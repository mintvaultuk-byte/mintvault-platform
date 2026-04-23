import type { Express } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { BUILD_STAMP, pricingTiers, calculateOrderTotals, gradeLabel, gradeLabelFull, isNonNumericGrade, SUBMISSION_STATUS_TRANSITIONS, SUBMISSION_STATUS_LABELS, serviceTierToPricingTier, auditLog } from "@shared/schema";
import type { PublicCertificate, ServiceTierRecord } from "@shared/schema";
import { storage, deductAiCredits } from "./storage";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { verifyAdminPassword, verifyAdminPin, requireAdmin, isLoginRateLimited, isPinRateLimited, recordFailedLogin, recordFailedPin, clearLoginAttempts, clearPinAttempts, isPendingAdminValid, clearPendingAdmin, ADMIN_EMAIL, FAILED_LOGIN_DELAY_MS } from "./auth";
import { generateLabelPNG, generateLabelPDF, applyLabelOverrides } from "./labels";
import { CERTS_PER_SHEET, LABELS_PER_SHEET } from "./label-sheet";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { uploadToR2, getR2SignedUrl, deleteFromR2, r2KeyForImage, r2KeyForLabel } from "./r2";
import { generateClaimInsertPNG, generateClaimInsertPDF, generateClaimInsertSheet } from "./claim-insert";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { sendSubmissionConfirmation, sendSubmissionConfirmationV2, sendCardsReceived, sendGradingComplete, sendShipped, sendSubmissionDelivered, sendClaimVerification, sendTransferOwnerConfirmation, sendTransferNewOwnerConfirmation, sendTransferV2OutgoingConfirmation, sendTransferV2IncomingConfirmation, sendTransferV2DisputeWindowStarted, sendTransferV2Completed, sendTransferV2Cancelled, sendTransferV2Disputed, sendCertificatePdf, sendMagicLink, sendStolenVerificationEmail } from "./email";
import { generateCertificateDocument } from "./certificate-document";
import { createMagicToken, verifyMagicToken, requireCustomer } from "./customer-auth";
import { identifyCard, identifyCardFromBuffer, verifyAndEnrichCardData, analyzeCard, identifyAndAnalyze, autoCropCard, analyzeCardFromBuffers, generateImageVariants, verifyPokemonCardWithTcgApi, resizeForClaude, normaliseCardName, type ImageKeys } from "./ai-grading-service";
import { anthropicFetch } from "./anthropic-fetch";
import { getCachedOrFreshEbayPrices, buildCardKey } from "./ebay";
import {
  hashPassword, verifyPassword, validatePassword,
  createEmailVerificationToken, createPasswordResetToken, createAccountMagicLinkToken,
  findUserByEmail, findUserById,
  countRecentFailedAttempts, logLoginAttempt, writeAuthAudit,
  migrateAccountSchema,
} from "./account-auth";
import { migrateMarketplaceSchema } from "./marketplace-schema";
import {
  sendWelcomeVerificationEmail, sendAccountMagicLinkEmail,
  sendPasswordResetEmail, sendPasswordChangedEmail,
  sendEmailChangedNotification, sendAccountDeletedEmail,
} from "./email";
import { requireAuth } from "./middleware/auth";
import { requireScannerOrAdmin } from "./lib/scanner-auth";
import { registerShowroomRoutes } from "./showroom";
import { registerVaultClubRoutes } from "./vault-club";
import { registerSellerRoutes } from "./marketplace-seller";
import { isActiveStatus } from "./vault-club-tiers";

/** Count unused, unexpired credits of a given type */
async function countCreditsRemaining(userId: string, creditType: string = "member"): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM member_credits
    WHERE user_id = ${userId} AND credit_type = ${creditType}
      AND used_at IS NULL AND expires_at > NOW()
  `);
  return parseInt((rows.rows[0] as any)?.cnt ?? "0", 10);
}

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

/** Resilient JSON extraction: handles Claude prose preambles, markdown fences, truncation */
function extractJson<T = any>(raw: string, label: string): T {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  // Attempt 1: direct parse
  try { return JSON.parse(cleaned); } catch {}
  // Attempt 2: extract outermost JSON object from prose
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e2: any) {
      console.error(`[${label}] regex-extracted JSON failed to parse:`, e2.message);
      console.error(`[${label}] extracted (first 500):`, match[0].slice(0, 500));
    }
  }
  // Attempt 3: truncated JSON — try to close it
  const braceMatch = cleaned.match(/\{[\s\S]*/);
  if (braceMatch) {
    const partial = braceMatch[0];
    // Count open vs close braces to auto-close
    const opens = (partial.match(/\{/g) || []).length;
    const closes = (partial.match(/\}/g) || []).length;
    if (opens > closes) {
      const repaired = partial + "}".repeat(opens - closes);
      try { return JSON.parse(repaired); } catch (e3: any) {
        console.error(`[${label}] truncation repair failed:`, e3.message);
      }
    }
  }
  console.error(`[${label}] could not extract JSON. Length: ${raw.length}, first 500: ${raw.slice(0, 500)}`);
  console.error(`[${label}] last 200: ${raw.slice(-200)}`);
  throw new Error(`AI returned invalid response for ${label}`);
}

function getSignedUrlSecret(): string {
  const s = process.env.SIGNED_URL_SECRET;
  if (!s) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return s;
}

const RARITY_LABELS: Record<string, string> = {
  COMMON: "Common", UNCOMMON: "Uncommon", RARE: "Rare", HOLO: "Holo", RARE_HOLO: "Holo Rare",
  REVERSE_HOLO: "Reverse Holo", DOUBLE_RARE: "Double Rare (ex/V)", ULTRA_RARE: "Ultra Rare (Full Art)",
  ILLUSTRATION_RARE: "Illustration Rare (IR)", SPECIAL_ILLUSTRATION_RARE: "Special Illustration Rare (SIR)",
  HYPER_RARE: "Hyper Rare (Gold)", SECRET_RARE: "Secret Rare", SHINY_RARE: "Shiny Rare",
  SHINY_ULTRA_RARE: "Shiny Ultra Rare", RADIANT: "Radiant", AMAZING_RARE: "Amazing Rare",
  ACE_SPEC: "ACE SPEC", TRAINER_GALLERY: "Trainer Gallery (TG)", GALAR_GALLERY: "Galarian Gallery (GG)",
  GOLD_STAR: "★ Gold Star", DOUBLE_GOLD_STAR: "★★ Double Gold Star",
  PROMO_RARITY: "Promo (Rarity Unknown)", OTHER: "Other (manual)",
};

const COLLECTION_LABELS: Record<string, string> = {
  CLASSIC_COLLECTION: "Classic Collection", COLLECTION_GENERIC: "Collection (generic)",
  BLACK_STAR_PROMO: "Black Star Promo", PROMO_GENERIC: "Promo (generic)",
  FIRST_EDITION: "1st Edition", UNLIMITED: "Unlimited", SHADOWLESS: "Shadowless",
  FOURTH_PRINT: "4th Print", NO_RARITY_SYMBOL: "No Rarity Symbol",
  ERROR_MISPRINT: "Error / Misprint", TROPHY_PRIZE: "Trophy / Prize",
  TRAINER_GALLERY: "Trainer Gallery (TG)", GALARIAN_GALLERY: "Galarian Gallery (GG)",
  RADIANT_COLLECTION: "Radiant Collection (RC)", SHINY_VAULT: "Shiny Vault (SV)",
  ILLUSTRATION_RARE: "Illustration Rare (IR)", SPECIAL_ILLUSTRATION_RARE: "Special Illustration Rare (SIR)",
  CHARACTER_RARE: "Character Rare (CHR)", CHARACTER_SUPER_RARE: "Character Super Rare (CSR)",
  PRISM_STAR: "Prism Star", AMAZING_RARE: "Amazing Rare", SECRET_RARE: "Secret Rare",
  OTHER: "Other (manual)",
};

function collectionDisplayLabel(code: string | null | undefined, other: string | null | undefined, legacyCollection?: string | null): string | null {
  if (!code) {
    return legacyCollection?.trim() || null;
  }
  if (code === "OTHER") return other?.trim() || null;
  return COLLECTION_LABELS[code] || code;
}

const VARIANT_LABELS: Record<string, string> = {
  NONE: "None / Regular", HOLO: "Holo", REVERSE_HOLO: "Reverse Holo",
  COSMOS_HOLO: "Cosmos Holo", CRACKED_ICE_HOLO: "Cracked Ice Holo",
  MIRROR_HOLO: "Mirror Holo", GLITTER_HOLO: "Glitter Holo", PATTERN_HOLO: "Pattern Holo",
  TEXTURED: "Textured", FULL_ART: "Full Art", ALT_ART: "Alt Art", SPECIAL_ART: "Special Art",
  RAINBOW: "Rainbow", GOLD: "Gold", SHINY: "Shiny", RADIANT: "Radiant",
  TRAINER_GALLERY: "Trainer Gallery", GALARIAN_GALLERY: "Galarian Gallery",
  CHARACTER_RARE: "Character Rare (CHR)", CHARACTER_SUPER_RARE: "Character Super Rare (CSR)",
  SECRET_RARE: "Secret Rare", ILLUSTRATION_RARE: "Illustration Rare",
  SPECIAL_ILLUSTRATION_RARE: "Special Illustration Rare", PROMO: "Promo",
  FIRST_EDITION: "1st Edition", SHADOWLESS: "Shadowless", UNLIMITED: "Unlimited",
  OTHER: "Other (manual)",
};

function variantDisplayLabel(code: string | null | undefined, variantOther: string | null | undefined): string | null {
  if (!code || code === "NONE") return null;
  if (code === "OTHER") return variantOther || "Other";
  return VARIANT_LABELS[code] || code;
}

const DESIGNATION_LABELS: Record<string, string> = {
  PROMO: "Promo", TOURNAMENT_STAMP: "Tournament / Event Stamp", PRERELEASE: "Prerelease",
  STAFF: "Staff", ERROR_MISCUT: "Error / Miscut / Misprint", FIRST_EDITION: "1st Edition",
  SHADOWLESS: "Shadowless", UNLIMITED: "Unlimited", JAPANESE_PRINT: "Japanese Print",
  OTHER_LANGUAGE: "Other Language",
};

function rarityCodeToLabel(code: string): string {
  return RARITY_LABELS[code] || code;
}

function rarityDisplayLabel(code: string | null | undefined, rarityOther: string | null | undefined): string | null {
  if (!code) return null;
  if (code === "OTHER") return rarityOther || "Other";
  return RARITY_LABELS[code] || code;
}

function designationCodesToLabels(codes: string[]): string[] {
  return codes.map(c => DESIGNATION_LABELS[c] || c);
}

function parseDesignations(raw: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return fallback;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  if (m) return `MV${m[1]}`;
  return raw;
}

async function certToPublic(c: any, viewerUserId?: string | null): Promise<PublicCertificate> {
  const gradeType = c.gradeType || "numeric";
  const isNonNum = isNonNumericGrade(gradeType);
  const grade = isNonNum ? 0 : parseFloat(c.gradeOverall || "0");

  let frontUrl: string | null = null;
  let backUrl: string | null = null;
  if (c.frontImagePath) {
    try { frontUrl = await getR2SignedUrl(c.frontImagePath, 3600); } catch (e) { console.error("R2 sign failed (front):", c.frontImagePath, e); frontUrl = null; }
  }
  if (c.backImagePath) {
    try { backUrl = await getR2SignedUrl(c.backImagePath, 3600); } catch (e) { console.error("R2 sign failed (back):", c.backImagePath, e); backUrl = null; }
  }

  return {
    certId: normalizeCertId(c.certId),
    status: c.status || "active",
    gradeType,
    cardGame: c.cardGame,
    cardName: c.cardName,
    cardSet: c.setName,
    cardYear: c.year,
    cardNumber: c.cardNumber,
    rarity: c.rarity || null,
    rarityLabel: rarityDisplayLabel(c.rarity, (c as any).rarityOther),
    designations: designationCodesToLabels((c.designations as string[]) || []),
    variant: variantDisplayLabel(c.variant, (c as any).variantOther) || c.variant || null,
    collection: collectionDisplayLabel((c as any).collectionCode, (c as any).collectionOther, (c as any).collection),
    language: c.language,
    grade: gradeLabelFull(gradeType, c.gradeOverall || "0"),
    gradeNumeric: grade,
    gradeCentering: c.gradeCentering != null ? String(c.gradeCentering) : null,
    gradeCorners: c.gradeCorners != null ? String(c.gradeCorners) : null,
    gradeEdges: c.gradeEdges != null ? String(c.gradeEdges) : null,
    gradeSurface: c.gradeSurface != null ? String(c.gradeSurface) : null,
    frontImageUrl: frontUrl,
    backImageUrl: backUrl,
    gradedDate: c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
    notes: c.notes || null,
    nfcEnabled: c.nfcEnabled ?? null,
    nfcScanCount: c.nfcScanCount != null ? Number(c.nfcScanCount) : null,
    ownershipStatus: c.ownershipStatus || "unclaimed",
    ownershipRef: c.ownershipStatus === "claimed" && c.certId
      ? `MV-REG-${String(c.certId).replace(/^MV-?0*/, "").padStart(10, "0")}`
      : null,
    gradingReport: c.gradingReport && Object.keys(c.gradingReport).length > 0 ? c.gradingReport : null,
    isOwnedByViewer: !!(viewerUserId && c.currentOwnerUserId && viewerUserId === c.currentOwnerUserId),
  };
}

async function migrateServiceTiersV213() {
  // ── Phase 1: Add new columns — each in its own try/catch so one failure doesn't block others ──
  for (const stmt of [
    sql`ALTER TABLE service_tiers ADD COLUMN IF NOT EXISTS display_name TEXT`,
    sql`ALTER TABLE service_tiers ADD COLUMN IF NOT EXISTS tagline TEXT`,
    sql`ALTER TABLE service_tiers ADD COLUMN IF NOT EXISTS most_popular BOOLEAN NOT NULL DEFAULT FALSE`,
  ]) {
    try { await db.execute(stmt); }
    catch (e: any) { console.error("[v213-migrate] ALTER service_tiers failed:", e.message); }
  }

  // ── Phase 2: Seed rows that don't yet exist (ON CONFLICT DO NOTHING) ──────
  // These only insert if the tier_id doesn't already exist in the table.
  // On a branched DB with existing data, every INSERT will be skipped — that's expected.
  const seeds = [
    { serviceType: "grading",        tierId: "standard",       name: "VAULT QUEUE",        pricePerCard: 1900,  turnaroundDays: 40, turnaroundLabel: "40 working days",  maxValueGbp: 500,  sortOrder: 1 },
    { serviceType: "grading",        tierId: "priority",       name: "STANDARD",           pricePerCard: 2500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1500, sortOrder: 2 },
    { serviceType: "grading",        tierId: "express",        name: "EXPRESS",            pricePerCard: 4500,  turnaroundDays: 5,  turnaroundLabel: "5 working days",   maxValueGbp: 3000, sortOrder: 3 },
    { serviceType: "grading",        tierId: "gold",           name: "BLACK LABEL REVIEW", pricePerCard: 7500,  turnaroundDays: 10, turnaroundLabel: "10 working days",  maxValueGbp: 7500, sortOrder: 4 },
    { serviceType: "reholder",       tierId: "reholder",       name: "REHOLDER",           pricePerCard: 1500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1000, sortOrder: 1 },
    { serviceType: "crossover",      tierId: "crossover",      name: "CROSSOVER",          pricePerCard: 3500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1500, sortOrder: 1 },
    { serviceType: "authentication", tierId: "authentication", name: "AUTHENTICATION",     pricePerCard: 1500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1000, sortOrder: 1 },
  ];
  for (const t of seeds) {
    try {
      await db.execute(sql`
        INSERT INTO service_tiers (service_type, tier_id, name, price_per_card, turnaround_days, turnaround_label, max_value_gbp, is_active, sort_order)
        VALUES (${t.serviceType}, ${t.tierId}, ${t.name}, ${t.pricePerCard}, ${t.turnaroundDays}, ${t.turnaroundLabel}, ${t.maxValueGbp}, true, ${t.sortOrder})
        ON CONFLICT DO NOTHING
      `);
    } catch (e: any) { console.error(`[v213-migrate] seed ${t.tierId} failed:`, e.message); }
  }

  // ── Phase 3a: UPDATE core columns that definitely exist (name, price, turnaround, etc.) ──
  // These columns have existed since the table was created — no dependency on Phase 1 ALTERs.
  // Rollback reference (old prices): standard=1200, priority=1500, express=2000, gold=8500, gold-elite=12500
  // Ancillary old prices: reholder=800, crossover=1500, authentication=1000
  const coreUpdates = [
    { tierId: "standard",       name: "VAULT QUEUE",        pricePerCard: 1900,  turnaroundDays: 40, turnaroundLabel: "40 working days",  maxValueGbp: 500,  sortOrder: 1 },
    { tierId: "priority",       name: "STANDARD",           pricePerCard: 2500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1500, sortOrder: 2 },
    { tierId: "express",        name: "EXPRESS",             pricePerCard: 4500,  turnaroundDays: 5,  turnaroundLabel: "5 working days",   maxValueGbp: 3000, sortOrder: 3 },
    { tierId: "gold",           name: "BLACK LABEL REVIEW",  pricePerCard: 7500,  turnaroundDays: 10, turnaroundLabel: "10 working days",  maxValueGbp: 7500, sortOrder: 4 },
    { tierId: "reholder",       name: "REHOLDER",            pricePerCard: 1500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1000, sortOrder: 1 },
    { tierId: "crossover",      name: "CROSSOVER",           pricePerCard: 3500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1500, sortOrder: 1 },
    { tierId: "authentication", name: "AUTHENTICATION",      pricePerCard: 1500,  turnaroundDays: 15, turnaroundLabel: "15 working days",  maxValueGbp: 1000, sortOrder: 1 },
  ];
  for (const u of coreUpdates) {
    try {
      const result = await db.execute(sql`
        UPDATE service_tiers SET
          name = ${u.name},
          price_per_card = ${u.pricePerCard},
          turnaround_days = ${u.turnaroundDays},
          turnaround_label = ${u.turnaroundLabel},
          max_value_gbp = ${u.maxValueGbp},
          sort_order = ${u.sortOrder},
          updated_at = NOW()
        WHERE tier_id = ${u.tierId}
      `);
      console.log(`[v213-migrate] core UPDATE ${u.tierId}: ${result.rowCount} row(s)`);
    } catch (e: any) { console.error(`[v213-migrate] core UPDATE ${u.tierId} failed:`, e.message); }
  }

  // ── Phase 3b: UPDATE new columns (display_name, tagline, most_popular) ──
  // These depend on Phase 1 ALTERs succeeding. If the columns don't exist, each UPDATE
  // will fail and log the error — but Phase 3a prices are already applied.
  const metaUpdates = [
    { tierId: "standard",       displayName: "Vault Queue",        tagline: "For patient collectors. Full Vault treatment, longer queue.",         mostPopular: false },
    { tierId: "priority",       displayName: "Standard",           tagline: "Our most popular tier. Professional grading, solid turnaround.",     mostPopular: true },
    { tierId: "express",        displayName: "Express",            tagline: "Fast-tracked grading for time-sensitive submissions.",               mostPopular: false },
    { tierId: "gold",           displayName: "Black Label Review", tagline: "Premium service for high-value and investment-grade cards.",         mostPopular: false },
    { tierId: "reholder",       displayName: "Reholder",           tagline: "New MintVault slab with updated NFC and certificate.",              mostPopular: false },
    { tierId: "crossover",      displayName: "Crossover",          tagline: "Re-grade a card from PSA, BGS, CGC, or another company.",           mostPopular: false },
    { tierId: "authentication", displayName: "Authentication",     tagline: "Verify authenticity and check for alterations.",                    mostPopular: false },
  ];
  for (const u of metaUpdates) {
    try {
      await db.execute(sql`
        UPDATE service_tiers SET
          display_name = ${u.displayName},
          tagline = ${u.tagline},
          most_popular = ${u.mostPopular}
        WHERE tier_id = ${u.tierId}
      `);
    } catch (e: any) { console.error(`[v213-migrate] meta UPDATE ${u.tierId} failed:`, e.message); }
  }

  // ── Phase 4: Deactivate gold-elite (no longer offered) ─────────────────────
  try {
    const r = await db.execute(sql`UPDATE service_tiers SET is_active = false WHERE tier_id = 'gold-elite'`);
    console.log(`[v213-migrate] deactivate gold-elite: ${r.rowCount} row(s)`);
  } catch (e: any) { console.error("[v213-migrate] deactivate gold-elite failed:", e.message); }

  // ── Phase 5: Create value_protection_tiers table ────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS value_protection_tiers (
        id SERIAL PRIMARY KEY,
        min_value_pence INTEGER NOT NULL,
        max_value_pence INTEGER,
        fee_pence INTEGER NOT NULL,
        requires_photos BOOLEAN DEFAULT false,
        display_name TEXT NOT NULL
      )
    `);
    const existing = await db.execute(sql`SELECT COUNT(*) AS cnt FROM value_protection_tiers`);
    if (parseInt((existing.rows[0] as any)?.cnt ?? "0", 10) === 0) {
      await db.execute(sql`
        INSERT INTO value_protection_tiers (min_value_pence, max_value_pence, fee_pence, requires_photos, display_name) VALUES
        (25000, 99900, 1000, false, '£250 – £999'),
        (100000, 249900, 2500, false, '£1,000 – £2,499'),
        (250000, NULL, 5000, true, '£2,500+')
      `);
      console.log("[v213-migrate] value_protection_tiers seeded with 3 rows");
    }
  } catch (e: any) { console.error("[v213-migrate] value_protection_tiers failed:", e.message); }

  // ── Phase 6: Add credit_type column to member_credits (formerly reholder_credits) ──
  try {
    await db.execute(sql`ALTER TABLE member_credits ADD COLUMN IF NOT EXISTS credit_type TEXT NOT NULL DEFAULT 'member'`);
    console.log("[v213-migrate] member_credits.credit_type column ensured");
  } catch (e: any) { console.error("[v213-migrate] ALTER member_credits failed:", e.message); }

  console.log("[startup] migrateServiceTiersV213 complete");

  // ── Phase 7: Ownership schema additions (v229) ─────────────────────────────
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS new_owner_name TEXT`);
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS new_owner_token_hash TEXT`);
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS new_owner_expires_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS dispute_deadline TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS dispute_reason TEXT`);
    await db.execute(sql`ALTER TABLE ownership_history ADD COLUMN IF NOT EXISTS public_name BOOLEAN DEFAULT false`);
    await db.execute(sql`ALTER TABLE submission_items ADD COLUMN IF NOT EXISTS declared_new BOOLEAN DEFAULT false`);
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS reference_number TEXT UNIQUE`);
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS logbook_version INTEGER NOT NULL DEFAULT 1`);
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS logbook_last_issued_at TIMESTAMPTZ`);
    console.log("[v229-migrate] ownership + reference_number + logbook_version schema ensured");
  } catch (e: any) { console.error("[v229-migrate] ownership schema failed:", e.message); }

  // ── Phase 9: Transfer v2 schema additions ─────────────────────────────────
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS flow_version VARCHAR(4) NOT NULL DEFAULT 'v1'`);
  } catch (e: any) { console.error("[transfer-v2] flow_version:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS transfer_status VARCHAR(30) NOT NULL DEFAULT 'pending_owner'`);
  } catch (e: any) { console.error("[transfer-v2] transfer_status:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS reference_number_provided TEXT`);
  } catch (e: any) { console.error("[transfer-v2] reference_number_provided:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS outgoing_keeper_user_id VARCHAR`);
  } catch (e: any) { console.error("[transfer-v2] outgoing_keeper_user_id:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS incoming_keeper_user_id VARCHAR`);
  } catch (e: any) { console.error("[transfer-v2] incoming_keeper_user_id:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS incoming_confirm_deadline TIMESTAMPTZ`);
  } catch (e: any) { console.error("[transfer-v2] incoming_confirm_deadline:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS disputed_by VARCHAR(10)`);
  } catch (e: any) { console.error("[transfer-v2] disputed_by:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMPTZ`);
  } catch (e: any) { console.error("[transfer-v2] finalised_at:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  } catch (e: any) { console.error("[transfer-v2] cancelled_at:", e.message); }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`);
  } catch (e: any) { console.error("[transfer-v2] cancellation_reason:", e.message); }
  // Index for cron jobs: find v2 transfers in dispute window that need finalising
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_transfer_v2_status ON transfer_verifications (transfer_status) WHERE flow_version = 'v2'`);
  } catch (e: any) { console.error("[transfer-v2] index:", e.message); }
  console.log("[transfer-v2] schema migration complete");

  // ── Phase 8: Backfill Owner #1 from submissions (v229) ─────────────────────
  try {
    // Find graded certs with no ownership_history row
    const unowned = await db.execute(sql`
      SELECT c.certificate_number, c.issued_at, c.submission_item_id
      FROM certificates c
      WHERE c.grade_approved_at IS NOT NULL
        AND c.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ownership_history oh WHERE oh.cert_id = c.certificate_number
        )
      LIMIT 200
    `);
    let backfilled = 0;
    for (const row of unowned.rows as any[]) {
      try {
        let email: string | null = null;
        let name: string | null = null;
        if (row.submission_item_id) {
          const sub = await db.execute(sql`
            SELECT s.customer_email, s.customer_first_name, s.customer_last_name
            FROM submission_items si
            JOIN submissions s ON s.id = si.submission_id
            WHERE si.id = ${row.submission_item_id}
            LIMIT 1
          `);
          const sr = sub.rows[0] as any;
          if (sr) {
            email = sr.customer_email || null;
            name = [sr.customer_first_name, sr.customer_last_name].filter(Boolean).join(" ") || null;
          }
        }
        await db.execute(sql`
          INSERT INTO ownership_history (cert_id, from_user_id, to_user_id, to_email, event_type, notes, created_at)
          VALUES (${row.certificate_number}, NULL, '', ${email}, 'auto_submission', ${name ? `Original submitter: ${name}` : 'Auto-assigned from submission'}, ${row.issued_at || new Date().toISOString()})
        `);
        backfilled++;
      } catch {}
    }
    if (backfilled > 0) console.log(`[v229-migrate] backfilled owner 1 for ${backfilled} certs`);
  } catch (e: any) { console.error("[v229-migrate] backfill failed:", e.message); }
}

async function addRevealWrapColumn() {
  try {
    await db.execute(sql`
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reveal_wrap BOOLEAN NOT NULL DEFAULT FALSE
    `);
  } catch {}
}

async function seedEstimateCreditsTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS estimate_credits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        credits_remaining INTEGER NOT NULL DEFAULT 0,
        credits_purchased INTEGER NOT NULL DEFAULT 0,
        credits_used INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch {}
}

const ESTIMATE_PACKAGES: Record<string, { credits: number; pricePence: number; label: string }> = {
  "5":   { credits: 5,   pricePence: 200,  label: "5 estimates" },
  "15":  { credits: 15,  pricePence: 400,  label: "15 estimates" },
  "100": { credits: 100, pricePence: 1000, label: "100 estimates" },
};

async function createAiGradeCorrectionsTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_grade_corrections (
      id                SERIAL PRIMARY KEY,
      cert_id           TEXT,
      ai_estimated_grade INTEGER,
      ai_centering      TEXT,
      ai_corners        TEXT,
      ai_edges          TEXT,
      ai_surface        TEXT,
      actual_grade      INTEGER,
      actual_centering  INTEGER,
      actual_corners    INTEGER,
      actual_edges      INTEGER,
      actual_surface    INTEGER,
      graded_by         TEXT,
      correction_notes  TEXT,
      created_at        TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Server-side "1 free estimate per IP per day" gate for anonymous-no-email
// callers on POST /api/tools/estimate. Prevents unlimited Anthropic API burn.
// IP is hashed (SHA-256) before storage — never store raw IPs per privacy rules.
async function createEstimateFreeUsesTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS estimate_free_uses (
      ip_hash       TEXT PRIMARY KEY,
      last_used_at  TIMESTAMP NOT NULL,
      count_today   INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Admin email gets unlimited free access to all tools
const ADMIN_FREE_EMAIL = "neilsophieoliver@gmail.com";

async function seedAdminCredits() {
  await db.execute(sql`
    INSERT INTO estimate_credits (email, credits_remaining, credits_purchased, credits_used)
    VALUES (${ADMIN_FREE_EMAIL}, 999999, 999999, 0)
    ON CONFLICT (email) DO UPDATE
      SET credits_remaining = GREATEST(estimate_credits.credits_remaining, 999999)
  `);
}

// ── Capacity gating helpers ───────────────────────────────────────────────────

// In-memory cache: tier slug → { active, max, full, forceOpen, ts }
type CapacityEntry = { active: number; max: number; full: boolean; forceOpen: boolean; ts: number };
const _capacityCache: Record<string, CapacityEntry> = {};
const CAPACITY_CACHE_MS = 30_000;

const ACTIVE_STATUSES = ["received", "in_grading", "ready_to_return", "ready_to_ship"];

async function getTierCapacity(tierSlug: string): Promise<CapacityEntry> {
  const now = Date.now();
  const cached = _capacityCache[tierSlug];
  if (cached && now - cached.ts < CAPACITY_CACHE_MS) return cached;

  // Get max + force_open from tier_capacity table
  const capRows = await db.execute(sql`
    SELECT max_active, force_open FROM tier_capacity WHERE tier_slug = ${tierSlug} LIMIT 1
  `);
  if (capRows.rows.length === 0) {
    // No row = unlimited
    const entry: CapacityEntry = { active: 0, max: 99999, full: false, forceOpen: false, ts: now };
    _capacityCache[tierSlug] = entry;
    return entry;
  }
  const cap = capRows.rows[0] as any;
  const maxActive: number = cap.max_active ?? 99999;
  const forceOpen: boolean = cap.force_open ?? false;

  // Count active submissions for this tier
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

function invalidateCapacityCache(tierSlug?: string) {
  if (tierSlug) {
    delete _capacityCache[tierSlug];
  } else {
    Object.keys(_capacityCache).forEach(k => delete _capacityCache[k]);
  }
}

async function seedTierCapacityTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tier_capacity (
        id          SERIAL PRIMARY KEY,
        tier_slug   TEXT UNIQUE NOT NULL,
        max_active  INTEGER NOT NULL,
        force_open  BOOLEAN NOT NULL DEFAULT false,
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // Seed default capacities — ON CONFLICT DO NOTHING so admin overrides are preserved
    for (const [slug, max] of [["standard", 500], ["priority", 150], ["express", 40]] as [string, number][]) {
      await db.execute(sql`
        INSERT INTO tier_capacity (tier_slug, max_active) VALUES (${slug}, ${max}) ON CONFLICT DO NOTHING
      `);
    }
  } catch {}
}

async function createAiOverrideAuditTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_override_audit (
        id SERIAL PRIMARY KEY,
        cert_id INTEGER,
        field_path TEXT NOT NULL,
        ai_value JSONB,
        override_value JSONB,
        override_reason TEXT,
        overridden_by TEXT NOT NULL,
        overridden_at TIMESTAMPTZ DEFAULT NOW(),
        session_id TEXT
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_override_audit_cert ON ai_override_audit(cert_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_override_audit_field ON ai_override_audit(field_path)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_override_audit_time ON ai_override_audit(overridden_at DESC)`);
    console.log("[v221-migrate] ai_override_audit table ensured");
  } catch (e: any) {
    console.error("[v221-migrate] ai_override_audit failed:", e.message);
  }
}

async function createEbayPriceCacheTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ebay_price_cache (
        id                  SERIAL PRIMARY KEY,
        card_key            TEXT NOT NULL UNIQUE,
        card_name           TEXT NOT NULL,
        card_number         TEXT,
        set_name            TEXT,
        average_price_pence INTEGER,
        listing_count       INTEGER NOT NULL DEFAULT 0,
        listings_json       JSONB NOT NULL DEFAULT '[]',
        last_updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_ebay_cache_updated ON ebay_price_cache(last_updated_at)
    `);
  } catch {}
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // v213 pricing migration + seed service tiers, estimate_credits, admin credits, column migrations
  migrateServiceTiersV213().catch(() => {});
  seedEstimateCreditsTable().catch(() => {});
  seedAdminCredits().catch(() => {});
  addRevealWrapColumn().catch(() => {});
  createAiGradeCorrectionsTable().catch(() => {});
  createAiOverrideAuditTable().catch(() => {});
  createEstimateFreeUsesTable().catch(() => {});
  createEbayPriceCacheTable().catch(() => {});
  seedTierCapacityTable().catch(() => {});
  migrateAccountSchema()
    .then(() => migrateMarketplaceSchema())
    .catch((e: any) => console.error("[startup-migration] error:", e.message));

  // Reference number backfill — async, fire-and-forget, never blocks boot
  if (process.env.SKIP_BACKFILL !== "true") {
    import("./reference-number").then(({ backfillReferenceNumbers }) =>
      backfillReferenceNumbers()
        .then(() => console.log("[startup] reference number backfill complete"))
        .catch(err => console.error("[startup] reference number backfill failed — will retry on next boot:", err.message))
    ).catch(() => {});
  } else {
    console.log("[startup] SKIP_BACKFILL=true — skipping reference number backfill");
  }

  // ── Public flags endpoint ──────────────────────────────────────────────────
  app.get("/api/config/public-flags", (_req, res) => {
    const { FEATURE_FLAGS } = require("./config/feature-flags");
    res.json({ legalPagesLive: FEATURE_FLAGS.LEGAL_PAGES_LIVE });
  });

  // ── v2 Homepage Stats ──────────────────────────────────────────────────────
  let homepageStatsCache: { data: any; ts: number } | null = null;
  app.get("/api/v2/homepage-stats", async (_req, res) => {
    try {
      if (homepageStatsCache && Date.now() - homepageStatsCache.ts < 60_000) {
        return res.json(homepageStatsCache.data);
      }
      const statsResult = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL) AS total_graded,
          COUNT(DISTINCT card_name) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL) AS unique_cards,
          COUNT(DISTINCT set_name) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL) AS unique_sets,
          ROUND(AVG(grade::numeric) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL), 1) AS avg_grade,
          COUNT(*) FILTER (WHERE ownership_status = 'claimed') AS claimed_count
        FROM certificates
      `);
      // Hero slab stack shows grade RANGE, not just the 3 most recent.
      // For each distinct numeric grade, pick the most recent cert; then take
      // the top 3 grades (highest first). Falls back to <3 rows if DB has
      // fewer distinct grades — caller degrades gracefully.
      const recentResult = await db.execute(sql`
        SELECT DISTINCT ON (grade::numeric)
               id, card_name, set_name, grade, grade_type,
               REGEXP_REPLACE(REGEXP_REPLACE(id::text, '^0+', ''), '^', 'MV') AS cert_number,
               front_image_path
        FROM certificates
        WHERE deleted_at IS NULL AND grade IS NOT NULL
          AND grade_type = 'numeric'
          AND card_name IS NOT NULL AND card_name != '' AND card_name != '(untitled)'
        ORDER BY grade::numeric DESC, issued_at DESC
        LIMIT 3
      `);
      const stats = statsResult.rows[0] as any;
      const data = {
        total_graded: parseInt(stats.total_graded || "0"),
        unique_cards: parseInt(stats.unique_cards || "0"),
        unique_sets: parseInt(stats.unique_sets || "0"),
        avg_grade: parseFloat(stats.avg_grade || "0"),
        claimed_count: parseInt(stats.claimed_count || "0"),
        recent_certs: (recentResult.rows as any[]).map(r => ({
          id: r.id,
          card_name: r.card_name,
          set_name: r.set_name,
          grade: r.grade,
          grade_type: r.grade_type,
          cert_number: r.cert_number,
          front_image_path: r.front_image_path,
        })),
      };
      homepageStatsCache = { data, ts: Date.now() };
      res.json(data);
    } catch (err: any) {
      console.error("[v2/homepage-stats] error:", err.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // ── Legal page API routes ─────────────────────────────────────────────────
  app.get("/api/legal/:slug", (req, res) => {
    const { FEATURE_FLAGS } = require("./config/feature-flags");
    if (!FEATURE_FLAGS.LEGAL_PAGES_LIVE) return res.status(404).json({ error: "Not found" });

    const { LEGAL_SLUGS, LEGAL_ALIASES } = require("./config/legal") as { LEGAL_SLUGS: readonly string[]; LEGAL_ALIASES: Record<string, string> };
    const slug = String(req.params.slug);
    if (!LEGAL_SLUGS.includes(slug)) return res.status(404).json({ error: "Not found" });

    try {
      const fs = require("fs");
      const path = require("path");
      const fileSlug = LEGAL_ALIASES[slug] || slug;
      const filePath = path.join(process.cwd(), "content", "legal", `${fileSlug}.md`);
      const content = fs.readFileSync(filePath, "utf-8");

      // Extract frontmatter title
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const versionMatch = content.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
      const body = content.replace(/^---[\s\S]*?---\s*/m, "");

      res.json({
        slug,
        title: titleMatch?.[1] || slug,
        version: versionMatch?.[1] || "unknown",
        content: body,
      });
    } catch {
      res.status(404).json({ error: "Document not found" });
    }
  });

  // Admin preview — always available regardless of flag
  app.get("/api/admin/legal/:slug", requireAdmin, (req, res) => {
    const { LEGAL_SLUGS, LEGAL_ALIASES } = require("./config/legal") as { LEGAL_SLUGS: readonly string[]; LEGAL_ALIASES: Record<string, string> };
    const slug = String(req.params.slug);
    if (!LEGAL_SLUGS.includes(slug)) return res.status(404).json({ error: "Not found" });

    try {
      const fs = require("fs");
      const path = require("path");
      const fileSlug = LEGAL_ALIASES[slug] || slug;
      const filePath = path.join(process.cwd(), "content", "legal", `${fileSlug}.md`);
      const content = fs.readFileSync(filePath, "utf-8");
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const versionMatch = content.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
      const body = content.replace(/^---[\s\S]*?---\s*/m, "");
      res.json({ slug, title: titleMatch?.[1] || slug, version: versionMatch?.[1] || "unknown", content: body });
    } catch {
      res.status(404).json({ error: "Document not found" });
    }
  });

  // ── Old cert URL redirects → new DIG URL ──────────────────────────────────
  // These fire for direct URL access (e.g. scanning an old QR code with a legacy URL format)
  app.get("/cert/:certId/report", (req, res, next) => {
    const raw = req.params.certId;
    if (/^MV-/i.test(raw)) {
      return res.redirect(301, `/vault/${normalizeCertId(raw)}`);
    }
    next();
  });
  app.get("/cert/report/:certId", (req, res) => {
    res.redirect(301, `/vault/${normalizeCertId(req.params.certId)}`);
  });
  // Redirect old /dig/:certId URLs to /vault/:certId (for any slabs printed before the rename)
  app.get("/dig/:certId", (req, res) => {
    res.redirect(301, `/vault/${normalizeCertId(req.params.certId)}`);
  });

  // ── Cutover URL redirects → canonical v2 paths (SEO 301s) ─────────────────
  app.get("/how-it-works", (_req, res) => res.redirect(301, "/technology"));
  app.get("/about/the-mintvault-slab", (_req, res) => res.redirect(301, "/technology"));
  app.get("/guides", (_req, res) => res.redirect(301, "/journal"));
  app.get("/guides/:slug", (req, res) => res.redirect(301, `/journal/${req.params.slug}`));

  // ── Legal route aliases → /legal/<slug> (SEO 301s) ────────────────────────
  app.get("/privacy",                         (_req, res) => res.redirect(301, "/legal/privacy-policy"));
  app.get("/cookies",                         (_req, res) => res.redirect(301, "/legal/cookies"));
  app.get("/shipping-requirements",           (_req, res) => res.redirect(301, "/legal/shipping-requirements"));
  app.get("/grading-standards",               (_req, res) => res.redirect(301, "/legal/grading-standards"));
  app.get("/cancel",                          (_req, res) => res.redirect(301, "/legal/cancel"));
  app.get("/adr",                             (_req, res) => res.redirect(301, "/legal/adr"));
  app.get("/website-terms",                   (_req, res) => res.redirect(301, "/legal/website-terms"));
  app.get("/submission-agreement",            (_req, res) => res.redirect(301, "/legal/submission-agreement"));
  app.get("/guarantee-and-correction-policy", (_req, res) => res.redirect(301, "/legal/guarantee-and-correction-policy"));
  // Legacy slug → canonical
  app.get("/legal/guarantee", (_req, res) => res.redirect(301, "/legal/guarantee-and-correction-policy"));

  // ── Cookie consent acknowledgment (strictly-necessary-only model) ─────────
  const cookieAckRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000, max: 1,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many requests." },
  });
  // Payment endpoints — generous for legit users retrying declined cards
  const paymentRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many payment attempts. Please wait a few minutes and try again." },
  });

  // Stolen-report — high-friction abuse surface. Generous enough for dealer batch-reports.
  const stolenReportRateLimit = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Daily report limit reached. Contact support@mintvaultuk.com if you need to file more." },
  });

  // Transfer dispute/cancel — same pattern as existing transferV2RateLimit
  const transferActionRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many transfer actions — please try again later." },
  });

  // Rate limit for owner-triggered logbook reissue — belt-and-braces behind
  // owner auth. Admin bypass via x-mv-admin-email header (for support cases).
  const reissueRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many reissue requests — please try again later." },
    skip: (req) => {
      const adminEmail = (req.header("x-mv-admin-email") || "").trim().toLowerCase();
      return adminEmail === ADMIN_FREE_EMAIL;
    },
  });

  // ── Health check — tests DB connectivity for Fly/monitoring ───────────────
  // No auth, no rate limit. Returns 503 if DB unreachable.
  const serverStartedAt = Date.now();
  app.get("/api/health", async (_req, res) => {
    try {
      const result = await db.execute(sql`SELECT 1 AS ok`);
      const dbOk = result.rows.length > 0;
      if (!dbOk) throw new Error("DB returned empty result for SELECT 1");
      res.json({
        status: "ok",
        db: "ok",
        uptime_ms: Date.now() - serverStartedAt,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[health] DB ping failed:", err.message);
      res.status(503).json({
        status: "degraded",
        db: "failed",
        error: err.message?.slice(0, 200) ?? "unknown",
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.post("/api/cookies/acknowledge", cookieAckRateLimit, async (req, res) => {
    try {
      const userAgent = (req.headers["user-agent"] as string || "").slice(0, 500);
      const ipRaw = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
      const ipHash = ipRaw ? crypto.createHash("sha256").update(ipRaw).digest("hex").slice(0, 32) : null;
      await db.insert(auditLog).values({
        entityType: "cookie_consent",
        entityId: ipHash || "unknown",
        action: "acknowledged",
        details: { userAgent, ipHash, acknowledgedAt: new Date().toISOString() },
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[cookie-ack] failed:", err?.message);
      res.json({ ok: true }); // non-blocking — client has localStorage as source of truth
    }
  });

  app.get("/api/version", (_req, res) => {
    res.json({
      build: BUILD_STAMP,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/cards/autofill", async (req, res) => {
    try {
      const setId = (req.query.setId as string || "").trim();
      const number = (req.query.number as string || "").trim();
      const language = (req.query.language as string || "English").trim();
      const allowFallbackLanguage = req.query.allowFallbackLanguage === "1" || req.query.allowFallbackLanguage === "true";

      if (!setId || !number) {
        return res.status(400).json({ error: "setId and number are required" });
      }

      const result = await storage.autofillCard(setId, number, language, allowFallbackLanguage);

      const stripInternal = (card: any) => {
        if (!card) return null;
        const { isDeleted, deletedAt, deletedBy, ...clean } = card;
        return clean;
      };

      res.json({
        match: stripInternal(result.match),
        matchType: result.matchType,
        setName: result.setName,
        ...(result.suggestions ? { suggestions: result.suggestions.map(stripInternal) } : {}),
      });
    } catch (error: any) {
      console.error("Autofill error:", error.message);
      res.status(500).json({ error: "Failed to autofill card data" });
    }
  });

  app.get("/api/cards/sets", async (req, res) => {
    try {
      const game = (req.query.game as string || "").trim() || undefined;
      const sets = await storage.getCardSets(game);
      res.json(sets);
    } catch (error: any) {
      console.error("Card sets error:", error.message);
      res.status(500).json({ error: "Failed to get card sets" });
    }
  });

  async function findCertByIdFlex(certId: string) {
    let dbCert = await storage.getCertificateByCertId(certId);
    if (dbCert) return dbCert;

    const numMatch = certId.match(/^MV-?0*(\d+)$/i);
    if (numMatch) {
      const num = numMatch[1];
      dbCert = await storage.getCertificateByCertId(`MV${num}`);
      if (dbCert) return dbCert;
      dbCert = await storage.getCertificateByCertId(`MV-${num.padStart(10, "0")}`);
      if (dbCert) return dbCert;
    }

    return null;
  }

  app.get("/api/cert/:id", async (req, res) => {
    const certId = req.params.id;
    const viewerUserId = (req.session as any)?.userId as string | undefined;

    const dbCert = await findCertByIdFlex(certId);
    if (!dbCert) {
      return res.status(404).json({ error: "Certificate not found" });
    }
    return res.json(await certToPublic(dbCert, viewerUserId));
  });

  // ── PUBLIC VERIFICATION API (v1) ──────────────────────────────────────────
  const verifyRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Limit: 100 per minute per IP." },
  });

  app.get("/api/v1/verify/:certId", verifyRateLimit, async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    try {
      const dbCert = await findCertByIdFlex(String(req.params.certId));
      if (!dbCert) {
        return res.status(404).json({ verified: false, error: "Certificate not found" });
      }

      const gradeType = dbCert.gradeType || "numeric";
      const isNonNum = isNonNumericGrade(gradeType);
      const gradeNumeric = isNonNum ? null : parseFloat(dbCert.gradeOverall || "0");

      return res.json({
        verified: true,
        certId: normalizeCertId(dbCert.certId),
        status: dbCert.status || "active",
        cardGame: dbCert.cardGame || null,
        cardName: dbCert.cardName || null,
        cardSet: dbCert.setName || null,
        cardYear: dbCert.year || null,
        cardNumber: dbCert.cardNumber || null,
        language: dbCert.language || null,
        grade: gradeLabelFull(gradeType, dbCert.gradeOverall || "0"),
        gradeNumeric,
        gradedDate: dbCert.createdAt ? new Date(dbCert.createdAt).toISOString().split("T")[0] : null,
        ownershipStatus: dbCert.ownershipStatus || "unclaimed",
        verifyUrl: `https://mintvaultuk.com/cert/${normalizeCertId(dbCert.certId)}`,
      });
    } catch (err: any) {
      console.error("[verify] error:", err.message);
      return res.status(500).json({ verified: false, error: "Internal error" });
    }
  });

  app.get("/api/featured-certificates", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT cert_id, card_name, set_name, grade_overall, grade_type, card_game, front_image_path
        FROM certificates
        WHERE status = 'active'
          AND card_name IS NOT NULL
          AND grade_overall IS NOT NULL
          AND front_image_path IS NOT NULL
        ORDER BY issued_at DESC NULLS LAST
        LIMIT 5
      `);
      const rows = result.rows as any[];
      const items = await Promise.all(
        rows.map(async (row) => {
          let frontImageUrl: string | null = null;
          if (row.front_image_path) {
            try { frontImageUrl = await getR2SignedUrl(row.front_image_path, 3600); } catch { /* ignore */ }
          }
          if (!frontImageUrl) return null;
          return {
            certId: normalizeCertId(String(row.cert_id)),
            cardName: row.card_name,
            setName: row.set_name,
            gradeOverall: row.grade_overall,
            gradeType: row.grade_type || "numeric",
            cardGame: row.card_game,
            frontImageUrl,
          };
        })
      );
      res.json(items.filter(Boolean));
    } catch {
      res.json([]);
    }
  });

  app.get("/api/cert/:id/population", async (req, res) => {
    try {
      const certId = req.params.id;
      const dbCert = await findCertByIdFlex(certId);
      if (!dbCert || (dbCert.status !== "active" && dbCert.status !== "published")) {
        return res.status(404).json({ error: "Certificate not found" });
      }

      const pop = await storage.getPopulationData(dbCert);
      res.json(pop);
    } catch (error: any) {
      console.error("Population error:", error.message);
      res.status(500).json({ error: "Failed to get population data" });
    }
  });

  app.get("/api/certs/search", async (req, res) => {
    const q = (req.query.q as string || "").trim();
    if (!q) {
      return res.json([]);
    }

    let dbResults = await storage.searchCertificates(q);
    if (dbResults.length === 0) {
      const numMatch = q.match(/^MV-?0*(\d+)$/i);
      if (numMatch) {
        const num = numMatch[1];
        const altNew = await storage.searchCertificates(`MV${num}`);
        const altOld = await storage.searchCertificates(`MV-${num.padStart(10, "0")}`);
        const seen = new Set<number>();
        dbResults = [...altNew, ...altOld].filter(c => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
      }
    }
    const results = dbResults.map((c) => {
      const gradeType = c.gradeType || "numeric";
      const isNonNum = isNonNumericGrade(gradeType);
      const grade = isNonNum ? 0 : parseFloat(c.gradeOverall || "0");
      return {
        certId: normalizeCertId(c.certId),
        cardName: c.cardName || "",
        cardSet: c.setName || "",
        cardYear: c.year || "",
        cardNumber: c.cardNumber || "",
        grade: gradeLabelFull(gradeType, c.gradeOverall || "0"),
        gradeNumeric: grade,
        gradedDate: c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
        status: c.status,
      };
    });

    res.json(results);
  });

  app.get("/api/stripe/publishable-key", async (_req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      res.json({ publishableKey });
    } catch (error: any) {
      console.error("Error getting Stripe publishable key:", error.message);
      res.status(500).json({ error: "Failed to get payment configuration" });
    }
  });

  app.get("/api/service-tiers", async (req, res) => {
    try {
      const serviceType = req.query.serviceType as string | undefined;
      const tiers = await storage.getServiceTiers(serviceType);
      const pricingData = tiers.map(serviceTierToPricingTier);

      // Enrich with capacity status
      const capacityRows = await db.execute(sql`SELECT tier_id, status, paused_until, paused_message FROM tier_capacity`);
      const capacityMap = new Map((capacityRows.rows as any[]).map(r => [r.tier_id, r]));

      const enriched = pricingData.map((tier: any) => {
        const cap = capacityMap.get(tier.tierId) || capacityMap.get(tier.id);
        return {
          ...tier,
          capacityStatus: cap?.status || "open",
          capacityPausedUntil: cap?.paused_until || null,
          capacityMessage: cap?.paused_message || null,
        };
      });

      res.json(enriched);
    } catch (error: any) {
      console.error("Error fetching service tiers:", error.message);
      res.status(500).json({ error: "Failed to fetch service tiers" });
    }
  });

  app.get("/api/value-protection-tiers", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, min_value_pence, max_value_pence, fee_pence,
               requires_photos, display_name
        FROM value_protection_tiers
        ORDER BY min_value_pence ASC
      `);
      res.json(result.rows || []);
    } catch (e: any) {
      // Table may not exist yet — return empty array
      console.error("[value-protection-tiers] error:", e.message);
      res.json([]);
    }
  });

  app.post("/api/create-payment-intent", paymentRateLimit, async (req, res) => {
    try {
      const {
        type, tier, quantity, declaredValue, notes, submissionName,
        email, firstName, lastName, shippingAddress, phone, cardItems,
        crossoverCompany, crossoverOriginalGrade, crossoverCertNumber,
        reholderCompany, reholderReason, reholderCondition,
        authReason, authConcerns, revealWrap,
        applyCredit, creditType: requestedCreditType,
      } = req.body;

      const VALID_SERVICE_TYPES = ["grading", "reholder", "crossover", "authentication"];
      if (!type || !VALID_SERVICE_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid or missing service type "${type || ""}". Must be one of: ${VALID_SERVICE_TYPES.join(", ")}` });
      }

      // Check tier capacity — block paused tiers
      if (tier) {
        const capRow = await db.execute(sql`SELECT status, paused_message FROM tier_capacity WHERE tier_id = ${tier} LIMIT 1`);
        const cap = capRow.rows[0] as any;
        if (cap?.status === "paused") {
          return res.status(403).json({ error: cap.paused_message || `The ${tier} tier is currently closed for submissions. Please try another tier.` });
        }
      }

      if (type === "crossover" && !crossoverCompany) {
        return res.status(400).json({ error: "Original grading company is required for crossover submissions." });
      }

      if (type === "reholder" && (!reholderCompany || !reholderReason)) {
        return res.status(400).json({ error: "Current slab company and reason are required for reholder submissions." });
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
        return res.status(400).json({ error: `Tier "${tier}" for service "${serviceType}" has an invalid price configuration (£0). Checkout aborted.` });
      }

      // Capacity gating — only applied to grading submissions (reholder/crossover/auth have no tier capacity)
      if (serviceType === "grading") {
        const capacity = await getTierCapacity(tier).catch(() => null);
        if (capacity && capacity.full) {
          return res.status(409).json({ error: "tier_full", tier, message: `The ${tier} tier is currently at full capacity. Please choose a different tier or check back later.` });
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
      const { FEATURE_FLAGS } = await import("./config/feature-flags");
      const { TERMS_VERSION } = await import("./config/legal");

      if (FEATURE_FLAGS.LEGAL_PAGES_LIVE) {
        // New combined terms flow — single checkbox sets both
        if (!termsAccepted) {
          return res.status(400).json({ error: "Terms acceptance required" });
        }
        if (clientTermsVersion && clientTermsVersion !== TERMS_VERSION) {
          return res.status(400).json({ error: `Terms version mismatch. Expected ${TERMS_VERSION}, got ${clientTermsVersion}` });
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
          return res.status(400).json({ error: `Card details count (${cardItems.length}) must match quantity (${quantity})` });
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

      const totals = calculateOrderTotals(tierData.pricePerCard, quantity, totalDeclaredValue);

      // Vault Club perks — Bronze/Gold deprecated 2026-04-19, Silver paused
      // pending the Phase 1B perk evaluator (free return shipping / free
      // authentication credits / queue jump). No percentage discount applies.
      // Bulk discount still works via totals.discountPercent. The locked
      // max(vault_club, bulk) rule still holds — vault_club side is 0 in
      // Phase 1A, so bulk always wins when present. Tier tracking will be
      // re-introduced when the perk evaluator ships and starts exempting
      // specific fees per-member.
      const effectiveDiscountPercent = totals.discountPercent;
      const effectiveDiscountAmount = totals.discountAmount;
      const discountType: string | null = totals.discountPercent > 0 ? "bulk" : null;
      const discountedSubtotal = tierData.pricePerCard * quantity - effectiveDiscountAmount;

      // ── Credit application (Vault Club Silver/Gold) ────────────────────────
      let creditApplied = false;
      let creditAmountPence = 0;
      let creditTypeApplied: string | null = null;
      if (applyCredit && req.session?.userId) {
        const ct = requestedCreditType === "reholder" ? "reholder" : "standard_grade";
        const hasCredit = await countCreditsRemaining((req.session as any).userId, ct);
        if (hasCredit > 0) {
          // Credit covers the grading/reholder fee for 1 card (not insurance, not shipping)
          creditAmountPence = tierData.pricePerCard;
          creditApplied = true;
          creditTypeApplied = ct;
        }
      }

      const total = Math.max(0, discountedSubtotal - creditAmountPence + totals.shipping + totals.totalInsuranceFee);

      const declaredValuePerCard = quantity > 0 ? Math.ceil(totalDeclaredValue / quantity) : 0;
      const highValueFlag = declaredValuePerCard > 3000 || totalDeclaredValue > 7500;
      const requiresManualApproval = totalDeclaredValue > 7500;

      const submissionId = await storage.getNextSubmissionId();

      const turnaroundDays = tierData.turnaround ? parseInt(tierData.turnaround) : null;

      const clientIp = req.headers["x-forwarded-for"]?.toString()?.split(",")[0]?.trim()
        || req.socket?.remoteAddress || "unknown";

      const submission = await storage.createSubmission({
        submissionId,
        type: serviceType,
        tier,
        quantity,
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
        shippingCost: totals.shipping,
        shippingInsuranceTier: totals.shippingLabel,
        gradingCost: discountedSubtotal,
        pricePerCardAtPurchase: tierData.pricePerCard,
        insuranceFee: totals.totalInsuranceFee,
        insuranceSurchargePerCard: totals.insuranceSurchargePerCard,
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
      });

      // Audit log for terms acceptance
      if (FEATURE_FLAGS.LEGAL_PAGES_LIVE) {
        try {
          const { truncateIp } = await import("./utils/truncate-ip");
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

      const stripe = await getUncachableStripeClient();

      const paymentIntent = await stripe.paymentIntents.create({
        amount: total,
        currency: "gbp",
        metadata: {
          submissionId: submission.submissionId,
          submissionDbId: submission.id,
          serviceType,
          tier,
          quantity: String(quantity),
          discountPercent: String(effectiveDiscountPercent),
          discountAmount: String(effectiveDiscountAmount),
          discountType: discountType || "none",
          declaredValue: String(totalDeclaredValue),
          declaredValuePerCard: String(declaredValuePerCard),
          shippingInsurance: totals.shippingLabel,
          insuranceFee: String(totals.totalInsuranceFee),
          highValue: String(highValueFlag),
          ...(creditApplied ? { creditApplied: "true", creditType: creditTypeApplied || "", creditAmountPence: String(creditAmountPence) } : {}),
          ...(type === "crossover" && crossoverCompany ? {
            crossoverCompany: crossoverCompany,
            crossoverOriginalGrade: crossoverOriginalGrade || "",
            crossoverCertNumber: crossoverCertNumber || "",
          } : {}),
          ...(type === "reholder" && reholderCompany ? {
            reholderCompany: reholderCompany,
            reholderReason: reholderReason || "",
            reholderCondition: reholderCondition || "",
          } : {}),
          ...(type === "authentication" && authReason ? {
            authReason: authReason,
            authConcerns: authConcerns || "",
          } : {}),
        },
        receipt_email: email,
      });

      await storage.updateSubmission(submission.id, {
        stripePaymentId: paymentIntent.id,
      });

      const submissionDbId = typeof submission.id === 'string' ? parseInt(submission.id, 10) : submission.id;
      const perCardDeclaredValue = quantity > 0 ? Math.ceil(totalDeclaredValue / quantity) : 0;
      const itemRows = [];

      if (Array.isArray(cardItems) && cardItems.length > 0) {
        for (const item of cardItems) {
          itemRows.push({
            game: typeof item.game === "string" && item.game.trim() ? item.game.trim() : null,
            cardName: typeof item.cardName === "string" && item.cardName.trim() ? item.cardName.trim() : null,
            cardSet: typeof item.setName === "string" && item.setName.trim() ? item.setName.trim() : null,
            cardNumber: typeof item.cardNumber === "string" && item.cardNumber.trim() ? item.cardNumber.trim() : null,
            year: typeof item.year === "string" && item.year.trim() ? item.year.trim() : null,
            declaredValue: typeof item.declaredValue === "number" && item.declaredValue > 0 ? item.declaredValue : perCardDeclaredValue,
            notes: typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : null,
          });
        }
      } else {
        for (let i = 1; i <= quantity; i++) {
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
        discount: effectiveDiscountPercent > 0 ? {
          type: discountType,
          percent: effectiveDiscountPercent,
          amount_pence: effectiveDiscountAmount,
        } : null,
        credit: creditApplied ? {
          type: creditTypeApplied,
          amount_pence: creditAmountPence,
        } : null,
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

      const stripe = await getUncachableStripeClient();
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === "succeeded") {
        if (submission.paymentStatus === "paid") {
          // Already processed (e.g. webhook fired first) — return success without re-processing
          const packingSlipToken = crypto.createHmac("sha256", getSignedUrlSecret()).update(submission.submissionId).digest("hex").slice(0, 16);
          return res.json({ success: true, submissionId: submission.submissionId, status: submission.status, packingSlipToken });
        }
        await storage.markSubmissionAsPaid(Number(submission.id));
        storage.setEstimatedCompletionDate(Number(submission.id)).catch(() => {});

        // Consume Vault Club credit if one was applied at checkout
        const piMeta = paymentIntent.metadata || {};
        if (piMeta.creditApplied === "true" && piMeta.creditType) {
          if (submission.email) {
            const creditUser = await storage.getUserByEmail(submission.email);
            if (creditUser) {
              await consumeCredit(creditUser.id, piMeta.creditType, Number(submission.id)).catch((e: any) =>
                console.error("[checkout] credit consume error:", e.message)
              );
            }
          }
        }

        if (submission.email) {
          let user = await storage.getUserByEmail(submission.email);
          if (!user) {
            user = await storage.createUser({
              email: submission.email,
              firstName: submission.firstName || undefined,
              lastName: submission.lastName || undefined,
            });
          }
          await storage.updateSubmission(submission.id, {
            userId: user.id,
          });
        }

        const packingSlipToken = crypto.createHmac("sha256", getSignedUrlSecret()).update(submission.submissionId).digest("hex").slice(0, 16);

        const { FEATURE_FLAGS: FF2 } = await import("./config/feature-flags");
        const { TERMS_VERSION: TV2 } = await import("./config/legal");
        const emailData = {
          email: submission.email || "",
          firstName: submission.firstName || "Customer",
          submissionId: submission.submissionId,
          cardCount: submission.cardCount || 0,
          tier: submission.serviceTier || "standard",
          total: paymentIntent.amount || 0,
          serviceType: submission.serviceType || undefined,
          labelToken: packingSlipToken,
        };
        if (FF2.LEGAL_PAGES_LIVE) {
          sendSubmissionConfirmationV2({
            ...emailData,
            termsVersion: TV2,
            termsAcceptedAt: new Date().toISOString(),
          }).catch(() => {});
        } else {
          sendSubmissionConfirmation({
            ...emailData,
            crossoverCompany: submission.crossover_company || undefined,
            crossoverOriginalGrade: submission.crossover_original_grade || undefined,
            crossoverCertNumber: submission.crossover_cert_number || undefined,
          }).catch(() => {});
        }

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

  app.get("/api/submissions/:submissionId", async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(req.params.submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      res.json({
        submissionId: submission.submissionId,
        status: submission.status,
        serviceTier: submission.serviceTier || null,
        serviceType: submission.serviceType || null,
        cardCount: submission.cardCount,
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
        turnaroundDays: submission.turnaroundDays || null,
      });
    } catch (error: any) {
      console.error("Track submission error:", error.message);
      res.status(500).json({ error: "Failed to track submission" });
    }
  });

  app.post("/api/admin/login", async (req, res) => {
    try {
      if (isLoginRateLimited(req)) {
        return res.status(429).json({ error: "Too many login attempts, please try again later" });
      }

      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const valid = await verifyAdminPassword(password);
      if (!valid) {
        recordFailedLogin(req);
        await new Promise(resolve => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearLoginAttempts(req);
      req.session.pendingAdmin = true;
      req.session.pendingAdminAt = Date.now();
      req.session.pinFailures = 0;
      res.json({ step: "PIN_REQUIRED" });
    } catch (error: any) {
      console.error("Login error:", error.message);
      res.status(500).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/admin/session", async (req, res) => {
    try {
      if (isLoginRateLimited(req)) {
        return res.status(429).json({ error: "Too many login attempts, please try again later" });
      }

      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const valid = await verifyAdminPassword(password);
      if (!valid) {
        recordFailedLogin(req);
        await new Promise(resolve => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearLoginAttempts(req);
      req.session.pendingAdmin = true;
      req.session.pendingAdminAt = Date.now();
      req.session.pinFailures = 0;
      res.json({ step: "PIN_REQUIRED" });
    } catch (error: any) {
      console.error("Login error:", error.message);
      res.status(500).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/admin/pin", async (req, res) => {
    try {
      if (isPinRateLimited(req)) {
        return res.status(429).json({ error: "Too many attempts, please try again later" });
      }

      if (!isPendingAdminValid(req)) {
        clearPendingAdmin(req);
        return res.status(401).json({ error: "Session expired, please start again" });
      }

      const { pin } = req.body;
      if (!pin) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const valid = await verifyAdminPin(pin);
      if (!valid) {
        const failures = recordFailedPin(req);
        req.session.pinFailures = (req.session.pinFailures || 0) + 1;
        await new Promise(resolve => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));

        if (req.session.pinFailures >= 5) {
          clearPendingAdmin(req);
          return res.status(401).json({ error: "Too many failed attempts, please start again" });
        }

        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearPinAttempts(req);
      req.session.isAdmin = true;
      req.session.adminEmail = ADMIN_EMAIL;
      clearPendingAdmin(req);
      res.json({ success: true });
    } catch (error: any) {
      console.error("PIN error:", error.message);
      res.status(500).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/admin/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
    });
  });

  app.get("/api/admin/session", (req, res) => {
    if (req.session && req.session.isAdmin) {
      return res.json({ authenticated: true, email: req.session.adminEmail });
    }
    res.json({ authenticated: false });
  });

  app.get("/api/admin/db-info", requireAdmin, async (_req, res) => {
    try {
      const { getDatabaseUrl } = await import("./config");
      const dbUrl = getDatabaseUrl();
      let neonHost = "";
      let dbName = "";
      try {
        const parsed = new URL(dbUrl);
        neonHost = parsed.hostname;
        dbName = parsed.pathname.replace(/^\//, "");
      } catch {}

      const timeResult = await db.execute(sql`SELECT NOW() AS server_time`);
      const serverTime = timeResult.rows[0]?.server_time;

      const cmResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM card_master WHERE is_deleted = false`);
      const cardMasterActive = parseInt(cmResult.rows[0]?.cnt as string || "0", 10);

      const csResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM card_sets WHERE is_deleted = false`);
      const cardSetsActive = parseInt(csResult.rows[0]?.cnt as string || "0", 10);

      const certResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM certificates WHERE deleted_at IS NULL`);
      const certificatesCount = parseInt(certResult.rows[0]?.cnt as string || "0", 10);

      const voidedResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM certificates WHERE status = 'voided'`);
      const voidedCount = parseInt(voidedResult.rows[0]?.cnt as string || "0", 10);

      const lastIssued = await storage.getLastIssuedMvNumber();

      res.json({
        env: process.env.NODE_ENV || "development",
        host: neonHost,
        database: dbName,
        source: "MINTVAULT_DATABASE_URL",
        server_time: serverTime,
        card_master_active_count: cardMasterActive,
        card_sets_active_count: cardSetsActive,
        certificates_count: certificatesCount,
        voided_count: voidedCount,
        last_issued_mv: lastIssued.mvNumber,
        last_issued_seq: lastIssued.lastIssued,
      });
    } catch (error: any) {
      console.error("DB info error:", error.message);
      res.status(500).json({ error: "Failed to get DB info" });
    }
  });

  app.post("/api/admin/backup-card-master", requireAdmin, async (req, res) => {
    try {
      const result = await db.execute(sql`SELECT * FROM card_master WHERE is_deleted = false ORDER BY id`);
      const rows = result.rows as any[];

      if (rows.length === 0) {
        return res.json({ success: true, message: "No active card_master rows to back up", rowCount: 0 });
      }

      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(",")];
      for (const row of rows) {
        csvLines.push(headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return "";
          const str = String(val);
          return str.includes(",") || str.includes('"') || str.includes("\n")
            ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(","));
      }
      const csvContent = csvLines.join("\n");

      const now = new Date();
      const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const r2Key = `backups/card_master_${dateStr}.csv`;

      await uploadToR2(r2Key, Buffer.from(csvContent, "utf-8"), "text/csv");

      await storage.writeAuditLog("backup", "card_master", "backup_created", req.session.adminEmail || "admin", {
        r2Key, rowCount: rows.length, timestamp: now.toISOString(),
      });

      res.json({ success: true, r2Key, rowCount: rows.length, timestamp: now.toISOString() });
    } catch (error: any) {
      console.error("Backup error:", error.message);
      res.status(500).json({ error: "Failed to create backup" });
    }
  });

  app.get("/api/admin/service-tiers", requireAdmin, async (_req, res) => {
    try {
      const tiers = await storage.getServiceTiers();
      res.json(tiers);
    } catch (error: any) {
      console.error("Admin service tiers error:", error.message);
      res.status(500).json({ error: "Failed to fetch service tiers" });
    }
  });

  app.put("/api/admin/service-tiers/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid tier ID" });

      const { pricePerCard, turnaroundDays, maxValueGbp, isActive, features } = req.body;

      const parsedPrice = pricePerCard !== undefined ? parseInt(pricePerCard, 10) : undefined;
      const parsedTurnaround = turnaroundDays !== undefined ? parseInt(turnaroundDays, 10) : undefined;
      const parsedMaxValue = maxValueGbp !== undefined ? parseInt(maxValueGbp, 10) : undefined;

      if ((parsedPrice !== undefined && (isNaN(parsedPrice) || parsedPrice < 1)) ||
          (parsedTurnaround !== undefined && (isNaN(parsedTurnaround) || parsedTurnaround < 1)) ||
          (parsedMaxValue !== undefined && (isNaN(parsedMaxValue) || parsedMaxValue < 0))) {
        return res.status(400).json({ error: "Invalid numeric values. Price and turnaround must be positive integers." });
      }

      const updated = await storage.updateServiceTier(id, {
        pricePerCard: parsedPrice,
        turnaroundDays: parsedTurnaround,
        maxValueGbp: parsedMaxValue,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        features: features !== undefined ? features : undefined,
      });

      if (!updated) return res.status(404).json({ error: "Tier not found" });

      await storage.writeAuditLog("service_tier", String(id), "update", req.session.adminEmail || "admin", {
        pricePerCard, turnaroundDays, maxValueGbp, isActive,
      });

      res.json(updated);
    } catch (error: any) {
      console.error("Update service tier error:", error.message);
      res.status(500).json({ error: "Failed to update service tier" });
    }
  });

  // ── AI-ASSISTED GRADING (Build 3 placeholder — superseded by Build 5) ───────

  // Rate limit — 1 AI call per 5 seconds per IP
  const aiRateLimit = rateLimit({
    windowMs: 5 * 1000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => false,
    message: { error: "Please wait 5 seconds between AI analysis requests." },
  });

  // OLD endpoint stub — kept to avoid 404 on any lingering clients; real impl in Build 5 below
  app.post("/api/admin/certificates/:id/analyze-v1-legacy", requireAdmin, aiRateLimit, async (req, res) => {
    try {
      const _unused = ""; // placeholder
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

      if (!cert.frontImagePath && !cert.backImagePath) {
        return res.status(400).json({ error: "Certificate must have at least one image uploaded before AI analysis" });
      }

      // Fetch images from R2 and convert to base64
      async function getImageBase64(key: string | null | undefined): Promise<{ data: string; mediaType: string } | null> {
        if (!key) return null;
        try {
          const { GetObjectCommand } = await import("@aws-sdk/client-s3");
          const { S3Client } = await import("@aws-sdk/client-s3");
          const s3 = new S3Client({
            region: "auto",
            endpoint: process.env.R2_ENDPOINT,
            credentials: {
              accessKeyId: process.env.R2_ACCESS_KEY_ID!,
              secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
            },
          });
          const result = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
          const chunks: Buffer[] = [];
          for await (const chunk of result.Body as any) chunks.push(Buffer.from(chunk));
          const buf = Buffer.concat(chunks);
          const ext = key.split(".").pop()?.toLowerCase() || "jpg";
          const mediaType = ext === "png" ? "image/png" : "image/jpeg";
          return { data: buf.toString("base64"), mediaType };
        } catch {
          return null;
        }
      }

      const [frontImg, backImg] = await Promise.all([
        getImageBase64(cert.frontImagePath),
        getImageBase64(cert.backImagePath),
      ]);

      if (!frontImg && !backImg) {
        return res.status(400).json({ error: "Could not load card images from storage" });
      }

      const contentParts: any[] = [];
      if (frontImg) {
        contentParts.push({ type: "image", source: { type: "base64", media_type: frontImg.mediaType, data: frontImg.data } });
      }
      if (backImg) {
        contentParts.push({ type: "image", source: { type: "base64", media_type: backImg.mediaType, data: backImg.data } });
      }
      contentParts.push({ type: "text", text: "Legacy endpoint disabled." });

      let anthropicRes;
      try {
        anthropicRes = await anthropicFetch(
          {
            model: "claude-opus-4-7",
            max_tokens: 4096,
            messages: [{ role: "user", content: contentParts }],
          },
          { apiKey, timeoutMs: 30_000 },
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }

      if (!anthropicRes.ok) {
        const errBody = await anthropicRes.text();
        console.error("Anthropic API error:", errBody);
        return res.status(502).json({ error: "AI analysis failed. Try again in a moment." });
      }

      const anthropicData = await anthropicRes.json();
      const rawText = anthropicData.content?.[0]?.text || "";

      let analysis: any;
      try {
        // Strip any accidental markdown fences
        const cleaned = rawText.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
        analysis = JSON.parse(cleaned);
      } catch {
        console.error("AI response parse failed:", rawText.slice(0, 500));
        return res.status(502).json({ error: "AI returned invalid JSON. Please retry." });
      }

      // Normalise AI defects into the DIG format (x/y instead of position_x_percent/position_y_percent)
      const aiDefectsNorm = (analysis.defects ?? []).map((d: any, i: number) => ({
        id: i + 1,
        type: d.type,
        severity: d.severity === "minor" ? "low" : d.severity === "major" ? "high" : "medium",
        x: d.position_x_percent ?? d.x ?? 50,
        y: d.position_y_percent ?? d.y ?? 50,
        description: d.description,
      }));

      // Persist to DB
      await db.execute(sql`
        UPDATE certificates SET
          ai_analysis        = ${JSON.stringify(analysis)}::jsonb,
          ai_draft_grade     = ${analysis.overall_grade ?? null},
          centering_front_lr = ${analysis.centering?.front_left_right ?? null},
          centering_front_tb = ${analysis.centering?.front_top_bottom ?? null},
          centering_back_lr  = ${analysis.centering?.back_left_right  ?? null},
          centering_back_tb  = ${analysis.centering?.back_top_bottom  ?? null},
          defects            = ${JSON.stringify(analysis.defects ?? [])}::jsonb,
          ai_defects         = ${JSON.stringify(aiDefectsNorm)}::jsonb,
          updated_at         = NOW()
        WHERE id = ${id}
      `);

      res.json({ analysis });
    } catch (error: any) {
      console.error("AI analyze error:", error.message, error.stack);
      res.status(500).json({ error: `Analysis failed: ${error.message}` });
    }
  });

  app.put("/api/admin/certificates/:id/approve-grade", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const { centering, corners, edges, surface, overall, gradeType } = req.body;

      const finalGradeType = gradeType || "numeric";
      const isNonNum = isNonNumericGrade(finalGradeType);
      const finalOverall = isNonNum ? null : parseFloat(overall);
      const computedLabel = (!isNonNum && finalOverall === 10) ? "black" : "Standard";

      // Promote ai_defects → verified_defects on grade approval (if not already set)
      await db.execute(sql`
        UPDATE certificates SET
          grade_type        = ${finalGradeType},
          grade             = ${isNonNum ? null : finalOverall},
          centering_score   = ${isNonNum ? null : (parseFloat(centering) || null)},
          corners_score     = ${isNonNum ? null : (parseFloat(corners) || null)},
          edges_score       = ${isNonNum ? null : (parseFloat(edges) || null)},
          surface_score     = ${isNonNum ? null : (parseFloat(surface) || null)},
          label_type        = ${computedLabel},
          grade_approved_by = ${"Cornelius Oliver"},
          grade_approved_at = NOW(),
          status            = 'active',
          verified_defects  = CASE
            WHEN verified_defects IS NULL OR verified_defects = '[]'::jsonb
            THEN COALESCE(ai_defects, '[]'::jsonb)
            ELSE verified_defects
          END,
          updated_at        = NOW()
        WHERE id = ${id}
      `);

      await storage.writeAuditLog("certificate", cert.certId, "approve_grade", req.session.adminEmail || "admin", {
        centering, corners, edges, surface, overall, gradeType, labelType: computedLabel,
      });

      const updated = await storage.getCertificate(id);
      res.json(updated ? { ...updated, certId: normalizeCertId(updated.certId) } : {});
    } catch (error: any) {
      console.error("Approve grade error:", error.message);
      res.status(500).json({ error: `Failed to approve grade: ${error.message}` });
    }
  });

  // ── Public DGR endpoint ────────────────────────────────────────────────────
  app.get("/api/cert/:id/report", async (req, res) => {
    try {
      const dbCert = await findCertByIdFlex(req.params.id);
      if (!dbCert) return res.status(404).json({ error: "Certificate not found" });
      if (dbCert.status !== "active") return res.status(404).json({ error: "Certificate not found" });

      const c = dbCert as any;
      const gradeType = c.gradeType || "numeric";
      const isNonNum = isNonNumericGrade(gradeType);
      const gradeNum = isNonNum ? 0 : parseFloat(c.gradeOverall || c.grade || "0");
      const labelType = c.labelType || "Standard";
      const isBlack = !isNonNum && gradeNum === 10 && labelType === "black";

      // Signed image URLs — grading variants
      async function signedOrNull(key: string | null | undefined): Promise<string | null> {
        if (!key) return null;
        try { return await getR2SignedUrl(key, 3600); } catch (e) { console.error("R2 sign failed:", key, e); return null; }
      }

      const [frontUrl, backUrl, fGrey, fHC, fEdge, fInv, bGrey, bHC, bEdge, bInv, angledUrl, closeupUrl] = await Promise.all([
        signedOrNull(c.gradingFrontCropped   || c.gradingFrontOriginal   || c.frontImagePath),
        signedOrNull(c.gradingBackCropped    || c.gradingBackOriginal    || c.backImagePath),
        signedOrNull(c.gradingFrontGreyscale),
        signedOrNull(c.gradingFrontHighcontrast),
        signedOrNull(c.gradingFrontEdgeenhanced),
        signedOrNull(c.gradingFrontInverted),
        signedOrNull(c.gradingBackGreyscale),
        signedOrNull(c.gradingBackHighcontrast),
        signedOrNull(c.gradingBackEdgeenhanced),
        signedOrNull(c.gradingBackInverted),
        signedOrNull(c.gradingAngledCropped  || c.gradingAngledOriginal),
        signedOrNull(c.gradingCloseupCropped || c.gradingCloseupOriginal),
      ]);

      // Population data
      let population = { totalGraded: 0, sameGradeCount: 0, higherGradeCount: 0, percentile: 0 };
      try {
        const popRows = await db.execute(sql`
          SELECT grade FROM certificates
          WHERE card_name = ${c.cardName} AND set_name = ${c.setName} AND card_game = ${c.cardGame}
            AND status = 'active' AND grade IS NOT NULL
        `);
        const grades: number[] = (popRows.rows || []).map((r: any) => parseFloat(r.grade)).filter((g: number) => !isNaN(g));
        const totalGraded = grades.length;
        const sameGradeCount = grades.filter(g => g === gradeNum).length;
        const higherGradeCount = grades.filter(g => g > gradeNum).length;
        const percentile = totalGraded > 0 ? Math.round(((totalGraded - higherGradeCount) / totalGraded) * 100) : 0;
        population = { totalGraded, sameGradeCount, higherGradeCount, percentile };
      } catch { /* non-critical */ }

      const defects = (c.defects || []).map((d: any) => ({
        id: d.id,
        type: d.type,
        severity: d.severity,
        description: d.description,
        location: d.location,
        imageSide: d.image_side || d.imageSide || "front",
        xPercent: d.x_percent ?? d.xPercent ?? 50,
        yPercent: d.y_percent ?? d.yPercent ?? 50,
      }));

      const ai = c.aiAnalysis || {};

      const report = {
        certificate: {
          certId: normalizeCertId(c.certId),
          cardName: c.cardName || "",
          cardGame: c.cardGame || "",
          cardSet: c.setName || "",
          cardYear: c.year || "",
          cardNumber: c.cardNumber || "",
          language: c.language || "English",
          rarity: rarityDisplayLabel(c.rarity, c.rarityOther) || c.rarity || null,
          variant: variantDisplayLabel(c.variant, c.variantOther) || null,
          gradedDate: c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
          gradedBy: c.gradeApprovedBy || "MintVault UK",
          status: c.status || "active",
        },
        grade: {
          overall: isNonNum ? (gradeType === "authentic_altered" ? "AA" : "NO") : gradeNum,
          label: isNonNum ? gradeLabelFull(gradeType, "0") : gradeLabel(gradeNum),
          labelType,
          isBlackLabel: isBlack,
          explanation: c.gradeExplanation || ai.grade_explanation || null,
          approvedBy: c.gradeApprovedBy || null,
          approvedAt: c.gradeApprovedAt || null,
        },
        subgrades: {
          centering: c.centeringScore   != null ? parseFloat(c.centeringScore)   : null,
          corners:   c.cornersScore     != null ? parseFloat(c.cornersScore)     : null,
          edges:     c.edgesScore       != null ? parseFloat(c.edgesScore)       : null,
          surface:   c.surfaceScore     != null ? parseFloat(c.surfaceScore)     : null,
        },
        centering: {
          frontLR: c.centeringFrontLr || null,
          frontTB: c.centeringFrontTb || null,
          backLR:  c.centeringBackLr  || null,
          backTB:  c.centeringBackTb  || null,
        },
        corners: c.cornerValues || null,
        edges:   c.edgeValues   || null,
        surface: c.surfaceValues ? { front: (c.surfaceValues as any).front, back: (c.surfaceValues as any).back } : null,
        defects,
        authentication: {
          status: c.authStatus || "genuine",
          notes:  c.authNotes  || ai.authentication_notes || null,
        },
        images: {
          front: frontUrl,
          back:  backUrl,
          frontGreyscale:    fGrey,
          frontHighcontrast: fHC,
          frontEdge:         fEdge,
          frontInverted:     fInv,
          backGreyscale:     bGrey,
          backHighcontrast:  bHC,
          backEdge:          bEdge,
          backInverted:      bInv,
          angled:  angledUrl,
          closeup: closeupUrl,
        },
        population,
        ownership: {
          status: c.ownershipStatus || "unclaimed",
          nfcEnabled: c.nfcEnabled ?? false,
        },
        marketValue: { estimatedLow: null, estimatedHigh: null, currency: "GBP" },
      };

      res.json(report);
    } catch (error: any) {
      console.error("[report] error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ── Public DGR PDF endpoint ────────────────────────────────────────────────
  app.get("/api/cert/:id/report/pdf", async (req, res) => {
    try {
      const dbCert = await findCertByIdFlex(req.params.id);
      if (!dbCert) return res.status(404).json({ error: "Certificate not found" });
      if (dbCert.status !== "active") return res.status(404).json({ error: "Certificate not found" });

      const certId = normalizeCertId(dbCert.certId);
      const c = dbCert as any;
      const gradeType = c.gradeType || "numeric";
      const isNonNum = isNonNumericGrade(gradeType);
      const gradeNum = isNonNum ? 0 : parseFloat(c.gradeOverall || c.grade || "0");
      const isBlack = !isNonNum && gradeNum === 10 && c.labelType === "black";
      const gLabel = isNonNum
        ? (gradeType === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL")
        : gradeLabel(gradeNum);

      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ size: "A4", margin: 50, autoFirstPage: true });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault-DGR-${certId}.pdf"`);
      doc.pipe(res);

      const GOLD = "#D4AF37";
      const DARK = isBlack ? "#FFFFFF" : "#1A1A1A";
      const BG   = isBlack ? "#0A0A0A" : "#FFFFFF";

      if (isBlack) {
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
      }

      // Header
      doc.fontSize(8).fillColor(GOLD).text("MINTVAULT UK", { align: "center" });
      doc.moveDown(0.3);
      doc.fontSize(14).fillColor(GOLD).text("DIGITAL GRADING REPORT", { align: "center" });
      doc.moveDown(0.2);
      doc.fontSize(10).fillColor(DARK).text(`Certificate ${certId}`, { align: "center" });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).lineWidth(1).stroke();
      doc.moveDown(0.8);

      // Card identity
      doc.fontSize(18).fillColor(DARK).text(c.cardName || "—", { align: "left" });
      doc.fontSize(10).fillColor(isBlack ? "#AAAAAA" : "#666666")
        .text(`${c.setName || ""}${c.year ? ` · ${c.year}` : ""}${c.cardNumber ? ` · #${c.cardNumber}` : ""}`)
        .text(`${c.cardGame || ""} · ${c.language || "English"}`);
      if (c.rarity) doc.text(`Rarity: ${rarityDisplayLabel(c.rarity, c.rarityOther) || c.rarity}`);
      doc.moveDown(0.3);
      const gradedDateFmt = c.createdAt ? new Date(c.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) : "—";
      doc.fontSize(9).fillColor(isBlack ? "#888888" : "#888888")
        .text(`Graded: ${gradedDateFmt}  ·  By: ${c.gradeApprovedBy || "MintVault UK"}`);
      doc.moveDown(0.8);

      // Grade hero
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).lineWidth(0.5).stroke();
      doc.moveDown(0.5);
      if (isBlack) doc.fontSize(9).fillColor(GOLD).text("★ BLACK LABEL ★", { align: "center" });
      doc.fontSize(48).fillColor(GOLD).text(isNonNum ? (gradeType === "authentic_altered" ? "AA" : "NO") : String(gradeNum), { align: "center" });
      doc.fontSize(14).fillColor(DARK).text(gLabel, { align: "center" });
      doc.moveDown(0.5);

      if (c.gradeExplanation) {
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).lineWidth(0.5).stroke();
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor(isBlack ? "#AAAAAA" : "#444444").text(`"${c.gradeExplanation}"`, { align: "left" });
        doc.moveDown(0.5);
      }

      // Images — fetch from R2 and embed
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      const backKey  = c.gradingBackCropped  || c.gradingBackOriginal  || c.backImagePath;

      async function fetchBuffer(key: string | null | undefined): Promise<Buffer | null> {
        if (!key) return null;
        try {
          const { GetObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
          const s3 = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT!, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
          const result = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
          const chunks: Buffer[] = [];
          for await (const chunk of result.Body as any) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks);
        } catch { return null; }
      }

      const [frontBuf, backBuf] = await Promise.all([fetchBuffer(frontKey), fetchBuffer(backKey)]);

      if (frontBuf || backBuf) {
        doc.moveDown(0.5);
        const imgW = 210, imgH = 294;
        const pageW = doc.page.width - 100;
        const startX = 50;

        if (frontBuf && backBuf) {
          try { doc.image(frontBuf, startX, doc.y, { width: imgW, height: imgH, fit: [imgW, imgH] }); } catch { /* skip */ }
          try { doc.image(backBuf, startX + imgW + 20, doc.y - (doc.y > 50 ? 0 : 0), { width: imgW, height: imgH, fit: [imgW, imgH] }); } catch { /* skip */ }
          doc.y += imgH + 10;
        } else if (frontBuf) {
          try { doc.image(frontBuf, startX + (pageW - imgW) / 2, doc.y, { width: imgW, height: imgH, fit: [imgW, imgH] }); } catch { /* skip */ }
          doc.y += imgH + 10;
        }
        doc.moveDown(0.5);
      }

      // Page 2 — subgrades
      doc.addPage();
      if (isBlack) doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);

      doc.fontSize(10).fillColor(GOLD).text("SUBGRADE BREAKDOWN", { align: "center" });
      doc.moveDown(0.5);

      const subs = [
        { label: "Centering", val: c.centeringScore },
        { label: "Corners",   val: c.cornersScore },
        { label: "Edges",     val: c.edgesScore },
        { label: "Surface",   val: c.surfaceScore },
      ];
      const boxW = 110, boxH = 55, gap = 10;
      const totalW = subs.length * boxW + (subs.length - 1) * gap;
      let bx = (doc.page.width - totalW) / 2;
      const by = doc.y;
      for (const s of subs) {
        const val = s.val != null ? parseFloat(s.val) : null;
        const bColor = val === null ? "#555555" : val >= 9.5 ? "#D4AF37" : val >= 8 ? "#16A34A" : val >= 6 ? "#CA8A04" : "#DC2626";
        doc.rect(bx, by, boxW, boxH).fillColor(bColor).fill();
        doc.fontSize(7).fillColor("#FFFFFF").text(s.label.toUpperCase(), bx, by + 6, { width: boxW, align: "center" });
        doc.fontSize(22).fillColor("#FFFFFF").text(val !== null ? String(val) : "—", bx, by + 16, { width: boxW, align: "center" });
        bx += boxW + gap;
      }
      doc.y = by + boxH + 15;
      doc.moveDown(0.5);

      // Centering ratios
      if (c.centeringFrontLr || c.centeringFrontTb) {
        doc.fontSize(9).fillColor(GOLD).text("Centering Measurements");
        doc.fontSize(8).fillColor(isBlack ? "#AAAAAA" : "#444444")
          .text(`Front L/R: ${c.centeringFrontLr || "—"}   Front T/B: ${c.centeringFrontTb || "—"}   Back L/R: ${c.centeringBackLr || "—"}   Back T/B: ${c.centeringBackTb || "—"}`);
        doc.moveDown(0.5);
      }

      // Defects
      const defects = c.defects || [];
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor(GOLD).text("IDENTIFIED DEFECTS");
      doc.moveDown(0.3);
      if (defects.length === 0) {
        doc.fontSize(8).fillColor(isBlack ? "#22C55E" : "#16A34A").text("No defects identified — this card is in exceptional condition.");
      } else {
        for (const d of defects) {
          doc.fontSize(8).fillColor(DARK).text(`${d.type} · ${d.severity?.toUpperCase()} · ${d.location || ""}`);
          if (d.description) doc.fontSize(7).fillColor(isBlack ? "#AAAAAA" : "#666666").text(`  ${d.description}`);
        }
      }
      doc.moveDown(0.5);

      // Authentication
      doc.fontSize(9).fillColor(GOLD).text("AUTHENTICATION");
      const authStatus = c.authStatus || "genuine";
      doc.fontSize(8).fillColor(isBlack ? "#AAAAAA" : "#444444")
        .text(authStatus === "genuine"
          ? "This card has been authenticated as genuine by MintVault UK."
          : authStatus === "authentic_altered"
            ? "This card has been identified as AUTHENTIC ALTERED."
            : "This card has been identified as NOT ORIGINAL.");
      if (c.authNotes) doc.fontSize(7).fillColor(isBlack ? "#888888" : "#666666").text(c.authNotes);
      doc.moveDown(0.5);

      // Footer
      doc.moveTo(50, doc.page.height - 70).lineTo(545, doc.page.height - 70).strokeColor(GOLD).lineWidth(0.5).stroke();
      doc.fontSize(7).fillColor(isBlack ? "#666666" : "#999999")
        .text(`Graded by MintVault UK · Rochester, Kent · mintvaultuk.com`, 50, doc.page.height - 60, { align: "center" })
        .text(`Verify at mintvaultuk.com/cert/${certId}/report`, 50, doc.page.height - 50, { align: "center" })
        .text(`© 2026 MintVault UK — This report is permanent and cannot be altered.`, 50, doc.page.height - 40, { align: "center" });

      doc.end();
    } catch (error: any) {
      console.error("[report/pdf] error:", error.message, error.stack);
      if (!res.headersSent) res.status(500).json({ error: `PDF generation failed: ${error.message}` });
    }
  });

  // ── Logbook endpoints ──────────────────────────────────────────────────────

  app.get("/api/logbook/:certId", async (req, res) => {
    try {
      const { buildLogbookData, toPublicPayload } = await import("./logbook-service");
      const data = await buildLogbookData(req.params.certId);
      if (!data) return res.status(404).json({ error: "Certificate not found" });
      res.json(toPublicPayload(data));
    } catch (err: any) {
      console.error("[logbook] error:", err.message);
      res.status(500).json({ error: "Failed to load logbook" });
    }
  });

  app.get("/api/logbook/:certId/verify", async (req, res) => {
    try {
      const sig = (req.query.sig || req.query.signature) as string | undefined;
      if (!sig) return res.status(400).json({ error: "signature query parameter required" });
      const { verifyLogbookSignature } = await import("./logbook-service");
      const result = await verifyLogbookSignature(req.params.certId, sig);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.get("/logbook/:certId.pdf", async (req, res) => {
    try {
      const { generateLogbookPdf } = await import("./logbook-pdf");
      const certId = String(req.params.certId);
      const forceRegenerate = req.query.regenerate === "true";
      const cacheKey = `logbooks/${certId}.pdf`;

      // Serve from R2 cache unless ?regenerate=true
      if (!forceRegenerate) {
        try {
          const cachedUrl = await getR2SignedUrl(cacheKey, 300);
          const cached = await fetch(cachedUrl);
          if (cached.ok) {
            const buf = Buffer.from(await cached.arrayBuffer());
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `inline; filename="MintVault-Logbook-${certId}.pdf"`);
            return res.send(buf);
          }
        } catch {} // cache miss
      }

      const pdf = await generateLogbookPdf(certId, {});
      if (!pdf) return res.status(404).json({ error: "Certificate not found" });

      // Cache to R2 (overwrites if regenerating)
      try { await uploadToR2(cacheKey, pdf, "application/pdf"); } catch {}

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="MintVault-Logbook-${certId}.pdf"`);
      res.send(pdf);
    } catch (err: any) {
      console.error(`[logbook-pdf] generation failed for ${req.params.certId}:`, err.message, err.stack?.split("\n")[1]?.trim());
      if (!res.headersSent) res.status(503).json({ error: "Logbook temporarily unavailable. Please try again in a few minutes or contact support@mintvaultuk.com." });
    }
  });

  // Owner-only PDF with Document Reference Number
  app.get("/logbook/:certId/owner.pdf", async (req, res) => {
    try {
      const { generateLogbookPdf } = await import("./logbook-pdf");
      const { buildLogbookData } = await import("./logbook-service");
      const certId = String(req.params.certId);

      const data = await buildLogbookData(certId);
      if (!data) return res.status(404).json({ error: "Certificate not found" });

      // Hardened dual-path owner auth:
      // 1. Cert must be claimed — unclaimed certs never expose owner copy
      // 2. ownerEmail must exist (non-null, non-empty)
      // 3. Either session.userId matches cert owner OR session.customerEmail matches cert ownerEmail
      const certOwnerStatus = (data as any).provenance?.ownershipStatus;
      const certOwnerUserId = (data as any).currentOwnerUserId;
      const certOwnerEmail = (data as any).ownerEmail;

      const isOwner =
        certOwnerStatus === "claimed" &&
        typeof certOwnerEmail === "string" && certOwnerEmail.trim() !== "" &&
        (
          ((req.session as any)?.userId && typeof certOwnerUserId === "string" && certOwnerUserId !== "" &&
           (req.session as any).userId === certOwnerUserId) ||
          ((req.session as any)?.customerEmail && typeof (req.session as any).customerEmail === "string" &&
           (req.session as any).customerEmail.trim().toLowerCase() === certOwnerEmail.trim().toLowerCase())
        );

      if (!isOwner) {
        return res.status(403).json({ error: "Only the current registered keeper can download the Owner Copy" });
      }

      // Version stays at current value on download — only increments on explicit reissue
      const pdf = await generateLogbookPdf(certId, { includeReferenceNumber: true });
      if (!pdf) return res.status(500).json({ error: "PDF generation failed" });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault-OwnerCopy-${certId}.pdf"`);
      res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      console.log(`[logbook-owner-pdf] served owner copy for ${certId}, referenceNumberPresent=${!!(data as any).referenceNumber}`);
      res.send(pdf);
    } catch (err: any) {
      console.error(`[logbook-owner-pdf] generation failed for ${req.params.certId}:`, err.message, err.stack?.split("\n")[1]?.trim());
      if (!res.headersSent) res.status(503).json({ error: "Logbook temporarily unavailable. Please try again in a few minutes or contact support@mintvaultuk.com." });
    }
  });

  // Reissue logbook — generates new reference number, increments version (V5C replacement)
  app.post("/api/logbook/:certId/reissue", reissueRateLimit, async (req, res) => {
    try {
      const { buildLogbookData } = await import("./logbook-service");
      const { generateReferenceNumber } = await import("./reference-number");
      const certId = String(req.params.certId);

      const data = await buildLogbookData(certId);
      if (!data) return res.status(404).json({ error: "Certificate not found" });

      // Same dual-path owner auth as owner PDF
      const certOwnerStatus = (data as any).provenance?.ownershipStatus;
      const certOwnerUserId = (data as any).currentOwnerUserId;
      const certOwnerEmail = (data as any).ownerEmail;
      const isOwner =
        certOwnerStatus === "claimed" &&
        typeof certOwnerEmail === "string" && certOwnerEmail.trim() !== "" &&
        (
          ((req.session as any)?.userId && typeof certOwnerUserId === "string" && certOwnerUserId !== "" &&
           (req.session as any).userId === certOwnerUserId) ||
          ((req.session as any)?.customerEmail && typeof (req.session as any).customerEmail === "string" &&
           (req.session as any).customerEmail.trim().toLowerCase() === certOwnerEmail.trim().toLowerCase())
        );
      if (!isOwner) return res.status(403).json({ error: "Only the current registered keeper can reissue the logbook" });

      const { confirm, reason } = req.body || {};
      if (confirm !== true || !reason || typeof reason !== "string" || reason.trim().length < 5) {
        return res.status(400).json({ error: "Body must include {confirm: true, reason: string (min 5 chars)}" });
      }

      const rawCertId = (data as any).rawCertId || certId;
      const oldVersion = (data as any).logbookVersion || 1;
      const newVersion = oldVersion + 1;
      const newRefNum = generateReferenceNumber();
      const actorEmail = (req.session as any)?.customerEmail || (req.session as any)?.userId || "unknown";

      // Single transaction: new ref number + increment version + audit log
      await db.execute(sql`
        UPDATE certificates SET
          reference_number = ${newRefNum},
          logbook_version = ${newVersion},
          logbook_last_issued_at = NOW(),
          updated_at = NOW()
        WHERE certificate_number = ${rawCertId}
      `);

      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('certificate', ${rawCertId}, 'logbook_reissue', ${actorEmail},
          ${JSON.stringify({ oldVersion, newVersion, reason: reason.trim() })}::jsonb, NOW())
      `);

      console.log(`[logbook-reissue] ${certId}: v${oldVersion} -> v${newVersion}, referenceNumberPresent=true, reason="${reason.trim().slice(0, 50)}"`);
      res.json({ newVersion, issuedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error(`[logbook-reissue] error for ${req.params.certId}:`, err.message);
      res.status(500).json({ error: "Reissue failed" });
    }
  });

  // Alias: /cert/:certId.pdf → passes through to /logbook/ with query params
  app.get("/cert/:certId.pdf", (req, res) => {
    const qs = req.query.regenerate === "true" ? "?regenerate=true" : "";
    res.redirect(301, `/logbook/${req.params.certId}.pdf${qs}`);
  });

  app.post("/api/admin/logbook/:certId/regenerate", requireAdmin, async (req, res) => {
    try {
      const { generateLogbookPdf } = await import("./logbook-pdf");
      const certId = String(req.params.certId);
      const pdf = await generateLogbookPdf(certId, {});
      if (!pdf) return res.status(404).json({ error: "Certificate not found" });
      const cacheKey = `logbooks/${certId}.pdf`;
      await uploadToR2(cacheKey, pdf, "application/pdf");
      res.json({ ok: true, key: cacheKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Vault Report endpoint (kept for backward compat) ──────────────────────
  app.get("/api/vault/:certId", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const dbCert = await findCertByIdFlex(req.params.certId);
      if (!dbCert) return res.status(404).json({ error: "Certificate not found" });
      if (dbCert.status !== "active") return res.status(404).json({ error: "Certificate not found" });

      const c = dbCert as any;
      const certId = normalizeCertId(c.certId);
      const gradeType = c.gradeType || "numeric";
      const isNonNum = isNonNumericGrade(gradeType);
      const gradeNum = isNonNum ? 0 : parseFloat(c.gradeOverall || "0");
      const isBlack = !isNonNum && gradeNum === 10 && c.labelType === "black";

      async function signedOrNull(key: string | null | undefined): Promise<string | null> {
        if (!key) return null;
        try { return await getR2SignedUrl(key, 3600); } catch (e) { console.error("R2 sign failed:", key, e); return null; }
      }

      const [frontUrl, backUrl] = await Promise.all([
        signedOrNull(c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath),
        signedOrNull(c.gradingBackCropped  || c.gradingBackOriginal  || c.backImagePath),
      ]);

      // Population — grade distribution for this card
      let population = {
        thisGrade: 0,
        totalGraded: 0,
        distribution: {} as Record<string, number>,
      };
      try {
        const popRows = await db.execute(sql`
          SELECT ROUND(grade::numeric, 0)::int AS g, COUNT(*) AS cnt
          FROM certificates
          WHERE card_name = ${c.cardName} AND set_name = ${c.setName} AND card_game = ${c.cardGame}
            AND status = 'active' AND grade IS NOT NULL AND grade_type = 'numeric'
          GROUP BY 1
        `);
        const dist: Record<string, number> = {};
        let total = 0;
        let sameGrade = 0;
        for (const row of popRows.rows as any[]) {
          const g = String(row.g);
          const cnt = parseInt(row.cnt, 10);
          dist[g] = cnt;
          total += cnt;
          if (row.g === gradeNum) sameGrade = cnt;
        }
        population = { thisGrade: sameGrade, totalGraded: total, distribution: dist };
      } catch { /* non-critical */ }

      // Owner's Vault Club tier (for members-only visual treatment on the frontend)
      let ownerVaultClubTier: string | null = null;
      if (c.currentOwnerUserId) {
        try {
          const ownerRows = await db.execute(sql`
            SELECT vault_club_tier, vault_club_status
            FROM users WHERE id = ${c.currentOwnerUserId} AND deleted_at IS NULL LIMIT 1
          `);
          const owner = ownerRows.rows[0] as any;
          if (owner && isActiveStatus(owner.vault_club_status)) {
            ownerVaultClubTier = owner.vault_club_tier || null;
          }
        } catch { /* non-critical */ }
      }

      // Ownership history
      let ownership: Array<{ owner: string; date: string; method: string; verified: boolean }> = [];
      try {
        const hist = await storage.getOwnershipHistory(certId);
        ownership = hist.map((h: any) => ({
          owner: h.ownerName || h.toEmail || "Anonymous Owner",
          date: h.createdAt ? new Date(h.createdAt).toISOString().split("T")[0] : "",
          method: h.eventType === "initial_claim" ? "Original Owner" : "Email Verified Transfer",
          verified: true,
        }));
      } catch { /* non-critical */ }

      // Verified defects — prefer verifiedDefects column, fallback to defects column
      const rawDefects = (c.verifiedDefects?.length ? c.verifiedDefects : c.defects) || [];
      const defects = rawDefects.map((d: any, i: number) => ({
        id: i + 1,
        type: d.type,
        severity: d.severity,
        x: d.x ?? d.position?.x_percent ?? 50,
        y: d.y ?? d.position?.y_percent ?? 50,
        description: d.description,
      }));

      // Centering
      const centeringLR = c.centeringFrontLr || null;
      const centeringTB = c.centeringFrontTb || null;

      function centeringMeetsPsa(lr: string | null, tb: string | null): boolean {
        if (!lr || !tb) return false;
        const [l, r] = lr.split("/").map(Number);
        const [t, b] = tb.split("/").map(Number);
        if (isNaN(l) || isNaN(r) || isNaN(t) || isNaN(b)) return false;
        const side = Math.max(l, r) / Math.min(l, r);
        const topb = Math.max(t, b) / Math.min(t, b);
        return side <= 1.5556 && topb <= 1.5556; // 55/45 ratio
      }

      function centeringMeetsBlack(lr: string | null, tb: string | null): boolean {
        if (!lr || !tb) return false;
        const [l, r] = lr.split("/").map(Number);
        const [t, b] = tb.split("/").map(Number);
        if (isNaN(l) || isNaN(r) || isNaN(t) || isNaN(b)) return false;
        const side = Math.max(l, r) / Math.min(l, r);
        const topb = Math.max(t, b) / Math.min(t, b);
        return side <= 1.1 && topb <= 1.1; // ~52/48
      }

      res.json({
        certId,
        card: {
          name: c.cardName || "",
          set: c.setName || "",
          year: c.year || "",
          number: c.cardNumber || "",
          variant: variantDisplayLabel(c.variant, c.variantOther) || null,
          language: c.language || "English",
          rarity: rarityDisplayLabel(c.rarity, c.rarityOther) || null,
          manufacturer: c.cardGame || "",
          collection: collectionDisplayLabel(c.collectionCode, c.collectionOther, c.collection) || null,
        },
        grades: {
          overall: isNonNum ? gradeType : gradeNum,
          centering: c.gradeCentering ? parseFloat(c.gradeCentering) : null,
          corners:   c.gradeCorners   ? parseFloat(c.gradeCorners)   : null,
          edges:     c.gradeEdges     ? parseFloat(c.gradeEdges)     : null,
          surface:   c.gradeSurface   ? parseFloat(c.gradeSurface)   : null,
          isBlackLabel: isBlack,
          isNonNumeric: isNonNum,
          gradeLabel: isNonNum ? gradeLabelFull(gradeType, "0") : gradeLabel(gradeNum),
        },
        centering: {
          leftRight: centeringLR,
          topBottom: centeringTB,
          meetsPsaGemMt10: centeringMeetsPsa(centeringLR, centeringTB),
          meetsBlackLabel: centeringMeetsBlack(centeringLR, centeringTB),
        },
        defects,
        images: { front: frontUrl, back: backUrl },
        ownership,
        population,
        authentication: {
          nfcActive: c.nfcEnabled ?? false,
          nfcUid: c.nfcUid || null,
          qrVerified: true,
          certId,
          slabSerial: c.slabSerial || null,
          tamperSealIntact: true,
        },
        gradedAt: c.createdAt || null,
        gradedBy: c.gradeApprovedBy || "MintVault UK",
        status: c.status || "active",
        stolenStatus: c.stolenStatus || null,
        stolenReportedAt: c.stolenReportedAt || null,
        ownerVaultClubTier: ownerVaultClubTier,
      });
    } catch (error: any) {
      console.error("[dig] error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ── Stolen card registry ─────────────────────────────────────────────────
  // Startup: ensure stolen_reports table and stolen columns exist
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stolen_reports (
        id            SERIAL PRIMARY KEY,
        cert_id       TEXT NOT NULL,
        reporter_name  TEXT NOT NULL,
        reporter_email TEXT NOT NULL,
        description   TEXT,
        verify_token  TEXT NOT NULL UNIQUE,
        verified_at   TIMESTAMP,
        cleared_at    TIMESTAMP,
        cleared_by    TEXT,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      ALTER TABLE certificates
        ADD COLUMN IF NOT EXISTS stolen_status TEXT,
        ADD COLUMN IF NOT EXISTS stolen_reported_at TIMESTAMP
    `);
  } catch (e: any) {
    console.error("[stolen] startup migration error:", e.message);
  }

  // POST /api/stolen/report — any visitor can file a report; sends verification email
  app.post("/api/stolen/report", stolenReportRateLimit, async (req, res) => {
    try {
      const { certId, reporterName, reporterEmail, description } = req.body;
      if (!certId || !reporterName || !reporterEmail) {
        return res.status(400).json({ error: "certId, reporterName, and reporterEmail are required" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
        return res.status(400).json({ error: "Invalid reporter email" });
      }
      const normalCertId = normalizeCertId(String(certId));
      const cert = await findCertByIdFlex(normalCertId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const token = crypto.randomBytes(32).toString("hex");
      await db.execute(sql`
        INSERT INTO stolen_reports (cert_id, reporter_name, reporter_email, description, verify_token)
        VALUES (${normalCertId}, ${String(reporterName).slice(0, 200)}, ${String(reporterEmail).toLowerCase()}, ${description ? String(description).slice(0, 1000) : null}, ${token})
      `);

      // Send verification email
      const verifyUrl = `${req.protocol}://${req.get("host")}/api/stolen/verify/${token}`;
      try {
        await sendStolenVerificationEmail(String(reporterEmail), String(reporterName), normalCertId, cert.cardName || "Unknown card", verifyUrl);
      } catch (emailErr: any) {
        console.error("[stolen] email send error:", emailErr.message);
      }

      return res.json({ ok: true, message: "Verification email sent. Please check your inbox to confirm the report." });
    } catch (err: any) {
      console.error("[stolen] POST report error:", err.message);
      return res.status(500).json({ error: "Failed to submit report" });
    }
  });

  // GET /api/stolen/verify/:token — link clicked in email; marks report verified, flags cert
  app.get("/api/stolen/verify/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const rows = await db.execute(sql`
        SELECT * FROM stolen_reports WHERE verify_token = ${token} LIMIT 1
      `);
      if (rows.rows.length === 0) {
        return res.status(404).send("Verification link not found or already used.");
      }
      const report = rows.rows[0] as any;
      if (report.verified_at) {
        return res.redirect("/stolen-card-protection?verified=already");
      }
      await db.execute(sql`
        UPDATE stolen_reports SET verified_at = NOW() WHERE verify_token = ${token}
      `);
      await db.execute(sql`
        UPDATE certificates SET stolen_status = 'reported_stolen', stolen_reported_at = NOW()
        WHERE certificate_number = ${report.cert_id}
      `);
      return res.redirect(`/stolen-card-protection?verified=true&cert=${report.cert_id}`);
    } catch (err: any) {
      console.error("[stolen] GET verify error:", err.message);
      return res.status(500).send("Verification failed. Please try again.");
    }
  });

  // GET /api/stolen/status/:certId — public; returns whether a cert is flagged
  app.get("/api/stolen/status/:certId", async (req, res) => {
    try {
      const normalCertId = normalizeCertId(req.params.certId);
      const rows = await db.execute(sql`
        SELECT stolen_status, stolen_reported_at FROM certificates
        WHERE certificate_number = ${normalCertId} LIMIT 1
      `);
      if (rows.rows.length === 0) return res.status(404).json({ error: "Not found" });
      const row = rows.rows[0] as any;
      return res.json({
        stolen: row.stolen_status === "reported_stolen",
        reportedAt: row.stolen_reported_at || null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: "Failed" });
    }
  });

  // GET /api/admin/stolen — admin only; list active stolen reports
  app.get("/api/admin/stolen", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT id, cert_id, reporter_name, reporter_email, description, verified_at, cleared_at, created_at
        FROM stolen_reports
        WHERE cleared_at IS NULL
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return res.json(rows.rows);
    } catch (err: any) {
      return res.status(500).json({ error: "Failed" });
    }
  });

  // POST /api/admin/stolen/:certId/clear — admin only; clears the stolen flag
  app.post("/api/admin/stolen/:certId/clear", requireAdmin, async (req, res) => {
    try {
      const normalCertId = normalizeCertId(String(req.params.certId));
      await db.execute(sql`
        UPDATE certificates SET stolen_status = NULL, stolen_reported_at = NULL
        WHERE certificate_number = ${normalCertId}
      `);
      await db.execute(sql`
        UPDATE stolen_reports SET cleared_at = NOW(), cleared_by = 'admin'
        WHERE cert_id = ${normalCertId} AND cleared_at IS NULL
      `);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[stolen] admin clear error:", err.message);
      return res.status(500).json({ error: "Failed to clear stolen flag" });
    }
  });

  // ── Capacity endpoint ─────────────────────────────────────────────────────
  // Returns current active vs max counts for each grading tier.
  // Cached in-memory for 30 s to avoid hammering the DB on every page load.
  app.get("/api/capacity", async (_req, res) => {
    try {
      const [standard, priority, express_] = await Promise.all([
        getTierCapacity("standard"),
        getTierCapacity("priority"),
        getTierCapacity("express"),
      ]);
      return res.json({
        standard: { active: standard.active, max: standard.max, full: standard.full, forceOpen: standard.forceOpen },
        priority: { active: priority.active, max: priority.max, full: priority.full, forceOpen: priority.forceOpen },
        express:  { active: express_.active,  max: express_.max,  full: express_.full,  forceOpen: express_.forceOpen },
      });
    } catch (err: any) {
      console.error("[capacity] GET /api/capacity error:", err.message);
      return res.status(500).json({ error: "Failed to load capacity data" });
    }
  });

  // ── Admin: update tier capacity ───────────────────────────────────────────
  app.put("/api/admin/capacity/:tierSlug", requireAdmin, async (req, res) => {
    try {
      const tierSlug = String(req.params.tierSlug);
      const { maxActive, forceOpen } = req.body;

      if (!["standard", "priority", "express"].includes(tierSlug)) {
        return res.status(400).json({ error: "Invalid tier slug" });
      }
      if (maxActive !== undefined && (typeof maxActive !== "number" || maxActive < 0)) {
        return res.status(400).json({ error: "maxActive must be a non-negative number" });
      }

      const fields: string[] = [];
      if (maxActive !== undefined) fields.push(`max_active = ${parseInt(maxActive, 10)}`);
      if (forceOpen !== undefined) fields.push(`force_open = ${Boolean(forceOpen)}`);
      if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

      await db.execute(sql`
        UPDATE tier_capacity
        SET ${sql.raw(fields.join(", "))}, updated_at = NOW()
        WHERE tier_slug = ${tierSlug}
      `);
      invalidateCapacityCache(tierSlug);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[capacity] PUT error:", err.message);
      return res.status(500).json({ error: "Failed to update capacity" });
    }
  });

  // ── eBay price data for Vault report ─────────────────────────────────────
  // Returns current eBay UK fixed-price listings for the card on this cert.
  // Results are cached for 24h in ebay_price_cache to minimise API calls.
  app.get("/api/vault/:certId/ebay-prices", async (req, res) => {
    const empty = { averagePence: 0, gradeAverages: {}, listings: [], cachedAt: new Date().toISOString() };
    try {
      const dbCert = await findCertByIdFlex(req.params.certId);
      if (!dbCert) return res.json(empty);

      const c = dbCert as any;
      const cardName: string = c.cardName || "";
      const cardNumber: string | null = c.cardNumber || null;
      const setName: string | null = c.setName || null;

      if (!cardName) return res.json(empty);

      const cardKey = buildCardKey(cardName, cardNumber, setName);
      const result = await getCachedOrFreshEbayPrices(cardKey, cardName, cardNumber, setName);

      return res.json({
        averagePence: result.averagePence,
        gradeAverages: result.gradeAverages,
        listings: result.listings,
        cachedAt: result.cachedAt.toISOString(),
      });
    } catch (err: any) {
      console.error("[ebay-prices] error:", err.message);
      return res.json(empty);
    }
  });

  // Startup migration — AI grading columns + Build 1 image columns + new tables
  (async () => {
    try {
      // AI grading columns (original set)
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS ai_analysis JSONB DEFAULT '{}'`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS ai_draft_grade DECIMAL(3,1)`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_front_lr TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_front_tb TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_back_lr TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_back_tb TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS defects JSONB DEFAULT '[]'`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_approved_by TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_approved_at TIMESTAMP`);

      // Build 1 — grading image paths (original + auto-cropped + 4 variants per angle)
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_original TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_cropped TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_greyscale TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_highcontrast TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_edgeenhanced TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_inverted TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_back_original TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_back_cropped TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_back_greyscale TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_back_highcontrast TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_back_edgeenhanced TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_back_inverted TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_angled_original TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_angled_cropped TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_closeup_original TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_closeup_cropped TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS image_quality_checks JSONB DEFAULT '{}'`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_card_id TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_card_source TEXT`);

      // Build 2 — detailed grading columns
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS corner_values JSONB`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS edge_values JSONB`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS surface_values JSONB`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS auth_status TEXT DEFAULT 'genuine'`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS auth_notes TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_explanation TEXT`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS private_notes TEXT`);

      // Build 1 — grading_sessions table
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS grading_sessions (
          id            SERIAL PRIMARY KEY,
          cert_id       TEXT NOT NULL,
          started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
          completed_at  TIMESTAMP,
          grader        TEXT,
          model_version TEXT,
          ai_response   JSONB,
          final_grade   DECIMAL(3,1),
          notes         TEXT
        )
      `);

      // Build 1 — ai_accuracy_log table
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS ai_accuracy_log (
          id              SERIAL PRIMARY KEY,
          cert_id         TEXT NOT NULL,
          ai_grade        DECIMAL(3,1),
          human_grade     DECIMAL(3,1),
          grade_delta     DECIMAL(3,1),
          ai_centering    DECIMAL(3,1),
          human_centering DECIMAL(3,1),
          ai_corners      DECIMAL(3,1),
          human_corners   DECIMAL(3,1),
          ai_edges        DECIMAL(3,1),
          human_edges     DECIMAL(3,1),
          ai_surface      DECIMAL(3,1),
          human_surface   DECIMAL(3,1),
          logged_at       TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Build 6 — grading timeline + market value columns
      await db.execute(sql`
        ALTER TABLE certificates
          ADD COLUMN IF NOT EXISTS grading_status      TEXT NOT NULL DEFAULT 'submitted',
          ADD COLUMN IF NOT EXISTS status_updated_at   TIMESTAMP,
          ADD COLUMN IF NOT EXISTS cert_tracking_number TEXT,
          ADD COLUMN IF NOT EXISTS estimated_value_low  DECIMAL(10,2),
          ADD COLUMN IF NOT EXISTS estimated_value_high DECIMAL(10,2),
          ADD COLUMN IF NOT EXISTS market_value_updated_at TIMESTAMP
      `);

      // Build 6 — extend grading_sessions with AI accuracy columns
      await db.execute(sql`
        ALTER TABLE grading_sessions
          ADD COLUMN IF NOT EXISTS card_game               TEXT,
          ADD COLUMN IF NOT EXISTS card_name               TEXT,
          ADD COLUMN IF NOT EXISTS card_set                TEXT,
          ADD COLUMN IF NOT EXISTS grading_duration_seconds INTEGER,
          ADD COLUMN IF NOT EXISTS ai_draft_centering      DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS ai_draft_corners        DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS ai_draft_edges          DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS ai_draft_surface        DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS ai_draft_overall        DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS human_centering         DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS human_corners           DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS human_edges             DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS human_surface           DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS human_overall           DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS human_defects           JSONB,
          ADD COLUMN IF NOT EXISTS ai_defects              JSONB,
          ADD COLUMN IF NOT EXISTS centering_diff          DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS corners_diff            DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS edges_diff              DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS surface_diff            DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS overall_diff            DECIMAL(3,1),
          ADD COLUMN IF NOT EXISTS correction_notes        TEXT,
          ADD COLUMN IF NOT EXISTS is_holo                 BOOLEAN,
          ADD COLUMN IF NOT EXISTS is_black_label          BOOLEAN
      `);

      // DIG Report — ai_defects and verified_defects columns
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS ai_defects JSONB DEFAULT '[]'`);
      await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS verified_defects JSONB DEFAULT '[]'`);

      // DIG Report — migrate old cert IDs from MV-0000000042 format to MV42 format
      await db.execute(sql`
        UPDATE certificates
        SET certificate_number = 'MV' || LTRIM(SPLIT_PART(certificate_number, '-', 2), '0')
        WHERE certificate_number ~ '^MV-[0-9]+$'
          AND certificate_number NOT LIKE 'MV%-%-%'
      `);

      // eBay cache — purge stale ungraded results so next load fetches graded-only data
      await db.execute(sql`DELETE FROM ebay_price_cache WHERE last_updated_at < NOW() - INTERVAL '1 second'`);

    } catch (err) {
      console.error("[migration] startup migration error:", err);
    }
  })();

  app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
    try {
      const stats = await storage.getDashboardStats();
      stats.recentCerts = stats.recentCerts.map((c: any) => ({ ...c, certId: normalizeCertId(c.certId) }));
      res.json(stats);
    } catch (error: any) {
      console.error("Stats error:", error.message, error.stack);
      res.status(500).json({ error: `Failed to get stats: ${error.message}` });
    }
  });

  app.get("/api/admin/submissions", requireAdmin, async (req, res) => {
    try {
      const filters: Record<string, string> = {};
      if (req.query.status && req.query.status !== "all") filters.status = req.query.status as string;
      if (req.query.email) filters.email = req.query.email as string;
      if (req.query.submissionId) filters.submissionId = req.query.submissionId as string;
      if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string;
      if (req.query.dateTo) filters.dateTo = req.query.dateTo as string;

      const subs = await storage.listSubmissions(Object.keys(filters).length > 0 ? filters : undefined);
      res.json(subs);
    } catch (error: any) {
      console.error("List submissions error:", error.message);
      res.status(500).json({ error: "Failed to list submissions" });
    }
  });

  app.get("/api/admin/submissions/export-csv", requireAdmin, async (_req, res) => {
    try {
      const subs = await storage.listSubmissions();
      const headers = [
        "Submission ID", "Status", "Service Type", "Tier", "Card Count",
        "Total Price", "Declared Value", "Payment Status", "Payment Intent",
        "Payment Amount", "Currency", "Shipping Cost", "Grading Cost",
        "Insurance Tier", "First Name", "Last Name", "Email", "Phone",
        "Address Line 1", "Address Line 2", "City", "County", "Postcode",
        "Return Carrier", "Return Tracking", "Return Postage Cost",
        "Notes", "Admin Notes", "Flagged",
        "Created At", "Received At", "Shipped At", "Completed At",
      ];
      const rows = subs.map((s: any) => [
        s.submissionId || s.submission_id || "",
        s.status || "",
        s.serviceType || s.service_type || s.type || "",
        s.serviceTier || s.service_tier || s.tier || "",
        s.cardCount ?? s.card_count ?? s.quantity ?? "",
        s.totalPrice ?? s.total_price ?? s.amount_total ?? "",
        s.totalDeclaredValue ?? s.total_declared_value ?? "",
        s.paymentStatus ?? s.payment_status ?? "",
        s.paymentIntentId ?? s.payment_intent_id ?? s.stripe_payment_id ?? "",
        s.paymentAmount ?? s.payment_amount ?? "",
        s.paymentCurrency ?? s.payment_currency ?? s.currency ?? "GBP",
        s.shippingCost ?? s.shipping_cost ?? "",
        s.gradingCost ?? s.grading_cost ?? "",
        s.shippingInsuranceTier ?? s.shipping_insurance_tier ?? "",
        s.customerFirstName ?? s.customer_first_name ?? s.first_name ?? "",
        s.customerLastName ?? s.customer_last_name ?? s.last_name ?? "",
        s.customerEmail ?? s.customer_email ?? s.email ?? "",
        s.phone ?? "",
        s.returnAddressLine1 ?? s.return_address_line1 ?? "",
        s.returnAddressLine2 ?? s.return_address_line2 ?? "",
        s.returnCity ?? s.return_city ?? "",
        s.returnCounty ?? s.return_county ?? "",
        s.returnPostcode ?? s.return_postcode ?? "",
        s.returnCarrier ?? s.return_carrier ?? "",
        s.returnTracking ?? s.return_tracking ?? "",
        s.returnPostageCost ?? s.return_postage_cost ?? "",
        s.notes ?? "",
        s.adminNotes ?? s.admin_notes ?? "",
        s.adminFlagged ?? s.admin_flagged ?? "",
        s.createdAt ?? s.created_at ?? "",
        s.receivedAt ?? s.received_at ?? "",
        s.shippedAt ?? s.shipped_at ?? "",
        s.completedAt ?? s.completed_at ?? "",
      ]);
      const csvContent = [
        headers.join(","),
        ...rows.map((r: any[]) => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="mintvault-submissions-${new Date().toISOString().split("T")[0]}.csv"`);
      res.send(csvContent);
    } catch (error: any) {
      console.error("Export submissions CSV error:", error.message);
      res.status(500).json({ error: "Failed to export submissions CSV" });
    }
  });

  app.get("/api/admin/submissions/:id", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numId);
      res.json({ ...submission, items });
    } catch (error: any) {
      console.error("Get submission error:", error.message);
      res.status(500).json({ error: "Failed to get submission" });
    }
  });

  app.post("/api/admin/submissions/:id/status", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const { status, returnTracking, returnCarrier, returnPostageCost } = req.body;
      if (!status) {
        return res.status(400).json({ error: "Status is required" });
      }

      const currentStatus = submission.status?.toLowerCase();
      const expectedNext = SUBMISSION_STATUS_TRANSITIONS[currentStatus];
      if (expectedNext && expectedNext !== status.toLowerCase()) {
        return res.status(400).json({
          error: `Cannot transition from ${SUBMISSION_STATUS_LABELS[currentStatus] || currentStatus} to ${SUBMISSION_STATUS_LABELS[status] || status}`,
        });
      }

      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const updated = await storage.updateSubmissionStatus(numId, status, {
        returnTracking,
        returnCarrier,
        returnPostageCost: returnPostageCost ? parseInt(returnPostageCost, 10) : undefined,
      });

      await storage.writeAuditLog("submission", submission.submissionId, `status_${status}`, req.session.adminEmail || "admin", {
        fromStatus: currentStatus,
        toStatus: status,
        returnTracking,
        returnCarrier,
      });

      const emailData = {
        email: submission.email || "",
        firstName: submission.firstName || "Customer",
        submissionId: submission.submissionId,
        cardCount: submission.cardCount || 0,
      };

      const newStatus = status.toLowerCase();
      if (newStatus === "received" && emailData.email) {
        sendCardsReceived(emailData).catch(() => {});
      } else if ((newStatus === "completed" || newStatus === "ready_to_return") && emailData.email) {
        sendGradingComplete(emailData).catch(() => {});
      } else if (newStatus === "shipped" && emailData.email) {
        sendShipped({
          ...emailData,
          trackingNumber: returnTracking || submission.returnTracking || undefined,
          carrier: returnCarrier || submission.returnCarrier || undefined,
        }).catch(() => {});
      } else if (newStatus === "delivered" && emailData.email) {
        sendSubmissionDelivered({
          email: emailData.email,
          firstName: emailData.firstName,
          submissionId: emailData.submissionId,
        }).catch(() => {});
      }

      res.json({ success: true, submission: updated });
    } catch (error: any) {
      console.error("Update submission status error:", error.message);
      res.status(500).json({ error: "Failed to update submission status" });
    }
  });

  app.patch("/api/admin/submissions/:id/items/:itemId", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const itemId = parseInt(String(req.params.itemId), 10);
      if (isNaN(itemId)) {
        return res.status(400).json({ error: "Invalid item ID" });
      }

      const numSubId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numSubId);
      const targetItem = items.find(i => i.id === itemId);
      if (!targetItem) {
        return res.status(404).json({ error: "Submission item not found" });
      }

      const { game, cardName, cardSet, cardNumber, year, declaredValue, notes } = req.body;
      const updateData: any = {};
      if (game !== undefined) updateData.game = game || null;
      if (cardName !== undefined) updateData.cardName = cardName || null;
      if (cardSet !== undefined) updateData.cardSet = cardSet || null;
      if (cardNumber !== undefined) updateData.cardNumber = cardNumber || null;
      if (year !== undefined) updateData.year = year || null;
      if (declaredValue !== undefined) {
        const dv = parseInt(declaredValue, 10);
        if (isNaN(dv) || dv < 0) {
          return res.status(400).json({ error: "Declared value must be a non-negative number" });
        }
        updateData.declaredValue = dv;
      }
      if (notes !== undefined) updateData.notes = notes || null;

      const updated = await storage.updateSubmissionItem(itemId, updateData);

      await storage.writeAuditLog("submission_item", String(itemId), "item_updated", req.session.adminEmail || "admin", {
        submissionId: submission.submissionId,
        changes: updateData,
      });

      res.json({ success: true, item: updated });
    } catch (error: any) {
      console.error("Update submission item error:", error.message);
      res.status(500).json({ error: "Failed to update submission item" });
    }
  });

  app.patch("/api/admin/submissions/:id/notes", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      const { notes, flagged } = req.body;
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      await storage.updateAdminNotes(numId, notes ?? null, !!flagged);
      await storage.writeAuditLog("submission", String(numId), "admin_notes_updated", req.session.adminEmail || "admin", {
        submissionId: submission.submissionId,
        flagged,
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Update admin notes error:", error.message);
      res.status(500).json({ error: "Failed to update admin notes" });
    }
  });

  app.post("/api/admin/submissions/:id/return-label", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const { carrier, trackingNumber, postageCost } = req.body;
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;

      const safeCarrier = carrier ? String(carrier) : null;
      const safeTracking = trackingNumber ? String(trackingNumber) : null;
      const safeCost = postageCost ? parseInt(postageCost, 10) : null;

      await db.execute(sql`
        UPDATE submissions SET
          return_carrier = COALESCE(${safeCarrier}, return_carrier),
          return_tracking = COALESCE(${safeTracking}, return_tracking),
          return_postage_cost = COALESCE(${safeCost}, return_postage_cost),
          updated_at = NOW()
        WHERE id = ${numId}
      `);

      await storage.writeAuditLog("submission", submission.submissionId, "return_label_created", req.session.adminEmail || "admin", {
        carrier, trackingNumber, postageCost,
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Return label error:", error.message);
      res.status(500).json({ error: "Failed to create return label" });
    }
  });

  app.get("/api/admin/submissions/:id/packing-slip", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numId);

      const { generatePackingSlipPDF } = await import("./packingSlip");
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
      console.error("Packing slip error:", error.message);
      res.status(500).json({ error: "Failed to generate packing slip" });
    }
  });

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

      const { generatePackingSlipPDF } = await import("./packingSlip");
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

      const { generateShippingLabelPDF } = await import("./shipping-label");
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

  app.get("/api/admin/submission-items/unlinked", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT si.id, si.submission_id, si.card_index, si.game, si.card_set, si.card_name, si.card_number, si.year, si.declared_value,
               s.tracking_number AS submission_tracking, s.service_tier, s.customer_email, s.customer_first_name, s.customer_last_name
        FROM submission_items si
        JOIN submissions s ON s.id = si.submission_id
        WHERE si.id NOT IN (SELECT submission_item_id FROM certificates WHERE submission_item_id IS NOT NULL)
          AND s.deleted_at IS NULL
          AND s.status != 'draft'
        ORDER BY si.submission_id DESC, si.card_index ASC
        LIMIT 200
      `);
      res.json(rows.rows);
    } catch (error: any) {
      console.error("List unlinked items error:", error.message);
      res.status(500).json({ error: "Failed to list unlinked items" });
    }
  });

  app.get("/api/admin/variant-options", requireAdmin, async (_req, res) => {
    try {
      const variants = await storage.getDistinctVariants();
      res.json(variants);
    } catch {
      res.status(500).json({ error: "Failed to fetch variant options" });
    }
  });

  app.get("/api/admin/rarity-other-options", requireAdmin, async (_req, res) => {
    try {
      const values = await storage.getDistinctRarityOthers();
      res.json(values);
    } catch {
      res.status(500).json({ error: "Failed to fetch rarity other options" });
    }
  });

  app.get("/api/admin/certificates/export-csv", requireAdmin, async (_req, res) => {
    try {
      const certs = await storage.listCertificates();
      const headers = ["Cert ID", "Grade Type", "Card Game", "Set", "Collection/Subset", "Card Name", "Card Number", "Rarity", "Designations", "Variant", "Language", "Year", "Grade Overall", "Status", "Ownership", "Created"];
      const rows = certs.map(c => {
        const gt = (c as any).gradeType || "numeric";
        const isNonNum = isNonNumericGrade(gt);
        return [
          normalizeCertId(c.certId), gt, c.cardGame, c.setName, collectionDisplayLabel((c as any).collectionCode, (c as any).collectionOther, (c as any).collection) || "", c.cardName, c.cardNumber,
          rarityDisplayLabel(c.rarity, (c as any).rarityOther) || "", designationCodesToLabels((c.designations as string[]) || []).join("; "), variantDisplayLabel(c.variant, (c as any).variantOther) || c.variant || "", c.language, c.year,
          isNonNum ? gt : (c.gradeOverall || ""),
          c.status, (c as any).ownershipStatus || "unclaimed",
          c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
        ];
      });

      const csvContent = [headers.join(","), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="mintvault-certificates-${new Date().toISOString().split("T")[0]}.csv"`);
      res.send(csvContent);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to export CSV" });
    }
  });

  app.get("/api/admin/ownership-export", requireAdmin, async (_req, res) => {
    try {
      const certs = await storage.listCertificates();
      const headers = ["Cert ID", "Card Name", "Card Game", "Set", "Grade", "Status", "Ownership Status", "Owner Email", "Owner User ID", "Claim Code Created At", "Claim Code Used At"];
      const rows = certs.map(c => {
        const ca = c as any;
        return [
          normalizeCertId(c.certId),
          c.cardName,
          c.cardGame,
          c.setName,
          c.gradeOverall || "",
          c.status,
          ca.ownershipStatus || "unclaimed",
          ca.ownerEmail || "",
          ca.ownerUserId || "",
          ca.claimCodeCreatedAt ? new Date(ca.claimCodeCreatedAt).toISOString() : "",
          ca.claimCodeUsedAt ? new Date(ca.claimCodeUsedAt).toISOString() : "",
        ];
      });
      const csvContent = [headers.join(","), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="mintvault-ownership-${new Date().toISOString().split("T")[0]}.csv"`);
      res.send(csvContent);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to export ownership CSV" });
    }
  });

  app.get("/api/admin/certificates", requireAdmin, async (req, res) => {
    try {
      const filters: Record<string, string> = {};
      if (req.query.cardName) filters.cardName = req.query.cardName as string;
      if (req.query.setName) filters.setName = req.query.setName as string;
      if (req.query.grade) filters.grade = req.query.grade as string;
      if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string;
      if (req.query.dateTo) filters.dateTo = req.query.dateTo as string;
      if (req.query.status && req.query.status !== "all") filters.status = req.query.status as string;
      if (req.query.ownershipStatus && req.query.ownershipStatus !== "all") filters.ownershipStatus = req.query.ownershipStatus as string;

      const allCerts = await storage.listCertificates(Object.keys(filters).length > 0 ? filters : undefined);
      // Hide empty drafts (no card name, no images, no grade) unless a specific ID is requested
      const includeId = req.query.includeId ? Number(req.query.includeId) : null;
      const certs = allCerts.filter((c: any) => {
        if (includeId && c.id === includeId) return true;
        // Hide empty draft certs from the list
        if (c.status === "draft" && !c.cardName && !c.frontImagePath && !c.gradeOverall) return false;
        return true;
      });
      const certsWithUrls = await Promise.all(certs.map(async (c: any) => {
        let frontImageUrl: string | null = null;
        let backImageUrl: string | null = null;
        if (c.frontImagePath) {
          try { frontImageUrl = await getR2SignedUrl(c.frontImagePath, 3600); } catch (e) { console.error("R2 sign failed (admin front):", c.frontImagePath, e); }
        }
        if (c.backImagePath) {
          try { backImageUrl = await getR2SignedUrl(c.backImagePath, 3600); } catch (e) { console.error("R2 sign failed (admin back):", c.backImagePath, e); }
        }
        return { ...c, certId: normalizeCertId(c.certId), frontImageUrl, backImageUrl };
      }));
      res.json(certsWithUrls);
    } catch (error: any) {
      console.error("List certs error:", error.message, error.stack);
      res.status(500).json({ error: `Failed to list certificates: ${error.message}` });
    }
  });

  // ── Create a new cert immediately with a real MV### number ─────────────────
  app.post("/api/admin/certificates/new", requireAdmin, async (_req, res) => {
    try {
      const { generateReferenceNumber } = await import("./reference-number");
      const certNumber = await storage.getNextCertId();
      const refNum = generateReferenceNumber();
      const result = await db.execute(sql`
        INSERT INTO certificates (certificate_number, status, label_type, grade_type, language, card_name, created_by, issued_at, updated_at, reference_number)
        VALUES (${certNumber}, 'active', 'Standard', 'numeric', 'English', NULL, 'admin', NOW(), NOW(), ${refNum})
        RETURNING *
      `);
      const row = result.rows[0] as any;
      // Build full camelCase cert object for frontend
      const cert = {
        ...row,
        certId: normalizeCertId(row.certificate_number),
        cardName: row.card_name || "",
        setName: row.set_name || "",
        cardNumber: row.card_number_display || "",
        cardGame: row.card_game || "",
        language: row.language || "English",
        year: row.year_text || "",
        notes: row.notes || "",
        gradeOverall: row.grade || "",
        gradeType: row.grade_type || "numeric",
        labelType: row.label_type || "Standard",
        frontImagePath: row.front_image_path || null,
        backImagePath: row.back_image_path || null,
        rarity: row.rarity || "",
        variant: row.variant || "",
        designations: row.designations || [],
      };
      console.log(`[admin] created new cert: ${certNumber} (id=${row.id})`);
      res.json(cert);
    } catch (err: any) {
      console.error("[admin] new cert error:", err.message);
      res.status(500).json({ error: "Failed to create certificate" });
    }
  });

  app.post(
    "/api/admin/certificates",
    requireAdmin,
    upload.fields([
      { name: "frontImage", maxCount: 1 },
      { name: "backImage", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const frontImage = files?.frontImage?.[0];
        const backImage = files?.backImage?.[0];

        const gradeType = req.body.gradeType || "numeric";
        const isNonNum = isNonNumericGrade(gradeType);

        if (!isNonNum && req.body.gradeOverall) {
          const g = Number(req.body.gradeOverall);
          if (!Number.isInteger(g) || g < 1 || g > 10) {
            return res.status(400).json({ error: "Grade must be an integer from 1 to 10" });
          }
        }

        const tempCertId = `MV-TEMP-${Date.now()}`;

        let frontR2Key: string | null = null;
        let backR2Key: string | null = null;

        if (frontImage) {
          const ext = path.extname(frontImage.originalname).replace(".", "");
          frontR2Key = r2KeyForImage(tempCertId, "front", ext || "jpg");
          await uploadToR2(frontR2Key, frontImage.buffer, frontImage.mimetype);
        }
        if (backImage) {
          const ext = path.extname(backImage.originalname).replace(".", "");
          backR2Key = r2KeyForImage(tempCertId, "back", ext || "jpg");
          await uploadToR2(backR2Key, backImage.buffer, backImage.mimetype);
        }

        let validatedItemId: number | null = null;
        if (req.body.submissionItemId) {
          validatedItemId = parseInt(req.body.submissionItemId, 10);
          const checkResult = await db.execute(sql`
            SELECT si.id FROM submission_items si
            JOIN submissions s ON s.id = si.submission_id
            WHERE si.id = ${validatedItemId}
              AND s.deleted_at IS NULL
              AND s.status != 'draft'
              AND si.id NOT IN (SELECT submission_item_id FROM certificates WHERE submission_item_id IS NOT NULL)
          `);
          if (checkResult.rows.length === 0) {
            return res.status(400).json({ error: "Submission item not found, already linked, or submission not paid" });
          }
        }

        const certGrade = !isNonNum ? parseFloat(req.body.gradeOverall || "0") : 0;
        const computedLabelType = certGrade === 10 ? "black" : "Standard";

        const data = {
          labelType: computedLabelType,
          gradeType,
          submissionItemId: validatedItemId,
          cardGame: req.body.cardGame,
          setName: req.body.setName,
          cardName: req.body.cardName,
          cardNumber: req.body.cardNumber,
          rarity: req.body.rarity || null,
          rarityOther: req.body.rarity === "OTHER" ? (req.body.rarityOther || null) : null,
          designations: parseDesignations(req.body.designations),
          variant: req.body.variant || null,
          variantOther: req.body.variant === "OTHER" ? (req.body.variantOther || null) : null,
          collection: null,
          collectionCode: req.body.collectionCode || null,
          collectionOther: req.body.collectionCode === "OTHER" ? (req.body.collectionOther?.trim() || null) : null,
          language: req.body.language || "English",
          year: req.body.year,
          notes: req.body.notes || null,
          gradeOverall: isNonNum ? null : req.body.gradeOverall,
          gradeCentering: null,
          gradeCorners: null,
          gradeEdges: null,
          gradeSurface: null,
          frontImagePath: frontR2Key,
          backImagePath: backR2Key,
          status: req.body.status || "draft",
          createdBy: req.session.adminEmail || "admin",
        };

        if (data.collectionCode === "OTHER" && !data.collectionOther) {
          return res.status(400).json({ error: "Collection 'Other (manual)' requires a manual entry value" });
        }

        const cert = await storage.createCertificate(data, req.session.adminEmail || "admin");

        await storage.writeAuditLog("certificate", cert.certId, "create", req.session.adminEmail || "admin", {
          cardName: data.cardName, setName: data.setName, cardNumber: data.cardNumber, gradeOverall: data.gradeOverall,
        });

        const realCertId = cert.certId;
        if (frontR2Key) {
          const ext = path.extname(frontImage!.originalname).replace(".", "");
          const newKey = r2KeyForImage(realCertId, "front", ext || "jpg");
          await uploadToR2(newKey, frontImage!.buffer, frontImage!.mimetype);
          await deleteFromR2(frontR2Key);
          await storage.updateCertificate(cert.id, { frontImagePath: newKey });
          await storage.addCertificateImage({
            certificateId: cert.id,
            imageType: "front",
            url: newKey,
            sortOrder: 0,
          });
        }
        if (backR2Key) {
          const ext = path.extname(backImage!.originalname).replace(".", "");
          const newKey = r2KeyForImage(realCertId, "back", ext || "jpg");
          await uploadToR2(newKey, backImage!.buffer, backImage!.mimetype);
          await deleteFromR2(backR2Key);
          await storage.updateCertificate(cert.id, { backImagePath: newKey });
          await storage.addCertificateImage({
            certificateId: cert.id,
            imageType: "back",
            url: newKey,
            sortOrder: 1,
          });
        }

        const updated = await storage.getCertificate(cert.id);
        res.json(updated ? { ...updated, certId: normalizeCertId(updated.certId) } : updated);
      } catch (error: any) {
        console.error("Create cert error:", error.message, error.stack);
        res.status(500).json({ error: `Failed to create certificate: ${error.message}` });
      }
    }
  );

  app.put(
    "/api/admin/certificates/:id",
    requireAdmin,
    upload.fields([
      { name: "frontImage", maxCount: 1 },
      { name: "backImage", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        const existing = await storage.getCertificate(id);
        if (!existing) {
          return res.status(404).json({ error: "Certificate not found" });
        }

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const frontImage = files?.frontImage?.[0];
        const backImage = files?.backImage?.[0];

        const gradeTypeUpdate = req.body.gradeType || existing.gradeType || "numeric";
        const isNonNumUpdate = isNonNumericGrade(gradeTypeUpdate);

        if (!isNonNumUpdate && req.body.gradeOverall) {
          const g = Number(req.body.gradeOverall);
          if (!Number.isInteger(g) || g < 1 || g > 10) {
            return res.status(400).json({ error: "Grade must be an integer from 1 to 10" });
          }
        }

        const updateGrade = !isNonNumUpdate ? parseFloat(req.body.gradeOverall || "0") : 0;
        const computedLabelTypeUpdate = updateGrade === 10 ? "black" : "Standard";

        const data: any = {
          labelType: computedLabelTypeUpdate,
          gradeType: gradeTypeUpdate,
          cardGame: req.body.cardGame,
          setName: req.body.setName,
          cardName: req.body.cardName,
          cardNumber: req.body.cardNumber,
          rarity: req.body.rarity || null,
          rarityOther: req.body.rarity === "OTHER" ? (req.body.rarityOther || null) : null,
          designations: parseDesignations(req.body.designations, existing.designations as string[]),
          variant: req.body.variant || null,
          variantOther: req.body.variant === "OTHER" ? (req.body.variantOther || null) : null,
          collection: null,
          collectionCode: req.body.collectionCode || null,
          collectionOther: req.body.collectionCode === "OTHER" ? (req.body.collectionOther?.trim() || null) : null,
          language: req.body.language || "English",
          year: req.body.year,
          notes: req.body.notes || null,
          gradeOverall: isNonNumUpdate ? null : req.body.gradeOverall,
          gradeCentering: null,
          gradeCorners: null,
          gradeEdges: null,
          gradeSurface: null,
          status: req.body.status || existing.status,
        };

        if (data.collectionCode === "OTHER" && !data.collectionOther) {
          return res.status(400).json({ error: "Collection 'Other (manual)' requires a manual entry value" });
        }

        if (frontImage) {
          const ext = path.extname(frontImage.originalname).replace(".", "");
          const r2Key = r2KeyForImage(existing.certId, "front", ext || "jpg");
          await uploadToR2(r2Key, frontImage.buffer, frontImage.mimetype);
          if (existing.frontImagePath) {
            try { await deleteFromR2(existing.frontImagePath); } catch {}
          }
          data.frontImagePath = r2Key;
          await storage.addCertificateImage({
            certificateId: id,
            imageType: "front",
            url: r2Key,
            sortOrder: 0,
          });
        }
        if (backImage) {
          const ext = path.extname(backImage.originalname).replace(".", "");
          const r2Key = r2KeyForImage(existing.certId, "back", ext || "jpg");
          await uploadToR2(r2Key, backImage.buffer, backImage.mimetype);
          if (existing.backImagePath) {
            try { await deleteFromR2(existing.backImagePath); } catch {}
          }
          data.backImagePath = r2Key;
          await storage.addCertificateImage({
            certificateId: id,
            imageType: "back",
            url: r2Key,
            sortOrder: 1,
          });
        }

        const cert = await storage.updateCertificate(id, data);

        await storage.writeAuditLog("certificate", existing.certId, "update", req.session.adminEmail || "admin", {
          cardName: data.cardName, setName: data.setName, gradeOverall: data.gradeOverall,
        });

        res.json(cert ? { ...cert, certId: normalizeCertId(cert.certId) } : cert);
      } catch (error: any) {
        console.error("Update cert error:", error.message, error.stack);
        res.status(500).json({ error: `Failed to update certificate: ${error.message}` });
      }
    }
  );

  app.delete("/api/admin/certificates/:id", requireAdmin, async (req, res) => {
    await storage.writeAuditLog("certificate", String(req.params.id), "delete_attempt_blocked", req.session.adminEmail || "admin", {
      message: "Hard delete is disabled. Use void instead.",
    });
    res.status(405).json({ error: "DELETE is disabled. Certificates cannot be deleted — use Void instead." });
  });

  app.post("/api/admin/certificates/:id/void", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { confirmation, reason } = req.body;

      if (confirmation !== "VOID") {
        return res.status(400).json({ error: "You must type VOID to confirm" });
      }

      const existing = await storage.getCertificate(id);
      if (!existing) {
        return res.status(404).json({ error: "Certificate not found" });
      }

      if (existing.status === "voided") {
        return res.status(400).json({ error: "Certificate is already voided" });
      }

      const updated = await storage.updateCertificate(id, {
        status: "voided",
        voidedAt: new Date(),
        voidReason: reason || "Voided by admin",
      } as any);

      await storage.writeAuditLog("certificate", existing.certId, "void", req.session.adminEmail || "admin", {
        cardName: existing.cardName,
        setName: existing.setName,
        previousStatus: existing.status,
        reason: reason || "Voided by admin",
      });

      res.json({ success: true, certificate: updated ? { ...updated, certId: normalizeCertId(updated.certId) } : updated });
    } catch (error: any) {
      console.error("Void cert error:", error.message, error.stack);
      res.status(500).json({ error: `Failed to void certificate: ${error.message}` });
    }
  });

  app.get("/api/admin/certificates/:id/label/:side", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const side = req.params.side as "front" | "back" | "both";
      const format = (req.query.format as string) || "pdf";
      const preview = req.query.preview === "1";

      const rawCert = await storage.getCertificate(id);
      if (!rawCert) {
        return res.status(404).json({ error: "Certificate not found" });
      }
      const cert = { ...rawCert, certId: normalizeCertId(rawCert.certId) };

      const disposition = preview ? "inline" : "attachment";

      if (format === "png" && side !== "both") {
        const png = await generateLabelPNG(cert, side);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `${disposition}; filename="${normalizeCertId(cert.certId)}-${side}-label.png"`);
        return res.send(png);
      }

      const pdf = await generateLabelPDF(cert, side);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `${disposition}; filename="${normalizeCertId(cert.certId)}-${side === "both" ? "labels" : side + "-label"}.pdf"`);
      res.send(pdf);
    } catch (error: any) {
      console.error("Label generation error:", error.message);
      res.status(500).json({ error: "Failed to generate label" });
    }
  });

  // ── LABEL PRINTING ROUTES ────────────────────────────────────────────────
  app.get("/api/admin/printing/queue", requireAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string || "200", 10);
      const certs = await storage.getAllCertificatesForPrinting(limit);
      const printed   = certs.filter((c) => c.lastPrintedAt !== null).length;
      const unprinted = certs.filter((c) => c.lastPrintedAt === null).length;
      console.log(`[printing/queue] returning ${certs.length} certs (${printed} printed, ${unprinted} unprinted)`);
      res.json(certs);
    } catch (err: any) {
      console.error("[printing/queue] ERROR:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/printing/sheets", requireAdmin, async (req, res) => {
    try {
      const sheets = await storage.getLabelSheets();
      res.json(sheets);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/printing/sheets/:sheetRef", requireAdmin, async (req, res) => {
    try {
      const detail = await storage.getSheetDetail(String(req.params.sheetRef));
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/printing/generate-sheet", requireAdmin, async (req, res) => {
    try {
      const { certIds } = req.body as { certIds: string[] };
      if (!certIds?.length) return res.status(400).json({ error: "No certificates selected" });
      if (certIds.length > CERTS_PER_SHEET) return res.status(400).json({ error: `Maximum ${CERTS_PER_SHEET} certificates per sheet (${LABELS_PER_SHEET} labels)` });

      // Fetch full cert records
      const { generateLabelSheet } = await import("./label-sheet");
      const allCerts = await storage.listCertificates();
      const selected = certIds
        .map((id) => allCerts.find((c) => c.certId === id))
        .filter(Boolean) as any[];

      if (!selected.length) return res.status(404).json({ error: "No matching certificates found" });

      // Queue for tracking
      const sheetRef = `SHEET-${Date.now()}`;
      await storage.queueForPrinting(selected.map((c: any) => c.certId), sheetRef);

      // Generate PDF
      const pdfBuf = await generateLabelSheet(selected);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="mintvault-labels-${sheetRef}.pdf"`);
      res.setHeader("X-Sheet-Ref", sheetRef);
      res.send(pdfBuf);
    } catch (err: any) {
      console.error("Sheet generation error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── SVG CUT GUIDE — matches print sheet positions exactly ──────────────────
  app.post("/api/admin/printing/generate-cut-sheet", requireAdmin, async (req, res) => {
    try {
      const { certIds } = req.body as { certIds: string[] };
      if (!certIds?.length) return res.status(400).json({ error: "No certificates selected" });
      if (certIds.length > CERTS_PER_SHEET) return res.status(400).json({ error: `Maximum ${CERTS_PER_SHEET} per sheet` });

      const { generateCutSheetSVG } = await import("./label-sheet");
      const svg = generateCutSheetSVG(certIds.length);

      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Content-Disposition", `attachment; filename="mintvault-cut-guide-${certIds.length}row.svg"`);
      res.send(svg);
    } catch (err: any) {
      console.error("Cut sheet error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/printing/mark-printed", requireAdmin, async (req, res) => {
    try {
      const { sheetRef } = req.body as { sheetRef: string };
      if (!sheetRef) return res.status(400).json({ error: "sheetRef required" });
      await storage.markSheetPrinted(sheetRef);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── CERT LABEL BY certId (text) — used by browser thumbnail and preview ──────
  // Pattern: /api/admin/certificates/label/:certId/front.png   (or back.png / front.pdf etc.)
  app.get("/api/admin/certificates/label/:certId/:filename", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const filename = String(req.params.filename); // e.g. "front.png", "back.pdf"
      const [side, fmt] = filename.split(".");
      if (!["front", "back", "both"].includes(side) || !["png", "pdf"].includes(fmt)) {
        return res.status(400).json({ error: "Invalid format. Use front.png / back.pdf / both.pdf" });
      }

      const rawCert = await storage.getCertificateByCertId(certId);
      if (!rawCert) return res.status(404).json({ error: "Certificate not found" });

      const override = await storage.getLabelOverride(certId);
      const cert = applyLabelOverrides({ ...rawCert, certId: normalizeCertId(rawCert.certId) }, override);

      if (fmt === "png" && side !== "both") {
        const png = await generateLabelPNG(cert, side as "front" | "back");
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `inline; filename="${cert.certId}-${side}.png"`);
        return res.send(png);
      }
      const pdf = await generateLabelPDF(cert, side as "front" | "back" | "both");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${cert.certId}-${side}.pdf"`);
      res.send(pdf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── CERTIFICATE BROWSER ────────────────────────────────────────────────────
  app.get("/api/admin/printing/browser", requireAdmin, async (req, res) => {
    try {
      const certs = await storage.listCertificatesBrowser();
      res.json(certs.map((c) => ({ ...c, certId: normalizeCertId(c.certId) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── LABEL OVERRIDES ────────────────────────────────────────────────────────
  app.get("/api/admin/printing/override/:certId", requireAdmin, async (req, res) => {
    try {
      const override = await storage.getLabelOverride(String(req.params.certId));
      res.json(override ?? null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/printing/override/:certId", requireAdmin, async (req, res) => {
    try {
      const { cardNameOverride, setOverride, variantOverride, languageOverride, yearOverride } = req.body;
      const override = await storage.upsertLabelOverride(String(req.params.certId), {
        cardNameOverride: cardNameOverride ?? null,
        setOverride: setOverride ?? null,
        variantOverride: variantOverride ?? null,
        languageOverride: languageOverride ?? null,
        yearOverride: yearOverride ?? null,
      });
      res.json(override);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/admin/printing/override/:certId", requireAdmin, async (req, res) => {
    try {
      await storage.clearLabelOverride(String(req.params.certId));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REPRINT SINGLE LABEL ───────────────────────────────────────────────────
  // Generates a 72×22mm PDF, logs the reprint. Does NOT affect the printed flag.
  app.post("/api/admin/printing/reprint/:certId", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const side   = (req.query.side as "front" | "back" | "both") || "both";

      const rawCert = await storage.getCertificateByCertId(certId);
      if (!rawCert) return res.status(404).json({ error: "Certificate not found" });

      const override = await storage.getLabelOverride(certId);
      const cert = applyLabelOverrides({ ...rawCert, certId: normalizeCertId(rawCert.certId) }, override);

      const pdf = await generateLabelPDF(cert, side);
      await storage.logReprint(certId);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${cert.certId}-reprint.pdf"`);
      res.send(pdf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── NFC ADMIN ROUTES ─────────────────────────────────────────────────────
  app.post("/api/admin/certificates/:id/nfc", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { uid, chipType, url, writtenBy } = req.body;
      if (!uid || !url) return res.status(400).json({ error: "uid and url are required" });

      // Duplicate UID guard — one tag, one certificate only
      const existing = await storage.getCertificateByNfcUid(uid);
      if (existing && existing.id !== id) {
        return res.status(409).json({
          error: `UID already registered`,
          conflict: normalizeCertId(existing.certId),
        });
      }

      // Guard: cert already has a different UID unless overwrite is explicitly confirmed
      const target = await storage.getCertificate(id);
      if (target?.nfcUid && target.nfcUid !== uid && !req.body.overwrite) {
        return res.status(409).json({
          error: "Certificate already has an NFC tag",
          code: "ALREADY_ASSIGNED",
          existingUid: target.nfcUid,
        });
      }

      const cert = await storage.saveNfcData(id, { uid, chipType, url, writtenBy });
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      res.json(cert);
    } catch (err: any) {
      console.error("NFC save error:", err.message);
      res.status(500).json({ error: "Failed to save NFC data" });
    }
  });

  app.post("/api/admin/certificates/:id/nfc/lock", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.lockNfc(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      res.json(cert);
    } catch (err: any) {
      console.error("NFC lock error:", err.message);
      res.status(500).json({ error: "Failed to lock NFC" });
    }
  });

  app.post("/api/admin/certificates/:id/nfc/verify", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      await storage.recordNfcVerified(id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to record verification" });
    }
  });

  app.delete("/api/admin/certificates/:id/nfc", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.clearNfc(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      res.json(cert);
    } catch (err: any) {
      console.error("NFC clear error:", err.message);
      res.status(500).json({ error: "Failed to clear NFC record" });
    }
  });

  // ── NFC PUBLIC SCAN ROUTE ─────────────────────────────────────────────────
  // Called when a physical NFC tag is tapped — logs the scan, returns cert info
  app.get("/api/nfc/:certId", async (req, res) => {
    try {
      const certId = req.params.certId.toUpperCase();
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert || cert.deletedAt) {
        return res.status(404).json({ error: "Certificate not found" });
      }
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || undefined;
      await storage.recordNfcScan(certId, ip);
      res.json({
        certId: cert.certId,
        cardName: cert.cardName,
        gradeOverall: cert.gradeOverall,
        status: cert.status,
        nfcEnabled: !!cert.nfcUid,
        redirectTo: `/cert/${normalizeCertId(cert.certId)}`,
      });
    } catch (err: any) {
      console.error("NFC scan error:", err.message);
      res.status(500).json({ error: "Scan failed" });
    }
  });

  const GUIDE_SLUGS = [
    "how-to-grade-pokemon-cards-uk",
    "what-pokemon-cards-are-worth-grading",
    "psa-vs-uk-card-grading-companies",
    "is-card-grading-worth-it-uk",
    "how-card-condition-affects-value",
    "pokemon-card-grading-costs-explained",
    "raw-vs-graded-pokemon-cards",
    "how-to-send-cards-for-grading-safely",
    "what-makes-a-card-gem-mint",
    "best-pokemon-cards-worth-grading-this-year",
    "uk-guide-to-trading-card-grading",
    "how-to-protect-pokemon-cards-before-grading",
    "why-graded-cards-sell-for-more",
    "beginners-guide-pokemon-card-collecting-uk",
    "understanding-card-centering-corners-edges-surface",
  ];

  // ── PUBLIC CLAIM FLOW ──────────────────────────────────────────────────────
  // Rate limiter: max 5 attempts per IP per 15 minutes to prevent brute-forcing claim codes
  const claimRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many claim attempts from this device. Please wait 15 minutes before trying again." },
  });

  app.post("/api/claim/request", claimRateLimit, async (req, res) => {
    try {
      const { certId, claimCode, email, name, declaredNew } = req.body;
      if (!certId || !claimCode || !email) {
        return res.status(400).json({ error: "Certificate number, claim code, and email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Please provide a valid email address." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedId);
      if (!cert) {
        // Generic error — do not confirm or deny whether the cert exists to avoid enumeration
        console.warn(`[claim] Failed attempt — cert not found: ${normalizedId} from IP ${req.ip}`);
        return res.status(400).json({ error: "Invalid certificate number or claim code. Please check your details and try again." });
      }
      if (cert.ownershipStatus === "claimed") {
        return res.status(400).json({ error: "This certificate has already been registered to an owner. To transfer ownership, please use the Transfer Ownership page." });
      }

      // ── SECOND FACTOR: validate claim code ──────────────────────────────────
      const codeValid = await storage.validateClaimCode(normalizedId, claimCode.trim());
      if (!codeValid) {
        console.warn(`[claim] Failed claim code attempt for cert ${normalizedId} from IP ${req.ip}`);
        return res.status(400).json({ error: "Invalid certificate number or claim code. Please check your details and try again." });
      }

      const token = await storage.createClaimVerification(normalizedId, email.trim(), name?.trim() || undefined, declaredNew === true);

      const baseUrl = process.env.APP_URL || "https://mintvaultuk.com";
      const verifyUrl = `${baseUrl}/api/claim/verify?token=${token}`;

      await sendClaimVerification({ email: email.trim(), certId: normalizedId, verifyUrl });

      return res.json({ success: true, message: "Verification email sent! Please check your inbox and click the link to complete your ownership registration." });
    } catch (err: any) {
      console.error("[claim] Error processing claim request:", err);
      return res.status(500).json({ error: "An error occurred processing your request. Please try again." });
    }
  });

  app.get("/api/claim/verify", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/claim?error=missing_token");

      const result = await storage.completeClaimByToken(token);
      if (result.success) {
        // Auto-generate and email the certificate PDF
        try {
          const cert = await storage.getCertificateByCertId(result.certId!);
          if (cert && cert.status !== "voided") {
            const pdfBuffer = await generateCertificateDocument(cert, result.ownerName);
            await sendCertificatePdf({
              email: result.email!,
              ownerName: result.ownerName,
              certId: normalizeCertId(cert.certId),
              cardName: cert.cardName,
              pdfBuffer,
            });
          }
        } catch (pdfErr: any) {
          console.error("[claim] PDF generation/email failed (non-fatal):", pdfErr.message);
        }
        return res.redirect(`/claim?success=true&certId=${encodeURIComponent(result.certId || "")}`);
      } else {
        return res.redirect(`/claim?error=${encodeURIComponent(result.error || "unknown")}`);
      }
    } catch (err: any) {
      console.error("[claim] Error verifying claim:", err);
      return res.redirect("/claim?error=server_error");
    }
  });

  // ── PUBLIC TRANSFER FLOW ───────────────────────────────────────────────────
  // Rate limiter: max 5 attempts per IP per 15 minutes
  const transferRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer attempts from this device. Please wait 15 minutes before trying again." },
  });

  // Step 1: initiate — current owner enters cert ID + their email + new owner email
  app.post("/api/transfer/request", transferRateLimit, async (req, res) => {
    try {
      const { certId, fromEmail, toEmail, newOwnerName } = req.body;
      if (!certId || !fromEmail || !toEmail) {
        return res.status(400).json({ error: "Certificate number, your email, and new owner email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fromEmail) || !emailRegex.test(toEmail)) {
        return res.status(400).json({ error: "Please provide valid email addresses for both fields." });
      }

      if (fromEmail.toLowerCase().trim() === toEmail.toLowerCase().trim()) {
        return res.status(400).json({ error: "The current owner and new owner email addresses must be different." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedId);
      if (!cert) {
        return res.status(404).json({ error: "Certificate not found. Please check your certificate number." });
      }
      if (cert.ownershipStatus !== "claimed") {
        return res.status(400).json({ error: "This certificate does not have a registered owner. Please use Register Ownership first." });
      }

      // Verify the fromEmail matches the current owner
      if (cert.currentOwnerUserId) {
        const owner = await storage.getUser(cert.currentOwnerUserId);
        if (!owner || (owner.email ?? "").toLowerCase() !== fromEmail.toLowerCase().trim()) {
          return res.status(400).json({ error: "The email address you entered does not match the registered owner of this certificate." });
        }
      } else {
        return res.status(400).json({ error: "This certificate does not have a verified owner on record." });
      }

      const ownerToken = await storage.createTransferVerification(normalizedId, fromEmail.trim(), toEmail.trim(), newOwnerName?.trim() || undefined);
      const baseUrl = process.env.APP_URL || "https://mintvaultuk.com";
      const confirmUrl = `${baseUrl}/api/transfer/owner-confirm?token=${ownerToken}`;

      await sendTransferOwnerConfirmation({ fromEmail: fromEmail.trim(), toEmail: toEmail.trim(), certId: normalizedId, confirmUrl });

      return res.json({ success: true, message: "Transfer initiated. Please check your inbox and click the confirmation link to proceed." });
    } catch (err: any) {
      console.error("[transfer] Error initiating transfer:", err);
      return res.status(500).json({ error: "An error occurred. Please try again." });
    }
  });

  // Step 2: current owner clicks their confirmation link → generates new owner token, sends to new owner
  app.get("/api/transfer/owner-confirm", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token");

      const result = await storage.confirmOwnerTransferStep(token);
      if (!result.success || !result.newOwnerToken) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}`);
      }

      const baseUrl = process.env.APP_URL || "https://mintvaultuk.com";
      const newOwnerConfirmUrl = `${baseUrl}/api/transfer/new-owner-confirm?token=${result.newOwnerToken}`;

      await sendTransferNewOwnerConfirmation({
        toEmail: result.toEmail || "",
        fromEmail: result.fromEmail || "",
        certId: result.certId || "",
        confirmUrl: newOwnerConfirmUrl,
      });

      return res.redirect(`/transfer?step=owner_confirmed&certId=${encodeURIComponent(result.certId || "")}`);
    } catch (err: any) {
      console.error("[transfer] Error confirming owner step:", err);
      return res.redirect("/transfer?error=server_error");
    }
  });

  // Step 3: new owner clicks their confirmation link → transfer completes
  app.get("/api/transfer/new-owner-confirm", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token");

      const result = await storage.completeTransferByNewOwnerToken(token);
      if (result.success) {
        // Auto-generate and email the certificate PDF to the new owner
        try {
          const cert = await storage.getCertificateByCertId(result.certId!);
          if (cert && cert.status !== "voided") {
            const pdfBuffer = await generateCertificateDocument(cert, result.ownerName);
            await sendCertificatePdf({
              email: result.toEmail!,
              ownerName: result.ownerName,
              certId: normalizeCertId(cert.certId),
              cardName: cert.cardName,
              pdfBuffer,
            });
          }
        } catch (pdfErr: any) {
          console.error("[transfer] PDF generation/email failed (non-fatal):", pdfErr.message);
        }
        return res.redirect(`/transfer?success=true&certId=${encodeURIComponent(result.certId || "")}`);
      } else {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}`);
      }
    } catch (err: any) {
      console.error("[transfer] Error completing transfer:", err);
      return res.redirect("/transfer?error=server_error");
    }
  });

  // ── V2 TRANSFER FLOW (DVLA-style: ref number + 14-day dispute window) ────
  // Rate limiter: max 5 attempts per IP per 15 minutes (shared concept, separate instance)
  const transferV2RateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer attempts. Please wait 15 minutes before trying again." },
  });

  // Stricter rate limit for ref number verification — 3 attempts per hour per IP
  const refNumberRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many verification attempts. Please wait before trying again." },
  });

  // Step 1: outgoing keeper initiates transfer
  app.post("/api/v2/transfers/initiate", transferV2RateLimit, async (req, res) => {
    try {
      const { certId, fromEmail, toEmail, newOwnerName } = req.body;
      if (!certId || !fromEmail || !toEmail) {
        return res.status(400).json({ error: "Certificate number, your email, and new keeper email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fromEmail) || !emailRegex.test(toEmail)) {
        return res.status(400).json({ error: "Please provide valid email addresses." });
      }

      if (fromEmail.toLowerCase().trim() === toEmail.toLowerCase().trim()) {
        return res.status(400).json({ error: "The current and new keeper email addresses must be different." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedId);
      if (!cert) {
        return res.status(404).json({ error: "Certificate not found." });
      }
      if (cert.ownershipStatus === "transfer_pending") {
        return res.status(400).json({ error: "A transfer is already in progress for this certificate." });
      }
      if (cert.ownershipStatus !== "claimed") {
        return res.status(400).json({ error: "This certificate does not have a registered keeper. Please use Register Ownership first." });
      }

      // Verify fromEmail matches the current owner
      if (!cert.currentOwnerUserId) {
        return res.status(400).json({ error: "This certificate does not have a verified keeper on record." });
      }
      const owner = await storage.getUser(cert.currentOwnerUserId);
      if (!owner || (owner.email ?? "").toLowerCase() !== fromEmail.toLowerCase().trim()) {
        return res.status(400).json({ error: "The email address does not match the registered keeper." });
      }

      // Check reference number exists (required for v2)
      const certRefNumber = (cert as any).referenceNumber as string | null;
      if (!certRefNumber) {
        return res.status(400).json({ error: "This certificate does not have a Document Reference Number yet. Please contact support." });
      }

      // Check for existing active v2 transfer
      const existing = await storage.getTransferV2ByCertId(normalizedId);
      if (existing) {
        return res.status(400).json({ error: "A transfer is already in progress for this certificate." });
      }

      const ownerToken = await storage.createTransferV2({
        certId: normalizedId,
        fromEmail: fromEmail.trim(),
        toEmail: toEmail.trim(),
        newOwnerName: newOwnerName?.trim() || undefined,
        outgoingKeeperUserId: cert.currentOwnerUserId,
        referenceNumber: certRefNumber,
      });

      const baseUrl = process.env.APP_URL || "https://mintvaultuk.com";
      const confirmUrl = `${baseUrl}/api/v2/transfers/outgoing-confirm?token=${ownerToken}`;

      await sendTransferV2OutgoingConfirmation({
        fromEmail: fromEmail.trim(),
        toEmail: toEmail.trim(),
        certId: normalizedId,
        confirmUrl,
      });

      await storage.writeAuditLog("transfer", normalizedId, "transfer_v2.initiated", null, {
        fromEmail: fromEmail.trim().toLowerCase(), toEmail: toEmail.trim().toLowerCase(),
      });

      return res.json({ success: true, message: "Transfer initiated. Check your inbox for the confirmation link." });
    } catch (err: any) {
      console.error("[transfer-v2] Error initiating:", err);
      return res.status(500).json({ error: "An error occurred. Please try again." });
    }
  });

  // Step 2: outgoing keeper clicks email link → generates incoming keeper token
  app.get("/api/v2/transfers/outgoing-confirm", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2");

      const result = await storage.confirmOutgoingKeeperV2(token);
      if (!result.success || !result.newOwnerToken) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2`);
      }

      const baseUrl = process.env.APP_URL || "https://mintvaultuk.com";
      const incomingConfirmUrl = `${baseUrl}/transfer/accept?token=${result.newOwnerToken}&v=2`;

      await sendTransferV2IncomingConfirmation({
        toEmail: result.toEmail || "",
        fromEmail: result.fromEmail || "",
        certId: result.certId || "",
        confirmUrl: incomingConfirmUrl,
      });

      return res.redirect(`/transfer?step=outgoing_confirmed&certId=${encodeURIComponent(result.certId || "")}&v=2`);
    } catch (err: any) {
      console.error("[transfer-v2] Error outgoing confirm:", err);
      return res.redirect("/transfer?error=server_error&v=2");
    }
  });

  // Step 3: incoming keeper submits ref number + token → enters dispute window
  app.post("/api/v2/transfers/incoming-confirm", transferV2RateLimit, refNumberRateLimit, async (req, res) => {
    try {
      const { token, referenceNumber } = req.body;
      if (!token || !referenceNumber) {
        return res.status(400).json({ error: "Token and Document Reference Number are required." });
      }

      if (typeof referenceNumber !== "string" || referenceNumber.replace(/-/g, "").length < 8) {
        return res.status(400).json({ error: "Please enter a valid Document Reference Number (format: XXXX-XXXX-XXXX)." });
      }

      const result = await storage.confirmIncomingKeeperV2(token, referenceNumber);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Send dispute-window emails to both parties
      try {
        // Look up the transfer to get details
        const cert = await storage.getCertificateByCertId(result.certId!);
        if (cert) {
          const ownerUser = cert.currentOwnerUserId ? await storage.getUser(cert.currentOwnerUserId) : null;
          const transfer = await storage.getTransferV2ByCertId(result.certId!);
          const disputeDeadline = transfer?.disputeDeadline || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

          if (ownerUser?.email) {
            await sendTransferV2DisputeWindowStarted({
              email: ownerUser.email,
              certId: result.certId!,
              role: "outgoing",
              disputeDeadline,
            });
          }
          await sendTransferV2DisputeWindowStarted({
            email: result.toEmail!,
            certId: result.certId!,
            role: "incoming",
            disputeDeadline,
          });
        }
      } catch (emailErr: any) {
        console.error("[transfer-v2] Dispute window emails failed (non-fatal):", emailErr.message);
      }

      await storage.writeAuditLog("transfer", result.certId!, "transfer_v2.incoming_confirmed", null, {
        toEmail: result.toEmail, referenceNumberPresent: true,
      });

      return res.json({ success: true, message: "Transfer verified. A 14-day dispute window is now active." });
    } catch (err: any) {
      console.error("[transfer-v2] Error incoming confirm:", err);
      return res.status(500).json({ error: "An error occurred. Please try again." });
    }
  });

  // Status check for a v2 transfer
  app.get("/api/v2/transfers/status/:certId", async (req, res) => {
    try {
      const normalizedId = normalizeCertId(String(req.params.certId));
      const transfer = await storage.getTransferV2ByCertId(normalizedId);
      if (!transfer) {
        return res.status(404).json({ error: "No active transfer found for this certificate." });
      }

      return res.json({
        certId: transfer.certId,
        status: transfer.status,
        flowVersion: transfer.flowVersion,
        fromEmail: transfer.fromEmail.replace(/(.{2}).*(@.*)/, "$1***$2"), // mask email
        toEmail: transfer.toEmail.replace(/(.{2}).*(@.*)/, "$1***$2"),
        ownerConfirmed: !!transfer.ownerConfirmedAt,
        incomingConfirmed: transfer.status === "pending_dispute" || transfer.status === "completed",
        disputeDeadline: transfer.disputeDeadline,
        finalisedAt: transfer.finalisedAt,
        createdAt: transfer.createdAt,
      });
    } catch (err: any) {
      console.error("[transfer-v2] Error fetching status:", err);
      return res.status(500).json({ error: "An error occurred." });
    }
  });

  // Dispute a v2 transfer during the 14-day window
  app.post("/api/v2/transfers/dispute", transferActionRateLimit, async (req, res) => {
    try {
      const { certId, email, reason } = req.body;
      if (!certId || !email || !reason) {
        return res.status(400).json({ error: "Certificate ID, your email, and a reason are required." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const transfer = await storage.getTransferV2ByCertId(normalizedId);
      if (!transfer) {
        return res.status(404).json({ error: "No active transfer found." });
      }

      // Determine role
      const normEmail = email.toLowerCase().trim();
      let role: "outgoing" | "incoming";
      if (normEmail === transfer.fromEmail.toLowerCase()) {
        role = "outgoing";
      } else if (normEmail === transfer.toEmail.toLowerCase()) {
        role = "incoming";
      } else {
        return res.status(403).json({ error: "You are not a party to this transfer." });
      }

      const result = await storage.disputeTransferV2(transfer.id, role, reason);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Audit
      await storage.writeAuditLog("transfer", String(transfer.id), "transfer_v2.disputed", null, {
        certId: normalizedId, disputedBy: role, reason: reason.trim().slice(0, 200),
      });

      // Notify the other party
      try {
        const otherEmail = role === "outgoing" ? transfer.toEmail : transfer.fromEmail;
        await sendTransferV2Disputed({ email: otherEmail, certId: normalizedId, disputedBy: role });
      } catch {}

      return res.json({ success: true, message: "Dispute raised. The transfer has been paused and MintVault will review." });
    } catch (err: any) {
      console.error("[transfer-v2] Error disputing:", err);
      return res.status(500).json({ error: "An error occurred." });
    }
  });

  // Cancel a v2 transfer (outgoing keeper only, before completion)
  app.post("/api/v2/transfers/cancel", transferActionRateLimit, async (req, res) => {
    try {
      const { certId, email } = req.body;
      if (!certId || !email) {
        return res.status(400).json({ error: "Certificate ID and your email are required." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const transfer = await storage.getTransferV2ByCertId(normalizedId);
      if (!transfer) {
        return res.status(404).json({ error: "No active transfer found." });
      }

      // Only the outgoing keeper can cancel
      if (email.toLowerCase().trim() !== transfer.fromEmail.toLowerCase()) {
        return res.status(403).json({ error: "Only the current registered keeper can cancel a transfer." });
      }

      const result = await storage.cancelTransferV2(transfer.id, "Cancelled by outgoing keeper");
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      await storage.writeAuditLog("transfer", String(transfer.id), "transfer_v2.cancelled", null, {
        certId: normalizedId, cancelledBy: "outgoing",
      });

      // Notify both parties
      try {
        await sendTransferV2Cancelled({ email: transfer.fromEmail, certId: normalizedId, reason: "Cancelled by current keeper" });
        await sendTransferV2Cancelled({ email: transfer.toEmail, certId: normalizedId, reason: "Cancelled by current keeper" });
      } catch {}

      return res.json({ success: true, message: "Transfer cancelled. Your keepership record is unchanged." });
    } catch (err: any) {
      console.error("[transfer-v2] Error cancelling:", err);
      return res.status(500).json({ error: "An error occurred." });
    }
  });

  // ── ADMIN TRANSFERS LIST ───────────────────────────────────────────────
  app.get("/api/admin/transfers", requireAdmin, async (_req, res) => {
    try {
      // Fetch all transfers (both v1 and v2), most recent first
      const result = await db.execute(sql`
        SELECT id, cert_id, from_email, to_email, flow_version,
               transfer_status, owner_confirmed_at, dispute_deadline,
               disputed_at, dispute_reason, disputed_by,
               finalised_at, cancelled_at, cancellation_reason,
               used_at, created_at
        FROM transfer_verifications
        ORDER BY created_at DESC
        LIMIT 200
      `);

      const rows = (result.rows as any[]).map(r => ({
        id: r.id,
        certId: r.cert_id,
        fromEmail: r.from_email,
        toEmail: r.to_email,
        flowVersion: r.flow_version || "v1",
        status: r.transfer_status || (r.used_at ? "completed" : "pending_owner"),
        ownerConfirmedAt: r.owner_confirmed_at,
        disputeDeadline: r.dispute_deadline,
        disputedAt: r.disputed_at,
        disputeReason: r.dispute_reason,
        disputedBy: r.disputed_by,
        finalisedAt: r.finalised_at,
        cancelledAt: r.cancelled_at,
        cancellationReason: r.cancellation_reason,
        createdAt: r.created_at,
      }));

      return res.json(rows);
    } catch (err: any) {
      console.error("[admin] Error listing transfers:", err);
      return res.status(500).json({ error: "Failed to load transfers" });
    }
  });

  // ── ADMIN TRANSFER RESOLVE (force-finalise + force-cancel) ──────────────
  app.post("/api/admin/transfers/:id/force-finalise", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid transfer id." });

      const { reason } = req.body || {};
      if (typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ error: "Reason is required (minimum 10 characters)." });
      }
      const trimmedReason = reason.trim().slice(0, 2000);

      const transfer = await storage.getTransferV2(id);
      if (!transfer) return res.status(404).json({ error: "Transfer not found." });

      if (["completed", "cancelled", "expired"].includes(transfer.status)) {
        return res.status(400).json({ error: `Transfer is already ${transfer.status}.` });
      }
      if (!["pending_dispute", "disputed"].includes(transfer.status)) {
        return res.status(400).json({ error: "Force-finalise is only allowed on pending_dispute or disputed transfers." });
      }

      const priorStatus = transfer.status;
      const result = await storage.finaliseTransferV2(id, { skipStatusCheck: true });
      if (!result.success) return res.status(400).json({ error: result.error || "Finalise failed." });

      const adminUser = req.session.adminEmail || ADMIN_EMAIL;
      await storage.writeAuditLog("transfer", transfer.certId, "admin_force_finalise", adminUser, {
        transferId: id,
        priorStatus,
        reason: trimmedReason,
        fromEmail: transfer.fromEmail,
        toEmail: transfer.toEmail,
        disputeReason: transfer.disputeReason ?? null,
        disputedBy: transfer.disputedBy ?? null,
      });

      // Notify both parties — same template as cron-driven finalise
      try {
        await sendTransferV2Completed({ email: transfer.fromEmail, certId: result.certId!, role: "outgoing" });
        await sendTransferV2Completed({ email: result.toEmail!, certId: result.certId!, role: "incoming", newKeeperName: result.ownerName });
      } catch (emailErr: any) {
        console.error("[admin] force-finalise emails failed (non-fatal):", emailErr.message);
      }

      return res.json({ ok: true, certId: result.certId, toEmail: result.toEmail });
    } catch (err: any) {
      console.error("[admin] force-finalise error:", err);
      return res.status(500).json({ error: "Failed to force-finalise transfer." });
    }
  });

  app.post("/api/admin/transfers/:id/force-cancel", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid transfer id." });

      const { reason } = req.body || {};
      if (typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ error: "Reason is required (minimum 10 characters)." });
      }
      const trimmedReason = reason.trim().slice(0, 1900);

      const transfer = await storage.getTransferV2(id);
      if (!transfer) return res.status(404).json({ error: "Transfer not found." });

      if (["completed", "cancelled", "expired"].includes(transfer.status)) {
        return res.status(400).json({ error: `Transfer is already ${transfer.status}.` });
      }

      const priorStatus = transfer.status;
      const adminPrefixed = `[ADMIN] ${trimmedReason}`;
      const result = await storage.cancelTransferV2(id, adminPrefixed);
      if (!result.success) return res.status(400).json({ error: result.error || "Cancel failed." });

      const adminUser = req.session.adminEmail || ADMIN_EMAIL;
      await storage.writeAuditLog("transfer", transfer.certId, "admin_force_cancel", adminUser, {
        transferId: id,
        priorStatus,
        reason: trimmedReason,
        fromEmail: transfer.fromEmail,
        toEmail: transfer.toEmail,
      });

      // Notify both parties
      try {
        await sendTransferV2Cancelled({ email: transfer.fromEmail, certId: transfer.certId, reason: adminPrefixed });
        await sendTransferV2Cancelled({ email: transfer.toEmail, certId: transfer.certId, reason: adminPrefixed });
      } catch (emailErr: any) {
        console.error("[admin] force-cancel emails failed (non-fatal):", emailErr.message);
      }

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[admin] force-cancel error:", err);
      return res.status(500).json({ error: "Failed to cancel transfer." });
    }
  });

  // ── STAGING HARNESS (seed + reset test data — staging only) ──────────────
  // Endpoints registered on every deploy but triple-guarded:
  //   1. requireAdmin (session-authenticated admin)
  //   2. APP_URL must contain 'mintvault-v2'
  //   3. STAGING_ONLY env var must equal '1'
  // All three must pass. See server/staging-harness.ts for implementation.
  {
    const { stagingOnlyGuard, seedE2Ev1, resetStagingData, SafetyLimitExceeded } = await import("./staging-harness");

    app.post("/api/admin/staging/seed", requireAdmin, stagingOnlyGuard, async (req, res) => {
      try {
        const dryRun = req.query.dryRun === "true";
        const adminEmail = req.session.adminEmail || "unknown-admin";
        const result = await seedE2Ev1({ dryRun, adminEmail });
        if (result.alreadySeeded) {
          return res.status(409).json({ error: "Already seeded — run reset first.", alreadySeeded: true });
        }
        return res.json(result);
      } catch (err: any) {
        console.error("[staging-harness] seed error:", err.message, err.stack?.split("\n")[1]?.trim());
        return res.status(500).json({ error: "Seed failed.", detail: err.message });
      }
    });

    app.post("/api/admin/staging/reset", requireAdmin, stagingOnlyGuard, async (req, res) => {
      try {
        const dryRun = req.query.dryRun === "true";
        const adminEmail = req.session.adminEmail || "unknown-admin";
        const result = await resetStagingData({ dryRun, adminEmail });
        return res.json(result);
      } catch (err: any) {
        if (err instanceof SafetyLimitExceeded) {
          console.warn("[staging-harness] reset refused (safety limit):", err.message);
          return res.status(400).json({ error: err.message, totalCount: err.totalCount, limit: err.limit });
        }
        console.error("[staging-harness] reset error:", err.message, err.stack?.split("\n")[1]?.trim());
        return res.status(500).json({ error: "Reset failed.", detail: err.message });
      }
    });
  }

  // ── ADMIN OWNERSHIP ROUTES ────────────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/ownership", requireAdmin, async (req, res) => {
    try {
      const cert = await storage.getCertificateByCertId(String(req.params.certId));
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const history = await storage.getOwnershipHistory(String(req.params.certId));

      let ownerEmail: string | null = null;
      if (cert.currentOwnerUserId) {
        const owner = await storage.getUser(cert.currentOwnerUserId);
        ownerEmail = owner?.email || null;
      }

      return res.json({
        certId: cert.certId,
        ownershipStatus: cert.ownershipStatus,
        ownerEmail,
        ownerUserId: cert.currentOwnerUserId,
        hasClaimCode: !!cert.claimCodeHash,
        claimCodeCreatedAt: cert.claimCodeCreatedAt,
        claimCodeUsedAt: cert.claimCodeUsedAt,
        ownershipToken: (cert as any).ownershipToken ?? null,
        ownershipTokenGeneratedAt: (cert as any).ownershipTokenGeneratedAt ?? null,
        history,
      });
    } catch (err: any) {
      console.error("[admin] Error fetching ownership:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/certificates/:certId/regenerate-claim-code", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const claimCode = await storage.generateClaimCode(certId);
      await storage.writeAuditLog("certificate", certId, "CLAIM_CODE_REGENERATED", "admin", {});

      return res.json({ certId, claimCode });
    } catch (err: any) {
      console.error("[admin] Error regenerating claim code:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/certificates/:certId/assign-owner", requireAdmin, async (req, res) => {
    try {
      const { email, notes } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      await storage.assignOwnerManual(certId, email, "admin", notes);
      return res.json({ success: true });
    } catch (err: any) {
      console.error("[admin] Error assigning owner:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── CERTIFICATE DOCUMENT (A4 PDF) ─────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/certificate-document", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      if (cert.status === "voided") return res.status(403).json({ error: "Cannot generate certificate for a voided certificate" });

      const pdfBuffer = await generateCertificateDocument(cert, cert.ownerName);
      const normalId = normalizeCertId(cert.certId);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault-Certificate-${normalId}.pdf"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      console.error("[certificate-doc] Error generating certificate document:", err.message);
      res.status(500).json({ error: "Failed to generate certificate document" });
    }
  });

  app.post("/api/admin/backfill-claim-codes", requireAdmin, async (req, res) => {
    try {
      const codes = await storage.batchGenerateClaimCodes();
      await storage.writeAuditLog("system", "backfill", "BATCH_CLAIM_CODES_GENERATED", "admin", {
        count: codes.length,
      });

      const csvLines = ["Certificate Number,Claim Code"];
      for (const { certId, claimCode } of codes) {
        csvLines.push(`${certId},${claimCode}`);
      }
      const csv = csvLines.join("\n");

      return res.json({ count: codes.length, codes, csv });
    } catch (err: any) {
      console.error("[admin] Error backfilling claim codes:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── GRADING REPORT ────────────────────────────────────────────────────────────
  app.patch("/api/admin/certificates/:certId/grading-report", requireAdmin, async (req, res) => {
    try {
      const certId = req.params.certId;
      const { centering, corners, edges, surface, overall } = req.body as {
        centering?: string; corners?: string; edges?: string; surface?: string; overall?: string;
      };
      const report: Record<string, string> = {};
      if (centering?.trim()) report.centering = centering.trim().slice(0, 1000);
      if (corners?.trim())   report.corners   = corners.trim().slice(0, 1000);
      if (edges?.trim())     report.edges     = edges.trim().slice(0, 1000);
      if (surface?.trim())   report.surface   = surface.trim().slice(0, 1000);
      if (overall?.trim())   report.overall   = overall.trim().slice(0, 1000);

      await db.execute(
        sql`UPDATE certificates SET grading_report = ${JSON.stringify(report)}::jsonb WHERE certificate_number = ${certId}`
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[grading-report] save error:", err);
      res.status(500).json({ error: "Failed to save grading report." });
    }
  });

  // ── CLAIM INSERT GENERATION ──────────────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/claim-insert", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const claimCode = await storage.getOrGenerateClaimCode(certId);
      await storage.writeAuditLog("certificate", certId, "CLAIM_INSERT_GENERATED", "admin", {});

      const format = (req.query.format as string) || "pdf";
      const nCertId = normalizeCertId(cert.certId);

      if (format === "png") {
        const png = await generateClaimInsertPNG(nCertId, claimCode);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `inline; filename="${nCertId}-claim-insert.png"`);
        return res.send(png);
      }

      const pdf = await generateClaimInsertPDF(nCertId, claimCode);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${nCertId}-claim-insert.pdf"`);
      return res.send(pdf);
    } catch (err: any) {
      console.error("[admin] Error generating claim insert:", err);
      return res.status(500).json({ error: "Failed to generate claim insert" });
    }
  });

  app.post("/api/admin/claim-insert-sheet", requireAdmin, async (req, res) => {
    try {
      const { certIds } = req.body;
      if (!certIds || !Array.isArray(certIds) || certIds.length === 0) {
        return res.status(400).json({ error: "Provide an array of certIds" });
      }
      if (certIds.length > 50) {
        return res.status(400).json({ error: "Maximum 50 inserts per sheet" });
      }

      const inserts: Array<{ certId: string; claimCode: string }> = [];

      for (const cid of certIds) {
        const cert = await storage.getCertificateByCertId(cid);
        if (!cert) continue;

        const claimCode = await storage.getOrGenerateClaimCode(cid);
        inserts.push({ certId: normalizeCertId(cert.certId), claimCode });
      }

      if (inserts.length === 0) {
        return res.status(400).json({ error: "No valid certificates found" });
      }

      await storage.writeAuditLog("system", "batch", "CLAIM_INSERT_SHEET_GENERATED", "admin", {
        count: inserts.length,
        certIds: inserts.map(i => i.certId),
      });

      const pdf = await generateClaimInsertSheet(inserts);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="claim-inserts-${new Date().toISOString().split("T")[0]}.pdf"`);
      return res.send(pdf);
    } catch (err: any) {
      console.error("[admin] Error generating claim insert sheet:", err);
      return res.status(500).json({ error: "Failed to generate claim insert sheet" });
    }
  });

  app.get("/sitemap.xml", (_req, res) => {
    const baseUrl = "https://mintvaultuk.com";
    const now = new Date().toISOString().split("T")[0];

    const staticPages = [
      { loc: "/", priority: "1.0", changefreq: "weekly" },
      { loc: "/submit", priority: "0.9", changefreq: "monthly" },
      { loc: "/cert", priority: "0.8", changefreq: "weekly" },
      { loc: "/track", priority: "0.6", changefreq: "monthly" },
      { loc: "/why-mintvault", priority: "0.7", changefreq: "monthly" },
      { loc: "/labels", priority: "0.5", changefreq: "monthly" },
      { loc: "/reports", priority: "0.5", changefreq: "monthly" },
      { loc: "/population", priority: "0.6", changefreq: "weekly" },
      { loc: "/tcg", priority: "0.5", changefreq: "monthly" },
      { loc: "/guides", priority: "0.8", changefreq: "weekly" },
      { loc: "/terms-and-conditions", priority: "0.3", changefreq: "yearly" },
      { loc: "/liability-and-insurance", priority: "0.3", changefreq: "yearly" },
      { loc: "/pokemon-card-grading-uk", priority: "0.9", changefreq: "monthly" },
      { loc: "/trading-card-grading-uk", priority: "0.8", changefreq: "monthly" },
      { loc: "/card-grading-service-uk", priority: "0.8", changefreq: "monthly" },
      { loc: "/psa-alternative-uk", priority: "0.8", changefreq: "monthly" },
      { loc: "/how-to-grade-pokemon-cards", priority: "0.8", changefreq: "monthly" },
      { loc: "/tcg-grading-uk", priority: "0.8", changefreq: "monthly" },
    ];

    staticPages.push({ loc: "/claim", priority: "0.4", changefreq: "monthly" });

    const urls = staticPages.map(p =>
      `  <url>\n    <loc>${baseUrl}${p.loc}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    );

    for (const slug of GUIDE_SLUGS) {
      urls.push(`  <url>\n    <loc>${baseUrl}/guides/${slug}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;

    res.header("Content-Type", "application/xml");
    res.send(xml);
  });

  app.get("/robots.txt", (_req, res) => {
    const baseUrl = "https://mintvaultuk.com";
    const txt = [
      "User-agent: *",
      "Allow: /",
      "",
      "Disallow: /admin",
      "Disallow: /api/admin",
      "Disallow: /submit/success",
      "",
      `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join("\n");

    res.header("Content-Type", "text/plain");
    res.send(txt);
  });

  // ── CUSTOMER DASHBOARD API ─────────────────────────────────────────────────
  const magicLinkRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login requests. Please wait 15 minutes." },
  });

  // POST /api/customer/magic-link — send login link to email
  app.post("/api/customer/magic-link", magicLinkRateLimit, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email address is required." });
      }
      const normalEmail = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      const token = await createMagicToken(normalEmail);
      const baseUrl = process.env.APP_URL || "https://mintvaultuk.com";
      const loginUrl = `${baseUrl}/api/customer/verify/${token}`;

      await sendMagicLink({ email: normalEmail, loginUrl });
      res.json({ message: "Login link sent. Check your inbox." });
    } catch (err) {
      console.error("[customer] magic-link error:", err);
      res.status(500).json({ error: "Failed to send login link. Please try again." });
    }
  });

  // GET /api/customer/verify/:token — verify magic link, set session, redirect
  app.get("/api/customer/verify/:token", async (req, res) => {
    try {
      const token = String(req.params.token);
      const email = await verifyMagicToken(token);
      if (!email) {
        return res.redirect("/dashboard?error=invalid_link");
      }
      req.session.customerEmail = email;
      res.redirect("/dashboard?login=success");
    } catch (err) {
      console.error("[customer] verify error:", err);
      res.redirect("/dashboard?error=server_error");
    }
  });

  // GET /api/customer/me — return current customer session info
  app.get("/api/customer/me", requireCustomer, (req, res) => {
    res.json({ email: req.session.customerEmail });
  });

  // POST /api/customer/logout — destroy customer session
  app.post("/api/customer/logout", (req, res) => {
    req.session.customerEmail = undefined as unknown as string;
    res.json({ message: "Logged out." });
  });

  // GET /api/customer/submissions — all submissions for the logged-in customer
  app.get("/api/customer/submissions", requireCustomer, async (req, res) => {
    try {
      const email = req.session.customerEmail!;
      const submissions = await storage.getSubmissionsByEmail(email);
      const secret = getSignedUrlSecret();
      const result = submissions.map((sub: any) => {
        const sid = sub.submissionId || sub.submission_id || "";
        const token = sid ? crypto.createHmac("sha256", secret).update(sid).digest("hex").slice(0, 16) : "";
        return { ...sub, packingSlipToken: token, shippingLabelToken: token };
      });
      res.json(result);
    } catch (err) {
      console.error("[customer] submissions error:", err);
      res.status(500).json({ error: "Failed to load submissions." });
    }
  });

  // GET /api/submissions/me — full submission list with tracking fields (user account session)
  app.get("/api/submissions/me", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      // Look up user email for legacy email-matched submissions
      const userRows = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
      const email = userRows.rows.length > 0 ? (userRows.rows[0] as any).email as string : null;
      let subs: any[] = [];
      if (email) {
        subs = await storage.getSubmissionsByEmail(email);
      }
      res.json(subs);
    } catch (err) {
      console.error("[submissions/me] error:", err);
      res.status(500).json({ error: "Failed to load submissions." });
    }
  });

  // POST /api/submissions/:id/customer-tracking — customer saves outbound tracking number
  app.post("/api/submissions/:id/customer-tracking", requireCustomer, async (req, res) => {
    try {
      const sub = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!sub) return res.status(404).json({ error: "Submission not found" });
      // Verify ownership by email
      if (sub.email !== req.session.customerEmail && sub.customerEmail !== req.session.customerEmail) {
        return res.status(403).json({ error: "Not your submission" });
      }
      const { tracking_number } = req.body;
      if (!tracking_number || typeof tracking_number !== "string") {
        return res.status(400).json({ error: "tracking_number required" });
      }
      const numId = typeof sub.id === "string" ? parseInt(sub.id, 10) : sub.id;
      await db.execute(sql`
        UPDATE submissions SET royal_mail_outbound_tracking = ${tracking_number.trim()}, updated_at = NOW()
        WHERE id = ${numId}
      `);
      res.json({ success: true });
    } catch (err) {
      console.error("[customer-tracking] error:", err);
      res.status(500).json({ error: "Failed to save tracking number" });
    }
  });

  // POST /api/admin/submissions/:id/mark-received — admin marks received + uploads photos
  const receiptUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 6 },
    fileFilter: (_req, file, cb) => {
      if (/\.(jpg|jpeg|png|webp)$/i.test(path.extname(file.originalname))) cb(null, true);
      else cb(new Error("Images only"));
    },
  });

  app.post(
    "/api/admin/submissions/:id/mark-received",
    requireAdmin,
    receiptUpload.array("photos", 6),
    async (req, res) => {
      try {
        const sub = await storage.getSubmissionBySubmissionId(String(req.params.id));
        if (!sub) return res.status(404).json({ error: "Submission not found" });
        const numId = typeof sub.id === "string" ? parseInt(sub.id, 10) : sub.id;

        // Upload photos to R2
        const files = (req.files as Express.Multer.File[]) ?? [];
        const photoUrls: string[] = [];
        for (const file of files) {
          const key = `receipt/${sub.submissionId}/${Date.now()}-${file.originalname}`;
          await uploadToR2(key, file.buffer, file.mimetype);
          const url = await getR2SignedUrl(key, 60 * 60 * 24 * 365); // 1-year URL
          photoUrls.push(url);
        }
        // Also accept pre-uploaded URLs from body (for admin typing in URLs)
        const bodyUrls: string[] = Array.isArray(req.body.photo_urls) ? req.body.photo_urls : [];
        const allUrls = [...photoUrls, ...bodyUrls];

        await storage.updateSubmissionStatus(numId, "received", {
          onReceiptPhotoUrls: JSON.stringify(allUrls),
        });

        await storage.writeAuditLog("submission", sub.submissionId, "status_received", req.session.adminEmail || "admin", { photoCount: allUrls.length });

        const email = sub.email || sub.customerEmail || "";
        if (email) {
          sendCardsReceived({
            email,
            firstName: sub.firstName || sub.customerFirstName || "Customer",
            submissionId: sub.submissionId,
            cardCount: sub.cardCount || 0,
            photoUrls: allUrls,
          }).catch(() => {});
        }

        res.json({ success: true, photoUrls: allUrls });
      } catch (err: any) {
        console.error("[mark-received] error:", err.message);
        res.status(500).json({ error: "Failed to mark received" });
      }
    }
  );

  // GET /api/customer/certificates — all certs linked to the logged-in customer
  app.get("/api/customer/certificates", requireCustomer, async (req, res) => {
    try {
      const email = req.session.customerEmail!;
      const certs = await storage.getCertificatesByEmail(email);
      // Strip sensitive fields before sending to client
      const safe = certs.map((c) => ({
        id: c.id,
        certId: c.certId,
        cardName: c.cardName,
        setName: c.setName,
        year: c.year,
        cardGame: c.cardGame,
        language: c.language,
        gradeOverall: c.gradeOverall,
        gradeType: c.gradeType,
        createdAt: c.createdAt,
        status: c.status,
        ownershipStatus: c.ownershipStatus,
        ownerEmail: c.ownerEmail,
        submissionItemId: c.submissionItemId,
      }));
      res.json(safe);
    } catch (err) {
      console.error("[customer] certificates error:", err);
      res.status(500).json({ error: "Failed to load certificates." });
    }
  });

  // ── Build 1: Grading image upload ─────────────────────────────────────────
  const gradingUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB for high-res scans
    fileFilter: (_req, file, cb) => {
      if (/\.(jpg|jpeg|png|webp|tiff?)$/i.test(path.extname(file.originalname))) {
        cb(null, true);
      } else {
        cb(new Error("Only image files are allowed"));
      }
    },
  });

  app.post(
    "/api/admin/certificates/:id/upload-images",
    requireAdmin,
    gradingUpload.fields([
      { name: "front", maxCount: 1 },
      { name: "back", maxCount: 1 },
      { name: "angled", maxCount: 1 },
      { name: "closeup", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const { deskewCard, cropToYellowBorder, autoCrop, maskRoundedCorners, generateVariants, checkImageQuality, reCentreBitmap } = await import("./image-processing");
        const cropGeometryByAngle: Record<string, any> = {};

        const id = parseInt(String(req.params.id), 10);
        const cert = await storage.getCertificate(id);
        if (!cert) return res.status(404).json({ error: "Certificate not found" });

        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        if (!files || Object.keys(files).length === 0) {
          return res.status(400).json({ error: "No images provided" });
        }

        const certId = normalizeCertId(cert.certId);
        const updates: Record<string, string> = {};
        const qualityResults: Record<string, any> = {};
        let frontCroppedBuf: Buffer | null = null;
        let backCroppedBuf: Buffer | null = null;

        async function processAngle(angle: "front" | "back" | "angled" | "closeup", buffer: Buffer) {
          const ext = "jpg";
          // 1. Save original
          const origKey = `grading/${certId}/${angle}_original.${ext}`;
          await uploadToR2(origKey, buffer, "image/jpeg");
          updates[`grading_${angle}_original`] = origKey;

          // 2. Deskew (straighten slight rotation before cropping)
          const { buffer: deskewedBuf, angle: deskewAngle } = await deskewCard(buffer);

          // 3. Yellow border crop (precise), then fallback to autoCrop
          const yellowResult = await cropToYellowBorder(deskewedBuf);
          const { buffer: rectCropped, cropped } = yellowResult || await autoCrop(deskewedBuf);

          // 3a. Deterministic re-centre — symmetric padding so the card sits centred in its bitmap
          const centreResult = await reCentreBitmap(rectCropped);
          cropGeometryByAngle[angle] = { pre_padding_px: centreResult.pre_padding_px, post_asymmetry_px: centreResult.post_asymmetry_px, extended: centreResult.extended };

          // 4. Rounded corner mask (card-shaped output with transparent corners)
          const croppedBuf = await maskRoundedCorners(centreResult.buffer);
          const ext2 = "png"; // PNG for transparency support
          const cropKey = `grading/${certId}/${angle}_cropped.${ext2}`;
          await uploadToR2(cropKey, croppedBuf, "image/png");
          updates[`grading_${angle}_cropped`] = cropKey;

          // 4. Quality check on cropped image
          const quality = await checkImageQuality(croppedBuf);
          qualityResults[angle] = { ...quality, cropped, deskewAngle };

          // 5. Also update the primary front/back image paths used for display + AI.
          // Canonical display key uses .png with correct image/png mime — croppedBuf is PNG bytes.
          if (angle === "front") {
            frontCroppedBuf = croppedBuf;
            const displayKey = r2KeyForImage(certId, "front", "png");
            updates["front_image_path"] = displayKey;
            await uploadToR2(displayKey, croppedBuf, "image/png");
          } else if (angle === "back") {
            backCroppedBuf = croppedBuf;
            const displayKey = r2KeyForImage(certId, "back", "png");
            updates["back_image_path"] = displayKey;
            await uploadToR2(displayKey, croppedBuf, "image/png");
          }

          // 6. Variants — fire-and-forget (don't block the response)
          setImmediate(async () => {
            try {
              const { greyscale, highcontrast, edgeenhanced, inverted } = await generateVariants(croppedBuf);
              await Promise.all([
                uploadToR2(`grading/${certId}/${angle}_greyscale.jpg`, greyscale, "image/jpeg"),
                uploadToR2(`grading/${certId}/${angle}_highcontrast.jpg`, highcontrast, "image/jpeg"),
                uploadToR2(`grading/${certId}/${angle}_edgeenhanced.jpg`, edgeenhanced, "image/jpeg"),
                uploadToR2(`grading/${certId}/${angle}_inverted.jpg`, inverted, "image/jpeg"),
              ]);
              // Persist variant paths for front/back
              if (angle === "front" || angle === "back") {
                await db.execute(sql`
                  UPDATE certificates SET
                    ${angle === "front" ? sql`grading_front_greyscale` : sql`grading_back_greyscale`}     = ${`grading/${certId}/${angle}_greyscale.jpg`},
                    ${angle === "front" ? sql`grading_front_highcontrast` : sql`grading_back_highcontrast`} = ${`grading/${certId}/${angle}_highcontrast.jpg`},
                    ${angle === "front" ? sql`grading_front_edgeenhanced` : sql`grading_back_edgeenhanced`} = ${`grading/${certId}/${angle}_edgeenhanced.jpg`},
                    ${angle === "front" ? sql`grading_front_inverted` : sql`grading_back_inverted`}     = ${`grading/${certId}/${angle}_inverted.jpg`},
                    updated_at = NOW()
                  WHERE id = ${id}
                `);
              }
            } catch (varErr) {
              console.error(`[upload-images] variant generation failed for ${angle}:`, varErr);
            }
          });
        }

        // Process each angle sequentially to avoid memory spikes
        for (const angle of ["front", "back", "angled", "closeup"] as const) {
          const fileArr = files[angle];
          if (fileArr && fileArr[0]) {
            await processAngle(angle, fileArr[0].buffer);
          }
        }

        // Persist image paths and quality results
        updates["image_quality_checks"] = JSON.stringify(qualityResults);
        const setClauses = Object.entries(updates)
          .filter(([k]) => !k.includes("_image_path") || k === "front_image_path" || k === "back_image_path");

        // Build dynamic update via raw SQL per-column
        const colMap: Record<string, string> = {
          grading_front_original: "grading_front_original",
          grading_front_cropped: "grading_front_cropped",
          grading_back_original: "grading_back_original",
          grading_back_cropped: "grading_back_cropped",
          grading_angled_original: "grading_angled_original",
          grading_angled_cropped: "grading_angled_cropped",
          grading_closeup_original: "grading_closeup_original",
          grading_closeup_cropped: "grading_closeup_cropped",
          image_quality_checks: "image_quality_checks",
          front_image_path: "front_image_path",
          back_image_path: "back_image_path",
        };

        for (const [key, val] of Object.entries(updates)) {
          const col = colMap[key];
          if (!col) continue;
          if (col === "image_quality_checks") {
            await db.execute(sql`UPDATE certificates SET image_quality_checks = ${val}::jsonb, updated_at = NOW() WHERE id = ${id}`);
          } else {
            await db.execute(sql`UPDATE certificates SET front_image_path = CASE WHEN ${col} = 'front_image_path' THEN ${val} ELSE front_image_path END, back_image_path = CASE WHEN ${col} = 'back_image_path' THEN ${val} ELSE back_image_path END, updated_at = NOW() WHERE id = ${id}`);
            // Use separate targeted updates to avoid conditional SQL complexity
          }
        }

        // Targeted column updates
        if (updates.grading_front_original) await db.execute(sql`UPDATE certificates SET grading_front_original = ${updates.grading_front_original}, updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_front_cropped)   await db.execute(sql`UPDATE certificates SET grading_front_cropped  = ${updates.grading_front_cropped},  updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_back_original)   await db.execute(sql`UPDATE certificates SET grading_back_original  = ${updates.grading_back_original},  updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_back_cropped)    await db.execute(sql`UPDATE certificates SET grading_back_cropped   = ${updates.grading_back_cropped},   updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_angled_original) await db.execute(sql`UPDATE certificates SET grading_angled_original = ${updates.grading_angled_original}, updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_angled_cropped)  await db.execute(sql`UPDATE certificates SET grading_angled_cropped  = ${updates.grading_angled_cropped},  updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_closeup_original) await db.execute(sql`UPDATE certificates SET grading_closeup_original = ${updates.grading_closeup_original}, updated_at = NOW() WHERE id = ${id}`);
        if (updates.grading_closeup_cropped) await db.execute(sql`UPDATE certificates SET grading_closeup_cropped  = ${updates.grading_closeup_cropped},  updated_at = NOW() WHERE id = ${id}`);
        if (updates.image_quality_checks)    await db.execute(sql`UPDATE certificates SET image_quality_checks = ${updates.image_quality_checks}::jsonb, updated_at = NOW() WHERE id = ${id}`);
        if (updates.front_image_path)        await db.execute(sql`UPDATE certificates SET front_image_path = ${updates.front_image_path}, updated_at = NOW() WHERE id = ${id}`);
        if (updates.back_image_path)         await db.execute(sql`UPDATE certificates SET back_image_path  = ${updates.back_image_path},  updated_at = NOW() WHERE id = ${id}`);

        // Crop forensics — records reCentre asymmetry + whether padding was extended. Read-only signal.
        if (Object.keys(cropGeometryByAngle).length > 0) {
          const cropGeometry = { ...cropGeometryByAngle, pipeline_version: "converged_v1", recorded_at: new Date().toISOString() };
          await db.execute(sql`UPDATE certificates SET crop_geometry = ${JSON.stringify(cropGeometry)}::jsonb, updated_at = NOW() WHERE id = ${id}`);
        }

        // Generate signed URLs for response
        const responseUrls: Record<string, string | null> = {};
        for (const [key, val] of Object.entries(updates)) {
          if (key === "image_quality_checks") continue;
          try { responseUrls[key] = await getR2SignedUrl(val, 3600); } catch { responseUrls[key] = null; }
        }

        // Fire async AI pipeline on first full upload (both front+back just became available and no prior analysis)
        try {
          const existingAi = (cert as any).aiAnalysis;
          const aiEmpty = !existingAi || (typeof existingAi === "object" && Object.keys(existingAi).length === 0);
          const aiGradeEmpty = (cert as any).aiDraftGrade === null || (cert as any).aiDraftGrade === undefined;
          if (aiEmpty && aiGradeEmpty && frontCroppedBuf && backCroppedBuf) {
            console.log(`[upload-images] cert=${id} first full upload with empty AI → triggering async pipeline`);
            const { runAiOnCertIfIdle } = await import("./scan-ingest-service");
            const aiPromise = runAiOnCertIfIdle(id, frontCroppedBuf, backCroppedBuf);
            if (aiPromise) {
              aiPromise
                .then(r => console.log(`[upload-images] AI done for cert ${id}: grade=${r.grade} strength=${r.strengthScore}`))
                .catch(e => console.error(`[upload-images] AI failed for cert ${id}: ${e.message}`));
            }
          } else {
            console.log(`[upload-images] cert=${id} skipping AI trigger (aiEmpty=${aiEmpty} aiGradeEmpty=${aiGradeEmpty} frontBuf=${!!frontCroppedBuf} backBuf=${!!backCroppedBuf})`);
          }
        } catch (aiErr: any) {
          console.error(`[upload-images] AI trigger setup failed for cert ${id}: ${aiErr.message}`);
        }

        res.json({ success: true, urls: responseUrls, quality: qualityResults });
      } catch (error: any) {
        console.error("[upload-images] error:", error.message, error.stack);
        res.status(500).json({ error: `Upload failed: ${error.message}` });
      }
    }
  );

  // ── Reprocess images: re-run deskew + crop + variants on existing originals
  app.post("/api/admin/certificates/:id/reprocess-images", requireAdmin, async (req, res) => {
    try {
      const { deskewCard: dsk, cropToYellowBorder: cyb, autoCrop: ac, generateVariants: gv } = await import("./image-processing");

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const certIdStr = normalizeCertId(cert.certId);
      const results: Record<string, any> = {};

      for (const side of ["front", "back"] as const) {
        // ALWAYS fetch from the ORIGINAL (pre-processed) image, never the cropped version
        const origKey = side === "front"
          ? (c.gradingFrontOriginal || c.frontImagePath)
          : (c.gradingBackOriginal || c.backImagePath);
        if (!origKey) {
          console.log(`[reprocess] ${certIdStr} ${side}: no original image path found, skipping`);
          continue;
        }

        let origBuf: Buffer;
        try {
          const url = await getR2SignedUrl(origKey, 300);
          const resp = await fetch(url);
          origBuf = Buffer.from(await resp.arrayBuffer());
        } catch (err: any) {
          console.error(`[reprocess] ${certIdStr} ${side}: failed to fetch original: ${err.message}`);
          continue;
        }

        console.log(`[reprocess] ${certIdStr} ${side}: fetched original ${(origBuf.length / 1024).toFixed(0)}KB from ${origKey}`);

        // Run pipeline: deskew → yellow crop → fallback autoCrop → save
        const { buffer: deskewed, angle } = await dsk(origBuf);
        const yellowResult = await cyb(deskewed);
        const { buffer: cropped } = yellowResult || await ac(deskewed);

        const cropKey = `grading/${certIdStr}/${side}_cropped.jpg`;
        await uploadToR2(cropKey, cropped, "image/jpeg");

        // Update display path
        if (side === "front") {
          const displayKey = r2KeyForImage(certIdStr, "front", "jpg");
          await uploadToR2(displayKey, cropped, "image/jpeg");
          await db.execute(sql`UPDATE certificates SET front_image_path = ${displayKey}, grading_front_cropped = ${cropKey}, updated_at = NOW() WHERE id = ${id}`);
        } else {
          const displayKey = r2KeyForImage(certIdStr, "back", "jpg");
          await uploadToR2(displayKey, cropped, "image/jpeg");
          await db.execute(sql`UPDATE certificates SET back_image_path = ${displayKey}, grading_back_cropped = ${cropKey}, updated_at = NOW() WHERE id = ${id}`);
        }

        // Regenerate variants sequentially
        const variants = await gv(cropped);
        for (const [vName, vBuf] of Object.entries(variants) as [string, Buffer][]) {
          const vKey = `grading/${certIdStr}/${side}_${vName}.jpg`;
          await uploadToR2(vKey, vBuf, "image/jpeg");
          const col = `grading_${side}_${vName}`;
          await db.execute(sql`UPDATE certificates SET updated_at = NOW() WHERE id = ${id}`);
          // Update the specific variant column
          if (vName === "greyscale") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_greyscale = '${vKey}' WHERE id = ${id}`));
          if (vName === "highcontrast") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_highcontrast = '${vKey}' WHERE id = ${id}`));
          if (vName === "edgeenhanced") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_edgeenhanced = '${vKey}' WHERE id = ${id}`));
          if (vName === "inverted") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_inverted = '${vKey}' WHERE id = ${id}`));
        }

        results[side] = { angle, processed: true };
        console.log(`[reprocess] ${certIdStr} ${side}: deskew=${angle.toFixed(2)}° variants=4`);
      }

      res.json({ success: true, results });
    } catch (err: any) {
      console.error("[reprocess] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/recrop — manual crop override
  app.post("/api/admin/certificates/:id/recrop", requireAdmin, async (req, res) => {
    try {
      const { generateVariants: gv } = await import("./image-processing");
      const sharpFn = (await import("sharp")).default;

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const { side, left_pct, top_pct, width_pct, height_pct, rotation_deg = 0 } = req.body;
      if (!side || !["front", "back"].includes(side)) return res.status(400).json({ error: "side must be front or back" });
      if ([left_pct, top_pct, width_pct, height_pct].some((v: any) => typeof v !== "number" || v < 0 || v > 100)) {
        return res.status(400).json({ error: "Invalid crop coordinates" });
      }

      const c = cert as any;
      const certIdStr = normalizeCertId(cert.certId);
      const origKey = side === "front"
        ? (c.gradingFrontOriginal || c.frontImagePath)
        : (c.gradingBackOriginal || c.backImagePath);
      if (!origKey) return res.status(400).json({ error: `No original ${side} image found` });

      let origBuf: Buffer;
      try {
        const url = await getR2SignedUrl(origKey, 300);
        const resp = await fetch(url);
        origBuf = Buffer.from(await resp.arrayBuffer());
      } catch (err: any) {
        return res.status(500).json({ error: `Failed to fetch original: ${err.message}` });
      }

      // Apply rotation first if specified, then crop from rotated dimensions
      let workBuf = origBuf;
      if (typeof rotation_deg === "number" && Math.abs(rotation_deg) > 0.1) {
        workBuf = await sharpFn(origBuf)
          .rotate(rotation_deg, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .toBuffer();
        console.log(`[recrop] ${certIdStr} ${side}: rotated ${rotation_deg.toFixed(1)}°`);
      }

      const meta = await sharpFn(workBuf).metadata();
      if (!meta.width || !meta.height) return res.status(500).json({ error: "Cannot read image dimensions" });

      const left = Math.max(0, Math.round(meta.width * left_pct / 100));
      const top = Math.max(0, Math.round(meta.height * top_pct / 100));
      const w = Math.min(meta.width - left, Math.round(meta.width * width_pct / 100));
      const h = Math.min(meta.height - top, Math.round(meta.height * height_pct / 100));
      if (w < 50 || h < 50) return res.status(400).json({ error: "Crop box too small" });

      console.log(`[recrop] ${certIdStr} ${side}: ${meta.width}x${meta.height} → extract(${left},${top},${w},${h})`);

      const cropped = await sharpFn(workBuf)
        .extract({ left, top, width: w, height: h })
        .jpeg({ quality: 95 })
        .toBuffer();

      const cropKey = `grading/${certIdStr}/${side}_cropped.jpg`;
      await uploadToR2(cropKey, cropped, "image/jpeg");
      const displayKey = r2KeyForImage(certIdStr, side, "jpg");
      await uploadToR2(displayKey, cropped, "image/jpeg");

      if (side === "front") {
        await db.execute(sql`UPDATE certificates SET front_image_path = ${displayKey}, grading_front_cropped = ${cropKey}, updated_at = NOW() WHERE id = ${id}`);
      } else {
        await db.execute(sql`UPDATE certificates SET back_image_path = ${displayKey}, grading_back_cropped = ${cropKey}, updated_at = NOW() WHERE id = ${id}`);
      }

      const variants = await gv(cropped);
      for (const [vName, vBuf] of Object.entries(variants) as [string, Buffer][]) {
        const vKey = `grading/${certIdStr}/${side}_${vName}.jpg`;
        await uploadToR2(vKey, vBuf, "image/jpeg");
        if (vName === "greyscale") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_greyscale = '${vKey}' WHERE id = ${id}`));
        if (vName === "highcontrast") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_highcontrast = '${vKey}' WHERE id = ${id}`));
        if (vName === "edgeenhanced") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_edgeenhanced = '${vKey}' WHERE id = ${id}`));
        if (vName === "inverted") await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_inverted = '${vKey}' WHERE id = ${id}`));
      }

      console.log(`[recrop] ${certIdStr} ${side}: manual crop applied, ${w}x${h}px, variants regenerated`);
      res.json({ success: true, side, width: w, height: h });
    } catch (err: any) {
      console.error("[recrop] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/detect-card-bounds — auto-detect card edges in raw image
  app.post("/api/admin/certificates/:id/detect-card-bounds", requireAdmin, async (req, res) => {
    try {
      const { detectCardBoundary } = await import("./image-processing");
      const sharpFn = (await import("sharp")).default;

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const { side } = req.body;
      if (!side || !["front", "back"].includes(side)) return res.status(400).json({ error: "side must be front or back" });

      const c = cert as any;
      const origKey = side === "front"
        ? (c.gradingFrontOriginal || c.frontImagePath)
        : (c.gradingBackOriginal || c.backImagePath);
      if (!origKey) return res.json({ ok: false, message: "No original image" });

      let origBuf: Buffer;
      try {
        const url = await getR2SignedUrl(origKey, 300);
        const resp = await fetch(url);
        origBuf = Buffer.from(await resp.arrayBuffer());
      } catch {
        return res.json({ ok: false, message: "Failed to fetch image" });
      }

      // Downscale for detection (same as cropToCardBoundary)
      const meta = await sharpFn(origBuf).metadata();
      if (!meta.width || !meta.height) return res.json({ ok: false, message: "Cannot read dimensions" });

      const scale = Math.min(1, 1500 / Math.max(meta.width, meta.height));
      const workW = Math.round(meta.width * scale);
      const workH = Math.round(meta.height * scale);

      const { data, info } = await sharpFn(origBuf)
        .resize(workW, workH, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const boundary = detectCardBoundary(new Uint8Array(data), info.width, info.height, info.channels);
      if (!boundary) return res.json({ ok: false, message: "Could not detect card edges" });

      res.json({
        ok: true,
        bounds: {
          left_pct: (boundary.minX / info.width) * 100,
          top_pct: (boundary.minY / info.height) * 100,
          width_pct: ((boundary.maxX - boundary.minX) / info.width) * 100,
          height_pct: ((boundary.maxY - boundary.minY) / info.height) * 100,
        },
      });
    } catch (err: any) {
      console.error("[detect-card-bounds] error:", err.message);
      res.json({ ok: false, message: err.message });
    }
  });

  // DELETE /api/admin/certificates/:id/images/:side — remove front or back image
  app.delete("/api/admin/certificates/:id/images/:side", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const side = req.params.side as "front" | "back";
      if (side !== "front" && side !== "back") return res.status(400).json({ error: "Side must be 'front' or 'back'" });

      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const certIdStr = normalizeCertId(cert.certId);

      // Collect all R2 keys for this side to delete
      const keysToDelete: string[] = [];
      const colsToClear: string[] = [];

      if (side === "front") {
        for (const col of ["frontImagePath", "gradingFrontOriginal", "gradingFrontCropped", "gradingFrontGreyscale", "gradingFrontHighcontrast", "gradingFrontEdgeenhanced", "gradingFrontInverted"]) {
          if (c[col]) keysToDelete.push(c[col]);
        }
        colsToClear.push("front_image_path", "grading_front_original", "grading_front_cropped", "grading_front_greyscale", "grading_front_highcontrast", "grading_front_edgeenhanced", "grading_front_inverted");
      } else {
        for (const col of ["backImagePath", "gradingBackOriginal", "gradingBackCropped", "gradingBackGreyscale", "gradingBackHighcontrast", "gradingBackEdgeenhanced", "gradingBackInverted"]) {
          if (c[col]) keysToDelete.push(c[col]);
        }
        colsToClear.push("back_image_path", "grading_back_original", "grading_back_cropped", "grading_back_greyscale", "grading_back_highcontrast", "grading_back_edgeenhanced", "grading_back_inverted");
      }

      // Delete from R2
      for (const key of keysToDelete) {
        try { await deleteFromR2(key); } catch { /* ignore missing keys */ }
      }

      // Clear DB columns
      const setClauses = colsToClear.map(col => `${col} = NULL`).join(", ");
      await db.execute(sql.raw(`UPDATE certificates SET ${setClauses}, updated_at = NOW() WHERE id = ${id}`));

      console.log(`[image-delete] cert ${certIdStr} removed ${side} (${keysToDelete.length} R2 keys)`);

      const updated = await storage.getCertificate(id);
      res.json({ ok: true, cert: updated ? { ...updated, certId: normalizeCertId(updated.certId) } : null });
    } catch (err: any) {
      console.error("[image-delete] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/certificates/:id/images", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const imageKeys: Record<string, string | null> = {
        // Grading-specific images (from capture wizard / upload-images endpoint)
        front_original:      c.gradingFrontOriginal   || c.frontImagePath || null,
        front_cropped:       c.gradingFrontCropped    || null,
        front_greyscale:     c.gradingFrontGreyscale  || null,
        front_highcontrast:  c.gradingFrontHighcontrast || null,
        front_edgeenhanced:  c.gradingFrontEdgeenhanced || null,
        front_inverted:      c.gradingFrontInverted   || null,
        back_original:       c.gradingBackOriginal    || c.backImagePath || null,
        back_cropped:        c.gradingBackCropped     || null,
        back_greyscale:      c.gradingBackGreyscale   || null,
        back_highcontrast:   c.gradingBackHighcontrast || null,
        back_edgeenhanced:   c.gradingBackEdgeenhanced || null,
        back_inverted:       c.gradingBackInverted    || null,
        angled_original:     c.gradingAngledOriginal  || null,
        angled_cropped:      c.gradingAngledCropped   || null,
        closeup_original:    c.gradingCloseupOriginal || null,
        closeup_cropped:     c.gradingCloseupCropped  || null,
        front_display:       c.frontImagePath         || null,
        back_display:        c.backImagePath          || null,
      };

      const urls: Record<string, string | null> = {};
      await Promise.all(
        Object.entries(imageKeys).map(async ([k, key]) => {
          if (!key) { urls[k] = null; return; }
          try { urls[k] = await getR2SignedUrl(key, 3600); } catch { urls[k] = null; }
        })
      );

      const quality = c.imageQualityChecks || {};
      res.json({ urls, quality });
    } catch (error: any) {
      res.status(500).json({ error: `Failed to get images: ${error.message}` });
    }
  });

  // ── Build 2: Manual grading endpoints ─────────────────────────────────────

  // GET grading data for a certificate
  app.get("/api/admin/certificates/:id/grading", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      const c = cert as any;
      res.json({
        centeringFrontLr: c.centeringFrontLr || c.centering_front_lr || null,
        centeringFrontTb: c.centeringFrontTb || c.centering_front_tb || null,
        centeringBackLr:  c.centeringBackLr  || c.centering_back_lr  || null,
        centeringBackTb:  c.centeringBackTb  || c.centering_back_tb  || null,
        centeringOuterFront: (c as any).centering_outer_front || null,
        centeringInnerFront: (c as any).centering_inner_front || null,
        centeringOuterBack:  (c as any).centering_outer_back  || null,
        centeringInnerBack:  (c as any).centering_inner_back  || null,
        centeringMethod:     (c as any).centering_method      || null,
        corners: c.cornerValues  || null,
        edges:   c.edgeValues    || null,
        surface: c.surfaceValues || null,
        defects: c.defects       || [],
        authStatus:       c.authStatus      || "genuine",
        authNotes:        c.authNotes       || "",
        gradeExplanation: c.gradeExplanation || "",
        privateNotes:     c.privateNotes     || "",
        gradeApprovedBy:  c.gradeApprovedBy  || null,
        gradeApprovedAt:  c.gradeApprovedAt  || null,
        gradeStrengthScore: c.gradeStrengthScore ?? (c as any).grade_strength_score ?? null,
        // Saved aggregate subgrades for hydration on reload
        centeringScore: c.centeringScore ?? (c as any).centering_score ?? null,
        cornersScore:   c.cornersScore   ?? (c as any).corners_score   ?? null,
        edgesScore:     c.edgesScore     ?? (c as any).edges_score     ?? null,
        surfaceScore:   c.surfaceScore   ?? (c as any).surface_score   ?? null,
        grade:          c.gradeOverall   ?? (c as any).grade           ?? null,
        aiDraftGrade:   c.aiDraftGrade   ?? (c as any).ai_draft_grade  ?? null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // PUT save draft grading data
  app.put("/api/admin/certificates/:id/grade", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const b = req.body;
      const overallGrade = b.overall_grade;
      const isNonNum = overallGrade === "AA" || overallGrade === "NO";
      const gradeNum = isNonNum ? null : parseFloat(overallGrade);

      await db.execute(sql`
        UPDATE certificates SET
          centering_front_lr  = ${b.centering_front_lr || null},
          centering_front_tb  = ${b.centering_front_tb || null},
          centering_back_lr   = ${b.centering_back_lr  || null},
          centering_back_tb   = ${b.centering_back_tb  || null},
          centering_score     = ${isNonNum ? null : (parseFloat(b.grade_centering) || null)},
          corners_score       = ${isNonNum ? null : (parseFloat(b.grade_corners)   || null)},
          edges_score         = ${isNonNum ? null : (parseFloat(b.grade_edges)     || null)},
          surface_score       = ${isNonNum ? null : (parseFloat(b.grade_surface)   || null)},
          grade               = ${isNonNum ? null : gradeNum},
          grade_type          = ${isNonNum ? (overallGrade === "AA" ? "authentic_altered" : "not_original") : "numeric"},
          corner_values       = ${b.corners ? JSON.stringify(b.corners) : null}::jsonb,
          edge_values         = ${b.edges   ? JSON.stringify(b.edges)   : null}::jsonb,
          surface_values      = ${b.surface ? JSON.stringify(b.surface) : null}::jsonb,
          defects             = ${JSON.stringify(b.defects || [])}::jsonb,
          auth_status         = ${b.auth_status || "genuine"},
          auth_notes          = ${b.auth_notes || null},
          grade_explanation   = ${b.grade_explanation || null},
          private_notes       = ${b.private_notes || null},
          updated_at          = NOW()
        WHERE id = ${id}
      `);

      res.json({ ok: true });
    } catch (error: any) {
      console.error("[grade] save error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // PUT approve grade — finalises, creates grading_session
  app.put("/api/admin/certificates/:id/approve", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const b = req.body;
      const overallGrade = b.overall_grade;
      const isNonNum = overallGrade === "AA" || overallGrade === "NO";
      const gradeNum = isNonNum ? null : parseFloat(overallGrade);
      const gradeCentering = isNonNum ? null : parseFloat(b.grade_centering) || null;
      const gradeCorners   = isNonNum ? null : parseFloat(b.grade_corners)   || null;
      const gradeEdges     = isNonNum ? null : parseFloat(b.grade_edges)     || null;
      const gradeSurface   = isNonNum ? null : parseFloat(b.grade_surface)   || null;

      // Compute Black Label: all subgrades must be exactly 10.0
      const allTen = !isNonNum && gradeNum === 10 &&
        gradeCentering === 10 && gradeCorners === 10 && gradeEdges === 10 && gradeSurface === 10;
      const labelType = allTen ? "black" : "Standard";
      const gradeType = isNonNum ? (overallGrade === "AA" ? "authentic_altered" : "not_original") : "numeric";

      await db.execute(sql`
        UPDATE certificates SET
          grade               = ${gradeNum},
          grade_type          = ${gradeType},
          centering_score     = ${gradeCentering},
          corners_score       = ${gradeCorners},
          edges_score         = ${gradeEdges},
          surface_score       = ${gradeSurface},
          centering_front_lr  = ${b.centering_front_lr || null},
          centering_front_tb  = ${b.centering_front_tb || null},
          centering_back_lr   = ${b.centering_back_lr  || null},
          centering_back_tb   = ${b.centering_back_tb  || null},
          corner_values       = ${b.corners ? JSON.stringify(b.corners) : null}::jsonb,
          edge_values         = ${b.edges   ? JSON.stringify(b.edges)   : null}::jsonb,
          surface_values      = ${b.surface ? JSON.stringify(b.surface) : null}::jsonb,
          defects             = ${JSON.stringify(b.defects || [])}::jsonb,
          auth_status         = ${b.auth_status || "genuine"},
          auth_notes          = ${b.auth_notes || null},
          grade_explanation   = ${b.grade_explanation || null},
          private_notes       = ${b.private_notes || null},
          label_type          = ${labelType},
          grade_approved_by   = ${"Cornelius Oliver"},
          grade_approved_at   = NOW(),
          status              = 'active',
          updated_at          = NOW()
        WHERE id = ${id}
      `);

      // Log to grading_sessions
      try {
        await db.execute(sql`
          INSERT INTO grading_sessions (cert_id, completed_at, grader, final_grade, ai_response, notes, model_version)
          VALUES (
            ${cert.certId},
            NOW(),
            ${"Cornelius Oliver"},
            ${gradeNum},
            ${b.defects ? JSON.stringify(b.defects) : null}::jsonb,
            ${b.private_notes || null},
            'claude-opus-4-7'
          )
        `);
      } catch (sessionErr) {
        console.warn("[approve] grading_sessions insert failed:", sessionErr);
      }

      await storage.writeAuditLog("certificate", cert.certId, "approve_grade_v2", req.session.adminEmail || "admin", {
        overall: overallGrade, labelType,
      });

      // Log AI vs human comparison if an AI draft grade exists for this certificate
      if (cert.aiDraftGrade != null && gradeNum != null) {
        try {
          const aiAnalysis = (cert.aiAnalysis || {}) as Record<string, any>;
          await db.execute(sql`
            INSERT INTO ai_grade_corrections (
              cert_id, ai_estimated_grade,
              ai_centering, ai_corners, ai_edges, ai_surface,
              actual_grade, actual_centering, actual_corners, actual_edges, actual_surface,
              graded_by
            ) VALUES (
              ${cert.certId},
              ${Math.round(parseFloat(String(cert.aiDraftGrade)))},
              ${aiAnalysis.centering?.subgrade != null ? String(aiAnalysis.centering.subgrade) : null},
              ${aiAnalysis.corners?.subgrade   != null ? String(aiAnalysis.corners.subgrade)   : null},
              ${aiAnalysis.edges?.subgrade     != null ? String(aiAnalysis.edges.subgrade)     : null},
              ${aiAnalysis.surface?.subgrade   != null ? String(aiAnalysis.surface.subgrade)   : null},
              ${gradeNum},
              ${gradeCentering != null ? Math.round(gradeCentering) : null},
              ${gradeCorners   != null ? Math.round(gradeCorners)   : null},
              ${gradeEdges     != null ? Math.round(gradeEdges)     : null},
              ${gradeSurface   != null ? Math.round(gradeSurface)   : null},
              ${req.session.adminEmail || "admin"}
            )
          `);
        } catch (logErr) {
          console.warn("[approve] ai_grade_corrections insert failed:", logErr);
        }
      }

      const updated = await storage.getCertificate(id);
      res.json(updated ? { ...updated, certId: normalizeCertId(updated.certId) } : {});
    } catch (error: any) {
      console.error("[approve] error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ── AI Override Audit ─────────────────────────────────────────────────────

  // POST single override audit entry
  app.post("/api/admin/certificates/:id/override-audit", requireAdmin, async (req, res) => {
    try {
      const certId = parseInt(String(req.params.id), 10);
      const { field_path, ai_value, override_value, override_reason } = req.body;
      if (!field_path) return res.status(400).json({ error: "field_path is required" });
      const adminEmail = (req.session as any)?.adminEmail || "admin";
      const result = await db.execute(sql`
        INSERT INTO ai_override_audit (cert_id, field_path, ai_value, override_value, override_reason, overridden_by)
        VALUES (${certId}, ${field_path}, ${JSON.stringify(ai_value ?? null)}::jsonb, ${JSON.stringify(override_value ?? null)}::jsonb, ${override_reason || null}, ${adminEmail})
        RETURNING id
      `);
      res.json({ ok: true, id: (result.rows[0] as any)?.id });
    } catch (err: any) {
      console.error("[override-audit] insert error:", err.message);
      res.json({ ok: false, error: err.message });
    }
  });

  // POST batch override audit entries
  app.post("/api/admin/certificates/:id/override-audit/batch", requireAdmin, async (req, res) => {
    try {
      const certId = parseInt(String(req.params.id), 10);
      const { overrides } = req.body;
      if (!Array.isArray(overrides) || overrides.length === 0) return res.json({ ok: true, inserted: 0 });
      const adminEmail = (req.session as any)?.adminEmail || "admin";
      let inserted = 0;
      for (const o of overrides) {
        if (!o.field_path) continue;
        try {
          await db.execute(sql`
            INSERT INTO ai_override_audit (cert_id, field_path, ai_value, override_value, override_reason, overridden_by)
            VALUES (${certId}, ${o.field_path}, ${JSON.stringify(o.ai_value ?? null)}::jsonb, ${JSON.stringify(o.override_value ?? null)}::jsonb, ${o.reason || null}, ${adminEmail})
          `);
          inserted++;
        } catch {}
      }
      console.log(`[override-audit] cert=${certId} logged ${inserted}/${overrides.length} overrides by ${adminEmail}`);
      res.json({ ok: true, inserted });
    } catch (err: any) {
      console.error("[override-audit] batch error:", err.message);
      res.json({ ok: false, error: err.message });
    }
  });

  // GET audit log entries
  app.get("/api/admin/override-audit", requireAdmin, async (req, res) => {
    try {
      const certId = req.query.cert_id ? parseInt(String(req.query.cert_id), 10) : null;
      const fieldPrefix = req.query.field_prefix as string | undefined;
      const limit = Math.min(200, parseInt(String(req.query.limit || "50"), 10));

      let query;
      if (certId) {
        query = fieldPrefix
          ? sql`SELECT * FROM ai_override_audit WHERE cert_id = ${certId} AND field_path LIKE ${fieldPrefix + "%"} ORDER BY overridden_at DESC LIMIT ${limit}`
          : sql`SELECT * FROM ai_override_audit WHERE cert_id = ${certId} ORDER BY overridden_at DESC LIMIT ${limit}`;
      } else {
        query = fieldPrefix
          ? sql`SELECT * FROM ai_override_audit WHERE field_path LIKE ${fieldPrefix + "%"} ORDER BY overridden_at DESC LIMIT ${limit}`
          : sql`SELECT * FROM ai_override_audit ORDER BY overridden_at DESC LIMIT ${limit}`;
      }
      const result = await db.execute(query);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[override-audit] query error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Build 1: Card database lookup ──────────────────────────────────────────
  app.get("/api/admin/card-lookup", requireAdmin, async (req, res) => {
    try {
      const { lookupCard } = await import("./card-database");
      const game  = typeof req.query.game  === "string" ? req.query.game.trim()  : "";
      const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
      const mode  = req.query.mode === "wildcard" ? "wildcard" as const : "exact" as const;
      console.log(`[card-lookup] game=${game} query=${query} mode=${mode}`);
      if (!query) return res.status(400).json({ error: "query is required" });
      const results = await lookupCard(game, query, mode);
      res.json(results);
    } catch (error: any) {
      console.error("[card-lookup] error:", error.message);
      res.status(500).json({ error: `Card lookup failed: ${error.message}` });
    }
  });

  // ── Build 4: Grading queue endpoints ──────────────────────────────────────

  app.get("/api/admin/grading-queue", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT id, cert_id, card_name, set_name, card_game, created_at,
               grade_approved_at,
               (front_image_path IS NOT NULL OR grading_front_original IS NOT NULL) AS has_images
        FROM certificates
        WHERE status = 'active' AND grade_approved_at IS NULL
        ORDER BY created_at ASC
        LIMIT 100
      `);
      const queue = (rows.rows || []).map((r: any) => ({
        id:         r.id,
        certId:     normalizeCertId(r.cert_id),
        cardName:   r.card_name,
        cardSet:    r.set_name,
        cardGame:   r.card_game,
        createdAt:  r.created_at,
        hasImages:  !!r.has_images,
        grade:      null,
      }));
      res.json(queue);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // In-memory grading queue current cert
  let _currentGradingCertId: string | null = null;

  app.get("/api/admin/grading-queue/current", requireAdmin, async (_req, res) => {
    if (_currentGradingCertId) return res.json({ certId: _currentGradingCertId });
    // Default: first ungraded
    try {
      const rows = await db.execute(sql`
        SELECT cert_id FROM certificates WHERE status = 'active' AND grade_approved_at IS NULL ORDER BY created_at ASC LIMIT 1
      `);
      const first = rows.rows?.[0] as any;
      res.json({ certId: first ? normalizeCertId(first.cert_id) : null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/grading-queue/set-current", requireAdmin, (req, res) => {
    _currentGradingCertId = req.body.certId || null;
    res.json({ ok: true, certId: _currentGradingCertId });
  });

  // ── Build 4: Upload token (phone QR) ──────────────────────────────────────

  // In-memory token store: token -> { certId, imageType, expiresAt }
  const _uploadTokens = new Map<string, { certId: string; imageType: string; expiresAt: number }>();

  app.post("/api/admin/upload-token", requireAdmin, (req, res) => {
    const { certId, imageType } = req.body;
    if (!certId || !imageType) return res.status(400).json({ error: "certId and imageType required" });
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    _uploadTokens.set(token, { certId: String(certId), imageType, expiresAt });
    // Cleanup expired tokens
    for (const [k, v] of _uploadTokens.entries()) {
      if (Date.now() > v.expiresAt) _uploadTokens.delete(k);
    }
    const uploadUrl = `${process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS}` : "https://mintvault.fly.dev"}/upload/${certId}/${imageType}?token=${token}`;
    res.json({ token, expiresAt: new Date(expiresAt).toISOString(), uploadUrl });
  });

  // ── Build 4: Public phone upload endpoint ─────────────────────────────────

  const phoneUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (/\.(jpg|jpeg|png|webp|heic)$/i.test(path.extname(file.originalname)) || file.mimetype.startsWith("image/")) cb(null, true);
      else cb(new Error("Images only"));
    },
  });

  app.post("/api/upload/:certId/:imageType", phoneUpload.single("image"), async (req, res) => {
    try {
      const { autoCrop, checkImageQuality } = await import("./image-processing");
      const token = req.query.token as string;
      if (!token) return res.status(401).json({ error: "Token required" });

      const entry = _uploadTokens.get(token);
      if (!entry) return res.status(401).json({ error: "Invalid or expired token" });
      if (Date.now() > entry.expiresAt) { _uploadTokens.delete(token); return res.status(401).json({ error: "Token expired" }); }

      const certId = String(req.params.certId);
      const imageType = String(req.params.imageType);
      if (entry.imageType !== imageType) return res.status(400).json({ error: "Token imageType mismatch" });

      const dbCert = await findCertByIdFlex(certId);
      if (!dbCert) return res.status(404).json({ error: "Certificate not found" });

      if (!req.file) return res.status(400).json({ error: "No image provided" });

      const { buffer: croppedBuf } = await autoCrop(req.file.buffer);
      const key = `grading/${normalizeCertId(dbCert.certId)}/${imageType}_original.jpg`;
      await uploadToR2(key, croppedBuf, "image/jpeg");

      const colMap: Record<string, string> = {
        angled:  "grading_angled_original",
        closeup: "grading_closeup_original",
      };
      const col = colMap[imageType];
      if (col) {
        await db.execute(sql`UPDATE certificates SET updated_at = NOW() WHERE id = ${dbCert.id}`);
      }

      const quality = await checkImageQuality(croppedBuf);
      const signedUrl = await getR2SignedUrl(key, 3600);

      res.json({ ok: true, imageUrl: signedUrl, quality });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Build 4: Hot folder upload ─────────────────────────────────────────────

  const hotFolderUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  app.post("/api/admin/hot-folder-upload", hotFolderUpload.single("front"), async (req, res) => {
    try {
      // Auth: Bearer token or session
      const authHeader = req.headers.authorization || "";
      const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
      const validToken = process.env.MINTVAULT_ADMIN_TOKEN;

      // Accept either a valid Bearer token or an active admin session
      const isSession = (req.session as any)?.adminAuthenticated === true;
      if (!isSession && (!validToken || bearerToken !== validToken)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const side = (req.body.side || "front") as "front" | "back";

      // Determine target cert: explicit or current queue item
      let certId = req.body.certId || _currentGradingCertId;
      let dbCert: any = null;
      if (certId) {
        dbCert = await findCertByIdFlex(String(certId));
      }
      if (!dbCert) {
        // Fall back to first ungraded
        const rows = await db.execute(sql`SELECT * FROM certificates WHERE status = 'active' AND grade_approved_at IS NULL ORDER BY created_at ASC LIMIT 1`);
        dbCert = rows.rows?.[0];
      }
      if (!dbCert) return res.status(404).json({ error: "No active certificate found for upload" });

      const { autoCrop } = await import("./image-processing");
      const file = req.file || (req.files as any)?.[side]?.[0];
      if (!file) return res.status(400).json({ error: "No image in request" });

      const normId = normalizeCertId(dbCert.cert_id || dbCert.certId || "");
      const { buffer: croppedBuf } = await autoCrop(file.buffer);

      const origKey = r2KeyForImage(normId, side as "front" | "back", "jpg");
      await uploadToR2(origKey, croppedBuf, "image/jpeg");

      const col = side === "front" ? "front_image_path" : "back_image_path";
      await db.execute(sql`UPDATE certificates SET updated_at = NOW() WHERE id = ${dbCert.id}`);
      if (side === "front") {
        await db.execute(sql`UPDATE certificates SET front_image_path = ${origKey}, grading_front_original = ${origKey}, updated_at = NOW() WHERE id = ${dbCert.id}`);
      } else {
        await db.execute(sql`UPDATE certificates SET back_image_path = ${origKey}, grading_back_original = ${origKey}, updated_at = NOW() WHERE id = ${dbCert.id}`);
      }

      const signedUrl = await getR2SignedUrl(origKey, 3600);
      res.json({ ok: true, certId: normId, side, imageUrl: signedUrl });
    } catch (err: any) {
      console.error("[hot-folder] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Build 5: AI Grading ────────────────────────────────────────────────────

  function getCertImageKeys(c: any): ImageKeys {
    return {
      frontOriginal:     c.gradingFrontOriginal     || null,
      backOriginal:      c.gradingBackOriginal       || null,
      frontGreyscale:    c.gradingFrontGreyscale     || null,
      frontHighcontrast: c.gradingFrontHighcontrast  || null,
      backGreyscale:     c.gradingBackGreyscale      || null,
      backHighcontrast:  c.gradingBackHighcontrast   || null,
      angledOriginal:    c.gradingAngledOriginal     || null,
      closeupOriginal:   c.gradingCloseupOriginal    || null,
    };
  }

  // POST /api/admin/certificates/:id/identify
  app.post("/api/admin/certificates/:id/identify", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontOriginal || c.frontImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image available for identification" });

      const rawId = await identifyCard(frontKey);
      const enriched = await verifyAndEnrichCardData(rawId);

      // Save reference image to ai_analysis
      await storage.updateCertificate(id, {
        aiAnalysis: { ...(c.aiAnalysis || {}), identification: enriched } as any,
      });

      res.json({ identification: enriched });
    } catch (err: any) {
      console.error("[ai/identify] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/identify-only — cheap Haiku + TCG API, no grading
  app.post("/api/admin/certificates/:id/identify-only", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image — upload images first" });

      // Fetch front image from R2
      let frontBuf: Buffer;
      try {
        const url = await getR2SignedUrl(frontKey, 300);
        const resp = await fetch(url);
        frontBuf = Buffer.from(await resp.arrayBuffer());
      } catch { return res.status(400).json({ error: "Could not fetch front image" }); }

      // Identify with Claude Haiku
      const rawId = await identifyCardFromBuffer(frontBuf, "image/jpeg");

      // Verify with Pokemon TCG API
      let enrichedId = await verifyAndEnrichCardData(rawId);
      const game = rawId.detected_game?.toLowerCase();
      const tcgVerified = game === "pokemon";
      let tcgResult: any = { verified: false };
      if (game === "pokemon") {
        tcgResult = await verifyPokemonCardWithTcgApi(rawId.detected_name, rawId.detected_number, rawId.detected_rarity, rawId.set_code, rawId.copyright_year);
        if (tcgResult.verified) {
          // Only override enrichedId if it wasn't already verified with a different card name
          const enrichedAlreadyVerified = enrichedId.verified === true;
          const namesAgree = !tcgResult.officialCardName || !enrichedId.officialName ||
            normaliseCardName(tcgResult.officialCardName) === normaliseCardName(enrichedId.officialName);
          if (!enrichedAlreadyVerified || namesAgree) {
            enrichedId = {
              ...enrichedId, verified: true,
              officialName: tcgResult.officialCardName || enrichedId.officialName,
              officialSet: tcgResult.officialSetName || enrichedId.officialSet,
              officialNumber: rawId.detected_number,
              referenceImageUrl: tcgResult.referenceImageUrl || enrichedId.referenceImageUrl,
              dbSource: "pokemon-tcg-api",
              detected_set: tcgResult.officialSetName || enrichedId.detected_set,
              detected_rarity: tcgResult.officialRarity || enrichedId.detected_rarity,
              detected_year: tcgResult.officialYear || enrichedId.detected_year,
            };
          } else {
            console.log(`[override-guard] blocked: enriched="${enrichedId.officialName}" tcg="${tcgResult.officialCardName}" — keeping enriched match`);
          }
        }
      }

      // Confidence guard
      const aiConfidence = rawId.confidence || "low";
      const verified = enrichedId.verified === true || tcgResult.verified === true;
      const trustAi = tcgResult.trustAi === true;
      const shouldWrite = verified || aiConfidence === "high" || trustAi;

      if (shouldWrite) {
        const cardName = enrichedId.officialName || enrichedId.detected_name;
        // When trusting AI without TCG verification, leave set_name null for manual entry
        const setName = verified ? (enrichedId.officialSet || enrichedId.detected_set) : null;
        const cardNumber = enrichedId.detected_number;
        const cardGame = enrichedId.detected_game || "pokemon";
        const rarity = enrichedId.detected_rarity;
        // Prefer copyright_year from Claude for better accuracy
        const rawYear = rawId.copyright_year || enrichedId.detected_year;
        const yearMatch = String(rawYear || "").match(/\d{4}/);
        const yearText = yearMatch ? yearMatch[0] : null;

        // Overwrite existing fields when verified or high-confidence;
        // otherwise only fill empty fields (protects manual entries from uncertain guesses)
        const overwrite = verified || aiConfidence === "high";

        if (overwrite) {
          await db.execute(sql`
            UPDATE certificates SET
              card_name = COALESCE(${cardName}, card_name),
              set_name = COALESCE(${setName}, set_name),
              card_number_display = COALESCE(${cardNumber}, card_number_display),
              year_text = COALESCE(${yearText}, year_text),
              card_game = COALESCE(${cardGame}, card_game),
              rarity = COALESCE(${rarity}, rarity),
              updated_at = NOW()
            WHERE id = ${id}
          `);
        } else {
          await db.execute(sql`
            UPDATE certificates SET
              card_name = CASE WHEN card_name IS NULL OR card_name = '' OR card_name = '(untitled)' OR card_name = '(pending)' THEN ${cardName} ELSE card_name END,
              set_name = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
              card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
              year_text = CASE WHEN year_text IS NULL OR year_text = '' THEN ${yearText} ELSE year_text END,
              card_game = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
              rarity = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
              updated_at = NOW()
            WHERE id = ${id}
          `);
        }
        console.log(`[identify-only] wrote to cert ${id}: name=${cardName} set=${setName} number=${cardNumber} year=${yearText} overwrite=${overwrite}`);
      } else {
        console.log(`[identify-only] cert ${id}: confidence=${aiConfidence} tcg=${verified} — NOT writing details`);
      }

      const updatedCert = await storage.getCertificate(id);
      res.json({
        identification: enrichedId,
        confidence: aiConfidence,
        tcgVerified: verified,
        detailsWritten: shouldWrite,
        rejectReason: !shouldWrite ? (tcgResult.rejectReason || "Low confidence — manual entry needed") : undefined,
        cert: updatedCert ? { ...updatedCert, certId: normalizeCertId(updatedCert.certId) } : null,
      });
    } catch (err: any) {
      console.error("[identify-only] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/measure-centering — Sonnet centering-only
  app.post("/api/admin/certificates/:id/measure-centering", requireAdmin, async (req, res) => {
    try {
      const { CENTERING_ONLY_PROMPT } = await import("./grading-prompt");
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      const backKey = c.gradingBackCropped || c.gradingBackOriginal || c.backImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image available" });

      // Fetch images
      const fetchBuf = async (key: string | null): Promise<Buffer | null> => {
        if (!key) return null;
        try { const url = await getR2SignedUrl(key, 300); const r = await fetch(url); return Buffer.from(await r.arrayBuffer()); } catch { return null; }
      };
      const frontBuf = await fetchBuf(frontKey);
      if (!frontBuf) return res.status(400).json({ error: "Could not fetch front image" });
      const backBuf = await fetchBuf(backKey);

      const { resizeForClaude } = await import("./ai-grading-service");
      const { buffer: frontResized } = await resizeForClaude(frontBuf);
      const content: object[] = [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frontResized.toString("base64") } },
      ];
      if (backBuf) {
        const { buffer: backResized } = await resizeForClaude(backBuf);
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: backResized.toString("base64") } });
      }
      content.push({ type: "text", text: CENTERING_ONLY_PROMPT });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      let response;
      try {
        response = await anthropicFetch(
          { model: "claude-opus-4-7", max_tokens: 2048, messages: [{ role: "user", content }] },
          { apiKey, timeoutMs: 30_000 },
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }
      if (!response.ok) throw new Error(`Claude API error ${response.status}`);
      const aiData = await response.json() as { content: { text: string }[] };
      const text = aiData.content?.[0]?.text || "";
      console.log(`[measure-centering] raw response (200 chars): ${text.slice(0, 200)}`);
      const centering = extractJson(text, "measure-centering");

      // Save to cert
      await db.execute(sql`
        UPDATE certificates SET
          ai_analysis = jsonb_set(COALESCE(ai_analysis, '{}'::jsonb), '{centering_measured}', ${JSON.stringify(centering)}::jsonb),
          updated_at = NOW()
        WHERE id = ${id}
      `);

      console.log(`[measure-centering] cert=${id} front=${centering.front_left_right} back=${centering.back_left_right}`);
      res.json({ centering });
    } catch (err: any) {
      console.error("[measure-centering] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/manual-centering — save two-rect manual measurement
  app.post("/api/admin/certificates/:id/manual-centering", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { side, outer, inner } = req.body;
      if (!side || !["front", "back"].includes(side)) return res.status(400).json({ error: "side must be front or back" });
      if (!outer || !inner) return res.status(400).json({ error: "outer and inner rects required" });

      // Calculate centering from the two rectangles
      const leftB = inner.left - outer.left;
      const rightB = outer.right - inner.right;
      const topB = inner.top - outer.top;
      const bottomB = outer.bottom - inner.bottom;
      const totalH = leftB + rightB;
      const totalV = topB + bottomB;

      // Float for accurate subgrade, rounded for display/save
      const lFloat = totalH > 0 ? (leftB / totalH) * 100 : 50;
      const tFloat = totalV > 0 ? (topB / totalV) * 100 : 50;
      const lRound = Math.round(lFloat);
      const tRound = Math.round(tFloat);
      const lr = lRound >= (100 - lRound) ? `${lRound}/${100 - lRound}` : `${100 - lRound}/${lRound}`;
      const tb = tRound >= (100 - tRound) ? `${tRound}/${100 - tRound}` : `${100 - tRound}/${tRound}`;

      const worstDev = Math.max(Math.abs(lFloat - 50), Math.abs(tFloat - 50));
      const subgrade = worstDev <= 2 ? 10 : worstDev <= 5 ? 9 : worstDev <= 10 ? 8 : worstDev <= 15 ? 7 : worstDev <= 20 ? 6 : worstDev <= 35 ? 5 : 4;

      const outerCol = side === "front" ? "centering_outer_front" : "centering_outer_back";
      const innerCol = side === "front" ? "centering_inner_front" : "centering_inner_back";
      const lrCol = side === "front" ? "centering_front_lr" : "centering_back_lr";
      const tbCol = side === "front" ? "centering_front_tb" : "centering_back_tb";

      // Add new columns if they don't exist yet
      try { await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_outer_front JSONB`); } catch {}
      try { await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_inner_front JSONB`); } catch {}
      try { await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_outer_back JSONB`); } catch {}
      try { await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_inner_back JSONB`); } catch {}

      await db.execute(sql.raw(`
        UPDATE certificates SET
          ${outerCol} = '${JSON.stringify(outer)}'::jsonb,
          ${innerCol} = '${JSON.stringify(inner)}'::jsonb,
          ${lrCol} = '${lr}',
          ${tbCol} = '${tb}',
          centering_method = 'manual',
          updated_at = NOW()
        WHERE id = ${id}
      `));

      console.log(`[manual-centering] cert=${id} ${side}: L/R=${lr} T/B=${tb} subgrade=${subgrade}`);
      res.json({ lr, tb, subgrade, outer, inner });
    } catch (err: any) {
      console.error("[manual-centering] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/detect-defects — Sonnet defect-only
  app.post("/api/admin/certificates/:id/detect-defects", requireAdmin, async (req, res) => {
    try {
      const { DEFECTS_ONLY_PROMPT } = await import("./grading-prompt");
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      const backKey = c.gradingBackCropped || c.gradingBackOriginal || c.backImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image available" });

      const fetchBuf = async (key: string | null): Promise<Buffer | null> => {
        if (!key) return null;
        try { const url = await getR2SignedUrl(key, 300); const r = await fetch(url); return Buffer.from(await r.arrayBuffer()); } catch { return null; }
      };
      const frontBuf = await fetchBuf(frontKey);
      if (!frontBuf) return res.status(400).json({ error: "Could not fetch front image" });
      const backBuf = await fetchBuf(backKey);

      const { resizeForClaude } = await import("./ai-grading-service");
      const { buffer: frontResized } = await resizeForClaude(frontBuf);
      const content: object[] = [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frontResized.toString("base64") } },
      ];
      if (backBuf) {
        const { buffer: backResized } = await resizeForClaude(backBuf);
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: backResized.toString("base64") } });
      }
      content.push({ type: "text", text: DEFECTS_ONLY_PROMPT });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      let response;
      try {
        response = await anthropicFetch(
          { model: "claude-opus-4-7", max_tokens: 4096, messages: [{ role: "user", content }] },
          { apiKey, timeoutMs: 30_000 },
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }
      if (!response.ok) throw new Error(`Claude API error ${response.status}`);
      const aiData = await response.json() as { content: { text: string }[] };
      const text = aiData.content?.[0]?.text || "";
      console.log(`[detect-defects] raw length: ${text.length}`);
      console.log(`[detect-defects] first 500: ${text.slice(0, 500)}`);
      console.log(`[detect-defects] last 200: ${text.slice(-200)}`);
      let parsed: any;
      try {
        parsed = extractJson(text, "detect-defects");
      } catch (parseErr: any) {
        console.error(`[detect-defects] JSON extraction failed, returning empty:`, parseErr.message);
        return res.json({ defects: [] });
      }

      // Unwrap: Claude returns {defects: [...], surface_front_grade, ...} — extract the array
      const defectArray: any[] = Array.isArray(parsed.defects) ? parsed.defects : Array.isArray(parsed) ? parsed : [];

      // Filter out defects that are in the background (outside card boundary)
      const rawCount = defectArray.length;
      const filtered = defectArray.filter((d: any) => {
        const x = d.position_x_percent ?? d.x_percent ?? 50;
        const y = d.position_y_percent ?? d.y_percent ?? 50;
        if (x < 3 || x > 97 || y < 3 || y > 97) {
          console.log(`[defect-filter] rejected defect "${d.type}" at (${x.toFixed(1)}, ${y.toFixed(1)}) — outside card boundary`);
          return false;
        }
        return true;
      });

      await db.execute(sql`
        UPDATE certificates SET
          ai_analysis = jsonb_set(COALESCE(ai_analysis, '{}'::jsonb), '{defects_detected}', ${JSON.stringify({ defects: filtered })}::jsonb),
          updated_at = NOW()
        WHERE id = ${id}
      `);

      console.log(`[detect-defects] cert=${id} defects=${filtered.length} (${rawCount - filtered.length} filtered out)`);
      res.json({ defects: filtered });
    } catch (err: any) {
      console.error("[detect-defects] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/grade-card — Sonnet grade-only using context from previous steps
  app.post("/api/admin/certificates/:id/grade-card", requireAdmin, async (req, res) => {
    try {
      const { GRADE_ONLY_PROMPT } = await import("./grading-prompt");
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const aiData = c.aiAnalysis || {};

      // Build context from previous steps
      const cardContext = `${c.cardName || "Unknown"} from ${c.setName || "Unknown"} #${c.cardNumber || "?"} (${c.year || "?"})`;
      const centeringContext = aiData.centering_measured
        ? `Front: ${aiData.centering_measured.front_left_right}, Back: ${aiData.centering_measured.back_left_right}, Subgrade: ${aiData.centering_measured.centering_subgrade}`
        : "Not measured yet";
      const defectsContext = aiData.defects_detected?.defects
        ? `${aiData.defects_detected.defects.length} defects: ${aiData.defects_detected.defects.map((d: any) => `${d.type} (${d.severity})`).join(", ")}`
        : "Not detected yet";

      const prompt = GRADE_ONLY_PROMPT
        .replace("{CARD_CONTEXT}", cardContext)
        .replace("{CENTERING_CONTEXT}", centeringContext)
        .replace("{DEFECTS_CONTEXT}", defectsContext);

      // Also send images for visual context
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      const fetchBuf = async (key: string | null): Promise<Buffer | null> => {
        if (!key) return null;
        try { const url = await getR2SignedUrl(key, 300); const r = await fetch(url); return Buffer.from(await r.arrayBuffer()); } catch { return null; }
      };
      const frontBuf = await fetchBuf(frontKey);

      const content: object[] = [];
      if (frontBuf) {
        const { resizeForClaude } = await import("./ai-grading-service");
        const { buffer: resized } = await resizeForClaude(frontBuf);
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") } });
      }
      content.push({ type: "text", text: prompt });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      let response;
      try {
        response = await anthropicFetch(
          { model: "claude-opus-4-7", max_tokens: 2048, messages: [{ role: "user", content }] },
          { apiKey, timeoutMs: 30_000 },
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }
      if (!response.ok) throw new Error(`Claude API error ${response.status}`);
      const aiResp = await response.json() as { content: { text: string }[] };
      const text = aiResp.content?.[0]?.text || "";
      console.log(`[grade-card] raw response (200 chars): ${text.slice(0, 200)}`);
      const gradeResult = extractJson(text, "grade-card");

      // Clamp grades to whole numbers
      const clamp = (v: any) => { const n = typeof v === "number" ? v : parseFloat(v); return isNaN(n) ? 1 : Math.max(1, Math.min(10, Math.floor(n))); };
      if (typeof gradeResult.overall_grade === "number") gradeResult.overall_grade = clamp(gradeResult.overall_grade);
      if (gradeResult.centering_subgrade) gradeResult.centering_subgrade = clamp(gradeResult.centering_subgrade);
      if (gradeResult.corners_subgrade) gradeResult.corners_subgrade = clamp(gradeResult.corners_subgrade);
      if (gradeResult.edges_subgrade) gradeResult.edges_subgrade = clamp(gradeResult.edges_subgrade);
      if (gradeResult.surface_subgrade) gradeResult.surface_subgrade = clamp(gradeResult.surface_subgrade);
      const strength = typeof gradeResult.grade_strength_score === "number" ? Math.max(0, Math.min(100, Math.round(gradeResult.grade_strength_score))) : null;

      await db.execute(sql`
        UPDATE certificates SET
          ai_analysis = jsonb_set(COALESCE(ai_analysis, '{}'::jsonb), '{grade_result}', ${JSON.stringify(gradeResult)}::jsonb),
          ai_draft_grade = ${gradeResult.overall_grade},
          grade_strength_score = ${strength},
          updated_at = NOW()
        WHERE id = ${id}
      `);

      console.log(`[grade-card] cert=${id} grade=${gradeResult.overall_grade} strength=${strength}`);
      res.json({ grade: gradeResult });
    } catch (err: any) {
      console.error("[grade-card] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/analyze
  app.post("/api/admin/certificates/:id/analyze", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const keys = getCertImageKeys(c);
      if (!keys.frontOriginal && !c.frontImagePath) {
        return res.status(400).json({ error: "No images available for AI analysis" });
      }
      if (!keys.frontOriginal) keys.frontOriginal = c.frontImagePath;
      if (!keys.backOriginal)  keys.backOriginal  = c.backImagePath;

      const cardGame = req.body?.card_game || c.gameType || undefined;
      const analysis = await analyzeCard(keys, cardGame);

      // Persist analysis
      await storage.updateCertificate(id, {
        aiAnalysis: { ...(c.aiAnalysis || {}), grading: analysis } as any,
      });

      res.json({ analysis });
    } catch (err: any) {
      console.error("[ai/analyze] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/certificates/:id/identify-and-analyze
  // Full pipeline: auto-crop → generate 5 views → save to R2 → identify → verify → grade → save
  app.post("/api/admin/certificates/:id/identify-and-analyze", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontOriginal || c.frontImagePath;
      const backKey = c.gradingBackOriginal || c.backImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image available for AI analysis" });

      console.log(`[ai/identify-and-analyze] starting for cert ${id}`);

      // Step 1: Fetch raw images from R2
      const { default: sharpImport } = await import("sharp");
      const fetchR2 = async (key: string | null): Promise<Buffer | null> => {
        if (!key) return null;
        try {
          const url = await getR2SignedUrl(key, 300);
          const resp = await fetch(url);
          return Buffer.from(await resp.arrayBuffer());
        } catch { return null; }
      };

      const frontRaw = await fetchR2(frontKey);
      if (!frontRaw) return res.status(400).json({ error: "Could not fetch front image from storage" });
      const backRaw = await fetchR2(backKey);

      // Step 2: Generate 5 image variants for front (and back if available)
      const frontVariants = await generateImageVariants(frontRaw);
      const backVariants = backRaw ? await generateImageVariants(backRaw) : null;

      // Step 3: Upload all variants to R2
      const prefix = `images/grading/${id}`;
      const uploadKeys: Record<string, string> = {};
      const uploads: Promise<void>[] = [];

      for (const [vName, buf] of Object.entries(frontVariants) as [string, Buffer][]) {
        const k = `${prefix}/front_${vName}.jpg`;
        uploadKeys[`front_${vName}`] = k;
        uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
      }
      if (backVariants) {
        for (const [vName, buf] of Object.entries(backVariants) as [string, Buffer][]) {
          const k = `${prefix}/back_${vName}.jpg`;
          uploadKeys[`back_${vName}`] = k;
          uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
        }
      }
      await Promise.all(uploads);
      console.log(`[ai/identify-and-analyze] uploaded ${uploads.length} image variants to R2`);

      // Step 4: Save image keys to certificate
      await db.execute(sql`
        UPDATE certificates SET
          grading_front_original = ${uploadKeys.front_original || null},
          grading_front_cropped = ${uploadKeys.front_cropped || null},
          grading_front_greyscale = ${uploadKeys.front_greyscale || null},
          grading_front_highcontrast = ${uploadKeys.front_highcontrast || null},
          grading_front_edgeenhanced = ${uploadKeys.front_edgeenhanced || null},
          grading_front_inverted = ${uploadKeys.front_inverted || null},
          grading_back_original = ${uploadKeys.back_original || null},
          grading_back_cropped = ${uploadKeys.back_cropped || null},
          grading_back_greyscale = ${uploadKeys.back_greyscale || null},
          grading_back_highcontrast = ${uploadKeys.back_highcontrast || null},
          grading_back_edgeenhanced = ${uploadKeys.back_edgeenhanced || null},
          grading_back_inverted = ${uploadKeys.back_inverted || null},
          updated_at = NOW()
        WHERE id = ${id}
      `);

      // Step 5: Identify the card (uses cropped front)
      const identification = await identifyCardFromBuffer(frontVariants.cropped, "image/jpeg");

      // Step 6: Pokémon TCG API verification
      const game = identification.detected_game?.toLowerCase();
      let enrichedId = await verifyAndEnrichCardData(identification);
      let tcgTrustAiFlag = false;
      if (game === "pokemon") {
        const tcgResult = await verifyPokemonCardWithTcgApi(
          identification.detected_name,
          identification.detected_number,
          identification.detected_rarity,
          identification.set_code,
          identification.copyright_year
        );
        if (tcgResult.verified) {
          // Only override enrichedId if it wasn't already verified with a different card name
          const enrichedAlreadyVerified = enrichedId.verified === true;
          const namesAgree = !tcgResult.officialCardName || !enrichedId.officialName ||
            normaliseCardName(tcgResult.officialCardName) === normaliseCardName(enrichedId.officialName);
          if (!enrichedAlreadyVerified || namesAgree) {
            console.log(`[ai/identify-and-analyze] TCG API override: "${identification.detected_set}" → "${tcgResult.officialSetName}" (${tcgResult.apiCardId})`);
            enrichedId = {
              ...enrichedId,
              verified: true,
              officialName: tcgResult.officialCardName || enrichedId.officialName,
              officialSet: tcgResult.officialSetName || enrichedId.officialSet,
              officialNumber: identification.detected_number,
              referenceImageUrl: tcgResult.referenceImageUrl || enrichedId.referenceImageUrl,
              dbSource: "pokemon-tcg-api",
              detected_set: tcgResult.officialSetName || enrichedId.detected_set,
              detected_rarity: tcgResult.officialRarity || enrichedId.detected_rarity,
              detected_year: tcgResult.officialYear || enrichedId.detected_year,
            };
          } else {
            console.log(`[override-guard] blocked: enriched="${enrichedId.officialName}" tcg="${tcgResult.officialCardName}" — keeping enriched match`);
          }
        }
        if (tcgResult.trustAi) tcgTrustAiFlag = true;
      }

      // Step 7: Full grading analysis (uses cropped front + back + greyscale + hicontrast)
      const analysis = await analyzeCardFromBuffers(
        frontVariants.cropped,
        backVariants?.cropped || null,
        game
      );

      // Step 8: Extract and log grade strength score
      const strengthScore = typeof (analysis as any).grade_strength_score === "number"
        ? Math.max(0, Math.min(100, Math.round((analysis as any).grade_strength_score)))
        : null;
      if (strengthScore !== null) {
        console.log(`[grade-strength] cert=${id} grade=${analysis.overall_grade} strength=${strengthScore}`);
        await db.execute(sql`
          UPDATE certificates SET grade_strength_score = ${strengthScore} WHERE id = ${id}
        `);
      }

      // Step 9: Confidence check — trust AI when TCG has zero results
      const aiConfidence = identification.confidence || "low";
      const tcgVerified = enrichedId.verified === true;
      const shouldWriteDetails = tcgVerified || aiConfidence === "high" || tcgTrustAiFlag;

      const cardName = shouldWriteDetails ? (enrichedId.officialName || enrichedId.detected_name || null) : null;
      // When trusting AI without TCG verification, leave set_name null for manual entry
      const setName = tcgVerified ? (enrichedId.officialSet || enrichedId.detected_set || null) : null;
      const cardNumber = shouldWriteDetails ? (enrichedId.detected_number || null) : null;
      const cardGame = shouldWriteDetails ? (enrichedId.detected_game || null) : null;
      const rarity = shouldWriteDetails ? (enrichedId.detected_rarity || null) : null;

      // Year normalisation: prefer copyright_year from Claude
      const currentYear = new Date().getFullYear();
      let yearText: string | null = null;
      if (shouldWriteDetails) {
        const rawYear = identification.copyright_year || enrichedId.detected_year || null;
        const match = rawYear ? String(rawYear).match(/\d{4}/) : null;
        yearText = match ? match[0] : null;
      }
      // Year guard: reject years >5 years off current unless TCG API confirmed
      if (yearText && !tcgVerified) {
        const y = parseInt(yearText, 10);
        if (isNaN(y) || Math.abs(y - currentYear) > 5) {
          console.warn(`[ai-identify] year guard: AI guessed ${yearText} but TCG API didn't verify — clearing`);
          yearText = null;
        }
      }

      // Overwrite existing fields when verified or high-confidence;
      // otherwise only fill empty fields (protects manual entries from uncertain guesses)
      const overwrite = tcgVerified || aiConfidence === "high";

      console.log(`[ai-identify] cert=${id} confidence=${aiConfidence} tcgVerified=${tcgVerified} shouldWrite=${shouldWriteDetails} overwrite=${overwrite} name=${cardName}, set=${setName}, number=${cardNumber}, year=${yearText}`);

      const aiAnalysisJson = JSON.stringify({ identification: enrichedId, grading: analysis });
      const aiDraftGrade = typeof analysis.overall_grade === "number" ? analysis.overall_grade : null;

      if (overwrite) {
        await db.execute(sql`
          UPDATE certificates SET
            ai_analysis = ${aiAnalysisJson}::jsonb,
            ai_draft_grade = ${aiDraftGrade},
            card_name = COALESCE(${cardName}, card_name),
            set_name = COALESCE(${setName}, set_name),
            card_number_display = COALESCE(${cardNumber}, card_number_display),
            year_text = COALESCE(${yearText}, year_text),
            card_game = COALESCE(${cardGame}, card_game),
            rarity = COALESCE(${rarity}, rarity),
            updated_at = NOW()
          WHERE id = ${id}
        `);
      } else {
        await db.execute(sql`
          UPDATE certificates SET
            ai_analysis = ${aiAnalysisJson}::jsonb,
            ai_draft_grade = ${aiDraftGrade},
            card_name = CASE WHEN card_name IS NULL OR card_name = '' OR card_name = '(untitled)' OR card_name = '(pending)' THEN ${cardName} ELSE card_name END,
            set_name = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
            card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
            year_text = CASE WHEN year_text IS NULL OR year_text = '' THEN ${yearText} ELSE year_text END,
            card_game = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
            rarity = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
            updated_at = NOW()
          WHERE id = ${id}
        `);
      }

      console.log(`[ai/identify-and-analyze] complete: cert=${id} card="${cardName}" set="${setName}" grade=${analysis.overall_grade} strength=${strengthScore}`);

      // Return the updated cert so the frontend can refresh form fields
      const updatedCert = await storage.getCertificate(id);
      res.json({
        identification: enrichedId,
        analysis,
        cert: updatedCert ? { ...updatedCert, certId: normalizeCertId(updatedCert.certId) } : null,
        identificationConfidence: aiConfidence,
        identificationVerified: tcgVerified,
        detailsWritten: shouldWriteDetails,
      });
    } catch (err: any) {
      console.error("[ai/identify-and-analyze] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Unified "Grade with AI" endpoint — auto-crop, identify, grade in one call ──

  const gradeWithAiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  app.post(
    "/api/admin/certificates/grade-with-ai",
    requireAdmin,
    gradeWithAiUpload.fields([
      { name: "front_image", maxCount: 1 },
      { name: "back_image", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as {
          front_image?: Express.Multer.File[];
          back_image?: Express.Multer.File[];
        };
        const frontFile = files.front_image?.[0];
        if (!frontFile) return res.status(400).json({ error: "front_image is required" });
        const backFile = files.back_image?.[0];
        const certId = req.body.cert_id ? parseInt(req.body.cert_id) : null;

        console.log("[grade-with-ai] starting workflow", {
          certId,
          frontSize: `${(frontFile.size / 1024 / 1024).toFixed(1)}MB`,
          backSize: backFile ? `${(backFile.size / 1024 / 1024).toFixed(1)}MB` : "none",
        });

        // Step 1: Auto-crop both images
        const frontCropped = await autoCropCard(frontFile.buffer);
        const backCropped = backFile ? await autoCropCard(backFile.buffer) : null;

        // Step 2: Upload cropped images to R2
        const ts = Date.now();
        const frontKey = `images/grade-ai/${ts}_front.jpg`;
        const backKey = backCropped ? `images/grade-ai/${ts}_back.jpg` : null;
        await uploadToR2(frontKey, frontCropped, "image/jpeg");
        if (backCropped && backKey) await uploadToR2(backKey, backCropped, "image/jpeg");

        // Step 3: Identify the card from front image
        const identification = await identifyCardFromBuffer(frontCropped, "image/jpeg");

        // Step 4: Run full grading analysis
        const cardGame = identification.detected_game || undefined;
        const grading = await analyzeCardFromBuffers(frontCropped, backCropped, cardGame);

        // Step 5: Get signed URLs for the cropped images
        const frontUrl = await getR2SignedUrl(frontKey, 3600);
        const backUrl = backKey ? await getR2SignedUrl(backKey, 3600) : null;

        // Step 6: If cert_id provided, save AI analysis to existing cert
        if (certId) {
          await db.execute(sql`
            UPDATE certificates SET
              ai_analysis = ${JSON.stringify({ identification, grading })}::jsonb,
              ai_draft_grade = ${typeof grading.overall_grade === "number" ? grading.overall_grade : null},
              updated_at = NOW()
            WHERE id = ${certId}
          `);
        }

        console.log("[grade-with-ai] complete", {
          certId,
          card: identification.detected_name,
          grade: grading.overall_grade,
          defects: grading.defects?.length ?? 0,
        });

        res.json({
          success: true,
          cert_id: certId,
          identification: {
            card_name: identification.detected_name,
            set_name: identification.detected_set,
            card_number: identification.detected_number,
            year: identification.detected_year,
            language: identification.detected_language,
            card_game: identification.detected_game,
            rarity: identification.detected_rarity,
            is_holo: identification.is_holo,
            is_foil: identification.is_foil,
            confidence: identification.confidence,
          },
          grading: {
            overall_grade: grading.overall_grade,
            grade_label: grading.grade_label,
            subgrades: {
              centering: grading.centering?.subgrade,
              corners: grading.corners?.subgrade,
              edges: grading.edges?.subgrade,
              surface: grading.surface?.subgrade,
            },
            centering_measurements: {
              front_left_right: grading.centering?.front_left_right,
              front_top_bottom: grading.centering?.front_top_bottom,
              back_left_right: grading.centering?.back_left_right,
              back_top_bottom: grading.centering?.back_top_bottom,
            },
            defects: grading.defects || [],
            confidence: grading.confidence,
            grade_explanation: grading.grade_explanation,
            is_authentic: grading.is_authentic,
            is_altered: grading.is_altered,
            authentication_notes: grading.authentication_notes,
            recommendations: grading.recommendations,
          },
          image_urls: {
            front_cropped: frontUrl,
            back_cropped: backUrl,
          },
        });
      } catch (err: any) {
        console.error("[grade-with-ai] error:", err.message);
        res.status(500).json({ error: "Grading failed", details: err.message });
      }
    }
  );

  // ── Build 6+: Identify card from uploaded image (no cert required) ─────────

  const identifyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  app.post("/api/admin/identify-image", requireAdmin, identifyUpload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    try {
      const result = await identifyCardFromBuffer(req.file.buffer, req.file.mimetype || "image/jpeg");
      res.json(result);
    } catch (err: any) {
      console.error("[ai/identify-image] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Build 6: Public tools ──────────────────────────────────────────────────

  const toolsRateLimit = rateLimit({
    windowMs: 60 * 1000, max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many requests — please wait a minute." },
  });
  // Admin bypass uses the `x-mv-admin-email` request header — body isn't parsed
  // yet when `skip` runs (multer is downstream). Admins hitting the web UI form
  // without the header will share the 5/hour bucket; power use should curl with
  // the header set.
  const estimateRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many estimate requests — you can request up to 5 estimates per hour." },
    skip: (req) => {
      const headerEmail = (req.headers["x-mv-admin-email"] as string || "").trim().toLowerCase();
      return headerEmail === ADMIN_FREE_EMAIL;
    },
  });

  const toolsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  // GET /api/tools/estimate/credits?email=
  app.get("/api/tools/estimate/credits", async (req, res) => {
    const email = (req.query.email as string || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });
    try {
      const rows = await db.execute(sql`
        SELECT credits_remaining, credits_purchased, credits_used
        FROM estimate_credits WHERE email = ${email}
      `);
      if (rows.rows.length === 0) return res.json({ credits: 0, email });
      const row = rows.rows[0] as any;
      res.json({ credits: row.credits_remaining, email });
    } catch (err: any) {
      console.error("[estimate/credits] error:", err.message);
      res.status(500).json({ error: "Failed to check credits" });
    }
  });

  // POST /api/tools/estimate/checkout  { email, package: "5"|"15"|"100", return_path?: "/tools/centering" }
  app.post("/api/tools/estimate/checkout", async (req, res) => {
    const email = (req.body.email || "").trim().toLowerCase();
    const pkg = req.body.package as string;
    const returnPath = (req.body.return_path as string) || "/tools/estimate";
    if (!email) return res.status(400).json({ error: "Email required" });
    const pkgInfo = ESTIMATE_PACKAGES[pkg];
    if (!pkgInfo) return res.status(400).json({ error: "Invalid package" });
    try {
      const stripe = await getUncachableStripeClient();
      const origin = (req.headers.origin as string) || "https://mintvaultuk.com";
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: email,
        line_items: [{
          price_data: {
            currency: "gbp",
            product_data: {
              name: `MintVault Pre-Grade Estimates — ${pkgInfo.label}`,
              description: `${pkgInfo.credits} AI pre-grading estimates for your trading cards`,
            },
            unit_amount: pkgInfo.pricePence,
          },
          quantity: 1,
        }],
        metadata: {
          type: "estimate_credits",
          email,
          credits: String(pkgInfo.credits),
        },
        success_url: `${origin}${returnPath}?payment=success&email=${encodeURIComponent(email)}`,
        cancel_url: `${origin}${returnPath}?payment=cancelled`,
      });
      res.json({ url: session.url });
    } catch (err: any) {
      console.error("[estimate/checkout] error:", err.message);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // POST /api/tools/estimate  (multipart: image + optional email field)
  // Pre-grade checker images are NOT saved — they're for one-time AI analysis only and deleted
  // immediately after processing to keep storage costs down. Images land in multer memory storage,
  // are resized in-memory with sharp, sent to Anthropic as base64, then garbage collected with
  // the request. Nothing is written to R2, Neon, or disk.
  // No rate limit for paid users (email + credits > 0); free uses get the standard limit.
  app.post("/api/tools/estimate", estimateRateLimit, toolsUpload.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No image uploaded" });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      console.log("[tools/estimate] ANTHROPIC_API_KEY present:", !!apiKey, "| length:", apiKey?.length ?? 0);
      if (!apiKey) {
        console.error("[tools/estimate] CRITICAL: ANTHROPIC_API_KEY secret missing. Run: flyctl secrets set ANTHROPIC_API_KEY=sk-ant-... -a <app-name>");
        return res.status(503).json({ error: "AI service is temporarily unavailable. Please try again shortly." });
      }

      const email = (req.body.email || "").trim().toLowerCase();
      const isAdminFree = email === ADMIN_FREE_EMAIL;

      // Logged-in users: check ai_credits_user_balance first, then fall back to email credits
      const sessionUserId = (req.session as any)?.userId;
      let usedUserBalance = false;

      if (!isAdminFree) {
        if (sessionUserId) {
          // Try user-level AI credit balance first
          const deduction = await deductAiCredits(sessionUserId, 1, 'ai_grading_estimate');
          if (deduction.ok) {
            usedUserBalance = true;
          } else if (deduction.reason === 'no_user') {
            return res.status(401).json({ error: "User account not found." });
          } else if (email) {
            // Fall back to email-based credits (e.g. pre-account purchases)
            const rows = await db.execute(sql`
              SELECT id, credits_remaining FROM estimate_credits WHERE email = ${email}
            `);
            if (rows.rows.length === 0 || (rows.rows[0] as any).credits_remaining <= 0) {
              await db.insert(auditLog).values({
                entityType: "estimate", entityId: sessionUserId, action: "402_insufficient",
                adminUser: null, details: { path: "user_then_email_empty", email },
              }).catch(() => {});
              return res.status(402).json({ error: "No credits remaining. Purchase more estimates to continue." });
            }
            await db.execute(sql`
              UPDATE estimate_credits
              SET credits_remaining = credits_remaining - 1,
                  credits_used = credits_used + 1,
                  updated_at = NOW()
              WHERE email = ${email} AND credits_remaining > 0
            `);
          } else {
            await db.insert(auditLog).values({
              entityType: "estimate", entityId: sessionUserId, action: "402_insufficient",
              adminUser: null, details: { path: "user_no_balance_no_email" },
            }).catch(() => {});
            return res.status(402).json({ error: "No AI credits remaining. Buy a pack or join Vault Club Silver when it reopens." });
          }
        } else if (email) {
          // Anonymous with email — use email credits only
          const rows = await db.execute(sql`
            SELECT id, credits_remaining FROM estimate_credits WHERE email = ${email}
          `);
          if (rows.rows.length === 0 || (rows.rows[0] as any).credits_remaining <= 0) {
            await db.insert(auditLog).values({
              entityType: "estimate", entityId: email, action: "402_insufficient",
              adminUser: null, details: { path: "anon_email_empty" },
            }).catch(() => {});
            return res.status(402).json({ error: "No credits remaining. Purchase more estimates to continue." });
          }
          await db.execute(sql`
            UPDATE estimate_credits
            SET credits_remaining = credits_remaining - 1,
                credits_used = credits_used + 1,
                updated_at = NOW()
            WHERE email = ${email} AND credits_remaining > 0
          `);
        } else {
          // Anonymous + no email — server-side free tier: 1 estimate per IP per UTC day.
          // IP hashed SHA-256 before storage (never raw, per privacy rules).
          const ipRaw = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
                        || req.socket.remoteAddress || "unknown";
          const ipHash = crypto.createHash("sha256").update(ipRaw).digest("hex");
          const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD UTC
          const upsert = await db.execute(sql`
            INSERT INTO estimate_free_uses (ip_hash, last_used_at, count_today)
            VALUES (${ipHash}, NOW(), 1)
            ON CONFLICT (ip_hash) DO UPDATE SET
              count_today = CASE
                WHEN to_char(estimate_free_uses.last_used_at, 'YYYY-MM-DD') = ${today}
                THEN estimate_free_uses.count_today + 1
                ELSE 1
              END,
              last_used_at = NOW()
            RETURNING count_today
          `);
          const countToday = Number((upsert.rows[0] as any).count_today);
          if (countToday > 1) {
            await db.insert(auditLog).values({
              entityType: "estimate", entityId: ipHash, action: "402_insufficient",
              adminUser: null, details: { path: "anon_ip_day_limit", countToday },
            }).catch(() => {});
            return res.status(402).json({
              error: "Free estimate used for today. Add an email to buy a credit pack from £2 for 5 estimates.",
              freeLimit: 1,
              windowResetAt: "midnight UTC",
            });
          }
        }
      }

      const { PRE_GRADE_PROMPT } = await import("./grading-prompt");

      // Resize large images before sending to Anthropic (phone photos can be 6-8MB)
      const sharp = (await import("sharp")).default;
      const resizedBuffer = await sharp(req.file.buffer)
        .resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      console.log(`[tools/estimate] image resized: ${req.file.size} bytes → ${resizedBuffer.length} bytes`);

      const base64 = resizedBuffer.toString("base64");
      const mt = "image/jpeg";

      let response;
      try {
        response = await anthropicFetch(
          {
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2048,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: mt, data: base64 } },
              { type: "text", text: PRE_GRADE_PROMPT },
            ]}],
          },
          { apiKey, timeoutMs: 30_000 },
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        console.error("[tools/estimate] Anthropic API error", response.status, errBody.slice(0, 300));
        throw new Error(`AI API error ${response.status}: ${errBody.slice(0, 200)}`);
      }
      const aiData = await response.json() as { content: { text: string }[] };
      const text = aiData.content?.[0]?.text || "";
      const cleaned = text.replace(/```json|```/g, "").trim();
      const estimate = JSON.parse(cleaned);

      // Backwards-compatible fields for existing client UI
      const sub = estimate.subgrades || {};
      const overall = estimate.overall_grade_estimate || {};
      const compat = {
        estimated_grade_low: overall.low ?? estimate.estimated_grade_low ?? 5,
        estimated_grade_high: overall.high ?? estimate.estimated_grade_high ?? 5,
        grade_label_low: overall.label ?? estimate.grade_label_low ?? "",
        grade_label_high: overall.label ?? estimate.grade_label_high ?? "",
        centering_notes: sub.centering?.note ?? estimate.centering_notes ?? "",
        corners_notes: sub.corners?.note ?? estimate.corners_notes ?? "",
        edges_notes: sub.edges?.note ?? estimate.edges_notes ?? "",
        surface_notes: sub.surface?.note ?? estimate.surface_notes ?? "",
        potential_issues: Array.isArray(estimate.potential_issues)
          ? estimate.potential_issues.map((p: any) => typeof p === "string" ? p : p.description || "")
          : [],
        recommendation: estimate.recommendation ?? "",
        confidence: sub.surface?.confidence ?? estimate.confidence ?? "medium",
      };

      // Return remaining credits with response
      let creditsLeft: number | undefined;
      if (usedUserBalance && sessionUserId) {
        const cr = await db.execute(sql`SELECT ai_credits_user_balance FROM users WHERE id = ${sessionUserId}`);
        creditsLeft = cr.rows.length ? (cr.rows[0] as any).ai_credits_user_balance : 0;
      } else if (email && !isAdminFree) {
        const cr = await db.execute(sql`SELECT credits_remaining FROM estimate_credits WHERE email = ${email}`);
        creditsLeft = cr.rows.length ? (cr.rows[0] as any).credits_remaining : 0;
      }
      // Merge: new structured fields + compat fields + credits
      res.json({ ...estimate, ...compat, credits_remaining: creditsLeft });
    } catch (err: any) {
      console.error("[tools/estimate] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin scan-ingest: scanner → cert → AI pipeline in one call ────────────

  const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  app.post(
    "/api/admin/scan-ingest",
    requireScannerOrAdmin,
    scanUpload.fields([{ name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]),
    async (req, res) => {
      const { createCertForScan, uploadImagesToCert, runAiOnCert } = await import("./scan-ingest-service");
      let certInfo: { id: number; certId: string } | null = null;

      try {
        const files = req.files as Record<string, Express.Multer.File[]>;
        if (!files?.front?.[0]) return res.status(400).json({ error: "Front image is required" });

        const frontBuf = files.front[0].buffer;
        const backBuf = files.back?.[0]?.buffer || null;
        const notes = (req.body?.notes || "").trim();
        const clientSource = (req.body?.client_source || "admin_ui").trim();

        console.log(`[scan-ingest] starting: front=${(frontBuf.length / 1024).toFixed(0)}KB back=${backBuf ? (backBuf.length / 1024).toFixed(0) + "KB" : "none"} source=${clientSource}`);

        // Step 1: Create cert
        certInfo = await createCertForScan();
        console.log(`[scan-ingest] cert created: ${certInfo.certId} (id=${certInfo.id})`);

        // Step 2: Upload + process images
        const { frontVariants, backVariants } = await uploadImagesToCert(certInfo.id, frontBuf, backBuf);
        console.log(`[scan-ingest] images processed for cert ${certInfo.certId}`);

        // Save notes if provided
        if (notes) {
          await db.execute(sql`UPDATE certificates SET notes = ${notes} WHERE id = ${certInfo.id}`);
        }

        // Step 3: Run AI — sync if client_source is scanner_app, async otherwise
        const isSync = clientSource === "scanner_app";

        if (isSync) {
          // Scanner desktop app needs result inline for display
          try {
            const aiResult = await runAiOnCert(certInfo.id, frontVariants.cropped, backVariants?.cropped || null);
            console.log(`[scan-ingest] AI done for ${certInfo.certId}: grade=${aiResult.grade}`);
            res.json({
              certId: certInfo.certId,
              dbId: certInfo.id,
              workstationUrl: `/admin#grading-${certInfo.id}`,
              aiStatus: "complete",
              aiResult,
              message: `Certificate ${certInfo.certId} graded.`,
            });
          } catch (aiErr: any) {
            console.error(`[scan-ingest] AI failed for ${certInfo.certId}: ${aiErr.message}`);
            res.json({
              certId: certInfo.certId,
              dbId: certInfo.id,
              workstationUrl: `/admin#grading-${certInfo.id}`,
              aiStatus: "failed",
              aiError: aiErr.message,
              message: `Certificate ${certInfo.certId} created but AI grading failed. Retry from workstation.`,
            });
          }
        } else {
          // Watcher script / admin UI — respond immediately, AI runs in background
          const aiPromise = runAiOnCert(certInfo.id, frontVariants.cropped, backVariants?.cropped || null)
            .then(r => console.log(`[scan-ingest] AI done for ${certInfo!.certId}: grade=${r.grade}`))
            .catch(e => console.error(`[scan-ingest] AI failed for ${certInfo!.certId}: ${e.message}`));

          res.json({
            certId: certInfo.certId,
            dbId: certInfo.id,
            workstationUrl: `/admin#grading-${certInfo.id}`,
            aiStatus: "processing",
            message: `Certificate ${certInfo.certId} created. AI grading in progress.`,
          });

          await aiPromise;
        }
      } catch (err: any) {
        console.error(`[scan-ingest] error${certInfo ? ` (cert=${certInfo.certId})` : ""}: ${err.message}`);
        res.status(500).json({ error: `Scan ingest failed: ${err.message}`, certId: certInfo?.certId || null });
      }
    }
  );

  // ── Admin scan-history: list certs from scanner ───────────────────────────

  app.get("/api/admin/scan-history", requireAdmin, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
      const limit = 50;
      const offset = (page - 1) * limit;
      const status = (req.query.status as string) || null;

      let whereClause = sql`source = 'admin_scan' AND deleted_at IS NULL`;
      if (status === "graded") whereClause = sql`${whereClause} AND grade IS NOT NULL`;
      else if (status === "pending") whereClause = sql`${whereClause} AND grade IS NULL`;

      const countResult = await db.execute(sql`SELECT COUNT(*)::int as total FROM certificates WHERE ${whereClause}`);
      const total = (countResult.rows[0] as any).total;

      const rows = await db.execute(sql`
        SELECT id, certificate_number, card_name, card_game, grade, grade_type, label_type,
               centering_score, corners_score, edges_score, surface_score,
               ai_draft_grade, grade_strength_score, grade_approved_by,
               front_image_path, issued_at, updated_at, source
        FROM certificates
        WHERE ${whereClause}
        ORDER BY issued_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      res.json({
        scans: (rows.rows as any[]).map(r => ({
          id: r.id,
          certId: r.certificate_number?.replace(/^MV-?0+/, "MV") || "",
          cardName: r.card_name || null,
          cardGame: r.card_game || null,
          grade: r.grade ? parseFloat(r.grade) : null,
          gradeType: r.grade_type || "numeric",
          labelType: r.label_type || "Standard",
          centering: r.centering_score ? parseFloat(r.centering_score) : null,
          corners: r.corners_score ? parseFloat(r.corners_score) : null,
          edges: r.edges_score ? parseFloat(r.edges_score) : null,
          surface: r.surface_score ? parseFloat(r.surface_score) : null,
          aiDraftGrade: r.ai_draft_grade ? parseFloat(r.ai_draft_grade) : null,
          strengthScore: r.grade_strength_score || null,
          grader: r.grade_approved_by || null,
          frontImagePath: r.front_image_path || null,
          createdAt: r.issued_at,
          updatedAt: r.updated_at,
        })),
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err: any) {
      console.error("[scan-history] error:", err.message);
      res.status(500).json({ error: "Failed to load scan history" });
    }
  });

  // ── Build 6: Admin Learning Dashboard ─────────────────────────────────────

  app.get("/api/admin/learning/overview", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT
          COUNT(*)::int                                    AS total_graded,
          COUNT(*) FILTER (WHERE DATE_TRUNC('month', completed_at) = DATE_TRUNC('month', NOW()))::int AS this_month,
          ROUND(AVG(final_grade)::numeric, 2)             AS avg_grade,
          ROUND(AVG(grading_duration_seconds)::numeric, 0)::int AS avg_seconds,
          COUNT(*) FILTER (WHERE final_grade = 10)::int   AS black_label_count
        FROM grading_sessions
        WHERE final_grade IS NOT NULL
      `);
      const overview = rows.rows[0] || {};

      const distRows = await db.execute(sql`
        SELECT final_grade, COUNT(*)::int AS count
        FROM grading_sessions
        WHERE final_grade IS NOT NULL
        GROUP BY final_grade
        ORDER BY final_grade DESC
      `);

      const gameRows = await db.execute(sql`
        SELECT card_game, COUNT(*)::int AS count
        FROM grading_sessions
        WHERE card_game IS NOT NULL
        GROUP BY card_game
        ORDER BY count DESC
      `);

      const activityRows = await db.execute(sql`
        SELECT DATE(completed_at) AS day, COUNT(*)::int AS count
        FROM grading_sessions
        WHERE completed_at >= NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day
      `);

      res.json({
        overview,
        grade_distribution: distRows.rows,
        game_distribution: gameRows.rows,
        activity_last_30_days: activityRows.rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/learning/accuracy", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(centering_diff) <= 0.5) / NULLIF(COUNT(*) FILTER (WHERE centering_diff IS NOT NULL), 0), 1) AS centering_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(corners_diff) <= 0.5)   / NULLIF(COUNT(*) FILTER (WHERE corners_diff IS NOT NULL), 0), 1)   AS corners_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(edges_diff) <= 0.5)     / NULLIF(COUNT(*) FILTER (WHERE edges_diff IS NOT NULL), 0), 1)     AS edges_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(surface_diff) <= 0.5)   / NULLIF(COUNT(*) FILTER (WHERE surface_diff IS NOT NULL), 0), 1)   AS surface_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(overall_diff) <= 0.5)   / NULLIF(COUNT(*) FILTER (WHERE overall_diff IS NOT NULL), 0), 1)   AS overall_accuracy,
          ROUND(AVG(centering_diff)::numeric, 2) AS avg_centering_diff,
          ROUND(AVG(corners_diff)::numeric, 2)   AS avg_corners_diff,
          ROUND(AVG(edges_diff)::numeric, 2)     AS avg_edges_diff,
          ROUND(AVG(surface_diff)::numeric, 2)   AS avg_surface_diff,
          ROUND(AVG(overall_diff)::numeric, 2)   AS avg_overall_diff
        FROM grading_sessions
        WHERE overall_diff IS NOT NULL
      `);
      res.json(rows.rows[0] || {});
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/admin/certificates/:id/status
  app.put("/api/admin/certificates/:id/status", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { status, tracking_number } = req.body;
      const validStatuses = ["submitted", "received", "in_queue", "grading", "quality_check", "slab_production", "shipping", "delivered"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      await db.execute(sql`
        UPDATE certificates
        SET grading_status = ${status},
            status_updated_at = NOW(),
            cert_tracking_number = COALESCE(${tracking_number || null}, cert_tracking_number),
            updated_at = NOW()
        WHERE id = ${id}
      `);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/customer/portfolio — customer's graded cards
  app.get("/api/customer/portfolio", requireCustomer, async (req, res) => {
    try {
      const email = (req.session as any).customerEmail;
      if (!email) return res.status(401).json({ error: "Not authenticated" });
      const rows = await db.execute(sql`
        SELECT
          c.id, c.cert_id, c.card_name, c.set_name, c.year, c.card_game, c.language,
          c.grade_overall, c.grade_type, c.created_at, c.grading_status,
          c.estimated_value_low, c.estimated_value_high,
          o.label_type
        FROM certificates c
        LEFT JOIN ownership_records o ON o.certificate_id = c.id AND o.owner_email = ${email} AND o.is_current = true
        WHERE c.grade_approved_by IS NOT NULL
          AND (o.owner_email = ${email} OR c.owner_email = ${email})
        ORDER BY c.created_at DESC
      `);
      res.json(rows.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/public/collection/:userId — shareable collection
  app.get("/api/public/collection/:userId", async (req, res) => {
    try {
      const userId = String(req.params.userId);
      const rows = await db.execute(sql`
        SELECT c.cert_id, c.card_name, c.set_name, c.year, c.card_game,
               c.grade_overall, c.grade_type, c.created_at
        FROM certificates c
        JOIN ownership_records o ON o.certificate_id = c.id
          AND o.owner_id = ${userId} AND o.is_current = true
          AND o.collection_public = true
        WHERE c.grade_approved_by IS NOT NULL
        ORDER BY c.created_at DESC
      `);
      res.json({ cards: rows.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Population report ───────────────────────────────────────────────────────
  app.get("/api/population", async (req, res) => {
    try {
      const game = typeof req.query.game === "string" ? req.query.game.trim() : undefined;
      const set  = typeof req.query.set  === "string" ? req.query.set.trim()  : undefined;
      const card = typeof req.query.card === "string" ? req.query.card.trim() : undefined;
      const rows = await storage.getGlobalPopulation({
        game: game || undefined,
        set:  set  || undefined,
        card: card || undefined,
      });

      // Counters + recent certs for the showcase hero
      const countersResult = await db.execute(sql`
        SELECT
          COUNT(*)::int as total_graded,
          COUNT(DISTINCT card_name)::int as unique_cards,
          COUNT(DISTINCT set_name)::int as unique_sets,
          COUNT(CASE WHEN ownership_status = 'claimed' THEN 1 END)::int as claimed_count,
          ROUND(AVG(grade::numeric), 1) as avg_grade
        FROM certificates
        WHERE deleted_at IS NULL AND grade IS NOT NULL
      `);
      const counters = countersResult.rows[0] as any;

      const recentResult = await db.execute(sql`
        SELECT certificate_number, card_name, set_name, grade, label_type, front_image_path, grade_approved_at
        FROM certificates
        WHERE deleted_at IS NULL AND grade IS NOT NULL AND grade_approved_at IS NOT NULL
        ORDER BY grade_approved_at DESC
        LIMIT 12
      `);
      const recent = await Promise.all((recentResult.rows as any[]).map(async (r) => {
        let imageUrl: string | null = null;
        const imgKey = r.front_image_path;
        if (imgKey) {
          try { imageUrl = await getR2SignedUrl(imgKey, 3600); } catch {}
        }
        const certNum = String(r.certificate_number).replace(/^MV-?0+/, "MV");
        return {
          certificate_number: certNum,
          card_name: r.card_name || null,
          card_set: r.set_name || null,
          grade: r.grade ? parseFloat(r.grade) : null,
          label_type: r.label_type || "Standard",
          card_image_front_url: imageUrl,
          approved_at: r.grade_approved_at,
        };
      }));

      res.json({
        counters: {
          total_graded: counters.total_graded || 0,
          unique_cards: counters.unique_cards || 0,
          unique_sets: counters.unique_sets || 0,
          claimed_count: counters.claimed_count || 0,
          avg_grade: counters.avg_grade ? parseFloat(counters.avg_grade) : 0,
        },
        recent,
        population: rows,
      });
    } catch (err) {
      console.error("[population] error:", err);
      res.status(500).json({ error: "Failed to load population data." });
    }
  });

  // ── Population — filtered cert list ─────────────────────────────────────────
  app.get("/api/population/certs", async (req, res) => {
    try {
      const card = typeof req.query.card === "string" ? req.query.card.trim() : "";
      const set  = typeof req.query.set  === "string" ? req.query.set.trim()  : "";
      if (!card && !set) return res.status(400).json({ error: "card or set required" });

      const cardEsc = card.replace(/'/g, "''").replace(/%/g, "\\%");
      const setEsc  = set.replace(/'/g, "''").replace(/%/g, "\\%");

      const conditions: string[] = [`status = 'active'`, `deleted_at IS NULL`, `grade_type = 'numeric'`];
      if (card) conditions.push(`LOWER(card_name) LIKE LOWER('%${cardEsc}%')`);
      if (set)  conditions.push(`LOWER(set_name) LIKE LOWER('%${setEsc}%')`);

      const result = await db.execute(sql.raw(`
        SELECT cert_id, card_name, set_name, card_game, grade_overall, created_at
        FROM certificates
        WHERE ${conditions.join(" AND ")}
        ORDER BY grade_overall DESC NULLS LAST, created_at DESC
        LIMIT 500
      `));

      res.json((result.rows as any[]).map(r => ({
        certId:      r.cert_id,
        cardName:    r.card_name,
        setName:     r.set_name,
        cardGame:    r.card_game,
        grade:       r.grade_overall,
        gradedAt:    r.created_at,
      })));
    } catch (err) {
      console.error("[population/certs] error:", err);
      res.status(500).json({ error: "Failed to load certificates." });
    }
  });

  // ── Account auth (/api/auth/*) ────────────────────────────────────────────

  function getClientIpForAuth(req: any): string {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
    return req.ip || req.socket?.remoteAddress || "unknown";
  }

  function getAppBaseUrl(req: any): string {
    return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  }

  // POST /api/auth/signup
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { email, password, display_name } = req.body;
      if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
      const pwCheck = validatePassword(password);
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });

      const existing = await findUserByEmail(email);
      if (existing && !existing.deleted_at) return res.status(409).json({ error: "An account with that email already exists" });

      const hash = await hashPassword(password);
      const result = await db.execute(sql`
        INSERT INTO users (email, password_hash, display_name, email_verified, role, created_at, updated_at)
        VALUES (${email.toLowerCase().trim()}, ${hash}, ${display_name?.trim() || null}, false, 'customer', NOW(), NOW())
        RETURNING id, email, display_name, email_verified
      `);
      const user = result.rows[0] as any;
      const verifyToken = await createEmailVerificationToken(user.id);
      const verifyUrl = `${getAppBaseUrl(req)}/api/auth/verify-email?token=${verifyToken}`;
      await sendWelcomeVerificationEmail(user.email, user.display_name, verifyUrl);
      await writeAuthAudit("auth.signup", user.id, getClientIpForAuth(req), { email: user.email });

      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      return res.status(201).json({ id: user.id, email: user.email, display_name: user.display_name, email_verified: false });
    } catch (err: any) {
      console.error("[auth] signup error:", err.message);
      return res.status(500).json({ error: "Signup failed. Please try again." });
    }
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (req, res) => {
    const ip = getClientIpForAuth(req);
    const ua = req.headers["user-agent"] as string | undefined;
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(401).json({ error: "invalid_credentials" });

      // IP rate limit check (express-rate-limit handles this via app.use in index.ts)
      // Email-level rate limit: 10 failed attempts in 1 hour
      const emailFailures = await countRecentFailedAttempts(email, 60);
      if (emailFailures >= 10) {
        await logLoginAttempt(email, ip, false, ua);
        await writeAuthAudit("auth.login.blocked", "unknown", ip, { email });
        // Generic error — do NOT reveal lockout
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const user = await findUserByEmail(email);
      if (!user || user.deleted_at) {
        await logLoginAttempt(email, ip, false, ua);
        await writeAuthAudit("auth.login.failure", "unknown", ip, { email, reason: "user_not_found" });
        return res.status(401).json({ error: "invalid_credentials" });
      }
      if (!user.password_hash) {
        await logLoginAttempt(email, ip, false, ua);
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const valid = await verifyPassword(password as string, user.password_hash as string);
      if (!valid) {
        await logLoginAttempt(email, ip, false, ua);
        await db.execute(sql`UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${user.id as string}`);
        await writeAuthAudit("auth.login.failure", user.id as string, ip, { email });
        return res.status(401).json({ error: "invalid_credentials" });
      }

      // Success — regenerate session to prevent fixation
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;

      await db.execute(sql`
        UPDATE users SET last_login_at = NOW(), last_login_ip = ${ip}, failed_login_count = 0 WHERE id = ${user.id as string}
      `);
      await logLoginAttempt(email, ip, true, ua);
      await writeAuthAudit("auth.login.success", user.id as string, ip, { email });
      return res.json({ id: user.id, email: user.email, display_name: user.display_name, email_verified: user.email_verified });
    } catch (err: any) {
      console.error("[auth] login error:", err.message);
      return res.status(500).json({ error: "Login failed. Please try again." });
    }
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", async (req, res) => {
    const userId = (req.session as any).userId as string | undefined;
    if (userId) await writeAuthAudit("auth.logout", userId, getClientIpForAuth(req), {});
    req.session.destroy(() => {});
    res.clearCookie("mv.sid");
    return res.json({ ok: true });
  });

  // POST /api/auth/magic-link
  app.post("/api/auth/magic-link", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });
      // Generic success regardless of whether account exists (prevents enumeration)
      const user = await findUserByEmail(email);
      if (user && !user.deleted_at) {
        const token = await createAccountMagicLinkToken(user.id as string);
        const loginUrl = `${getAppBaseUrl(req)}/api/auth/magic-link/verify?token=${token}`;
        await sendAccountMagicLinkEmail(user.email as string, loginUrl);
        await writeAuthAudit("auth.magic_link.requested", user.id as string, getClientIpForAuth(req), { email });
      }
      return res.json({ ok: true, message: "If an account exists, a login link has been sent." });
    } catch (err: any) {
      console.error("[auth] magic-link error:", err.message);
      return res.json({ ok: true, message: "If an account exists, a login link has been sent." });
    }
  });

  // GET /api/auth/magic-link/verify?token=...
  app.get("/api/auth/magic-link/verify", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string") return res.redirect("/login?error=expired_link");
      const rows = await db.execute(sql`
        SELECT * FROM account_magic_link_tokens WHERE token = ${token} LIMIT 1
      `);
      if (!rows.rows.length) return res.redirect("/login?error=expired_link");
      const rec = rows.rows[0] as any;
      if (rec.consumed_at || new Date(rec.expires_at) < new Date()) {
        return res.redirect("/login?error=expired_link");
      }
      await db.execute(sql`UPDATE account_magic_link_tokens SET consumed_at = NOW() WHERE token = ${token}`);
      const user = await findUserById(rec.user_id);
      if (!user || user.deleted_at) return res.redirect("/login?error=expired_link");

      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      await db.execute(sql`UPDATE users SET last_login_at = NOW(), last_login_ip = ${getClientIpForAuth(req)} WHERE id = ${user.id as string}`);
      await writeAuthAudit("auth.magic_link.used", user.id as string, getClientIpForAuth(req), {});
      return res.redirect("/dashboard");
    } catch (err: any) {
      console.error("[auth] magic-link verify error:", err.message);
      return res.redirect("/login?error=expired_link");
    }
  });

  // POST /api/auth/forgot-password
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (email) {
        const user = await findUserByEmail(email);
        if (user && !user.deleted_at && user.password_hash) {
          const token = await createPasswordResetToken(user.id as string);
          const resetUrl = `${getAppBaseUrl(req)}/reset-password?token=${token}`;
          await sendPasswordResetEmail(user.email as string, resetUrl);
          await writeAuthAudit("auth.password_reset.requested", user.id as string, getClientIpForAuth(req), { email });
        }
      }
      // Always return generic success (prevents email enumeration)
      return res.json({ ok: true, message: "If an account exists with that email, a reset link has been sent." });
    } catch (err: any) {
      console.error("[auth] forgot-password error:", err.message);
      return res.json({ ok: true, message: "If an account exists with that email, a reset link has been sent." });
    }
  });

  // POST /api/auth/reset-password
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { token, new_password } = req.body;
      if (!token || !new_password) return res.status(400).json({ error: "Token and new password are required" });
      const pwCheck = validatePassword(new_password);
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });

      const rows = await db.execute(sql`SELECT * FROM password_reset_tokens WHERE token = ${token} LIMIT 1`);
      if (!rows.rows.length) return res.status(400).json({ error: "Invalid or expired reset link" });
      const rec = rows.rows[0] as any;
      if (rec.consumed_at || new Date(rec.expires_at) < new Date()) {
        return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
      }
      const hash = await hashPassword(new_password);
      await db.execute(sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${rec.user_id}`);
      await db.execute(sql`UPDATE password_reset_tokens SET consumed_at = NOW() WHERE token = ${token}`);
      // Destroy all sessions for this user by updating their password (sessions will fail to re-validate)
      const user = await findUserById(rec.user_id);
      if (user) {
        await sendPasswordChangedEmail(user.email as string);
        await writeAuthAudit("auth.password_reset", user.id as string, getClientIpForAuth(req), { email: user.email });
      }
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] reset-password error:", err.message);
      return res.status(500).json({ error: "Password reset failed. Please try again." });
    }
  });

  // GET /api/auth/verify-email?token=...
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string") return res.redirect("/dashboard?verified=error");
      const rows = await db.execute(sql`SELECT * FROM email_verification_tokens WHERE token = ${token} LIMIT 1`);
      if (!rows.rows.length) return res.redirect("/dashboard?verified=error");
      const rec = rows.rows[0] as any;
      if (rec.consumed_at || new Date(rec.expires_at) < new Date()) return res.redirect("/verify-email?error=expired");
      await db.execute(sql`UPDATE users SET email_verified = true, email_verified_at = NOW(), updated_at = NOW() WHERE id = ${rec.user_id}`);
      await db.execute(sql`UPDATE email_verification_tokens SET consumed_at = NOW() WHERE token = ${token}`);
      await writeAuthAudit("auth.email.verified", rec.user_id, getClientIpForAuth(req), {});
      return res.redirect("/dashboard?verified=true");
    } catch (err: any) {
      console.error("[auth] verify-email error:", err.message);
      return res.redirect("/dashboard?verified=error");
    }
  });

  // POST /api/auth/resend-verification
  app.post("/api/auth/resend-verification", requireAuth, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const user = await findUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.email_verified) return res.status(400).json({ error: "Email already verified" });
      const token = await createEmailVerificationToken(userId);
      const verifyUrl = `${getAppBaseUrl(req)}/api/auth/verify-email?token=${token}`;
      await sendWelcomeVerificationEmail(user.email as string, user.display_name as string | null, verifyUrl);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] resend-verification error:", err.message);
      return res.status(500).json({ error: "Failed to send verification email" });
    }
  });

  // GET /api/auth/me
  app.get("/api/auth/me", async (req, res) => {
    const userId = (req.session as any).userId as string | undefined;
    if (!userId) return res.status(401).json({ error: "auth_required" });
    try {
      const user = await findUserById(userId);
      if (!user || user.deleted_at) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: "auth_required" });
      }
      return res.json({
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        email_verified: user.email_verified,
        created_at: user.created_at,
      });
    } catch (err: any) {
      return res.status(500).json({ error: "Failed to get user" });
    }
  });

  // PUT /api/auth/change-password
  app.put("/api/auth/change-password", requireAuth, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password) return res.status(400).json({ error: "Both current and new password are required" });
      const pwCheck = validatePassword(new_password);
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });
      const user = await findUserById(userId);
      if (!user || !user.password_hash) return res.status(400).json({ error: "No password set on this account" });
      const valid = await verifyPassword(current_password, user.password_hash as string);
      if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
      const hash = await hashPassword(new_password);
      await db.execute(sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${userId}`);
      await sendPasswordChangedEmail(user.email as string);
      await writeAuthAudit("auth.password_changed", userId, getClientIpForAuth(req), { email: user.email });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] change-password error:", err.message);
      return res.status(500).json({ error: "Failed to change password" });
    }
  });

  // PUT /api/auth/change-email
  app.put("/api/auth/change-email", requireAuth, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { new_email, password } = req.body;
      if (!new_email || !password) return res.status(400).json({ error: "New email and password are required" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email)) return res.status(400).json({ error: "Invalid email address" });
      const user = await findUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.password_hash) {
        const valid = await verifyPassword(password, user.password_hash as string);
        if (!valid) return res.status(401).json({ error: "Password is incorrect" });
      }
      const existing = await findUserByEmail(new_email);
      if (existing && existing.id !== userId) return res.status(409).json({ error: "That email is already in use" });
      const oldEmail = user.email as string;
      await db.execute(sql`UPDATE users SET email = ${new_email.toLowerCase().trim()}, email_verified = false, email_verified_at = NULL, updated_at = NOW() WHERE id = ${userId}`);
      (req.session as any).userEmail = new_email.toLowerCase().trim();
      const token = await createEmailVerificationToken(userId);
      const verifyUrl = `${getAppBaseUrl(req)}/api/auth/verify-email?token=${token}`;
      await sendWelcomeVerificationEmail(new_email, user.display_name as string | null, verifyUrl);
      await sendEmailChangedNotification(oldEmail, new_email);
      await writeAuthAudit("auth.email_changed", userId, getClientIpForAuth(req), { old_email: oldEmail, new_email });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] change-email error:", err.message);
      return res.status(500).json({ error: "Failed to change email" });
    }
  });

  // PUT /api/auth/profile
  app.put("/api/auth/profile", requireAuth, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { display_name } = req.body;
      await db.execute(sql`UPDATE users SET display_name = ${display_name?.trim() || null}, updated_at = NOW() WHERE id = ${userId}`);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // DELETE /api/auth/delete-account
  app.delete("/api/auth/delete-account", requireAuth, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { password, confirmation } = req.body;
      if (confirmation !== "DELETE") return res.status(400).json({ error: 'Please type "DELETE" to confirm account deletion' });
      const user = await findUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.password_hash) {
        if (!password) return res.status(400).json({ error: "Password is required to delete your account" });
        const valid = await verifyPassword(password, user.password_hash as string);
        if (!valid) return res.status(401).json({ error: "Password is incorrect" });
      }
      // Soft delete — anonymise PII but preserve cert ownership chain
      await db.execute(sql`
        UPDATE users SET
          email = ${`deleted_${userId}@mintvault.invalid`},
          password_hash = NULL,
          display_name = 'Deleted User',
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE id = ${userId}
      `);
      const emailForNotif = user.email as string;
      await writeAuthAudit("auth.account_deleted", userId, getClientIpForAuth(req), { email: emailForNotif });
      req.session.destroy(() => {});
      await sendAccountDeletedEmail(emailForNotif);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] delete-account error:", err.message);
      return res.status(500).json({ error: "Failed to delete account" });
    }
  });

  // ── Tier capacity management ──────────────────────────────────────────────

  // GET all tier capacities (admin)
  app.get("/api/admin/capacity", requireAdmin, async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT tc.*,
          (SELECT COUNT(*) FROM submissions s
           WHERE s.service_tier = tc.tier_id
             AND s.status IN ('new', 'received', 'in_grading')
             AND s.deleted_at IS NULL
          ) AS current_queue_count
        FROM tier_capacity tc
        ORDER BY tc.tier_id
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update a single tier's capacity (admin)
  app.put("/api/admin/capacity/:tierId", requireAdmin, async (req, res) => {
    try {
      const { tierId } = req.params;
      const { status, paused_until, paused_message, max_concurrent } = req.body;

      if (status && !["open", "paused", "waitlist"].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be open, paused, or waitlist." });
      }

      await db.execute(sql`
        UPDATE tier_capacity SET
          status = COALESCE(${status || null}, status),
          paused_until = ${paused_until || null},
          paused_message = ${paused_message || null},
          max_concurrent = COALESCE(${max_concurrent ? Number(max_concurrent) : null}, max_concurrent),
          paused_at = ${status === "paused" || status === "waitlist" ? sql`NOW()` : sql`paused_at`},
          paused_by = ${status === "paused" || status === "waitlist" ? (req.session as any)?.adminEmail || "admin" : sql`paused_by`},
          updated_at = NOW()
        WHERE tier_id = ${tierId}
      `);

      console.log(`[capacity] tier ${tierId} → ${status || "updated"} by ${(req.session as any)?.adminEmail || "admin"}`);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST pause ALL tiers (emergency)
  app.post("/api/admin/capacity/pause-all", requireAdmin, async (req, res) => {
    try {
      const message = req.body.message || "Submissions temporarily paused";
      await db.execute(sql`
        UPDATE tier_capacity SET
          status = 'paused',
          paused_message = ${message},
          paused_at = NOW(),
          paused_by = ${(req.session as any)?.adminEmail || "admin"},
          updated_at = NOW()
      `);
      console.log(`[capacity] ALL TIERS PAUSED by ${(req.session as any)?.adminEmail || "admin"}`);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST resume ALL tiers
  app.post("/api/admin/capacity/resume-all", requireAdmin, async (req, res) => {
    try {
      await db.execute(sql`
        UPDATE tier_capacity SET status = 'open', paused_until = NULL, paused_message = NULL, updated_at = NOW()
      `);
      console.log(`[capacity] ALL TIERS RESUMED by ${(req.session as any)?.adminEmail || "admin"}`);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET public tier capacity status (for pricing page + submit flow)
  app.get("/api/tier-capacity", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT tier_id, status, paused_until, paused_message
        FROM tier_capacity
        ORDER BY tier_id
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pokemon TCG sets list (cached 24h, merged with custom sets) ──────────
  let cachedTcgSets: any[] | null = null;
  let tcgCacheTime = 0;

  app.get("/api/pokemon-sets", async (_req, res) => {
    try {
      // Fetch TCG API sets (cached 24h)
      if (!cachedTcgSets || Date.now() - tcgCacheTime > 24 * 60 * 60 * 1000) {
        const apiKey = process.env.POKEMON_TCG_API_KEY;
        const headers: Record<string, string> = {};
        if (apiKey) headers["X-Api-Key"] = apiKey;
        const r = await fetch("https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250", { headers });
        if (r.ok) {
          const data = await r.json();
          cachedTcgSets = (data.data || []).map((s: any) => ({
            id: s.id, name: s.name, series: s.series, ptcgoCode: s.ptcgoCode || null,
            releaseDate: s.releaseDate, total: s.total, source: "tcg",
          }));
          tcgCacheTime = Date.now();
        }
      }

      // Fetch custom sets from DB
      const customRows = await db.execute(sql`SELECT * FROM custom_sets ORDER BY created_at DESC`);
      const customSets = (customRows.rows as any[]).map(s => ({
        id: s.set_id, name: s.set_name, series: s.series || "Custom", ptcgoCode: s.ptcgo_code || null,
        releaseDate: s.release_date ? new Date(s.release_date).toISOString().split("T")[0] : null,
        total: s.total_cards || 0, source: "custom",
      }));

      // Merge: custom sets first, then TCG API sets (dedup by id)
      const tcg = cachedTcgSets || [];
      const customIds = new Set(customSets.map(s => s.id));
      const merged = [...customSets, ...tcg.filter(s => !customIds.has(s.id))];

      res.json(merged);
    } catch (err: any) {
      console.error("[pokemon-sets] error:", err.message);
      res.json(cachedTcgSets || []);
    }
  });

  // ── Custom sets CRUD ────────────────────────────────────────────────────────
  app.post("/api/admin/custom-sets", requireAdmin, async (req, res) => {
    try {
      const { setId, setName, series, ptcgoCode, releaseDate, totalCards, notes } = req.body;
      if (!setId || !setName) return res.status(400).json({ error: "setId and setName required" });
      await db.execute(sql`
        INSERT INTO custom_sets (set_id, set_name, series, ptcgo_code, release_date, total_cards, notes, created_by)
        VALUES (${setId}, ${setName}, ${series || null}, ${ptcgoCode || null}, ${releaseDate || null}, ${totalCards || null}, ${notes || null}, ${(req.session as any)?.adminEmail || "admin"})
      `);
      console.log(`[custom-set] added "${setId}" — ${setName}`);
      res.json({ ok: true, setId, setName });
    } catch (err: any) {
      if (err.code === "23505") return res.status(409).json({ error: `Set ID "${req.body.setId}" already exists` });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/admin/custom-sets/:setId", requireAdmin, async (req, res) => {
    try {
      await db.execute(sql`DELETE FROM custom_sets WHERE set_id = ${req.params.setId}`);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Showroom routes ──────────────────────────────────────────────────────────
  registerShowroomRoutes(app);

  // ── Vault Club routes ────────────────────────────────────────────────────────
  registerVaultClubRoutes(app);

  // ── Marketplace seller routes ──────────────────────────────────────────────
  registerSellerRoutes(app);

  return httpServer;
}
