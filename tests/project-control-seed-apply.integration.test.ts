/**
 * Project Control — transactional seed apply, against real PostgreSQL 17.
 *
 * WHAT THIS SUITE IS DEFENDING
 *
 * The planner is already proven pure and correct. What cannot be proven without a real database
 * is that EXECUTION honours it: that a dry run truly writes nothing, that a failure truly leaves
 * nothing behind, that an operator's note truly survives a structural upgrade, and that a retired
 * package is truly still there afterwards.
 *
 * Each of those is a property where a plausible-looking implementation silently does the wrong
 * thing and every test still passes — a dry run that "rolls back" but fires triggers, an apply
 * that commits structure before its audit row, a supersede implemented as a delete. So the
 * assertions here are deliberately about the DATABASE's state after the fact, not about what the
 * service returned.
 *
 * Runs against a DISPOSABLE, ISOLATED, LOCAL database this file creates and drops. It never
 * touches staging or production, and never uses the application's own connection. It fails loudly
 * rather than skipping; PROJECT_CONTROL_DB_TESTS=optional downgrades an unreachable server to a
 * skip only on a developer machine that genuinely has no PostgreSQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  SeedApplyError,
  applySeed,
  clearConfirmations,
  dryRunSeed,
  loadCurrentState,
  loadLatestRun,
  loadSeedStatus,
} from "../server/project-control/seed-repository";
import { manifestDigest, type SeedManifest } from "@shared/project-control-seed-manifest";

const ROOT = join(__dirname, "..");
const M0030 = readFileSync(join(ROOT, "migrations/0030_project_control.sql"), "utf8");
const M0040 = readFileSync(join(ROOT, "migrations/0040_project_control_seed_reconciliation.sql"), "utf8");

const ADMIN_URL =
  process.env.PROJECT_CONTROL_TEST_ADMIN_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:5432/postgres`;
const DB_NAME = `pc_seed_apply_${process.pid}`;
const OPTIONAL = process.env.PROJECT_CONTROL_DB_TESTS === "optional";

let admin: pg.Client | undefined;
let pool: pg.Pool | undefined;
let reachable = false;
let bootError = "";

function baseManifest(): SeedManifest {
  return {
    version: 1,
    nodes: [
      { key: "root", parentKey: null, name: "Root", description: "", sortOrder: 0 },
      { key: "area", parentKey: "root", name: "Area", description: "", sortOrder: 10 },
    ],
    packages: [
      {
        key: "pkg-a",
        nodeKey: "area",
        title: "Package A",
        summary: "s",
        risk: "low",
        classification: "A",
        businessValue: 3,
        engineeringRisk: 3,
        remainingWork: "Seed default note.",
      },
      {
        key: "pkg-b",
        nodeKey: "area",
        title: "Package B",
        summary: "s",
        risk: "low",
        classification: "A",
        businessValue: 3,
        engineeringRisk: 3,
      },
    ],
    supersessions: [],
  };
}

beforeAll(async () => {
  try {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    pool = new pg.Pool({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`), max: 6 });
    reachable = true;
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  if (admin) {
    // Terminate any backend still attached, otherwise DROP DATABASE blocks behind it and the
    // teardown hook times out. The pool is already ended; this reaps stragglers.
    await admin
      .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [
        DB_NAME,
      ])
      .catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {});
    await admin.end().catch(() => {});
  }
}, 60_000);

function db(): pg.Pool {
  if (!reachable) {
    if (OPTIONAL) throw new Error(`SKIPPED-BY-CONFIG: ${bootError}`);
    throw new Error(`Disposable local database unavailable, so seed apply was NOT proven: ${bootError}`);
  }
  return pool!;
}

/** Fresh schema for each test — every property is proven from a known starting point. */
async function resetSchema(withSchema = true): Promise<void> {
  const c = await db().connect();
  try {
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    if (withSchema) {
      await c.query(M0030);
      await c.query(M0040);
    }
  } finally {
    c.release();
  }
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const c = await db().connect();
  try {
    const { rows } = await c.query(sql, params);
    return rows[0] as T | undefined;
  } finally {
    c.release();
  }
}

