import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  ObjectWriteAbandonError,
  ObjectWriteCoordinator,
  createPoolTransactionRunner,
  readObjectWriteSnapshot,
  sha256Hex,
  type ObjectInspection,
  type ObjectStoreName,
  type ObjectStorePort,
} from "../server/lib/object-write-coordinator";
import {
  finalizeSubmissionReceiptObjectWrite,
  signedSubmissionReceiptPhotoUrls,
} from "../server/lib/submission-receipt-persistence";
import { getR2SignedUrl } from "../server/r2";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

vi.mock("../server/db", () => ({
  pool: {
    connect: async () => {
      throw new Error("default application pool is forbidden in the receipt integration test");
    },
  },
}));
vi.mock("../server/r2", () => ({
  getR2SignedUrl: vi.fn(),
  inspectR2ObjectIntegrity: vi.fn(),
  uploadCreateOnlyToR2: vi.fn(),
  deleteFromR2: vi.fn(),
}));

const migration = (filename: string) => {
  const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
  if (!found) throw new Error(`${filename} is missing from the production migration runner`);
  return found;
};

class MemoryStore implements ObjectStorePort {
  readonly objects = new Map<string, Buffer>();

  private identity(store: ObjectStoreName, key: string): string {
    return `${store}:${key}`;
  }

  async inspect(store: ObjectStoreName, objectKey: string): Promise<ObjectInspection> {
    const body = this.objects.get(this.identity(store, objectKey));
    return body ? { exists: true, byteLength: body.length, sha256: sha256Hex(body) } : { exists: false };
  }

  async putCreateOnly(input: { store: ObjectStoreName; objectKey: string; body: Buffer }): Promise<void> {
    const identity = this.identity(input.store, input.objectKey);
    if (this.objects.has(identity)) throw new Error("conditional create collision");
    this.objects.set(identity, Buffer.from(input.body));
  }

  async deleteR2(objectKey: string): Promise<void> {
    this.objects.delete(this.identity("R2", objectKey));
  }
}

