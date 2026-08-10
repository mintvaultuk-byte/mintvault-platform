/**
 * Partner grading-credit packages — the SERVER-AUTHORITATIVE price list.
 *
 * Owner-locked commercial decision: 1 Partner grading credit = £10, sold in four prepaid packages.
 *
 * The single rule this module exists to enforce: a browser may name a PACKAGE, and nothing else.
 * It may never send a price, a credit quantity, or a tenant id and have any of them believed. Every
 * caller therefore takes a `packageId` and resolves the credits and the amount HERE, server-side.
 * `findCreditPackage` returns undefined for anything not in this table, so a forged or retired id is
 * refused rather than defaulted — there is deliberately no fallback package.
 *
 * Money is integer PENCE. No floats anywhere in the pricing path: `1000 * 10` is exact, `10.00 * 10`
 * is not, and Stripe's API is denominated in the minor unit regardless.
 *
 * These are prepaid credits, not a subscription. The ledger stays append-only — buying a package
 * appends one positive row (entry_type 'purchase', source 'stripe'); it never edits a balance.
 */

export interface PartnerCreditPackage {
  /** Opaque, stable id. This is the ONLY package field a client is allowed to send. */
  id: string;
  /** Whole grading credits granted on successful payment. */
  credits: number;
  /** Total charge in pence. Must equal credits * PARTNER_CREDIT_UNIT_PRICE_PENCE. */
  pricePence: number;
  /** Shown in the portal and on the Stripe line item. */
  label: string;
}

/** £10 per grading credit. Owner-locked. */
export const PARTNER_CREDIT_UNIT_PRICE_PENCE = 1000;

export const PARTNER_CREDIT_CURRENCY = "gbp" as const;

/**
 * The four launch packages. Ordered smallest-first for display; the portal renders this array
 * directly so it cannot drift from what the server will actually charge.
 */
export const PARTNER_CREDIT_PACKAGES: readonly PartnerCreditPackage[] = [
  { id: "credits-10", credits: 10, pricePence: 10_000, label: "10 grading credits" },
  { id: "credits-25", credits: 25, pricePence: 25_000, label: "25 grading credits" },
  { id: "credits-50", credits: 50, pricePence: 50_000, label: "50 grading credits" },
  { id: "credits-100", credits: 100, pricePence: 100_000, label: "100 grading credits" },
] as const;

/**
 * Resolve a client-supplied package id.
 *
 * Returns undefined for an unknown id — callers MUST treat that as a refusal (400) and must never
 * substitute a default. This is the boundary that stops package/price forgery.
 */
export function findCreditPackage(packageId: unknown): PartnerCreditPackage | undefined {
  if (typeof packageId !== "string" || packageId.length === 0) return undefined;
  return PARTNER_CREDIT_PACKAGES.find((p) => p.id === packageId);
}

/**
 * Internal consistency guard, asserted by tests rather than trusted.
 *
 * Every package must price at exactly the unit rate — a typo that made 100 credits cost £100 would
 * otherwise be a silent 90% discount that no type check would catch.
 */
export function creditPackagePricingIsConsistent(): boolean {
  return PARTNER_CREDIT_PACKAGES.every(
    (p) =>
      Number.isSafeInteger(p.credits) &&
      Number.isSafeInteger(p.pricePence) &&
      p.credits > 0 &&
      p.pricePence === p.credits * PARTNER_CREDIT_UNIT_PRICE_PENCE
  );
}

/**
 * The ledger idempotency key for a Stripe-funded top-up.
 *
 * uq_partner_credit_ledger_idem is UNIQUE (source, idempotency_key) and is NOT tenant-scoped, so
 * this key must be globally unique across every tenant. A Stripe event id satisfies that, and keying
 * on the EVENT means a redelivery of the same event collapses onto the same ledger row —
 * appendFoundationCredit then reports alreadyApplied and no second credit is minted.
 */
export function stripeCreditLedgerIdempotencyKey(stripeEventId: string): string {
  return `stripe-evt:${stripeEventId}`;
}