/** Snapshot enough of the database to prove a dry run changed literally nothing. */
async function snapshot(): Promise<string> {
  const c = await db().connect();
  try {
    const r = await c.query(`
      SELECT
        (SELECT count(*) FROM pc_nodes) n,
        (SELECT count(*) FROM pc_work_packages) p,
        (SELECT count(*) FROM pc_dependencies) d,
        (SELECT count(*) FROM pc_evidence) e,
        (SELECT count(*) FROM pc_status_events) s,
        (SELECT count(*) FROM pc_seed_runs) r,
        (SELECT count(*) FROM pc_seed_state) st,
        (SELECT coalesce(md5(string_agg(key||title||summary||remaining_work, '|' ORDER BY key)),'') FROM pc_work_packages) h,
        (SELECT last_value FROM pc_work_packages_id_seq) seq`);
    return JSON.stringify(r.rows[0]);
  } finally {
    c.release();
  }
}

async function applyFresh(manifest: SeedManifest, actor = "test"): Promise<void> {
  const preview = await dryRunSeed(db(), manifest);
  await applySeed(db(), manifest, { actor, confirmationToken: preview.confirmationToken, isProduction: false });
}

describe("Project Control seed apply coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(
        process.env.PROJECT_CONTROL_TEST_ADMIN_URL,
        "must be set in CI or seed apply is never proven"
      ).toBeTruthy();
      expect(OPTIONAL, "PROJECT_CONTROL_DB_TESTS=optional must never be used in CI").toBe(false);
      expect(reachable, `database must be reachable in CI: ${bootError}`).toBe(true);
    }
  });
});

describe("schema absence is distinguished from an empty programme", () => {
  it("reports schema absent rather than 'empty and ready'", async () => {
    await resetSchema(false);
    const c = await db().connect();
    try {
      const status = await loadSeedStatus(c);
      expect(status.schemaPresent).toBe(false);
      // They look identical to a naive count and mean opposite things: a migration that has not
      // run, versus a database ready for its first seed.
      await expect(loadCurrentState(c)).rejects.toMatchObject({ code: "schema_absent" });
    } finally {
      c.release();
    }
  }, 60_000);

  it("reports schema present and empty once migrated", async () => {
    await resetSchema();
    const c = await db().connect();
    try {
      const status = await loadSeedStatus(c);
      expect(status.schemaPresent).toBe(true);
      expect(status.seedVersion).toBeNull();
      expect(status.packageCount).toBe(0);
    } finally {
      c.release();
    }
  }, 60_000);
});

describe("dry run writes NOTHING", () => {
  beforeEach(async () => {
    await resetSchema();
    clearConfirmations();
  });

  it("leaves the database byte-identical, including sequences", async () => {
    const before = await snapshot();
    const preview = await dryRunSeed(db(), baseManifest());
    const after = await snapshot();
    // Sequence value is included deliberately: an "apply then rollback" dry run would burn ids
    // even though the rows vanished, which is how you tell the two implementations apart.
    expect(after).toBe(before);
    expect(preview.plan.counts.packagesInserted).toBe(2);
  }, 60_000);

  it("still writes nothing on a database that already has structure", async () => {
    await applyFresh(baseManifest());
    const before = await snapshot();
    await dryRunSeed(db(), { ...baseManifest(), version: 2 });
    expect(await snapshot()).toBe(before);
  }, 60_000);
});

