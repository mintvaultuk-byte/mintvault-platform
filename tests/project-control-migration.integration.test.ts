/**
 * Project Control — migration 0030 database-integrity suite.
 *
 * Runs against a DISPOSABLE, ISOLATED, LOCAL database that this file creates and drops. It never
 * touches staging or production, and it never uses the application's own connection. If no local
 * PostgreSQL is reachable the suite fails loudly rather than skipping quietly — a silent skip is
 * exactly the vacuous pass this remediation exists to remove. Set
 * PROJECT_CONTROL_DB_TESTS=optional to downgrade an unreachable server to a skip on a machine
 * that genuinely has no PostgreSQL.
 *
 * What it proves, against the real schema rather than against the SQL text:
 *  - every foreign key exists and behaves as declared (RESTRICT / CASCADE / SET NULL);
 *  - the append-only ledger genuinely refuses UPDATE and DELETE;
 *  - prompt snapshots genuinely refuse UPDATE;
 *  - created_at cannot be backdated;
 *  - uniqueness prevents duplicate releases and duplicate test runs;
 *  - CHECK constraints reject future evidence, bad ranges and self-dependency;
 *  - the rollback removes only Project Control objects.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const ROOT = join(__dirname, "..");
const MIGRATION = readFileSync(join(ROOT, "migrations/0030_project_control.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "migrations/rollback-0030-project-control.sql"), "utf8");

const ADMIN_URL =
  process.env.PROJECT_CONTROL_TEST_ADMIN_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:5432/postgres`;
const DB_NAME = `pc_migration_test_${process.pid}`;
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
    await client.query(MIGRATION);
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

/** Fails the suite when the database is unreachable, unless explicitly downgraded. */
function db(): pg.Client {
  if (!reachable) {
    if (OPTIONAL) {
      throw new Error(`SKIPPED-BY-CONFIG: ${bootError}`);
    }
    throw new Error(`Disposable local database unavailable, so migration integrity was NOT proven: ${bootError}`);
  }
  return client!;
}

async function expectRejected(sql: string, params: unknown[] = []): Promise<string> {
  let message = "";
  try {
    await db().query(sql, params);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `expected this to be rejected: ${sql}`).not.toBe("");
  return message;
}

/** Seed a minimal, valid graph for the referential tests. */
async function seedGraph(): Promise<void> {
  await db().query(`INSERT INTO pc_nodes (key, name) VALUES ('root','Root') ON CONFLICT DO NOTHING`);
  await db().query(
    `INSERT INTO pc_work_packages (key, node_key, title) VALUES ('wp-a','root','A'), ('wp-b','root','B')
     ON CONFLICT DO NOTHING`
  );
}

describe("migration 0030 applies to a clean database", () => {
  it("creates exactly the nine pc_ tables", async () => {
    const { rows } = await db().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'pc\\_%' ORDER BY table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "pc_blockers",
      "pc_dependencies",
      "pc_deployments",
      "pc_evidence",
      "pc_nodes",
      "pc_prompts",
      "pc_status_events",
      "pc_test_runs",
      "pc_work_packages",
    ]);
  });

  it("creates nothing outside the pc_ namespace", async () => {
    const { rows } = await db().query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    for (const r of rows) expect(r.table_name).toMatch(/^pc_/);
  });

  it("is idempotent — applying it twice is a no-op", async () => {
    await expect(db().query(MIGRATION)).resolves.toBeTruthy();
  });
});

