/**
 * Shared PostgreSQL rate-limit store (invariant I19).
 *
 * Replaces the per-process MemoryRateLimitStore that server/partner/rate-limit.ts shipped as its
 * LOCAL-ONLY default. Production runs a minimum of two Fly Machines against one database, so a
 * per-process counter made every published partner limit silently double and reset on every rolling
 * deploy. These are the only credential-attack controls on the partner portal.
 *
 * ATOMICITY. A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING performs the whole
 * read-modify-write under the row lock Postgres already takes for the upsert, so two Machines
 * incrementing the same bucket concurrently cannot lose a hit. There is deliberately no
 * SELECT-then-UPDATE: that would be a read-modify-write race across Machines, which is the exact
 * class of bug this store exists to remove.
 *
 * WINDOW SEMANTICS are preserved exactly from MemoryRateLimitStore — a fixed window that starts on
 * the first hit and resets once `reset_at` passes — so limiter behaviour is unchanged apart from
 * being fleet-wide instead of per-process.
 *
 * FAIL BEHAVIOUR. `hit()` THROWS when the store is unavailable. That is the contract the limiter
 * relies on: a `failClosed: true` limiter (login, MFA, password reset, invitation accept) DENIES on a
 * store error. Swallowing the error here would silently convert every sensitive limiter into
 * fail-open, which is strictly worse than the in-memory store it replaces.
 */
import type { RateLimitStore } from "./rate-limit";
import { partnerRuntimeQuery } from "./db";

/** Expired rows are pruned opportunistically rather than by a scheduled job. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 5_000;

export class PostgresRateLimitStore implements RateLimitStore {
  private lastSweepAt = 0;

  async hit(key: string, windowMs: number): Promise<number> {
    const { rows } = await partnerRuntimeQuery<{ hit_count: number }>(
      `INSERT INTO partner_rate_limit_buckets (bucket_key, hit_count, reset_at)
            VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (bucket_key) DO UPDATE
              SET hit_count = CASE
                                WHEN partner_rate_limit_buckets.reset_at <= now() THEN 1
                                ELSE partner_rate_limit_buckets.hit_count + 1
                              END,
                  reset_at  = CASE
                                WHEN partner_rate_limit_buckets.reset_at <= now()
                                  THEN now() + ($2 || ' milliseconds')::interval
                                ELSE partner_rate_limit_buckets.reset_at
                              END
         RETURNING hit_count`,
      [key, String(Math.max(1, Math.floor(windowMs)))]
    );
    const count = rows[0]?.hit_count;
    if (typeof count !== "number") {
      // Never report a fabricated count — a wrong number here silently weakens a security control.
      throw new Error("partner rate-limit store returned no count");
    }
    void this.maybeSweep();
    return count;
  }

  /**
   * Delete expired buckets. Bounded and best-effort: a sweep failure must never deny a request that
   * the counter itself already allowed, so errors are swallowed HERE (unlike hit(), which must
   * throw). Bucket keys can embed a submitted email address, so pruning is also a privacy measure,
   * not merely housekeeping.
   */
  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    try {
      await partnerRuntimeQuery(
        `DELETE FROM partner_rate_limit_buckets
          WHERE bucket_key IN (
            SELECT bucket_key FROM partner_rate_limit_buckets WHERE reset_at <= now() LIMIT $1
          )`,
        [SWEEP_BATCH]
      );
    } catch {
      /* best effort — expired rows are harmless and the next sweep retries */
    }
  }
}

/**
 * Probe for the backing table and install the shared store when it is present.
 *
 * Returns whether the shared store was installed. Called once at partner-portal mount; a database
 * that has not yet received migration 0078 keeps the in-memory default rather than failing to boot,
 * which is what makes the migration safe to apply either side of the deploy (expand → migrate →
 * deploy). The outcome is logged either way — an operator must be able to see which store is live,
 * because the difference is a doubling of every partner rate limit.
 */
export async function installSharedPartnerRateLimitStore(): Promise<boolean> {
  const { setPartnerRateLimitStore } = await import("./rate-limit");
  try {
    const { rows } = await partnerRuntimeQuery<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='partner_rate_limit_buckets'
       ) AS present`
    );
    if (rows[0]?.present !== true) {
      // eslint-disable-next-line no-console
      console.warn(
        "[partner] partner_rate_limit_buckets is absent — partner rate limits remain PER-MACHINE " +
          "(apply migrations/0078_partner_shared_rate_limit_buckets.sql to make them fleet-wide)."
      );
      return false;
    }
    setPartnerRateLimitStore(new PostgresRateLimitStore());
    // eslint-disable-next-line no-console
    console.log("[partner] shared PostgreSQL rate-limit store installed (limits are fleet-wide).");
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[partner] could not install the shared rate-limit store; falling back to the per-machine " +
        `in-memory store: ${(err as Error).message}`
    );
    return false;
  }
}