describe("submission receipt object-write finalizer", () => {
  let cluster: DisposablePostgres17;
  let pool: pg.Pool;
  let store: MemoryStore;

  beforeAll(async () => {
    cluster = await startPostgres17("submission-receipt-object-write");
    pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
    await pool.query(`
      CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE partner_organisations (id uuid PRIMARY KEY);
      CREATE TABLE certificates (id serial PRIMARY KEY);
      CREATE TABLE submissions (
        id serial PRIMARY KEY,
        tracking_number text NOT NULL UNIQUE,
        status text NOT NULL,
        status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
        on_receipt_photo_urls text,
        received_at timestamptz,
        deleted_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION partner_current_tenant()
      RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
        SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
      $fn$;
    `);
    await applyMigrations(pool, [
      migration("0121_main_runtime_role_authority.sql"),
      migration("0122_object_write_intent_reconciliation.sql"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE audit_log,object_write_items,certificates,object_write_operations,submissions RESTART IDENTITY"
    );
    store = new MemoryStore();
  });

  async function seedSubmission(trackingNumber: string): Promise<{ id: number; revision: number }> {
    const row = await pool.query<{ id: number; on_receipt_photo_revision: string | number }>(
      "INSERT INTO submissions(tracking_number,status) VALUES ($1,'paid') RETURNING id,on_receipt_photo_revision",
      [trackingNumber]
    );
    return { id: row.rows[0].id, revision: Number(row.rows[0].on_receipt_photo_revision) };
  }

  function request(submission: { id: number; revision: number }, trackingNumber: string, suffix: string) {
    const body = Buffer.from(`receipt-${suffix}`);
    return {
      idempotencyKey: `receipt-${suffix}`,
      operationKind: "SUBMISSION_RECEIPT_PHOTOS",
      aggregateType: "submission",
      aggregateId: String(submission.id),
      actorId: "admin@example.test",
      expectedState: { status: "paid", receiptRevision: submission.revision },
      intentPayload: {
        submissionId: submission.id,
        trackingNumber,
        expectedStatus: "paid",
        expectedRevision: submission.revision,
        adminUser: "admin@example.test",
        externalUrls: ["https://evidence.example.test/intake.jpg"],
      },
      items: [
        {
          store: "R2" as const,
          logicalSlot: "photo-1",
          objectKey: `receipt/${trackingNumber}/revisions/${suffix}/1.jpg`,
          body,
          contentType: "image/jpeg",
          objectClass: "CANONICAL" as const,
        },
      ],
    };
  }

  it("publishes receipt descriptors, status history, audit and COMMITTED in one transaction", async () => {
    const trackingNumber = "MV-RECEIPT-1";
    const submission = await seedSubmission(trackingNumber);
    const coordinator = new ObjectWriteCoordinator(createPoolTransactionRunner(pool), store, "receipt-test", 2_000);
    await coordinator.execute(request(submission, trackingNumber, "success"), finalizeSubmissionReceiptObjectWrite);

    const row = (
      await pool.query<{
        status: string;
        on_receipt_photo_urls: string;
        on_receipt_photo_objects: Array<Record<string, unknown>>;
        history_count: number;
      }>(
        `SELECT status,on_receipt_photo_urls,on_receipt_photo_objects,
                jsonb_array_length(status_history)::int AS history_count
           FROM submissions WHERE id=$1`,
        [submission.id]
      )
    ).rows[0];
    expect(row.status).toBe("received");
    expect(JSON.parse(row.on_receipt_photo_urls)).toEqual(["https://evidence.example.test/intake.jpg"]);
    expect(row.on_receipt_photo_objects).toEqual([
      expect.objectContaining({
        store: "R2",
        key: `receipt/${trackingNumber}/revisions/success/1.jpg`,
        sha256: sha256Hex("receipt-success"),
      }),
    ]);
    expect(row.history_count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_log")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("COMMITTED");
  });

  it("rolls back pointer and audit publication when the submission CAS is stale", async () => {
    const trackingNumber = "MV-RECEIPT-2";
    const submission = await seedSubmission(trackingNumber);
    await pool.query("UPDATE submissions SET on_receipt_photo_revision=on_receipt_photo_revision+1 WHERE id=$1", [
      submission.id,
    ]);
    const coordinator = new ObjectWriteCoordinator(createPoolTransactionRunner(pool), store, "receipt-test", 2_000);
    await expect(
      coordinator.execute(request(submission, trackingNumber, "stale"), finalizeSubmissionReceiptObjectWrite)
    ).rejects.toBeInstanceOf(ObjectWriteAbandonError);

    expect(
      (
        await pool.query(
          "SELECT status,on_receipt_photo_objects,jsonb_array_length(status_history)::int AS history_count FROM submissions"
        )
      ).rows[0]
    ).toEqual({ status: "paid", on_receipt_photo_objects: [], history_count: 0 });
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_log")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("ABANDONED");
    expect((await pool.query("SELECT cleanup_state FROM object_write_items")).rows[0].cleanup_state).toBe("PENDING");
  });

  it("rehydrates the immutable snapshot so a committed retry does not re-finalize changed domain state", async () => {
    const trackingNumber = "MV-RECEIPT-REPLAY";
    const submission = await seedSubmission(trackingNumber);
    const runner = createPoolTransactionRunner(pool);
    const coordinator = new ObjectWriteCoordinator(runner, store, "receipt-test", 2_000);
    const original = request(submission, trackingNumber, "replay");
    const first = await coordinator.execute(original, finalizeSubmissionReceiptObjectWrite);
    expect(first.replayed).toBe(false);

    const snapshot = await runner.transaction((client) =>
      readObjectWriteSnapshot(client, null, original.idempotencyKey)
    );
    expect(snapshot).not.toBeNull();
    const replay = await coordinator.execute(
      {
        tenantId: snapshot!.tenantId,
        idempotencyKey: snapshot!.idempotencyKey,
        operationKind: snapshot!.operationKind,
        aggregateType: snapshot!.aggregateType,
        aggregateId: snapshot!.aggregateId,
        actorId: snapshot!.actorId,
        expectedState: snapshot!.expectedState,
        intentPayload: snapshot!.intentPayload,
        items: snapshot!.items.map((item) => ({
          store: item.store,
          logicalSlot: item.logicalSlot,
          objectKey: item.objectKey,
          priorObjectKey: item.priorObjectKey,
          body: original.items[0].body,
          contentType: item.contentType,
          objectClass: item.objectClass,
          required: item.required,
          retentionDays: item.retentionDays ?? undefined,
        })),
      },
      finalizeSubmissionReceiptObjectWrite
    );
    expect(replay.replayed).toBe(true);
    expect(replay.operationId).toBe(first.operationId);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_log")).rows[0].count).toBe(1);
  });

  it("signs durable descriptors afresh and never treats a stored URL as canonical object state", async () => {
    vi.mocked(getR2SignedUrl)
      .mockResolvedValueOnce("https://signed.example.test/first")
      .mockResolvedValueOnce("https://signed.example.test/second");
    const record = {
      on_receipt_photo_objects: [
        {
          operationId: "11111111-1111-1111-1111-111111111111",
          logicalSlot: "photo-1",
          store: "R2",
          key: "receipt/MV/revisions/one/1.jpg",
          sha256: "a".repeat(64),
          byteLength: 123,
          contentType: "image/jpeg",
        },
      ],
      on_receipt_photo_urls: JSON.stringify(["https://external.example.test/photo.jpg"]),
    };
    expect(await signedSubmissionReceiptPhotoUrls(record)).toEqual([
      "https://signed.example.test/first",
      "https://external.example.test/photo.jpg",
    ]);
    expect(await signedSubmissionReceiptPhotoUrls(record)).toEqual([
      "https://signed.example.test/second",
      "https://external.example.test/photo.jpg",
    ]);
    expect(getR2SignedUrl).toHaveBeenNthCalledWith(1, "receipt/MV/revisions/one/1.jpg", 60 * 60);
    expect(getR2SignedUrl).toHaveBeenNthCalledWith(2, "receipt/MV/revisions/one/1.jpg", 60 * 60);
  });
});