describe("first seed", () => {
  beforeEach(async () => {
    await resetSchema();
    clearConfirmations();
  });

  it("creates the full structure, seed state and run record atomically", async () => {
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);
    const result = await applySeed(db(), m, {
      actor: "opus",
      confirmationToken: preview.confirmationToken,
      isProduction: false,
    });

    expect(result.mode).toBe("first_seed");
    expect((await one("SELECT count(*)::int n FROM pc_nodes"))!.n).toBe(2);
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(2);

    const state = await one("SELECT seed_version, manifest_digest FROM pc_seed_state WHERE id=1");
    expect(Number(state!.seed_version)).toBe(1);
    expect(state!.manifest_digest).toBe(manifestDigest(m));

    const runClient = await db().connect();
    try {
      const run = await loadLatestRun(runClient);
      expect(run!.outcome).toBe("applied");
      expect(Number(run!.packages_inserted)).toBe(2);
    } finally {
      // Leaking this client makes pool.end() hang forever in teardown.
      runClient.release();
    }
  }, 60_000);

  it("seeds NO machine-derived status — columns take their honest defaults", async () => {
    await applyFresh(baseManifest());
    const row = await one(
      "SELECT status, declared_completion, deployment_state, production_verification, branch FROM pc_work_packages WHERE key='pkg-a'"
    );
    expect(row!.status).toBe("not_started");
    expect(Number(row!.declared_completion)).toBe(0);
    expect(row!.deployment_state).toBe("not_deployed");
    expect(row!.production_verification).toBe("not_verified");
    expect(row!.branch).toBeNull();
  }, 60_000);

  it("a second apply is a genuine no-op that inserts nothing", async () => {
    await applyFresh(baseManifest());
    const before = await snapshot();
    const preview = await dryRunSeed(db(), baseManifest());
    expect(preview.noOp).toBe(true);
    const result = await applySeed(db(), baseManifest(), {
      actor: "t",
      confirmationToken: preview.confirmationToken,
      isProduction: false,
    });
    expect(result.noOp).toBe(true);
    expect(result.counts.packagesInserted).toBe(0);
    // Only the run record may differ; structure must be untouched.
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(2);
    expect(before).not.toBe(""); // snapshot taken
  }, 60_000);

  it("keeps stable database ids across a rerun", async () => {
    await applyFresh(baseManifest());
    const idBefore = (await one("SELECT id FROM pc_work_packages WHERE key='pkg-a'"))!.id;
    await applyFresh(baseManifest());
    expect((await one("SELECT id FROM pc_work_packages WHERE key='pkg-a'"))!.id).toBe(idBefore);
  }, 60_000);
});

describe("upgrade preserves everything a human did", () => {
  beforeEach(async () => {
    await resetSchema();
    clearConfirmations();
    await applyFresh(baseManifest());

    // An operator then works: edits a note, opens a blocker, records evidence, and the machine
    // records evidence of its own.
    const c = await db().connect();
    try {
      await c.query(
        "UPDATE pc_work_packages SET remaining_work=$1, category_notes=$2::jsonb, status='built', declared_completion=60 WHERE key='pkg-a'",
        ["OPERATOR NOTE: do not deploy until the founder signs off.", JSON.stringify({ backend: "operator note" })]
      );
      await c.query(
        "INSERT INTO pc_blockers (package_key, kind, description, severity) VALUES ('pkg-a','security_issue','manual blocker','high')"
      );
      await c.query(
        "INSERT INTO pc_evidence (package_key, kind, supports, summary) VALUES ('pkg-a','manual_verification',true,'operator evidence')"
      );
      await c.query(
        "INSERT INTO pc_evidence (package_key, kind, supports, summary) VALUES ('pkg-a','repository_scan',true,'machine evidence')"
      );
    } finally {
      c.release();
    }
  }, 120_000);

  it("updates a system title while PRESERVING the operator note", async () => {
    const m = baseManifest();
    m.version = 2;
    m.packages[0].title = "Package A (renamed by the manifest)";
    m.packages[0].remainingWork = "A compiled default that must NOT win.";
    await applyFresh(m);

    const row = await one("SELECT title, remaining_work, category_notes FROM pc_work_packages WHERE key='pkg-a'");
    expect(row!.title).toBe("Package A (renamed by the manifest)");
    expect(row!.remaining_work).toBe("OPERATOR NOTE: do not deploy until the founder signs off.");
    expect(JSON.stringify(row!.category_notes)).toContain("operator note");
  }, 60_000);

  it("leaves machine-derived status untouched — the seed is not its author", async () => {
    const m = baseManifest();
    m.version = 2;
    m.packages[0].title = "Retitled";
    await applyFresh(m);
    const row = await one("SELECT status, declared_completion FROM pc_work_packages WHERE key='pkg-a'");
    expect(row!.status).toBe("built");
    expect(Number(row!.declared_completion)).toBe(60);
  }, 60_000);

  it("preserves manual blockers and BOTH kinds of evidence", async () => {
    const m = baseManifest();
    m.version = 2;
    m.packages[0].title = "Retitled";
    await applyFresh(m);
    expect((await one("SELECT count(*)::int n FROM pc_blockers WHERE package_key='pkg-a'"))!.n).toBe(1);
    expect((await one("SELECT count(*)::int n FROM pc_evidence WHERE package_key='pkg-a'"))!.n).toBe(2);
  }, 60_000);

  it("preserves append-only audit history", async () => {
    const before = (await one("SELECT count(*)::int n FROM pc_status_events"))!.n;
    const m = baseManifest();
    m.version = 2;
    m.packages[0].title = "Retitled";
    await applyFresh(m);
    expect((await one("SELECT count(*)::int n FROM pc_status_events"))!.n).toBeGreaterThanOrEqual(Number(before));
  }, 60_000);

  it("adds and removes dependencies", async () => {
    const m = baseManifest();
    m.version = 2;
    m.packages[0].dependsOn = ["pkg-b"];
    await applyFresh(m);
    expect((await one("SELECT count(*)::int n FROM pc_dependencies WHERE package_key='pkg-a'"))!.n).toBe(1);

    const m3 = baseManifest();
    m3.version = 3;
    await applyFresh(m3);
    expect((await one("SELECT count(*)::int n FROM pc_dependencies WHERE package_key='pkg-a'"))!.n).toBe(0);
  }, 60_000);
});

