import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  applyScopedMigration,
  listMigrationFiles,
  migrationProfile,
  parseMigrationEstate,
  planMigrations,
  type MigrationEstate,
} from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

// Namespace proof only: these synthetic files cannot attest historical VQ schema.
const file = (filename: string, sql: string) => ({
  number: filename.slice(0, 4),
  filename,
  path: `/synthetic/${filename}`,
  sql,
  checksum: createHash("sha256").update(sql).digest("hex"),
  noTransaction: false,
});
const main = file("0000_main.sql", "CREATE TABLE main_effect (id integer)");
const vq = file("0000_vq.sql", "CREATE TABLE vq_effect (id integer)");
const forward = file("0001_vq_forward.sql", "ALTER TABLE vq_effect ADD COLUMN proof text");
let cluster: DisposablePostgres17;
let client: pg.Client;

beforeAll(async () => {
  cluster = await startPostgres17("vq-migration-authority");
  client = new pg.Client({ connectionString: cluster.url });
  await client.connect();
}, 60_000);
afterAll(async () => {
  await client?.end();
  await cluster?.stop();
});
beforeEach(async () => {
  // Only this helper-owned synthetic cluster, never a configured application URL.
  await client.query("DROP TABLE IF EXISTS main_effect, vq_effect, schema_migrations, vq_schema_migrations");
});

