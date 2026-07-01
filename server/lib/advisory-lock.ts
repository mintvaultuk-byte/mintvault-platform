/**
 * Postgres advisory-lock wrapper for scheduled jobs (Phase 5).
 *
 * MintVault runs one Fly machine today, but the scheduled jobs (transfer sweep,
 * vault-club grace, scan reconciler, archival, etc.) have no guard against
 * running concurrently if it ever scales to 2+. Wrapping a job in
 * withAdvisoryLock() means only ONE machine runs that tick — others see the lock
 * held and skip. Non-blocking (pg_try_advisory_lock) so a busy machine never
 * stalls; always released.
 *
 * IMPORTANT: advisory locks are SESSION-scoped. We must acquire AND release on
 * the SAME connection, so this checks out a dedicated client via pool.connect()
 * rather than pool.query() (which could lock and unlock on different pooled
 * connections, leaving the lock stuck). Fail-closed: if anything goes wrong
 * acquiring the lock, the job is skipped — a skip is always safer than a
 * double-run for externally-visible actions (emails, publishing).
 */

interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}
interface MinimalPool {
  connect(): Promise<PoolClientLike>;
}

/** Stable 31-bit hash of a lock name -> a Postgres advisory-lock key. */
export function hashLockKey(name: string): number {
  let h = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 0x7fffffff; // positive 31-bit single-bigint key
}

export interface LockOutcome {
  ran: boolean;
}

export async function withAdvisoryLock(
  pool: MinimalPool,
  lockName: string,
  fn: () => Promise<void>
): Promise<LockOutcome> {
  const key = hashLockKey(lockName);
  let client: PoolClientLike;
  try {
    client = await pool.connect();
  } catch {
    return { ran: false }; // can't even get a connection — skip
  }
  try {
    let acquired = false;
    try {
      const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [key]);
      acquired = res.rows[0]?.locked === true;
    } catch {
      return { ran: false }; // acquire failed — fail closed
    }
    if (!acquired) return { ran: false }; // another holder has it

    try {
      await fn();
      return { ran: true };
    } finally {
      // release on the SAME client that acquired it
      await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
