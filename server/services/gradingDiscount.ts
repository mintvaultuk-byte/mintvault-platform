/**
 * gradingDiscount.ts — the grading-checkout discount resolver, extracted verbatim
 * from the /api/create-payment-intent handler so it is a single, testable unit.
 *
 * This is the ONE place the charged grading discount is decided. The route in
 * server/routes/submissions.ts calls resolveGradingDiscount() with the
 * server-resolved percents (vault-club, bulk, promo) and applies the result by
 * reducing the PaymentIntent amount. Behaviour is identical to the prior inline
 * code — same rounding, same winner selection, same labels.
 *
 *   best_of (default): charge the single LOWEST final price across
 *     {vault-club, bulk, promo} — i.e. the largest discount amount wins.
 *   stack_on_top: better-of(vault-club, bulk) first, then promo compounded on
 *     the reduced subtotal, floored so the price can never go below £0.
 *
 * All money is integer PENCE.
 */

export type GradingStackingMode = "best_of" | "stack_on_top";

export interface GradingDiscountInput {
  /** pricePerCard × quantity, in pence. */
  subtotalPence: number;
  /** Vault-club discount % (0 if not a member / not logged in). */
  vcPercent: number;
  /** Bulk discount % for the quantity (getBulkDiscountPercent). */
  bulkPercent: number;
  /** Active promo % for this tier (0 if none / not grading / tier has no promo). */
  promoPercent: number;
  /** The active promo's stacking mode (irrelevant when promoPercent is 0). */
  promoStackingMode: GradingStackingMode;
}

export interface GradingDiscountResult {
  /** Pence taken off the subtotal. */
  effectiveDiscountAmount: number;
  /** Headline % of the winning method (or combined %, for stack_on_top). */
  effectiveDiscountPercent: number;
  /** Winning method label: vault_club_silver | bulk | promo | *+promo | null. */
  discountType: string | null;
  /** subtotalPence − effectiveDiscountAmount. */
  discountedSubtotal: number;
  /** True when the promo contributed to the charge. */
  promoApplied: boolean;
}

export function resolveGradingDiscount(input: GradingDiscountInput): GradingDiscountResult {
  const { subtotalPence, vcPercent, bulkPercent, promoPercent, promoStackingMode } = input;

  // Discount amounts for each method, on the same subtotal base.
  const vcAmt = Math.round((subtotalPence * vcPercent) / 100);
  const bulkAmt = Math.round((subtotalPence * bulkPercent) / 100);
  const promoAmt = Math.round((subtotalPence * promoPercent) / 100);

  let effectiveDiscountAmount: number;
  let effectiveDiscountPercent: number;
  let discountType: string | null;

  if (promoPercent > 0 && promoStackingMode === "stack_on_top") {
    // Better-of(vault-club, bulk) FIRST, then promo compounded on the
    // reduced subtotal. Floored so the price can never go below £0.
    const baseAmt = Math.max(vcAmt, bulkAmt);
    const afterBase = subtotalPence - baseAmt;
    const promoOnTop = Math.round((afterBase * promoPercent) / 100);
    effectiveDiscountAmount = Math.min(subtotalPence, baseAmt + promoOnTop);
    effectiveDiscountPercent = subtotalPence > 0 ? Math.round((effectiveDiscountAmount / subtotalPence) * 100) : 0;
    const baseLabel = vcPercent >= bulkPercent && vcPercent > 0 ? "vault_club_silver" : bulkPercent > 0 ? "bulk" : null;
    discountType = baseLabel ? `${baseLabel}+promo` : "promo";
  } else {
    // best_of (default + the locked vault-club/bulk rule): the single
    // LOWEST final price across {vault-club, bulk, promo}. Same subtotal
    // base → largest discount amount wins.
    effectiveDiscountAmount = Math.max(vcAmt, bulkAmt, promoAmt);
    if (promoPercent > 0 && promoAmt >= vcAmt && promoAmt >= bulkAmt) {
      discountType = "promo";
      effectiveDiscountPercent = promoPercent;
    } else if (vcPercent >= bulkPercent && vcPercent > 0) {
      discountType = "vault_club_silver";
      effectiveDiscountPercent = vcPercent;
    } else if (bulkPercent > 0) {
      discountType = "bulk";
      effectiveDiscountPercent = bulkPercent;
    } else {
      discountType = null;
      effectiveDiscountPercent = 0;
    }
  }

  const promoApplied = discountType !== null && discountType.includes("promo");
  const discountedSubtotal = subtotalPence - effectiveDiscountAmount;

  return { effectiveDiscountAmount, effectiveDiscountPercent, discountType, discountedSubtotal, promoApplied };
}