describe("referential integrity", () => {
  beforeAll(seedGraph);

  it("has every declared foreign key", async () => {
    const { rows } = await db().query(
      `SELECT conname FROM pg_constraint WHERE contype='f' AND conname LIKE 'fk_pc_%' ORDER BY conname`
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "fk_pc_blockers_package",
      "fk_pc_dependencies_depends_on",
      "fk_pc_dependencies_package",
      "fk_pc_deployments_package",
      "fk_pc_evidence_package",
      "fk_pc_nodes_parent",
      "fk_pc_prompts_package",
      "fk_pc_test_runs_package",
      "fk_pc_work_packages_node",
    ]);
  });

  it("refuses evidence for a work package that does not exist", async () => {
    const message = await expectRejected(`INSERT INTO pc_evidence (package_key, kind) VALUES ('ghost','vitest')`);
    expect(message).toContain("fk_pc_evidence_package");
  });

  it("refuses a work package pointing at a node that does not exist", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_work_packages (key, node_key, title) VALUES ('ghost-wp','no-such-node','X')`
    );
    expect(message).toContain("fk_pc_work_packages_node");
  });

  it("refuses a dependency on a package that does not exist", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_dependencies (package_key, depends_on_key) VALUES ('wp-a','ghost')`
    );
    expect(message).toContain("fk_pc_dependencies_depends_on");
  });

  it("refuses a self-dependency", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_dependencies (package_key, depends_on_key) VALUES ('wp-a','wp-a')`
    );
    expect(message).toContain("pc_dependencies_no_self");
  });

  it("refuses a node that is its own parent", async () => {
    const message = await expectRejected(`INSERT INTO pc_nodes (key, parent_key, name) VALUES ('loop','loop','Loop')`);
    expect(message).toContain("pc_nodes_no_self_parent");
  });

  it("RESTRICTs deleting a node that still holds work", async () => {
    const message = await expectRejected(`DELETE FROM pc_nodes WHERE key='root'`);
    expect(message).toContain("fk_pc_work_packages_node");
  });

  it("CASCADEs children when a work package is deleted", async () => {
    await db().query(`INSERT INTO pc_work_packages (key, node_key, title) VALUES ('wp-tmp','root','Temp')`);
    await db().query(`INSERT INTO pc_evidence (package_key, kind) VALUES ('wp-tmp','vitest')`);
    await db().query(`INSERT INTO pc_blockers (package_key, kind, description) VALUES ('wp-tmp','other','x')`);
    await db().query(
      `INSERT INTO pc_test_runs (package_key, kind, result, idempotency_key) VALUES ('wp-tmp','vitest','passed','cascade-key-001')`
    );
    await db().query(`INSERT INTO pc_prompts (package_key, target, body) VALUES ('wp-tmp','codex','b')`);

    await db().query(`DELETE FROM pc_work_packages WHERE key='wp-tmp'`);

    for (const table of ["pc_evidence", "pc_blockers", "pc_test_runs", "pc_prompts"]) {
      const { rows } = await db().query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE package_key='wp-tmp'`);
      expect(rows[0].c, table).toBe(0);
    }
  });

  it("SET NULLs a deployment's package rather than deleting the release record", async () => {
    await db().query(`INSERT INTO pc_work_packages (key, node_key, title) VALUES ('wp-dep','root','Dep')`);
    await db().query(
      `INSERT INTO pc_deployments (environment, commit_sha, package_key, idempotency_key) VALUES ('production','abc1234','wp-dep','setnull-key-001')`
    );
    await db().query(`DELETE FROM pc_work_packages WHERE key='wp-dep'`);
    const { rows } = await db().query(`SELECT package_key FROM pc_deployments WHERE commit_sha='abc1234'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].package_key).toBeNull();
  });

  it("keeps the audit ledger when its subject is deleted — history outlives its subject", async () => {
    await db().query(`INSERT INTO pc_work_packages (key, node_key, title) VALUES ('wp-hist','root','Hist')`);
    await db().query(
      `INSERT INTO pc_status_events (subject_type, subject_key, field, new_value) VALUES ('work_package','wp-hist','status','built')`
    );
    await db().query(`DELETE FROM pc_work_packages WHERE key='wp-hist'`);
    const { rows } = await db().query(`SELECT COUNT(*)::int AS c FROM pc_status_events WHERE subject_key='wp-hist'`);
    expect(rows[0].c).toBe(1);
  });
});

describe("append-only audit ledger — enforced by the database", () => {
  beforeAll(seedGraph);

  it("pins a safe search_path on every trigger function", async () => {
    const { rows } = await db().query(
      `SELECT proname, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND proname LIKE 'pc\\_%' ORDER BY proname`
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(String(r.proconfig), `${r.proname} does not pin search_path`).toContain("search_path=");
    }
  });

  it("installs all three integrity triggers", async () => {
    const { rows } = await db().query(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_pc_%' ORDER BY tgname`
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      "trg_pc_prompts_immutable",
      "trg_pc_status_events_append_only",
      "trg_pc_status_events_stamp_time",
    ]);
  });

  it("refuses UPDATE on a status event", async () => {
    await db().query(
      `INSERT INTO pc_status_events (subject_type, subject_key, field, new_value) VALUES ('work_package','wp-a','status','built')`
    );
    const message = await expectRejected(`UPDATE pc_status_events SET new_value='merged' WHERE subject_key='wp-a'`);
    expect(message).toContain("append-only");
  });

  it("refuses DELETE on a status event", async () => {
    const message = await expectRejected(`DELETE FROM pc_status_events WHERE subject_key='wp-a'`);
    expect(message).toContain("append-only");
  });

  it("refuses a bulk DELETE of the whole ledger", async () => {
    const message = await expectRejected(`DELETE FROM pc_status_events`);
    expect(message).toContain("append-only");
  });

  it("cannot be backdated — created_at is stamped by the database", async () => {
    await db().query(
      `INSERT INTO pc_status_events (subject_type, subject_key, field, created_at)
       VALUES ('work_package','wp-b','status','1999-01-01T00:00:00Z')`
    );
    const { rows } = await db().query(
      `SELECT created_at FROM pc_status_events WHERE subject_key='wp-b' ORDER BY id DESC LIMIT 1`
    );
    expect(new Date(rows[0].created_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("refuses UPDATE on an issued prompt snapshot", async () => {
    await db().query(`INSERT INTO pc_prompts (package_key, target, body) VALUES ('wp-a','codex','original')`);
    const message = await expectRejected(`UPDATE pc_prompts SET body='tampered' WHERE package_key='wp-a'`);
    expect(message).toContain("immutable");
  });
});

describe("uniqueness and idempotency", () => {
  beforeAll(seedGraph);

  it("rejects a duplicate work-package key", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_work_packages (key, node_key, title) VALUES ('wp-a','root','Duplicate')`
    );
    expect(message).toContain("uq_pc_work_packages_key");
  });

  it("rejects a duplicate node key", async () => {
    const message = await expectRejected(`INSERT INTO pc_nodes (key, name) VALUES ('root','Duplicate')`);
    expect(message).toContain("uq_pc_nodes_key");
  });

  it("rejects a duplicate dependency edge", async () => {
    await db().query(
      `INSERT INTO pc_dependencies (package_key, depends_on_key) VALUES ('wp-a','wp-b') ON CONFLICT DO NOTHING`
    );
    const message = await expectRejected(
      `INSERT INTO pc_dependencies (package_key, depends_on_key) VALUES ('wp-a','wp-b')`
    );
    expect(message).toContain("uq_pc_dependencies_edge");
  });

  /**
   * These replace the self-fulfilling tests the second hostile review identified. The old versions
   * passed the SAME timestamp by hand, manufacturing a conflict that production code could never
   * produce because `deployed_at` / `ran_at` default to NOW(). Here the timestamps are left to
   * default and differ naturally, so only the stable idempotency key can cause the collision.
   */
  it("rejects the same release recorded twice, with timestamps left to default", async () => {
    await db().query(
      `INSERT INTO pc_deployments (environment, commit_sha, idempotency_key) VALUES ('production','dup1234','release-key-0001')`
    );
    await new Promise((r) => setTimeout(r, 20));
    const message = await expectRejected(
      `INSERT INTO pc_deployments (environment, commit_sha, idempotency_key) VALUES ('production','dup1234','release-key-0001')`
    );
    expect(message).toContain("uq_pc_deployments_idempotency");
  });

  it("rejects the same test run recorded twice, with timestamps left to default", async () => {
    await db().query(
      `INSERT INTO pc_test_runs (kind, result, idempotency_key) VALUES ('vitest','passed','testrun-key-0001')`
    );
    await new Promise((r) => setTimeout(r, 20));
    const message = await expectRejected(
      `INSERT INTO pc_test_runs (kind, result, idempotency_key) VALUES ('vitest','passed','testrun-key-0001')`
    );
    expect(message).toContain("uq_pc_test_runs_idempotency");
  });

  it("allows genuinely distinct events that differ only by their idempotency key", async () => {
    await db().query(
      `INSERT INTO pc_deployments (environment, commit_sha, idempotency_key) VALUES ('production','dup1234','release-key-0002')`
    );
    const { rows } = await db().query(`SELECT COUNT(*)::int AS c FROM pc_deployments WHERE commit_sha='dup1234'`);
    expect(rows[0].c).toBe(2);
  });

  it("requires an idempotency key of a sane length", async () => {
    expect(
      await expectRejected(
        `INSERT INTO pc_test_runs (kind, result, idempotency_key) VALUES ('vitest','passed','short')`
      )
    ).toContain("pc_test_runs_idempotency_key_length");
  });
});

describe("CHECK constraints", () => {
  beforeAll(seedGraph);

  it("rejects evidence dated in the future", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_evidence (package_key, kind, captured_at) VALUES ('wp-a','vitest', NOW() + INTERVAL '2 days')`
    );
    expect(message).toContain("pc_evidence_not_future");
  });

  it("rejects a test run dated in the future", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_test_runs (kind, result, ran_at, idempotency_key) VALUES ('vitest','passed', NOW() + INTERVAL '2 days','future-key-001')`
    );
    expect(message).toContain("pc_test_runs_not_future");
  });

  it("rejects a verification dated before its deployment", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_deployments (environment, commit_sha, deployed_at, verified_at, idempotency_key)
       VALUES ('production','ordr123', NOW(), NOW() - INTERVAL '1 day','order-key-001')`
    );
    expect(message).toContain("pc_deployments_verified_after_deploy");
  });

  it("rejects an out-of-range completion, business value or engineering risk", async () => {
    expect(
      await expectRejected(
        `INSERT INTO pc_work_packages (key,node_key,title,declared_completion) VALUES ('bad1','root','X',150)`
      )
    ).toContain("pc_work_packages_completion_range");
    expect(
      await expectRejected(
        `INSERT INTO pc_work_packages (key,node_key,title,business_value) VALUES ('bad2','root','X',99)`
      )
    ).toContain("pc_work_packages_business_value_range");
    expect(
      await expectRejected(
        `INSERT INTO pc_work_packages (key,node_key,title,engineering_risk) VALUES ('bad3','root','X',-5)`
      )
    ).toContain("pc_work_packages_engineering_risk_range");
  });

  it("rejects an unknown environment or blocker severity", async () => {
    expect(
      await expectRejected(`INSERT INTO pc_evidence (package_key, kind, environment) VALUES ('wp-a','vitest','mars')`)
    ).toContain("pc_evidence_environment_valid");
    expect(
      await expectRejected(
        `INSERT INTO pc_blockers (package_key, kind, description, severity) VALUES ('wp-a','security_issue','x','apocalyptic')`
      )
    ).toContain("pc_blockers_severity_valid");
  });

  it("rejects a resolved-before-opened blocker", async () => {
    const message = await expectRejected(
      `INSERT INTO pc_blockers (package_key, kind, description, opened_at, resolved_at)
       VALUES ('wp-a','other','x', NOW(), NOW() - INTERVAL '1 day')`
    );
    expect(message).toContain("pc_blockers_resolved_after_opened");
  });

  it("defaults the optimistic-locking version to 1 and refuses zero", async () => {
    await db().query(`INSERT INTO pc_work_packages (key,node_key,title) VALUES ('wp-ver','root','V')`);
    const { rows } = await db().query(`SELECT version FROM pc_work_packages WHERE key='wp-ver'`);
    expect(rows[0].version).toBe(1);
    expect(await expectRejected(`UPDATE pc_work_packages SET version = 0 WHERE key='wp-ver'`)).toContain(
      "pc_work_packages_version_positive"
    );
  });
});

