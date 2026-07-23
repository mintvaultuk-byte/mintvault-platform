/**
 * PKG-3 — estimate-credit consumption: owner binding + atomic decrement.
 *
 * The public AI Pre-Grade tool (POST /api/tools/estimate) spends one estimate
 * credit per paid inference. This module is the single authority that decides
 * whether a request may spend a credit, and performs the spend ATOMICALLY, so
 * the route calls the paid Anthropic provider ONLY after the database has proven
 * exactly one credit was consumed.
 *
 * Security invariants enforced here:
 *  A. Authenticated requests draw ONLY from the authenticated user's own credits
 *     (users.ai_credits_user_balance, then estimate_credits owned by the session
 *     user id or the session's own verified email). A caller-supplied
 *     req.body.email NEVER grants an authenticated caller spending authority.
 *  B. The genuine pre-account anonymous flow is preserved: a logged-OUT caller
 *     with a normalized email may still spend that email's credits.
 *  D. Every spend is a single conditional UPDATE whose row count is the final
 *     authority. Zero rows affected → no provider call.
 *  E. Concurrency safety comes from the database (guarded UPDATE / row lock),
 *     not an in-process lock: two requests racing one credit yield exactly one
 *     decrement and never a negative balance.
 *
 * The executor / deduct dependencies are injectable purely so tests can drive a
 * disposable local PostgreSQL cluster (no SSL). Production callers pass nothing
 * and use the real db + deductAiCredits — no runtime behaviour changes.
 */
import { sql } from "drizzle-orm";
import { db } from "./db";
import { auditLog } from "@shared/schema";
import { deductAiCredits as realDeductAiCredits, type AiCreditExec } from "./storage";

/** Executor surface this module needs (satisfied by the real db and by a test drizzle instance). */
export type EstimateExec = AiCreditExec;

/** deductAiCredits signature (injectable for tests). */
export type DeductFn = typeof realDeductAiCredits;

export interface ConsumeEstimateCreditInput {
  /** Authenticated user id from the trusted session (req.session.userId), if any. */
  sessionUserId?: string | null;
  /** Verified account email from the trusted session (req.session.userEmail), if any. */
  sessionUserEmail?: string | null;
  /** Caller-supplied email from the request body (UNTRUSTED for authenticated callers). */
  bodyEmail?: string | null;
  /** Admin free-usage bypass (keyed on the pre-existing ADMIN_FREE_EMAIL). */
  isAdminFree?: boolean;
  /** SHA-256 IP hash for the anonymous free-tier (no session, no email). */
  ipHash?: string | null;
  /** UTC day (YYYY-MM-DD) for the anonymous free-tier window. */
  today?: string | null;
}

export interface ConsumeEstimateCreditDeps {
  exec?: EstimateExec;
  deduct?: DeductFn;
}

export type ConsumeEstimateCreditResult =
  | {
      ok: true;
      /** Which pool the credit was consumed from. */
      path: "admin" | "user_balance" | "user_estimate" | "anon_email" | "anon_free";
      /** Remaining balance to echo back to the client, or null when not tracked. */
      remaining: number | null;
    }
  | {
      ok: false;
      status: 401 | 402;
      error: string;
      /** Extra response fields (preserves the anon free-tier payload shape). */
      extra?: Record<string, unknown>;
    };

function norm(email: string | null | undefined): string {
  return (email || "").trim().toLowerCase();
}

