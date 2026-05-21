import type { Express, Request as ExpressRequest, Response as ExpressResponse, NextFunction as ExpressNextFunction } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { BUILD_STAMP, pricingTiers, calculateOrderTotals, getVaultClubDiscountPercent, gradeLabel, gradeLabelFull, isNonNumericGrade, SUBMISSION_STATUS_TRANSITIONS, SUBMISSION_STATUS_LABELS, serviceTierToPricingTier, auditLog } from "@shared/schema";
import type { PublicCertificate, ServiceTierRecord } from "@shared/schema";
import { storage, deductAiCredits } from "./storage";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { verifyAdminPassword, requireAdmin, isLoginRateLimited, isPinRateLimited, recordFailedLogin, recordFailedPin, clearLoginAttempts, clearPinAttempts, isPendingAdminValid, clearPendingAdmin, ADMIN_EMAIL, FAILED_LOGIN_DELAY_MS } from "./auth";
import { generateLabelPNG, generateLabelPDF, applyLabelOverrides } from "./labels";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { uploadToR2, getR2SignedUrl, deleteFromR2, headR2, r2KeyForImage, r2KeyForLabel } from "./r2";
import { generateClaimInsertPNG, generateClaimInsertPDF, generateClaimInsertSheet } from "./claim-insert";
import { db } from "./db";
import { sql, inArray } from "drizzle-orm";
import { sendSubmissionConfirmation, sendSubmissionConfirmationV2, sendCardsReceived, sendGradingComplete, sendShipped, sendSubmissionDelivered, sendClaimVerification, sendTransferOwnerConfirmation, sendTransferNewOwnerConfirmation, sendTransferV2OutgoingConfirmation, sendTransferV2IncomingConfirmation, sendTransferV2DisputeWindowStarted, sendTransferV2Completed, sendTransferV2Cancelled, sendTransferV2Disputed, sendTransferV2OwnerInvitedByBuyer, sendTransferV2BuyerInitOwnerConfirmed, sendTransferV2BuyerInitOwnerRejected, sendCertificatePdf, sendMagicLink, sendPinResetLink, sendStolenVerificationEmail } from "./email";
import { getOwnerChain } from "./ownership-service";
import { generateCertificateDocument } from "./certificate-document";
import { createMagicToken, verifyMagicToken, requireCustomer } from "./customer-auth";
import { identifyCard, identifyCardFromBuffer, verifyAndEnrichCardData, analyzeCard, identifyAndAnalyze, autoCropCard, analyzeCardFromBuffers, generateImageVariants, verifyPokemonCardWithTcgApi, resizeForClaude, normaliseCardName, type ImageKeys } from "./ai-grading-service";
import { anthropicFetch } from "./anthropic-fetch";
import { APP_BASE_URL } from "./app-url";
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
    gradeStrengthScore: c.gradeStrengthScore != null ? Number(c.gradeStrengthScore) : null,
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
    stolenStatus: c.stolenStatus || null,
  };
}

