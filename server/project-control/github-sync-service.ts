/**
 * Project Control — durable GitHub synchronisation.
 *
 * Orchestrates the pieces that already exist — the injectable transport in `github-scan.ts`, the
 * cross-machine lease in `sync-lease.ts`, the append-only repository in `evidence-repository.ts` —
 * into one flow whose state lives in the database rather than in a process.
 *
 * THE ORDERING RULE, WHICH IS THE WHOLE DESIGN
 * --------------------------------------------
 *     scan  ->  persist snapshots  ->  advance checkpoint  ->  close the run
 *
 * The checkpoint moves LAST, and only on a run that actually stored what it claims. A checkpoint
 * is a promise that "everything up to here is recorded"; advancing it after a failure makes the
 * next sync skip data nothing ever persisted, and that hole is silent, permanent and invisible to
 * every later read. This is the single most important property in the module, and it is the one
 * mutation DUR1 exists to attack.
 *
 * WHAT A FAILURE DOES
 * -------------------
 * Records an UNAVAILABLE (or RATE_LIMITED) observation and stops. It does not delete, does not
 * overwrite, and does not advance the checkpoint. `getLatestGoodSnapshot` therefore still returns
 * the last real answer, so an outage degrades the dashboard's freshness label rather than its
 * content. A dashboard that blanks during an outage teaches operators to distrust it.
 *
 * UNTRUSTED TEXT
 * --------------
 * Branch names, PR titles and workflow names are attacker-influenceable. They are bounded and
 * redacted on the way in (`redactPayload`), and stored as data — never interpolated into SQL, and
 * never executed. Rendering remains the caller's responsibility to escape.
 */
import { scanGitHub, isGitHubConfigured, resolveRepository, type GitHubFetch } from "./github-scan";
import type { GitHubSnapshot } from "@shared/project-control-github";
import { withLease, workerIdentity, type LeaseDb } from "./sync-lease";
import {
  createRun,
  expireAbandonedRuns,
  markRunning,
  completeRun,
  getActiveRun,
  insertSnapshot,
  loadCheckpoints,
  storeCheckpoint,
  withTransaction,
  type EvidenceDb,
  type SyncRun,
} from "./evidence-repository";

export const GITHUB_SOURCE = "github";

/**
 * How long a GitHub observation stays CURRENT.
 *
 * Application evidence carries APPLICATION_VALID_MS (10 min), flags FLAG_VALID_MS (30 min) and the
 * migration ledger DATABASE_VALID_MS (15 min). GitHub carried NONE — every insertSnapshot below
 * omitted validUntil, and effectiveFreshness() in overview-service.ts reads
 *
 *     if (snap.validUntil && snap.validUntil.getTime() < now.getTime()) return "STALE";
 *
 * so a null validUntil meant CURRENT for ever. The headline "Evidence freshness" badge read Current
 * regardless of when the last sync ran, and the AUTHORED gate stayed SATISFIED off arbitrarily old
 * evidence. A dashboard that cannot go stale cannot be trusted to say it is fresh.
 *
 * 20 minutes: comfortably longer than the 120s dashboard poll and the forced-refresh cooldown, so
 * ordinary use never flickers to STALE, but short enough that an evening without a sync shows as
 * stale rather than confident.
 *
 * This does NOT discard anything. STALE rows remain USABLE_FRESHNESS, so getLatestGoodSnapshot()
 * still returns them and last-known-good survives — the operator is told the age, not denied the
 * data.
 */
export const GITHUB_VALID_MS = 20 * 60 * 1000;
/** One checkpoint row per logical collection, so a partial scan can advance only what it stored. */
export const CHECKPOINT_REPOSITORY = "repository";

export type SyncDb = EvidenceDb & LeaseDb;

export type SyncOutcome =
  | { started: true; syncId: string; state: "QUEUED" }
  | { started: false; reason: "already_running"; syncId: string }
  | { started: false; reason: "unavailable"; syncId: string };

