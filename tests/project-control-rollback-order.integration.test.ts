/**
 * Project Control — rollback ORDER safety (0040 -> 0039 -> 0030).
 *
 * WHAT THIS SUITE IS DEFENDING
 *
 * 0030 is the base migration; 0039 and 0040 build on it. Running rollback-0030 while either was
 * still applied used to succeed SILENTLY, because nothing in the schema forced an error:
 * 0040's only reference into 0030's tables is fk_pc_work_packages_superseded_by, which is
 * SELF-referencing and drops with pc_work_packages rather than raising, and 0039's four tables
 * reference 0030 not at all.
 *
 * The damage is not the drop itself — it is the state left behind. Six orphaned tables, the 0039
 * and 0040 journal rows still claiming "applied", and only 0030's row retracted. A later
 * `db:migrate --apply` re-applies 0030 ALONE, recreating pc_work_packages WITHOUT the supersession
 * columns while the journal insists 0040 is applied. Every seed-repository query naming
 * superseded_at then fails at runtime: the canonical "journal says applied, column does not exist"
 * trap, reached through the rollback door.
 *
 * So the assertions here are about the DATABASE's state after the fact — which tables survive,
 * which journal rows survive, and whether a refused rollback wrote anything at all — not about
 * whether a statement returned an error. A guard that raised but had already dropped two tables
 * would pass a naive test and fail this one.
 *
 * Runs against a DISPOSABLE, ISOLATED, LOCAL PostgreSQL 17 database this file creates and drops.
 * It never touches staging or production. It fails loudly rather than skipping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const ROOT = join(__dirname, "..");
const sql = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8");

const M0030 = sql("0030_project_control.sql");
const M0039 = sql("0039_project_control_live_evidence.sql");
const M0040 = sql("0040_project_control_seed_reconciliation.sql");
const R0030 = sql("rollback-0030-project-control.sql");
const R0039 = sql("rollback-0039-project-control-live-evidence.sql");
const R0040 = sql("rollback-0040-project-control-seed-reconciliation.sql");

const BASE_TABLES = [
  "pc_nodes",
  "pc_work_packages",
  "pc_evidence",
  "pc_blockers",
  "pc_dependencies",
  "pc_deployments",
  "pc_test_runs",
  "pc_prompts",
  "pc_status_events",
];
const T0039 = ["pc_sync_runs", "pc_sync_leases", "pc_sync_checkpoints", "pc_evidence_snapshots"];
const T0040 = ["pc_seed_state", "pc_seed_runs"];

let cluster: DisposablePostgres17;
let db: pg.Pool;

/** The journal the runner maintains. Created here so rollbacks can retract their own rows. */
async function resetJournalAndSchema(): Promise<void> {
  for (const t of [...T0040, ...T0039, ...BASE_TABLES]) {
    await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await db.query(`DROP TABLE IF EXISTS schema_migrations CASCADE`);
  await db.query(`
    CREATE TABLE schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT,
      status TEXT NOT NULL DEFAULT 'applied',
      completed_at TIMESTAMPTZ DEFAULT now()
    )`);
}

async function applyAllThree(): Promise<void> {
  for (const [file, text] of [
    ["0030_project_control.sql", M0030],
    ["0039_project_control_live_evidence.sql", M0039],
    ["0040_project_control_seed_reconciliation.sql", M0040],
  ] as const) {
    await db.query(text);
    await db.query(
      `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
                    ON CONFLICT (filename) DO NOTHING`,
      [file, "x"]
    );
  }
}

async function tablesPresent(names: string[]): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
    [names]
  );
  return rows.map((r) => r.table_name);
}

async function journalRows(): Promise<string[]> {
  const { rows } = await db.query<{ filename: string }>(`SELECT filename FROM schema_migrations ORDER BY filename`);
  return rows.map((r) => r.filename);
}

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

beforeAll(async () => {
  cluster = await startPostgres17("pc-rollback-order");
  db = new pg.Pool({ connectionString: cluster.url, max: 4 });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await cluster?.stop();
});

beforeEach(async () => {
  await resetJournalAndSchema();
  await applyAllThree();
});

describe("Project Control rollback-order coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(cluster?.url, "disposable PostgreSQL 17 must be reachable in CI").toBeTruthy();
    }
  });

  it("starts each case from all three migrations genuinely applied", async () => {
    expect(await tablesPresent([...BASE_TABLES, ...T0039, ...T0040])).toHaveLength(15);
    expect(await columnsOf("pc_work_packages")).toContain("superseded_at");
    expect(await journalRows()).toHaveLength(3);
  }, 60_000);
});

