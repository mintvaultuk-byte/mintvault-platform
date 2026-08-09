/**
 * Partner rating lifecycle — durable dirtying, non-blocking refresh, bounded reconciliation.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * -------------------------------------------------------------------------------------------
 * A rating is SECONDARY. Nothing in here may cause a card's grading, approval, credit settlement,
 * certificate issuance, printing or completion to fail, or to WAIT. A shop's quality score being
 * briefly stale is an inconvenience; a card that could not be approved because a rating query hung
 * is an outage of the actual product.
 *
 * "Must not fail" was the previous version of that sentence and it was too weak. `NEVER THROWS`
 * was implemented faithfully and the HQ approval path still hung, because the caller AWAITED a
 * function that could take unbounded time on an unbounded pool. A promise that never settles has
 * not failed and has not succeeded; the caller waits either way. Three things enforce the stronger
 * rule now, and all three are needed:
 *
 *   1. ISOLATED CAPACITY. Every query here runs on `partnerRatingQuery` / the rating pool
 *      (server/partner/db.ts) — max 2, with acquire, query, statement and lock timeouts. Rating
 *      work cannot consume the four `adminPool` connections HQ review runs on, however badly it
 *      is going.
 *   2. NOT AWAITED. `scheduleRatingRefresh` detaches the expensive half. HQ approve/reject returns
 *      without it. See its own comment for why this is not a floating promise.
 *   3. DURABLE OBLIGATION FIRST. `markRatingDirty` commits with the evidence that created it, so
 *      dropping the refresh entirely costs freshness, never correctness.
 *
 * LOCK ORDER (load-bearing, do not reorder)
 * -------------------------------------------------------------------------------------------
 * partner_public_listings is acquired LAST in every transaction that touches it. Every existing
 * write path takes some subset of certificates -> partner_grading_work_items -> partner_submissions
 * -> submissions -> wallets/reservations, in mutually consistent order. Adding the listing as a
 * SINK is cycle-free; adding it anywhere earlier creates a genuine ABBA against those paths. So
 * markRatingDirty must be called as the LAST statement of a transaction body, never before the
 * work it accompanies.
 *
 * AND NEVER ACROSS POOLS FROM INSIDE A TRANSACTION. If this took its own connection while the
 * caller's transaction held a lock it needs, PostgreSQL would see one session idle-in-transaction
 * and one waiting — no cycle to detect, so no deadlock error, just an indefinite hang on two pooled
 * connections. That is why markRatingDirty takes the caller's client rather than opening anything.
 */
import { partnerRatingQuery, withPartnerRatingTransaction } from "./db";
import { recalculateRating } from "./public-network-service";
import { RATING_WINDOW_DAYS } from "./public-network-rating";

/** How many dirty listings one reconciler tick will process. Bounded on purpose — see runRatingReconciler. */
export const RATING_RECONCILER_BATCH = Number(process.env.PARTNER_RATING_RECONCILER_BATCH ?? 25);

/**
 * Consecutive failures before a listing is considered stuck rather than unlucky.
 *
 * A transient error must NOT become a Super Admin task on its first occurrence — the reconciler
 * retries on its own cadence and almost every real failure (a lock, a blip, a redeploy) clears
 * without anyone looking. Needs Attention keys on this threshold, not on failure_count > 0.
 */
export const RATING_FAILURE_ATTENTION_THRESHOLD = Number(
  process.env.PARTNER_RATING_FAILURE_THRESHOLD ?? 3,
);

/**
 * How long a reconciler holds its claim on a listing.
 *
 * Long enough that a slow recalculation finishes inside it; short enough that a machine killed
 * mid-item releases its work within one or two ticks. The rating pool's own query timeout (8s) is
 * the real bound on how long an item can take, so 120s is ~15x headroom and still well under the
 * 5-minute tick interval.
 */
export const RATING_CLAIM_SECONDS = Number(process.env.PARTNER_RATING_CLAIM_SECONDS ?? 120);

/**
 * Retry backoff after a failed recalculation, in seconds: BASE * 2^(failures-1), capped at CAP.
 *
 * DETERMINISTIC, NOT JITTERED. Two runners must walk the queue in the same order for the
 * oldest-first ordering to mean anything; the durable claim below is what stops them colliding, so
 * jitter would buy nothing and make the sequence untestable.
 */