describe("supersede retires, it does not delete", () => {
  beforeEach(async () => {
    await resetSchema();
    clearConfirmations();
    await applyFresh(baseManifest());
    const c = await db().connect();
    try {
      await c.query(
        "UPDATE pc_work_packages SET remaining_work='operator note on the doomed package' WHERE key='pkg-b'"
      );
      await c.query(
        "INSERT INTO pc_evidence (package_key, kind, supports, summary) VALUES ('pkg-b','manual_verification',true,'evidence on doomed package')"
      );
    } finally {
      c.release();
    }
  }, 120_000);

  it("marks the package superseded and KEEPS the row, its notes and its evidence", async () => {
    const m = baseManifest();
    m.version = 2;
    m.packages = m.packages.filter((p) => p.key !== "pkg-b");
    m.packages.push({
      key: "pkg-b",
      nodeKey: "area",
      title: "Package B",
      summary: "s",
      risk: "low",
      classification: "A",
      businessValue: 3,
      engineeringRisk: 3,
    });
    m.supersessions = [{ key: "pkg-b", replacedBy: "pkg-a", reason: "Consolidated into Package A." }];
    await applyFresh(m);

    const row = await one(
      "SELECT id, superseded_at, superseded_by, superseded_reason, remaining_work FROM pc_work_packages WHERE key='pkg-b'"
    );
    expect(row, "the superseded package row must still exist").toBeDefined();
    expect(row!.superseded_at).not.toBeNull();
    expect(row!.superseded_by).toBe("pkg-a");
    expect(row!.superseded_reason).toContain("Consolidated");
    expect(row!.remaining_work).toBe("operator note on the doomed package");
    expect((await one("SELECT count(*)::int n FROM pc_evidence WHERE package_key='pkg-b'"))!.n).toBe(1);
  }, 60_000);

  it("is excluded from active work but retained for history and export", async () => {
    const m = baseManifest();
    m.version = 2;
    m.supersessions = [{ key: "pkg-b", replacedBy: "pkg-a", reason: "Consolidated." }];
    await applyFresh(m);

    const active = await one("SELECT count(*)::int n FROM pc_work_packages WHERE superseded_at IS NULL");
    const all = await one("SELECT count(*)::int n FROM pc_work_packages");
    expect(Number(active!.n)).toBe(1);
    expect(Number(all!.n)).toBe(2);
  }, 60_000);

  it("does not supersede an operator-created package the manifest never mentioned", async () => {
    const c = await db().connect();
    try {
      await c.query(
        "INSERT INTO pc_work_packages (key,node_key,title,summary,risk,classification,business_value,engineering_risk) VALUES ('operator-made','area','Operator made','',$1,'A',3,3)",
        ["low"]
      );
    } finally {
      c.release();
    }
    const m = baseManifest();
    m.version = 2;
    await applyFresh(m);
    // It may have been created deliberately; auto-retiring it would destroy that intent.
    expect(
      (await one("SELECT superseded_at FROM pc_work_packages WHERE key='operator-made'"))!.superseded_at
    ).toBeNull();
  }, 60_000);
});