describe("WRONG order is refused, and writes nothing", () => {
  it("rollback-0030 raises while 0039 and 0040 are still applied", async () => {
    await expect(db.query(R0030)).rejects.toThrow(/Refusing to roll back 0030/);
  }, 60_000);

  it("names the dependent objects precisely, not just 'something is wrong'", async () => {
    await expect(db.query(R0030)).rejects.toThrow(/pc_seed_state/);
    await expect(db.query(R0030)).rejects.toThrow(/rollback-0040/);
    await expect(db.query(R0030)).rejects.toThrow(/0040 -> 0039 -> 0030/);
  }, 60_000);

  it("performs ZERO destructive writes — all 15 tables and all 3 journal rows survive", async () => {
    await expect(db.query(R0030)).rejects.toThrow();
    // The whole point: a guard that raised AFTER dropping would pass the assertion above.
    expect(await tablesPresent([...BASE_TABLES, ...T0039, ...T0040])).toHaveLength(15);
    expect(await journalRows()).toEqual([
      "0030_project_control.sql",
      "0039_project_control_live_evidence.sql",
      "0040_project_control_seed_reconciliation.sql",
    ]);
    expect(await columnsOf("pc_work_packages")).toContain("superseded_at");
  }, 60_000);

  it("still refuses when only 0039 remains (0040 already rolled back)", async () => {
    await db.query(R0040);
    expect(await tablesPresent(T0040)).toEqual([]);
    await expect(db.query(R0030)).rejects.toThrow(/pc_sync_runs|pc_evidence_snapshots/);
    expect(await tablesPresent(BASE_TABLES)).toHaveLength(9);
  }, 60_000);

  it("preserves the neighbouring journal rows when it refuses", async () => {
    await expect(db.query(R0030)).rejects.toThrow();
    const rows = await journalRows();
    expect(rows).toContain("0039_project_control_live_evidence.sql");
    expect(rows).toContain("0040_project_control_seed_reconciliation.sql");
  }, 60_000);
});

describe("CORRECT order 0040 -> 0039 -> 0030 tears down cleanly", () => {
  it("removes every Project Control table and retracts every journal row", async () => {
    await db.query(R0040);
    expect(await tablesPresent(T0040)).toEqual([]);
    expect(await columnsOf("pc_work_packages")).not.toContain("superseded_at");
    expect(await journalRows()).not.toContain("0040_project_control_seed_reconciliation.sql");

    await db.query(R0039);
    expect(await tablesPresent(T0039)).toEqual([]);
    expect(await journalRows()).not.toContain("0039_project_control_live_evidence.sql");

    await db.query(R0030);
    expect(await tablesPresent(BASE_TABLES)).toEqual([]);
    expect(await journalRows()).toEqual([]);
  }, 90_000);

  it("leaves no orphaned pc_ object of any kind behind", async () => {
    await db.query(R0040);
    await db.query(R0039);
    await db.query(R0030);
    const { rows } = await db.query<{ n: string }>(
      `SELECT table_name AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'pc\\_%'
       UNION ALL
       SELECT routine_name FROM information_schema.routines
        WHERE routine_schema='public' AND routine_name LIKE '%pc\\_%'`
    );
    expect(rows.map((r) => r.n)).toEqual([]);
  }, 90_000);
});

describe("apply -> correct-order rollback -> REAPPLY returns to a working schema", () => {
  it("rebuilds all 15 tables with the supersession columns intact", async () => {
    await db.query(R0040);
    await db.query(R0039);
    await db.query(R0030);
    expect(await tablesPresent([...BASE_TABLES, ...T0039, ...T0040])).toEqual([]);

    await applyAllThree();

    expect(await tablesPresent([...BASE_TABLES, ...T0039, ...T0040])).toHaveLength(15);
    // The specific regression the ordering trap produced: 0030 re-applied alone would recreate
    // pc_work_packages WITHOUT these while the journal still claimed 0040 was applied.
    const cols = await columnsOf("pc_work_packages");
    expect(cols).toContain("superseded_at");
    expect(cols).toContain("superseded_by");
    expect(cols).toContain("superseded_reason");
    expect(await journalRows()).toHaveLength(3);
  }, 120_000);

  it("is re-runnable: applying the three again is a clean no-op", async () => {
    await expect(applyAllThree()).resolves.not.toThrow();
    expect(await tablesPresent([...BASE_TABLES, ...T0039, ...T0040])).toHaveLength(15);
  }, 90_000);
});
