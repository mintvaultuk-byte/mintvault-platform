import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles, migrationProfile } from "../scripts/db/migrate";
import {
  VQ_BASELINE_FINGERPRINT,
  VQ_BASELINE_RELATIONS,
  VQ_BASELINE_MIGRATION_SET_SHA256,
  VQ_SCHEMA_CATALOG_SQL,
  vqSchemaFingerprint,
} from "../server/lib/vq-schema-contract";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let db: pg.Client;
let expected: string;
const files = listMigrationFiles(migrationProfile("vault-quest").migrationsDir).filter((f) => Number(f.number) <= 15);
const fingerprint = async () => vqSchemaFingerprint((await db.query(VQ_SCHEMA_CATALOG_SQL)).rows[0].catalog);

beforeAll(async () => {
  cluster = await startPostgres17("vq-catalog");
  db = new pg.Client({ connectionString: cluster.url });
  await db.connect();
  await applyMigrations(db, files, { estate: "vault-quest" });
  expected = await fingerprint();
}, 60_000);
afterAll(async () => {
  await db?.end();
  await cluster?.stop();
});
beforeEach(async () => {
  await db.query("BEGIN");
});
afterEach(async () => {
  await db.query("ROLLBACK");
});

describe("immutable VQ historical schema catalog", () => {
  it("remains compatible with immutable main runtime authority after VQ creation", async () => {
    await db.query(
      "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key) VALUES ('test','synthetic','main-after-vq')"
    );
    const before = (await db.query("SELECT * FROM vq_export_jobs")).rows;
    await db.query(readFileSync("migrations/0121_main_runtime_role_authority.sql", "utf8"));
    expect((await db.query("SELECT * FROM vq_export_jobs")).rows).toEqual(before);
    expect(await fingerprint()).toBe(VQ_BASELINE_FINGERPRINT);
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('mintvault_app','public.vq_export_jobs','INSERT') insert_ok, has_table_privilege('mintvault_app','public.vq_export_jobs','DELETE') delete_ok"
        )
      ).rows[0]
    ).toEqual({ insert_ok: true, delete_ok: false });
  });
  it("pins source inventory and structural evidence, not a fabricated migration history", async () => {
    expect(files).toHaveLength(16);
    const sourceHash = createHash("sha256")
      .update(files.map((f) => `${f.filename}:${f.checksum}`).join("\n"))
      .digest("hex");
    expect({ sourceHash, expected }).toEqual({
      sourceHash: VQ_BASELINE_MIGRATION_SET_SHA256,
      expected: VQ_BASELINE_FINGERPRINT,
    });
    const catalog = (await db.query(VQ_SCHEMA_CATALOG_SQL)).rows[0].catalog;
    expect(catalog).toHaveLength(26);
    expect(catalog.map((relation: { name: string }) => relation.name)).toEqual(VQ_BASELINE_RELATIONS);
  });

  it.each([
    ["column", "ALTER TABLE vq_export_jobs DROP COLUMN ids"],
    ["column type", "ALTER TABLE vq_export_jobs ALTER COLUMN output_size TYPE numeric"],
    ["nullability", "ALTER TABLE vq_export_jobs ALTER COLUMN owner_admin_id DROP NOT NULL"],
    ["default", "ALTER TABLE vq_export_jobs ALTER COLUMN attempt_count SET DEFAULT 1"],
    ["index", "DROP INDEX vq_export_jobs_idem_active_uq"],
    ["constraint", "ALTER TABLE vq_export_jobs DROP CONSTRAINT vq_export_jobs_attempt_nonneg"],
    ["sequence", "ALTER SEQUENCE vq_export_jobs_id_seq INCREMENT BY 2"],
    ["unexpected table", "CREATE TABLE vq_unexpected (id integer)"],
    ["missing table", "DROP TABLE vq_feature_flags"],
    ["row policy state", "ALTER TABLE vq_export_jobs ENABLE ROW LEVEL SECURITY"],
    [
      "unvalidated constraint",
      "ALTER TABLE vq_export_jobs DROP CONSTRAINT vq_export_jobs_attempt_nonneg; ALTER TABLE vq_export_jobs ADD CONSTRAINT vq_export_jobs_attempt_nonneg CHECK (attempt_count >= 0) NOT VALID",
    ],
    [
      "trigger",
      "CREATE FUNCTION vq_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER vq_test BEFORE INSERT ON vq_export_jobs FOR EACH ROW EXECUTE FUNCTION vq_test_trigger()",
    ],
  ])("detects changed %s without a baseline or schema write of its own", async (_name, mutation) => {
    await db.query(mutation);
    expect(await fingerprint()).not.toBe(expected);
    expect((await db.query("SELECT to_regclass('drizzle.vq_schema_baselines') receipt")).rows[0].receipt).toBeNull();
    expect((await db.query("SELECT count(*)::int count FROM drizzle.vq_schema_migrations")).rows[0].count).toBe(16);
  });

  it("ignores row contents and sequence consumption, not structural changes", async () => {
    await db.query(
      "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key) VALUES ('test','synthetic','catalog-proof')"
    );
    await db.query("UPDATE vq_export_jobs SET completed_count=1");
    expect(await fingerprint()).toBe(expected);
  });

  it("rejects malformed catalogs and never treats an empty catalog as the baseline", () => {
    expect(() => vqSchemaFingerprint(null)).toThrow(/array/);
    expect(() => vqSchemaFingerprint([undefined])).toThrow(/Invalid/);
    expect(vqSchemaFingerprint([])).not.toBe(VQ_BASELINE_FINGERPRINT);
    expect(vqSchemaFingerprint([{ a: 1, b: 2 }])).toBe(vqSchemaFingerprint([{ b: 2, a: 1 }]));
  });

  it("does not mistake the main journal or any execution ledger for schema evidence", async () => {
    await db.query("DROP TABLE drizzle.vq_schema_migrations");
    await db.query("CREATE TABLE schema_migrations (filename text)");
    expect(await fingerprint()).toBe(expected);
    expect((await db.query("SELECT count(*)::int count FROM schema_migrations")).rows[0].count).toBe(0);
    expect((await db.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal).toBeNull();
  });
});
