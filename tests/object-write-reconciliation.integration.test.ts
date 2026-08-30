import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg, { type PoolClient } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  __resetObjectWriteRuntimeForTests,
  claimDueObjectWrite,
  installObjectWriteReconciler,
  reconcileObjectWriteClaim,
  runObjectWriteCleanupPass,
  type ObjectWriteReconciliationDependencies,
} from "../server/jobs/object-write-reconciliation";
import {
  ObjectWriteCoordinator,
  createPoolTransactionRunner,
  sha256Hex,
  type ObjectInspection,
  type ObjectStoreName,
  type ObjectStorePort,
  type ObjectWriteFinalizeContext,
  type ObjectWriteTransactionRunner,
} from "../server/lib/object-write-coordinator";
import type { RegisteredObjectWriteFinalizer } from "../server/lib/object-write-finalizer-registry";
import { __resetLifecycleForTests, cancelAllTimers } from "../server/lib/lifecycle";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

vi.mock("../server/db", () => ({
  pool: {
    connect: async () => {
      throw new Error("default application pool is forbidden in the reconciliation integration test");
    },
  },
}));

const HASH = sha256Hex("reconciliation-body");

const migration = (filename: string) => {
  const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
  if (!found) throw new Error(`${filename} is missing from the production migration runner`);
  return found;
};

class MemoryStore implements ObjectStorePort {
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];

  identity(store: ObjectStoreName, key: string): string {
    return `${store}:${key}`;
  }

  async inspect(store: ObjectStoreName, objectKey: string): Promise<ObjectInspection> {
    const body = this.objects.get(this.identity(store, objectKey));
    return body ? { exists: true, byteLength: body.length, sha256: sha256Hex(body) } : { exists: false };
  }

  async putCreateOnly(input: { store: ObjectStoreName; objectKey: string; body: Buffer }): Promise<void> {
    const identity = this.identity(input.store, input.objectKey);
    if (this.objects.has(identity)) throw new Error("conditional create refused an existing object");
    this.objects.set(identity, Buffer.from(input.body));
  }

  async deleteR2(objectKey: string): Promise<void> {
    this.deleted.push(objectKey);
    this.objects.delete(this.identity("R2", objectKey));
  }
}

