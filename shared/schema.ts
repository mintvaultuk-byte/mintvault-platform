import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, decimal, serial, boolean, numeric, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const BUILD_STAMP = "MV-P5-20260225-nohalf";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: varchar("role", { length: 20 }).notNull().default("customer"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const submissions = pgTable("submissions", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  trackingNumber: text("tracking_number").notNull().unique(),
  cardCount: integer("card_count").notNull().default(0),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull().default("0"),
  totalDeclaredValue: integer("total_declared_value").notNull().default(0),
  paymentIntentId: text("payment_intent_id"),
  paymentStatus: varchar("payment_status", { length: 20 }).notNull().default("unpaid"),
  paymentAmount: decimal("payment_amount", { precision: 10, scale: 2 }),
  paymentCurrency: varchar("payment_currency", { length: 3 }).default("GBP"),
  paymentTimestamp: timestamp("payment_timestamp"),
  shippingTrackingNumber: text("shipping_tracking_number"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  checkoutSessionId: text("checkout_session_id"),
  customerEmail: text("customer_email"),
  customerFirstName: text("customer_first_name"),
  customerLastName: text("customer_last_name"),
  phone: text("phone"),
  returnAddressLine1: text("return_address_line1"),
  returnAddressLine2: text("return_address_line2"),
  returnCity: text("return_city"),
  returnCounty: text("return_county"),
  returnPostcode: text("return_postcode"),
  serviceType: text("service_type"),
  serviceTier: text("service_tier"),
  turnaroundDays: integer("turnaround_days"),
  shippingCost: integer("shipping_cost").default(0),
  shippingInsuranceTier: text("shipping_insurance_tier"),
  gradingCost: integer("grading_cost").default(0),
  notes: text("notes"),
  receivedAt: timestamp("received_at"),
  shippedAt: timestamp("shipped_at"),
  completedAt: timestamp("completed_at"),
  returnCarrier: text("return_carrier"),
  returnTracking: text("return_tracking"),
  returnPostageCost: integer("return_postage_cost"),
  termsAccepted: boolean("terms_accepted").default(false),
  termsAcceptedAt: timestamp("terms_accepted_at"),
  termsVersion: text("terms_version"),
});

export const submissionItems = pgTable("submission_items", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull(),
  cardIndex: integer("card_index").notNull().default(0),
  game: text("game"),
  cardSet: text("card_set"),
  cardName: text("card_name"),
  cardNumber: text("card_number"),
  year: text("year"),
  declaredValue: integer("declared_value").default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tiers = pgTable("tiers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  pricePerCard: decimal("price_per_card", { precision: 10, scale: 2 }).notNull(),
  turnaroundWorkingDays: integer("turnaround_working_days").notNull(),
  declaredValueCap: integer("declared_value_cap").notNull(),
  features: text("features").default("[]"),
  requiresSeniorReview: boolean("requires_senior_review").notNull().default(false),
  requiresDualVerification: boolean("requires_dual_verification").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
});

export const cards = pgTable("cards", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull(),
  tierId: integer("tier_id").notNull(),
  internalId: text("internal_id").notNull().unique(),
  cardName: text("card_name").notNull(),
  cardSet: text("card_set").notNull(),
  cardNumber: text("card_number"),
  cardVariant: text("card_variant"),
  year: integer("year").notNull(),
  declaredValue: integer("declared_value").notNull(),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  assignedGraderId: varchar("assigned_grader_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  notes: text("notes"),
});

export const certificates = pgTable("certificates", {
  id: serial("id").primaryKey(),
  cardId: integer("card_id"),
  submissionItemId: integer("submission_item_id"),
  nfcUid: text("nfc_uid"),
  nfcEnabled: boolean("nfc_enabled").default(false),
  nfcChipType: text("nfc_chip_type"),
  nfcUrl: text("nfc_url"),
  nfcLocked: boolean("nfc_locked").default(false),
  nfcWrittenAt: timestamp("nfc_written_at"),
  nfcLockedAt: timestamp("nfc_locked_at"),
  nfcLastVerifiedAt: timestamp("nfc_last_verified_at"),
  nfcWrittenBy: text("nfc_written_by"),
  nfcScanCount: integer("nfc_scan_count").default(0),
  nfcLastScanAt: timestamp("nfc_last_scan_at"),
  nfcLastScanIp: text("nfc_last_scan_ip"),
  certId: text("certificate_number").notNull().unique(),
  gradeOverall: decimal("grade", { precision: 4, scale: 1 }),
  gradeCentering: decimal("centering_score", { precision: 4, scale: 1 }),
  gradeCorners: decimal("corners_score", { precision: 4, scale: 1 }),
  gradeEdges: decimal("edges_score", { precision: 4, scale: 1 }),
  gradeSurface: decimal("surface_score", { precision: 4, scale: 1 }),
  status: varchar("status", { length: 10 }).notNull().default("active"),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
  replacedByCertId: integer("replaced_by_cert_id"),
  integrityHash: text("integrity_hash"),
  issuedByUserId: varchar("issued_by_user_id"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("issued_at").notNull().defaultNow(),
  certSeq: integer("cert_seq"),
  qrPayloadUrl: text("qr_payload_url"),
  labelType: text("label_type").notNull().default("Standard"),
  gradeType: text("grade_type").notNull().default("numeric"),
  cardGame: text("card_game"),
  setName: text("set_name"),
  cardName: text("card_name"),
  cardNumber: text("card_number_display"),
  rarity: text("rarity"),
  designations: jsonb("designations").$type<string[]>().default([]),
  variant: text("variant"),
  variantOther: text("variant_other"),
  collection: text("collection"),
  collectionCode: text("collection_code"),
  collectionOther: text("collection_other"),
  rarityOther: text("rarity_other"),
  language: text("language").default("English"),
  year: text("year_text"),
  notes: text("notes"),
  frontImagePath: text("front_image_path"),
  backImagePath: text("back_image_path"),
  createdBy: text("created_by"),
  updatedAt: timestamp("updated_at").defaultNow(),
  currentOwnerUserId: varchar("current_owner_user_id"),
  ownershipStatus: varchar("ownership_status", { length: 20 }).notNull().default("unclaimed"),
  claimCodeHash: text("claim_code_hash"),
  claimCodeCreatedAt: timestamp("claim_code_created_at"),
  claimCodeUsedAt: timestamp("claim_code_used_at"),
});

export const certificateImages = pgTable("certificate_images", {
  id: serial("id").primaryKey(),
  certificateId: integer("certificate_id").notNull(),
  imageType: text("image_type").notNull(),
  url: text("url").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const cardImages = pgTable("card_images", {
  id: serial("id").primaryKey(),
  cardId: integer("card_id").notNull(),
  imageType: varchar("image_type", { length: 20 }).notNull(),
  imageUrl: text("image_url"),
  version: integer("version").notNull().default(1),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  storageKey: text("storage_key").notNull(),
});

export const cardSets = pgTable("card_sets", {
  id: serial("id").primaryKey(),
  setId: text("set_id").notNull().unique(),
  setName: text("set_name").notNull(),
  series: text("series"),
  totalCards: integer("total_cards"),
  releaseDate: text("release_date"),
  game: text("game").notNull().default("pokemon"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at"),
});

export const cardMaster = pgTable("card_master", {
  id: serial("id").primaryKey(),
  setId: text("set_id").notNull(),
  cardNumber: text("card_number").notNull(),
  cardName: text("card_name").notNull(),
  language: text("language").notNull().default("English"),
  variant: text("variant"),
  rarity: text("rarity"),
  year: text("year"),
  imageUrl: text("image_url"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at"),
  deletedBy: text("deleted_by"),
}, (t) => ({
  unqSetNumLang: uniqueIndex("uq_card_master_set_number_lang").on(t.setId, t.cardNumber, t.language),
  idxLookup: index("idx_card_master_lookup").on(t.setId, t.cardNumber, t.language),
}));

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  adminUser: text("admin_user"),
  details: jsonb("details").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CardSet = typeof cardSets.$inferSelect;
export type CardMaster = typeof cardMaster.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;

export const insertCertificateSchema = createInsertSchema(certificates).omit({
  id: true,
  certId: true,
  cardId: true,
  voidedAt: true,
  voidReason: true,
  replacedByCertId: true,
  integrityHash: true,
  issuedByUserId: true,
  deletedAt: true,
  createdAt: true,
  certSeq: true,
  qrPayloadUrl: true,
  updatedAt: true,
  nfcUid: true,
  nfcEnabled: true,
  nfcChipType: true,
  nfcUrl: true,
  nfcLocked: true,
  nfcWrittenAt: true,
  nfcLockedAt: true,
  nfcLastVerifiedAt: true,
  nfcWrittenBy: true,
  nfcScanCount: true,
  nfcLastScanAt: true,
  nfcLastScanIp: true,
  currentOwnerUserId: true,
  ownershipStatus: true,
  claimCodeHash: true,
  claimCodeCreatedAt: true,
  claimCodeUsedAt: true,
});

export const insertCertificateImageSchema = createInsertSchema(certificateImages).omit({
  id: true,
});

export type User = typeof users.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type SubmissionItem = typeof submissionItems.$inferSelect;
export type CertificateRecord = typeof certificates.$inferSelect;
export type InsertCertificate = z.infer<typeof insertCertificateSchema>;
export type CertificateImage = typeof certificateImages.$inferSelect;
export type InsertCertificateImage = z.infer<typeof insertCertificateImageSchema>;

// ── Label printing — isolated tracking table ───────────────────────────────────
export const labelPrints = pgTable("label_prints", {
  id:        serial("id").primaryKey(),
  certId:    text("cert_id").notNull().unique(),
  sheetRef:  text("sheet_ref"),
  queuedAt:  timestamp("queued_at").notNull().defaultNow(),
  printedAt: timestamp("printed_at"),
});

export type LabelPrint = typeof labelPrints.$inferSelect;
export const insertLabelPrintSchema = createInsertSchema(labelPrints).omit({ id: true, queuedAt: true });
export type InsertLabelPrint = z.infer<typeof insertLabelPrintSchema>;

// ── Label overrides — edit display fields without touching the certificate ─────
export const labelOverrides = pgTable("label_overrides", {
  id:                serial("id").primaryKey(),
  certId:            text("cert_id").notNull().unique(),
  cardNameOverride:  text("card_name_override"),
  setOverride:       text("set_override"),
  variantOverride:   text("variant_override"),
  languageOverride:  text("language_override"),
  yearOverride:      text("year_override"),
  editedAt:          timestamp("edited_at").notNull().defaultNow(),
});

export type LabelOverride = typeof labelOverrides.$inferSelect;
export const insertLabelOverrideSchema = createInsertSchema(labelOverrides).omit({ id: true, editedAt: true });
export type InsertLabelOverride = z.infer<typeof insertLabelOverrideSchema>;

// ── Reprint log — tracks every single-label reprint without affecting printed flag ──
export const reprintLog = pgTable("reprint_log", {
  id:          serial("id").primaryKey(),
  certId:      text("cert_id").notNull(),
  reprintTime: timestamp("reprint_time").notNull().defaultNow(),
});

export type ReprintLog = typeof reprintLog.$inferSelect;

// ── Ownership history — tracks every claim and transfer event ─────────────────
export const ownershipHistory = pgTable("ownership_history", {
  id:          serial("id").primaryKey(),
  certId:      text("cert_id").notNull(),
  fromUserId:  varchar("from_user_id"),
  toUserId:    varchar("to_user_id").notNull(),
  toEmail:     text("to_email"),
  eventType:   text("event_type").notNull(),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type OwnershipHistoryRecord = typeof ownershipHistory.$inferSelect;

// ── Claim verifications — email verification tokens for ownership claims ──────
export const claimVerifications = pgTable("claim_verifications", {
  id:          serial("id").primaryKey(),
  certId:      text("cert_id").notNull(),
  email:       text("email").notNull(),
  tokenHash:   text("token_hash").notNull(),
  expiresAt:   timestamp("expires_at").notNull(),
  usedAt:      timestamp("used_at"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type ClaimVerification = typeof claimVerifications.$inferSelect;

export const OWNERSHIP_STATUSES = ["unclaimed", "claimed", "transfer_pending"] as const;
export type OwnershipStatus = typeof OWNERSHIP_STATUSES[number];

export const NUMERIC_GRADES = [
  { value: 10, label: "GEM MT", description: "Gem Mint" },
  { value: 9, label: "MINT", description: "Mint" },
  { value: 8, label: "NM-MT", description: "Near Mint-Mint" },
  { value: 7, label: "NM", description: "Near Mint" },
  { value: 6, label: "EX-MT", description: "Excellent-Mint" },
  { value: 5, label: "EX", description: "Excellent" },
  { value: 4, label: "VG-EX", description: "Very Good-Excellent" },
  { value: 3, label: "VG", description: "Very Good" },
  { value: 2, label: "GOOD", description: "Good" },
  { value: 1, label: "PR", description: "Poor" },
] as const;

export const NON_NUMERIC_GRADES = [
  { value: "NO", label: "AUTHENTIC", description: "Authentic Only" },
  { value: "AA", label: "AUTHENTIC ALTERED", description: "Authentic Altered" },
] as const;

export function isNonNumericGrade(gradeType: string): boolean {
  return gradeType === "NO" || gradeType === "AA";
}

export function gradeLabel(grade: number): string {
  const g = Math.round(grade);
  if (g >= 10) return "GEM MT";
  if (g >= 9) return "MINT";
  if (g >= 8) return "NM-MT";
  if (g >= 7) return "NM";
  if (g >= 6) return "EX-MT";
  if (g >= 5) return "EX";
  if (g >= 4) return "VG-EX";
  if (g >= 3) return "VG";
  if (g >= 2) return "GOOD";
  if (g >= 1) return "PR";
  return "";
}

export function gradeLabelFull(gradeType: string, gradeOverall: string): string {
  if (gradeType === "NO") return "AUTHENTIC";
  if (gradeType === "AA") return "AUTHENTIC ALTERED";
  return gradeLabel(parseFloat(gradeOverall));
}

export const serviceTiers = pgTable("service_tiers", {
  id: serial("id").primaryKey(),
  serviceType: text("service_type").notNull(),
  name: text("name").notNull(),
  tierId: text("tier_id").notNull(),
  pricePerCard: integer("price_per_card").notNull(),
  turnaroundDays: integer("turnaround_days").notNull(),
  turnaroundLabel: text("turnaround_label"),
  maxValueGbp: integer("max_value_gbp").notNull(),
  features: text("features").array().default([]),
  isActive: boolean("is_active").default(true),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type ServiceTierRecord = typeof serviceTiers.$inferSelect;

export function serviceTierToPricingTier(st: ServiceTierRecord): PricingTier {
  const priceGbp = st.pricePerCard / 100;
  return {
    id: st.tierId,
    name: st.name,
    price: `£${priceGbp % 1 === 0 ? priceGbp : priceGbp.toFixed(2)} per card`,
    pricePerCard: st.pricePerCard,
    recommendedCardValue: `Up to £${st.maxValueGbp.toLocaleString()}`,
    turnaround: st.turnaroundLabel || `${st.turnaroundDays} working days`,
    features: st.features || [],
    serviceType: st.serviceType,
  };
}

export interface PricingTier {
  id: string;
  name: string;
  price: string;
  pricePerCard: number;
  recommendedCardValue: string;
  turnaround: string;
  features: string[];
  serviceType?: string;
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
  frontImageUrl: string | null;
  backImageUrl: string | null;
  gradedDate: string;
  notes: string | null;
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
  "new", "received", "in_grading", "ready_to_return", "shipped", "completed",
] as const;

export type SubmissionStatus = typeof SUBMISSION_STATUSES[number];

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
  { minQty: 10, maxQty: 24, percent: 3, label: "10–24 cards" },
  { minQty: 25, maxQty: 49, percent: 5, label: "25–49 cards" },
  { minQty: 50, maxQty: 99, percent: 7, label: "50–99 cards" },
  { minQty: 100, maxQty: null, percent: 10, label: "100+ cards" },
];

export function getBulkDiscountPercent(quantity: number): number {
  for (let i = bulkDiscountTiers.length - 1; i >= 0; i--) {
    if (quantity >= bulkDiscountTiers[i].minQty) {
      return bulkDiscountTiers[i].percent;
    }
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
  const discountAmount = Math.round(subtotal * discountPercent / 100);
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
    subtotal, discountPercent, discountAmount, discountedSubtotal,
    shipping, shippingLabel,
    insuranceSurchargePerCard, totalInsuranceFee, insuranceSurchargeLabel,
    declaredValuePerCard,
    total,
  };
}

export const pricingTiers: PricingTier[] = [
  {
    id: "basic",
    name: "BASIC",
    price: "£12 per card",
    pricePerCard: 1200,
    recommendedCardValue: "Up to £500",
    turnaround: "60 working days",
    features: [
      "Professional grading assessment",
      "Tamper-evident precision slab",
      "Online order tracking",
      "Fully insured return shipping (based on declared value)",
    ],
  },
  {
    id: "standard",
    name: "STANDARD",
    price: "£15 per card",
    pricePerCard: 1500,
    recommendedCardValue: "Up to £500",
    turnaround: "20 working days",
    features: [
      "Professional grading assessment",
      "Priority grading queue",
      "Tamper-evident precision slab",
      "Online order tracking",
      "Fully insured return shipping (based on declared value)",
    ],
  },
  {
    id: "premier",
    name: "PREMIER",
    price: "£18 per card",
    pricePerCard: 1800,
    recommendedCardValue: "Up to £1,500",
    turnaround: "10 working days",
    features: [
      "Professional grading assessment",
      "Fast-track grading queue",
      "Detailed grader notes included",
      "Tamper-evident precision slab",
      "Online order tracking",
      "Fully insured return shipping (based on declared value)",
    ],
  },
  {
    id: "ultra",
    name: "ULTRA",
    price: "£25 per card",
    pricePerCard: 2500,
    recommendedCardValue: "Up to £3,000",
    turnaround: "5 working days",
    features: [
      "Senior grader review",
      "Priority fast-track handling",
      "Detailed grader notes included",
      "High-resolution front & back imaging",
      "Tamper-evident precision slab",
      "Online verification & tracking",
      "Fully insured return shipping (based on declared value)",
    ],
  },
  {
    id: "elite",
    name: "ELITE",
    price: "£50 per card",
    pricePerCard: 5000,
    recommendedCardValue: "Up to £7,500",
    turnaround: "2 working days",
    features: [
      "Immediate priority grading queue",
      "Senior grader + secondary verification review",
      "Detailed grader notes included",
      "High-resolution front & back imaging",
      "Population report inclusion",
      "Tamper-evident precision slab",
      "Online certification verification",
      "Fully insured return shipping (based on declared value)",
    ],
  },
];