/**
 * Begin a synchronisation.
 *
 * Returns as soon as the run is durably recorded. The scan itself is awaited by `runSync`, which
 * the caller may schedule rather than await — the HTTP layer must not hold a request open for a
 * full GitHub scan, and the database run is the authoritative record either way, so a caller that
 * disconnects loses nothing.
 */
export async function beginGitHubSync(
  db: SyncDb,
  input: { triggerType: "manual" | "scheduled" | "startup"; actor?: string | null },
  env: NodeJS.ProcessEnv = process.env
): Promise<SyncOutcome> {
  const repository = resolveRepository(env);

  /*
   * Reap abandoned runs BEFORE checking for an active one.
   *
   * Without this, a run left QUEUED or RUNNING by a killed process would be reported as "already
   * running" forever and refresh would be permanently wedged. Reaping first means the very next
   * request self-heals, rather than requiring an operator to edit the table.
   */
  await expireAbandonedRuns(db, GITHUB_SOURCE);

  // A duplicate refresh must SHOW the run already in progress, not start a second scan against a
  // rate-limited API and not fail with a bare 409.
  const active = await getActiveRun(db, GITHUB_SOURCE);
  if (active) return { started: false, reason: "already_running", syncId: active.syncId };

  const syncId = await createRun(db, {
    sourceType: GITHUB_SOURCE,
    triggerType: input.triggerType,
    target: repository,
    actor: input.actor ?? null,
    workerIdentity: workerIdentity(env),
  });

  // An unconfigured server records the attempt and the reason rather than pretending it synced.
  // The run is real evidence that somebody asked and the answer was "no credential".
  if (!isGitHubConfigured(env)) {
    await insertSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "repository",
      entityId: repository,
      freshness: "UNAVAILABLE",
      syncId,
      staleReason: "GitHub credential is not configured in this environment.",
      payload: { configured: false },
    });
    await completeRun(db, syncId, "UNAVAILABLE", { errorCode: "github_not_configured" });
    return { started: false, reason: "unavailable", syncId };
  }

  return { started: true, syncId, state: "QUEUED" };
}

/**
 * Execute the scan for an already-created run, under the durable lease.
 *
 * Split from `beginGitHubSync` so the HTTP layer can return 202 immediately while this continues.
 */
