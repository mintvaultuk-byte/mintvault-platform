import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  timestamp,
  decimal,
  serial,
  boolean,
  numeric,
  uniqueIndex,
  index,
  jsonb,
  bigint,
  customType,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { mvgsTierName } from "./mvgs-scoring";

/**
 * pgvector column type — drizzle-orm doesn't ship a first-class pgvector
 * helper as of 0.39.x. We declare it via customType: pg returns vector
 * values as the literal string "[0.123,0.456,...]" and accepts the same
 * format on insert, so toDriver/fromDriver just bridge that to a JS
 * number[]. Dimension is fixed at 1536 to match OpenAI text-embedding-3-small.
 *
 * Phase 0 of the RAG workstream — populated by the hourly embed-corpus
 * job (server/jobs/embed-corpus.ts), read by future similarity-search
 * code that does NOT exist yet.
 */
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return "[" + value.join(",") + "]";
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/[\[\]]/g, "")
      .split(",")
      .map(Number);
  },
});

/**
 * ── Certificate-ID naming convention ────────────────────────────────────────
 *
 * Primary `certificates` table stores the MV business id (e.g. "MV141") in the
 * column named `certificate_number` (historical name — line 202). All other
 * tables referencing a certificate use column `cert_id` (FK shorthand, same
 * string value). Drizzle exposes both as the TS field `certId`, so app code is
 * uniform; raw SQL sees the split.
 *
 * Tables with `cert_id` column: label_prints, label_overrides, reprint_log,
 * ownership_history, claim_verifications, transfer_verifications, stolen_reports,
 * marketplace_listings, marketplace_orders.
 *
 * Note: `replaced_by_cert_id` (certificates table, line 211) is an INTEGER FK
 * to certificates.id, NOT the MV string. Name is misleading — it's a row ref.
 */

export const BUILD_STAMP = "MV-P5-20260225-nohalf";

