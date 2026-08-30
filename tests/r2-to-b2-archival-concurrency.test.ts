import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

vi.mock("../server/db", () => ({ db: {}, pool: {} }));

import { finaliseArchiveIfEvidenceUnchanged, type FinaliseArchiveInput } from "../server/workers/r2-to-b2-archival";

const dialect = new PgDialect();
const FINALISER_APPLICATION_NAME = "archive-finalise-race-test";

let cluster: DisposablePostgres17;
let observer: Client;

function finaliseInput(): FinaliseArchiveInput {
  return {
    certId: 7,
    certNumber: "MV7",
    ledgerFingerprint: [
      [41, "front", "NEW_IMMUTABLE_MASTER", "evidence/masters/7/front/old.tif", "a".repeat(64), "10", null, null],
    ],
    auditDetails: {
      r2_keys_archived: ["evidence/masters/7/front/old.tif"],
      total_bytes_verified: 10,
      object_count: 1,
      evidence_row_count: 1,
      verified_objects: [
        {
          key: "evidence/masters/7/front/old.tif",
          byteLength: 10,
          sha256: "a".repeat(64),
          source: "evidence",
          objectLockMode: "COMPLIANCE",
          objectLockRetainUntil: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  };
}

function transactionExecutor(applicationName: string) {
  return {
    transaction: async <T>(callback: (tx: { execute(query: SQL): Promise<{ rows: unknown[] }> }) => Promise<T>) => {
      const client = new Client({ connectionString: cluster.url, application_name: applicationName });
      await client.connect();
      await client.query("BEGIN");
      try {
        const result = await callback({
          execute: async (query: SQL) => {
            const built = dialect.sqlToQuery(query);
            return client.query(built.sql, built.params);
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await client.end();
      }
    },
  };
}

async function waitUntilFinaliserIsBlockedOnCertificateLock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const activity = await observer.query<{ wait_event_type: string | null; query: string }>(
      `SELECT wait_event_type, query
         FROM pg_stat_activity
        WHERE application_name = $1
          AND state = 'active'`,
      [FINALISER_APPLICATION_NAME]
    );
    if (activity.rows.some((row) => row.wait_event_type === "Lock" && /SELECT id[\s\S]+FOR UPDATE/i.test(row.query))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("archive finaliser did not block on the certificate row lock");
}

describe("R2-to-B2 archive finalisation ordering against PostgreSQL 17", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("r2-b2-finalise-race");
    observer = new Client({ connectionString: cluster.url });
    await observer.connect();
    await observer.query(`
      CREATE TABLE certificates (
        id integer PRIMARY KEY,
        certificate_number text NOT NULL,
        deleted_at timestamptz,
        archived_to_b2_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE certificate_image_evidence (
        id integer PRIMARY KEY,
        certificate_id integer NOT NULL REFERENCES certificates(id),
        side text NOT NULL,
        evidence_class text NOT NULL,
        object_key text NOT NULL,
        sha256 text NOT NULL,
        byte_length bigint NOT NULL,
        working_object_key text,
        working_sha256 text
      );
      CREATE TABLE audit_log (
        entity_type text,
        entity_id text,
        action text,
        admin_user text,
        details jsonb
      );
    `);
  }, 60_000);

  beforeEach(async () => {
    await observer.query("TRUNCATE audit_log, certificate_image_evidence, certificates");
    await observer.query("INSERT INTO certificates (id, certificate_number) VALUES (7, 'MV7')");
    await observer.query(
      `INSERT INTO certificate_image_evidence
         (id, certificate_id, side, evidence_class, object_key, sha256, byte_length)
       VALUES (41, 7, 'front', 'NEW_IMMUTABLE_MASTER', 'evidence/masters/7/front/old.tif', $1, 10)`,
      ["a".repeat(64)]
    );
  });

  afterAll(async () => {
    await observer?.end().catch(() => {});
    await cluster?.stop();
  });

  it("marks and audits an unchanged evidence fingerprint atomically", async () => {
    await expect(
      finaliseArchiveIfEvidenceUnchanged(transactionExecutor("archive-finalise-happy-test"), finaliseInput())
    ).resolves.toBe(true);
    expect(
      (await observer.query("SELECT archived_to_b2_at IS NOT NULL AS archived FROM certificates WHERE id=7")).rows[0]
    ).toEqual({ archived: true });
    expect((await observer.query("SELECT count(*)::int AS count FROM audit_log")).rows[0]).toEqual({ count: 1 });
  });

  it("waits behind recapture and rejects the stale fingerprint after recapture commits", async () => {
    const recapture = new Client({ connectionString: cluster.url });
    await recapture.connect();
    await recapture.query("BEGIN");
    try {
      await recapture.query(
        `INSERT INTO certificate_image_evidence
           (id, certificate_id, side, evidence_class, object_key, sha256, byte_length)
         VALUES (42, 7, 'back', 'NEW_IMMUTABLE_MASTER', 'evidence/masters/7/back/new.tif', $1, 11)`,
        ["b".repeat(64)]
      );
      // The scanner recapture transaction clears this marker even if it was
      // already NULL; the UPDATE still owns the row lock used for ordering.
      await recapture.query(
        "UPDATE certificates SET archived_to_b2_at=NULL,updated_at=now() WHERE id=$1",
        [7]
      );

      const finalise = finaliseArchiveIfEvidenceUnchanged(
        transactionExecutor(FINALISER_APPLICATION_NAME),
        finaliseInput()
      );
      await waitUntilFinaliserIsBlockedOnCertificateLock();
      await recapture.query("COMMIT");

      await expect(finalise).resolves.toBe(false);
    } catch (error) {
      await recapture.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await recapture.end();
    }

    expect(
      (await observer.query("SELECT archived_to_b2_at IS NULL AS unarchived FROM certificates WHERE id=7")).rows[0]
    ).toEqual({ unarchived: true });
    expect((await observer.query("SELECT count(*)::int AS count FROM certificate_image_evidence")).rows[0]).toEqual({
      count: 2,
    });
    expect((await observer.query("SELECT count(*)::int AS count FROM audit_log")).rows[0]).toEqual({ count: 0 });
  });
});
