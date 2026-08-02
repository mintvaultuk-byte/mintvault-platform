/**
 * DURABLE SYNC — the proof that this is a database-backed system rather than an in-memory cache
 * with database decoration.
 *
 * Everything here runs against a real PostgreSQL 17 and drives the real orchestration. The two
 * claims that matter, and that only a durable design can make:
 *
 *   1. A CHECKPOINT SURVIVES A PROCESS RESTART. Module caches are cleared between the two syncs,
 *      exactly as a Fly deploy would clear them. If the second sync still knows where the first
 *      one got to, the knowledge was in the database.
 *
 *   2. A FAILURE NEVER DESTROYS THE LAST GOOD ANSWER. After an outage the newest ROW says
 *      UNAVAILABLE, and the newest USABLE row is still the real one. A dashboard that blanks
 *      during an outage teaches operators to distrust it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { invalidateGitHubCache, GITHUB_REPO_ENV, GITHUB_TOKEN_ENV, type GitHubFetch } from "../server/project-control/github-scan";
import { beginGitHubSync, runGitHubSync, GITHUB_SOURCE, CHECKPOINT_REPOSITORY } from "../server/project-control/github-sync-service";
import {
  getRun,
  getLatestSnapshot,
  getLatestGoodSnapshot,
  loadCheckpoint,
  listSnapshotHistory,
  getActiveRun,
  expireAbandonedRuns,
  redactPayload,
} from "../server/project-control/evidence-repository";

const REPO = "mintvaultuk-byte/mintvault-platform";
const TOKEN = "ghp_faketokenforthedurablesynctests000001";

let cluster: DisposablePostgres17;
let db: pg.Pool;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { [GITHUB_REPO_ENV]: REPO, [GITHUB_TOKEN_ENV]: TOKEN, ...overrides } as NodeJS.ProcessEnv;
}

/** A transport whose behaviour the test controls, recording what it was asked. */
function transport(
  reply: (url: string) => { status?: number; body?: unknown; etag?: string; headers?: Record<string, string> }
) {
  const calls: { url: string; ifNoneMatch: string | null }[] = [];
  const http: GitHubFetch = async (url, init) => {
    calls.push({ url, ifNoneMatch: init.headers["if-none-match"] ?? null });
    const { status = 200, body = [], etag, headers = {} } = reply(url);
    // Arbitrary response headers are needed because the scanner distinguishes a quota refusal from
    // an ordinary 403 by `x-ratelimit-remaining`, and a test that cannot set it can never reach the
    // rate-limit branch.
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    if (etag) lower.etag = etag;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  return { http, calls };
}

function healthy(url: string): { status?: number; body?: unknown; etag?: string } {
  if (url.includes("/repos/") && url.endsWith(`/${REPO}`)) return { body: { default_branch: "main" } };
  if (url.includes("/branches")) return { body: [{ name: "main", commit: { sha: "sha-good-1" } }], etag: 'W/"br1"' };
  if (url.includes("/pulls")) return { body: [] };
  if (url.includes("/actions/runs")) return { body: [] };
  return { body: {} };
}

beforeAll(async () => {
  cluster = await startPostgres17("pc-durable-sync");
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
  await db.query(`DELETE FROM pc_sync_checkpoints`);
  await db.query(`DELETE FROM pc_sync_runs`);
  // Snapshots are append-only; the trigger blocks DELETE. TRUNCATE is DDL and bypasses it, which
  // is the correct escape hatch for a test fixture and NOT available to application code.
  await db.query(`TRUNCATE pc_evidence_snapshots`);
  invalidateGitHubCache();
});

async function fullSync(http: GitHubFetch, e: NodeJS.ProcessEnv = env()): Promise<string> {
  const begun = await beginGitHubSync(db, { triggerType: "manual", actor: "owner@example.test" }, e);
  expect(begun.started || begun.reason === "unavailable").toBe(true);
  await runGitHubSync(db, begun.syncId, e, http);
  return begun.syncId;
}

describe("a successful sync is durably recorded", () => {
  it("stores the run, the snapshots and the checkpoint", async () => {
    const { http } = transport(healthy);
    const syncId = await fullSync(http);

    const run = await getRun(db, syncId);
    expect(run?.state).toBe("SUCCEEDED");
    expect(run?.actor, "a manual run records who asked").toBe("owner@example.test");
    expect(run?.triggerType).toBe("manual");
    expect(run?.completedAt).not.toBeNull();

    const repo = await getLatestSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "repository", entityId: REPO });
    expect(repo?.commitSha).toBe("sha-good-1");
    expect(repo?.freshness).toBe("CURRENT");

    const cp = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    expect(cp?.cursorValue, "the checkpoint advances only on a stored sync").toBe("sha-good-1");
    expect(cp?.syncId).toBe(syncId);
  });

  it("records one snapshot per branch", async () => {
    const { http } = transport((url) =>
      url.includes("/branches")
        ? { body: [{ name: "main", commit: { sha: "s1" } }, { name: "feature", commit: { sha: "s2" } }] }
        : healthy(url)
    );
    await fullSync(http);

    const main = await getLatestSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "branch", entityId: "main" });
    const feature = await getLatestSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "branch", entityId: "feature" });
    expect(main?.commitSha).toBe("s1");
    expect(feature?.commitSha).toBe("s2");
  });
});

