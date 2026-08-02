/**
 * Project Control — rollback / migration-ledger integrity.
 *
 * WHY THIS SUITE EXISTS, SEPARATELY FROM project-control-migration.integration.test.ts:
 *
 * That suite applies 0030 by calling `client.query(MIGRATION)` directly, against a database that
 * has no `schema_migrations` table at all. It therefore proves the rollback removes the Project
 * Control OBJECTS — and is structurally incapable of noticing whether the rollback retracts the
 * migration runner's LEDGER ROW, because in that harness there is no ledger.
 *
 * The runner's identity is the ledger row, not the presence of the tables
 * (scripts/db/migrate.ts decides what is pending by reading `schema_migrations`). A rollback that
 * drops the tables but leaves the row puts the environment into a state the runner cannot
 * recover from on its own: `db:migrate` reports 0 pending while every Project Control read fails
 * with `relation "pc_work_packages" does not exist`. Recovery then requires hand-written SQL
 * against a live host, during an incident.
 *
 * This suite therefore builds the ledger exactly as the runner does, and proves the full
 * apply -> rollback -> reapply cycle leaves BOTH the schema and the ledger consistent at every
 * step. It is the regression guard for that defect.
 *
 * Runs against a DISPOSABLE, ISOLATED, LOCAL database it creates and drops. It never touches
 * staging or production and never uses the application's own connection. It fails loudly rather
 * than skipping quietly; PROJECT_CONTROL_DB_TESTS=optional downgrades an unreachable server to a
 * skip only on a developer machine that genuinely has no PostgreSQL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";

const ROOT = join(__dirname, "..");
const MIGRATION_FILE = "0030_project_control.sql";
const MIGRATION_SQL = readFileSync(join(ROOT, "migrations", MIGRATION_FILE), "utf8");
const ROLLBACK_SQL = readFileSync(join(ROOT, "migrations/rollback-0030-project-control.sql"), "utf8");
const MIGRATION_SHA = createHash("sha256").update(MIGRATION_SQL, "utf8").digest("hex");

/**
 * The ledger DDL is copied from scripts/db/migrate.ts deliberately. If the runner's ledger shape
 * ever changes, this suite must be updated in step — that coupling is the point, not an accident.
 */
const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'applied',
  applied_by TEXT NOT NULL DEFAULT current_user
);`;

/** A neighbouring ledger row that the 0030 rollback must never touch. */
const UNRELATED_ROW = "0022_print_workflow_lifecycle.sql";

const ADMIN_URL =
  process.env.PROJECT_CONTROL_TEST_ADMIN_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:5432/postgres`;
const DB_NAME = `pc_rollback_journal_test_${process.pid}`;
const OPTIONAL = process.env.PROJECT_CONTROL_DB_TESTS === "optional";

let client: pg.Client | undefined;
let admin: pg.Client | undefined;
let reachable = false;
let bootError = "";