export const RATING_BACKOFF_BASE_SECONDS = Number(process.env.PARTNER_RATING_BACKOFF_BASE_SECONDS ?? 60);
export const RATING_BACKOFF_CAP_SECONDS = Number(process.env.PARTNER_RATING_BACKOFF_CAP_SECONDS ?? 3600);

/**
 * Upper bound on how long a listing may go without ANY recalculation.
 *
 * `rating_next_recalc_at` is normally derived from the window boundary (see scheduleNextRecalc).
 * A listing with no evidence at all has no boundary, and NULL would mean "never look again" — so
 * it gets this bounded sweep instead. Also caps the derived value, so a shop whose oldest evidence
 * is 179 days old is not left for 179 days on the strength of arithmetic alone.
 */
export const RATING_MAX_STALENESS_SECONDS = Number(process.env.PARTNER_RATING_MAX_STALENESS_SECONDS ?? 7 * 24 * 3600);

/** Something the caller can execute SQL on — a pool client inside a transaction, or a Drizzle-ish tx. */
export interface RatingDirtyExecutor {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * Mark the listing for this LOCATION dirty, on the caller's own connection.
 *
 * IDEMPOTENT IN EFFECT AND MONOTONIC IN ORDER, BUT NOT A NO-OP WHEN ALREADY DIRTY. Marking an
 * already-dirty listing does not move `rating_dirty_since` — the reconciler's oldest-first ordering
 * keeps its meaning and a shop under constant activity cannot push itself to the back of the queue
 * — but it DOES bump `rating_dirty_generation`.
 *
 * That distinction is the whole of the H2 repair, so it is worth stating why the previous
 * `AND rating_dirty = false` guard had to go. With it, the sequence
 *
 *     reconciler reads generation G  ->  approval marks dirty (SKIPPED: already dirty)  ->
 *     reconciler finishes and clears the flag
 *
 * loses the approval permanently: nothing recorded that it arrived, so the CAS in markRatingClean
 * would have nothing to detect. The generation must move on EVERY quality event, whatever the flag
 * already says.
 *
 * A location with no public listing is a NO-OP, not an error: most locations never opt into the
 * public network. Zero rows affected is the expected case.
 *
 * Callers pass the transaction's own client. See the lock-order note at the top of this file.
 */
export async function markRatingDirty(
  exec: RatingDirtyExecutor,
  locationId: string | null | undefined,
): Promise<void> {
  if (!locationId) return;
  await exec.query(
    `UPDATE partner_public_listings
        SET rating_dirty = true,
            rating_dirty_since = COALESCE(rating_dirty_since, now()),
            rating_dirty_generation = rating_dirty_generation + 1
      WHERE location_id = $1`,
    [locationId],
  );
}

/**
 * Fire a rating refresh and DO NOT WAIT FOR IT.
 *
 * ── WHY THIS IS NOT A FLOATING PROMISE ──────────────────────────────────────────────────────
 * "Don't await it" is one line away from an unhandled rejection that takes the process down under
 * Node's default `--unhandled-rejections=throw`. Three things prevent that here:
 *
 *   * `refreshRatingAfterCommit` is contractually non-throwing and every internal await inside it
 *     is inside its try/catch, so the promise resolves rather than rejects;
 *   * a `.catch()` is attached SYNCHRONOUSLY at creation anyway, belt and braces, because "it
 *     can't reject" is a claim about code that will be edited;
 *   * the promise is retained in `inFlight` until it settles, so it is observable — a background
 *     task nothing holds a reference to is a background task nobody can prove ran.
 *
 * `inFlight` is also what makes this TESTABLE. A detached refresh is exactly the shape that
 * produces a flaky suite: the assertion runs before the work does. `await drainRatingRefreshes()`
 * gives a test a deterministic join point without reintroducing the await on the HQ path.
 *
 * It is bounded by construction — the rating pool has an acquire timeout, a query timeout and a
 * statement timeout — so a stuck refresh cannot accumulate connections without limit, and it holds
 * none of the product's own.
 */
const inFlight = new Set<Promise<unknown>>();

export function scheduleRatingRefresh(locationId: string | null | undefined, actor: string): void {
  if (!locationId) return;
  const p = refreshRatingAfterCommit(locationId, actor)
    .catch((err) => {
      // Structurally unreachable (the callee catches everything). Present so that a future edit
      // which makes it reachable degrades to a log line rather than to a process exit.
      const e = err as { code?: string; message?: string };
      console.error("[partner-rating] detached refresh rejected (should be impossible):", e?.code, e?.message);
    })
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/** Test/shutdown join point for every detached refresh currently running. Never throws. */
export async function drainRatingRefreshes(): Promise<void> {
  // Settled work removes itself from the set, so re-reading the set is required rather than
  // snapshotting once: a refresh can schedule while we are awaiting an earlier one.
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Best-effort refresh, AFTER the caller's transaction has committed.
 *
 * NEVER THROWS. On failure the listing simply stays dirty and the reconciler retries.
 *
 * THE GENERATION IS CAPTURED BEFORE THE CALCULATION, not after. Everything between that read and
 * markRatingClean is the window in which a new quality event can land, and capturing afterwards
 * would mean cleaning against a generation that already included the event we never measured —
 * which is the H2 lost update with extra steps.
 *
 * Callers must not await this inside a transaction — it opens its own connection, and doing so
 * while holding locks it needs is the cross-pool hang described at the top of this file. Prefer
 * `scheduleRatingRefresh` on any request path.
 */
export async function refreshRatingAfterCommit(
  locationId: string | null | undefined,
  actor: string,
): Promise<{ refreshed: boolean; reason?: string }> {
  if (!locationId) return { refreshed: false, reason: "no_location" };
  try {
    const { rows } = await partnerRatingQuery<{ id: string; rating_dirty_generation: string }>(
      "SELECT id, rating_dirty_generation FROM partner_public_listings WHERE location_id = $1 LIMIT 1",
      [locationId],
    );
    const listing = rows[0];
    if (!listing) return { refreshed: false, reason: "no_listing" };
    const generation = BigInt(listing.rating_dirty_generation);

    const result = await recalculateRating(listing.id, actor);
    const cleaned = await markRatingClean(listing.id, generation, result.evidence.oldestEvidenceInWindow);
    // NOT an error, and NOT a retry here. A CAS miss means a quality event arrived mid-calculation;
    // the listing is correctly still dirty and the reconciler owns it now. Retrying inline would
    // race the same way again, on a request path, for a value that is already only advisory.
    return cleaned
      ? { refreshed: true }
      : { refreshed: false, reason: "superseded" };
  } catch (err) {
    // Swallowed DELIBERATELY, and recorded rather than silently dropped: the durable dirty flag is
    // what makes this safe to swallow. Logged with code+message only — a pg error's `detail` can
    // carry row values.
    const e = err as { code?: string; message?: string };
    console.error("[partner-rating] deferred refresh failed (listing stays dirty):", e?.code, e?.message);
    await recordRatingFailure(locationId, classifyRatingFailure(err)).catch(() => {});
    return { refreshed: false, reason: "recalculation_failed" };
  }
}

/** A SHORT classification. Never driver text — see the note in migration 0062. */
export function classifyRatingFailure(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const code = typeof e?.code === "string" ? e.code : "";
  if (code === "57014") return "statement_timeout";
  if (code === "55P03") return "lock_timeout";
  if (code === "40P01") return "deadlock";
  if (code === "53300" || code === "53200") return "resource_exhausted";
  // Neon restarts and idles a compute; these are the SQLSTATEs it produces doing so, and they are
  // transient by definition. 57P01/02/03 were previously classified "unknown", which put an
  // ordinary autosuspend in the same bucket as a schema bug.
  if (code === "57P01" || code === "57P02" || code === "57P03") return "server_restart";
  if (code.startsWith("08")) return "connection";
  if (code.startsWith("42")) return "schema";
  return "unknown";
}

/**
 * Clear the dirty flag ONLY IF no quality event arrived since `generation` was observed.
 *
 * Compare-and-swap on `rating_dirty_generation`. Returns false when the CAS missed, which the
 * caller must treat as "someone else owns this now", never as an error.
 *
 * `rating_clean_generation` is set to the CAPTURED generation, not to the row's current value: the
 * calculation is only entitled to certify the evidence it actually read. The CHECK constraint in
 * 0066 then keeps `rating_dirty` in agreement with the two counters automatically.
 *
 * The claim is released in the same statement. A worker that finishes must not keep a lease it no
 * longer needs, or the next tick will skip a listing that was re-dirtied a millisecond later.
 */
async function markRatingClean(
  listingId: string,
  generation: bigint,
  oldestEvidenceInWindow: string | null,
): Promise<boolean> {
  const nextRecalcSeconds = nextRecalcDelaySeconds(oldestEvidenceInWindow);
  const { rowCount } = await partnerRatingQuery(
    `UPDATE partner_public_listings
        SET rating_dirty = false,
            rating_dirty_since = NULL,
            rating_clean_generation = $2,
            rating_last_attempted_at = now(),
            rating_last_success_at = now(),
            rating_failure_count = 0,
            rating_last_error_code = NULL,
            rating_next_attempt_at = NULL,
            rating_next_recalc_at = now() + make_interval(secs => $3::double precision),
            rating_claimed_until = NULL,
            rating_claimed_by = NULL
      WHERE id = $1
        AND rating_dirty_generation = $2`,
    [listingId, generation.toString(), nextRecalcSeconds],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * When the 180-day window could next change this rating WITHOUT any workflow write.
 *
 * The oldest unit inside the window is the next one to leave it, so its timestamp plus the window
 * length is the earliest instant the population can differ. Before then the answer is provably the
 * same and recalculating would burn a connection to produce identical numbers.
 *
 * Clamped at both ends: never in the past (a boundary already crossed means recalculate on the
 * very next tick), never further out than RATING_MAX_STALENESS_SECONDS (so "no evidence at all"
 * and "evidence only just inside the window" both still get looked at).
 */
export function nextRecalcDelaySeconds(oldestEvidenceInWindow: string | null): number {
  if (!oldestEvidenceInWindow) return RATING_MAX_STALENESS_SECONDS;
  const oldest = Date.parse(oldestEvidenceInWindow);
  if (!Number.isFinite(oldest)) return RATING_MAX_STALENESS_SECONDS;
  const expiresAtMs = oldest + RATING_WINDOW_DAYS * 24 * 3600 * 1000;
  const seconds = Math.ceil((expiresAtMs - Date.now()) / 1000);
  if (seconds <= 0) return 0;
  return Math.min(seconds, RATING_MAX_STALENESS_SECONDS);
}

/**
 * Record a failed attempt and push the listing's retry into the future.
 *
 * THE BACKOFF IS THE H4 REPAIR. Without it a permanently-failing listing keeps the oldest
 * `rating_dirty_since` in the estate forever, so it is first in every bounded batch, on every
 * tick, and nothing behind it is ever reached. `rating_dirty_since` deliberately still does NOT
 * move — that monotonicity is what stops a busy shop starving a quiet one — so the eligibility
 * has to be a separate column. The row is never abandoned: it keeps retrying, just not at the
 * expense of every healthy listing behind it, and Needs Attention still surfaces it.
 *
 * Also releases the claim, so a failure does not hold a lease for its full duration.
 */
async function recordRatingFailure(locationId: string, code: string): Promise<void> {
  await partnerRatingQuery(
    `UPDATE partner_public_listings
        SET rating_last_attempted_at = now(),
            rating_failure_count = rating_failure_count + 1,
            rating_last_error_code = $2,
            rating_dirty = true,
            rating_dirty_since = COALESCE(rating_dirty_since, now()),
            -- The failure itself is a reason to recompute, so the generation must move too, or a
            -- CAS from an in-flight calculation could clean a listing we just marked failed.
            rating_dirty_generation = GREATEST(rating_dirty_generation, rating_clean_generation + 1),
            rating_next_attempt_at = now() + make_interval(secs =>
              LEAST($3::double precision,
                    $4::double precision * power(2, LEAST(rating_failure_count, 12)))),
            rating_claimed_until = NULL,
            rating_claimed_by = NULL
      WHERE location_id = $1`,
    [locationId, code, RATING_BACKOFF_CAP_SECONDS, RATING_BACKOFF_BASE_SECONDS],
  );
}

/** Same, addressed by listing id — the reconciler already knows it and should not re-resolve. */
async function recordRatingFailureByListing(listingId: string, code: string): Promise<void> {
  await partnerRatingQuery(
    `UPDATE partner_public_listings
        SET rating_last_attempted_at = now(),
            rating_failure_count = rating_failure_count + 1,
            rating_last_error_code = $2,
            rating_dirty = true,
            rating_dirty_since = COALESCE(rating_dirty_since, now()),
            rating_dirty_generation = GREATEST(rating_dirty_generation, rating_clean_generation + 1),
            rating_next_attempt_at = now() + make_interval(secs =>
              LEAST($3::double precision,
                    $4::double precision * power(2, LEAST(rating_failure_count, 12)))),
            rating_claimed_until = NULL,
            rating_claimed_by = NULL
      WHERE id = $1`,
    [listingId, code, RATING_BACKOFF_CAP_SECONDS, RATING_BACKOFF_BASE_SECONDS],
  );
}

export interface ReconcilerResult {
  processed: number;
  refreshed: number;
  failed: number;
  /** Claimed but superseded mid-calculation. Not a failure — the listing stays dirty on purpose. */
  superseded: number;
}

/**
 * One bounded reconciler tick.
 *
 * ── MUTUAL EXCLUSION IS A DURABLE CLAIM, NOT A ROW LOCK ─────────────────────────────────────
 * The previous version selected candidates with `FOR UPDATE SKIP LOCKED` through
 * `partnerAdminQuery` — a single `pool.query` with no surrounding transaction. PostgreSQL wraps
 * such a statement in an IMPLICIT transaction that commits when the statement ends, so every lock
 * SKIP LOCKED took was released BEFORE the first row was processed. The comment claimed "two
 * reconcilers on two Fly machines take disjoint work"; in fact both selected the same rows.
 *
 * The claim below is a single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED). That is
 * still one statement, but now the lock and the WRITE are in the same implicit transaction, so
 * they commit together: a second worker running the identical statement concurrently either blocks
 * on the row lock and then sees `rating_claimed_until` in the future (excluded by the predicate),
 * or skips the locked row outright. Either way it takes different work.
 *
 * The claim is DURABLE, which the lock was not. A worker killed mid-item leaves a lease that
 * expires by the clock — no liveness protocol, no reaper, no stuck row. That is also why the
 * advisory lock in server/index.ts is no longer load-bearing: it still serialises the SCHEDULED
 * path, but correctness no longer depends on it, and runRatingReconciler is safe called directly.
 *
 * ── THE CANDIDATE SET ───────────────────────────────────────────────────────────────────────
 *  - DIRTY AND DUE. `rating_dirty` plus retry eligibility (H4), so a poisoned row backs off
 *    instead of occupying every batch.
 *  - OR STALE BY CLOCK. `rating_next_recalc_at <= now()` even when clean (H6) — a 180-day rolling
 *    rating changes as time passes with no write at all, and nothing else in the system notices.
 *  - UNCLAIMED, or claimed by a lease that has expired.
 *
 * ── EVERYTHING ELSE THAT WAS ALREADY RIGHT, AND STAYS ───────────────────────────────────────
 *  - BOUNDED BATCH, no estate-wide sweep, no estate-wide transaction.
 *  - PER-ITEM ISOLATION: the loop catches per listing and keeps going.
 *  - DETERMINISTIC OLDEST-FIRST ORDER, so two runners walk the queue the same way.
 *  - IDEMPOTENT: recalculating an unchanged listing produces the same effective rating.
 */
export async function runRatingReconciler(
  opts: { limit?: number; actor?: string } = {},
): Promise<ReconcilerResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit ?? RATING_RECONCILER_BATCH))));
  const actor = opts.actor ?? "rating-reconciler";
  const empty: ReconcilerResult = { processed: 0, refreshed: 0, failed: 0, superseded: 0 };