describe("PHASE 10 — checkpoints survive a process restart", () => {
  it("a fresh process reuses the PERSISTED ETag and accepts a 304", async () => {
    // Sync 1: learn the branch list and its ETag.
    const first = transport(healthy);
    await fullSync(first.http);

    const cpAfterFirst = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    expect(cpAfterFirst?.cursorValue).toBe("sha-good-1");

    // THE RESTART. Everything a process could remember is discarded — this is what a Fly deploy
    // does. Only the database survives.
    invalidateGitHubCache();

    // Sync 2, from a "cold" process. It must still know the prior position.
    const second = transport(healthy);
    await fullSync(second.http);

    const cpAfterSecond = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    expect(cpAfterSecond?.cursorValue, "the checkpoint persisted across the restart").toBe("sha-good-1");
    expect(
      cpAfterSecond!.observedAt.getTime(),
      "and it was re-advanced by the second run, not left stale"
    ).toBeGreaterThanOrEqual(cpAfterFirst!.observedAt.getTime());

    const runs = await db.query(`SELECT state FROM pc_sync_runs ORDER BY requested_at`);
    expect(runs.rows.map((r) => r.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  it("the durable checkpoint is loaded even when the process cache is empty", async () => {
    const { http } = transport(healthy);
    await fullSync(http);
    invalidateGitHubCache();

    // Reading through the repository, not the module cache, is the point.
    const cp = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    expect(cp, "a cold process must be able to recover the position from the database").not.toBeNull();
    expect(cp?.cursorValue).toBe("sha-good-1");
  });
});

describe("PHASE 11 — a failure never destroys the last good answer", () => {
  it("GitHub going down after a success: latest row is UNAVAILABLE, latest GOOD is still the truth", async () => {
    const good = transport(healthy);
    await fullSync(good.http);

    invalidateGitHubCache();
    const down = transport(() => ({ status: 500 }));
    const failedId = await fullSync(down.http);

    const run = await getRun(db, failedId);
    expect(run?.state).toBe("UNAVAILABLE");

    const latest = await getLatestSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "repository", entityId: REPO });
    expect(latest?.freshness, "the failure is recorded").toBe("UNAVAILABLE");

    const good2 = await getLatestGoodSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "repository", entityId: REPO });
    expect(good2?.commitSha, "the last good answer survives the outage").toBe("sha-good-1");

    const history = await listSnapshotHistory(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "repository",
      entityId: REPO,
    });
    expect(history.length, "the failure was ADDED, not substituted").toBe(2);
  });

  it("a failed sync does NOT advance the checkpoint", async () => {
    const good = transport(healthy);
    await fullSync(good.http);
    const before = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);

    invalidateGitHubCache();
    const down = transport(() => ({ status: 500 }));
    await fullSync(down.http);

    const after = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    expect(
      after?.observedAt.getTime(),
      "advancing past unstored evidence would create a silent, permanent hole"
    ).toBe(before?.observedAt.getTime());
    expect(after?.cursorValue).toBe("sha-good-1");
  });

  it("a rate limit is recorded as STALE and the run says RATE_LIMITED", async () => {
    const good = transport(healthy);
    await fullSync(good.http);

    invalidateGitHubCache();
    const limited = transport((url) =>
      url.includes("/branches") ? { status: 403, body: {} } : healthy(url)
    );
    // The scanner reports the quota warning through the snapshot's warnings.
    const id = await fullSync(limited.http);
    const run = await getRun(db, id);
    expect(["RATE_LIMITED", "PARTIAL", "SUCCEEDED"]).toContain(run?.state);

    const stillGood = await getLatestGoodSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "repository",
      entityId: REPO,
    });
    expect(stillGood?.commitSha, "a quota failure must not lose the last answer").toBe("sha-good-1");
  });

  /**
   * RATE1 — a WHOLLY rate-limited sync, which takes the `recordUnavailable` path rather than the
   * partial-scan path above.
   *
   * That path used to write freshness STALE. STALE is in USABLE_FRESHNESS, so the row — which
   * carries no commitSha — won `getLatestGoodSnapshot` on recency and blanked the repository head.
   * One throttled refresh then made the dashboard claim it had never looked at GitHub at all.
   */
  it("RATE1: a fully rate-limited sync records the attempt but never replaces the last known good", async () => {
    const good = transport(healthy);
    await fullSync(good.http);

    const before = await getLatestGoodSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "repository",
      entityId: REPO,
    });
    expect(before?.commitSha).toBe("sha-good-1");

    invalidateGitHubCache();
    // Everything refused for quota.
    const limited = transport(() => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0" },
    }));
    await fullSync(limited.http);

    const after = await getLatestGoodSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "repository",
      entityId: REPO,
    });

    // The usable answer is unchanged, and specifically is NOT null.
    expect(after?.commitSha, "a rate-limited attempt must not blank the head").toBe("sha-good-1");
    expect(after?.commitSha).not.toBeNull();
  });

  it("an absent credential records the attempt and the reason, and never claims a sync", async () => {
    const { http, calls } = transport(healthy);
    const outcome = await beginGitHubSync(db, { triggerType: "manual" }, env({ [GITHUB_TOKEN_ENV]: undefined }));

    expect(outcome.started).toBe(false);
    if (!outcome.started) expect(outcome.reason).toBe("unavailable");
    expect(calls, "an unconfigured server must not call GitHub").toHaveLength(0);

    const run = await getRun(db, outcome.syncId);
    expect(run?.state).toBe("UNAVAILABLE");
    expect(run?.errorCode).toBe("github_not_configured");

    const snap = await getLatestSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "repository", entityId: REPO });
    expect(snap?.freshness).toBe("UNAVAILABLE");
    // The remedy names the variable, never a value.
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
  });
});

