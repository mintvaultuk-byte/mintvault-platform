/**
 * Project Control — durable, cross-machine sync coordination.
 *
 * WHY A PROCESS CACHE WAS NOT ENOUGH
 * ----------------------------------
 * `scanGitHub` coalesces concurrent callers with a module-level `inFlight` promise. That is a
 * correct optimisation and a useless guarantee: production runs TWO Fly machines, so machine A's
 * in-flight promise is invisible to machine B. Two operators clicking "Refresh" hit two machines
 * and start two syncs against a rate-limited API, and neither can see the other's state. Nothing
 * survives a restart.
 *
 * The lease moves the authority into the one place both machines share — the database.
 *
 * THE MECHANISM
 * -------------
 * One row per source type; the PRIMARY KEY is what makes it exclusive. Acquiring is a single
 * `INSERT ... ON CONFLICT DO UPDATE` whose WHERE clause only fires when the existing lease has
 * EXPIRED. So:
 *
 *   - a live lease held by anyone   -> conflict, no update, we did not get it;
 *   - an expired lease              -> taken over atomically, no separate read-then-write;
 *   - no lease at all               -> inserted.
 *
 * It is one statement, so two machines racing cannot both win: PostgreSQL serialises the conflict.
 * There is no read-then-write window to lose.
 *
 * WHY EXPIRY IS NOT OPTIONAL
 * --------------------------
 * A process that dies mid-sync — OOM, a Fly machine replacement, a deploy — leaves its lease row
 * behind. Without expiry that row would block every future sync forever, and the only remedy would
 * be a manual DELETE against production. Expiry makes a crash self-healing.
 *
 * WHY THE OWNER TOKEN EXISTS
 * --------------------------
 * Release is conditional on the token. A slow machine whose lease has already expired and been
 * taken over by another machine must NOT be able to release the new holder's lease when it finally
 * finishes. Without the token that is a silent double-sync.
 */
import { randomUUID } from "node:crypto";

/** Long enough for a full GitHub sync, short enough that a crash recovers promptly. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

/** Minimal database seam, so the tests can drive a real pool and production can pass its own. */
export interface LeaseDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface LeaseHandle {
  sourceType: string;
  ownerToken: string;
  syncId: string;
  expiresAt: Date;
}

export type AcquireResult =
  | { acquired: true; lease: LeaseHandle }
  /** Somebody else holds it. `activeSyncId` lets the caller return the RUNNING sync instead of 409. */
  | { acquired: false; activeSyncId: string | null; expiresAt: Date | null };

/**
 * Identify this process in the ledger so an operator can tell the two Fly machines apart.
 * Fly injects FLY_MACHINE_ID; elsewhere the hostname is enough. Never a credential.
 */
export function workerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FLY_MACHINE_ID || env.HOSTNAME || "local").slice(0, 64);
}

/**
 * Try to take the lease for `sourceType`.
 *
 * Single statement, so the race is resolved by the database rather than by application logic.
 * Returning `acquired: false` is a normal outcome, not an error — it means a sync is already
 * running and the caller should surface that one.
 */
export async function acquireLease(
  db: LeaseDb,
  sourceType: string,
  syncId: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  env: NodeJS.ProcessEnv = process.env
): Promise<AcquireResult> {
  const ownerToken = randomUUID();
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));

  const res = await db.query(
    `INSERT INTO pc_sync_leases (source_type, owner_token, sync_id, acquired_at, expires_at, worker_identity)
     VALUES ($1, $2, $3, now(), now() + ($4 || ' seconds')::interval, $5)
     ON CONFLICT (source_type) DO UPDATE
       SET owner_token = EXCLUDED.owner_token,
           sync_id = EXCLUDED.sync_id,
           acquired_at = now(),
           expires_at = EXCLUDED.expires_at,
           worker_identity = EXCLUDED.worker_identity
       -- The whole exclusion rule. Only an EXPIRED lease may be taken over; a live one is left
       -- untouched and the INSERT reports zero rows, which is how we learn we lost the race.
       WHERE pc_sync_leases.expires_at < now()
     RETURNING owner_token, sync_id, expires_at`,
    [sourceType, ownerToken, syncId, String(ttlSeconds), workerIdentity(env)]
  );

  if (res.rowCount && res.rowCount > 0) {
    const row = res.rows[0] as { owner_token: string; sync_id: string; expires_at: Date };
    return {
      acquired: true,
      lease: { sourceType, ownerToken: row.owner_token, syncId: row.sync_id, expiresAt: new Date(row.expires_at) },
    };
  }

  // We lost. Report WHO holds it so the caller can return the active sync rather than a bare
  // "busy" — a duplicate refresh should show the run already in progress.
  const held = await db.query(`SELECT sync_id, expires_at FROM pc_sync_leases WHERE source_type = $1`, [sourceType]);
  const row = held.rows[0] as { sync_id?: string; expires_at?: Date } | undefined;
  return {
    acquired: false,
    activeSyncId: row?.sync_id ?? null,
    expiresAt: row?.expires_at ? new Date(row.expires_at) : null,
  };
}

/**
 * Release a lease we hold.
 *
 * Conditional on the owner token: if our lease expired and another machine took it over, this
 * deletes nothing and returns false. Releasing unconditionally would hand a second machine's
 * active sync to whoever finished last — a silent double-sync against a rate-limited API.
 */
export async function releaseLease(db: LeaseDb, lease: LeaseHandle): Promise<boolean> {
  const res = await db.query(`DELETE FROM pc_sync_leases WHERE source_type = $1 AND owner_token = $2`, [
    lease.sourceType,
    lease.ownerToken,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Extend a lease we still hold, for a sync that is legitimately long-running.
 *
 * Also conditional on the token, and additionally on the lease not having expired already — an
 * expired lease may have been taken over, and resurrecting it would create two live holders.
 */
export async function renewLease(
  db: LeaseDb,
  lease: LeaseHandle,
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): Promise<boolean> {
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));
  const res = await db.query(
    `UPDATE pc_sync_leases
        SET expires_at = now() + ($3 || ' seconds')::interval
      WHERE source_type = $1 AND owner_token = $2 AND expires_at > now()`,
    [lease.sourceType, lease.ownerToken, String(ttlSeconds)]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Run `work` under a lease, releasing it whatever happens.
 *
 * The `finally` is the point: a throwing sync must not hold the lease until expiry, or a transient
 * failure would lock out refresh for the full TTL. Returns null when the lease was not acquired,
 * so the caller can distinguish "did not run" from "ran and returned null".
 */
export async function withLease<T>(
  db: LeaseDb,
  sourceType: string,
  syncId: string,
  work: (lease: LeaseHandle) => Promise<T>,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ran: false; activeSyncId: string | null } | { ran: true; result: T }> {
  const attempt = await acquireLease(db, sourceType, syncId, ttlMs, env);
  if (!attempt.acquired) return { ran: false, activeSyncId: attempt.activeSyncId };

  try {
    return { ran: true, result: await work(attempt.lease) };
  } finally {
    await releaseLease(db, attempt.lease).catch(() => {
      // A failed release is survivable — expiry will clear it. Losing the original error to a
      // cleanup failure would not be.
    });
  }
}