describe("object-write reconciliation worker", () => {
  let cluster: DisposablePostgres17;
  let pool: pg.Pool;
  let runner: ObjectWriteTransactionRunner;
  let store: MemoryStore;

  beforeAll(async () => {
    cluster = await startPostgres17("object-write-reconciliation");
    pool = new pg.Pool({ connectionString: cluster.url, max: 10 });
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
      CREATE TABLE reconciled_publications (
        operation_id uuid PRIMARY KEY,
        aggregate_id text NOT NULL,
        object_key text NOT NULL
      )
    `);
    runner = createPoolTransactionRunner(pool);
  }, 60_000);

  afterAll(async () => {
    cancelAllTimers();
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE reconciled_publications,certificates,object_write_items,object_write_operations");
    store = new MemoryStore();
    __resetObjectWriteRuntimeForTests();
    __resetLifecycleForTests();
  });

  async function prepare(idempotencyKey: string, key = `object-write/reconcile/${idempotencyKey}`): Promise<string> {
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO object_write_operations
         (idempotency_key,operation_kind,aggregate_type,aggregate_id,manifest_sha256,expected_state,intent_payload)
       VALUES ($1,'CERTIFICATE_IMAGE_REVISION','certificate',$1,$2,'{}',$3::jsonb)
       RETURNING id::text`,
      [idempotencyKey, HASH, JSON.stringify({ aggregateId: idempotencyKey })]
    );
    await pool.query(
      `INSERT INTO object_write_items
         (operation_id,store,logical_slot,object_key,content_sha256,byte_length,content_type,object_class)
       VALUES ($1,'R2','front',$2,$3,$4,'image/png','CANONICAL')`,
      [operation.rows[0].id, key, HASH, Buffer.byteLength("reconciliation-body")]
    );
    return operation.rows[0].id;
  }

  const handler = (): RegisteredObjectWriteFinalizer => ({
    transactionRunner: () => runner,
    finalize: async (client: PoolClient, context: ObjectWriteFinalizeContext) => {
      await client.query(
        `INSERT INTO reconciled_publications(operation_id,aggregate_id,object_key)
         VALUES ($1,$2,$3) ON CONFLICT (operation_id) DO NOTHING`,
        [context.operationId, context.aggregateId, context.items[0].objectKey]
      );
      return { aggregateId: context.aggregateId, objectKey: context.items[0].objectKey };
    },
  });

  const dependencies = (overrides: Partial<ObjectWriteReconciliationDependencies> = {}) => ({
    runner,
    stores: store,
    resolveFinalizer: () => handler(),
    workerId: "reconciliation-test",
    leaseMs: 2_000,
    missingGraceMs: 5_000,
    ...overrides,
  });

  it("claims an expired operation and adopts verified bytes after a process crash", async () => {
    const operationId = await prepare("crash-adoption");
    store.objects.set("R2:object-write/reconcile/crash-adoption", Buffer.from("reconciliation-body"));
    await pool.query(
      `UPDATE object_write_operations
          SET state='UPLOADING',lease_owner='dead-worker',lease_token=gen_random_uuid(),
              lease_expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [operationId]
    );

    const claim = await claimDueObjectWrite(dependencies());
    expect(claim?.operation.id).toBe(operationId);
    await expect(reconcileObjectWriteClaim(claim!, dependencies())).resolves.toBe("COMMITTED");
    expect((await pool.query("SELECT state FROM object_write_operations WHERE id=$1", [operationId])).rows[0].state).toBe(
      "COMMITTED"
    );
    expect((await pool.query("SELECT count(*)::int AS count FROM reconciled_publications")).rows[0].count).toBe(1);
  });

  it("uses durable missing-byte grace before abandonment and cleans only a proven-created R2 object", async () => {
    const operationId = await prepare("missing-grace");
    await pool.query("UPDATE object_write_items SET write_disposition='CREATED' WHERE operation_id=$1", [operationId]);
    const first = await claimDueObjectWrite(dependencies());
    await expect(reconcileObjectWriteClaim(first!, dependencies())).resolves.toBe("RETRY");
    expect(
      (
        await pool.query(
          `SELECT operation.state,item.missing_observed_at IS NOT NULL AS observed,item.cleanup_state
             FROM object_write_operations operation
             JOIN object_write_items item ON item.operation_id=operation.id
            WHERE operation.id=$1`,
          [operationId]
        )
      ).rows[0]
    ).toEqual({ state: "RECONCILIATION_REQUIRED", observed: true, cleanup_state: "NONE" });

    await pool.query("UPDATE object_write_items SET missing_observed_at=now()-interval '10 seconds' WHERE operation_id=$1", [
      operationId,
    ]);
    await pool.query("UPDATE object_write_operations SET next_attempt_at=now() WHERE id=$1", [operationId]);
    const second = await claimDueObjectWrite(dependencies());
    await expect(reconcileObjectWriteClaim(second!, dependencies())).resolves.toBe("ABANDONED");
    await pool.query("UPDATE object_write_items SET delete_after=now() WHERE operation_id=$1", [operationId]);
    await expect(runObjectWriteCleanupPass(dependencies(), 1)).resolves.toEqual({ examined: 1, cleaned: 1, failed: 0 });
    expect(store.deleted).toEqual(["object-write/reconcile/missing-grace"]);
  });

  it("recovers a late PUT after lease takeover without publishing or abandoning the first missing observation", async () => {
    let releasePut: (() => void) | undefined;
    let signalPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      signalPutStarted = resolve;
    });
    const delayedStore = new MemoryStore();
    delayedStore.putCreateOnly = async (request) => {
      signalPutStarted?.();
      await new Promise<void>((resolve) => {
        releasePut = resolve;
      });
      delayedStore.objects.set(delayedStore.identity(request.store, request.objectKey), Buffer.from(request.body));
    };
    store = delayedStore;
    const coordinator = new ObjectWriteCoordinator(runner, store, "slow-writer", 50);
    const request = {
      idempotencyKey: "late-put",
      operationKind: "CERTIFICATE_IMAGE_REVISION",
      aggregateType: "certificate",
      aggregateId: "late-put",
      intentPayload: { aggregateId: "late-put" },
      items: [
        {
          store: "R2" as const,
          logicalSlot: "front",
          objectKey: "object-write/reconcile/late-put",
          body: Buffer.from("reconciliation-body"),
          contentType: "image/png",
          objectClass: "CANONICAL" as const,
        },
      ],
    };
    const original = coordinator.execute(request, handler().finalize);
    await putStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const takeover = await claimDueObjectWrite(dependencies({ leaseMs: 2_000, missingGraceMs: 5_000 }));
    expect(takeover).not.toBeNull();
    await expect(reconcileObjectWriteClaim(takeover!, dependencies())).resolves.toBe("RETRY");
    releasePut?.();
    await expect(original).rejects.toThrow("lease expired or was lost");

    await pool.query("UPDATE object_write_operations SET next_attempt_at=now() WHERE id=$1", [takeover!.operation.id]);
    const recovery = await claimDueObjectWrite(dependencies());
    await expect(reconcileObjectWriteClaim(recovery!, dependencies())).resolves.toBe("COMMITTED");
    expect(
      (await pool.query("SELECT state,last_error_code FROM object_write_operations WHERE id=$1", [takeover!.operation.id]))
        .rows[0]
    ).toEqual({ state: "COMMITTED", last_error_code: "OBJECT_MISSING_GRACE" });
  });

  it("gives concurrent workers distinct due operations through SKIP LOCKED leasing", async () => {
    const firstId = await prepare("worker-one");
    const secondId = await prepare("worker-two");
    const [first, second] = await Promise.all([
      claimDueObjectWrite(dependencies({ workerId: "worker-a" })),
      claimDueObjectWrite(dependencies({ workerId: "worker-b" })),
    ]);
    expect(new Set([first?.operation.id, second?.operation.id])).toEqual(new Set([firstId, secondId]));
  });

  it("contains an immediate worker failure instead of emitting an unhandled rejection", async () => {
    const error = new Error("database unavailable");
    const failingRunner: ObjectWriteTransactionRunner = {
      transaction: async <T>(_operation: (client: PoolClient) => Promise<T>): Promise<T> => Promise.reject(error),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      installObjectWriteReconciler(dependencies({ runner: failingRunner }), 60_000);
      await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(1));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      logged.mockRestore();
      cancelAllTimers();
      __resetObjectWriteRuntimeForTests();
      __resetLifecycleForTests();
    }
  });
});
