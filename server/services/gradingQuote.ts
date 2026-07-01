/**
 * gradingQuote.ts — THE single source of truth for the grading-checkout total.
 *
 * Both /api/create-payment-intent (the actual charge) and /api/grading/quote
 * (the wizard's displayed total) call computeGradingQuote(), so the amount shown
 * to the customer and the amount charged are identical BY CONSTRUCTION — not by
 * two code paths that merely "should" agree.
 *
 * Read-only: it reads the session user's vault-club status, the active promo, and
 * the member-credit count from the DB. It performs NO writes and NO Stripe calls.
 * The credit is only *counted* here (to decide the displayed/charged amount); the
 * actual credit consumption stays in the PaymentIntent post-payment flow.
 *
 * This is a verbatim extraction of the money block that used to live inline in
 * server/routes/submissions.ts — behaviour (rounding, discount resolution, credit,
 * shipping, insurance, the final total) is unchanged.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { calculateOrderTotals, getVaultClubDiscountPercent } from "@shared/schema";
import { getActivePromotion } from "./promotionService";
import { resolveGradingDiscount, type GradingStackingMode } from "./gradingDiscount";
import { validatePromoCode } from "./promoCodeService";

/** Count unused, unexpired credits of a given type (read-only). */
export async function countCreditsRemaining(userId: string, creditType: string = "member"): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM member_credits
    WHERE user_id = ${userId} AND credit_type = ${creditType}
      AND used_at IS NULL AND expires_at > NOW()
  `);
  return parseInt((rows.rows[0] as any)?.cnt ?? "0", 10);
}

export interface GradingQuoteInput {
  serviceType: string;
  tier: string;
  /** Tier price per card in pence (storage.getServiceTier → serviceTierToPricingTier). */
  pricePerCard: number;
  /** Authoritative quantity (cardItems.length || quantity). */
  quantity: number;
  /** Total declared value in pounds (drives insurance). */
  declaredValue: number;
  userId?: string | null;
  applyCredit?: boolean;
  /** requestedCreditType from the client ("reholder" → reholder, else standard_grade). */
  creditType?: string;
  /** Optional customer-typed promo code — validated server-side; never trust a client %. */
  promoCode?: string;
}

export interface GradingQuoteResult {
  pricePerCard: number;
  quantity: number;
  subtotalPence: number;
  vcTier: string | null;
  vcStatus: string | null;
  vcPercent: number;
  bulkPercent: number;
  promoPercent: number;
  promoId: number | null;
  promoStackingMode: GradingStackingMode;
  effectiveDiscountAmount: number;
  effectiveDiscountPercent: number;
  discountType: string | null;
  discountedSubtotal: number;
  promoApplied: boolean;
  creditApplied: boolean;
  creditAmountPence: number;
  creditTypeApplied: string | null;
  shipping: number;
  totalInsuranceFee: number;
  insuranceSurchargePerCard: number;
  shippingLabel: string;
  insuranceSurchargeLabel: string;
  /** The chargeable total in pence — exactly the PaymentIntent amount. */
  total: number;
  // ── Promo code (when one was supplied) ──
  /** A code was entered and passed validation (active, not expired, under cap). */
  promoCodeValid: boolean;
  /** Rejection reason when a code was entered but invalid (for wizard feedback). */
  promoCodeReason: string | null;
  /** The code actually discounted this order (won best_of). Drives redemption. */
  promoCodeApplied: boolean;
  /** The validated code's id — stored in PI metadata only when applied. */
  promoCodeId: number | null;
  /** Normalized code string (when valid). */
  promoCode: string | null;
  /** The code's % (when valid). */
  promoCodePercent: number;
}

export async function computeGradingQuote(input: GradingQuoteInput): Promise<GradingQuoteResult> {
  const { serviceType, tier, pricePerCard, quantity, declaredValue, userId, applyCredit, creditType, promoCode } =
    input;

  const totals = calculateOrderTotals(pricePerCard, quantity, declaredValue);
  const subtotalPence = pricePerCard * quantity;
  const bulkPercent = totals.discountPercent;

  // Vault Club Silver discount (10%) — resolved SERVER-SIDE from the user's row.
  let vcTier: string | null = null;
  let vcStatus: string | null = null;
  let vcPercent = 0;
  if (userId) {
    const vcRows = await db.execute(sql`
      SELECT vault_club_tier, vault_club_status FROM users
      WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
    `);
    if (vcRows.rows.length > 0) {
      const u = vcRows.rows[0] as any;
      vcTier = u.vault_club_tier ?? null;
      vcStatus = u.vault_club_status ?? null;
      vcPercent = getVaultClubDiscountPercent(vcTier, vcStatus);
    }
  }

  // Active promotion — grading checkouts only; a client-supplied pct/coupon id is
  // never trusted. A missing/broken promo falls back to 0% and never blocks.
  let promoPercent = 0;
  let promoId: number | null = null;
  let promoStackingMode: GradingStackingMode = "best_of";
  try {
    const promo = serviceType === "grading" ? await getActivePromotion() : null;
    if (promo && promo.active === true) {
      const promoPctByTier: Record<string, number> = {
        standard: promo.standard_pct,
        priority: promo.priority_pct,
        express: promo.express_pct,
      };
      const pct = promoPctByTier[tier];
      if (typeof pct === "number" && pct > 0) {
        promoPercent = Math.max(0, Math.min(100, Math.trunc(pct)));
        promoId = promo.id;
        promoStackingMode = promo.stacking_mode === "stack_on_top" ? "stack_on_top" : "best_of";
      }
    }
  } catch (err: any) {
    console.error("[promo] quote/checkout resolve failed — charging full price:", err?.message || err);
  }

  // Promo CODE — validated SERVER-SIDE (never trust a client %). Grading only.
  // It's fed to the resolver as a best_of arm; it only "applies" (discounts the
  // order) if it beats vault-club/bulk/auto-promo (discountType === "promo_code").
  let codePercent = 0;
  let promoCodeValid = false;
  let promoCodeReason: string | null = null;
  let promoCodeId: number | null = null;
  let promoCodeStr: string | null = null;
  if (typeof promoCode === "string" && promoCode.trim() !== "") {
    if (serviceType !== "grading") {
      promoCodeReason = "not_found";
    } else {
      const v = await validatePromoCode(promoCode);
      if (v.valid) {
        codePercent = v.percent;
        promoCodeValid = true;
        promoCodeId = v.id;
        promoCodeStr = v.code;
      } else {
        promoCodeReason = v.reason;
      }
    }
  }

  const { effectiveDiscountAmount, effectiveDiscountPercent, discountType, discountedSubtotal, promoApplied } =
    resolveGradingDiscount({ subtotalPence, vcPercent, bulkPercent, promoPercent, promoStackingMode, codePercent });

  const promoCodeApplied = discountType === "promo_code";

  // Credit application (Vault Club Silver/Gold). Read-only count here.
  let creditApplied = false;
  let creditAmountPence = 0;
  let creditTypeApplied: string | null = null;
  if (applyCredit && userId) {
    const ct = creditType === "reholder" ? "reholder" : "standard_grade";
    const hasCredit = await countCreditsRemaining(userId, ct);
    if (hasCredit > 0) {
      // Cap the credit at the discounted grading subtotal so it can only zero out
      // the grading cost — never subsidise shipping/insurance (which would let a
      // credit + discount drop the charge below shipping+insurance). See B2.
      creditAmountPence = Math.min(pricePerCard, discountedSubtotal);
      creditApplied = true;
      creditTypeApplied = ct;
    }
  }

  const total = Math.max(0, discountedSubtotal - creditAmountPence + totals.shipping + totals.totalInsuranceFee);

  return {
    pricePerCard,
    quantity,
    subtotalPence,
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
    shipping: totals.shipping,
    totalInsuranceFee: totals.totalInsuranceFee,
    insuranceSurchargePerCard: totals.insuranceSurchargePerCard,
    shippingLabel: totals.shippingLabel,
    insuranceSurchargeLabel: totals.insuranceSurchargeLabel,
    total,
    promoCodeValid,
    promoCodeReason,
    promoCodeApplied,
    promoCodeId,
    promoCode: promoCodeStr,
    promoCodePercent: codePercent,
  };
}
