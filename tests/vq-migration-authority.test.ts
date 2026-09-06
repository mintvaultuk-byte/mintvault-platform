import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  applyScopedMigration,
  listMigrationFiles,
  migrationProfile,
  parseMigrationEstate,
  parseHistoricalBaseline,
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
  await client.query(
    "DROP TABLE IF EXISTS main_effect, vq_effect, schema_migrations, drizzle.vq_schema_migrations, public.vq_schema_migrations, public.vq_schema_baselines; DROP SEQUENCE IF EXISTS public.vq_schema_migrations_id_seq"
  );
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
    expect(profile.journalTable).toBe("drizzle.vq_schema_migrations");
    expect(profile.advisoryLockKey).toBe(4_150_206);
    const files = listMigrationFiles(profile.migrationsDir);
    expect(files).toHaveLength(17);
    expect(files[0].filename).toBe("0000_next_mister_fear.sql");
    expect(files.at(-1)?.filename).toBe("0016_schema_baseline_authority.sql");
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
      "SELECT to_regclass('public.schema_migrations') a, to_regclass('drizzle.vq_schema_migrations') b"
    );
    expect(result.rows[0]).toEqual({ a: null, b: null });
  });

  it("plans missing estates read-only without creating either journal", async () => {
    const schemaBefore = (await client.query("SELECT to_regnamespace('drizzle') schema")).rows;
    expect((await planMigrations(client, [main])).pending).toEqual([main.filename]);
    expect((await planMigrations(client, [vq], "vault-quest")).pending).toEqual([vq.filename]);
    const result = await client.query(
      "SELECT to_regclass('public.schema_migrations') a, to_regclass('drizzle.vq_schema_migrations') b"
    );
    expect(result.rows[0]).toEqual({ a: null, b: null });
    expect((await client.query("SELECT to_regnamespace('drizzle') schema")).rows).toEqual(schemaBefore);
  });

  it.each(["CREATE TABLE public.vq_schema_baselines (id text)", "CREATE SEQUENCE public.vq_schema_migrations_id_seq"])(
    "refuses partial public control residue without writes: %s",
    async (ddl) => {
      await client.query(ddl);
      const before = (await client.query("SELECT to_regnamespace('drizzle') schema")).rows;
      await expect(planMigrations(client, [vq], "vault-quest")).rejects.toThrow(/legacy public control state/);
      await expect(applyMigrations(client, [vq], { estate: "vault-quest" })).rejects.toThrow(
        /legacy public control state/
      );
      await expect(applyScopedMigration(client, vq.filename, { files: [vq], estate: "vault-quest" })).rejects.toThrow(
        /legacy public control state/
      );
      expect(
        (await client.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal
      ).toBeNull();
      expect((await client.query("SELECT to_regnamespace('drizzle') schema")).rows).toEqual(before);
      expect(
        (
          await client.query(
            "SELECT COALESCE(to_regclass('public.vq_schema_baselines'), to_regclass('public.vq_schema_migrations_id_seq')) residue"
          )
        ).rows[0].residue
      ).not.toBeNull();
    }
  );

  it("refuses old public control state without adopting, copying or deleting it", async () => {
    await client.query(
      "CREATE TABLE public.vq_schema_migrations (filename text); INSERT INTO public.vq_schema_migrations VALUES ('preserved-history')"
    );
    const before = (await client.query("SELECT to_regnamespace('drizzle') schema")).rows;
    await expect(planMigrations(client, [vq], "vault-quest")).rejects.toThrow(/legacy public control state/);
    await expect(applyMigrations(client, [vq], { estate: "vault-quest" })).rejects.toThrow(
      /legacy public control state/
    );
    await expect(applyScopedMigration(client, vq.filename, { files: [vq], estate: "vault-quest" })).rejects.toThrow(
      /legacy public control state/
    );
    expect((await client.query("SELECT * FROM public.vq_schema_migrations")).rows).toEqual([
      { filename: "preserved-history" },
    ]);
    expect(
      (await client.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal
    ).toBeNull();
    expect((await client.query("SELECT to_regnamespace('drizzle') schema")).rows).toEqual(before);
  });

  it("applies overlapping numeric identities separately and replays without effects", async () => {
    expect(await applyMigrations(client, [main])).toEqual({ applied: [main.filename] });
    expect(await applyMigrations(client, [vq], { estate: "vault-quest" })).toEqual({ applied: [vq.filename] });
    expect(await applyMigrations(client, [main])).toEqual({ applied: [] });
    expect(await applyMigrations(client, [vq], { estate: "vault-quest" })).toEqual({ applied: [] });
    expect((await client.query("SELECT filename, checksum, status FROM schema_migrations")).rows).toEqual([
      { filename: main.filename, checksum: main.checksum, status: "applied" },
    ]);
    expect((await client.query("SELECT filename, checksum, status FROM drizzle.vq_schema_migrations")).rows).toEqual([
      { filename: vq.filename, checksum: vq.checksum, status: "applied" },
    ]);
  });

  it("refuses an empty qualified journal over unjournalled business data but resumes a genuinely empty estate", async () => {
    await applyMigrations(client, [], { estate: "vault-quest" });
    expect((await planMigrations(client, [vq], "vault-quest")).pending).toEqual([vq.filename]);
    await client.query("CREATE TABLE vq_effect (id integer)");
    const changed = file(vq.filename, "ALTER TABLE vq_effect ADD COLUMN replayed integer");
    await expect(planMigrations(client, [changed], "vault-quest")).rejects.toThrow(/unjournalled/);
    await expect(applyMigrations(client, [changed], { estate: "vault-quest" })).rejects.toThrow(/unjournalled/);
    expect((await client.query("SELECT count(*)::int n FROM drizzle.vq_schema_migrations")).rows[0].n).toBe(0);
    expect(
      (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='vq_effect' AND column_name='replayed'"
        )
      ).rowCount
    ).toBe(0);
  });

  it("refuses VQ checksum drift, failed state and same-estate numeric collision", async () => {
    await applyMigrations(client, [vq], { estate: "vault-quest" });
    await expect(
      applyMigrations(client, [file(vq.filename, vq.sql + "; SELECT 1")], { estate: "vault-quest" })
    ).rejects.toThrow(/Checksum mismatch/);
    await client.query("UPDATE drizzle.vq_schema_migrations SET status='failed'");
    await expect(applyMigrations(client, [vq, forward], { estate: "vault-quest" })).rejects.toThrow(/inconsistent/);
    await client.query("UPDATE drizzle.vq_schema_migrations SET status='applied'");
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
      /no drizzle.vq_schema_migrations journal/
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
    expect((await client.query("SELECT filename FROM drizzle.vq_schema_migrations ORDER BY filename")).rows).toEqual([
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
      (await client.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal
    ).toBeNull();
  });

  it("rechecks public control residue under the scoped lock before any migration effect", async () => {
    await applyMigrations(client, [vq], { estate: "vault-quest" });
    const before = (await client.query("SELECT * FROM drizzle.vq_schema_migrations")).rows;
    let injected = false;
    const racingClient = {
      async query(sql: string, args?: unknown[]) {
        if (!injected && sql.includes("pg_try_advisory_lock")) {
          injected = true;
          await client.query("CREATE TABLE public.vq_schema_migrations (filename text)");
        }
        return client.query(sql, args);
      },
    };
    await expect(
      applyScopedMigration(racingClient, forward.filename, { files: [vq, forward], estate: "vault-quest" })
    ).rejects.toThrow(/legacy public control state/);
    expect(injected).toBe(true);
    expect((await client.query("SELECT * FROM drizzle.vq_schema_migrations")).rows).toEqual(before);
    expect(
      (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='vq_effect' AND column_name='proof'"
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await client.query("SELECT to_regclass('public.vq_schema_migrations') legacy")).rows[0].legacy
    ).not.toBeNull();
  });
});

describe("fresh immutable VQ estate through the real CLI", () => {
  it("journals all seventeen files exactly once and retains durable rows and constraints", async () => {
    const fresh = await startPostgres17("vq-fresh-cli");
    const admin = new pg.Client({ connectionString: fresh.url });
    await admin.connect();
    await admin.query("CREATE DATABASE mintvault_vq_phase10_local");
    await admin.end();
    const target = new URL(fresh.url);
    target.pathname = "/mintvault_vq_phase10_local";
    const db = new pg.Client({ connectionString: target.href });
    await db.connect();
    const run = (apply: boolean) =>
      execFileSync(
        process.execPath,
        [
          "node_modules/tsx/dist/cli.mjs",
          "scripts/db/migrate.ts",
          "--estate",
          "vault-quest",
          ...(apply ? ["--apply"] : []),
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            LANG: "C",
            LC_ALL: "C",
            NODE_ENV: "test",
            MINTVAULT_MIGRATION_DATABASE_URL: target.href,
          },
          timeout: 30_000,
        }
      );
    try {
      expect(run(false)).toContain("17 pending");
      expect((await db.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal).toBeNull();
      const prepareMain = () =>
        execFileSync(process.execPath, ["--import", "tsx", "scripts/ci/prepare-vq-test-db.mjs"], {
          env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TEST_DATABASE_URL: target.href },
          timeout: 30_000,
        });
      prepareMain();
      await db.query("UPDATE public.schema_migrations SET status='failed'");
      const invalidBefore = (await db.query("SELECT * FROM public.schema_migrations")).rows;
      expect(() => prepareMain()).toThrow(/invalid main migration lineage/);
      expect((await db.query("SELECT * FROM public.schema_migrations")).rows).toEqual(invalidBefore);
      await db.query("UPDATE public.schema_migrations SET status='applied'");
      prepareMain();
      expect(run(true)).toContain("Applied 17:");
      const files = listMigrationFiles(migrationProfile("vault-quest").migrationsDir);
      const journal = (
        await db.query(
          "SELECT filename, checksum, status, completed_at IS NOT NULL completed FROM drizzle.vq_schema_migrations ORDER BY filename"
        )
      ).rows;
      expect(journal).toEqual(
        files.map((f) => ({ filename: f.filename, checksum: f.checksum, status: "applied", completed: true }))
      );
      expect((await db.query("SELECT filename FROM public.schema_migrations")).rows).toEqual([
        { filename: "0121_main_runtime_role_authority.sql" },
      ]);
      expect((await db.query("SELECT * FROM drizzle.vq_schema_baselines")).rows).toEqual([]);
      await db.query("SET ROLE mintvault_app");
      expect((await db.query("SELECT count(*)::int count FROM drizzle.vq_schema_migrations")).rows[0].count).toBe(17);
      await expect(db.query("DELETE FROM drizzle.vq_schema_migrations")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("DELETE FROM vq_export_jobs")).rejects.toMatchObject({ code: "42501" });
      await db.query("RESET ROLE");
      await db.query(
        "INSERT INTO vq_feature_flags (feature, enabled) VALUES ('gen_action_pose', false), ('auto_paid_retry', false)"
      );
      await db.query(
        "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key,ids) VALUES ('test','synthetic-admin','fresh-proof','[1]')"
      );
      const before = (await db.query("SELECT * FROM vq_export_jobs")).rows;
      expect(run(true)).toContain("Applied 0:");
      expect((await db.query("SELECT * FROM vq_export_jobs")).rows).toEqual(before);
      expect((await db.query("SELECT count(*)::int count FROM drizzle.vq_schema_migrations")).rows[0].count).toBe(17);
      await expect(
        db.query(
          "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key) VALUES ('test','synthetic-admin','fresh-proof')"
        )
      ).rejects.toMatchObject({ code: "23505" });
      await expect(db.query("UPDATE vq_export_jobs SET attempt_count=-1")).rejects.toMatchObject({ code: "23514" });
      await expect(db.query("UPDATE vq_export_jobs SET ids='{}'")).rejects.toThrow();
      expect((await db.query("SELECT * FROM vq_export_jobs")).rows).toEqual(before);
    } finally {
      await db.end();
      await fresh.stop();
    }
  }, 60_000);
});

describe("closed historical CLI selection", () => {
  it("rejects ambiguous or cross-estate historical commands before credentials", () => {
    expect(parseHistoricalBaseline([], "main")).toBe(false);
    expect(
      parseHistoricalBaseline(["--estate", "vault-quest", "--historical-baseline-v1", "--apply"], "vault-quest")
    ).toBe(true);
    for (const extra of ["--unexpected", "--apply", "--convergence-mode=true"]) {
      expect(() =>
        parseHistoricalBaseline(
          ["--estate", "vault-quest", "--historical-baseline-v1", "--apply", extra],
          "vault-quest"
        )
      ).toThrow();
    }
    for (const args of [
      ["--historical-baseline-v1"],
      ["--historical-baseline-v1=true", "--apply"],
      ["--historical-baseline-v1", "--historical-baseline-v1", "--apply"],
      ["--historical-baseline-v1", "--apply", "--only", "0016_schema_baseline_authority.sql"],
      ["--historical-baseline-v1", "--apply", "--allow-destructive"],
    ]) {
      expect(() => parseHistoricalBaseline(args, "vault-quest")).toThrow();
    }
    expect(() => parseHistoricalBaseline(["--historical-baseline-v1", "--apply"], "main")).toThrow();
  });
});
