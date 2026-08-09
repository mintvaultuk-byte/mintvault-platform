/**
 * Partner rating lifecycle — automatic dirtying, non-blocking refresh, bounded reconciliation.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * -------------------------------------------------------------------------------------------
 * A rating is SECONDARY. Nothing in here may cause a card's grading, approval, credit settlement,
 * certificate issuance, printing or completion to fail. A shop's quality score being briefly stale
 * is an inconvenience; a card that could not be approved because a rating query timed out is an
 * outage of the actual product.
 *
 * That is why the two halves are shaped so differently:
 *
 *   markRatingDirty  — TINY, inside the caller's own transaction, on the caller's own client.
 *                      One UPDATE of one row by primary-key-ish lookup. Durable, so the obligation
 *                      commits with the evidence that created it.
 *
 *   refreshRatingAfterCommit — everything expensive, AFTER the commit, on its own connection,
 *                      and it NEVER throws. Its failure mode is "the listing stays dirty", which
 *                      the reconciler then picks up.
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
import { partnerAdminQuery } from "./db";
import { recalculateRating } from "./public-network-service";

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

/** Something the caller can execute SQL on — a pool client inside a transaction, or a Drizzle-ish tx. */
export interface RatingDirtyExecutor {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * Mark the listing for this LOCATION dirty, on the caller's own connection.
 *
 * IDEMPOTENT AND MONOTONIC. Marking an already-dirty listing does not move rating_dirty_since, so
 * the reconciler's oldest-first ordering keeps its meaning and a shop under constant activity
 * cannot keep pushing itself to the back of the queue.
 *
 * A location with no public listing is a NO-OP, not an error: most locations never opt into the
 * public network. Zero rows affected is the expected case, so it is deliberately not reported as
 * success-or-failure — there is nothing to report.
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
            rating_dirty_since = COALESCE(rating_dirty_since, now())
      WHERE location_id = $1
        AND rating_dirty = false`,
    [locationId],
  );
}

/**
 * Best-effort refresh, AFTER the caller's transaction has committed.
 *
 * NEVER THROWS. That is the entire contract, and it is why the signature returns a result object
 * rather than propagating: an approval must not fail because a rating did not refresh. On failure
 * the listing simply stays dirty and the reconciler retries.
 *
 * Callers must not await this inside a transaction — it opens its own connection, and doing so
 * while holding locks it needs is the cross-pool hang described at the top of this file.
 */
export async function refreshRatingAfterCommit(
  locationId: string | null | undefined,
  actor: string,
): Promise<{ refreshed: boolean; reason?: string }> {
  if (!locationId) return { refreshed: false, reason: "no_location" };
  try {
    const { rows } = await partnerAdminQuery<{ id: string }>(
      "SELECT id FROM partner_public_listings WHERE location_id = $1 LIMIT 1",
      [locationId],
    );
    const listingId = rows[0]?.id;
    if (!listingId) return { refreshed: false, reason: "no_listing" };
    await recalculateRating(listingId, actor);
    await markRatingClean(listingId);
    return { refreshed: true };
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
  if (code.startsWith("08")) return "connection";
  if (code.startsWith("42")) return "schema";
  return "unknown";
}

async function markRatingClean(listingId: string): Promise<void> {
  await partnerAdminQuery(
    `UPDATE partner_public_listings
        SET rating_dirty = false,
            rating_dirty_since = NULL,
            rating_last_attempted_at = now(),
            rating_last_success_at = now(),
            rating_failure_count = 0,
            rating_last_error_code = NULL
      WHERE id = $1`,
    [listingId],
  );
}

async function recordRatingFailure(locationId: string, code: string): Promise<void> {
  await partnerAdminQuery(
    `UPDATE partner_public_listings
        SET rating_last_attempted_at = now(),
            rating_failure_count = rating_failure_count + 1,
            rating_last_error_code = $2,
            rating_dirty = true,
            rating_dirty_since = COALESCE(rating_dirty_since, now())
      WHERE location_id = $1`,
    [locationId, code],
  );
}

export interface ReconcilerResult {
  processed: number;
  refreshed: number;
  failed: number;
}

/**
 * One bounded reconciler tick.
 *
 * DESIGN NOTES, each of which is a failure mode avoided:
 *
 *  - BOUNDED BATCH. A `LIMIT` on the candidate query, not "all dirty listings". An estate-wide
 *    sweep would grow without limit and eventually not finish inside any sane tick.
 *  - NO ESTATE-WIDE TRANSACTION. Each listing is recalculated on its own, so one shop's failure
 *    cannot roll back another shop's successful refresh.
 *  - PER-ITEM ISOLATION. The loop catches per listing and keeps going. One poisoned row must not
 *    stop the queue — that is how a single bad shop freezes every rating in the estate.
 *  - FOR UPDATE SKIP LOCKED. Two reconcilers on two Fly machines take disjoint work rather than
 *    duplicating it or deadlocking. This is the same claim shape connector-service already uses.
 *  - DETERMINISTIC OLDEST-FIRST ORDER. rating_dirty_since ASC, id ASC — so a busy shop cannot
 *    starve a quiet one, and two concurrent runners walk the queue the same way.
 *  - IDEMPOTENT. Recalculating an unchanged listing produces the same effective rating; a second
 *    run over the same rows is harmless.
 */
export async function runRatingReconciler(
  opts: { limit?: number; actor?: string } = {},
): Promise<ReconcilerResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit ?? RATING_RECONCILER_BATCH))));
  const actor = opts.actor ?? "rating-reconciler";

  // Pre-0062 databases have no dirty state at all. Treat that as a clean no-op rather than an
  // error, so an application-first rollout does not spew failures until the migration lands.
  const ready = await partnerAdminQuery<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name='rating_dirty'
     ) AS present`,
  );
  if (!ready.rows[0]?.present) return { processed: 0, refreshed: 0, failed: 0 };

  const { rows: candidates } = await partnerAdminQuery<{ id: string; location_id: string }>(
    `SELECT id, location_id
       FROM partner_public_listings
      WHERE rating_dirty = true
      ORDER BY rating_dirty_since ASC, id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  let refreshed = 0;
  let failed = 0;
  for (const row of candidates) {
    try {
      await recalculateRating(row.id, actor);
      await markRatingClean(row.id);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      const e = err as { code?: string; message?: string };
      console.error("[partner-rating] reconciler: listing failed, continuing:", row.id, e?.code, e?.message);
      // Recorded, and the listing stays dirty so the next tick retries it.
      await recordRatingFailure(row.location_id, classifyRatingFailure(err)).catch(() => {});
    }
  }
  return { processed: candidates.length, refreshed, failed };
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
): Promise<Array<{ listingId: string; slug: string; failureCount: number; lastErrorCode: string | null; dirtySince: string | null }>> {
  const { rows } = await partnerAdminQuery<{
    id: string; slug: string; rating_failure_count: number;
    rating_last_error_code: string | null; rating_dirty_since: Date | null;
  }>(
    `SELECT id, slug, rating_failure_count, rating_last_error_code, rating_dirty_since
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
  }));
}