beforeAll(async () => {
  try {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);

    client = new pg.Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`) });
    await client.connect();
    reachable = true;
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

function db(): pg.Client {
  if (!reachable) {
    if (OPTIONAL) throw new Error(`SKIPPED-BY-CONFIG: ${bootError}`);
    throw new Error(`Disposable local database unavailable, so rollback integrity was NOT proven: ${bootError}`);
  }
  return client!;
}

async function count(sql: string): Promise<number> {
  const { rows } = await db().query(sql);
  return Number(rows[0].n);
}

const pcTables = () =>
  count(`SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema='public' AND table_name LIKE 'pc\\_%'`);
const pcForeignKeys = () =>
  count(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND conname LIKE 'fk\\_pc\\_%'`);
const pcTriggers = () =>
  count(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_pc%'`);
const pcFunctions = () => count(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'pc\\_%'`);
const journalRowsFor0030 = () =>
  count(`SELECT count(*)::int AS n FROM schema_migrations WHERE filename='${MIGRATION_FILE}'`);

/** Apply 0030 and journal it exactly as scripts/db/migrate.ts would. */
async function applyAndJournal(): Promise<void> {
  await db().query(MIGRATION_SQL);
  await db().query(
    `INSERT INTO schema_migrations (filename, checksum, completed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (filename) DO NOTHING`,
    [MIGRATION_FILE, MIGRATION_SHA]
  );
}

describe("Project Control rollback coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(
        process.env.PROJECT_CONTROL_TEST_ADMIN_URL,
        "PROJECT_CONTROL_TEST_ADMIN_URL must be set in CI or the rollback ledger contract is never proven"
      ).toBeTruthy();
      expect(OPTIONAL, "PROJECT_CONTROL_DB_TESTS=optional must never be used in CI").toBe(false);
      expect(reachable, `the Project Control database must be reachable in CI: ${bootError}`).toBe(true);
    }
  });
});

describe("rollback-0030 leaves the schema and the migration ledger consistent", () => {
  it("runs the full apply -> rollback -> reapply cycle without stranding the ledger", async () => {
    await db().query(JOURNAL_DDL);
    await db().query(
      `INSERT INTO schema_migrations (filename, checksum, completed_at)
       VALUES ($1, $2, now()) ON CONFLICT (filename) DO NOTHING`,
      [UNRELATED_ROW, "unrelated-checksum-not-a-real-migration"]
    );

    // ---- 1. apply ---------------------------------------------------------------------------
    await applyAndJournal();
    expect(await pcTables(), "0030 must create exactly nine pc_ tables").toBe(9);
    expect(await pcForeignKeys(), "0030 declares nine foreign keys").toBe(9);
    expect(await pcTriggers(), "0030 installs three pc triggers").toBe(3);
    expect(await journalRowsFor0030(), "the runner must consider 0030 applied").toBe(1);

    // ---- 2. rollback ------------------------------------------------------------------------
    await db().query(ROLLBACK_SQL);
    expect(await pcTables(), "rollback must remove every pc_ table").toBe(0);
    expect(await pcFunctions(), "rollback must remove the pc_ functions").toBe(0);

    // THE REGRESSION GUARD. Dropping the objects while leaving this row is the defect: the runner
    // would report nothing pending over a schema that no longer exists.
    expect(
      await journalRowsFor0030(),
      "rollback MUST retract the 0030 ledger row — otherwise db:migrate reports 0 pending over a schema that no longer exists, and every Project Control read fails"
    ).toBe(0);

    // ---- 3. reapply -------------------------------------------------------------------------
    // Only possible because the ledger row was retracted; this is what "recoverable" means.
    await applyAndJournal();
    expect(await pcTables(), "0030 must reapply cleanly after a rollback").toBe(9);
    expect(await pcForeignKeys(), "reapply must restore all nine foreign keys").toBe(9);
    expect(await journalRowsFor0030(), "reapply must re-journal exactly one row").toBe(1);
  }, 120_000);

  it("retracts only its own ledger row and never a neighbouring migration's", async () => {
    expect(
      await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE filename='${UNRELATED_ROW}'`),
      "the 0030 rollback must not touch any other migration's ledger row"
    ).toBe(1);
  });

  it("re-journals under the current file checksum, so the runner does not see drift", async () => {
    const { rows } = await db().query(`SELECT checksum FROM schema_migrations WHERE filename=$1`, [MIGRATION_FILE]);
    expect(rows[0].checksum).toBe(MIGRATION_SHA);
  });

  it("is idempotent: rolling back an already-rolled-back database is not an error", async () => {
    await db().query(ROLLBACK_SQL);
    expect(await pcTables()).toBe(0);
    expect(await journalRowsFor0030()).toBe(0);
    await db().query(ROLLBACK_SQL); // second run must not throw
    expect(await pcTables()).toBe(0);
    expect(await journalRowsFor0030()).toBe(0);
  }, 120_000);

  it("runs without a ledger table at all, so a disposable database is still rollback-able", async () => {
    await db().query(MIGRATION_SQL);
    expect(await pcTables()).toBe(9);
    await db().query(`DROP TABLE IF EXISTS schema_migrations`);
    await db().query(ROLLBACK_SQL); // the DO-block guard must swallow the missing ledger
    expect(await pcTables()).toBe(0);
  }, 120_000);
});