  // Pre-0062/0066 databases have no dirty state at all. Treat that as a clean no-op rather than an
  // error, so an application-first rollout does not spew failures until the migration lands.
  const ready = await partnerRatingQuery<{ present: boolean }>(
    `SELECT (
       SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_public_listings'
          AND column_name IN ('rating_dirty','rating_dirty_generation','rating_claimed_until','rating_next_attempt_at')
     ) = 4 AS present`,
  );
  if (!ready.rows[0]?.present) return empty;

  const { rows: claimed } = await partnerRatingQuery<{
    id: string;
    location_id: string;
    rating_dirty_generation: string;
  }>(
    `UPDATE partner_public_listings AS l
        SET rating_claimed_until = now() + make_interval(secs => $2::double precision),
            rating_claimed_by = $3
       FROM (
         SELECT id
           FROM partner_public_listings
          WHERE (
                  (rating_dirty = true
                   AND (rating_next_attempt_at IS NULL OR rating_next_attempt_at <= now()))
                  OR (rating_next_recalc_at IS NOT NULL AND rating_next_recalc_at <= now())
                )
            AND (rating_claimed_until IS NULL OR rating_claimed_until <= now())
          ORDER BY rating_dirty_since ASC NULLS LAST, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) AS c
      WHERE l.id = c.id
      RETURNING l.id, l.location_id, l.rating_dirty_generation`,
    [limit, RATING_CLAIM_SECONDS, actor],
  );

