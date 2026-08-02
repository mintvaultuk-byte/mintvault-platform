/**
 * PROBE PERSISTENCE — the last-known-good guarantee, proven.
 *
 * The probes already refused to turn unreachable into undeployed. What is under test here is what
 * happens to that answer over TIME: after an outage the newest row must say UNAVAILABLE while the
 * newest USABLE row is still the real deployed SHA.
 *
 * That distinction is the difference between a dashboard that says "staging was running 372a98f3
 * as of twenty minutes ago, and we cannot reach it right now" and one that blanks — which is the
 * difference between a tool an operator trusts and one they learn to ignore.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import type { ProbeFetch } from "../server/project-control/app-probe";
import {
  collectApplicationEvidence,
  collectFlagEvidenceSnapshots,
  APPLICATION_SOURCE,
  FLAG_SOURCE,
  resolveEnvironmentName,
} from "../server/project-control/probe-persistence";
import {
  getRun,
  getLatestSnapshot,
  getLatestGoodSnapshot,
  listSnapshotHistory,
  getActiveRun,
} from "../server/project-control/evidence-repository";

let cluster: DisposablePostgres17;
let db: pg.Pool;

const STAGING_HOST = "mintvault-v2.fly.dev";
const PROD_HOST = "mintvault.fly.dev";

function transport(reply: (url: string) => { status?: number; body?: string }): ProbeFetch {
  return async (url) => {
    const { status = 200, body = "{}" } = reply(url);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => body,
    };
  };
}

const bothHealthy = transport((url) =>
  url.includes("mintvault-v2")
    ? { body: '{"commit":"372a98f3","build":"MV-P5"}' }
    : { body: '{"commit":"6f182624","build":"MV-P5"}' }
);

beforeAll(async () => {
  cluster = await startPostgres17("pc-probe-persistence");
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

const stagingKey = {
  sourceType: APPLICATION_SOURCE,
  environment: "staging",
  entityType: "application_version",
  entityId: STAGING_HOST,
};

describe("application evidence is persisted per environment", () => {
  it("stores both environments with their deployed commits", async () => {
    const out = await collectApplicationEvidence(db, { triggerType: "manual", actor: "owner@x.test" }, process.env, bothHealthy);
    expect(out.started).toBe(true);

    const run = await getRun(db, out.syncId);
    expect(run?.state).toBe("SUCCEEDED");
    expect(run?.actor).toBe("owner@x.test");

    const staging = await getLatestSnapshot(db, stagingKey);
    const production = await getLatestSnapshot(db, {
      sourceType: APPLICATION_SOURCE,
      environment: "production",
      entityType: "application_version",
      entityId: PROD_HOST,
    });

    expect(staging?.commitSha).toBe("372a98f3");
    expect(staging?.freshness).toBe("CURRENT");
    expect(staging?.validUntil, "a version observation ages").not.toBeNull();
    expect(production?.commitSha).toBe("6f182624");
  });

  it("one unreachable environment does not stop the other being recorded", async () => {
    const halfDown = transport((url) =>
      url.includes("mintvault-v2") ? { status: 503 } : { body: '{"commit":"6f182624"}' }
    );
    const out = await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, halfDown);

    const run = await getRun(db, out.syncId);
    expect(run?.state, "one of two reachable is PARTIAL, not a total failure").toBe("PARTIAL");

    const production = await getLatestGoodSnapshot(db, {
      sourceType: APPLICATION_SOURCE,
      environment: "production",
      entityType: "application_version",
      entityId: PROD_HOST,
    });
    expect(production?.commitSha, "staging's outage must not erase production's answer").toBe("6f182624");
  });

  it("an unreachable application is UNAVAILABLE with a null commit — never 'undeployed'", async () => {
    const down = transport(() => ({ status: 503 }));
    const out = await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, down);

    expect((await getRun(db, out.syncId))?.state).toBe("UNAVAILABLE");
    const snap = await getLatestSnapshot(db, stagingKey);
    expect(snap?.freshness).toBe("UNAVAILABLE");
    expect(snap?.commitSha).toBeNull();
    expect(snap?.staleReason).not.toMatch(/not deployed/i);
  });

  it("THE GUARANTEE: after an outage the last good SHA is still queryable", async () => {
    await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, bothHealthy);
    const down = transport(() => ({ status: 500 }));
    await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, down);

    const latest = await getLatestSnapshot(db, stagingKey);
    expect(latest?.freshness, "the failure is recorded").toBe("UNAVAILABLE");

    const good = await getLatestGoodSnapshot(db, stagingKey);
    expect(good?.commitSha, "and the last real answer survives it").toBe("372a98f3");

    const history = await listSnapshotHistory(db, stagingKey);
    expect(history.length, "the failure was ADDED, not substituted").toBe(2);
  });

  it("an HTML shell served with 200 is refused as version evidence", async () => {
    const spa = transport(() => ({ body: "<!doctype html><html><body>MintVault</body></html>" }));
    await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, spa);

    const snap = await getLatestSnapshot(db, stagingKey);
    expect(snap?.freshness, "the classic false positive must not become a deployed version").toBe("UNAVAILABLE");
    expect(snap?.commitSha).toBeNull();
  });

  it("a 200 with JSON but no commit field is refused", async () => {
    const noCommit = transport(() => ({ body: '{"build":"x"}' }));
    await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, noCommit);
    expect((await getLatestSnapshot(db, stagingKey))?.commitSha).toBeNull();
  });

  it("a duplicate refresh coalesces onto the active run", async () => {
    // Hold a lease so the first run cannot complete, then ask again.
    const first = await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, bothHealthy);
    expect(first.started).toBe(true);

    await db.query(
      `INSERT INTO pc_sync_runs (sync_id, source_type, trigger_type, target, state)
       VALUES ('held-open', $1, 'manual', 'fly-applications', 'RUNNING')`,
      [APPLICATION_SOURCE]
    );

    const second = await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, bothHealthy);
    expect(second.started, "a duplicate must not start a second probe sweep").toBe(false);
    if (!second.started) expect(second.syncId).toBe("held-open");
  });
});

describe("feature-flag evidence is persisted", () => {
  const env = { PROJECT_CONTROL_ENV: "staging" } as NodeJS.ProcessEnv;

  it("records every tracked flag, including the absent ones", async () => {
    const out = await collectFlagEvidenceSnapshots(db, { triggerType: "manual" }, env);
    expect((await getRun(db, out.syncId))?.state).toBe("SUCCEEDED");

    const pc = await getLatestSnapshot(db, {
      sourceType: FLAG_SOURCE,
      environment: "staging",
      entityType: "feature_flag",
      entityId: "SUPER_ADMIN_PROJECT_CONTROL_ENABLED",
    });
    expect(pc?.status, "absent is a real observation, not a gap").toBe("absent");
    expect(pc?.freshness).toBe("CURRENT");
  });

  it("keeps ABSENT distinct from explicitly FALSE", async () => {
    await collectFlagEvidenceSnapshots(db, { triggerType: "manual" }, env);
    const absent = await getLatestSnapshot(db, {
      sourceType: FLAG_SOURCE,
      environment: "staging",
      entityType: "feature_flag",
      entityId: "TRANSFER_FLOW_LIVE",
    });

    await collectFlagEvidenceSnapshots(
      db,
      { triggerType: "manual" },
      { ...env, TRANSFER_FLOW_LIVE: "false" } as NodeJS.ProcessEnv
    );
    const off = await getLatestSnapshot(db, {
      sourceType: FLAG_SOURCE,
      environment: "staging",
      entityType: "feature_flag",
      entityId: "TRANSFER_FLOW_LIVE",
    });

    expect(absent?.status).toBe("absent");
    expect(off?.status).toBe("disabled_explicit");
    expect(absent?.status, "collapsing these hides whether a switch-off was deliberate").not.toBe(off?.status);
  });

  it("never stores an unrelated secret name or value", async () => {
    const dirty = {
      ...env,
      STRIPE_SECRET_KEY: "sk_live_must_never_be_stored",
      R2_SECRET_ACCESS_KEY: "also-secret",
    } as NodeJS.ProcessEnv;
    await collectFlagEvidenceSnapshots(db, { triggerType: "manual" }, dirty);

    const all = await db.query(`SELECT payload::text AS p, entity_id FROM pc_evidence_snapshots`);
    const text = JSON.stringify(all.rows);
    expect(text).not.toContain("STRIPE_SECRET_KEY");
    expect(text).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(text).not.toContain("sk_live_must_never_be_stored");
  });

  it("records the environment this PROCESS observed, never another", async () => {
    expect(resolveEnvironmentName({ PROJECT_CONTROL_ENV: "staging" } as NodeJS.ProcessEnv)).toBe("staging");
    await collectFlagEvidenceSnapshots(db, { triggerType: "manual" }, env);
    const rows = await db.query(
      `SELECT DISTINCT environment FROM pc_evidence_snapshots WHERE source_type=$1`,
      [FLAG_SOURCE]
    );
    expect(rows.rows.map((r) => r.environment)).toEqual(["staging"]);
  });
});

describe("probe runs never wedge", () => {
  it("an abandoned run is reaped so the next refresh proceeds", async () => {
    const orphan = await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, bothHealthy);
    await db.query(`UPDATE pc_sync_runs SET state='RUNNING', requested_at = now() - interval '1 hour'`);
    await db.query(`DELETE FROM pc_sync_leases`);

    const next = await collectApplicationEvidence(db, { triggerType: "manual" }, process.env, bothHealthy);
    expect(next.started, "a dead process must not block refresh forever").toBe(true);
    expect((await getRun(db, orphan.syncId))?.state).toBe("EXPIRED");
    expect(await getActiveRun(db, APPLICATION_SOURCE)).toBeNull();
  });
});
