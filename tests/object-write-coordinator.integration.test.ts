import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  ObjectWriteConflictError,
  ObjectWriteCoordinator,
  ObjectWriteIntegrityError,
  createPoolTransactionRunner,
  sha256Hex,
  type ObjectInspection,
  type ObjectStoreName,
  type ObjectStorePort,
  type ObjectWriteInput,
} from "../server/lib/object-write-coordinator";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

class MemoryObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, Buffer>();
  readonly retention = new Map<string, Date>();
  putCalls = 0;
  failAfterPut = false;

  private identity(store: ObjectStoreName, key: string): string {
    return `${store}:${key}`;
  }

  async inspect(store: ObjectStoreName, objectKey: string): Promise<ObjectInspection> {
    const body = this.objects.get(this.identity(store, objectKey));
    if (!body) return { exists: false };
    const retainUntil = this.retention.get(this.identity(store, objectKey));
    return store === "B2"
      ? {
          exists: true,
          byteLength: body.length,
          sha256: sha256Hex(body),
          versionId: "memory-version-1",
          objectLockMode: "COMPLIANCE",
          objectLockRetainUntil: retainUntil,
        }
      : { exists: true, byteLength: body.length, sha256: sha256Hex(body) };
  }

  async putCreateOnly(input: {
    store: ObjectStoreName;
    objectKey: string;
    body: Buffer;
    minimumRetainUntil?: Date;
  }): Promise<void> {
    this.putCalls += 1;
    const identity = this.identity(input.store, input.objectKey);
    if (this.objects.has(identity)) throw new Error("conditional create refused an existing object");
    this.objects.set(identity, Buffer.from(input.body));
    if (input.minimumRetainUntil) this.retention.set(identity, input.minimumRetainUntil);
    if (this.failAfterPut) {
      this.failAfterPut = false;
      throw new Error("transport lost the successful PUT response");
    }
  }

  async deleteR2(objectKey: string): Promise<void> {
    this.objects.delete(this.identity("R2", objectKey));
  }
}

const migration = (filename: string) => {
  const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
  if (!found) throw new Error(`${filename} is missing from the production migration runner`);
  return found;
};

const input = (idempotencyKey: string, body = "front-image"): ObjectWriteInput => ({
  idempotencyKey,
  operationKind: "TEST_OBJECT_PUBLICATION",
  aggregateType: "test_record",
  aggregateId: idempotencyKey,
  actorId: "test-actor",
  expectedState: { pointer: null },
  intentPayload: { recordId: idempotencyKey },
  items: [
    {
      store: "R2",
      logicalSlot: "front",
      objectKey: `object-write/tests/${idempotencyKey}/front-${sha256Hex(body)}.png`,
      body: Buffer.from(body),
      contentType: "image/png",
      objectClass: "CANONICAL",
    },
  ],
});