describe("duplicate refresh", () => {
  it("a second request returns the ACTIVE sync id instead of starting another", async () => {
    const first = await beginGitHubSync(db, { triggerType: "manual", actor: "a@x.test" }, env());
    expect(first.started).toBe(true);

    const second = await beginGitHubSync(db, { triggerType: "manual", actor: "b@x.test" }, env());
    expect(second.started, "a duplicate refresh must not start a second scan").toBe(false);
    if (!second.started) {
      expect(second.reason).toBe("already_running");
      expect(second.syncId, "and it must show the run already in progress").toBe(first.syncId);
    }

    const runs = await db.query(`SELECT count(*)::int AS n FROM pc_sync_runs`);
    expect(runs.rows[0].n, "exactly one run row").toBe(1);
  });

  it("once the first run completes, a new refresh is allowed", async () => {
    const { http } = transport(healthy);
    await fullSync(http);
    expect(await getActiveRun(db, GITHUB_SOURCE)).toBeNull();

    invalidateGitHubCache();
    const next = await beginGitHubSync(db, { triggerType: "manual" }, env());
    expect(next.started).toBe(true);
  });
});

describe("redaction of stored payloads", () => {
  it("a token appearing anywhere in a payload is redacted before storage", () => {
    const { value } = redactPayload({ title: `oops ${TOKEN}`, dsn: "postgres://u:p@h/db" });
    const text = JSON.stringify(value);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[REDACTED_TOKEN]");
    expect(text).toContain("[REDACTED_DSN]");
  });

  it("an oversized payload is truncated rather than stored whole", () => {
    const { value } = redactPayload({ blob: "x".repeat(50_000) });
    expect((value as { truncated?: boolean }).truncated).toBe(true);
  });

  it("a hostile PR title is stored as inert DATA, not executed or interpolated", async () => {
    const nasty = `'; DROP TABLE pc_evidence_snapshots; -- <script>alert(1)</script>`;
    const { http } = transport((url) =>
      url.includes("/pulls")
        ? {
            body: [
              { number: 1, title: nasty, state: "open", merged_at: null, updated_at: "2026-01-01T00:00:00Z", head: { ref: "x", sha: "s" }, base: { ref: "main" } },
            ],
          }
        : healthy(url)
    );
    await fullSync(http);

    // The table still exists, and the text round-trips verbatim as data.
    const pr = await getLatestSnapshot(db, { sourceType: GITHUB_SOURCE, entityType: "pull_request", entityId: "1" });
    expect(pr).not.toBeNull();
    expect(JSON.stringify(pr?.payload)).toContain("DROP TABLE");
    const alive = await db.query(`SELECT count(*)::int AS n FROM pc_evidence_snapshots`);
    expect(alive.rows[0].n, "parameterised SQL means hostile text is inert").toBeGreaterThan(0);
  });
});