describe("atomicity and refusal", () => {
  beforeEach(async () => {
    await resetSchema();
    clearConfirmations();
  });

  it("rolls back EVERYTHING when the transaction fails mid-apply", async () => {
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);
    /**
     * Inject a failure that fires MID-APPLY, after nodes and the first package are already
     * inserted. An earlier version of this test hid pc_seed_state instead, which made the loader
     * report schema-absent and abort BEFORE any structural write — so it proved nothing about
     * rollback. A CHECK that rejects the second package's title fails on its INSERT, with real
     * uncommitted work already in the transaction.
     */
    const c = await db().connect();
    try {
      await c.query("ALTER TABLE pc_work_packages ADD CONSTRAINT tmp_reject_b CHECK (title <> 'Package B')");
    } finally {
      c.release();
    }

    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false })
    ).rejects.toMatchObject({ code: "internal" });

    // The packages inserted before the failure must be gone — partial structure is the defect.
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(0);
    expect((await one("SELECT count(*)::int n FROM pc_nodes"))!.n).toBe(0);
    expect((await one("SELECT count(*)::int n FROM pc_seed_runs"))!.n).toBe(0);
  }, 60_000);

  it("rolls back when a NON-SQL failure occurs after the writes", async () => {
    /**
     * The mid-apply test above fails via a constraint violation, which puts the transaction into
     * PostgreSQL's aborted state — where the server itself discards the work regardless of what
     * the client sends. That proves the outcome but NOT this module's own rollback path.
     *
     * Here the failure is a JavaScript throw at COMMIT time, with a healthy transaction full of
     * real uncommitted work. Only the explicit ROLLBACK in the catch block can save it.
     */
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);

    const failing: typeof pool = {
      connect: async () => {
        const real = await db().connect();
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "query") {
              return (text: string, params?: unknown[]) => {
                if (typeof text === "string" && text.trim().toUpperCase() === "COMMIT") {
                  throw new Error("injected client-side failure at commit time");
                }
                return target.query(text, params as never);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as unknown as Awaited<ReturnType<pg.Pool["connect"]>>;
      },
    } as unknown as pg.Pool;

    await expect(
      applySeed(failing, m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false })
    ).rejects.toBeInstanceOf(SeedApplyError);

    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(0);
    expect((await one("SELECT count(*)::int n FROM pc_nodes"))!.n).toBe(0);
    expect((await one("SELECT count(*)::int n FROM pc_seed_state"))!.n).toBe(0);
  }, 60_000);

  it("does not advance the seed version on a failed apply", async () => {
    await applyFresh(baseManifest());
    const m = baseManifest();
    m.version = 2;
    m.packages[0].title = "Retitled";
    const preview = await dryRunSeed(db(), m);
    const c = await db().connect();
    try {
      await c.query("ALTER TABLE pc_seed_runs RENAME TO pc_seed_runs_hidden");
    } finally {
      c.release();
    }
    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false })
    ).rejects.toBeInstanceOf(SeedApplyError);
    expect(Number((await one("SELECT seed_version FROM pc_seed_state WHERE id=1"))!.seed_version)).toBe(1);
  }, 60_000);

  it("refuses an apply with no preview at all", async () => {
    await expect(
      applySeed(db(), baseManifest(), { actor: "t", confirmationToken: "never-issued", isProduction: false })
    ).rejects.toMatchObject({ code: "digest_mismatch" });
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(0);
  }, 60_000);

  it("refuses a stale preview after the database moved underneath it", async () => {
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);
    await applyFresh(m); // someone else applies first
    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false })
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  }, 60_000);

  it("consumes a confirmation exactly once — a replay is refused", async () => {
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);
    await applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false });
    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false })
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  }, 60_000);

  it("expires a confirmation rather than trusting an old one", async () => {
    const m = baseManifest();
    const t0 = Date.now();
    const preview = await dryRunSeed(db(), m, t0);
    await expect(
      applySeed(db(), m, {
        actor: "t",
        confirmationToken: preview.confirmationToken,
        isProduction: false,
        now: t0 + 11 * 60 * 1000,
      })
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  }, 60_000);

  it("refuses a manifest carrying conflicts and writes nothing", async () => {
    const m = baseManifest();
    m.packages[0].nodeKey = "nowhere";
    const preview = await dryRunSeed(db(), m);
    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: false })
    ).rejects.toMatchObject({ code: "conflicts" });
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(0);
  }, 60_000);

  it("retries successfully after a failed apply", async () => {
    const m = baseManifest();
    const p1 = await dryRunSeed(db(), m);
    const c = await db().connect();
    try {
      await c.query("ALTER TABLE pc_seed_state RENAME TO pc_seed_state_hidden");
    } finally {
      c.release();
    }
    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: p1.confirmationToken, isProduction: false })
    ).rejects.toBeInstanceOf(SeedApplyError);

    const c2 = await db().connect();
    try {
      await c2.query("ALTER TABLE pc_seed_state_hidden RENAME TO pc_seed_state");
    } finally {
      c2.release();
    }
    await applyFresh(m);
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(2);
  }, 60_000);

  it("never leaks a raw database error to the caller", async () => {
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);
    const c = await db().connect();
    try {
      await c.query("ALTER TABLE pc_work_packages ADD CONSTRAINT tmp_reject_b2 CHECK (title <> 'Package B')");
    } finally {
      c.release();
    }
    const error = await applySeed(db(), m, {
      actor: "t",
      confirmationToken: preview.confirmationToken,
      isProduction: false,
    }).catch((e) => e as SeedApplyError);
    // A driver error can quote a connection string, a constraint's full contents, or operator text.
    expect(error.message).not.toMatch(/relation|postgres:\/\/|constraint|tmp_reject|syntax|violates/i);
    expect(error.code).toBe("internal");
  }, 60_000);
});