export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: varchar("role", { length: 20 }).notNull().default("customer"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // Account auth fields — base fields from migrateAccountSchema(); Phase 1
  // hardening columns from migrations/add-auth-security-hardening-phase1.sql.
  passwordHash: text("password_hash"),
  displayName: text("display_name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerifiedAt: timestamp("email_verified_at"),
  lastLoginAt: timestamp("last_login_at"),
  lastLoginIp: text("last_login_ip"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until"),
  lastFailedLoginAt: timestamp("last_failed_login_at"),
  credentialVersion: integer("credential_version").notNull().default(1),
  adminPassphraseHash: text("admin_passphrase_hash"),
  // PIN auth (v1 launch) — separate lockout state from password above so
  // cert-owner PIN failures don't share counters with account-holder password.
  pinHash: text("pin_hash"),
  pinSetAt: timestamp("pin_set_at"),
  pinFailedCount: integer("pin_failed_count").notNull().default(0),
  pinLockedUntil: timestamp("pin_locked_until"),
  // Public-name toggle (per-user). When true AND PUBLIC_NAME_TOGGLE_LIVE=true
  // AND displayName is non-empty, surfaces displayName on /api/v1/verify/:certId
  // for certs this user owns. Default false (anonymous).
  //
  // NOTE: distinct from `ownership_history.public_name` (per-event toggle)
  // which is dormant in v1 — the gated render path at routes.ts:2950 stays
  // anonymous regardless of either column. Per-event consent UX deferred.
  publicName: boolean("public_name").notNull().default(false),
  // ── Staff capability flags (migrateStaffCapabilitiesSchema) ────────────────
  // Unify staff into ONE account + capability toggles. role stays
  // customer/admin/staff; these booleans say which tools a staffer may use.
  // ADMIN implicitly has all capabilities (never gated on these flags).
  canGrade: boolean("can_grade").notNull().default(false),
  canScan: boolean("can_scan").notNull().default(false),
  canPrint: boolean("can_print").notNull().default(false),
  canEditSets: boolean("can_edit_sets").notNull().default(false),
  // ── Per-operator review rate (migratePerOperatorSchema) — Phase 0 ──────────
  // % of this operator's grades requiring manual review. Starts 100 (every card
  // reviewed) and is dialled DOWN as the operator earns trust (Phase 4 reads it).
  reviewRate: integer("review_rate").notNull().default(100),
});

export type User = typeof users.$inferSelect;

// ── Auth token tables ─────────────────────────────────────────────────────────

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const accountMagicLinkTokens = pgTable("account_magic_link_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const customerMagicLinkTokens = pgTable("customer_magic_link_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const loginAttempts = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  ip: text("ip").notNull(),
  success: boolean("success").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Customer contact-form inbox. Every /help/contact submission writes a row
// here BEFORE the Resend send attempt — guarantees the message survives
// even if email delivery fails. email_sent_at is set on Resend success;
// email_error captures the failure message for triage. Soft-delete only.
export const contactInquiries = pgTable("contact_inquiries", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  topic: text("topic").notNull(),
  message: text("message").notNull(),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  emailSentAt: timestamp("email_sent_at"),
  emailError: text("email_error"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  deletedAt: timestamp("deleted_at"),
});

export type ContactInquiry = typeof contactInquiries.$inferSelect;
export const CONTACT_TOPICS = [
  "submission",
  "grading",
  "cert-vault",
  "ownership",
  "returns-shipping",
  "payment",
  "other",
] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

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
  // Carrier-confirmed delivery time, distinct from `completedAt` (which is
  // an admin operational state, not a delivery confirmation). Today this is
  // set manually by an admin via POST /api/admin/submissions/:id/mark-
  // delivered as a stopgap; later it will be set automatically by the Royal
  // Mail Tracking API polling. Nullable; null = not confirmed delivered.
  deliveredAt: timestamp("delivered_at"),
  completedAt: timestamp("completed_at"),
  returnCarrier: text("return_carrier"),
  // Carrier service-level key, paired with returnCarrier. Values live in
  // shared/carriers.ts (e.g. "tracked_48", "tracked_24", "special_delivery",
  // "dpd_classic", "dpd_next_day", "dpd_1200", "evri_standard",
  // "evri_next_day"). NULL when carrier === "other" or when the submission
  // pre-dates the dispatch-service-tracking change. The source of truth for
  // the key set is shared/carriers.ts, not this column.
  returnService: text("return_service"),
  returnTracking: text("return_tracking"),
  returnPostageCost: integer("return_postage_cost"),
  termsAccepted: boolean("terms_accepted").default(false),
  termsAcceptedAt: timestamp("terms_accepted_at"),
  termsVersion: text("terms_version"),
  revealWrap: boolean("reveal_wrap").default(false),
  // Marketing-feature consent — opt-in checkbox on the submit form. NEVER
  // pre-checked. Withdraw is per-submission or global from /account-settings;
  // every change writes an audit_log row.
  marketingFeatureConsent: boolean("marketing_feature_consent").notNull().default(false),
  marketingFeatureConsentAt: timestamp("marketing_feature_consent_at", { withTimezone: true }),
  // ── Restricted-grader assignment (migrateGraderSchema) ────────────────────
  // A submission can be assigned to a single grader (users.id, role='grader').
  // grading_status drives the workflow: unassigned → assigned → pending_review
  // → approved. The actual grade still lives on the linked certificate; these
  // columns track WHO may grade it and WHERE it is in review. Columns are added
  // idempotently at boot; see server/grader.ts migrateGraderSchema().
  assignedGraderId: varchar("assigned_grader_id"),
  gradingStatus: varchar("grading_status", { length: 20 }).notNull().default("unassigned"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  gradedAt: timestamp("graded_at", { withTimezone: true }),
  // ── Scanner assignment (migrateScanSchema) — NEW columns, do NOT reuse the
  // dead v1 grader columns above (slated for drop). A physical box = a
  // submission; admin assigns it to a can_scan staffer to photograph its cards.
  scanAssignedTo: varchar("scan_assigned_to"),
  scanStatus: varchar("scan_status", { length: 20 }).notNull().default("unassigned"),
  scanAssignedAt: timestamp("scan_assigned_at", { withTimezone: true }),
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
  declaredNew: boolean("declared_new").default(false),
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
  // ── Structured Pokémon rarity/variant (Phase 1 — additive, all nullable) ──────
  // Each concept is stored SEPARATELY here instead of crammed into the flat
  // `variant` column above. Every column is nullable with no default, so existing
  // rows stay valid and current writers are unaffected. The legacy `variant` /
  // `variant_other` / `rarity` columns remain the historical source of truth and
  // are never overwritten by this foundation. `language` reuses the existing
  // column above (no duplicate added). Populated only by the future structured
  // picker (not wired yet). Bounded CHECK constraints on the small, stable enums
  // (symbol colour/count, region, era) live in
  // migrations/add-structured-rarity-columns.sql.
  rarityCode: text("rarity_code"),
  rarityLabelStructured: text("rarity_label"),
  printedSymbol: text("printed_symbol"),
  printedSymbolCount: integer("printed_symbol_count"),
  printedSymbolColour: text("printed_symbol_colour"),
  finishVariant: text("finish_variant"),
  promoType: text("promo_type"),
  subsetName: text("subset_name"),
  region: text("region"),
  era: text("era"),
  structuredVariantVersion: integer("structured_variant_version"),
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
  // Stored ownership token — unique per ownership event, replaced on transfer
  ownershipToken: text("ownership_token"),
  ownershipTokenGeneratedAt: timestamp("ownership_token_generated_at"),
  // Owner name and email — captured at claim/transfer time
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  // Grading report — per-subgrade commentary filled in by the grader
  gradingReport: jsonb("grading_report")
    .$type<{
      centering?: string;
      corners?: string;
      edges?: string;
      surface?: string;
      overall?: string;
    }>()
    .default({}),
  // AI-assisted grading fields
  aiAnalysis: jsonb("ai_analysis").$type<Record<string, unknown>>().default({}),
  aiDraftGrade: decimal("ai_draft_grade", { precision: 3, scale: 1 }),
  centeringFrontLr: text("centering_front_lr"),
  centeringFrontTb: text("centering_front_tb"),
  centeringBackLr: text("centering_back_lr"),
  centeringBackTb: text("centering_back_tb"),
  // Crop pipeline forensics (Phase Y convergence). Nullable; populated on
  // every scan-ingest or admin CaptureWizard upload. Does NOT feed grade
  // calculation — the centering grade remains AI-driven via centering_inner_*.
  cropGeometry: jsonb("crop_geometry").$type<{
    front?: {
      pre_padding_px: { top: number; bottom: number; left: number; right: number };
      post_asymmetry_px: { horizontal: number; vertical: number };
      extended: boolean;
    } | null;
    back?: {
      pre_padding_px: { top: number; bottom: number; left: number; right: number };
      post_asymmetry_px: { horizontal: number; vertical: number };
      extended: boolean;
    } | null;
    pipeline_version?: string;
    recorded_at?: string;
  } | null>(),
  // Defect type matches the actual flat storage shape. Earlier declaration
  // had `position?: {x_percent, y_percent}` (nested) but every writer (admin
  // image-viewer, AI grader, scan-ingest) stores x_percent/y_percent as
  // direct properties. Type-only fix; data already flat in DB, no migration.
  defects: jsonb("defects")
    .$type<
      Array<{
        id?: number;
        type: string;
        severity: "minor" | "moderate" | "significant" | string;
        description: string;
        location: string;
        image_side?: "front" | "back";
        x_percent?: number;
        y_percent?: number;
      }>
    >()
    .default([]),
  aiDefects: jsonb("ai_defects")
    .$type<Array<{ type: string; severity: string; x: number; y: number; description: string }>>()
    .default([]),
  // MVGS-classified defect array. Two write paths feed this column:
  //   1. Legacy: server/routes.ts auto-promotes ai_defects on grade approval
  //      (shape: {type, severity, x, y, description}) — MVGS fields absent.
  //   2. New: admin grading UI writes the classified shape with
  //      {id, mvgsCode, tier, zone, x_percent, y_percent} — MVGS fields present.
  // MVGS fields are therefore typed optional so both shapes validate; the
  // scoring engine only looks at pins where mvgsCode + tier + zone are all set.
  verifiedDefects: jsonb("verified_defects")
    .$type<
      Array<{
        // Legacy fields (preserved for backwards compat — never remove).
        type?: string;
        severity?: string;
        x?: number;
        y?: number;
        // MVGS fields — present on new classified pins.
        id?: string;
        mvgsCode?:
          | "WH"
          | "CH"
          | "FR"
          | "SC"
          | "SP"
          | "PI"
          | "PL"
          | "PS"
          | "SV"
          | "ST"
          | "GL"
          | "CR"
          | "RD"
          | "DG"
          | "OC";
        tier?: "D1" | "D2" | "D3";
        zone?:
          | "FA"
          | "FH"
          | "FB"
          | "FC1"
          | "FC2"
          | "FC3"
          | "FC4"
          | "FE1"
          | "FE2"
          | "FE3"
          | "FE4"
          | "BA"
          | "BB"
          | "BC1"
          | "BC2"
          | "BC3"
          | "BC4"
          | "BE1"
          | "BE2"
          | "BE3"
          | "BE4";
        x_percent?: number;
        y_percent?: number;
        description?: string;
      }>
    >()
    .default([]),
  gradeApprovedBy: text("grade_approved_by"),
  gradeApprovedAt: timestamp("grade_approved_at"),
  // ── Restricted-grader assignment, CERT-LEVEL (migrateGraderCertSchema) ─────
  // Grader v2 re-grains assignment from submissions → certificates so each card
  // in a multi-card submission is graded/locked independently. The v1
  // submissions.assigned_grader_id/grading_status columns are now DEAD (left in
  // place, to be dropped later). Workflow: unassigned → assigned → pending_review
  // → approved; reject bounces pending_review → assigned (rejection_reason +
  // redo_count++).
  assignedGraderId: varchar("assigned_grader_id"),
  // Column is grader_status (NOT grading_status): certificates ALREADY has a
  // pre-existing grading_status='submitted' workflow column (routes.ts Build 6)
  // owned by another feature — the grader system uses its OWN column so it never
  // clobbers that one.
  graderStatus: varchar("grader_status", { length: 20 }).notNull().default("unassigned"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  gradedAt: timestamp("graded_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  redoCount: integer("redo_count").notNull().default(0),
  // ── Per-operator grading pipeline (migratePerOperatorSchema) — Phase 0 ─────
  // All nullable + UN-backfillable: captured at action-time (scan / submit) from
  // Phase 1/3 onward; existing inventory stays NULL (forward-only). Phase 0 adds
  // the columns ONLY — nothing reads or writes them yet.
  scannedBy: varchar("scanned_by"), // operator user id who scanned the card
  gradedBy: varchar("graded_by"), // operator who graded (distinct from grade_approved_by = reviewer)
  operatorGrade: decimal("operator_grade"), // operator's submitted overall grade, snapshot at submit
  operatorSubgrades: jsonb("operator_subgrades").$type<{
    centering?: number;
    corners?: number;
    edges?: number;
    surface?: number;
  }>(), // operator's submitted subgrade snapshot at submit
  reviewRequired: boolean("review_required"), // set by sampling at submit (Phase 4)
  // Admin-controlled marketing-pool flag. Distinct from
  // submissions.marketing_feature_consent (user opt-in, legal record) —
  // this column gates the weekly-reel pool regardless of consent state.
  // Toggled via /api/admin/weekly-reel/card/:certNumber/featured.
  marketingFeatured: boolean("marketing_featured").notNull().default(false),
  marketingFeaturedAt: timestamp("marketing_featured_at", { withTimezone: true }),
  // Pinned certs always appear first in the weekly reel regardless of
  // grade/sort order. Blacklisted certs are excluded from the pool
  // permanently. Both are admin-only and set via /admin/weekly-reel.
  marketingPinned: boolean("marketing_pinned").notNull().default(false),
  marketingBlacklisted: boolean("marketing_blacklisted").notNull().default(false),
  // Time spent in admin grading UI between open and approve, in seconds.
  // Captured client-side, capped at 1800s (30 min) server-side to filter
  // coffee-break sessions out of the dashboard average.
  gradingTimeSeconds: integer("grading_time_seconds"),
  // Stolen card flag — set to "stolen" when a verified report exists; null otherwise
  stolenStatus: text("stolen_status"), // null | "reported_stolen"
  stolenReportedAt: timestamp("stolen_reported_at"),
  // Document Reference Number — plaintext, shown only on Owner Copy PDF
  referenceNumber: text("reference_number").unique(),
  // Logbook version — increments on each owner PDF generation for V5C-style reissue tracking
  logbookVersion: integer("logbook_version").notNull().default(1),
  logbookLastIssuedAt: timestamp("logbook_last_issued_at"),
  // Cold-archive timestamp: set once the cert's R2 image artefacts have
  // been copied to B2 (Backblaze, Compliance-locked 90 days). NULL until
  // archival completes successfully. R2 originals are NOT deleted in
  // phase 1; tier-down or eviction is a separate phase. See
  // server/workers/r2-to-b2-archival.ts.
  archivedToB2At: timestamp("archived_to_b2_at"),
  // DVLA-parity: first keeper declaration — set at initial claim time only
  declaredNew: boolean("declared_new").notNull().default(false),
  // Grading pipeline R2 keys — per-side, per-variant. These are populated by
  // scan-ingest / upload-images and read by /recrop, /reprocess-images, and
  // /api/admin/certificates/:id/images. Without these in the schema, Drizzle
  // returns undefined for `c.gradingFrontOriginal` etc., and recrop falls
  // through to `c.frontImagePath` — i.e. the already-cropped display image,
  // not the raw scanner buffer.
  gradingFrontOriginal: text("grading_front_original"),
  gradingFrontCropped: text("grading_front_cropped"),
  gradingFrontGreyscale: text("grading_front_greyscale"),
  gradingFrontHighcontrast: text("grading_front_highcontrast"),
  gradingFrontEdgeenhanced: text("grading_front_edgeenhanced"),
  gradingFrontInverted: text("grading_front_inverted"),
  gradingBackOriginal: text("grading_back_original"),
  gradingBackCropped: text("grading_back_cropped"),
  gradingBackGreyscale: text("grading_back_greyscale"),
  gradingBackHighcontrast: text("grading_back_highcontrast"),
  gradingBackEdgeenhanced: text("grading_back_edgeenhanced"),
  gradingBackInverted: text("grading_back_inverted"),
  // 1600px q80 display derivatives for the grading-panel viewer — the full-res
  // cropped scans (multi-MB) stay as the zoom/manual-tool source; the viewer
  // loads these instead. Null on certs predating the derivative pipeline; the
  // images endpoint falls back to the cropped key.
  gradingFrontDisplay: text("grading_front_display"),
  gradingBackDisplay: text("grading_back_display"),
  // Grading commentary + scoring metadata. All exist in the live DB but were
  // missing from the schema — same gap-class as the grading_* columns above.
  // Without these, raw-SQL writes succeed but Drizzle reads return undefined,
  // so the values never round-trip on cert load.
  gradeExplanation: text("grade_explanation"),
  // grade_strength_score doubles as the MVGS (MintVault Grading Standard)
  // score 0–100. Written by the admin grading-panel "Approve" path via the
  // pure scoring helper in server/mvgs-scoring.ts.
  gradeStrengthScore: integer("grade_strength_score"),
  // MVGS inputs — admin-set per cert. dark_border_front / dark_border_back
  // each boost the WH (whitening) ×1.25 edge multiplier on their own side.
  // Legacy dark_border column is preserved for backwards compat and now
  // mirrors (dark_border_front OR dark_border_back) on save.
  // eye_appeal_modifier is the ±2 finishing adjustment applied after all
  // deductions.
  darkBorder: boolean("dark_border").notNull().default(false),
  darkBorderFront: boolean("dark_border_front").notNull().default(false),
  darkBorderBack: boolean("dark_border_back").notNull().default(false),
  eyeAppealModifier: integer("eye_appeal_modifier").notNull().default(0),
  // ── MVGS v2 measurement inputs (Phase 2) ────────────────────────────────
  // Persisted per cert from the grading-workstation line tool + severity
  // pickers. Engine (shared/mvgs-scoring.ts) accepts these as optional
  // MvgsInput fields; shared/mvgs-input-builder.ts handles precedence
  // (measurement OVERRIDES the legacy has_crease/has_tear booleans on
  // surface_values). NULL / [] = no v2 measurement for that category;
  // legacy boolean fallback (if set) applies via the input builder.
  // Migration: migrations/add-mvgs-v2-measurements.sql (staging only).
  whiteningLines: jsonb("whitening_lines")
    .$type<
      Array<{
        id?: string;
        side: "front" | "back";
        edge: "top" | "right" | "bottom" | "left";
        coveragePct: number;
        // Display-only: operator's actual drawn segment, image-relative %
        // (0..100). Engine ignores it (reads only coveragePct); kept so the
        // marked line redraws exactly where drawn. Extra jsonb keys round-trip
        // with no migration; optional → rows saved before this field fall back
        // to the legacy corner-stub indicator.
        start?: { x: number; y: number };
        end?: { x: number; y: number };
        // Display-only line colour (v2.1) — stripped at the mvgs-input-builder
        // boundary so the engine never sees it. Aligns with creaseLines.
        color?: string;
      }>
    >()
    .notNull()
    .default([]),
  // Legacy single-crease % — kept as a derived mirror of max(crease_lines.spanPct)
  // for back-compat (readers that haven't migrated to crease_lines still see
  // the worst span). New writes go through crease_lines.
  creaseSpanPct: decimal("crease_span_pct", { precision: 4, scale: 1 }),
  // MVGS v2 multi-crease persistence (Phase 2.1). Operator can mark multiple
  // creases per cert; each entry stores the actual drawn segment so the line
  // redraws on reload. Engine input derives `creaseSpanPct = max(spanPct)`
  // across all entries (longest crease wins per spec §4/§5 — strictest cap,
  // no compounding). `color` is display-only — stripped at the
  // mvgs-input-builder boundary so the engine never sees it.
  creaseLines: jsonb("crease_lines")
    .$type<
      Array<{
        id: string;
        side: "front" | "back";
        spanPct: number;
        start: { x: number; y: number };
        end: { x: number; y: number };
        color?: string;
      }>
    >()
    .notNull()
    .default([]),
  wrinkleSeverity: text("wrinkle_severity").$type<
    "tiny_back" | "longer_back" | "small_front" | "multiple_front" | null
  >(),
  tearSeverity: text("tear_severity").$type<"minor" | "significant" | "major" | null>(),
  centeringOuterFront: jsonb("centering_outer_front").$type<{
    top_pct: number;
    left_pct: number;
    right_pct: number;
    bottom_pct: number;
  } | null>(),
  centeringOuterBack: jsonb("centering_outer_back").$type<{
    top_pct: number;
    left_pct: number;
    right_pct: number;
    bottom_pct: number;
  } | null>(),
  centeringInnerFront: jsonb("centering_inner_front").$type<{
    top_pct: number;
    left_pct: number;
    right_pct: number;
    bottom_pct: number;
  } | null>(),
  centeringInnerBack: jsonb("centering_inner_back").$type<{
    top_pct: number;
    left_pct: number;
    right_pct: number;
    bottom_pct: number;
  } | null>(),
  centeringMethod: text("centering_method"),
  // AI defect-candidate suggestions surfaced by the Haiku scan-time defect
  // pass. Admin confirms or rejects each candidate; confirmed ones move to
  // the `defects` array. Distinct column so the candidate list survives
  // independent of the persisted defects.
  aiDefectCandidates: jsonb("ai_defect_candidates").$type<
    Array<{
      type: string;
      severity: "minor" | "moderate" | "significant";
      description: string;
      location: string;
      image_side: string;
      x_percent: number;
      y_percent: number;
    }>
  >(),
  // Per-zone grading values. corner_values / edge_values / surface_values
  // already exist in DB; these schema entries surface them via Drizzle so
  // the GET /grading endpoint can return them on cert reload. Same gap-class
  // as the v406 grading_* fix — values were being written by raw-SQL PUTs
  // but never came back out via db.select(). Result: per-zone dropdowns
  // reset to zeros on every page reload, even when data was saved.
  cornerValues: jsonb("corner_values").$type<{
    frontTL: number;
    frontTR: number;
    frontBL: number;
    frontBR: number;
    backTL: number;
    backTR: number;
    backBL: number;
    backBR: number;
  } | null>(),
  edgeValues: jsonb("edge_values").$type<{
    frontTop: number;
    frontBottom: number;
    frontLeft: number;
    frontRight: number;
    backTop: number;
    backBottom: number;
    backLeft: number;
    backRight: number;
  } | null>(),
  surfaceValues: jsonb("surface_values").$type<{
    front: number;
    back: number;
    hasPrintLines?: boolean;
    hasHoloScratches?: boolean;
    hasSurfaceScratches?: boolean;
    hasStaining?: boolean;
    hasIndentation?: boolean;
    hasRollerMarks?: boolean;
    hasColorRegistration?: boolean;
    hasCrease?: boolean;
    hasTear?: boolean;
  } | null>(),
  // ── RAG Phase 0: passive embedding for future retrieval ─────────────────
  // Populated by the hourly embed-corpus cron over the existing approved
  // corpus. embedded_at = NULL means "not yet embedded"; non-null is the
  // timestamp of the last successful embed. Re-embedding on model change
  // is a future op (set embedded_at = NULL to re-queue).
  embedding: vector1536("embedding"),
  embeddedAt: timestamp("embedded_at", { withTimezone: true }),
  // TCGdex canonical card ID (e.g. "SV5K-075"). Populated by card-lookup.
  externalCardId: text("external_card_id"),
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

export const cardMaster = pgTable(
  "card_master",
  {
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
  },
  (t) => ({
    unqSetNumLang: uniqueIndex("uq_card_master_set_number_lang").on(t.setId, t.cardNumber, t.language),
    idxLookup: index("idx_card_master_lookup").on(t.setId, t.cardNumber, t.language),
  })
);

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  adminUser: text("admin_user"),
  details: jsonb("details").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Pending set lookups (TCGdex card-lookup queue) ────────────────────────
// Written when a TCGdex-confirmed set is not in custom_sets and auto-add is
// OFF. Admin reviews the queue and adds manually. status: pending | resolved.
export const pendingSetLookups = pgTable("pending_set_lookups", {
  id: serial("id").primaryKey(),
  printedCode: text("printed_code").notNull(),
  cardNumber: text("card_number").notNull(),
  language: text("language").notNull().default("en"),
  certId: text("cert_id"),
  status: text("status").notNull().default("pending"),
  tcgdexData: jsonb("tcgdex_data").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
});

export type PendingSetLookup = typeof pendingSetLookups.$inferSelect;

// ── Community wall posts ──────────────────────────────────────────────────
// Backs /community (public gallery) + /admin/community (moderation). Manual
// admin adds auto-approve; status="rejected" serves as soft-delete. Image
// lives in R2 (community/{id}.jpg). Audit-logged on every status change.
export const communityPosts = pgTable(
  "community_posts",
  {
    id: serial("id").primaryKey(),
    certNumber: text("cert_number").references(() => certificates.certId),
    instagramHandle: text("instagram_handle"),
    instagramPostUrl: text("instagram_post_url"),
    imageR2Key: text("image_r2_key").notNull(),
    cardName: text("card_name"),
    grade: numeric("grade", { precision: 4, scale: 1 }),
    status: text("status").notNull().default("pending"),
    featured: boolean("featured").notNull().default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("idx_community_posts_status").on(t.status),
    certIdx: index("idx_community_posts_cert").on(t.certNumber),
  })
);

export type CommunityPostRecord = typeof communityPosts.$inferSelect;

// ── MVGS compliance interest (public form capture) ────────────────────────
// Backs POST /api/mvgs/interest. Append-only; no auth, no public read.
export const mvgsInterest = pgTable("mvgs_interest", {
  id: serial("id").primaryKey(),
  company: text("company").notNull(),
  email: text("email").notNull(),
  message: text("message"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Weekly-reel pipeline settings (key/value JSON, admin-editable) ─────────
// Generic store for every dial on /admin/weekly-reel (schedule, selection
// rules, video style, output, notifications). Defaults live in
// server/lib/pipeline-settings.ts; rows here are admin overrides only.
export const pipelineSettings = pgTable("pipeline_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

// ── Weekly-reel analytics (per-run record) ─────────────────────────────────
// One row per reel run, populated by server/jobs/weekly-reel.ts after each
// generation. Drives the analytics dashboard (running total cost +
// per-week bar chart). Cost is in USD; Segmind list price is captured at
// run time so historical rows stay accurate after price changes.
export const reelAnalytics = pgTable("reel_analytics", {
  id: serial("id").primaryKey(),
  reelDate: text("reel_date").notNull(),
  cardCount: integer("card_count"),
  successCount: integer("success_count"),
  failCount: integer("fail_count"),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 4 }),
  model: text("model"),
  clipLengthSeconds: integer("clip_length_seconds"),
  // Social-publishing metadata. Populated when the operator publishes the
  // reel to a channel. Insights backfilled via /refresh-insights.
  instagramPostId: text("instagram_post_id"),
  facebookPostId: text("facebook_post_id"),
  instagramLikes: integer("instagram_likes"),
  instagramViews: integer("instagram_views"),
  instagramReach: integer("instagram_reach"),
  instagramComments: integer("instagram_comments"),
  tiktokPostId: text("tiktok_post_id"),
  thumbnailR2Key: text("thumbnail_r2_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Per-card approval rows (created when require_card_approval is on) ─────
// One row per (reel_date, cert_number). Reel publishing is held until every
// row in a given reel_date is approved=true (or the operator triggers the
// approve-all endpoint).
export const reelCardApprovals = pgTable(
  "reel_card_approvals",
  {
    id: serial("id").primaryKey(),
    reelDate: text("reel_date").notNull(),
    certNumber: text("cert_number").notNull(),
    approved: boolean("approved").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDateCert: uniqueIndex("idx_reel_card_approvals_date_cert").on(t.reelDate, t.certNumber),
  })
);

// ── AI feature toggles (DB-backed, runtime-flippable) ─────────────────────
// One row per env-var flag from server/config/feature-flags.ts. The DB row
// overrides the env-var default at runtime. Absence of a row means "use env
// default". Cleared via DELETE to revert.
export const featureOverrides = pgTable("feature_overrides", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  reason: text("reason"),
});

// ── AI prediction history (append-only, queryable per call) ───────────────
// Every Claude/GPT call writes a row here on success. Used by the AI Learning
// dashboard for accuracy + cost analytics, and as the future RAG corpus.
export const aiPredictions = pgTable(
  "ai_predictions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    certId: text("cert_id").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version"),
    callType: text("call_type").notNull(), // "identify" | "defect_suggest" | "quick_grade" | "full_grade" | "centering" | ...
    prediction: jsonb("prediction").notNull(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costGbp: numeric("cost_gbp", { precision: 8, scale: 5 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    certCallIdx: index("ai_predictions_cert_call_idx").on(t.certId, t.callType),
    createdIdx: index("ai_predictions_created_idx").on(t.createdAt),
  })
);

// Founding-member homepage waitlist (replaces the old stats trio CTA).
// Soft-delete only (deleted_at) per project rules. Email is normalised
// case-insensitively at the index level.
export const waitlistSignups = pgTable("waitlist_signups", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  source: text("source").notNull().default("homepage_founding_member"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export type CardSet = typeof cardSets.$inferSelect;
export type CardMaster = typeof cardMaster.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type WaitlistSignup = typeof waitlistSignups.$inferSelect;

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

export type Submission = typeof submissions.$inferSelect;
export type SubmissionItem = typeof submissionItems.$inferSelect;
export type CertificateRecord = typeof certificates.$inferSelect;
export type InsertCertificate = z.infer<typeof insertCertificateSchema>;
export type CertificateImage = typeof certificateImages.$inferSelect;
export type InsertCertificateImage = z.infer<typeof insertCertificateImageSchema>;

// ── Structured-rarity legacy mapping review queue (Phase 1 — data only) ─────────
// The admin-facing queue for confirming how each historical flat `variant` value
// maps onto the structured catalogue. Populated later from the read-only audit
// (shared/rarity-legacy-audit.ts); NOTHING here rewrites a certificate. Each row
// is one distinct legacy value with a proposed classification/mapping the admin
// can approve / reject / ignore. No approval UI yet — data structure only.
export const REVIEW_STATUSES = ["pending", "approved", "rejected", "ignored"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const rarityMappingReviews = pgTable(
  "rarity_mapping_reviews",
  {
    id: serial("id").primaryKey(),
    // The historical value as stored in certificates.variant (e.g. "REVERSE_HOLO").
    legacyValue: text("legacy_value").notNull(),
    // Proposed target: rarity | finish | promo | subset | ambiguous.
    proposedClassification: text("proposed_classification"),
    // Proposed canonical catalogue value (null when ambiguous / needs a human).
    proposedValue: text("proposed_value"),
    // high | medium | low.
    confidence: text("confidence"),
    // Plain-English reason for the proposal.
    reason: text("reason"),
    // Snapshot of how many certificates carried this value at audit time.
    recordCount: integer("record_count").notNull().default(0),
    // Whether a human must confirm before this mapping could ever be applied.
    reviewRequired: boolean("review_required").notNull().default(true),
    // pending | approved | rejected | ignored. Nothing is ever auto-applied.
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uqLegacyValue: uniqueIndex("uq_rarity_mapping_reviews_legacy_value").on(t.legacyValue),
    idxStatus: index("idx_rarity_mapping_reviews_status").on(t.status),
  })
);

export const insertRarityMappingReviewSchema = createInsertSchema(rarityMappingReviews).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type RarityMappingReview = typeof rarityMappingReviews.$inferSelect;
export type InsertRarityMappingReview = z.infer<typeof insertRarityMappingReviewSchema>;

// ── Pokémon Knowledge Engine (additive — migrations/add-pokemon-knowledge.sql) ──
// Canonical SET knowledge lives here (companion to tcgdex_sets/custom_sets,
// keyed by normalised set_key — the tcgdex re-import UPSERT clobbers its own
// rows, so founder-verified knowledge must never live in importer-owned
// columns). Rarities/finishes/promos/languages/eras stay in the ONE shared
// catalogue (shared/pokemon-rarity-catalogue.ts) — no duplicate tables.

export const pokemonSetKnowledge = pgTable(
  "pokemon_set_knowledge",
  {
    id: serial("id").primaryKey(),
    setKey: text("set_key").notNull(), // normalised code — join key to tcgdex/custom sets
    language: text("language").notNull().default("en"),
    canonicalName: text("canonical_name").notNull(),
    localName: text("local_name"),
    translatedName: text("translated_name"),
    setCode: text("set_code"),
    altCode: text("alt_code"),
    abbreviation: text("abbreviation"),
    series: text("series"),
    era: text("era"), // same vocabulary as certificates.era CHECK
    region: text("region"), // same vocabulary as certificates.region CHECK
    releaseDate: text("release_date"),
    year: text("year"),
    announcedCount: integer("announced_count"),
    mainCount: integer("main_count"),
    secretCount: integer("secret_count"),
    collectorNumberFormat: text("collector_number_format"),
    parentSetKey: text("parent_set_key"), // regional-equivalent relationship (loose)
    symbolNote: text("symbol_note"),
    symbolAssetKey: text("symbol_asset_key"),
    sourceType: text("source_type").notNull().default("unknown"),
    sourceReference: text("source_reference"),
    verifiedDate: text("verified_date"),
    confidence: text("confidence").notNull().default("low"),
    status: text("status").notNull().default("provisional"),
    archived: boolean("archived").notNull().default(false),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqKeyLang: uniqueIndex("uq_pokemon_set_knowledge_key_lang").on(t.setKey, t.language),
    idxStatus: index("idx_pokemon_set_knowledge_status").on(t.status),
    idxEra: index("idx_pokemon_set_knowledge_era").on(t.era),
    idxName: index("idx_pokemon_set_knowledge_name").on(t.canonicalName),
  })
);

export const pokemonSetAliases = pgTable(
  "pokemon_set_aliases",
  {
    id: serial("id").primaryKey(),
    setKey: text("set_key").notNull(),
    language: text("language").notNull().default("en"),
    aliasType: text("alias_type").notNull(), // printed_code | ptcgo | jp_english_name | market_name | translated_name | other
    aliasValue: text("alias_value").notNull(), // normalised
    sourceType: text("source_type").notNull().default("community"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqAlias: uniqueIndex("uq_pokemon_set_aliases_value").on(t.aliasType, t.aliasValue, t.language),
    idxSetKey: index("idx_pokemon_set_aliases_set_key").on(t.setKey),
  })
);

export const pokemonKnowledgeRevisions = pgTable(
  "pokemon_knowledge_revisions",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(), // 'set' | 'alias' | future kinds
    entityKey: text("entity_key").notNull(), // "<set_key>:<language>"
    revisionNumber: integer("revision_number").notNull(),
    oldValue: jsonb("old_value").$type<Record<string, unknown> | null>(),
    newValue: jsonb("new_value").$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    sourceType: text("source_type"),
    editedBy: text("edited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqRevision: uniqueIndex("uq_pokemon_knowledge_revisions").on(t.entityType, t.entityKey, t.revisionNumber),
    idxEntity: index("idx_pokemon_knowledge_revisions_entity").on(t.entityType, t.entityKey),
  })
);

export const pokemonImportRuns = pgTable(
  "pokemon_import_runs",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // manual | starter_seed | csv | json | tcgdex
    sourceReference: text("source_reference"),
    status: text("status").notNull().default("draft"), // draft | approved | rejected | applied
    payload: jsonb("payload").$type<unknown[]>().notNull().default([]),
    recordsTotal: integer("records_total").notNull().default(0),
    recordsAdded: integer("records_added").notNull().default(0),
    recordsChanged: integer("records_changed").notNull().default(0),
    conflicts: jsonb("conflicts").$type<unknown[]>().notNull().default([]),
    startedBy: text("started_by"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxStatus: index("idx_pokemon_import_runs_status").on(t.status),
  })
);

export const pokemonReviewQueue = pgTable(
  "pokemon_review_queue",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    entityType: text("entity_type").notNull().default("set"),
    entityKey: text("entity_key").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    importRunId: integer("import_run_id"),
    status: text("status").notNull().default("pending"), // pending | approved | rejected | ignored
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    idxStatus: index("idx_pokemon_review_queue_status").on(t.status),
    idxEntity: index("idx_pokemon_review_queue_entity").on(t.entityType, t.entityKey),
  })
);

export type PokemonSetKnowledge = typeof pokemonSetKnowledge.$inferSelect;
export type InsertPokemonSetKnowledge = typeof pokemonSetKnowledge.$inferInsert;
export type PokemonSetAlias = typeof pokemonSetAliases.$inferSelect;
export type PokemonKnowledgeRevision = typeof pokemonKnowledgeRevisions.$inferSelect;
export type PokemonImportRun = typeof pokemonImportRuns.$inferSelect;
export type PokemonReviewQueueItem = typeof pokemonReviewQueue.$inferSelect;

// ── AI Card Identification (additive — migrations/add-card-identification-analytics.sql) ──
// Non-PII correction analytics + multi-machine idempotency ledger. Never stores
// card images, customer data, cert numbers, or provider chain-of-thought.
export const cardIdentificationCorrections = pgTable(
  "card_identification_corrections",
  {
    id: serial("id").primaryKey(),
    requestId: text("request_id").notNull(),
    field: text("field").notNull(),
    suggestedValue: text("suggested_value"),
    decision: text("decision").notNull(), // accepted | rejected | changed
    correctedValue: text("corrected_value"),
    confidenceBand: text("confidence_band"),
    setKey: text("set_key"),
    era: text("era"),
    language: text("language"),
    provider: text("provider"),
    model: text("model"),
    actor: text("actor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxField: index("idx_card_id_corrections_field").on(t.field),
    idxCreated: index("idx_card_id_corrections_created").on(t.createdAt),
    idxRequest: index("idx_card_id_corrections_request").on(t.requestId),
  }),
);

export const cardIdentificationRequests = pgTable(
  "card_identification_requests",
  {
    id: serial("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    certId: text("cert_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    actor: text("actor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqKey: uniqueIndex("uq_card_id_requests_key").on(t.idempotencyKey),
    idxCreated: index("idx_card_id_requests_created").on(t.createdAt),
  }),
);

export type CardIdentificationCorrection = typeof cardIdentificationCorrections.$inferSelect;
export type CardIdentificationRequest = typeof cardIdentificationRequests.$inferSelect;

// ── Label printing — isolated tracking table ───────────────────────────────────
export const labelPrints = pgTable("label_prints", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull().unique(),
  sheetRef: text("sheet_ref"),
  queuedAt: timestamp("queued_at").notNull().defaultNow(),
  printedAt: timestamp("printed_at"),
});

export type LabelPrint = typeof labelPrints.$inferSelect;
export const insertLabelPrintSchema = createInsertSchema(labelPrints).omit({ id: true, queuedAt: true });
export type InsertLabelPrint = z.infer<typeof insertLabelPrintSchema>;

// ── Label overrides — edit display fields without touching the certificate ─────
export const labelOverrides = pgTable("label_overrides", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull().unique(),
  cardNameOverride: text("card_name_override"),
  setOverride: text("set_override"),
  variantOverride: text("variant_override"),
  languageOverride: text("language_override"),
  yearOverride: text("year_override"),
  editedAt: timestamp("edited_at").notNull().defaultNow(),
});

export type LabelOverride = typeof labelOverrides.$inferSelect;
export const insertLabelOverrideSchema = createInsertSchema(labelOverrides).omit({ id: true, editedAt: true });
export type InsertLabelOverride = z.infer<typeof insertLabelOverrideSchema>;

// ── Reprint log — tracks every single-label reprint without affecting printed flag ──
export const reprintLog = pgTable("reprint_log", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull(),
  reprintTime: timestamp("reprint_time").notNull().defaultNow(),
});

export type ReprintLog = typeof reprintLog.$inferSelect;

// ── Ownership history — tracks every claim and transfer event ─────────────────
export const ownershipHistory = pgTable("ownership_history", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull(),
  fromUserId: varchar("from_user_id"),
  toUserId: varchar("to_user_id").notNull(),
  toEmail: text("to_email"),
  eventType: text("event_type").notNull(),
  notes: text("notes"),
  publicName: boolean("public_name").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type OwnershipHistoryRecord = typeof ownershipHistory.$inferSelect;

// ── Claim verifications — email verification tokens for ownership claims ──────
export const claimVerifications = pgTable("claim_verifications", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull(),
  email: text("email").notNull(),
  ownerName: text("owner_name"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  declaredNew: boolean("declared_new").notNull().default(false),
});

export type ClaimVerification = typeof claimVerifications.$inferSelect;

// ── Transfer verifications — two-step email confirmation for ownership transfers
// Step 1: current owner confirms via ownerTokenHash
// Step 2: new owner confirms via newOwnerTokenHash → transfer completes
export const transferVerifications = pgTable("transfer_verifications", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull(),
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  // Step 1 — current owner confirmation
  ownerTokenHash: text("owner_token_hash").notNull(),
  ownerExpiresAt: timestamp("owner_expires_at").notNull(),
  ownerConfirmedAt: timestamp("owner_confirmed_at"),
  // Step 2 — new owner confirmation (generated after step 1)
  newOwnerTokenHash: text("new_owner_token_hash"),
  newOwnerExpiresAt: timestamp("new_owner_expires_at"),
  newOwnerName: text("new_owner_name"),
  // Completion
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Dispute window (v229)
  disputeDeadline: timestamp("dispute_deadline"),
  disputedAt: timestamp("disputed_at"),
  disputeReason: text("dispute_reason"),
  // ── v2 transfer flow columns ──────────────────────────────────────────────
  flowVersion: varchar("flow_version", { length: 4 }).notNull().default("v1"),
  status: varchar("transfer_status", { length: 30 }).notNull().default("pending_owner"),
  referenceNumberProvided: text("reference_number_provided"),
  outgoingKeeperUserId: varchar("outgoing_keeper_user_id"),
  incomingKeeperUserId: varchar("incoming_keeper_user_id"),
  incomingConfirmDeadline: timestamp("incoming_confirm_deadline"),
  disputedBy: varchar("disputed_by", { length: 10 }),
  finalisedAt: timestamp("finalised_at"),
  cancelledAt: timestamp("cancelled_at"),
  cancellationReason: text("cancellation_reason"),
});

export type TransferVerification = typeof transferVerifications.$inferSelect;

// v2 transfer statuses — DVLA-style flow + v435 buyer-initiated entry point
export const TRANSFER_V2_STATUSES = [
  "pending_owner", // Seller-init: outgoing keeper has initiated, awaiting their email confirmation
  "pending_incoming", // Seller-init: outgoing confirmed, awaiting incoming keeper confirmation + ref number
  "pending_owner_invited_by_buyer", // v435 buyer-init: incoming keeper has claimed via claim code; owner has 14 days to confirm or dispute
  "pending_dispute", // Both parties confirmed (or buyer-init owner confirmed); 14-day dispute window
  "completed", // Dispute window passed or skipped, transfer finalised
  "disputed", // One party raised a dispute during the window (or buyer-init owner rejected)
  "cancelled", // Cancelled by outgoing keeper
  "expired", // Token/owner-deadline expired without action — buyer-init expiry preserves original ownership (no auto-complete on owner silence)
] as const;
export type TransferV2Status = (typeof TRANSFER_V2_STATUSES)[number];

export const OWNERSHIP_STATUSES = ["unclaimed", "claimed", "transfer_pending"] as const;
export type OwnershipStatus = (typeof OWNERSHIP_STATUSES)[number];

export const NUMERIC_GRADES = [
  { value: 10, label: "GEM MT", description: "Gem Mint" },
  { value: 9.5, label: "MINT+", description: "Mint+" },
  { value: 9, label: "MINT", description: "Mint" },
  { value: 8.5, label: "NM-MT+", description: "NM-Mint+" },
  { value: 8, label: "NM-MT", description: "Near Mint-Mint" },
  { value: 7.5, label: "NM+", description: "NM+" },
  { value: 7, label: "NM", description: "Near Mint" },
  { value: 6.5, label: "EX-MT+", description: "EX-Mint+" },
  { value: 6, label: "EX-MT", description: "Excellent-Mint" },
  { value: 5.5, label: "EX+", description: "Excellent+" },
  { value: 5, label: "EX", description: "Excellent" },
  { value: 4.5, label: "VG-EX+", description: "VG-EX+" },
  { value: 4, label: "VG-EX", description: "Very Good-Excellent" },
  { value: 3.5, label: "VG+", description: "VG+" },
  { value: 3, label: "VG", description: "Very Good" },
  { value: 2.5, label: "GOOD+", description: "Good+" },
  { value: 2, label: "GOOD", description: "Good" },
  { value: 1.5, label: "FAIR", description: "Fair" },
  { value: 1, label: "PR", description: "Poor" },
] as const;

export const NON_NUMERIC_GRADES = [
  { value: "NO", label: "AUTHENTIC", description: "Authentic Only" },
  { value: "AA", label: "AUTHENTIC ALTERED", description: "Authentic Altered" },
] as const;

// The complete set of valid MVGS overall grades — whole grades 1–10 plus the
// half grades (1.5, 2.5, … 9.5). Single source of truth for grade validation
// on both client and server; derived from NUMERIC_GRADES so it can never drift.
export const NUMERIC_GRADE_VALUES: readonly number[] = NUMERIC_GRADES.map((g) => g.value);

/** True if `grade` is one of the permitted MVGS numeric grades (incl. half grades). */
export function isValidNumericGrade(grade: number): boolean {
  return Number.isFinite(grade) && NUMERIC_GRADE_VALUES.includes(grade);
}

export function isNonNumericGrade(gradeType: string): boolean {
  // Accept the legacy long-form aliases that some grade write-paths persisted
  // ("not_original" == NO / Authentic, "authentic_altered" == AA) so cert pages,
  // /verify, search, labels and PDFs classify those certs correctly. New writes
  // should use the canonical "NO"/"AA"; normalising the write-paths + a data
  // backfill is the follow-up that lets these aliases be removed again.
  return gradeType === "NO" || gradeType === "AA" || gradeType === "not_original" || gradeType === "authentic_altered";
}

export function gradeLabel(grade: number): string {
  if (grade >= 10) return "GEM MT";
  if (grade >= 9.5) return "MINT+";
  if (grade >= 9) return "MINT";
  if (grade >= 8.5) return "NM-MT+";
  if (grade >= 8) return "NM-MT";
  if (grade >= 7.5) return "NM+";
  if (grade >= 7) return "NM";
  if (grade >= 6.5) return "EX-MT+";
  if (grade >= 6) return "EX-MT";
  if (grade >= 5.5) return "EX+";
  if (grade >= 5) return "EX";
  if (grade >= 4.5) return "VG-EX+";
  if (grade >= 4) return "VG-EX";
  if (grade >= 3.5) return "VG+";
  if (grade >= 3) return "VG";
  if (grade >= 2.5) return "GOOD+";
  if (grade >= 2) return "GOOD";
  if (grade >= 1.5) return "FAIR";
  if (grade >= 1) return "PR";
  return "";
}

export function gradeLabelFull(gradeType: string, gradeOverall: string): string {
  if (gradeType === "NO" || gradeType === "not_original") return "AUTHENTIC";
  if (gradeType === "AA" || gradeType === "authentic_altered") return "AUTHENTIC ALTERED";
  // Tier NAME from the exact grade via the canonical MVGS tier table — no
  // rounding, so half grades read their TRUE tier (8.5 → "NM-MINT+", 9.5 →
  // "MINT+") and agree with the displayed number. Same source the cert page,
  // slab, PDF and logbook use. (The numeric VALUE is rendered separately by
  // callers; this returns the name only.)
  const g = parseFloat(gradeOverall);
  if (!Number.isFinite(g)) return "";
  return mvgsTierName(g).toUpperCase();
}

// ── Tier capacity gating ────────────────────────────────────────────────────
// Controls how many active submissions are allowed per tier before new orders
// are blocked. Admin can override with force_open = true.
export const tierCapacity = pgTable("tier_capacity", {
  id: serial("id").primaryKey(),
  tierSlug: text("tier_slug").notNull().unique(),
  maxActive: integer("max_active").notNull(),
  forceOpen: boolean("force_open").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TierCapacityRecord = typeof tierCapacity.$inferSelect;

// ── Certificate number allocator ────────────────────────────────────────────
// Single-row counter (id = 1) that hands out monotonic MV numbers via an atomic
// UPDATE ... RETURNING in storage.getNextCertId(). Declared here for the single
// source of truth; the table is created idempotently (CREATE TABLE IF NOT EXISTS)
// at allocation time so a fresh database self-bootstraps. Was previously created
// implicitly and invisible to the schema.
export const certCounter = pgTable("cert_counter", {
  id: integer("id").primaryKey().default(1),
  lastIssued: integer("last_issued").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ── Stolen card registry ─────────────────────────────────────────────────────
// When a card owner reports their graded card as stolen, a report is created
// with a verification token emailed to them. Once verified the certificate is
// flagged `stolen` and a red banner appears on its Vault page.
export const stolenReports = pgTable("stolen_reports", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull(), // e.g. MV1
  reporterName: text("reporter_name").notNull(),
  reporterEmail: text("reporter_email").notNull(),
  description: text("description"), // optional free-text
  verifyToken: text("verify_token").notNull().unique(),
  verifiedAt: timestamp("verified_at"),
  clearedAt: timestamp("cleared_at"),
  clearedBy: text("cleared_by"), // admin email
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type StolenReport = typeof stolenReports.$inferSelect;
export type InsertStolenReport = typeof stolenReports.$inferInsert;

// ── eBay price cache ────────────────────────────────────────────────────────
// Caches eBay UK listing results per card (24h TTL) to avoid hitting the API
// on every Vault page load. Populated and read by server/ebay.ts.
export const ebayPriceCache = pgTable("ebay_price_cache", {
  id: serial("id").primaryKey(),
  cardKey: text("card_key").notNull().unique(),
  cardName: text("card_name").notNull(),
  cardNumber: text("card_number"),
  setName: text("set_name"),
  averagePricePence: integer("average_price_pence"),
  listingCount: integer("listing_count").notNull().default(0),
  listingsJson: jsonb("listings_json").notNull().default([]),
  lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
});

export type EbayPriceCacheRecord = typeof ebayPriceCache.$inferSelect;

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
    turnaroundDays: st.turnaroundDays,
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
  turnaroundDays?: number;
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

// ============================================================================
// MARKETPLACE SCHEMA
// ============================================================================

export const MARKETPLACE_LISTING_STATUSES = ["draft", "active", "sold", "cancelled", "frozen", "expired"] as const;
export type MarketplaceListingStatus = (typeof MARKETPLACE_LISTING_STATUSES)[number];

export const MARKETPLACE_OFFER_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "countered",
  "withdrawn",
  "expired",
] as const;
export type MarketplaceOfferStatus = (typeof MARKETPLACE_OFFER_STATUSES)[number];

export const MARKETPLACE_ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "refunded",
  "disputed",
] as const;
export type MarketplaceOrderStatus = (typeof MARKETPLACE_ORDER_STATUSES)[number];

export const SELLER_STATUSES = ["none", "pending", "active", "suspended", "rejected"] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export const MARKETPLACE_SHIPPING_METHODS = [
  "royal_mail_tracked_24",
  "royal_mail_tracked_48",
  "royal_mail_special_delivery",
] as const;
export type MarketplaceShippingMethod = (typeof MARKETPLACE_SHIPPING_METHODS)[number];

export const MARKETPLACE_DISPUTE_REASONS = [
  "item_not_received",
  "not_as_described",
  "counterfeit",
  "damaged_in_transit",
  "wrong_card",
  "stolen_card",
  "seller_unresponsive",
  "other",
] as const;
export type MarketplaceDisputeReason = (typeof MARKETPLACE_DISPUTE_REASONS)[number];

export const MARKETPLACE_DISPUTE_STATUSES = [
  "open",
  "seller_responded",
  "under_review",
  "resolved_buyer",
  "resolved_seller",
  "resolved_partial",
  "escalated",
] as const;
export type MarketplaceDisputeStatus = (typeof MARKETPLACE_DISPUTE_STATUSES)[number];

export const marketplaceListings = pgTable("marketplace_listings", {
  id: serial("id").primaryKey(),
  certId: text("cert_id").notNull(),
  sellerUserId: text("seller_user_id").notNull(),
  status: text("status").notNull().default("draft"),
  pricePence: integer("price_pence").notNull(),
  currency: text("currency").notNull().default("GBP"),
  title: text("title").notNull(),
  description: text("description"),
  aiDescriptionUsed: boolean("ai_description_used").notNull().default(false),
  conditionNotes: text("condition_notes"),
  shippingMethod: text("shipping_method").notNull().default("royal_mail_tracked_48"),
  shippingCostPence: integer("shipping_cost_pence").notNull().default(0),
  viewCount: integer("view_count").notNull().default(0),
  watchCount: integer("watch_count").notNull().default(0),
  listedAt: timestamp("listed_at"),
  soldAt: timestamp("sold_at"),
  cancelledAt: timestamp("cancelled_at"),
  frozenAt: timestamp("frozen_at"),
  frozenReason: text("frozen_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MarketplaceListing = typeof marketplaceListings.$inferSelect;

export const marketplaceListingImages = pgTable("marketplace_listing_images", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull(),
  imageUrl: text("image_url").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MarketplaceListingImage = typeof marketplaceListingImages.$inferSelect;

export const marketplaceOffers = pgTable("marketplace_offers", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull(),
  buyerUserId: text("buyer_user_id").notNull(),
  sellerUserId: text("seller_user_id").notNull(),
  amountPence: integer("amount_pence").notNull(),
  status: text("status").notNull().default("pending"),
  message: text("message"),
  counterOfferId: integer("counter_offer_id"),
  expiresAt: timestamp("expires_at"),
  respondedAt: timestamp("responded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MarketplaceOffer = typeof marketplaceOffers.$inferSelect;

export const marketplaceOrders = pgTable("marketplace_orders", {
  id: serial("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  listingId: integer("listing_id").notNull(),
  certId: text("cert_id").notNull(),
  buyerUserId: text("buyer_user_id").notNull(),
  sellerUserId: text("seller_user_id").notNull(),
  status: text("status").notNull().default("pending_payment"),
  pricePence: integer("price_pence").notNull(),
  shippingPence: integer("shipping_pence").notNull().default(0),
  totalPence: integer("total_pence").notNull(),
  commissionRate: numeric("commission_rate", { precision: 5, scale: 4 }).notNull(),
  commissionPence: integer("commission_pence").notNull(),
  stripeFeePence: integer("stripe_fee_pence").notNull().default(0),
  sellerNetPence: integer("seller_net_pence").notNull(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeChargeId: text("stripe_charge_id"),
  stripeTransferId: text("stripe_transfer_id"),
  escrowReleaseAt: timestamp("escrow_release_at"),
  buyerName: text("buyer_name").notNull(),
  buyerEmail: text("buyer_email").notNull(),
  shipToName: text("ship_to_name").notNull(),
  shipToLine1: text("ship_to_line1").notNull(),
  shipToLine2: text("ship_to_line2"),
  shipToCity: text("ship_to_city").notNull(),
  shipToPostcode: text("ship_to_postcode").notNull(),
  shipToCountry: text("ship_to_country").notNull().default("GB"),
  paidAt: timestamp("paid_at"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  refundedAt: timestamp("refunded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MarketplaceOrder = typeof marketplaceOrders.$inferSelect;

export const marketplaceOrderEvents = pgTable("marketplace_order_events", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull().default("system"),
  actorId: text("actor_id"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MarketplaceOrderEvent = typeof marketplaceOrderEvents.$inferSelect;

export const marketplaceShipments = pgTable("marketplace_shipments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  carrier: text("carrier").notNull().default("royal_mail"),
  serviceCode: text("service_code"),
  trackingNumber: text("tracking_number"),
  labelUrl: text("label_url"),
  costPence: integer("cost_pence"),
  weightGrams: integer("weight_grams"),
  dispatchedAt: timestamp("dispatched_at"),
  deliveredAt: timestamp("delivered_at"),
  lastTrackingEvent: text("last_tracking_event"),
  lastTrackingEventAt: timestamp("last_tracking_event_at"),
  royalMailOrderId: text("royal_mail_order_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MarketplaceShipment = typeof marketplaceShipments.$inferSelect;

export const marketplaceConversations = pgTable("marketplace_conversations", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id"),
  orderId: integer("order_id"),
  buyerUserId: text("buyer_user_id").notNull(),
  sellerUserId: text("seller_user_id").notNull(),
  lastMessageAt: timestamp("last_message_at"),
  buyerUnreadCount: integer("buyer_unread_count").notNull().default(0),
  sellerUnreadCount: integer("seller_unread_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MarketplaceConversation = typeof marketplaceConversations.$inferSelect;

export const marketplaceMessages = pgTable("marketplace_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),
  senderUserId: text("sender_user_id").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MarketplaceMessage = typeof marketplaceMessages.$inferSelect;

export const marketplaceReviews = pgTable("marketplace_reviews", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().unique(),
  reviewerUserId: text("reviewer_user_id").notNull(),
  revieweeUserId: text("reviewee_user_id").notNull(),
  direction: text("direction").notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MarketplaceReview = typeof marketplaceReviews.$inferSelect;

export const marketplaceDisputes = pgTable("marketplace_disputes", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  openedByUserId: text("opened_by_user_id").notNull(),
  reason: text("reason").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("open"),
  resolution: text("resolution"),
  resolutionNotes: text("resolution_notes"),
  resolvedByAdminId: text("resolved_by_admin_id"),
  resolvedAt: timestamp("resolved_at"),
  refundAmountPence: integer("refund_amount_pence"),
  evidenceJson: jsonb("evidence_json").$type<unknown[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MarketplaceDispute = typeof marketplaceDisputes.$inferSelect;

export const marketplaceWatchlist = pgTable(
  "marketplace_watchlist",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    listingId: integer("listing_id").notNull(),
    priceAlertThresholdPence: integer("price_alert_threshold_pence"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userListingUnique: uniqueIndex("uniq_marketplace_watchlist_user_listing").on(table.userId, table.listingId),
  })
);

export type MarketplaceWatchlistEntry = typeof marketplaceWatchlist.$inferSelect;

export const marketplaceDac7Quarterly = pgTable("marketplace_dac7_quarterly", {
  id: serial("id").primaryKey(),
  sellerUserId: text("seller_user_id").notNull(),
  year: integer("year").notNull(),
  quarter: integer("quarter").notNull(),
  grossSalesPence: bigint("gross_sales_pence", { mode: "number" }).notNull().default(0),
  transactionCount: integer("transaction_count").notNull().default(0),
  commissionCollectedPence: bigint("commission_collected_pence", { mode: "number" }).notNull().default(0),
  lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
});

export type MarketplaceDac7Quarterly = typeof marketplaceDac7Quarterly.$inferSelect;

// ── Instagram automation ─────────────────────────────────────────────────────
// Daily IG post queue + a single-row toggle table. Runs as a setInterval
// cron in server/index.ts that fires once per day around 10:00 Europe/London.
// Soft-delete via deletedAt; never hard-deleted. Audit-log entry on every
// status change (entity_type='ig_post').

export const IG_POST_TYPES = [
  "card_reveal",
  "grade_breakdown",
  "service_explainer",
  "vault_club",
  "market_insight",
] as const;
export type IgPostType = (typeof IG_POST_TYPES)[number];

export const IG_POST_STATUSES = ["pending", "generating", "ready", "posted", "failed", "skipped"] as const;
export type IgPostStatus = (typeof IG_POST_STATUSES)[number];

export const igPostQueue = pgTable(
  "ig_post_queue",
  {
    id: serial("id").primaryKey(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    postType: text("post_type").notNull(), // one of IG_POST_TYPES
    certId: integer("cert_id"), // certificates.id, nullable
    imageR2Key: text("image_r2_key"),
    caption: text("caption"),
    hashtags: text("hashtags"),
    status: text("status").notNull().default("pending"), // one of IG_POST_STATUSES
    metaPostId: text("meta_post_id"),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    scheduledIdx: index("ig_post_queue_scheduled_for_idx").on(t.scheduledFor),
    statusIdx: index("ig_post_queue_status_idx").on(t.status),
    // (deleted_at, scheduled_for) covers the canonical queue-list query
    // `WHERE deleted_at IS NULL ORDER BY scheduled_for DESC`.
    deletedScheduledIdx: index("ig_post_queue_deleted_at_scheduled_for_idx").on(t.deletedAt, t.scheduledFor),
  })
);

export const insertIgPostQueueSchema = createInsertSchema(igPostQueue).omit({
  id: true,
  createdAt: true,
});
export type IgPostQueueRow = typeof igPostQueue.$inferSelect;
export type InsertIgPostQueue = z.infer<typeof insertIgPostQueueSchema>;

// Single-row toggle table. Row id=1 always exists after seed.
export const igSettings = pgTable("ig_settings", {
  id: serial("id").primaryKey(),
  postEnabled: boolean("post_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export type IgSettingsRow = typeof igSettings.$inferSelect;
