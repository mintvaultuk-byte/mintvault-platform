/**
 * DATABASE AND MIGRATION EVIDENCE — including the B-2 repair.
 *
 * Two properties matter here and both are easy to get wrong in the dangerous direction:
 *
 *   1. UNAVAILABLE IS NOT "EVERYTHING PENDING". Inferring "pending" from "could not look" would
 *      manufacture a fake crisis on every transient blip, and an operator who sees one of those
 *      learns to ignore the next real one.
 *
 *   2. THE NINE FOREIGN KEYS ARE CHECKED BY NAME. The old check was `fks.length >= 7` against a
 *      comment claiming seven were expected, while migration 0030 creates nine — so a database
 *      missing two reported healthy. Every one of the nine is removed individually below.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  collectDatabaseEvidence,
  collectAndStoreDatabaseEvidence,
  verifyForeignKeys,
  repositoryMigrations,
  EXPECTED_PC_FOREIGN_KEYS,
  DATABASE_SOURCE,
} from "../server/project-control/database-evidence";
import {
  getRun,
  getLatestSnapshot,
  getLatestGoodSnapshot,
  type EvidenceDb,
} from "../server/project-control/evidence-repository";

let cluster: DisposablePostgres17;
let db: pg.Pool;

const ENV = { PROJECT_CONTROL_ENV: "staging" } as NodeJS.ProcessEnv;
const KEY = {
  sourceType: DATABASE_SOURCE,
  environment: "staging",
  entityType: "migration_ledger",
  entityId: "staging",
};

beforeAll(async () => {
  cluster = await startPostgres17("pc-database-evidence");
  db = new pg.Pool({ connectionString: cluster.url, max: 4 });
  await db.query(`CREATE TABLE IF NOT EXISTS pc_nodes (key text PRIMARY KEY)`);
  await db.query(`CREATE TABLE IF NOT EXISTS pc_work_packages (key text PRIMARY KEY)`);
  await db.query(readFileSync(join(__dirname, "..", "migrations/0039_project_control_live_evidence.sql"), "utf8"));
}, 240_000);

afterAll(async () => {
  await db?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

beforeEach(async () => {
  await db.query(`DELETE FROM pc_sync_leases`);
  await db.query(`DELETE FROM pc_sync_runs`);
  await db.query(`TRUNCATE pc_evidence_snapshots`);
});

/**
 * The migrations are the authority; this list is a copy, and a copy can drift. It DID drift:
 * 0040 added `fk_pc_work_packages_superseded_by` and nobody added it here, so staging reported a
 * legitimate constraint as `unexpected` on every refresh. These tests derive the truth from the
 * migration SQL in BOTH directions so the same omission cannot recur silently.
 */
const PC_FK_MIGRATIONS = ["0030_project_control.sql", "0040_project_control_seed_reconciliation.sql"];

function foreignKeysCreatedByMigrations(): string[] {
  const names = new Set<string>();
  for (const file of PC_FK_MIGRATIONS) {
    const sql = readFileSync(join(__dirname, "..", "migrations", file), "utf8");
    for (const m of sql.matchAll(/ADD\s+CONSTRAINT\s+(fk_pc_[a-z0-9_]+)|CONSTRAINT\s+(fk_pc_[a-z0-9_]+)\s+FOREIGN\s+KEY/gi)) {
      names.add((m[1] ?? m[2]).toLowerCase());
    }
  }
  return [...names].sort();
}

