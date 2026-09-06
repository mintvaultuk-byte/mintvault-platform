/**
 * Commerce + submission-status vocabulary — the client-safe half of the barrel.
 *
 * Extracted from shared/schema.ts for the SAME reason as
 * shared/grade-presentation.ts: that barrel holds ~40 `pgTable(...)` calls,
 * which are side-effectful module-scope expressions a bundler cannot tree-shake.
 * One value import from it — `pages/home.tsx` taking `pricingTiers`, in a page
 * `App.tsx` loads EAGERLY — shipped every internal database column name to
 * every unauthenticated visitor in the entry chunk.
 *
 * Nothing here touches Drizzle, the database, or the MVGS scoring engine. It is
 * pricing, insurance, bulk-discount and submission-status presentation: values
 * the browser has always been entitled to, and which are published on the
 * pricing page anyway. Re-exported from shared/schema.ts so the many server
 * call sites are unchanged.
 *
 * `serviceTierToPricingTier` deliberately did NOT move: it consumes a Drizzle
 * row type, so it belongs with the schema. It imports `PricingTier` from here
 * as a TYPE, which is erased at compile time and adds no runtime edge.
 */

export interface PricingTier {
  id: string;
  name: string;
  price: string;
  pricePerCard: number;
  recommendedCardValue: string;
  turnaround: string;
  turnaroundDays?: number;
  features: string[];
  serviceType?: string;
}

export function formatTierPrice(pricePerCard: number): string {
  const pounds = pricePerCard / 100;
  return `£${pricePerCard % 100 === 0 ? pounds : pounds.toFixed(2)} per card`;
}

/** Camel-case Admin wire fields; timestamps are intentionally not client inputs. */
export interface ServiceTierAdminRow {
  id: number;
  serviceType: string;
  tierId: string;
  name: string;
  pricePerCard: number;
  turnaroundDays: number;
  turnaroundLabel: string | null;
  maxValueGbp: number;
  features: string[] | null;
  isActive: boolean | null;
  sortOrder: number | null;
}

/** Live public projection, not a quote or authority to choose a charge amount. */
export interface LivePricingTier extends PricingTier {
  serviceType: string;
  turnaroundDays: number;
  capacityStatus: string;
  capacityPausedUntil: string | null;
  capacityMessage: string | null;
}

export interface PublicCertificate {
  certId: string;
  status: string;
  gradeType: string;
  cardGame: string;
  cardName: string;
  cardSet: string;
  cardYear: string;
  cardNumber: string;
  rarity: string | null;
  rarityLabel: string | null;
  designations: string[];
  variant: string | null;
  collection: string | null;
  language: string;
  grade: string;
  gradeNumeric: number;
  gradeCentering: string | null;
  gradeCorners: string | null;
  gradeEdges: string | null;
  gradeSurface: string | null;
  // MVGS — admin-computed score 0–100, set on grade approval. Null when
  // gradeType !== "numeric" or when the cert was approved before MVGS
  // existed. UI gates rendering on both fields.
  gradeStrengthScore: number | null;
  labelType: string;
  /** Pristine 10P / black-label, derived live from the MVGS gate (isPristine),
   *  NOT the stored label_type flag. Single source of truth for display. */
  isBlackLabel: boolean;
  frontImageUrl: string | null;
  backImageUrl: string | null;
  gradedDate: string;
  notes: string | null;
  nfcEnabled: boolean | null;
  nfcScanCount: number | null;
  ownershipStatus: string;
  ownershipRef: string | null;
  gradingReport: { centering?: string; corners?: string; edges?: string; surface?: string; overall?: string } | null;
  isOwnedByViewer: boolean;
  // Stolen flag — null for unflagged certs, "reported_stolen" once a stolen
  // report has been verified. Drives the red banner on cert-detail.tsx.
  stolenStatus: string | null;
}

export interface PopulationData {
  lowerCount: number;
  sameCount: number;
  higherCount: number;
  totalCount: number;
  authenticOnlyCount: number;
  authenticAlteredCount: number;
  gradeDistribution: { grade: number; count: number }[];
}

export const SUBMISSION_STATUSES = [
  "new",
  "received",
  "in_grading",
  "ready_to_return",
  "shipped",
  "completed",
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  new: "New",
  paid: "Paid",
  received: "Received",
  in_grading: "In Grading",
  ready_to_return: "Ready to Return",
  shipped: "Shipped",
  completed: "Completed",
};

export const SUBMISSION_STATUS_TRANSITIONS: Record<string, string> = {
  new: "received",
  paid: "received",
  received: "in_grading",
  in_grading: "ready_to_return",
  ready_to_return: "shipped",
  shipped: "completed",
};

export const submissionTypes = [
  { id: "grading", name: "Grading", description: "Professional card grading and encapsulation" },
  { id: "reholder", name: "Reholder", description: "Transfer your card to a new MintVault slab" },
  { id: "crossover", name: "Crossover", description: "Re-grade a card from another grading company" },
  { id: "authentication", name: "Authentication", description: "Verify the authenticity of your card" },
];

export interface BulkDiscountTier {
  minQty: number;
  maxQty: number | null;
  percent: number;
  label: string;
}

export const bulkDiscountTiers: BulkDiscountTier[] = [
  { minQty: 1, maxQty: 9, percent: 0, label: "1–9 cards" },
  { minQty: 10, maxQty: 24, percent: 5, label: "10–24 cards" },
  { minQty: 25, maxQty: 49, percent: 7.5, label: "25–49 cards" },
  { minQty: 50, maxQty: null, percent: 10, label: "50+ cards" },
];

