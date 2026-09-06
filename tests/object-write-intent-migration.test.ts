import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { OBJECT_WRITE_READINESS_SQL } from "../server/readiness";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FILENAME = "0122_object_write_intent_reconciliation.sql";
const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let cluster: DisposablePostgres17;
let pool: pg.Pool;

function migration(filename: string) {
  const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
  if (!found) throw new Error(`${filename} was not discovered by the production migration runner`);
  return found;
}

async function asRole<T>(
  role: "mintvault_app" | "partner_runtime",
  tenantId: string | null,
  operation: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    if (tenantId) await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function prepareOperation(input: {
  tenantId?: string | null;
  idempotencyKey: string;
  hash?: string;
  store?: "R2" | "B2";
}): Promise<string> {
  const role = input.tenantId ? "partner_runtime" : "mintvault_app";
  return asRole(role, input.tenantId ?? null, async (client) => {
    const operation = await client.query<{ id: string }>(
      `INSERT INTO object_write_operations
         (tenant_id,idempotency_key,operation_kind,aggregate_type,aggregate_id,
          manifest_sha256,expected_state,intent_payload)
       VALUES ($1,$2,'CERTIFICATE_IMAGE_REVISION','certificate','1',$3,'{}','{}')
       RETURNING id::text`,
      [input.tenantId ?? null, input.idempotencyKey, input.hash ?? HASH_A]
    );
    await client.query(
      `INSERT INTO object_write_items
         (operation_id,store,logical_slot,object_key,content_sha256,byte_length,content_type,object_class,
          retention_days,minimum_retain_until)
       VALUES ($1,$2,'front',$3,$4,10,'image/png','CANONICAL',$5,$6)`,
      [
        operation.rows[0].id,
        input.store ?? "R2",
        `object-write/test/${input.idempotencyKey}/front`,
        input.hash ?? HASH_A,
        input.store === "B2" ? 90 : null,
        input.store === "B2" ? new Date(Date.now() + 90 * 86_400_000) : null,
      ]
    );
    return operation.rows[0].id;
  });
}

describe("0122 durable object-write intent authority", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("object-write-intent");
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
      INSERT INTO partner_organisations(id) VALUES ('${TENANT_A}'),('${TENANT_B}');
    `);
    await applyMigrations(pool, [migration("0121_main_runtime_role_authority.sql"), migration(FILENAME)]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  it("is journalled, force-RLS protected, trigger-owned and safe to re-execute", async () => {
    expect((await pool.query("SELECT status FROM schema_migrations WHERE filename=$1", [FILENAME])).rows[0]).toEqual({
      status: "applied",
    });
    const contracts = await pool.query<{
      table_name: string;
      rls: boolean;
      force_rls: boolean;
      trigger_name: string;
      trigger_mode: string;
    }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
             t.tgname AS trigger_name, t.tgenabled AS trigger_mode
        FROM pg_class c
        JOIN pg_trigger t ON t.tgrelid=c.oid AND NOT t.tgisinternal
       WHERE c.oid IN ('object_write_operations'::regclass,'object_write_items'::regclass)
       ORDER BY c.relname
    `);
    expect(contracts.rows).toEqual([
      {
        table_name: "object_write_items",
        rls: true,
        force_rls: true,
        trigger_name: "trg_object_write_item_guard",
        trigger_mode: "A",
      },
      {
        table_name: "object_write_operations",
        rls: true,
        force_rls: true,
        trigger_name: "trg_object_write_operation_guard",
        trigger_mode: "A",
      },
    ]);
    expect(
      (
        await pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('mintvault_app','object_write_operations','DELETE') AS allowed"
        )
      ).rows[0].allowed
    ).toBe(false);
    expect(
      (
        await pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('partner_runtime','object_write_items','DELETE') AS allowed"
        )
      ).rows[0].allowed
    ).toBe(false);

    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(true);
    await pool.query("ALTER TABLE object_write_items NO FORCE ROW LEVEL SECURITY");
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(false);
    await pool.query("ALTER TABLE object_write_items FORCE ROW LEVEL SECURITY");
    await pool.query("DROP INDEX uq_object_write_operation_idempotency");
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(false);
    await pool.query(`
      CREATE UNIQUE INDEX uq_object_write_operation_idempotency
        ON object_write_operations (
          COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid),
          idempotency_key,
          aggregate_type
        )
    `);
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(false);
    await expect(pool.query(migration(FILENAME).sql)).rejects.toThrow(
      "incompatible uq_object_write_operation_idempotency index"
    );
    await pool.query("DROP INDEX uq_object_write_operation_idempotency");
    await pool.query(`
      CREATE UNIQUE INDEX uq_object_write_operation_idempotency
        ON object_write_operations (
          COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid),
          idempotency_key
        )
    `);
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(true);

    await pool.query("DROP INDEX uq_object_write_items_store_key");
    await pool.query(`
      CREATE UNIQUE INDEX uq_object_write_items_store_key
        ON object_write_items (store,object_key,logical_slot)
    `);
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(false);
    await expect(pool.query(migration(FILENAME).sql)).rejects.toThrow("incompatible uq_object_write_items_store_key index");
    await pool.query("DROP INDEX uq_object_write_items_store_key");
    await pool.query("CREATE UNIQUE INDEX uq_object_write_items_store_key ON object_write_items (store,object_key)");

    await pool.query("ALTER TABLE object_write_items DROP CONSTRAINT chk_object_write_item_verified");
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(false);
    await expect(pool.query(migration(FILENAME).sql)).rejects.toThrow(
      "incompatible chk_object_write_item_verified constraint"
    );
    await pool.query(`
      ALTER TABLE object_write_items
        ADD CONSTRAINT chk_object_write_item_verified CHECK (
          verification_state <> 'VERIFIED'
          OR (
            observed_sha256=content_sha256
            AND observed_byte_length=byte_length
            AND (store='R2' OR observed_version_id IS NOT NULL)
            AND verified_at IS NOT NULL
          )
        )
    `);
    expect((await pool.query<{ ready: boolean }>(OBJECT_WRITE_READINESS_SQL)).rows[0].ready).toBe(true);

    await expect(pool.query(migration(FILENAME).sql)).resolves.toBeDefined();
  });

  it("serializes manifest insertion before sealing so a late item cannot race publication", async () => {
    const creator = await pool.connect();
    const sealer = await pool.connect();
    try {
      const operation = await pool.query<{ id: string }>(
        `INSERT INTO object_write_operations
           (idempotency_key,operation_kind,aggregate_type,manifest_sha256,expected_state,intent_payload)
         VALUES ('seal-race','CERTIFICATE_IMAGE_REVISION','certificate',$1,'{}','{}')
         RETURNING id::text`,
        [HASH_A]
      );
      const operationId = operation.rows[0].id;
      await creator.query("BEGIN");
      await creator.query(
        `INSERT INTO object_write_items
           (operation_id,store,logical_slot,object_key,content_sha256,byte_length,content_type,object_class)
         VALUES ($1,'R2','front','object-write/test/seal-race/front',$2,10,'image/png','CANONICAL')`,
        [operationId, HASH_A]
      );

      await sealer.query("BEGIN");
      let sealSettled = false;
      const seal = sealer
        .query("UPDATE object_write_operations SET state='UPLOADING' WHERE id=$1", [operationId])
        .then(() => {
          sealSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sealSettled).toBe(false);
      await creator.query("COMMIT");
      await seal;
      await sealer.query("COMMIT");

      await expect(
        pool.query(
          `INSERT INTO object_write_items
             (operation_id,store,logical_slot,object_key,content_sha256,byte_length,content_type,object_class)
           VALUES ($1,'R2','back','object-write/test/seal-race/back',$2,10,'image/png','CANONICAL')`,
          [operationId, HASH_B]
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await creator.query("ROLLBACK").catch(() => {});
      await sealer.query("ROLLBACK").catch(() => {});
      creator.release();
      sealer.release();
    }
  });

  it("publishes only after every required item is byte/hash verified and keeps intent immutable", async () => {
    const operationId = await prepareOperation({ idempotencyKey: "state-machine" });
    await expect(
      asRole("mintvault_app", null, (client) =>
        client.query("UPDATE object_write_operations SET state='VERIFIED' WHERE id=$1", [operationId])
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asRole("mintvault_app", null, (client) =>
        client.query(
          `INSERT INTO object_write_operations
             (idempotency_key,operation_kind,aggregate_type,manifest_sha256,result_payload)
           VALUES ('forged-result','CERTIFICATE_IMAGE_REVISION','certificate',$1,'{}')`,
          [HASH_A]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });

    await asRole("mintvault_app", null, async (client) => {
      await client.query("UPDATE object_write_operations SET state='UPLOADING' WHERE id=$1", [operationId]);
      await client.query(
        `UPDATE object_write_items
            SET write_disposition='CREATED', verification_state='VERIFIED', observed_sha256=content_sha256,
                observed_byte_length=byte_length, verified_at=now()
          WHERE operation_id=$1`,
        [operationId]
      );
      await client.query("UPDATE object_write_operations SET state='VERIFIED' WHERE id=$1", [operationId]);
      await client.query("UPDATE object_write_operations SET state='COMMITTED',result_payload=$2::jsonb WHERE id=$1", [
        operationId,
        JSON.stringify({ certificateId: 1 }),
      ]);
    });
    expect(
      (
        await pool.query(
          "SELECT state,verified_at IS NOT NULL AS verified,committed_at IS NOT NULL AS committed FROM object_write_operations WHERE id=$1",
          [operationId]
        )
      ).rows[0]
    ).toEqual({ state: "COMMITTED", verified: true, committed: true });
    await expect(
      asRole("mintvault_app", null, (client) =>
        client.query("UPDATE object_write_operations SET aggregate_id='changed' WHERE id=$1", [operationId])
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asRole("mintvault_app", null, (client) =>
        client.query("UPDATE object_write_operations SET result_payload='{\"forged\":true}' WHERE id=$1", [operationId])
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces idempotency and tenant isolation through real runtime roles", async () => {
    await prepareOperation({ tenantId: TENANT_A, idempotencyKey: "tenant-a" });
    await prepareOperation({ tenantId: TENANT_B, idempotencyKey: "tenant-b", hash: HASH_B });
    await expect(prepareOperation({ tenantId: TENANT_A, idempotencyKey: "tenant-a" })).rejects.toMatchObject({
      code: "23505",
    });

    expect(
      await asRole("partner_runtime", TENANT_A, async (client) =>
        Number((await client.query("SELECT count(*)::int AS count FROM object_write_operations")).rows[0].count)
      )
    ).toBe(1);
    expect(
      await asRole("partner_runtime", TENANT_B, async (client) =>
        Number((await client.query("SELECT count(*)::int AS count FROM object_write_operations")).rows[0].count)
      )
    ).toBe(1);
    expect(
      await asRole("partner_runtime", TENANT_A, async (client) =>
        Number((await client.query("SELECT count(*)::int AS count FROM object_write_items")).rows[0].count)
      )
    ).toBe(1);
  });

  it("permits cleanup only for abandoned R2 objects and never for B2", async () => {
    const r2Operation = await prepareOperation({ idempotencyKey: "abandoned-r2" });
    await asRole("mintvault_app", null, async (client) => {
      await client.query("UPDATE object_write_operations SET state='ABANDONED' WHERE id=$1", [r2Operation]);
      await client.query(
        "UPDATE object_write_items SET write_disposition='CREATED',cleanup_state='PENDING',delete_after=now() WHERE operation_id=$1",
        [r2Operation]
      );
      await client.query("UPDATE object_write_items SET cleanup_state='CLEANED' WHERE operation_id=$1", [r2Operation]);
    });
    expect(
      (
        await pool.query(
          "SELECT cleanup_state,cleaned_at IS NOT NULL AS cleaned FROM object_write_items WHERE operation_id=$1",
          [r2Operation]
        )
      ).rows[0]
    ).toEqual({ cleanup_state: "CLEANED", cleaned: true });

    const b2Operation = await prepareOperation({ idempotencyKey: "abandoned-b2", store: "B2" });
    await asRole("mintvault_app", null, (client) =>
      client.query("UPDATE object_write_operations SET state='ABANDONED' WHERE id=$1", [b2Operation])
    );
    await expect(
      asRole("mintvault_app", null, (client) =>
        client.query("UPDATE object_write_items SET cleanup_state='PENDING',delete_after=now() WHERE operation_id=$1", [
          b2Operation,
        ])
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
