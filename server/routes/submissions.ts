import type { Express } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { serviceTierToPricingTier, auditLog } from "@shared/schema";
import { storage } from "../storage";
import { getUncachableStripeClient } from "../stripeClient";
import { sendSubmissionConfirmation, sendSubmissionConfirmationV2 } from "../email";
import { computeGradingQuote } from "../services/gradingQuote";
import { redeemPromoCode } from "../services/promoCodeService";
import { db } from "../db";
import { sql } from "drizzle-orm";

/** Consume a single credit of the given type. Returns true if consumed. */
async function consumeCredit(userId: string, creditType: string, submissionId: number): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE member_credits
    SET used_at = NOW(), used_for_submission_id = ${submissionId}
    WHERE id = (
      SELECT id FROM member_credits
      WHERE user_id = ${userId} AND credit_type = ${creditType}
        AND used_at IS NULL AND expires_at > NOW()
      ORDER BY expires_at ASC LIMIT 1
    ) RETURNING id
  `);
  return result.rows.length > 0;
}

function getSignedUrlSecret(): string {
  const s = process.env.SIGNED_URL_SECRET;
  if (!s) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return s;
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
 * Idempotent fulfilment of a paid grading submission. Called by BOTH
 * /api/confirm-payment AND the Stripe grading webhook (payment_intent.succeeded).
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
export async function fulfilPaidSubmission(
  submission: any,
  piMeta: Record<string, string | undefined>,
  piAmount: number
): Promise<{ fulfilled: boolean }> {
  const sid: string = submission.submissionId;
  const numId = Number(submission.id);

  // ATOMIC GATE — only the first transition to paid wins.
  const won = await storage.markSubmissionAsPaid(numId);
  if (!won) {
    console.log(`[fulfil] submission ${sid} already paid, skipping (idempotent no-op)`);
    return { fulfilled: false };
  }
  console.log(`[fulfil] submission ${sid} — first paid transition, fulfilling`);

  storage
    .setEstimatedCompletionDate(numId)
    .catch((e: any) => console.error(`[fulfil] submission ${sid} setEstimatedCompletionDate error:`, e?.message || e));

  // Consume a Vault Club credit if one was applied at checkout.
  if (piMeta.creditApplied === "true" && piMeta.creditType && submission.email) {
    try {
      const creditUser = await storage.getUserByEmail(submission.email);
      if (creditUser) {
        const consumed = await consumeCredit(creditUser.id, piMeta.creditType, numId);
        if (!consumed) {
          console.error(
            `[fulfil] submission ${sid} credit NOT consumed (none available for ${piMeta.creditType}) — reconcile`
          );
        } else {
          console.log(`[fulfil] submission ${sid} consumed 1 ${piMeta.creditType} credit`);
        }
      } else {
        console.error(`[fulfil] submission ${sid} creditApplied but no user for ${submission.email} — reconcile`);
      }
    } catch (e: any) {
      console.error(`[fulfil] submission ${sid} credit consume error:`, e?.message || e);
    }
  }

  // Redeem the promo code (atomic increment + audit, cap-guarded) if one
  // discounted this order. The charge already reflects the discount, so we
  // never fail fulfilment on a redeem error.
  if (piMeta.promoCodeId) {
    const codeId = Number(piMeta.promoCodeId);
    if (Number.isInteger(codeId) && codeId > 0) {
      try {
        await redeemPromoCode(
          codeId,
          piMeta.promoCode || null,
          piMeta.promoCodePercent ? Number(piMeta.promoCodePercent) : null,
          numId
        );
        console.log(`[fulfil] submission ${sid} redeemed promo code id=${codeId}`);
      } catch (e: any) {
        console.error(`[fulfil] submission ${sid} promo redeem error:`, e?.message || e);
      }
    }
  }

  // Link (or create) the customer user record.
  if (submission.email) {
    try {
      let user = await storage.getUserByEmail(submission.email);
      if (!user) {
        user = await storage.createUser({
          email: submission.email,
          firstName: submission.firstName || submission.first_name || undefined,
          lastName: submission.lastName || submission.last_name || undefined,
        });
      }
      await storage.updateSubmission(submission.id, { userId: user.id });
    } catch (e: any) {
      console.error(`[fulfil] submission ${sid} user-link error:`, e?.message || e);
    }
  }

  // Confirmation email (V2 with legal terms when the flag is live, else legacy
  // with crossover fields). Fire-and-forget — logged, never blocks.
  try {
    const packingSlipToken = crypto.createHmac("sha256", getSignedUrlSecret()).update(sid).digest("hex").slice(0, 16);
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
      const quote = await computeGradingQuote({
        serviceType,
        tier,
        pricePerCard: tierData.pricePerCard,
        quantity: authoritativeQuantity,
        declaredValue: totalDeclaredValue,
        userId: (req.session as any)?.userId ?? null,
        applyCredit: !!applyCredit,
        creditType: requestedCreditType,
        promoCode: typeof promoCode === "string" ? promoCode : undefined,
      });
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

      const submissionId = await storage.getNextSubmissionId();

      const turnaroundDays = tierData.turnaround ? parseInt(tierData.turnaround) : null;

      const clientIp =
        req.headers["x-forwarded-for"]?.toString()?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

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
        await fulfilPaidSubmission(submission, paymentIntent.metadata || {}, paymentIntent.amount || 0);

        const packingSlipToken = crypto
          .createHmac("sha256", getSignedUrlSecret())
          .update(submission.submissionId)
          .digest("hex")
          .slice(0, 16);
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

  app.post("/api/submissions/:submissionId/track", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const submission = await storage.getSubmissionBySubmissionId(req.params.submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const storedEmail = (submission.customerEmail || "").toLowerCase().trim();
      const providedEmail = email.toLowerCase().trim();
      if (!storedEmail || storedEmail !== providedEmail) {
        return res.status(403).json({ error: "Email does not match" });
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
  app.get("/api/submissions/:submissionId/packing-slip", async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(req.params.submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const token = req.query.token as string;
      if (!token) {
        return res.status(403).json({ error: "Access denied" });
      }
      const secret = getSignedUrlSecret();
      const expected = crypto.createHmac("sha256", secret).update(req.params.submissionId).digest("hex").slice(0, 16);
      if (token !== expected) {
        return res.status(403).json({ error: "Invalid token" });
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
  app.get("/api/submissions/:submissionId/shipping-label", async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(req.params.submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const token = req.query.token as string;
      if (!token) {
        return res.status(403).json({ error: "Access denied" });
      }
      const secret = getSignedUrlSecret();
      const expected = crypto.createHmac("sha256", secret).update(req.params.submissionId).digest("hex").slice(0, 16);
      if (token !== expected) {
        return res.status(403).json({ error: "Invalid token" });
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