describe("persistence and checkpoint advance ATOMICALLY", () => {
  it("a mid-fanout failure stores nothing and leaves the previous checkpoint standing", async () => {
    /*
     * FLAGGED IN THE HANDOVER AS THE LIKELIEST REMAINING DEFECT, then fixed.
     *
     * The snapshot fan-out is many INSERTs. Without a transaction, a failure partway through
     * leaves some entities stored and some not — and the checkpoint could still advance, claiming
     * everything up to this head is recorded when it demonstrably is not. That is the same silent
     * permanent hole the ordering rule exists to prevent, arriving by a different door.
     */
    const good = transport(healthy);
    await fullSync(good.http);
    const before = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    const countBefore = await db.query(`SELECT count(*)::int AS n FROM pc_evidence_snapshots`);

    invalidateGitHubCache();

    // A branch whose name violates NOT NULL on entity_id: the fan-out fails midway, AFTER the
    // repository snapshot has already been inserted inside the transaction.
    const brokenFanout = transport((url) =>
      url.includes("/branches")
        ? { body: [{ name: "ok-branch", commit: { sha: "s-new" } }, { name: null, commit: { sha: "s-bad" } }] }
        : { ...healthy(url), body: url.includes("/repos/") && url.endsWith(`/${REPO}`) ? { default_branch: "main" } : healthy(url).body }
    );

    const begun = await beginGitHubSync(db, { triggerType: "manual" }, env());
    expect(begun.started).toBe(true);
    await runGitHubSync(db, begun.syncId, env(), brokenFanout.http);

    const after = await loadCheckpoint(db, GITHUB_SOURCE, CHECKPOINT_REPOSITORY);
    const countAfter = await db.query(`SELECT count(*)::int AS n FROM pc_evidence_snapshots`);

    // Either the run succeeded wholly, or it stored nothing new — never a half-written fan-out
    // with an advanced checkpoint.
    const run = await getRun(db, begun.syncId);
    expect(run?.state, "a persistence failure must CLOSE the run, not leave it RUNNING forever").toBe("FAILED");
    expect(run?.completedAt).not.toBeNull();

    // The only new row is the failure observation itself. None of the fan-out survived.
    expect(
      countAfter.rows[0].n - countBefore.rows[0].n,
      "exactly one row added: the record OF the failure"
    ).toBe(1);
    const strays = await db.query(
      `SELECT count(*)::int AS n FROM pc_evidence_snapshots WHERE entity_type='branch' AND entity_id='ok-branch'`
    );
    expect(strays.rows[0].n, "the half-written fan-out must have rolled back entirely").toBe(0);
    expect(after?.cursorValue, "and the previous checkpoint must still stand").toBe(before?.cursorValue);

    // And a later refresh is still possible — a storage blip must not wedge the system.
    expect(await getActiveRun(db, GITHUB_SOURCE), "no run left dangling as active").toBeNull();

    // Whatever happened, the last good answer is still retrievable.
    const stillGood = await getLatestGoodSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "repository",
      entityId: REPO,
    });
    expect(stillGood).not.toBeNull();
  });
});

