/**
 * PKG-3 — estimate-credit consumption: owner binding + atomic decrement.
 *
 * The public AI Pre-Grade tool (POST /api/tools/estimate) spends one estimate
 * credit per paid inference. This module is the single authority that decides
 * whether a request may reserve a credit, and performs the reservation ATOMICALLY, so
 * the route calls the paid Anthropic provider ONLY after the database has proven
 * exactly one credit was consumed.
 *
 * Security invariants enforced here:
 *  A. Paid credits are owner-bound. They can be spent only by an authenticated
 *     account id (users.ai_credits_user_balance, then estimate_credits owned by
 *     that id or the account's current database-verified email).
 *  B. Logged-out callers never gain authority from an email in the request. They
 *     retain only the bounded one-per-IP/day free tier.
 *  D. Every reservation is a single conditional UPDATE + durable ledger insert
 *     whose row count is the final
 *     authority. Zero rows affected → no provider call.
 *  E. Concurrency safety comes from the database (guarded UPDATE / row lock),
 *     not an in-process lock: two requests racing one credit yield exactly one
 *     decrement and never a negative balance.
 *
 *  F. Provider failure refunds a reservation exactly once. A retry can reserve
 *     the restored credit; duplicate compensation cannot mint extra credit.
 *
 * The executor dependency is injectable purely so tests can drive a disposable
 * local PostgreSQL cluster (no SSL). Production callers pass nothing.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { auditLog } from "@shared/schema";
import type { AiCreditExec } from "./storage";
import { normalizePartnerRateLimitIp } from "./partner/rate-limit";

/** Executor surface this module needs (satisfied by the real db and by a test drizzle instance). */
export type EstimateExec = AiCreditExec;

export interface ConsumeEstimateCreditInput {
  /** Authenticated user id from the trusted session (req.session.userId), if any. */
  sessionUserId?: string | null;
  /** True only when the trusted server-side session carries authenticated admin state. */
  isAuthenticatedAdmin?: boolean;
  /** SHA-256 IP hash for the anonymous free-tier (no session, no email). */
  ipHash?: string | null;
  /** UTC day (YYYY-MM-DD) for the anonymous free-tier window. */
  today?: string | null;
}

export interface ConsumeEstimateCreditDeps {
  exec?: EstimateExec;
}

export type ConsumeEstimateCreditResult =
  | {
      ok: true;
      /** Which pool the credit was consumed from. */
      path: "admin" | "user_balance" | "user_estimate" | "anon_free";
      /** Remaining balance to echo back to the client, or null when not tracked. */
      remaining: number | null;
      /** Durable reservation to commit after a valid result or refund on failure. */
      reservationId: string | null;
    }
  | {
      ok: false;
      status: 401 | 402;
      error: string;
      /** Extra response fields (preserves the anon free-tier payload shape). */
      extra?: Record<string, unknown>;
    };

async function bestEffortAudit(exec: EstimateExec, entityId: string, details: Record<string, unknown>): Promise<void> {
  try {
    await exec.insert(auditLog).values({
      entityType: "estimate",
      entityId,
      action: "402_insufficient",
      adminUser: null,
      details,
    });
  } catch {
    // Audit is best-effort; never block the request path on it.
  }
}

/**
 * Decide whether this request may spend an estimate credit and, if so, atomically
 * spend exactly one. The paid provider must be invoked by the caller ONLY when
 * this resolves to { ok: true }.
 */
