import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { generatePdfToken, verifyPdfToken } from "../lib/pdf-token";
import { paidSubmissionConfirmation } from "../lib/paid-submission-confirmation";
import { serviceTierToPricingTier, auditLog } from "@shared/schema";
import { storage } from "../storage";
import { getUncachableStripeClient } from "../stripeClient";
import { sendSubmissionConfirmation, sendSubmissionConfirmationV2 } from "../email";
import { computeGradingQuote } from "../services/gradingQuote";
import { redeemPromoCode, reservePromoCodeUse } from "../services/promoCodeService";
import { recordSubmissionAttribution } from "../commercial-attribution";
import { recordGrowthConversionEvent } from "../growth-conversion-service";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * Minimal DB executor surface used by the credit primitives. Defaults to the
 * shared `db` in production; a test can inject a cluster-backed executor so the
 * exact SQL semantics are verified against a real PostgreSQL without touching
 * the production SSL connection config. Injection is READ-ONLY plumbing — it
 * changes no runtime behaviour (every production caller passes nothing).
 */
type SqlExecutor = Pick<typeof db, "execute">;

/**
 * Atomically RESERVE one available credit for the exact submission whose
 * checkout is about to create a discounted PaymentIntent. Returns the reserved
 * credit id, or null if none is available (already used / expired / bound to
 * another checkout).
 * Two simultaneous callers can't reserve the same row (FOR UPDATE SKIP LOCKED +
 * the availability re-check at commit), so only one gets the discount. A
 * reservation is deliberately NOT reusable on a timer: Stripe PaymentIntents
 * remain payable beyond a local TTL, so timed reuse would let one credit back
 * multiple chargeable orders. Release requires an explicit future cancellation
 * authority which proves the original PaymentIntent can no longer succeed.
 */
export async function reserveCredit(
  userId: string,
  creditType: string,
  trackingNumber: string,
  runner: SqlExecutor = db
): Promise<number | null> {
  const result = await runner.execute(sql`
    UPDATE member_credits
    SET reserved_at = NOW(), reserved_until = NULL, reserved_for_tracking_number = ${trackingNumber}
    WHERE id = (
      SELECT id FROM member_credits
      WHERE user_id = ${userId} AND credit_type = ${creditType}
        AND used_at IS NULL AND expires_at > NOW()
        AND reserved_at IS NULL AND reserved_for_tracking_number IS NULL
      ORDER BY expires_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
      AND used_at IS NULL
      AND reserved_at IS NULL AND reserved_for_tracking_number IS NULL
    RETURNING id
  `);
  return result.rows.length > 0 ? Number((result.rows[0] as any).id) : null;
}

/**
 * Consume the EXACT credit row reserved at PaymentIntent creation. Fails closed:
 * if that specific reservation is no longer available (already used / gone) this
 * returns false and NEVER claims a different credit. The reserved row's own
 * user_id is the server-derived owner of the credit; when the reserving user's
 * identity was also bound into the PI metadata (creditOwnerUserId) we additionally
 * pin `user_id = ownerUserId` as belt-and-braces, so a discounted order can only
 * ever burn the reserving user's own reserved credit — never one derived from the
 * customer-supplied submission email. Single atomic UPDATE.
 */
async function consumeReservedCredit(
  reservedCreditId: number,
  submissionId: number,
  trackingNumber: string,
  ownerUserId: string | null,
  runner: SqlExecutor = db
): Promise<boolean> {
  const r = await runner.execute(sql`
    UPDATE member_credits
    SET used_at = NOW(), used_for_submission_id = ${submissionId}
    WHERE id = ${reservedCreditId}
      AND used_at IS NULL
      AND reserved_for_tracking_number = ${trackingNumber}
      ${ownerUserId ? sql`AND user_id = ${ownerUserId}` : sql``}
    RETURNING id
  `);
  return r.rows.length > 0;
}

/** Claim any one available credit of the given type for a KNOWN server-side user.
 *  Used only for the legacy fallback (PaymentIntents created before reserve-at-
 *  checkout shipped, which carry neither a reservedCreditId nor a bound owner).
 *  FOR UPDATE SKIP LOCKED makes two simultaneous callers lock + claim DIFFERENT
 *  unused credits (rather than both picking the same row), and the outer
 *  `AND used_at IS NULL` is a belt-and-braces guard so a re-selected row can never
 *  be consumed twice. Single statement, so it's atomic. */
async function consumeCredit(
  userId: string,
  creditType: string,
  submissionId: number,
  runner: SqlExecutor = db
): Promise<boolean> {
  const result = await runner.execute(sql`
    UPDATE member_credits
    SET used_at = NOW(), used_for_submission_id = ${submissionId}
    WHERE id = (
      SELECT id FROM member_credits
      WHERE user_id = ${userId} AND credit_type = ${creditType}
        AND used_at IS NULL AND expires_at > NOW()
        AND reserved_at IS NULL AND reserved_for_tracking_number IS NULL
      ORDER BY expires_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    ) AND used_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

type CapacityEntry = { active: number; max: number; full: boolean; forceOpen: boolean; ts: number };
const _capacityCache: Record<string, CapacityEntry> = {};
const CAPACITY_CACHE_MS = 30_000;
const ACTIVE_STATUSES = ["received", "in_grading", "ready_to_return", "ready_to_ship"];

async function getTierCapacity(tierSlug: string): Promise<CapacityEntry> {
  const now = Date.now();
  const cached = _capacityCache[tierSlug];
  if (cached && now - cached.ts < CAPACITY_CACHE_MS) return cached;

  const capRows = await db.execute(sql`
    SELECT max_active, force_open FROM tier_capacity WHERE tier_slug = ${tierSlug} LIMIT 1
  `);
  if (capRows.rows.length === 0) {
    const entry: CapacityEntry = { active: 0, max: 99999, full: false, forceOpen: false, ts: now };
    _capacityCache[tierSlug] = entry;
    return entry;
  }
  const cap = capRows.rows[0] as any;
  const maxActive: number = cap.max_active ?? 99999;
  const forceOpen: boolean = cap.force_open ?? false;

  const statusList = `{${ACTIVE_STATUSES.join(",")}}`;
  const countRows = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM submissions
    WHERE service_tier = ${tierSlug}
      AND status = ANY(${statusList}::text[])
  `);
  const active = parseInt((countRows.rows[0] as any)?.cnt ?? "0", 10);
  const full = !forceOpen && active >= maxActive;

  const entry: CapacityEntry = { active, max: maxActive, full, forceOpen, ts: now };
  _capacityCache[tierSlug] = entry;
  return entry;
}

/**
 * Legacy/injected idempotent fulfilment implementation. Production Stripe and
 * browser-confirm paths now enter through the durable wrapper below; this body
 * remains for non-payment maintenance callers and focused credit primitives.
 *
 * The atomic markSubmissionAsPaid() gate is the single source of truth for
 * "who fulfils": only the FIRST caller to flip the submission to paid runs the
 * once-only side-effects (consume Vault Club credit, redeem promo code, link
 * user, send confirmation email). Every other caller — a Stripe retry, the
 * webhook racing confirm-payment, or a double-clicked confirm — short-circuits
 * to a logged no-op. This closes the double-consume hole (credit/promo counted
 * twice) AND the inverse gap (a webhook-only completion that previously never
 * consumed the credit or redeemed the code).
 *
 * NEVER throws on a side-effect failure: the charge already succeeded, so a
 * failed email or credit lookup must not bubble up and 500 the caller. Every
 * branch logs with the human submissionId for traceability.
 */