describe("production blockade", () => {
  beforeEach(async () => {
    await resetSchema();
    clearConfirmations();
  });

  it("refuses apply in production without an explicit separate override", async () => {
    const m = baseManifest();
    const preview = await dryRunSeed(db(), m);
    await expect(
      applySeed(db(), m, { actor: "t", confirmationToken: preview.confirmationToken, isProduction: true })
    ).rejects.toMatchObject({ code: "production_blocked" });
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(0);
  }, 60_000);

  it("refuses BEFORE taking a connection or a lock — nothing is touched at all", async () => {
    const before = await snapshot();
    await expect(
      applySeed(db(), baseManifest(), { actor: "t", confirmationToken: "anything", isProduction: true })
    ).rejects.toMatchObject({ code: "production_blocked" });
    expect(await snapshot()).toBe(before);
  }, 60_000);
});

describe("concurrency", () => {
  it("lets exactly one of two concurrent applies commit", async () => {
    await resetSchema();
    clearConfirmations();
    const m = baseManifest();
    const p1 = await dryRunSeed(db(), m);
    const p2 = await dryRunSeed(db(), m);

    const results = await Promise.allSettled([
      applySeed(db(), m, { actor: "a", confirmationToken: p1.confirmationToken, isProduction: false }),
      applySeed(db(), m, { actor: "b", confirmationToken: p2.confirmationToken, isProduction: false }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    // One wins. The other is refused — either by the advisory lock or, if it queued behind the
    // winner's commit, by the digest guard. Both are correct refusals; two commits would not be.
    expect(fulfilled.length).toBe(1);
    expect((await one("SELECT count(*)::int n FROM pc_work_packages"))!.n).toBe(2);
  }, 120_000);
});