export function getBulkDiscountPercent(quantity: number): number {
  for (let i = bulkDiscountTiers.length - 1; i >= 0; i--) {
    if (quantity >= bulkDiscountTiers[i].minQty) {
      return bulkDiscountTiers[i].percent;
    }
  }
  return 0;
}

// Vault Club grading discount — Silver tier only. Mutually exclusive with
// bulk discount; server applies max(vc, bulk) and ties go to vc.
export const VAULT_CLUB_SILVER_DISCOUNT_PERCENT = 10;

export function getVaultClubDiscountPercent(
  tier: string | null | undefined,
  status: string | null | undefined
): number {
  if (tier === "silver" && (status === "active" || status === "trialing")) {
    return VAULT_CLUB_SILVER_DISCOUNT_PERCENT;
  }
  return 0;
}

export interface InsuranceTier {
  maxValue: number;
  shippingPence: number;
  label: string;
}

export const insuranceTiers: InsuranceTier[] = [
  { maxValue: 500, shippingPence: 499, label: "Up to £500 cover" },
  { maxValue: 1500, shippingPence: 999, label: "Up to £1,500 cover" },
  { maxValue: 3000, shippingPence: 1499, label: "Up to £3,000 cover" },
  { maxValue: 7500, shippingPence: 2499, label: "Up to £7,500 cover" },
];

export function getInsuranceTier(totalDeclaredValue: number): InsuranceTier {
  for (const tier of insuranceTiers) {
    if (totalDeclaredValue <= tier.maxValue) return tier;
  }
  return insuranceTiers[insuranceTiers.length - 1];
}

export interface InsuranceSurchargeBand {
  maxValue: number;
  surchargePence: number;
  label: string;
}

export const insuranceSurchargeBands: InsuranceSurchargeBand[] = [
  { maxValue: 500, surchargePence: 0, label: "No surcharge" },
  { maxValue: 1500, surchargePence: 200, label: "+£2 per card" },
  { maxValue: 3000, surchargePence: 500, label: "+£5 per card" },
  { maxValue: 7500, surchargePence: 1000, label: "+£10 per card" },
];

export function getInsuranceSurchargePerCard(declaredValuePerCard: number): InsuranceSurchargeBand {
  for (const band of insuranceSurchargeBands) {
    if (declaredValuePerCard <= band.maxValue) return band;
  }
  return insuranceSurchargeBands[insuranceSurchargeBands.length - 1];
}

export function calculateOrderTotals(pricePerCard: number, quantity: number, totalDeclaredValue: number = 0) {
  const subtotal = pricePerCard * quantity;
  const discountPercent = getBulkDiscountPercent(quantity);
  const discountAmount = Math.round((subtotal * discountPercent) / 100);
  const discountedSubtotal = subtotal - discountAmount;
  const insurance = getInsuranceTier(totalDeclaredValue);
  const shipping = insurance.shippingPence;
  const shippingLabel = insurance.label;

  const declaredValuePerCard = quantity > 0 ? Math.ceil(totalDeclaredValue / quantity) : 0;
  const surchargeInfo = getInsuranceSurchargePerCard(declaredValuePerCard);
  const insuranceSurchargePerCard = surchargeInfo.surchargePence;
  const totalInsuranceFee = insuranceSurchargePerCard * quantity;
  const insuranceSurchargeLabel = surchargeInfo.label;

  const total = discountedSubtotal + shipping + totalInsuranceFee;
  return {
    subtotal,
    discountPercent,
    discountAmount,
    discountedSubtotal,
    shipping,
    shippingLabel,
    insuranceSurchargePerCard,
    totalInsuranceFee,
    insuranceSurchargeLabel,
    declaredValuePerCard,
    total,
  };
}

export const pricingTiers: PricingTier[] = [
  {
    id: "standard",
    name: "VAULT QUEUE",
    price: "£19 per card",
    pricePerCard: 1900,
    recommendedCardValue: "Any value",
    turnaround: "40 working days",
    turnaroundDays: 40,
    features: [
      "Professional grade assessment (1–10 scale)",
      "Subgrade breakdown (centering, corners, edges, surface)",
      "Tamper-evident NFC-enabled precision slab",
      "Unique online-verifiable certificate",
      "Claim code for ownership registration",
      "Insured Royal Mail return shipping",
    ],
  },
  {
    id: "priority",
    name: "STANDARD",
    price: "£25 per card",
    pricePerCard: 2500,
    recommendedCardValue: "Any value",
    turnaround: "15 working days",
    turnaroundDays: 15,
    features: [
      "Professional grade assessment (1–10 scale)",
      "Subgrade breakdown (centering, corners, edges, surface)",
      "Tamper-evident NFC-enabled precision slab",
      "Unique online-verifiable certificate",
      "Claim code for ownership registration",
      "Insured Royal Mail return shipping",
    ],
  },
  {
    id: "express",
    name: "EXPRESS",
    price: "£45 per card",
    pricePerCard: 4500,
    recommendedCardValue: "Any value",
    turnaround: "5 working days",
    turnaroundDays: 5,
    features: [
      "Professional grade assessment (1–10 scale)",
      "Subgrade breakdown (centering, corners, edges, surface)",
      "Tamper-evident NFC-enabled precision slab",
      "Unique online-verifiable certificate",
      "Claim code for ownership registration",
      "Insured Royal Mail return shipping",
    ],
  },
];