async function fulfilPaidSubmissionLegacy(
  submission: any,
  piMeta: Record<string, string | undefined>,
  piAmount: number,
  deps: { storage?: typeof storage; exec?: SqlExecutor } = {},
  payment?: { currency: string; paidAt: Date }
): Promise<{ fulfilled: boolean }> {
  // Dependency injection is backward-compatible test plumbing: production callers
  // (/api/confirm-payment and the Stripe webhook) pass nothing and get the real
  // storage + DB. It changes NO runtime behaviour.
  const store = deps.storage ?? storage;
  const exec = deps.exec ?? db;
  const sid: string = submission.submissionId;
  const numId = Number(submission.id);

  // ATOMIC GATE — only the first transition to paid wins.
  const won = await store.markSubmissionAsPaid(
    numId,
    payment
      ? {
          amountPence: piAmount,
          currency: payment.currency,
          paidAt: payment.paidAt,
        }
      : undefined
  );
  if (!won) {
    console.log(`[fulfil] submission ${sid} already paid, skipping (idempotent no-op)`);
    return { fulfilled: false };
  }
  console.log(`[fulfil] submission ${sid} — first paid transition, fulfilling`);

  // Awaited (was fire-and-forget) so a failed UPDATE surfaces in this
  // request's logs before fulfilment reports success. Still non-fatal:
  // a missing estimate date must not fail a paid fulfilment.
  await store
    .setEstimatedCompletionDate(numId)
    .catch((e: any) => console.error(`[fulfil] submission ${sid} setEstimatedCompletionDate error:`, e?.message || e));

  // Consume a Vault Club credit if one was applied at checkout.
  //
  // SECURITY (PKG-1) — the credit owner is DERIVED FROM SERVER STATE, never from
  // submission.email (which the customer supplies and can point at another
  // account). At checkout we reserve the credit against the authenticated session
  // user and bind BOTH the reserved row id (reservedCreditId) and that user's
  // immutable id (creditOwnerUserId) into the trusted PaymentIntent metadata.
  // Fulfilment consumes ONLY that exact reserved row, pinned to that owner. If the
  // exact reservation cannot be consumed we FAIL CLOSED: we never claim a
  // different credit, and we record reconciliation evidence — a discounted order
  // is never silently completed with someone else's credit or with no credit.
  if (piMeta.creditApplied === "true" && piMeta.creditType) {
    try {
      const reservedIdNum = piMeta.reservedCreditId ? Number(piMeta.reservedCreditId) : NaN;
      const reservedCreditId = Number.isInteger(reservedIdNum) && reservedIdNum > 0 ? reservedIdNum : null;
      const ownerUserId = (piMeta.creditOwnerUserId ?? "").trim() || null;

      let consumed = false;
      let failReason = "unknown";

      if (reservedCreditId) {
        // Primary path (all PIs since reserve-at-checkout shipped). Consume the
        // exact reserved row, pinned to the bound owner when present. Fail closed.
        consumed = await consumeReservedCredit(reservedCreditId, numId, sid, ownerUserId, exec);
        failReason = "reserved_credit_unavailable";
      } else if (ownerUserId) {
        // Owner bound but no reserved id (defensive; not produced by current
        // checkout). Claim one of the OWNER's own credits — still never email.
        consumed = await consumeCredit(ownerUserId, piMeta.creditType, numId, exec);
        failReason = "no_credit_available";
      } else if (submission.email) {
        // Truly-legacy PI (pre-reservation, pre-owner-binding). No server-bound
        // identity exists on the payment, so fall back to the historical
        // email-derived lookup. New PIs never reach this branch.
        const creditUser = await store.getUserByEmail(submission.email);
        if (creditUser) {
          consumed = await consumeCredit(creditUser.id, piMeta.creditType, numId, exec);
          failReason = "no_credit_available";
        } else {
          failReason = "no_user_for_email";
        }
      } else {
        failReason = "no_owner_identity";
      }

      if (consumed) {
        console.log(`[fulfil] submission ${sid} consumed 1 ${piMeta.creditType} credit`);
      } else {
        // Charge already succeeded — never fail/refund here. Record an audit row
        // so finance can reconcile; mirrors the over_cap audit redeemPromoCode
        // writes for promos.
        console.error(`[fulfil] submission ${sid} credit NOT consumed (${failReason}) — reconcile`);
        await store
          .writeAuditLog("submission", String(numId), "CREDIT_CONSUME_FAILED", null, {
            reason: failReason,
            creditType: piMeta.creditType,
            creditAmountPence: piMeta.creditAmountPence ?? null,
            reservedCreditId: reservedCreditId ?? null,
            userId: ownerUserId,
          })
          .catch((e: any) => console.error(`[fulfil] submission ${sid} credit-fail audit error:`, e?.message || e));
      }
    } catch (e: any) {
      console.error(`[fulfil] submission ${sid} credit consume error:`, e?.message || e);
    }
  }

  // Promo code usage. New PIs already counted the use atomically at checkout
  // (reservePromoCodeUse) — flagged promoReservedAtCheckout — so we must NOT
  // increment again here; just audit the successful redemption. Legacy PIs
  // (created before the reserve-at-checkout change) still redeem here as before.
  if (piMeta.promoCodeId) {
    const codeId = Number(piMeta.promoCodeId);
    if (Number.isInteger(codeId) && codeId > 0) {
      try {
        if (piMeta.promoReservedAtCheckout === "true") {
          await store
            .writeAuditLog("promo_code", String(codeId), "PROMO_CODE_REDEEMED", null, {
              code: piMeta.promoCode || null,
              percent: piMeta.promoCodePercent ? Number(piMeta.promoCodePercent) : null,
              submission_id: numId,
              reserved_at_checkout: true,
            })
            .catch(() => {});
          console.log(`[fulfil] submission ${sid} promo code id=${codeId} (reserved at checkout)`);
        } else {
          await redeemPromoCode(
            codeId,
            piMeta.promoCode || null,
            piMeta.promoCodePercent ? Number(piMeta.promoCodePercent) : null,
            numId
          );
          console.log(`[fulfil] submission ${sid} redeemed promo code id=${codeId}`);
        }
      } catch (e: any) {
        console.error(`[fulfil] submission ${sid} promo redeem error:`, e?.message || e);
      }
    }
  }

  // Link (or create) the customer user record.
  if (submission.email) {
    try {
      let user = await store.getUserByEmail(submission.email);
      if (!user) {
        user = await store.createUser({
          email: submission.email,
          firstName: submission.firstName || submission.first_name || undefined,
          lastName: submission.lastName || submission.last_name || undefined,
        });
      }
      await store.updateSubmission(submission.id, { userId: user.id });
    } catch (e: any) {
      console.error(`[fulfil] submission ${sid} user-link error:`, e?.message || e);
    }
  }

  // Confirmation email (V2 with legal terms when the flag is live, else legacy
  // with crossover fields). Fire-and-forget — logged, never blocks.
  try {
    const packingSlipToken = generatePdfToken(sid); // H-a hardened token (timing-safe, 256-bit, TTL, owner-bound)
    const { FEATURE_FLAGS: FF2 } = await import("../config/feature-flags");
    const { TERMS_VERSION: TV2 } = await import("../config/legal");
    const emailData = {
      email: submission.email || "",
      firstName: submission.firstName || submission.first_name || "Customer",
      submissionId: sid,
      cardCount: submission.cardCount || submission.card_count || 0,
      tier: submission.serviceTier || submission.service_tier || "standard",
      total: piAmount || 0,
      serviceType: submission.serviceType || submission.service_type || undefined,
      labelToken: packingSlipToken,
    };
    if (FF2.LEGAL_PAGES_LIVE) {
      sendSubmissionConfirmationV2({
        ...emailData,
        termsVersion: TV2,
        termsAcceptedAt: new Date().toISOString(),
      }).catch((e: any) => console.error(`[fulfil] submission ${sid} confirmation email (v2) error:`, e?.message || e));
    } else {
      sendSubmissionConfirmation({
        ...emailData,
        crossoverCompany: submission.crossover_company || submission.crossoverCompany || undefined,
        crossoverOriginalGrade: submission.crossover_original_grade || submission.crossoverOriginalGrade || undefined,
        crossoverCertNumber: submission.crossover_cert_number || submission.crossoverCertNumber || undefined,
      }).catch((e: any) => console.error(`[fulfil] submission ${sid} confirmation email error:`, e?.message || e));
    }
  } catch (e: any) {
    console.error(`[fulfil] submission ${sid} email dispatch error:`, e?.message || e);
  }

  console.log(`[fulfil] submission ${sid} fulfilled (paymentStatus=paid)`);
  return { fulfilled: true };
}

type PaymentExecutor = Pick<typeof db, "execute" | "transaction">;

interface PaidSubmissionPayment {
  currency: string;
  paidAt: Date;
  /** Present on both production authorities: Stripe webhook and browser confirm. */
  paymentIntentId?: string;
}

interface ConfirmationPayload {
  useV2: boolean;
  emailData: {
    email: string;
    firstName: string;
    submissionId: string;
    cardCount: number;
    tier: string;
    total: number;
    serviceType?: string;
    crossoverCompany?: string;
    crossoverOriginalGrade?: string;
    crossoverCertNumber?: string;
    labelToken: string;
    termsVersion?: string;
    termsAcceptedAt?: string;
  };
}

interface GradingPaymentFulfilmentRow {
  submission_id: number;
  tracking_number: string;
  payment_intent_id: string;
  payment_metadata: Record<string, string>;
  amount_pence: number;
  currency: string;
  paid_at: Date | string;
  confirmation_payload: ConfirmationPayload;
  provider_idempotency_key: string;
  status: "PENDING" | "PROCESSING" | "FAILED" | "COMPLETE" | "RECONCILIATION_REQUIRED";
  attempt_count: number;
  claim_token: string;
  estimate_completed_at: Date | string | null;
  credit_completed_at: Date | string | null;
  promo_completed_at: Date | string | null;
  user_link_completed_at: Date | string | null;
  email_completed_at: Date | string | null;
}

class PermanentPaymentFulfilmentError extends Error {}

const PAYMENT_FULFILMENT_MAX_ATTEMPTS = 8;