describe("B-2 — the Project Control foreign keys are verified by exact identity", () => {
  it("expects exactly ten, matching migrations 0030 and 0040", () => {
    expect(EXPECTED_PC_FOREIGN_KEYS).toHaveLength(10);
    const sql = PC_FK_MIGRATIONS.map((f) =>
      readFileSync(join(__dirname, "..", "migrations", f), "utf8")
    ).join("\n");
    for (const name of EXPECTED_PC_FOREIGN_KEYS) {
      expect(sql, `${name} is expected but no Project Control migration creates it`).toContain(name);
    }
  });

  /**
   * THE REGRESSION GUARD. Removing any migration-created FK from EXPECTED_PC_FOREIGN_KEYS turns
   * this RED — including `fk_pc_work_packages_superseded_by`, the one that actually drifted.
   */
  it("every foreign key the migrations create is declared expected", () => {
    const created = foreignKeysCreatedByMigrations();
    expect(created.length, "the migration scan found no pc_* foreign keys — the regex has rotted").toBeGreaterThan(0);
    expect(created).toContain("fk_pc_work_packages_superseded_by");
    for (const name of created) {
      expect(
        EXPECTED_PC_FOREIGN_KEYS,
        `${name} is created by a migration but is absent from EXPECTED_PC_FOREIGN_KEYS, so a correct constraint would be reported as unexpected`
      ).toContain(name);
    }
  });

  it("declares no phantom foreign key that no migration creates", () => {
    const created = foreignKeysCreatedByMigrations();
    for (const name of EXPECTED_PC_FOREIGN_KEYS) {
      expect(created, `${name} is expected but no migration creates it`).toContain(name);
    }
  });

  it("a complete schema produces NO warning", () => {
    const verdict = verifyForeignKeys([...EXPECTED_PC_FOREIGN_KEYS]);
    expect(verdict.intact).toBe(true);
    expect(verdict.missing).toEqual([]);
    expect(verdict.unexpected, "the real staging schema must report nothing unexpected").toEqual([]);
    expect(verdict.present).toHaveLength(10);
  });

  it("EACH of the nine, removed individually, is detected", () => {
    // The old `>= 7` rule passed with any two missing. Every one is now load-bearing.
    for (const omitted of EXPECTED_PC_FOREIGN_KEYS) {
      const observed = EXPECTED_PC_FOREIGN_KEYS.filter((n) => n !== omitted);
      const verdict = verifyForeignKeys([...observed]);
      expect(verdict.intact, `removing ${omitted} was not detected`).toBe(false);
      expect(verdict.missing, `${omitted} was not named as missing`).toEqual([omitted]);
    }
  });

  it("SEVEN present is NOT sufficient — the precise old defect", () => {
    const sevenOfTen = EXPECTED_PC_FOREIGN_KEYS.slice(0, 7);
    const verdict = verifyForeignKeys([...sevenOfTen]);
    expect(verdict.intact, "seven used to report healthy").toBe(false);
    expect(verdict.missing).toHaveLength(EXPECTED_PC_FOREIGN_KEYS.length - 7);
  });

  it("a RENAMED constraint appears as both missing and unexpected", () => {
    const renamed = [...EXPECTED_PC_FOREIGN_KEYS.slice(1), "fk_pc_blockers_package_v2"];
    const verdict = verifyForeignKeys(renamed);
    expect(verdict.missing).toEqual(["fk_pc_blockers_package"]);
    expect(verdict.unexpected, "a rename is a different problem from a deletion").toEqual([
      "fk_pc_blockers_package_v2",
    ]);
  });

  it("all ten present plus an extra is still intact — extras are reported, not fatal", () => {
    const verdict = verifyForeignKeys([...EXPECTED_PC_FOREIGN_KEYS, "fk_pc_future_thing"]);
    expect(verdict.intact).toBe(true);
    expect(verdict.unexpected).toEqual(["fk_pc_future_thing"]);
  });
});