describe("indexes support the dashboard's reads", () => {
  it("indexes every column the overview and queue queries filter on", async () => {
    const { rows } = await db().query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_pc_%' ORDER BY indexname`
    );
    const names = rows.map((r) => r.indexname);
    for (const required of [
      "idx_pc_work_packages_node",
      "idx_pc_work_packages_status",
      "idx_pc_work_packages_updated",
      "idx_pc_work_packages_live",
      "idx_pc_evidence_package",
      "idx_pc_blockers_package_open",
      "idx_pc_blockers_open_security",
      "idx_pc_dependencies_depends_on",
      "idx_pc_status_events_subject",
      "idx_pc_deployments_env_deployed",
      "idx_pc_test_runs_package_ran",
      "idx_pc_prompts_package",
    ]) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });

  it("uses an index for the per-package evidence read rather than a sequential scan", async () => {
    // Force the planner to prefer the index so the plan is meaningful on a tiny table.
    await db().query("SET enable_seqscan = off");
    const { rows } = await db().query(
      `EXPLAIN (FORMAT JSON) SELECT * FROM pc_evidence WHERE package_key = 'wp-a' ORDER BY captured_at DESC`
    );
    await db().query("RESET enable_seqscan");
    expect(JSON.stringify(rows)).toContain("idx_pc_evidence_package");
  });
});

describe("rollback removes only Project Control objects", () => {
  it("drops every pc_ table, trigger and function and nothing else", async () => {
    await db().query(ROLLBACK);

    const { rows: tables } = await db().query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
    );
    expect(tables).toHaveLength(0);

    const { rows: functions } = await db().query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND proname LIKE 'pc\\_%'`
    );
    expect(functions).toHaveLength(0);

    // And re-applying afterwards still works, so the rollback leaves a clean slate.
    await expect(db().query(MIGRATION)).resolves.toBeTruthy();
  });
});