async function buildConfirmationPayload(submission: any, piAmount: number): Promise<ConfirmationPayload> {
  const { FEATURE_FLAGS: currentFlags } = await import("../config/feature-flags");
  const { TERMS_VERSION: currentTermsVersion } = await import("../config/legal");
  return {
    useV2: currentFlags.LEGAL_PAGES_LIVE,
    emailData: {
      email: submission.email || "",
      firstName: submission.firstName || submission.first_name || "Customer",
      submissionId: submission.submissionId,
      cardCount: submission.cardCount || submission.card_count || 0,
      tier: submission.serviceTier || submission.service_tier || "standard",
      total: piAmount || 0,
      serviceType: submission.serviceType || submission.service_type || undefined,
      crossoverCompany: submission.crossover_company || submission.crossoverCompany || undefined,
      crossoverOriginalGrade: submission.crossover_original_grade || submission.crossoverOriginalGrade || undefined,
      crossoverCertNumber: submission.crossover_cert_number || submission.crossoverCertNumber || undefined,
      // Snapshot the token once. Resend retries use the same idempotency key and
      // therefore must also use byte-equivalent message content.
      labelToken: generatePdfToken(submission.submissionId),
      termsVersion: currentFlags.LEGAL_PAGES_LIVE ? currentTermsVersion : undefined,
      termsAcceptedAt: currentFlags.LEGAL_PAGES_LIVE ? new Date().toISOString() : undefined,
    },
  };
}

async function ensureGradingPaymentFulfilment(
  submission: any,
  piMeta: Record<string, string | undefined>,
  piAmount: number,
  payment: PaidSubmissionPayment & { paymentIntentId: string },
  runner: PaymentExecutor
): Promise<void> {
  const submissionId = Number(submission.id);
  const currency = payment.currency.trim().toUpperCase().slice(0, 3);
  if (!Number.isInteger(submissionId) || submissionId <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Cannot enqueue grading-payment fulfilment: invalid submission or currency");
  }
  const confirmationPayload = await buildConfirmationPayload(submission, piAmount);
  const metadataJson = JSON.stringify(piMeta);
  const payloadJson = JSON.stringify(confirmationPayload);
  const providerIdempotencyKey = `grading-payment-confirmation:${submission.submissionId}`;
  const inserted = await runner.execute(sql`
    INSERT INTO grading_payment_fulfilments (
      submission_id, tracking_number, payment_intent_id, payment_metadata,
      amount_pence, currency, paid_at, confirmation_payload, provider_idempotency_key
    ) VALUES (
      ${submissionId}, ${submission.submissionId}, ${payment.paymentIntentId}, ${metadataJson}::jsonb,
      ${Math.max(0, Math.trunc(piAmount))}, ${currency}, ${payment.paidAt},
      ${payloadJson}::jsonb, ${providerIdempotencyKey}
    )
    ON CONFLICT DO NOTHING
    RETURNING submission_id
  `);
  if (inserted.rows.length === 1) return;
  const existing = await runner.execute(sql`
    SELECT 1 FROM grading_payment_fulfilments
     WHERE submission_id = ${submissionId}
       AND payment_intent_id = ${payment.paymentIntentId}
       AND amount_pence = ${Math.max(0, Math.trunc(piAmount))}
       AND currency = ${currency}
  `);
  if (existing.rows.length !== 1) {
    throw new Error("Grading-payment fulfilment already exists with different authoritative payment data");
  }
}

async function claimGradingPaymentFulfilment(
  submissionId: number,
  runner: PaymentExecutor
): Promise<GradingPaymentFulfilmentRow | null> {
  const claimToken = randomUUID();
  const claimed = await runner.execute(sql`
    UPDATE grading_payment_fulfilments f
       SET status = 'PROCESSING',
           attempt_count = attempt_count + 1,
           claim_token = ${claimToken},
           claim_expires_at = NOW() + INTERVAL '5 minutes',
           next_attempt_at = NOW() + INTERVAL '5 minutes',
           last_error = NULL,
           updated_at = NOW()
     WHERE f.submission_id = ${submissionId}
       AND f.attempt_count < ${PAYMENT_FULFILMENT_MAX_ATTEMPTS}
       AND EXISTS (
         SELECT 1 FROM submissions s
          WHERE s.id = f.submission_id AND s.payment_status = 'paid'
       )
       AND (
         (f.status IN ('PENDING', 'FAILED') AND f.next_attempt_at <= NOW())
         OR (f.status = 'PROCESSING' AND f.claim_expires_at <= NOW())
       )
    RETURNING *
  `);
  return (claimed.rows[0] as unknown as GradingPaymentFulfilmentRow | undefined) ?? null;
}