  let refreshed = 0;
  let failed = 0;
  let superseded = 0;
  for (const row of claimed) {
    try {
      const result = await recalculateRating(row.id, actor);
      const ok = await markRatingClean(
        row.id,
        BigInt(row.rating_dirty_generation),
        result.evidence.oldestEvidenceInWindow,
      );
      if (ok) refreshed += 1;
      else {
        // A quality event landed while we were calculating. The listing is correctly still dirty;
        // releasing the claim is all this tick owes it. Counted separately so an operator can tell
        // "busy" apart from "broken" — a rising `failed` is an incident, a rising `superseded` is
        // just a shop being graded.
        superseded += 1;
        await releaseClaim(row.id).catch(() => {});
      }
    } catch (err) {
      failed += 1;
      const e = err as { code?: string; message?: string };
      console.error("[partner-rating] reconciler: listing failed, continuing:", row.id, e?.code, e?.message);
      // Recorded, backed off, claim released — so the next tick reaches the listings behind it.
      await recordRatingFailureByListing(row.id, classifyRatingFailure(err)).catch(() => {});
    }
  }
  return { processed: claimed.length, refreshed, failed, superseded };
}

async function releaseClaim(listingId: string): Promise<void> {
  await partnerRatingQuery(
    "UPDATE partner_public_listings SET rating_claimed_until = NULL, rating_claimed_by = NULL WHERE id = $1",
    [listingId],
  );
}