// v424 — record once-per-deploy that label artwork was resized + de-gradiented.
// Idempotent on the deterministic entity_id "label_artwork_v424".
async function recordLabelArtworkV424Audit() {
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
      SELECT
        'system',
        'label_artwork_v424',
        'label_artwork_updated',
        'mintvaultuk@gmail.com',
        ${JSON.stringify({
          changes: ["dimensions_72x22_to_70x20", "gradient_fade_removed_solid_colours_only"],
          reason: "physical_slab_cutout_70x20_and_readability_complaints",
          endpoints_affected: [
            "POST /api/admin/print-batch",
            "POST /api/admin/printing/generate-sheet",
            "GET /api/admin/certificates/:id/label/:side",
          ],
        })}::jsonb,
        NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log WHERE entity_id = 'label_artwork_v424'
      )
    `);
  } catch (err: any) {
    console.error("[v424-audit] insert failed:", err.message);
  }
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

  // ── Public-name toggle (per-user). Idempotent additive nullable→default false.
  // Distinct from ownership_history.public_name (per-event, dormant). Audit-log
  // the first run only — schema-presence check before insert keeps re-runs clean.
  try {
    const before = await db.execute(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'public_name' LIMIT 1
    `);
    const wasPresent = before.rows.length > 0;
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_name BOOLEAN NOT NULL DEFAULT false`);
    if (!wasPresent) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('schema', 'users', 'add_column_public_name', 'startup_migration',
          ${JSON.stringify({
            column: "public_name",
            type: "boolean",
            nullable: false,
            default: false,
            scope: "per-user",
            note: "Distinct from ownership_history.public_name (per-event); v1 ships per-user toggle.",
          })}::jsonb)
      `);
      console.log("[public-name-migrate] users.public_name added + audit logged");
    }
  } catch (e: any) { console.error("[public-name-migrate] failed:", e.message); }

  // ── Cold-archive timestamp + candidate index. Idempotent additive nullable.
  // Audit-log the first run only — information_schema gate prevents duplicate
  // audit rows on re-runs.
  try {
    const before = await db.execute(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'certificates' AND column_name = 'archived_to_b2_at' LIMIT 1
    `);
    const wasPresent = before.rows.length > 0;
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS archived_to_b2_at TIMESTAMP`);
    // Partial index — only rows still pending archival. Keeps the index small
    // (most prod certs will eventually have archived_to_b2_at IS NOT NULL).
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_certificates_archive_candidates
        ON certificates(grade_approved_at)
        WHERE archived_to_b2_at IS NULL AND deleted_at IS NULL
    `);
    if (!wasPresent) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('schema', 'certificates', 'add_column_archived_to_b2_at', 'startup_migration',
          ${JSON.stringify({
            column: "archived_to_b2_at",
            type: "timestamp",
            nullable: true,
            default: null,
            index: "idx_certificates_archive_candidates",
            index_predicate: "archived_to_b2_at IS NULL AND deleted_at IS NULL",
            age_signal: "grade_approved_at",
            note: "Phase 1 cold-archive marker; see server/workers/r2-to-b2-archival.ts.",
          })}::jsonb)
      `);
      console.log("[archival-b2-migrate] certificates.archived_to_b2_at + idx_certificates_archive_candidates added + audit logged");
    }
  } catch (e: any) { console.error("[archival-b2-migrate] failed:", e.message); }

  // ── Contact-form inbox table. Idempotent CREATE TABLE IF NOT EXISTS.
  // Audit-log the first run only via information_schema gate.
  try {
    const before = await db.execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'contact_inquiries' LIMIT 1
    `);
    const wasPresent = before.rows.length > 0;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contact_inquiries (
        id            SERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL,
        topic         TEXT NOT NULL,
        message       TEXT NOT NULL,
        submitted_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        email_sent_at TIMESTAMP,
        email_error   TEXT,
        ip_address    TEXT,
        user_agent    TEXT,
        deleted_at    TIMESTAMP
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_contact_inquiries_submitted_at
        ON contact_inquiries(submitted_at DESC)
        WHERE deleted_at IS NULL
    `);
    if (!wasPresent) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('schema', 'contact_inquiries', 'create_table_contact_inquiries', 'startup_migration',
          ${JSON.stringify({
            table: "contact_inquiries",
            purpose: "customer contact-form inbox; row written before Resend send so messages survive email failures",
            soft_delete: "deleted_at",
            index: "idx_contact_inquiries_submitted_at",
          })}::jsonb)
      `);
      console.log("[contact-inquiries-migrate] contact_inquiries table + index added + audit logged");
    }
  } catch (e: any) { console.error("[contact-inquiries-migrate] failed:", e.message); }

  // ── v525 — audit_log lookup index for print-batch idempotency checks +
  // operational reprint history queries. Additive, idempotent, safe on cold
  // start. The 5-minute idempotency window in /api/admin/print-batch scans
  // by entity_id + action; without this index the scan was a seq scan over
  // the full audit_log table.
  try {
    const before = await db.execute(sql`
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_log_entity_action' LIMIT 1
    `);
    const wasPresent = before.rows.length > 0;
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_audit_log_entity_action
        ON audit_log (entity_id, action, created_at DESC)
    `);
    if (!wasPresent) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('schema', 'audit_log', 'create_index_entity_action', 'startup_migration',
          ${JSON.stringify({
            index: "idx_audit_log_entity_action",
            columns: ["entity_id", "action", "created_at DESC"],
            purpose: "print_batch idempotency lookup + reprint history queries",
          })}::jsonb)
      `);
      console.log("[audit-log-index-migrate] idx_audit_log_entity_action created + audit logged");
    }
  } catch (e: any) { console.error("[audit-log-index-migrate] failed:", e.message); }

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
  recordLabelArtworkV424Audit().catch(() => {});
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

  // ── Health check — no auth, no DB, no shared state. First registered so
  // it answers even if downstream middleware throws. Used by deploy smoke
  // tests and by anything wanting a cheap liveness signal.
  app.get("/api/healthz", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // ── Public flags endpoint ──────────────────────────────────────────────────
  app.get("/api/config/public-flags", (_req, res) => {
    const { FEATURE_FLAGS } = require("./config/feature-flags");
    res.json({
      legalPagesLive: FEATURE_FLAGS.LEGAL_PAGES_LIVE,
      transferFlowLive: FEATURE_FLAGS.TRANSFER_FLOW_LIVE,
      publicNameToggleLive: FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE,
    });
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

  // ── v2 Founding-members waitlist (homepage CTA, replaces stats trio) ───────
  // Rate limit: 10 attempts per IP per hour. Idempotent insert — repeat
  // submissions of the same email return the same success message without
  // revealing whether the address was already on the list. Audit logged
  // only on first insert (entity_type='waitlist_signup').
  const waitlistRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts from this device. Please try again later." },
  });

  app.post("/api/v2/waitlist", waitlistRateLimit, async (req, res) => {
    try {
      const { email } = req.body as { email?: unknown };
      if (typeof email !== "string") {
        return res.status(400).json({ error: "Email is required." });
      }
      const trimmed = email.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!trimmed || trimmed.length > 254 || !emailRegex.test(trimmed)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        || req.socket.remoteAddress
        || null;
      const userAgent = (req.headers["user-agent"] as string | undefined) || null;

      // Atomic insert. The partial unique index on LOWER(email) WHERE
      // deleted_at IS NULL means duplicates are caught at the DB layer.
      // Treat unique-violation as "already on the list" → same success
      // response, no audit row, no enumeration leak.
      try {
        const inserted = await db.execute(sql`
          INSERT INTO waitlist_signups (email, source, ip_address, user_agent)
          VALUES (${trimmed}, 'homepage_founding_member', ${ip}, ${userAgent ? userAgent.slice(0, 500) : null})
          RETURNING id
        `);
        const newId = (inserted.rows[0] as any)?.id;
        if (newId != null) {
          await storage.writeAuditLog("waitlist_signup", String(newId), "created", null, {
            source: "homepage_founding_member",
            ip,
          });
        }
      } catch (insertErr: any) {
        // Postgres unique violation = "23505". Anything else is a real error.
        if (insertErr?.code !== "23505" && !/duplicate key/i.test(insertErr?.message || "")) {
          throw insertErr;
        }
        // Duplicate — refresh the existing row's created_at so admin queues
        // can sort by latest interest. Do not write a new audit log row;
        // the original one remains intact per spec.
        await db.execute(sql`
          UPDATE waitlist_signups
          SET created_at = NOW()
          WHERE LOWER(email) = LOWER(${trimmed}) AND deleted_at IS NULL
        `);
      }

      return res.json({ success: true, message: "You're on the list — we'll be in touch." });
    } catch (err: any) {
      console.error("[v2/waitlist] error:", err.message);
      return res.status(500).json({ error: "We couldn't add you right now. Please try again." });
    }
  });

  // ── Contact-form endpoint ─────────────────────────────────────────────────
  // Public POST. Validates with zod, writes to contact_inquiries BEFORE the
  // Resend send (so messages survive email failures), then attempts Resend
  // and records the outcome on the same row. Returns 200 even if Resend
  // throws — the message is in the DB, operator can read from there.
  const contactRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many contact-form submissions from this device. Please wait 15 minutes." },
  });

  const contactSchema = z.object({
    name: z.string().trim().min(1, "Name is required").max(100, "Name too long"),
    email: z.string().trim().email("Invalid email address").max(200, "Email too long"),
    topic: z.enum(["submission", "grading", "cert-vault", "ownership", "returns-shipping", "payment", "other"]),
    message: z.string().trim().min(10, "Message too short (min 10 characters)").max(5000, "Message too long (max 5000 characters)"),
  });

  app.post("/api/contact", contactRateLimit, async (req, res) => {
    try {
      const parsed = contactSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return res.status(400).json({
          error: firstIssue?.message || "Invalid submission",
          field: firstIssue?.path?.[0] ?? null,
        });
      }
      const { name, email, topic, message } = parsed.data;

      const ipAddress = ((req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()) || req.ip || "unknown";
      const userAgent = (req.headers["user-agent"] as string)?.slice(0, 500) || null;

      // Write BEFORE send so the message survives any Resend failure.
      const insertResult = await db.execute(sql`
        INSERT INTO contact_inquiries (name, email, topic, message, ip_address, user_agent)
        VALUES (${name}, ${email}, ${topic}, ${message}, ${ipAddress}, ${userAgent})
        RETURNING id
      `);
      const inquiryId = (insertResult.rows[0] as any)?.id as number;

      // Attempt the email. Don't fail the whole request on Resend errors —
      // the DB row already exists; operator can read from there or retry.
      const { sendContactInquiry } = await import("./email");
      try {
        await sendContactInquiry({
          name, email, topic, message,
          submittedAt: new Date(),
          inquiryId,
        });
        await db.execute(sql`
          UPDATE contact_inquiries SET email_sent_at = NOW() WHERE id = ${inquiryId}
        `);
        console.log(`[contact] inquiry ${inquiryId} sent to inbox (topic=${topic}, from=${email})`);
      } catch (sendErr: any) {
        const errMsg = (sendErr?.message || String(sendErr)).slice(0, 1000);
        console.error(`[contact] inquiry ${inquiryId} Resend send failed: ${errMsg}`);
        await db.execute(sql`
          UPDATE contact_inquiries SET email_error = ${errMsg} WHERE id = ${inquiryId}
        `);
      }

      return res.json({ ok: true, inquiryId });
    } catch (err: any) {
      console.error("[contact] route error:", err?.message || err);
      return res.status(500).json({ error: "Couldn't process your message. Please try again." });
    }
  });

  // ── MVGS compliance interest (public, rate-limited) ──────────────────────
  // POST /api/mvgs/interest — captures the /mvgs/join form. Append-only into
  // mvgs_interest table; no read endpoint, no public listing.
  const mvgsInterestRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submissions from this device. Please wait an hour." },
  });

  const mvgsInterestSchema = z.object({
    company: z.string().trim().min(1, "Company name is required").max(200, "Company name too long"),
    email:   z.string().trim().email("Invalid email address").max(254, "Email too long"),
    message: z.string().trim().max(2000, "Message too long").optional(),
  });

  app.post("/api/mvgs/interest", mvgsInterestRateLimit, async (req, res) => {
    try {
      const parsed = mvgsInterestSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return res.status(400).json({ error: firstIssue?.message || "Invalid submission" });
      }
      const { company, email, message } = parsed.data;
      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        || req.socket.remoteAddress
        || null;
      const { mvgsInterest } = await import("@shared/schema");
      await db.insert(mvgsInterest).values({
        company,
        email,
        message: message ?? null,
        ip,
      });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[mvgs-interest] error:", err?.message || err);
      return res.status(500).json({ error: "Couldn't record interest. Please try again." });
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
  app.get("/grading-standards",               (_req, res) => res.redirect(301, "/standard"));
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

  // Public AI pre-grade — 3/hour per IP. Each call invokes Claude Haiku
  // (paid). Tight cap is deliberate; expect VPN abuse to bypass over
  // time and add captcha / signed-token gating if it materialises.
  const preGradeRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, max: 3,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "AI pre-grade is limited to 3 requests per hour per IP. Try again later." },
  });

  // TIFF preview transcoding (/api/pre-grade/preview) — sharp resize +
  // JPEG encode only, no AI cost. Higher cap so users uploading scanner
  // TIFFs for front + back can preview both sides without spending
  // grading quota. Still capped to deter abuse of the public endpoint.
  const preGradePreviewRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many preview requests. Try again later." },
  });

  // Multer config for /api/pre-grade. In-memory storage (per spec — no
  // data stored on disk or R2), 20 MB per file, accepts JPEG/PNG/TIFF.
  const preGradeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 2 },
    fileFilter: (_req, file, cb) => {
      const ok = ["image/jpeg", "image/png", "image/tiff", "image/tif", "image/x-tiff"].includes(
        (file.mimetype || "").toLowerCase()
      );
      cb(null, ok);
    },
  });

  // POST /api/pre-grade — public AI pre-grade. No auth. Rate-limited.
  // Runs the uploaded front (+ optional back) through the standard
  // display pipeline (generateImageVariants → tightenForDisplay [which
  // includes whitewashEdgesBySaturation] → maskRoundedCorners) and
  // passes the cleaned buffers to gradeCardFromBuffer (Claude Haiku).
  // Returns the full AiGrading object including per-subgrade confidence.
  // Nothing is persisted — buffers stay in memory and are discarded.
  app.post(
    "/api/pre-grade",
    preGradeRateLimit,
    preGradeUpload.fields([
      { name: "front", maxCount: 1 },
      { name: "back",  maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as { front?: Express.Multer.File[]; back?: Express.Multer.File[] } | undefined;
        const frontFile = files?.front?.[0];
        const backFile = files?.back?.[0];
        if (!frontFile) {
          return res.status(400).json({ error: "Front image required (multipart field: 'front')." });
        }
        if (!backFile) {
          return res.status(400).json({ error: "Back image required (multipart field: 'back')." });
        }

        const { generateImageVariants, gradeCardFromBuffer } = await import("./ai-grading-service");
        const { tightenForDisplay, maskRoundedCorners } = await import("./image-processing");

        const processOne = async (buf: Buffer, side: "front" | "back"): Promise<Buffer> => {
          // generateImageVariants runs deskew → cropToYellowBorder|autoCrop
          // → reCentreBitmap, then exposes the post-recentre buffer as
          // centredUnpadded — exactly what tightenForDisplay expects.
          const variants = await generateImageVariants(buf);
          const centredUnpadded = (variants as any).centredUnpadded as Buffer;
          // tightenForDisplay runs detectCardEdgesByCoverage + the per-side
          // whitewashEdgesBySaturation internally.
          const tight = await tightenForDisplay(centredUnpadded, undefined, undefined, side);
          // Final rounded-corner mask matches the standard display output.
          return await maskRoundedCorners(tight);
        };

        console.log(`[pre-grade] processing front=${(frontFile.buffer.length / 1024).toFixed(0)}KB back=${(backFile.buffer.length / 1024).toFixed(0)}KB`);
        const [frontProcessed, backProcessed] = await Promise.all([
          processOne(frontFile.buffer, "front"),
          processOne(backFile.buffer, "back"),
        ]);

        const grading = await gradeCardFromBuffer(frontProcessed, backProcessed);
        if (!grading) {
          return res.status(503).json({
            error: "AI pre-grade is temporarily unavailable. Please try again later.",
          });
        }

        res.json({ success: true, grading });
      } catch (err: any) {
        console.error("[pre-grade] failed:", err.message);
        res.status(500).json({ error: err.message || "Pre-grade failed." });
      }
    }
  );

  // POST /api/pre-grade/preview — converts any sharp-readable image
  // (incl. TIFF) to a small JPEG preview for the client. In-memory only;
  // nothing persisted. Uses preGradePreviewRateLimit (20/hour/IP) so
  // previewing doesn't eat the user's 3/hour grading quota — sharp
  // resize + JPEG encode is cheap and ~10× preview headroom matches
  // realistic use (front + back × a few replacements).
  app.post(
    "/api/pre-grade/preview",
    preGradePreviewRateLimit,
    preGradeUpload.single("image"),
    async (req, res) => {
      try {
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: "Image required (multipart field: 'image')." });
        }
        const sharp = (await import("sharp")).default;
        const jpeg = await sharp(file.buffer)
          .rotate()
          .resize(800, undefined, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 70, progressive: true })
          .toBuffer();
        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "no-store");
        res.send(jpeg);
      } catch (err: any) {
        console.error("[pre-grade/preview] failed:", err.message);
        res.status(500).json({ error: err.message || "Preview generation failed." });
      }
    }
  );

  // Rate limit for unauthenticated public lookup endpoints — protects against
  // enumeration scrapers (cert IDs are sequential MV1, MV2, ...).
  // Applied to /api/cert/:id, /api/cert/:id/population, /api/logbook/:certId,
  // and (via parallel definition in server/showroom.ts) the showroom GETs.
  const lookupRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Limit: 60 per minute per IP." },
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

  app.get("/api/cert/:id", lookupRateLimit, async (req, res) => {
    const certId = String(req.params.id);
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

      // Public-name surfacing — gated three ways:
      //   1. PUBLIC_NAME_TOGGLE_LIVE flag must be true
      //   2. cert must have a current owner
      //   3. owner.public_name must be true AND owner.display_name non-empty
      // Any failure → field omitted entirely (NOT null) so client renders
      // the existing anonymous path. NEVER returns email, real name, or user ID.
      const { FEATURE_FLAGS } = await import("./config/feature-flags");
      let ownerDisplayName: string | undefined;
      if (FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE && (dbCert as any).currentOwnerUserId) {
        try {
          const ownerRow = await db.execute(sql`
            SELECT display_name, public_name FROM users
            WHERE id = ${(dbCert as any).currentOwnerUserId}
              AND deleted_at IS NULL
            LIMIT 1
          `);
          const owner = ownerRow.rows[0] as any;
          if (owner?.public_name === true) {
            const dn = typeof owner.display_name === "string" ? owner.display_name.trim() : "";
            if (dn.length > 0) ownerDisplayName = dn;
          }
        } catch (e: any) {
          // Graceful fallback if column missing or query fails — never block verify.
          console.warn(`[verify] owner display_name lookup skipped: ${e.message}`);
        }
      }

      const payload: Record<string, unknown> = {
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
        stolenStatus: (dbCert as any).stolenStatus || null,
        verifyUrl: `${APP_BASE_URL}/cert/${normalizeCertId(dbCert.certId)}`,
      };
      if (ownerDisplayName) payload.ownerDisplayName = ownerDisplayName;
      return res.json(payload);
    } catch (err: any) {
      console.error("[verify] error:", err.message);
      return res.status(500).json({ verified: false, error: "Internal error" });
    }
  });

  app.get("/api/featured-certificates", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT certificate_number AS cert_id, card_name, set_name,
               grade AS grade_overall, grade_type, card_game, front_image_path
        FROM certificates
        WHERE status = 'active'
          AND deleted_at IS NULL
          AND card_name IS NOT NULL
          AND grade IS NOT NULL
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

  app.get("/api/cert/:id/population", lookupRateLimit, async (req, res) => {
    try {
      const certId = String(req.params.id);
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
        marketingFeatureConsent,
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

      // Vault Club Silver discount (10%) vs bulk discount — apply max(vc, bulk).
      // Tie goes to VC (>= on the vc side) since it's a paid member perk.
      // Discount applies ONLY to the per-card grading fee, not shipping/insurance.
      let vcTier: string | null = null;
      let vcStatus: string | null = null;
      let vcPercent = 0;
      if (req.session?.userId) {
        const vcRows = await db.execute(sql`
          SELECT vault_club_tier, vault_club_status FROM users
          WHERE id = ${(req.session as any).userId} AND deleted_at IS NULL LIMIT 1
        `);
        if (vcRows.rows.length > 0) {
          const u = vcRows.rows[0] as any;
          vcTier = u.vault_club_tier ?? null;
          vcStatus = u.vault_club_status ?? null;
          vcPercent = getVaultClubDiscountPercent(vcTier, vcStatus);
        }
      }

      const bulkPercent = totals.discountPercent;
      const effectiveDiscountPercent = Math.max(vcPercent, bulkPercent);
      const effectiveDiscountAmount = Math.round(
        tierData.pricePerCard * quantity * effectiveDiscountPercent / 100
      );
      const discountType: string | null =
        vcPercent >= bulkPercent && vcPercent > 0 ? "vault_club_silver" :
        bulkPercent > 0 ? "bulk" :
        null;
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
        marketingFeatureConsent: marketingFeatureConsent === true,
        marketingFeatureConsentAt: marketingFeatureConsent === true ? new Date() : null,
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

      // Audit log for marketing-feature consent. Only on opt-in — default
      // (consent === false) doesn't write a row. Withdrawals are written
      // by the /api/account/submissions/:id/marketing-consent endpoint.
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

      // Audit log for applied discount (vault_club_silver or bulk). Records
      // both the applied side and the alternative so the max(vc, bulk)
      // decision is reconstructable later.
      if (discountType !== null) {
        try {
          await db.insert(auditLog).values({
            entityType: "submission",
            entityId: String(submission.id),
            action: discountType === "vault_club_silver"
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
              card_count: quantity,
              vc_alternative_percent: vcPercent,
              bulk_alternative_percent: bulkPercent,
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
          vcAlternativePercent: String(vcPercent),
          bulkAlternativePercent: String(bulkPercent),
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

      // LOCK-3: verify against the admin user's per-user bcrypt pin_hash,
      // not the legacy env-var ADMIN_PIN. If the admin has no pin_hash yet
      // (first time after PIN-auth deploy), surface PIN_SETUP_REQUIRED so
      // the frontend routes to /auth/pin/setup with admin context.
      const { verifyPin, checkLockout, registerFailure, resetFailures, logPinEvent, hashIp } = await import("./pin");
      const ipH = hashIp(req.ip || "unknown");

      const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
      if (!adminUser) {
        await new Promise(resolve => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (!(adminUser as any).pinHash) {
        // PIN not yet set — keep pendingAdmin flag in session, frontend
        // routes the admin to /auth/pin/setup which uses pendingAdmin
        // as the admin-context authorisation flag.
        return res.json({ step: "PIN_SETUP_REQUIRED" });
      }

      const lockState = await checkLockout(ADMIN_EMAIL);
      if (lockState.locked) {
        await logPinEvent(ADMIN_EMAIL, false, "locked", ipH);
        clearPendingAdmin(req);
        return res.status(423).json({ error: "Account locked. Try again later." });
      }

      const valid = await verifyPin(pin, (adminUser as any).pinHash);
      if (!valid) {
        const post = await registerFailure(ADMIN_EMAIL);
        await logPinEvent(ADMIN_EMAIL, false, post.locked ? "lockout_triggered" : "wrong_pin", ipH);
        recordFailedPin(req); // session-level counter retained for back-compat
        req.session.pinFailures = (req.session.pinFailures || 0) + 1;
        await new Promise(resolve => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));

        if (post.locked || req.session.pinFailures >= 5) {
          clearPendingAdmin(req);
          return res.status(401).json({ error: "Too many failed attempts, please start again" });
        }
        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearPinAttempts(req);
      await resetFailures(ADMIN_EMAIL);

      // Regenerate session on privilege escalation to admin.
      // Prevents pre-existing customer/account-holder fields from
      // surviving into the new admin session document (PR 3a).
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });

      req.session.userId = undefined as unknown as string;
      req.session.userEmail = undefined as unknown as string;
      req.session.customerEmail = undefined as unknown as string;
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
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_FULL_GRADE_ENABLED"))) {
        return res.status(503).json({ error: "AI legacy analyze is disabled" });
      }
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
          const { getR2Client } = await import("./r2");
          const s3 = getR2Client();
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

      const { centering, corners, edges, surface, overall, gradeType, grading_time_seconds } = req.body;

      const finalGradeType = gradeType || "numeric";
      const isNonNum = isNonNumericGrade(finalGradeType);
      const finalOverall = isNonNum ? null : parseFloat(overall);
      const computedLabel = (!isNonNum && finalOverall === 10) ? "black" : "Standard";

      // Cap at 1800s (30 min) so a grader leaving the tab open all day doesn't
      // skew the dashboard average. Anything over 30 min gets clamped — keeps
      // honest sessions intact while flattening coffee-break outliers.
      const rawTime = Number(grading_time_seconds);
      const clampedTime = Number.isFinite(rawTime) && rawTime > 0
        ? Math.min(1800, Math.round(rawTime))
        : null;

      // P0 preservation helper — see /grade handler for rationale.
      const num = (v: unknown): number | null => {
        if (v == null || v === "") return null;
        const n = typeof v === "number" ? v : parseFloat(String(v));
        return isNaN(n) ? null : n;
      };

      // ── MVGS scoring on approve ──────────────────────────────────────────
      // Cert state (defects, dark_border, eye_appeal_modifier, centering
      // ratios) was already saved by the grading-panel /grade PUT before
      // the operator hit Approve. Re-read the relevant columns and run the
      // pure scoring helper. Result lands in grade_strength_score.
      //
      // verified_defects gets the MVGS-classified pins from the `defects`
      // column when any are classified (any pin with mvgsCode+tier+zone);
      // otherwise falls through to the legacy auto-promote-from-ai-defects
      // behaviour so existing flows keep working.
      const { computeMvgsScore } = await import("./mvgs-scoring");
      const savedDefects: any[] = Array.isArray((cert as any).defects) ? (cert as any).defects : [];
      const mvgsPins = savedDefects
        .filter((d: any) => d?.mvgsCode && d?.tier && d?.zone)
        .map((d: any) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) }));
      let mvgsScore: number | null = null;
      if (!isNonNum) {
        const r = computeMvgsScore({
          centeringFrontLr: (cert as any).centeringFrontLr ?? null,
          centeringFrontTb: (cert as any).centeringFrontTb ?? null,
          centeringBackLr:  (cert as any).centeringBackLr ?? null,
          centeringBackTb:  (cert as any).centeringBackTb ?? null,
          defects: mvgsPins,
          darkBorder: !!(cert as any).darkBorder,
          eyeAppealModifier: Number((cert as any).eyeAppealModifier ?? 0) || 0,
        });
        mvgsScore = r.score;
      }
      const useMvgsClassifiedVerified = mvgsPins.length > 0;
      const mvgsVerifiedJson = useMvgsClassifiedVerified ? JSON.stringify(savedDefects) : null;

      await db.execute(sql`
        UPDATE certificates SET
          grade_type        = ${finalGradeType},
          grade             = ${isNonNum ? null : finalOverall},
          centering_score   = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(centering)}::numeric, centering_score)`},
          corners_score     = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(corners)}::numeric,   corners_score)`},
          edges_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(edges)}::numeric,     edges_score)`},
          surface_score     = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(surface)}::numeric,   surface_score)`},
          label_type        = ${computedLabel},
          grade_approved_by = ${"Cornelius Oliver"},
          grade_approved_at = NOW(),
          status            = 'active',
          grade_strength_score = ${isNonNum ? sql`grade_strength_score` : sql`${mvgsScore}::int`},
          verified_defects  = ${
            useMvgsClassifiedVerified
              ? sql`${mvgsVerifiedJson}::jsonb`
              : sql`CASE
                  WHEN verified_defects IS NULL OR verified_defects = '[]'::jsonb
                  THEN COALESCE(ai_defects, '[]'::jsonb)
                  ELSE verified_defects
                END`
          },
          grading_time_seconds = COALESCE(${clampedTime}::int, grading_time_seconds),
          updated_at        = NOW()
        WHERE id = ${id}
      `);

      await storage.writeAuditLog("certificate", cert.certId, "approve_grade", req.session.adminEmail || "admin", {
        centering, corners, edges, surface, overall, gradeType, labelType: computedLabel,
        grading_time_seconds: clampedTime,
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
            AND status = 'active' AND deleted_at IS NULL AND grade IS NOT NULL
        `);
        const grades: number[] = (popRows.rows || []).map((r: any) => parseFloat(r.grade)).filter((g: number) => !isNaN(g));
        const totalGraded = grades.length;
        const sameGradeCount = grades.filter(g => g === gradeNum).length;
        const higherGradeCount = grades.filter(g => g > gradeNum).length;
        const percentile = totalGraded > 0 ? Math.round(((totalGraded - higherGradeCount) / totalGraded) * 100) : 0;
        population = { totalGraded, sameGradeCount, higherGradeCount, percentile };
      } catch { /* non-critical */ }

      // v417 — sanitise free-text descriptions on the way out (defence-in-depth
      // against admin paste-of-PII into a public-surface field).
      const { stripEmailsFromText: stripEmailsR } = await import("./lib/sanitise-pii");
      const defects = (c.defects || []).map((d: any) => ({
        id: d.id,
        type: d.type,
        severity: d.severity,
        description: stripEmailsR(d.description),
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
          // v417 — public surface shows brand only; real grader name stays
          // in the DB and admin endpoints.
          gradedBy: "MintVault UK",
          status: c.status || "active",
        },
        grade: {
          overall: isNonNum ? (gradeType === "authentic_altered" ? "AA" : "NO") : gradeNum,
          label: isNonNum ? gradeLabelFull(gradeType, "0") : gradeLabel(gradeNum),
          labelType,
          isBlackLabel: isBlack,
          explanation: stripEmailsR(c.gradeExplanation || ai.grade_explanation || ""),
          // v417 — drop approver name from public report; date is fine.
          approvedBy: null,
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
          // v417 — auth notes are free-text; sanitise on public surface.
          notes:  stripEmailsR(c.authNotes || ai.authentication_notes || "") || null,
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
        // v417 — public DGR PDF: brand only, no individual grader name.
        .text(`Graded: ${gradedDateFmt}  ·  By: MintVault UK`);
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
          const { GetObjectCommand } = await import("@aws-sdk/client-s3");
          const { getR2Client } = await import("./r2");
          const s3 = getR2Client();
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
        .text(`Graded by MintVault UK · Kent · mintvaultuk.com`, 50, doc.page.height - 60, { align: "center" })
        .text(`Verify at mintvaultuk.com/cert/${certId}/report`, 50, doc.page.height - 50, { align: "center" })
        .text(`© 2026 MintVault UK — This report is permanent and cannot be altered.`, 50, doc.page.height - 40, { align: "center" });

      doc.end();
    } catch (error: any) {
      console.error("[report/pdf] error:", error.message, error.stack);
      if (!res.headersSent) res.status(500).json({ error: `PDF generation failed: ${error.message}` });
    }
  });

  // ── Logbook endpoints ──────────────────────────────────────────────────────

  app.get("/api/logbook/:certId", lookupRateLimit, async (req, res) => {
    try {
      const { buildLogbookData, toPublicPayload } = await import("./logbook-service");
      const data = await buildLogbookData(String(req.params.certId));
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
      const cacheKey = `logbooks/v2/${certId}.pdf`;

      // ── Cert lookup FIRST ────────────────────────────────────────────────
      // Cache must NEVER be served for hard/soft-deleted certs, even if a
      // stale R2 object still exists (the MV1 reset bug). If the cert isn't
      // findable, 404 immediately.
      const dbCert = await findCertByIdFlex(certId);
      if (!dbCert || dbCert.status === "voided") {
        return res.status(404).json({ error: "Certificate not found" });
      }
      const certUpdatedAt = (dbCert as any).updatedAt instanceof Date
        ? (dbCert as any).updatedAt
        : new Date((dbCert as any).updatedAt || 0);

      // ── Cache read with auto-stale-check ─────────────────────────────────
      // Serve cached PDF only if cache exists AND cert hasn't been updated
      // since the cache was written. Any failure (head error, missing object,
      // stale comparison) falls through to regenerate.
      if (!forceRegenerate) {
        const cachedHead = await headR2(cacheKey);
        const cacheIsFresh = !!cachedHead && certUpdatedAt <= cachedHead.lastModified;
        console.log(`[logbook-cache] cert=${certId} certUpdated=${certUpdatedAt.toISOString()} cacheLastMod=${cachedHead?.lastModified.toISOString() || "none"} action=${cacheIsFresh ? "serve-cache" : "regenerate"}`);
        if (cacheIsFresh) {
          try {
            const cachedUrl = await getR2SignedUrl(cacheKey, 300);
            const cached = await fetch(cachedUrl);
            if (cached.ok) {
              const buf = Buffer.from(await cached.arrayBuffer());
              res.setHeader("Content-Type", "application/pdf");
              res.setHeader("Content-Disposition", `inline; filename="MintVault-Logbook-${certId}.pdf"`);
              return res.send(buf);
            }
          } catch {} // signed-url fetch failed → fall through to regenerate
        }
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
      const cacheKey = `logbooks/v2/${certId}.pdf`;
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
      // v417 — viewer gate: matches the pattern used by certToPublic. Only the
      // verified current owner sees owner-scoped fields like nfcUid; everyone
      // else gets null.
      const viewerUserId = (req.session as any)?.userId as string | undefined;
      const viewerIsOwner = !!(viewerUserId && c.currentOwnerUserId && viewerUserId === c.currentOwnerUserId);
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
            AND status = 'active' AND deleted_at IS NULL AND grade IS NOT NULL AND grade_type = 'numeric'
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

      // Ownership history — v417 PII fix.
      // Replaces the prior `h.ownerName || h.toEmail || "Anonymous Owner"`
      // fallback (which leaked raw to_email when no display name was set)
      // with the GDPR-correct `getOwnerChain` redactor + numbered labels.
      // No display names or emails are ever surfaced here, even for owners
      // who opted into `public_name` — until a proper consent UX ships,
      // we keep the door closed entirely. Method labels normalise to
      // "Original Issuance" or "Verified Transfer" so we don't imply that
      // email is part of the public-facing attestation chain.
      let ownership: Array<{ owner: string; date: string; method: string; verified: boolean }> = [];
      try {
        const { getOwnerChain } = await import("./ownership-service");
        const chain = await getOwnerChain(certId);
        ownership = chain.map(entry => ({
          owner: `Verified Owner #${entry.ownerNumber}`,
          date: entry.claimedAt ? entry.claimedAt.split("T")[0] : "",
          method: (entry.claimMethod === "initial_claim" || entry.claimMethod === "auto_submission")
            ? "Original Issuance"
            : "Verified Transfer",
          verified: true,
        }));
      } catch { /* non-critical — empty array on failure, never falls back to raw history */ }

      // Verified defects — prefer verifiedDefects column, fallback to defects column.
      // v417 — sanitise free-text descriptions on the way out (admin paste-of-PII
      // defence-in-depth). Admin endpoints get the original text; only public
      // surfaces redact.
      const { stripEmailsFromText } = await import("./lib/sanitise-pii");
      const rawDefects = (c.verifiedDefects?.length ? c.verifiedDefects : c.defects) || [];
      const defects = rawDefects.map((d: any, i: number) => ({
        id: i + 1,
        type: d.type,
        severity: d.severity,
        x: d.x ?? d.position?.x_percent ?? 50,
        y: d.y ?? d.position?.y_percent ?? 50,
        description: stripEmailsFromText(d.description),
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
          // v417 — nfcUid is owner-scoped; non-owners get null. The chip's
          // hardware ID enables physical-scan correlation tracking, so it
          // shouldn't be public.
          nfcUid: viewerIsOwner ? (c.nfcUid || null) : null,
          qrVerified: true,
          certId,
          slabSerial: c.slabSerial || null,
          tamperSealIntact: true,
        },
        gradedAt: c.createdAt || null,
        // v417 — grader's actual identity stays internal. Public surfaces show
        // the brand name. The real `gradeApprovedBy` is preserved in the DB
        // and visible to admins via /api/admin/certificates/:id/grading.
        gradedBy: "MintVault UK",
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

  // POST /api/stolen/report — only the current registered keeper can flag
  // their own cert. Reporter email must match cert.ownerEmail; the verify
  // link sent to that address closes the loop on email-control proof.
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

      // Ownership gate — unclaimed certs have no keeper to authenticate.
      if ((cert as any).ownershipStatus !== "claimed" || !(cert as any).ownerEmail) {
        return res.status(403).json({ error: "This certificate has no registered keeper on file. Contact support@mintvaultuk.com." });
      }
      const reporterLc = String(reporterEmail).toLowerCase().trim();
      if (String((cert as any).ownerEmail).toLowerCase().trim() !== reporterLc) {
        return res.status(403).json({ error: "Only the current registered keeper can report a certificate as stolen." });
      }

      const token = crypto.randomBytes(32).toString("hex");
      const inserted = await db.execute(sql`
        INSERT INTO stolen_reports (cert_id, reporter_name, reporter_email, description, verify_token)
        VALUES (${normalCertId}, ${String(reporterName).slice(0, 200)}, ${reporterLc}, ${description ? String(description).slice(0, 1000) : null}, ${token})
        RETURNING id
      `);
      const reportId = (inserted.rows[0] as any)?.id ?? null;

      await storage.writeAuditLog("certificate", normalCertId, "stolen_reported", reporterLc, {
        reporterName: String(reporterName).slice(0, 200),
        description: description ? String(description).slice(0, 1000) : null,
        reportId,
      });

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

  // GET /api/stolen/verify/:token — link clicked in email; marks report
  // verified, flags cert. Tokens expire 24h after creation (matches email
  // copy). JS-side TTL check on row.created_at avoids a second query.
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
      const createdAtMs = new Date(report.created_at).getTime();
      if (Date.now() - createdAtMs > 24 * 60 * 60 * 1000) {
        return res.redirect("/stolen-card-protection?verified=expired");
      }
      await db.execute(sql`
        UPDATE stolen_reports SET verified_at = NOW() WHERE verify_token = ${token}
      `);
      await db.execute(sql`
        UPDATE certificates SET stolen_status = 'reported_stolen', stolen_reported_at = NOW()
        WHERE certificate_number = ${report.cert_id}
      `);
      await storage.writeAuditLog("certificate", report.cert_id, "stolen_verified", report.reporter_email || null, {
        reportId: report.id,
        verifyToken: token,
      });
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
      const adminEmail = req.session.adminEmail || "admin";
      await db.execute(sql`
        UPDATE certificates SET stolen_status = NULL, stolen_reported_at = NULL
        WHERE certificate_number = ${normalCertId}
      `);
      const cleared = await db.execute(sql`
        UPDATE stolen_reports SET cleared_at = NOW(), cleared_by = ${adminEmail}
        WHERE cert_id = ${normalCertId} AND cleared_at IS NULL
      `);
      await storage.writeAuditLog("certificate", normalCertId, "stolen_cleared", adminEmail, {
        clearedBy: adminEmail,
        reportCount: (cleared as any).rowCount ?? null,
      });
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

  // v525 — legacy /generate-sheet and /generate-cut-sheet routes removed.
  // The two-column "front + NFC back" layout they produced was wrong (the
  // NFC back was redundant with the QR on the front and the QR on the
  // claim insert). All sheet-printing now flows through /api/admin/print-batch
  // which emits PDF + SVG + PNG in one call with the correct
  // front + claim-insert layout. label-sheet.ts is deleted.

  // v525 — single-sheet print-and-cut batch. Up to 4 cards per A4 sheet,
  // front label + claim insert per row. Returns THREE files in one call:
  //
  //   - PDF (A4 210×297mm)             home-printer fallback / archive
  //   - SVG cut paths (#FF00FF on <g id="cut">)   ScanNCut Direct Cut / Cricut
  //   - PNG composite (210×279.4mm @ 300DPI, 2480×3300px)   Cricut Print Then Cut
  //
  // Three filenames share a deterministic batchId so the operator can
  // pair the files at the printer.
  //
  // Idempotency: batchId is derived from sha256(sortedCertIds + admin + UTC date).
  // If audit_log already has a print_batch_generated entry with the same
  // batch_id within the last 5 minutes, the audit_log + labelPrints inserts
  // are SKIPPED but the artifacts are regenerated (same input → same bytes).
  // Saves prod surprise on fat-fingered double-clicks.
  //
  // Dual-write: every batch also writes one row per cert to labelPrints
  // (sheetRef = batchId). This keeps the existing sheet-history UI in
  // admin-printing.tsx working without code changes there. labelPrints is
  // for operational "have I printed this yet" checks; audit_log is the
  // compliance source of truth. Both writes are best-effort: failure here
  // must not stop the operator from getting the artifacts.
  app.post("/api/admin/print-batch", requireAdmin, async (req, res) => {
    try {
      const { certIds } = req.body as { certIds: unknown };
      if (!Array.isArray(certIds) || certIds.length === 0) {
        return res.status(400).json({ error: "Provide certIds array with at least 1 entry" });
      }
      const {
        MAX_CERTS_PER_BATCH,
        SHEET_LAYOUT_VERSION,
        generatePrintBatchPDF,
        generatePrintBatchCutSVG,
        generatePrintBatchPNG,
        deriveBatchId,
      } = await import("./print-batch");
      if (certIds.length > MAX_CERTS_PER_BATCH) {
        return res.status(400).json({ error: `Maximum ${MAX_CERTS_PER_BATCH} certs per batch` });
      }
      const ids = certIds.map(String);

      // Resolve each cert. Reject claimed certs at this endpoint (security
      // boundary kept intact — admins can still reprint claimed certs via
      // /api/admin/print-batch/reprint with a recorded reason).
      const allCerts = await storage.listCertificates();
      const items: { cert: any; claimCode: string }[] = [];
      const missing: string[] = [];
      const claimed: string[] = [];
      const mintedFor: string[] = [];
      for (const id of ids) {
        const cert = allCerts.find((c: any) => c.certId === id);
        if (!cert) { missing.push(id); continue; }
        if ((cert as any).ownershipStatus !== "unclaimed") { claimed.push(id); continue; }
        let code: string | undefined = (cert as any).claimCode || (cert as any).claim_code;
        if (!code) {
          code = await storage.getOrGenerateClaimCode(id);
          mintedFor.push(id);
        }
        items.push({ cert, claimCode: String(code) });
      }
      if (missing.length) return res.status(404).json({ error: `Certs not found: ${missing.join(", ")}` });
      if (claimed.length) return res.status(409).json({
        error: `Only unclaimed certs can be batched (claimed: ${claimed.join(", ")}). Use /api/admin/print-batch/reprint for claimed certs.`,
        claimedCertIds: claimed,
        code: "CLAIMED_CERTS_PRESENT",
      });

      const adminUser = (req.session as any)?.adminEmail || "admin";
      const batchId = deriveBatchId(ids, adminUser);
      const generatedAt = new Date().toISOString();

      // Idempotency check — same batchId from same admin within 5 minutes?
      let isRecentDuplicate = false;
      try {
        const recent = await db.execute(sql`
          SELECT 1 FROM audit_log
          WHERE entity_id = ${`print_batch_${batchId}`}
            AND action = 'print_batch_generated'
            AND created_at > NOW() - INTERVAL '5 minutes'
          LIMIT 1
        `);
        isRecentDuplicate = recent.rows.length > 0;
      } catch (e: any) {
        console.warn("[print-batch] idempotency check failed (continuing):", e.message);
      }

      const [pdfBuf, svgStr, pngBuf] = await Promise.all([
        generatePrintBatchPDF(items),
        Promise.resolve(generatePrintBatchCutSVG(items.length)),
        generatePrintBatchPNG(items),
      ]);

      if (!isRecentDuplicate) {
        // Audit row — one per batch generated.
        try {
          await db.execute(sql`
            INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
            VALUES (
              'system',
              ${`print_batch_${batchId}`},
              'print_batch_generated',
              ${adminUser},
              ${JSON.stringify({
                batch_id: batchId,
                cert_ids: ids,
                cert_count: items.length,
                pdf_size_bytes: pdfBuf.length,
                svg_size_bytes: Buffer.byteLength(svgStr, "utf8"),
                png_size_bytes: pngBuf.length,
                auto_generated_codes_for: mintedFor,
                sheet_layout_version: SHEET_LAYOUT_VERSION,
                layout: "front_plus_insert",
              })}::jsonb,
              NOW()
            )
          `);
        } catch (auditErr: any) {
          console.warn("[print-batch] audit_log insert failed:", auditErr.message);
        }

        // Dual-write: labelPrints row per cert. Keeps the operational sheet
        // history UI working without it having to query audit_log.
        try {
          await storage.queueForPrinting(ids, `print_batch_${batchId}`);
        } catch (qErr: any) {
          console.warn("[print-batch] queueForPrinting failed:", qErr.message);
        }

        if (mintedFor.length > 0) {
          try {
            await db.execute(sql`
              INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
              VALUES (
                'system',
                ${`print_batch_autocode_${batchId}`},
                'claim_codes_auto_generated',
                ${adminUser},
                ${JSON.stringify({
                  batch_id: batchId,
                  cert_ids: mintedFor,
                  count: mintedFor.length,
                  reason: "missing_at_print_batch_request",
                })}::jsonb,
                NOW()
              )
            `);
          } catch (auditErr: any) {
            console.warn("[print-batch] auto-code audit_log insert failed:", auditErr.message);
          }
        }
      } else {
        console.log(`[print-batch] idempotent return for batch ${batchId} (recent duplicate within 5min)`);
      }

      res.json({
        pdf: pdfBuf.toString("base64"),
        svg: Buffer.from(svgStr, "utf8").toString("base64"),
        png: pngBuf.toString("base64"),
        batchId,
        certIds: ids,
        mintedFor,
        generatedAt,
        isRecentDuplicate,
        sheetLayoutVersion: SHEET_LAYOUT_VERSION,
      });
    } catch (err: any) {
      console.error("[print-batch] error:", err.message);
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

  // v525 — admin-only reprint endpoint for CLAIMED certs (damaged in post,
  // lost, bad cut). Admin must supply a reason which is written to audit_log
  // per cert. The customer-facing path at /api/admin/print-batch still
  // rejects claimed certs (security boundary intact — that prevents the
  // operational endpoint from being used to silently re-emit claim codes).
  //
  // Schema:
  //   POST { certIds: string[], reason: string (10-500 chars after trim) }
  //   Returns same envelope as /api/admin/print-batch (pdf/svg/png/batchId)
  //
  // Audit: one row per cert, action='reprint', details includes reason,
  // batch_id. Plus the standard print_batch_generated row.
  const reprintReasonSchema = z.object({
    certIds: z.array(z.string().min(1)).min(1).max(8),
    reason: z.string().trim().min(10).max(500),
  });
  app.post("/api/admin/print-batch/reprint", requireAdmin, async (req, res) => {
    try {
      const parsed = reprintReasonSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request: certIds (1-8 entries) and reason (10-500 chars) required",
          detail: parsed.error.flatten(),
        });
      }
      const { certIds, reason } = parsed.data;
      const {
        MAX_CERTS_PER_BATCH,
        SHEET_LAYOUT_VERSION,
        generatePrintBatchPDF,
        generatePrintBatchCutSVG,
        generatePrintBatchPNG,
        deriveBatchId,
      } = await import("./print-batch");
      if (certIds.length > MAX_CERTS_PER_BATCH) {
        return res.status(400).json({ error: `Maximum ${MAX_CERTS_PER_BATCH} certs per batch` });
      }
      const ids = certIds.map(String);

      // Resolve certs. Skip the "unclaimed only" check — that's the whole
      // point of this endpoint. Still reject not-found / soft-deleted /
      // missing-grade so the layout doesn't draw garbage.
      const allCerts = await storage.listCertificates();
      const items: { cert: any; claimCode: string }[] = [];
      const missing: string[] = [];
      const mintedFor: string[] = [];
      for (const id of ids) {
        const cert = allCerts.find((c: any) => c.certId === id);
        if (!cert) { missing.push(id); continue; }
        let code: string | undefined = (cert as any).claimCode || (cert as any).claim_code;
        if (!code) {
          // A claimed cert without a claim code shouldn't normally exist
          // (claim required a code in the first place) but we mint defensively
          // so the insert renders something rather than throwing.
          code = await storage.getOrGenerateClaimCode(id);
          mintedFor.push(id);
        }
        items.push({ cert, claimCode: String(code) });
      }
      if (missing.length) return res.status(404).json({ error: `Certs not found: ${missing.join(", ")}` });

      const adminUser = (req.session as any)?.adminEmail || "admin";
      const batchId = deriveBatchId(ids, `${adminUser}|reprint`);
      const generatedAt = new Date().toISOString();

      // Reprint endpoint is NOT idempotent on the audit trail — every
      // reprint of a claimed cert must produce a fresh audit_log entry
      // with the reason. Generating duplicates if an admin double-clicks
      // is a feature here: each click is a deliberate operational decision.
      // We still derive batchId from inputs so the operator can match
      // filenames at the printer.

      const [pdfBuf, svgStr, pngBuf] = await Promise.all([
        generatePrintBatchPDF(items),
        Promise.resolve(generatePrintBatchCutSVG(items.length)),
        generatePrintBatchPNG(items),
      ]);

      // One audit_log row per cert. Best-effort: failure here is logged
      // but does not block the operator from getting the artifacts —
      // recovery is a manual SQL insert if needed, the operator has the
      // batch_id from the response.
      const auditRows: { certId: string; ok: boolean }[] = [];
      for (const it of items) {
        const certId = (it.cert as any).certId as string;
        try {
          await db.execute(sql`
            INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
            VALUES (
              'cert',
              ${certId},
              'reprint',
              ${adminUser},
              ${JSON.stringify({
                reason,
                batch_id: batchId,
                original_batch_id: null,
                new_batch_id: `print_batch_${batchId}`,
                cert_count: items.length,
                sheet_layout_version: SHEET_LAYOUT_VERSION,
              })}::jsonb,
              NOW()
            )
          `);
          auditRows.push({ certId, ok: true });
        } catch (e: any) {
          console.warn(`[reprint] audit_log failed for ${certId}:`, e.message);
          auditRows.push({ certId, ok: false });
        }
      }

      // Standard print_batch_generated row + labelPrints dual-write so
      // history UI surfaces the reprint sheet the same as a regular batch.
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
          VALUES (
            'system',
            ${`print_batch_${batchId}`},
            'print_batch_generated',
            ${adminUser},
            ${JSON.stringify({
              batch_id: batchId,
              cert_ids: ids,
              cert_count: items.length,
              pdf_size_bytes: pdfBuf.length,
              svg_size_bytes: Buffer.byteLength(svgStr, "utf8"),
              png_size_bytes: pngBuf.length,
              auto_generated_codes_for: mintedFor,
              sheet_layout_version: SHEET_LAYOUT_VERSION,
              layout: "front_plus_insert",
              source: "reprint",
              reason,
            })}::jsonb,
            NOW()
          )
        `);
      } catch (auditErr: any) {
        console.warn("[reprint] print_batch_generated audit_log failed:", auditErr.message);
      }
      try {
        await storage.queueForPrinting(ids, `print_batch_${batchId}`);
      } catch (qErr: any) {
        console.warn("[reprint] queueForPrinting failed:", qErr.message);
      }

      res.json({
        pdf: pdfBuf.toString("base64"),
        svg: Buffer.from(svgStr, "utf8").toString("base64"),
        png: pngBuf.toString("base64"),
        batchId,
        certIds: ids,
        mintedFor,
        generatedAt,
        sheetLayoutVersion: SHEET_LAYOUT_VERSION,
        auditRows,
      });
    } catch (err: any) {
      console.error("[reprint] error:", err.message);
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

  // v525 — /api/admin/printing/reprint/:certId removed. Single-cert reprint
  // now flows through /api/admin/print-batch with a 1-element certIds array,
  // producing the same PDF+SVG+PNG as a multi-cert batch but with a 1-row
  // layout. For claimed certs, the operator routes through
  // /api/admin/print-batch/reprint with a reason (recorded to audit_log).

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
      if (!cert) {
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
      if ((cert as any).stolenStatus === "reported_stolen") {
        return res.status(403).json({
          error: "This certificate has been reported stolen and cannot be transferred. Contact support@mintvaultuk.com to verify."
        });
      }
      if (cert.ownershipStatus === "claimed") {
        // v435 — surface a machine-readable code so the client can offer
        // the buyer-init transfer path when TRANSFER_FLOW_LIVE is true.
        return res.status(400).json({
          error: "This certificate has already been registered to an owner. If you are the new owner with the printed claim insert, you can request a transfer.",
          code: "ALREADY_CLAIMED",
          buyerInitPath: "/transfer/claim-by-code",
        });
      }
      if (cert.ownershipStatus === "transfer_pending") {
        return res.status(400).json({
          error: "A transfer is already in progress for this certificate. Please wait for it to complete or be resolved.",
          code: "TRANSFER_IN_PROGRESS",
        });
      }

      // ── SECOND FACTOR: validate claim code ──────────────────────────────────
      const codeValid = await storage.validateClaimCode(normalizedId, claimCode.trim());
      if (!codeValid) {
        console.warn(`[claim] Failed claim code attempt for cert ${normalizedId} from IP ${req.ip}`);
        return res.status(400).json({ error: "Invalid certificate number or claim code. Please check your details and try again." });
      }

      const token = await storage.createClaimVerification(normalizedId, email.trim(), name?.trim() || undefined, declaredNew === true);

      const baseUrl = APP_BASE_URL;
      const verifyUrl = `${baseUrl}/api/claim/verify?token=${token}`;

      // Surface email-send failures explicitly. Pre-fix the helper swallowed
      // every Resend error and the route returned success regardless ("lying
      // green banner"). Now the helper re-throws and we return a 500 with a
      // user-actionable message.
      try {
        await sendClaimVerification({ email: email.trim(), certId: normalizedId, verifyUrl });
      } catch (sendErr: any) {
        console.error("[claim] sendClaimVerification failed:", sendErr.message);
        return res.status(500).json({
          success: false,
          error: "Could not send verification email. Please try again or contact support@mintvaultuk.com.",
        });
      }

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
      const baseUrl = APP_BASE_URL;
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

      const baseUrl = APP_BASE_URL;
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
  // v435 — public transfer endpoints are gated by TRANSFER_FLOW_LIVE. When
  // false (default), they return 503. Admin endpoints are NOT gated so we
  // can inspect/resolve regardless of the public switch.
  const requireTransferFlowLive = (_req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => {
    const { FEATURE_FLAGS } = require("./config/feature-flags");
    if (!FEATURE_FLAGS.TRANSFER_FLOW_LIVE) {
      return res.status(503).json({ error: "Transfer flow not yet available — coming soon." });
    }
    next();
  };

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
  app.post("/api/v2/transfers/initiate", requireTransferFlowLive, transferV2RateLimit, async (req, res) => {
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
      if ((cert as any).stolenStatus === "reported_stolen") {
        return res.status(403).json({
          error: "This certificate has been reported stolen and cannot be transferred. Contact support@mintvaultuk.com to verify."
        });
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

      const baseUrl = APP_BASE_URL;
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
  app.get("/api/v2/transfers/outgoing-confirm", requireTransferFlowLive, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2");

      const result = await storage.confirmOutgoingKeeperV2(token);
      if (!result.success || !result.newOwnerToken) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2`);
      }

      const baseUrl = APP_BASE_URL;
      const incomingConfirmUrl = `${baseUrl}/transfer/accept?token=${result.newOwnerToken}&v=2`;

      // Compute former-keeper count for DVLA-parity on the incoming-transfer email.
      // Matches the Former Keepers row on the Logbook PDF (L247) — chain.length - 1.
      const ownerChain = result.certId ? await getOwnerChain(result.certId) : [];
      const previousOwnersCount = Math.max(0, ownerChain.length - 1);

      await sendTransferV2IncomingConfirmation({
        toEmail: result.toEmail || "",
        fromEmail: result.fromEmail || "",
        certId: result.certId || "",
        confirmUrl: incomingConfirmUrl,
        previousOwnersCount,
      });

      // v435 — audit log the outgoing-keeper confirmation step transition.
      await storage.writeAuditLog("transfer", result.certId || "", "transfer_v2.outgoing_confirmed", null, {
        fromEmail: result.fromEmail, toEmail: result.toEmail,
      });

      return res.redirect(`/transfer?step=outgoing_confirmed&certId=${encodeURIComponent(result.certId || "")}&v=2`);
    } catch (err: any) {
      console.error("[transfer-v2] Error outgoing confirm:", err);
      return res.redirect("/transfer?error=server_error&v=2");
    }
  });

  // Step 3: incoming keeper submits ref number + token → enters dispute window
  app.post("/api/v2/transfers/incoming-confirm", requireTransferFlowLive, transferV2RateLimit, refNumberRateLimit, async (req, res) => {
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
        if (result.stolen) {
          return res.status(403).json({ error: result.error });
        }
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
  app.get("/api/v2/transfers/status/:certId", requireTransferFlowLive, async (req, res) => {
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
  app.post("/api/v2/transfers/dispute", requireTransferFlowLive, transferActionRateLimit, async (req, res) => {
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
  app.post("/api/v2/transfers/cancel", requireTransferFlowLive, transferActionRateLimit, async (req, res) => {
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

  // v435 — masks an email for audit log use: alice@example.com → a***@example.com
  const maskEmailForAudit = (email: string): string => {
    const trimmed = email.trim().toLowerCase();
    const at = trimmed.indexOf("@");
    if (at <= 0) return "***";
    const head = trimmed.slice(0, at);
    const domain = trimmed.slice(at);
    if (head.length <= 1) return `${head}***${domain}`;
    return `${head.charAt(0)}***${domain}`;
  };

  // ── V435 BUYER-INITIATED TRANSFER (eBay buyer with claim insert) ────────
  // The new claimant types cert ID + claim code from the printed insert
  // into /transfer/claim-by-code; we verify the claim_code_hash, lock the
  // cert into transfer_pending, and notify the current owner with 14 days
  // to either CONFIRM (transfer proceeds via the standard pending_dispute
  // window) or DISPUTE (transfer rejected, original ownership preserved).
  // Silence is treated as REJECTION (sweep auto-expires) — explicit
  // confirmation is required for ownership to change.

  app.post("/api/v2/transfers/claim-by-code", requireTransferFlowLive, transferV2RateLimit, claimRateLimit, async (req, res) => {
    try {
      const { certId, claimCode, claimantEmail, claimantName } = req.body as {
        certId?: unknown; claimCode?: unknown; claimantEmail?: unknown; claimantName?: unknown;
      };
      if (typeof certId !== "string" || typeof claimCode !== "string" || typeof claimantEmail !== "string") {
        return res.status(400).json({ error: "Certificate number, claim code, and your email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(claimantEmail.trim())) {
        return res.status(400).json({ error: "Please provide a valid email address." });
      }

      const normalizedCertId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedCertId);
      if (!cert) {
        return res.status(404).json({ error: "Certificate not found." });
      }

      if ((cert as any).stolenStatus === "reported_stolen") {
        return res.status(403).json({
          error: "This certificate has been reported stolen and cannot be transferred. Contact support@mintvaultuk.com to verify."
        });
      }

      // Path discrimination — buyer-init only handles already-claimed certs.
      // Unclaimed → redirect to the existing first-claim flow.
      if (cert.ownershipStatus === "unclaimed") {
        return res.status(409).json({
          error: "This certificate has not yet been claimed. Use the first-time claim flow.",
          redirect: "/api/claim/request",
        });
      }
      if (cert.ownershipStatus === "transfer_pending") {
        // Race-condition guard: another transfer is already in progress.
        await storage.writeAuditLog("transfer", normalizedCertId, "transfer_v2.buyer_init_rejected_race", null, {
          reason: "Another transfer in progress",
          claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
        });
        return res.status(409).json({ error: "A transfer is already in progress for this certificate. Please wait for it to complete or be resolved." });
      }
      if (cert.ownershipStatus !== "claimed") {
        return res.status(400).json({ error: "This certificate is not in a state that supports transfer." });
      }

      // Validate the claim code (constant-time hash compare at DB layer)
      const validation = await storage.validateClaimCodeForTransfer(normalizedCertId, claimCode.trim());
      if (!validation.valid || !validation.currentOwnerEmail || !validation.currentOwnerUserId) {
        await storage.writeAuditLog("transfer", normalizedCertId, "transfer_v2.buyer_init_rejected_bad_code", null, {
          claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
        });
        return res.status(401).json({ error: "Invalid certificate number or claim code." });
      }

      // Self-transfer guard
      if (claimantEmail.toLowerCase().trim() === validation.currentOwnerEmail) {
        return res.status(400).json({ error: "You're already the registered keeper of this certificate." });
      }

      // Final race check — if a transfer was inserted between our status read
      // and now, getTransferV2ByCertId returns it and we reject.
      const existing = await storage.getTransferV2ByCertId(normalizedCertId);
      if (existing) {
        await storage.writeAuditLog("transfer", normalizedCertId, "transfer_v2.buyer_init_rejected_race", null, {
          reason: "Active transfer detected on second check",
          claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
          existingTransferId: existing.id,
        });
        return res.status(409).json({ error: "A transfer is already in progress for this certificate." });
      }

      const { ownerToken, transferId } = await storage.createTransferV2BuyerInit({
        certId: normalizedCertId,
        claimantEmail: claimantEmail.trim(),
        claimantName: typeof claimantName === "string" ? claimantName.trim() : undefined,
        currentOwnerEmail: validation.currentOwnerEmail,
        currentOwnerUserId: validation.currentOwnerUserId,
      });

      const baseUrl = APP_BASE_URL;
      const disputeUrl = `${baseUrl}/api/v2/transfers/buyer-init/owner-dispute?token=${ownerToken}`;
      const confirmUrl = `${baseUrl}/api/v2/transfers/buyer-init/owner-confirm?token=${ownerToken}`;
      const ownerExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      await sendTransferV2OwnerInvitedByBuyer({
        ownerEmail: validation.currentOwnerEmail,
        certId: normalizedCertId,
        maskedClaimantEmail: maskEmailForAudit(claimantEmail.trim()),
        ownerExpiresAt,
        disputeUrl,
        confirmUrl,
      });

      await storage.writeAuditLog("transfer", String(transferId), "transfer_v2.buyer_init_initiated", null, {
        certId: normalizedCertId,
        claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
        currentOwnerEmailMasked: maskEmailForAudit(validation.currentOwnerEmail),
        ownerExpiresAt: ownerExpiresAt.toISOString(),
      });

      return res.json({
        success: true,
        message: "Transfer requested. The current keeper has been notified and has 14 days to confirm or dispute.",
        transferId,
      });
    } catch (err: any) {
      console.error("[transfer-v2-buyer-init] Error:", err);
      return res.status(500).json({ error: "An error occurred. Please try again." });
    }
  });

  // Owner clicks CONFIRM link in buyer-init notification email
  app.get("/api/v2/transfers/buyer-init/owner-confirm", requireTransferFlowLive, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2&path=buyer-init");

      const result = await storage.confirmBuyerInitTransfer(token);
      if (!result.success) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2&path=buyer-init`);
      }

      // Notify the buyer that the owner confirmed and the dispute window has started.
      try {
        await sendTransferV2BuyerInitOwnerConfirmed({
          claimantEmail: result.claimantEmail!,
          certId: result.certId!,
          disputeDeadline: result.disputeDeadline!,
        });
        // Also send the standard dispute-window-started email to both parties
        // so they get the same dispute UX as the seller-init flow.
        await sendTransferV2DisputeWindowStarted({
          email: result.ownerEmail!,
          certId: result.certId!,
          role: "outgoing",
          disputeDeadline: result.disputeDeadline!,
        });
        await sendTransferV2DisputeWindowStarted({
          email: result.claimantEmail!,
          certId: result.certId!,
          role: "incoming",
          disputeDeadline: result.disputeDeadline!,
        });
      } catch (emailErr: any) {
        console.error("[transfer-v2-buyer-init] confirm emails failed (non-fatal):", emailErr.message);
      }

      await storage.writeAuditLog("transfer", String(result.transferId), "transfer_v2.buyer_init_owner_confirmed", null, {
        certId: result.certId,
        disputeDeadline: result.disputeDeadline?.toISOString(),
      });

      return res.redirect(`/transfer?step=buyer_init_owner_confirmed&certId=${encodeURIComponent(result.certId || "")}&v=2`);
    } catch (err: any) {
      console.error("[transfer-v2-buyer-init] owner-confirm error:", err);
      return res.redirect("/transfer?error=server_error&v=2&path=buyer-init");
    }
  });

  // Owner clicks DISPUTE link in buyer-init notification email — this rejects
  // the transfer immediately. Cert ownership is preserved.
  app.get("/api/v2/transfers/buyer-init/owner-dispute", requireTransferFlowLive, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2&path=buyer-init");

      const result = await storage.disputeBuyerInitTransfer(token);
      if (!result.success) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2&path=buyer-init`);
      }

      // Notify the buyer that the owner rejected.
      try {
        await sendTransferV2BuyerInitOwnerRejected({
          claimantEmail: result.claimantEmail!,
          certId: result.certId!,
        });
      } catch (emailErr: any) {
        console.error("[transfer-v2-buyer-init] reject email failed (non-fatal):", emailErr.message);
      }

      await storage.writeAuditLog("transfer", String(result.transferId), "transfer_v2.buyer_init_owner_disputed", null, {
        certId: result.certId,
      });

      return res.redirect(`/transfer?step=buyer_init_owner_disputed&certId=${encodeURIComponent(result.certId || "")}&v=2`);
    } catch (err: any) {
      console.error("[transfer-v2-buyer-init] owner-dispute error:", err);
      return res.redirect("/transfer?error=server_error&v=2&path=buyer-init");
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
      const { email, notes, overrideStolen, overrideReason } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const adminUser = (req.session as any)?.adminEmail || "admin";

      // Admin-override audit. The override flag bypasses the stolen-status
      // guard inside assignOwnerManual; we record the override here at the
      // route layer where admin identity + reason are available.
      if (overrideStolen === true && (cert as any).stolenStatus === "reported_stolen") {
        await storage.writeAuditLog("certificate", certId, "admin_override_stolen_assign", adminUser, {
          email, reason: typeof overrideReason === "string" ? overrideReason.trim().slice(0, 2000) : null,
        });
      }

      await storage.assignOwnerManual(certId, email, adminUser, notes, { overrideStolen: overrideStolen === true });
      return res.json({ success: true });
    } catch (err: any) {
      const { StolenCertError } = await import("./storage");
      if (err instanceof StolenCertError) {
        return res.status(403).json({ error: err.message });
      }
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
    const baseUrl = APP_BASE_URL;
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
    const baseUrl = APP_BASE_URL;
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
      const baseUrl = APP_BASE_URL;
      // Wrap through /m/login/:token so the User-Agent sniff can intercept
      // mobile-webview clicks and show the "open in browser" intermediate
      // page. Real browsers 302 straight to /api/customer/verify/:token.
      const loginUrl = `${baseUrl}/m/login/${token}`;

      try {
        await sendMagicLink({ email: normalEmail, loginUrl });
      } catch (sendErr: any) {
        console.error("[magic-link] sendMagicLink failed:", sendErr.message);
        return res.status(500).json({
          success: false,
          error: "Could not send login link. Please try again or contact support@mintvaultuk.com.",
        });
      }
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
        // Destroy any pre-existing session — prevents a failed verify from
        // leaving a stale customer/admin session visible to the recipient.
        return req.session.destroy(() => {
          res.redirect("/dashboard?error=invalid_link");
        });
      }

      // If an active session is already signed in as a DIFFERENT customer,
      // don't switch silently. Stash a 5-min HMAC-signed cookie + DB nonce
      // and route the user to /account/switch for explicit confirmation.
      // Same-email and no-session cases fall through to the existing flow.
      const existingCustomerEmail = (req.session as any)?.customerEmail as string | undefined;
      if (existingCustomerEmail && existingCustomerEmail.toLowerCase() !== email.toLowerCase()) {
        const { createPendingSwitchCookie, setPendingSwitchCookie } = await import("./account-switch");
        const cookie = await createPendingSwitchCookie(email);
        setPendingSwitchCookie(res, cookie.value, cookie.attrs);
        return res.redirect("/account/switch");
      }

      // Find-or-create the users row for this email. PIN auth requires a
      // users row to live on (pin_hash column). Cert-owners who came in
      // pre-PIN may not have one yet — create idempotently here.
      let user = await storage.getUserByEmail(email);
      if (!user) {
        user = await storage.createUser({ email });
      }

      // Regenerate session on privilege grant to cert-owner.
      // Prevents pre-existing admin/account-holder fields from
      // surviving into the new customer session document (PR 3a).
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });

      req.session.userId = undefined as unknown as string;
      req.session.userEmail = undefined as unknown as string;
      req.session.isAdmin = false;
      req.session.adminEmail = undefined as unknown as string;
      req.session.customerEmail = email;

      // Branch on whether the user has a PIN set. First-time enrollers go
      // to /auth/pin/setup; returning users with a PIN already set carry
      // on to /dashboard. Setup-required is also a session flag the setup
      // endpoint reads to authorise the write.
      const hasPin = !!(user as any).pinHash;
      if (!hasPin) {
        (req.session as any).pinSetupRequired = true;
        return res.redirect("/auth/pin/setup");
      }
      res.redirect("/dashboard?login=success");
    } catch (err) {
      console.error("[customer] verify error:", err);
      return req.session.destroy(() => {
        res.redirect("/dashboard?error=server_error");
      });
    }
  });

  // ── Account-switch confirm flow ─────────────────────────────────────────────
  // Triggered by /api/customer/verify/:token when an active session is signed
  // in as a different customer. /account/switch renders an HTML confirm page;
  // the user explicitly confirms or cancels. See server/account-switch.ts.

  const accountSwitchRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many switch attempts. Please wait 15 minutes." },
  });

  app.get("/account/switch", async (req, res) => {
    const { readSwitchCookie, verifyPendingSwitchCookie, clearPendingSwitchCookie } = await import("./account-switch");
    const raw = readSwitchCookie(req);
    const verified = verifyPendingSwitchCookie(raw);
    if (!verified.valid) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_expired");
    }
    const currentEmail = ((req.session as any)?.customerEmail as string | undefined) ?? "";
    if (!currentEmail) {
      // No active session to switch from — just clear the pending cookie and
      // route to /dashboard. The success path on /verify handles a fresh login.
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard");
    }
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const currentEsc = escape(currentEmail);
    const pendingEsc = escape(verified.email);
    const nonceEsc = escape(verified.nonce);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switch account — MintVault</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #1A1612; color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 480px; background: #221C16; border: 1px solid rgba(212,175,55,0.25); border-radius: 16px; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #D4AF37; margin: 0 0 16px; }
  h1 { color: #FAF7F1; font-size: 24px; font-weight: 600; margin: 0 0 16px; }
  p { color: rgba(250,247,241,0.78); font-size: 15px; line-height: 1.55; margin: 0 0 16px; }
  strong.email { color: #D4AF37; font-weight: 600; word-break: break-all; }
  .actions { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
  button { font: inherit; font-size: 15px; padding: 12px 18px; border-radius: 10px; border: 0; cursor: pointer; width: 100%; }
  button.primary { background: linear-gradient(135deg,#B8960C,#D4AF37); color: #1A1400; font-weight: 700; }
  button.secondary { background: transparent; color: #FAF7F1; border: 1px solid rgba(250,247,241,0.25); }
  button:hover { filter: brightness(1.08); }
  form { margin: 0; }
  .meta { color: rgba(250,247,241,0.45); font-size: 12px; margin-top: 18px; }
</style></head>
<body>
  <div class="card">
    <p class="eyebrow">MintVault &middot; Account switch</p>
    <h1>Switch account?</h1>
    <p>You're currently signed in as <strong class="email">${currentEsc}</strong> on this device.</p>
    <p>Continuing will sign that account out and sign in as <strong class="email">${pendingEsc}</strong>.</p>
    <div class="actions">
      <form method="POST" action="/account/switch/confirm">
        <input type="hidden" name="nonce" value="${nonceEsc}">
        <button type="submit" class="primary">Switch to ${pendingEsc}</button>
      </form>
      <form method="POST" action="/account/switch/cancel">
        <button type="submit" class="secondary">Stay signed in as ${currentEsc}</button>
      </form>
    </div>
    <p class="meta">If you don't recognise either address, close this page. Doing nothing leaves your current session intact.</p>
  </div>
</body></html>`);
  });

  app.post("/account/switch/confirm", accountSwitchRateLimit, async (req, res) => {
    const { readSwitchCookie, verifyPendingSwitchCookie, consumePendingSwitch, clearPendingSwitchCookie, cleanupStaleNonces, maskEmail, ipHash } = await import("./account-switch");
    cleanupStaleNonces();
    const raw = readSwitchCookie(req);
    const verified = verifyPendingSwitchCookie(raw);
    if (!verified.valid) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    const formNonce = String((req.body?.nonce ?? "")).trim();
    if (!formNonce || formNonce !== verified.nonce) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    const consumed = await consumePendingSwitch(verified.nonce);
    if (!consumed) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    const fromEmail = ((req.session as any)?.customerEmail as string | undefined) ?? "";
    const toEmail = verified.email;
    try {
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
    } catch (err: any) {
      console.error("[account-switch] regenerate failed:", err?.message ?? err);
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    req.session.userId = undefined as unknown as string;
    req.session.userEmail = undefined as unknown as string;
    req.session.isAdmin = false;
    req.session.adminEmail = undefined as unknown as string;
    req.session.customerEmail = toEmail;
    clearPendingSwitchCookie(res);
    try {
      const ip = (req.ip as string) || "unknown";
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('session', ${verified.nonce}, 'customer_session_switch', 'system',
                ${JSON.stringify({
                  from_email_masked: maskEmail(fromEmail),
                  to_email_masked: maskEmail(toEmail),
                  ip_hash: ipHash(ip),
                  nonce: verified.nonce,
                })}::jsonb,
                NOW())
      `);
    } catch (auditErr: any) {
      console.warn("[account-switch] audit_log insert failed:", auditErr?.message ?? auditErr);
    }
    return res.redirect("/dashboard?login=success&switched=1");
  });

  // ── Mobile-webview intermediate pages (PIN auth launch) ─────────────────────
  // Magic-link emails clicked from in-app webviews (Gmail, Outlook, FB, etc.)
  // land in a webview that doesn't share session cookies with the user's real
  // browser. /m/login and /m/reset sniff the User-Agent: real browsers 302
  // straight through; webviews get an HTML page with an "open in browser"
  // CTA that re-targets the real verify URL via target="_blank" + window.open.

  function isInAppWebview(ua: string): boolean {
    if (!ua) return false;
    // Common in-app browser signatures. Conservative — false positives just
    // show one extra confirmation tap, false negatives mean a broken login.
    return /\bwv\)|; wv;|FBAN\/|FBAV\/|Instagram |Twitter for|LinkedInApp|GoogleMail|Outlook(?:Mobile|-iOS|-Android)|YJApp|Snapchat\b|Line\/|MicroMessenger\b/i.test(ua);
  }

  function renderIntermediateHtml(realUrl: string, kind: "login" | "reset"): string {
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const urlEsc = escape(realUrl);
    const heading = kind === "login" ? "Open in your browser" : "Open in your browser";
    const subhead = kind === "login"
      ? "For security, your sign-in link needs to open in your phone's real browser, not inside this email app."
      : "For security, your PIN reset link needs to open in your phone's real browser, not inside this email app.";
    const ctaLabel = kind === "login" ? "Open Sign-In Link" : "Open Reset Link";
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} — MintVault</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #1A1612; color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 480px; background: #221C16; border: 1px solid rgba(212,175,55,0.25); border-radius: 16px; padding: 28px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #D4AF37; margin: 0 0 14px; }
  h1 { color: #FAF7F1; font-size: 22px; font-weight: 600; margin: 0 0 14px; line-height: 1.25; }
  p { color: rgba(250,247,241,0.78); font-size: 14px; line-height: 1.55; margin: 0 0 14px; }
  .cta { display: block; width: 100%; padding: 14px 18px; border-radius: 12px; background: linear-gradient(135deg,#B8960C,#D4AF37); color: #1A1400; font-weight: 700; font-size: 15px; text-align: center; text-decoration: none; margin: 18px 0 12px; }
  .copy-block { background: #15110D; border: 1px solid rgba(250,247,241,0.08); border-radius: 8px; padding: 10px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; color: rgba(250,247,241,0.55); }
  .meta { color: rgba(250,247,241,0.45); font-size: 12px; margin-top: 16px; }
  .steps { color: rgba(250,247,241,0.55); font-size: 12px; line-height: 1.6; margin: 14px 0 0; padding-left: 18px; }
  .steps li { margin-bottom: 4px; }
</style></head>
<body>
  <div class="card">
    <p class="eyebrow">MintVault &middot; Continue in browser</p>
    <h1>${heading}</h1>
    <p>${subhead}</p>
    <a href="${urlEsc}" target="_blank" rel="noopener" class="cta" id="cta">${ctaLabel}</a>
    <p class="meta">If the button doesn't open your browser, long-press it and choose <em>Open in Browser</em>, or copy the link below into Safari / Chrome:</p>
    <div class="copy-block">${urlEsc}</div>
    <ol class="steps">
      <li>Tap the share / menu icon in this email view</li>
      <li>Choose <em>Open in Browser</em> (iOS) or <em>Open in Chrome</em> (Android)</li>
    </ol>
  </div>
  <script>
    // Defence in depth: try window.open as a JS fallback when the user taps
    // the CTA. In some webviews target=_blank is intercepted; window.open
    // can succeed where the anchor fails.
    document.getElementById("cta").addEventListener("click", function(e) {
      try { window.open(${JSON.stringify(realUrl)}, "_blank", "noopener"); } catch (_) {}
    });
  </script>
</body></html>`;
  }

  app.get("/m/login/:token", (req, res) => {
    const token = String(req.params.token);
    const realUrl = `${APP_BASE_URL}/api/customer/verify/${token}`;
    const ua = String(req.headers["user-agent"] || "");
    if (!isInAppWebview(ua)) {
      return res.redirect(302, realUrl);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(renderIntermediateHtml(realUrl, "login"));
  });

  app.get("/m/reset/:token", (req, res) => {
    const token = String(req.params.token);
    const realUrl = `${APP_BASE_URL}/auth/pin/reset/${token}`;
    const ua = String(req.headers["user-agent"] || "");
    if (!isInAppWebview(ua)) {
      return res.redirect(302, realUrl);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(renderIntermediateHtml(realUrl, "reset"));
  });

  app.post("/account/switch/cancel", async (_req, res) => {
    const { clearPendingSwitchCookie, cleanupStaleNonces } = await import("./account-switch");
    cleanupStaleNonces();
    clearPendingSwitchCookie(res);
    return res.redirect("/dashboard");
  });

  // ── PIN auth (v1 launch) ────────────────────────────────────────────────────
  // Replaces magic-link as primary login for cert-owners + admin step 2.
  // Magic-link demoted to first-time enrollment (/api/customer/verify routes
  // to /auth/pin/setup if no pin_hash) and forgot-PIN reset.

  const pinLoginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please wait 15 minutes." },
  });

  // POST /api/auth/pin/setup — set the PIN on the user's row.
  // Authorisation: must have one of these session contexts (in priority order):
  //   1. pinResetEmail (set by /auth/pin/reset/:token after consuming a reset token)
  //   2. pendingAdmin (admin in step 2 of two-step login, no PIN yet — LOCK-3)
  //   3. customerEmail (cert-owner just verified magic-link, pinSetupRequired flag set)
  app.post("/api/auth/pin/setup", async (req, res) => {
    try {
      const { hashPin, validatePinStrength, WeakPinError, logPinEvent, hashIp, resetFailures } = await import("./pin");
      const pin = String(req.body?.pin || "").trim();
      const ipH = hashIp(req.ip || "unknown");

      // Determine target email + completion behaviour from session context
      let targetEmail: string | undefined;
      let completionMode: "customer" | "admin" | "reset_customer" | "reset_admin" | null = null;
      const resetEmail = (req.session as any)?.pinResetEmail as string | undefined;
      const resetIsAdmin = (req.session as any)?.pinResetIsAdmin === true;
      if (resetEmail) {
        targetEmail = resetEmail;
        completionMode = resetIsAdmin ? "reset_admin" : "reset_customer";
      } else if ((req.session as any)?.pendingAdmin) {
        targetEmail = ADMIN_EMAIL;
        completionMode = "admin";
      } else if ((req.session as any)?.customerEmail) {
        targetEmail = (req.session as any).customerEmail;
        completionMode = "customer";
      }
      if (!targetEmail || !completionMode) {
        return res.status(401).json({ error: "Not authorised to set a PIN. Please log in via your email link first." });
      }

      try {
        validatePinStrength(pin);
      } catch (e: any) {
        if (e instanceof WeakPinError) {
          await logPinEvent(targetEmail, false, "weak_pin", ipH);
          return res.status(422).json({ error: e.message, reason: e.reason });
        }
        throw e;
      }

      const hash = await hashPin(pin);
      await db.execute(sql`
        UPDATE users
        SET pin_hash = ${hash},
            pin_set_at = NOW(),
            pin_failed_count = 0,
            pin_locked_until = NULL,
            updated_at = NOW()
        WHERE LOWER(email) = LOWER(${targetEmail}) AND deleted_at IS NULL
      `);
      await resetFailures(targetEmail);

      const isReset = completionMode.startsWith("reset_");
      await logPinEvent(targetEmail, true, isReset ? "pin_reset" : "pin_set", ipH);

      // Clear setup-context flags
      (req.session as any).pinResetEmail = undefined;
      (req.session as any).pinResetIsAdmin = undefined;
      (req.session as any).pinSetupRequired = undefined;

      // Complete the login appropriate to context. Reset paths come in
      // logged-out, so we regenerate + set the appropriate session field.
      if (completionMode === "admin" || completionMode === "reset_admin") {
        await new Promise<void>((resolve, reject) => {
          req.session.regenerate((err) => (err ? reject(err) : resolve()));
        });
        req.session.userId = undefined as unknown as string;
        req.session.userEmail = undefined as unknown as string;
        req.session.customerEmail = undefined as unknown as string;
        req.session.isAdmin = true;
        req.session.adminEmail = ADMIN_EMAIL;
        clearPendingAdmin(req);
        return res.json({ ok: true, redirect: "/admin" });
      }
      // customer or reset_customer
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      req.session.userId = undefined as unknown as string;
      req.session.userEmail = undefined as unknown as string;
      req.session.isAdmin = false;
      req.session.adminEmail = undefined as unknown as string;
      req.session.customerEmail = targetEmail;
      return res.json({ ok: true, redirect: "/dashboard?login=success" });
    } catch (err: any) {
      console.error("[pin/setup] error:", err.message);
      res.status(500).json({ error: "Could not set PIN. Please try again." });
    }
  });

  // POST /api/auth/pin/login — primary cert-owner login. Email + PIN.
  // Admin login uses /api/admin/login (password) → /api/admin/pin (PIN) instead.
  app.post("/api/auth/pin/login", pinLoginRateLimit, async (req, res) => {
    try {
      const { verifyPin, checkLockout, registerFailure, resetFailures, logPinEvent, hashIp, PIN_LOCKOUT_DURATION_MS } = await import("./pin");
      const rawEmail = String(req.body?.email || "").toLowerCase().trim();
      const pin = String(req.body?.pin || "").trim();
      const ipH = hashIp(req.ip || "unknown");

      if (!rawEmail || !pin) {
        return res.status(400).json({ error: "Email and PIN are both required." });
      }

      // Lockout check first — even before user existence check, so a locked
      // account can't be probed via "is this email in our system" timing.
      const lockState = await checkLockout(rawEmail);
      if (lockState.locked) {
        await logPinEvent(rawEmail, false, "locked", ipH);
        const retryAfterSeconds = lockState.retryAfter
          ? Math.ceil((lockState.retryAfter.getTime() - Date.now()) / 1000)
          : Math.ceil(PIN_LOCKOUT_DURATION_MS / 1000);
        return res.status(423).json({
          error: `Too many incorrect attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
          retryAfterSeconds,
        });
      }

      const user = await storage.getUserByEmail(rawEmail);
      if (!user || !(user as any).pinHash) {
        await logPinEvent(rawEmail, false, user ? "no_pin_set" : "no_user", ipH);
        return res.status(401).json({ error: "Email or PIN incorrect." });
      }

      const ok = await verifyPin(pin, (user as any).pinHash);
      if (!ok) {
        const post = await registerFailure(rawEmail);
        await logPinEvent(rawEmail, false, post.locked ? "lockout_triggered" : "wrong_pin", ipH);
        if (post.locked && post.retryAfter) {
          const retryAfterSeconds = Math.ceil((post.retryAfter.getTime() - Date.now()) / 1000);
          return res.status(423).json({
            error: `Too many incorrect attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
            retryAfterSeconds,
          });
        }
        return res.status(401).json({ error: "Email or PIN incorrect." });
      }

      // PIN correct. Reset failure counters.
      await resetFailures(rawEmail);

      // LOCK-2: account-switch mismatch detection. If the existing session
      // is signed in as a DIFFERENT cert-owner, route through the confirm
      // page instead of switching silently. Same logic shape as the
      // magic-link verify branch above.
      const existingCustomerEmail = (req.session as any)?.customerEmail as string | undefined;
      if (existingCustomerEmail && existingCustomerEmail.toLowerCase() !== rawEmail) {
        const { createPendingSwitchCookie, setPendingSwitchCookie } = await import("./account-switch");
        const cookie = await createPendingSwitchCookie(rawEmail);
        setPendingSwitchCookie(res, cookie.value, cookie.attrs);
        return res.json({ ok: true, redirect: "/account/switch" });
      }

      // Regenerate session on privilege grant. Cross-clear admin/account-holder
      // fields per the existing PR 3a discipline.
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      // Set both audiences from the verified user (login-unification design,
      // see commit bca27f4 + docs/login-unification-plan.md). regenerate()
      // above already wiped any prior session contents. We preserve the
      // admin cross-clear (PR 3a discipline) since admin is the only
      // audience that must remain isolated from cert-owner / account-holder.
      req.session.userId = user.id as string;
      req.session.userEmail = (user.email as string | null) ?? rawEmail;
      req.session.isAdmin = false;
      req.session.adminEmail = undefined as unknown as string;
      req.session.customerEmail = rawEmail;
      return res.json({ ok: true, redirect: "/dashboard?login=success" });
    } catch (err: any) {
      console.error("[pin/login] error:", err.message);
      res.status(500).json({ error: "Could not sign in. Please try again." });
    }
  });

  // POST /api/auth/pin/forgot — request a PIN-reset magic link by email.
  // Always returns 200 with a generic message to avoid email enumeration.
  app.post("/api/auth/pin/forgot", magicLinkRateLimit, async (req, res) => {
    try {
      const { logPinEvent, hashIp } = await import("./pin");
      const rawEmail = String(req.body?.email || "").toLowerCase().trim();
      const ipH = hashIp(req.ip || "unknown");

      if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      const user = await storage.getUserByEmail(rawEmail);
      // Generic response either way
      const genericMsg = { ok: true, message: "If an account exists, a reset link has been sent." };

      if (!user) {
        await logPinEvent(rawEmail, false, "no_user", ipH);
        return res.json(genericMsg);
      }

      // Mint reset token + send email
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await db.execute(sql`
        INSERT INTO pin_reset_tokens (email, token, expires_at)
        VALUES (${rawEmail}, ${token}, ${expiresAt.toISOString()})
      `);
      const baseUrl = APP_BASE_URL;
      // Wrap through /m/reset/:token for the same in-app-webview protection
      // as the login flow. The token itself is consumed at /auth/pin/reset/:token,
      // not at the /m/ wrapper.
      const resetUrl = `${baseUrl}/m/reset/${token}`;
      try {
        await sendPinResetLink({ email: rawEmail, resetUrl });
      } catch (sendErr: any) {
        console.error("[pin/forgot] sendPinResetLink failed:", sendErr.message);
      }
      await logPinEvent(rawEmail, true, "reset_link_sent", ipH);
      return res.json(genericMsg);
    } catch (err: any) {
      console.error("[pin/forgot] error:", err.message);
      // Still return generic success so timing doesn't leak existence
      return res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
    }
  });

  // GET /auth/pin/reset/:token — consume the reset token, set a session
  // flag authorising a PIN write, redirect to /auth/pin/setup?reset=1.
  app.get("/auth/pin/reset/:token", async (req, res) => {
    try {
      const token = String(req.params.token);
      // Atomic single-use consume — same pattern as customer_magic_link_tokens
      const r = await db.execute(sql`
        UPDATE pin_reset_tokens
        SET consumed_at = NOW()
        WHERE token = ${token}
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING email
      `);
      const row = r.rows[0] as { email: string } | undefined;
      if (!row) {
        return req.session.destroy(() => {
          res.redirect("/customer-login?error=reset_link_invalid");
        });
      }
      // Establish reset-authorised session. Destroy any pre-existing session
      // first to prevent leaking another account's data into the setup flow.
      await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
      const user = await storage.getUserByEmail(row.email);
      const isAdmin = !!user && (user as any).role === "admin";
      (req.session as any).pinResetEmail = row.email.toLowerCase();
      (req.session as any).pinResetIsAdmin = isAdmin;
      return res.redirect("/auth/pin/setup?reset=1");
    } catch (err: any) {
      console.error("[pin/reset] error:", err.message);
      return req.session.destroy(() => {
        res.redirect("/customer-login?error=reset_link_invalid");
      });
    }
  });

  // POST /api/auth/logout-everywhere — admin-only. Truncates the session
  // table; every active cookie is invalidated. Used as a one-shot kick
  // after the PIN-auth deploy lands so all 30-day cookies must re-auth.
  // Wraps in try/catch so a failed truncate surfaces clearly.
  app.post("/api/auth/logout-everywhere", requireAdmin, async (req, res) => {
    try {
      const before = await db.execute(sql`SELECT COUNT(*)::int AS n FROM session`);
      const beforeCount = (before.rows[0] as any).n;
      await db.execute(sql`TRUNCATE session`);
      const adminEmail = (req.session as any)?.adminEmail || "admin";
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('session', 'all', 'logout_everywhere', ${adminEmail},
                ${JSON.stringify({ destroyed: beforeCount, reason: "PIN auth deploy: forced re-auth" })}::jsonb,
                NOW())
      `);
      // Note: this destroys the admin's own session too. Their next request
      // will hit 401. They'll need to re-authenticate via /api/admin/login.
      return res.json({ ok: true, destroyed: beforeCount });
    } catch (err: any) {
      console.error("[logout-everywhere] error:", err.message);
      return res.status(500).json({ error: "Failed to truncate sessions: " + err.message });
    }
  });

  // GET /api/customer/me — return current customer session info
  app.get("/api/customer/me", requireCustomer, (req, res) => {
    res.json({ email: req.session.customerEmail });
  });

  // POST /api/customer/logout — destroy customer session
  app.post("/api/customer/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("[customer-logout] session destroy failed:", err);
        return res.status(500).json({ error: "Logout failed" });
      }
      res.clearCookie("mv.sid");
      res.json({ message: "Logged out." });
    });
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

  // PATCH /api/customer/submissions/:id/marketing-consent — per-card toggle.
  // Body: { consent: boolean }. Ownership-checked against the session email.
  // Writes audit_log on every change (both grant + withdrawal), keyed by
  // submission.id. No-op when consent state matches existing value.
  app.patch("/api/customer/submissions/:id/marketing-consent", requireCustomer, async (req, res) => {
    try {
      const email = req.session.customerEmail!;
      const subId = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(subId)) return res.status(400).json({ error: "Invalid submission id." });
      const consent = req.body?.consent === true;

      const rows = (await db.execute(sql`
        SELECT id, customer_email, marketing_feature_consent, deleted_at
        FROM submissions WHERE id = ${subId} LIMIT 1
      `)).rows;
      const sub = rows[0] as any;
      if (!sub) return res.status(404).json({ error: "Submission not found." });
      if (sub.deleted_at) return res.status(404).json({ error: "Submission not found." });
      if ((sub.customer_email || "").toLowerCase() !== email.toLowerCase()) {
        return res.status(403).json({ error: "Not your submission." });
      }

      const before = sub.marketing_feature_consent === true;
      if (before === consent) {
        return res.json({ ok: true, changed: false, consent });
      }

      await db.execute(sql`
        UPDATE submissions
        SET marketing_feature_consent = ${consent},
            marketing_feature_consent_at = NOW(),
            updated_at = NOW()
        WHERE id = ${subId}
      `);
      await db.insert(auditLog).values({
        entityType: "submission",
        entityId: String(subId),
        action: "marketing_consent_changed",
        // Spec: admin_user = <user id> — for a customer self-toggle the
        // actor is the user themselves; we record the session userId if
        // available, falling back to the email so the actor is traceable.
        adminUser: (req.session as any).userId ?? email,
        details: { before, after: consent, reason: consent ? "user_grant" : "user_withdrawal" },
      });
      res.json({ ok: true, changed: true, consent });
    } catch (err: any) {
      console.error("[marketing-consent] toggle error:", err);
      res.status(500).json({ error: err?.message ?? "Failed to update consent." });
    }
  });

  // POST /api/customer/marketing-consent/withdraw-all — global withdraw.
  // Flips every active submission for this customer email from true → false
  // and writes one audit_log row per affected submission. No-op when none
  // were consented. Idempotent.
  app.post("/api/customer/marketing-consent/withdraw-all", requireCustomer, async (req, res) => {
    try {
      const email = req.session.customerEmail!;
      const actor = (req.session as any).userId ?? email;
      const consented = (await db.execute(sql`
        SELECT id FROM submissions
        WHERE LOWER(customer_email) = ${email.toLowerCase()}
          AND marketing_feature_consent = true
          AND deleted_at IS NULL
      `)).rows as Array<{ id: number }>;

      if (consented.length === 0) {
        return res.json({ ok: true, withdrew: 0 });
      }

      const ids = consented.map(r => r.id);
      await db.execute(sql`
        UPDATE submissions
        SET marketing_feature_consent = false,
            marketing_feature_consent_at = NOW(),
            updated_at = NOW()
        WHERE id = ANY(${ids}::int[])
      `);
      for (const subId of ids) {
        await db.insert(auditLog).values({
          entityType: "submission",
          entityId: String(subId),
          action: "marketing_consent_changed",
          adminUser: actor,
          details: { before: true, after: false, reason: "user_withdrawal" },
        });
      }
      res.json({ ok: true, withdrew: ids.length });
    } catch (err: any) {
      console.error("[marketing-consent] withdraw-all error:", err);
      res.status(500).json({ error: err?.message ?? "Failed to withdraw consent." });
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
          const url = await getR2SignedUrl(key, 60 * 60 * 24 * 7);   // 7-day URL (AWS SigV4 hard cap)
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
      // Strip sensitive fields, expose subgrades + signed front-image URL.
      // 1-hour TTL on the signed URL matches the /cert/:id page (certToPublic).
      // R2 sign calls run in parallel via Promise.all — typical dashboard
      // returns 1-20 certs so the per-cert sign doesn't dominate latency.
      const safe = await Promise.all(certs.map(async (c) => ({
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
        cardNumber: c.cardNumber ?? null,
        gradeCentering: c.gradeCentering ?? null,
        gradeCorners: c.gradeCorners ?? null,
        gradeEdges: c.gradeEdges ?? null,
        gradeSurface: c.gradeSurface ?? null,
        frontImageUrl: (c as any).frontImagePath
          ? await getR2SignedUrl((c as any).frontImagePath, 3600).catch(() => null)
          : null,
        stolenStatus: (c as any).stolenStatus ?? null,
      })));
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
        const { deskewCard, cropToYellowBorder, autoCrop, maskRoundedCorners, generateVariants, checkImageQuality, reCentreBitmap, padWithMat } = await import("./image-processing");
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
          // 1. Save original — re-encode via sharp to strip EXIF/ICC/thumbnail
          // metadata that came through multer (sharp default omits metadata
          // unless .withMetadata() is called). Standardises q85 mozjpeg
          // progressive regardless of input format (browser may have sent
          // PNG/TIFF/WebP/JPEG; ContentType was previously forced to
          // image/jpeg without re-encoding, which lied to clients on non-JPEG
          // inputs). Same encode settings as every other JPEG output.
          const sharp = (await import("sharp")).default;
          const reencodedOriginal = await sharp(buffer)
            .jpeg({ quality: 85, progressive: true, mozjpeg: true })
            .toBuffer();
          const origKey = `grading/${certId}/${angle}_original.${ext}`;
          await uploadToR2(origKey, reencodedOriginal, "image/jpeg");
          updates[`grading_${angle}_original`] = origKey;

          // 2. Deskew (straighten slight rotation before cropping)
          const { buffer: deskewedBuf, angle: deskewAngle } = await deskewCard(buffer);

          // 3. Yellow border crop (precise), then fallback to autoCrop
          const yellowResult = await cropToYellowBorder(deskewedBuf);
          const cropResult = yellowResult || await autoCrop(deskewedBuf);
          const { buffer: rectCropped, cropped, matRgb } = cropResult;

          // 3a. Deterministic re-centre — measure actual card edges against
          // mat colour and shift card to centre inside the bitmap (Fix 2).
          // matRgb is plumbed in from the cropper so reCentreBitmap doesn't
          // misdetect the cropped buffer's yellow card border as mat.
          const centreResult = await reCentreBitmap(rectCropped, { certId, matRgb });
          cropGeometryByAngle[angle] = { pre_padding_px: centreResult.pre_padding_px, post_asymmetry_px: centreResult.post_asymmetry_px, extended: centreResult.extended };

          // 4. Rounded corner mask + mat padding. Order matters: mask FIRST
          // so the rounded-corner alpha sits on the card's corners, then
          // pad with mat so the final display image has a passport-style
          // frame with the card visibly framed. Without this order the
          // mask would clip the bitmap corners (now far from the card).
          //
          // FINAL flatten: composite alpha against white and JPEG-encode at
          // q85 mozjpeg progressive. maskRoundedCorners already sets white
          // RGB under the transparent corners (image-processing.ts:40-44),
          // so flatten-against-white is a no-op visually for the corners;
          // mat-padded outer ring stays the mat colour. Saves ~74% per
          // image vs the prior PNG output (2.1MB → ~550KB per side).
          const maskedBuf = await maskRoundedCorners(centreResult.buffer);
          const paddedBuf = await padWithMat(maskedBuf, matRgb);
          const croppedBuf = await (await import("sharp")).default(paddedBuf)
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality: 85, progressive: true, mozjpeg: true })
            .toBuffer();
          const ext2 = "jpg";
          const cropKey = `grading/${certId}/${angle}_cropped.${ext2}`;
          await uploadToR2(cropKey, croppedBuf, "image/jpeg");
          updates[`grading_${angle}_cropped`] = cropKey;

          // 4. Quality check on cropped image
          const quality = await checkImageQuality(croppedBuf);
          qualityResults[angle] = { ...quality, cropped, deskewAngle };

          // 5. Also update the primary front/back image paths used for display + AI.
          // Canonical display key uses .jpg with image/jpeg mime — croppedBuf
          // is the flattened JPEG buffer.
          if (angle === "front") {
            frontCroppedBuf = croppedBuf;
            const displayKey = r2KeyForImage(certId, "front", "jpg");
            updates["front_image_path"] = displayKey;
            await uploadToR2(displayKey, croppedBuf, "image/jpeg");
          } else if (angle === "back") {
            backCroppedBuf = croppedBuf;
            const displayKey = r2KeyForImage(certId, "back", "jpg");
            updates["back_image_path"] = displayKey;
            await uploadToR2(displayKey, croppedBuf, "image/jpeg");
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
                .catch(e => console.error(`[upload-images] AI failed for cert ${id}: ${e?.message || e}\n${e?.stack || "(no stack)"}`));
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

  // ── Attach images to an existing (typically blank) cert. Reuses the
  // scan-ingest pipeline (uploadImagesToCert) so attached images go through
  // the same deskew → safety-pad → mask → 10px-trim → PNG path as a
  // natively-scanned cert. Front required, back optional. AI fires async.
  const attachImagesUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB, matches scan-ingest
    fileFilter: (_req, file, cb) => {
      if (/\.(jpg|jpeg|png|webp|tiff?)$/i.test(path.extname(file.originalname))) cb(null, true);
      else cb(new Error("Unsupported image format"));
    },
  });

  app.put(
    "/api/admin/certificates/:id/attach-images",
    requireAdmin,
    attachImagesUpload.fields([{ name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]),
    async (req, res) => {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid certificate id" });

      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const frontFile = files?.front?.[0];
      const backFile  = files?.back?.[0];
      if (!frontFile) return res.status(400).json({ error: "Front image is required" });

      try {
        const { uploadImagesToCert, runAiOnCertIfIdle } = await import("./scan-ingest-service");
        const { frontVariants, backVariants } =
          await uploadImagesToCert(id, frontFile.buffer, backFile?.buffer ?? null);

        const adminUser = req.session.adminEmail || "admin";
        await storage.writeAuditLog(
          "certificate",
          String(cert.certId),
          "cert_images_attached",
          adminUser,
          {
            cert_id: id,
            had_front_before: !!cert.frontImagePath,
            had_back_before:  !!cert.backImagePath,
            attached: {
              front: { filename: frontFile.originalname, size: frontFile.size },
              back:  backFile ? { filename: backFile.originalname, size: backFile.size } : null,
            },
          },
        );

        const aiPromise = runAiOnCertIfIdle(id, frontVariants.cropped, backVariants?.cropped || null);
        if (aiPromise) {
          aiPromise
            .then(r => console.log(`[attach-images] AI done for cert ${id}: grade=${r?.grade}`))
            .catch(e => console.warn(`[attach-images] AI failed for cert ${id}:`, e?.message || e));
        }

        res.json({ ok: true, certId: cert.certId, aiTriggered: !!aiPromise });
      } catch (err: any) {
        console.error(`[attach-images] cert=${id} failed:`, err?.message || err, err?.stack || "");
        res.status(500).json({ error: err?.message || "Attach failed" });
      }
    },
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
          // Rotate-bounding-box wedges fill with white to match scanner mat
          // (Epson V850 Pro, confirmed). Black previously baked black wedges
          // into the JPEG when the extract overlapped them — see PR fixing
          // recrop black-corners regression.
          .rotate(rotation_deg, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
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
        // Belt-and-braces: flatten any residual alpha/transparency to white
        // before JPEG encoding (which would otherwise default to black for
        // transparent pixels — root cause of earlier black-corners bug).
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
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

  // POST /api/admin/certificates/:id/generate-description — Option B
  //
  // Synthesise the grade-rationale paragraph from the admin's manual subgrades
  // + confirmed defects. Haiku 4.5 text-only call. Idempotent: each invocation
  // overwrites grade_explanation; the audit_log row records every call.
  app.post("/api/admin/certificates/:id/generate-description", requireAdmin, async (req, res) => {
    try {
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_DESCRIPTION_GEN_ENABLED"))) {
        return res.status(503).json({ error: "AI description generation is disabled" });
      }
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid certificate id" });
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      const c = cert as any;
      if (c.deletedAt) return res.status(410).json({ error: "Certificate is deleted" });

      // Validate all four subgrades present. Empty/0 means "not set" — the
      // calculator never produces 0 for a real grade (1 is the floor).
      const centeringScore = c.centeringScore ?? c.gradeCentering ?? null;
      const cornersScore   = c.cornersScore   ?? c.gradeCorners   ?? null;
      const edgesScore     = c.edgesScore     ?? c.gradeEdges     ?? null;
      const surfaceScore   = c.surfaceScore   ?? c.gradeSurface   ?? null;
      const overallGrade   = c.gradeOverall   ?? null;
      const missing: string[] = [];
      if (centeringScore == null) missing.push("centering");
      if (cornersScore   == null) missing.push("corners");
      if (edgesScore     == null) missing.push("edges");
      if (surfaceScore   == null) missing.push("surface");
      if (missing.length > 0) {
        return res.status(422).json({
          error: `Set all four subgrades before generating description. Missing: ${missing.join(", ")}`,
        });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

      // Confirmed defects (admin-curated). Skip ai_defect_candidates — those
      // are unconfirmed suggestions.
      const defects = Array.isArray(c.defects) ? c.defects as Array<Record<string, unknown>> : [];
      const defectLines = defects.length === 0
        ? "none"
        : defects.map((d) => {
            const loc = d.location || d.image_side || "front";
            const type = d.type || "defect";
            const sev = d.severity || "minor";
            return `${loc} ${type} (${sev})`;
          }).join("; ");

      const overallLabel = typeof overallGrade === "number" || (typeof overallGrade === "string" && /^\d/.test(overallGrade))
        ? gradeLabel(typeof overallGrade === "number" ? overallGrade : parseFloat(String(overallGrade)))
        : (overallGrade || "—");

      const certIdStr = normalizeCertId(cert.certId);
      const cardName  = c.cardName  || "Unknown card";
      const setName   = c.setName   || "Unknown set";
      const cardNumber = c.cardNumber || "";
      const year      = c.year      || "";
      const variant   = c.variant   || "";
      const language  = c.language  || "English";

      const prompt = `Write a professional grading description for this trading card. Output 3–5 sentences in this structure: (1) one-line card identification, (2) per-zone observations for centering / corners / edges / surface using the supplied subgrades and defects, (3) a closing summary sentence. Use precise, neutral grading language. Do NOT invent defects not in the input. Do NOT include the certificate number. Output plain text only — no markdown, no headings, no bullets.

Card: ${cardName} — ${setName}${cardNumber ? ` — #${cardNumber}` : ""}${year ? ` — ${year}` : ""}${variant ? ` (${variant})` : ""} (${language})
Overall grade: ${overallGrade ?? "—"} (${overallLabel})
Subgrades: Centering ${centeringScore}, Corners ${cornersScore}, Edges ${edgesScore}, Surface ${surfaceScore}
Defects (admin-confirmed): ${defectLines}`;

      const body = {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      };

      let anthRes: Response;
      try {
        anthRes = await anthropicFetch(body, { apiKey, timeoutMs: 60_000 });
      } catch (err: any) {
        return res.status(502).json({ error: `Claude API call failed: ${err.message}` });
      }
      if (!anthRes.ok) {
        const errText = await anthRes.text();
        return res.status(502).json({ error: `Claude API error ${anthRes.status}: ${errText.slice(0, 200)}` });
      }
      const data = await anthRes.json() as Record<string, unknown>;
      const content = data.content as Array<{ type: string; text?: string }> | undefined;
      const textBlock = content?.find(b => b.type === "text");
      const description = (textBlock?.text || "").trim();
      if (!description) {
        return res.status(502).json({ error: "Claude returned empty description" });
      }

      // Cost estimate (Haiku 4.5: $1/M input, $5/M output)
      const usage = (data.usage as any) || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const costUsd = (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 5;
      const costGbp = costUsd * 0.79;

      // Persist + audit
      await db.execute(sql`
        UPDATE certificates SET
          grade_explanation = ${description},
          updated_at = NOW()
        WHERE id = ${id}
      `);
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES (
          'certificate',
          ${String(id)},
          'generate_description',
          ${(req as any).adminUser?.email || 'admin'},
          ${JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            cost_estimate_gbp: Number(costGbp.toFixed(4)),
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cert_id: certIdStr,
            override: false,
          })}::jsonb,
          NOW()
        )
      `);

      console.log(`[generate-description] ${certIdStr}: wrote ${description.length} chars (£${costGbp.toFixed(4)})`);
      res.json({ description, costEstimate: Number(costGbp.toFixed(4)) });
    } catch (err: any) {
      console.error("[generate-description] error:", err.message);
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
        centeringFrontLr:    c.centeringFrontLr    || null,
        centeringFrontTb:    c.centeringFrontTb    || null,
        centeringBackLr:     c.centeringBackLr     || null,
        centeringBackTb:     c.centeringBackTb     || null,
        centeringOuterFront: c.centeringOuterFront || null,
        centeringInnerFront: c.centeringInnerFront || null,
        centeringOuterBack:  c.centeringOuterBack  || null,
        centeringInnerBack:  c.centeringInnerBack  || null,
        centeringMethod:     c.centeringMethod     || null,
        // Per-zone JSONB columns (now exposed via schema — was returning null
        // pre-v408 because Drizzle didn't know about these columns).
        corners: c.cornerValues  || null,
        edges:   c.edgeValues    || null,
        surface: c.surfaceValues || null,
        defects: c.defects       || [],
        authStatus:       c.authStatus       || "genuine",
        authNotes:        c.authNotes        || "",
        gradeExplanation: c.gradeExplanation || "",
        privateNotes:     c.privateNotes     || "",
        gradeApprovedBy:  c.gradeApprovedBy  || null,
        gradeApprovedAt:  c.gradeApprovedAt  || null,
        gradeStrengthScore: c.gradeStrengthScore ?? null,
        // MVGS admin inputs — hydrated into grading-panel local state on load.
        darkBorder:        !!c.darkBorder,
        eyeAppealModifier: Number(c.eyeAppealModifier ?? 0) || 0,
        // Saved aggregate subgrades for hydration on reload. Field names below
        // come straight from the schema (gradeCorners/gradeEdges/gradeSurface
        // map to corners_score/edges_score/surface_score). Pre-v408 the
        // handler accessed c.cornersScore (undefined — no such schema field),
        // falling through to (c as any).corners_score (also undefined since
        // Drizzle returns camelCase JS keys, not snake_case), so scores never
        // round-tripped on reload.
        centeringScore: c.gradeCentering ?? null,
        cornersScore:   c.gradeCorners   ?? null,
        edgesScore:     c.gradeEdges     ?? null,
        surfaceScore:   c.gradeSurface   ?? null,
        grade:          c.gradeOverall   ?? null,
        aiDraftGrade:   c.aiDraftGrade   ?? null,
        // Full AI analysis JSONB — under Option B this only contains the
        // identification payload (no `grading` key on new scans). Legacy
        // certs may still have `grading` here; the client ignores it.
        aiAnalysis:     c.aiAnalysis     ?? (c as any).ai_analysis     ?? null,
        // Option B: Haiku-suggested defects from scan-ingest, awaiting admin
        // confirm/reject. Distinct from the persisted `defects` array.
        aiDefectCandidates: c.aiDefectCandidates ?? (c as any).ai_defect_candidates ?? [],
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
      const parsedOverall = parseFloat(overallGrade);
      const gradeNum = isNonNum ? null : (isNaN(parsedOverall) ? null : parsedOverall);

      // P0 preservation helpers — return null when payload field is missing/empty/invalid,
      // so the SQL COALESCE below falls through to the existing column value.
      // (Prior `parseFloat(x) || null` idiom silently nulled rows on partial saves.)
      const num = (v: unknown): number | null => {
        if (v == null || v === "") return null;
        const n = typeof v === "number" ? v : parseFloat(String(v));
        return isNaN(n) ? null : n;
      };
      const txt = (v: unknown): string | null => (v == null || v === "") ? null : String(v);
      const jsn = (v: unknown): string | null => v != null ? JSON.stringify(v) : null;

      // Strength score is calibrated to the AI's overall grade. If the admin
      // changes the grade manually here, the AI-derived score is stale and
      // must be cleared. fmt() normalises 9 vs 9.0 vs null cleanly.
      const fmt = (n: number | null) => n == null ? "" : n.toFixed(1);
      const oldGradeNum = (cert as any).gradeOverall != null
        ? parseFloat(String((cert as any).gradeOverall))
        : null;
      const gradeChanged = fmt(gradeNum) !== fmt(oldGradeNum);

      // Track approval state pre-write for the audit trail. Edits to an
      // already-approved cert are LIVE-RECORD edits — same SQL path,
      // different audit_log action so we can analyse post-launch which
      // certs got changed after publication.
      const wasApproved = (cert as any).gradeApprovedAt != null;

      await db.execute(sql`
        UPDATE certificates SET
          centering_front_lr  = COALESCE(${txt(b.centering_front_lr)}, centering_front_lr),
          centering_front_tb  = COALESCE(${txt(b.centering_front_tb)}, centering_front_tb),
          centering_back_lr   = COALESCE(${txt(b.centering_back_lr)},  centering_back_lr),
          centering_back_tb   = COALESCE(${txt(b.centering_back_tb)},  centering_back_tb),
          centering_score     = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(b.grade_centering)}::numeric, centering_score)`},
          corners_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(b.grade_corners)}::numeric,   corners_score)`},
          edges_score         = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(b.grade_edges)}::numeric,     edges_score)`},
          surface_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${num(b.grade_surface)}::numeric,   surface_score)`},
          grade               = ${isNonNum ? sql`NULL` : sql`COALESCE(${gradeNum}::numeric, grade)`},
          grade_type          = ${isNonNum ? (overallGrade === "AA" ? "authentic_altered" : "not_original") : "numeric"},
          grade_strength_score = ${gradeChanged ? sql`NULL` : sql`grade_strength_score`},
          corner_values       = COALESCE(${jsn(b.corners)}::jsonb, corner_values),
          edge_values         = COALESCE(${jsn(b.edges)}::jsonb,   edge_values),
          surface_values      = COALESCE(${jsn(b.surface)}::jsonb, surface_values),
          defects             = COALESCE(${jsn(b.defects)}::jsonb, defects),
          ai_defect_candidates = ${
            // Overwriteable — client is source of truth for confirm/reject state.
            // Skip when key absent (legacy clients); apply when present (incl. []).
            Array.isArray(b.ai_defect_candidates)
              ? sql`${JSON.stringify(b.ai_defect_candidates)}::jsonb`
              : sql`ai_defect_candidates`
          },
          auth_status         = ${b.auth_status || "genuine"},
          auth_notes          = COALESCE(${txt(b.auth_notes)},        auth_notes),
          grade_explanation   = COALESCE(${txt(b.grade_explanation)}, grade_explanation),
          private_notes       = COALESCE(${txt(b.private_notes)},     private_notes),
          dark_border         = ${
            typeof b.dark_border === "boolean" ? b.dark_border : sql`dark_border`
          },
          eye_appeal_modifier = ${
            // Clamp ±2 server-side; ignore non-finite payloads.
            (() => {
              const n = Number(b.eye_appeal_modifier);
              if (!Number.isFinite(n)) return sql`eye_appeal_modifier`;
              const clamped = Math.max(-2, Math.min(2, Math.trunc(n)));
              return sql`${clamped}`;
            })()
          },
          updated_at          = NOW()
        WHERE id = ${id}
      `);

      // Audit — distinguish draft saves from post-approve live-record edits.
      // Both fire the same SQL above, but the audit trail captures the
      // semantic difference: pre-launch we want to know what % of certs
      // get edited after publication, and which fields.
      //
      // Diff capture: compare payload values against the cert state read at
      // the top of this handler. Only fields the payload actually carries
      // (and that differ from the prior DB value) appear in `changed`. JSONB
      // columns (corners/edges/surface/defects/ai_defect_candidates) are
      // compared by JSON.stringify so a no-op re-submit doesn't pollute the
      // log.
      try {
        const fieldsChanged = Object.keys(b || {});
        // Mapping: payload key (snake_case) → cert column accessor (camelCase from Drizzle).
        const fieldMap: Array<[string, string]> = [
          ["overall_grade",       "gradeOverall"],
          ["grade_centering",     "gradeCentering"],
          ["grade_corners",       "gradeCorners"],
          ["grade_edges",         "gradeEdges"],
          ["grade_surface",       "gradeSurface"],
          ["centering_front_lr",  "centeringFrontLr"],
          ["centering_front_tb",  "centeringFrontTb"],
          ["centering_back_lr",   "centeringBackLr"],
          ["centering_back_tb",   "centeringBackTb"],
          ["auth_status",         "authStatus"],
          ["auth_notes",          "authNotes"],
          ["grade_explanation",   "gradeExplanation"],
          ["private_notes",       "privateNotes"],
          ["corners",             "cornerValues"],
          ["edges",               "edgeValues"],
          ["surface",             "surfaceValues"],
          ["defects",             "defects"],
          ["ai_defect_candidates", "aiDefectCandidates"],
        ];
        const norm = (v: unknown) => v == null ? null : (typeof v === "object" ? JSON.stringify(v) : String(v));
        const changed: Record<string, { from: unknown; to: unknown }> = {};
        for (const [pKey, cKey] of fieldMap) {
          if (!(pKey in (b || {}))) continue;
          const before = norm((cert as any)[cKey]);
          const after  = norm((b as any)[pKey]);
          if (before !== after) {
            changed[pKey] = { from: (cert as any)[cKey] ?? null, to: (b as any)[pKey] ?? null };
          }
        }
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
          VALUES (
            'certificate',
            ${String(id)},
            ${wasApproved ? "cert_live_record_edit" : "draft_save"},
            ${(req.session as any)?.adminEmail || "admin"},
            ${JSON.stringify({ fields_changed: fieldsChanged, changed, was_approved: wasApproved })}::jsonb,
            NOW()
          )
        `);
      } catch (auditErr: any) {
        // Don't fail the save if audit insert fails — log and continue.
        console.warn("[grade] audit_log insert failed:", auditErr.message);
      }

      res.json({ ok: true, wasApproved });
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

      // P0 preservation helpers — see /grade handler for rationale.
      const num = (v: unknown): number | null => {
        if (v == null || v === "") return null;
        const n = typeof v === "number" ? v : parseFloat(String(v));
        return isNaN(n) ? null : n;
      };
      const txt = (v: unknown): string | null => (v == null || v === "") ? null : String(v);
      const jsn = (v: unknown): string | null => v != null ? JSON.stringify(v) : null;

      const gradeNum       = isNonNum ? null : num(overallGrade);
      const sentCentering  = isNonNum ? null : num(b.grade_centering);
      const sentCorners    = isNonNum ? null : num(b.grade_corners);
      const sentEdges      = isNonNum ? null : num(b.grade_edges);
      const sentSurface    = isNonNum ? null : num(b.grade_surface);

      // Grading time (admin opens the grading workstation → clicks Approve).
      // Capped at 1800s (30 min) to keep the dashboard average representative —
      // anything longer is almost certainly a coffee break / tab left open.
      const rawTime = Number(b.grading_time_seconds);
      const clampedTime = Number.isFinite(rawTime) && rawTime > 0
        ? Math.min(1800, Math.round(rawTime))
        : null;

      // Final state for label_type computation: payload value if present, else existing.
      // SQL COALESCE will produce the same final state in DB; we mirror it here so
      // label_type reflects what's actually saved when a partial payload comes in.
      const finalCentering = sentCentering ?? num(cert.gradeCentering);
      const finalCorners   = sentCorners   ?? num(cert.gradeCorners);
      const finalEdges     = sentEdges     ?? num(cert.gradeEdges);
      const finalSurface   = sentSurface   ?? num(cert.gradeSurface);

      // Strength score is calibrated to the AI's overall grade. If the admin
      // changes the grade manually here, the AI-derived score is stale and
      // must be cleared. fmt() normalises 9 vs 9.0 vs null cleanly.
      const fmt = (n: number | null) => n == null ? "" : n.toFixed(1);
      const oldGradeNum = (cert as any).gradeOverall != null
        ? parseFloat(String((cert as any).gradeOverall))
        : null;
      const gradeChanged = fmt(gradeNum) !== fmt(oldGradeNum);

      // Compute Black Label: all subgrades must be exactly 10.0
      const allTen = !isNonNum && gradeNum === 10 &&
        finalCentering === 10 && finalCorners === 10 && finalEdges === 10 && finalSurface === 10;
      const labelType = allTen ? "black" : "Standard";
      const gradeType = isNonNum ? (overallGrade === "AA" ? "authentic_altered" : "not_original") : "numeric";

      await db.execute(sql`
        UPDATE certificates SET
          grade               = ${gradeNum},
          grade_type          = ${gradeType},
          centering_score     = ${isNonNum ? sql`NULL` : sql`COALESCE(${sentCentering}::numeric, centering_score)`},
          corners_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${sentCorners}::numeric,   corners_score)`},
          edges_score         = ${isNonNum ? sql`NULL` : sql`COALESCE(${sentEdges}::numeric,     edges_score)`},
          surface_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${sentSurface}::numeric,   surface_score)`},
          grade_strength_score = ${gradeChanged ? sql`NULL` : sql`grade_strength_score`},
          centering_front_lr  = COALESCE(${txt(b.centering_front_lr)}, centering_front_lr),
          centering_front_tb  = COALESCE(${txt(b.centering_front_tb)}, centering_front_tb),
          centering_back_lr   = COALESCE(${txt(b.centering_back_lr)},  centering_back_lr),
          centering_back_tb   = COALESCE(${txt(b.centering_back_tb)},  centering_back_tb),
          corner_values       = COALESCE(${jsn(b.corners)}::jsonb, corner_values),
          edge_values         = COALESCE(${jsn(b.edges)}::jsonb,   edge_values),
          surface_values      = COALESCE(${jsn(b.surface)}::jsonb, surface_values),
          defects             = COALESCE(${jsn(b.defects)}::jsonb, defects),
          auth_status         = ${b.auth_status || "genuine"},
          auth_notes          = COALESCE(${txt(b.auth_notes)},        auth_notes),
          grade_explanation   = COALESCE(${txt(b.grade_explanation)}, grade_explanation),
          private_notes       = COALESCE(${txt(b.private_notes)},     private_notes),
          label_type          = ${labelType},
          grade_approved_by   = ${"Cornelius Oliver"},
          grade_approved_at   = NOW(),
          status              = 'active',
          grading_time_seconds = COALESCE(${clampedTime}::int, grading_time_seconds),
          updated_at          = NOW()
        WHERE id = ${id}
      `);

      // Log to grading_sessions. grading_duration_seconds also feeds the
      // existing /api/admin/learning/overview avg_seconds metric — finally
      // populating it after months of empty "—".
      try {
        await db.execute(sql`
          INSERT INTO grading_sessions (cert_id, completed_at, grader, final_grade, ai_response, notes, model_version, grading_duration_seconds)
          VALUES (
            ${cert.certId},
            NOW(),
            ${"Cornelius Oliver"},
            ${gradeNum},
            ${b.defects ? JSON.stringify(b.defects) : null}::jsonb,
            ${b.private_notes || null},
            'claude-opus-4-7',
            ${clampedTime}
          )
        `);
      } catch (sessionErr) {
        console.warn("[approve] grading_sessions insert failed:", sessionErr);
      }

      // Track whether this approval was AI-drafted (cert had `ai_draft_grade`
      // populated by Option-A scan-ingest before the admin clicked approve).
      // Useful post-launch metric: "what % of certs ship untouched-from-AI?"
      const wasAiDrafted = (cert as any).aiDraftGrade != null;
      await storage.writeAuditLog("certificate", cert.certId, "approve_and_publish", req.session.adminEmail || "admin", {
        overall: overallGrade,
        labelType,
        was_ai_drafted: wasAiDrafted,
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
              ${finalCentering != null ? Math.round(finalCentering) : null},
              ${finalCorners   != null ? Math.round(finalCorners)   : null},
              ${finalEdges     != null ? Math.round(finalEdges)     : null},
              ${finalSurface   != null ? Math.round(finalSurface)   : null},
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
        SELECT id, certificate_number AS cert_id, card_name, set_name, card_game,
               issued_at AS created_at,
               grade_approved_at,
               (front_image_path IS NOT NULL OR grading_front_original IS NOT NULL) AS has_images
        FROM certificates
        WHERE status = 'active' AND deleted_at IS NULL AND grade_approved_at IS NULL
        ORDER BY issued_at ASC
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
        SELECT certificate_number FROM certificates WHERE status = 'active' AND deleted_at IS NULL AND grade_approved_at IS NULL ORDER BY issued_at ASC LIMIT 1
      `);
      const first = rows.rows?.[0] as any;
      res.json({ certId: first ? normalizeCertId(first.certificate_number) : null });
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
    const uploadUrl = `${process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS}` : "https://mintvaultuk.com"}/upload/${certId}/${imageType}?token=${token}`;
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
        const rows = await db.execute(sql`SELECT * FROM certificates WHERE status = 'active' AND deleted_at IS NULL AND grade_approved_at IS NULL ORDER BY created_at ASC LIMIT 1`);
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
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_CENTERING_ENABLED"))) {
        return res.status(503).json({ error: "AI centering measurement is disabled" });
      }
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
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_STANDALONE_DETECT_ENABLED"))) {
        return res.status(503).json({ error: "AI defect detection is disabled" });
      }
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
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_STANDALONE_GRADE_ENABLED"))) {
        return res.status(503).json({ error: "AI grade-card is disabled" });
      }
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

  // POST /api/admin/certificates/:id/identify
  // Standalone Identify (Haiku + GPT consensus + TCG API). Populates ONLY
  // card metadata (card_name, set_name, card_number_display, rarity,
  // year_text, card_game). Does not touch any grade columns. Gated on
  // AI_IDENTIFY_ENABLED — returns 403 with a clear message when OFF so the
  // UI can render the disabled-state tooltip.
  app.post("/api/admin/certificates/:id/identify", requireAdmin, async (req, res) => {
    try {
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_IDENTIFY_ENABLED"))) {
        return res.status(403).json({ error: "AI Identify is disabled — enable it in /admin → AI Learning" });
      }

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image — upload images first" });

      let frontBuf: Buffer;
      try {
        const url = await getR2SignedUrl(frontKey, 300);
        const resp = await fetch(url);
        frontBuf = Buffer.from(await resp.arrayBuffer());
      } catch { return res.status(400).json({ error: "Could not fetch front image" }); }

      // Haiku identify + GPT consensus
      const rawId = await identifyCardFromBuffer(frontBuf, "image/jpeg", id);

      // Lookup-table verify, then Pokémon TCG API on top (same logic as
      // /identify-only — kept inline rather than extracted because the two
      // routes have slightly different response shapes).
      let enrichedId = await verifyAndEnrichCardData(rawId);
      const game = rawId.detected_game?.toLowerCase();
      let tcgResult: any = { verified: false };
      if (game === "pokemon") {
        tcgResult = await verifyPokemonCardWithTcgApi(rawId.detected_name, rawId.detected_number, rawId.detected_rarity, rawId.set_code, rawId.copyright_year);
        if (tcgResult.verified) {
          const enrichedAlreadyVerified = enrichedId.verified === true;
          const namesAgree = !tcgResult.officialCardName || !enrichedId.officialName ||
            normaliseCardName(tcgResult.officialCardName) === normaliseCardName(enrichedId.officialName);
          if (!enrichedAlreadyVerified || namesAgree) {
            enrichedId = {
              ...enrichedId, verified: true,
              officialName:   tcgResult.officialCardName || enrichedId.officialName,
              officialSet:    tcgResult.officialSetName  || enrichedId.officialSet,
              officialNumber: rawId.detected_number,
              referenceImageUrl: tcgResult.referenceImageUrl || enrichedId.referenceImageUrl,
              dbSource:       "pokemon-tcg-api",
              detected_set:   tcgResult.officialSetName || enrichedId.detected_set,
              detected_rarity: tcgResult.officialRarity || enrichedId.detected_rarity,
              detected_year:  tcgResult.officialYear   || enrichedId.detected_year,
            };
          }
        }
      }

      const aiConfidence = rawId.confidence || "low";
      const verified = enrichedId.verified === true || tcgResult.verified === true;
      const trustAi = tcgResult.trustAi === true;
      const shouldWrite = verified || aiConfidence === "high" || trustAi;

      const cardName   = shouldWrite ? (enrichedId.officialName || enrichedId.detected_name || null) : null;
      const setName    = verified ? (enrichedId.officialSet || enrichedId.detected_set || null) : null;
      const cardNumber = shouldWrite ? (enrichedId.detected_number || null) : null;
      const cardGame   = shouldWrite ? (enrichedId.detected_game || null) : null;
      const rarity     = shouldWrite ? (enrichedId.detected_rarity || null) : null;
      const rawYear    = rawId.copyright_year || enrichedId.detected_year || null;
      const yearMatch  = rawYear ? String(rawYear).match(/\d{4}/) : null;
      const yearText   = yearMatch ? yearMatch[0] : null;
      const language   = (enrichedId as any).detected_language || null;
      const overwrite  = verified || aiConfidence === "high";

      let updatedFields: string[] = [];
      if (shouldWrite) {
        if (overwrite) {
          await db.execute(sql`
            UPDATE certificates SET
              card_name           = COALESCE(${cardName},   card_name),
              set_name            = COALESCE(${setName},    set_name),
              card_number_display = COALESCE(${cardNumber}, card_number_display),
              year_text           = COALESCE(${yearText},   year_text),
              card_game           = COALESCE(${cardGame},   card_game),
              rarity              = COALESCE(${rarity},     rarity),
              language            = COALESCE(${language},   language),
              updated_at = NOW()
            WHERE id = ${id}
          `);
        } else {
          await db.execute(sql`
            UPDATE certificates SET
              card_name           = CASE WHEN card_name IS NULL OR card_name = '' OR card_name = '(untitled)' OR card_name = '(pending)' THEN ${cardName} ELSE card_name END,
              set_name            = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
              card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
              year_text           = CASE WHEN year_text IS NULL OR year_text = '' THEN ${yearText} ELSE year_text END,
              card_game           = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
              rarity              = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
              language            = CASE WHEN language IS NULL OR language = '' THEN ${language} ELSE language END,
              updated_at = NOW()
            WHERE id = ${id}
          `);
        }
        updatedFields = ["card_name","set_name","card_number_display","year_text","card_game","rarity","language"].filter(f => {
          const v: Record<string,unknown> = { card_name: cardName, set_name: setName, card_number_display: cardNumber, year_text: yearText, card_game: cardGame, rarity, language };
          return v[f] != null && v[f] !== "";
        });
      }

      // Audit
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, details)
          VALUES ('certificate', ${String(id)}, 'ai_identify',
            ${JSON.stringify({ fields_updated: updatedFields, source: "manual_button", confidence: aiConfidence, tcgVerified: verified })}::jsonb)
        `);
      } catch (e: any) { console.warn("[ai/identify] audit failed:", e.message); }

      console.log(`[ai/identify] cert=${id} confidence=${aiConfidence} tcgVerified=${verified} fields=${updatedFields.join(",")}`);
      res.json({
        card_name:   cardName,
        set_name:    setName,
        card_number: cardNumber,
        year:        yearText,
        rarity,
        set_id:      (enrichedId as any).set_code || rawId.set_code || null,
        language,
        confidence:  aiConfidence,
        verified,
        detailsWritten: shouldWrite,
      });
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("AI_IDENTIFY_ENABLED=false")) {
        return res.status(403).json({ error: "AI Identify is disabled — enable it in /admin → AI Learning" });
      }
      console.error("[ai/identify] error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/admin/certificates/:id/grade
  // Standalone Full Grade (Opus 4.7 via analyzeCardFromBuffers). Populates
  // ONLY grade columns (centering_score, corners_score, edges_score,
  // surface_score, grade, ai_draft_grade). Does not touch card metadata.
  // Gated on AI_FULL_GRADE_ENABLED.
  app.post("/api/admin/certificates/:id/grade", requireAdmin, async (req, res) => {
    try {
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_FULL_GRADE_ENABLED"))) {
        return res.status(403).json({ error: "AI Full Grade is disabled — enable it in /admin → AI Learning" });
      }

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const frontKey = c.gradingFrontOriginal || c.frontImagePath;
      const backKey  = c.gradingBackOriginal  || c.backImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image — upload images first" });

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

      // Generate variants (cropped buffer is what analyzeCardFromBuffers wants).
      // Use the same Buffer-allowlist pattern fixed in 5c1ca8c — never iterate
      // generateImageVariants's full return shape (it includes non-Buffer
      // diagnostic fields cropGeometry/matRgb).
      const frontVariants = await generateImageVariants(frontRaw, id);
      const backVariants = backRaw ? await generateImageVariants(backRaw, id) : null;

      const cardGame = (c.cardGame || "").toLowerCase() || undefined;
      const analysis = await analyzeCardFromBuffers(
        frontVariants.cropped,
        backVariants?.cropped || null,
        cardGame,
        id,
      );

      const cents   = typeof analysis.centering?.subgrade === "number" ? analysis.centering.subgrade : null;
      const corners = typeof analysis.corners?.subgrade   === "number" ? analysis.corners.subgrade   : null;
      const edges   = typeof analysis.edges?.subgrade     === "number" ? analysis.edges.subgrade     : null;
      const surface = typeof analysis.surface?.subgrade   === "number" ? analysis.surface.subgrade   : null;
      const overall = typeof analysis.overall_grade       === "number" ? analysis.overall_grade     : null;
      const strength = typeof (analysis as any).grade_strength_score === "number"
        ? Math.max(0, Math.min(100, Math.round((analysis as any).grade_strength_score)))
        : null;

      await db.execute(sql`
        UPDATE certificates SET
          ai_analysis           = jsonb_set(COALESCE(ai_analysis, '{}'::jsonb), '{grading}', ${JSON.stringify(analysis)}::jsonb),
          ai_draft_grade        = ${overall},
          centering_score       = ${cents},
          corners_score         = ${corners},
          edges_score           = ${edges},
          surface_score         = ${surface},
          grade_strength_score  = ${strength},
          updated_at            = NOW()
        WHERE id = ${id}
      `);

      // Audit
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, details)
          VALUES ('certificate', ${String(id)}, 'ai_grade',
            ${JSON.stringify({ subgrades: { centering: cents, corners, edges, surface }, overall, model_used: "claude-opus-4-7", source: "manual_button" })}::jsonb)
        `);
      } catch (e: any) { console.warn("[ai/grade] audit failed:", e.message); }

      console.log(`[ai/grade] cert=${id} centering=${cents} corners=${corners} edges=${edges} surface=${surface} overall=${overall} strength=${strength}`);
      res.json({
        centering: cents,
        corners,
        edges,
        surface,
        overall,
        grade_label: analysis.grade_label || null,
        grade_strength_score: strength,
      });
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("AI_FULL_GRADE_ENABLED=false")) {
        return res.status(403).json({ error: "AI Full Grade is disabled — enable it in /admin → AI Learning" });
      }
      console.error("[ai/grade] error:", msg);
      res.status(500).json({ error: msg });
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

      // Step 3: Upload all variants to R2 — explicit allowlist (skips
      // generateImageVariants's non-Buffer fields like cropGeometry/matRgb,
      // which were added in commit 6b7ce9f and broke Object.entries()-based
      // iteration with TypeError "Received an instance of Object")
      const prefix = `images/grading/${id}`;
      const uploadKeys: Record<string, string> = {};
      const uploads: Promise<void>[] = [];
      const jpgVariants = ["original", "cropped", "greyscale", "highcontrast", "edgeenhanced", "inverted"] as const;

      for (const vName of jpgVariants) {
        const buf = (frontVariants as any)[vName] as Buffer | undefined;
        if (!Buffer.isBuffer(buf)) continue;
        const k = `${prefix}/front_${vName}.jpg`;
        uploadKeys[`front_${vName}`] = k;
        uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
      }
      if (backVariants) {
        for (const vName of jpgVariants) {
          const buf = (backVariants as any)[vName] as Buffer | undefined;
          if (!Buffer.isBuffer(buf)) continue;
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
      const origin = (req.headers.origin as string) || APP_BASE_URL;
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
      const { getFeatureFlag } = await import("./config/feature-flags");
      if (!(await getFeatureFlag("AI_PUBLIC_ESTIMATE_ENABLED"))) {
        return res.status(503).json({ error: "AI Pre-Grade tool is temporarily paused. Please try again later." });
      }
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
            console.error(`[scan-ingest] AI failed for ${certInfo.certId} (sync): ${aiErr?.message || aiErr}\n${aiErr?.stack || "(no stack)"}`);
            res.json({
              certId: certInfo.certId,
              dbId: certInfo.id,
              workstationUrl: `/admin#grading-${certInfo.id}`,
              aiStatus: "failed",
              aiError: aiErr?.message || String(aiErr),
              message: `Certificate ${certInfo.certId} created but AI grading failed. Retry from workstation.`,
            });
          }
        } else {
          // Watcher script / admin UI — respond immediately, AI runs in background
          const aiPromise = runAiOnCert(certInfo.id, frontVariants.cropped, backVariants?.cropped || null)
            .then(r => console.log(`[scan-ingest] AI done for ${certInfo!.certId}: grade=${r.grade}`))
            .catch(e => console.error(`[scan-ingest] AI failed for ${certInfo!.certId} (async): ${e?.message || e}\n${e?.stack || "(no stack)"}`));

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

  // ── AI feature flags (DB-backed runtime overrides) ───────────────────────
  // Admin can flip any of the 10 AI flags at runtime without redeploying.
  // Override write also drops the in-memory cache so the change takes effect
  // on the very next AI call instead of waiting out the 30s TTL.

  app.get("/api/admin/ai-feature-flags", requireAdmin, async (_req, res) => {
    try {
      const { getAllAiFlags, AI_FLAG_NAMES } = await import("./config/feature-flags");
      const { featureOverrides } = await import("@shared/schema");
      const flags = await getAllAiFlags();

      // Pull last-toggled metadata per flag from feature_overrides so the
      // dashboard can show "set by X at Y, reason Z" alongside each row.
      // Use Drizzle's inArray() — pg's wire protocol won't accept a raw JS
      // array bound to ANY(...) without a column-type cast, and inArray
      // emits standard `IN (?, ?, ...)` which always works.
      const meta = await db.select({
        name: featureOverrides.name,
        updatedAt: featureOverrides.updatedAt,
        updatedBy: featureOverrides.updatedBy,
        reason: featureOverrides.reason,
      }).from(featureOverrides).where(inArray(featureOverrides.name, AI_FLAG_NAMES as unknown as string[]));
      const metaByName = new Map<string, any>();
      for (const r of meta) metaByName.set(r.name, r);

      res.json({
        flags: flags.map(f => ({
          ...f,
          updatedAt: metaByName.get(f.name)?.updatedAt || null,
          updatedBy: metaByName.get(f.name)?.updatedBy || null,
          reason:    metaByName.get(f.name)?.reason    || null,
        })),
      });
    } catch (err: any) {
      console.error("[ai-feature-flags] GET failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/ai-feature-flags", requireAdmin, async (req, res) => {
    try {
      const { AI_FLAG_NAMES, invalidateFeatureFlagCache } = await import("./config/feature-flags");
      const { name, enabled, reason } = req.body || {};
      if (!AI_FLAG_NAMES.includes(name)) {
        return res.status(400).json({ error: "Unknown flag name" });
      }
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be boolean" });
      }
      const adminEmail = req.session.adminEmail || "admin";
      await db.execute(sql`
        INSERT INTO feature_overrides (name, enabled, updated_at, updated_by, reason)
        VALUES (${name}, ${enabled}, NOW(), ${adminEmail}, ${reason || null})
        ON CONFLICT (name) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by,
          reason = EXCLUDED.reason
      `);
      invalidateFeatureFlagCache();
      await storage.writeAuditLog("feature_flag", name, "override_set", adminEmail, { enabled, reason: reason || null });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ai-feature-flags] POST failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/admin/ai-feature-flags/:name", requireAdmin, async (req, res) => {
    try {
      const { AI_FLAG_NAMES, invalidateFeatureFlagCache } = await import("./config/feature-flags");
      const name = String(req.params.name);
      if (!AI_FLAG_NAMES.includes(name as any)) {
        return res.status(400).json({ error: "Unknown flag name" });
      }
      const adminEmail = req.session.adminEmail || "admin";
      await db.execute(sql`DELETE FROM feature_overrides WHERE name = ${name}`);
      invalidateFeatureFlagCache();
      await storage.writeAuditLog("feature_flag", name, "override_cleared", adminEmail, {});
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ai-feature-flags] DELETE failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI dashboard stats — single endpoint feeding the AI Learning page ────
  // Combines top-line cert stats with the new ai_predictions accuracy view so
  // the dashboard makes one fetch on load instead of fanning out to four.

  app.get("/api/admin/ai-dashboard-stats", requireAdmin, async (_req, res) => {
    try {
      // Top-line cert metrics (only approved/published certs).
      const top = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                     AS total_graded,
          COUNT(*) FILTER (WHERE DATE_TRUNC('month', grade_approved_at) = DATE_TRUNC('month', NOW()))::int AS this_month,
          ROUND(AVG(grade)::numeric, 2)                                     AS average_grade,
          ROUND(AVG(grading_time_seconds)::numeric, 0)::int                 AS avg_time_seconds,
          COUNT(*) FILTER (WHERE label_type = 'black')::int                 AS black_labels_count
        FROM certificates
        WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL
      `);
      const topRow = top.rows[0] || {};

      // Grade distribution (approved certs only).
      const dist = await db.execute(sql`
        SELECT grade::text AS grade, COUNT(*)::int AS count
        FROM certificates
        WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL AND grade IS NOT NULL
        GROUP BY grade
        ORDER BY grade DESC
      `);

      // Last-30-days activity, one row per day in the window even if zero.
      const activity = await db.execute(sql`
        SELECT TO_CHAR(d::date, 'YYYY-MM-DD') AS day,
               COALESCE(c.cnt, 0)::int AS count
        FROM generate_series(NOW() - INTERVAL '29 days', NOW(), INTERVAL '1 day') AS d
        LEFT JOIN (
          SELECT DATE(grade_approved_at) AS day, COUNT(*)::int AS cnt
          FROM certificates
          WHERE grade_approved_at >= NOW() - INTERVAL '30 days'
            AND deleted_at IS NULL
          GROUP BY day
        ) c ON DATE(d) = c.day
        ORDER BY day
      `);

      // AI accuracy from ai_predictions joined to approved certs. Only
      // quick_grade and full_grade rows have an `overall_grade` to compare,
      // so we restrict to those call_types. Returns null fields when
      // approved_count < 30 (statistical-significance threshold).
      const accuracy = await db.execute(sql`
        WITH preds AS (
          SELECT
            p.cert_id,
            COALESCE(
              (p.prediction->>'overall_grade')::numeric,
              (p.prediction->>'overall')::numeric
            ) AS predicted,
            c.grade::numeric AS actual
          FROM ai_predictions p
          JOIN certificates c ON c.certificate_number = p.cert_id
          WHERE p.call_type IN ('full_grade', 'quick_grade')
            AND c.grade_approved_at IS NOT NULL
            AND c.deleted_at IS NULL
            AND c.grade IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*) FROM ai_predictions WHERE call_type IN ('full_grade','quick_grade'))::int AS prediction_count,
          COUNT(*)::int                                                                        AS approved_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE predicted = actual) / NULLIF(COUNT(*), 0), 1)   AS exact_agreement_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(predicted - actual) <= 0.5) / NULLIF(COUNT(*), 0), 1) AS within_half_point_pct,
          ROUND(AVG(ABS(predicted - actual))::numeric, 2)                                      AS mean_absolute_error
        FROM preds
        WHERE predicted IS NOT NULL
      `);
      const accRow = (accuracy.rows[0] as any) || {};
      const approvedCount = Number(accRow.approved_count || 0);
      const aiAccuracy = approvedCount >= 30
        ? {
            prediction_count:      Number(accRow.prediction_count || 0),
            approved_count:        approvedCount,
            exact_agreement_pct:   accRow.exact_agreement_pct != null ? Number(accRow.exact_agreement_pct) : null,
            within_half_point_pct: accRow.within_half_point_pct != null ? Number(accRow.within_half_point_pct) : null,
            mean_absolute_error:   accRow.mean_absolute_error != null ? Number(accRow.mean_absolute_error) : null,
          }
        : {
            prediction_count:      Number(accRow.prediction_count || 0),
            approved_count:        approvedCount,
            exact_agreement_pct:   null,
            within_half_point_pct: null,
            mean_absolute_error:   null,
          };

      res.json({
        total_graded:       Number(topRow.total_graded || 0),
        this_month:         Number(topRow.this_month || 0),
        average_grade:      topRow.average_grade != null ? Number(topRow.average_grade) : null,
        avg_time_seconds:   topRow.avg_time_seconds != null ? Number(topRow.avg_time_seconds) : null,
        grade_distribution: dist.rows,
        black_labels_count: Number(topRow.black_labels_count || 0),
        ai_accuracy:        aiAccuracy,
        last_30_days:       activity.rows,
      });
    } catch (err: any) {
      console.error("[ai-dashboard-stats] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Manual cert-image attach + soft-delete + preview ─────────────────────
  // Surgical-repair endpoints for orphan-cert recovery (e.g. when scanner
  // pairing misses a back, or a misclick produces front-only). Designed to
  // be callable by:
  //   - admin web UI via session auth, AND
  //   - the local scanner-watcher via SCANNER_API_TOKEN header
  // (same dual-auth pattern as /api/admin/scan-ingest).
  //
  // Out of scope: variant generation (greyscale/highcontrast/etc). The
  // attach path writes only `grading_{side}_original`. Run /reprocess-images
  // afterward if variants are needed.

  const certImgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  // GET /preview — light metadata used by Manual Mode UI to confirm cert
  // exists and which side(s) are populated before uploading.
  // GET /api/admin/next-cert-id — read-only next-cert allocation.
  // Used by the scanner-app to display the upcoming MV number before a scan
  // arrives. Reservation is owned by the scan-ingest endpoint; this is just
  // a hint, hence the comment "may differ from final allocation if multiple
  // scans race". Skips soft-deleted rows so a deleted MV60 doesn't become
  // the predicted next when the real next is MV62.
  app.get("/api/admin/next-cert-id", requireScannerOrAdmin, async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT COALESCE(
          (SELECT MAX(NULLIF(regexp_replace(certificate_number, '[^0-9]', '', 'g'), '')::int)
             FROM certificates WHERE deleted_at IS NULL),
          0
        ) + 1 AS next_numeric
      `);
      const n = parseInt(String((r.rows[0] as any)?.next_numeric ?? 1), 10);
      res.json({ next: `MV${n}`, next_numeric: n });
    } catch (err: any) {
      console.error("[next-cert-id] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/orphan-certs — certs missing front and/or back image.
  // Used by the scanner-app's "Fix orphan…" picker. Limited to 50 newest.
  app.get("/api/admin/orphan-certs", requireScannerOrAdmin, async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT
          certificate_number AS cert_id,
          card_name,
          set_name,
          (grading_front_original IS NULL) AS missing_front,
          (grading_back_original  IS NULL) AS missing_back,
          issued_at,
          deleted_at
        FROM certificates
        WHERE deleted_at IS NULL
          AND (grading_front_original IS NULL OR grading_back_original IS NULL)
        ORDER BY issued_at DESC
        LIMIT 50
      `);
      res.json({
        orphans: r.rows.map((row: any) => ({
          certId:        row.cert_id,
          cardName:      row.card_name ?? null,
          set:           row.set_name ?? null,
          missingFront:  !!row.missing_front,
          missingBack:   !!row.missing_back,
          createdAt:     row.issued_at,
          deleted:       !!row.deleted_at,
        })),
      });
    } catch (err: any) {
      console.error("[orphan-certs] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/certs/:certId/preview", requireScannerOrAdmin, async (req, res) => {
    try {
      const certIdRaw = String(req.params.certId);
      const certId = normalizeCertId(certIdRaw);
      const r = await db.execute(sql`
        SELECT
          id,
          certificate_number,
          card_name,
          (grading_front_original IS NOT NULL) AS has_front,
          (grading_back_original  IS NOT NULL) AS has_back,
          grade::text AS grade_overall,
          grade_approved_at,
          deleted_at,
          status
        FROM certificates
        WHERE certificate_number = ${certId}
        LIMIT 1
      `);
      const row = r.rows[0] as any;
      if (!row) return res.status(404).json({ error: "cert not found", certId });
      res.json({
        cert_id:           row.certificate_number,
        internal_id:       row.id,
        card_name:         row.card_name ?? null,
        has_front:         !!row.has_front,
        has_back:          !!row.has_back,
        grade_overall:     row.grade_overall ?? null,
        grade_approved_at: row.grade_approved_at ?? null,
        deleted:           !!row.deleted_at,
        status:            row.status,
      });
    } catch (err: any) {
      console.error("[cert-preview] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /pop-report — population report for the current cert's card
  // (matched by card_name + set_name + card_number_display). Aggregates
  // all active, graded certs into a grade-frequency table for the admin
  // cert detail panel. Admin-only — admin can view voided/deleted certs,
  // but the AGGREGATE only includes active+published+graded so the
  // distribution reflects what the public sees.
  app.get("/api/admin/certs/:certId/pop-report", requireAdmin, async (req, res) => {
    try {
      const certIdRaw = String(req.params.certId);
      const certId = normalizeCertId(certIdRaw);

      const curRows = (await db.execute(sql`
        SELECT card_name, set_name, card_number_display, grade_type, grade::text AS grade_text
        FROM certificates
        WHERE certificate_number = ${certId}
        LIMIT 1
      `)).rows;
      if (curRows.length === 0) return res.status(404).json({ error: "cert not found", certId });
      const cur = curRows[0] as any;

      const cardName = cur.card_name as string | null;
      const setName = cur.set_name as string | null;
      const cardNumber = cur.card_number_display as string | null;

      // Format the current cert's grade label the same way we format
      // aggregated rows so the client can do a string match for highlight.
      const formatNumeric = (raw: string | null | undefined): string | null => {
        if (raw == null) return null;
        const n = parseFloat(raw);
        if (!Number.isFinite(n)) return null;
        return n % 1 === 0 ? String(Math.trunc(n)) : String(n);
      };
      const currentGrade: string | null =
        cur.grade_type === "numeric" ? formatNumeric(cur.grade_text) : (cur.grade_type ?? null);

      if (!cardName || !setName || !cardNumber) {
        return res.json({
          cert_id: certId,
          card: { name: cardName, set: setName, number: cardNumber },
          current_grade: currentGrade,
          total: 0,
          distribution: [],
          note: "cert is missing card_name / set_name / card_number_display — cannot aggregate",
        });
      }

      // Aggregate. Numeric grades collapse trailing zeros so "9.0" → "9"
      // and "10.0" → "10". Non-numeric grade_type values (NO/AA) flow
      // straight through as their own labels.
      const distRows = (await db.execute(sql`
        SELECT
          CASE
            WHEN grade_type = 'numeric' AND grade IS NOT NULL
              THEN trim(trailing '.' from rtrim(grade::text, '0'))
            ELSE grade_type
          END                                                       AS label,
          CASE WHEN grade_type = 'numeric' AND grade IS NOT NULL THEN 0 ELSE 1 END
                                                                    AS sort_class,
          CASE WHEN grade_type = 'numeric' THEN grade ELSE NULL END AS sort_num,
          COUNT(*)::int                                             AS count
        FROM certificates
        WHERE deleted_at IS NULL
          AND status IN ('active', 'published')
          AND grade_approved_at IS NOT NULL
          AND card_name = ${cardName}
          AND set_name = ${setName}
          AND card_number_display = ${cardNumber}
        GROUP BY label, sort_class, sort_num
        ORDER BY sort_class ASC, sort_num DESC NULLS LAST, label ASC
      `)).rows as Array<{ label: string; count: number }>;

      const total = distRows.reduce((s, r) => s + r.count, 0);
      const distribution = distRows.map(r => ({
        grade: r.label,
        count: r.count,
        percent: total > 0 ? (r.count / total) * 100 : 0,
      }));

      res.json({
        cert_id: certId,
        card: { name: cardName, set: setName, number: cardNumber },
        current_grade: currentGrade,
        total,
        distribution,
      });
    } catch (err: any) {
      console.error("[pop-report] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /reprocess-images — re-run the FULL display pipeline on the
  // cert's R2 originals. Distinct from the legacy
  // /api/admin/certificates/:id/reprocess-images endpoint (which only
  // regenerates AI-grading variants via the old deskew+autoCrop path).
  // This one goes through uploadImagesToCert — the same scan-ingest flow
  // new scans use — so the full chain runs: deskew → detectCardEdges-
  // ByCoverage → reCentreBitmap → tightenForDisplay → whitewashEdgesBy-
  // Saturation → maskRoundedCorners → display PNG + JPEG + 4 AI variants.
  //
  // Source: grading_{front,back}_original — the RAW scan saved at first
  // ingest. NOT frontImagePath/backImagePath (those are display keys —
  // already-processed PNGs that would distort detection if re-fed). The
  // Fly server has no access to the operator's local watcher folder, so
  // the R2 originals are the canonical re-process input.
  app.post("/api/admin/certs/:certId/reprocess-images", requireAdmin, async (req, res) => {
    try {
      const certIdRaw = String(req.params.certId);
      const certId = normalizeCertId(certIdRaw);

      const rows = (await db.execute(sql`
        SELECT id, grading_front_original, grading_back_original
        FROM certificates
        WHERE certificate_number = ${certId}
        LIMIT 1
      `)).rows;
      if (rows.length === 0) return res.status(404).json({ error: "cert not found", certId });
      const cur = rows[0] as any;
      const dbId = Number(cur.id);
      const frontKey = (cur.grading_front_original as string | null) ?? null;
      const backKey = (cur.grading_back_original as string | null) ?? null;

      if (!frontKey) {
        return res.status(400).json({
          error: "cannot reprocess — no grading_front_original on this cert",
          cert_id: certId,
        });
      }

      const fetchR2Buf = async (key: string): Promise<Buffer> => {
        const url = await getR2SignedUrl(key, 300);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`fetch ${key} failed: ${resp.status}`);
        return Buffer.from(await resp.arrayBuffer());
      };

      const frontBuf = await fetchR2Buf(frontKey);
      const backBuf = backKey ? await fetchR2Buf(backKey) : null;
      console.log(`[reprocess-images] cert=${certId} dbId=${dbId} front=${(frontBuf.length / 1024).toFixed(0)}KB back=${backBuf ? `${(backBuf.length / 1024).toFixed(0)}KB` : "—"}`);

      const { uploadImagesToCert } = await import("./scan-ingest-service");
      await uploadImagesToCert(dbId, frontBuf, backBuf);

      // Read back the post-reprocess display image paths and sign them
      // for the response so the frontend can swap the viewer image src
      // without going through /api/logbook again.
      const afterRows = (await db.execute(sql`
        SELECT front_image_path, back_image_path
        FROM certificates
        WHERE id = ${dbId}
        LIMIT 1
      `)).rows;
      const after = (afterRows[0] ?? {}) as any;
      const signIfPresent = async (key: string | null): Promise<string | null> => {
        if (!key) return null;
        try { return await getR2SignedUrl(key, 3600); } catch { return null; }
      };
      const front_url = await signIfPresent(after.front_image_path ?? null);
      const back_url = await signIfPresent(after.back_image_path ?? null);

      const adminUser = (req.session as any)?.adminUser ?? ADMIN_EMAIL ?? "admin";
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('certificate', ${String(dbId)}, 'reprocess_images', ${adminUser}, ${JSON.stringify({ reason: "manual" })}::jsonb, NOW())
      `);

      res.json({ success: true, front_url, back_url });
    } catch (err: any) {
      console.error("[reprocess-images] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/bulk-reprocess-images — bulk version of the above.
  // Body: { certIds?: string[], all?: boolean }
  //   - all=true → every cert with grading_front_original NOT NULL and
  //     deleted_at IS NULL
  //   - else certIds[] (normalized via normalizeCertId, filtered to active
  //     + has-original)
  //
  // Concurrency 10 per batch, sequential between batches. For a typical
  // ~15s/cert pipeline this means N/10 × 15s end-to-end — 100+ certs will
  // exceed Fly's 60s proxy timeout. The Node process keeps running after
  // the client disconnects, and audit_log records progress per cert, so a
  // timed-out call still finishes server-side. Operators should re-poll
  // /api/admin/stats or grep fly logs for [bulk-reprocess] to confirm
  // completion when this happens.
  app.post("/api/admin/bulk-reprocess-images", requireAdmin, async (req, res) => {
    try {
      const body = (req.body || {}) as { certIds?: string[]; all?: boolean };
      const all = body.all === true;
      const inputCertIds = Array.isArray(body.certIds) ? body.certIds.map(String) : [];

      if (!all && inputCertIds.length === 0) {
        return res.status(400).json({ error: "Body must include certIds: string[] OR all: true." });
      }

      // Build the worklist. all=true → every still-active cert that has
      // an original to reprocess. Otherwise normalize the supplied list
      // and filter to the same criteria so we never try to reprocess a
      // voided cert or one without an R2 original.
      let worklist: Array<{ id: number; certNumber: string }>;
      if (all) {
        const rows = (await db.execute(sql`
          SELECT id, certificate_number
          FROM certificates
          WHERE deleted_at IS NULL
            AND grading_front_original IS NOT NULL
          ORDER BY id
        `)).rows as Array<{ id: number; certificate_number: string }>;
        worklist = rows.map(r => ({ id: r.id, certNumber: r.certificate_number }));
      } else {
        const normalized = inputCertIds.map(c => normalizeCertId(c));
        const rows = (await db.execute(sql`
          SELECT id, certificate_number
          FROM certificates
          WHERE certificate_number = ANY(${normalized}::text[])
            AND deleted_at IS NULL
            AND grading_front_original IS NOT NULL
          ORDER BY id
        `)).rows as Array<{ id: number; certificate_number: string }>;
        worklist = rows.map(r => ({ id: r.id, certNumber: r.certificate_number }));
      }

      console.log(`[bulk-reprocess] starting: ${worklist.length} certs (all=${all})`);

      const { uploadImagesToCert } = await import("./scan-ingest-service");
      const adminUser = (req.session as any)?.adminUser ?? ADMIN_EMAIL ?? "admin";

      const errors: Array<{ cert_id: string; error: string }> = [];
      let processed = 0;
      let failed = 0;
      const BATCH = 10;

      const fetchR2Buf = async (key: string): Promise<Buffer> => {
        const url = await getR2SignedUrl(key, 300);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`R2 fetch ${key} failed: ${resp.status}`);
        return Buffer.from(await resp.arrayBuffer());
      };

      const processOne = async (item: { id: number; certNumber: string }) => {
        try {
          const r = (await db.execute(sql`
            SELECT grading_front_original, grading_back_original
            FROM certificates
            WHERE id = ${item.id}
            LIMIT 1
          `)).rows[0] as any;
          const frontKey: string | null = r?.grading_front_original ?? null;
          const backKey: string | null = r?.grading_back_original ?? null;
          if (!frontKey) throw new Error("no grading_front_original");

          // HEAD-check BEFORE starting the sharp pipeline. headR2 returns
          // null on any failure (404 / network / creds) — for this bulk
          // path we treat any null as "missing" and skip the cert. Avoids
          // spending memory + CPU on certs whose source isn't in R2
          // (common on staging where older certs' originals were never
          // back-filled). Back is optional — only HEAD-checked if a key
          // is recorded.
          const frontHead = await headR2(frontKey);
          if (frontHead === null) {
            throw new Error(`R2 original missing (front: ${frontKey})`);
          }
          if (backKey) {
            const backHead = await headR2(backKey);
            if (backHead === null) {
              throw new Error(`R2 original missing (back: ${backKey})`);
            }
          }

          const frontBuf = await fetchR2Buf(frontKey);
          const backBuf = backKey ? await fetchR2Buf(backKey) : null;

          await uploadImagesToCert(item.id, frontBuf, backBuf);

          await db.execute(sql`
            INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
            VALUES ('certificate', ${String(item.id)}, 'reprocess_images', ${adminUser}, ${JSON.stringify({ reason: "bulk", source: "bulk-reprocess" })}::jsonb, NOW())
          `);

          processed++;
          console.log(`[bulk-reprocess] ✓ ${item.certNumber} (id=${item.id}) ${processed}/${worklist.length}`);
        } catch (err: any) {
          failed++;
          errors.push({ cert_id: item.certNumber, error: err.message || String(err) });
          console.error(`[bulk-reprocess] ✗ ${item.certNumber} (id=${item.id}): ${err.message}`);
        }
      };

      for (let i = 0; i < worklist.length; i += BATCH) {
        const batch = worklist.slice(i, i + BATCH);
        await Promise.all(batch.map(processOne));
        console.log(`[bulk-reprocess] batch complete: ${processed + failed}/${worklist.length} (ok=${processed} fail=${failed})`);
      }

      console.log(`[bulk-reprocess] DONE total=${worklist.length} processed=${processed} failed=${failed}`);
      res.json({
        total: worklist.length,
        processed,
        failed,
        errors,
      });
    } catch (err: any) {
      console.error("[bulk-reprocess] fatal:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /image — attach a single-side image to an existing cert. sharp
  // re-encodes to JPEG (handles .tif, .tiff, .png, .webp, .jpg/.jpeg input).
  // R2 key follows the existing scan-ingest convention so /reprocess-images
  // and the dashboard image fetcher both find it without changes.
  app.post(
    "/api/admin/certs/:certId/image",
    requireScannerOrAdmin,
    certImgUpload.single("image"),
    async (req, res) => {
      try {
        const certIdRaw = String(req.params.certId);
        const certId    = normalizeCertId(certIdRaw);
        const side      = String(req.body?.side || "").toLowerCase();
        const replaceExisting = String(req.body?.replace_existing || "false") === "true";

        if (side !== "front" && side !== "back") {
          return res.status(400).json({ error: "side must be 'front' or 'back'" });
        }
        const file = req.file;
        if (!file) return res.status(400).json({ error: "image file required (multipart 'image')" });

        const certRow = await db.execute(sql`
          SELECT id, certificate_number, grading_front_original, grading_back_original, deleted_at
          FROM certificates
          WHERE certificate_number = ${certId}
          LIMIT 1
        `);
        const cert = certRow.rows[0] as any;
        if (!cert) return res.status(404).json({ error: "cert not found", certId });
        if (cert.deleted_at) return res.status(410).json({ error: "cert is soft-deleted; restore before attaching images" });

        const sideCol = side === "front" ? "grading_front_original" : "grading_back_original";
        const previousKey: string | null = cert[sideCol] || null;

        if (previousKey && !replaceExisting) {
          let currentSignedUrl: string | null = null;
          try { currentSignedUrl = await getR2SignedUrl(previousKey, 600); } catch {}
          return res.status(409).json({
            error: `${side} already attached to ${certId}`,
            current_key: previousKey,
            current_signed_url: currentSignedUrl,
          });
        }

        // sharp → JPEG. .rotate() applies EXIF orientation; resize cap mirrors
        // scan-ingest-service.uploadImagesToCert (3000×3000 fit:inside).
        const sharp = (await import("sharp")).default;
        let jpegBuf: Buffer;
        try {
          jpegBuf = await sharp(file.buffer)
            .rotate()
            .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85, progressive: true, mozjpeg: true })
            .toBuffer();
        } catch (err: any) {
          return res.status(400).json({ error: `image decode failed: ${err.message}` });
        }

        const newKey = `images/grading/${cert.id}/${side}_original.jpg`;
        await uploadToR2(newKey, jpegBuf, "image/jpeg");

        if (side === "front") {
          await db.execute(sql`UPDATE certificates SET grading_front_original = ${newKey}, updated_at = NOW() WHERE id = ${cert.id}`);
        } else {
          await db.execute(sql`UPDATE certificates SET grading_back_original  = ${newKey}, updated_at = NOW() WHERE id = ${cert.id}`);
        }

        const adminUser = (req.session as any)?.adminEmail || (req.headers["x-scanner-token"] ? "scanner-watcher" : "admin");
        await storage.writeAuditLog("certificate", certId, "image_attached_manual", adminUser, {
          side,
          replace_existing:  replaceExisting,
          previous_key:      previousKey,
          new_key:           newKey,
          original_filename: file.originalname || null,
          mime_received:     file.mimetype || null,
          size_in_bytes:     file.size,
        });

        // ── Post-save: run the same crop + AI pipeline scan-ingest uses ──
        // Without this, the cert has the raw original in R2 but no display
        // PNG, no AI variants, and AI grading is never queued — so the
        // workstation viewer is blank and the grade stays at "—". Mirrors
        // PUT /attach-images, which calls uploadImagesToCert + AI for new
        // certs that get image attachments from the admin UI.
        //
        // uploadImagesToCert requires the FRONT original (back-only certs
        // can't go through the pipeline). When the operator uploads back
        // first, we skip with pipeline_status='skipped-no-front' — the
        // operator's subsequent front upload will trigger the full pipeline
        // for both sides.
        let pipelineStatus: "ok" | "skipped-no-front" | "failed" = "skipped-no-front";
        let pipelineError: string | null = null;
        let aiTriggered = false;

        const frontKeyAfter = side === "front" ? newKey : (cert.grading_front_original as string | null);
        const backKeyAfter  = side === "back"  ? newKey : (cert.grading_back_original  as string | null);

        if (frontKeyAfter) {
          try {
            // Fetch buffers — the just-uploaded side is already in memory
            // as jpegBuf; the other side comes from R2.
            const fetchR2Buf = async (key: string): Promise<Buffer> => {
              const url = await getR2SignedUrl(key, 300);
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`fetch ${key} failed: ${resp.status}`);
              return Buffer.from(await resp.arrayBuffer());
            };
            const frontBuf: Buffer = side === "front" ? jpegBuf : await fetchR2Buf(frontKeyAfter);
            const backBuf: Buffer | null = !backKeyAfter
              ? null
              : side === "back"
                ? jpegBuf
                : await fetchR2Buf(backKeyAfter);

            const { uploadImagesToCert, runAiOnCertIfIdle } = await import("./scan-ingest-service");
            const { frontVariants, backVariants } = await uploadImagesToCert(cert.id, frontBuf, backBuf);
            pipelineStatus = "ok";
            console.log(`[cert-image-attach] pipeline ok for cert ${cert.id} (${certId}) side=${side}`);

            const aiPromise = runAiOnCertIfIdle(cert.id, frontVariants.cropped, backVariants?.cropped || null);
            if (aiPromise) {
              aiTriggered = true;
              aiPromise
                .then(r => console.log(`[cert-image-attach] AI done for cert ${cert.id}: grade=${r?.grade}`))
                .catch(e => console.warn(`[cert-image-attach] AI failed for cert ${cert.id}:`, e?.message || e));
            }
          } catch (err: any) {
            // Original is saved on R2 + the column is updated — pipeline
            // failure doesn't undo that. Return 200 with the failure flagged
            // so the caller can decide (e.g. re-run /reprocess-images).
            pipelineStatus = "failed";
            pipelineError  = err?.message || String(err);
            console.error(`[cert-image-attach] pipeline failed for cert ${cert.id}:`, pipelineError);
          }
        }

        res.json({
          ok:       true,
          cert_id:  certId,
          side,
          new_key:  newKey,
          previous_key: previousKey,
          replaced: !!previousKey,
          pipeline_status: pipelineStatus,
          pipeline_error:  pipelineError,
          ai_triggered:    aiTriggered,
        });
      } catch (err: any) {
        console.error("[cert-image-attach] failed:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // DELETE — soft-delete only (sets deleted_at). Hard-delete is intentionally
  // not exposed; project rule "no hard deletes on business tables" applies.
  app.delete("/api/admin/certs/:certId", requireScannerOrAdmin, async (req, res) => {
    try {
      const certIdRaw = String(req.params.certId);
      const certId    = normalizeCertId(certIdRaw);
      const reason    = String(req.body?.reason || "").trim();
      if (reason.length < 10) {
        return res.status(400).json({ error: "reason must be at least 10 characters" });
      }

      const r = await db.execute(sql`
        UPDATE certificates
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE certificate_number = ${certId} AND deleted_at IS NULL
        RETURNING id
      `);
      if (r.rows.length === 0) {
        const exists = await db.execute(sql`SELECT id, deleted_at FROM certificates WHERE certificate_number = ${certId} LIMIT 1`);
        if (exists.rows.length === 0) return res.status(404).json({ error: "cert not found", certId });
        return res.status(410).json({ error: "cert already soft-deleted", certId });
      }

      const adminUser = (req.session as any)?.adminEmail || (req.headers["x-scanner-token"] ? "scanner-watcher" : "admin");
      await storage.writeAuditLog("certificate", certId, "soft_delete", adminUser, { reason });

      res.json({ ok: true, cert_id: certId });
    } catch (err: any) {
      console.error("[cert-soft-delete] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI Divergence dashboard ──────────────────────────────────────────────
  // For every approved cert that ALSO has a grade-prediction row in
  // ai_predictions, compute the per-zone divergence between AI and human:
  //   divergence = ai - human  (positive = AI too generous, negative = AI too harsh)
  //
  // First concrete step toward a custom-model training pipeline — surfaces
  // systematic bias in the current AI grader. One SQL query (DISTINCT ON
  // for the latest prediction per cert), JS aggregation for summaries.
  //
  // Note on call_type values: the brief uses 'haiku_quick_grade' as a
  // value but the canonical name written by callClaude is 'quick_grade'.
  // SQL filters here use the canonical name; UI labels them
  // human-friendly as "Haiku quick-grade".
  app.get("/api/admin/ai-divergence", requireAdmin, async (req, res) => {
    try {
      const sinceDays = req.query.sinceDays == null || req.query.sinceDays === ""
        ? 30
        : Math.max(1, parseInt(String(req.query.sinceDays), 10) || 30);

      // callType filter — accept both the canonical 'quick_grade' and the
      // brief's 'haiku_quick_grade' alias for callers using the spec name.
      const callTypeRaw = req.query.callType ? String(req.query.callType) : null;
      const callType = callTypeRaw === "haiku_quick_grade" ? "quick_grade" : callTypeRaw;
      const callTypeClause = (callType === "full_grade" || callType === "quick_grade")
        ? sql` AND p.call_type = ${callType}`
        : sql` AND p.call_type IN ('full_grade', 'quick_grade')`;

      // ── Q: latest prediction per cert + paired human grade ──────────────
      // DISTINCT ON (cert_id) + ORDER BY cert_id, created_at DESC picks the
      // most recent prediction row per cert. Outer JOIN to certificates
      // restricts to approved-with-numeric-grade certs in window.
      const rowsRes = await db.execute(sql`
        WITH latest_pred AS (
          SELECT DISTINCT ON (p.cert_id)
            p.cert_id,
            p.model,
            p.call_type,
            p.created_at AS prediction_at,
            COALESCE(
              (p.prediction->>'overall_grade')::numeric,
              (p.prediction->>'overall')::numeric
            ) AS ai_overall,
            (p.prediction->'centering'->>'subgrade')::numeric AS ai_centering,
            (p.prediction->'corners'  ->>'subgrade')::numeric AS ai_corners,
            (p.prediction->'edges'    ->>'subgrade')::numeric AS ai_edges,
            (p.prediction->'surface'  ->>'subgrade')::numeric AS ai_surface
          FROM ai_predictions p
          WHERE 1 = 1
            ${callTypeClause}
          ORDER BY p.cert_id, p.created_at DESC
        )
        SELECT
          c.certificate_number AS cert_id,
          c.card_name,
          c.grade_approved_at,
          lp.model,
          lp.call_type,
          lp.prediction_at,
          lp.ai_overall, lp.ai_centering, lp.ai_corners, lp.ai_edges, lp.ai_surface,
          c.grade::numeric           AS human_overall,
          c.centering_score::numeric AS human_centering,
          c.corners_score::numeric   AS human_corners,
          c.edges_score::numeric     AS human_edges,
          c.surface_score::numeric   AS human_surface
        FROM latest_pred lp
        JOIN certificates c ON c.certificate_number = lp.cert_id
        WHERE c.grade_approved_at IS NOT NULL
          AND c.grade IS NOT NULL
          AND c.deleted_at IS NULL
          AND c.grade_approved_at >= NOW() - (${sinceDays} || ' days')::interval
        ORDER BY c.grade_approved_at DESC
      `);

      const ZONES = ["overall", "centering", "corners", "edges", "surface"] as const;
      type Zone = typeof ZONES[number];

      type CertRow = {
        cert_id: string;
        card_name: string | null;
        approved_at: string | null;
        model: string;
        call_type: string;
        prediction_at: string | null;
        grades: Record<Zone, { ai: number | null; human: number | null; divergence: number | null }>;
        max_zone_divergence: number;
        any_field_missing: boolean;
      };

      const certs: CertRow[] = (rowsRes.rows as any[]).map(r => {
        const grades: CertRow["grades"] = {} as any;
        let maxAbs = 0;
        let anyMissing = false;
        for (const z of ZONES) {
          const ai    = r["ai_" + z]    != null ? Number(r["ai_" + z])    : null;
          const human = r["human_" + z] != null ? Number(r["human_" + z]) : null;
          const div   = (ai != null && human != null) ? Math.round((ai - human) * 100) / 100 : null;
          if (div != null && Math.abs(div) > maxAbs) maxAbs = Math.abs(div);
          if (ai == null) anyMissing = true;
          grades[z] = { ai, human, divergence: div };
        }
        return {
          cert_id:        String(r.cert_id),
          card_name:      r.card_name ?? null,
          approved_at:    r.grade_approved_at ? new Date(r.grade_approved_at).toISOString() : null,
          model:          String(r.model || ""),
          call_type:      String(r.call_type || ""),
          prediction_at:  r.prediction_at ? new Date(r.prediction_at).toISOString() : null,
          grades,
          max_zone_divergence: maxAbs,
          any_field_missing:   anyMissing,
        };
      });

      // ── Aggregations ────────────────────────────────────────────────────
      function zoneStats(divs: number[]) {
        if (divs.length === 0) return { n: 0, mean_divergence: null, median_divergence: null, stddev: null, ai_too_generous_pct: null, ai_too_harsh_pct: null, exact_match_pct: null };
        const sorted = [...divs].sort((a, b) => a - b);
        const n = divs.length;
        const mean = divs.reduce((a, b) => a + b, 0) / n;
        const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const variance = divs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
        const stddev = Math.sqrt(variance);
        const generous = divs.filter(d => d > 0).length;
        const harsh    = divs.filter(d => d < 0).length;
        const exact    = divs.filter(d => d === 0).length;
        return {
          n,
          mean_divergence:     Math.round(mean * 100) / 100,
          median_divergence:   Math.round(median * 100) / 100,
          stddev:              Math.round(stddev * 100) / 100,
          ai_too_generous_pct: Math.round((generous / n) * 100),
          ai_too_harsh_pct:    Math.round((harsh    / n) * 100),
          exact_match_pct:     Math.round((exact    / n) * 100),
        };
      }

      const by_zone: Record<Zone, ReturnType<typeof zoneStats>> = {} as any;
      for (const z of ZONES) {
        by_zone[z] = zoneStats(certs.map(c => c.grades[z].divergence).filter((d): d is number => d != null));
      }

      // Grade bands — bucket by HUMAN overall grade.
      const bandKey = (g: number | null): string | null => {
        if (g == null) return null;
        if (g === 10) return "10";
        if (g >= 9.5) return "9.5-9.9";
        if (g === 9)  return "9";
        if (g === 8)  return "8";
        if (g <  8)   return "below 8";
        return null;
      };
      const bands: Record<string, number[]> = { "10": [], "9.5-9.9": [], "9": [], "8": [], "below 8": [] };
      for (const c of certs) {
        const k = bandKey(c.grades.overall.human);
        const d = c.grades.overall.divergence;
        if (k && d != null) bands[k].push(d);
      }
      const by_grade_band: Record<string, { n: number; mean_overall_divergence: number | null }> = {};
      for (const [k, divs] of Object.entries(bands)) {
        by_grade_band[k] = divs.length === 0
          ? { n: 0, mean_overall_divergence: null }
          : { n: divs.length, mean_overall_divergence: Math.round((divs.reduce((a, b) => a + b, 0) / divs.length) * 100) / 100 };
      }

      // Per-model — aggregated by model string from ai_predictions.
      const byModelMap = new Map<string, number[]>();
      for (const c of certs) {
        const d = c.grades.overall.divergence;
        if (d == null) continue;
        if (!byModelMap.has(c.model)) byModelMap.set(c.model, []);
        byModelMap.get(c.model)!.push(d);
      }
      const by_model: Record<string, { n: number; mean_overall_divergence: number | null }> = {};
      for (const [model, divs] of byModelMap.entries()) {
        by_model[model] = {
          n: divs.length,
          mean_overall_divergence: Math.round((divs.reduce((a, b) => a + b, 0) / divs.length) * 100) / 100,
        };
      }

      // Sort per-cert by biggest disagreement first; the dashboard's primary
      // value is "where did we miss the most" — easier to spot at the top.
      certs.sort((a, b) => b.max_zone_divergence - a.max_zone_divergence);

      res.json({
        generated_at: new Date().toISOString(),
        sample_size:  certs.length,
        summary:      { by_zone, by_grade_band, by_model },
        certs,
      });
    } catch (err: any) {
      console.error("[ai-divergence] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI Capture Health dashboard ──────────────────────────────────────────
  // Read-only snapshot of how well the capture pipeline is doing on every
  // approved cert across 8 fields. Used by /admin (capture-health tab) to
  // catch regressions immediately instead of weeks later via ad-hoc audits.
  //
  // Shape: 3 SQL queries total — one for the cert rows, one for
  // ai_predictions counts, one for audit_log action sets. Per-row field
  // checks are pure column reads on the cert; no per-cert query loop.
  app.get("/api/admin/ai-capture-health", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10) || 25));
      const onlyFailing = String(req.query.onlyFailing ?? "false") === "true";
      const sinceDaysRaw = req.query.sinceDays;
      const sinceDays = sinceDaysRaw == null || sinceDaysRaw === ""
        ? null
        : Math.max(1, parseInt(String(sinceDaysRaw), 10) || 0);

      const sinceClause = sinceDays
        ? sql` AND grade_approved_at >= NOW() - (${sinceDays} || ' days')::interval`
        : sql``;

      // ── Q1: certs (one row per approved cert, ordered most-recent first) ──
      const certRows = await db.execute(sql`
        SELECT
          certificate_number AS cert_id,
          grade_approved_at,
          card_name, set_name, card_number_display, rarity, year_text,
          grade::numeric AS grade_overall,
          centering_score, corners_score, edges_score, surface_score,
          defects, label_type,
          grading_front_original, grading_back_original,
          grading_time_seconds,
          embedded_at,
          (embedding IS NOT NULL) AS has_embedding
        FROM certificates
        WHERE grade_approved_at IS NOT NULL
          AND deleted_at IS NULL
          ${sinceClause}
        ORDER BY grade_approved_at DESC
        LIMIT ${limit}
      `);
      const certs = certRows.rows as any[];

      if (certs.length === 0) {
        return res.json({
          generated_at: new Date().toISOString(),
          summary: { total_checked: 0, fully_green: 0, any_red: 0, any_amber: 0, by_field: {} },
          certs: [],
        });
      }

      const certIds = certs.map(c => String(c.cert_id));

      // ── Q2: ai_predictions count by cert_id ───────────────────────────────
      const predRows = await db.execute(sql`
        SELECT cert_id, COUNT(*)::int AS cnt
        FROM ai_predictions
        WHERE cert_id IN (${sql.join(certIds.map(id => sql`${id}`), sql`, `)})
        GROUP BY cert_id
      `);
      const predCounts = new Map<string, number>();
      for (const r of predRows.rows as any[]) predCounts.set(String(r.cert_id), Number(r.cnt));

      // ── Q3: audit_log actions seen per entity_id ──────────────────────────
      const auditRows = await db.execute(sql`
        SELECT entity_id, ARRAY_AGG(DISTINCT action) AS actions
        FROM audit_log
        WHERE entity_type = 'certificate'
          AND entity_id IN (${sql.join(certIds.map(id => sql`${id}`), sql`, `)})
          AND action IN ('grade_approved','approved','metadata_backfill','CERT_ID_ALLOCATED','OWNER_ASSIGNED','approve_grade','approve_and_publish')
        GROUP BY entity_id
      `);
      const auditActions = new Map<string, string[]>();
      for (const r of auditRows.rows as any[]) auditActions.set(String(r.entity_id), r.actions || []);

      // ── Per-cert checks ───────────────────────────────────────────────────
      type CheckStatus = "green" | "amber" | "red";
      const FIELD_KEYS = ["card_metadata", "grade_fields", "defects", "images", "grading_time", "embedding", "ai_predictions", "audit_log"] as const;
      type FieldKey = typeof FIELD_KEYS[number];

      const byField: Record<FieldKey, { green: number; amber: number; red: number }> =
        Object.fromEntries(FIELD_KEYS.map(k => [k, { green: 0, amber: 0, red: 0 }])) as any;

      const isEmpty = (v: unknown): boolean => v == null || (typeof v === "string" && v.trim() === "");
      const now = Date.now();

      const out = certs.map(cert => {
        const certId = String(cert.cert_id);

        // 1) card_metadata — 5 fields all non-null/non-empty
        const metaMissing: string[] = [];
        for (const f of ["card_name", "set_name", "card_number_display", "rarity", "year_text"]) {
          if (isEmpty(cert[f])) metaMissing.push(f);
        }
        const cardMetadata = { status: (metaMissing.length === 0 ? "green" : "red") as CheckStatus, missing: metaMissing.length ? metaMissing : null };

        // 2) grade_fields — overall + 4 subgrades all non-null
        const gradeMissing: string[] = [];
        if (cert.grade_overall == null)    gradeMissing.push("grade_overall");
        if (cert.centering_score == null)  gradeMissing.push("grade_centering");
        if (cert.corners_score   == null)  gradeMissing.push("grade_corners");
        if (cert.edges_score     == null)  gradeMissing.push("grade_edges");
        if (cert.surface_score   == null)  gradeMissing.push("grade_surface");
        const gradeFields = { status: (gradeMissing.length === 0 ? "green" : "red") as CheckStatus, missing: gradeMissing.length ? gradeMissing : null };

        // 3) defects — non-empty array OR (grade=10 / label=black) → intentional zero
        const defectsArr = Array.isArray(cert.defects) ? cert.defects : [];
        const isPerfect = Number(cert.grade_overall) === 10 || cert.label_type === "black";
        let defects: { status: CheckStatus; note: string | null };
        if (defectsArr.length > 0) {
          defects = { status: "green", note: null };
        } else if (isPerfect) {
          defects = { status: "green", note: `intentional zero (grade=${cert.grade_overall ?? "10"}${cert.label_type === "black" ? "/black" : ""})` };
        } else {
          defects = { status: "red", note: null };
        }

        // 4) images — both keys present + front prefix sanity
        const imgMissing: string[] = [];
        if (isEmpty(cert.grading_front_original)) imgMissing.push("grading_front_original");
        else if (typeof cert.grading_front_original === "string" && !cert.grading_front_original.startsWith("images/")) {
          imgMissing.push(`grading_front_original looks like a URL not an R2 key (${String(cert.grading_front_original).slice(0, 32)}…)`);
        }
        if (isEmpty(cert.grading_back_original)) imgMissing.push("grading_back_original");
        const images = { status: (imgMissing.length === 0 ? "green" : "red") as CheckStatus, missing: imgMissing.length ? imgMissing : null };

        // 5) grading_time
        const gt = Number(cert.grading_time_seconds);
        const grading_time = Number.isFinite(gt) && gt > 0
          ? { status: "green" as CheckStatus, value_seconds: gt }
          : { status: "red"   as CheckStatus, value_seconds: null };

        // 6) embedding — green if both set; amber if < 2hr post-approval; else red
        const minsSinceApproved = cert.grade_approved_at
          ? Math.floor((now - new Date(cert.grade_approved_at).getTime()) / 60_000)
          : null;
        let embedding: { status: CheckStatus; embedded_at: string | null; minutes_since_approved: number | null };
        if (cert.embedded_at && cert.has_embedding) {
          embedding = { status: "green", embedded_at: new Date(cert.embedded_at).toISOString(), minutes_since_approved: minsSinceApproved };
        } else if (minsSinceApproved != null && minsSinceApproved < 120) {
          embedding = { status: "amber", embedded_at: null, minutes_since_approved: minsSinceApproved };
        } else {
          embedding = { status: "red", embedded_at: null, minutes_since_approved: minsSinceApproved };
        }

        // 7) ai_predictions — at least one row
        const predCount = predCounts.get(certId) || 0;
        const ai_predictions = predCount > 0
          ? { status: "green" as CheckStatus, count: predCount }
          : { status: "red"   as CheckStatus, count: 0 };

        // 8) audit_log — at least one of the canonical actions seen
        const actions = auditActions.get(certId) || [];
        const audit_log = actions.length > 0
          ? { status: "green" as CheckStatus, actions_seen: actions }
          : { status: "red"   as CheckStatus, actions_seen: [] };

        const checks = {
          card_metadata:  cardMetadata,
          grade_fields:   gradeFields,
          defects,
          images,
          grading_time,
          embedding,
          ai_predictions,
          audit_log,
        };

        let any_red = false, any_amber = false;
        for (const k of FIELD_KEYS) {
          const s = (checks as any)[k].status as CheckStatus;
          byField[k][s]++;
          if (s === "red")   any_red = true;
          if (s === "amber") any_amber = true;
        }

        return {
          cert_id: certId,
          grade_approved_at: cert.grade_approved_at ? new Date(cert.grade_approved_at).toISOString() : null,
          card_name: cert.card_name ?? null,
          grade_overall: cert.grade_overall != null ? String(cert.grade_overall) : null,
          checks,
          any_red,
          any_amber,
        };
      });

      const filtered = onlyFailing ? out.filter(c => c.any_red) : out;

      const summary = {
        total_checked: out.length,
        fully_green:   out.filter(c => !c.any_red && !c.any_amber).length,
        any_red:       out.filter(c => c.any_red).length,
        any_amber:     out.filter(c => c.any_amber).length,
        by_field:      byField,
      };

      res.json({ generated_at: new Date().toISOString(), summary, certs: filtered });
    } catch (err: any) {
      console.error("[ai-capture-health] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── One-time-use metadata backfill ────────────────────────────────────────
  // Re-runs AI Identify on certs that were approved before identification
  // happened (per docs/corpus-capture-audit.md — MV20/21/41/44). Only fills
  // NULLs; never overwrites populated fields. Each successful update is
  // mirrored to audit_log inside the same transaction.
  //
  // The endpoint stays in place after the one-off use — useful for any
  // future cert discovered with missing metadata. dryRun: true is the
  // intended default flow; live writes only after the dry-run is reviewed.
  app.post("/api/admin/backfill-cert-metadata", requireAdmin, async (req, res) => {
    try {
      const { certIds, dryRun } = req.body || {};
      if (!Array.isArray(certIds) || certIds.length === 0) {
        return res.status(400).json({ error: "certIds must be a non-empty array of strings" });
      }
      if (certIds.length > 20) {
        return res.status(400).json({ error: "max 20 certIds per call (budget guard)" });
      }
      if (typeof dryRun !== "boolean") {
        return res.status(400).json({ error: "dryRun must be boolean" });
      }

      const { identifyCardFromBuffer, verifyAndEnrichCardData } = await import("./ai-grading-service");
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("./r2");
      const r2bucket = process.env.R2_BUCKET_NAME;
      if (!r2bucket) return res.status(500).json({ error: "R2_BUCKET_NAME not set" });
      const r2client = getR2Client();
      const adminEmail = req.session.adminEmail || "admin";

      // Only fill NULL/empty. Never overwrite. Re-run safety: a re-run
      // after a partial success won't clobber any field already populated.
      const pickValue = <T>(existing: T | null | undefined, suggested: T | null | undefined): T | null => {
        if (existing != null && existing !== "") return existing as T;
        if (suggested == null || suggested === "") return null;
        return suggested as T;
      };

      const FIELDS = ["card_name", "set_name", "card_number_display", "rarity", "year_text"] as const;
      type ResultRow = {
        certId: string;
        status: "would-update" | "updated" | "skipped" | "failed";
        reason?: string;
        before: Record<string, string | null>;
        after?: Record<string, string | null>;
        identification?: Record<string, unknown>;
      };
      const results: ResultRow[] = [];

      for (const raw of certIds) {
        const certIdStr = String(raw);
        const before: Record<string, string | null> = { card_name: null, set_name: null, card_number_display: null, rarity: null, year_text: null };

        const cert = await storage.getCertificateByCertId(certIdStr) as any;
        if (!cert) { results.push({ certId: certIdStr, status: "failed", reason: "cert not found", before }); continue; }

        before.card_name           = cert.cardName   ?? null;
        before.set_name            = cert.setName    ?? null;
        before.card_number_display = cert.cardNumber ?? null;
        before.rarity              = cert.rarity     ?? null;
        before.year_text           = cert.year       ?? null;

        const imageKey = cert.gradingFrontOriginal || cert.frontImagePath;
        if (!imageKey) { results.push({ certId: certIdStr, status: "failed", reason: "no front image key on cert", before }); continue; }

        // Fetch front image from R2.
        let buffer: Buffer;
        try {
          const r2 = await r2client.send(new GetObjectCommand({ Bucket: r2bucket, Key: imageKey }));
          if (!r2.Body) throw new Error("empty R2 body");
          const chunks: Buffer[] = [];
          for await (const chunk of r2.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
          buffer = Buffer.concat(chunks);
        } catch (err: any) {
          results.push({ certId: certIdStr, status: "failed", reason: `R2 fetch failed (${imageKey}): ${err.message}`, before }); continue;
        }

        // Run Haiku identify (+ optional GPT reconciliation inside the helper).
        let identified: any;
        try {
          identified = await identifyCardFromBuffer(buffer, "image/jpeg", certIdStr);
        } catch (err: any) {
          results.push({ certId: certIdStr, status: "failed", reason: `identify failed: ${err.message}`, before }); continue;
        }

        // Brief asks for ">0.6" confidence; underlying enum is high|medium|low.
        // Accept high+medium, skip low. Never write a guess.
        const idPayload = (verifiedFlag: boolean, dbSrc: string | null) => ({
          confidence:      identified.confidence,
          detected_name:   identified.detected_name,
          detected_set:    identified.detected_set,
          detected_number: identified.detected_number,
          detected_year:   identified.copyright_year || identified.detected_year,
          detected_rarity: identified.detected_rarity,
          verified:        verifiedFlag,
          dbSource:        dbSrc,
        });

        if (identified.confidence === "low") {
          results.push({
            certId: certIdStr,
            status: "skipped",
            reason: `confidence=low (${(identified.reasoning || "").slice(0, 120)})`,
            before,
            identification: idPayload(false, null),
          });
          continue;
        }

        // TCG cross-check (verifyAndEnrichCardData internally falls back to
        // unverified on lookup errors; defensive try/catch is belt-and-braces).
        let enriched: any;
        try {
          enriched = await verifyAndEnrichCardData(identified);
        } catch {
          enriched = { ...identified, verified: false, officialName: identified.detected_name, officialSet: identified.detected_set, officialNumber: identified.detected_number, dbSource: null };
        }

        const proposed: Record<string, string | null> = {
          card_name:           pickValue(cert.cardName,    enriched.officialName),
          set_name:            pickValue(cert.setName,     enriched.officialSet),
          card_number_display: pickValue(cert.cardNumber,  enriched.officialNumber),
          rarity:              pickValue(cert.rarity,      identified.detected_rarity),
          year_text:           pickValue(cert.year,        identified.copyright_year || identified.detected_year),
        };

        const changed = FIELDS.filter(f => proposed[f] !== before[f]);
        if (changed.length === 0) {
          results.push({ certId: certIdStr, status: "skipped", reason: "no field needs filling", before, identification: idPayload(enriched.verified, enriched.dbSource) });
          continue;
        }

        if (dryRun) {
          results.push({ certId: certIdStr, status: "would-update", before, after: proposed, identification: idPayload(enriched.verified, enriched.dbSource) });
          continue;
        }

        // Live write — UPDATE + audit_log INSERT inside one transaction.
        // COALESCE in the UPDATE means the column-level "never overwrite"
        // guard is enforced at the DB layer too, defending against a race
        // between the SELECT we just did and the UPDATE.
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql`
              UPDATE certificates SET
                card_name           = COALESCE(card_name,           ${proposed.card_name}),
                set_name            = COALESCE(set_name,            ${proposed.set_name}),
                card_number_display = COALESCE(card_number_display, ${proposed.card_number_display}),
                rarity              = COALESCE(rarity,              ${proposed.rarity}),
                year_text           = COALESCE(year_text,           ${proposed.year_text}),
                updated_at = NOW()
              WHERE certificate_number = ${certIdStr}
            `);
            await tx.execute(sql`
              INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
              VALUES ('certificate', ${certIdStr}, 'metadata_backfill', ${adminEmail}, ${JSON.stringify({
                before, after: proposed, identification: { ...idPayload(enriched.verified, enriched.dbSource), reasoning: identified.reasoning }, fields_changed: changed,
              })}::jsonb)
            `);
          });
          results.push({ certId: certIdStr, status: "updated", before, after: proposed, identification: idPayload(enriched.verified, enriched.dbSource) });
        } catch (err: any) {
          results.push({ certId: certIdStr, status: "failed", reason: `DB write failed: ${err.message}`, before });
        }
      }

      const summary = { "would-update": 0, updated: 0, skipped: 0, failed: 0 };
      for (const r of results) summary[r.status]++;
      res.json({ dryRun, results, summary });
    } catch (err: any) {
      console.error("[backfill-cert-metadata] failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── RAG Phase 0 corpus status ────────────────────────────────────────────
  // Surfaces the embed-corpus job's progress so the dashboard can show
  // "X/Y cards embedded for future retrieval system." Fail-softs to
  // sensible nulls when the embedding column doesn't exist yet (pre-
  // migration), so the dashboard panel doesn't break the whole page.
  app.get("/api/admin/embedding-status", requireAdmin, async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL)::int           AS total_approved,
          COUNT(*) FILTER (WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL AND embedded_at IS NOT NULL)::int AS embedded_count,
          (SELECT certificate_number FROM certificates
             WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL AND embedded_at IS NULL
             ORDER BY grade_approved_at ASC NULLS LAST LIMIT 1) AS oldest_unembedded_cert_id
        FROM certificates
      `);
      const row = (r.rows[0] || {}) as any;
      const total = Number(row.total_approved || 0);
      const embedded = Number(row.embedded_count || 0);
      res.json({
        embedded_count: embedded,
        total_approved: total,
        percentage: total > 0 ? Math.round((embedded / total) * 1000) / 10 : 0,
        oldest_unembedded_cert_id: row.oldest_unembedded_cert_id || null,
      });
    } catch (err: any) {
      // Migration likely hasn't run — return a graceful "ready: false"
      // shape rather than 500'ing the whole panel.
      console.warn("[embedding-status] query failed (migration may be pending):", err?.message || err);
      res.json({
        embedded_count: 0,
        total_approved: 0,
        percentage: 0,
        oldest_unembedded_cert_id: null,
        ready: false,
        error: err?.message || "embedding column not present",
      });
    }
  });

  // ── RAG embed-corpus admin controls ──────────────────────────────────────
  // Force-run + per-cert re-embed. Wire-protocol contract:
  //   POST /api/admin/embed-corpus/run         — picks the next batch (up
  //     to BATCH_SIZE from embed-corpus.ts) and runs it inline. Debounced
  //     60s server-side so a fat-fingered re-click is a no-op rather than
  //     a duplicate batch.
  //   POST /api/admin/embed-corpus/cert/:certId — single-cert force
  //     re-embed; bypasses the "already embedded" skip. One-shot, no
  //     debounce — admin may need to re-embed several certs in a row.
  // Both audit-logged. The /run endpoint stores `picked` and `skipped`
  // (debounce-hit boolean) in details; the per-cert endpoint stores the
  // service's status code.
  let lastForceRunAtMs = 0;
  const FORCE_RUN_DEBOUNCE_MS = 60_000;

  // GET /api/admin/embed-corpus/last-run — drives the button countdown so
  // the operator can see exactly how long until the next force-run is
  // allowed. Reads the same closure variable as the POST handler. Null
  // when the server has never run since boot (initial state).
  app.get("/api/admin/embed-corpus/last-run", requireAdmin, (_req, res) => {
    res.json({
      lastRunAtMs: lastForceRunAtMs > 0 ? lastForceRunAtMs : null,
      windowMs:    FORCE_RUN_DEBOUNCE_MS,
    });
  });

  app.post("/api/admin/embed-corpus/run", requireAdmin, async (req, res) => {
    try {
      const adminEmail = req.session.adminEmail || "admin";
      const now = Date.now();
      if (now - lastForceRunAtMs < FORCE_RUN_DEBOUNCE_MS) {
        const waitSec = Math.ceil((FORCE_RUN_DEBOUNCE_MS - (now - lastForceRunAtMs)) / 1000);
        await storage.writeAuditLog("rag_corpus", "embed_corpus", "force_run", adminEmail, {
          skipped: true,
          picked: 0,
          reason: "debounced",
          waitSec,
        });
        return res.json({ ok: true, skipped: true, picked: 0, waitSec });
      }
      lastForceRunAtMs = now;
      const { runEmbedCorpusJob } = await import("./jobs/embed-corpus");
      const stats = await runEmbedCorpusJob();
      await storage.writeAuditLog("rag_corpus", "embed_corpus", "force_run", adminEmail, {
        skipped: false,
        picked:   stats.picked,
        embedded: stats.embedded,
        skippedCount: stats.skipped,
        failed:   stats.failed,
        reason:   stats.reason || null,
      });
      return res.json({
        ok: true,
        skipped: false,
        picked:       stats.picked,
        embedded:     stats.embedded,
        skippedCount: stats.skipped,
        failed:       stats.failed,
        reason:       stats.reason || null,
      });
    } catch (err: any) {
      console.error("[embed-corpus/run] failed:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/embed-corpus/cert/:certId", requireAdmin, async (req, res) => {
    try {
      const adminEmail = req.session.adminEmail || "admin";
      const normalCertId = normalizeCertId(String(req.params.certId));
      const { generateEmbeddingForCert } = await import("./embedding-service");
      const result = await generateEmbeddingForCert(normalCertId, { force: true });
      await storage.writeAuditLog("certificate", normalCertId, "rag_force_reembed", adminEmail, {
        status: result.status,
        reason: result.reason || null,
      });
      return res.json({ ok: result.status !== "no-data", ...result });
    } catch (err: any) {
      console.error(`[embed-corpus/cert] ${req.params.certId} failed:`, err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── B2 cold-archive endpoints ───────────────────────────────────────────
  // Manual trigger + status surface for the R2 → B2 archival worker.
  // Worker runs daily via setInterval (server/index.ts); these endpoints
  // give the operator a way to dry-run, force a sweep, or check progress.

  // POST /api/admin/archival/run — body: { dryRun?, batchSize?, ageDays? }
  app.post("/api/admin/archival/run", requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const dryRun = body.dryRun === true;
      const batchSizeRaw = Number(body.batchSize);
      const ageDaysRaw = Number(body.ageDays);
      const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.min(500, Math.floor(batchSizeRaw)) : 50;
      const ageDays = Number.isFinite(ageDaysRaw) && ageDaysRaw >= 0 ? Math.floor(ageDaysRaw) : 90;
      const { archiveStaleImages } = await import("./workers/r2-to-b2-archival");
      const summary = await archiveStaleImages({ dryRun, batchSize, ageDays });
      res.json(summary);
    } catch (err: any) {
      console.error("[archival-b2] manual run error:", err?.message || err);
      res.status(500).json({ error: err?.message || "archival run failed" });
    }
  });

  // GET /api/admin/archival/status — pending / archived / recent failures
  app.get("/api/admin/archival/status", requireAdmin, async (_req, res) => {
    try {
      const ageDaysParam = 90; // matches the cron's default
      const counts = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE grade_approved_at < NOW() - (${ageDaysParam}::int * INTERVAL '1 day')
              AND deleted_at IS NULL AND archived_to_b2_at IS NULL
          )::int AS pending,
          COUNT(*) FILTER (WHERE archived_to_b2_at IS NOT NULL)::int AS archived,
          COUNT(*) FILTER (
            WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL
          )::int AS total_eligible
        FROM certificates
      `);
      const row = counts.rows[0] as { pending: number; archived: number; total_eligible: number };

      // Last 20 failures from audit_log (action='archive_failed')
      const failuresRows = await db.execute(sql`
        SELECT entity_id AS cert_id, details, created_at
        FROM audit_log
        WHERE entity_type = 'certificate' AND action = 'archive_failed'
        ORDER BY created_at DESC
        LIMIT 20
      `);

      res.json({
        age_days_threshold: ageDaysParam,
        pending: row?.pending ?? 0,
        archived: row?.archived ?? 0,
        total_eligible: row?.total_eligible ?? 0,
        recent_failures: failuresRows.rows.map((r: any) => ({
          cert_id: r.cert_id,
          created_at: r.created_at,
          details: r.details,
        })),
      });
    } catch (err: any) {
      console.error("[archival-b2] status error:", err?.message || err);
      res.status(500).json({ error: err?.message || "archival status query failed" });
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
      // Mirror to customer-audience field per login-unification design.
      // The verified user's email is the same identity for both audiences.
      // Admin cross-clear is defensive belt-and-braces (regenerate() already wiped).
      (req.session as any).customerEmail = user.email;
      (req.session as any).isAdmin = false;
      (req.session as any).adminEmail = undefined;

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
      const { FEATURE_FLAGS } = await import("./config/feature-flags");
      const base: Record<string, unknown> = {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        email_verified: user.email_verified,
        created_at: user.created_at,
      };
      // Dark-ship: only surface public_name when the flag is live. With flag
      // off, clients can't see (and shouldn't render UI for) the toggle.
      if (FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE) {
        base.public_name = (user as any).public_name === true;
      }
      return res.json(base);
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
      const { display_name, public_name } = req.body as { display_name?: string | null; public_name?: unknown };
      const { FEATURE_FLAGS } = await import("./config/feature-flags");

      // Dark-ship gate: with the flag off, public_name in the body is rejected
      // so the feature is invisible end-to-end.
      if (public_name !== undefined && !FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE) {
        return res.status(404).json({ error: "Not found" });
      }
      if (public_name !== undefined && typeof public_name !== "boolean") {
        return res.status(400).json({ error: "public_name must be a boolean" });
      }

      // Touch display_name only if it was explicitly provided in the payload —
      // otherwise toggling public_name shouldn't blank an existing display_name.
      const touchDisplayName = Object.prototype.hasOwnProperty.call(req.body || {}, "display_name");

      // Capture before-state for the public_name audit row.
      let priorPublicName: boolean | null = null;
      if (public_name !== undefined) {
        const row = await db.execute(sql`SELECT public_name FROM users WHERE id = ${userId} LIMIT 1`);
        priorPublicName = (row.rows[0] as any)?.public_name === true;
      }

      if (touchDisplayName && public_name !== undefined) {
        await db.execute(sql`
          UPDATE users SET display_name = ${display_name?.trim() || null},
                          public_name = ${public_name},
                          updated_at = NOW()
          WHERE id = ${userId}
        `);
      } else if (touchDisplayName) {
        await db.execute(sql`UPDATE users SET display_name = ${display_name?.trim() || null}, updated_at = NOW() WHERE id = ${userId}`);
      } else if (public_name !== undefined) {
        await db.execute(sql`UPDATE users SET public_name = ${public_name}, updated_at = NOW() WHERE id = ${userId}`);
      }

      // Audit only the public_name change — display_name is already covered
      // by writeAuthAudit elsewhere if/when wired.
      if (public_name !== undefined && priorPublicName !== public_name) {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES ('user', ${userId}, 'toggle_public_name', ${userId},
            ${JSON.stringify({ from: priorPublicName, to: public_name })}::jsonb)
        `);
        console.log(`[profile] user=${userId} toggled public_name ${priorPublicName} -> ${public_name}`);
      }

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[profile] update error:", err.message);
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

  // ── Instagram automation admin ────────────────────────────────────────────
  // Six routes power the /admin/instagram page. All require admin auth.
  // Audit-log entry written on every state change (entity_type='ig_post' or
  // 'ig_settings'). Soft-delete only — skipped rows get deleted_at, never DROP.
  app.get("/api/admin/ig/settings", requireAdmin, async (_req, res) => {
    try {
      const { igSettings, igPostQueue, certificates } = await import("@shared/schema");
      const { desc, eq, isNull } = await import("drizzle-orm");
      const settings = await db.select().from(igSettings).limit(1);
      const next = await db
        .select()
        .from(igPostQueue)
        .where(isNull(igPostQueue.deletedAt))
        .orderBy(desc(igPostQueue.scheduledFor))
        .limit(1);

      // Enrich nextPost with cert thumbnail URL + the canonical MV-prefixed
      // certIdString (LogbookPage looks up by the string, not the PK).
      let nextPost: any = next[0] ?? null;
      if (nextPost && nextPost.certId != null) {
        const certRows = await db
          .select({ certIdString: certificates.certId, frontImagePath: certificates.frontImagePath })
          .from(certificates)
          .where(eq(certificates.id, nextPost.certId))
          .limit(1);
        const row = certRows[0];
        nextPost = { ...nextPost, certIdString: row?.certIdString ?? null, certThumbnailUrl: null };
        const path = row?.frontImagePath;
        if (path) {
          try {
            const { getR2SignedUrl } = await import("./r2");
            nextPost.certThumbnailUrl = await getR2SignedUrl(path, 3600);
          } catch { /* keep certThumbnailUrl = null */ }
        }
      } else if (nextPost) {
        nextPost = { ...nextPost, certIdString: null, certThumbnailUrl: null };
      }

      res.json({
        postEnabled:  settings[0]?.postEnabled ?? false,
        envGate:      process.env.IG_POST_ENABLED === "true",
        dryRunEnvVar: process.env.IG_DRY_RUN === "true",
        nextPost,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/admin/ig/settings", requireAdmin, async (req, res) => {
    try {
      const { igSettings } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const enabled = !!req.body?.postEnabled;
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      // Ensure single row exists (id=1).
      const existing = await db.select().from(igSettings).limit(1);
      if (existing.length === 0) {
        await db.insert(igSettings).values({ id: 1, postEnabled: enabled, updatedBy: adminEmail });
      } else {
        await db.update(igSettings)
          .set({ postEnabled: enabled, updatedAt: new Date(), updatedBy: adminEmail })
          .where(eq(igSettings.id, existing[0].id));
      }
      try { await storage.writeAuditLog("ig_settings", "1", enabled ? "enable" : "disable", adminEmail, {}); } catch {}
      res.json({ ok: true, postEnabled: enabled });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/ig/queue", requireAdmin, async (req, res) => {
    try {
      const { igPostQueue, certificates } = await import("@shared/schema");
      const { desc, isNull, inArray, sql: drizzleSql } = await import("drizzle-orm");
      const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"), 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const offset = (page - 1) * limit;
      // includeDeleted=true is a debugging hook — not surfaced in UI yet.
      // Default filters soft-deleted rows out of every list response.
      const includeDeleted = String(req.query.includeDeleted ?? "").toLowerCase() === "true";

      const baseQuery = db.select().from(igPostQueue);
      const rows = await (includeDeleted
        ? baseQuery
        : baseQuery.where(isNull(igPostQueue.deletedAt)))
        .orderBy(desc(igPostQueue.scheduledFor))
        .limit(limit)
        .offset(offset);

      const countWhere = includeDeleted ? drizzleSql`1=1` : drizzleSql`deleted_at IS NULL`;
      const countRes = await db.execute<{ n: number }>(drizzleSql`SELECT COUNT(*)::int AS n FROM ig_post_queue WHERE ${countWhere}`);
      const total = (countRes as any).rows?.[0]?.n ?? 0;

      // Batch-fetch cert thumbnails for all rows with cert_id in this page.
      // One DB round-trip + N R2 signs; signs happen in parallel.
      const certPks = Array.from(new Set(rows.map((r) => r.certId).filter((id): id is number => id != null)));
      const certMap = new Map<number, { certIdString: string | null; frontImagePath: string | null }>();
      if (certPks.length > 0) {
        const certRows = await db
          .select({ id: certificates.id, certIdString: certificates.certId, frontImagePath: certificates.frontImagePath })
          .from(certificates)
          .where(inArray(certificates.id, certPks));
        for (const c of certRows) {
          certMap.set(c.id, { certIdString: c.certIdString, frontImagePath: c.frontImagePath });
        }
      }

      const { getR2SignedUrl } = await import("./r2");
      const enriched = await Promise.all(rows.map(async (r) => {
        let certThumbnailUrl: string | null = null;
        let certIdString: string | null = null;
        if (r.certId != null) {
          const meta = certMap.get(r.certId);
          certIdString = meta?.certIdString ?? null;
          if (meta?.frontImagePath) {
            try { certThumbnailUrl = await getR2SignedUrl(meta.frontImagePath, 3600); } catch { certThumbnailUrl = null; }
          }
        }
        return { ...r, certIdString, certThumbnailUrl };
      }));

      res.json({ rows: enriched, page, limit, total });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/ig/post-now", requireAdmin, async (req, res) => {
    try {
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      // Optional override: admin can pin a specific post type instead of
      // using today's day-of-week rotation. Validated against IG_POST_TYPES
      // so a malformed body can't reach the cron entry point.
      const { IG_POST_TYPES } = await import("@shared/schema");
      const rawOverride = typeof req.body?.post_type === "string" ? req.body.post_type : null;
      const postTypeOverride = rawOverride && (IG_POST_TYPES as readonly string[]).includes(rawOverride)
        ? (rawOverride as typeof IG_POST_TYPES[number])
        : undefined;

      const { runIgDailyPost } = await import("./jobs/ig-daily-post");
      const result = await runIgDailyPost({ force: true, postTypeOverride });
      try {
        await storage.writeAuditLog("ig_post", String(result.queueId ?? "n/a"), "post-now-triggered", adminEmail, {
          ...result,
          ...(postTypeOverride ? { override_type: postTypeOverride } : {}),
        });
      } catch {}
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/weekly-reel/generate — manually trigger the Friday
  // weekly grade-highlight reel job (server/jobs/weekly-reel.ts) for
  // testing or re-running on demand. Honours the same scheduler
  // pipeline: top-N consenting graded certs → Segmind hfai-dop-lite →
  // R2 manifest at videos/weekly-reels/draft-{date}.json. Per spec the
  // gate is requireAuth (any authenticated user), not requireAdmin —
  // flag if you want this tightened.
  //
  // Long-running: 8 cards × ~30-60s Segmind each = ~4-8 minutes total.
  // Fly proxy's 60s timeout will likely close the client connection
  // before the job finishes; the Node process keeps running and the
  // audit_log row (entity_type='weekly_reel') captures completion.
  app.post("/api/admin/weekly-reel/generate", requireAdmin, async (_req, res) => {
    try {
      const { runWeeklyReel } = await import("./jobs/weekly-reel");
      const result = await runWeeklyReel({ force: true });
      res.json(result);
    } catch (err: any) {
      console.error("[weekly-reel] manual trigger crashed:", err);
      res.status(500).json({ error: err?.message ?? "weekly-reel failed" });
    }
  });

  // GET /api/admin/weekly-reel/key-status — does Fly have SEGMIND_API_KEY?
  // Boolean only; never echoes the key value.
  app.get("/api/admin/weekly-reel/key-status", requireAdmin, (_req, res) => {
    res.json({ configured: !!process.env.SEGMIND_API_KEY });
  });

  // GET /api/admin/weekly-reel/status — last 10 reel runs from audit_log,
  // joined with the JSON manifest persisted in R2 by the job. Derives a
  // human status (ok / partial / failed / unknown) from successCount and
  // failCount in the manifest.
  //
  // Coverage gap: the job only writes audit_log on completed runs. Pure
  // skips (below-floor, segmind-key-missing) won't appear here. If we
  // need that visibility, add a skip-side audit_log row in the job —
  // separate task.
  app.get("/api/admin/weekly-reel/status", requireAdmin, async (_req, res) => {
    try {
      const rows = (await db.execute(sql`
        SELECT id, entity_id, created_at, details
        FROM audit_log
        WHERE entity_type = 'weekly_reel'
          AND action = 'generated'
        ORDER BY created_at DESC
        LIMIT 10
      `)).rows as Array<{ id: number; entity_id: string; created_at: Date; details: any }>;

      const history = await Promise.all(rows.map(async (row) => {
        const date = row.entity_id;
        const manifestKey = `videos/weekly-reels/draft-${date}.json`;
        let manifest: any = null;
        try {
          const url = await getR2SignedUrl(manifestKey, 60);
          const resp = await fetch(url);
          if (resp.ok) manifest = await resp.json();
        } catch {
          // best-effort — missing manifest doesn't fail the whole list
        }
        const cardCount = manifest?.cardCount ?? row.details?.cardCount ?? 0;
        const successCount = manifest?.successCount ?? row.details?.successCount ?? 0;
        const failCount = manifest?.failCount ?? row.details?.failCount ?? 0;
        const status: "ok" | "partial" | "failed" | "unknown" =
          manifest === null && cardCount === 0 ? "unknown" :
          successCount > 0 && failCount === 0 ? "ok" :
          successCount > 0 && failCount > 0 ? "partial" :
          "failed";
        return {
          date,
          createdAt: row.created_at,
          status,
          cardCount,
          successCount,
          failCount,
          manifestKey,
          manifestPresent: manifest !== null,
          cards: Array.isArray(manifest?.cards) ? manifest.cards : [],
          model: manifest?.model ?? row.details?.model ?? null,
          clipLengthSeconds: manifest?.clipLengthSeconds ?? row.details?.clipLengthSeconds ?? null,
        };
      }));

      res.json({ history });
    } catch (err: any) {
      console.error("[weekly-reel] status fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "status fetch failed" });
    }
  });

  // GET /api/admin/weekly-reel/consenting-cards — every graded cert whose
  // submission has marketing_feature_consent=true (no time window filter,
  // unlike the weekly job's 7-day cutoff). Sorted grade DESC so the most
  // reel-worthy cards surface first.
  app.get("/api/admin/weekly-reel/consenting-cards", requireAdmin, async (_req, res) => {
    try {
      const rows = (await db.execute(sql`
        SELECT
          c.certificate_number       AS cert_number,
          c.grade::text              AS grade,
          c.card_name                AS card_name,
          c.set_name                 AS set_name,
          c.year_text                AS year_text,
          s.marketing_feature_consent_at AS consented_at
        FROM certificates c
        JOIN submission_items si ON si.id = c.submission_item_id
        JOIN submissions     s  ON s.id  = si.submission_id
        WHERE s.marketing_feature_consent = true
          AND s.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND c.grade_approved_at IS NOT NULL
        ORDER BY c.grade DESC NULLS LAST, c.grade_approved_at DESC
      `)).rows as Array<any>;
      const cards = rows.map((r) => ({
        certNumber: String(r.cert_number),
        grade: r.grade != null ? Number(r.grade) : null,
        cardName: r.card_name ?? null,
        cardSet: r.set_name ?? null,
        year: r.year_text ?? null,
        consentedAt: r.consented_at ?? null,
      }));
      res.json({ cards });
    } catch (err: any) {
      console.error("[weekly-reel] consenting-cards fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "consenting-cards fetch failed" });
    }
  });

  // GET /api/admin/weekly-reel/all-graded-cards — every graded cert (whether
  // consenting or not) joined to its submission so the admin UI can render
  // BOTH an "In Pool" table (consent=true) AND a "Not in Pool" table
  // (consent=false) from a single round-trip. Superset of /consenting-cards;
  // that endpoint is now unused but left for backwards-compat.
  app.get("/api/admin/weekly-reel/all-graded-cards", requireAdmin, async (_req, res) => {
    try {
      const rows = (await db.execute(sql`
        SELECT
          c.certificate_number       AS cert_number,
          c.grade::text              AS grade,
          c.card_name                AS card_name,
          c.set_name                 AS set_name,
          c.year_text                AS year_text,
          s.marketing_feature_consent     AS consent,
          s.marketing_feature_consent_at  AS consented_at
        FROM certificates c
        JOIN submission_items si ON si.id = c.submission_item_id
        JOIN submissions     s  ON s.id  = si.submission_id
        WHERE c.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND c.grade_approved_at IS NOT NULL
        ORDER BY c.grade DESC NULLS LAST, c.grade_approved_at DESC
      `)).rows as Array<any>;
      const cards = rows.map((r) => ({
        certNumber: String(r.cert_number),
        grade: r.grade != null ? Number(r.grade) : null,
        cardName: r.card_name ?? null,
        cardSet: r.set_name ?? null,
        year: r.year_text ?? null,
        consent: r.consent === true,
        consentedAt: r.consented_at ?? null,
      }));
      res.json({ cards });
    } catch (err: any) {
      console.error("[weekly-reel] all-graded-cards fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "all-graded-cards fetch failed" });
    }
  });

  // PATCH /api/admin/weekly-reel/card/:certNumber/consent — admin override
  // of the submission's marketing_feature_consent. Walks cert → submission
  // _item → submission. Writes audit_log with before/after +
  // reason='admin_override'. Idempotent — no-op + no audit row when the
  // requested state already matches current.
  app.patch("/api/admin/weekly-reel/card/:certNumber/consent", requireAdmin, async (req, res) => {
    try {
      const certNumberRaw = String(req.params.certNumber).trim();
      if (!certNumberRaw) return res.status(400).json({ error: "certNumber required" });
      const consent = req.body?.consent === true;

      const rows = (await db.execute(sql`
        SELECT s.id AS submission_id, s.marketing_feature_consent
        FROM certificates c
        JOIN submission_items si ON si.id = c.submission_item_id
        JOIN submissions     s  ON s.id  = si.submission_id
        WHERE c.certificate_number = ${certNumberRaw}
          AND c.deleted_at IS NULL
          AND s.deleted_at IS NULL
        LIMIT 1
      `)).rows;
      const cur = rows[0] as any;
      if (!cur) {
        return res.status(404).json({ error: "cert not found OR not linked to a submission" });
      }
      const submissionId = Number(cur.submission_id);
      const before = cur.marketing_feature_consent === true;

      if (before === consent) {
        return res.json({ ok: true, changed: false, consent });
      }

      await db.execute(sql`
        UPDATE submissions
        SET marketing_feature_consent = ${consent},
            marketing_feature_consent_at = NOW(),
            updated_at = NOW()
        WHERE id = ${submissionId}
      `);

      const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
      await db.insert(auditLog).values({
        entityType: "submission",
        entityId: String(submissionId),
        action: "marketing_consent_changed",
        adminUser: actor,
        details: { before, after: consent, reason: "admin_override", certNumber: certNumberRaw },
      });

      res.json({ ok: true, changed: true, consent, submissionId });
    } catch (err: any) {
      console.error("[weekly-reel] consent override failed:", err);
      res.status(500).json({ error: err?.message ?? "consent update failed" });
    }
  });

  // GET /api/admin/weekly-reel/featured-cards — every graded cert with the
  // admin marketing_featured flag. Replaces the consent-driven
  // /all-graded-cards view: the weekly reel pool is now admin-curated and
  // independent of submissions.marketing_feature_consent.
  app.get("/api/admin/weekly-reel/featured-cards", requireAdmin, async (_req, res) => {
    try {
      const rows = (await db.execute(sql`
        SELECT
          c.certificate_number     AS cert_number,
          c.grade::text            AS grade,
          c.card_name              AS card_name,
          c.set_name               AS set_name,
          c.year_text              AS year_text,
          c.marketing_featured     AS featured,
          c.marketing_featured_at  AS featured_at,
          c.marketing_pinned       AS pinned,
          c.marketing_blacklisted  AS blacklisted
        FROM certificates c
        WHERE c.deleted_at IS NULL
          AND c.grade_approved_at IS NOT NULL
        ORDER BY c.marketing_pinned DESC,
                 c.marketing_featured DESC,
                 c.grade DESC NULLS LAST,
                 c.grade_approved_at DESC
      `)).rows as Array<any>;
      const cards = rows.map((r) => ({
        certNumber: String(r.cert_number),
        grade: r.grade != null ? Number(r.grade) : null,
        cardName: r.card_name ?? null,
        cardSet: r.set_name ?? null,
        year: r.year_text ?? null,
        featured: r.featured === true,
        featuredAt: r.featured_at ?? null,
        pinned: r.pinned === true,
        blacklisted: r.blacklisted === true,
      }));
      res.json({ cards });
    } catch (err: any) {
      console.error("[weekly-reel] featured-cards fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "featured-cards fetch failed" });
    }
  });

  // PATCH /api/admin/weekly-reel/card/:certNumber/featured — flip the admin
  // marketing_featured flag on a certificate. Writes audit_log with
  // before/after. Idempotent — no-op + no audit row when state already
  // matches.
  app.patch("/api/admin/weekly-reel/card/:certNumber/featured", requireAdmin, async (req, res) => {
    try {
      const certNumberRaw = String(req.params.certNumber).trim();
      if (!certNumberRaw) return res.status(400).json({ error: "certNumber required" });
      const featured = req.body?.featured === true;

      const rows = (await db.execute(sql`
        SELECT id, marketing_featured
        FROM certificates
        WHERE certificate_number = ${certNumberRaw}
          AND deleted_at IS NULL
        LIMIT 1
      `)).rows;
      const cur = rows[0] as any;
      if (!cur) {
        return res.status(404).json({ error: "cert not found" });
      }
      const certId = Number(cur.id);
      const before = cur.marketing_featured === true;

      if (before === featured) {
        return res.json({ ok: true, changed: false, featured });
      }

      await db.execute(sql`
        UPDATE certificates
        SET marketing_featured = ${featured},
            marketing_featured_at = NOW()
        WHERE id = ${certId}
      `);

      const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
      await db.insert(auditLog).values({
        entityType: "certificate",
        entityId: String(certId),
        action: "marketing_featured_changed",
        adminUser: actor,
        details: { before, after: featured, certNumber: certNumberRaw },
      });

      res.json({ ok: true, changed: true, featured, certId });
    } catch (err: any) {
      console.error("[weekly-reel] featured override failed:", err);
      res.status(500).json({ error: err?.message ?? "featured update failed" });
    }
  });

  // ── Pipeline settings (single key/value store backing every admin dial) ──

  app.get("/api/admin/weekly-reel/settings", requireAdmin, async (_req, res) => {
    try {
      const { getAllSettings } = await import("./lib/pipeline-settings");
      const settings = await getAllSettings();
      res.json({ settings });
    } catch (err: any) {
      console.error("[weekly-reel] settings fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "settings fetch failed" });
    }
  });

  // PATCH body: { key, value }. Validates key against PIPELINE_DEFAULTS and
  // clamps numeric values into their permitted ranges so a typo in the UI
  // can't put the scheduler into an invalid state.
  app.patch("/api/admin/weekly-reel/settings", requireAdmin, async (req, res) => {
    try {
      const { PIPELINE_DEFAULTS, setSetting, getSetting } = await import("./lib/pipeline-settings");
      const key = String(req.body?.key ?? "").trim();
      if (!(key in PIPELINE_DEFAULTS)) {
        return res.status(400).json({ error: `unknown setting key: ${key}` });
      }
      const raw = req.body?.value;
      // Per-key sanitisation. Keep this small + obvious; extra cases get
      // their own dedicated endpoint.
      let value: any = raw;
      switch (key) {
        case "schedule_day":
          value = Math.max(0, Math.min(6, Number(raw)));
          break;
        case "schedule_hour_utc":
          value = Math.max(0, Math.min(23, Number(raw)));
          break;
        case "min_grade":
          value = Math.max(0, Math.min(10, Number(raw)));
          break;
        case "max_cards":
          value = Math.max(3, Math.min(8, Number(raw)));
          break;
        case "clip_length_seconds":
          value = [4, 6, 8].includes(Number(raw)) ? Number(raw) : 6;
          break;
        case "output_resolution":
          value = Number(raw) === 720 ? 720 : 1080;
          break;
        case "sort_order":
          value = ["grade_desc", "value_desc", "newest_first"].includes(String(raw))
            ? String(raw) : "grade_desc";
          break;
        case "pipeline_paused":
        case "include_back":
        case "auto_post_instagram":
        case "watermark_enabled":
        case "auto_post_instagram_video":
        case "auto_post_facebook":
        case "instagram_draft_mode":
        case "auto_post_tiktok":
        case "tiktok_disable_duet":
        case "tiktok_disable_stitch":
        case "text_overlay_enabled":
        case "require_card_approval":
        case "auto_generate_thumbnail":
        case "notify_card_owners":
        case "smart_schedule":
          value = raw === true || raw === "true";
          break;
        case "post_delay_minutes":
          value = Math.max(0, Math.min(180, Number(raw) || 0));
          break;
        case "tiktok_privacy":
          value = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].includes(String(raw))
            ? String(raw) : "PUBLIC_TO_EVERYONE";
          break;
        case "transition_style":
          value = ["cut", "dissolve", "zoom"].includes(String(raw))
            ? String(raw) : "cut";
          break;
        case "video_prompt":
        case "video_model":
        case "caption_template":
        case "notify_email":
        case "notify_webhook_url":
        case "intro_video_r2_key":
        case "outro_video_r2_key":
        case "background_music_r2_key":
        case "text_overlay_format":
          value = String(raw ?? "");
          break;
        default:
          // unreachable — `key in PIPELINE_DEFAULTS` is the gate
          break;
      }
      const before = await getSetting(key as any, (PIPELINE_DEFAULTS as any)[key]);
      const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
      await setSetting(key as any, value, actor);
      try {
        await db.insert(auditLog).values({
          entityType: "pipeline_setting",
          entityId: key,
          action: "setting_changed",
          adminUser: actor,
          details: { key, before, after: value },
        });
      } catch {}
      res.json({ ok: true, key, value });
    } catch (err: any) {
      console.error("[weekly-reel] settings update failed:", err);
      res.status(500).json({ error: err?.message ?? "settings update failed" });
    }
  });

  // PATCH /pinned and /blacklisted — same shape as /featured.
  function makeBoolColPatch(opts: {
    bodyField: string;
    sqlCol: string;
    auditAction: string;
    logTag: string;
  }) {
    return async (req: any, res: any) => {
      try {
        const certNumberRaw = String(req.params.certNumber).trim();
        if (!certNumberRaw) return res.status(400).json({ error: "certNumber required" });
        const nextVal = req.body?.[opts.bodyField] === true;
        const rows = (await db.execute(sql`
          SELECT id, ${sql.raw(opts.sqlCol)} AS cur
          FROM certificates
          WHERE certificate_number = ${certNumberRaw}
            AND deleted_at IS NULL
          LIMIT 1
        `)).rows;
        const cur = rows[0] as any;
        if (!cur) return res.status(404).json({ error: "cert not found" });
        const certId = Number(cur.id);
        const before = cur.cur === true;
        if (before === nextVal) return res.json({ ok: true, changed: false, [opts.bodyField]: nextVal });
        await db.execute(sql`
          UPDATE certificates
          SET ${sql.raw(opts.sqlCol)} = ${nextVal}
          WHERE id = ${certId}
        `);
        const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
        try {
          await db.insert(auditLog).values({
            entityType: "certificate",
            entityId: String(certId),
            action: opts.auditAction,
            adminUser: actor,
            details: { before, after: nextVal, certNumber: certNumberRaw },
          });
        } catch {}
        res.json({ ok: true, changed: true, [opts.bodyField]: nextVal, certId });
      } catch (err: any) {
        console.error(`[${opts.logTag}] update failed:`, err);
        res.status(500).json({ error: err?.message ?? "update failed" });
      }
    };
  }

  app.patch(
    "/api/admin/weekly-reel/card/:certNumber/pinned",
    requireAdmin,
    makeBoolColPatch({
      bodyField: "pinned",
      sqlCol: "marketing_pinned",
      auditAction: "marketing_pinned_changed",
      logTag: "weekly-reel:pin",
    }),
  );

  app.patch(
    "/api/admin/weekly-reel/card/:certNumber/blacklisted",
    requireAdmin,
    makeBoolColPatch({
      bodyField: "blacklisted",
      sqlCol: "marketing_blacklisted",
      auditAction: "marketing_blacklisted_changed",
      logTag: "weekly-reel:blacklist",
    }),
  );

  // POST /test-webhook — fires a synthetic payload to the configured webhook
  // so the operator can verify the URL accepts traffic before relying on it.
  app.post("/api/admin/weekly-reel/test-webhook", requireAdmin, async (_req, res) => {
    try {
      const { getAllSettings } = await import("./lib/pipeline-settings");
      const { postReelWebhook } = await import("./lib/reel-notifications");
      const settings = await getAllSettings();
      if (!settings.notify_webhook_url) {
        return res.status(400).json({ error: "notify_webhook_url not configured" });
      }
      await postReelWebhook(settings.notify_webhook_url, {
        date: new Date().toISOString().slice(0, 10),
        status: "ok",
        cardCount: 0,
        successCount: 0,
        failCount: 0,
        manifestKey: "test-payload",
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "webhook test failed" });
    }
  });

  // POST /rerun — regenerate the reel for the same date key with force=true.
  // Same long-running characteristics as /generate.
  app.post("/api/admin/weekly-reel/rerun", requireAdmin, async (_req, res) => {
    try {
      const { runWeeklyReel } = await import("./jobs/weekly-reel");
      const result = await runWeeklyReel({ force: true });
      res.json(result);
    } catch (err: any) {
      console.error("[weekly-reel] rerun crashed:", err);
      res.status(500).json({ error: err?.message ?? "rerun failed" });
    }
  });

  // GET /api/admin/weekly-reel/analytics — last 12 weeks + running total cost.
  app.get("/api/admin/weekly-reel/analytics", requireAdmin, async (_req, res) => {
    try {
      const rows = (await db.execute(sql`
        SELECT reel_date, card_count, success_count, fail_count,
               estimated_cost_usd::text AS estimated_cost_usd,
               model, clip_length_seconds, created_at,
               instagram_post_id, facebook_post_id, tiktok_post_id,
               instagram_likes, instagram_views, instagram_reach,
               instagram_comments, thumbnail_r2_key
        FROM reel_analytics
        ORDER BY created_at DESC
        LIMIT 12
      `)).rows as Array<any>;
      const totalRow = (await db.execute(sql`
        SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS total
        FROM reel_analytics
      `)).rows[0] as any;
      res.json({
        rows: rows.map((r) => ({
          reelDate: r.reel_date,
          cardCount: r.card_count,
          successCount: r.success_count,
          failCount: r.fail_count,
          estimatedCostUsd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : 0,
          model: r.model,
          clipLengthSeconds: r.clip_length_seconds,
          createdAt: r.created_at,
          instagramPostId: r.instagram_post_id ?? null,
          facebookPostId: r.facebook_post_id ?? null,
          tiktokPostId: r.tiktok_post_id ?? null,
          instagramLikes: r.instagram_likes ?? null,
          instagramViews: r.instagram_views ?? null,
          instagramReach: r.instagram_reach ?? null,
          instagramComments: r.instagram_comments ?? null,
          thumbnailR2Key: r.thumbnail_r2_key ?? null,
        })),
        totalCostUsd: totalRow?.total != null ? Number(totalRow.total) : 0,
      });
    } catch (err: any) {
      console.error("[weekly-reel] analytics fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "analytics fetch failed" });
    }
  });

  // ── Social publishing (Meta + TikTok) ──────────────────────────────────

  // Helper: read manifest JSON for a date from R2. Returns null on miss.
  async function readReelManifest(date: string): Promise<any | null> {
    const key = `videos/weekly-reels/draft-${date}.json`;
    try {
      const url = await getR2SignedUrl(key, 60);
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function ensureAllCardsApproved(date: string): Promise<{ ok: boolean; pending: string[] }> {
    try {
      const rows = (await db.execute(sql`
        SELECT cert_number, approved FROM reel_card_approvals WHERE reel_date = ${date}
      `)).rows as Array<{ cert_number: string; approved: boolean }>;
      if (rows.length === 0) return { ok: true, pending: [] };
      const pending = rows.filter(r => r.approved !== true).map(r => r.cert_number);
      return { ok: pending.length === 0, pending };
    } catch {
      return { ok: true, pending: [] };
    }
  }

  app.get("/api/admin/weekly-reel/meta-status", requireAdmin, async (_req, res) => {
    try {
      const { getMetaTokenStatus } = await import("./lib/meta-publisher");
      res.json(await getMetaTokenStatus());
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "meta-status failed" });
    }
  });

  app.get("/api/admin/weekly-reel/tiktok-status", requireAdmin, async (_req, res) => {
    try {
      const { getTikTokTokenStatus } = await import("./lib/tiktok-publisher");
      res.json(await getTikTokTokenStatus());
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "tiktok-status failed" });
    }
  });

  // Shared publish handler factory — IG/FB/TikTok all follow the same shape:
  // read manifest → require approvals (when configured) → pick top video →
  // call publisher → store post id in reel_analytics.
  async function publishHandler(
    req: any, res: any,
    publisher: (videoUrl: string, caption: string) => Promise<{ postId: string }>,
    column: "instagram_post_id" | "facebook_post_id" | "tiktok_post_id",
    label: string,
  ) {
    try {
      const date = String(req.body?.date ?? "").trim();
      if (!date) return res.status(400).json({ error: "date required" });
      const manifest = await readReelManifest(date);
      if (!manifest) return res.status(404).json({ error: "manifest not found" });
      const { getAllSettings } = await import("./lib/pipeline-settings");
      const settings = await getAllSettings();
      if (settings.require_card_approval) {
        const approval = await ensureAllCardsApproved(date);
        if (!approval.ok) {
          return res.status(409).json({ error: "approvals_pending", pending: approval.pending });
        }
      }
      const topCard = (manifest.cards ?? []).find((c: any) => c.videoUrl);
      if (!topCard?.videoUrl) return res.status(400).json({ error: "no successful video in manifest" });
      const caption = String(manifest.caption ?? "");
      const { postId } = await publisher(topCard.videoUrl, caption);
      await db.execute(sql`
        UPDATE reel_analytics
        SET ${sql.raw(column)} = ${postId}
        WHERE reel_date = ${date}
      `);
      const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
      try {
        await db.insert(auditLog).values({
          entityType: "weekly_reel", entityId: date, action: `${label}_published`,
          adminUser: actor, details: { postId },
        });
      } catch {}
      res.json({ ok: true, postId });
    } catch (err: any) {
      const msg = err?.message ?? "publish failed";
      if (msg === "token_not_configured") return res.json({ error: "token_not_configured" });
      console.error(`[weekly-reel] ${label} publish failed:`, err);
      res.status(500).json({ error: msg });
    }
  }

  app.post("/api/admin/weekly-reel/publish-instagram", requireAdmin, async (req, res) => {
    const { publishToInstagram } = await import("./lib/meta-publisher");
    return publishHandler(req, res, publishToInstagram, "instagram_post_id", "instagram");
  });

  app.post("/api/admin/weekly-reel/publish-facebook", requireAdmin, async (req, res) => {
    const { publishToFacebook } = await import("./lib/meta-publisher");
    return publishHandler(req, res, publishToFacebook, "facebook_post_id", "facebook");
  });

  app.post("/api/admin/weekly-reel/publish-tiktok", requireAdmin, async (req, res) => {
    const { publishToTikTok } = await import("./lib/tiktok-publisher");
    const { getAllSettings } = await import("./lib/pipeline-settings");
    const settings = await getAllSettings();
    return publishHandler(
      req, res,
      (videoUrl, caption) => publishToTikTok(videoUrl, caption, {
        privacy: settings.tiktok_privacy,
        disableDuet: settings.tiktok_disable_duet,
        disableStitch: settings.tiktok_disable_stitch,
      }),
      "tiktok_post_id", "tiktok",
    );
  });

  // POST /refresh-insights — pull latest IG numbers for a reel and store
  // in reel_analytics.
  app.post("/api/admin/weekly-reel/refresh-insights", requireAdmin, async (req, res) => {
    try {
      const date = String(req.body?.date ?? "").trim();
      if (!date) return res.status(400).json({ error: "date required" });
      const row = (await db.execute(sql`
        SELECT instagram_post_id FROM reel_analytics WHERE reel_date = ${date} LIMIT 1
      `)).rows[0] as { instagram_post_id?: string } | undefined;
      if (!row?.instagram_post_id) return res.status(404).json({ error: "no instagram_post_id for date" });
      const { getInstagramInsights } = await import("./lib/meta-publisher");
      const insights = await getInstagramInsights(row.instagram_post_id);
      await db.execute(sql`
        UPDATE reel_analytics
        SET instagram_likes    = ${insights.likes},
            instagram_views    = ${insights.views},
            instagram_reach    = ${insights.reach},
            instagram_comments = ${insights.comments}
        WHERE reel_date = ${date}
      `);
      res.json({ ok: true, insights });
    } catch (err: any) {
      const msg = err?.message ?? "refresh-insights failed";
      if (msg === "token_not_configured") return res.json({ error: "token_not_configured" });
      console.error("[weekly-reel] refresh-insights failed:", err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Per-card approval workflow ─────────────────────────────────────────

  app.get("/api/admin/weekly-reel/approvals/:date", requireAdmin, async (req, res) => {
    try {
      const date = String(req.params.date).trim();
      const rows = (await db.execute(sql`
        SELECT cert_number, approved, reviewed_at, reviewed_by
        FROM reel_card_approvals
        WHERE reel_date = ${date}
        ORDER BY cert_number
      `)).rows as Array<any>;
      res.json({
        date,
        cards: rows.map(r => ({
          certNumber: r.cert_number,
          approved: r.approved === true,
          reviewedAt: r.reviewed_at ?? null,
          reviewedBy: r.reviewed_by ?? null,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "approvals fetch failed" });
    }
  });

  app.patch("/api/admin/weekly-reel/approvals/:date/:certNumber", requireAdmin, async (req, res) => {
    try {
      const date = String(req.params.date).trim();
      const certNumber = String(req.params.certNumber).trim();
      const approved = req.body?.approved === true;
      const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
      await db.execute(sql`
        INSERT INTO reel_card_approvals (reel_date, cert_number, approved, reviewed_at, reviewed_by)
        VALUES (${date}, ${certNumber}, ${approved}, NOW(), ${actor})
        ON CONFLICT (reel_date, cert_number) DO UPDATE
          SET approved = EXCLUDED.approved,
              reviewed_at = NOW(),
              reviewed_by = EXCLUDED.reviewed_by
      `);
      res.json({ ok: true, date, certNumber, approved });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "approval update failed" });
    }
  });

  app.post("/api/admin/weekly-reel/approvals/:date/approve-all", requireAdmin, async (req, res) => {
    try {
      const date = String(req.params.date).trim();
      const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
      await db.execute(sql`
        UPDATE reel_card_approvals
        SET approved = true, reviewed_at = NOW(), reviewed_by = ${actor}
        WHERE reel_date = ${date}
      `);
      res.json({ ok: true, date });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "approve-all failed" });
    }
  });

  // POST /regenerate-card — re-run Segmind for one card only, replace the
  // entry in the manifest. Cheap-and-cheerful: no re-running of approvals.
  app.post("/api/admin/weekly-reel/regenerate-card", requireAdmin, async (req, res) => {
    try {
      const date = String(req.body?.date ?? "").trim();
      const certNumber = String(req.body?.certNumber ?? "").trim();
      if (!date || !certNumber) return res.status(400).json({ error: "date + certNumber required" });
      if (!process.env.SEGMIND_API_KEY) return res.status(400).json({ error: "SEGMIND_API_KEY missing" });

      const manifestKey = `videos/weekly-reels/draft-${date}.json`;
      const manifest = await readReelManifest(date);
      if (!manifest) return res.status(404).json({ error: "manifest not found" });

      const { getAllSettings } = await import("./lib/pipeline-settings");
      const settings = await getAllSettings();
      const { imageToVideo } = await import("./lib/segmind-client");

      const cardIdx = (manifest.cards ?? []).findIndex((c: any) => c.certNumber === certNumber);
      if (cardIdx < 0) return res.status(404).json({ error: "card not in manifest" });

      const frontKey = `images/${certNumber}/front.png`;
      const srcUrl = await getR2SignedUrl(frontKey, 60 * 60);
      let videoUrl: string | null = null;
      let error: string | undefined = undefined;
      try {
        videoUrl = await imageToVideo(srcUrl, settings.video_prompt, {
          model: settings.video_model,
          clipLengthSeconds: settings.clip_length_seconds,
        });
      } catch (err: any) {
        error = err?.message ?? String(err);
      }

      manifest.cards[cardIdx] = {
        ...manifest.cards[cardIdx],
        videoUrl,
        error,
      };
      // Recount success/fail
      const cards = manifest.cards as Array<any>;
      manifest.successCount = cards.filter(c => c.videoUrl).length;
      manifest.failCount = cards.length - manifest.successCount;

      try {
        await uploadToR2(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"), "application/json");
      } catch (err: any) {
        return res.status(500).json({ error: `manifest re-upload failed: ${err?.message ?? err}` });
      }

      res.json({ ok: true, videoUrl, error });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "regenerate failed" });
    }
  });

  // ── Content enhancement uploads (intro / outro / music) ────────────────

  const reelAssetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },   // 50 MB cap
  });

  function makeAssetUploadHandler(opts: {
    r2Key: string;
    settingKey: "intro_video_r2_key" | "outro_video_r2_key" | "background_music_r2_key";
    contentType: string;
    logTag: string;
  }) {
    return async (req: any, res: any) => {
      try {
        const file = req.file;
        if (!file?.buffer?.length) return res.status(400).json({ error: "file required" });
        await uploadToR2(opts.r2Key, file.buffer, opts.contentType);
        const { setSetting } = await import("./lib/pipeline-settings");
        const actor = (req.session as any)?.userId ?? ADMIN_EMAIL ?? "admin";
        await setSetting(opts.settingKey, opts.r2Key, actor);
        res.json({ ok: true, r2Key: opts.r2Key, size: file.buffer.length });
      } catch (err: any) {
        console.error(`[${opts.logTag}] upload failed:`, err);
        res.status(500).json({ error: err?.message ?? "upload failed" });
      }
    };
  }

  app.post("/api/admin/weekly-reel/upload-intro", requireAdmin, reelAssetUpload.single("file"),
    makeAssetUploadHandler({
      r2Key: "weekly-reel/intro.mp4",
      settingKey: "intro_video_r2_key",
      contentType: "video/mp4",
      logTag: "reel-asset:intro",
    }));
  app.post("/api/admin/weekly-reel/upload-outro", requireAdmin, reelAssetUpload.single("file"),
    makeAssetUploadHandler({
      r2Key: "weekly-reel/outro.mp4",
      settingKey: "outro_video_r2_key",
      contentType: "video/mp4",
      logTag: "reel-asset:outro",
    }));
  app.post("/api/admin/weekly-reel/upload-music", requireAdmin, reelAssetUpload.single("file"),
    makeAssetUploadHandler({
      r2Key: "weekly-reel/music.mp3",
      settingKey: "background_music_r2_key",
      contentType: "audio/mpeg",
      logTag: "reel-asset:music",
    }));

  // ── Thumbnail presigned URL ────────────────────────────────────────────

  app.get("/api/admin/weekly-reel/thumbnail/:date", requireAdmin, async (req, res) => {
    try {
      const date = String(req.params.date).trim();
      const key = `videos/weekly-reels/thumbnail-${date}.jpg`;
      const url = await getR2SignedUrl(key, 60 * 60);
      res.json({ url });
    } catch (err: any) {
      res.status(404).json({ error: "thumbnail not available" });
    }
  });

  // ── Public reel endpoints (no auth) ────────────────────────────────────

  // GET /api/reels — last 12 reel runs with successCount > 0. Manifests
  // fetched from R2 + audit_log to determine recency. PII-free: only
  // cert numbers, grades, card names + video URLs are returned. No
  // owner emails, no submission internals.
  app.get("/api/reels", async (_req, res) => {
    try {
      const rows = (await db.execute(sql`
        SELECT entity_id, created_at
        FROM audit_log
        WHERE entity_type = 'weekly_reel' AND action = 'generated'
        ORDER BY created_at DESC
        LIMIT 24
      `)).rows as Array<{ entity_id: string; created_at: Date }>;
      const reels = [];
      for (const row of rows) {
        const manifest = await readReelManifest(row.entity_id);
        if (!manifest) continue;
        if ((manifest.successCount ?? 0) <= 0) continue;
        reels.push({
          date: row.entity_id,
          generatedAt: manifest.generatedAt ?? row.created_at,
          caption: manifest.caption ?? "",
          cardCount: manifest.cardCount ?? 0,
          successCount: manifest.successCount ?? 0,
          thumbnailKey: manifest.thumbnailR2Key ?? null,
          cards: (manifest.cards ?? [])
            .filter((c: any) => c.videoUrl)
            .map((c: any) => ({
              certNumber: c.certNumber,
              grade: c.grade,
              cardName: c.cardName,
              videoUrl: c.videoUrl,
            })),
        });
        if (reels.length >= 12) break;
      }
      res.json({ reels });
    } catch (err: any) {
      console.error("[public-reels] fetch failed:", err);
      res.status(500).json({ error: err?.message ?? "reels fetch failed" });
    }
  });

  // GET /api/reels/:date/:certNumber — single card from a reel manifest.
  // Used by the public /share/reel page.
  app.get("/api/reels/:date/:certNumber", async (req, res) => {
    try {
      const date = String(req.params.date).trim();
      const certNumber = String(req.params.certNumber).trim();
      const manifest = await readReelManifest(date);
      if (!manifest) return res.status(404).json({ error: "reel not found" });
      const card = (manifest.cards ?? []).find((c: any) => c.certNumber === certNumber && c.videoUrl);
      if (!card) return res.status(404).json({ error: "card not in reel" });
      res.json({
        date,
        certNumber: card.certNumber,
        grade: card.grade,
        cardName: card.cardName,
        videoUrl: card.videoUrl,
        caption: manifest.caption ?? "",
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "share-reel fetch failed" });
    }
  });

  app.patch("/api/admin/ig/queue/:id/skip", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      await db.update(igPostQueue)
        .set({ status: "skipped", deletedAt: new Date() })
        .where(eq(igPostQueue.id, id));
      try { await storage.writeAuditLog("ig_post", String(id), "skipped", adminEmail, {}); } catch {}
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/admin/ig/queue/:id/retry", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      await db.update(igPostQueue)
        .set({ status: "pending", errorDetail: null })
        .where(eq(igPostQueue.id, id));
      try { await storage.writeAuditLog("ig_post", String(id), "retry", adminEmail, {}); } catch {}
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Signed URL for queue-row image preview (admin only, 60s expiry).
  app.get("/api/admin/ig/queue/:id/image-url", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(igPostQueue).where(eq(igPostQueue.id, id)).limit(1);
      const row = rows[0];
      if (!row?.imageR2Key) return res.status(404).json({ error: "No image for this queue row" });
      const { getR2SignedUrl } = await import("./r2");
      const url = await getR2SignedUrl(row.imageR2Key, 60);
      res.json({ url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── IG queue row edits (caption, hashtags, scheduled_for) ─────────────────
  // Combined PATCH endpoint — accept any subset of editable fields and only
  // update what was supplied. Server-side validation per field. Audit log
  // records which fields changed so the trail is greppable later.
  app.patch("/api/admin/ig/queue/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const body = req.body ?? {};
      const updates: Record<string, any> = {};
      const fieldsChanged: string[] = [];

      // Caption — IG hard cap is 2200 chars.
      if (typeof body.caption === "string") {
        if (body.caption.length > 2200) {
          return res.status(400).json({ error: `Caption too long — ${body.caption.length}/2200 chars` });
        }
        updates.caption = body.caption;
        fieldsChanged.push("caption");
      }

      // Hashtags — trim each token, dedupe, max 30 tags.
      if (typeof body.hashtags === "string") {
        const tags = body.hashtags.split(/\s+/).map((t: string) => t.trim()).filter(Boolean);
        if (tags.length > 30) {
          return res.status(400).json({ error: `Too many hashtags — ${tags.length} (max 30)` });
        }
        updates.hashtags = tags.join(" ");
        fieldsChanged.push("hashtags");
      }

      // Scheduled time — ISO 8601, must parse + be in the future.
      if (typeof body.scheduled_for === "string") {
        const dt = new Date(body.scheduled_for);
        if (isNaN(dt.getTime())) {
          return res.status(400).json({ error: "scheduled_for must be a valid ISO 8601 datetime" });
        }
        if (dt.getTime() <= Date.now()) {
          return res.status(400).json({ error: "scheduled_for must be in the future" });
        }
        updates.scheduledFor = dt;
        fieldsChanged.push("scheduled_for");
      }

      if (fieldsChanged.length === 0) {
        return res.status(400).json({ error: "No editable fields supplied (caption, hashtags, scheduled_for)" });
      }

      await db.update(igPostQueue).set(updates).where(eq(igPostQueue.id, id));
      try { await storage.writeAuditLog("ig_post", String(id), "manual_edit", adminEmail, { fields_changed: fieldsChanged }); } catch {}
      res.json({ ok: true, fieldsChanged });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Replace queue row image (manual upload, overrides generated render) ──
  // Multer in-memory; 50 MB cap (TIFFs from the scanner are large).
  // Accepts JPEG, PNG, TIFF, WebP. Server-side converts EVERYTHING to JPEG
  // before R2 upload because the Meta Graph API only accepts JPEG for IG
  // posts — uniform output format means the publish path doesn't have to
  // branch by source type. R2 object is always .jpg with image/jpeg
  // content-type regardless of what the admin uploaded.
  const ACCEPTED_UPLOAD_MIMES = new Set([
    "image/jpeg",
    "image/jpg",     // less standard but seen from some clients
    "image/png",
    "image/tiff",
    "image/x-tiff",  // alternate TIFF mime
    "image/webp",
  ]);
  const igImageUpload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 50 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
      if (ACCEPTED_UPLOAD_MIMES.has(file.mimetype)) return cb(null, true);
      cb(new Error(`Unsupported format ${file.mimetype} — accepted: JPEG, PNG, TIFF, WebP`));
    },
  });
  app.post(
    "/api/admin/ig/queue/:id/replace-image",
    requireAdmin,
    igImageUpload.single("image"),
    async (req, res) => {
      try {
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
        if (!req.file) return res.status(400).json({ error: "No file provided (form field 'image')" });
        const adminEmail = (req.session as any)?.adminEmail ?? null;

        const { igPostQueue } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        const rows = await db.select().from(igPostQueue).where(eq(igPostQueue.id, id)).limit(1);
        const row = rows[0];
        if (!row) return res.status(404).json({ error: "Queue row not found" });

        const sharp = (await import("sharp")).default;
        // Read metadata from the original buffer (sharp understands all 4
        // input formats). Reused for the squareWarning + the converted JPEG.
        let dimensions: { width?: number; height?: number; squareWarning?: boolean } = {};
        try {
          const meta = await sharp(req.file.buffer).metadata();
          dimensions = {
            width: meta.width,
            height: meta.height,
            squareWarning: meta.width !== meta.height,
          };
        } catch { /* metadata extraction is best-effort */ }

        // Always convert to JPEG @ q=92. Meta Graph API only accepts JPEG
        // for IG posts, so doing it here means the publish path stays format-
        // agnostic. JPEG @ 92 is a sensible quality/size trade-off — file
        // bytes drop ~70% vs PNG/TIFF for the same visual fidelity.
        const jpegBuffer = await sharp(req.file.buffer)
          .jpeg({ quality: 92 })
          .toBuffer();

        const newKey = `ig/manual-upload/${id}-${Date.now()}.jpg`;
        const { uploadToR2 } = await import("./r2");
        await uploadToR2(newKey, jpegBuffer, "image/jpeg");

        await db.update(igPostQueue)
          .set({ imageR2Key: newKey })
          .where(eq(igPostQueue.id, id));

        try {
          await storage.writeAuditLog("ig_post", String(id), "manual_image_upload", adminEmail, {
            old_key:        row.imageR2Key,
            new_key:        newKey,
            uploaded_mime:  req.file.mimetype,
            uploaded_size:  req.file.size,
            stored_mime:    "image/jpeg",
            stored_size:    jpegBuffer.length,
            converted:      req.file.mimetype !== "image/jpeg",
            ...dimensions,
          });
        } catch {}
        res.json({ ok: true, r2Key: newKey, ...dimensions, converted: req.file.mimetype !== "image/jpeg" });
      } catch (err: any) {
        // Multer errors land here (file too big, unsupported format)
        res.status(400).json({ error: err.message });
      }
    },
  );

  // ── Regenerate caption — re-run the Anthropic call (or fallback) with the
  // same data the queue row was originally built from. For card_reveal /
  // grade_breakdown rows we re-pull the pinned cert by PK so regen sticks
  // to the same card. Non-card post types refetch from the live data source.
  app.post("/api/admin/ig/queue/:id/regenerate-caption", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const adminEmail = (req.session as any)?.adminEmail ?? null;

      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(igPostQueue).where(eq(igPostQueue.id, id)).limit(1);
      const row = rows[0];
      if (!row) return res.status(404).json({ error: "Queue row not found" });

      const { fetchCardRevealDataForCertPk, fetchGradeBreakdownDataForCertPk, fetchPostData } = await import("./ig/data-fetcher");
      let data;
      if (row.certId != null && row.postType === "card_reveal") {
        data = await fetchCardRevealDataForCertPk(row.certId);
      } else if (row.certId != null && row.postType === "grade_breakdown") {
        data = await fetchGradeBreakdownDataForCertPk(row.certId);
      } else {
        data = await fetchPostData(row.postType as any);
      }
      if (!data) return res.status(409).json({ error: "Could not rebuild post data (cert may be deleted or post type unavailable)" });

      const { generateCaption } = await import("./ig/caption-generator");
      const { caption, hashtags, fromFallback } = await generateCaption(data);

      await db.update(igPostQueue)
        .set({ caption, hashtags })
        .where(eq(igPostQueue.id, id));
      try { await storage.writeAuditLog("ig_post", String(id), "regenerate_caption", adminEmail, { fromFallback }); } catch {}
      res.json({ ok: true, caption, hashtags, fromFallback });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Regenerate image — re-render the SVG composite. Always uploads to a
  // NEW R2 key (ig/regen/...), never overwrites the previous one. Works even
  // if a manual upload had replaced the prior image — regen always pulls
  // fresh data from the cert PK / post-type fetcher.
  app.post("/api/admin/ig/queue/:id/regenerate-image", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const adminEmail = (req.session as any)?.adminEmail ?? null;

      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(igPostQueue).where(eq(igPostQueue.id, id)).limit(1);
      const row = rows[0];
      if (!row) return res.status(404).json({ error: "Queue row not found" });

      const { fetchCardRevealDataForCertPk, fetchGradeBreakdownDataForCertPk, fetchPostData } = await import("./ig/data-fetcher");
      let data;
      if (row.certId != null && row.postType === "card_reveal") {
        data = await fetchCardRevealDataForCertPk(row.certId);
      } else if (row.certId != null && row.postType === "grade_breakdown") {
        data = await fetchGradeBreakdownDataForCertPk(row.certId);
      } else {
        data = await fetchPostData(row.postType as any);
      }
      if (!data) return res.status(409).json({ error: "Could not rebuild post data (cert may be deleted or post type unavailable)" });

      const { generateIgImage } = await import("./ig/image-generator");
      const imageBuffer = await generateIgImage(data);

      const newKey = `ig/regen/${id}-${Date.now()}.png`;
      const { uploadToR2 } = await import("./r2");
      await uploadToR2(newKey, imageBuffer, "image/png");

      await db.update(igPostQueue)
        .set({ imageR2Key: newKey })
        .where(eq(igPostQueue.id, id));

      try {
        await storage.writeAuditLog("ig_post", String(id), "image_regenerate", adminEmail, {
          old_key: row.imageR2Key,
          new_key: newKey,
        });
      } catch {}
      res.json({ ok: true, r2Key: newKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Hashtag preset bundles ────────────────────────────────────────────────
  // Served read-only — bundles defined in shared/ig-hashtag-presets.ts so
  // editing copy is a single-file change, no API restart needed if the bundle
  // is re-imported on each request.
  app.get("/api/admin/ig/hashtag-presets", requireAdmin, async (_req, res) => {
    try {
      const { IG_HASHTAG_PRESETS } = await import("@shared/ig-hashtag-presets");
      res.json(IG_HASHTAG_PRESETS);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Soft-delete a queue row ───────────────────────────────────────────────
  // Distinct from PATCH /skip (which marks status='skipped' and soft-deletes
  // as one combined action). DELETE preserves the prior status but hides the
  // row from queue lists. Posted rows are protected — preserves the Meta
  // post-ID audit trail.
  app.delete("/api/admin/ig/queue/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const adminEmail = (req.session as any)?.adminEmail ?? null;

      const { igPostQueue } = await import("@shared/schema");
      const { and, eq, isNull } = await import("drizzle-orm");
      const rows = await db.select().from(igPostQueue).where(and(
        eq(igPostQueue.id, id),
        isNull(igPostQueue.deletedAt),
      )).limit(1);
      const row = rows[0];
      if (!row) return res.status(404).json({ error: "Queue row not found or already deleted" });

      if (row.status === "posted") {
        return res.status(409).json({ error: "Cannot delete a published post (preserves Meta post-ID audit trail)" });
      }

      await db.update(igPostQueue)
        .set({ deletedAt: new Date() })
        .where(eq(igPostQueue.id, id));

      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
      try {
        await storage.writeAuditLog("ig_post_queue", String(id), "admin_delete", adminEmail, {
          prior_status:        row.status,
          prior_scheduled_for: row.scheduledFor,
          post_type:           row.postType,
          cert_id:             row.certId,
          reason,
        });
      } catch {}
      res.status(204).end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Queue an IG post pinned to a specific cert ────────────────────────────
  // Admin dashboard "Post to IG" flow. Body: { certId, postType: 'auto' |
  // 'card_reveal' | 'grade_breakdown' }. 'auto' picks card_reveal if grade
  // ≥ 8 (matches the cron's bias), grade_breakdown otherwise. Inserts a
  // fully-baked queue row (image + caption ready), status='ready'.
  app.post("/api/admin/ig/queue/from-cert", requireAdmin, async (req, res) => {
    try {
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      const certId = Number(req.body?.certId);
      const requestedType = String(req.body?.postType ?? "");
      if (!Number.isFinite(certId) || certId <= 0) {
        return res.status(400).json({ error: "certId must be a positive integer" });
      }
      if (!["auto", "card_reveal", "grade_breakdown"].includes(requestedType)) {
        return res.status(400).json({ error: "postType must be 'auto', 'card_reveal' or 'grade_breakdown'" });
      }

      const { certificates, igPostQueue } = await import("@shared/schema");
      const { and, eq, isNull } = await import("drizzle-orm");
      const certRows = await db.select().from(certificates).where(and(
        eq(certificates.id, certId),
        isNull(certificates.deletedAt),
      )).limit(1);
      const cert = certRows[0];
      if (!cert) return res.status(404).json({ error: "Cert not found or deleted" });

      // Resolve post type. 'auto' uses the same grade-bias logic as the cron.
      let postType: "card_reveal" | "grade_breakdown";
      if (requestedType === "auto") {
        const overall = parseFloat(String(cert.gradeOverall ?? "0"));
        postType = overall >= 8 ? "card_reveal" : "grade_breakdown";
      } else {
        postType = requestedType as "card_reveal" | "grade_breakdown";
      }

      // grade_breakdown requires an overall grade present. Admin is explicitly
      // overriding the grade-floor — no min on the floor here, just non-null.
      if (postType === "grade_breakdown" && (cert.gradeOverall == null || cert.gradeOverall === "")) {
        return res.status(422).json({ error: "Cert has no overall grade — cannot build grade_breakdown" });
      }

      const { fetchCardRevealDataForCertPk, fetchGradeBreakdownDataForCertPk } = await import("./ig/data-fetcher");
      const data = postType === "card_reveal"
        ? await fetchCardRevealDataForCertPk(certId)
        : await fetchGradeBreakdownDataForCertPk(certId);
      if (!data) return res.status(422).json({ error: "Could not build post data for this cert" });

      const { generateIgImage } = await import("./ig/image-generator");
      const imageBuffer = await generateIgImage(data);

      const r2Key = `ig/admin-dashboard/${certId}-${Date.now()}.png`;
      const { uploadToR2 } = await import("./r2");
      await uploadToR2(r2Key, imageBuffer, "image/png");

      const { generateCaption } = await import("./ig/caption-generator");
      const { caption, hashtags, fromFallback } = await generateCaption(data);

      const [inserted] = await db.insert(igPostQueue).values({
        scheduledFor: new Date(),
        postType,
        certId,
        imageR2Key:   r2Key,
        caption,
        hashtags,
        status:       "ready",
      }).returning();

      try {
        await storage.writeAuditLog("ig_post_queue", String(inserted.id), "admin_queue_from_cert", adminEmail, {
          cert_id:         certId,
          post_type:       postType,
          requested_type:  requestedType,
          source:          "admin_dashboard",
          caption_fallback: fromFallback,
        });
      } catch {}

      res.status(201).json({ ok: true, row: inserted, fromFallback });
    } catch (err: any) {
      console.error("[ig/queue/from-cert] failed:", err);
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