async function completeEstimateEffect(
  row: GradingPaymentFulfilmentRow,
  submission: any,
  runner: PaymentExecutor
): Promise<void> {
  if (row.estimate_completed_at) return;
  const tier = String(submission.serviceTier || submission.service_tier || "standard").toLowerCase();
  const purchasedDays = submission.turnaroundDays ?? submission.turnaround_days;
  if (purchasedDays != null && (!Number.isInteger(purchasedDays) || purchasedDays <= 0)) {
    throw new PermanentPaymentFulfilmentError("invalid purchased turnaround snapshot");
  }
  // New purchases retain the configured numeric promise even after tier edits.
  // Pre-snapshot orders keep their historical fallback; never consult live prices here.
  const workingDays =
    purchasedDays ?? ({ standard: 20, priority: 10, express: 5 } as Record<string, number>)[tier] ?? 20;
  const target = new Date(row.paid_at);
  let added = 0;
  while (added < workingDays) {
    target.setUTCDate(target.getUTCDate() + 1);
    const day = target.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  await runner.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT estimate_completed_at FROM grading_payment_fulfilments
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
         AND status = 'PROCESSING'
       FOR UPDATE
    `);
    if (locked.rows.length !== 1) throw new Error("grading payment estimate claim lost");
    if ((locked.rows[0] as { estimate_completed_at: Date | null }).estimate_completed_at) return;
    // Derive from authoritative paid_at, never retry-time NOW(), and keep any
    // earlier canonical promise. The submission write and effect marker commit
    // together, so a crash cannot move the date on replay.
    await tx.execute(sql`
      UPDATE submissions
         SET estimated_completion_date = COALESCE(estimated_completion_date, ${target.toISOString()}),
             updated_at = NOW()
       WHERE id = ${row.submission_id}
    `);
    await tx.execute(sql`
      UPDATE grading_payment_fulfilments
         SET estimate_completed_at = NOW(), updated_at = NOW()
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
    `);
  });
}

async function completeCreditEffect(
  row: GradingPaymentFulfilmentRow,
  submission: any,
  runner: PaymentExecutor
): Promise<void> {
  if (row.credit_completed_at) return;
  const meta = row.payment_metadata || {};
  const outcome = await runner.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT credit_completed_at FROM grading_payment_fulfilments
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
         AND status = 'PROCESSING'
       FOR UPDATE
    `);
    if (locked.rows.length !== 1) return { ok: false, reason: "claim_lost", permanent: false };
    if ((locked.rows[0] as { credit_completed_at: Date | null }).credit_completed_at) {
      return { ok: true, reason: "already_complete", permanent: false };
    }

    if (meta.creditApplied !== "true" || !meta.creditType) {
      await tx.execute(sql`
        UPDATE grading_payment_fulfilments SET credit_completed_at = NOW(), updated_at = NOW()
         WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
      `);
      return { ok: true, reason: "not_applied", permanent: false };
    }

    const reservedId = Number(meta.reservedCreditId);
    const reservedCreditId = Number.isInteger(reservedId) && reservedId > 0 ? reservedId : null;
    const ownerUserId = (meta.creditOwnerUserId || "").trim() || null;
    let consumed = false;
    let reason = "no_owner_identity";

    if (reservedCreditId) {
      const used = await tx.execute(sql`
        UPDATE member_credits
           SET used_at = NOW(), used_for_submission_id = ${row.submission_id}
         WHERE id = ${reservedCreditId}
           AND used_at IS NULL
           AND reserved_for_tracking_number = ${row.tracking_number}
           ${ownerUserId ? sql`AND user_id = ${ownerUserId}` : sql``}
        RETURNING id
      `);
      consumed = used.rows.length === 1;
      if (!consumed) {
        const replay = await tx.execute(sql`
          SELECT 1 FROM member_credits
           WHERE id = ${reservedCreditId} AND used_for_submission_id = ${row.submission_id}
        `);
        consumed = replay.rows.length === 1;
      }
      reason = "reserved_credit_unavailable";
    } else {
      let effectiveOwner = ownerUserId;
      if (!effectiveOwner && submission.email) {
        const user = await tx.execute(sql`
          SELECT id FROM users WHERE LOWER(email) = LOWER(${submission.email}) LIMIT 1
        `);
        effectiveOwner = (user.rows[0] as { id?: string } | undefined)?.id ?? null;
        reason = effectiveOwner ? "no_credit_available" : "no_user_for_email";
      }
      if (effectiveOwner) {
        const used = await tx.execute(sql`
          UPDATE member_credits
             SET used_at = NOW(), used_for_submission_id = ${row.submission_id}
           WHERE id = (
             SELECT id FROM member_credits
              WHERE user_id = ${effectiveOwner} AND credit_type = ${meta.creditType}
                AND used_at IS NULL AND expires_at > NOW()
                AND reserved_at IS NULL AND reserved_for_tracking_number IS NULL
              ORDER BY expires_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
           )
          RETURNING id
        `);
        consumed = used.rows.length === 1;
        if (!consumed) {
          const replay = await tx.execute(sql`
            SELECT 1 FROM member_credits
             WHERE user_id = ${effectiveOwner} AND credit_type = ${meta.creditType}
               AND used_for_submission_id = ${row.submission_id}
             LIMIT 1
          `);
          consumed = replay.rows.length === 1;
        }
        reason = "no_credit_available";
      }
    }

    if (!consumed) {
      const details = JSON.stringify({
        reason,
        creditType: meta.creditType,
        creditAmountPence: meta.creditAmountPence ?? null,
        reservedCreditId,
        userId: ownerUserId,
      });
      await tx.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('submission', ${String(row.submission_id)}, 'CREDIT_CONSUME_FAILED', NULL, ${details}::jsonb)
      `);
      return { ok: false, reason, permanent: true };
    }

    await tx.execute(sql`
      UPDATE grading_payment_fulfilments SET credit_completed_at = NOW(), updated_at = NOW()
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
    `);
    return { ok: true, reason: "consumed", permanent: false };
  });

  if (!outcome.ok) {
    if (outcome.permanent) throw new PermanentPaymentFulfilmentError(`credit:${outcome.reason}`);
    throw new Error(`grading payment credit effect failed: ${outcome.reason}`);
  }
}

async function completePromoEffect(row: GradingPaymentFulfilmentRow, runner: PaymentExecutor): Promise<void> {
  if (row.promo_completed_at) return;
  const meta = row.payment_metadata || {};
  await runner.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT promo_completed_at FROM grading_payment_fulfilments
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
         AND status = 'PROCESSING'
       FOR UPDATE
    `);
    if (locked.rows.length !== 1) throw new Error("grading payment promo claim lost");
    if ((locked.rows[0] as { promo_completed_at: Date | null }).promo_completed_at) return;

    const promoId = Number(meta.promoCodeId);
    if (Number.isInteger(promoId) && promoId > 0) {
      let overCap = false;
      if (meta.promoReservedAtCheckout !== "true") {
        const redeemed = await tx.execute(sql`
          UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW()
           WHERE id = ${promoId} AND deleted_at IS NULL
             AND (max_uses IS NULL OR uses_count < max_uses)
          RETURNING id
        `);
        overCap = redeemed.rows.length === 0;
      }
      const details = JSON.stringify({
        code: meta.promoCode || null,
        percent: meta.promoCodePercent ? Number(meta.promoCodePercent) : null,
        submission_id: row.submission_id,
        over_cap: overCap,
        reserved_at_checkout: meta.promoReservedAtCheckout === "true",
      });
      await tx.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('promo_code', ${String(promoId)}, 'PROMO_CODE_REDEEMED', NULL, ${details}::jsonb)
      `);
    }
    await tx.execute(sql`
      UPDATE grading_payment_fulfilments SET promo_completed_at = NOW(), updated_at = NOW()
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
    `);
  });
}

async function completeUserLinkEffect(
  row: GradingPaymentFulfilmentRow,
  submission: any,
  runner: PaymentExecutor
): Promise<void> {
  if (row.user_link_completed_at) return;
  await runner.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT user_link_completed_at FROM grading_payment_fulfilments
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
         AND status = 'PROCESSING'
       FOR UPDATE
    `);
    if (locked.rows.length !== 1) throw new Error("grading payment user-link claim lost");
    if ((locked.rows[0] as { user_link_completed_at: Date | null }).user_link_completed_at) return;

    if (submission.email) {
      const email = String(submission.email).trim().toLowerCase();
      let user = await tx.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
      if (user.rows.length === 0) {
        user = await tx.execute(sql`
          INSERT INTO users (email, first_name, last_name)
          VALUES (
            ${email},
            ${submission.firstName || submission.first_name || null},
            ${submission.lastName || submission.last_name || null}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
        if (user.rows.length === 0) {
          // Another account transaction may have won the case-insensitive email
          // key. Resolve its canonical id before linking the paid submission.
          user = await tx.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
        }
      }
      const userId = (user.rows[0] as { id?: string } | undefined)?.id;
      if (!userId) throw new Error("grading payment user creation failed");
      await tx.execute(sql`
        UPDATE submissions SET user_id = ${userId}, updated_at = NOW() WHERE id = ${row.submission_id}
      `);
    }
    await tx.execute(sql`
      UPDATE grading_payment_fulfilments
         SET user_link_completed_at = NOW(), updated_at = NOW()
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
    `);
  });
}

async function completeEmailEffect(row: GradingPaymentFulfilmentRow, runner: PaymentExecutor): Promise<void> {
  if (row.email_completed_at) return;
  const payload = row.confirmation_payload;
  const emailData = { ...payload.emailData, idempotencyKey: row.provider_idempotency_key };
  const receipt = payload.useV2
    ? await sendSubmissionConfirmationV2(emailData)
    : await sendSubmissionConfirmation(emailData);
  if (!receipt?.id) throw new Error("grading payment confirmation email provider unavailable");
  await runner.execute(sql`
    UPDATE grading_payment_fulfilments
       SET email_completed_at = COALESCE(email_completed_at, NOW()),
           provider_message_id = COALESCE(provider_message_id, ${receipt.id}),
           updated_at = NOW()
     WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token} AND status = 'PROCESSING'
  `);
}

async function markGradingPaymentFulfilmentFailure(
  row: GradingPaymentFulfilmentRow,
  error: unknown,
  runner: PaymentExecutor
): Promise<"FAILED" | "RECONCILIATION_REQUIRED"> {
  const terminal =
    error instanceof PermanentPaymentFulfilmentError || row.attempt_count >= PAYMENT_FULFILMENT_MAX_ATTEMPTS;
  const status = terminal ? "RECONCILIATION_REQUIRED" : "FAILED";
  const rawMessage = error instanceof Error ? error.message : "unknown fulfilment error";
  const message = rawMessage.replace(/[\r\n\t]+/g, " ").slice(0, 300);
  await runner.execute(sql`
    UPDATE grading_payment_fulfilments
       SET status = ${status}, claim_token = NULL, claim_expires_at = NULL,
           next_attempt_at = NOW() + INTERVAL '5 minutes', last_error = ${message}, updated_at = NOW()
     WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token} AND status = 'PROCESSING'
  `);
  return status;
}

async function processClaimedGradingPaymentFulfilment(
  row: GradingPaymentFulfilmentRow,
  deps: { storage?: typeof storage; exec?: PaymentExecutor } = {}
): Promise<"COMPLETE" | "FAILED" | "RECONCILIATION_REQUIRED"> {
  const store = deps.storage ?? storage;
  const runner = deps.exec ?? db;
  try {
    const submission = await store.getSubmissionBySubmissionId(row.tracking_number);
    if (!submission) throw new PermanentPaymentFulfilmentError("canonical submission missing");
    await completeEstimateEffect(row, submission, runner);
    await completeCreditEffect(row, submission, runner);
    await completePromoEffect(row, runner);
    await completeUserLinkEffect(row, submission, runner);
    await completeEmailEffect(row, runner);
    const completed = await runner.execute(sql`
      UPDATE grading_payment_fulfilments
         SET status = 'COMPLETE', completed_at = NOW(), claim_token = NULL, claim_expires_at = NULL,
             next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE submission_id = ${row.submission_id} AND claim_token = ${row.claim_token}
         AND status = 'PROCESSING'
         AND estimate_completed_at IS NOT NULL AND credit_completed_at IS NOT NULL
         AND promo_completed_at IS NOT NULL AND user_link_completed_at IS NOT NULL
         AND email_completed_at IS NOT NULL
      RETURNING submission_id
    `);
    if (completed.rows.length !== 1) throw new Error("grading payment fulfilment completion CAS failed");
    return "COMPLETE";
  } catch (error) {
    return markGradingPaymentFulfilmentFailure(row, error, runner);
  }
}

async function processGradingPaymentFulfilmentById(
  submissionId: number,
  deps: { storage?: typeof storage; exec?: PaymentExecutor } = {}
): Promise<"NOT_DUE" | "COMPLETE" | "FAILED" | "RECONCILIATION_REQUIRED"> {
  const runner = deps.exec ?? db;
  const row = await claimGradingPaymentFulfilment(submissionId, runner);
  if (!row) return "NOT_DUE";
  return processClaimedGradingPaymentFulfilment(row, deps);
}

/**
 * Durable payment entrypoint shared by Stripe webhook and browser confirmation.
 * The outbox row is committed before the paid transition, so a process death
 * after `markSubmissionAsPaid` leaves explicit retryable work rather than a
 * silently paid-but-unfulfilled submission.
 */
export async function fulfilPaidSubmission(
  submission: any,
  piMeta: Record<string, string | undefined>,
  piAmount: number,
  deps: { storage?: typeof storage; exec?: PaymentExecutor } = {},
  payment?: PaidSubmissionPayment
): Promise<{ fulfilled: boolean }> {
  if (!payment?.paymentIntentId) {
    return fulfilPaidSubmissionLegacy(submission, piMeta, piAmount, deps, payment);
  }

  const store = deps.storage ?? storage;
  const runner = deps.exec ?? db;
  await ensureGradingPaymentFulfilment(
    submission,
    piMeta,
    piAmount,
    { ...payment, paymentIntentId: payment.paymentIntentId },
    runner
  );

  const won = await store.markSubmissionAsPaid(Number(submission.id), {
    amountPence: piAmount,
    currency: payment.currency,
    paidAt: payment.paidAt,
  });
  if (!won) {
    // `false` means either an idempotent replay of an already-paid row or a
    // transition that did not happen. Only the first is safe to acknowledge to
    // Stripe: otherwise the provider event would be recorded while the durable
    // receipt remained permanently filtered out of fulfilment.
    const paid = await runner.execute(sql`
      SELECT 1 FROM submissions
       WHERE id = ${Number(submission.id)} AND payment_status = 'paid'
    `);
    if (paid.rows.length !== 1) {
      throw new Error("grading payment receipt persisted but submission did not reach paid state");
    }
  }
  const outcome = await processGradingPaymentFulfilmentById(Number(submission.id), deps);
  if (outcome === "RECONCILIATION_REQUIRED") {
    console.error(`[fulfil] submission ${submission.submissionId} requires payment-fulfilment reconciliation`);
  }
  return { fulfilled: won };
}

/** Advisory-locked by server/index.ts; row claims remain the multi-machine authority. */
export async function reconcileGradingPaymentFulfilments(
  options: { limit?: number; storage?: typeof storage; exec?: PaymentExecutor } = {}
): Promise<{ examined: number; completed: number; failed: number; reconciliationRequired: number }> {
  const runner = options.exec ?? db;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  // The receipt is written before the paid transition. If a process dies in
  // that narrow window, recover the same guarded draft->paid transition from
  // authoritative receipt data instead of depending forever on provider
  // redelivery. Unsafe non-draft mismatches are never overwritten; they become
  // a standing operator-visible reconciliation item.
  await runner.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL mintvault.admin_bypass = 'true'`);
    await tx.execute(sql`
      UPDATE submissions s
         SET status = 'paid', payment_status = 'paid',
             payment_amount = f.amount_pence::numeric / 100,
             payment_currency = f.currency,
             payment_timestamp = COALESCE(s.payment_timestamp, f.paid_at),
             updated_at = NOW()
        FROM grading_payment_fulfilments f
       WHERE f.submission_id = s.id
         AND f.status IN ('PENDING', 'FAILED')
         AND f.next_attempt_at <= NOW()
         AND LOWER(s.status) = 'draft'
         AND s.payment_status <> 'paid'
    `);
    await tx.execute(sql`
      UPDATE grading_payment_fulfilments f
         SET status = 'RECONCILIATION_REQUIRED',
             claim_token = NULL, claim_expires_at = NULL,
             last_error = 'paid receipt conflicts with non-draft unpaid submission state',
             updated_at = NOW()
        FROM submissions s
       WHERE s.id = f.submission_id
         AND f.status IN ('PENDING', 'FAILED')
         AND f.next_attempt_at <= NOW()
         AND s.payment_status <> 'paid'
         AND LOWER(s.status) <> 'draft'
    `);
  });
  // A hard process death bypasses the in-process catch. If it happens during
  // the final allowed claim, terminalize the expired lease explicitly rather
  // than leaving a PROCESSING row that the attempt ceiling makes unclaimable.
  await runner.execute(sql`
    UPDATE grading_payment_fulfilments
       SET status = 'RECONCILIATION_REQUIRED', claim_token = NULL, claim_expires_at = NULL,
           last_error = COALESCE(last_error, 'fulfilment attempt ceiling exhausted after worker interruption'),
           updated_at = NOW()
     WHERE attempt_count >= ${PAYMENT_FULFILMENT_MAX_ATTEMPTS}
       AND (
         (status IN ('PENDING', 'FAILED') AND next_attempt_at <= NOW())
         OR (status = 'PROCESSING' AND claim_expires_at <= NOW())
       )
  `);
  const due = await runner.execute(sql`
    SELECT f.submission_id
      FROM grading_payment_fulfilments f
      JOIN submissions s ON s.id = f.submission_id AND s.payment_status = 'paid'
     WHERE f.attempt_count < ${PAYMENT_FULFILMENT_MAX_ATTEMPTS}
       AND (
         (f.status IN ('PENDING', 'FAILED') AND f.next_attempt_at <= NOW())
         OR (f.status = 'PROCESSING' AND f.claim_expires_at <= NOW())
       )
     ORDER BY f.next_attempt_at, f.submission_id
     LIMIT ${limit}
  `);
  let completed = 0;
  let failed = 0;
  for (const item of due.rows as Array<{ submission_id: number }>) {
    const state = await processGradingPaymentFulfilmentById(Number(item.submission_id), {
      storage: options.storage,
      exec: runner,
    });
    if (state === "COMPLETE") completed += 1;
    else if (state === "FAILED") failed += 1;
  }
  // Return the standing backlog, not only transitions from this invocation.
  // The periodic worker therefore keeps alerting until an operator resolves it.
  const reconciliation = await runner.execute(sql`
    SELECT COUNT(*)::int AS count FROM grading_payment_fulfilments
     WHERE status = 'RECONCILIATION_REQUIRED'
  `);
  const reconciliationRequired = Number((reconciliation.rows[0] as { count?: number } | undefined)?.count ?? 0);
  return { examined: due.rows.length, completed, failed, reconciliationRequired };
}