describe("durable object-write coordinator", () => {
  let cluster: DisposablePostgres17;
  let pool: pg.Pool;
  let store: MemoryObjectStore;
  let coordinator: ObjectWriteCoordinator;

  beforeAll(async () => {
    cluster = await startPostgres17("object-write-coordinator");
    pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
    await pool.query(`
      CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE partner_organisations (id uuid PRIMARY KEY);
      CREATE TABLE submissions (id integer PRIMARY KEY);
      CREATE TABLE certificates (id serial PRIMARY KEY);
      CREATE OR REPLACE FUNCTION partner_current_tenant()
      RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
        SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
      $fn$;
    `);
    await applyMigrations(pool, [
      migration("0121_main_runtime_role_authority.sql"),
      migration("0122_object_write_intent_reconciliation.sql"),
    ]);
    await pool.query(`
      CREATE TABLE object_publications (
        record_id text PRIMARY KEY,
        object_key text NOT NULL,
        operation_id uuid NOT NULL UNIQUE
      );
      CREATE TABLE object_publication_audit (
        operation_id uuid PRIMARY KEY,
        record_id text NOT NULL,
        object_key text NOT NULL
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE object_publication_audit,object_publications,certificates,object_write_items,object_write_operations"
    );
    store = new MemoryObjectStore();
    coordinator = new ObjectWriteCoordinator(createPoolTransactionRunner(pool), store, "coordinator-test", 10_000);
  });

  const finalizer = async (client: pg.PoolClient, context: any) => {
    const item = context.items[0];
    await client.query(
      `INSERT INTO object_publications(record_id,object_key,operation_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (record_id) DO UPDATE
         SET object_key=EXCLUDED.object_key,operation_id=EXCLUDED.operation_id`,
      [context.intentPayload.recordId, item.objectKey, context.operationId]
    );
    await client.query(
      `INSERT INTO object_publication_audit(operation_id,record_id,object_key)
       VALUES ($1,$2,$3) ON CONFLICT (operation_id) DO NOTHING`,
      [context.operationId, context.intentPayload.recordId, item.objectKey]
    );
    return { recordId: context.intentPayload.recordId, objectKey: item.objectKey };
  };

  it("publishes verified bytes, pointer, audit and COMMITTED result as one durable outcome", async () => {
    const result = await coordinator.execute(input("success"), finalizer);
    expect(result.replayed).toBe(false);
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT object_key FROM object_publications WHERE record_id='success'")).rows).toEqual([
      { object_key: result.result.objectKey },
    ]);
    expect(
      (
        await pool.query(
          `SELECT operation.state,item.verification_state,item.write_disposition,
                  operation.result_payload
             FROM object_write_operations operation
             JOIN object_write_items item ON item.operation_id=operation.id`
        )
      ).rows[0]
    ).toMatchObject({
      state: "COMMITTED",
      verification_state: "VERIFIED",
      write_disposition: "CREATED",
      result_payload: result.result,
    });
    expect((await pool.query("SELECT count(*)::int AS count FROM object_publication_audit")).rows[0].count).toBe(1);
  });

  it("returns the stored result on an idempotent replay without object I/O or a second finalizer", async () => {
    const first = await coordinator.execute(input("replay"), finalizer);
    const second = await coordinator.execute(input("replay"), async () => {
      throw new Error("replay must not run the finalizer");
    });
    expect(second).toEqual({ ...first, replayed: true });
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM object_publication_audit")).rows[0].count).toBe(1);
  });

  it("rejects reuse of an idempotency key for different bytes", async () => {
    await coordinator.execute(input("conflict", "first"), finalizer);
    await expect(coordinator.execute(input("conflict", "different"), finalizer)).rejects.toBeInstanceOf(
      ObjectWriteConflictError
    );
  });

  it("adopts an ambiguous successful PUT only after GET/hash verification", async () => {
    store.failAfterPut = true;
    await coordinator.execute(input("ambiguous"), finalizer);
    expect((await pool.query("SELECT write_disposition,verification_state FROM object_write_items")).rows[0]).toEqual({
      write_disposition: "AMBIGUOUS",
      verification_state: "VERIFIED",
    });
  });

  it("quarantines mismatched existing bytes and leaves every business pointer unmodified", async () => {
    const request = input("mismatch");
    store.objects.set(`R2:${request.items[0].objectKey}`, Buffer.from("hostile-existing-content"));
    await expect(coordinator.execute(request, finalizer)).rejects.toBeInstanceOf(ObjectWriteIntegrityError);
    expect((await pool.query("SELECT count(*)::int AS count FROM object_publications")).rows[0].count).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT operation.state,item.verification_state,item.write_disposition
             FROM object_write_operations operation
             JOIN object_write_items item ON item.operation_id=operation.id`
        )
      ).rows[0]
    ).toEqual({
      state: "RECONCILIATION_REQUIRED",
      verification_state: "QUARANTINED",
      write_disposition: "ADOPTED",
    });
  });

  it("rolls a failed business finalizer back, then safely finalizes the verified operation on retry", async () => {
    let attempts = 0;
    const flakyFinalizer = async (client: pg.PoolClient, context: any) => {
      attempts += 1;
      await finalizer(client, context);
      if (attempts === 1) throw new Error("crash before transaction commit");
      return { recordId: context.intentPayload.recordId, objectKey: context.items[0].objectKey };
    };
    await expect(coordinator.execute(input("finalizer-retry"), flakyFinalizer)).rejects.toThrow("crash before");
    expect((await pool.query("SELECT count(*)::int AS count FROM object_publications")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe(
      "RECONCILIATION_REQUIRED"
    );

    const recovered = await coordinator.execute(input("finalizer-retry"), flakyFinalizer);
    expect(recovered.result.recordId).toBe("finalizer-retry");
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM object_publications")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("COMMITTED");
  });

  it("persists one absolute B2 retention deadline and the exact verified version across a later retry", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const request = input("b2-retention");
    request.items[0] = {
      ...request.items[0],
      store: "B2",
      objectKey: `object-write/tests/b2-retention/front-${sha256Hex(request.items[0].body)}.png`,
      retentionDays: 90,
    };
    let attempts = 0;
    const flakyFinalizer = async (client: pg.PoolClient, context: any) => {
      attempts += 1;
      await finalizer(client, context);
      if (attempts === 1) throw new Error("retry after a later wall-clock instant");
      return { recordId: context.intentPayload.recordId, objectKey: context.items[0].objectKey };
    };
    try {
      await expect(coordinator.execute(request, flakyFinalizer)).rejects.toThrow("later wall-clock");
      const first = (
        await pool.query<{
          minimum_retain_until: Date;
          observed_version_id: string;
        }>("SELECT minimum_retain_until,observed_version_id FROM object_write_items")
      ).rows[0];
      expect(first.observed_version_id).toBe("memory-version-1");

      clock.mockReturnValue(now + 24 * 60 * 60 * 1_000);
      await coordinator.execute(request, flakyFinalizer);
      const second = (
        await pool.query<{ minimum_retain_until: Date; observed_version_id: string }>(
          "SELECT minimum_retain_until,observed_version_id FROM object_write_items"
        )
      ).rows[0];
      expect(second).toEqual(first);
      expect(store.putCalls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