export async function runGitHubSync(
  db: SyncDb,
  syncId: string,
  env: NodeJS.ProcessEnv = process.env,
  http?: GitHubFetch
): Promise<SyncRun | null> {
  const repository = resolveRepository(env);

  const outcome = await withLease(db, GITHUB_SOURCE, syncId, async () => {
    await markRunning(db, syncId);

    // Priming the transport from DURABLE checkpoints is what makes this survive a restart. A
    // process cache would be empty after a deploy and every conditional request would become a
    // full download, spending rate-limit quota to re-learn what the database already knew.
    const checkpoints = await loadCheckpoints(db, GITHUB_SOURCE);
    const priorEtag = checkpoints.get(CHECKPOINT_REPOSITORY)?.etag ?? null;

    let snapshot: GitHubSnapshot;
    try {
      snapshot = await scanGitHub(true, env, http);
    } catch (error) {
      await recordUnavailable(db, syncId, repository, "github_scan_threw");
      await completeRun(db, syncId, "FAILED", {
        errorCode: "github_scan_threw",
        warnings: [String((error as Error)?.message ?? "").slice(0, 200)],
      });
      return null;
    }

    // A snapshot with no fetch time is the scanner's UNAVAILABLE shape.
    if (!snapshot.fetchedAt) {
      const rateLimited = snapshot.warnings.some((w) => /rate limit/i.test(String(w)));
      await recordUnavailable(
        db,
        syncId,
        repository,
        rateLimited ? "github_rate_limited" : "github_unavailable",
        snapshot.warnings
      );
      await completeRun(db, syncId, rateLimited ? "RATE_LIMITED" : "UNAVAILABLE", {
        errorCode: rateLimited ? "github_rate_limited" : "github_unavailable",
        warnings: snapshot.warnings,
        // The checkpoint is deliberately untouched here. See the ordering rule above.
      });
      return null;
    }

    /*
     * PERSIST AND ADVANCE ATOMICALLY.
     *
     * The snapshot fan-out is many INSERTs. Without a transaction a failure partway through
     * leaves some entities stored and some not, and — worse — the checkpoint could still advance,
     * declaring that everything up to this head is recorded when it demonstrably is not. That is
     * the silent, permanent hole the ordering rule exists to prevent, arriving by a different
     * door.
     *
     * Wrapping both in ONE transaction makes the rule atomic: either every snapshot and the new
     * checkpoint land together, or neither does and the previous position stands untouched.
     */
    let counts: Record<string, number>;
    try {
      counts = await withTransaction(db, async (tx) => {
        const stored = await persistSnapshot(tx, syncId, snapshot);

        // ONLY NOW may the checkpoint advance, and only to a head we actually resolved. A null
        // cursor would erase the position and make the next sync behave as if it had never run.
        if (snapshot.defaultBranchSha) {
          await storeCheckpoint(tx, {
            sourceType: GITHUB_SOURCE,
            resourceKey: CHECKPOINT_REPOSITORY,
            etag: snapshot.defaultBranchSha ?? priorEtag,
            cursorValue: snapshot.defaultBranchSha,
            syncId,
          });
        }
        return stored;
      });
    } catch (error) {
      /*
       * A PERSISTENCE FAILURE MUST CLOSE THE RUN.
       *
       * The transaction above already rolled back, so no partial evidence survives and the
       * checkpoint still stands — that part was correct. But letting the error escape left the run
       * in RUNNING forever, and `getActiveRun` treats RUNNING as an active sync: one storage blip
       * would then block EVERY future refresh until somebody edited the table by hand. The lease
       * would expire in five minutes; the run row would not.
       */
      await recordUnavailable(db, syncId, repository, "evidence_persist_failed");
      await completeRun(db, syncId, "FAILED", {
        errorCode: "evidence_persist_failed",
        warnings: [String((error as Error)?.message ?? "").slice(0, 200)],
      });
      return null;
    }

    // Warnings without a total failure means some collection was truncated or refused — real
    // evidence was stored, but the view is incomplete, and PARTIAL says exactly that.
    await completeRun(db, syncId, snapshot.warnings.length > 0 ? "PARTIAL" : "SUCCEEDED", {
      counts,
      warnings: snapshot.warnings,
    });
    return null;
  });

  if (!outcome.ran) {
    // Another machine holds the lease. This run never executed; mark it so it cannot sit QUEUED
    // forever and be mistaken for an active sync by the next duplicate check.
    await completeRun(db, syncId, "CANCELLED", { errorCode: "lease_held_elsewhere" });
  }
  return null;
}

/**
 * Record a failure as an ADDITIONAL observation. Never a replacement.
 *
 * WHY RATE-LIMITED IS UNAVAILABLE AND NOT STALE
 *
 * This function used to write `STALE` on the rate-limit path. `STALE` is in `USABLE_FRESHNESS`,
 * because it means "a real answer, just old" — so `getLatestGoodSnapshot`, which orders by recency
 * across usable rows, returned this row in preference to the real observation taken minutes
 * earlier. And this row carries no `commitSha`, so `repository.mainSha` went NULL.
 *
 * The visible consequence was that one throttled refresh made the dashboard report "no repository
 * evidence has been collected yet" — it had looked, and been told to wait. Every gate reading the
 * repository lost its input, and an UNKNOWN_REPOSITORY contradiction appeared out of nowhere.
 *
 * `UNAVAILABLE` means "no answer": recorded, visible, attributable to a rate limit via
 * `staleReason`, and never a candidate to replace one. The sibling `persistSnapshot` below already
 * reasons this out at length for the degraded-scan case; this path simply did not follow it.
 */
async function recordUnavailable(
  db: SyncDb,
  syncId: string,
  repository: string,
  reason: string,
  warnings: unknown[] = []
): Promise<void> {
  await insertSnapshot(db, {
    sourceType: GITHUB_SOURCE,
    entityType: "repository",
    entityId: repository,
    freshness: "UNAVAILABLE",
    syncId,
    staleReason: reason,
    payload: { warnings: warnings.slice(0, 10) },
  });
}