describe("database evidence collection", () => {
  it("reports the journal, applied migrations and pending files", async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, status text NOT NULL)`);
    await db.query(`INSERT INTO schema_migrations (filename, status) VALUES ('0030_project_control.sql','applied')`);

    const evidence = await collectDatabaseEvidence(db, ENV);
    expect(evidence.available).toBe(true);
    expect(evidence.journalPresent).toBe(true);
    expect(evidence.appliedFilenames).toContain("0030_project_control.sql");
    expect(evidence.expectedFilenames.length, "the repository half of the comparison").toBeGreaterThan(0);
    expect(evidence.pendingFilenames, "0039 is authored but not applied here").toContain(
      "0039_project_control_live_evidence.sql"
    );
    await db.query(`DROP TABLE schema_migrations`);
  });

  it("a journal row that is NOT 'applied' is a contradiction, not a pending file", async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, status text NOT NULL)`);
    await db.query(`INSERT INTO schema_migrations (filename, status) VALUES ('0030_project_control.sql','running')`);

    const evidence = await collectDatabaseEvidence(db, ENV);
    expect(evidence.checksumMismatches).toContain("0030_project_control.sql");
    expect(evidence.contradictions.join(" ")).toMatch(/not in 'applied' state/);
    await db.query(`DROP TABLE schema_migrations`);
  });

  it("tables present with no journal is surfaced as a contradiction", async () => {
    const evidence = await collectDatabaseEvidence(db, ENV);
    // pc_nodes and pc_work_packages exist here without any journal.
    expect(evidence.journalPresent).toBe(false);
    expect(evidence.projectControlTablesPresent.length).toBeGreaterThan(0);
    expect(evidence.contradictions.join(" ")).toMatch(/no migration journal/i);
  });

  it("THE RULE: an unreadable database yields UNAVAILABLE, never 'everything pending'", async () => {
    const broken: EvidenceDb = {
      query: async () => {
        throw new Error("connection to server at 10.0.0.1:5432 failed: password authentication failed");
      },
    };
    const evidence = await collectDatabaseEvidence(broken, ENV);

    expect(evidence.available).toBe(false);
    expect(evidence.errorCode).toBe("database_evidence_unavailable");
    expect(
      evidence.pendingFilenames,
      "inferring 'pending' from 'could not look' manufactures a fake crisis"
    ).toEqual([]);
    expect(JSON.stringify(evidence), "a driver error can carry a DSN").not.toContain("password");
    expect(JSON.stringify(evidence)).not.toContain("10.0.0.1");
  });

  it("the repository migration inventory is read from disk", () => {
    const files = repositoryMigrations();
    expect(files).toContain("0030_project_control.sql");
    expect(files).toContain("0039_project_control_live_evidence.sql");
    expect(files.every((f) => /^\d{4,}_.+\.sql$/.test(f)), "rollback files must not be counted").toBe(true);
  });
});

describe("database evidence is persisted", () => {
  it("stores a snapshot for the connected environment only", async () => {
    const out = await collectAndStoreDatabaseEvidence(db, { triggerType: "manual", actor: "o@x.test" }, ENV);
    expect(out.started).toBe(true);

    const run = await getRun(db, out.syncId);
    expect(["SUCCEEDED", "UNAVAILABLE"]).toContain(run?.state);
    expect(run?.environment).toBe("staging");

    const snap = await getLatestSnapshot(db, KEY);
    expect(snap).not.toBeNull();
    const envs = await db.query(`SELECT DISTINCT environment FROM pc_evidence_snapshots WHERE source_type=$1`, [
      DATABASE_SOURCE,
    ]);
    expect(envs.rows.map((r) => r.environment), "a staging process must not claim production").toEqual(["staging"]);
  });

  it("a contradiction is CONTRADICTORY — a real observation, not an outage", async () => {
    // pc_ tables exist with no journal: the contradiction path.
    await collectAndStoreDatabaseEvidence(db, { triggerType: "manual" }, ENV);
    const snap = await getLatestSnapshot(db, KEY);
    expect(snap?.freshness).toBe("CONTRADICTORY");
    expect(snap?.status).toBe("contradictory");
  });

  it("a duplicate refresh coalesces", async () => {
    await db.query(
      `INSERT INTO pc_sync_runs (sync_id, source_type, trigger_type, target, state)
       VALUES ('db-held', $1, 'manual', 'staging', 'RUNNING')`,
      [DATABASE_SOURCE]
    );
    const second = await collectAndStoreDatabaseEvidence(db, { triggerType: "manual" }, ENV);
    expect(second.started).toBe(false);
    if (!second.started) expect(second.syncId).toBe("db-held");
  });

  it("last-known-good survives a later unavailable observation", async () => {
    // A usable observation first.
    await db.query(
      `INSERT INTO pc_evidence_snapshots (source_type, environment, entity_type, entity_id, status, freshness, payload_digest, payload)
       VALUES ($1,'staging','migration_ledger','staging','ok','CURRENT','d1','{"appliedCount":30}'::jsonb)`,
      [DATABASE_SOURCE]
    );
    // Then an outage.
    await db.query(
      `INSERT INTO pc_evidence_snapshots (source_type, environment, entity_type, entity_id, status, freshness, payload_digest, payload)
       VALUES ($1,'staging','migration_ledger','staging','unavailable','UNAVAILABLE','d2','{}'::jsonb)`,
      [DATABASE_SOURCE]
    );

    const latest = await getLatestSnapshot(db, KEY);
    const good = await getLatestGoodSnapshot(db, KEY);
    expect(latest?.freshness).toBe("UNAVAILABLE");
    expect(
      (good?.payload as { appliedCount?: number })?.appliedCount,
      "the last real migration state must survive an outage"
    ).toBe(30);
  });
});
