/**
 * Project Control — schema-registry / preflight recognition.
 *
 * WHAT THIS SUITE IS DEFENDING
 *
 * The fail-closed preflight (scripts/db/preflight-schema.ts) refuses to proceed when a live
 * object is in NEITHER the managed allowlist (derived from shared/schema.ts) NOR the classified
 * unmanaged inventory. Migrations 0039 and 0040 create six tables that were in neither set, so
 * applying them turned the very next `npm run db:preflight` into a hard stop with six UNKNOWN
 * objects — blocking the sanctioned db:preflight -> db:migrate pipeline this project uses for
 * every staging and production schema change.
 *
 * The failure was loud and destroyed nothing, which is exactly why it must be fixed rather than
 * worked around: the preflight is the gate, and a gate that must be bypassed to deploy is not a
 * gate.
 *
 * The two properties that matter pull in opposite directions, and both are asserted here:
 *   1. every table the Project Control migrations actually create must be RECOGNISED; and
 *   2. a pc_ table nobody declared must still FAIL CLOSED.
 * A `name.startsWith("pc_")` predicate would satisfy (1) and silently destroy (2), so the six
 * tables are registered individually and (2) is pinned by its own case.
 *
 * The expected set is derived from the migration SQL rather than hand-copied, so a future
 * migration that adds a pc_ table turns this suite RED instead of quietly shrinking coverage.
 * That derivation is what makes the mutation proof meaningful: deleting any single entry from
 * UNMANAGED_INVENTORY or from PC_TABLES turns a case here RED.
 *
 * Runs against a DISPOSABLE, ISOLATED, LOCAL PostgreSQL 17 database. It never touches staging or
 * production. It fails loudly rather than skipping.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { managedTables, inventoriedTables, classifyLiveObjects } from "../scripts/db/schema-registry";
import { evaluatePreflight } from "../scripts/db/preflight-schema";
import { PC_TABLES } from "../server/project-control/database-evidence";

const ROOT = join(__dirname, "..");
const MIGRATIONS = join(ROOT, "migrations");
const PC_MIGRATIONS = [
  "0030_project_control.sql",
  "0039_project_control_live_evidence.sql",
  "0040_project_control_seed_reconciliation.sql",
];

/** Every `pc_*` table the Project Control migrations create, read from the SQL itself. */
function pcTablesDeclaredInMigrations(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{4,}_.+\.sql$/.test(f))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(pc_[a-z0-9_]+)/gi)) {
      found.add(m[1].toLowerCase());
    }
  }
  return [...found].sort();
}

let cluster: DisposablePostgres17;
let db: pg.Pool;

beforeAll(async () => {
  cluster = await startPostgres17("pc-schema-registry");
  db = new pg.Pool({ connectionString: cluster.url, max: 4 });
  for (const file of PC_MIGRATIONS) {
    await db.query(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
}, 180_000);

afterAll(async () => {
  await db?.end();
  await cluster?.stop();
});

describe("Project Control schema-registry coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(cluster?.url, "disposable PostgreSQL 17 must be reachable in CI").toBeTruthy();
    }
  });
});

describe("every Project Control table the migrations create is recognised", () => {
  it("derives a non-trivial expected set from the migration SQL", () => {
    const declared = pcTablesDeclaredInMigrations();
    // 9 from 0030 + 4 from 0039 + 2 from 0040. A regex that silently matched nothing would
    // make every assertion below vacuously true, so the shape is pinned first.
    expect(declared.length).toBe(15);
    expect(declared).toContain("pc_status_events");
    expect(declared).toContain("pc_evidence_snapshots");
    expect(declared).toContain("pc_seed_runs");
  });

  it("classifies all 15 as managed or inventoried — never unknown", () => {
    const declared = pcTablesDeclaredInMigrations();
    const c = classifyLiveObjects({
      tables: declared,
      views: [],
      matviews: [],
      schemas: ["public"],
      orphanSequences: [],
      enums: [],
    });
    expect(c.unknown).toEqual([]);
    expect([...c.managed, ...c.unmanaged].sort()).toEqual(declared);
  });

  it("keeps 0030's nine in the MANAGED set (they are declared in shared/schema.ts)", () => {
    const managed = new Set(managedTables());
    for (const t of [
      "pc_nodes",
      "pc_work_packages",
      "pc_dependencies",
      "pc_evidence",
      "pc_blockers",
      "pc_deployments",
      "pc_test_runs",
      "pc_prompts",
      "pc_status_events",
    ]) {
      expect(managed.has(t), `${t} must be managed via shared/schema.ts`).toBe(true);
    }
  });

  it("registers 0039/0040's six as INVENTORIED, and never double-classifies them", () => {
    const managed = new Set(managedTables());
    const inventoried = new Set(inventoriedTables());
    for (const t of [
      "pc_sync_runs",
      "pc_sync_leases",
      "pc_sync_checkpoints",
      "pc_evidence_snapshots",
      "pc_seed_state",
      "pc_seed_runs",
    ]) {
      expect(inventoried.has(t), `${t} must be in UNMANAGED_INVENTORY`).toBe(true);
      // Drizzle must never diff these — they are raw-SQL-only evidence/seed ledgers.
      expect(managed.has(t), `${t} must NOT be in shared/schema.ts`).toBe(false);
    }
  });
});