/**
 * Listings whose rating has failed enough times to be a human problem.
 *
 * This is the ONLY rating entry into the Super Admin exception queue. A listing that failed once
 * and recovered never appears; a listing failing persistently does. Healthy listings are excluded
 * by construction — the predicate is failures, not staleness.
 */
export async function ratingsNeedingAttention(
  threshold: number = RATING_FAILURE_ATTENTION_THRESHOLD,
): Promise<Array<{
  listingId: string;
  slug: string;
  failureCount: number;
  lastErrorCode: string | null;
  dirtySince: string | null;
  nextAttemptAt: string | null;
}>> {
  const { rows } = await partnerRatingQuery<{
    id: string; slug: string; rating_failure_count: number;
    rating_last_error_code: string | null; rating_dirty_since: Date | null;
    rating_next_attempt_at: Date | null;
  }>(
    `SELECT id, slug, rating_failure_count, rating_last_error_code, rating_dirty_since, rating_next_attempt_at
       FROM partner_public_listings
      WHERE rating_dirty = true
        AND rating_failure_count >= $1
      ORDER BY rating_failure_count DESC, rating_dirty_since ASC`,
    [Math.max(1, Math.floor(threshold))],
  );
  return rows.map((r) => ({
    listingId: r.id,
    slug: r.slug,
    failureCount: Number(r.rating_failure_count),
    lastErrorCode: r.rating_last_error_code,
    dirtySince: r.rating_dirty_since ? r.rating_dirty_since.toISOString() : null,
    // Surfaced so an operator can see that a stuck listing IS still being retried, and when.
    // Without it a backed-off row looks abandoned.
    nextAttemptAt: r.rating_next_attempt_at ? r.rating_next_attempt_at.toISOString() : null,
  }));
}

/**
 * Mark a listing dirty from OUTSIDE any caller transaction, atomically with nothing.
 *
 * Exists for the one path that genuinely has no transaction to join — the override admin routes,
 * which must dirty a listing they have just changed. Prefer `markRatingDirty` with the caller's
 * client everywhere a transaction exists; this is the fallback, not the default.
 */
export async function markRatingDirtyByLocation(locationId: string | null | undefined): Promise<void> {
  if (!locationId) return;
  await partnerRatingQuery(
    `UPDATE partner_public_listings
        SET rating_dirty = true,
            rating_dirty_since = COALESCE(rating_dirty_since, now()),
            rating_dirty_generation = rating_dirty_generation + 1
      WHERE location_id = $1`,
    [locationId],
  );
}

/** As above, addressed by listing id. Used by the override routes, which hold one. */
export async function markRatingDirtyByListing(
  exec: RatingDirtyExecutor,
  listingId: string,
): Promise<void> {
  await exec.query(
    `UPDATE partner_public_listings
        SET rating_dirty = true,
            rating_dirty_since = COALESCE(rating_dirty_since, now()),
            rating_dirty_generation = rating_dirty_generation + 1
      WHERE id = $1`,
    [listingId],
  );
}

export { withPartnerRatingTransaction };