describe("closed migration estate namespace", () => {
  it("preserves main defaults and selects the repository VQ inventory explicitly", () => {
    expect(migrationProfile()).toEqual({
      estate: "main",
      migrationsDir: join(process.cwd(), "migrations"),
      journalTable: "schema_migrations",
      advisoryLockKey: 4_150_205,
    });
    const profile = migrationProfile("vault-quest");
    expect(profile.journalTable).toBe("vq_schema_migrations");
    expect(profile.advisoryLockKey).toBe(4_150_206);
    const files = listMigrationFiles(profile.migrationsDir);
    expect(files).toHaveLength(16);
    expect(files[0].filename).toBe("0000_next_mister_fear.sql");
    expect(files.at(-1)?.filename).toBe("0015_feature_flags_generation_types.sql");
  });

  it("rejects ambiguous CLI choices before database work", async () => {
    expect(parseMigrationEstate([])).toBe("main");
    expect(parseMigrationEstate(["--estate", "vault-quest", "--apply"])).toBe("vault-quest");
    for (const args of [
      ["--estate"],
      ["--estate", "other"],
      ["--estate=vault-quest"],
      ["--estate", "main", "--estate", "vault-quest"],
      ["--estate", "--apply"],
    ]) {
      expect(() => parseMigrationEstate(args)).toThrow();
    }
    const invalid = "arbitrary_table" as MigrationEstate;
    await expect(applyMigrations(client, [vq], { estate: invalid })).rejects.toThrow(/estate/);
    await expect(planMigrations(client, [vq], invalid)).rejects.toThrow(/estate/);
    await expect(applyScopedMigration(client, vq.filename, { files: [vq], estate: invalid })).rejects.toThrow(/estate/);
    const result = await client.query(
      "SELECT to_regclass('public.schema_migrations') a, to_regclass('public.vq_schema_migrations') b"
    );
    expect(result.rows[0]).toEqual({ a: null, b: null });
  });

  it("plans missing estates read-only without creating either journal", async () => {
    expect((await planMigrations(client, [main])).pending).toEqual([main.filename]);
    expect((await planMigrations(client, [vq], "vault-quest")).pending).toEqual([vq.filename]);
    const result = await client.query(
      "SELECT to_regclass('public.schema_migrations') a, to_regclass('public.vq_schema_migrations') b"
    );
    expect(result.rows[0]).toEqual({ a: null, b: null });
  });

  it("applies overlapping numeric identities separately and replays without effects", async () => {
    expect(await applyMigrations(client, [main])).toEqual({ applied: [main.filename] });
    expect(await applyMigrations(client, [vq], { estate: "vault-quest" })).toEqual({ applied: [vq.filename] });
    expect(await applyMigrations(client, [main])).toEqual({ applied: [] });
    expect(await applyMigrations(client, [vq], { estate: "vault-quest" })).toEqual({ applied: [] });
    expect((await client.query("SELECT filename, checksum, status FROM schema_migrations")).rows).toEqual([
      { filename: main.filename, checksum: main.checksum, status: "applied" },
    ]);
    expect((await client.query("SELECT filename, checksum, status FROM vq_schema_migrations")).rows).toEqual([
      { filename: vq.filename, checksum: vq.checksum, status: "applied" },
    ]);
  });

  it("refuses VQ checksum drift, failed state and same-estate numeric collision", async () => {
    await applyMigrations(client, [vq], { estate: "vault-quest" });
    await expect(
      applyMigrations(client, [file(vq.filename, vq.sql + "; SELECT 1")], { estate: "vault-quest" })
    ).rejects.toThrow(/Checksum mismatch/);
    await client.query("UPDATE vq_schema_migrations SET status='failed'");
    await expect(applyMigrations(client, [vq, forward], { estate: "vault-quest" })).rejects.toThrow(/inconsistent/);
    await client.query("UPDATE vq_schema_migrations SET status='applied'");
    await expect(
      applyMigrations(client, [file("0000_collision.sql", "SELECT 1")], { estate: "vault-quest" })
    ).rejects.toThrow(/identity conflict/);
    expect(
      (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='vq_effect' AND column_name='proof'"
        )
      ).rowCount
    ).toBe(0);
  });

  it("uses VQ's own lock while leaving the main lock independently usable", async () => {
    const holder = new pg.Client({ connectionString: cluster.url });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [migrationProfile("vault-quest").advisoryLockKey]);
      await expect(applyMigrations(client, [vq], { estate: "vault-quest" })).rejects.toThrow(/advisory lock/);
      expect(await applyMigrations(client, [main])).toEqual({ applied: [main.filename] });
    } finally {
      await holder.end();
    }
    expect(await applyMigrations(client, [vq], { estate: "vault-quest" })).toEqual({ applied: [vq.filename] });
  });

  it("scopes the exact forward migration and fingerprint to VQ, never the main journal", async () => {
    await applyMigrations(client, [main]);
    // A main journal does not bootstrap a VQ historical lineage.
    await expect(applyScopedMigration(client, vq.filename, { files: [vq], estate: "vault-quest" })).rejects.toThrow(
      /no vq_schema_migrations journal/
    );
    await applyMigrations(client, [vq], { estate: "vault-quest" });
    const before = (await client.query("SELECT * FROM schema_migrations")).rows;
    expect(
      await applyScopedMigration(client, forward.filename, { files: [vq, forward], estate: "vault-quest" })
    ).toMatchObject({ applied: true, journalBefore: 1, journalAfter: 2 });
    expect(
      await applyScopedMigration(client, forward.filename, { files: [vq, forward], estate: "vault-quest" })
    ).toMatchObject({ applied: false, reason: "already_applied", journalBefore: 2, journalAfter: 2 });
    expect((await client.query("SELECT * FROM schema_migrations")).rows).toEqual(before);
    expect((await client.query("SELECT filename FROM vq_schema_migrations ORDER BY filename")).rows).toEqual([
      { filename: vq.filename },
      { filename: forward.filename },
    ]);
    expect((await client.query("SELECT proof FROM vq_effect")).rows).toEqual([]);
  });

  it("never accepts the main lineage exclusions for a VQ apply", async () => {
    await expect(
      applyMigrations(client, [vq], {
        estate: "vault-quest",
        exclusions: [
          {
            incoming: vq.filename,
            occupant: main.filename,
            supersededBy: forward.filename,
            reason: "synthetic",
          },
        ],
      })
    ).rejects.toThrow(/does not accept main-lineage/);
    expect(
      (await client.query("SELECT to_regclass('public.vq_schema_migrations') journal")).rows[0].journal
    ).toBeNull();
  });
});