export async function consumeEstimateCredit(
  input: ConsumeEstimateCreditInput,
  deps: ConsumeEstimateCreditDeps = {}
): Promise<ConsumeEstimateCreditResult> {
  const exec = deps.exec ?? db;

  const sessionUserId = input.sessionUserId || null;

  // The only unlimited path is authenticated server-side admin state. Public
  // headers, body email and query email are deliberately absent from this API.
  if (input.isAuthenticatedAdmin) {
    return { ok: true, path: "admin", remaining: null, reservationId: null };
  }

  // ── AUTHENTICATED ─────────────────────────────────────────────────────────
  // Authority comes solely from the session. req.body.email is IGNORED here.
  if (sessionUserId) {
    // 1) Owner-bound personal AI-credit balance. The decrement and durable
    // reservation are one statement: either both commit, or neither does.
    const userReservationId = crypto.randomUUID();
    const personal = await exec.execute(sql`
      WITH spent AS (
        UPDATE users
           SET ai_credits_user_balance = ai_credits_user_balance - 1,
               updated_at = NOW()
         WHERE id = ${sessionUserId}
           AND deleted_at IS NULL
           AND ai_credits_user_balance >= 1
        RETURNING ai_credits_user_balance
      ), reserved AS (
        INSERT INTO estimate_credit_reservations
          (id, credit_path, session_user_id, status)
        SELECT ${userReservationId}::uuid, 'user_balance', ${sessionUserId}, 'reserved'
          FROM spent
        RETURNING id
      )
      SELECT spent.ai_credits_user_balance AS remaining, reserved.id AS reservation_id
        FROM spent CROSS JOIN reserved
    `);
    if (personal.rows.length === 1) {
      return {
        ok: true,
        path: "user_balance",
        remaining: Number((personal.rows[0] as any).remaining),
        reservationId: String((personal.rows[0] as any).reservation_id),
      };
    }

    // 2) Fall back ONLY to estimate credits the authenticated user owns — matched
    //    by user id, or an unclaimed legacy row matching the account's CURRENT
    //    DATABASE-VERIFIED email. The cached session email is intentionally not
    //    authority: an unverified email change must not claim another customer's
    //    legacy row. A single-row locked decrement guarantees exactly one
    //    credit is spent even if the user owns several matching rows, and is
    //    concurrency-safe (FOR UPDATE SKIP LOCKED).
    const estimateReservationId = crypto.randomUUID();
    const owned = await exec.execute(sql`
      WITH spent AS (
        UPDATE estimate_credits
           SET credits_remaining = credits_remaining - 1,
               credits_used = credits_used + 1,
               updated_at = NOW()
         WHERE id = (
           SELECT id FROM estimate_credits
            WHERE credits_remaining > 0
              AND (
                user_id = ${sessionUserId}
                OR (
                  user_id IS NULL
                  AND email = (
                    SELECT lower(u.email)
                      FROM users u
                     WHERE u.id = ${sessionUserId}
                       AND u.email_verified IS TRUE
                       AND u.deleted_at IS NULL
                  )
                )
              )
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
        RETURNING id, credits_remaining
      ), reserved AS (
        INSERT INTO estimate_credit_reservations
          (id, credit_path, session_user_id, estimate_credit_id, status)
        SELECT ${estimateReservationId}::uuid, 'user_estimate', ${sessionUserId}, spent.id, 'reserved'
          FROM spent
        RETURNING id
      )
      SELECT spent.credits_remaining AS remaining, reserved.id AS reservation_id
        FROM spent CROSS JOIN reserved
    `);
    if (owned.rows.length === 1) {
      return {
        ok: true,
        path: "user_estimate",
        remaining: Number((owned.rows[0] as any).remaining),
        reservationId: String((owned.rows[0] as any).reservation_id),
      };
    }

    const liveUser = await exec.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE id = ${sessionUserId} AND deleted_at IS NULL
      ) AS present
    `);
    if ((liveUser.rows[0] as any)?.present !== true) {
      return { ok: false, status: 401, error: "User account not found." };
    }

    await bestEffortAudit(exec, sessionUserId, { path: "user_no_owned_credits" });
    return {
      ok: false,
      status: 402,
      error: "No AI credits remaining. Buy a pack or join Vault Club Silver when it reopens.",
    };
  }

  // ── ANONYMOUS — server-side free tier: 1 estimate per IP per UTC day ─────────
  if (input.ipHash && input.today) {
    const reservationId = crypto.randomUUID();
    const upsert = await exec.execute(sql`
      WITH admitted AS (
        INSERT INTO estimate_free_uses (ip_hash, last_used_at, count_today)
        VALUES (${input.ipHash}, NOW(), 1)
        ON CONFLICT (ip_hash) DO UPDATE SET
          count_today = 1,
          last_used_at = NOW()
        WHERE estimate_free_uses.last_used_at::date <> ${input.today}::date
           OR estimate_free_uses.count_today < 1
        RETURNING count_today
      ), reserved AS (
        INSERT INTO estimate_credit_reservations
          (id, credit_path, ip_hash, free_use_day, status)
        SELECT ${reservationId}::uuid, 'anon_free', ${input.ipHash}, ${input.today}::date, 'reserved'
          FROM admitted
        RETURNING id
      )
      SELECT admitted.count_today, reserved.id AS reservation_id
        FROM admitted CROSS JOIN reserved
    `);
    if (upsert.rows.length === 0) {
      await bestEffortAudit(exec, input.ipHash, { path: "anon_ip_day_limit" });
      return {
        ok: false,
        status: 402,
        error: "Free estimate used for today. Sign in to use purchased credits.",
        extra: { freeLimit: 1, windowResetAt: "midnight UTC" },
      };
    }
    return {
      ok: true,
      path: "anon_free",
      remaining: null,
      reservationId: String((upsert.rows[0] as any).reservation_id),
    };
  }

  // No session and no IP context to gate a free use — reject.
  return { ok: false, status: 402, error: "No credits remaining. Purchase more estimates to continue." };
}

export type EstimateReservationOutcome = "commit" | "refund";

/**
 * The estimate route bounds its Anthropic request at 30 seconds. Ten minutes also
 * leaves ample room for the bounded image resize, database latency and event-loop
 * scheduling before a live request can ever be mistaken for a crashed process.
 */
export const ESTIMATE_CREDIT_STALE_RESERVATION_MS = 10 * 60 * 1000;
export const ESTIMATE_CREDIT_RECOVERY_BATCH_SIZE = 100;

export interface EstimateCreditRecoveryResult {
  examined: number;
  refunded: number;
  unrecoverable: number;
}

/**
 * Settle a reservation idempotently. Refund claims the still-reserved row first,
 * then restores exactly its recorded pool in the same statement. Repeating a
 * refund sees `refunded` and cannot increment a balance twice.
 */
export async function settleEstimateCreditReservation(
  reservationId: string,
  outcome: EstimateReservationOutcome,
  deps: ConsumeEstimateCreditDeps = {}
): Promise<boolean> {
  const exec = deps.exec ?? db;
  if (outcome === "commit") {
    const result = await exec.execute(sql`
      WITH settled AS (
        UPDATE estimate_credit_reservations
           SET status = 'committed', settled_at = NOW()
         WHERE id = ${reservationId}::uuid AND status = 'reserved'
        RETURNING status
      )
      SELECT status FROM settled
      UNION ALL
      SELECT status FROM estimate_credit_reservations
       WHERE id = ${reservationId}::uuid AND NOT EXISTS (SELECT 1 FROM settled)
      LIMIT 1
    `);
    return (result.rows[0] as any)?.status === "committed";
  }

  const result = await exec.execute(sql`
    WITH claimed AS (
      UPDATE estimate_credit_reservations
         SET status = 'refunded', settled_at = NOW()
       WHERE id = ${reservationId}::uuid AND status = 'reserved'
         AND (
           credit_path = 'anon_free'
           OR (
             credit_path = 'user_balance'
             AND EXISTS (
               SELECT 1 FROM users u WHERE u.id = estimate_credit_reservations.session_user_id
             )
           )
           OR (
             credit_path = 'user_estimate'
             AND EXISTS (
               SELECT 1 FROM estimate_credits ec
                WHERE ec.id = estimate_credit_reservations.estimate_credit_id
             )
           )
         )
      RETURNING credit_path, session_user_id, estimate_credit_id, ip_hash, free_use_day
    ), refund_user AS (
      UPDATE users u
         SET ai_credits_user_balance = ai_credits_user_balance + 1,
             updated_at = NOW()
        FROM claimed c
       WHERE c.credit_path = 'user_balance' AND u.id = c.session_user_id
      RETURNING u.id
    ), refund_estimate AS (
      UPDATE estimate_credits ec
         SET credits_remaining = credits_remaining + 1,
             credits_used = GREATEST(0, credits_used - 1),
             updated_at = NOW()
        FROM claimed c
       WHERE c.credit_path = 'user_estimate' AND ec.id = c.estimate_credit_id
      RETURNING ec.id
    ), refund_anon AS (
      UPDATE estimate_free_uses f
         SET count_today = GREATEST(0, count_today - 1),
             last_used_at = NOW()
        FROM claimed c
       WHERE c.credit_path = 'anon_free'
         AND f.ip_hash = c.ip_hash
         AND f.last_used_at::date = c.free_use_day
         AND f.count_today > 0
      RETURNING f.ip_hash
    )
    SELECT status
      FROM estimate_credit_reservations
     WHERE id = ${reservationId}::uuid
  `);
  return (result.rows[0] as any)?.status === "refunded";
}

/**
 * Refund reservations abandoned by a process crash.
 *
 * Selection, claim, and every balance restoration happen in one PostgreSQL
 * statement. `FOR UPDATE SKIP LOCKED` lets overlapping machines divide a batch
 * safely, while the status compare-and-set prevents a foreground commit or a
 * second sweep from restoring the same credit twice. Refunds are aggregated by
 * source row, so several abandoned reservations for one customer restore the
 * exact count rather than one arbitrary row from `UPDATE ... FROM`.
 */
export async function refundStaleEstimateCreditReservations(
  options: {
    now?: Date;
    staleAfterMs?: number;
    batchSize?: number;
  } = {},
  deps: ConsumeEstimateCreditDeps = {}
): Promise<EstimateCreditRecoveryResult> {
  const exec = deps.exec ?? db;
  const staleAfterMs = options.staleAfterMs ?? ESTIMATE_CREDIT_STALE_RESERVATION_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 30_000) {
    throw new Error("estimate credit recovery threshold must exceed the provider timeout");
  }
  const requestedBatchSize = options.batchSize ?? ESTIMATE_CREDIT_RECOVERY_BATCH_SIZE;
  if (!Number.isSafeInteger(requestedBatchSize) || requestedBatchSize < 1) {
    throw new Error("estimate credit recovery batch size must be a positive integer");
  }
  const batchSize = Math.min(requestedBatchSize, 250);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("estimate credit recovery requires a valid clock");
  const cutoff = new Date(now.getTime() - staleAfterMs);

  const result = await exec.execute(sql`
    WITH stale AS MATERIALIZED (
      SELECT r.id, r.credit_path, r.session_user_id, r.estimate_credit_id,
             r.ip_hash, r.free_use_day
        FROM estimate_credit_reservations r
       WHERE r.status = 'reserved'
         AND r.created_at < ${cutoff}
       ORDER BY r.created_at, r.id
       FOR UPDATE SKIP LOCKED
       LIMIT ${batchSize}
    ), eligible AS MATERIALIZED (
      SELECT s.*
        FROM stale s
       WHERE s.credit_path = 'anon_free'
          OR (
            s.credit_path = 'user_balance'
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = s.session_user_id)
          )
          OR (
            s.credit_path = 'user_estimate'
            AND EXISTS (SELECT 1 FROM estimate_credits ec WHERE ec.id = s.estimate_credit_id)
          )
    ), claimed AS (
      UPDATE estimate_credit_reservations r
         SET status = 'refunded', settled_at = ${now}
        FROM eligible e
       WHERE r.id = e.id AND r.status = 'reserved'
      RETURNING e.credit_path, e.session_user_id, e.estimate_credit_id,
                e.ip_hash, e.free_use_day
    ), user_refund_amounts AS (
      SELECT session_user_id, COUNT(*)::integer AS amount
        FROM claimed
       WHERE credit_path = 'user_balance'
       GROUP BY session_user_id
    ), refund_users AS (
      UPDATE users u
         SET ai_credits_user_balance = u.ai_credits_user_balance + amounts.amount,
             updated_at = ${now}
        FROM user_refund_amounts amounts
       WHERE u.id = amounts.session_user_id
      RETURNING u.id
    ), estimate_refund_amounts AS (
      SELECT estimate_credit_id, COUNT(*)::integer AS amount
        FROM claimed
       WHERE credit_path = 'user_estimate'
       GROUP BY estimate_credit_id
    ), refund_estimates AS (
      UPDATE estimate_credits ec
         SET credits_remaining = ec.credits_remaining + amounts.amount,
             credits_used = GREATEST(0, ec.credits_used - amounts.amount),
             updated_at = ${now}
        FROM estimate_refund_amounts amounts
       WHERE ec.id = amounts.estimate_credit_id
      RETURNING ec.id
    ), anonymous_refund_amounts AS (
      SELECT ip_hash, free_use_day, COUNT(*)::integer AS amount
        FROM claimed
       WHERE credit_path = 'anon_free'
       GROUP BY ip_hash, free_use_day
    ), refund_anonymous AS (
      UPDATE estimate_free_uses f
         SET count_today = GREATEST(0, f.count_today - amounts.amount),
             last_used_at = ${now}
        FROM anonymous_refund_amounts amounts
       WHERE f.ip_hash = amounts.ip_hash
         AND f.last_used_at::date = amounts.free_use_day
         AND f.count_today > 0
      RETURNING f.ip_hash
    )
    SELECT
      (SELECT COUNT(*)::integer FROM stale) AS examined,
      (SELECT COUNT(*)::integer FROM claimed) AS refunded,
      ((SELECT COUNT(*) FROM stale) - (SELECT COUNT(*) FROM claimed))::integer AS unrecoverable
  `);
  const row = result.rows[0] as
    { examined?: number | string; refunded?: number | string; unrecoverable?: number | string } | undefined;
  return {
    examined: Number(row?.examined ?? 0),
    refunded: Number(row?.refunded ?? 0),
    unrecoverable: Number(row?.unrecoverable ?? 0),
  };
}

/** Trust Express's configured proxy hop and collapse IPv6 rotation to the canonical /56 bucket. */
export function estimateAnonymousIpHash(request: { ip?: string; socket?: { remoteAddress?: string | null } }): string {
  const trustedAddress = request.ip || request.socket?.remoteAddress || "unknown";
  const bucket = normalizePartnerRateLimitIp(trustedAddress);
  return crypto.createHash("sha256").update(bucket).digest("hex");
}

/**
 * Build the Stripe checkout metadata for an estimate-credit purchase. Ownership is
 * server-derived from the trusted session ONLY — there is deliberately no parameter
 * for a browser-supplied user id, so a client can never stamp or override it.
 * PKG-2 fulfilment reads mandatory `metadata.user_id` and binds the credits to
 * that account.
 */
export function buildEstimateCheckoutMetadata(input: {
  sessionUserId: string;
  email: string;
  credits: number;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    type: "estimate_credits",
    email: input.email,
    credits: String(input.credits),
  };
  metadata.user_id = input.sessionUserId;
  return metadata;
}

export interface EstimateBalanceInput {
  sessionUserId?: string | null;
}

export type EstimateBalanceResult =
  { ok: true; credits: number; email: string | null; scope: "user" } | { ok: false; status: 401; error: string };

/**
 * Owner-bound balance lookup. Authentication is mandatory and the database is
 * the authority for both the account email and whether it was verified.
 */
export async function getEstimateCreditBalance(
  input: EstimateBalanceInput,
  deps: ConsumeEstimateCreditDeps = {}
): Promise<EstimateBalanceResult> {
  const exec = deps.exec ?? db;
  const sessionUserId = input.sessionUserId || null;

  if (!sessionUserId) return { ok: false, status: 401, error: "Sign in to view purchased credits." };
  const rows = await exec.execute(sql`
    SELECT
      lower(u.email) AS email,
      u.ai_credits_user_balance
        + COALESCE((
            SELECT SUM(ec.credits_remaining)
              FROM estimate_credits ec
             WHERE ec.user_id = u.id
                OR (ec.user_id IS NULL AND u.email_verified IS TRUE AND ec.email = lower(u.email))
          ), 0) AS credits
      FROM users u
     WHERE u.id = ${sessionUserId}
       AND u.deleted_at IS NULL
  `);
  const account = rows.rows[0] as { email?: string; credits?: number | string } | undefined;
  if (!account) return { ok: false, status: 401, error: "User account not found." };
  return { ok: true, credits: Number(account.credits ?? 0), email: account.email ?? null, scope: "user" };
}
