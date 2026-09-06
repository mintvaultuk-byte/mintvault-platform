import type { Store } from "express-rate-limit";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

/**
 * Fleet-wide fixed-window store for public account authentication routes.
 * Public-account traffic has its own main-runtime relation.  It must not reuse
 * Partner Network storage: the main web credential has zero authority on
 * operational partner_* relations.
 */
export class PostgresFixedWindowRateLimitStore implements Store {
  readonly localKeys = false;
  private lastSweepAt = 0;

  constructor(
    private readonly queryable: Queryable,
    private readonly windowMs: number,
    readonly prefix: string
  ) {}

  private bucket(key: string): string {
    return `${this.prefix}${key}`;
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    const result = await this.queryable.query<{ hit_count: number; reset_at: Date }>(
      `INSERT INTO public.public_rate_limit_buckets (bucket_key, hit_count, reset_at)
            VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (bucket_key) DO UPDATE
              SET hit_count = CASE
                                WHEN public_rate_limit_buckets.reset_at <= now() THEN 1
                                ELSE public_rate_limit_buckets.hit_count + 1
                              END,
                  reset_at = CASE
                               WHEN public_rate_limit_buckets.reset_at <= now()
                                 THEN now() + ($2 || ' milliseconds')::interval
                               ELSE public_rate_limit_buckets.reset_at
                             END
         RETURNING hit_count, reset_at`,
      [this.bucket(key), String(Math.max(1, Math.floor(this.windowMs)))]
    );
    const row = result.rows[0];
    if (!row || !Number.isSafeInteger(row.hit_count) || !(row.reset_at instanceof Date)) {
      throw new Error("public auth rate-limit store returned an invalid counter");
    }
    await this.maybeSweep();
    return { totalHits: row.hit_count, resetTime: row.reset_at };
  }

  async decrement(key: string): Promise<void> {
    await this.queryable.query(
      `UPDATE public.public_rate_limit_buckets
          SET hit_count = GREATEST(0, hit_count - 1)
        WHERE bucket_key = $1`,
      [this.bucket(key)]
    );
  }

  async resetKey(key: string): Promise<void> {
    await this.queryable.query(`DELETE FROM public.public_rate_limit_buckets WHERE bucket_key = $1`, [
      this.bucket(key),
    ]);
  }

  /** Bounded best-effort retention; a cleanup failure never weakens a successful counter hit. */
  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < 5 * 60_000) return;
    this.lastSweepAt = now;
    try {
      await this.queryable.query(
        `DELETE FROM public.public_rate_limit_buckets
          WHERE bucket_key IN (
            SELECT bucket_key
              FROM public.public_rate_limit_buckets
             WHERE reset_at <= now()
             ORDER BY reset_at
             LIMIT 5000
          )`
      );
    } catch {
      // Expired rows are not authority. The next interval retries cleanup.
    }
  }
}

export class PostgresPublicAuthRateLimitStore extends PostgresFixedWindowRateLimitStore {
  constructor(queryable: Queryable, windowMs: number) {
    super(queryable, windowMs, "public_auth:");
  }
}