async function bestEffortAudit(
  exec: EstimateExec,
  entityId: string,
  details: Record<string, unknown>
): Promise<void> {
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
  const deduct = deps.deduct ?? realDeductAiCredits;

  const sessionUserId = input.sessionUserId || null;
  const sessionUserEmail = norm(input.sessionUserEmail) || null;
  const bodyEmail = norm(input.bodyEmail);

  // Admin free usage — pre-existing bypass, unchanged. No credit is spent.
  if (input.isAdminFree) {
    return { ok: true, path: "admin", remaining: null };
  }

  // ── AUTHENTICATED ─────────────────────────────────────────────────────────
  // Authority comes solely from the session. req.body.email is IGNORED here.
  if (sessionUserId) {
    // 1) Owner-bound personal AI-credit balance (atomic conditional UPDATE).
    const d = await deduct(sessionUserId, 1, "ai_grading_estimate", exec);
    if (d.ok) {
      return { ok: true, path: "user_balance", remaining: d.remaining };
    }
    if (d.reason === "no_user") {
      return { ok: false, status: 401, error: "User account not found." };
    }

    // 2) Fall back ONLY to estimate credits the authenticated user owns — matched
    //    by the session user id or the session's own VERIFIED email (never the
    //    request body). A single-row locked decrement guarantees exactly one
    //    credit is spent even if the user owns several matching rows, and is
    //    concurrency-safe (FOR UPDATE SKIP LOCKED).
    const owned = await exec.execute(sql`
      UPDATE estimate_credits
         SET credits_remaining = credits_remaining - 1,
             credits_used = credits_used + 1,
             updated_at = NOW()
       WHERE id = (
         SELECT id FROM estimate_credits
          WHERE credits_remaining > 0
            AND ( user_id = ${sessionUserId}
                  OR ( ${sessionUserEmail}::text IS NOT NULL AND email = ${sessionUserEmail} ) )
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING credits_remaining
    `);
    if (owned.rows.length === 1) {
      return { ok: true, path: "user_estimate", remaining: Number((owned.rows[0] as any).credits_remaining) };
    }

    await bestEffortAudit(exec, sessionUserId, { path: "user_no_owned_credits" });
    return {
      ok: false,
      status: 402,
      error: "No AI credits remaining. Buy a pack or join Vault Club Silver when it reopens.",
    };
  }

  // ── ANONYMOUS + EMAIL (legacy pre-account flow, preserved) ──────────────────
  if (bodyEmail) {
    // Single guarded UPDATE against the UNIQUE(email) row. The row lock + the
    // `credits_remaining > 0` guard make this the atomic authority: a losing
    // concurrent request affects zero rows and is rejected.
    const decremented = await exec.execute(sql`
      UPDATE estimate_credits
         SET credits_remaining = credits_remaining - 1,
             credits_used = credits_used + 1,
             updated_at = NOW()
       WHERE email = ${bodyEmail} AND credits_remaining > 0
      RETURNING credits_remaining
    `);
    if (decremented.rows.length === 1) {
      return { ok: true, path: "anon_email", remaining: Number((decremented.rows[0] as any).credits_remaining) };
    }
    await bestEffortAudit(exec, bodyEmail, { path: "anon_email_empty" });
    return { ok: false, status: 402, error: "No credits remaining. Purchase more estimates to continue." };
  }

  // ── ANONYMOUS + NO EMAIL — server-side free tier: 1 estimate per IP per UTC day
  if (input.ipHash && input.today) {
    const upsert = await exec.execute(sql`
      INSERT INTO estimate_free_uses (ip_hash, last_used_at, count_today)
      VALUES (${input.ipHash}, NOW(), 1)
      ON CONFLICT (ip_hash) DO UPDATE SET
        count_today = CASE
          WHEN to_char(estimate_free_uses.last_used_at, 'YYYY-MM-DD') = ${input.today}
          THEN estimate_free_uses.count_today + 1
          ELSE 1
        END,
        last_used_at = NOW()
      RETURNING count_today
    `);
    const countToday = Number((upsert.rows[0] as any).count_today);
    if (countToday > 1) {
      await bestEffortAudit(exec, input.ipHash, { path: "anon_ip_day_limit", countToday });
      return {
        ok: false,
        status: 402,
        error: "Free estimate used for today. Add an email to buy a credit pack from £2 for 5 estimates.",
        extra: { freeLimit: 1, windowResetAt: "midnight UTC" },
      };
    }
    return { ok: true, path: "anon_free", remaining: null };
  }

  // No session, no email, and no IP context to gate a free use — reject.
  return { ok: false, status: 402, error: "No credits remaining. Purchase more estimates to continue." };
}

/**
 * Build the Stripe checkout metadata for an estimate-credit purchase. Ownership is
 * server-derived from the trusted session ONLY — there is deliberately no parameter
 * for a browser-supplied user id, so a client can never stamp or override it. When a
 * session user id is present, PKG-2 fulfilment (fulfilEstimateCreditsPurchase) reads
 * `metadata.user_id` and binds the credits to that account.
 */
export function buildEstimateCheckoutMetadata(input: {
  sessionUserId?: string | null;
  email: string;
  credits: number;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    type: "estimate_credits",
    email: input.email,
    credits: String(input.credits),
  };
  if (input.sessionUserId) metadata.user_id = input.sessionUserId;
  return metadata;
}

export interface EstimateBalanceInput {
  sessionUserId?: string | null;
  sessionUserEmail?: string | null;
  /** UNTRUSTED caller-supplied email (used ONLY for the anonymous legacy lookup). */
  queryEmail?: string | null;
}

export type EstimateBalanceResult =
  | { ok: true; credits: number; email: string | null; scope: "user" | "anon" }
  | { ok: false; status: 400; error: string };

/**
 * Owner-bound balance lookup. Authenticated callers get their OWN balance derived
 * from the session identity; a conflicting ?email= is ignored. Anonymous callers
 * retain the minimal legacy per-email lookup.
 */
export async function getEstimateCreditBalance(
  input: EstimateBalanceInput,
  deps: ConsumeEstimateCreditDeps = {}
): Promise<EstimateBalanceResult> {
  const exec = deps.exec ?? db;
  const sessionUserId = input.sessionUserId || null;
  const sessionUserEmail = norm(input.sessionUserEmail) || null;

  if (sessionUserId) {
    // Authenticated: personal AI-credit balance + estimate credits this user owns.
    // req.query.email is NEVER consulted — no cross-account enumeration.
    const rows = await exec.execute(sql`
      SELECT
        COALESCE((SELECT ai_credits_user_balance FROM users WHERE id = ${sessionUserId}), 0)
        + COALESCE((
            SELECT SUM(credits_remaining) FROM estimate_credits
             WHERE user_id = ${sessionUserId}
                OR ( ${sessionUserEmail}::text IS NOT NULL AND email = ${sessionUserEmail} )
          ), 0) AS credits
    `);
    const credits = Number((rows.rows[0] as any)?.credits ?? 0);
    return { ok: true, credits, email: sessionUserEmail, scope: "user" };
  }

  const email = norm(input.queryEmail);
  if (!email) return { ok: false, status: 400, error: "Email required" };
  const rows = await exec.execute(sql`
    SELECT credits_remaining FROM estimate_credits WHERE email = ${email}
  `);
  const credits = rows.rows.length ? Number((rows.rows[0] as any).credits_remaining) : 0;
  return { ok: true, credits, email, scope: "anon" };
}