// Payment endpoints — generous for legit users retrying declined cards
const paymentRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please wait a few minutes and try again." },
});

// Public-lookup limiter for the submission GET (H3): submission ids are sequential
// (MV-SUB-NNNNNN), so even behind the email gate we cap per-IP request volume to
// stop enumeration sweeps. Mirrors the lookupRateLimit used by other public lookups.
const submissionLookupRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Limit: 60 per minute per IP." },
});

// A valid document token is necessary but does not bound replay. PDF rendering
// is CPU-intensive, so keep a separate modest per-client budget for these two
// token-gated document routes.
const submissionPdfRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many document requests. Please wait a minute and try again." },
});

export function registerSubmissionRoutes(app: Express): void {
  // Authoritative grading quote — the SAME computeGradingQuote() the PaymentIntent
  // uses, so the wizard can display the exact charged total without doing any money
  // math itself. Read-only: reads the session user's vault-club status + active
  // promo server-side; never trusts a client-supplied percentage. No DB writes.
  app.post("/api/grading/quote", async (req, res) => {
    try {
      const { type, tier, quantity, declaredValue, applyCredit, creditType, promoCode } = req.body ?? {};
      const serviceType = typeof type === "string" && type ? type : "grading";
      if (!tier || typeof tier !== "string") {
        return res.status(400).json({ error: "tier is required" });
      }
      const qty = Math.trunc(Number(quantity));
      if (!Number.isFinite(qty) || qty < 1) {
        return res.status(400).json({ error: "quantity must be a positive integer" });
      }
      const dbTier = await storage.getServiceTier(serviceType, tier);
      if (!dbTier) {
        return res.status(400).json({ error: `Invalid or inactive tier "${tier}" for service "${serviceType}"` });
      }
      const tierData = serviceTierToPricingTier(dbTier);
      if (!tierData.pricePerCard || tierData.pricePerCard <= 0) {
        return res.status(400).json({ error: "Tier has an invalid price configuration" });
      }
      const totalDeclaredValue = Math.max(0, parseFloat(declaredValue) || 0);
      const quote = await computeGradingQuote({
        serviceType,
        tier,
        pricePerCard: tierData.pricePerCard,
        quantity: qty,
        declaredValue: totalDeclaredValue,
        userId: (req.session as any)?.userId ?? null,
        applyCredit: !!applyCredit,
        creditType,
        promoCode: typeof promoCode === "string" ? promoCode : undefined,
      });
      res.json(quote);
    } catch (err: any) {
      console.error("[grading/quote] error:", err?.message || err);
      res.status(500).json({ error: "Failed to compute quote" });
    }
  });

  app.post("/api/create-payment-intent", paymentRateLimit, async (req, res) => {
    try {
      const {
        type,
        tier,
        quantity,
        declaredValue,
        notes,
        submissionName,
        email,
        firstName,
        lastName,
        shippingAddress,
        phone,
        cardItems,
        crossoverCompany,
        crossoverOriginalGrade,
        crossoverCertNumber,
        reholderCompany,
        reholderReason,
        reholderCondition,
        authReason,
        authConcerns,
        revealWrap,
        marketingFeatureConsent,
        applyCredit,
        creditType: requestedCreditType,
        promoCode,
        attribution,
      } = req.body;

      const VALID_SERVICE_TYPES = ["grading", "reholder", "crossover", "authentication"];
      if (!type || !VALID_SERVICE_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Invalid or missing service type "${type || ""}". Must be one of: ${VALID_SERVICE_TYPES.join(", ")}`,
        });
      }

      // Check tier capacity — block paused tiers
      if (tier) {
        const capRow = await db.execute(
          sql`SELECT status, paused_message FROM tier_capacity WHERE tier_id = ${tier} LIMIT 1`
        );
        const cap = capRow.rows[0] as any;
        if (cap?.status === "paused") {
          return res.status(403).json({
            error:
              cap.paused_message || `The ${tier} tier is currently closed for submissions. Please try another tier.`,
          });
        }
      }

      if (type === "crossover" && !crossoverCompany) {
        return res.status(400).json({ error: "Original grading company is required for crossover submissions." });
      }

      if (type === "reholder" && (!reholderCompany || !reholderReason)) {
        return res
          .status(400)
          .json({ error: "Current slab company and reason are required for reholder submissions." });
      }

      if (type === "authentication" && !authReason) {
        return res.status(400).json({ error: "Authentication reason is required for authentication submissions." });
      }
      const serviceType = type;

      if (!tier) {
        return res.status(400).json({ error: "Service tier is required" });
      }

      const dbTier = await storage.getServiceTier(serviceType, tier);
      if (!dbTier) {
        return res.status(400).json({ error: `Invalid or inactive tier "${tier}" for service "${serviceType}"` });
      }
      const tierData = serviceTierToPricingTier(dbTier);

      if (!tierData.pricePerCard || tierData.pricePerCard <= 0) {
        return res.status(400).json({
          error: `Tier "${tier}" for service "${serviceType}" has an invalid price configuration (£0). Checkout aborted.`,
        });
      }

      // Capacity gating — only applied to grading submissions (reholder/crossover/auth have no tier capacity)
      if (serviceType === "grading") {
        const capacity = await getTierCapacity(tier).catch(() => null);
        if (capacity && capacity.full) {
          return res.status(409).json({
            error: "tier_full",
            tier,
            message: `The ${tier} tier is currently at full capacity. Please choose a different tier or check back later.`,
          });
        }
      }

      if (!quantity || quantity < 1) {
        return res.status(400).json({ error: "Quantity must be at least 1" });
      }

      if (!shippingAddress?.line1 || !shippingAddress?.city || !shippingAddress?.postcode) {
        return res.status(400).json({ error: "Return address is required (line1, city, postcode)" });
      }

      if (!email || !firstName || !lastName) {
        return res.status(400).json({ error: "Customer name and email are required" });
      }

      const totalDeclaredValue = Math.max(0, parseFloat(declaredValue) || 0);
      if (totalDeclaredValue <= 0) {
        return res.status(400).json({ error: "Declared value is required and must be greater than 0" });
      }

      const { liabilityAccepted, termsAccepted, termsVersion: clientTermsVersion } = req.body;
      const { FEATURE_FLAGS } = await import("../config/feature-flags");
      const { TERMS_VERSION } = await import("../config/legal");

      if (FEATURE_FLAGS.LEGAL_PAGES_LIVE) {
        // New combined terms flow — single checkbox sets both
        if (!termsAccepted) {
          return res.status(400).json({ error: "Terms acceptance required" });
        }
        if (clientTermsVersion && clientTermsVersion !== TERMS_VERSION) {
          return res
            .status(400)
            .json({ error: `Terms version mismatch. Expected ${TERMS_VERSION}, got ${clientTermsVersion}` });
        }
      } else {
        // Legacy flow — separate checkboxes
        if (!liabilityAccepted) {
          return res.status(400).json({ error: "You must accept the Liability & Shipping Policy before proceeding." });
        }
        if (!termsAccepted) {
          return res.status(400).json({ error: "Terms & Conditions must be accepted." });
        }
      }

      if (Array.isArray(cardItems) && cardItems.length > 0) {
        if (cardItems.length !== quantity) {
          return res
            .status(400)
            .json({ error: `Card details count (${cardItems.length}) must match quantity (${quantity})` });
        }
        for (let i = 0; i < cardItems.length; i++) {
          const ci = cardItems[i];
          if (ci.declaredValue !== undefined && ci.declaredValue !== null) {
            const dv = Number(ci.declaredValue);
            if (isNaN(dv) || dv < 0) {
              return res.status(400).json({ error: `Card ${i + 1}: declared value must be a non-negative number` });
            }
          }
          for (const field of ["game", "cardName", "setName", "cardNumber", "year", "notes"] as const) {
            if (ci[field] !== undefined && ci[field] !== null && typeof ci[field] !== "string") {
              return res.status(400).json({ error: `Card ${i + 1}: ${field} must be a string` });
            }
            if (typeof ci[field] === "string" && ci[field].length > 500) {
              return res.status(400).json({ error: `Card ${i + 1}: ${field} exceeds maximum length (500 chars)` });
            }
          }
        }
      }

      if (quantity > 1 && (!Array.isArray(cardItems) || cardItems.length === 0)) {
        return res.status(400).json({ error: "Card details required for multi-card submissions" });
      }
      const authoritativeQuantity = Array.isArray(cardItems) && cardItems.length > 0 ? cardItems.length : quantity;
      if (authoritativeQuantity !== quantity) {
        return res.status(400).json({ error: "Quantity mismatch" });
      }

      // Single source of truth for the charged total — server/services/gradingQuote.ts.
      // The /api/grading/quote endpoint calls the SAME helper with the SAME inputs,
      // so the wizard's displayed total and this PaymentIntent amount are identical
      // by construction. Vault-club status + active promo are resolved server-side.
      const quoteInput = {
        serviceType,
        tier,
        pricePerCard: tierData.pricePerCard,
        quantity: authoritativeQuantity,
        declaredValue: totalDeclaredValue,
        userId: (req.session as any)?.userId ?? null,
        applyCredit: !!applyCredit,
        creditType: requestedCreditType,
        promoCode: typeof promoCode === "string" ? promoCode : undefined,
      };
      let quote = await computeGradingQuote(quoteInput);
      const submissionId = await storage.getNextSubmissionId();

      // ── Reserve-at-checkout (fix for the credit double-spend + promo
      // over-redemption races). Atomically claim the credit/promo BEFORE the
      // discounted PaymentIntent is committed to Stripe, so two concurrent
      // checkouts can't both apply the same one. If a claim is lost to a
      // concurrent order, recompute the quote WITHOUT that discount so the
      // charged amount is correct (full price). Not excluding reserved credits
      // from the count (see gradingQuote.ts) means this recompute never wrongly
      // drops a credit we DID reserve.
      const sessionUserId = (req.session as any)?.userId ?? null;
      let reservedCreditId: number | null = null;
      let promoReservedAtCheckout = false;
      if (quote.creditApplied && quote.creditTypeApplied && sessionUserId) {
        reservedCreditId = await reserveCredit(sessionUserId, quote.creditTypeApplied, submissionId);
      }
      if (quote.promoCodeApplied && quote.promoCodeId != null) {
        promoReservedAtCheckout = await reservePromoCodeUse(quote.promoCodeId);
      }
      const creditLost = !!(quote.creditApplied && quote.creditTypeApplied && sessionUserId && !reservedCreditId);
      const promoLost = !!(quote.promoCodeApplied && quote.promoCodeId != null && !promoReservedAtCheckout);
      if (creditLost || promoLost) {
        quote = await computeGradingQuote({
          ...quoteInput,
          applyCredit: creditLost ? false : quoteInput.applyCredit,
          promoCode: promoLost ? undefined : quoteInput.promoCode,
        });
      }
      const {
        vcTier,
        vcStatus,
        vcPercent,
        bulkPercent,
        promoPercent,
        promoId,
        promoStackingMode,
        effectiveDiscountAmount,
        effectiveDiscountPercent,
        discountType,
        discountedSubtotal,
        promoApplied,
        creditApplied,
        creditAmountPence,
        creditTypeApplied,
        shipping,
        totalInsuranceFee,
        insuranceSurchargePerCard,
        shippingLabel,
        total,
        promoCodeApplied,
        promoCodeId,
        promoCode: appliedPromoCode,
        promoCodePercent,
      } = quote;

      const declaredValuePerCard =
        authoritativeQuantity > 0 ? Math.ceil(totalDeclaredValue / authoritativeQuantity) : 0;
      const highValueFlag = declaredValuePerCard > 3000 || totalDeclaredValue > 7500;
      const requiresManualApproval = totalDeclaredValue > 7500;

      const turnaroundDays = dbTier.turnaroundDays;

      const clientIp = req.ip || req.socket?.remoteAddress || "unknown";

      const submission = await storage.createSubmission({
        submissionId,
        type: serviceType,
        tier,
        quantity: authoritativeQuantity,
        submissionName: submissionName || null,
        notes: notes || null,
        amountTotal: total,
        totalDeclaredValue: totalDeclaredValue,
        currency: "gbp",
        status: "draft",
        email: email?.toLowerCase(),
        firstName,
        lastName,
        phone: phone || null,
        shippingAddress,
        turnaroundDays,
        shippingCost: shipping,
        shippingInsuranceTier: shippingLabel,
        gradingCost: discountedSubtotal,
        pricePerCardAtPurchase: tierData.pricePerCard,
        insuranceFee: totalInsuranceFee,
        insuranceSurchargePerCard: insuranceSurchargePerCard,
        liabilityAccepted: true,
        liabilityAcceptedAt: new Date(),
        liabilityAcceptedIp: clientIp,
        termsAccepted: true,
        termsAcceptedAt: new Date(),
        termsVersion: FEATURE_FLAGS.LEGAL_PAGES_LIVE ? TERMS_VERSION : "Feb-2026",
        highValueFlag,
        requiresManualApproval,
        crossoverCompany: crossoverCompany || null,
        crossoverOriginalGrade: crossoverOriginalGrade || null,
        crossoverCertNumber: crossoverCertNumber || null,
        reholderCompany: reholderCompany || null,
        reholderReason: reholderReason || null,
        reholderCondition: reholderCondition || null,
        authReason: authReason || null,
        authConcerns: authConcerns || null,
        revealWrap: revealWrap === true,
        marketingFeatureConsent: marketingFeatureConsent === true,
        marketingFeatureConsentAt: marketingFeatureConsent === true ? new Date() : null,
      });

      // Attribution is optional commercial context, deliberately outside the
      // payment authority. A persistence failure must never prevent a customer
      // from creating a submission or paying for grading.
      await recordSubmissionAttribution(Number(submission.id), attribution).catch(() => {
        console.warn("[commercial-attribution] submission context unavailable");
      });
      await recordGrowthConversionEvent(Number(submission.id), "SUBMISSION_START").catch(() => {
        console.warn("[growth-conversion] submission-start event unavailable");
      });

      // Audit log for terms acceptance
      if (FEATURE_FLAGS.LEGAL_PAGES_LIVE) {
        try {
          const { truncateIp } = await import("../utils/truncate-ip");
          await db.insert(auditLog).values({
            entityType: "submission",
            entityId: String(submission.id),
            action: "terms_accepted",
            adminUser: null,
            details: {
              termsVersion: TERMS_VERSION,
              acceptedAt: new Date().toISOString(),
              userAgent: req.headers["user-agent"]?.slice(0, 200),
              ip: truncateIp(req.ip),
            },
          });
        } catch {}
      }

      // Audit log for marketing-feature consent.
      if (marketingFeatureConsent === true) {
        try {
          await db.insert(auditLog).values({
            entityType: "submission",
            entityId: String(submission.id),
            action: "marketing_consent_changed",
            adminUser: null,
            details: { before: false, after: true, reason: "submission_form" },
          });
        } catch {}
      }

      // Audit log for applied discount (vault_club_silver, bulk, and/or promo).
      if (discountType !== null) {
        try {
          await db.insert(auditLog).values({
            entityType: "submission",
            entityId: String(submission.id),
            action: promoApplied
              ? "promo_discount_applied"
              : discountType === "vault_club_silver"
                ? "vault_club_discount_applied"
                : "bulk_discount_applied",
            adminUser: null,
            details: {
              user_id: (req.session as any)?.userId ?? null,
              vault_club_tier: vcTier,
              vault_club_status: vcStatus,
              applied_type: discountType,
              applied_percent: effectiveDiscountPercent,
              amount_pence: effectiveDiscountAmount,
              card_count: authoritativeQuantity,
              vc_alternative_percent: vcPercent,
              bulk_alternative_percent: bulkPercent,
              promo_id: promoId,
              promo_percent: promoPercent,
              promo_stacking_mode: promoId !== null ? promoStackingMode : null,
            },
          });
        } catch {}
      }

      const stripe = await getUncachableStripeClient();

      const paymentIntent = await stripe.paymentIntents.create({
        amount: total,
        currency: "gbp",
        metadata: {
          submissionId: submission.submissionId,
          submissionDbId: submission.id,
          serviceType,
          tier,
          quantity: String(authoritativeQuantity),
          discountPercent: String(effectiveDiscountPercent),
          discountAmount: String(effectiveDiscountAmount),
          discountType: discountType || "none",
          vcAlternativePercent: String(vcPercent),
          bulkAlternativePercent: String(bulkPercent),
          promoId: promoId !== null ? String(promoId) : "",
          promoPercent: String(promoPercent),
          promoStackingMode: promoId !== null ? promoStackingMode : "",
          // Promo code — recorded only when it actually discounted the order (won
          // best_of). Redeemed (usage incremented) on the success path.
          ...(promoCodeApplied && promoCodeId !== null
            ? {
                promoCodeId: String(promoCodeId),
                promoCode: appliedPromoCode || "",
                promoCodePercent: String(promoCodePercent),
                // The use was already counted atomically at checkout
                // (reservePromoCodeUse) — fulfilment must NOT increment again.
                promoReservedAtCheckout: promoReservedAtCheckout ? "true" : "",
              }
            : {}),
          declaredValue: String(totalDeclaredValue),
          declaredValuePerCard: String(declaredValuePerCard),
          shippingInsurance: shippingLabel,
          insuranceFee: String(totalInsuranceFee),
          highValue: String(highValueFlag),
          ...(creditApplied
            ? {
                creditApplied: "true",
                creditType: creditTypeApplied || "",
                creditAmountPence: String(creditAmountPence),
                // The specific credit reserved at checkout — fulfilment consumes
                // exactly this row (empty ⇒ legacy PI / no reservation).
                reservedCreditId: reservedCreditId != null ? String(reservedCreditId) : "",
                // PKG-1 — the reserving user's immutable, server-derived id. This
                // BINDS credit ownership to the authenticated session that reserved
                // it, so fulfilment never re-derives the owner from the
                // customer-supplied submission email. It's an opaque internal id
                // (not personal data). Empty only if somehow reserved without a
                // session (not produced by this route).
                creditOwnerUserId: sessionUserId ? String(sessionUserId) : "",
              }
            : {}),
          ...(type === "crossover" && crossoverCompany
            ? {
                crossoverCompany: crossoverCompany,
                crossoverOriginalGrade: crossoverOriginalGrade || "",
                crossoverCertNumber: crossoverCertNumber || "",
              }
            : {}),
          ...(type === "reholder" && reholderCompany
            ? {
                reholderCompany: reholderCompany,
                reholderReason: reholderReason || "",
                reholderCondition: reholderCondition || "",
              }
            : {}),
          ...(type === "authentication" && authReason
            ? {
                authReason: authReason,
                authConcerns: authConcerns || "",
              }
            : {}),
        },
        receipt_email: email,
      });

      await storage.updateSubmission(submission.id, {
        stripePaymentId: paymentIntent.id,
      });
      await recordGrowthConversionEvent(Number(submission.id), "CHECKOUT_START").catch(() => {
        console.warn("[growth-conversion] checkout-start event unavailable");
      });

      const submissionDbId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const perCardDeclaredValue =
        authoritativeQuantity > 0 ? Math.ceil(totalDeclaredValue / authoritativeQuantity) : 0;
      const itemRows = [];

      if (Array.isArray(cardItems) && cardItems.length > 0) {
        for (const item of cardItems) {
          itemRows.push({
            game: typeof item.game === "string" && item.game.trim() ? item.game.trim() : null,
            cardName: typeof item.cardName === "string" && item.cardName.trim() ? item.cardName.trim() : null,
            cardSet: typeof item.setName === "string" && item.setName.trim() ? item.setName.trim() : null,
            cardNumber: typeof item.cardNumber === "string" && item.cardNumber.trim() ? item.cardNumber.trim() : null,
            year: typeof item.year === "string" && item.year.trim() ? item.year.trim() : null,
            declaredValue:
              typeof item.declaredValue === "number" && item.declaredValue > 0
                ? item.declaredValue
                : perCardDeclaredValue,
            notes: typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : null,
          });
        }
      } else {
        for (let i = 1; i <= authoritativeQuantity; i++) {
          itemRows.push({
            game: null,
            cardSet: null,
            cardName: null,
            cardNumber: null,
            year: null,
            declaredValue: perCardDeclaredValue,
            notes: null,
          });
        }
      }
      await storage.addSubmissionItems(submissionDbId, itemRows);

      res.json({
        clientSecret: paymentIntent.client_secret,
        submissionId: submission.submissionId,
        total,
        discount:
          effectiveDiscountPercent > 0
            ? {
                type: discountType,
                percent: effectiveDiscountPercent,
                amount_pence: effectiveDiscountAmount,
              }
            : null,
        credit: creditApplied
          ? {
              type: creditTypeApplied,
              amount_pence: creditAmountPence,
            }
          : null,
        freeShipping: false,
      });
    } catch (error: any) {
      console.error("Error creating payment intent:", error.message);
      res.status(500).json({ error: "Failed to create payment" });
    }
  });

  app.post("/api/confirm-payment", paymentRateLimit, async (req, res) => {
    try {
      const { submissionId, paymentIntentId } = req.body;

      const submission = await storage.getSubmissionBySubmissionId(submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      // SECURITY — bind the PaymentIntent to THIS submission before fulfilling.
      // The PI id was stored on the submission when the PaymentIntent was created
      // (create-payment-intent → stripePaymentId), with a server-computed amount.
      // Without this check a caller could confirm an arbitrary draft submission
      // using ANY succeeded PaymentIntent (e.g. a cheap one they paid for),
      // bypassing the real charge. Matching the id also guarantees the amount,
      // since the client never sets the PI amount.
      if (!submission.stripePaymentId || submission.stripePaymentId !== paymentIntentId) {
        return res.status(400).json({ error: "Payment does not match this submission" });
      }

      const stripe = await getUncachableStripeClient();
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === "succeeded") {
        // Idempotent fulfilment — the once-only side-effects (mark paid, consume
        // credit, redeem promo, link user, email) run for exactly ONE caller
        // (this handler or the Stripe webhook, whoever wins the atomic paid
        // transition). A duplicate/raced confirm is a safe no-op.
        await fulfilPaidSubmission(
          submission,
          paymentIntent.metadata || {},
          paymentIntent.amount || 0,
          {},
          {
            currency: paymentIntent.currency,
            paidAt: new Date(),
            paymentIntentId: paymentIntent.id,
          }
        );

        const packingSlipToken = generatePdfToken(submission.submissionId); // H-a hardened token
        return res.json({
          success: true,
          submissionId: submission.submissionId,
          status: "paid",
          packingSlipToken,
        });
      }

      res.json({
        success: false,
        status: paymentIntent.status,
      });
    } catch (error: any) {
      console.error("Error confirming payment:", error.message);
      res.status(500).json({ error: "Failed to confirm payment" });
    }
  });

  // The success page cannot use the normal submission lookup: that endpoint
  // deliberately requires an email/session to prevent sequential-id discovery.
  // A confirmation token is minted only after Stripe has reported success, is
  // bound to this submission id, and already authorizes the more sensitive PDF
  // documents. Keep this response deliberately small and never cache it.
  app.get("/api/submissions/:submissionId/success", submissionLookupRateLimit, async (req, res) => {
    try {
      const submissionId = String(req.params.submissionId);
      if (!verifyPdfToken(submissionId, req.query.token)) {
        return res.status(403).json({ error: "Invalid or expired confirmation token" });
      }

      const confirmation = paidSubmissionConfirmation(await storage.getSubmissionBySubmissionId(submissionId));
      if (!confirmation) {
        return res.status(404).json({ error: "Paid submission confirmation not found" });
      }

      res.setHeader("Cache-Control", "private, no-store");
      res.json(confirmation);
    } catch (error: any) {
      console.error("Error getting paid submission confirmation:", error.message);
      res.status(500).json({ error: "Failed to get paid submission confirmation" });
    }
  });

  app.get("/api/submissions/:submissionId", submissionLookupRateLimit, async (req, res) => {
    try {
      // H3 — OWNERSHIP GATE. Submission ids are sequential, so an unauthenticated
      // caller could previously enumerate every order (tier/count/PRICE). Require
      // proof of ownership via an email match (same gate as POST .../track), or a
      // logged-in session whose email matches. No email → 401; wrong email → 403.
      const sess = req.session as any;
      const provided = (
        (typeof req.query.email === "string" && req.query.email) ||
        sess?.customerEmail ||
        sess?.userEmail ||
        ""
      )
        .toLowerCase()
        .trim();
      if (!provided) {
        return res.status(401).json({ error: "Email required" });
      }

      const submission = await storage.getSubmissionBySubmissionId(String(req.params.submissionId));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const storedEmail = (submission.customerEmail || "").toLowerCase().trim();
      if (!storedEmail || storedEmail !== provided) {
        return res.status(403).json({ error: "Email does not match" });
      }

      res.json({
        submissionId: submission.submissionId,
        status: submission.status,
        serviceTier: submission.serviceTier || null,
        serviceType: submission.serviceType || null,
        cardCount: submission.cardCount,
        totalPrice: submission.totalPrice || null,
        createdAt: submission.createdAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get submission" });
    }
  });

  app.post("/api/submissions/:submissionId/track", submissionLookupRateLimit, async (req, res) => {
    try {
      const { email } = req.body;
      if (typeof email !== "string" || !email.trim()) {
        return res.status(400).json({ error: "Email is required" });
      }

      const submission = await storage.getSubmissionBySubmissionId(String(req.params.submissionId));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found or details do not match" });
      }

      const storedEmail = (submission.customerEmail || "").toLowerCase().trim();
      const providedEmail = email.toLowerCase().trim();
      if (!storedEmail || storedEmail !== providedEmail) {
        // Sequential submission ids make distinct 404/403 responses an
        // existence oracle. Missing and mismatched records are deliberately
        // indistinguishable to public callers.
        return res.status(404).json({ error: "Submission not found or details do not match" });
      }

      res.json({
        submissionId: submission.submissionId,
        status: submission.status,
        serviceTier: submission.serviceTier || null,
        serviceType: submission.serviceType || null,
        cardCount: submission.cardCount,
        createdAt: submission.createdAt,
        receivedAt: submission.receivedAt || null,
        shippedAt: submission.shippedAt || null,
        completedAt: submission.completedAt || null,
        returnTracking: submission.returnTracking || null,
        returnCarrier: submission.returnCarrier || null,
        returnService: (submission as any).returnService || null,
        turnaroundDays: submission.turnaroundDays || null,
        // Stepper inputs — see migrations/add-delivered-at.sql for the
        // delivered_at column rationale. in_grading / ready_to_return
        // timestamps are derived from status_history server-side.
        inGradingAt: (submission as any).inGradingAt || null,
        readyToReturnAt: (submission as any).readyToReturnAt || null,
        deliveredAt: (submission as any).deliveredAt || null,
      });
    } catch (error: any) {
      console.error("Track submission error:", error.message);
      res.status(500).json({ error: "Failed to track submission" });
    }
  });

  // ── Public packing slip (token-gated) ─────────────────────────────────────
  app.get("/api/submissions/:submissionId/packing-slip", submissionPdfRateLimit, async (req, res) => {
    try {
      const submissionId = req.params.submissionId;
      if (typeof submissionId !== "string") {
        return res.status(400).json({ error: "Valid submission id required" });
      }
      const submission = await storage.getSubmissionBySubmissionId(submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const token = req.query.token;
      if (!verifyPdfToken(submissionId, token)) {
        return res.status(403).json({ error: "Invalid or expired token" });
      }

      if (submission.status === "draft") {
        return res.status(400).json({ error: "Submission is still in draft" });
      }

      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numId);

      const { generatePackingSlipPDF } = await import("../packingSlip");
      const pdf = await generatePackingSlipPDF({
        submissionId: submission.submissionId,
        customerFirstName: submission.customerFirstName || submission.customer_first_name || "",
        customerLastName: submission.customerLastName || submission.customer_last_name || "",
        customerEmail: submission.customerEmail || submission.customer_email || "",
        phone: submission.phone,
        returnAddressLine1: submission.returnAddressLine1 || submission.return_address_line1 || "",
        returnAddressLine2: submission.returnAddressLine2 || submission.return_address_line2 || "",
        returnCity: submission.returnCity || submission.return_city || "",
        returnCounty: submission.returnCounty || submission.return_county || "",
        returnPostcode: submission.returnPostcode || submission.return_postcode || "",
        serviceType: submission.serviceType || submission.service_type || "",
        serviceTier: submission.serviceTier || submission.service_tier || "",
        turnaroundDays: submission.turnaroundDays || submission.turnaround_days,
        cardCount: submission.cardCount || submission.card_count || 0,
        totalDeclaredValue: parseInt(submission.totalDeclaredValue || submission.total_declared_value || "0", 10),
        totalPrice: submission.totalPrice || submission.total_price || "0",
        shippingCost: parseInt(submission.shippingCost || submission.shipping_cost || "0", 10),
        shippingInsuranceTier: submission.shippingInsuranceTier || submission.shipping_insurance_tier || "",
        gradingCost: parseInt(submission.gradingCost || submission.grading_cost || "0", 10),
        insuranceFee: parseInt(submission.insuranceFee || submission.insurance_fee || "0", 10),
        items: items.map((item: any) => ({
          cardIndex: item.cardIndex || item.card_index || 0,
          game: item.game,
          cardSet: item.cardSet || item.card_set,
          cardName: item.cardName || item.card_name,
          cardNumber: item.cardNumber || item.card_number,
          year: item.year,
          declaredValue: item.declaredValue || item.declared_value,
        })),
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${submission.submissionId}-packing-slip.pdf"`);
      res.send(pdf);
    } catch (error: any) {
      console.error("Public packing slip error:", error.message);
      res.status(500).json({ error: "Failed to generate packing slip" });
    }
  });

  // ── Public shipping label (token-gated) ───────────────────────────────────
  app.get("/api/submissions/:submissionId/shipping-label", submissionPdfRateLimit, async (req, res) => {
    try {
      const submissionId = req.params.submissionId;
      if (typeof submissionId !== "string") {
        return res.status(400).json({ error: "Valid submission id required" });
      }
      const submission = await storage.getSubmissionBySubmissionId(submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const token = req.query.token;
      if (!verifyPdfToken(submissionId, token)) {
        return res.status(403).json({ error: "Invalid or expired token" });
      }

      if (submission.status === "draft") {
        return res.status(400).json({ error: "Submission is still in draft" });
      }

      const { generateShippingLabelPDF } = await import("../shipping-label");
      const pdf = await generateShippingLabelPDF({
        submissionId: submission.submissionId,
        customerFirstName: submission.customerFirstName || submission.customer_first_name || "",
        customerLastName: submission.customerLastName || submission.customer_last_name || "",
        returnAddressLine1: submission.returnAddressLine1 || submission.return_address_line1 || "",
        returnAddressLine2: submission.returnAddressLine2 || submission.return_address_line2 || undefined,
        returnCity: submission.returnCity || submission.return_city || "",
        returnCounty: submission.returnCounty || submission.return_county || undefined,
        returnPostcode: submission.returnPostcode || submission.return_postcode || "",
        cardCount: submission.cardCount || submission.card_count || 0,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${submission.submissionId}-shipping-label.pdf"`);
      res.send(pdf);
    } catch (error: any) {
      console.error("Shipping label error:", error.message);
      res.status(500).json({ error: "Failed to generate shipping label" });
    }
  });
}