describe("an undeclared pc_ object still fails closed", () => {
  it("classifies an unrecognised pc_ table as UNKNOWN", () => {
    const c = classifyLiveObjects({
      tables: [...pcTablesDeclaredInMigrations(), "pc_rogue_table"],
      views: [],
      matviews: [],
      schemas: ["public"],
      orphanSequences: [],
      enums: [],
    });
    // This is the case a `startsWith("pc_")` shortcut would destroy.
    expect(c.unknown).toEqual([{ objectType: "table", name: "pc_rogue_table" }]);
    expect(
      evaluatePreflight({
        tables: ["pc_rogue_table"],
        views: [],
        matviews: [],
        schemas: ["public"],
        orphanSequences: [],
        enums: [],
      }).ok
    ).toBe(false);
  });

  it("fails closed on an unrecognised pc_ VIEW as well as a table", () => {
    const c = classifyLiveObjects({
      tables: [],
      views: ["pc_rogue_view"],
      matviews: [],
      schemas: ["public"],
      orphanSequences: [],
      enums: [],
    });
    expect(c.unknown).toEqual([{ objectType: "view", name: "pc_rogue_view" }]);
  });
});

describe("no customer, payment or grading table is reclassified", () => {
  it("leaves the protected managed tables in MANAGED", () => {
    const c = classifyLiveObjects({
      tables: [
        "certificates",
        "certificate_images",
        "cert_counter",
        "submissions",
        "submission_items",
        "users",
        "pc_seed_runs",
      ],
      views: [],
      matviews: [],
      schemas: ["public"],
      orphanSequences: [],
      enums: [],
    });
    // The six new entries are additive: they must not pull an existing table out of MANAGED.
    for (const t of [
      "certificates",
      "certificate_images",
      "cert_counter",
      "submissions",
      "submission_items",
      "users",
    ]) {
      expect(c.managed, `${t} must remain managed`).toContain(t);
      expect(c.unmanaged).not.toContain(t);
    }
    expect(c.unknown).toEqual([]);
  });

  it("adds exactly six entries to the inventory, all Project Control", () => {
    const pcInInventory = inventoriedTables().filter((t) => t.startsWith("pc_"));
    expect(pcInInventory).toEqual([
      "pc_evidence_snapshots",
      "pc_seed_runs",
      "pc_seed_state",
      "pc_sync_checkpoints",
      "pc_sync_leases",
      "pc_sync_runs",
    ]);
  });
});

describe("PC_TABLES matches the migrations in BOTH directions", () => {
  it("names every pc_ table the migrations create, and nothing they do not", () => {
    // The previous list named `pc_audit` (created by no migration) and omitted
    // `pc_status_events` (created by 0030). Both directions are asserted so neither can recur.
    expect([...PC_TABLES].sort()).toEqual(pcTablesDeclaredInMigrations());
    expect(PC_TABLES).not.toContain("pc_audit");
    expect(PC_TABLES).toContain("pc_status_events");
  });
});

describe("preflight passes against a real database carrying 0030 + 0039 + 0040", () => {
  it("reports zero unknown objects after the three migrations are applied", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );
    const live = rows.map((r) => r.table_name);
    // Proves the migrations really ran, so a silently-empty database cannot pass this.
    expect(live.filter((t) => t.startsWith("pc_")).sort()).toEqual(pcTablesDeclaredInMigrations());

    const result = evaluatePreflight({
      tables: live,
      views: [],
      matviews: [],
      schemas: ["public"],
      orphanSequences: [],
      enums: [],
    });
    expect(result.unknown).toEqual([]);
    expect(result.ok).toBe(true);
  }, 60_000);
});
