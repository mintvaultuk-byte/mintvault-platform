/**
 * Shared PostgreSQL rate-limit store (invariant I19).
 *
 * Replaces the unavailable fail-closed boot store in server/partner/rate-limit.ts.
 * Production runs a minimum of two Fly Machines against one database, so a
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
import {
  installSharedPostgresPartnerRateLimitStore,
  markSharedPostgresPartnerRateLimitStoreUnavailable,
  partnerSharedRateLimitStoreInstalled,
  type RateLimitStore,
} from "./rate-limit";
import { partnerRuntimeQuery } from "./db";
import { getPartnerRuntimeCapability, type PartnerCapabilityResult } from "./admin-capability";
import type pg from "pg";

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
 * Returns whether the shared store was installed. Until it succeeds, sensitive
 * partner limiters remain unavailable/fail-closed; there is no per-Machine
 * fallback and therefore no doubled attack budget during boot or schema drift.
 */
type QueryFn = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
) => Promise<pg.QueryResult<T>>;

interface InstallSharedPartnerRateLimitStoreDeps {
  capabilityProbe?: () => Promise<PartnerCapabilityResult>;
  query?: QueryFn;
}

export async function installSharedPartnerRateLimitStore(
  deps: InstallSharedPartnerRateLimitStoreDeps = {}
): Promise<boolean> {
  markSharedPostgresPartnerRateLimitStoreUnavailable();
  try {
    const capability = await (deps.capabilityProbe ?? getPartnerRuntimeCapability)();
    if (!capability.ok) {
      // Failure codes are deliberately name-safe: never log the URL, role name or credentials.
      // eslint-disable-next-line no-console
      console.error(`[partner] shared rate-limit store credential rejected: ${capability.code}`);
      return false;
    }

    const query = deps.query ?? partnerRuntimeQuery;
    const { rows } = await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='partner_rate_limit_buckets'
       ) AS present`
    );
    if (rows[0]?.present !== true) {
      // eslint-disable-next-line no-console
      console.warn(
        "[partner] partner_rate_limit_buckets is absent — sensitive partner routes remain fail-closed " +
          "(apply migrations/0089_partner_shared_rate_limit_buckets.sql)."
      );
      return false;
    }
    installSharedPostgresPartnerRateLimitStore(new PostgresRateLimitStore());
    // eslint-disable-next-line no-console
    console.log("[partner] shared PostgreSQL rate-limit store installed (limits are fleet-wide).");
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[partner] could not install the shared rate-limit store; sensitive partner routes remain fail-closed: " +
        (err as Error).message
    );
    return false;
  }
}

/**
 * Start the one process-lifetime boot probe and return the same promise to every caller.
 *
 * Public routes are registered before the authenticated mount, so fire-and-forget installation in
 * mount.ts left a real race: the first login/invitation/reset request could hit the deliberately
 * unavailable boot store and receive 503 even though the database was healthy. Callers that serve
 * those routes await this promise before entering the limiter chain. A failed probe still leaves
 * the store unavailable and therefore fail-closed; this barrier changes timing, not policy.
 */
let sharedStoreBootInstall: Promise<boolean> | null = null;

export function startSharedPartnerRateLimitStoreInstall(): Promise<boolean> {
  if (partnerSharedRateLimitStoreInstalled()) return Promise.resolve(true);
  if (!sharedStoreBootInstall) sharedStoreBootInstall = installSharedPartnerRateLimitStore();
  return sharedStoreBootInstall;
}