/** Fan the snapshot out into one immutable observation per entity. */
async function persistSnapshot(
  db: EvidenceDb,
  syncId: string,
  snapshot: GitHubSnapshot
): Promise<Record<string, number>> {
  const counts: Record<string, number> = { repository: 0, branch: 0, pull_request: 0, workflow_run: 0 };
  // One clock for the whole batch, so every row from a single scan expires together rather than
  // drifting apart by however long the inserts took.
  const validUntil = new Date(Date.now() + GITHUB_VALID_MS);

  /*
   * A DEGRADED SCAN MUST NOT BECOME THE LATEST GOOD ANSWER.
   *
   * A partial failure — the branch list refused for quota while the rest succeeded — still yields
   * a snapshot with a fetch time, but with no default-branch SHA. Recording that as CURRENT would
   * publish "this repository has no head" as the newest usable truth, and `getLatestGoodSnapshot`
   * would return it in preference to the real answer observed a minute earlier. Worse than a
   * blank: a confident wrong value.
   *
   * So the repository observation is CURRENT only when the scan actually resolved a head. Without
   * one it is UNAVAILABLE, not STALE. That distinction is deliberate and load-bearing: STALE means
   * "a real answer, just old" and still counts as usable, so a STALE null-head row would win the
   * latest-good read on recency and reintroduce the very bug this guards against. UNAVAILABLE
   * means "no answer" — recorded and visible, but never a replacement for one.
   */
  const resolvedHead = Boolean(snapshot.defaultBranchSha);
  await insertSnapshot(db, {
    sourceType: GITHUB_SOURCE,
    entityType: "repository",
    entityId: snapshot.repository,
    commitSha: snapshot.defaultBranchSha,
    status: resolvedHead ? "ok" : "degraded",
    freshness: resolvedHead ? "CURRENT" : "UNAVAILABLE",
    staleReason: resolvedHead ? null : "Scan completed without resolving a default-branch head.",
    // Only a CURRENT row gets a window; an UNAVAILABLE row is already unusable and must not be
    // handed an expiry that would make it look like it was ever good.
    validUntil: resolvedHead ? validUntil : null,
    syncId,
    payload: {
      defaultBranch: snapshot.defaultBranch,
      defaultBranchSha: snapshot.defaultBranchSha,
      branchCount: snapshot.branches.length,
      // ALL states — the scanner fetches `?state=all`, so this is the total, not the open count.
      pullRequestCount: snapshot.pullRequests.length,
      // The open count, stored separately. `openPullRequests` in the DTO was reading
      // `pullRequestCount` and labelling it "open", so a repo with 3 open and 120 closed PRs
      // would have reported 123 open once the UI consumed the composed endpoint.
      openPullRequestCount: snapshot.pullRequests.filter((pr) => pr.state === "open").length,
      warnings: snapshot.warnings.slice(0, 10),
    },
  });
  counts.repository = 1;

  for (const branch of snapshot.branches) {
    await insertSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "branch",
      entityId: branch.name,
      commitSha: branch.headSha,
      status: "ok",
      freshness: "CURRENT",
      validUntil,
      syncId,
      payload: branch,
    });
    counts.branch += 1;
  }

  for (const pr of snapshot.pullRequests) {
    await insertSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "pull_request",
      entityId: String(pr.number),
      commitSha: pr.headSha ?? null,
      status: pr.state,
      freshness: "CURRENT",
      validUntil,
      syncId,
      payload: pr,
    });
    counts.pull_request += 1;
  }

  for (const run of snapshot.workflowRuns) {
    await insertSnapshot(db, {
      sourceType: GITHUB_SOURCE,
      entityType: "workflow_run",
      entityId: `${run.name ?? "workflow"}@${run.headSha ?? "unknown"}`,
      commitSha: run.headSha ?? null,
      status: run.conclusion,
      freshness: "CURRENT",
      validUntil,
      syncId,
      payload: run,
    });
    counts.workflow_run += 1;
  }

  return counts;
}