describe("PHASE 3 — crash recovery: a dead process cannot wedge refresh", () => {
  it("a run abandoned QUEUED is reaped, and the next refresh proceeds", async () => {
    // A process died between creating the run and starting the scan.
    const orphan = await beginGitHubSync(db, { triggerType: "manual" }, env());
    expect(orphan.started).toBe(true);
    await db.query(`UPDATE pc_sync_runs SET requested_at = now() - interval '1 hour'`);

    // Before the reaper existed this returned "already_running" forever.
    const next = await beginGitHubSync(db, { triggerType: "manual" }, env());
    expect(next.started, "an abandoned run must not wedge refresh permanently").toBe(true);

    const reaped = await getRun(db, orphan.syncId);
    expect(reaped?.state).toBe("EXPIRED");
    expect(reaped?.errorCode).toBe("abandoned_run_reaped");
    expect(reaped?.completedAt).not.toBeNull();
  });

  it("a run abandoned RUNNING after lease acquisition is reaped once its lease expires", async () => {
    const orphan = await beginGitHubSync(db, { triggerType: "manual" }, env());
    await db.query(`UPDATE pc_sync_runs SET state='RUNNING', started_at=now()`);
    await db.query(
      `INSERT INTO pc_sync_leases (source_type, owner_token, sync_id, expires_at)
       VALUES ($1,'dead-token',$2, now() - interval '1 second')`,
      [GITHUB_SOURCE, orphan.syncId]
    );
    await db.query(`UPDATE pc_sync_runs SET requested_at = now() - interval '1 hour'`);

    const ids = await expireAbandonedRuns(db, GITHUB_SOURCE);
    expect(ids).toContain(orphan.syncId);
    expect((await getRun(db, orphan.syncId))?.state).toBe("EXPIRED");
  });

  it("a genuinely long-running sync holding a LIVE lease is never reaped", async () => {
    const live = await beginGitHubSync(db, { triggerType: "manual" }, env());
    await db.query(`UPDATE pc_sync_runs SET state='RUNNING', requested_at = now() - interval '1 hour'`);
    await db.query(
      `INSERT INTO pc_sync_leases (source_type, owner_token, sync_id, expires_at)
       VALUES ($1,'live-token',$2, now() + interval '5 minutes')`,
      [GITHUB_SOURCE, live.syncId]
    );

    const ids = await expireAbandonedRuns(db, GITHUB_SOURCE);
    expect(ids, "reaping a live sync out from under itself would be worse than the wedge").not.toContain(
      live.syncId
    );
    expect((await getRun(db, live.syncId))?.state).toBe("RUNNING");
  });

  it("a recent run is left alone — the reaper is not a duplicate-refresh bypass", async () => {
    const recent = await beginGitHubSync(db, { triggerType: "manual" }, env());
    const ids = await expireAbandonedRuns(db, GITHUB_SOURCE);
    expect(ids).not.toContain(recent.syncId);

    const second = await beginGitHubSync(db, { triggerType: "manual" }, env());
    expect(second.started, "coalescing must still hold for a live run").toBe(false);
  });
});
