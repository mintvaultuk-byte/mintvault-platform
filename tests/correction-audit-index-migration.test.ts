/**
 * Super Admin Correction Mode — concurrent audit-index migration proof.
 *
 * Uses an isolated PostgreSQL 17.10 cluster and the real migration runner. This deliberately
 * recreates PostgreSQL's invalid-index state: CREATE INDEX CONCURRENTLY IF NOT EXISTS reports
 * success when a same-named invalid index remains, so the old migration would have journalled a
 * broken index as applied. The runner directive in 0018 must instead repair it before completion.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles, planMigrations } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const INDEX_NAME = "idx_audit_log_cert_correction_recent";
const INDEX = `public.${INDEX_NAME}`;
const FILENAME = "0018_correction_audit_index.sql";

let cluster: DisposablePostgres17;
let client: Client;

function migration() {
  const file = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!file) throw new Error(`${FILENAME} was not discovered`);
  return file;
}

async function indexState(): Promise<{ oid: string; valid: boolean } | null> {
  const result = await client.query<{ oid: string; indisvalid: boolean }>(
    `SELECT c.oid::text, i.indisvalid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass($1)`,
    [INDEX]
  );
  if (result.rows.length === 0) return null;
  return { oid: result.rows[0].oid, valid: result.rows[0].indisvalid };
}

async function createInvalidIndex(): Promise<void> {
  // A failed UNIQUE concurrent build leaves a tangible same-named invalid index. The index's
  // definition does not need to match 0017: PostgreSQL's IF NOT EXISTS shortcut is name-based,
  // which is the defect we are proving and repairing.
  await client.query(
    `INSERT INTO audit_log (entity_type, entity_id, action)
     VALUES ('certificate', '1', 'cert_live_record_edit'), ('certificate', '2', 'cert_live_record_edit')`
  );
  await expect(client.query(`CREATE UNIQUE INDEX CONCURRENTLY ${INDEX_NAME} ON audit_log ((1))`)).rejects.toThrow();
  expect(await indexState()).toMatchObject({ valid: false });
}

describe("0018 correction audit index migration", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("correction-audit-index");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
    await client.query(`
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
  }, 60_000);

  beforeEach(async () => {
    await client.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    await client.query("TRUNCATE audit_log");
    const journal = await client.query("SELECT to_regclass('public.schema_migrations') AS reg");
    if (journal.rows[0]?.reg) {
      await client.query("DELETE FROM schema_migrations WHERE filename = $1", [FILENAME]);
    }
  });

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  it("creates a valid index on a clean database and journals it only after validation", async () => {
    const { applied } = await applyMigrations(client, [migration()]);

    expect(applied).toEqual([FILENAME]);
    expect(await indexState()).toMatchObject({ valid: true });
    expect(
      (
        await client.query(
          "SELECT status, completed_at IS NOT NULL AS completed FROM schema_migrations WHERE filename = $1",
          [FILENAME]
        )
      ).rows[0]
    ).toEqual({ status: "applied", completed: true });
  });

  it("accepts and preserves a valid existing index", async () => {
    await client.query(`
      CREATE INDEX CONCURRENTLY ${INDEX_NAME}
      ON audit_log (created_at DESC, entity_id)
      WHERE entity_type = 'certificate' AND action = 'cert_live_record_edit'`);
    const before = await indexState();
    expect(before).toMatchObject({ valid: true });

    await applyMigrations(client, [migration()]);

    // No DROP/CREATE occurs for a valid index: its relation OID stays identical.
    expect(await indexState()).toEqual(before);
  });

  it("reproduces the old IF NOT EXISTS false-success, then repairs the invalid index and validates it", async () => {
    await createInvalidIndex();

    // This is the exact old migration statement. PostgreSQL emits a NOTICE rather than an error,
    // while leaving indisvalid=false; a runner that journals immediately therefore loses repair.
    await expect(
      client.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
        ON audit_log (created_at DESC, entity_id)
        WHERE entity_type = 'certificate' AND action = 'cert_live_record_edit'`)
    ).resolves.toBeTruthy();
    expect(await indexState()).toMatchObject({ valid: false });

    await applyMigrations(client, [migration()]);

    expect(await indexState()).toMatchObject({ valid: true });
    expect(
      (await client.query("SELECT status FROM schema_migrations WHERE filename = $1", [FILENAME])).rows[0].status
    ).toBe("applied");
  });

  it("does not mark a failed concurrent build as applied, and retries the repair rather than jamming", async () => {
    await client.query(
      `INSERT INTO audit_log (entity_type, entity_id, action)
       VALUES ('certificate', '1', 'cert_live_record_edit'), ('certificate', '2', 'cert_live_record_edit')`
    );
    const failed = {
      ...migration(),
      filename: "0018_test_failed_concurrent_index.sql",
      checksum: "synthetic-failed-concurrent-index",
      sql: `-- migrate:no-transaction
-- migrate:ensure-valid-concurrent-index ${INDEX}
CREATE UNIQUE INDEX CONCURRENTLY ${INDEX_NAME} ON audit_log ((1));`,
    };

    await expect(applyMigrations(client, [failed])).rejects.toThrow(/Non-transactional migration/);
    expect(await indexState()).toMatchObject({ valid: false });
    expect(
      (await client.query("SELECT status, completed_at FROM schema_migrations WHERE filename = $1", [failed.filename]))
        .rows[0]
    ).toEqual({ status: "failed", completed_at: null });

    /**
     * RETRY CONTRACT CHANGED (lock-safety hostile review, 2026-08-07).
     *
     * This used to assert `/Journal inconsistent/` — the runner refused to look at the file ever
     * again, and recovery needed a manual UPDATE/DELETE on schema_migrations, which is a protected
     * action, during an incident. That refusal fired on EVERY non-'applied' row, and only the
     * no-transaction path can leave one, so it was firing exclusively on the very files the runner
     * already had a verified repair for — making migrate:ensure-valid-concurrent-index dead code
     * in exactly the case it was written for. A routine lock-contention event jammed the journal
     * permanently.
     *
     * A self-healing file at an unchanged checksum is now RESUMED: the runner re-attempts the
     * repair. What must not change is that a genuinely impossible migration is never marked
     * applied — and here it is genuinely impossible (a UNIQUE index on a constant expression over
     * two rows), so the retry fails again for the REAL reason and the journal row stays 'failed'.
     */
    await expect(applyMigrations(client, [failed])).rejects.toThrow(
      /Non-transactional migration .* could not create unique index/s
    );
    expect(await indexState()).toMatchObject({ valid: false });
    expect(
      (await client.query("SELECT status, completed_at FROM schema_migrations WHERE filename = $1", [failed.filename]))
        .rows[0],
      "a failing migration must never be journalled as applied, however many times it is retried"
    ).toEqual({ status: "failed", completed_at: null });
  });

  it("a stale 'failed' row for a self-healing file is repaired on the next run, not jammed forever", async () => {
    // The lock-contention case, end to end: an invalid index plus a 'failed' journal row is
    // exactly what a lock_timeout during CREATE INDEX CONCURRENTLY leaves behind. The operator
    // must recover by re-running the same command, with no journal surgery.
    await createInvalidIndex();
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, status)
       VALUES ($1, $2, 'failed')
       ON CONFLICT (filename) DO UPDATE SET status = 'failed', checksum = EXCLUDED.checksum`,
      [FILENAME, migration().checksum]
    );
    expect(await indexState()).toMatchObject({ valid: false });

    const plan = await planMigrations(client, [migration()]);
    expect(plan.resumable.map((r) => r.filename)).toEqual([FILENAME]);
    expect(plan.inconsistent, "a repairable row must not be reported as fatally inconsistent").toEqual([]);

    await applyMigrations(client, [migration()]);

    expect(await indexState()).toMatchObject({ valid: true });
    expect(
      (await client.query("SELECT status FROM schema_migrations WHERE filename = $1", [FILENAME])).rows[0].status
    ).toBe("applied");
  });

  it("discovers the complete migration inventory in a read-only dry-run", async () => {
    // planMigrations must not create the journal, even when every discovered migration is pending.
    await client.query("DROP TABLE IF EXISTS schema_migrations");
    const files = listMigrationFiles();
    const plan = await planMigrations(client, files);

    expect(plan.pending).toEqual(files.map((file) => file.filename));
    expect(plan.inconsistent).toEqual([]);
    expect(plan.checksumMismatches).toEqual([]);
    expect((await client.query("SELECT to_regclass('public.schema_migrations') AS reg")).rows[0].reg).toBeNull();
  });
});
