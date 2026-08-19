import { sendServerError } from "./lib/error-response";
import {
  kindOfGradeType,
  kindOfOverallGrade,
  rejectKindChange,
  gradeTypeToPersist,
  normaliseGradeType,
} from "./lib/grade-kind";
import { normalizeCertId, certNumberFromId } from "./lib/cert-id";
import { ensurePerfIndexes } from "./lib/perf-indexes";
import { applyStructuredVariantFromBody } from "./lib/structured-variant";
import { getCatalogueSnapshot } from "./lib/catalogue-provider";
import type {
  Express,
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction as ExpressNextFunction,
} from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import {
  cookieAckRateLimit,
  paymentRateLimit,
  stolenReportRateLimit,
  transferActionRateLimit,
  reissueRateLimit,
  preGradeRateLimit,
  preGradePreviewRateLimit,
  lookupRateLimit,
  verifyRateLimit,
  showcaseRateLimit,
  aiRateLimit,
  claimRateLimit,
  transferRateLimit,
  transferV2RateLimit,
  refNumberRateLimit,
  magicLinkRateLimit,
  accountSwitchRateLimit,
  pinLoginRateLimit,
  toolsRateLimit,
  estimateRateLimit,
  ADMIN_FREE_EMAIL,
} from "./lib/rate-limiters";
import {
  ACCEPTED_UPLOAD_MIMES,
  upload,
  preGradeUpload,
  receiptUpload,
  gradingUpload,
  attachImagesUpload,
  phoneUpload,
  hotFolderUpload,
  gradeWithAiUpload,
  identifyUpload,
  toolsUpload,
  scanUpload,
  certImgUpload,
  reelAssetUpload,
  igImageUpload,
} from "./lib/multer-configs";
import { z } from "zod";
import { registerPublicRoutes } from "./routes/public";
import { registerAuthRoutes } from "./routes/auth";
import { registerSubmissionRoutes } from "./routes/submissions";
import { registerAdminSubmissionRoutes } from "./routes/admin-submissions";
import { registerAdminConfigRoutes } from "./routes/admin-config";
import { registerSuperAdminPartnerRoutes } from "./partner/admin-routes";
import { registerConnectorOpsRoutes } from "./partner/connector-admin-routes";
import { registerPartnerManagementRoutes } from "./partner/partner-management-routes";
import { registerPartnerStationAdminRoutes } from "./partner/station-admin-routes";
import { registerPartnerPublicRoutes } from "./partner/public-routes";
import { mountPartnerPortal } from "./partner/mount";
import { registerPartnerFlagAdminRoutes } from "./partner/flag-admin-routes";
import { registerPartnerDashboardRoutes } from "./partner/dashboard-routes";
import { registerCommandCentreRoutes } from "./command-centre/routes";
import { registerCommercialGrowthRoutes } from "./routes/admin/commercial-growth";
import { registerReviewRequestRoutes } from "./routes/reviews";
import { registerGrowthMcpRoutes } from "./routes/growth-mcp";
import { registerRarityMappingRoutes } from "./routes/rarity-mapping";
import { registerPokemonKnowledgeRoutes } from "./routes/pokemon-knowledge";
import { registerCatalogueRoutes } from "./routes/admin/catalogue";
import { registerProjectControlRoutes } from "./routes/admin/project-control";
import { registerCardIdentificationRoutes } from "./routes/card-identification";
import { registerTransferRoutes } from "./routes/transfers";
import { registerPreGradeRoutes } from "./routes/pre-grade";
import { registerVaultQuestAdminRoutes } from "./routes/vault-quest-admin";
import { registerVaultQuestProductionRoutes } from "./routes/vault-quest-production";
import { registerVaultQuestCardFactoryRoutes } from "./routes/vault-quest-card-factory";
import { registerStolenRoutes } from "./routes/stolen";
import { registerRedirectRoutes } from "./routes/redirects";
import { getSitemapEntries } from "./seo-config";
import { registerEmbeddingRoutes } from "./routes/embedding";
import { registerPromotionRoutes } from "./routes/admin/promotions";
import { migratePromotionsSchema } from "./services/promotionService";
import { migratePaymentIdempotencySchema } from "./webhookHandlers";
import { registerReviewPreviewRoutes } from "./routes/review-preview";
import { registerCorrectionModeRoutes } from "./correction-mode";
import {
  migrateGraderSchema,
  migrateGraderCertSchema,
  migratePerOperatorSchema,
  isGraderLocked,
  checkGradePublishGates,
} from "./grader";

import { migrateStaffCapabilitiesSchema, migrateScanSchema } from "./staff";
import { registerStaffRoutes } from "./routes/staff";
import { registerPrintWorkflowRoutes } from "./routes/print-workflow";
import { reconcileStuckPrintBatches, renderAdminUser } from "./print-workflow";
import {
  BUILD_STAMP,
  pricingTiers,
  calculateOrderTotals,
  getVaultClubDiscountPercent,
  gradeLabel,
  gradeLabelFull,
  isNonNumericGrade,
  isValidNumericGrade,
  SUBMISSION_STATUS_TRANSITIONS,
  SUBMISSION_STATUS_LABELS,
  serviceTierToPricingTier,
  auditLog,
  certificates,
  CERTIFICATE_ORIGIN_SNAPSHOT_VERSION,
} from "@shared/schema";
import { mvgsTierName } from "@shared/mvgs-scoring";
import type { PublicCertificate, ServiceTierRecord, CertificateRecord } from "@shared/schema";
import { isBlackLabel } from "@shared/pristine";
import { languageLabel, normalizePokemonLanguage } from "@shared/pokemon-rarity-catalogue";
import { GradeDraftValidationError, validateGradeDraftIdentityAndVariant } from "@shared/grading-draft-validation";
import { certIsPristine } from "./lib/cert-pristine";
import { resolveDraftGradeAuthority } from "./lib/draft-grade-authority";
import { enqueueScanJob } from "./lib/scan-job-queue";
import { scannerEvidenceAdmission } from "./lib/scanner-evidence-admission";
import { isServiceValidForCarrier } from "@shared/carriers";
import { deriveVariantFromIdentification, splitSetDesignation } from "@shared/variant-derive";
import {
  gradingFieldChanges,
  gradingFieldContractError,
  assertServerMetadataCommitKeys,
  canonicalGradingField,
  NUMERIC_GRADING_FIELDS,
} from "@shared/certificate-field-ownership";
import {
  resolveEditConflicts,
  GUARDED_FIELD_SPECS,
  canonicalArray,
  canonicalArrayValue,
  type EditConflictResolution,
  type FieldProvenance,
} from "@shared/edit-conflict";
import { centeringAxisGrade } from "@shared/centering";
import {
  SOCIAL_STUDIO_BACKGROUNDS,
  SOCIAL_STUDIO_FORMAT_DIMENSIONS,
  buildSocialStudioDownloadFilename,
  buildSocialStudioCaption,
  buildSocialStudioHashtags,
  escapeSocialStudioSearchTerm,
  isSocialStudioBackground,
  isSocialStudioFormat,
  resolveAutoBackground,
  resolveBackgroundVariant,
  type SocialStudioBackgroundId,
} from "@shared/social-studio";
import { storage } from "./storage";
import {
  consumeEstimateCredit,
  getEstimateCreditBalance,
  buildEstimateCheckoutMetadata,
} from "./estimate-credit-consumption";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import {
  verifyAdminPassword,
  requireAdmin,
  isLoginRateLimited,
  isPinRateLimited,
  recordFailedLogin,
  recordFailedPin,
  clearLoginAttempts,
  clearPinAttempts,
  isPendingAdminValid,
  clearPendingAdmin,
  ADMIN_EMAIL,
  FAILED_LOGIN_DELAY_MS,
} from "./auth";
import { generateLabelPNG, generateLabelPDF, applyLabelOverrides } from "./labels";
import { checkPrintableGrade, UnprintableGradeError } from "@shared/printable-grade";
import { checkNfcBindable } from "@shared/nfc-binding";
import { fileTypeFromBuffer } from "file-type";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { generatePdfToken, verifyPdfToken } from "./lib/pdf-token";
import { generateUploadToken, verifyUploadToken } from "./lib/upload-token";
import { uploadToR2, getR2SignedUrl, getR2Buffer, deleteFromR2, headR2, r2KeyForImage, r2KeyForLabel } from "./r2";
import {
  persistImageUploadAudited,
  IMAGE_UPLOAD_JSONB_COLUMNS,
  IMAGE_VARIANTS_AUDIT_ACTION,
  COLUMN_TO_CERT_KEY,
} from "./lib/certificate-image-persistence";
import { generateClaimInsertPNG, generateClaimInsertPDF, generateClaimInsertSheet } from "./claim-insert";
import { db } from "./db";
import { sql, inArray } from "drizzle-orm";
import {
  sendSubmissionConfirmation,
  sendSubmissionConfirmationV2,
  sendCardsReceived,
  sendGradingComplete,
  sendShipped,
  sendSubmissionDelivered,
  sendClaimVerification,
  sendTransferOwnerConfirmation,
  sendTransferNewOwnerConfirmation,
  sendTransferV2OutgoingConfirmation,
  sendTransferV2IncomingConfirmation,
  sendTransferV2DisputeWindowStarted,
  sendTransferV2Completed,
  sendTransferV2Cancelled,
  sendTransferV2Disputed,
  sendTransferV2OwnerInvitedByBuyer,
  sendTransferV2BuyerInitOwnerConfirmed,
  sendTransferV2BuyerInitOwnerRejected,
  sendCertificatePdf,
  sendMagicLink,
  sendPinResetLink,
  sendStolenVerificationEmail,
} from "./email";
import { getOwnerChain } from "./ownership-service";
import { generateCertificateDocument } from "./certificate-document";
import { createMagicToken, verifyMagicToken, requireCustomer } from "./customer-auth";
import {
  identifyCard,
  identifyCardFromBuffer,
  verifyAndEnrichCardData,
  analyzeCard,
  identifyAndAnalyze,
  autoCropCard,
  analyzeCardFromBuffers,
  generateImageVariants,
  verifyPokemonCardWithTcgApi,
  resizeForClaude,
  normaliseCardName,
  type ImageKeys,
} from "./ai-grading-service";
import { anthropicFetch } from "./anthropic-fetch";
import { APP_BASE_URL } from "./app-url";
import { getCachedOrFreshEbayPrices, buildCardKey } from "./ebay";
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  createEmailVerificationToken,
  createPasswordResetToken,
  createAccountMagicLinkToken,
  findUserByEmail,
  findUserById,
  countRecentFailedAttempts,
  logLoginAttempt,
  writeAuthAudit,
  migrateAccountSchema,
} from "./account-auth";
import { migrateMarketplaceSchema } from "./marketplace-schema";
import {
  sendWelcomeVerificationEmail,
  sendAccountMagicLinkEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendEmailChangedNotification,
  sendAccountDeletedEmail,
} from "./email";
import { requireAuth } from "./middleware/auth";
import { requireScannerOrAdmin, requireStationCaptureAgent } from "./lib/scanner-auth";
import { registerShowroomRoutes } from "./showroom";
import { registerVaultClubRoutes } from "./vault-club";
import { registerSellerRoutes } from "./marketplace-seller";
import { isActiveStatus } from "./vault-club-tiers";
import { FEATURE_FLAGS } from "./config/feature-flags";
/*
 * Statically imported, unlike the authority functions themselves, because it is needed in a CATCH
 * block to classify the failure. Awaiting a dynamic import while already handling an error is a way
 * to lose the original error to a second one.
 */
import { CaptureGeometryError } from "./lib/lide400-capture-authority";

// `/api/health` remains a generic public readiness probe only. Detailed
// database/infrastructure intelligence belongs exclusively behind the Super
// Admin Growth boundary, never in a public response or raw error message.
const publicHealthRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
  message: { status: "unavailable" },
});

/** Count unused, unexpired credits of a given type */
async function countCreditsRemaining(userId: string, creditType: string = "member"): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM member_credits
    WHERE user_id = ${userId} AND credit_type = ${creditType}
      AND used_at IS NULL AND expires_at > NOW()
  `);
  return parseInt((rows.rows[0] as any)?.cnt ?? "0", 10);
}

/** Resilient JSON extraction: handles Claude prose preambles, markdown fences, truncation */
function extractJson<T = any>(raw: string, label: string): T {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  // Attempt 1: direct parse
  try {
    return JSON.parse(cleaned);
  } catch {}
  // Attempt 2: extract outermost JSON object from prose
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e2: any) {
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
      try {
        return JSON.parse(repaired);
      } catch (e3: any) {
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
  COMMON: "Common",
  UNCOMMON: "Uncommon",
  RARE: "Rare",
  HOLO: "Holo",
  RARE_HOLO: "Holo Rare",
  REVERSE_HOLO: "Reverse Holo",
  DOUBLE_RARE: "Double Rare (ex/V)",
  ULTRA_RARE: "Ultra Rare (Full Art)",
  ILLUSTRATION_RARE: "Illustration Rare (IR)",
  SPECIAL_ILLUSTRATION_RARE: "Special Illustration Rare (SIR)",
  HYPER_RARE: "Hyper Rare (Gold)",
  SECRET_RARE: "Secret Rare",
  SHINY_RARE: "Shiny Rare",
  SHINY_ULTRA_RARE: "Shiny Ultra Rare",
  RADIANT: "Radiant",
  AMAZING_RARE: "Amazing Rare",
  ACE_SPEC: "ACE SPEC",
  TRAINER_GALLERY: "Trainer Gallery (TG)",
  GALAR_GALLERY: "Galarian Gallery (GG)",
  GOLD_STAR: "★ Gold Star",
  DOUBLE_GOLD_STAR: "★★ Double Gold Star",
  PROMO_RARITY: "Promo (Rarity Unknown)",
  OTHER: "Other (manual)",
};

const COLLECTION_LABELS: Record<string, string> = {
  CLASSIC_COLLECTION: "Classic Collection",
  COLLECTION_GENERIC: "Collection (generic)",
  BLACK_STAR_PROMO: "Black Star Promo",
  PROMO_GENERIC: "Promo (generic)",
  FIRST_EDITION: "1st Edition",
  UNLIMITED: "Unlimited",
  SHADOWLESS: "Shadowless",
  FOURTH_PRINT: "4th Print",
  NO_RARITY_SYMBOL: "No Rarity Symbol",
  ERROR_MISPRINT: "Error / Misprint",
  TROPHY_PRIZE: "Trophy / Prize",
  TRAINER_GALLERY: "Trainer Gallery (TG)",
  GALARIAN_GALLERY: "Galarian Gallery (GG)",
  RADIANT_COLLECTION: "Radiant Collection (RC)",
  SHINY_VAULT: "Shiny Vault (SV)",
  ILLUSTRATION_RARE: "Illustration Rare (IR)",
  SPECIAL_ILLUSTRATION_RARE: "Special Illustration Rare (SIR)",
  CHARACTER_RARE: "Character Rare (CHR)",
  CHARACTER_SUPER_RARE: "Character Super Rare (CSR)",
  PRISM_STAR: "Prism Star",
  AMAZING_RARE: "Amazing Rare",
  SECRET_RARE: "Secret Rare",
  OTHER: "Other (manual)",
};

function collectionDisplayLabel(
  code: string | null | undefined,
  other: string | null | undefined,
  legacyCollection?: string | null
): string | null {
  if (!code) {
    return legacyCollection?.trim() || null;
  }
  if (code === "OTHER") return other?.trim() || null;
  return COLLECTION_LABELS[code] || code;
}

const VARIANT_LABELS: Record<string, string> = {
  NONE: "None / Regular",
  HOLO: "Holo",
  REVERSE_HOLO: "Reverse Holo",
  COSMOS_HOLO: "Cosmos Holo",
  CRACKED_ICE_HOLO: "Cracked Ice Holo",
  MIRROR_HOLO: "Mirror Holo",
  GLITTER_HOLO: "Glitter Holo",
  PATTERN_HOLO: "Pattern Holo",
  TEXTURED: "Textured",
  FULL_ART: "Full Art",
  ALT_ART: "Alt Art",
  SPECIAL_ART: "Special Art",
  RAINBOW: "Rainbow",
  GOLD: "Gold",
  SHINY: "Shiny",
  RADIANT: "Radiant",
  TRAINER_GALLERY: "Trainer Gallery",
  GALARIAN_GALLERY: "Galarian Gallery",
  CHARACTER_RARE: "Character Rare (CHR)",
  CHARACTER_SUPER_RARE: "Character Super Rare (CSR)",
  SECRET_RARE: "Secret Rare",
  ILLUSTRATION_RARE: "Illustration Rare",
  SPECIAL_ILLUSTRATION_RARE: "Special Illustration Rare",
  DOUBLE_RARE: "Double Rare",
  ULTRA_RARE: "Ultra Rare",
  HYPER_RARE: "Hyper Rare",
  AMAZING_RARE: "Amazing Rare",
  ACE_SPEC_RARE: "ACE SPEC Rare",
  EX: "Ex",
  PROMO: "Promo",
  FIRST_EDITION: "1st Edition",
  SHADOWLESS: "Shadowless",
  UNLIMITED: "Unlimited",
  OTHER: "Other (manual)",
};

function variantDisplayLabel(code: string | null | undefined, variantOther: string | null | undefined): string | null {
  if (!code || code === "NONE") return null;
  if (code === "OTHER") return variantOther || "Other";
  // Unmapped codes must never surface with underscores ("ULTRA_RARE").
  return VARIANT_LABELS[code] || code.replace(/_/g, " ");
}

const DESIGNATION_LABELS: Record<string, string> = {
  PROMO: "Promo",
  TOURNAMENT_STAMP: "Tournament / Event Stamp",
  PRERELEASE: "Prerelease",
  STAFF: "Staff",
  ERROR_MISCUT: "Error / Miscut / Misprint",
  FIRST_EDITION: "1st Edition",
  SHADOWLESS: "Shadowless",
  UNLIMITED: "Unlimited",
  JAPANESE_PRINT: "Japanese Print",
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
  return codes.map((c) => DESIGNATION_LABELS[c] || c);
}

/**
 * H-1 / H6 — the truthful audit diff, computed from the EXACT object that will
 * be committed.
 *
 * Every key present in `data` is a field the UPDATE will write, so every one is
 * compared against the stored row and reported if — and only if — it genuinely
 * changed. A field ABSENT from `data` is not being written and therefore cannot
 * appear as a change. This is what makes requirements 9 and 10 hold in both
 * directions: nothing changes silently, and nothing is claimed that was not
 * written.
 *
 * Array-valued fields use the SAME canonicaliser as shared/edit-conflict.ts
 * (order-insensitive, duplicate-safe, unambiguous separator), so the audit and
 * the conflict resolver can never disagree about whether a set changed.
 */
export function buildCommittedFieldDiff(
  existing: Record<string, unknown>,
  data: Record<string, unknown>,
  provenanceFor: (key: string) => FieldProvenance = () => "request"
): Array<{ field: string; previous: string | string[]; next: string | string[]; source: FieldProvenance }> {
  const out: Array<{ field: string; previous: string | string[]; next: string | string[]; source: FieldProvenance }> =
    [];
  const arrayFields = new Set(GUARDED_FIELD_SPECS.filter((f) => f.kind === "stringArray").map((f) => f.key));

  for (const key of Object.keys(data)) {
    if (arrayFields.has(key)) {
      const prev = canonicalArrayValue(existing[key]);
      const next = canonicalArrayValue(data[key]);
      // canonicalArray is the shared, unambiguous comparison key.
      if (canonicalArray(prev) !== canonicalArray(next)) {
        out.push({ field: key, previous: prev, next, source: provenanceFor(key) });
      }
      continue;
    }
    const prev = existing[key] == null ? "" : String(existing[key]).trim();
    const next = data[key] == null ? "" : String(data[key]).trim();
    if (prev !== next) out.push({ field: key, previous: prev, next, source: provenanceFor(key) });
  }
  return out;
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

// normalizeCertId + certNumberFromId now live in the shared, ReDoS-safe helper
// (server/lib/cert-id.ts, fixes #113). Re-exported here so existing callers that
// do `import { normalizeCertId } from "../routes"` keep working unchanged.
export { normalizeCertId };

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff"]);

async function validateImageMagicBytes(file: Express.Multer.File): Promise<boolean> {
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected) return false;
  return ALLOWED_IMAGE_MIMES.has(detected.mime);
}

export async function rejectInvalidUploads(files: Express.Multer.File[]): Promise<string | null> {
  for (const f of files) {
    const valid = await validateImageMagicBytes(f);
    if (!valid) return `File "${f.originalname}" failed content-type validation`;
  }
  return null;
}

// PUBLIC cert lookup — resolves an MV id in its various forms AND enforces the
// public-visibility gate: a cert is only returned once its grade has been
// APPROVED (grade_approved_at set on admin approve). Ungraded empty shells and
// unapproved grades resolve to null, so every public read built on this helper
// (cert page, vault, report, verify, logbook PDF, ebay-prices, stolen-report)
// returns not-found for them.
// ⚠️ PUBLIC-ONLY: every caller of this function is a public route. Internal
// admin/staff/grader code must use storage.getCertificateByCertId directly
// (NOT gated) so it can still load unapproved certs to grade/approve them.
// Do NOT call this from an internal route — it will hide unapproved certs.
/**
 * UNGATED by-number cert resolver. Resolves a cert by its certificate_number
 * (MV303 / MV-0000000303 / 303) REGARDLESS of grade/publish state. For
 * admin/internal callers that must see a cert even before it's graded — e.g. the
 * scanner's scan-status poll on a freshly created, still-ungraded cert. PUBLIC
 * reads must use findCertByIdFlex, which adds the publish gate on top of this.
 */
export async function findCertByNumberUngated(certId: string) {
  // One query for all id forms (raw + MV<n> + zero-padded). certificate_number is
  // unique so at most one matches — order is irrelevant. Was 2–3 sequential reads.
  const num = certNumberFromId(certId);
  const candidates = num !== null ? [certId, `MV${num}`, `MV-${num.padStart(10, "0")}`] : [certId];
  const dbCert = await storage.getCertificateByAnyCertId([...new Set(candidates)]);
  return dbCert ?? null;
}

export async function findCertByIdFlex(certId: string) {
  const dbCert = await findCertByNumberUngated(certId);
  if (!dbCert) return null;
  // Public-visibility gate: hide ungraded/unapproved certs from public reads.
  if ((dbCert as { gradeApprovedAt?: unknown }).gradeApprovedAt == null) return null;
  return dbCert;
}

async function certToPublic(c: any, viewerUserId?: string | null): Promise<PublicCertificate> {
  const gradeType = c.gradeType || "numeric";
  const isNonNum = isNonNumericGrade(gradeType);
  const grade = isNonNum ? 0 : parseFloat(c.gradeOverall || "0");

  // Sign front + back presigned URLs in PARALLEL (one round-trip instead of two
  // on every cert lookup). Same behaviour: null on missing key or sign error.
  const signImg = async (key: string | null | undefined, side: string): Promise<string | null> => {
    if (!key) return null;
    try {
      return await getR2SignedUrl(key, 3600);
    } catch (e) {
      console.error(`R2 sign failed (${side}):`, key, e);
      return null;
    }
  };
  const [frontUrl, backUrl] = await Promise.all([signImg(c.frontImagePath, "front"), signImg(c.backImagePath, "back")]);

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
    grade: isNonNum ? gradeLabelFull(gradeType, c.gradeOverall || "0") : mvgsTierName(grade).toUpperCase(),
    gradeNumeric: grade,
    gradeCentering: c.gradeCentering != null ? String(c.gradeCentering) : null,
    gradeCorners: c.gradeCorners != null ? String(c.gradeCorners) : null,
    gradeEdges: c.gradeEdges != null ? String(c.gradeEdges) : null,
    gradeSurface: c.gradeSurface != null ? String(c.gradeSurface) : null,
    gradeStrengthScore: c.gradeStrengthScore != null ? Number(c.gradeStrengthScore) : null,
    labelType: c.labelType || "Standard",
    // Pristine 10P from the MVGS gate (same authority as the slab), never the
    // stored label_type flag.
    isBlackLabel: await certIsPristine(c),
    frontImageUrl: frontUrl,
    backImageUrl: backUrl,
    gradedDate: c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
    notes: c.notes || null,
    nfcEnabled: c.nfcEnabled ?? null,
    nfcScanCount: c.nfcScanCount != null ? Number(c.nfcScanCount) : null,
    ownershipStatus: c.ownershipStatus || "unclaimed",
    ownershipRef:
      c.ownershipStatus === "claimed" && c.certId
        ? `MV-REG-${String(c.certId)
            .replace(/^MV-?0*/, "")
            .padStart(10, "0")}`
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
    try {
      await db.execute(stmt);
    } catch (e: any) {
      console.error("[v213-migrate] ALTER service_tiers failed:", e.message);
    }
  }

  // ── Phase 2: Seed rows that don't yet exist (ON CONFLICT DO NOTHING) ──────
  // These only insert if the tier_id doesn't already exist in the table.
  // On a branched DB with existing data, every INSERT will be skipped — that's expected.
  const seeds = [
    {
      serviceType: "grading",
      tierId: "standard",
      name: "VAULT QUEUE",
      pricePerCard: 1900,
      turnaroundDays: 40,
      turnaroundLabel: "40 working days",
      maxValueGbp: 500,
      sortOrder: 1,
    },
    {
      serviceType: "grading",
      tierId: "priority",
      name: "STANDARD",
      pricePerCard: 2500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1500,
      sortOrder: 2,
    },
    {
      serviceType: "grading",
      tierId: "express",
      name: "EXPRESS",
      pricePerCard: 4500,
      turnaroundDays: 5,
      turnaroundLabel: "5 working days",
      maxValueGbp: 3000,
      sortOrder: 3,
    },
    {
      serviceType: "grading",
      tierId: "gold",
      name: "BLACK LABEL REVIEW",
      pricePerCard: 7500,
      turnaroundDays: 10,
      turnaroundLabel: "10 working days",
      maxValueGbp: 7500,
      sortOrder: 4,
    },
    {
      serviceType: "reholder",
      tierId: "reholder",
      name: "REHOLDER",
      pricePerCard: 1500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1000,
      sortOrder: 1,
    },
    {
      serviceType: "crossover",
      tierId: "crossover",
      name: "CROSSOVER",
      pricePerCard: 3500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1500,
      sortOrder: 1,
    },
    {
      serviceType: "authentication",
      tierId: "authentication",
      name: "AUTHENTICATION",
      pricePerCard: 1500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1000,
      sortOrder: 1,
    },
  ];
  for (const t of seeds) {
    try {
      await db.execute(sql`
        INSERT INTO service_tiers (service_type, tier_id, name, price_per_card, turnaround_days, turnaround_label, max_value_gbp, is_active, sort_order)
        VALUES (${t.serviceType}, ${t.tierId}, ${t.name}, ${t.pricePerCard}, ${t.turnaroundDays}, ${t.turnaroundLabel}, ${t.maxValueGbp}, true, ${t.sortOrder})
        ON CONFLICT DO NOTHING
      `);
    } catch (e: any) {
      console.error(`[v213-migrate] seed ${t.tierId} failed:`, e.message);
    }
  }

  // ── Phase 3a: UPDATE core columns that definitely exist (name, price, turnaround, etc.) ──
  // These columns have existed since the table was created — no dependency on Phase 1 ALTERs.
  // Rollback reference (old prices): standard=1200, priority=1500, express=2000, gold=8500, gold-elite=12500
  // Ancillary old prices: reholder=800, crossover=1500, authentication=1000
  const coreUpdates = [
    {
      tierId: "standard",
      name: "VAULT QUEUE",
      pricePerCard: 1900,
      turnaroundDays: 40,
      turnaroundLabel: "40 working days",
      maxValueGbp: 500,
      sortOrder: 1,
    },
    {
      tierId: "priority",
      name: "STANDARD",
      pricePerCard: 2500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1500,
      sortOrder: 2,
    },
    {
      tierId: "express",
      name: "EXPRESS",
      pricePerCard: 4500,
      turnaroundDays: 5,
      turnaroundLabel: "5 working days",
      maxValueGbp: 3000,
      sortOrder: 3,
    },
    {
      tierId: "gold",
      name: "BLACK LABEL REVIEW",
      pricePerCard: 7500,
      turnaroundDays: 10,
      turnaroundLabel: "10 working days",
      maxValueGbp: 7500,
      sortOrder: 4,
    },
    {
      tierId: "reholder",
      name: "REHOLDER",
      pricePerCard: 1500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1000,
      sortOrder: 1,
    },
    {
      tierId: "crossover",
      name: "CROSSOVER",
      pricePerCard: 3500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1500,
      sortOrder: 1,
    },
    {
      tierId: "authentication",
      name: "AUTHENTICATION",
      pricePerCard: 1500,
      turnaroundDays: 15,
      turnaroundLabel: "15 working days",
      maxValueGbp: 1000,
      sortOrder: 1,
    },
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
    } catch (e: any) {
      console.error(`[v213-migrate] core UPDATE ${u.tierId} failed:`, e.message);
    }
  }

  // ── Phase 3b: UPDATE new columns (display_name, tagline, most_popular) ──
  // These depend on Phase 1 ALTERs succeeding. If the columns don't exist, each UPDATE
  // will fail and log the error — but Phase 3a prices are already applied.
  const metaUpdates = [
    {
      tierId: "standard",
      displayName: "Vault Queue",
      tagline: "For patient collectors. Full Vault treatment, longer queue.",
      mostPopular: false,
    },
    {
      tierId: "priority",
      displayName: "Standard",
      tagline: "Our most popular tier. Professional grading, solid turnaround.",
      mostPopular: true,
    },
    {
      tierId: "express",
      displayName: "Express",
      tagline: "Fast-tracked grading for time-sensitive submissions.",
      mostPopular: false,
    },
    {
      tierId: "gold",
      displayName: "Black Label Review",
      tagline: "Premium service for high-value and investment-grade cards.",
      mostPopular: false,
    },
    {
      tierId: "reholder",
      displayName: "Reholder",
      tagline: "New MintVault slab with updated NFC and certificate.",
      mostPopular: false,
    },
    {
      tierId: "crossover",
      displayName: "Crossover",
      tagline: "Re-grade a card from PSA, BGS, CGC, or another company.",
      mostPopular: false,
    },
    {
      tierId: "authentication",
      displayName: "Authentication",
      tagline: "Verify authenticity and check for alterations.",
      mostPopular: false,
    },
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
    } catch (e: any) {
      console.error(`[v213-migrate] meta UPDATE ${u.tierId} failed:`, e.message);
    }
  }

  // ── Phase 4: Deactivate gold-elite (no longer offered) ─────────────────────
  try {
    const r = await db.execute(sql`UPDATE service_tiers SET is_active = false WHERE tier_id = 'gold-elite'`);
    console.log(`[v213-migrate] deactivate gold-elite: ${r.rowCount} row(s)`);
  } catch (e: any) {
    console.error("[v213-migrate] deactivate gold-elite failed:", e.message);
  }

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
  } catch (e: any) {
    console.error("[v213-migrate] value_protection_tiers failed:", e.message);
  }

  // ── Phase 6: Add credit_type column to member_credits (formerly reholder_credits) ──
  try {
    await db.execute(
      sql`ALTER TABLE member_credits ADD COLUMN IF NOT EXISTS credit_type TEXT NOT NULL DEFAULT 'member'`
    );
    console.log("[v213-migrate] member_credits.credit_type column ensured");
  } catch (e: any) {
    console.error("[v213-migrate] ALTER member_credits failed:", e.message);
  }

  // Reserve-at-checkout columns — a credit is atomically reserved when a
  // discounted PaymentIntent is created, so two concurrent checkouts can't
  // both apply the same credit (double-spend race). TTL-based: an abandoned
  // checkout's reservation auto-frees once reserved_until passes, so no
  // sweeper job is needed. Nullable/additive — safe on live data.
  try {
    await db.execute(sql`ALTER TABLE member_credits ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE member_credits ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`);
    console.log("[v213-migrate] member_credits.reserved_at/reserved_until columns ensured");
  } catch (e: any) {
    console.error("[v213-migrate] ALTER member_credits reservation cols failed:", e.message);
  }

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
  } catch (e: any) {
    console.error("[v229-migrate] ownership schema failed:", e.message);
  }

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
  } catch (e: any) {
    console.error("[public-name-migrate] failed:", e.message);
  }

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
      console.log(
        "[archival-b2-migrate] certificates.archived_to_b2_at + idx_certificates_archive_candidates added + audit logged"
      );
    }
  } catch (e: any) {
    console.error("[archival-b2-migrate] failed:", e.message);
  }

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
  } catch (e: any) {
    console.error("[contact-inquiries-migrate] failed:", e.message);
  }

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
  } catch (e: any) {
    console.error("[audit-log-index-migrate] failed:", e.message);
  }

  // ── Phase 9: Transfer v2 schema additions ─────────────────────────────────
  try {
    await db.execute(
      sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS flow_version VARCHAR(4) NOT NULL DEFAULT 'v1'`
    );
  } catch (e: any) {
    console.error("[transfer-v2] flow_version:", e.message);
  }
  try {
    await db.execute(
      sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS transfer_status VARCHAR(30) NOT NULL DEFAULT 'pending_owner'`
    );
  } catch (e: any) {
    console.error("[transfer-v2] transfer_status:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS reference_number_provided TEXT`);
  } catch (e: any) {
    console.error("[transfer-v2] reference_number_provided:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS outgoing_keeper_user_id VARCHAR`);
  } catch (e: any) {
    console.error("[transfer-v2] outgoing_keeper_user_id:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS incoming_keeper_user_id VARCHAR`);
  } catch (e: any) {
    console.error("[transfer-v2] incoming_keeper_user_id:", e.message);
  }
  try {
    await db.execute(
      sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS incoming_confirm_deadline TIMESTAMPTZ`
    );
  } catch (e: any) {
    console.error("[transfer-v2] incoming_confirm_deadline:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS disputed_by VARCHAR(10)`);
  } catch (e: any) {
    console.error("[transfer-v2] disputed_by:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMPTZ`);
  } catch (e: any) {
    console.error("[transfer-v2] finalised_at:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  } catch (e: any) {
    console.error("[transfer-v2] cancelled_at:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE transfer_verifications ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`);
  } catch (e: any) {
    console.error("[transfer-v2] cancellation_reason:", e.message);
  }
  // Index for cron jobs: find v2 transfers in dispute window that need finalising
  try {
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS idx_transfer_v2_status ON transfer_verifications (transfer_status) WHERE flow_version = 'v2'`
    );
  } catch (e: any) {
    console.error("[transfer-v2] index:", e.message);
  }
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
          VALUES (${row.certificate_number}, NULL, '', ${email}, 'auto_submission', ${name ? `Original submitter: ${name}` : "Auto-assigned from submission"}, ${row.issued_at || new Date().toISOString()})
        `);
        backfilled++;
      } catch {}
    }
    if (backfilled > 0) console.log(`[v229-migrate] backfilled owner 1 for ${backfilled} certs`);
  } catch (e: any) {
    console.error("[v229-migrate] backfill failed:", e.message);
  }
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
  "5": { credits: 5, pricePence: 200, label: "5 estimates" },
  "15": { credits: 15, pricePence: 400, label: "15 estimates" },
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

// ADMIN_FREE_EMAIL is imported from ./lib/rate-limiters (relocated so the shared
// rate-limiters' skip() can use it without a circular import).

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
    Object.keys(_capacityCache).forEach((k) => delete _capacityCache[k]);
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
    for (const [slug, max] of [
      ["standard", 500],
      ["priority", 150],
      ["express", 40],
    ] as [string, number][]) {
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

/**
 * H-1 (second hostile review) — the certificate metadata update handler,
 * EXTRACTED VERBATIM from its former inline position so it can be mounted and
 * driven directly by route-level tests against a disposable PostgreSQL cluster.
 * Behaviour is unchanged by the extraction: `registerRoutes` mounts this exact
 * function behind the same `requireAdmin` + multer chain it always had.
 */

export async function handleCertificateMetadataUpdate(req: any, res: any): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    const existing = await storage.getCertificate(id);
    if (!existing) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    // Approval lock (2026-07-01): this metadata editor has no other guard
    // against overwriting an already-approved/published certificate — the
    // client's auto-save intentionally stops calling this route once a
    // cert is approved, but a request already in flight when approval
    // lands isn't cancelled client-side, so the server must be the real
    // gate. Only the explicit "Save Changes to Published Certificate" UI
    // path sends confirmPublishedEdit — auto-save never does.
    if (existing.gradeApprovedAt && req.body.confirmPublishedEdit !== "true") {
      return res.status(409).json({
        error: "Certificate already approved and published — reload and use explicit save to edit it",
      });
    }

    // Stale-tab guard (2026-07-06): this editor posts FULL state, so a tab
    // opened before a concurrent change (repair script, another session)
    // silently writes old values back — it clobbered MV237's repaired
    // variant the same day it was fixed. FIELD-SCOPED on purpose: the
    // grading workstation shares this page and bumps the row constantly
    // without touching metadata, so a row-level updated_at check would
    // false-conflict on routine grading. A field conflicts only when it
    // changed in the DB since this tab loaded it AND this save would
    // overwrite that newer value with something different (see
    // shared/edit-conflict.ts). Tabs from before this deploy send no
    // snapshot and pass through unchanged.
    let editResolution: EditConflictResolution | null = null;
    if (req.body.loadedSnapshot) {
      let snapshot: Record<string, unknown> | null = null;
      try {
        snapshot = JSON.parse(String(req.body.loadedSnapshot));
      } catch {
        snapshot = null; // malformed → treat as legacy (no guard)
      }
      if (snapshot && typeof snapshot === "object") {
        // Owner spec 2026-07-26 + hostile-review H5/MED: only a genuine
        // SAME-FIELD disagreement (or a related-field hybrid) may interrupt
        // the grader. Fields this tab never edited but that moved in the DB
        // merge silently; fields the request never submitted are left alone
        // and are NEVER treated as a clear.
        editResolution = resolveEditConflicts(snapshot, req.body, existing as Record<string, unknown>);

        if (editResolution.blocked) {
          // H6: a blocked conflict must NOT produce a normal successful
          // "update" audit event. Record a DISTINCT blocked event instead,
          // so the trail is truthful in both directions, and write nothing
          // to the certificate.
          const compoundFields = editResolution.compoundConflicts.flatMap((c) => [
            ...c.editorEdited,
            ...c.movedElsewhere,
          ]);
          const reported = Array.from(new Set([...editResolution.conflicts, ...compoundFields]));
          await storage.writeAuditLog(
            "certificate",
            existing.certId,
            "update_conflict_blocked",
            req.session.adminEmail || "admin",
            {
              certificateId: existing.id,
              conflicts: editResolution.conflicts,
              compoundConflicts: editResolution.compoundConflicts,
              outcome: "no_write",
            }
          );
          return res.status(409).json({
            error:
              editResolution.compoundConflicts.length > 0
                ? `This certificate's ${editResolution.compoundConflicts
                    .map((c) => c.group)
                    .join(
                      " and "
                    )} details were changed elsewhere while you were editing related fields (${reported.join(
                    ", "
                  )}) — refresh the page to see the latest values, then re-apply your edit.`
                : `This certificate was changed elsewhere since you opened it (${editResolution.conflicts.join(
                    ", "
                  )}) — refresh the page to see the latest values, then re-apply your edit.`,
            conflicts: editResolution.conflicts,
            compoundConflicts: editResolution.compoundConflicts,
          });
        }

        // NOTE (review requirement 7): the request body is NOT mutated here.
        // An earlier revision wrote merged values back into `req.body` to fake
        // presence, which destroyed the distinction between "the client sent
        // this" and "the server merged this". The merge is applied directly to
        // the update object instead — see `putGuarded` below, which consults
        // the resolution's per-field provenance.
      }
    }

    // Required-identity fields (matches the client's create/edit validation)
    // — enforced here too since auto-save posts directly to this route and
    // must never persist a blank identity field.
    // Required-identity fields must never be persisted BLANK. H-1: validate
    // only the ones this request actually SUBMITTED — an absent field is not
    // being written, so there is nothing to blank. Validating absence here
    // was what forced every save to be a full-state post, which is precisely
    // the pattern that made partial edits clobber unrelated columns.
    const requiredKeys = ["cardGame", "setName", "cardName", "cardNumber", "year"] as const;
    const blankField = requiredKeys
      .filter((k) => Object.prototype.hasOwnProperty.call(req.body, k))
      .find((k) => typeof req.body[k] !== "string" || !String(req.body[k]).trim());
    if (blankField) {
      return res.status(400).json({ error: `${blankField} is required and cannot be blank` });
    }
    const submittedSetNameBlank =
      Object.prototype.hasOwnProperty.call(req.body, "setName") &&
      (typeof req.body.setName !== "string" || !String(req.body.setName).trim());
    const submittedCanonicalSetCode =
      Object.prototype.hasOwnProperty.call(req.body, "setId") ||
      Object.prototype.hasOwnProperty.call(req.body, "set_code") ||
      Object.prototype.hasOwnProperty.call(req.body, "canonical_set_id");
    const explicitUnresolvedSet =
      req.body.canonical_mapping_unresolved === true ||
      req.body.canonical_mapping_unresolved === "true" ||
      req.body.needs_manual_add === true ||
      req.body.needs_manual_add === "true";
    if (submittedSetNameBlank && submittedCanonicalSetCode && !explicitUnresolvedSet) {
      return res.status(400).json({
        error:
          "Cannot save a canonical set code with a blank set name unless the set mapping is explicitly unresolved.",
      });
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const frontImage = files?.frontImage?.[0];
    const backImage = files?.backImage?.[0];

    const toValidate2 = [frontImage, backImage].filter((f): f is Express.Multer.File => !!f);
    if (toValidate2.length > 0) {
      const uploadErr = await rejectInvalidUploads(toValidate2);
      if (uploadErr) return res.status(400).json({ error: uploadErr });
    }

    // Locked NO rule on the metadata editor too: its Grade Type dropdown could
    // convert a PUBLISHED numeric certificate to authentication-only and null its
    // grade in the same write (finalGradeOverall below is forced to null for a
    // non-numeric kind). Ordinary editing of an unapproved certificate is still
    // allowed; changing a published certificate's kind is refused and routed to
    // Super Admin Correction Mode. Comparison only — no scoring logic touched.
    const storedGradeTypeUpdate = normaliseGradeType(existing.gradeType);
    const requestedKindUpdate = kindOfGradeType(req.body.gradeType || storedGradeTypeUpdate);
    const kindRejectionUpdate = rejectKindChange({
      storedGradeType: storedGradeTypeUpdate,
      requestedKind: requestedKindUpdate,
      isApproved: existing.gradeApprovedAt != null,
      allowChangeWhenUnapproved: true,
    });
    if (kindRejectionUpdate) {
      try {
        await storage.writeAuditLog(
          "certificate",
          String((existing as { certId?: string }).certId ?? id),
          "edit_kind_change_rejected",
          (req.session as { adminEmail?: string })?.adminEmail || "admin",
          {
            stored_grade_type: storedGradeTypeUpdate,
            requested_kind: requestedKindUpdate,
            route: "certificate-update",
          }
        );
      } catch (auditErr) {
        console.warn("[cert-update] kind-rejection audit failed:", (auditErr as Error).message);
      }
      return res.status(400).json({ error: kindRejectionUpdate });
    }
    const gradeTypeUpdate = gradeTypeToPersist(storedGradeTypeUpdate, requestedKindUpdate);
    const isNonNumUpdate = requestedKindUpdate !== "numeric";

    // ── OMISSION DISCIPLINE ──────────────────────────────────────────────
    // Real property presence on the request body. This is the SINGLE test
    // every writable field below is gated on — including the grade fields.
    const submitted = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k);

    if (!isNonNumUpdate && req.body.gradeOverall) {
      const g = Number(req.body.gradeOverall);
      if (!isValidNumericGrade(g)) {
        return res.status(400).json({ error: "Grade must be a valid MVGS grade (1–10, including half grades)" });
      }
    }

    // ── H-1 (final hostile review): the GRADE fields honour omission too ──
    // `gradeOverall`, `gradeType` and `labelType` used to be written on EVERY
    // request. A metadata-only PUT therefore nulled a stored grade, and the
    // Pristine gate — fed that null — demoted a genuine black label to
    // Standard, while the audit falsely attributed both to the request
    // (`source: "request"` for a field the request never sent).
    //
    // This route now governs a grade field ONLY when the request carries one:
    //   • `gradeOverall` submitted → that value, or an explicit "" clear;
    //   • `gradeType` submitted AND converting to a non-numeric kind (NO/AA)
    //     → the grade is cleared, which is the documented meaning of that
    //     conversion (`rejectKindChange` above already refuses it outright on
    //     a published certificate);
    //   • otherwise → all three are ABSENT from `data`, so the UPDATE cannot
    //     touch them, the stored subgrades stay intact, the Pristine/black
    //     state survives, and the audit cannot claim they changed.
    //
    // Full-state grading saves are unaffected: the edit form posts every form
    // key, so `gradeOverall`/`gradeType` are present and behave exactly as before.
    // ── PR A · SERVER-SIDE FIELD OWNERSHIP (primary defence) ─────────────
    // This route owns certificate METADATA ONLY. It is now structurally
    // incapable of writing grading state: grading-owned columns are never
    // added to `data`, whatever the client sends.
    //
    // WHY: the Card Details form posted FULL form state on every auto-save,
    // including a `gradeOverall` that had gone stale the moment the hidden
    // grading workstation wrote a new grade out-of-band. The metadata save
    // then reverted it. Live evidence: MV900007 9.0 -> 10.0 -> 9.0
    // (audit #1915 `gradeOverall: "10.0"->"9.0"`).
    //
    // A submitted grading field is REJECTED with an explicit contract error
    // rather than silently ignored — except when the submitted value equals
    // what is already stored, which is a harmless echo from an older client
    // and must not break it. Legitimate grading writes use the dedicated
    // grading route.
    //
    // ALIAS COVERAGE: detection is alias-aware (shared contract), because the
    // same column travels under three naming families — `gradeCorners`
    // (Drizzle), `grade_corners` (grading-API payload) and `corners_score`
    // (the actual column, and the name in raw SQL and audit payloads). A
    // multipart client using any of them is caught, and the comparison is made
    // against the canonical stored column rather than an undefined property.
    const { changing: changingGradingFields } = gradingFieldChanges(
      req.body as Record<string, unknown>,
      existing as unknown as Record<string, unknown>
    );
    if (changingGradingFields.length > 0) {
      await storage.writeAuditLog(
        "certificate",
        existing.certId,
        "metadata_grading_field_rejected",
        req.session.adminEmail || "admin",
        { certificateId: existing.id, rejected: changingGradingFields, outcome: "no_write" }
      );
      return res.status(409).json({
        error: gradingFieldContractError(changingGradingFields),
        rejectedFields: changingGradingFields,
      });
    }

    // ── H-1: the update object HONOURS OMISSION ──────────────────────────
    // A guarded field is written ONLY when the request actually submitted it
    // (real property presence), or when conflict resolution decided to MERGE
    // a concurrent database value. An OMITTED field is absent from `data`
    // entirely, so the UPDATE cannot touch it and the audit cannot claim it
    // changed.
    /** Provenance per guarded field, when a three-way resolution ran. */
    const provenanceOf = (k: string): FieldProvenance | null =>
      editResolution?.fields.find((f) => f.key === k)?.provenance ?? null;

    // Built from the METADATA allowlist only. gradeOverall / gradeType /
    // labelType and every other grading-owned column are GRADING-OWNED and
    // are never written here — see the ownership contract above. Subgrades
    // were already excluded; the boundary now covers the whole grading set.
    const data: any = {};
    // labelType is DERIVED from grade + kind, so it is recomputed ONLY when
    // this request actually changes one of them. Re-deriving it on a
    // metadata-only edit is exactly what demoted Pristine certificates.
    // labelType is GRADING-OWNED and DERIVED from grade + kind. Because this
    // route can no longer change either, it must not re-derive labelType
    // either: doing so on a metadata-only edit is exactly what demoted
    // Pristine certificates. The stored label survives untouched, so
    // historical certificates render exactly as before (PR A clarification E).

    /**
     * Write a guarded field only when it was submitted, or when the resolver
     * merged a concurrent value. `transform` maps the RAW submitted value to
     * the column value, so each field keeps its own documented clear
     * representation (e.g. "" / null for a scalar).
     */
    const putGuarded = (key: string, transform: (raw: unknown) => unknown = (v) => v) => {
      const prov = provenanceOf(key);
      if (prov === "omitted") return; // resolver: never submitted → untouched
      if (prov === "merged") {
        // Concurrent database value wins. Taken from the resolver directly —
        // req.body is NOT mutated to fake presence (review requirement 7).
        data[key] = (existing as Record<string, unknown>)[key] ?? null;
        return;
      }
      if (!submitted(key)) return; // legacy path (no snapshot): honour absence
      data[key] = transform(req.body[key]);
    };

    // Scalars: an explicit "" or null is a legitimate clear and is preserved
    // as-is; only genuine absence skips the write.
    const scalarOrNull = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : v);
    let validatedIdentityVariant: ReturnType<typeof validateGradeDraftIdentityAndVariant>;
    try {
      validatedIdentityVariant = validateGradeDraftIdentityAndVariant(existing, req.body);
    } catch (e) {
      if (e instanceof GradeDraftValidationError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    putGuarded("cardGame");
    putGuarded("setName");
    putGuarded("cardName");
    putGuarded("cardNumber");
    putGuarded("year");
    putGuarded("language", (v) => {
      const raw = scalarOrNull(v);
      if (raw == null) return null;
      return validatedIdentityVariant.nextLanguage;
    });
    putGuarded("rarity", scalarOrNull);
    putGuarded("variant", scalarOrNull);
    putGuarded("collectionCode", scalarOrNull);

    // "OTHER" companions follow their GOVERNING field's presence: they are
    // only meaningful when that field is being written in this request.
    if (Object.prototype.hasOwnProperty.call(data, "rarity")) {
      data.rarityOther = data.rarity === "OTHER" ? req.body.rarityOther || null : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "variant")) {
      data.variantOther = data.variant === "OTHER" ? req.body.variantOther || null : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "collectionCode")) {
      data.collectionOther = data.collectionCode === "OTHER" ? req.body.collectionOther?.trim() || null : null;
    }

    // designations: explicit [] (or "[]") clears; absence leaves it alone.
    if (provenanceOf("designations") === "merged") {
      data.designations = (existing.designations as string[]) ?? [];
    } else if (provenanceOf("designations") !== "omitted" && submitted("designations")) {
      data.designations = parseDesignations(req.body.designations, existing.designations as string[]);
    }

    // notes is not a conflict-guarded field, but it had the SAME defect:
    // `req.body.notes || null` cleared stored notes on any partial PUT.
    if (submitted("notes")) data.notes = req.body.notes || null;
    // status keeps its existing fallback (it is always meaningful).
    data.status = req.body.status || existing.status;

    if (data.collectionCode === "OTHER" && !data.collectionOther) {
      return res.status(400).json({ error: "Collection 'Other (manual)' requires a manual entry value" });
    }

    // Front-label line 3 shows EITHER variant OR rarity — enforce at write
    // time. Only reject when this edit actually CHANGES variant/rarity, so
    // legacy both-set certs can still receive unrelated metadata edits.
    //
    // H-1: reason about the EFFECTIVE post-update state. A field absent from
    // `data` is not being written, so its effective value is the stored one —
    // reading `data.variant` directly would see `undefined` and mistake an
    // untouched field for a cleared one.
    const effective = (k: "variant" | "rarity") =>
      (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : (existing as Record<string, unknown>)[k]) ?? null;
    const effVariant = effective("variant");
    const effRarity = effective("rarity");
    const touchesVariantRarity = effVariant !== (existing.variant ?? null) || effRarity !== (existing.rarity ?? null);
    if (effVariant && effRarity && touchesVariantRarity) {
      return res.status(400).json({
        error: "Set either Variant or Rarity, not both — the front label shows only one on line 3.",
      });
    }

    // Structured rarity/variant picker → new nullable columns. Opt-in by key
    // presence, so a partial PUT (e.g. grade-only) never erases them; the
    // legacy variant/rarity remain the untouched historical source of truth.
    let structuredUpdate = applyStructuredVariantFromBody(
      req.body,
      data,
      await getCatalogueSnapshot(),
      existing.structuredVariantVersion
    );
    if (!structuredUpdate.ok) {
      // Stale cross-machine cache guard — force-refresh once and retry.
      structuredUpdate = applyStructuredVariantFromBody(
        req.body,
        data,
        await getCatalogueSnapshot(true),
        existing.structuredVariantVersion
      );
    }
    if (!structuredUpdate.ok) {
      return res.status(400).json({ error: "Invalid rarity selection.", details: structuredUpdate.errors });
    }

    // ── M-3 · IMAGE REPLACEMENT MUST LEAVE TRUTHFUL AUDIT EVIDENCE ────────
    // R2 keys are DETERMINISTIC (`images/{certId}/front.jpg`), so re-uploading
    // a front image with the same extension replaces the OBJECT while the
    // stored path STRING is unchanged. The committed-field diff therefore saw
    // no change, the no-op early return fired, and a customer's card image was
    // swapped with no audit row at all — the trail said nothing happened.
    //
    // Recorded per replacement below and audited unconditionally further down,
    // whether or not any metadata column also changed. The evidence is the
    // CONTENT identity (sha256 of the uploaded bytes + size + mime), not a
    // fabricated path change: the audit states that the image content was
    // replaced, and says explicitly when the path did not move.
    type ImageReplacement = {
      side: "front" | "back";
      r2Key: string;
      previousPath: string | null;
      pathChanged: boolean;
      contentSha256: string;
      bytes: number;
      contentType: string;
      originalFilename: string;
    };
    const imageReplacements: ImageReplacement[] = [];

    const applyImageUpload = async (
      side: "front" | "back",
      file: Express.Multer.File,
      previousPath: string | null,
      sortOrder: number
    ) => {
      const ext = path.extname(file.originalname).replace(".", "");
      const r2Key = r2KeyForImage(existing.certId, side, ext || "jpg");
      await uploadToR2(r2Key, file.buffer, file.mimetype);
      // Delete the superseded object ONLY when it is genuinely a DIFFERENT
      // key. Deleting unconditionally removed the object that had just been
      // uploaded whenever the extension was unchanged — the overwhelmingly
      // common case — destroying the image the operator had just supplied.
      if (previousPath && previousPath !== r2Key) {
        try {
          await deleteFromR2(previousPath);
        } catch {}
      }
      data[side === "front" ? "frontImagePath" : "backImagePath"] = r2Key;
      await storage.addCertificateImage({
        certificateId: id,
        imageType: side,
        url: r2Key,
        sortOrder,
      });
      imageReplacements.push({
        side,
        r2Key,
        previousPath: previousPath ?? null,
        pathChanged: (previousPath ?? null) !== r2Key,
        contentSha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
        bytes: file.buffer.length,
        contentType: file.mimetype,
        originalFilename: file.originalname,
      });
    };

    if (frontImage) await applyImageUpload("front", frontImage, existing.frontImagePath ?? null, 0);
    if (backImage) await applyImageUpload("back", backImage, existing.backImagePath ?? null, 1);

    // ── H6: truthful FIELD-LEVEL audit ───────────────────────────────────
    // The old payload recorded three CURRENT values and no previous values,
    // so it could not answer "what actually changed?". Record the real diff:
    // only fields whose value genuinely changed, each with its previous and
    // next value and where the value came from (this request, or a safe
    // merge that preserved a concurrent database value).
    //
    // H-1 (second review): the diff is computed from the EXACT object that is
    // about to be committed — never from the resolver's view of it. The
    // resolver does not know about the always-computed fields (labelType,
    // gradeType, gradeOverall, status) or the "OTHER" companions, so a
    // resolver-derived diff could omit a field the UPDATE really changed.
    // Provenance is layered on top from the resolution where it is known.
    const auditChanges = buildCommittedFieldDiff(
      existing as Record<string, unknown>,
      data as Record<string, unknown>,
      (k) => editResolution?.fields.find((f) => f.key === k)?.provenance ?? "request"
    );

    const mergedFields = editResolution
      ? editResolution.fields.filter((f) => f.provenance === "merged").map((f) => f.key)
      : [];

    // ── PR A · A GENUINE NO-OP WRITES NOTHING AND AUDITS NOTHING ──────────
    // DIAGNOSIS. `data.status` is assigned unconditionally
    // (`req.body.status || existing.status`), so `data` was never empty and
    // the audited UPDATE always ran. `buildCommittedFieldDiff` correctly
    // produced an EMPTY change list for a request that submitted only values
    // identical to the stored ones — but `updateCertificateAudited` writes its
    // audit row regardless, so a no-op save produced an `update` audit event
    // claiming `changes: []` and bumped `updated_at`. On the Card Details
    // auto-save, which fires on a debounce while a grader tabs around, that
    // filled the trail with meaningless rows and made a real edit harder to
    // find. It was NOT caused by normalisation, derived metadata or tolerated
    // grading echoes — a tolerated echo is not in `data` at all.
    //
    // INTENTIONAL updated_at BEHAVIOUR: a request that changes no business
    // field does not touch the row, so `updated_at` is NOT bumped. The row
    // timestamp means "when this certificate last actually changed". Tested.
    //
    // M-3: an image upload that lands on the SAME deterministic R2 key
    // produces no committed FIELD change, but the customer's image content
    // genuinely changed. That is NOT a no-op and must never take the silent
    // path — it gets its own audit event below, carrying the content identity.
    if (auditChanges.length === 0 && imageReplacements.length === 0) {
      return res.json({ ...existing, certId: normalizeCertId(existing.certId) });
    }

    // ── M-5 · SERVER-SIDE COMMITTED-KEY ALLOWLIST (fail closed) ───────────
    // `data` is assembled by convention — hard-coded putGuarded calls, the
    // "OTHER" companions, image paths, and an in-place merge from the
    // structured-variant applier. Nothing structurally prevented a future
    // `putGuarded("gradeOverall")` from reintroducing the very defect PR A
    // removes. Every key about to be persisted must now belong to an explicit
    // approved set (metadata / image / structured / documented server-derived).
    // Throws, so a mistake is loud (500 + logged) rather than a silent grading
    // write; it is checked BEFORE any row or audit write, so a violation
    // persists nothing.
    assertServerMetadataCommitKeys(data as Record<string, unknown>);

    const imageAuditDetail = imageReplacements.length
      ? {
          imageReplacements: imageReplacements.map((r) => ({
            side: r.side,
            r2Key: r.r2Key,
            previousPath: r.previousPath,
            // Stated explicitly rather than implied: when false, the stored
            // path did NOT move and the object itself was overwritten.
            pathChanged: r.pathChanged,
            contentSha256: r.contentSha256,
            bytes: r.bytes,
            contentType: r.contentType,
            originalFilename: r.originalFilename,
          })),
        }
      : {};

    // M-3: image content replaced but NO metadata column changed. There is
    // nothing to UPDATE, so `updateCertificateAudited` (which pairs a row
    // write with its audit row) has no row to write — the audit is recorded on
    // its own. It is awaited and NOT swallowed: if it fails the handler's
    // outer catch returns 500, so the caller is never told a replacement
    // succeeded with no trail of it.
    if (auditChanges.length === 0) {
      await storage.writeAuditLog(
        "certificate",
        existing.certId,
        "certificate_image_replaced",
        req.session.adminEmail || "admin",
        {
          certificateId: existing.id,
          certId: existing.certId,
          scope: "certificate_image_only",
          changes: [],
          changedFields: [],
          ...imageAuditDetail,
        }
      );
      return res.json({ ...existing, certId: normalizeCertId(existing.certId) });
    }

    // H7: the row change and its audit row commit together or not at all.
    const cert = await storage.updateCertificateAudited(id, data, {
      entityId: existing.certId,
      action: "update",
      adminUser: req.session.adminEmail || "admin",
      details: {
        certificateId: existing.id,
        certId: existing.certId,
        // certificate-only edit — this route never renames a catalogue entry.
        scope: "certificate_only",
        changes: auditChanges,
        changedFields: auditChanges.map((c) => c.field),
        // Unrelated concurrent edits that were preserved rather than clobbered.
        mergedFromConcurrentEdit: mergedFields,
        conflictGuard: editResolution ? "three_way_snapshot" : "legacy_no_snapshot",
        // M-3: content identity travels with the ordinary update audit too, so
        // a replacement is provable whether or not the path string moved.
        ...imageAuditDetail,
      },
    });

    res.json(cert ? { ...cert, certId: normalizeCertId(cert.certId) } : cert);
  } catch (error: any) {
    console.error("Update cert error:", error.message, error.stack);
    res.status(500).json({ error: "Failed to update certificate" });
  }
}

/**
 * POST /api/admin/certificates — the certificate CREATE handler.
 *
 * Extracted VERBATIM from its former inline `app.post` registration inside
 * registerRoutes, exactly as `handleCertificateMetadataUpdate` and
 * `handleCertificateGradeUpdate` already were, so the paid-submission linkage
 * (hostile review H-1) can be driven over real HTTP against a disposable
 * PostgreSQL cluster instead of being asserted from source text.
 *
 * NOT ONE LINE OF CREATE LOGIC IS CHANGED by the extraction: same body, same
 * order, same comments, same validation, same audit. The mount point below is
 * unchanged too — same path, same requireAdmin + multer chain, same position.
 */
export async function handleCertificateCreate(req: any, res: any): Promise<void> {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const frontImage = files?.frontImage?.[0];
    const backImage = files?.backImage?.[0];

    const toValidate = [frontImage, backImage].filter((f): f is Express.Multer.File => !!f);
    if (toValidate.length > 0) {
      const uploadErr = await rejectInvalidUploads(toValidate);
      if (uploadErr) return res.status(400).json({ error: uploadErr });
    }

    // Normalise on the way IN. `certificates.grade_type` is plain text with no CHECK
    // constraint, and the renderer decides the kind by EXACT string membership
    // (isNonNumericGrade). So a padded or junk value — " NO ", "no", "banana" — is
    // treated as NUMERIC by the renderer while looking non-numeric to a human. That is
    // precisely how a row could be created that claims to need no grade and then prints
    // 0 / POOR. The PUT paths already normalise (handleCertificateGradeUpdate does);
    // this create path did not.
    //
    // Re-applied here rather than in the inline handler PR #254 originally patched: main
    // has since refactored that route body into this named handler.
    const gradeType = normaliseGradeType(req.body.gradeType);
    const isNonNum = isNonNumericGrade(gradeType);

    if (!isNonNum && req.body.gradeOverall) {
      const g = Number(req.body.gradeOverall);
      if (!isValidNumericGrade(g)) {
        return res.status(400).json({ error: "Grade must be a valid MVGS grade (1–10, including half grades)" });
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
    // Pristine/black via the shared MVGS gate, never grade alone. This path
    // stores null subgrades (Pristine is established only by the grading-save
    // paths that run the full subgrade+deduction gate), so isBlackLabel()
    // returns false here → "Standard". Same gate as approve-grade/grade-card.
    const computedLabelType =
      !isNonNum && isBlackLabel({ centering: -1, corners: -1, edges: -1, surface: -1 }, certGrade)
        ? "black"
        : "Standard";
    if (req.body.language && !normalizePokemonLanguage(req.body.language)) {
      return res.status(400).json({ error: `Unsupported language: ${req.body.language}` });
    }

    const data = {
      labelType: computedLabelType,
      gradeType,
      submissionItemId: validatedItemId,
      cardGame: req.body.cardGame,
      setName: req.body.setName,
      cardName: req.body.cardName,
      cardNumber: req.body.cardNumber,
      rarity: req.body.rarity || null,
      rarityOther: req.body.rarity === "OTHER" ? req.body.rarityOther || null : null,
      designations: parseDesignations(req.body.designations),
      variant: req.body.variant || null,
      variantOther: req.body.variant === "OTHER" ? req.body.variantOther || null : null,
      collection: null,
      collectionCode: req.body.collectionCode || null,
      collectionOther: req.body.collectionCode === "OTHER" ? req.body.collectionOther?.trim() || null : null,
      language: languageLabel(req.body.language || "English"),
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

    // Front-label line 3 shows EITHER variant OR rarity — held by convention
    // only until now. Enforce at write time so both can never be set (the
    // label renderer would silently drop one → wrong physical product).
    if (data.variant && data.rarity) {
      return res.status(400).json({
        error: "Set either Variant or Rarity, not both — the front label shows only one on line 3.",
      });
    }

    // Structured rarity/variant picker → new nullable columns (legacy
    // variant/rarity above are left untouched). Validated + symbol-derived
    // server-side; invalid catalogue values are rejected here, not at the DB.
    let structuredCreate = applyStructuredVariantFromBody(req.body, data, await getCatalogueSnapshot());
    if (!structuredCreate.ok) {
      // A stale cross-machine catalogue cache can reject a just-added value —
      // force-refresh the snapshot once and retry before failing (data is not
      // mutated on a failed apply, so the retry is safe).
      structuredCreate = applyStructuredVariantFromBody(req.body, data, await getCatalogueSnapshot(true));
    }
    if (!structuredCreate.ok) {
      return res.status(400).json({ error: "Invalid rarity selection.", details: structuredCreate.errors });
    }

    const cert = await storage.createCertificate(data, req.session.adminEmail || "admin");

    await storage.writeAuditLog("certificate", cert.certId, "create", req.session.adminEmail || "admin", {
      cardName: data.cardName,
      setName: data.setName,
      cardNumber: data.cardNumber,
      gradeOverall: data.gradeOverall,
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
    res.status(500).json({ error: "Failed to create certificate" });
  }
}

/**
 * PUT /api/admin/certificates/:id/grade — the DEDICATED grading write path.
 *
 * Extracted VERBATIM from its inline `app.put` registration inside
 * registerRoutes so it can be mounted in a route-level test over a disposable
 * PostgreSQL cluster, exactly as `handleCertificateMetadataUpdate` above already
 * is. PR A moves the last grading writes off the metadata route onto this one,
 * and that migration is only meaningfully proven by driving THIS handler.
 *
 * NOT ONE LINE OF GRADING LOGIC IS CHANGED by the extraction: the body below is
 * the original body, in the original order, with the original comments. Scoring,
 * weights, the MVGS formula, the kind rules and the COALESCE preservation
 * semantics are all untouched. The mount point is unchanged too — same path,
 * same requireAdmin middleware, same position in the route table.
 */
export async function handleCertificateGradeUpdate(req: any, res: any): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    const cert = await storage.getCertificate(id);
    if (!cert) return res.status(404).json({ error: "Certificate not found" });

    // Restricted-grader lock (cert-level). An admin must NOT grade-write a card
    // that is assigned to a grader and still in their workflow.
    if (await isGraderLocked(id)) return res.status(409).json({ error: "This card is assigned to a grader" });
    const rawBody = req.body || {};
    const authoritativeGrade = await resolveDraftGradeAuthority(cert as any, rawBody);
    // Only observation fields cross the browser boundary.  Replace every
    // client-supplied grade output before the established write/audit path
    // sees it, so forged totals or subgrades cannot reach the database.
    const b = {
      ...rawBody,
      overall_grade: authoritativeGrade.overall,
      grade_centering: authoritativeGrade.subgrades.centering,
      grade_corners: authoritativeGrade.subgrades.corners,
      grade_edges: authoritativeGrade.subgrades.edges,
      grade_surface: authoritativeGrade.subgrades.surface,
    };
    const overallGrade = b.overall_grade;
    const isNonNumRequested = overallGrade === "AA" || overallGrade === "NO";
    const parsedOverall = parseFloat(overallGrade);
    const gradeNum = isNonNumRequested ? null : isNaN(parsedOverall) ? null : parsedOverall;

    // grade_type used to be derived SOLELY from this request's overall_grade, so ANY
    // partial auto-save that omitted the field (the common case — this route fires on
    // every autosave) rewrote grade_type to 'numeric'. On an authentication-only
    // record that silently converted it to numeric. Proven on staging 2026-07-25:
    // an autosave body of {"grade_explanation":"..."} flipped a stored 'NO' to
    // 'numeric'. Per the locked business rule, a numeric <-> authentication-only
    // conversion must be an explicit, separately-confirmed Super Admin action, never
    // a side effect of a save. Fix: only honour a kind the caller actually stated;
    // otherwise preserve the stored value. Preservation only — no scoring or formula
    // logic, and an explicit NO/AA/numeric from the workstation still applies.
    const storedGradeType = normaliseGradeType((cert as { gradeType?: string | null }).gradeType);
    const overallStated = overallGrade != null && String(overallGrade).trim() !== "";
    // CRITICAL (found by hostile review of the first version of this fix): giving this
    // route only preserve-on-omission left a one-key body — {"overall_grade":"NO"} —
    // able to convert a LIVE PUBLISHED numeric certificate to authentication-only and
    // null its grade AND all four sub-grades, with a 200. This route's UPDATE has no
    // grade_approved_at guard, so published rows are writable here.
    //
    // Locked rule, applied through the shared helper: setting the kind on a certificate
    // that has never been approved is ordinary grading work and stays allowed (a card
    // must be gradeable as authentication-only in the first place); changing the kind of
    // an ALREADY-PUBLISHED certificate is refused and routed to Super Admin Correction
    // Mode. An unstated kind always preserves the stored value.
    const requestedKind = overallStated ? kindOfOverallGrade(overallGrade) : kindOfGradeType(storedGradeType);
    const kindRejection = overallStated
      ? rejectKindChange({
          storedGradeType,
          requestedKind,
          isApproved: (cert as { gradeApprovedAt?: unknown }).gradeApprovedAt != null,
          allowChangeWhenUnapproved: true,
        })
      : null;
    if (kindRejection) {
      try {
        await storage.writeAuditLog(
          "certificate",
          String((cert as { certId?: string }).certId ?? id),
          "grade_kind_change_rejected",
          (req.session as { adminEmail?: string })?.adminEmail || "admin",
          { stored_grade_type: storedGradeType, requested_kind: requestedKind, route: "grade" }
        );
      } catch (auditErr) {
        console.warn("[grade] kind-rejection audit failed:", (auditErr as Error).message);
      }
      return res.status(400).json({ error: kindRejection });
    }
    const nextGradeType = gradeTypeToPersist(storedGradeType, requestedKind);
    // The NULL-out branches below must follow the RESOLVED kind, never the raw request:
    // otherwise a body whose kind change was refused (or simply omitted) could still
    // null the grade and sub-grades while grade_type kept its stored value.
    const isNonNum = requestedKind !== "numeric";

    // P0 preservation helpers — return null when payload field is missing/empty/invalid,
    // so the SQL COALESCE below falls through to the existing column value.
    // (Prior `parseFloat(x) || null` idiom silently nulled rows on partial saves.)
    const num = (v: unknown): number | null => {
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : parseFloat(String(v));
      return isNaN(n) ? null : n;
    };
    const txt = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
    const jsn = (v: unknown): string | null => (v != null ? JSON.stringify(v) : null);

    // Strength score is calibrated to the AI's overall grade. If the admin
    // changes the grade manually here, the AI-derived score is stale and
    // must be cleared. fmt() normalises 9 vs 9.0 vs null cleanly.
    const fmt = (n: number | null) => (n == null ? "" : n.toFixed(1));
    const oldGradeNum = (cert as any).gradeOverall != null ? parseFloat(String((cert as any).gradeOverall)) : null;
    const gradeChanged = fmt(gradeNum) !== fmt(oldGradeNum);

    // Track approval state pre-write for the audit trail. Edits to an
    // already-approved cert are LIVE-RECORD edits — same SQL path,
    // different audit_log action so we can analyse post-launch which
    // certs got changed after publication.
    const wasApproved = (cert as any).gradeApprovedAt != null;

    // ── M-3 · THE GRADING WRITE AND ITS AUDIT COMMIT TOGETHER OR NOT AT ALL ─
    //
    // DIAGNOSIS (hostile review of PR #260, finding M-3). The UPDATE below ran
    // on its own connection and committed immediately. The audit INSERT then
    // ran afterwards inside `try { … } catch { console.warn(…) }`, so ANY
    // audit failure — a bad connection, a constraint, a jsonb error, a pool
    // timeout — was swallowed and the route still answered `{ ok: true }`. A
    // grade could therefore change on a customer's certificate with NO durable
    // record of who changed it or from what, and the operator would be told it
    // saved. For a grading platform whose product is the trustworthiness of
    // the record, an unauditable grade change is the failure that matters.
    //
    // The diff is computed BEFORE the transaction (it compares the payload
    // against the row read at the top of this handler), so the transaction
    // contains only the two durable writes and nothing that can fail slowly.
    //
    // ENTITY IDENTITY: this route recorded `entity_id` as the NUMERIC row id
    // while the metadata route records the canonical `certId` ("MV1"), so an
    // operator querying the trail by certificate ID silently missed every
    // grading event. Both now write the canonical certId, with the numeric id
    // retained inside `details` for continuity with historical rows.
    // ── M-1 (hostile review of PR #262) · EFFECTIVE WRITTEN VALUES ──────────
    //
    // Eight MVGS v2 defect-input columns are written by the UPDATE below but
    // were absent from the audit field map, so — once PR #262 stopped writing
    // an audit row for an empty change set — a save that touched ONLY these
    // produced NO audit row at all. They are grading EVIDENCE (they feed the
    // engine), so that was a real coverage hole. `buildPayload()` sends all
    // eight on every save.
    //
    // They cannot simply be added to the map with their RAW payload values:
    // unlike the other mapped fields, the SQL for these CLAMPS, VALIDATES or
    // type-gates what it writes. `eye_appeal_modifier: 99` writes 2;
    // `wrinkle_severity: "junk"` writes nothing at all. Auditing the payload
    // would therefore claim changes the database never made — trading a
    // missing row for a lying one.
    //
    // So the rule is resolved ONCE here, and the SAME resolved value is used
    // by both the UPDATE and the audit diff. `undefined` means "this request
    // does not write the column" (preserve stored), and such a field is never
    // reported as changed.
    const effDarkBorderFront = typeof b.dark_border_front === "boolean" ? b.dark_border_front : undefined;
    const effDarkBorderBack = typeof b.dark_border_back === "boolean" ? b.dark_border_back : undefined;
    const effEyeAppealModifier = (() => {
      // Clamp ±2 server-side; ignore non-finite payloads.
      const n = Number(b.eye_appeal_modifier);
      if (!Number.isFinite(n)) return undefined;
      return Math.max(-2, Math.min(2, Math.trunc(n)));
    })();
    const effWhiteningLines = Array.isArray((b as any).whitening_lines)
      ? ((b as any).whitening_lines as unknown[])
      : undefined;
    const effCreaseLines = Array.isArray((b as any).crease_lines) ? ((b as any).crease_lines as unknown[]) : undefined;
    const effCreaseSpanPct = (() => {
      const v = (b as any).crease_span_pct;
      if (v === null) return null;
      if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
      return undefined;
    })();
    const effWrinkleSeverity = (() => {
      const v = (b as any).wrinkle_severity;
      if (v === null) return null;
      if (v === "tiny_back" || v === "longer_back" || v === "small_front" || v === "multiple_front") return v;
      return undefined;
    })();
    const effTearSeverity = (() => {
      const v = (b as any).tear_severity;
      if (v === null) return null;
      if (v === "minor" || v === "significant" || v === "major") return v;
      return undefined;
    })();
    // ── H-3 · THE NO/AA NULL-OUT PATH MUST BE AUDITED AT WHAT POSTGRES STORES
    //
    // When `isNonNum` the SET clause writes `grade` and all four sub-grade
    // columns as literal NULL, IGNORING the payload. Auditing the raw payload
    // therefore recorded values the database never held: on an
    // authentication-only certificate the workstation posts
    // `overall_grade: "NO"` on every autosave, so the trail filled with rows
    // claiming `overall_grade: null -> "NO"` while the column stayed NULL, and
    // `{overall_grade:"NO", grade_centering:9}` was logged as
    // `grade_centering -> 9` while the column was NULLed.
    //
    // These five now resolve the same way the eight MVGS inputs already do:
    // one resolved value, consumed by BOTH the UPDATE and the audit diff.
    const effOverallGrade = isNonNum ? null : gradeNum != null ? gradeNum : undefined;
    const effGradeCentering = isNonNum ? null : (num(b.grade_centering) ?? undefined);
    const effGradeCorners = isNonNum ? null : (num(b.grade_corners) ?? undefined);
    const effGradeEdges = isNonNum ? null : (num(b.grade_edges) ?? undefined);
    const effGradeSurface = isNonNum ? null : (num(b.grade_surface) ?? undefined);
    // M-2r · `grade_type` is written UNCONDITIONALLY (`grade_type = ${nextGradeType}`),
    // so it is never "not written" — it is always the resolved kind. It is also
    // the one column the client never names in its payload, which is why the
    // diff below keys effective fields off "did the UPDATE write it" rather
    // than "is the key in the body". A numeric <-> NO/AA conversion is the
    // highest-consequence change this route makes and went entirely unnamed.
    const effGradeType = nextGradeType;

    /** Payload key → the value the UPDATE will actually commit (undefined = not written). */
    const EFFECTIVE_WRITTEN: Record<string, unknown> = {
      dark_border_front: effDarkBorderFront,
      dark_border_back: effDarkBorderBack,
      eye_appeal_modifier: effEyeAppealModifier,
      whitening_lines: effWhiteningLines,
      crease_lines: effCreaseLines,
      crease_span_pct: effCreaseSpanPct,
      wrinkle_severity: effWrinkleSeverity,
      tear_severity: effTearSeverity,
      overall_grade: effOverallGrade,
      grade_centering: effGradeCentering,
      grade_corners: effGradeCorners,
      grade_edges: effGradeEdges,
      grade_surface: effGradeSurface,
      grade_type: effGradeType,
    };
    const HAS_EFFECTIVE: ReadonlySet<string> = new Set(Object.keys(EFFECTIVE_WRITTEN));

    const fieldsChanged = Object.keys(b || {});
    const fieldMap: Array<[string, string]> = [
      ["overall_grade", "gradeOverall"],
      // M-2r · the resolved kind. Written unconditionally and never named by
      // the client, so the diff loop keys effective fields off "did the UPDATE
      // write it" rather than "is the key in the body".
      ["grade_type", "gradeType"],
      ["grade_centering", "gradeCentering"],
      ["grade_corners", "gradeCorners"],
      ["grade_edges", "gradeEdges"],
      ["grade_surface", "gradeSurface"],
      ["centering_front_lr", "centeringFrontLr"],
      ["centering_front_tb", "centeringFrontTb"],
      ["centering_back_lr", "centeringBackLr"],
      ["centering_back_tb", "centeringBackTb"],
      ["auth_status", "authStatus"],
      ["auth_notes", "authNotes"],
      ["grade_explanation", "gradeExplanation"],
      ["private_notes", "privateNotes"],
      ["corners", "cornerValues"],
      ["edges", "edgeValues"],
      ["surface", "surfaceValues"],
      ["defects", "defects"],
      ["ai_defect_candidates", "aiDefectCandidates"],
      // M-1 · the eight MVGS v2 defect-input columns. Accessors are the
      // Drizzle properties declared in shared/schema.ts, so a diff built from
      // the selected row is real rather than fabricated (unlike authStatus,
      // which is an undeclared column and fails closed elsewhere).
      ["dark_border_front", "darkBorderFront"],
      ["dark_border_back", "darkBorderBack"],
      ["eye_appeal_modifier", "eyeAppealModifier"],
      ["whitening_lines", "whiteningLines"],
      ["crease_lines", "creaseLines"],
      ["crease_span_pct", "creaseSpanPct"],
      ["wrinkle_severity", "wrinkleSeverity"],
      ["tear_severity", "tearSeverity"],
    ];
    // M-1 · structured values are compared SEMANTICALLY, not by raw string
    // formatting. `whitening_lines` and `crease_lines` are jsonb: Postgres
    // returns them with its own key ordering, while the workstation posts
    // JavaScript insertion order. A plain JSON.stringify compare would then
    // report a change on every save for objects whose keys happen to differ in
    // order. Keys are sorted recursively; ARRAY order is preserved, because
    // for a list of whitening lines or creases the order is part of the value.
    const canonicalJson = (value: unknown): string => {
      const walk = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === "object") {
          const src = x as Record<string, unknown>;
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
          return out;
        }
        return x;
      };
      return JSON.stringify(walk(value));
    };
    const norm = (v: unknown) => (v == null ? null : typeof v === "object" ? canonicalJson(v) : String(v));
    // Same narrowly-scoped numeric rule the metadata route already uses: for
    // the grading columns that are genuinely NUMERIC, Postgres returns "8.0"
    // while the workstation posts "8", so a plain string compare recorded a
    // FALSE change on every re-save. A debounced autosave re-sending an
    // unchanged grade would then write an audit row per keystroke claiming the
    // grade changed 8 -> 8. Applied ONLY when both sides are non-empty finite
    // numbers; everything else keeps the strict comparison.
    const NUMERIC_SET: ReadonlySet<string> = new Set(NUMERIC_GRADING_FIELDS);
    const sameValue = (pKey: string, before: string | null, after: string | null): boolean => {
      if (before === after) return true;
      const canonical = canonicalGradingField(pKey);
      if (!canonical || !NUMERIC_SET.has(canonical)) return false;
      if (before == null || after == null || before === "" || after === "") return false;
      const x = Number(before);
      const y = Number(after);
      return Number.isFinite(x) && Number.isFinite(y) && x === y;
    };
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    // ── H-2 · NO DIFF WITHOUT A REAL BEFORE-VALUE ────────────────────────────
    // `auth_status`, `auth_notes` and `private_notes` are REAL database columns
    // that this route writes, but shared/schema.ts does not declare them, so
    // Drizzle's `.select()` never materialises them and `cert.authStatus` is
    // `undefined` — not null, absent. `norm(undefined)` collapsed to `null`, so
    // every save compared `null` against the value the client always sends and
    // logged `auth_status: null -> "genuine"`.
    //
    // Two consequences, both proven against a real cluster: every audit row
    // carried three fabricated field changes, and because `changed` was never
    // empty the no-op suppression this PR added could never fire — a
    // byte-identical re-save still wrote a row.
    //
    // Fail CLOSED: a field whose before-value cannot be read is not audited at
    // all rather than audited from a fabricated one. A missing record is
    // recoverable; a false record is not. The fields are still listed under
    // `unauditableFields` so the omission is stated rather than silent.
    const unauditableFields: string[] = [];
    for (const [pKey, cKey] of fieldMap) {
      const beforeRaw = (cert as Record<string, unknown>)[cKey];
      // `undefined` means the column is not declared on the selected row.
      // A declared column that is SQL NULL comes back as `null`, not undefined.
      const beforeReadable = beforeRaw !== undefined;

      let afterValue: unknown;
      if (HAS_EFFECTIVE.has(pKey)) {
        const eff = EFFECTIVE_WRITTEN[pKey];
        // The UPDATE preserves the stored value for this request (payload was
        // absent, malformed, or the wrong type). Nothing is written, so
        // nothing may be reported as changed. Note this is keyed off what the
        // UPDATE WRITES, not off `pKey in b` — `grade_type` is always written
        // and is never named by the client.
        if (eff === undefined) continue;
        afterValue = eff;
      } else {
        if (!(pKey in (b || {}))) continue;
        afterValue = (b as any)[pKey];
      }

      if (!beforeReadable) {
        unauditableFields.push(pKey);
        continue;
      }
      const before = norm(beforeRaw);
      const after = norm(afterValue);
      if (!sameValue(pKey, before, after)) {
        changed[pKey] = { from: beforeRaw ?? null, to: afterValue ?? null };
      }
    }
    const canonicalCertId = String((cert as { certId?: string }).certId ?? id);
    const gradingActor = (req.session as { adminEmail?: string })?.adminEmail || "admin";

    // MERGE (2026-08-11): the v1070 canonical lineage's server-authoritative
    // review revision is preserved here on top of the v1069 audit-diff logic.
    // The revision is what the UPDATE RETURNS, never what the request claimed,
    // and it is what every downstream CAS (preview, manual approval, sampled
    // auto-finalisation) compares against.
    let savedReviewRevision: number | null = null;
    await db.transaction(async (tx) => {
      const gradeWrite = await tx.execute(sql`
        UPDATE certificates SET
          centering_front_lr  = COALESCE(${txt(b.centering_front_lr)}, centering_front_lr),
          centering_front_tb  = COALESCE(${txt(b.centering_front_tb)}, centering_front_tb),
          centering_back_lr   = COALESCE(${txt(b.centering_back_lr)},  centering_back_lr),
          centering_back_tb   = COALESCE(${txt(b.centering_back_tb)},  centering_back_tb),
          -- H-3: these five now read the SAME resolved values the audit diff
          -- reads, so the trail can no longer report a payload value on a request
          -- whose NULL-out discarded it. The COALESCE preserve-on-omission
          -- mechanism is deliberately KEPT: it is the anti-erasure guard that
          -- stops a partial autosave nulling a published grade (see
          -- tests/approval-grade-preservation.test.ts). Nullish-coalescing to
          -- null turns "not written" back into the COALESCE no-op, so the
          -- emitted SQL is byte-identical to before for every input.
          --
          -- NOTE: never use a backtick in a comment inside this template literal.
          -- It terminates the tagged template, silently truncating the statement
          -- after the last placeholder rendered before it.
          centering_score     = ${isNonNum ? sql`NULL` : sql`COALESCE(${effGradeCentering ?? null}::numeric, centering_score)`},
          corners_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${effGradeCorners ?? null}::numeric,   corners_score)`},
          edges_score         = ${isNonNum ? sql`NULL` : sql`COALESCE(${effGradeEdges ?? null}::numeric,     edges_score)`},
          surface_score       = ${isNonNum ? sql`NULL` : sql`COALESCE(${effGradeSurface ?? null}::numeric,   surface_score)`},
          grade               = ${isNonNum ? sql`NULL` : sql`COALESCE(${effOverallGrade ?? null}::numeric, grade)`},
          -- Preserves the stored kind when the caller did not state one (see nextGradeType
          -- above): an autosave must never convert an authentication-only record to numeric.
          grade_type          = ${nextGradeType},
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
          -- Preserve on omission rather than resetting to the most permissive value:
          -- a payload without auth_status must not silently downgrade an
          -- 'authentic_altered' record to 'genuine'. New rows default to 'genuine'
          -- at the column level, so behaviour for a genuinely-new cert is unchanged.
          auth_status         = COALESCE(${txt(b.auth_status)}, auth_status, 'genuine'),
          auth_notes          = COALESCE(${txt(b.auth_notes)},        auth_notes),
          grade_explanation   = COALESCE(${txt(b.grade_explanation)}, grade_explanation),
          private_notes       = COALESCE(${txt(b.private_notes)},     private_notes),
          -- M-1: these expressions read the values resolved ABOVE, so the audit
          -- diff and the write can never disagree about what this request
          -- commits. Same rules, same clamps, same enum validation, same
          -- preserve-on-omission — evaluated once instead of twice.
          dark_border_front   = ${effDarkBorderFront === undefined ? sql`dark_border_front` : sql`${effDarkBorderFront}`},
          dark_border_back    = ${effDarkBorderBack === undefined ? sql`dark_border_back` : sql`${effDarkBorderBack}`},
          dark_border         = ${
            // Legacy mirror = front OR back. PostgreSQL UPDATE evaluates RHS
            // against the OLD row, so we can't reference the new sibling
            // values directly — express the same OR via column refs and
            // payload values per-side.
            (() => {
              const fSet = effDarkBorderFront !== undefined;
              const bSet = effDarkBorderBack !== undefined;
              const frontExpr = fSet ? sql`${effDarkBorderFront}::boolean` : sql`dark_border_front`;
              const backExpr = bSet ? sql`${effDarkBorderBack}::boolean` : sql`dark_border_back`;
              if (fSet || bSet) return sql`(${frontExpr} OR ${backExpr})`;
              // Neither new flag in payload — keep legacy semantics so old
              // clients still toggle the column unchanged.
              return typeof b.dark_border === "boolean" ? sql`${b.dark_border}` : sql`dark_border`;
            })()
          },
          eye_appeal_modifier = ${
            effEyeAppealModifier === undefined ? sql`eye_appeal_modifier` : sql`${effEyeAppealModifier}`
          },
          whitening_lines     = ${
            // MVGS v2 — operator-marked whitening lines per edge. Array
            // present (incl. []) → overwrite; absent key → keep existing
            // (legacy client / non-grading payload).
            effWhiteningLines === undefined ? sql`whitening_lines` : sql`${JSON.stringify(effWhiteningLines)}::jsonb`
          },
          crease_lines        = ${
            // MVGS v2.1 — multi-crease list with start/end persistence.
            // Same array-overwrite pattern as whitening_lines.
            effCreaseLines === undefined ? sql`crease_lines` : sql`${JSON.stringify(effCreaseLines)}::jsonb`
          },
          crease_span_pct     = ${
            // Numeric 0..100 or null. Explicit null clears; undefined keeps.
            // In v2.1 this is a derived mirror of max(crease_lines.spanPct)
            // on the client (sent unconditionally in buildPayload) — server
            // accepts whatever the client computes for back-compat readers.
            effCreaseSpanPct === undefined
              ? sql`crease_span_pct`
              : effCreaseSpanPct === null
                ? sql`NULL`
                : sql`${effCreaseSpanPct}::numeric`
          },
          wrinkle_severity    = ${
            // Validated against the enum above, so payload junk never reaches
            // the DB CHECK constraint.
            effWrinkleSeverity === undefined
              ? sql`wrinkle_severity`
              : effWrinkleSeverity === null
                ? sql`NULL`
                : sql`${effWrinkleSeverity}`
          },
          tear_severity       = ${
            effTearSeverity === undefined
              ? sql`tear_severity`
              : effTearSeverity === null
                ? sql`NULL`
                : sql`${effTearSeverity}`
          },
          updated_at          = NOW()
        WHERE id = ${id}
        RETURNING grading_revision
      `);
      const rawRevision = (gradeWrite.rows[0] as { grading_revision?: unknown } | undefined)?.grading_revision;
      const reviewRevision = Number(rawRevision);
      if (!Number.isSafeInteger(reviewRevision) || reviewRevision < 1) {
        throw new Error("Saved certificate has an invalid grading revision");
      }
      savedReviewRevision = reviewRevision;

      // Audit — distinguish draft saves from post-approve live-record edits.
      // Both fire the same SQL above, but the audit trail captures the
      // semantic difference: pre-launch we want to know what % of certs
      // get edited after publication, and which fields.
      //
      // M-3: this INSERT is now INSIDE the transaction and its failure is NOT
      // caught. If it throws, the UPDATE above rolls back with it and the outer
      // handler returns 500 — the caller is never told a grading change saved
      // when no durable record of it exists.
      //
      // NO-OP: a submission that changes no mapped field writes no audit row, so
      // the debounced auto-save cannot fill the trail with rows claiming an
      // empty change set. The UPDATE itself still runs unconditionally, exactly
      // as before, so COALESCE preservation semantics and `updated_at` are
      // untouched — this changes what is AUDITED, never what is WRITTEN.
      if (Object.keys(changed).length > 0) {
        await tx.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
          VALUES (
            'certificate',
            ${canonicalCertId},
            ${wasApproved ? "cert_live_record_edit" : "draft_save"},
            ${gradingActor},
            ${JSON.stringify({
              certificateId: id,
              certId: canonicalCertId,
              fields_changed: fieldsChanged,
              changed,
              changedFields: Object.keys(changed),
              // H-2: columns this route wrote whose BEFORE value could not be
              // read (undeclared in shared/schema.ts), so no truthful diff is
              // possible. Stated rather than fabricated. Omitted when empty.
              ...(unauditableFields.length > 0 ? { unauditableFields } : {}),
              was_approved: wasApproved,
              outcome: "committed",
            })}::jsonb,
            NOW()
          )
        `);
      }
    });

    res.json({ ok: true, wasApproved, reviewRevision: savedReviewRevision, authoritativeGrade });
  } catch (error: any) {
    console.error("[grade] save error:", error.message);
    sendServerError(res, error);
  }
}

/** The canonical approval CAS token is server-issued and never coerced from a client string. */
function expectedReviewRevision(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return null;
  return raw;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // v213 pricing migration + seed service tiers, estimate_credits, admin credits, column migrations
  migrateServiceTiersV213().catch(() => {});
  // cert_counter allocator table — created ONCE here at boot (awaited so the
  // hot allocation path can assume it exists), replacing the per-scan
  // CREATE TABLE IF NOT EXISTS that raced the catalogs under concurrent scans
  // (SQLSTATE 23505 pg_type_typname_nsp_index / 42710). Idempotent + race-safe.
  await storage.ensureCertCounterTable().catch((e: any) => console.error("[cert_counter-migrate] error:", e?.message));
  // Scanner persistence is supplied by numbered migrations 0045–0047 before
  // this application release is deployed. Do not issue scanner DDL at boot:
  // a missing prerequisite must fail closed in the capture path rather than
  // silently mutating a production schema after rollout.
  recordLabelArtworkV424Audit().catch(() => {});
  seedEstimateCreditsTable().catch(() => {});
  seedAdminCredits().catch(() => {});
  addRevealWrapColumn().catch(() => {});
  createAiGradeCorrectionsTable().catch(() => {});
  createAiOverrideAuditTable().catch(() => {});
  createEstimateFreeUsesTable().catch(() => {});
  createEbayPriceCacheTable().catch(() => {});
  seedTierCapacityTable().catch(() => {});
  migratePromotionsSchema().catch((e: any) => console.error("[promotions-migrate] error:", e.message));
  migratePaymentIdempotencySchema().catch((e: any) => console.error("[payment-idempotency-migrate] error:", e.message));
  migrateGraderSchema().catch((e: any) => console.error("[grader-migrate] error:", e.message));
  migrateGraderCertSchema().catch((e: any) => console.error("[grader-cert-migrate] error:", e.message));
  migratePerOperatorSchema().catch((e: any) => console.error("[per-operator-migrate] error:", e.message));
  migrateStaffCapabilitiesSchema().catch((e: any) => console.error("[staff-caps-migrate] error:", e.message));
  migrateScanSchema().catch((e: any) => console.error("[scan-migrate] error:", e.message));
  // NOTE: the print-workflow schema (print_state, print_batches, print_events) is
  // applied ONLY by the numbered migration migrations/0022_print_workflow_lifecycle.sql
  // via the migration runner — deliberately NOT a boot-time ALTER, to avoid two
  // competing schema-mutation paths for the same objects.
  // Release any print batches stranded in 'rendering' by a crash/restart mid-render
  // (age-guarded so it never races a live render on another machine). Best-effort;
  // no-op until 0022 is applied.
  reconcileStuckPrintBatches().catch((e: any) => console.error("[print-reconcile] error:", e?.message));
  // Perf indexes run 20s after boot (CONCURRENTLY, no blocking lock) so the
  // schema ALTER migrations above have settled first — avoids the boot-time lock
  // contention that failed the earlier attempt. Fire-and-forget; non-fatal.
  setTimeout(() => {
    ensurePerfIndexes().catch((e: any) => console.error("[perf-indexes] error:", e?.message));
  }, 20_000);
  // Awaited (was fire-and-forget): auth/account routes registered below query
  // the tables these create (email_verification_tokens, magic-link tokens,
  // marketplace tables). Unawaited, a signup arriving during cold-start could
  // 500 with "relation does not exist". DDL is IF NOT EXISTS — steady-state
  // cost is a few no-op checks. Errors stay non-fatal (logged, boot continues)
  // to preserve the old crash behaviour.
  try {
    await migrateAccountSchema();
    await migrateMarketplaceSchema();
  } catch (e: any) {
    console.error("[startup-migration] error:", e.message);
  }

  // Reference number backfill — async, fire-and-forget, never blocks boot
  if (process.env.SKIP_BACKFILL !== "true") {
    import("./reference-number")
      .then(({ backfillReferenceNumbers }) =>
        backfillReferenceNumbers()
          .then(() => console.log("[startup] reference number backfill complete"))
          .catch((err) =>
            console.error("[startup] reference number backfill failed — will retry on next boot:", err.message)
          )
      )
      .catch(() => {});
  } else {
    console.log("[startup] SKIP_BACKFILL=true — skipping reference number backfill");
  }

  // ── Domain route modules ───────────────────────────────────────────────────
  registerPublicRoutes(app);
  registerAuthRoutes(app);
  registerReviewPreviewRoutes(app);
  registerCorrectionModeRoutes(app);
  registerStaffRoutes(app);
  registerPrintWorkflowRoutes(app); // Approval → Printing → Printed lifecycle (requireAdmin; staff via can_print proxy)
  // ORDERING INVARIANT — registerPartnerPublicRoutes MUST precede mountPartnerPortal.
  // partnerApiRouter (server/partner/routes.ts) still defines its OWN /auth/login,
  // /auth/password-reset/* and /invitations/accept handlers. Registering the public routes first is
  // what keeps those duplicates permanently shadowed, so the hardened public implementations — the
  // ones carrying the emergency-stop and portal_enabled gates, and the IP-keyed login limiter that
  // binds in front of the per-account one — are the only ones that ever serve. Swapping these two
  // lines silently changes which code handles partner login. Do not reorder.
  registerPartnerPublicRoutes(app); // Partner public auth/onboarding routes (login, reset, invite accept)
  mountPartnerPortal(app); // Authenticated Partner portal (session, submissions, customers, team, MFA)
  registerSubmissionRoutes(app);
  registerAdminSubmissionRoutes(app);
  registerAdminConfigRoutes(app);
  registerSuperAdminPartnerRoutes(app); // Phase 1 partner-network super-admin control shell (requireAdmin-gated)
  registerConnectorOpsRoutes(app); // G4 partner-connector operations (requireAdmin-gated, internal)
  registerPartnerManagementRoutes(app); // G5 partner management (requireAdmin-gated, internal)
  registerPartnerStationAdminRoutes(app); // server-paginated station fleet control
  registerPartnerDashboardRoutes(app); // Partner Master Dashboard (requireSuperAdmin-gated, read-only)
  registerCommandCentreRoutes(app); // Command Centre is feature-gated and Super-Admin read-only
  registerCommercialGrowthRoutes(app); // GB-04 aggregate/lead Super Admin Growth Command
  registerReviewRequestRoutes(app); // GB-05 signed review redirect + explicit suppression confirmation
  registerGrowthMcpRoutes(app); // GB-04C dedicated aggregate-only external MCP transport
  registerPartnerFlagAdminRoutes(app); // GLOBAL partner feature flags (requireSuperAdmin-gated, audited)
  registerRarityMappingRoutes(app);
  registerPokemonKnowledgeRoutes(app);
  registerCatalogueRoutes(app);
  registerProjectControlRoutes(app); // Super Admin Project Control dashboard (super-admin-gated, internal)
  registerCardIdentificationRoutes(app);
  registerTransferRoutes(app);
  registerPreGradeRoutes(app);
  registerStolenRoutes(app);
  registerPromotionRoutes(app);
  registerEmbeddingRoutes(app);

  // ── Vault Quest admin (isolated feature — server/routes/vault-quest-admin.ts) ──
  registerVaultQuestAdminRoutes(app);
  // ── Vault Quest Genesis Production Studio (Phase 4 — server/routes/vault-quest-production.ts) ──
  registerVaultQuestProductionRoutes(app);
  // ── Vault Quest Card Factory (production cards; zero-provider render/export) ──
  registerVaultQuestCardFactoryRoutes(app);

  // ── Legacy-URL + SEO 301 redirects (extracted → server/routes/redirects.ts) ──
  registerRedirectRoutes(app);

  // ── Cookie consent acknowledgment (strictly-necessary-only model) ─────────
  // Payment endpoints — generous for legit users retrying declined cards

  // Stolen-report — high-friction abuse surface. Generous enough for dealer batch-reports.

  // Transfer dispute/cancel — same pattern as existing transferV2RateLimit

  // Rate limit for owner-triggered logbook reissue — belt-and-braces behind
  // owner auth. Admin bypass via x-mv-admin-email header (for support cases).

  // Public AI pre-grade — 3/hour per IP. Each call invokes Claude Haiku
  // (paid). Tight cap is deliberate; expect VPN abuse to bypass over
  // time and add captcha / signed-token gating if it materialises.

  // TIFF preview transcoding (/api/pre-grade/preview) — sharp resize +
  // JPEG encode only, no AI cost. Higher cap so users uploading scanner
  // TIFFs for front + back can preview both sides without spending
  // grading quota. Still capped to deter abuse of the public endpoint.

  // Multer config for /api/pre-grade. In-memory storage (per spec — no
  // data stored on disk or R2), 20 MB per file, accepts JPEG/PNG/TIFF.

  // Rate limit for unauthenticated public lookup endpoints — protects against
  // enumeration scrapers (cert IDs are sequential MV1, MV2, ...).
  // Applied to /api/cert/:id, /api/cert/:id/population, /api/logbook/:certId,
  // and (via parallel definition in server/showroom.ts) the showroom GETs.

  // ── Public generic readiness probe ────────────────────────────────────────
  // Detailed database state, uptime and provider errors are sensitive
  // operational telemetry. Super Admin Growth reads a separate, sanitised
  // server-side check; this public route reveals only a bounded liveness state.
  app.get("/api/health", publicHealthRateLimit, async (_req, res) => {
    try {
      const result = await db.execute(sql`SELECT 1 AS ok`);
      const dbOk = result.rows.length > 0;
      if (!dbOk) throw new Error("DB returned empty result for SELECT 1");
      res.set("Cache-Control", "no-store").json({ status: "ok" });
    } catch {
      console.error("[health] readiness check failed");
      res.set("Cache-Control", "no-store").status(503).json({ status: "unavailable" });
    }
  });

  app.post("/api/cookies/acknowledge", cookieAckRateLimit, async (req, res) => {
    try {
      const userAgent = ((req.headers["user-agent"] as string) || "").slice(0, 500);
      const ipRaw = ((req.headers["x-forwarded-for"] as string) || req.ip || "").split(",")[0].trim();
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

  app.get("/api/cards/autofill", async (req, res) => {
    try {
      const setId = ((req.query.setId as string) || "").trim();
      const number = ((req.query.number as string) || "").trim();
      const language = ((req.query.language as string) || "English").trim();
      const allowFallbackLanguage =
        req.query.allowFallbackLanguage === "1" || req.query.allowFallbackLanguage === "true";

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
      const game = ((req.query.game as string) || "").trim() || undefined;
      const sets = await storage.getCardSets(game);
      res.json(sets);
    } catch (error: any) {
      console.error("Card sets error:", error.message);
      res.status(500).json({ error: "Failed to get card sets" });
    }
  });

  // findCertByIdFlex is exported at module level (below registerRoutes)

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
        grade: isNonNum
          ? gradeLabelFull(gradeType, dbCert.gradeOverall || "0")
          : mvgsTierName(gradeNumeric as number).toUpperCase(),
        gradeNumeric,
        // Pristine 10P overlay — from the MVGS gate (certIsPristine, the same
        // authority as the slab, logbook, and reports), NOT the stored
        // label_type. The `grade` tier text above stays the base tier
        // ("GEM MINT" for a 10); the client adds the Pristine overlay when true.
        isBlackLabel: !isNonNum && (await certIsPristine(dbCert)),
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

  // ── Slab showcase — homepage 3D hero data ─────────────────────────────────
  // Public, no auth. Top graded certs with real label PNGs (generated +
  // cached in R2 by server/slab-showcase.ts). Never 500s a page load.
  app.get("/api/public/slab-showcase", showcaseRateLimit, async (_req, res) => {
    try {
      const { getSlabShowcaseItems } = await import("./slab-showcase");
      const items = await getSlabShowcaseItems(8);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({ items, generatedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error("[slab-showcase] endpoint error:", err?.message || err);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ items: [], generatedAt: new Date().toISOString() });
    }
  });

  // Most recently graded certs (newest first) — homepage hero source.
  app.get("/api/public/recent-graded", showcaseRateLimit, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(20, parseInt(String(req.query.limit ?? "8"), 10) || 8));
      const { getRecentGradedItems } = await import("./slab-showcase");
      const items = await getRecentGradedItems(limit);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ items });
    } catch (err: any) {
      console.error("[recent-graded] endpoint error:", err?.message || err);
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json({ items: [] });
    }
  });

  // Grade distribution for the public Population Registry chart.
  app.get("/api/public/grade-distribution", showcaseRateLimit, async (_req, res) => {
    try {
      const { getGradeDistribution } = await import("./slab-showcase");
      const data = await getGradeDistribution();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(data);
    } catch (err: any) {
      console.error("[grade-distribution] endpoint error:", err?.message || err);
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json({ distribution: [], total: 0 });
    }
  });

  // Per-card population lookup (search-gated). Returns grade distribution +
  // total for ONE card (+ optional set) only — never a global aggregate.
  app.get("/api/public/population", showcaseRateLimit, async (req, res) => {
    try {
      const card = String(req.query.card ?? "").slice(0, 120);
      const set = String(req.query.set ?? "").slice(0, 120);
      if (!card.trim()) {
        res.json({ card: "", set: set.trim() || null, distribution: [], total: 0 });
        return;
      }
      const { getCardPopulation } = await import("./slab-showcase");
      const data = await getCardPopulation(card, set);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(data);
    } catch (err: any) {
      console.error("[population] endpoint error:", err?.message || err);
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json({ card: "", set: null, distribution: [], total: 0 });
    }
  });

  // ── Slab showcase image proxy ──────────────────────────────────────────────
  // The browser canvas can't consume R2 signed URLs cross-origin (no CORS
  // headers on the bucket), so the showcase loads images through this
  // same-origin proxy. R2 access happens server-side with the app's creds.
  app.get("/api/public/slab-image/:certNumber/:kind", lookupRateLimit, async (req, res) => {
    try {
      const certNumber = normalizeCertId(String(req.params.certNumber));
      const kind = String(req.params.kind);
      if (!/^MV\d+$/.test(certNumber)) return res.status(404).end();

      const cert = (await storage.getCertificateByCertId(certNumber)) as any;
      if (!cert || cert.status !== "active" || cert.gradeOverall == null) return res.status(404).end();

      let key: string | null = null;
      if (kind === "front-label") {
        key = `public/slab-showcase/${certNumber}/front_label.png`;
      } else if (kind === "back-label") {
        key = `public/slab-showcase/${certNumber}/back_label.png`;
      } else if (kind === "scan") {
        // Raw SQL: grading_front_display predates this branch's schema.ts
        // (added on perf/grading-speed) but exists in the staging DB — a
        // drizzle select() won't return it until the branches merge.
        const scanRow = (
          await db.execute(
            sql`SELECT grading_front_display, grading_front_cropped, front_image_path FROM certificates WHERE id = ${cert.id}`
          )
        ).rows[0] as any;
        key = scanRow?.grading_front_display || scanRow?.grading_front_cropped || scanRow?.front_image_path || null;
      } else {
        return res.status(404).end();
      }
      if (!key) return res.status(404).end();

      try {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        const { getR2Client } = await import("./r2");
        const s3 = getR2Client();
        const result = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
        if (!result.Body) return res.status(502).end();
        const ext = key.split(".").pop()?.toLowerCase() || "jpg";
        res.setHeader("Content-Type", ext === "png" ? "image/png" : "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (result.ContentLength != null) res.setHeader("Content-Length", String(result.ContentLength));
        (result.Body as NodeJS.ReadableStream).pipe(res);
      } catch (r2Err: any) {
        // Missing object (e.g. label not generated yet) → 404; anything else → 502
        const code = r2Err?.name === "NoSuchKey" || r2Err?.$metadata?.httpStatusCode === 404 ? 404 : 502;
        console.error(`[slab-image] R2 fetch failed for ${certNumber}/${kind} (${key}): ${r2Err?.message || r2Err}`);
        res.status(code).end();
      }
    } catch (err: any) {
      console.error("[slab-image] error:", err?.message || err);
      res.status(502).end();
    }
  });

  // ── Instagram share images + caption ───────────────────────────────────────
  // Public. Feed (1080×1080) and story (1080×1920) renders of a cert, cached
  // permanently in R2 (invalidated on re-grade in the approve endpoint).
  // Same active+graded gate as the slab-image proxy. No PII.

  /** Shared loader for the share endpoints — cert + scan key + render data. */
  async function loadShareCert(rawCertNumber: string): Promise<{
    cert: import("./share-image").ShareCertData;
    scanKey: string | null;
    cardGame: string | null;
  } | null> {
    const certNumber = normalizeCertId(String(rawCertNumber));
    if (!/^MV\d+$/.test(certNumber)) return null;
    const row = (await storage.getCertificateByCertId(certNumber)) as any;
    if (!row || row.status !== "active" || row.gradeOverall == null) return null;
    const grade = parseFloat(String(row.gradeOverall));
    if (!Number.isFinite(grade)) return null;
    const { mvgsTierName } = await import("@shared/mvgs-scoring");
    return {
      cert: {
        certNumber,
        grade,
        gradeLabel: mvgsTierName(grade),
        gradeStrengthScore: row.gradeStrengthScore != null ? Number(row.gradeStrengthScore) : null,
        cardName: String(row.cardName || "Graded Card"),
        setName: row.setName ? String(row.setName) : null,
        setNumber: row.cardNumber ? String(row.cardNumber) : null,
      },
      scanKey: row.gradingFrontDisplay || row.gradingFrontCropped || row.frontImagePath || null,
      cardGame: row.cardGame ? String(row.cardGame).toLowerCase() : null,
    };
  }

  // Variant-aware share image handler. `variant` undefined → default (vault-gold).
  const shareImageHandler = (format: "feed" | "story") => async (req: any, res: any) => {
    try {
      const { isValidVariant, DEFAULT_VARIANT } = await import("./share-image");
      const rawVariant = req.params.variant as string | undefined;
      if (rawVariant && !isValidVariant(rawVariant)) {
        return res.status(400).json({ error: `Unknown share variant "${rawVariant}"` });
      }
      const variant = (rawVariant ?? DEFAULT_VARIANT) as any;

      const loaded = await loadShareCert(req.params.certNumber);
      if (!loaded) return res.status(404).json({ error: "Certificate not found" });
      if (!loaded.scanKey) return res.status(404).json({ error: "Certificate has no image" });

      const { getOrCreateShareImage } = await import("./share-image");
      const image = await getOrCreateShareImage(loaded.cert, loaded.scanKey, format, variant);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Content-Length", String(image.length));
      res.end(image);
    } catch (err: any) {
      console.error(`[share-image] ${format} failed for ${req.params.certNumber}: ${err?.message || err}`);
      res.status(500).json({ error: "Share image generation failed" });
    }
  };

  // No-variant (backwards compat) → default variant. These are 2-segment
  // paths; the 3-segment variant routes below can't shadow them (Express
  // distinguishes by segment count).
  app.get("/api/public/share/:certNumber/feed", lookupRateLimit, shareImageHandler("feed"));
  app.get("/api/public/share/:certNumber/story", lookupRateLimit, shareImageHandler("story"));

  // Variant routes — the handler validates :variant against SHARE_VARIANTS and
  // returns 400 for unknown ids. (Inline-regex route params, e.g.
  // ":variant(a|b)", are unsupported by this path-to-regexp version and crash
  // route registration — so validation lives in the handler instead.)
  app.get("/api/public/share/:certNumber/:variant/feed", lookupRateLimit, shareImageHandler("feed"));
  app.get("/api/public/share/:certNumber/:variant/story", lookupRateLimit, shareImageHandler("story"));

  // Variant catalogue
  app.get("/api/public/share-variants", async (_req, res) => {
    const { SHARE_VARIANTS: variants, VARIANT_CATEGORIES } = await import("./share-image");
    // Short cache: the catalogue changes between deploys, and a long TTL leaves
    // browsers building thumbnails from removed variant ids (→ 400s) after a
    // variant set change.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        category: v.category,
        preview: `/api/public/share-bg/${v.id}`,
      })),
      categories: VARIANT_CATEGORIES,
    });
  });

  // Raw background image for a variant (shared across all certs)
  app.get("/api/public/share-bg/:variant", lookupRateLimit, async (req, res) => {
    try {
      const { isValidVariant, getShareBackground } = await import("./share-image");
      const variant = String(req.params.variant);
      if (!isValidVariant(variant)) return res.status(400).json({ error: `Unknown share variant "${variant}"` });
      const buf = await getShareBackground(variant);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=604800"); // 7 days
      res.setHeader("Content-Length", String(buf.length));
      res.end(buf);
    } catch (err: any) {
      console.error(`[share-bg] failed for ${req.params.variant}: ${err?.message || err}`);
      res.status(500).json({ error: "Background generation failed" });
    }
  });

  app.get("/api/public/share/:certNumber/caption", async (req, res) => {
    try {
      const loaded = await loadShareCert(String(req.params.certNumber));
      if (!loaded) return res.status(404).json({ error: "Certificate not found" });
      const { cert, cardGame } = loaded;

      const caption =
        `Just got my ${cert.cardName} graded! 🏆\n\n` +
        `Grade: ${cert.grade} ${cert.gradeLabel}\n` +
        `Certified by @mintvaultuk 🔐\n\n` +
        `Verify at mintvaultuk.com/cert/${cert.certNumber}`;

      let gameTag = "#PokemonTCG";
      if (cardGame === "mtg") gameTag = "#MagicTheGathering";
      else if (cardGame === "yugioh") gameTag = "#YuGiOh";
      const hashtags = `#MintVault #GradedCards #CardGrading ${gameTag} #TCG #TradingCards #CardCollector #Pokemon`;

      res.json({ caption, hashtags });
    } catch (err: any) {
      console.error("[share-caption] error:", err?.message || err);
      res.status(500).json({ error: "Caption generation failed" });
    }
  });

  // ── Admin Social Studio (zero-credit, download-first) ─────────────────────
  // These routes intentionally reuse the share renderer in static-only mode.
  // Missing backgrounds fall back locally instead of calling Segmind.

  function socialStudioCardFromLoaded(
    loaded: NonNullable<Awaited<ReturnType<typeof loadShareCert>>>,
    overrides: Record<string, any> = {}
  ) {
    const card = {
      certNumber: loaded.cert.certNumber,
      cardName: loaded.cert.cardName,
      setName: loaded.cert.setName,
      setNumber: loaded.cert.setNumber ?? null,
      cardGame: loaded.cardGame,
      grade: loaded.cert.grade,
      gradeLabel: loaded.cert.gradeLabel,
      hasImage: !!loaded.scanKey,
      ...overrides,
    };
    return {
      ...card,
      autoBackground: resolveAutoBackground(card),
      caption: buildSocialStudioCaption(card),
      hashtags: buildSocialStudioHashtags(card),
    };
  }

  const socialStudioRenderRateLimit = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
  });
  const socialStudioCertificateBodySchema = z.object({
    certNumber: z.string().trim().min(1).max(80),
  });
  const socialStudioRenderBodySchema = socialStudioCertificateBodySchema.extend({
    format: z.string().refine(isSocialStudioFormat),
    background: z.string().refine(isSocialStudioBackground),
  });

  app.get("/api/admin/social-studio/backgrounds", requireAdmin, (_req, res) => {
    res.json({
      backgrounds: SOCIAL_STUDIO_BACKGROUNDS.map((bg) => ({
        ...bg,
        preview: bg.id === "auto" ? null : `/api/admin/social-studio/backgrounds/${bg.id}/preview`,
        staticOnly: true,
      })),
      staticOnly: true,
      providerGeneration: false,
    });
  });

  app.get("/api/admin/social-studio/backgrounds/:background/preview", requireAdmin, async (req, res) => {
    try {
      const background = String(req.params.background);
      if (!isSocialStudioBackground(background) || background === "auto") {
        return res.status(400).json({ error: "Unknown background" });
      }
      const variant = resolveBackgroundVariant(background, { certNumber: "MV0" });
      const { getShareBackground } = await import("./share-image");
      const buf = await getShareBackground(variant as any, { allowProviderGeneration: false });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Length", String(buf.length));
      res.end(buf);
    } catch (err: any) {
      console.error("[social-studio] background preview failed:", err?.message || err);
      res.status(500).json({ error: "Background preview failed" });
    }
  });

  app.get("/api/admin/social-studio/certificates", requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 80);
      const like = `%${escapeSocialStudioSearchTerm(q)}%`;
      const rows = (
        await db.execute(sql`
          SELECT
            c.certificate_number       AS cert_number,
            c.grade::text              AS grade,
            c.card_name                AS card_name,
            c.set_name                 AS set_name,
            c.card_number              AS card_number,
            c.card_game                AS card_game,
            c.marketing_featured       AS featured,
            c.marketing_pinned         AS pinned,
            c.marketing_blacklisted    AS blacklisted,
            c.grading_front_display    AS grading_front_display,
            c.grading_front_cropped    AS grading_front_cropped,
            c.front_image_path         AS front_image_path,
            s.id                       AS submission_id,
            s.marketing_feature_consent AS marketing_consent
          FROM certificates c
          LEFT JOIN submission_items si ON si.id = c.submission_item_id
          LEFT JOIN submissions s ON s.id = si.submission_id
          WHERE c.deleted_at IS NULL
            AND c.grade_approved_at IS NOT NULL
            AND COALESCE(c.marketing_blacklisted, false) = false
            AND (
              c.grading_front_display IS NOT NULL
              OR c.grading_front_cropped IS NOT NULL
              OR c.front_image_path IS NOT NULL
            )
            AND (
              ${q} = ''
              OR c.certificate_number ILIKE ${like} ESCAPE '\\'
              OR c.card_name ILIKE ${like} ESCAPE '\\'
              OR c.set_name ILIKE ${like} ESCAPE '\\'
              OR CAST(s.id AS TEXT) ILIKE ${like} ESCAPE '\\'
            )
          ORDER BY c.marketing_pinned DESC,
                   c.marketing_featured DESC,
                   c.grade_approved_at DESC
          LIMIT 80
        `)
      ).rows as Array<any>;

      const cards = rows.map((r) => {
        const card = {
          certNumber: String(r.cert_number),
          cardName: r.card_name ? String(r.card_name) : "Graded Card",
          setName: r.set_name ? String(r.set_name) : null,
          setNumber: r.card_number ? String(r.card_number) : null,
          cardGame: r.card_game ? String(r.card_game).toLowerCase() : null,
          grade: r.grade != null ? Number(r.grade) : null,
          featured: r.featured === true,
          pinned: r.pinned === true,
          marketingConsent: r.marketing_consent === true,
          submissionReference: r.submission_id != null ? `Submission ${r.submission_id}` : null,
          hasImage: !!(r.grading_front_display || r.grading_front_cropped || r.front_image_path),
        };
        return {
          ...card,
          autoBackground: resolveAutoBackground(card),
          hashtags: buildSocialStudioHashtags(card),
        };
      });
      res.json({ cards, q, staticOnly: true });
    } catch (err: any) {
      console.error("[social-studio] certificate search failed:", err?.message || err);
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/social-studio/certificate", requireAdmin, socialStudioRenderRateLimit, async (req, res) => {
    try {
      const parsed = socialStudioCertificateBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid certificate request" });
      const loaded = await loadShareCert(parsed.data.certNumber);
      if (!loaded || !loaded.scanKey) return res.status(404).json({ error: "Certificate not found" });
      res.json({ card: socialStudioCardFromLoaded(loaded), staticOnly: true });
    } catch (err: any) {
      console.error("[social-studio] certificate detail failed:", err?.message || err);
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/social-studio/caption", requireAdmin, socialStudioRenderRateLimit, async (req, res) => {
    try {
      const parsed = socialStudioCertificateBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid caption request" });
      const loaded = await loadShareCert(parsed.data.certNumber);
      if (!loaded || !loaded.scanKey) return res.status(404).json({ error: "Certificate not found" });
      const card = socialStudioCardFromLoaded(loaded);
      res.json({ caption: card.caption, hashtags: card.hashtags, staticOnly: true });
    } catch (err: any) {
      console.error("[social-studio] caption failed:", err?.message || err);
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/social-studio/render", requireAdmin, socialStudioRenderRateLimit, async (req, res) => {
    try {
      const parsed = socialStudioRenderBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid render request" });
      const { certNumber, format, background } = parsed.data;

      const loaded = await loadShareCert(certNumber);
      if (!loaded || !loaded.scanKey) return res.status(404).json({ error: "Certificate not found" });

      const variant = resolveBackgroundVariant(background as SocialStudioBackgroundId, {
        certNumber: loaded.cert.certNumber,
        cardName: loaded.cert.cardName,
        setName: loaded.cert.setName,
        cardGame: loaded.cardGame,
        grade: loaded.cert.grade,
      });
      const shareFormat = format === "feed" || format === "weekly-highlights" ? "feed" : "story";
      const { getOrCreateShareImage } = await import("./share-image");
      const image = await getOrCreateShareImage(loaded.cert, loaded.scanKey, shareFormat, variant as any, {
        allowProviderGeneration: false,
      });
      const dims = SOCIAL_STUDIO_FORMAT_DIMENSIONS[format];
      const filename = buildSocialStudioDownloadFilename({ certNumber: loaded.cert.certNumber }, format);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("X-MintVault-Static-Only", "true");
      res.setHeader("X-MintVault-Provider-Generation", "false");
      res.setHeader("X-MintVault-Output-Width", String(dims.width));
      res.setHeader("X-MintVault-Output-Height", String(dims.height));
      res.setHeader("Content-Length", String(image.length));
      res.end(image);
    } catch (err: any) {
      console.error("[social-studio] render failed:", err?.message || err);
      res.status(500).json({ error: "Social Studio render failed" });
    }
  });

  // ── Community wall ──────────────────────────────────────────────────────────

  app.get("/api/public/community", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const { listApprovedPosts } = await import("./community");
      const { posts, total } = await listApprovedPosts(page, limit);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ posts, total });
    } catch (err: any) {
      console.error("[community] list error:", err?.message || err);
      res.json({ posts: [], total: 0 });
    }
  });

  app.get("/api/admin/community", requireAdmin, async (req, res) => {
    try {
      const filter = String(req.query.filter ?? "all");
      const { listPostsAdmin } = await import("./community");
      res.json({ posts: await listPostsAdmin(filter) });
    } catch (err: any) {
      console.error("[community] admin list error:", err?.message || err);
      res.status(500).json({ error: "Failed to list posts" });
    }
  });

  app.post("/api/admin/community", requireAdmin, upload.single("imageFile"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "imageFile is required" });
      const uploadErr = await rejectInvalidUploads([req.file]);
      if (uploadErr) return res.status(400).json({ error: uploadErr });
      const gradeRaw = req.body.grade != null && req.body.grade !== "" ? parseFloat(String(req.body.grade)) : null;
      const { createPostManual } = await import("./community");
      const post = await createPostManual(
        {
          instagramHandle: req.body.instagramHandle?.trim() || null,
          certNumber: req.body.certNumber ? normalizeCertId(String(req.body.certNumber)) : null,
          cardName: req.body.cardName?.trim() || null,
          grade: gradeRaw != null && Number.isFinite(gradeRaw) ? gradeRaw : null,
          instagramPostUrl: req.body.instagramPostUrl?.trim() || null,
        },
        req.file.buffer,
        req.file.mimetype || "image/jpeg",
        req.session.adminEmail || "admin"
      );
      res.json({ post });
    } catch (err: any) {
      console.error("[community] create error:", err?.message || err);
      res.status(500).json({ error: "Failed to create post" });
    }
  });

  app.patch("/api/admin/community/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid post id" });
      const patch: { status?: "approved" | "rejected"; featured?: boolean } = {};
      if (req.body.status === "approved" || req.body.status === "rejected") patch.status = req.body.status;
      if (typeof req.body.featured === "boolean") patch.featured = req.body.featured;
      if (patch.status === undefined && patch.featured === undefined) {
        return res.status(400).json({ error: "Nothing to update (status or featured required)" });
      }
      const { updatePostStatus } = await import("./community");
      const result = await updatePostStatus(id, patch, req.session.adminEmail || "admin");
      if (!result.ok) return res.status(404).json({ error: result.error });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[community] patch error:", err?.message || err);
      res.status(500).json({ error: "Failed to update post" });
    }
  });

  // Pre-warm all 20 share backgrounds (p-limit concurrency 3 inside).
  app.post("/api/admin/share/prewarm", requireAdmin, async (_req, res) => {
    try {
      const { preGenerateAllBackgrounds } = await import("./share-image");
      const result = await preGenerateAllBackgrounds();
      res.json(result);
    } catch (err: any) {
      console.error("[share-prewarm] error:", err?.message || err);
      res.status(500).json({ error: "Prewarm failed" });
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

  app.get("/api/certs/search", lookupRateLimit, async (req, res) => {
    const q = ((req.query.q as string) || "").trim();
    if (!q) {
      return res.json([]);
    }

    let dbResults = await storage.searchCertificates(q);
    if (dbResults.length === 0) {
      const num = certNumberFromId(q);
      if (num !== null) {
        const altNew = await storage.searchCertificates(`MV${num}`);
        const altOld = await storage.searchCertificates(`MV-${num.padStart(10, "0")}`);
        const seen = new Set<number>();
        dbResults = [...altNew, ...altOld].filter((c) => {
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
        grade: isNonNum ? gradeLabelFull(gradeType, c.gradeOverall || "0") : mvgsTierName(grade).toUpperCase(),
        gradeNumeric: grade,
        gradedDate: c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
        status: c.status,
      };
    });

    res.json(results);
  });

  // ── AI-ASSISTED GRADING (Build 3 placeholder — superseded by Build 5) ───────

  // Rate limit — 1 AI call per 5 seconds per IP

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
      async function getImageBase64(
        key: string | null | undefined
      ): Promise<{ data: string; mediaType: string } | null> {
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
        contentParts.push({
          type: "image",
          source: { type: "base64", media_type: frontImg.mediaType, data: frontImg.data },
        });
      }
      if (backImg) {
        contentParts.push({
          type: "image",
          source: { type: "base64", media_type: backImg.mediaType, data: backImg.data },
        });
      }
      contentParts.push({ type: "text", text: "Legacy endpoint disabled." });

      let anthropicRes;
      try {
        anthropicRes = await anthropicFetch(
          {
            model: "claude-haiku-4-5-20251001",
            max_tokens: 4096,
            messages: [{ role: "user", content: contentParts }],
          },
          { apiKey, timeoutMs: 30_000 }
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
        const cleaned = rawText
          .replace(/^```[a-z]*\n?/i, "")
          .replace(/\n?```$/i, "")
          .trim();
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
          centering_back_lr  = ${analysis.centering?.back_left_right ?? null},
          centering_back_tb  = ${analysis.centering?.back_top_bottom ?? null},
          defects            = ${JSON.stringify(analysis.defects ?? [])}::jsonb,
          ai_defects         = ${JSON.stringify(aiDefectsNorm)}::jsonb,
          updated_at         = NOW()
        WHERE id = ${id}
      `);

      res.json({ analysis });
    } catch (error: any) {
      console.error("AI analyze error:", error.message, error.stack);
      res.status(500).json({ error: "Analysis failed" });
    }
  });

  // Legacy CertificateForm approval had no revision-bound preview.  Keep an
  // explicit terminal response for stale clients; canonical review is the only
  // final-approval authority.
  app.put("/api/admin/certificates/:id/approve-grade", requireAdmin, async (_req, res) => {
    return res.status(410).json({
      error: "Legacy approval is retired. Open the canonical grading workstation and prepare Review before approving.",
      code: "CANONICAL_REVIEW_REQUIRED",
    });
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
      // Pristine 10P from the MVGS gate (same authority as the slab + v908 surfaces),
      // never the stored label_type flag.
      const isBlack = !isNonNum && (await certIsPristine(c));

      // Signed image URLs — grading variants
      async function signedOrNull(key: string | null | undefined): Promise<string | null> {
        if (!key) return null;
        try {
          return await getR2SignedUrl(key, 3600);
        } catch (e) {
          console.error("R2 sign failed:", key, e);
          return null;
        }
      }

      const [frontUrl, backUrl, fGrey, fHC, fEdge, fInv, bGrey, bHC, bEdge, bInv, angledUrl, closeupUrl] =
        await Promise.all([
          signedOrNull(c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath),
          signedOrNull(c.gradingBackCropped || c.gradingBackOriginal || c.backImagePath),
          signedOrNull(c.gradingFrontGreyscale),
          signedOrNull(c.gradingFrontHighcontrast),
          signedOrNull(c.gradingFrontEdgeenhanced),
          signedOrNull(c.gradingFrontInverted),
          signedOrNull(c.gradingBackGreyscale),
          signedOrNull(c.gradingBackHighcontrast),
          signedOrNull(c.gradingBackEdgeenhanced),
          signedOrNull(c.gradingBackInverted),
          signedOrNull(c.gradingAngledCropped || c.gradingAngledOriginal),
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
        const grades: number[] = (popRows.rows || [])
          .map((r: any) => parseFloat(r.grade))
          .filter((g: number) => !isNaN(g));
        const totalGraded = grades.length;
        const sameGradeCount = grades.filter((g) => g === gradeNum).length;
        const higherGradeCount = grades.filter((g) => g > gradeNum).length;
        const percentile = totalGraded > 0 ? Math.round(((totalGraded - higherGradeCount) / totalGraded) * 100) : 0;
        population = { totalGraded, sameGradeCount, higherGradeCount, percentile };
      } catch {
        /* non-critical */
      }

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

      // MVGS v2 — operator-drawn line measurements alongside the pin defects.
      // Surfaced as display-only segments for the report card overlay. Engine
      // never sees `color` (stripped at the input-builder boundary).
      const whiteningLines = (Array.isArray((c as any).whiteningLines) ? (c as any).whiteningLines : [])
        .filter((w: any) => w && w.start && w.end)
        .map((w: any) => ({
          side: w.side === "back" ? "back" : "front",
          edge: w.edge,
          coveragePct: typeof w.coveragePct === "number" ? w.coveragePct : null,
          start: w.start,
          end: w.end,
          color: typeof w.color === "string" ? w.color : null,
        }));
      const creaseLines = (Array.isArray((c as any).creaseLines) ? (c as any).creaseLines : [])
        .filter((cr: any) => cr && cr.start && cr.end)
        .map((cr: any) => ({
          side: cr.side === "back" ? "back" : "front",
          spanPct: typeof cr.spanPct === "number" ? cr.spanPct : null,
          start: cr.start,
          end: cr.end,
          color: typeof cr.color === "string" ? cr.color : null,
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
          overall: isNonNum ? (gradeType === "authentic_altered" || gradeType === "AA" ? "AA" : "NO") : gradeNum,
          label: isNonNum ? gradeLabelFull(gradeType, "0") : mvgsTierName(gradeNum).toUpperCase(),
          labelType,
          isBlackLabel: isBlack,
          explanation: stripEmailsR(c.gradeExplanation || ai.grade_explanation || ""),
          // v417 — drop approver name from public report; date is fine.
          approvedBy: null,
          approvedAt: c.gradeApprovedAt || null,
        },
        subgrades: {
          centering: c.centeringScore != null ? parseFloat(c.centeringScore) : null,
          corners: c.cornersScore != null ? parseFloat(c.cornersScore) : null,
          edges: c.edgesScore != null ? parseFloat(c.edgesScore) : null,
          surface: c.surfaceScore != null ? parseFloat(c.surfaceScore) : null,
        },
        centering: {
          frontLR: c.centeringFrontLr || null,
          frontTB: c.centeringFrontTb || null,
          backLR: c.centeringBackLr || null,
          backTB: c.centeringBackTb || null,
        },
        corners: c.cornerValues || null,
        edges: c.edgeValues || null,
        surface: c.surfaceValues
          ? { front: (c.surfaceValues as any).front, back: (c.surfaceValues as any).back }
          : null,
        defects,
        whiteningLines,
        creaseLines,
        authentication: {
          status: c.authStatus || "genuine",
          // v417 — auth notes are free-text; sanitise on public surface.
          notes: stripEmailsR(c.authNotes || ai.authentication_notes || "") || null,
        },
        images: {
          front: frontUrl,
          back: backUrl,
          frontGreyscale: fGrey,
          frontHighcontrast: fHC,
          frontEdge: fEdge,
          frontInverted: fInv,
          backGreyscale: bGrey,
          backHighcontrast: bHC,
          backEdge: bEdge,
          backInverted: bInv,
          angled: angledUrl,
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
      sendServerError(res, error);
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
      // Pristine 10P from the MVGS gate (same authority as the slab + v908 surfaces),
      // never the stored label_type flag.
      const isBlack = !isNonNum && (await certIsPristine(c));
      const gLabel = isNonNum
        ? gradeType === "authentic_altered" || gradeType === "AA"
          ? "AUTHENTIC ALTERED"
          : "NOT ORIGINAL"
        : mvgsTierName(gradeNum).toUpperCase();

      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ size: "A4", margin: 50, autoFirstPage: true });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault-DGR-${certId}.pdf"`);
      doc.pipe(res);

      const GOLD = "#D4AF37";
      const DARK = isBlack ? "#FFFFFF" : "#1A1A1A";
      const BG = isBlack ? "#0A0A0A" : "#FFFFFF";

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
      doc
        .fontSize(18)
        .fillColor(DARK)
        .text(c.cardName || "—", { align: "left" });
      doc
        .fontSize(10)
        .fillColor(isBlack ? "#AAAAAA" : "#666666")
        .text(`${c.setName || ""}${c.year ? ` · ${c.year}` : ""}${c.cardNumber ? ` · #${c.cardNumber}` : ""}`)
        .text(`${c.cardGame || ""} · ${c.language || "English"}`);
      if (c.rarity) doc.text(`Rarity: ${rarityDisplayLabel(c.rarity, c.rarityOther) || c.rarity}`);
      doc.moveDown(0.3);
      const gradedDateFmt = c.createdAt
        ? new Date(c.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
        : "—";
      doc
        .fontSize(9)
        .fillColor(isBlack ? "#888888" : "#888888")
        // v417 — public DGR PDF: brand only, no individual grader name.
        .text(`Graded: ${gradedDateFmt}  ·  By: MintVault UK`);
      doc.moveDown(0.8);

      // Grade hero
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).lineWidth(0.5).stroke();
      doc.moveDown(0.5);
      if (isBlack) doc.fontSize(9).fillColor(GOLD).text("★ BLACK LABEL ★", { align: "center" });
      doc
        .fontSize(48)
        .fillColor(GOLD)
        .text(isNonNum ? (gradeType === "authentic_altered" || gradeType === "AA" ? "AA" : "NO") : String(gradeNum), {
          align: "center",
        });
      doc.fontSize(14).fillColor(DARK).text(gLabel, { align: "center" });
      doc.moveDown(0.5);

      if (c.gradeExplanation) {
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(GOLD).lineWidth(0.5).stroke();
        doc.moveDown(0.5);
        doc
          .fontSize(9)
          .fillColor(isBlack ? "#AAAAAA" : "#444444")
          .text(`"${c.gradeExplanation}"`, { align: "left" });
        doc.moveDown(0.5);
      }

      // Images — fetch from R2 and embed
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      const backKey = c.gradingBackCropped || c.gradingBackOriginal || c.backImagePath;

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
        } catch {
          return null;
        }
      }

      const [frontBuf, backBuf] = await Promise.all([fetchBuffer(frontKey), fetchBuffer(backKey)]);

      if (frontBuf || backBuf) {
        doc.moveDown(0.5);
        const imgW = 210,
          imgH = 294;
        const pageW = doc.page.width - 100;
        const startX = 50;

        if (frontBuf && backBuf) {
          try {
            doc.image(frontBuf, startX, doc.y, { width: imgW, height: imgH, fit: [imgW, imgH] });
          } catch {
            /* skip */
          }
          try {
            doc.image(backBuf, startX + imgW + 20, doc.y - (doc.y > 50 ? 0 : 0), {
              width: imgW,
              height: imgH,
              fit: [imgW, imgH],
            });
          } catch {
            /* skip */
          }
          doc.y += imgH + 10;
        } else if (frontBuf) {
          try {
            doc.image(frontBuf, startX + (pageW - imgW) / 2, doc.y, { width: imgW, height: imgH, fit: [imgW, imgH] });
          } catch {
            /* skip */
          }
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
        { label: "Corners", val: c.cornersScore },
        { label: "Edges", val: c.edgesScore },
        { label: "Surface", val: c.surfaceScore },
      ];
      const boxW = 110,
        boxH = 55,
        gap = 10;
      const totalW = subs.length * boxW + (subs.length - 1) * gap;
      let bx = (doc.page.width - totalW) / 2;
      const by = doc.y;
      for (const s of subs) {
        const val = s.val != null ? parseFloat(s.val) : null;
        const bColor =
          val === null ? "#555555" : val >= 9.5 ? "#D4AF37" : val >= 8 ? "#16A34A" : val >= 6 ? "#CA8A04" : "#DC2626";
        doc.rect(bx, by, boxW, boxH).fillColor(bColor).fill();
        doc
          .fontSize(7)
          .fillColor("#FFFFFF")
          .text(s.label.toUpperCase(), bx, by + 6, { width: boxW, align: "center" });
        doc
          .fontSize(22)
          .fillColor("#FFFFFF")
          .text(val !== null ? String(val) : "—", bx, by + 16, { width: boxW, align: "center" });
        bx += boxW + gap;
      }
      doc.y = by + boxH + 15;
      doc.moveDown(0.5);

      // Centering ratios
      if (c.centeringFrontLr || c.centeringFrontTb) {
        doc.fontSize(9).fillColor(GOLD).text("Centering Measurements");
        doc
          .fontSize(8)
          .fillColor(isBlack ? "#AAAAAA" : "#444444")
          .text(
            `Front L/R: ${c.centeringFrontLr || "—"}   Front T/B: ${c.centeringFrontTb || "—"}   Back L/R: ${c.centeringBackLr || "—"}   Back T/B: ${c.centeringBackTb || "—"}`
          );
        doc.moveDown(0.5);
      }

      // Defects
      const defects = c.defects || [];
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor(GOLD).text("IDENTIFIED DEFECTS");
      doc.moveDown(0.3);
      if (defects.length === 0) {
        doc
          .fontSize(8)
          .fillColor(isBlack ? "#22C55E" : "#16A34A")
          .text("No defects identified — this card is in exceptional condition.");
      } else {
        for (const d of defects) {
          doc
            .fontSize(8)
            .fillColor(DARK)
            .text(`${d.type} · ${d.severity?.toUpperCase()} · ${d.location || ""}`);
          if (d.description)
            doc
              .fontSize(7)
              .fillColor(isBlack ? "#AAAAAA" : "#666666")
              .text(`  ${d.description}`);
        }
      }
      doc.moveDown(0.5);

      // Authentication
      doc.fontSize(9).fillColor(GOLD).text("AUTHENTICATION");
      const authStatus = c.authStatus || "genuine";
      doc
        .fontSize(8)
        .fillColor(isBlack ? "#AAAAAA" : "#444444")
        .text(
          authStatus === "genuine"
            ? "This card has been authenticated as genuine by MintVault UK."
            : authStatus === "authentic_altered"
              ? "This card has been identified as AUTHENTIC ALTERED."
              : "This card has been identified as NOT ORIGINAL."
        );
      if (c.authNotes)
        doc
          .fontSize(7)
          .fillColor(isBlack ? "#888888" : "#666666")
          .text(c.authNotes);
      doc.moveDown(0.5);

      // Footer
      doc
        .moveTo(50, doc.page.height - 70)
        .lineTo(545, doc.page.height - 70)
        .strokeColor(GOLD)
        .lineWidth(0.5)
        .stroke();
      doc
        .fontSize(7)
        .fillColor(isBlack ? "#666666" : "#999999")
        .text(`Graded by MintVault UK · Kent · mintvaultuk.com`, 50, doc.page.height - 60, { align: "center" })
        .text(`Verify at mintvaultuk.com/cert/${certId}/report`, 50, doc.page.height - 50, { align: "center" })
        .text(`© 2026 MintVault UK — This report is permanent and cannot be altered.`, 50, doc.page.height - 40, {
          align: "center",
        });

      doc.end();
    } catch (error: any) {
      console.error("[report/pdf] error:", error.message, error.stack);
      if (!res.headersSent) res.status(500).json({ error: "PDF generation failed" });
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

  app.get("/api/logbook/:certId/verify", lookupRateLimit, async (req, res) => {
    try {
      const sig = (req.query.sig || req.query.signature) as string | undefined;
      if (!sig) return res.status(400).json({ error: "signature query parameter required" });
      const { verifyLogbookSignature } = await import("./logbook-service");
      const result = await verifyLogbookSignature(String(req.params.certId), sig);
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
      const cacheKey = `logbooks/v5/${certId}.pdf`;

      // ── Cert lookup FIRST ────────────────────────────────────────────────
      // Cache must NEVER be served for hard/soft-deleted certs, even if a
      // stale R2 object still exists (the MV1 reset bug). If the cert isn't
      // findable, 404 immediately.
      const dbCert = await findCertByIdFlex(certId);
      if (!dbCert || dbCert.status === "voided") {
        return res.status(404).json({ error: "Certificate not found" });
      }
      const certUpdatedAt =
        (dbCert as any).updatedAt instanceof Date
          ? (dbCert as any).updatedAt
          : new Date((dbCert as any).updatedAt || 0);

      // ── Cache read with auto-stale-check ─────────────────────────────────
      // Serve cached PDF only if cache exists AND cert hasn't been updated
      // since the cache was written. Any failure (head error, missing object,
      // stale comparison) falls through to regenerate.
      if (!forceRegenerate) {
        const cachedHead = await headR2(cacheKey);
        const cacheIsFresh = !!cachedHead && certUpdatedAt <= cachedHead.lastModified;
        console.log(
          `[logbook-cache] cert=${certId} certUpdated=${certUpdatedAt.toISOString()} cacheLastMod=${cachedHead?.lastModified.toISOString() || "none"} action=${cacheIsFresh ? "serve-cache" : "regenerate"}`
        );
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
      try {
        await uploadToR2(cacheKey, pdf, "application/pdf");
      } catch {}

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="MintVault-Logbook-${certId}.pdf"`);
      res.send(pdf);
    } catch (err: any) {
      console.error(
        "[logbook-pdf] generation failed for %s:",
        req.params.certId,
        err.message,
        err.stack?.split("\n")[1]?.trim()
      );
      if (!res.headersSent)
        res.status(503).json({
          error:
            "Logbook temporarily unavailable. Please try again in a few minutes or contact support@mintvaultuk.com.",
        });
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
        typeof certOwnerEmail === "string" &&
        certOwnerEmail.trim() !== "" &&
        (((req.session as any)?.userId &&
          typeof certOwnerUserId === "string" &&
          certOwnerUserId !== "" &&
          (req.session as any).userId === certOwnerUserId) ||
          ((req.session as any)?.customerEmail &&
            typeof (req.session as any).customerEmail === "string" &&
            (req.session as any).customerEmail.trim().toLowerCase() === certOwnerEmail.trim().toLowerCase()));

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
      console.log(
        `[logbook-owner-pdf] served owner copy for ${certId}, referenceNumberPresent=${!!(data as any).referenceNumber}`
      );
      res.send(pdf);
    } catch (err: any) {
      console.error(
        "[logbook-owner-pdf] generation failed for %s:",
        req.params.certId,
        err.message,
        err.stack?.split("\n")[1]?.trim()
      );
      if (!res.headersSent)
        res.status(503).json({
          error:
            "Logbook temporarily unavailable. Please try again in a few minutes or contact support@mintvaultuk.com.",
        });
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
        typeof certOwnerEmail === "string" &&
        certOwnerEmail.trim() !== "" &&
        (((req.session as any)?.userId &&
          typeof certOwnerUserId === "string" &&
          certOwnerUserId !== "" &&
          (req.session as any).userId === certOwnerUserId) ||
          ((req.session as any)?.customerEmail &&
            typeof (req.session as any).customerEmail === "string" &&
            (req.session as any).customerEmail.trim().toLowerCase() === certOwnerEmail.trim().toLowerCase()));
      if (!isOwner)
        return res.status(403).json({ error: "Only the current registered keeper can reissue the logbook" });

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

      console.log(
        `[logbook-reissue] ${certId}: v${oldVersion} -> v${newVersion}, referenceNumberPresent=true, reason="${reason.trim().slice(0, 50)}"`
      );
      res.json({ newVersion, issuedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error("[logbook-reissue] error for %s:", req.params.certId, err.message);
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
      const cacheKey = `logbooks/v5/${certId}.pdf`;
      await uploadToR2(cacheKey, pdf, "application/pdf");
      res.json({ ok: true, key: cacheKey });
    } catch (err: any) {
      sendServerError(res, err);
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
      const isBlack = !isNonNum && (await certIsPristine(c));

      async function signedOrNull(key: string | null | undefined): Promise<string | null> {
        if (!key) return null;
        try {
          return await getR2SignedUrl(key, 3600);
        } catch (e) {
          console.error("R2 sign failed:", key, e);
          return null;
        }
      }

      const [frontUrl, backUrl] = await Promise.all([
        signedOrNull(c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath),
        signedOrNull(c.gradingBackCropped || c.gradingBackOriginal || c.backImagePath),
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
      } catch {
        /* non-critical */
      }

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
        } catch {
          /* non-critical */
        }
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
        ownership = chain.map((entry) => ({
          owner: `Verified Owner #${entry.ownerNumber}`,
          date: entry.claimedAt ? entry.claimedAt.split("T")[0] : "",
          method:
            entry.claimMethod === "initial_claim" || entry.claimMethod === "auto_submission"
              ? "Original Issuance"
              : "Verified Transfer",
          verified: true,
        }));
      } catch {
        /* non-critical — empty array on failure, never falls back to raw history */
      }

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
          corners: c.gradeCorners ? parseFloat(c.gradeCorners) : null,
          edges: c.gradeEdges ? parseFloat(c.gradeEdges) : null,
          surface: c.gradeSurface ? parseFloat(c.gradeSurface) : null,
          isBlackLabel: isBlack,
          isNonNumeric: isNonNum,
          gradeLabel: isNonNum ? gradeLabelFull(gradeType, "0") : mvgsTierName(gradeNum).toUpperCase(),
          gradeStrengthScore: typeof c.gradeStrengthScore === "number" ? c.gradeStrengthScore : null,
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
          nfcUid: viewerIsOwner ? c.nfcUid || null : null,
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
      sendServerError(res, error);
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
        express: { active: express_.active, max: express_.max, full: express_.full, forceOpen: express_.forceOpen },
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

  app.get("/api/admin/certificates/export-csv", requireAdmin, async (_req, res) => {
    try {
      const certs = await storage.listCertificates();
      const headers = [
        "Cert ID",
        "Grade Type",
        "Card Game",
        "Set",
        "Collection/Subset",
        "Card Name",
        "Card Number",
        "Rarity",
        "Designations",
        "Variant",
        "Language",
        "Year",
        "Grade Overall",
        "Status",
        "Ownership",
        "Created",
      ];
      const rows = certs.map((c) => {
        const gt = (c as any).gradeType || "numeric";
        const isNonNum = isNonNumericGrade(gt);
        return [
          normalizeCertId(c.certId),
          gt,
          c.cardGame,
          c.setName,
          collectionDisplayLabel((c as any).collectionCode, (c as any).collectionOther, (c as any).collection) || "",
          c.cardName,
          c.cardNumber,
          rarityDisplayLabel(c.rarity, (c as any).rarityOther) || "",
          designationCodesToLabels((c.designations as string[]) || []).join("; "),
          variantDisplayLabel(c.variant, (c as any).variantOther) || c.variant || "",
          c.language,
          c.year,
          isNonNum ? gt : c.gradeOverall || "",
          c.status,
          (c as any).ownershipStatus || "unclaimed",
          c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "",
        ];
      });

      const csvContent = [
        headers.join(","),
        ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")),
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="mintvault-certificates-${new Date().toISOString().split("T")[0]}.csv"`
      );
      res.send(csvContent);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to export CSV" });
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
      if (req.query.ownershipStatus && req.query.ownershipStatus !== "all")
        filters.ownershipStatus = req.query.ownershipStatus as string;

      const allCerts = await storage.listCertificates(Object.keys(filters).length > 0 ? filters : undefined);
      // Hide empty drafts (no card name, no images, no grade) unless a specific ID is requested
      const includeId = req.query.includeId ? Number(req.query.includeId) : null;
      const certs = allCerts.filter((c: any) => {
        if (includeId && c.id === includeId) return true;
        // Hide empty draft certs from the list
        if (c.status === "draft" && !c.cardName && !c.frontImagePath && !c.gradeOverall) return false;
        return true;
      });
      const certIds = certs.map((c: any) => Number(c.id)).filter((id) => Number.isInteger(id) && id > 0);
      const correctionVersions = new Map<number, string>();
      if (certIds.length > 0) {
        const rows = await db
          .select({
            id: certificates.id,
            correctionVersion: sql<string>`EXTRACT(EPOCH FROM ${certificates.updatedAt})::text`,
          })
          .from(certificates)
          .where(inArray(certificates.id, certIds));
        for (const row of rows) correctionVersions.set(Number(row.id), row.correctionVersion);
      }
      const certsWithUrls = await Promise.all(
        certs.map(async (c: any) => {
          let frontImageUrl: string | null = null;
          let backImageUrl: string | null = null;
          if (c.frontImagePath) {
            try {
              frontImageUrl = await getR2SignedUrl(c.frontImagePath, 3600);
            } catch (e) {
              console.error("R2 sign failed (admin front):", c.frontImagePath, e);
            }
          }
          if (c.backImagePath) {
            try {
              backImageUrl = await getR2SignedUrl(c.backImagePath, 3600);
            } catch (e) {
              console.error("R2 sign failed (admin back):", c.backImagePath, e);
            }
          }
          const correctionVersion = correctionVersions.get(Number(c.id)) ?? null;
          return { ...c, certId: normalizeCertId(c.certId), correctionVersion, frontImageUrl, backImageUrl };
        })
      );
      res.json(certsWithUrls);
    } catch (error: any) {
      console.error("List certs error:", error.message, error.stack);
      res.status(500).json({ error: "Failed to list certificates" });
    }
  });

  // ── Create a new cert immediately with a real MV### number ─────────────────
  app.post("/api/admin/certificates/new", requireAdmin, async (_req, res) => {
    try {
      const { generateReferenceNumber } = await import("./reference-number");
      const refNum = generateReferenceNumber();
      // Allocate + insert ATOMICALLY so a failed INSERT rolls the counter
      // increment back instead of permanently burning an MV integer (the MV
      // number is the physical card's identity; gaps are not acceptable).
      //
      // The grading origin is stamped HQ explicitly — same rationale as in
      // scan-ingest-service.ts. This path also bypasses storage.createCertificate, so it left the
      // origin_* columns NULL, which the reader treats as LEGACY rather than as a recorded fact.
      // Partner provenance is never inferred here. The stamp sits inside the same transaction as
      // the allocation so provenance and identity commit or roll back together.
      const result = await db.transaction(async (tx) => {
        const certNumber = await storage.getNextCertId(tx);
        return await tx.execute(sql`
          INSERT INTO certificates (certificate_number, status, label_type, grade_type, language, card_name, created_by, issued_at, updated_at, reference_number, origin_type, origin_captured_at, origin_snapshot_version)
          VALUES (${certNumber}, 'active', 'Standard', 'numeric', 'English', NULL, 'admin', NOW(), NOW(), ${refNum}, 'HQ', NOW(), ${CERTIFICATE_ORIGIN_SNAPSHOT_VERSION})
          RETURNING *
        `);
      });
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
      // Log the COMMITTED number off the returned row, not a pre-commit local.
      console.log(`[admin] created new cert: ${row.certificate_number} (id=${row.id})`);
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
    handleCertificateCreate
  );

  app.put(
    "/api/admin/certificates/:id",
    requireAdmin,
    upload.fields([
      { name: "frontImage", maxCount: 1 },
      { name: "backImage", maxCount: 1 },
    ]),
    handleCertificateMetadataUpdate
  );

  app.delete("/api/admin/certificates/:id", requireAdmin, async (req, res) => {
    await storage.writeAuditLog(
      "certificate",
      String(req.params.id),
      "delete_attempt_blocked",
      req.session.adminEmail || "admin",
      {
        message: "Hard delete is disabled. Use void instead.",
      }
    );
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

      res.json({
        success: true,
        certificate: updated ? { ...updated, certId: normalizeCertId(updated.certId) } : updated,
      });
    } catch (error: any) {
      console.error("Void cert error:", error.message, error.stack);
      res.status(500).json({ error: "Failed to void certificate" });
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
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${normalizeCertId(cert.certId)}-${side}-label.png"`
        );
        return res.send(png);
      }

      const pdf = await generateLabelPDF(cert, side);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${normalizeCertId(cert.certId)}-${side === "both" ? "labels" : side + "-label"}.pdf"`
      );
      res.send(pdf);
    } catch (error: any) {
      console.error("Label generation error:", error.message);
      // A refused grade is an operator-fixable condition, not a server fault.
      if (error instanceof UnprintableGradeError) {
        return res
          .status(422)
          .json({ error: error.message, code: "UNPRINTABLE_GRADE", blockedCertIds: [error.certId] });
      }
      res.status(500).json({ error: "Failed to generate label" });
    }
  });

  // ── LABEL PRINTING ROUTES ────────────────────────────────────────────────
  app.get("/api/admin/printing/queue", requireAdmin, async (req, res) => {
    try {
      const limit = parseInt((req.query.limit as string) || "200", 10);
      const certs = await storage.getAllCertificatesForPrinting(limit);
      const printed = certs.filter((c) => c.lastPrintedAt !== null).length;
      const unprinted = certs.filter((c) => c.lastPrintedAt === null).length;
      console.log(`[printing/queue] returning ${certs.length} certs (${printed} printed, ${unprinted} unprinted)`);
      res.json(certs);
    } catch (err: any) {
      console.error("[printing/queue] ERROR:", err.message);
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/printing/sheets", requireAdmin, async (req, res) => {
    try {
      const sheets = await storage.getLabelSheets();
      res.json(sheets);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/printing/sheets/:sheetRef", requireAdmin, async (req, res) => {
    try {
      const detail = await storage.getSheetDetail(String(req.params.sheetRef));
      res.json(detail);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // v525 — legacy /generate-sheet and /generate-cut-sheet routes removed.
  // The two-column "front + NFC back" layout they produced was wrong (the
  // NFC back was redundant with the QR on the front and the QR on the
  // claim insert). All sheet-printing now flows through /api/admin/print-batch
  // which emits PDF + SVG + PNG in one call with the correct
  // front + claim-insert layout. label-sheet.ts is deleted.

  /* ══════════════════════════════════════════════════════════════════════════
   * P0-D — PRINT APPROVAL GATE (server-side, both print endpoints).
   * ══════════════════════════════════════════════════════════════════════════
   * The live print console posts straight to /api/admin/print-batch. That
   * endpoint had a grade PRINTABILITY pre-pass (added after the 2026-07-02
   * incident) but NO approval or review-state gate at all — a certificate that
   * was still being graded, still awaiting review, or bounced back to the
   * grader for correction could be batched onto a real label sheet by a direct
   * API call. The approval gate that does exist lives in the parallel
   * print-workflow system (shared/print-lifecycle.ts) which this legacy console
   * never calls.
   *
   * This closes it AT THE HANDLER, not in the UI. Three refusals, all fail
   * closed on unknown/missing state:
   *
   *   grade_review_incomplete — grader_status is 'assigned' or 'pending_review'.
   *       'pending_review' = review not done. 'assigned' is ALSO a blocking
   *       correction state: rejectCertGrade bounces a card back to 'assigned'
   *       WITHOUT clearing grade_approved_at, so a previously-approved card
   *       that a reviewer sent back for correction would otherwise sail
   *       through the approval check below on a stale timestamp.
   *       'unassigned' is allowed — pre-grader-v2 certs approved by an admin
   *       legitimately sit there, and they are still held by the next check.
   *
   *   not_approved — grade_approved_at IS NULL. This is the same signal
   *       shared/print-lifecycle.ts's effectivePrintState() uses to decide
   *       approved vs awaiting_approval, so both systems agree on the meaning
   *       of "approved" rather than inventing a second definition.
   *
   *   cert_not_active — status is voided (listCertificates excludes soft-
   *       deleted rows but NOT voided ones).
   *
   * The pre-existing grade printability pre-pass is UNCHANGED and still runs —
   * that was a deliberate fix for a real production incident. Both passes are
   * ALL-OR-NOTHING: one blocked cert refuses the whole batch, before the
   * claim-code minting loop, so no partial sheet and no side effects.
   *
   * Deliberately NOT gated here: print_state. Advancing print_state is owned by
   * the parallel print-workflow service; the legacy console never writes it, so
   * gating on it would block certs on state this endpoint cannot produce.
   *
   * WHY THE HANDLER AND NOT storage.getAllCertificatesForPrinting():
   *   that function is a READ used to populate the console's queue view. A gate
   *   is an authorisation decision on a WRITE-effecting action (claim-code
   *   minting + artefact generation + audit), so it belongs at the action
   *   boundary. Filtering the list instead would (a) leave the endpoint itself
   *   open to a direct API call — the exact hole being closed, (b) silently
   *   vanish certs from the operator's queue with no reason shown, and (c)
   *   change behaviour for every other caller of that read. The handler gate
   *   refuses loudly, per cert, with a machine-readable code.
   */
  type PrintApprovalBlock = { certId: string; code: string; message: string };
  const checkPrintApproval = (id: string, c: Record<string, unknown>): PrintApprovalBlock | null => {
    const graderStatus = String(c.graderStatus ?? "");
    if (graderStatus === "pending_review" || graderStatus === "assigned") {
      return {
        certId: id,
        code: "grade_review_incomplete",
        message:
          graderStatus === "pending_review"
            ? `${id}: grading review is not complete (awaiting approval).`
            : `${id}: this card is back with the grader for correction.`,
      };
    }
    if (!c.gradeApprovedAt) {
      return { certId: id, code: "not_approved", message: `${id}: grade has not been approved.` };
    }
    if (String(c.status ?? "") !== "active") {
      return { certId: id, code: "cert_not_active", message: `${id}: certificate is not active (voided).` };
    }
    return null;
  };

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
        MAX_CERTS_PER_MULTI_BATCH,
        CERTS_PER_PAGE,
        SHEET_LAYOUT_VERSION,
        generatePrintBatchPDF,
        generatePrintBatchCutSVG,
        generatePrintBatchPNG,
        generatePrintBatchPrintPNG,
        generateCricutSVG,
        deriveBatchId,
        uploadPrintBatchArtifacts,
        uploadPrintBatchPDF,
        uploadCricutSvg,
        r2KeyForPrintBatch,
      } = await import("./print-batch");
      if (certIds.length > MAX_CERTS_PER_MULTI_BATCH) {
        return res.status(400).json({ error: `Maximum ${MAX_CERTS_PER_MULTI_BATCH} certs per batch` });
      }
      // Normalize input IDs so "MV-0000000042" and "MV42" both resolve —
      // allCerts store certId in canonical form, and find() below is exact.
      const ids = certIds.map((c: unknown) => normalizeCertId(String(c)));

      // Resolve each cert. Reject claimed certs at this endpoint (security
      // boundary kept intact — admins can still reprint claimed certs via
      // /api/admin/print-batch/reprint with a recorded reason).
      const allCerts = await storage.listCertificates();
      // ── Grade printability PRE-PASS (fail closed) ────────────────────────────
      // Runs BEFORE the loop below, because that loop MINTS claim codes as a side
      // effect (getOrGenerateClaimCode) — so a rejected batch must never reach it.
      // This is the exact endpoint that, on 2026-07-02, rendered 22 ungraded
      // production certificates onto a real label sheet showing 0 / POOR: it had no
      // grade or approval gate at all. All-or-nothing: no partial sheet.
      const unprintable: { certId: string; code: string; message: string }[] = [];
      for (const id of ids) {
        const c = allCerts.find((x: any) => x.certId === id);
        if (!c) continue; // handled as `missing` below
        const verdict = checkPrintableGrade({ gradeType: (c as any).gradeType, gradeOverall: (c as any).gradeOverall });
        if (!verdict.printable) {
          unprintable.push({
            certId: id,
            code: verdict.reason ?? "unprintable_grade",
            message: `${id}: ${verdict.message}`,
          });
        }
      }
      if (unprintable.length) {
        return res.status(422).json({
          error: `Cannot print — ${unprintable.length === 1 ? "this certificate is" : "these certificates are"} not ready: ${unprintable.map((u) => u.message).join(" ")}`,
          code: "UNPRINTABLE_GRADE",
          blockedCertIds: unprintable.map((u) => u.certId),
          blocked: unprintable,
        });
      }
      // ── Approval / review-state PRE-PASS (fail closed) ───────────────────────
      // See the P0-D block above this handler. Same all-or-nothing contract as
      // the printability pre-pass, and likewise BEFORE the claim-code minting
      // loop, so a refused batch has zero side effects.
      const unapproved: { certId: string; code: string; message: string }[] = [];
      for (const id of ids) {
        const c = allCerts.find((x: any) => x.certId === id);
        if (!c) continue; // handled as `missing` below
        const block = checkPrintApproval(id, c as unknown as Record<string, unknown>);
        if (block) unapproved.push(block);
      }
      if (unapproved.length) {
        return res.status(422).json({
          error: `Cannot print — ${unapproved.length === 1 ? "this certificate is" : "these certificates are"} not approved for printing: ${unapproved.map((u) => u.message).join(" ")}`,
          code: "NOT_APPROVED_FOR_PRINT",
          blockedCertIds: unapproved.map((u) => u.certId),
          blocked: unapproved,
        });
      }
      // The legacy print console predates the workflow service, but it still
      // emits a physical artefact and mints claim codes. It therefore uses the
      // exact Partner authority before any side effect, rather than treating a
      // Partner-origin record as a generic approved certificate.
      const { getPartnerPrintEligibilityBlocks } = await import("./partner/print-eligibility");
      const partnerBlocks = await getPartnerPrintEligibilityBlocks(ids);
      if (partnerBlocks.length) {
        return res.status(422).json({
          error: `Cannot print — ${partnerBlocks.map((block) => block.message).join(" ")}`,
          code: "PARTNER_PRINT_INELIGIBLE",
          blockedCertIds: partnerBlocks.map((block) => block.certId),
          blocked: partnerBlocks,
        });
      }
      const items: { cert: any; claimCode: string }[] = [];
      const missing: string[] = [];
      const claimed: string[] = [];
      const mintedFor: string[] = [];
      for (const id of ids) {
        const cert = allCerts.find((c: any) => c.certId === id);
        if (!cert) {
          missing.push(id);
          continue;
        }
        if ((cert as any).ownershipStatus !== "unclaimed") {
          claimed.push(id);
          continue;
        }
        let code: string | undefined = (cert as any).claimCode || (cert as any).claim_code;
        if (!code) {
          code = await storage.getOrGenerateClaimCode(id);
          mintedFor.push(id);
        }
        items.push({ cert, claimCode: String(code) });
      }
      if (missing.length) return res.status(404).json({ error: `Certs not found: ${missing.join(", ")}` });
      if (claimed.length)
        return res.status(409).json({
          error: `Only unclaimed certs can be batched (claimed: ${claimed.join(", ")}). Use /api/admin/print-batch/reprint for claimed certs.`,
          claimedCertIds: claimed,
          code: "CLAIMED_CERTS_PRESENT",
        });

      const adminUser = (req.session as any)?.adminEmail || "admin";
      const batchId = deriveBatchId(ids, adminUser);
      const generatedAt = new Date().toISOString();

      // Multi-sheet batches (> one page of certs) are guillotine-only: a
      // multi-page PDF, no Cricut PNG/SVG cut files. Single-sheet batches keep
      // the full artefact set (PDF + Cricut PNG + print PNG + cut SVG).
      const isMultiSheet = items.length > CERTS_PER_PAGE;
      const pageCount = Math.ceil(items.length / CERTS_PER_PAGE);

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

      // Fast-path: if this is a recent duplicate AND the R2 artefacts still
      // exist at the current key version, skip the expensive PDF + PNG
      // generation (~9s wall-time, ~500MB peak memory). The SVG is rebuilt
      // here because it's a cheap static cell-template string and the
      // client downloads it inline from this response.
      // HEAD-checks the PDF object — if it's missing (R2 key version bumped
      // mid-window, or object cleared), we fall through to full regeneration.
      if (isRecentDuplicate) {
        const pdfKey = r2KeyForPrintBatch(batchId, "pdf");
        const head = await headR2(pdfKey).catch(() => null);
        if (head && isMultiSheet) {
          // Multi-sheet fast-path — only the PDF exists (no Cricut artefacts).
          console.log(`[print-batch] idempotent fast-path (multi-sheet, ${pageCount}pg) for batch ${batchId}`);
          return res.json({
            pdfUrl: `/api/admin/print-batch/${batchId}/pdf`,
            batchId,
            certIds: ids,
            mintedFor,
            generatedAt,
            isRecentDuplicate: true,
            isMultiSheet: true,
            pageCount,
            sheetLayoutVersion: SHEET_LAYOUT_VERSION,
          });
        }
        if (head) {
          const svgStr = generatePrintBatchCutSVG(items.length);
          // Cricut cut SVG is a cheap static string — (re)upload it so its
          // download endpoint resolves even on the idempotent fast-path (the
          // object may predate this feature for an older same-version batch).
          await uploadCricutSvg(batchId, generateCricutSVG(items)).catch((e: any) =>
            console.warn("[print-batch] cricut SVG upload (fast-path) failed:", e?.message || e)
          );
          console.log(`[print-batch] idempotent fast-path for batch ${batchId} — skipped generation`);
          return res.json({
            pdfUrl: `/api/admin/print-batch/${batchId}/pdf`,
            pngUrl: `/api/admin/print-batch/${batchId}/png`,
            printPngUrl: `/api/admin/print-batch/${batchId}/print-png`,
            cricutSvgUrl: `/api/admin/print-batch/${batchId}/cricut-cut.svg`,
            svg: Buffer.from(svgStr, "utf8").toString("base64"),
            batchId,
            certIds: ids,
            mintedFor,
            generatedAt,
            isRecentDuplicate: true,
            sheetLayoutVersion: SHEET_LAYOUT_VERSION,
          });
        }
        console.log(`[print-batch] duplicate batchId ${batchId} but R2 artefact missing — regenerating`);
      }

      // Multi-sheet → guillotine-only multi-page PDF (no Cricut artefacts).
      // Single-sheet → PDF + Cricut PNG + 400-DPI print PNG + cut SVG, as before.
      let pdfBuf: Buffer;
      let svgStr = "";
      let pngBuf: Buffer | null = null;
      let printPngBuf: Buffer | null = null;

      if (isMultiSheet) {
        pdfBuf = await generatePrintBatchPDF(items);
        try {
          await uploadPrintBatchPDF(batchId, pdfBuf);
        } catch (uploadErr: any) {
          console.error("[print-batch] R2 upload failed:", uploadErr.message);
          return res.status(500).json({ error: "Failed to store print batch artefacts" });
        }
      } else {
        [pdfBuf, svgStr, pngBuf, printPngBuf] = await Promise.all([
          generatePrintBatchPDF(items),
          Promise.resolve(generatePrintBatchCutSVG(items.length)),
          generatePrintBatchPNG(items),
          generatePrintBatchPrintPNG(items),
        ]);

        // Persist PDF + PNG (+ 400-DPI print PNG) to R2 so the client can retrieve
        // them via stable server URLs instead of expiring blob URLs. SVG inline.
        try {
          await uploadPrintBatchArtifacts(batchId, pdfBuf, pngBuf, printPngBuf);
        } catch (uploadErr: any) {
          console.error("[print-batch] R2 upload failed:", uploadErr.message);
          return res.status(500).json({ error: "Failed to store print batch artefacts" });
        }

        // Cricut cut-guide SVG (matches the PNG layout). Non-fatal if it fails —
        // the PDF/PNG are the critical artefacts; the cut SVG is a convenience.
        await uploadCricutSvg(batchId, generateCricutSVG(items)).catch((e: any) =>
          console.warn("[print-batch] cricut SVG upload failed:", e?.message || e)
        );
      }

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
                page_count: pageCount,
                multi_sheet: isMultiSheet,
                pdf_size_bytes: pdfBuf.length,
                svg_size_bytes: Buffer.byteLength(svgStr, "utf8"),
                png_size_bytes: pngBuf?.length ?? 0,
                auto_generated_codes_for: mintedFor,
                sheet_layout_version: SHEET_LAYOUT_VERSION,
                layout: isMultiSheet ? "multi_page_guillotine" : "front_plus_insert",
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
      }
      // Note: reaching this point with isRecentDuplicate=true means the
      // fast-path's R2 HEAD check came back empty and we regenerated. The
      // audit log writes above were skipped (gated on !isRecentDuplicate) so
      // we don't double-record the batch.

      if (isMultiSheet) {
        // Guillotine-only multi-page PDF — no PNG/SVG artefacts to return.
        res.json({
          pdfUrl: `/api/admin/print-batch/${batchId}/pdf`,
          batchId,
          certIds: ids,
          mintedFor,
          generatedAt,
          isRecentDuplicate,
          isMultiSheet: true,
          pageCount,
          sheetLayoutVersion: SHEET_LAYOUT_VERSION,
        });
      } else {
        res.json({
          pdfUrl: `/api/admin/print-batch/${batchId}/pdf`,
          pngUrl: `/api/admin/print-batch/${batchId}/png`,
          printPngUrl: `/api/admin/print-batch/${batchId}/print-png`,
          cricutSvgUrl: `/api/admin/print-batch/${batchId}/cricut-cut.svg`,
          svg: Buffer.from(svgStr, "utf8").toString("base64"),
          batchId,
          certIds: ids,
          mintedFor,
          generatedAt,
          isRecentDuplicate,
          isMultiSheet: false,
          pageCount,
          sheetLayoutVersion: SHEET_LAYOUT_VERSION,
        });
      }
    } catch (err: any) {
      console.error("[print-batch] error:", err.message);
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/printing/mark-printed", requireAdmin, async (req, res) => {
    try {
      const { sheetRef } = req.body as { sheetRef: string };
      if (!sheetRef) return res.status(400).json({ error: "sheetRef required" });
      await storage.markSheetPrinted(sheetRef);
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
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
        uploadPrintBatchArtifacts,
      } = await import("./print-batch");
      if (certIds.length > MAX_CERTS_PER_BATCH) {
        return res.status(400).json({ error: `Maximum ${MAX_CERTS_PER_BATCH} certs per batch` });
      }
      // Normalize input IDs so "MV-0000000042" and "MV42" both resolve —
      // allCerts store certId in canonical form, and find() below is exact.
      const ids = certIds.map((c: unknown) => normalizeCertId(String(c)));

      // Resolve certs. Skip the "unclaimed only" check — that's the whole
      // point of this endpoint. Still reject not-found / soft-deleted /
      // missing-grade so the layout doesn't draw garbage.
      const allCerts = await storage.listCertificates();
      // Reprint enforces the SAME grade printability rule as a fresh batch. There is no
      // separate immutable-historical-artefact render path in this codebase, so none is
      // invented here: a reprint re-renders from the CURRENT certificate row, which means
      // an invalid grade would print an invented panel exactly as a fresh batch would.
      // Pre-pass, before the claim-code minting below.
      const unprintableRe: { certId: string; code: string; message: string }[] = [];
      for (const id of ids) {
        const c = allCerts.find((x: any) => x.certId === id);
        if (!c) continue;
        const verdict = checkPrintableGrade({ gradeType: (c as any).gradeType, gradeOverall: (c as any).gradeOverall });
        if (!verdict.printable) {
          unprintableRe.push({
            certId: id,
            code: verdict.reason ?? "unprintable_grade",
            message: `${id}: ${verdict.message}`,
          });
        }
      }
      if (unprintableRe.length) {
        return res.status(422).json({
          error: `Cannot reprint — ${unprintableRe.length === 1 ? "this certificate is" : "these certificates are"} not ready: ${unprintableRe.map((u) => u.message).join(" ")}`,
          code: "UNPRINTABLE_GRADE",
          blockedCertIds: unprintableRe.map((u) => u.certId),
          blocked: unprintableRe,
        });
      }
      // Reprint enforces the SAME approval / review-state gate as a fresh batch,
      // for the same reason the printability rule is shared: a reprint re-renders
      // from the CURRENT certificate row, so a card that is mid-correction or
      // unapproved would emit a physical label exactly as a fresh batch would.
      const unapprovedRe: { certId: string; code: string; message: string }[] = [];
      for (const id of ids) {
        const c = allCerts.find((x: any) => x.certId === id);
        if (!c) continue;
        const block = checkPrintApproval(id, c as unknown as Record<string, unknown>);
        if (block) unapprovedRe.push(block);
      }
      if (unapprovedRe.length) {
        return res.status(422).json({
          error: `Cannot reprint — ${unapprovedRe.length === 1 ? "this certificate is" : "these certificates are"} not approved for printing: ${unapprovedRe.map((u) => u.message).join(" ")}`,
          code: "NOT_APPROVED_FOR_PRINT",
          blockedCertIds: unapprovedRe.map((u) => u.certId),
          blocked: unapprovedRe,
        });
      }
      const { getPartnerPrintEligibilityBlocks } = await import("./partner/print-eligibility");
      const partnerBlocks = await getPartnerPrintEligibilityBlocks(ids);
      if (partnerBlocks.length) {
        return res.status(422).json({
          error: `Cannot reprint — ${partnerBlocks.map((block) => block.message).join(" ")}`,
          code: "PARTNER_PRINT_INELIGIBLE",
          blockedCertIds: partnerBlocks.map((block) => block.certId),
          blocked: partnerBlocks,
        });
      }
      const items: { cert: any; claimCode: string }[] = [];
      const missing: string[] = [];
      const mintedFor: string[] = [];
      for (const id of ids) {
        const cert = allCerts.find((c: any) => c.certId === id);
        if (!cert) {
          missing.push(id);
          continue;
        }
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

      // Persist PDF + PNG to R2 so the client can retrieve them via stable
      // server URLs instead of expiring blob URLs.
      try {
        await uploadPrintBatchArtifacts(batchId, pdfBuf, pngBuf);
      } catch (uploadErr: any) {
        console.error("[reprint] R2 upload failed:", uploadErr.message);
        return res.status(500).json({ error: "Failed to store print batch artefacts" });
      }

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
        pdfUrl: `/api/admin/print-batch/${batchId}/pdf`,
        pngUrl: `/api/admin/print-batch/${batchId}/png`,
        svg: Buffer.from(svgStr, "utf8").toString("base64"),
        batchId,
        certIds: ids,
        mintedFor,
        generatedAt,
        sheetLayoutVersion: SHEET_LAYOUT_VERSION,
        auditRows,
      });
    } catch (err: any) {
      console.error("[reprint] error:", err.message);
      sendServerError(res, err);
    }
  });

  // ── PRINT BATCH ARTIFACT RETRIEVAL ───────────────────────────────────────
  // GET endpoints serve the PDF and PNG artefacts previously written to R2
  // by the POST handlers above. Admin auth required.
  // PDF: inline by default (so the print-window flow can navigate to it and
  // trigger window.print()), attachment when ?download=1 is set.
  // PNG: always attachment (Cricut Design Space needs the file on disk).

  /**
   * Cached print artefacts (PDF/PNG/cut-SVG) are streamed straight out of R2 with no
   * re-render, so a sheet produced BEFORE the grade gate existed — including the
   * 2026-07-02 sheet whose panels read 0 / POOR — remained downloadable and printable by
   * batch id. Re-validate the batch's certificates against the same rule before serving.
   *
   * Cert membership is resolved from `print_batches.cert_ids` when the row exists, and
   * otherwise from `label_prints.sheet_ref` (which is how pre-0022 legacy sheets are
   * recorded). If membership cannot be resolved at all we FAIL CLOSED rather than serve an
   * artefact we cannot vouch for.
   */
  async function assertBatchArtefactPrintable(
    batchId: string
  ): Promise<{ ok: true } | { ok: false; blocked: string[]; message: string }> {
    let certIds: string[] = [];
    try {
      const b = await db.execute(sql`SELECT cert_ids FROM print_batches WHERE batch_id = ${batchId}`);
      const row = b.rows[0] as { cert_ids?: string[] } | undefined;
      if (row?.cert_ids?.length) certIds = row.cert_ids;
    } catch {
      /* print_batches may not exist yet (pre-0022) — fall through to label_prints */
    }
    if (certIds.length === 0) {
      const lp = await db.execute(
        sql`SELECT cert_id FROM label_prints WHERE sheet_ref = ${`print_batch_${batchId}`} OR sheet_ref = ${batchId}`
      );
      certIds = (lp.rows as unknown as { cert_id: string }[]).map((r) => r.cert_id).filter(Boolean);
    }
    if (certIds.length === 0) {
      return {
        ok: false,
        blocked: [],
        message:
          "This print sheet's certificates cannot be identified, so it cannot be verified as safe to print. " +
          "Create a fresh batch instead.",
      };
    }
    const rows = await db.execute(
      sql`SELECT certificate_number, grade_type, grade::text AS grade FROM certificates
           WHERE certificate_number IN (${sql.join(
             certIds.map((c) => sql`${c}`),
             sql`, `
           )})`
    );
    const byId = new Map(
      (rows.rows as unknown as { certificate_number: string; grade_type: string | null; grade: string | null }[]).map(
        (r) => [r.certificate_number, r]
      )
    );
    const blocked: string[] = [];
    for (const id of certIds) {
      const r = byId.get(id);
      // A cert missing from the result fails CLOSED.
      const v = checkPrintableGrade({ gradeType: r?.grade_type ?? null, gradeOverall: r?.grade ?? null });
      if (!v.printable) blocked.push(id);
    }
    if (blocked.length) {
      return {
        ok: false,
        blocked,
        message:
          `This print sheet contains ${blocked.length === 1 ? "a certificate" : "certificates"} without a valid grade ` +
          `(${blocked.join(", ")}), so it cannot be downloaded or printed. Grade ${blocked.length === 1 ? "it" : "them"} and create a fresh batch.`,
      };
    }
    const { getPartnerPrintEligibilityBlocks } = await import("./partner/print-eligibility");
    const partnerBlocks = await getPartnerPrintEligibilityBlocks(certIds);
    if (partnerBlocks.length) {
      return {
        ok: false,
        blocked: partnerBlocks.map((block) => block.certId),
        message: `This print sheet contains Partner cards that are not eligible for output (${partnerBlocks
          .map((block) => block.certId)
          .join(", ")}). Create a fresh batch after the Partner QA, credit, and scanner checks pass.`,
      };
    }
    return { ok: true };
  }

  app.get("/api/admin/print-batch/:batchId/pdf", requireAdmin, async (req, res) => {
    try {
      {
        const guard = await assertBatchArtefactPrintable(String(req.params.batchId));
        if (!guard.ok) {
          return res
            .status(422)
            .json({ error: guard.message, code: "UNPRINTABLE_GRADE", blockedCertIds: guard.blocked });
        }
      }
      const batchId = String(req.params.batchId);
      const download = req.query.download === "1";
      const { r2KeyForPrintBatch } = await import("./print-batch");
      const key = r2KeyForPrintBatch(batchId, "pdf");
      const head = await headR2(key);
      if (!head) return res.status(404).json({ error: "Print batch PDF not found" });
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("./r2");
      const client = getR2Client();
      const result = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
      if (!result.Body) return res.status(404).json({ error: "Print batch PDF not found" });
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const filename = `MintVault-Batch-${batchId}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${filename}"`);
      res.send(Buffer.concat(chunks));
    } catch (err: any) {
      console.error("[print-batch/pdf] error:", err.message);
      res.status(500).json({ error: "Failed to fetch print batch PDF" });
    }
  });

  app.get("/api/admin/print-batch/:batchId/png", requireAdmin, async (req, res) => {
    try {
      {
        const guard = await assertBatchArtefactPrintable(String(req.params.batchId));
        if (!guard.ok) {
          return res
            .status(422)
            .json({ error: guard.message, code: "UNPRINTABLE_GRADE", blockedCertIds: guard.blocked });
        }
      }
      const batchId = String(req.params.batchId);
      const { r2KeyForPrintBatch } = await import("./print-batch");
      const key = r2KeyForPrintBatch(batchId, "png");
      const head = await headR2(key);
      if (!head) return res.status(404).json({ error: "Print batch PNG not found" });
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("./r2");
      const client = getR2Client();
      const result = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
      if (!result.Body) return res.status(404).json({ error: "Print batch PNG not found" });
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const filename = `MintVault-Batch-${batchId}.png`;
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(Buffer.concat(chunks));
    } catch (err: any) {
      console.error("[print-batch/png] error:", err.message);
      res.status(500).json({ error: "Failed to fetch print batch PNG" });
    }
  });

  // 400-DPI print PNG — same R2-stream pattern as /png, distinct -print.png key.
  app.get("/api/admin/print-batch/:batchId/print-png", requireAdmin, async (req, res) => {
    try {
      {
        const guard = await assertBatchArtefactPrintable(String(req.params.batchId));
        if (!guard.ok) {
          return res
            .status(422)
            .json({ error: guard.message, code: "UNPRINTABLE_GRADE", blockedCertIds: guard.blocked });
        }
      }
      const batchId = String(req.params.batchId);
      const { r2KeyForPrintBatch } = await import("./print-batch");
      const key = r2KeyForPrintBatch(batchId, "print-png");
      const head = await headR2(key);
      if (!head) return res.status(404).json({ error: "Print batch print PNG not found" });
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("./r2");
      const client = getR2Client();
      const result = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
      if (!result.Body) return res.status(404).json({ error: "Print batch print PNG not found" });
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const filename = `MintVault-Batch-${batchId}-print.png`;
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(Buffer.concat(chunks));
    } catch (err: any) {
      console.error("[print-batch/print-png] error:", err.message);
      res.status(500).json({ error: "Failed to fetch print batch print PNG" });
    }
  });

  // Cricut cut-guide SVG (matches the PNG layout) — same R2-stream pattern as /png.
  app.get("/api/admin/print-batch/:batchId/cricut-cut.svg", requireAdmin, async (req, res) => {
    try {
      {
        const guard = await assertBatchArtefactPrintable(String(req.params.batchId));
        if (!guard.ok) {
          return res
            .status(422)
            .json({ error: guard.message, code: "UNPRINTABLE_GRADE", blockedCertIds: guard.blocked });
        }
      }
      const batchId = String(req.params.batchId);
      const { r2KeyForCricutSvg } = await import("./print-batch");
      const key = r2KeyForCricutSvg(batchId);
      const head = await headR2(key);
      if (!head) return res.status(404).json({ error: "Print batch cut SVG not found" });
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("./r2");
      const client = getR2Client();
      const result = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
      if (!result.Body) return res.status(404).json({ error: "Print batch cut SVG not found" });
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const filename = `MintVault-Batch-${batchId}-cut.svg`;
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(Buffer.concat(chunks));
    } catch (err: any) {
      console.error("[print-batch/cricut-cut.svg] error:", err.message);
      res.status(500).json({ error: "Failed to fetch print batch cut SVG" });
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
      // A refused grade is operator-fixable, not a server fault. This route feeds the
      // Printing-console thumbnails, so every ungraded row previously produced an opaque
      // 500 plus a server-error log line with no actionable message.
      if (err instanceof UnprintableGradeError) {
        return res.status(422).json({ error: err.message, code: "UNPRINTABLE_GRADE", blockedCertIds: [err.certId] });
      }
      sendServerError(res, err);
    }
  });

  // ── CERTIFICATE BROWSER ────────────────────────────────────────────────────
  app.get("/api/admin/printing/browser", requireAdmin, async (req, res) => {
    try {
      const certs = await storage.listCertificatesBrowser();
      res.json(certs.map((c) => ({ ...c, certId: normalizeCertId(c.certId) })));
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── LABEL OVERRIDES ────────────────────────────────────────────────────────
  app.get("/api/admin/printing/override/:certId", requireAdmin, async (req, res) => {
    try {
      const override = await storage.getLabelOverride(String(req.params.certId));
      res.json(override ?? null);
    } catch (err: any) {
      sendServerError(res, err);
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
      sendServerError(res, err);
    }
  });

  app.delete("/api/admin/printing/override/:certId", requireAdmin, async (req, res) => {
    try {
      await storage.clearLabelOverride(String(req.params.certId));
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
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
      if (!target) return res.status(404).json({ error: "Certificate not found" });
      if (target.nfcUid && target.nfcUid !== uid && !req.body.overwrite) {
        return res.status(409).json({
          error: "Certificate already has an NFC tag",
          code: "ALREADY_ASSIGNED",
          existingUid: target.nfcUid,
        });
      }

      /*
       * A TAG MAY ONLY BE BOUND TO AN APPROVED CERTIFICATE.
       *
       * This route previously read `status`, `print_state`, `grade_approved_at` and `deleted_at` not
       * at all, so a chip could be written for a draft, ungraded, unapproved, voided or soft-deleted
       * card. The public scan route already refuses to resolve an unapproved certificate
       * (`gradeApprovedAt == null` → 404), so every such tag was a physical object in a customer's
       * hand that resolved to nothing — the failure only became visible after the card had shipped.
       *
       * The gate is the SAME fact the public route uses, applied at the point of binding instead of
       * the point of embarrassment. It is also what makes the P11 contract true for Partner Card Job
       * lineage: an NFC tag exists only for a card that cleared Super Admin QA.
       */
      const bindable = checkNfcBindable(target);
      if (!bindable.ok) {
        return res.status(bindable.status).json({
          error: bindable.error,
          ...(bindable.refusal === "not_approved" ? { code: "NFC_NOT_APPROVED" } : {}),
        });
      }

      // Operator attribution. `writtenBy` arrived from the request body and NO client ever sent it,
      // so `nfc_written_by` was always NULL and no NFC action had an author. The authenticated admin
      // is the truthful answer and cannot be spoofed by the body.
      const nfcActor = renderAdminUser(req) || (typeof writtenBy === "string" ? writtenBy : null);
      const previousUid = target.nfcUid ?? null;

      let cert;
      try {
        cert = await storage.saveNfcData(id, { uid, chipType, url, writtenBy: nfcActor ?? undefined });
      } catch (bindErr: any) {
        // 0088's partial unique index on lower(nfc_uid) is the REAL "one tag, one certificate"
        // authority — the read guard above races and two concurrent binds both pass it. Translate the
        // constraint into the same 409 the guard returns, so the loser of a race gets an answer it
        // can act on rather than a 500.
        if (bindErr?.code === "23505" || bindErr?.cause?.code === "23505") {
          return res.status(409).json({ error: "UID already registered", code: "NFC_UID_TAKEN" });
        }
        throw bindErr;
      }
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      // NFC binding was entirely unlogged: no audit row on bind, overwrite, lock or clear. A
      // tamper-evident chip whose binding cannot be reconstructed afterwards is not evidence.
      await storage.writeAuditLog("certificate", String(id), "nfc_bound", nfcActor ?? "admin", {
        uid,
        chip_type: chipType ?? null,
        previous_uid: previousUid,
        overwrite: Boolean(req.body.overwrite),
      });
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
      // Read the outgoing UID BEFORE clearing it: `clearNfc` nulls all twelve columns, so afterwards
      // there is nothing left to say which tag was removed. A failed/replaced tag whose identity was
      // destroyed with no record is exactly the history a replacement workflow needs.
      const before = await storage.getCertificate(id);
      const cert = await storage.clearNfc(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      await storage.writeAuditLog("certificate", String(id), "nfc_cleared", renderAdminUser(req) || "admin", {
        previous_uid: before?.nfcUid ?? null,
        previous_scan_count: before?.nfcScanCount ?? null,
        reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : null,
      });
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
      // Public-visibility gate: an unapproved/ungraded cert is not public, so a
      // chip tap on one resolves to not-found (same as findCertByIdFlex).
      if (!cert || (cert as { gradeApprovedAt?: unknown }).gradeApprovedAt == null) {
        return res.status(404).json({ error: "Certificate not found" });
      }
      const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || undefined;
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

  // ── PUBLIC CLAIM FLOW ──────────────────────────────────────────────────────
  // Rate limiter: max 5 attempts per IP per 15 minutes to prevent brute-forcing claim codes

  // ── PUBLIC TRANSFER FLOW ───────────────────────────────────────────────────
  // Rate limiter: max 5 attempts per IP per 15 minutes

  // ── V2 TRANSFER FLOW (DVLA-style: ref number + 14-day dispute window) ────
  // v435 — public transfer endpoints are gated by TRANSFER_FLOW_LIVE. When
  // false (default), they return 503. Admin endpoints are NOT gated so we
  // can inspect/resolve regardless of the public switch.
  const requireTransferFlowLive = (_req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => {
    // FEATURE_FLAGS imported at top level
    if (!FEATURE_FLAGS.TRANSFER_FLOW_LIVE) {
      return res.status(503).json({ error: "Transfer flow not yet available — coming soon." });
    }
    next();
  };

  // Rate limiter: max 5 attempts per IP per 15 minutes (shared concept, separate instance)

  // Stricter rate limit for ref number verification — 3 attempts per hour per IP

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
        return res.status(500).json({ error: "Seed failed." });
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
        return res.status(500).json({ error: "Reset failed." });
      }
    });
  }

  // ── CERTIFICATE DOCUMENT (A4 PDF) ─────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/certificate-document", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      if (cert.status === "voided")
        return res.status(403).json({ error: "Cannot generate certificate for a voided certificate" });

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

  // ── GRADING REPORT ────────────────────────────────────────────────────────────
  app.patch("/api/admin/certificates/:certId/grading-report", requireAdmin, async (req, res) => {
    try {
      const certId = req.params.certId;
      const { centering, corners, edges, surface, overall } = req.body as {
        centering?: string;
        corners?: string;
        edges?: string;
        surface?: string;
        overall?: string;
      };
      const report: Record<string, string> = {};
      if (centering?.trim()) report.centering = centering.trim().slice(0, 1000);
      if (corners?.trim()) report.corners = corners.trim().slice(0, 1000);
      if (edges?.trim()) report.edges = edges.trim().slice(0, 1000);
      if (surface?.trim()) report.surface = surface.trim().slice(0, 1000);
      if (overall?.trim()) report.overall = overall.trim().slice(0, 1000);

      await db.execute(
        sql`UPDATE certificates SET grading_report = ${JSON.stringify(report)}::jsonb WHERE certificate_number = ${certId}`
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[grading-report] save error:", err);
      res.status(500).json({ error: "Failed to save grading report." });
    }
  });

  app.get("/sitemap.xml", (_req, res) => {
    const baseUrl = APP_BASE_URL;
    const now = new Date().toISOString().split("T")[0];
    const urls = getSitemapEntries().map(
      (p) =>
        `  <url>\n    <loc>${baseUrl}${p.loc}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    );

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

  // ── Account-switch confirm flow ─────────────────────────────────────────────
  // Triggered by /api/customer/verify/:token when an active session is signed
  // in as a different customer. /account/switch renders an HTML confirm page;
  // the user explicitly confirms or cancels. See server/account-switch.ts.

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
    return /\bwv\)|; wv;|FBAN\/|FBAV\/|Instagram |Twitter for|LinkedInApp|GoogleMail|Outlook(?:Mobile|-iOS|-Android)|YJApp|Snapchat\b|Line\/|MicroMessenger\b/i.test(
      ua
    );
  }

  function renderIntermediateHtml(realUrl: string, kind: "login" | "reset"): string {
    const escape = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const urlEsc = escape(realUrl);
    const heading = kind === "login" ? "Open in your browser" : "Open in your browser";
    const subhead =
      kind === "login"
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

  // ── PIN auth (v1 launch) ────────────────────────────────────────────────────
  // Replaces magic-link as primary login for cert-owners + admin step 2.
  // Magic-link demoted to first-time enrollment (/api/customer/verify routes
  // to /auth/pin/setup if no pin_hash) and forgot-PIN reset.

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
      const result = submissions.map((sub: any) => {
        const sid = sub.submissionId || sub.submission_id || "";
        const token = sid ? generatePdfToken(sid) : ""; // H-a hardened token
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

      const rows = (
        await db.execute(sql`
        SELECT id, customer_email, marketing_feature_consent, deleted_at
        FROM submissions WHERE id = ${subId} LIMIT 1
      `)
      ).rows;
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
      sendServerError(res, err);
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
      const consented = (
        await db.execute(sql`
        SELECT id FROM submissions
        WHERE LOWER(customer_email) = ${email.toLowerCase()}
          AND marketing_feature_consent = true
          AND deleted_at IS NULL
      `)
      ).rows as Array<{ id: number }>;

      if (consented.length === 0) {
        return res.json({ ok: true, withdrew: 0 });
      }

      const ids = consented.map((r) => r.id);
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
      sendServerError(res, err);
    }
  });

  // GET /api/submissions/me — full submission list with tracking fields (user account session)
  app.get("/api/submissions/me", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      // Look up user email for legacy email-matched submissions
      const userRows = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
      const email = userRows.rows.length > 0 ? ((userRows.rows[0] as any).email as string) : null;
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

  app.post(
    "/api/admin/submissions/:id/mark-received",
    requireAdmin,
    receiptUpload.array("photos", 6),
    async (req, res) => {
      try {
        const sub = await storage.getSubmissionBySubmissionId(String(req.params.id));
        if (!sub) return res.status(404).json({ error: "Submission not found" });
        const numId = typeof sub.id === "string" ? parseInt(sub.id, 10) : sub.id;

        // Upload photos to R2 — validate real image content (magic bytes), not
        // just the filename extension, before trusting the client-supplied type.
        const files = (req.files as Express.Multer.File[]) ?? [];
        for (const f of files) {
          if (!(await validateImageMagicBytes(f))) {
            return res.status(400).json({ error: `File "${f.originalname}" is not a valid image.` });
          }
        }
        const photoUrls: string[] = [];
        for (const file of files) {
          const key = `receipt/${sub.submissionId}/${Date.now()}-${file.originalname}`;
          await uploadToR2(key, file.buffer, file.mimetype);
          const url = await getR2SignedUrl(key, 60 * 60 * 24 * 7); // 7-day URL (AWS SigV4 hard cap)
          photoUrls.push(url);
        }
        // Also accept pre-uploaded URLs from body (for admin typing in URLs)
        const bodyUrls: string[] = Array.isArray(req.body.photo_urls) ? req.body.photo_urls : [];
        const allUrls = [...photoUrls, ...bodyUrls];

        await storage.updateSubmissionStatus(numId, "received", {
          onReceiptPhotoUrls: JSON.stringify(allUrls),
        });

        await storage.writeAuditLog(
          "submission",
          sub.submissionId,
          "status_received",
          req.session.adminEmail || "admin",
          { photoCount: allUrls.length }
        );

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
      const safe = await Promise.all(
        certs.map(async (c) => ({
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
        }))
      );
      res.json(safe);
    } catch (err) {
      console.error("[customer] certificates error:", err);
      res.status(500).json({ error: "Failed to load certificates." });
    }
  });

  // ── Build 1: Grading image upload ─────────────────────────────────────────

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
        const {
          deskewCard,
          cropToYellowBorder,
          autoCrop,
          maskRoundedCorners,
          generateVariants,
          checkImageQuality,
          reCentreBitmap,
          padWithMat,
        } = await import("./image-processing");
        const cropGeometryByAngle: Record<string, any> = {};

        const id = parseInt(String(req.params.id), 10);
        const cert = await storage.getCertificate(id);
        if (!cert) return res.status(404).json({ error: "Certificate not found" });

        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        if (!files || Object.keys(files).length === 0) {
          return res.status(400).json({ error: "No images provided" });
        }

        // Validate real image content (magic bytes), not just the multer
        // filename-extension filter, before processing/uploading. See B9.
        const badUpload = await rejectInvalidUploads(Object.values(files).flat());
        if (badUpload) return res.status(400).json({ error: badUpload });

        const certId = normalizeCertId(cert.certId);
        const updates: Record<string, string> = {};
        const qualityResults: Record<string, any> = {};
        let frontCroppedBuf: Buffer | null = null;
        let backCroppedBuf: Buffer | null = null;

        // ── M-2 · CONTENT IDENTITY FOR EVERY OBJECT THIS REQUEST WRITES ───────
        // R2 keys here are DETERMINISTIC (`grading/{certId}/front_cropped.jpg`,
        // `images/{certId}/front.jpg`), so a re-upload replaces the OBJECT while
        // the stored path STRING stays the same. A path-only audit would
        // therefore record "nothing changed" for a request that swapped a
        // customer's card image. Every upload is recorded with the SHA-256 of the
        // bytes actually sent, the byte count and the MIME type, so a replacement
        // is provable even when no column value moves.
        //
        // `preexisting` marks a key that was ALREADY the committed value for its
        // column before this request. It drives compensation below: an orphan
        // from a failed transaction may be deleted, but an object that the last
        // committed state still points at must never be.
        type UploadedObject = {
          key: string;
          column: string;
          sha256: string;
          bytes: number;
          contentType: string;
          preexisting: boolean;
        };
        const uploadedObjects: UploadedObject[] = [];
        const recordUpload = (key: string, column: string, buf: Buffer, contentType: string) => {
          uploadedObjects.push({
            key,
            column,
            sha256: crypto.createHash("sha256").update(buf).digest("hex"),
            bytes: buf.length,
            contentType,
            preexisting: (cert as Record<string, unknown>)[COLUMN_TO_CERT_KEY[column] ?? ""] === key,
          });
        };

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
          recordUpload(origKey, `grading_${angle}_original`, reencodedOriginal, "image/jpeg");

          // 2. Deskew (straighten slight rotation before cropping)
          const { buffer: deskewedBuf, angle: deskewAngle } = await deskewCard(buffer);

          // 3. Yellow border crop (precise), then fallback to autoCrop
          const yellowResult = await cropToYellowBorder(deskewedBuf);
          const cropResult = yellowResult || (await autoCrop(deskewedBuf));
          const { buffer: rectCropped, cropped, matRgb } = cropResult;

          // 3a. Deterministic re-centre — measure actual card edges against
          // mat colour and shift card to centre inside the bitmap (Fix 2).
          // matRgb is plumbed in from the cropper so reCentreBitmap doesn't
          // misdetect the cropped buffer's yellow card border as mat.
          const centreResult = await reCentreBitmap(rectCropped, { certId, matRgb });
          cropGeometryByAngle[angle] = {
            pre_padding_px: centreResult.pre_padding_px,
            post_asymmetry_px: centreResult.post_asymmetry_px,
            extended: centreResult.extended,
          };

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
          const croppedBuf = await (
            await import("sharp")
          )
            .default(paddedBuf)
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality: 85, progressive: true, mozjpeg: true })
            .toBuffer();
          const ext2 = "jpg";
          const cropKey = `grading/${certId}/${angle}_cropped.${ext2}`;
          await uploadToR2(cropKey, croppedBuf, "image/jpeg");
          updates[`grading_${angle}_cropped`] = cropKey;
          recordUpload(cropKey, `grading_${angle}_cropped`, croppedBuf, "image/jpeg");

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
            recordUpload(displayKey, "front_image_path", croppedBuf, "image/jpeg");
          } else if (angle === "back") {
            backCroppedBuf = croppedBuf;
            const displayKey = r2KeyForImage(certId, "back", "jpg");
            updates["back_image_path"] = displayKey;
            await uploadToR2(displayKey, croppedBuf, "image/jpeg");
            recordUpload(displayKey, "back_image_path", croppedBuf, "image/jpeg");
          }

          // 5a. 1600px display derivative for the grading-panel viewer —
          // full-res cropped stays as the zoom/manual-tool source.
          if (angle === "front" || angle === "back") {
            const { makeDisplayDerivative } = await import("./image-processing");
            const displayDerivative = await makeDisplayDerivative(croppedBuf);
            const derivKey = `grading/${certId}/${angle}_display.jpg`;
            await uploadToR2(derivKey, displayDerivative, "image/jpeg");
            updates[`grading_${angle}_display`] = derivKey;
            recordUpload(derivKey, `grading_${angle}_display`, displayDerivative, "image/jpeg");
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
              // M-2: the background variant pass writes real certificate
              // columns, so it goes through the SAME allowlist + transaction +
              // audit as the foreground upload rather than a bare UPDATE. It
              // runs after the response, so its failure cannot roll the
              // foreground commit back — it is audited separately under its own
              // action and logged loudly if it fails.
              if (angle === "front" || angle === "back") {
                const variantBufs: Array<[string, Buffer]> = [
                  ["greyscale", greyscale],
                  ["highcontrast", highcontrast],
                  ["edgeenhanced", edgeenhanced],
                  ["inverted", inverted],
                ];
                const variantUpdates: Record<string, string> = {};
                const variantObjects = variantBufs.map(([name, buf]) => {
                  const key = `grading/${certId}/${angle}_${name}.jpg`;
                  const column = `grading_${angle}_${name}`;
                  variantUpdates[column] = key;
                  return {
                    key,
                    column,
                    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
                    bytes: buf.length,
                    contentType: "image/jpeg",
                    preexisting: false,
                  };
                });
                const variantResult = await persistImageUploadAudited({
                  id,
                  certId,
                  updates: variantUpdates,
                  uploadedObjects: variantObjects,
                  actor: (req.session as { adminEmail?: string })?.adminEmail || "admin",
                  action: IMAGE_VARIANTS_AUDIT_ACTION,
                });
                if (!variantResult.committed) {
                  console.error(`[upload-images] variant persist failed for cert=${id} angle=${angle}`);
                }
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

        // ── M-2 · ONE TRANSACTION, ONE TRUTHFUL AUDIT ROW ─────────────────────
        // The durable half lives in server/lib/certificate-image-persistence.ts
        // so it can be proven against a real PostgreSQL cluster without running
        // the sharp pipeline. See that module for the full diagnosis and for the
        // explicit statement of what is and is not atomic across R2 + Postgres.
        //
        // This also removes a real defect in the previous code: the old
        // colMap/CASE loop re-ran a no-op UPDATE for every non-path key (its
        // `${col} = 'front_image_path'` comparison bound `col` as a string
        // LITERAL, so it was always false) and the targeted block then wrote the
        // same columns a second time — up to ~14 sequential auto-committed
        // statements per upload, none of them audited.
        updates["image_quality_checks"] = JSON.stringify(qualityResults);
        if (Object.keys(cropGeometryByAngle).length > 0) {
          updates["crop_geometry"] = JSON.stringify({
            ...cropGeometryByAngle,
            pipeline_version: "converged_v1",
            recorded_at: new Date().toISOString(),
          });
        }

        const persistResult = await persistImageUploadAudited({
          id,
          certId,
          updates,
          uploadedObjects,
          actor: (req.session as { adminEmail?: string })?.adminEmail || "admin",
        });
        if (!persistResult.committed) {
          // Truthful failure: nothing committed, nothing audited as committed,
          // last committed certificate state preserved.
          return res.status(500).json({
            error: "Image upload could not be saved",
            committed: false,
            orphanCleanupFailed: persistResult.orphanCleanupFailed.length || undefined,
          });
        }

        // Generate signed URLs for response
        const responseUrls: Record<string, string | null> = {};
        for (const [key, val] of Object.entries(updates)) {
          // JSONB columns hold documents, not R2 keys — signing them is nonsense.
          if (IMAGE_UPLOAD_JSONB_COLUMNS.has(key)) continue;
          try {
            responseUrls[key] = await getR2SignedUrl(val, 3600);
          } catch {
            responseUrls[key] = null;
          }
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
                .then((r) =>
                  console.log(`[upload-images] AI done for cert ${id}: grade=${r.grade} strength=${r.strengthScore}`)
                )
                .catch((e) =>
                  console.error(
                    `[upload-images] AI failed for cert ${id}: ${e?.message || e}\n${e?.stack || "(no stack)"}`
                  )
                );
            }
          } else {
            console.log(
              `[upload-images] cert=${id} skipping AI trigger (aiEmpty=${aiEmpty} aiGradeEmpty=${aiGradeEmpty} frontBuf=${!!frontCroppedBuf} backBuf=${!!backCroppedBuf})`
            );
          }
        } catch (aiErr: any) {
          console.error(`[upload-images] AI trigger setup failed for cert ${id}: ${aiErr.message}`);
        }

        res.json({ success: true, urls: responseUrls, quality: qualityResults });
      } catch (error: any) {
        console.error("[upload-images] error:", error.message, error.stack);
        res.status(500).json({ error: "Upload failed" });
      }
    }
  );

  // ── Attach images to an existing (typically blank) cert. Reuses the
  // scan-ingest pipeline (uploadImagesToCert) so attached images go through
  // the same deskew → safety-pad → mask → 10px-trim → PNG path as a
  // natively-scanned cert. Front required, back optional. AI fires async.

  app.put(
    "/api/admin/certificates/:id/attach-images",
    requireAdmin,
    attachImagesUpload.fields([
      { name: "front", maxCount: 1 },
      { name: "back", maxCount: 1 },
    ]),
    async (req, res) => {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid certificate id" });

      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const frontFile = files?.front?.[0];
      const backFile = files?.back?.[0];
      if (!frontFile) return res.status(400).json({ error: "Front image is required" });

      // Validate real image content (magic bytes), not just the multer
      // filename-extension filter, before processing/uploading. See B9.
      const badUpload = await rejectInvalidUploads([frontFile, ...(backFile ? [backFile] : [])]);
      if (badUpload) return res.status(400).json({ error: badUpload });

      try {
        const { uploadImagesToCert, runAiOnCertIfIdle } = await import("./scan-ingest-service");
        const { frontVariants, backVariants } = await uploadImagesToCert(
          id,
          frontFile.buffer,
          backFile?.buffer ?? null
        );

        const adminUser = req.session.adminEmail || "admin";
        await storage.writeAuditLog("certificate", String(cert.certId), "cert_images_attached", adminUser, {
          cert_id: id,
          had_front_before: !!cert.frontImagePath,
          had_back_before: !!cert.backImagePath,
          attached: {
            front: { filename: frontFile.originalname, size: frontFile.size },
            back: backFile ? { filename: backFile.originalname, size: backFile.size } : null,
          },
        });

        const aiPromise = runAiOnCertIfIdle(id, frontVariants.cropped, backVariants?.cropped || null);
        if (aiPromise) {
          aiPromise
            .then((r) => console.log(`[attach-images] AI done for cert ${id}: grade=${r?.grade}`))
            .catch((e) => console.warn(`[attach-images] AI failed for cert ${id}:`, e?.message || e));
        }

        res.json({ ok: true, certId: cert.certId, aiTriggered: !!aiPromise });
      } catch (err: any) {
        console.error(`[attach-images] cert=${id} failed:`, err?.message || err, err?.stack || "");
        sendServerError(res, err);
      }
    }
  );

  // ── Reprocess images: re-run deskew + crop + variants on existing originals
  app.post("/api/admin/certificates/:id/reprocess-images", requireAdmin, async (req, res) => {
    try {
      const {
        deskewCard: dsk,
        cropToYellowBorder: cyb,
        autoCrop: ac,
        generateVariants: gv,
      } = await import("./image-processing");

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const c = cert as any;
      const certIdStr = normalizeCertId(cert.certId);
      const results: Record<string, any> = {};

      for (const side of ["front", "back"] as const) {
        // ALWAYS fetch from the ORIGINAL (pre-processed) image, never the cropped version
        const origKey =
          side === "front" ? c.gradingFrontOriginal || c.frontImagePath : c.gradingBackOriginal || c.backImagePath;
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

        console.log(
          `[reprocess] ${certIdStr} ${side}: fetched original ${(origBuf.length / 1024).toFixed(0)}KB from ${origKey}`
        );

        // Run pipeline: deskew → yellow crop → fallback autoCrop → save
        const { buffer: deskewed, angle } = await dsk(origBuf);
        const yellowResult = await cyb(deskewed);
        const { buffer: cropped } = yellowResult || (await ac(deskewed));

        const cropKey = `grading/${certIdStr}/${side}_cropped.jpg`;
        await uploadToR2(cropKey, cropped, "image/jpeg");

        // 1600px display derivative for the grading-panel viewer
        const { makeDisplayDerivative: mdd } = await import("./image-processing");
        const derivBuf = await mdd(cropped);
        const derivKey = `grading/${certIdStr}/${side}_display.jpg`;
        await uploadToR2(derivKey, derivBuf, "image/jpeg");

        // Update display path
        if (side === "front") {
          const displayKey = r2KeyForImage(certIdStr, "front", "jpg");
          await uploadToR2(displayKey, cropped, "image/jpeg");
          await db.execute(
            sql`UPDATE certificates SET front_image_path = ${displayKey}, grading_front_cropped = ${cropKey}, grading_front_display = ${derivKey}, updated_at = NOW() WHERE id = ${id}`
          );
        } else {
          const displayKey = r2KeyForImage(certIdStr, "back", "jpg");
          await uploadToR2(displayKey, cropped, "image/jpeg");
          await db.execute(
            sql`UPDATE certificates SET back_image_path = ${displayKey}, grading_back_cropped = ${cropKey}, grading_back_display = ${derivKey}, updated_at = NOW() WHERE id = ${id}`
          );
        }

        // Regenerate variants sequentially
        const variants = await gv(cropped);
        for (const [vName, vBuf] of Object.entries(variants) as [string, Buffer][]) {
          const vKey = `grading/${certIdStr}/${side}_${vName}.jpg`;
          await uploadToR2(vKey, vBuf, "image/jpeg");
          const col = `grading_${side}_${vName}`;
          await db.execute(sql`UPDATE certificates SET updated_at = NOW() WHERE id = ${id}`);
          // Update the specific variant column
          if (vName === "greyscale")
            await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_greyscale = '${vKey}' WHERE id = ${id}`));
          if (vName === "highcontrast")
            await db.execute(
              sql.raw(`UPDATE certificates SET grading_${side}_highcontrast = '${vKey}' WHERE id = ${id}`)
            );
          if (vName === "edgeenhanced")
            await db.execute(
              sql.raw(`UPDATE certificates SET grading_${side}_edgeenhanced = '${vKey}' WHERE id = ${id}`)
            );
          if (vName === "inverted")
            await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_inverted = '${vKey}' WHERE id = ${id}`));
        }

        results[side] = { angle, processed: true };
        console.log(`[reprocess] ${certIdStr} ${side}: deskew=${angle.toFixed(2)}° variants=4`);
      }

      res.json({ success: true, results });
    } catch (err: any) {
      console.error("[reprocess] error:", err.message);
      sendServerError(res, err);
    }
  });

  // POST /api/admin/certificates/:id/recrop — manual crop override
  app.post("/api/admin/certificates/:id/recrop", requireAdmin, async (req, res) => {
    try {
      const { generateVariants: gv, maskRoundedCorners } = await import("./image-processing");
      const sharpFn = (await import("sharp")).default;

      const id = parseInt(String(req.params.id), 10);
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const { side, left_pct, top_pct, width_pct, height_pct, rotation_deg = 0 } = req.body;
      if (!side || !["front", "back"].includes(side))
        return res.status(400).json({ error: "side must be front or back" });
      if ([left_pct, top_pct, width_pct, height_pct].some((v: any) => typeof v !== "number" || v < 0 || v > 100)) {
        return res.status(400).json({ error: "Invalid crop coordinates" });
      }

      const c = cert as any;
      const certIdStr = normalizeCertId(cert.certId);
      const origKey =
        side === "front" ? c.gradingFrontOriginal || c.frontImagePath : c.gradingBackOriginal || c.backImagePath;
      if (!origKey) return res.status(400).json({ error: `No original ${side} image found` });

      let origBuf: Buffer;
      try {
        const url = await getR2SignedUrl(origKey, 300);
        const resp = await fetch(url);
        origBuf = Buffer.from(await resp.arrayBuffer());
      } catch (err: any) {
        return res.status(500).json({ error: "Failed to fetch original" });
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

      const left = Math.max(0, Math.round((meta.width * left_pct) / 100));
      const top = Math.max(0, Math.round((meta.height * top_pct) / 100));
      const w = Math.min(meta.width - left, Math.round((meta.width * width_pct) / 100));
      const h = Math.min(meta.height - top, Math.round((meta.height * height_pct) / 100));
      if (w < 50 || h < 50) return res.status(400).json({ error: "Crop box too small" });

      console.log(`[recrop] ${certIdStr} ${side}: ${meta.width}x${meta.height} → extract(${left},${top},${w},${h})`);

      // Extract the operator-chosen crop as a lossless PNG intermediate so
      // the rounded-corner mask below operates on un-recompressed pixels
      // (avoids a JPEG round-trip on the very corners the operator just
      // dialled in via the 8-dot tool).
      const extracted = await sharpFn(workBuf).extract({ left, top, width: w, height: h }).png().toBuffer();

      // Round corners to match a real Pokémon card — same maskRoundedCorners
      // the auto-pipeline applies to upload-images / pre-grade / backfill
      // outputs (CARD_CORNER_RADIUS_PCT = 3% of min(w,h), calibrated against
      // real scans). The mask sets alpha=0 in the corner triangles with
      // RGB=white underneath; the flatten below renders them as clean white.
      // Centering is computed from the dot coordinates by /manual-centering
      // (shared/centering.ts) on a separate call — this purely cosmetic
      // rounding does NOT affect the measurement.
      const masked = await maskRoundedCorners(extracted);

      // Final flatten + JPEG. Same q85 mozjpeg progressive as the auto-crop
      // pipeline (routes.ts:8782-8784) so manual + auto outputs share an
      // encoding spec. Flatten-to-white also belt-and-braces against the
      // earlier black-corners regression: any residual alpha (including the
      // rounded corner triangles we just masked) renders as white, not the
      // JPEG-default black.
      const cropped = await sharpFn(masked)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toBuffer();

      const cropKey = `grading/${certIdStr}/${side}_cropped.jpg`;
      await uploadToR2(cropKey, cropped, "image/jpeg");
      const displayKey = r2KeyForImage(certIdStr, side, "jpg");
      await uploadToR2(displayKey, cropped, "image/jpeg");

      // Refresh the 1600px viewer derivative so the recrop is visible in the
      // grading panel (which prefers grading_{side}_display over cropped).
      const { makeDisplayDerivative: makeDeriv } = await import("./image-processing");
      const recropDerivBuf = await makeDeriv(cropped);
      const recropDerivKey = `grading/${certIdStr}/${side}_display.jpg`;
      await uploadToR2(recropDerivKey, recropDerivBuf, "image/jpeg");

      if (side === "front") {
        await db.execute(
          sql`UPDATE certificates SET front_image_path = ${displayKey}, grading_front_cropped = ${cropKey}, grading_front_display = ${recropDerivKey}, updated_at = NOW() WHERE id = ${id}`
        );
      } else {
        await db.execute(
          sql`UPDATE certificates SET back_image_path = ${displayKey}, grading_back_cropped = ${cropKey}, grading_back_display = ${recropDerivKey}, updated_at = NOW() WHERE id = ${id}`
        );
      }

      const variants = await gv(cropped);
      for (const [vName, vBuf] of Object.entries(variants) as [string, Buffer][]) {
        const vKey = `grading/${certIdStr}/${side}_${vName}.jpg`;
        await uploadToR2(vKey, vBuf, "image/jpeg");
        if (vName === "greyscale")
          await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_greyscale = '${vKey}' WHERE id = ${id}`));
        if (vName === "highcontrast")
          await db.execute(
            sql.raw(`UPDATE certificates SET grading_${side}_highcontrast = '${vKey}' WHERE id = ${id}`)
          );
        if (vName === "edgeenhanced")
          await db.execute(
            sql.raw(`UPDATE certificates SET grading_${side}_edgeenhanced = '${vKey}' WHERE id = ${id}`)
          );
        if (vName === "inverted")
          await db.execute(sql.raw(`UPDATE certificates SET grading_${side}_inverted = '${vKey}' WHERE id = ${id}`));
      }

      // Return a signed URL for the just-written display image so the Card
      // Tool can swap its <img src> directly into the defects phase without
      // racing a TanStack refetch. 5-min expiry matches the origKey signing
      // above. Falls back to undefined on signing failure — the client treats
      // absent URL as "use the rawImageUrl instead".
      //
      // No cache-buster query string appended: getR2SignedUrl uses SigV4
      // (server/r2.ts → @aws-sdk/s3-request-presigner) whose signature covers
      // every query parameter. Appending `?v=<ts>` AFTER signing breaks the
      // canonical-request hash and R2 returns 403 SignatureDoesNotMatch (the
      // v819 broken-image regression). A cache-buster wasn't needed anyway —
      // each /recrop call produces a brand-new signed URL (signing timestamp
      // and signature both change), so the browser can't cache-hit a prior
      // version. Other working URL sites in this file (e.g. :404, :412, :2047,
      // :3392, :4053, :8665) all use this bare-signed-URL pattern.
      let displayUrl: string | undefined;
      try {
        displayUrl = await getR2SignedUrl(displayKey, 300);
      } catch {
        // Non-fatal — the crop is saved; the client just won't auto-advance.
      }

      console.log(`[recrop] ${certIdStr} ${side}: manual crop applied, ${w}x${h}px, variants regenerated`);
      res.json({ success: true, side, width: w, height: h, displayUrl });
    } catch (err: any) {
      console.error("[recrop] error:", err.message);
      sendServerError(res, err);
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
      const cornersScore = c.cornersScore ?? c.gradeCorners ?? null;
      const edgesScore = c.edgesScore ?? c.gradeEdges ?? null;
      const surfaceScore = c.surfaceScore ?? c.gradeSurface ?? null;
      const overallGrade = c.gradeOverall ?? null;
      const missing: string[] = [];
      if (centeringScore == null) missing.push("centering");
      if (cornersScore == null) missing.push("corners");
      if (edgesScore == null) missing.push("edges");
      if (surfaceScore == null) missing.push("surface");
      if (missing.length > 0) {
        return res.status(422).json({
          error: `Set all four subgrades before generating description. Missing: ${missing.join(", ")}`,
        });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

      // Confirmed defects (admin-curated). Skip ai_defect_candidates — those
      // are unconfirmed suggestions.
      const defects = Array.isArray(c.defects) ? (c.defects as Array<Record<string, unknown>>) : [];
      const defectLines =
        defects.length === 0
          ? "none"
          : defects
              .map((d) => {
                const loc = d.location || d.image_side || "front";
                const type = d.type || "defect";
                const sev = d.severity || "minor";
                return `${loc} ${type} (${sev})`;
              })
              .join("; ");

      const overallLabel =
        typeof overallGrade === "number" || (typeof overallGrade === "string" && /^\d/.test(overallGrade))
          ? gradeLabel(typeof overallGrade === "number" ? overallGrade : parseFloat(String(overallGrade)))
          : overallGrade || "—";

      const certIdStr = normalizeCertId(cert.certId);
      const cardName = c.cardName || "Unknown card";
      const setName = c.setName || "Unknown set";
      const cardNumber = c.cardNumber || "";
      const year = c.year || "";
      const variant = c.variant || "";
      const language = c.language || "English";

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
        return res.status(502).json({ error: "Claude API call failed" });
      }
      if (!anthRes.ok) {
        const errText = await anthRes.text();
        console.error("[claude] upstream error", anthRes.status, errText.slice(0, 500));
        return res.status(502).json({ error: "AI service error" });
      }
      const data = (await anthRes.json()) as Record<string, unknown>;
      const content = data.content as Array<{ type: string; text?: string }> | undefined;
      const textBlock = content?.find((b) => b.type === "text");
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
          ${(req as any).adminUser?.email || "admin"},
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
      sendServerError(res, err);
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
      if (!side || !["front", "back"].includes(side))
        return res.status(400).json({ error: "side must be front or back" });

      const c = cert as any;
      const origKey =
        side === "front" ? c.gradingFrontOriginal || c.frontImagePath : c.gradingBackOriginal || c.backImagePath;
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
      res.json({ ok: false, message: "Detection failed" });
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
        for (const col of [
          "frontImagePath",
          "gradingFrontOriginal",
          "gradingFrontCropped",
          "gradingFrontGreyscale",
          "gradingFrontHighcontrast",
          "gradingFrontEdgeenhanced",
          "gradingFrontInverted",
        ]) {
          if (c[col]) keysToDelete.push(c[col]);
        }
        colsToClear.push(
          "front_image_path",
          "grading_front_original",
          "grading_front_cropped",
          "grading_front_greyscale",
          "grading_front_highcontrast",
          "grading_front_edgeenhanced",
          "grading_front_inverted"
        );
      } else {
        for (const col of [
          "backImagePath",
          "gradingBackOriginal",
          "gradingBackCropped",
          "gradingBackGreyscale",
          "gradingBackHighcontrast",
          "gradingBackEdgeenhanced",
          "gradingBackInverted",
        ]) {
          if (c[col]) keysToDelete.push(c[col]);
        }
        colsToClear.push(
          "back_image_path",
          "grading_back_original",
          "grading_back_cropped",
          "grading_back_greyscale",
          "grading_back_highcontrast",
          "grading_back_edgeenhanced",
          "grading_back_inverted"
        );
      }

      // Clear DB columns FIRST — the database is the source of truth. Only once
      // the record no longer references these keys do we delete the R2 objects,
      // so a failed R2 cleanup leaves harmless orphans rather than the DB
      // pointing at keys that no longer exist.
      const setClauses = colsToClear.map((col) => `${col} = NULL`).join(", ");
      await db.execute(sql.raw(`UPDATE certificates SET ${setClauses}, updated_at = NOW() WHERE id = ${id}`));

      // Best-effort R2 cleanup (non-fatal — an orphaned object is harmless).
      for (const key of keysToDelete) {
        try {
          await deleteFromR2(key);
        } catch {
          /* ignore missing keys */
        }
      }

      console.log(`[image-delete] cert ${certIdStr} removed ${side} (${keysToDelete.length} R2 keys)`);

      const updated = await storage.getCertificate(id);
      res.json({ ok: true, cert: updated ? { ...updated, certId: normalizeCertId(updated.certId) } : null });
    } catch (err: any) {
      console.error("[image-delete] error:", err.message);
      sendServerError(res, err);
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
        front_original: c.gradingFrontOriginal || c.frontImagePath || null,
        front_cropped: c.gradingFrontCropped || null,
        front_greyscale: c.gradingFrontGreyscale || null,
        front_highcontrast: c.gradingFrontHighcontrast || null,
        front_edgeenhanced: c.gradingFrontEdgeenhanced || null,
        front_inverted: c.gradingFrontInverted || null,
        back_original: c.gradingBackOriginal || c.backImagePath || null,
        back_cropped: c.gradingBackCropped || null,
        back_greyscale: c.gradingBackGreyscale || null,
        back_highcontrast: c.gradingBackHighcontrast || null,
        back_edgeenhanced: c.gradingBackEdgeenhanced || null,
        back_inverted: c.gradingBackInverted || null,
        angled_original: c.gradingAngledOriginal || null,
        angled_cropped: c.gradingAngledCropped || null,
        closeup_original: c.gradingCloseupOriginal || null,
        closeup_cropped: c.gradingCloseupCropped || null,
        // Viewer derivatives (1600px q80). Fallback chain keeps certs that
        // predate the derivative pipeline working: full-res cropped → legacy
        // display path.
        front_display: c.gradingFrontDisplay || c.gradingFrontCropped || c.frontImagePath || null,
        back_display: c.gradingBackDisplay || c.gradingBackCropped || c.backImagePath || null,
      };

      const urls: Record<string, string | null> = {};
      await Promise.all(
        Object.entries(imageKeys).map(async ([k, key]) => {
          if (!key) {
            urls[k] = null;
            return;
          }
          try {
            urls[k] = await getR2SignedUrl(key, 3600);
          } catch {
            urls[k] = null;
          }
        })
      );

      // New scanner evidence has a native-geometry browser working asset in
      // the additive ledger. It is intentionally distinct from both the TIFF
      // master and the 1600px display derivative. Absence is normal for
      // legacy JPEG-only certificates.
      try {
        const evidence = (
          await db.execute(sql`
            SELECT side, working_object_key
            FROM certificate_image_evidence
            WHERE certificate_id = ${id}
              AND evidence_class = 'NEW_IMMUTABLE_MASTER'
              AND is_current = true
          `)
        ).rows as Array<{ side: string; working_object_key: string | null }>;
        await Promise.all(
          evidence.map(async (row) => {
            if ((row.side !== "front" && row.side !== "back") || !row.working_object_key) return;
            try {
              urls[`${row.side}_working`] = await getR2SignedUrl(row.working_object_key, 3600);
            } catch {
              urls[`${row.side}_working`] = null;
            }
          })
        );
      } catch {
        // The table is introduced additively; retain legacy compatibility
        // during rolling deployment or for records without a master.
      }

      const quality = c.imageQualityChecks || {};
      res.json({ urls, quality });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get images" });
    }
  });

  // ── Build 2: Manual grading endpoints ─────────────────────────────────────

  // GET grading data for a certificate
  app.get("/api/admin/certificates/:id/grading", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      let cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });
      // Card IDENTIFICATION is deferred off the scan path. If it hasn't run, compute
      // it NOW (bounded ~20s) and re-read so it's present on first paint — never
      // silently absent until refresh. Fails gracefully.
      // Per-device AI-identify toggle: the client sends ?aiIdentify=0 when OFF, which
      // SKIPS the identify call entirely (grader/admin enters the identity manually).
      const aiIdentifyOff = req.query.aiIdentify === "0";
      const existingAi = (cert as any).aiAnalysis;
      if (!aiIdentifyOff && (!existingAi || (typeof existingAi === "object" && Object.keys(existingAi).length === 0))) {
        const { ensureAiDraft } = await import("./scan-ingest-service");
        await ensureAiDraft(id);
        cert = (await storage.getCertificate(id)) ?? cert;
      }
      // Self-heal a card_name clobbered to "" from the confirmed identify snapshot
      // (deterministic, no AI re-run). Re-read so first paint shows the real name.
      if (!aiIdentifyOff && (!(cert as any).cardName || String((cert as any).cardName).trim() === "")) {
        const { repairEmptyIdentityFromSnapshot } = await import("./scan-ingest-service");
        if (await repairEmptyIdentityFromSnapshot(id)) {
          cert = (await storage.getCertificate(id)) ?? cert;
        }
      }
      const c = cert as any;
      res.json({
        centeringFrontLr: c.centeringFrontLr || null,
        centeringFrontTb: c.centeringFrontTb || null,
        centeringBackLr: c.centeringBackLr || null,
        centeringBackTb: c.centeringBackTb || null,
        centeringOuterFront: c.centeringOuterFront || null,
        centeringInnerFront: c.centeringInnerFront || null,
        centeringOuterBack: c.centeringOuterBack || null,
        centeringInnerBack: c.centeringInnerBack || null,
        centeringMethod: c.centeringMethod || null,
        // Per-zone JSONB columns (now exposed via schema — was returning null
        // pre-v408 because Drizzle didn't know about these columns).
        corners: c.cornerValues || null,
        edges: c.edgeValues || null,
        surface: c.surfaceValues || null,
        defects: c.defects || [],
        authStatus: c.authStatus || "genuine",
        authNotes: c.authNotes || "",
        gradeExplanation: c.gradeExplanation || "",
        privateNotes: c.privateNotes || "",
        // Server-authoritative token used by the canonical preview → approval
        // compare-and-swap. Hydration must expose it before any persisted-card
        // preview is allowed to render.
        reviewRevision: c.gradingRevision ?? 1,
        gradeApprovedBy: c.gradeApprovedBy || null,
        gradeApprovedAt: c.gradeApprovedAt || null,
        gradeStrengthScore: c.gradeStrengthScore ?? null,
        // MVGS admin inputs — hydrated into grading-panel local state on load.
        // Legacy darkBorder is preserved for old clients; new clients read
        // darkBorderFront / darkBorderBack and fall back to darkBorder.
        darkBorder: !!c.darkBorder,
        darkBorderFront: (c as any).darkBorderFront ?? !!c.darkBorder,
        darkBorderBack: (c as any).darkBorderBack ?? !!c.darkBorder,
        eyeAppealModifier: Number(c.eyeAppealModifier ?? 0) || 0,
        // MVGS v2 measurement inputs — hydrated into grading-panel state on
        // load. Engine consumes them via shared/mvgs-input-builder.ts; the
        // legacy hasCrease/hasTear booleans on surfaceValues stay as a
        // fallback when these are null/empty.
        whiteningLines: Array.isArray(c.whiteningLines) ? c.whiteningLines : [],
        // v2.1 — multi-crease list. Hydrates direct into creaseLines state;
        // grading-panel synthesises a legacy single-entry from
        // creaseSpanPct when this is empty AND the legacy column is set
        // (preserves the persisted span% on pre-2.1 rows).
        creaseLines: Array.isArray((c as any).creaseLines) ? (c as any).creaseLines : [],
        creaseSpanPct: c.creaseSpanPct != null ? Number(c.creaseSpanPct) : null,
        wrinkleSeverity: c.wrinkleSeverity ?? null,
        tearSeverity: c.tearSeverity ?? null,
        // Saved aggregate subgrades for hydration on reload. Field names below
        // come straight from the schema (gradeCorners/gradeEdges/gradeSurface
        // map to corners_score/edges_score/surface_score). Pre-v408 the
        // handler accessed c.cornersScore (undefined — no such schema field),
        // falling through to (c as any).corners_score (also undefined since
        // Drizzle returns camelCase JS keys, not snake_case), so scores never
        // round-tripped on reload.
        centeringScore: c.gradeCentering ?? null,
        cornersScore: c.gradeCorners ?? null,
        edgesScore: c.gradeEdges ?? null,
        surfaceScore: c.gradeSurface ?? null,
        grade: c.gradeOverall ?? null,
        aiDraftGrade: c.aiDraftGrade ?? null,
        // Full AI analysis JSONB — under Option B this only contains the
        // identification payload (no `grading` key on new scans). Legacy
        // certs may still have `grading` here; the client ignores it.
        aiAnalysis: c.aiAnalysis ?? (c as any).ai_analysis ?? null,
        // Option B: Haiku-suggested defects from scan-ingest, awaiting admin
        // confirm/reject. Distinct from the persisted `defects` array.
        aiDefectCandidates: c.aiDefectCandidates ?? (c as any).ai_defect_candidates ?? [],
      });
    } catch (error: any) {
      sendServerError(res, error);
    }
  });

  // POST manual card-identity override — admin/review context. For cards that
  // never auto-identify (no TCG match) OR whose auto-ID was wrong/empty, an admin
  // sets the real name/set/year by hand. Authoritative: OVERWRITES the columns,
  // stamps ai_analysis.manual_override (who/when), clears the "needs review" flag,
  // and writes an audit row. The corrected name then flows to the operator's
  // /staff view and the public cert page (both read card_name directly).
  app.post("/api/admin/certificates/:id/identity-override", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid certificate id" });
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const b = req.body || {};
      const cardName = typeof b.card_name === "string" ? b.card_name.trim() : "";
      if (!cardName) return res.status(400).json({ error: "card_name is required" });
      const setName = typeof b.set_name === "string" ? b.set_name.trim() : null;
      const yearText = typeof b.year_text === "string" ? b.year_text.trim() : null;
      // card_number_display is text (Pokémon numbers are strings: "037",
      // "037/091", "TG12/TG30", "SV001") — never an integer.
      const cardNumber = typeof b.card_number_display === "string" ? b.card_number_display.trim() : null;
      // variant/finish — stored as the canonical label text (e.g. "Holo"), same as
      // the grader identity editor and the admin form.
      const variant = typeof b.variant === "string" ? b.variant.trim() : null;

      const adminEmail = (req.session as any)?.adminEmail || "admin";
      const c = cert as any;
      const before = {
        card_name: c.cardName ?? null,
        set_name: c.setName ?? null,
        year_text: c.year ?? null,
        card_number_display: c.cardNumber ?? null,
        variant: c.variant ?? null,
      };
      const after = {
        card_name: cardName,
        set_name: setName,
        year_text: yearText,
        card_number_display: cardNumber,
        variant,
      };
      // Only overwrite optional fields when the admin actually supplied them
      // (empty input → keep the existing column value, never wipe).
      const overrideMeta = JSON.stringify({ by: adminEmail, at: new Date().toISOString() });
      await db.execute(sql`
        UPDATE certificates SET
          card_name           = ${cardName},
          set_name            = ${setName == null ? sql`set_name` : sql`${setName}`},
          year_text           = ${yearText == null ? sql`year_text` : sql`${yearText}`},
          card_number_display = ${cardNumber == null ? sql`card_number_display` : sql`${cardNumber}`},
          variant             = ${variant == null ? sql`variant` : sql`${variant}`},
          ai_analysis = jsonb_set(
            jsonb_set(COALESCE(ai_analysis, '{}'::jsonb), '{manual_override}', ${overrideMeta}::jsonb, true),
            '{needs_identification_review}', 'false'::jsonb, true
          ),
          updated_at = NOW()
        WHERE id = ${id}
      `);
      // CRITICAL — make the corrected identity reach the SLAB. The label render
      // (applyLabelOverrides) prefers a per-cert label_overrides row's
      // cardName/set/variant over the cert columns; a stale one would silently
      // hide this correction on the slab/PDF. An authoritative identity override
      // supersedes any display override, so clear it. (card_number_display has no
      // label-override layer — it always renders from the column.) Best-effort.
      try {
        await storage.clearLabelOverride(String(c.certId));
      } catch (e: any) {
        console.warn(`[identity-override] clearLabelOverride failed for ${c.certId}: ${e?.message}`);
      }
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('certificate', ${String(id)}, 'identity_manual_override', ${adminEmail},
          ${JSON.stringify({ before, after })}::jsonb, NOW())
      `);
      console.log(
        `[identity-override] cert=${id} by ${adminEmail}: card_name="${cardName}" #${cardNumber ?? "—"} variant="${variant ?? "—"}"`
      );
      return res.json({ ok: true, card_name: cardName, set_name: setName, card_number_display: cardNumber, variant });
    } catch (error: any) {
      console.error("[identity-override] error:", error.message);
      return sendServerError(res, error);
    }
  });

  // PUT save draft grading data
  app.put("/api/admin/certificates/:id/grade", requireAdmin, handleCertificateGradeUpdate);

  // PUT approve grade — finalises, creates grading_session
  app.put("/api/admin/certificates/:id/approve", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const expectedRevision = expectedReviewRevision((req.body ?? {}).expectedRevision);
      if (expectedRevision == null) {
        return res.status(400).json({ error: "A valid expectedRevision is required to approve this card" });
      }
      const cert = await storage.getCertificate(id);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      // Restricted-grader lock — see /grade handler. Admin publishes a
      // grader-assigned card via POST /api/admin/submissions/:id/approve-grade.
      if (await isGraderLocked(id)) return res.status(409).json({ error: "This card is assigned to a grader" });

      const b = req.body;
      const overallGrade = b.overall_grade;
      // ── OWNER-AUTHORISED REPAIR (2026-08-11) — STORED-GRADE APPROVAL AUTHORITY ──
      // Which kind of certificate this is comes from the STORED row, never the
      // request. The approval UPDATE below persists no certificate-facing field,
      // so the request's `overall_grade` is not what gets published — gating on it
      // let a payload-supplied grade satisfy the publish gates while the stored
      // `grade` column was still NULL, producing an `active` certificate with no
      // grade (which the label renderer prints as "0/POOR"). The request kind is
      // still compared against the stored kind further below by rejectKindChange,
      // which is the anti-conversion guard; this constant is the publish authority.
      const isNonNum = kindOfGradeType((cert as { gradeType?: string | null }).gradeType) !== "numeric";

      // P0 preservation helpers — see /grade handler for rationale.
      const num = (v: unknown): number | null => {
        if (v == null || v === "") return null;
        const n = typeof v === "number" ? v : parseFloat(String(v));
        return isNaN(n) ? null : n;
      };
      const txt = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
      const jsn = (v: unknown): string | null => (v != null ? JSON.stringify(v) : null);

      // STRICT parse for the published overall grade only (sub-grades keep num(), and
      // are COALESCE-protected anyway). num() is parseFloat-based, i.e. a *prefix*
      // parser: "7.5abc" -> 7.5 and [8] -> 8, so a malformed payload could publish a
      // grade the operator never entered. Number() on a string plus an explicit type
      // check rejects both. Every legitimate value (a JS number, or a numeric string
      // such as "8", "8.0", " 8.5 ") still parses identically.
      const strictGrade = (v: unknown): number | null => {
        if (typeof v === "number") return Number.isFinite(v) ? v : null;
        if (typeof v !== "string") return null;
        const t = v.trim();
        // Plain decimal only. Number() also accepts hex ("0x0A" -> 10), binary and
        // exponent forms, none of which any client sends for a card grade.
        if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      };
      // The four values the publish gates below validate, and the ONLY values this
      // route can publish, all read from the authoritative stored row. strictGrade
      // still guards the shape, so a malformed legacy persisted value fails closed
      // instead of being published.
      const certRow = cert as {
        gradeOverall?: unknown;
        gradeCentering?: unknown;
        gradeCorners?: unknown;
        gradeEdges?: unknown;
        gradeSurface?: unknown;
      };
      const storedGrade = isNonNum ? null : strictGrade(certRow.gradeOverall);
      const storedCentering = isNonNum ? null : num(certRow.gradeCentering);
      const storedCorners = isNonNum ? null : num(certRow.gradeCorners);
      const storedEdges = isNonNum ? null : num(certRow.gradeEdges);
      const storedSurface = isNonNum ? null : num(certRow.gradeSurface);

      // Grading time (admin opens the grading workstation → clicks Approve).
      // Capped at 1800s (30 min) to keep the dashboard average representative —
      // anything longer is almost certainly a coffee break / tab left open.
      const rawTime = Number(b.grading_time_seconds);
      const clampedTime = Number.isFinite(rawTime) && rawTime > 0 ? Math.min(1800, Math.round(rawTime)) : null;

      // B3 completeness gate (owner-approved 2026-07-02): the MVGS overall
      // grade is COMPUTED FROM the four sub-grades, so a numeric grade must
      // never publish with any of them blank — sub-grades come automatically
      // from the MVGS workstation and must all be present here. Non-numeric
      // grades (NO/AA) are exempt (their sub-grades are NULL by design).
      // Gate only — no scoring, weights, or formula logic is touched.
      // ── OWNER-AUTHORISED REPAIR (2026-08-11) — ONE SHARED PRINTABILITY AUTHORITY ──
      //
      // This route used to re-derive its own publish rules while its sibling
      // (approveGraderCert / the auto-publish path) used the shared
      // checkGradePublishGates -> checkPrintableGrade. Two authorities meant two
      // answers, and hostile review found the gap: this route decides "is it
      // non-numeric?" with kindOfGradeType, which TRIMS and accepts legacy long
      // forms, and then skips every gate for a non-numeric kind. So
      //   • grade_type 'NO' WITH a stored numeric grade published here but is a
      //     kind_grade_contradiction — unprintable, and refused by the sibling; and
      //   • a padded ' NO ' published with a NULL grade, while the renderer's EXACT
      //     predicate reads it as numeric-with-no-grade and prints "0 / POOR".
      // Both produce a PUBLISHED certificate that cannot legitimately print — the
      // MV205 defect class, on the one path that had not adopted the shared rule.
      //
      // checkGradePublishGates reads the STORED row (never the request), applies the
      // B3 four-sub-grade completeness rule and then the renderer's own
      // checkPrintableGrade. The business rule is unchanged — this deletes a
      // divergent copy of it, it does not add or relax anything, and no threshold,
      // ladder or scoring logic is touched.
      const publishGate = await checkGradePublishGates(id);
      if (!publishGate.ok) {
        return res.status(publishGate.status).json({ error: publishGate.error, code: publishGate.code });
      }

      // Overall-grade presence gate. The B3 gate above only inspects sub-grades, so a
      // payload carrying sub-grades but no parseable `overall_grade` used to reach the
      // UPDATE with gradeNum === null and silently NULL out a published grade (MV205,
      // 2026-07-25: an empty `{}` body returned 200 and erased a stored 8.0). Reject the
      // malformed payload instead of erasing the value. Non-numeric grades (NO/AA) are
      // exempt by design — their `grade` column is NULL. Gate only: no scoring, weights,
      // or formula logic is touched.
      // isValidNumericGrade (the repo's existing predicate, already used by the other
      // grade write paths at ~L3884/L4122) rather than a bare null check: num() is a
      // prefix parser, so "7.5abc" -> 7.5, "1e2" -> 100, [8] -> 8, and 0/-5/Infinity
      // all pass a presence-only test. Verified before adopting: every grade the MVGS
      // engine can emit is a member of NUMERIC_GRADE_VALUES, and neither staging nor
      // production holds a single off-ladder grade, so no legitimate re-approval is
      // newly rejected. Membership check only — no scoring or formula logic.
      // OWNER-AUTHORISED REPAIR (2026-08-11): this gate now inspects the STORED
      // grade. Previously it inspected the request payload while the UPDATE below
      // persisted nothing from that payload, so `{"overall_grade":9,...}` published
      // a certificate whose stored `grade` was still NULL — and a NULL grade renders
      // as "0/POOR" on the printed label. The grade that is validated here is now
      // exactly the grade that gets published.
      // RETAINED IN ADDITION to the shared gate above, because it enforces something
      // checkPrintableGrade deliberately does not: LADDER MEMBERSHIP. checkPrintableGrade
      // answers "can this print?", which an off-ladder value like 7.3 technically can.
      // This answers "is it a grade MintVault issues?" — membership only, no scoring.
      // Still read from the STORED row, never the request.
      if (!isNonNum && (storedGrade == null || !isValidNumericGrade(storedGrade))) {
        return res.status(400).json({
          error:
            "Cannot approve: this card has no valid saved overall grade (1–10, half grades allowed). Save the grade in the grading workstation first, then approve — approval publishes the saved grade, not the one on screen.",
        });
      }

      // ── LOCKED BUSINESS RULE (owner-approved 2026-07-25): normal approval may NOT
      // convert a certificate between numeric and authentication-only ────────────
      // `isNonNum` above is derived SOLELY from the client-sent overall_grade, so a
      // one-key payload (`{"overall_grade":"NO"}`) previously took the gate-exempt
      // branch and cleared a published numeric grade plus all four sub-grades with a
      // 200. The canonical STORED record — not the request — decides which kind of
      // certificate this is. A numeric→authentication-only conversion must be an
      // explicit, separately-confirmed, audited Super Admin action; this route is not
      // that action.
      //
      // Fail closed in BOTH directions: the requested kind must match the stored
      // kind, and for an already-authentication-only record the exact canonical token
      // must match too (NO and AA print differently). Legacy long-form aliases are
      // handled by isNonNumericGrade. Comparison only — no scoring, weighting or
      // formula logic is touched, and grade_type is never changed by this route.
      const storedGradeType = normaliseGradeType((cert as { gradeType?: string | null }).gradeType);
      const requestedKind = kindOfOverallGrade(overallGrade);
      // Approval may NEVER change the kind (allowChangeWhenUnapproved: false).
      const kindRejection = rejectKindChange({
        storedGradeType,
        requestedKind,
        isApproved: (cert as { gradeApprovedAt?: unknown }).gradeApprovedAt != null,
        allowChangeWhenUnapproved: false,
      });
      if (kindRejection) {
        // Audited: an attempted violation of the locked rule must not be silent.
        try {
          await storage.writeAuditLog(
            "certificate",
            String((cert as { certId?: string }).certId ?? id),
            "approval_kind_change_rejected",
            (req.session as { adminEmail?: string })?.adminEmail || "admin",
            { stored_grade_type: storedGradeType, requested_kind: requestedKind, route: "approve" }
          );
        } catch (auditErr) {
          console.warn("[approve] kind-rejection audit failed:", (auditErr as Error).message);
        }
        return res.status(400).json({ error: kindRejection });
      }

      // (The former "did the admin change the grade here?" comparison has been
      // removed: approval is a state transition only and can no longer alter the
      // grade, so the AI strength score can never be invalidated by this route.)

      // Pristine 10P / black label — shared gate (one source of truth with the
      // client panel and the approve-grade route). Mirror that route: run MVGS
      // on the final state so the gate sees raw per-category deductions, not
      // just the subgrade chips. A card with e.g. corners -1.5 must NOT be
      // flagged Pristine even if its corners subgrade rounds to 10.
      let blackDeductions: Record<string, number> | undefined;
      if (!isNonNum) {
        // Same scoreMvgsV2 + calibration plumbing as the grade-card route.
        // Engine input goes through buildMvgsInput so the legacy
        // hasCrease/hasTear booleans are only consulted when the v2
        // measurement (creaseSpanPct / tearSeverity) is null.
        const { scoreMvgsV2 } = await import("@shared/mvgs-input-builder");
        const { loadMvgsCalibration } = await import("./lib/mvgs-calibration");
        // OWNER-AUTHORISED REPAIR (2026-08-11): every engine input now reads the
        // STORED row. The body-preferred fallbacks that used to sit here let an
        // approval payload steer the Pristine/black-label gate toward a tier the
        // saved record does not support. Approval publishes stored state, so the
        // tier must be derived from exactly that state. The scoreMvgsV2 call and
        // the isBlackLabel gate below are UNCHANGED — no scoring, weighting,
        // threshold or calibration logic is touched, only which row feeds them.
        const certAny = cert as any;
        const storedDefects: any[] = Array.isArray(certAny.defects) ? certAny.defects : [];
        const mvgsPins = storedDefects
          .filter((d: any) => d?.mvgsCode && d?.tier && d?.zone)
          .map((d: any) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) }));
        const calibration = await loadMvgsCalibration();
        const certSurface = (certAny.surfaceValues as any) ?? {};
        const r = scoreMvgsV2(
          {
            centeringFrontLr: certAny.centeringFrontLr ?? null,
            centeringFrontTb: certAny.centeringFrontTb ?? null,
            centeringBackLr: certAny.centeringBackLr ?? null,
            centeringBackTb: certAny.centeringBackTb ?? null,
            defects: mvgsPins,
            darkBorderFront: certAny.darkBorderFront ?? !!certAny.darkBorder,
            darkBorderBack: certAny.darkBorderBack ?? !!certAny.darkBorder,
            eyeAppealModifier: Number(certAny.eyeAppealModifier ?? 0) || 0,
            whiteningLines: Array.isArray(certAny.whiteningLines) ? certAny.whiteningLines : null,
            // v2.1 — multi-crease list. Engine input is max(spanPct) at the
            // builder boundary. creaseSpanPct legacy field kept as fallback.
            creaseLines: Array.isArray(certAny.creaseLines) ? certAny.creaseLines : null,
            creaseSpanPct: certAny.creaseSpanPct != null ? Number(certAny.creaseSpanPct) : null,
            wrinkleSeverity: certAny.wrinkleSeverity ?? null,
            tearSeverity: certAny.tearSeverity ?? null,
            hasCrease: !!certSurface.hasCrease,
            hasTear: !!certSurface.hasTear,
          },
          calibration
        );
        blackDeductions = r.deductions;
      }
      const labelType =
        !isNonNum &&
        isBlackLabel(
          {
            centering: storedCentering ?? -1,
            corners: storedCorners ?? -1,
            edges: storedEdges ?? -1,
            surface: storedSurface ?? -1,
          },
          storedGrade ?? -1,
          blackDeductions
        )
          ? "black"
          : "Standard";

      // The final mutation is the CAS claim. All success-side effects below
      // (grading session/audit/cache work) run only after this exact prepared
      // revision is still current. This closes the Reviewer-A/Reviewer-B race
      // for the unrestricted Super Admin path as well as pending review.
      const approvalWrite = await db.execute(sql`
        UPDATE certificates SET
          -- Approval is a state transition only. The canonical Grade → Review
          -- barrier persisted and rendered this exact row already; allowing an
          -- approval payload to rewrite certificate-facing fields here would
          -- let it publish content the reviewer never inspected.
          grade_approved_by   = ${(req.session as any)?.adminEmail || "admin"},
          grade_approved_at   = NOW(),
          status              = 'active',
          -- Print workflow: approval atomically enters Needs Printing (no regression).
          print_state         = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END,
          updated_at          = NOW()
        WHERE id = ${id}
          AND grade_approved_at IS NULL
          AND grading_revision = ${expectedRevision}
        RETURNING id
      `);
      if (approvalWrite.rows.length === 0) {
        return res.status(409).json({
          code: "STALE_REVIEW",
          error: "This card changed after your review was prepared. Refresh the saved review before approving.",
        });
      }

      // Log to grading_sessions. grading_duration_seconds also feeds the
      // existing /api/admin/learning/overview avg_seconds metric — finally
      // populating it after months of empty "—".
      try {
        await db.execute(sql`
          INSERT INTO grading_sessions (cert_id, completed_at, grader, final_grade, ai_response, notes, model_version, grading_duration_seconds)
          VALUES (
            ${cert.certId},
            NOW(),
            ${(req.session as any)?.adminEmail || "admin"},
            ${cert.gradeOverall ?? null},
            ${cert.defects ? JSON.stringify(cert.defects) : null}::jsonb,
            ${(cert as any).privateNotes || null},
            'claude-haiku-4-5-20251001',
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
      await storage.writeAuditLog(
        "certificate",
        cert.certId,
        "approve_and_publish",
        req.session.adminEmail || "admin",
        {
          overall: cert.gradeOverall ?? null,
          labelType: cert.labelType ?? null,
          was_ai_drafted: wasAiDrafted,
        }
      );

      // Log AI vs human comparison if an AI draft grade exists for this certificate
      if (cert.aiDraftGrade != null && cert.gradeOverall != null) {
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
              ${aiAnalysis.corners?.subgrade != null ? String(aiAnalysis.corners.subgrade) : null},
              ${aiAnalysis.edges?.subgrade != null ? String(aiAnalysis.edges.subgrade) : null},
              ${aiAnalysis.surface?.subgrade != null ? String(aiAnalysis.surface.subgrade) : null},
              ${Math.round(Number(cert.gradeOverall))},
              ${cert.gradeCentering != null ? Math.round(Number(cert.gradeCentering)) : null},
              ${cert.gradeCorners != null ? Math.round(Number(cert.gradeCorners)) : null},
              ${cert.gradeEdges != null ? Math.round(Number(cert.gradeEdges)) : null},
              ${cert.gradeSurface != null ? Math.round(Number(cert.gradeSurface)) : null},
              ${req.session.adminEmail || "admin"}
            )
          `);
        } catch (logErr) {
          console.warn("[approve] ai_grade_corrections insert failed:", logErr);
        }
      }

      // Newly published cert should appear in the homepage showcase without
      // waiting out the 5-min memory cache.
      try {
        const { clearSlabShowcaseCache } = await import("./slab-showcase");
        clearSlabShowcaseCache();
      } catch {
        /* non-fatal */
      }

      // Invalidate share image cache on (re-)grade — next share request
      // regenerates with the new grade. Best-effort, never blocks approve.
      try {
        const shareCertNumber = normalizeCertId(cert.certId);
        await Promise.all([
          deleteFromR2(`public/share/${shareCertNumber}/feed.jpg`).catch(() => {}),
          deleteFromR2(`public/share/${shareCertNumber}/story.jpg`).catch(() => {}),
        ]);
      } catch {
        /* non-fatal */
      }

      const updated = await storage.getCertificate(id);
      res.json(updated ? { ...updated, certId: normalizeCertId(updated.certId) } : {});
    } catch (error: any) {
      console.error("[approve] error:", error.message);
      sendServerError(res, error);
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
      sendServerError(res, err);
    }
  });

  // ── Build 1: Card database lookup ──────────────────────────────────────────
  app.get("/api/admin/card-lookup", requireAdmin, async (req, res) => {
    try {
      const { lookupCard } = await import("./card-database");
      const game = typeof req.query.game === "string" ? req.query.game.trim() : "";
      const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
      const mode = req.query.mode === "wildcard" ? ("wildcard" as const) : ("exact" as const);
      console.log(`[card-lookup] game=${game} query=${query} mode=${mode}`);
      if (!query) return res.status(400).json({ error: "query is required" });
      const results = await lookupCard(game, query, mode);
      res.json(results);
    } catch (error: any) {
      console.error("[card-lookup] error:", error.message);
      res.status(500).json({ error: "Card lookup failed" });
    }
  });

  // ── Build 4: Grading queue endpoints ──────────────────────────────────────

  app.get("/api/admin/grading-queue", requireAdmin, async (req, res) => {
    // Two shapes share this path:
    //  • ?status=<filter>  → rich, PII-FREE admin assignment queue (staff page).
    //  • no param          → legacy in-app grading queue (dashboard Grading tab).
    // Branching on the param keeps the legacy consumer byte-for-byte unchanged.
    const statusParam = typeof req.query.status === "string" ? req.query.status : null;
    const partnerIdParam = typeof req.query.partnerId === "string" ? req.query.partnerId.trim() : "";
    const certIdParam = typeof req.query.certId === "string" ? req.query.certId.trim() : "";
    if (
      partnerIdParam &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(partnerIdParam)
    ) {
      return res.status(400).json({ error: "partnerId must be a Partner UUID" });
    }
    if (
      certIdParam &&
      (!/^\d+$/.test(certIdParam) || !Number.isSafeInteger(Number(certIdParam)) || Number(certIdParam) < 1)
    ) {
      return res.status(400).json({ error: "certId must be a positive numeric certificate id" });
    }

    if (statusParam || partnerIdParam || certIdParam) {
      try {
        const VALID = ["needs_grading", "assigned", "pending_review", "rejected", "all"];
        const f = statusParam && VALID.includes(statusParam) ? statusParam : "all";
        const CAP = 200;
        // Gradeable = BOTH a front and a back source present (display or original).
        const hasImages = sql`((cert.front_image_path IS NOT NULL OR cert.grading_front_original IS NOT NULL) AND (cert.back_image_path IS NOT NULL OR cert.grading_back_original IS NOT NULL))`;
        // Server-side filter per view. Literals are constants (not user input);
        // the only external value (statusParam) is whitelisted above.
        const partnerScope = partnerIdParam ? sql`cert.origin_partner_id = ${partnerIdParam}` : sql`TRUE`;
        // A certId-scoped request is still this guarded, bounded queue read. It guarantees a
        // deterministic Staff deep-link even when the normal 200-row operational view is full.
        const certScope = certIdParam ? sql`cert.id = ${Number(certIdParam)}` : sql`TRUE`;
        const where =
          f === "needs_grading"
            ? sql`cert.deleted_at IS NULL AND cert.grader_status = 'unassigned' AND ${hasImages} AND ${partnerScope} AND ${certScope}`
            : f === "assigned"
              ? sql`cert.deleted_at IS NULL AND cert.grader_status = 'assigned' AND ${partnerScope} AND ${certScope}`
              : f === "pending_review"
                ? sql`cert.deleted_at IS NULL AND cert.grader_status = 'pending_review' AND ${partnerScope} AND ${certScope}`
                : f === "rejected"
                  ? sql`cert.deleted_at IS NULL AND cert.grader_status = 'assigned' AND cert.redo_count > 0 AND ${partnerScope} AND ${certScope}`
                  : sql`cert.deleted_at IS NULL AND cert.grader_status IN ('unassigned','assigned','pending_review') AND ${partnerScope} AND ${certScope}`;
        const rows = await db.execute(sql`
          SELECT cert.id AS cert_id, cert.certificate_number AS cert_id_str, cert.card_name, cert.set_name,
                 cert.card_number_display AS card_number, cert.year_text AS year, cert.language, cert.variant,
                 cert.grader_status, cert.assigned_grader_id, cert.redo_count, cert.rejection_reason,
                 u.email AS grader_email, s.tracking_number AS submission_ref, s.service_tier, s.id AS submission_id,
                 cert.origin_partner_id AS partner_id, partner.legal_name AS partner_name,
                 ${hasImages} AS has_images
          FROM certificates cert
          LEFT JOIN cards c ON cert.card_id = c.id
          LEFT JOIN submissions s ON s.id = c.submission_id
          LEFT JOIN users u ON u.id = cert.assigned_grader_id
          LEFT JOIN partner_organisations partner ON partner.id = cert.origin_partner_id
          WHERE ${where}
          ORDER BY cert.id ASC
          LIMIT ${CAP}
        `);
        const countRes = await db.execute(sql`SELECT COUNT(*)::int AS n FROM certificates cert WHERE ${where}`);
        const total = Number((countRes.rows[0] as any)?.n ?? 0);
        const queue = (rows.rows as any[]).map((r) => ({
          certId: Number(r.cert_id),
          certIdStr: normalizeCertId(r.cert_id_str),
          cardName: r.card_name ?? null,
          setName: r.set_name ?? null,
          cardNumber: r.card_number ?? null,
          year: r.year ?? null,
          language: r.language ?? null,
          serviceTier: r.service_tier ?? null,
          variant: r.variant ?? null,
          graderStatus: r.grader_status ?? "unassigned",
          assignedGraderId: r.assigned_grader_id ?? null,
          assignedGraderEmail: r.grader_email ?? null,
          redoCount: Number(r.redo_count ?? 0),
          rejectionReason: r.rejection_reason ?? null,
          hasImages: !!r.has_images,
          submissionRef: r.submission_ref ?? null,
          submissionId: r.submission_id != null ? Number(r.submission_id) : null,
          partnerId: r.partner_id ?? null,
          partnerName: r.partner_name ?? null,
        }));
        return res.json({ queue, status: f, cap: CAP, total, capped: total > CAP });
      } catch (err: any) {
        return sendServerError(res, err);
      }
    }

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
        id: r.id,
        certId: normalizeCertId(r.cert_id),
        cardName: r.card_name,
        cardSet: r.set_name,
        cardGame: r.card_game,
        createdAt: r.created_at,
        hasImages: !!r.has_images,
        grade: null,
      }));
      res.json(queue);
    } catch (err: any) {
      sendServerError(res, err);
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
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/grading-queue/set-current", requireAdmin, (req, res) => {
    _currentGradingCertId = req.body.certId || null;
    res.json({ ok: true, certId: _currentGradingCertId });
  });

  // ── Build 4: Upload token (phone QR) ──────────────────────────────────────

  // Tokens are STATELESS and signed (server/lib/upload-token.ts). The previous implementation kept a
  // module-level Map, which is per-process: production runs two Fly Machines, and the phone that
  // scans the QR code is a separate client with no affinity to the Machine that minted the token, so
  // roughly half of scans hit a Machine that had never seen it and failed as "invalid or expired".
  app.post("/api/admin/upload-token", requireAdmin, (req, res) => {
    const { certId, imageType } = req.body;
    if (!certId || !imageType) return res.status(400).json({ error: "certId and imageType required" });
    const { token, expiresAt } = generateUploadToken(String(certId), String(imageType));
    const uploadUrl = `${process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS}` : "https://mintvaultuk.com"}/upload/${certId}/${imageType}?token=${token}`;
    res.json({ token, expiresAt: new Date(expiresAt).toISOString(), uploadUrl });
  });

  // ── Build 4: Public phone upload endpoint ─────────────────────────────────

  app.post("/api/upload/:certId/:imageType", phoneUpload.single("image"), async (req, res) => {
    try {
      const { autoCrop, checkImageQuality } = await import("./image-processing");
      const token = req.query.token as string;
      if (!token) return res.status(401).json({ error: "Token required" });

      const certId = String(req.params.certId);
      const imageType = String(req.params.imageType);
      // The target is inside the signed payload, so a token minted for one certificate/side cannot
      // be replayed against another — the separate imageType equality check this replaces could only
      // ever catch half of that, and never the certId. Verification is constant-time and works on
      // EITHER Machine because nothing is stored server-side.
      if (!verifyUploadToken(certId, imageType, token)) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const dbCert = await findCertByIdFlex(certId);
      if (!dbCert) return res.status(404).json({ error: "Certificate not found" });

      if (!req.file) return res.status(400).json({ error: "No image provided" });

      const phoneUploadErr = await rejectInvalidUploads([req.file]);
      if (phoneUploadErr) return res.status(400).json({ error: phoneUploadErr });

      const { buffer: croppedBuf } = await autoCrop(req.file.buffer);
      const key = `grading/${normalizeCertId(dbCert.certId)}/${imageType}_original.jpg`;
      await uploadToR2(key, croppedBuf, "image/jpeg");

      const colMap: Record<string, string> = {
        angled: "grading_angled_original",
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
      sendServerError(res, err);
    }
  });

  // ── Build 4: Hot folder upload ─────────────────────────────────────────────

  app.post("/api/admin/hot-folder-upload", hotFolderUpload.single("front"), async (req, res) => {
    try {
      // Auth: a valid Bearer token (scanner / hot-folder ingest) OR an active admin session.
      const authHeader = req.headers.authorization || "";
      const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
      const validToken = process.env.MINTVAULT_ADMIN_TOKEN;

      // H3 — use the REAL admin session flag. Was `adminAuthenticated`, which is
      // never set anywhere, so a logged-in admin silently fell through to token-only.
      const isSession = (req.session as any)?.isAdmin === true;
      if (!isSession && (!validToken || bearerToken !== validToken)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // H3 — magic-byte validation: reject non-image payloads before the image
      // pipeline touches them (the 50 MB size cap stays on the multer config above).
      if (!req.file || !(await validateImageMagicBytes(req.file))) {
        return res.status(400).json({ error: "Invalid or missing image file" });
      }

      const side = (req.body.side || "front") as "front" | "back";

      // Determine target cert: explicit, else the current queue pointer.
      //
      // There is deliberately NO "first ungraded" fallback. It used to select
      // `ORDER BY created_at ASC LIMIT 1` whenever the target could not be
      // resolved, which silently bound this upload to an ARBITRARY, unrelated
      // certificate — attaching one customer's card photo to another customer's
      // record with a 200 response and no warning. That is reachable in normal
      // operation because `_currentGradingCertId` is in-process state and
      // production runs multiple Fly machines: the admin sets the pointer on one
      // machine and the phone upload lands on another, where it is null.
      //
      // If the target is unknown the only safe answer is to refuse. The caller
      // must pass an explicit certId.
      const certId = req.body.certId || _currentGradingCertId;
      let dbCert: any = null;
      if (certId) {
        dbCert = await findCertByIdFlex(String(certId));
      }
      if (!dbCert) {
        return res.status(400).json({
          error:
            "No target certificate for this upload. Pass an explicit certId — the server will not guess which card an image belongs to.",
        });
      }

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
        await db.execute(
          sql`UPDATE certificates SET front_image_path = ${origKey}, grading_front_original = ${origKey}, updated_at = NOW() WHERE id = ${dbCert.id}`
        );
      } else {
        await db.execute(
          sql`UPDATE certificates SET back_image_path = ${origKey}, grading_back_original = ${origKey}, updated_at = NOW() WHERE id = ${dbCert.id}`
        );
      }

      const signedUrl = await getR2SignedUrl(origKey, 3600);
      res.json({ ok: true, certId: normId, side, imageUrl: signedUrl });
    } catch (err: any) {
      console.error("[hot-folder] error:", err.message);
      sendServerError(res, err);
    }
  });

  // ── Build 5: AI Grading ────────────────────────────────────────────────────

  function getCertImageKeys(c: any): ImageKeys {
    return {
      frontOriginal: c.gradingFrontOriginal || null,
      backOriginal: c.gradingBackOriginal || null,
      frontGreyscale: c.gradingFrontGreyscale || null,
      frontHighcontrast: c.gradingFrontHighcontrast || null,
      backGreyscale: c.gradingBackGreyscale || null,
      backHighcontrast: c.gradingBackHighcontrast || null,
      angledOriginal: c.gradingAngledOriginal || null,
      closeupOriginal: c.gradingCloseupOriginal || null,
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
      sendServerError(res, err);
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
      } catch {
        return res.status(400).json({ error: "Could not fetch front image" });
      }

      // Identify with Claude Haiku
      const rawId = await identifyCardFromBuffer(frontBuf, "image/jpeg");

      // Verify with Pokemon TCG API
      let enrichedId = await verifyAndEnrichCardData(rawId);
      const game = rawId.detected_game?.toLowerCase();
      const tcgVerified = game === "pokemon";
      let tcgResult: any = { verified: false };
      if (game === "pokemon") {
        tcgResult = await verifyPokemonCardWithTcgApi(
          rawId.detected_name,
          rawId.detected_number,
          rawId.detected_rarity,
          rawId.set_code,
          rawId.copyright_year
        );
        if (tcgResult.verified) {
          // Only override enrichedId if it wasn't already verified with a different card name
          const enrichedAlreadyVerified = enrichedId.verified === true;
          const namesAgree =
            !tcgResult.officialCardName ||
            !enrichedId.officialName ||
            normaliseCardName(tcgResult.officialCardName) === normaliseCardName(enrichedId.officialName);
          if (!enrichedAlreadyVerified || namesAgree) {
            enrichedId = {
              ...enrichedId,
              verified: true,
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
            console.log(
              `[override-guard] blocked: enriched="${enrichedId.officialName}" tcg="${tcgResult.officialCardName}" — keeping enriched match`
            );
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
        const setName = verified ? enrichedId.officialSet || enrichedId.detected_set : null;
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
        console.log(
          `[identify-only] wrote to cert ${id}: name=${cardName} set=${setName} number=${cardNumber} year=${yearText} overwrite=${overwrite}`
        );
      } else {
        console.log(`[identify-only] cert ${id}: confidence=${aiConfidence} tcg=${verified} — NOT writing details`);
      }

      const updatedCert = await storage.getCertificate(id);
      res.json({
        identification: enrichedId,
        confidence: aiConfidence,
        tcgVerified: verified,
        detailsWritten: shouldWrite,
        rejectReason: !shouldWrite ? tcgResult.rejectReason || "Low confidence — manual entry needed" : undefined,
        cert: updatedCert ? { ...updatedCert, certId: normalizeCertId(updatedCert.certId) } : null,
      });
    } catch (err: any) {
      console.error("[identify-only] error:", err.message);
      sendServerError(res, err);
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
        try {
          const url = await getR2SignedUrl(key, 300);
          const r = await fetch(url);
          return Buffer.from(await r.arrayBuffer());
        } catch {
          return null;
        }
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
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: backResized.toString("base64") },
        });
      }
      content.push({ type: "text", text: CENTERING_ONLY_PROMPT });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      let response;
      try {
        response = await anthropicFetch(
          { model: "claude-haiku-4-5-20251001", max_tokens: 2048, messages: [{ role: "user", content }] },
          { apiKey, timeoutMs: 30_000 }
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }
      if (!response.ok) throw new Error(`Claude API error ${response.status}`);
      const aiData = (await response.json()) as { content: { text: string }[] };
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

      console.log(
        `[measure-centering] cert=${id} front=${centering.front_left_right} back=${centering.back_left_right}`
      );
      res.json({ centering });
    } catch (err: any) {
      console.error("[measure-centering] error:", err.message);
      sendServerError(res, err);
    }
  });

  // POST /api/admin/certificates/:id/manual-centering — save two-rect manual measurement
  app.post("/api/admin/certificates/:id/manual-centering", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { side, outer, inner } = req.body;
      if (!side || !["front", "back"].includes(side))
        return res.status(400).json({ error: "side must be front or back" });
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
      const lr = lRound >= 100 - lRound ? `${lRound}/${100 - lRound}` : `${100 - lRound}/${lRound}`;
      const tb = tRound >= 100 - tRound ? `${tRound}/${100 - tRound}` : `${100 - tRound}/${tRound}`;

      // Centering subgrade — canonical PSA chart (shared/centering.ts): the
      // worst of the two axes for this side. One source of truth shared with the
      // client ManualCentering panel and computeMvgsScore. Replaces the old
      // side-agnostic worstDev ladder, which mis-scored front cards (a 60/40
      // front is grade 9 on the strict front chart, not the ladder's 8).
      const subgrade = Math.min(centeringAxisGrade(lr, side), centeringAxisGrade(tb, side));

      const outerCol = side === "front" ? "centering_outer_front" : "centering_outer_back";
      const innerCol = side === "front" ? "centering_inner_front" : "centering_inner_back";
      const lrCol = side === "front" ? "centering_front_lr" : "centering_back_lr";
      const tbCol = side === "front" ? "centering_front_tb" : "centering_back_tb";

      // Add new columns if they don't exist yet
      try {
        await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_outer_front JSONB`);
      } catch {}
      try {
        await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_inner_front JSONB`);
      } catch {}
      try {
        await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_outer_back JSONB`);
      } catch {}
      try {
        await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_inner_back JSONB`);
      } catch {}

      // Parameterized — outer/inner/lr/tb/id are BOUND params (never interpolated
      // into SQL text); column names come from the fixed front/back allowlist via
      // sql.identifier. Same columns, values, and WHERE as before — behaviour is
      // identical, injection-class breakout eliminated (cf. H2/H2b).
      await db.execute(sql`
        UPDATE certificates SET
          ${sql.identifier(outerCol)} = ${JSON.stringify(outer)}::jsonb,
          ${sql.identifier(innerCol)} = ${JSON.stringify(inner)}::jsonb,
          ${sql.identifier(lrCol)} = ${lr},
          ${sql.identifier(tbCol)} = ${tb},
          centering_method = 'manual',
          updated_at = NOW()
        WHERE id = ${id}
      `);

      console.log(`[manual-centering] cert=${id} ${side}: L/R=${lr} T/B=${tb} subgrade=${subgrade}`);
      res.json({ lr, tb, subgrade, outer, inner });
    } catch (err: any) {
      console.error("[manual-centering] error:", err.message);
      sendServerError(res, err);
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
        try {
          const url = await getR2SignedUrl(key, 300);
          const r = await fetch(url);
          return Buffer.from(await r.arrayBuffer());
        } catch {
          return null;
        }
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
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: backResized.toString("base64") },
        });
      }
      content.push({ type: "text", text: DEFECTS_ONLY_PROMPT });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      let response;
      try {
        response = await anthropicFetch(
          { model: "claude-haiku-4-5-20251001", max_tokens: 4096, messages: [{ role: "user", content }] },
          { apiKey, timeoutMs: 30_000 }
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }
      if (!response.ok) throw new Error(`Claude API error ${response.status}`);
      const aiData = (await response.json()) as { content: { text: string }[] };
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
          console.log(
            `[defect-filter] rejected defect "${d.type}" at (${x.toFixed(1)}, ${y.toFixed(1)}) — outside card boundary`
          );
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

      console.log(
        `[detect-defects] cert=${id} defects=${filtered.length} (${rawCount - filtered.length} filtered out)`
      );
      res.json({ defects: filtered });
    } catch (err: any) {
      console.error("[detect-defects] error:", err.message);
      sendServerError(res, err);
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

      const prompt = GRADE_ONLY_PROMPT.replace("{CARD_CONTEXT}", cardContext)
        .replace("{CENTERING_CONTEXT}", centeringContext)
        .replace("{DEFECTS_CONTEXT}", defectsContext);

      // Also send images for visual context
      const frontKey = c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath;
      const fetchBuf = async (key: string | null): Promise<Buffer | null> => {
        if (!key) return null;
        try {
          const url = await getR2SignedUrl(key, 300);
          const r = await fetch(url);
          return Buffer.from(await r.arrayBuffer());
        } catch {
          return null;
        }
      };
      const frontBuf = await fetchBuf(frontKey);

      const content: object[] = [];
      if (frontBuf) {
        const { resizeForClaude } = await import("./ai-grading-service");
        const { buffer: resized } = await resizeForClaude(frontBuf);
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") },
        });
      }
      content.push({ type: "text", text: prompt });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      let response;
      try {
        response = await anthropicFetch(
          { model: "claude-haiku-4-5-20251001", max_tokens: 2048, messages: [{ role: "user", content }] },
          { apiKey, timeoutMs: 30_000 }
        );
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "AI service timed out. Please try again." });
        }
        throw err;
      }
      if (!response.ok) throw new Error(`Claude API error ${response.status}`);
      const aiResp = (await response.json()) as { content: { text: string }[] };
      const text = aiResp.content?.[0]?.text || "";
      console.log(`[grade-card] raw response (200 chars): ${text.slice(0, 200)}`);
      const gradeResult = extractJson(text, "grade-card");

      // Clamp grades to whole numbers
      const clamp = (v: any) => {
        const n = typeof v === "number" ? v : parseFloat(v);
        return isNaN(n) ? 1 : Math.max(1, Math.min(10, Math.floor(n)));
      };
      if (typeof gradeResult.overall_grade === "number") gradeResult.overall_grade = clamp(gradeResult.overall_grade);
      if (gradeResult.centering_subgrade) gradeResult.centering_subgrade = clamp(gradeResult.centering_subgrade);
      if (gradeResult.corners_subgrade) gradeResult.corners_subgrade = clamp(gradeResult.corners_subgrade);
      if (gradeResult.edges_subgrade) gradeResult.edges_subgrade = clamp(gradeResult.edges_subgrade);
      if (gradeResult.surface_subgrade) gradeResult.surface_subgrade = clamp(gradeResult.surface_subgrade);
      const strength =
        typeof gradeResult.grade_strength_score === "number"
          ? Math.max(0, Math.min(100, Math.round(gradeResult.grade_strength_score)))
          : null;

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
      sendServerError(res, err);
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
      if (!keys.backOriginal) keys.backOriginal = c.backImagePath;

      const cardGame = req.body?.card_game || c.gameType || undefined;
      const analysis = await analyzeCard(keys, cardGame);

      // Persist analysis
      await storage.updateCertificate(id, {
        aiAnalysis: { ...(c.aiAnalysis || {}), grading: analysis } as any,
      });

      res.json({ analysis });
    } catch (err: any) {
      console.error("[ai/analyze] error:", err.message);
      sendServerError(res, err);
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

      // Restricted-grader lock — an admin must not AI-grade a card that's in a
      // grader's workflow. Use the grader approval flow instead.
      if (await isGraderLocked(id)) return res.status(409).json({ error: "This card is assigned to a grader" });

      const c = cert as any;
      const frontKey = c.gradingFrontOriginal || c.frontImagePath;
      const backKey = c.gradingBackOriginal || c.backImagePath;
      if (!frontKey) return res.status(400).json({ error: "No front image — upload images first" });

      const fetchR2 = async (key: string | null): Promise<Buffer | null> => {
        if (!key) return null;
        try {
          const url = await getR2SignedUrl(key, 300);
          const resp = await fetch(url);
          return Buffer.from(await resp.arrayBuffer());
        } catch {
          return null;
        }
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
      const analysis = await analyzeCardFromBuffers(frontVariants.cropped, backVariants?.cropped || null, cardGame, id);

      const cents = typeof analysis.centering?.subgrade === "number" ? analysis.centering.subgrade : null;
      const corners = typeof analysis.corners?.subgrade === "number" ? analysis.corners.subgrade : null;
      const edges = typeof analysis.edges?.subgrade === "number" ? analysis.edges.subgrade : null;
      const surface = typeof analysis.surface?.subgrade === "number" ? analysis.surface.subgrade : null;
      const overall = typeof analysis.overall_grade === "number" ? analysis.overall_grade : null;
      const strength =
        typeof (analysis as any).grade_strength_score === "number"
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
            ${JSON.stringify({ subgrades: { centering: cents, corners, edges, surface }, overall, model_used: "claude-haiku-4-5-20251001", source: "manual_button" })}::jsonb)
        `);
      } catch (e: any) {
        console.warn("[ai/grade] audit failed:", e.message);
      }

      console.log(
        `[ai/grade] cert=${id} centering=${cents} corners=${corners} edges=${edges} surface=${surface} overall=${overall} strength=${strength}`
      );
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
        } catch {
          return null;
        }
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
      // Steps 3+4 (upload variants, save keys) run in parallel with Step 5
      // (identify) — identify only needs the in-memory cropped buffer, and was
      // previously blocked behind 12 R2 uploads it never used.
      const uploadAndSaveKeys = (async () => {
        // Refresh the 1600px viewer derivatives alongside the regenerated
        // crops, otherwise the grading panel keeps showing the stale derivative.
        const { makeDisplayDerivative } = await import("./image-processing");
        if (Buffer.isBuffer(frontVariants.cropped)) {
          const k = `${prefix}/front_display.jpg`;
          uploadKeys["front_display"] = k;
          uploads.push(
            makeDisplayDerivative(frontVariants.cropped)
              .then((b) => uploadToR2(k, b, "image/jpeg"))
              .then(() => {})
          );
        }
        if (backVariants && Buffer.isBuffer(backVariants.cropped)) {
          const k = `${prefix}/back_display.jpg`;
          uploadKeys["back_display"] = k;
          uploads.push(
            makeDisplayDerivative(backVariants.cropped)
              .then((b) => uploadToR2(k, b, "image/jpeg"))
              .then(() => {})
          );
        }
        await Promise.all(uploads);
        console.log(`[ai/identify-and-analyze] uploaded ${uploads.length} image variants to R2`);
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
            grading_front_display = ${uploadKeys.front_display || null},
            grading_back_display = ${uploadKeys.back_display || null},
            updated_at = NOW()
          WHERE id = ${id}
        `);
      })();

      // Step 5: Identify the card (uses cropped front)
      const [identification] = await Promise.all([
        identifyCardFromBuffer(frontVariants.cropped, "image/jpeg"),
        uploadAndSaveKeys,
      ]);

      // Step 7 kicked off early: the grade call only needs detected_game (for
      // the game-specific prompt module), not the TCG enrichment below — so it
      // runs in parallel with Step 6 instead of waiting behind it.
      const game = identification.detected_game?.toLowerCase();
      const analysisPromise = analyzeCardFromBuffers(frontVariants.cropped, backVariants?.cropped || null, game, id);
      analysisPromise.catch(() => {}); // pre-subscribe: avoids unhandled rejection if Step 6 throws first; error still surfaces at the await below

      // Step 6: Pokémon TCG API verification
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
          const namesAgree =
            !tcgResult.officialCardName ||
            !enrichedId.officialName ||
            normaliseCardName(tcgResult.officialCardName) === normaliseCardName(enrichedId.officialName);
          if (!enrichedAlreadyVerified || namesAgree) {
            console.log(
              `[ai/identify-and-analyze] TCG API override: "${identification.detected_set}" → "${tcgResult.officialSetName}" (${tcgResult.apiCardId})`
            );
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
            console.log(
              `[override-guard] blocked: enriched="${enrichedId.officialName}" tcg="${tcgResult.officialCardName}" — keeping enriched match`
            );
          }
        }
        if (tcgResult.trustAi) tcgTrustAiFlag = true;
      }

      // Step 7: Full grading analysis (started above, in parallel with Step 6)
      const analysis = await analysisPromise;

      // Step 8: Extract and log grade strength score
      const strengthScore =
        typeof (analysis as any).grade_strength_score === "number"
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

      const cardName = shouldWriteDetails ? enrichedId.officialName || enrichedId.detected_name || null : null;
      // When trusting AI without TCG verification, leave set_name null for manual entry
      const rawSetName = tcgVerified ? enrichedId.officialSet || enrichedId.detected_set || null : null;
      // Owner ruling (2026-07-06, option B): a designation carried in the official
      // set name ("… Trainer Gallery", "SWSH Black Star Promos") moves OFF the set
      // line — base set stays here, the designation becomes the variant below.
      const setSplit = splitSetDesignation(rawSetName);
      const setName = rawSetName ? setSplit.baseSet : null;
      const cardNumber = shouldWriteDetails ? enrichedId.detected_number || null : null;
      const cardGame = shouldWriteDetails ? enrichedId.detected_game || null : null;
      const rarity = shouldWriteDetails ? enrichedId.detected_rarity || null : null;

      // Variant (finish) vs Rarity are MUTUALLY EXCLUSIVE per card — the front
      // label line 3 shows exactly one (owner rule, enforced in the cert
      // create/update guards). Derive the finish here with the SAME shared logic
      // the browser form uses, then pick ONE line-3 value: a set-name designation
      // outranks a detected finish (more specific product identity); either
      // wins over the detected rarity. This is why AI Identify previously
      // left Variant blank — it was derived on screen but never persisted.
      const finishCode = shouldWriteDetails ? deriveVariantFromIdentification(enrichedId) : "";
      const variantCode = shouldWriteDetails ? setSplit.designation || finishCode : "";
      const variantToWrite: string | null = variantCode || null;
      const rarityToWrite: string | null = variantCode ? null : rarity;
      // A definitive line-3 value exists → assert it (and clear the other slot);
      // if the AI detected neither, leave both fields untouched (non-destructive).
      const hasLine3 = Boolean(variantToWrite || rarityToWrite);

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

      console.log(
        `[ai-identify] cert=${id} confidence=${aiConfidence} tcgVerified=${tcgVerified} shouldWrite=${shouldWriteDetails} overwrite=${overwrite} name=${cardName}, set=${setName}, number=${cardNumber}, year=${yearText}`
      );

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
            variant = CASE WHEN ${hasLine3} THEN ${variantToWrite} ELSE variant END,
            rarity = CASE WHEN ${hasLine3} THEN ${rarityToWrite} ELSE rarity END,
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
            variant = CASE WHEN (variant IS NULL OR variant = '') AND (rarity IS NULL OR rarity = '') THEN ${variantToWrite} ELSE variant END,
            rarity = CASE WHEN (variant IS NULL OR variant = '') AND (rarity IS NULL OR rarity = '') THEN ${rarityToWrite} ELSE rarity END,
            updated_at = NOW()
          WHERE id = ${id}
        `);
      }

      console.log(
        `[ai/identify-and-analyze] complete: cert=${id} card="${cardName}" set="${setName}" grade=${analysis.overall_grade} strength=${strengthScore}`
      );

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
      sendServerError(res, err);
    }
  });

  // ── Unified "Grade with AI" endpoint — auto-crop, identify, grade in one call ──

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
        const uploadErr = await rejectInvalidUploads([frontFile, ...(backFile ? [backFile] : [])]);
        if (uploadErr) return res.status(400).json({ error: uploadErr });
        const certId = req.body.cert_id ? parseInt(req.body.cert_id, 10) : null;
        if (certId !== null && !Number.isFinite(certId)) {
          return res.status(400).json({ error: "Invalid certificate ID" });
        }

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
        res.status(500).json({ error: "Grading failed" });
      }
    }
  );

  // ── Build 6+: Identify card from uploaded image (no cert required) ─────────

  app.post("/api/admin/identify-image", requireAdmin, identifyUpload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    const uploadErr = await rejectInvalidUploads([req.file]);
    if (uploadErr) return res.status(400).json({ error: uploadErr });
    try {
      const result = await identifyCardFromBuffer(req.file.buffer, req.file.mimetype || "image/jpeg");
      res.json(result);
    } catch (err: any) {
      console.error("[ai/identify-image] error:", err.message);
      sendServerError(res, err);
    }
  });

  // ── Build 6: Public tools ──────────────────────────────────────────────────

  // Admin bypass uses the `x-mv-admin-email` request header — body isn't parsed
  // yet when `skip` runs (multer is downstream). Admins hitting the web UI form
  // without the header will share the 5/hour bucket; power use should curl with
  // the header set.

  // GET /api/tools/estimate/credits?email=
  // Owner-bound (PKG-3). An AUTHENTICATED caller always sees ONLY their own
  // balance, derived from the session identity — a conflicting ?email= is ignored,
  // so a logged-in user cannot enumerate another customer's balance. Anonymous
  // callers keep the minimal legacy per-email lookup (rate-limited: a positive
  // balance is the only oracle, and that must be shown to the tool's own user).
  app.get("/api/tools/estimate/credits", lookupRateLimit, async (req, res) => {
    try {
      const result = await getEstimateCreditBalance({
        sessionUserId: (req.session as any)?.userId,
        sessionUserEmail: (req.session as any)?.userEmail,
        queryEmail: (req.query.email as string) || null,
      });
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.json({ credits: result.credits, email: result.email });
    } catch (err: any) {
      console.error("[estimate/credits] error:", err.message);
      res.status(500).json({ error: "Failed to check credits" });
    }
  });

  // POST /api/tools/estimate/checkout  { email, package: "5"|"15"|"100", return_path?: "/tools/centering" }
  app.post("/api/tools/estimate/checkout", async (req, res) => {
    // Ownership is server-derived from the trusted session. For a logged-in buyer
    // we stamp the authenticated user id into metadata so PKG-2 fulfilment binds
    // the purchased credits to their account (users.ai_credits_user_balance). A
    // browser-supplied user_id is never read. Email is retained for the receipt
    // and the legacy anonymous fulfilment path; when authenticated we default it
    // to the session's verified email so the receipt is correct.
    const sessionUserId = (req.session as any)?.userId || null;
    const sessionUserEmail = ((req.session as any)?.userEmail || "").trim().toLowerCase();
    const email = (req.body.email || "").trim().toLowerCase() || sessionUserEmail;
    const pkg = req.body.package as string;
    const returnPath = (req.body.return_path as string) || "/tools/estimate";
    if (!email) return res.status(400).json({ error: "Email required" });
    const pkgInfo = ESTIMATE_PACKAGES[pkg];
    if (!pkgInfo) return res.status(400).json({ error: "Invalid package" });
    try {
      const stripe = await getUncachableStripeClient();
      const origin = (req.headers.origin as string) || APP_BASE_URL;
      const metadata = buildEstimateCheckoutMetadata({ sessionUserId, email, credits: pkgInfo.credits });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: email,
        line_items: [
          {
            price_data: {
              currency: "gbp",
              product_data: {
                name: `MintVault Pre-Grade Estimates — ${pkgInfo.label}`,
                description: `${pkgInfo.credits} AI pre-grading estimates for your trading cards`,
              },
              unit_amount: pkgInfo.pricePence,
            },
            quantity: 1,
          },
        ],
        metadata,
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
      const uploadErr = await rejectInvalidUploads([req.file]);
      if (uploadErr) return res.status(400).json({ error: uploadErr });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      console.log("[tools/estimate] ANTHROPIC_API_KEY present:", !!apiKey, "| length:", apiKey?.length ?? 0);
      if (!apiKey) {
        console.error(
          "[tools/estimate] CRITICAL: ANTHROPIC_API_KEY secret missing. Run: flyctl secrets set ANTHROPIC_API_KEY=sk-ant-... -a <app-name>"
        );
        return res.status(503).json({ error: "AI service is temporarily unavailable. Please try again shortly." });
      }

      const email = (req.body.email || "").trim().toLowerCase();
      const isAdminFree = email === ADMIN_FREE_EMAIL;

      // PKG-3 — owner-bound, atomic credit consumption. The paid Anthropic call
      // below runs ONLY when this resolves to ok, i.e. the database has proven
      // exactly one credit was consumed against the correct owner. Authenticated
      // authority comes solely from the session; a caller-supplied req.body.email
      // never grants a logged-in caller spending authority over another pool.
      // IP is hashed (SHA-256) before storage for the anonymous free tier — never
      // store a raw IP, per privacy rules.
      const ipRaw =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const ipHash = crypto.createHash("sha256").update(ipRaw).digest("hex");
      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD UTC

      const consume = await consumeEstimateCredit({
        sessionUserId: (req.session as any)?.userId,
        sessionUserEmail: (req.session as any)?.userEmail,
        bodyEmail: email,
        isAdminFree,
        ipHash,
        today,
      });
      if (!consume.ok) {
        return res.status(consume.status).json({ error: consume.error, ...(consume.extra || {}) });
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
            messages: [
              {
                role: "user",
                content: [
                  { type: "image", source: { type: "base64", media_type: mt, data: base64 } },
                  { type: "text", text: PRE_GRADE_PROMPT },
                ],
              },
            ],
          },
          { apiKey, timeoutMs: 30_000 }
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
      const aiData = (await response.json()) as { content: { text: string }[] };
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
          ? estimate.potential_issues.map((p: any) => (typeof p === "string" ? p : p.description || ""))
          : [],
        recommendation: estimate.recommendation ?? "",
        confidence: sub.surface?.confidence ?? estimate.confidence ?? "medium",
      };

      // Return remaining credits with response. The atomic decrement already
      // reported the post-spend balance (null for admin-free / anonymous-free
      // paths, which don't track a per-caller balance).
      const creditsLeft: number | undefined = consume.remaining ?? undefined;
      // Merge: new structured fields + compat fields + credits
      res.json({ ...estimate, ...compat, credits_remaining: creditsLeft });
    } catch (err: any) {
      console.error("[tools/estimate] error:", err.message);
      sendServerError(res, err);
    }
  });

  // ── Target-bound scanner capture sessions ──────────────────────────────────
  // The workstation creates one of these BEFORE the scanner receives a capture
  // request.  The local app can only claim a station-matching session; it never
  // supplies a free-form certificate, card or side along with a TIFF.
  app.post("/api/admin/certificates/:id/scanner-capture-sessions", requireAdmin, async (req, res) => {
    try {
      const certificateId = Number.parseInt(String(req.params.id), 10);
      if (!Number.isSafeInteger(certificateId) || certificateId <= 0) {
        return res.status(400).json({ error: "valid certificate id required" });
      }
      const { createScannerCaptureSession } = await import("./scanner-capture-service");
      const { CANON_LIDE_400_PROFILE } = await import("./lib/lide400-profile");
      const { resolveActiveStationByCode } = await import("./partner/station-service");
      const requestedStation = await resolveActiveStationByCode(req.body?.workstation_id);
      if (!requestedStation) {
        return res.status(409).json({ error: "Select an active, provisioned MintVault station" });
      }
      const { assertStationCaptureReady } = await import("./partner/station-service");
      try {
        assertStationCaptureReady(requestedStation, CANON_LIDE_400_PROFILE.version);
      } catch {
        return res.status(409).json({ error: "Station needs a current calibration for the locked Canon profile" });
      }
      const session = await createScannerCaptureSession({
        certificateId,
        side: req.body?.side,
        workstationId: requestedStation.code,
        stationId: requestedStation.id,
        actorId: (req.session as any)?.adminUser ?? (req.session as any)?.adminEmail ?? null,
        recapture: req.body?.recapture === true,
        scannerProfileVersion: CANON_LIDE_400_PROFILE.version,
      });
      await storage.writeAuditLog(
        "certificate",
        String(certificateId),
        "scanner_capture_armed",
        (req.session as any)?.adminEmail ?? "admin",
        {
          capture_session_id: session.id,
          side: session.side,
          card_id: session.cardId,
          submission_item_id: session.submissionItemId,
          submission_id: session.submissionId,
          workstation_id: session.workstationId,
          scanner_profile_version: session.scannerProfileVersion,
          recapture: session.recapture,
          expires_at: session.expiresAt.toISOString(),
        }
      );
      return res.status(201).json({ capture: session });
    } catch (error: any) {
      const message = error?.message || "Unable to arm scanner capture";
      const status = /not found|already|valid|must be/.test(message) ? 409 : 500;
      return res.status(status).json({ error: message });
    }
  });

  app.get(
    "/api/admin/scanner/capture-sessions/next",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    async (req, res) => {
      try {
        const { claimNextScannerCapture } = await import("./scanner-capture-service");
        const station = req.scannerStation;
        const capture = await claimNextScannerCapture(
          station?.code ?? req.query.workstation_id,
          station?.code ?? req.query.device_id,
          station?.id ?? null
        );
        return res.json({ capture });
      } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Unable to claim scanner capture" });
      }
    }
  );

  // The scanner process uses this after an interrupted/late HTTP response.
  // It is scoped to the device that claimed the session and derives acceptance
  // from immutable provenance, not an optimistic client-side upload result.
  app.get(
    "/api/admin/scanner/capture-sessions/:sessionId",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    async (req, res) => {
      try {
        const { getScannerCaptureStatus } = await import("./scanner-capture-service");
        const result = await getScannerCaptureStatus(
          String(req.params.sessionId),
          req.scannerStation?.code ?? req.query.device_id
        );
        return res.json({ capture: result.session, accepted: result.accepted, card_registered: result.cardRegistered });
      } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Unable to read scanner capture status" });
      }
    }
  );

  // The Electron station keeps an already-claimed target alive while an
  // operator positions the card or reviews a local, non-authoritative preview.
  // It accepts no certificate/card/side fields and cannot revive a terminal
  // session, so it cannot broaden the scanner token's authority.
  app.post(
    "/api/admin/scanner/capture-sessions/:sessionId/keepalive",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    async (req, res) => {
      try {
        const { renewScannerCapture } = await import("./scanner-capture-service");
        const capture = await renewScannerCapture(
          String(req.params.sessionId),
          req.scannerStation?.code ?? req.body?.device_id
        );
        return res.json({ capture });
      } catch (error: any) {
        return res.status(409).json({ error: error?.message || "Unable to renew scanner capture" });
      }
    }
  );

  app.get("/api/admin/certificates/:id/scanner-capture-sessions/:sessionId", requireAdmin, async (req, res) => {
    try {
      const certificateId = Number.parseInt(String(req.params.id), 10);
      const row = await db.execute(sql`
        SELECT id, certificate_id, card_id, submission_item_id, submission_id, side, workstation_id,
               scanner_profile_version, state, claimed_by_device_id, physical_released, recapture, failure_reason,
               created_at, claimed_at, captured_at, expires_at
        FROM scanner_capture_sessions
        WHERE id = ${String(req.params.sessionId)} AND certificate_id = ${certificateId}
        LIMIT 1`);
      if (!row.rows.length) return res.status(404).json({ error: "capture session not found" });
      return res.json({ capture: row.rows[0] });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.post(
    "/api/admin/scanner/capture-sessions/:sessionId/failed",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    async (req, res) => {
      try {
        const { failScannerCapture } = await import("./scanner-capture-service");
        const result = await failScannerCapture(
          String(req.params.sessionId),
          req.scannerStation?.code ?? req.body?.device_id,
          String(req.body?.reason || "Local scanner capture failed")
        );
        if (!result.terminalized && !result.accepted) {
          return res.status(409).json({ ok: false, ...result });
        }
        return res.json({ ok: true, ...result });
      } catch (error: any) {
        return res.status(400).json({ error: error?.message || "Unable to mark scanner capture failed" });
      }
    }
  );

  // Direct-staging grant. The station never chooses an R2 key: the server
  // creates one opaque key for this exact claimed session, binds its expected
  // bytes/hash/provenance, and signs a short-lived TIFF-only PUT URL. The
  // following finalise route is still the only authority that can promote
  // anything into immutable evidence.
  app.post(
    "/api/admin/scanner/capture-sessions/:sessionId/staged-upload",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    async (req, res) => {
      try {
        const { grantScannerEvidenceStaging } = await import("./scanner-evidence-staging-service");
        const { createScannerEvidenceStagingUpload } = await import("./r2");
        const deviceId = req.scannerStation?.code ?? req.body?.device_id;
        const grant = await grantScannerEvidenceStaging({
          sessionId: String(req.params.sessionId),
          deviceId,
          authenticatedStationId: req.scannerStation?.id ?? null,
          expectedSha256: req.body?.sha256,
          expectedBytes: req.body?.byte_length,
          provenance: req.body?.capture_provenance,
        });
        const upload = await createScannerEvidenceStagingUpload(grant.staging.objectKey);
        return res.status(201).json({
          staging_id: grant.staging.id,
          expires_at: grant.staging.expiresAt.toISOString(),
          transport: upload.transport,
          upload_url: upload.uploadUrl,
          headers: upload.headers,
          upload_expires_in_seconds: upload.expiresInSeconds,
        });
      } catch (error: any) {
        const message = error?.message || "Unable to create staged scanner upload";
        return res
          .status(/invalid|not found|not bound|not awaiting|expired|already/.test(message) ? 409 : 500)
          .json({ error: message });
      }
    }
  );

  // The R2 object is deliberately non-authoritative. This bounded server path
  // reads it back, verifies the exact client-declared content hash/length,
  // applies the same decoded TIFF/profile/card-frame gates as the legacy route,
  // then writes a content-addressed immutable evidence revision.
  app.post(
    "/api/admin/scanner/capture-sessions/:sessionId/staged-upload/:stagingId/finalise",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    scannerEvidenceAdmission.middleware,
    async (req, res) => {
      const sessionId = String(req.params.sessionId);
      const stagingId = String(req.params.stagingId);
      let activeSession: any = null;
      let evidenceCommitted = false;
      try {
        const { beginScannerEvidenceFinalisation } = await import("./scanner-evidence-staging-service");
        const prepared = await beginScannerEvidenceFinalisation({
          sessionId,
          stagingId,
          deviceId: req.scannerStation?.code ?? req.body?.device_id,
          authenticatedStationId: req.scannerStation?.id ?? null,
        });
        if (prepared.alreadyAccepted) {
          const { getScannerCaptureStatus } = await import("./scanner-capture-service");
          const status = await getScannerCaptureStatus(sessionId, req.scannerStation?.code ?? req.body?.device_id);
          const { reconcileAcceptedScannerEvidence } = await import("./scanner-evidence-finalisation");
          const reconciled = await reconcileAcceptedScannerEvidence({
            session: status.session,
            stagingId,
            trusted: {
              stationId: req.scannerStation?.id ?? null,
              tenantId: req.scannerStation?.tenantId ?? null,
              locationId: req.scannerStation?.locationId ?? null,
              actorId: req.scannerOperator?.userId ?? status.session.actorId,
            },
          });
          return res.json({
            ok: true,
            already_accepted: true,
            certId: status.session.certificateNumber,
            side: status.session.side,
            raw_uploaded: true,
            reconciliation_complete: true,
            card_registered: reconciled.cardRegistered,
          });
        }
        const { beginScannerCapture } = await import("./scanner-capture-service");
        activeSession = await beginScannerCapture(sessionId, req.scannerStation?.code ?? req.body?.device_id);
        const { getR2Buffer } = await import("./r2");
        const stagedTiff = await getR2Buffer(prepared.staging.objectKey);
        if (!stagedTiff) throw new Error("Staged TIFF object is unavailable");
        if (stagedTiff.length !== prepared.staging.expectedBytes) {
          throw new Error("Staged TIFF byte length does not match the accepted candidate");
        }
        const actualHash = crypto.createHash("sha256").update(stagedTiff).digest("hex");
        if (actualHash !== prepared.staging.expectedSha256) {
          throw new Error("Staged TIFF hash does not match the accepted candidate");
        }
        const { finaliseScannerEvidence, reconcileAcceptedScannerEvidence } =
          await import("./scanner-evidence-finalisation");
        const evidence = await finaliseScannerEvidence({
          session: activeSession,
          buffer: stagedTiff,
          mimeType: "image/tiff",
          provenanceInput: prepared.staging.provenance,
          trusted: {
            stationId: req.scannerStation?.id ?? null,
            tenantId: req.scannerStation?.tenantId ?? null,
            locationId: req.scannerStation?.locationId ?? null,
            actorId: req.scannerOperator?.userId ?? activeSession.actorId,
          },
        });
        evidenceCommitted = true;
        const reconciled = await reconcileAcceptedScannerEvidence({
          session: activeSession,
          evidence,
          stagingId,
          trusted: {
            stationId: req.scannerStation?.id ?? null,
            tenantId: req.scannerStation?.tenantId ?? null,
            locationId: req.scannerStation?.locationId ?? null,
            actorId: req.scannerOperator?.userId ?? activeSession.actorId,
          },
        });
        return res.status(201).json({
          ok: true,
          certId: activeSession.certificateNumber,
          side: activeSession.side,
          raw_uploaded: true,
          reconciliation_complete: true,
          card_registered: reconciled.cardRegistered,
        });
      } catch (error: any) {
        const reason = error?.message || "staged scanner capture rejected";
        if (!evidenceCommitted) {
          const retryable =
            /(timeout|timed out|temporar|network|socket|econn|eai_again|r2|object storage|unavailable|until an immutable front master exists)/i.test(
              reason
            );
          try {
            const { failScannerEvidenceFinalisation } = await import("./scanner-evidence-staging-service");
            await failScannerEvidenceFinalisation(stagingId, reason, retryable);
          } catch {}
          try {
            const { finishScannerCapture } = await import("./scanner-capture-service");
            await finishScannerCapture(sessionId, false, reason, retryable);
          } catch {}
        }
        /*
         * A geometry refusal is classified by its TYPE, before any message matching.
         *
         * The regex below decides an HTTP status by looking at English prose, which means rewording
         * an error silently changes its status code. Three of the four capture-geometry refusals
         * happened to match nothing and were reported as 500 — including "this capture session
         * carries no authoritative capture window; re-arm this card side", which is an instruction,
         * not a fault. Type first; prose only as the existing fallback for everything else.
         */
        const status =
          error instanceof CaptureGeometryError ||
          /required|invalid|must|does not|refused|expired|not claimed|not found|already|hash|byte length/.test(reason)
            ? 409
            : 500;
        return res.status(status).json({ error: reason });
      }
    }
  );

  app.post(
    "/api/admin/scanner/capture-sessions/:sessionId/evidence",
    requireScannerOrAdmin,
    requireStationCaptureAgent,
    // Must precede multer: otherwise a concurrent TIFF burst has already
    // consumed its 128 MiB memory buffer before we can apply backpressure.
    scannerEvidenceAdmission.middleware,
    scanUpload.single("image"),
    async (req, res) => {
      const sessionId = String(req.params.sessionId);
      try {
        const { beginScannerCapture, finishScannerCapture, isScannerCaptureCardRegistered } =
          await import("./scanner-capture-service");
        const { parseLide400CaptureProvenance, assertLide400Evidence } = await import("./lib/lide400-profile");
        const { inspectScannerEvidence, uploadRawScannerSide, markRawUploaded, setScanStatus } =
          await import("./scan-ingest-service");
        const deviceId = req.scannerStation?.code ?? req.body?.device_id;
        const session = await beginScannerCapture(sessionId, deviceId);
        const file = req.file;
        if (!file) throw new Error("TIFF image is required");
        const inspection = await inspectScannerEvidence(file.buffer);
        const provenance = parseLide400CaptureProvenance(JSON.parse(String(req.body?.capture_provenance || "")));
        assertLide400Evidence(inspection, provenance);
        const { assessLide400CardFrame } = await import("./lib/lide400-card-frame");
        /*
         * SERVER-OWNED GEOMETRY, exactly as in `finaliseScannerEvidence`. The acquisition rectangle
         * is the one snapshotted onto this session when the side was armed, from the station's
         * current VALID calibration — never the station's own declaration in the upload, which is
         * only required to agree with it. Both evidence paths must derive it the same way or the
         * weaker one becomes the way in.
         */
        const { authoritativeRegionForSession, assertDeclaredRegionMatchesAuthority } =
          await import("./lib/lide400-capture-authority");
        const authoritativeRegion = authoritativeRegionForSession(session);
        assertDeclaredRegionMatchesAuthority(provenance.scanAreaMm, authoritativeRegion);
        // Same commit-time pairing check as the staged path — see scanner-evidence-finalisation.ts.
        const { assertCommittedSidesShareOneRectangle } = await import("./scanner-capture-service");
        await assertCommittedSidesShareOneRectangle(session.certificateId, session.side, authoritativeRegion);
        const frameAssessment = await assessLide400CardFrame(file.buffer, inspection, authoritativeRegion);
        if (!frameAssessment.accepted) {
          throw new Error(frameAssessment.reason || "Card-boundary safety check rejected this acquired TIFF");
        }
        if (
          provenance.profileVersion !== session.scannerProfileVersion ||
          provenance.workstationId !== session.workstationId
        ) {
          throw new Error("Capture provenance does not match the armed workstation/profile");
        }
        if (req.scannerStation && session.stationId !== req.scannerStation.id) {
          throw new Error("Capture session is not bound to this authenticated station");
        }
        // Fail before writing any immutable back evidence. A back-only master
        // would be an incomplete target capture, not a recoverable partial
        // upload, and must not alter the current evidence selection.
        if (session.side === "back") {
          const front = await db.execute(sql`
            SELECT 1 FROM certificate_image_evidence
            WHERE certificate_id = ${session.certificateId} AND side = 'front' AND is_current = true
            LIMIT 1`);
          if (!front.rows.length) throw new Error("Back capture refused until an immutable front master exists");
        }
        await uploadRawScannerSide(
          session.certificateId,
          session.side,
          { buffer: file.buffer, mimeType: file.mimetype, ext: "tif", inspection },
          {
            allowRecapture: session.recapture,
            captureMetadata: {
              captureSessionId: session.id,
              cardId: session.cardId,
              submissionItemId: session.submissionItemId,
              submissionId: session.submissionId,
              cardFrameAssessment: frameAssessment,
              ...provenance,
              // The SERVER's rectangle, not the station's declaration — see the equivalent note in
              // scanner-evidence-finalisation.ts. Written after the spread so it wins.
              declaredScanAreaMm: provenance.scanAreaMm,
              scanAreaMm: authoritativeRegion,
              // These values are never trusted from multipart provenance.
              // They resolve only from the armed session and station/operator
              // principals authenticated by the server.
              stationId: req.scannerStation?.id ?? session.stationId,
              tenantId: req.scannerStation?.tenantId ?? null,
              locationId: req.scannerStation?.locationId ?? null,
              actorId: req.scannerOperator?.userId ?? session.actorId,
            },
          }
        );
        await markRawUploaded(session.certificateId);
        await setScanStatus(session.certificateId, "processing");
        const { enqueueScannerProcessing } = await import("./scanner-processing-queue");
        await enqueueScannerProcessing(session.certificateId, session.stationId);
        await finishScannerCapture(sessionId, true);
        const cardRegistered = await isScannerCaptureCardRegistered(session.certificateId);
        await storage.writeAuditLog(
          "certificate",
          String(session.certificateId),
          "scanner_capture_accepted",
          "scanner",
          {
            capture_session_id: session.id,
            side: session.side,
            card_id: session.cardId,
            submission_item_id: session.submissionItemId,
            submission_id: session.submissionId,
            workstation_id: session.workstationId,
            station_id: req.scannerStation?.id ?? session.stationId,
            tenant_id: req.scannerStation?.tenantId ?? null,
            location_id: req.scannerStation?.locationId ?? null,
            actor_id: req.scannerOperator?.userId ?? session.actorId,
            scanner_device_id: provenance.scannerDeviceId,
            scanner_model: provenance.scannerModel,
            scanner_profile_version: provenance.profileVersion,
            sha256: inspection.sha256,
            recapture: session.recapture,
          }
        );
        /*
         * ADVANCE THE PARTNER CARD JOB — the same bridge the R2 staging path gets inside
         * recordAcceptedScannerEvidence().
         *
         * This legacy multipart route does NOT call recordAcceptedScannerEvidence: it inlines its own
         * audit write. So hooking only the shared helper would have left this transport unable to
         * promote a Card Job to READY_TO_GRADE — a card captured through the compatibility body would
         * silently stay ungradeable, which is precisely the defect being closed. A no-op for HQ and
         * connector-imported certificates, which have no Card Job.
         */
        const { advanceCardJobAfterCaptureSafely } = await import("./partner/card-job-lifecycle");
        await advanceCardJobAfterCaptureSafely(session.certificateId);
        return res.status(201).json({
          ok: true,
          certId: session.certificateNumber,
          side: session.side,
          raw_uploaded: true,
          card_registered: cardRegistered,
        });
      } catch (error: any) {
        const reason = error?.message || "scanner capture rejected";
        try {
          const { finishScannerCapture } = await import("./scanner-capture-service");
          // Only transport/storage failures can return this claimed session to
          // the same scanner for the already-staged TIFF.  Profile, target,
          // expiry and decoded-image failures stay terminal and fail closed.
          const retryable = /(timeout|timed out|temporar|network|socket|econn|eai_again|r2|object storage)/i.test(
            reason
          );
          await finishScannerCapture(sessionId, false, reason, retryable);
        } catch {}
        // Type before prose — see the equivalent block on the staged-evidence route above.
        const status =
          error instanceof CaptureGeometryError ||
          /required|invalid|must|does not|refused|expired|not claimed|not found|already/.test(reason)
            ? 409
            : 500;
        return res.status(status).json({ error: reason });
      }
    }
  );

  // ── Admin scan-ingest: scanner → cert → AI pipeline in one call ────────────

  app.post(
    "/api/admin/scan-ingest",
    requireScannerOrAdmin,
    // Timing marker captured BEFORE multer, so we can log body-receive (multer)
    // duration separately from handler/processing time.
    (req, _res, next) => {
      (req as any)._ingestT0 = process.hrtime.bigint();
      next();
    },
    scanUpload.fields([
      { name: "front", maxCount: 1 },
      { name: "back", maxCount: 1 },
    ]),
    async (req, res) => {
      // A physical scanner may no longer mint an unbound certificate. The
      // target-bound session endpoint above uses the same evidence/pipeline
      // service after it proves certificate/card/submission/side ownership.
      // Keep this route as an explicit failure rather than leaving the old
      // allocation behaviour reachable to a leaked/stale scanner token.
      const unboundIngestDisabled = () => true;
      if (unboundIngestDisabled()) {
        return res.status(410).json({
          error: "Unbound scanner ingest is retired. Arm a certificate-side capture session before scanning.",
        });
      }
      /* c8 ignore next -- historical handler below is unreachable during the
         cutover window and retained only to make rollback diffable. */
      const {
        createCertForScan,
        resolveScanOperatorId,
        uploadRawScansToR2,
        processScanInBackground,
        markRawUploaded,
        pgErrorDetail,
        inspectScannerEvidence,
        assertCompatibleEvidencePair,
      } = await import("./scan-ingest-service");
      const { getSetting } = await import("./lib/pipeline-settings");
      const elapsedMs = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
      const tHandler = process.hrtime.bigint();
      const multerMs = (req as any)._ingestT0 ? elapsedMs((req as any)._ingestT0 as bigint) : null;
      let certInfo: { id: number; certId: string } | null = null;

      try {
        const files = req.files as Record<string, Express.Multer.File[]>;
        if (!files?.front?.[0]) return res.status(400).json({ error: "Front image is required" });

        const frontFile = files.front[0];
        const backFile = files.back?.[0] || null;
        // Phase 2 — magic-byte content-type validation (mirrors the H3 hot-folder
        // fix): reject anything that isn't a real image before it enters the pipeline.
        if (!(await validateImageMagicBytes(frontFile))) {
          return res.status(400).json({ error: "Front image failed content-type validation (not a valid image)" });
        }
        if (backFile && !(await validateImageMagicBytes(backFile))) {
          return res.status(400).json({ error: "Back image failed content-type validation (not a valid image)" });
        }
        // Decode metadata with a bounded TIFF decoder before allocating a cert.
        // This verifies signature/content agreement and prevents a malformed or
        // decompression-bomb TIFF from entering the asynchronous R2 path.
        let frontEvidence: any;
        let backEvidence: any = null;
        try {
          frontEvidence = await inspectScannerEvidence(frontFile.buffer);
          backEvidence = backFile ? await inspectScannerEvidence(backFile.buffer) : null;
          assertCompatibleEvidencePair(frontEvidence, backEvidence);
          if (frontEvidence.evidenceClass !== "NEW_IMMUTABLE_MASTER") {
            return res.status(400).json({ error: "New scanner ingestion requires an original TIFF master" });
          }
        } catch (e: any) {
          return res.status(400).json({ error: `Scanner evidence rejected: ${e?.message ?? "invalid image"}` });
        }
        const frontBuf = frontFile.buffer;
        const backBuf = backFile?.buffer || null;
        const notes = (req.body?.notes || "").trim();
        const clientSource = (req.body?.client_source || "admin_ui").trim();

        // Pull a usable file extension from the multipart filename so the
        // raw R2 key keeps the original format (.tif / .tiff / .png / .jpg).
        const extFromName = (name?: string) => {
          if (!name) return "bin";
          const m = String(name)
            .toLowerCase()
            .match(/\.([a-z0-9]{1,5})$/);
          return m ? m[1] : "bin";
        };
        const frontExt = extFromName(frontFile.originalname);
        const backExt = backFile ? extFromName(backFile.originalname) : "bin";

        // Content-derived idempotency key (front+back SHA), stable across the
        // scanner's retries + restarts. The UNIQUE-index gate in createCertForScan
        // makes a re-driven / raced ingest resolve to the SAME cert — no duplicate.
        const idempotencyKey =
          (req.headers["x-idempotency-key"] as string | undefined)?.trim() ||
          (req.body?.idempotency_key ? String(req.body.idempotency_key).trim() : "") ||
          null;

        console.log(
          `[scan-ingest] starting: front=${(frontBuf.length / 1024).toFixed(0)}KB back=${backBuf ? (backBuf.length / 1024).toFixed(0) + "KB" : "none"} source=${clientSource} multer=${multerMs != null ? multerMs.toFixed(0) + "ms" : "?"} key=${idempotencyKey ? idempotencyKey.slice(0, 12) + "…" : "none"}`
        );

        // Phase 1: resolve the scanning operator from the X-Scanner-Operator header
        // (operator email, validated server-side → user id, or NULL for a legacy
        // shared-token scan). Never fails the scan; an unknown/absent operator → NULL.
        const scannedBy = await resolveScanOperatorId(req.header("x-scanner-operator"));

        // Step 1 (sync): idempotent cert allocation — same key → same cert.
        const ci = await createCertForScan(idempotencyKey, scannedBy);
        certInfo = { id: ci.id, certId: ci.certId };

        // Idempotent replay of an already-COMPLETE cert (raw confirmed in R2):
        // nothing to redo — reply so the watcher sees raw_uploaded=true and moves
        // the inbox file. This is the crash-between-move-and-removePending path.
        if (ci.reused && ci.rawUploaded) {
          console.log(`[scan-ingest] ${ci.certId}: idempotent replay of complete cert — no reprocess`);
          return res.json({
            certId: ci.certId,
            dbId: ci.id,
            raw_uploaded: true,
            scan_status: ci.scanStatus,
            reused: true,
            status: ci.scanStatus ?? "ready",
            workstationUrl: `/admin#grading-${ci.id}`,
            message: `Certificate ${ci.certId} already ingested.`,
          });
        }

        if (notes) {
          await db.execute(sql`UPDATE certificates SET notes = ${notes} WHERE id = ${ci.id}`);
        }

        // Step 2 (async — Fix A): background the RAW R2 upload + the heavy
        // pipeline, and respond IMMEDIATELY — the server no longer holds the
        // request open for the raw PUT, which closes the client's 60s no-progress
        // window. The CORE INVARIANT still holds: raw_uploaded flips true ONLY
        // after the raw PUT confirms, and the scanner keeps the inbox file until
        // it polls raw_uploaded=true. Crash before that → file retained → re-drive
        // (same key → same cert) + deterministic R2 keys make it idempotent.
        const autoAiOn = await getSetting("ai_auto_ingest_enabled", true);
        setImmediate(() => {
          void (async () => {
            const tBg = process.hrtime.bigint();
            try {
              await uploadRawScansToR2(
                ci.id,
                { buffer: frontBuf, mimeType: frontFile.mimetype, ext: frontExt, inspection: frontEvidence },
                backBuf && backFile
                  ? { buffer: backBuf, mimeType: backFile.mimetype, ext: backExt, inspection: backEvidence }
                  : null
              );
              await markRawUploaded(ci.id);
              console.log(
                `[scan-ingest] ${ci.certId}: raw confirmed in R2 (raw_uploaded=true) rawPut=${elapsedMs(tBg).toFixed(0)}ms`
              );
            } catch (rawErr: any) {
              // Raw PUT failed → raw_uploaded stays false. The scanner retains the
              // inbox file; the reconciler / next re-drive retries. Do NOT process.
              console.error(
                `[scan-ingest] ${ci.certId}: raw R2 upload FAILED (raw_uploaded stays false): ${rawErr?.message ?? rawErr}${pgErrorDetail(rawErr)}`
              );
              return;
            }
            // Heavy CPU work (sharp variants + AI) is SERIALIZED through the scan
            // job queue (default 1 at a time) so a burst of scans can't saturate
            // the single shared vCPU. Raw is already confirmed above (fast
            // file-move); only the heavy pipeline queues.
            // skipAi: ALWAYS defer the AI pre-grade off the scan path so the queue
            // slot frees right after sharp+r2 (~10s sooner — the AI step is API-wait
            // that used to block the slot). The pre-grade is computed lazily when a
            // grader opens the cert (ensureAiDraft). The ai_auto_ingest_enabled
            // master switch still gates that lazy/manual AI compute.
            //
            // NOTE: an at-scan auto-identify trigger (PR #122) was REVERTED here — it
            // fired ensureAiDraft DETACHED, outside this serialized queue, once per
            // scan, which reintroduced the exact unbounded CPU + DB-pool saturation
            // the queue exists to prevent (stuck-'processing' empty certs + downstream
            // front/back mis-pairing, MV291+, v932). Names still auto-fill on
            // grader-open via the on-open ensureAiDraft. Any future at-scan identify
            // MUST run INSIDE this serialized job (or a concurrency-capped lane).
            enqueueScanJob(() => processScanInBackground(ci, frontBuf, backBuf, { skipAi: true }), ci.certId);
          })();
        });

        // Step 3 (sync return): immediate — cert exists; raw + processing async.
        console.log(
          `[scan-ingest] ${ci.certId}: responded in ${elapsedMs(tHandler).toFixed(0)}ms (raw+processing backgrounded)`
        );
        res.json({
          certId: ci.certId,
          dbId: ci.id,
          raw_uploaded: false,
          scan_status: "processing",
          reused: ci.reused,
          workstationUrl: `/admin#grading-${ci.id}`,
          status: "processing",
          aiStatus: autoAiOn ? "deferred" : "skipped",
          message: `Certificate ${ci.certId} created. Raw upload + processing in background.`,
        });
      } catch (err: any) {
        console.error(
          `[scan-ingest] error${certInfo ? ` (cert=${certInfo.certId})` : ""}: ${err.message}${pgErrorDetail(err)}`
        );
        res.status(500).json({ error: "Scan ingest failed", certId: certInfo?.certId || null });
      }
    }
  );

  // ── Scan-status poll — the scanner holds the inbox file until raw_uploaded=true
  // here, then moves it (the core-invariant completion signal). Also the reconcile
  // probe used by requeuePending after a crash. Lightweight: two columns only. ──
  app.get("/api/admin/scan-status/:certId", requireScannerOrAdmin, async (req, res) => {
    try {
      // UNGATED lookup: the scanner polls this on a freshly created cert that is
      // not yet graded. The publish-gated findCertByIdFlex would return null for
      // an ungraded cert → a spurious 404 loop until the cert is approved. This
      // endpoint is scanner-token/admin authed, so resolving by number regardless
      // of grade state is correct (and never exposes anything to the public).
      const cert = await findCertByNumberUngated(String(req.params.certId));
      if (!cert) return res.status(404).json({ error: "cert not found", certId: String(req.params.certId) });
      const r = await db.execute(
        sql`SELECT raw_uploaded, scan_status FROM certificates WHERE id = ${(cert as any).id} LIMIT 1`
      );
      const row = r.rows[0] as any;
      res.json({
        certId: normalizeCertId((cert as any).certId),
        raw_uploaded: row?.raw_uploaded === true,
        scan_status: row?.scan_status ?? null,
      });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── Scan health — incomplete ingests surfaced for the admin Capture Health
  // view: pipeline failures (the reconciler re-drives these) + raw-never-confirmed
  // (server can't fix; awaiting scanner re-supply). Makes an incomplete cert
  // visible instead of silent-until-a-customer-opens-it. ──
  app.get("/api/admin/scan-health", requireAdmin, async (_req, res) => {
    try {
      const failed = await db.execute(sql`
        SELECT certificate_number, scan_status, updated_at FROM certificates
        WHERE scan_status = 'failed' AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 100`);
      const noRaw = await db.execute(sql`
        SELECT certificate_number, issued_at FROM certificates
        WHERE raw_uploaded = false AND scan_status = 'processing'
          AND deleted_at IS NULL
          AND issued_at < NOW() - interval '10 minutes'
        ORDER BY issued_at DESC LIMIT 100`);
      res.json({
        failed: (failed.rows as any[]).map((r) => ({
          certId: normalizeCertId(r.certificate_number),
          scanStatus: r.scan_status,
          at: r.updated_at,
        })),
        rawNotConfirmed: (noRaw.rows as any[]).map((r) => ({
          certId: normalizeCertId(r.certificate_number),
          at: r.issued_at,
        })),
      });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

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
        scans: (rows.rows as any[]).map((r) => ({
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
      // INNER JOIN to certificates + deleted_at IS NULL filter — excludes
      // both soft-deleted certs AND orphaned grading_sessions (where the
      // referenced cert has been hard-deleted). pristine_10p_count is
      // derived from the cert's MVGS score (grade_strength_score >= 96)
      // rather than the headline grade — only MVGS-qualified Pristine
      // 10Ps count, not every grade-10 cert.
      const rows = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                                 AS total_graded,
          COUNT(*) FILTER (WHERE DATE_TRUNC('month', gs.completed_at) = DATE_TRUNC('month', NOW()))::int AS this_month,
          ROUND(AVG(gs.final_grade)::numeric, 2)                                        AS avg_grade,
          ROUND(AVG(gs.grading_duration_seconds)::numeric, 0)::int                      AS avg_seconds,
          COUNT(*) FILTER (WHERE c.grade_strength_score >= 96)::int                     AS pristine_10p_count
        FROM grading_sessions gs
        INNER JOIN certificates c ON c.certificate_number = gs.cert_id AND c.deleted_at IS NULL
        WHERE gs.final_grade IS NOT NULL
      `);
      const overview = rows.rows[0] || {};

      const distRows = await db.execute(sql`
        SELECT gs.final_grade, COUNT(*)::int AS count
        FROM grading_sessions gs
        INNER JOIN certificates c ON c.certificate_number = gs.cert_id AND c.deleted_at IS NULL
        WHERE gs.final_grade IS NOT NULL
        GROUP BY gs.final_grade
        ORDER BY gs.final_grade DESC
      `);

      const gameRows = await db.execute(sql`
        SELECT gs.card_game, COUNT(*)::int AS count
        FROM grading_sessions gs
        INNER JOIN certificates c ON c.certificate_number = gs.cert_id AND c.deleted_at IS NULL
        WHERE gs.card_game IS NOT NULL
        GROUP BY gs.card_game
        ORDER BY count DESC
      `);

      const activityRows = await db.execute(sql`
        SELECT DATE(gs.completed_at) AS day, COUNT(*)::int AS count
        FROM grading_sessions gs
        INNER JOIN certificates c ON c.certificate_number = gs.cert_id AND c.deleted_at IS NULL
        WHERE gs.completed_at >= NOW() - INTERVAL '30 days'
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
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/learning/accuracy", requireAdmin, async (_req, res) => {
    try {
      // Same JOIN + deleted_at filter as /api/admin/learning/overview —
      // accuracy figures must not include sessions whose certs have been
      // hard-deleted or soft-deleted.
      const rows = await db.execute(sql`
        SELECT
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(gs.centering_diff) <= 0.5) / NULLIF(COUNT(*) FILTER (WHERE gs.centering_diff IS NOT NULL), 0), 1) AS centering_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(gs.corners_diff) <= 0.5)   / NULLIF(COUNT(*) FILTER (WHERE gs.corners_diff IS NOT NULL), 0), 1)   AS corners_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(gs.edges_diff) <= 0.5)     / NULLIF(COUNT(*) FILTER (WHERE gs.edges_diff IS NOT NULL), 0), 1)     AS edges_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(gs.surface_diff) <= 0.5)   / NULLIF(COUNT(*) FILTER (WHERE gs.surface_diff IS NOT NULL), 0), 1)   AS surface_accuracy,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(gs.overall_diff) <= 0.5)   / NULLIF(COUNT(*) FILTER (WHERE gs.overall_diff IS NOT NULL), 0), 1)   AS overall_accuracy,
          ROUND(AVG(gs.centering_diff)::numeric, 2) AS avg_centering_diff,
          ROUND(AVG(gs.corners_diff)::numeric, 2)   AS avg_corners_diff,
          ROUND(AVG(gs.edges_diff)::numeric, 2)     AS avg_edges_diff,
          ROUND(AVG(gs.surface_diff)::numeric, 2)   AS avg_surface_diff,
          ROUND(AVG(gs.overall_diff)::numeric, 2)   AS avg_overall_diff
        FROM grading_sessions gs
        INNER JOIN certificates c ON c.certificate_number = gs.cert_id AND c.deleted_at IS NULL
        WHERE gs.overall_diff IS NOT NULL
      `);
      res.json(rows.rows[0] || {});
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── AI feature flags (DB-backed runtime overrides) ───────────────────────
  // Admin can flip any of the 10 AI flags at runtime without redeploying.
  // Override write also drops the in-memory cache so the change takes effect
  // on the very next AI call instead of waiting out the 30s TTL.

  // ── AI dashboard stats — single endpoint feeding the AI Learning page ────
  // Combines top-line cert stats with the new ai_predictions accuracy view so
  // the dashboard makes one fetch on load instead of fanning out to four.

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

  // GET /preview — light metadata used by Manual Mode UI to confirm cert
  // exists and which side(s) are populated before uploading.
  // GET /api/admin/next-cert-id — ADVISORY display hint only.
  //
  // This reads the ONE authoritative allocator (cert_counter.last_issued + 1).
  // It previously derived its own answer from
  // MAX(regexp_replace(certificate_number,…)) over live certificates, which was
  // a SECOND formula over a DIFFERENT source of truth and could disagree with
  // what the card actually receives: soft-deleting the newest certificate made
  // it re-predict a number the counter will never reissue, and out-of-band rows
  // in a higher band (the staging harness seeds MV900001+) made it predict from
  // that band instead. One number space, one formula.
  //
  // It remains a HINT and is never a reservation — issuance is owned solely by
  // the transactional allocator. A concurrent issuance can still consume this
  // number first, so no caller may treat it as assigned.
  app.get("/api/admin/next-cert-id", requireScannerOrAdmin, async (_req, res) => {
    try {
      const { lastIssued } = await storage.getLastIssuedMvNumber();
      const n = lastIssued + 1;
      res.json({ next: `MV${n}`, next_numeric: n, advisory: true });
    } catch (err: any) {
      console.error("[next-cert-id] failed:", err);
      sendServerError(res, err);
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
          certId: row.cert_id,
          cardName: row.card_name ?? null,
          set: row.set_name ?? null,
          missingFront: !!row.missing_front,
          missingBack: !!row.missing_back,
          createdAt: row.issued_at,
          deleted: !!row.deleted_at,
        })),
      });
    } catch (err: any) {
      console.error("[orphan-certs] failed:", err);
      sendServerError(res, err);
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
        cert_id: row.certificate_number,
        internal_id: row.id,
        card_name: row.card_name ?? null,
        has_front: !!row.has_front,
        has_back: !!row.has_back,
        grade_overall: row.grade_overall ?? null,
        grade_approved_at: row.grade_approved_at ?? null,
        deleted: !!row.deleted_at,
        status: row.status,
      });
    } catch (err: any) {
      console.error("[cert-preview] failed:", err);
      sendServerError(res, err);
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

      const curRows = (
        await db.execute(sql`
        SELECT card_name, set_name, card_number_display, grade_type, grade::text AS grade_text
        FROM certificates
        WHERE certificate_number = ${certId}
        LIMIT 1
      `)
      ).rows;
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
      const distRows = (
        await db.execute(sql`
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
      `)
      ).rows as Array<{ label: string; count: number }>;

      const total = distRows.reduce((s, r) => s + r.count, 0);
      const distribution = distRows.map((r) => ({
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
      sendServerError(res, err);
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

      const rows = (
        await db.execute(sql`
        SELECT id, grading_front_original, grading_back_original
        FROM certificates
        WHERE certificate_number = ${certId}
        LIMIT 1
      `)
      ).rows;
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
      console.log(
        `[reprocess-images] cert=${certId} dbId=${dbId} front=${(frontBuf.length / 1024).toFixed(0)}KB back=${backBuf ? `${(backBuf.length / 1024).toFixed(0)}KB` : "—"}`
      );

      const { uploadImagesToCert } = await import("./scan-ingest-service");
      await uploadImagesToCert(dbId, frontBuf, backBuf);

      // Read back the post-reprocess display image paths and sign them
      // for the response so the frontend can swap the viewer image src
      // without going through /api/logbook again.
      const afterRows = (
        await db.execute(sql`
        SELECT front_image_path, back_image_path
        FROM certificates
        WHERE id = ${dbId}
        LIMIT 1
      `)
      ).rows;
      const after = (afterRows[0] ?? {}) as any;
      const signIfPresent = async (key: string | null): Promise<string | null> => {
        if (!key) return null;
        try {
          return await getR2SignedUrl(key, 3600);
        } catch {
          return null;
        }
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
      sendServerError(res, err);
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
        const rows = (
          await db.execute(sql`
          SELECT id, certificate_number
          FROM certificates
          WHERE deleted_at IS NULL
            AND grading_front_original IS NOT NULL
          ORDER BY id
        `)
        ).rows as Array<{ id: number; certificate_number: string }>;
        worklist = rows.map((r) => ({ id: r.id, certNumber: r.certificate_number }));
      } else {
        const normalized = inputCertIds.map((c) => normalizeCertId(c));
        const rows = (
          await db.execute(sql`
          SELECT id, certificate_number
          FROM certificates
          WHERE certificate_number = ANY(${normalized}::text[])
            AND deleted_at IS NULL
            AND grading_front_original IS NOT NULL
          ORDER BY id
        `)
        ).rows as Array<{ id: number; certificate_number: string }>;
        worklist = rows.map((r) => ({ id: r.id, certNumber: r.certificate_number }));
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
          const r = (
            await db.execute(sql`
            SELECT grading_front_original, grading_back_original
            FROM certificates
            WHERE id = ${item.id}
            LIMIT 1
          `)
          ).rows[0] as any;
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
        console.log(
          `[bulk-reprocess] batch complete: ${processed + failed}/${worklist.length} (ok=${processed} fail=${failed})`
        );
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
      sendServerError(res, err);
    }
  });

  // POST /image — attach a single-side image to an existing cert. sharp
  // re-encodes to JPEG (handles .tif, .tiff, .png, .webp, .jpg/.jpeg input).
  // R2 key follows the existing scan-ingest convention so /reprocess-images
  // and the dashboard image fetcher both find it without changes.
  app.post("/api/admin/certs/:certId/image", requireScannerOrAdmin, certImgUpload.single("image"), async (req, res) => {
    try {
      const certIdRaw = String(req.params.certId);
      const certId = normalizeCertId(certIdRaw);
      const side = String(req.body?.side || "").toLowerCase();
      const replaceExisting = String(req.body?.replace_existing || "false") === "true";

      if (side !== "front" && side !== "back") {
        return res.status(400).json({ error: "side must be 'front' or 'back'" });
      }
      const file = req.file;
      if (!file) return res.status(400).json({ error: "image file required (multipart 'image')" });
      const uploadErr = await rejectInvalidUploads([file]);
      if (uploadErr) return res.status(400).json({ error: uploadErr });
      // Phase 58A: this legacy single-side endpoint re-encodes every input to
      // q85 JPEG. Refuse TIFF rather than silently destroying a scanner master;
      // V850/SilverFast TIFFs must use /api/admin/scan-ingest, which writes the
      // immutable master ledger and native working derivative.
      if (/^image\/(tiff|x-tiff)$/i.test(file.mimetype) || /\.tiff?$/i.test(file.originalname)) {
        return res.status(409).json({
          error:
            "TIFF scanner masters must be uploaded through /api/admin/scan-ingest; this legacy image endpoint would re-encode the evidence",
        });
      }

      const certRow = await db.execute(sql`
          SELECT id, certificate_number, grading_front_original, grading_back_original, deleted_at
          FROM certificates
          WHERE certificate_number = ${certId}
          LIMIT 1
        `);
      const cert = certRow.rows[0] as any;
      if (!cert) return res.status(404).json({ error: "cert not found", certId });
      if (cert.deleted_at)
        return res.status(410).json({ error: "cert is soft-deleted; restore before attaching images" });

      const sideCol = side === "front" ? "grading_front_original" : "grading_back_original";
      const previousKey: string | null = cert[sideCol] || null;

      if (previousKey && !replaceExisting) {
        let currentSignedUrl: string | null = null;
        try {
          currentSignedUrl = await getR2SignedUrl(previousKey, 600);
        } catch {}
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
        return res.status(400).json({ error: "image decode failed" });
      }

      // Unique key per upload (two-scanner safety): with the old deterministic
      // key, two devices racing the same cert/side wrote the SAME R2 object —
      // last write silently won and the losing card's image was lost while the
      // DB looked correct. Each upload now writes its own object; the atomic
      // CAS below decides the single winner. Downstream always reads the
      // column, never reconstructs this path by convention.
      const newKey = `images/grading/${cert.id}/${side}_original_${Date.now().toString(36)}.jpg`;
      await uploadToR2(newKey, jpegBuf, "image/jpeg");

      // Atomic claim-the-slot: only update if the cert is still live AND the
      // side still holds exactly what we read above (IS NOT DISTINCT FROM
      // handles NULL). A concurrent device that attached in between makes this
      // match 0 rows → we clean up our orphan object and 409 instead of
      // silently cross-wiring two different physical cards.
      const sideColSql = side === "front" ? sql`grading_front_original` : sql`grading_back_original`;
      const claimed = await db.execute(sql`
        UPDATE certificates
        SET ${sideColSql} = ${newKey}, updated_at = NOW()
        WHERE id = ${cert.id}
          AND deleted_at IS NULL
          AND (${replaceExisting} OR ${sideColSql} IS NOT DISTINCT FROM ${previousKey})
        RETURNING id
      `);
      if (claimed.rows.length === 0) {
        try {
          await deleteFromR2(newKey);
        } catch {}
        return res.status(409).json({
          error: `${side} image for ${certId} changed under this upload (another scanner attached it, or the cert was deleted) — refresh and retry`,
        });
      }

      const adminUser =
        (req.session as any)?.adminEmail || (req.headers["x-scanner-token"] ? "scanner-watcher" : "admin");
      await storage.writeAuditLog("certificate", certId, "image_attached_manual", adminUser, {
        side,
        replace_existing: replaceExisting,
        previous_key: previousKey,
        new_key: newKey,
        original_filename: file.originalname || null,
        mime_received: file.mimetype || null,
        size_in_bytes: file.size,
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
      const backKeyAfter = side === "back" ? newKey : (cert.grading_back_original as string | null);

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
              .then((r) => console.log(`[cert-image-attach] AI done for cert ${cert.id}: grade=${r?.grade}`))
              .catch((e) => console.warn(`[cert-image-attach] AI failed for cert ${cert.id}:`, e?.message || e));
          }
        } catch (err: any) {
          // Original is saved on R2 + the column is updated — pipeline
          // failure doesn't undo that. Return 200 with the failure flagged
          // so the caller can decide (e.g. re-run /reprocess-images).
          pipelineStatus = "failed";
          pipelineError = err?.message || String(err);
          console.error(`[cert-image-attach] pipeline failed for cert ${cert.id}:`, pipelineError);
        }
      }

      res.json({
        ok: true,
        cert_id: certId,
        side,
        new_key: newKey,
        previous_key: previousKey,
        replaced: !!previousKey,
        pipeline_status: pipelineStatus,
        pipeline_error: pipelineError,
        ai_triggered: aiTriggered,
      });
    } catch (err: any) {
      console.error("[cert-image-attach] failed:", err);
      sendServerError(res, err);
    }
  });

  // DELETE — soft-delete only (sets deleted_at). Hard-delete is intentionally
  // not exposed; project rule "no hard deletes on business tables" applies.
  app.delete("/api/admin/certs/:certId", requireScannerOrAdmin, async (req, res) => {
    try {
      const certIdRaw = String(req.params.certId);
      const certId = normalizeCertId(certIdRaw);
      const reason = String(req.body?.reason || "").trim();
      if (reason.length < 10) {
        return res.status(400).json({ error: "reason must be at least 10 characters" });
      }

      // grade_approved_at guard: this endpoint serves the SCANNER workflow
      // (reject & rescan, orphan cleanup). A cert whose grade has been
      // approved/published is finished grading work — a scanner popup must
      // never be able to soft-delete it. Admin-side deletion of graded certs
      // goes through the separate admin route with its own confirmation.
      const r = await db.execute(sql`
        UPDATE certificates
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE certificate_number = ${certId} AND deleted_at IS NULL AND grade_approved_at IS NULL
        RETURNING id
      `);
      if (r.rows.length === 0) {
        const exists = await db.execute(
          sql`SELECT id, deleted_at, grade_approved_at FROM certificates WHERE certificate_number = ${certId} LIMIT 1`
        );
        if (exists.rows.length === 0) return res.status(404).json({ error: "cert not found", certId });
        if ((exists.rows[0] as any).deleted_at)
          return res.status(410).json({ error: "cert already soft-deleted", certId });
        return res.status(409).json({
          error: "cert has an approved grade — cannot be deleted from the scanner; use the admin panel",
          certId,
        });
      }

      const adminUser =
        (req.session as any)?.adminEmail || (req.headers["x-scanner-token"] ? "scanner-watcher" : "admin");
      await storage.writeAuditLog("certificate", certId, "soft_delete", adminUser, { reason });

      res.json({ ok: true, cert_id: certId });
    } catch (err: any) {
      console.error("[cert-soft-delete] failed:", err);
      sendServerError(res, err);
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
        const before: Record<string, string | null> = {
          card_name: null,
          set_name: null,
          card_number_display: null,
          rarity: null,
          year_text: null,
        };

        const cert = (await storage.getCertificateByCertId(certIdStr)) as any;
        if (!cert) {
          results.push({ certId: certIdStr, status: "failed", reason: "cert not found", before });
          continue;
        }

        before.card_name = cert.cardName ?? null;
        before.set_name = cert.setName ?? null;
        before.card_number_display = cert.cardNumber ?? null;
        before.rarity = cert.rarity ?? null;
        before.year_text = cert.year ?? null;

        const imageKey = cert.gradingFrontOriginal || cert.frontImagePath;
        if (!imageKey) {
          results.push({ certId: certIdStr, status: "failed", reason: "no front image key on cert", before });
          continue;
        }

        // Fetch front image from R2.
        let buffer: Buffer;
        try {
          const r2 = await r2client.send(new GetObjectCommand({ Bucket: r2bucket, Key: imageKey }));
          if (!r2.Body) throw new Error("empty R2 body");
          const chunks: Buffer[] = [];
          for await (const chunk of r2.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
          buffer = Buffer.concat(chunks);
        } catch (err: any) {
          results.push({
            certId: certIdStr,
            status: "failed",
            reason: `R2 fetch failed (${imageKey}): ${err.message}`,
            before,
          });
          continue;
        }

        // Run Haiku identify (+ optional GPT reconciliation inside the helper).
        let identified: any;
        try {
          identified = await identifyCardFromBuffer(buffer, "image/jpeg", certIdStr);
        } catch (err: any) {
          results.push({ certId: certIdStr, status: "failed", reason: `identify failed: ${err.message}`, before });
          continue;
        }

        // Brief asks for ">0.6" confidence; underlying enum is high|medium|low.
        // Accept high+medium, skip low. Never write a guess.
        const idPayload = (verifiedFlag: boolean, dbSrc: string | null) => ({
          confidence: identified.confidence,
          detected_name: identified.detected_name,
          detected_set: identified.detected_set,
          detected_number: identified.detected_number,
          detected_year: identified.copyright_year || identified.detected_year,
          detected_rarity: identified.detected_rarity,
          verified: verifiedFlag,
          dbSource: dbSrc,
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
          enriched = {
            ...identified,
            verified: false,
            officialName: identified.detected_name,
            officialSet: identified.detected_set,
            officialNumber: identified.detected_number,
            dbSource: null,
          };
        }

        const proposed: Record<string, string | null> = {
          card_name: pickValue(cert.cardName, enriched.officialName),
          set_name: pickValue(cert.setName, enriched.officialSet),
          card_number_display: pickValue(cert.cardNumber, enriched.officialNumber),
          rarity: pickValue(cert.rarity, identified.detected_rarity),
          year_text: pickValue(cert.year, identified.copyright_year || identified.detected_year),
        };

        const changed = FIELDS.filter((f) => proposed[f] !== before[f]);
        if (changed.length === 0) {
          results.push({
            certId: certIdStr,
            status: "skipped",
            reason: "no field needs filling",
            before,
            identification: idPayload(enriched.verified, enriched.dbSource),
          });
          continue;
        }

        if (dryRun) {
          results.push({
            certId: certIdStr,
            status: "would-update",
            before,
            after: proposed,
            identification: idPayload(enriched.verified, enriched.dbSource),
          });
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
                before,
                after: proposed,
                identification: { ...idPayload(enriched.verified, enriched.dbSource), reasoning: identified.reasoning },
                fields_changed: changed,
              })}::jsonb)
            `);
          });
          results.push({
            certId: certIdStr,
            status: "updated",
            before,
            after: proposed,
            identification: idPayload(enriched.verified, enriched.dbSource),
          });
        } catch (err: any) {
          results.push({ certId: certIdStr, status: "failed", reason: `DB write failed: ${err.message}`, before });
        }
      }

      const summary = { "would-update": 0, updated: 0, skipped: 0, failed: 0 };
      for (const r of results) summary[r.status]++;
      res.json({ dryRun, results, summary });
    } catch (err: any) {
      console.error("[backfill-cert-metadata] failed:", err);
      sendServerError(res, err);
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
  const lastForceRunAtMs = 0;
  const FORCE_RUN_DEBOUNCE_MS = 60_000;

  // ── B2 cold-archive endpoints ───────────────────────────────────────────
  // Manual trigger + status surface for the R2 → B2 archival worker.
  // Worker runs daily via setInterval (server/index.ts); these endpoints
  // give the operator a way to dry-run, force a sweep, or check progress.

  // PUT /api/admin/certificates/:id/status
  app.put("/api/admin/certificates/:id/status", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { status, tracking_number } = req.body;
      const validStatuses = [
        "submitted",
        "received",
        "in_queue",
        "grading",
        "quality_check",
        "slab_production",
        "shipping",
        "delivered",
      ];
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
      sendServerError(res, err);
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

  // ── Tier capacity management ──────────────────────────────────────────────

  // ── Custom sets CRUD + pokemon-sets GET are canonical in admin-config.ts
  // and public.ts respectively. Shadowed duplicates removed 2026-06-20.

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
          } catch {
            /* keep certThumbnailUrl = null */
          }
        }
      } else if (nextPost) {
        nextPost = { ...nextPost, certIdString: null, certThumbnailUrl: null };
      }

      res.json({
        postEnabled: settings[0]?.postEnabled ?? false,
        envGate: process.env.IG_POST_ENABLED === "true",
        dryRunEnvVar: process.env.IG_DRY_RUN === "true",
        nextPost,
      });
    } catch (err: any) {
      sendServerError(res, err);
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
        await db
          .update(igSettings)
          .set({ postEnabled: enabled, updatedAt: new Date(), updatedBy: adminEmail })
          .where(eq(igSettings.id, existing[0].id));
      }
      try {
        await storage.writeAuditLog("ig_settings", "1", enabled ? "enable" : "disable", adminEmail, {});
      } catch {}
      res.json({ ok: true, postEnabled: enabled });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/ig/queue", requireAdmin, async (req, res) => {
    try {
      const { igPostQueue, certificates } = await import("@shared/schema");
      const { desc, isNull, inArray, sql: drizzleSql } = await import("drizzle-orm");
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const offset = (page - 1) * limit;
      // includeDeleted=true is a debugging hook — not surfaced in UI yet.
      // Default filters soft-deleted rows out of every list response.
      const includeDeleted = String(req.query.includeDeleted ?? "").toLowerCase() === "true";

      const baseQuery = db.select().from(igPostQueue);
      const rows = await (includeDeleted ? baseQuery : baseQuery.where(isNull(igPostQueue.deletedAt)))
        .orderBy(desc(igPostQueue.scheduledFor))
        .limit(limit)
        .offset(offset);

      const countWhere = includeDeleted ? drizzleSql`1=1` : drizzleSql`deleted_at IS NULL`;
      const countRes = await db.execute<{ n: number }>(
        drizzleSql`SELECT COUNT(*)::int AS n FROM ig_post_queue WHERE ${countWhere}`
      );
      const total = (countRes as any).rows?.[0]?.n ?? 0;

      // Batch-fetch cert thumbnails for all rows with cert_id in this page.
      // One DB round-trip + N R2 signs; signs happen in parallel.
      const certPks = Array.from(new Set(rows.map((r) => r.certId).filter((id): id is number => id != null)));
      const certMap = new Map<number, { certIdString: string | null; frontImagePath: string | null }>();
      if (certPks.length > 0) {
        const certRows = await db
          .select({
            id: certificates.id,
            certIdString: certificates.certId,
            frontImagePath: certificates.frontImagePath,
          })
          .from(certificates)
          .where(inArray(certificates.id, certPks));
        for (const c of certRows) {
          certMap.set(c.id, { certIdString: c.certIdString, frontImagePath: c.frontImagePath });
        }
      }

      const { getR2SignedUrl } = await import("./r2");
      const enriched = await Promise.all(
        rows.map(async (r) => {
          let certThumbnailUrl: string | null = null;
          let certIdString: string | null = null;
          if (r.certId != null) {
            const meta = certMap.get(r.certId);
            certIdString = meta?.certIdString ?? null;
            if (meta?.frontImagePath) {
              try {
                certThumbnailUrl = await getR2SignedUrl(meta.frontImagePath, 3600);
              } catch {
                certThumbnailUrl = null;
              }
            }
          }
          return { ...r, certIdString, certThumbnailUrl };
        })
      );

      res.json({ rows: enriched, page, limit, total });
    } catch (err: any) {
      sendServerError(res, err);
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
      const postTypeOverride =
        rawOverride && (IG_POST_TYPES as readonly string[]).includes(rawOverride)
          ? (rawOverride as (typeof IG_POST_TYPES)[number])
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
      sendServerError(res, err);
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
      sendServerError(res, err);
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
      const rows = (
        await db.execute(sql`
        SELECT id, entity_id, created_at, details
        FROM audit_log
        WHERE entity_type = 'weekly_reel'
          AND action = 'generated'
        ORDER BY created_at DESC
        LIMIT 10
      `)
      ).rows as Array<{ id: number; entity_id: string; created_at: Date; details: any }>;

      const history = await Promise.all(
        rows.map(async (row) => {
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
            manifest === null && cardCount === 0
              ? "unknown"
              : successCount > 0 && failCount === 0
                ? "ok"
                : successCount > 0 && failCount > 0
                  ? "partial"
                  : "failed";
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
        })
      );

      res.json({ history });
    } catch (err: any) {
      console.error("[weekly-reel] status fetch failed:", err);
      sendServerError(res, err);
    }
  });

  // GET /api/admin/weekly-reel/consenting-cards — every graded cert whose
  // submission has marketing_feature_consent=true (no time window filter,
  // unlike the weekly job's 7-day cutoff). Sorted grade DESC so the most
  // reel-worthy cards surface first.
  app.get("/api/admin/weekly-reel/consenting-cards", requireAdmin, async (_req, res) => {
    try {
      const rows = (
        await db.execute(sql`
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
      `)
      ).rows as Array<any>;
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
      sendServerError(res, err);
    }
  });

  // GET /api/admin/weekly-reel/all-graded-cards — every graded cert (whether
  // consenting or not) joined to its submission so the admin UI can render
  // BOTH an "In Pool" table (consent=true) AND a "Not in Pool" table
  // (consent=false) from a single round-trip. Superset of /consenting-cards;
  // that endpoint is now unused but left for backwards-compat.
  app.get("/api/admin/weekly-reel/all-graded-cards", requireAdmin, async (_req, res) => {
    try {
      const rows = (
        await db.execute(sql`
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
      `)
      ).rows as Array<any>;
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
      sendServerError(res, err);
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

      const rows = (
        await db.execute(sql`
        SELECT s.id AS submission_id, s.marketing_feature_consent
        FROM certificates c
        JOIN submission_items si ON si.id = c.submission_item_id
        JOIN submissions     s  ON s.id  = si.submission_id
        WHERE c.certificate_number = ${certNumberRaw}
          AND c.deleted_at IS NULL
          AND s.deleted_at IS NULL
        LIMIT 1
      `)
      ).rows;
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
      sendServerError(res, err);
    }
  });

  // GET /api/admin/weekly-reel/featured-cards — consented graded certs with
  // admin curation flags. Admin selection never overrides the customer’s
  // marketing-feature consent; withdrawing consent removes a card from the
  // future reel pool immediately.
  app.get("/api/admin/weekly-reel/featured-cards", requireAdmin, async (_req, res) => {
    try {
      const rows = (
        await db.execute(sql`
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
        JOIN submission_items si ON si.id = c.submission_item_id
        JOIN submissions s ON s.id = si.submission_id
        WHERE c.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND s.marketing_feature_consent = true
          AND c.grade_approved_at IS NOT NULL
        ORDER BY c.marketing_pinned DESC,
                 c.marketing_featured DESC,
                 c.grade DESC NULLS LAST,
                 c.grade_approved_at DESC
      `)
      ).rows as Array<any>;
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
      sendServerError(res, err);
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

      const rows = (
        await db.execute(sql`
        SELECT c.id, c.marketing_featured
        FROM certificates c
        JOIN submission_items si ON si.id = c.submission_item_id
        JOIN submissions s ON s.id = si.submission_id
        WHERE c.certificate_number = ${certNumberRaw}
          AND c.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND s.marketing_feature_consent = true
        LIMIT 1
      `)
      ).rows;
      const cur = rows[0] as any;
      if (!cur) {
        return res.status(409).json({ error: "Marketing feature consent is required for this card." });
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
      sendServerError(res, err);
    }
  });

  // ── MVGS v2 grading calibration (Phase 3 Step 1) ────────────────────────
  // Admin panel writes the three "[CALIBRATE]" values per spec §3 + §6 into
  // the pipeline_settings row keyed "mvgs.calibration". Engine
  // (shared/mvgs-scoring.ts, frozen at fe0d60c) reads them via
  // loadMvgsCalibration() — these routes never touch engine code.
  //
  // Lock semantics: once `locked: true`, normal PATCH refuses (server-side
  // gate in saveMvgsCalibration). The dedicated /unlock route is the ONLY
  // caller passing `force: true`, so unlocking is a deliberate two-step:
  // unlock → edit → re-lock. Same pattern matches spec §6 ("locked values
  // are the published standard, not a casual nudge"). updatedBy logged on
  // every write so the audit trail captures BOTH value changes and lock
  // state transitions.

  app.get("/api/admin/mvgs/calibration", requireAdmin, async (_req, res) => {
    try {
      const { loadMvgsCalibration } = await import("./lib/mvgs-calibration");
      const { defaultCalibration, FIELD_RANGES } = await import("./lib/mvgs-calibration-validation");
      const calibration = await loadMvgsCalibration();
      res.json({ calibration, defaults: defaultCalibration(), ranges: FIELD_RANGES });
    } catch (err: any) {
      console.error("[mvgs-calibration] load failed:", err);
      sendServerError(res, err);
    }
  });

  // PATCH body: { values: Partial<MvgsCalibration> }. Each field is clamped
  // into its allowed range; cross-field ordering (crease cutoffs minor <
  // half < threeQuarter) is validated and REJECTED with 400 if out-of-order
  // — silent reorder would muddle the audit trail of what the operator
  // intended. Returns 409 with `{error: "locked"}` if the store is locked.
  app.patch("/api/admin/mvgs/calibration", requireAdmin, async (req, res) => {
    try {
      const { loadMvgsCalibration, saveMvgsCalibration } = await import("./lib/mvgs-calibration");
      const { clampField, validateCalibration, FIELD_RANGES } = await import("./lib/mvgs-calibration-validation");
      const incoming = (req.body?.values ?? {}) as Record<string, unknown>;
      const current = await loadMvgsCalibration();
      if (current.locked) {
        return res.status(409).json({ error: "Calibration is locked. Unlock before editing." });
      }
      // Build the proposed object by overlaying clamped incoming fields onto
      // the current persisted values. Unrecognised keys are ignored; absent
      // keys keep their existing value (partial PATCH).
      const proposed = { ...current };
      for (const key of Object.keys(FIELD_RANGES) as Array<keyof typeof FIELD_RANGES>) {
        if (key in incoming) {
          const v = clampField(key, incoming[key]);
          if (v !== null) proposed[key] = v;
        }
      }
      const check = validateCalibration(proposed);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const result = await saveMvgsCalibration(proposed, { updatedBy: ADMIN_EMAIL });
      if (!result.ok) {
        // Race: someone else locked between load and save. Surface plainly.
        return res.status(409).json({ error: "Calibration was locked concurrently. Reload and retry." });
      }
      const next = await loadMvgsCalibration();
      res.json({ calibration: next });
    } catch (err: any) {
      console.error("[mvgs-calibration] patch failed:", err);
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/mvgs/calibration/lock", requireAdmin, async (_req, res) => {
    try {
      const { loadMvgsCalibration, saveMvgsCalibration } = await import("./lib/mvgs-calibration");
      const current = await loadMvgsCalibration();
      if (current.locked) return res.json({ calibration: current, alreadyLocked: true });
      const result = await saveMvgsCalibration({ ...current, locked: true }, { updatedBy: ADMIN_EMAIL });
      if (!result.ok) {
        return res.status(409).json({ error: "Could not lock — concurrent modification." });
      }
      res.json({ calibration: await loadMvgsCalibration() });
    } catch (err: any) {
      console.error("[mvgs-calibration] lock failed:", err);
      sendServerError(res, err);
    }
  });

  // /unlock is the SINGLE caller that passes `force: true` — explicit
  // deliberate action per spec §6. The audit row records who unlocked
  // (updatedBy). Editing the values still requires a separate PATCH.
  app.post("/api/admin/mvgs/calibration/unlock", requireAdmin, async (_req, res) => {
    try {
      const { loadMvgsCalibration, saveMvgsCalibration } = await import("./lib/mvgs-calibration");
      const current = await loadMvgsCalibration();
      if (!current.locked) return res.json({ calibration: current, alreadyUnlocked: true });
      const result = await saveMvgsCalibration({ ...current, locked: false }, { force: true, updatedBy: ADMIN_EMAIL });
      if (!result.ok) {
        return res.status(500).json({ error: "Unlock save returned not-ok unexpectedly" });
      }
      res.json({ calibration: await loadMvgsCalibration() });
    } catch (err: any) {
      console.error("[mvgs-calibration] unlock failed:", err);
      sendServerError(res, err);
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
      sendServerError(res, err);
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
          value = ["grade_desc", "value_desc", "newest_first"].includes(String(raw)) ? String(raw) : "grade_desc";
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
        case "ai_auto_ingest_enabled":
        case "ai_ingest_identify_only":
          value = raw === true || raw === "true";
          break;
        case "post_delay_minutes":
          value = Math.max(0, Math.min(180, Number(raw) || 0));
          break;
        case "tiktok_privacy":
          value = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].includes(String(raw))
            ? String(raw)
            : "PUBLIC_TO_EVERYONE";
          break;
        case "transition_style":
          value = ["cut", "dissolve", "zoom"].includes(String(raw)) ? String(raw) : "cut";
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
      // Fail-fast SSRF check when setting the reel webhook URL, so the admin
      // gets an immediate error instead of a silent failure at send time. The
      // real protection is the guard at the postReelWebhook sink; this is UX.
      if (key === "notify_webhook_url" && typeof value === "string" && value.trim()) {
        try {
          const { assertPublicHttpsUrl } = await import("./lib/ssrf-guard");
          await assertPublicHttpsUrl(value);
        } catch (e: any) {
          return res.status(400).json({ error: `Invalid webhook URL: ${e?.message || "not allowed"}` });
        }
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
      sendServerError(res, err);
    }
  });

  // PATCH /pinned and /blacklisted — same shape as /featured.
  function makeBoolColPatch(opts: { bodyField: string; sqlCol: string; auditAction: string; logTag: string }) {
    return async (req: any, res: any) => {
      try {
        const certNumberRaw = String(req.params.certNumber).trim();
        if (!certNumberRaw) return res.status(400).json({ error: "certNumber required" });
        const nextVal = req.body?.[opts.bodyField] === true;
        const rows = (
          await db.execute(sql`
          SELECT id, ${sql.raw(opts.sqlCol)} AS cur
          FROM certificates
          WHERE certificate_number = ${certNumberRaw}
            AND deleted_at IS NULL
          LIMIT 1
        `)
        ).rows;
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
        sendServerError(res, err);
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
    })
  );

  app.patch(
    "/api/admin/weekly-reel/card/:certNumber/blacklisted",
    requireAdmin,
    makeBoolColPatch({
      bodyField: "blacklisted",
      sqlCol: "marketing_blacklisted",
      auditAction: "marketing_blacklisted_changed",
      logTag: "weekly-reel:blacklist",
    })
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
      sendServerError(res, err);
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
      sendServerError(res, err);
    }
  });

  // GET /api/admin/weekly-reel/analytics — last 12 weeks + running total cost.
  app.get("/api/admin/weekly-reel/analytics", requireAdmin, async (_req, res) => {
    try {
      const rows = (
        await db.execute(sql`
        SELECT reel_date, card_count, success_count, fail_count,
               estimated_cost_usd::text AS estimated_cost_usd,
               model, clip_length_seconds, created_at,
               instagram_post_id, facebook_post_id, tiktok_post_id,
               instagram_likes, instagram_views, instagram_reach,
               instagram_comments, thumbnail_r2_key
        FROM reel_analytics
        ORDER BY created_at DESC
        LIMIT 12
      `)
      ).rows as Array<any>;
      const totalRow = (
        await db.execute(sql`
        SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS total
        FROM reel_analytics
      `)
      ).rows[0] as any;
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
      sendServerError(res, err);
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
    } catch {
      return null;
    }
  }

  async function ensureAllCardsApproved(date: string): Promise<{ ok: boolean; pending: string[] }> {
    try {
      const rows = (
        await db.execute(sql`
        SELECT cert_number, approved FROM reel_card_approvals WHERE reel_date = ${date}
      `)
      ).rows as Array<{ cert_number: string; approved: boolean }>;
      if (rows.length === 0) return { ok: true, pending: [] };
      const pending = rows.filter((r) => r.approved !== true).map((r) => r.cert_number);
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
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/weekly-reel/tiktok-status", requireAdmin, async (_req, res) => {
    try {
      const { getTikTokTokenStatus } = await import("./lib/tiktok-publisher");
      res.json(await getTikTokTokenStatus());
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // Shared publish handler factory — IG/FB/TikTok all follow the same shape:
  // read manifest → require approvals (when configured) → pick top video →
  // call publisher → store post id in reel_analytics.
  async function publishHandler(
    req: any,
    res: any,
    publisher: (videoUrl: string, caption: string) => Promise<{ postId: string }>,
    column: "instagram_post_id" | "facebook_post_id" | "tiktok_post_id",
    label: string
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
          entityType: "weekly_reel",
          entityId: date,
          action: `${label}_published`,
          adminUser: actor,
          details: { postId },
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
      req,
      res,
      (videoUrl, caption) =>
        publishToTikTok(videoUrl, caption, {
          privacy: settings.tiktok_privacy,
          disableDuet: settings.tiktok_disable_duet,
          disableStitch: settings.tiktok_disable_stitch,
        }),
      "tiktok_post_id",
      "tiktok"
    );
  });

  // POST /refresh-insights — pull latest IG numbers for a reel and store
  // in reel_analytics.
  app.post("/api/admin/weekly-reel/refresh-insights", requireAdmin, async (req, res) => {
    try {
      const date = String(req.body?.date ?? "").trim();
      if (!date) return res.status(400).json({ error: "date required" });
      const row = (
        await db.execute(sql`
        SELECT instagram_post_id FROM reel_analytics WHERE reel_date = ${date} LIMIT 1
      `)
      ).rows[0] as { instagram_post_id?: string } | undefined;
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
      const rows = (
        await db.execute(sql`
        SELECT cert_number, approved, reviewed_at, reviewed_by
        FROM reel_card_approvals
        WHERE reel_date = ${date}
        ORDER BY cert_number
      `)
      ).rows as Array<any>;
      res.json({
        date,
        cards: rows.map((r) => ({
          certNumber: r.cert_number,
          approved: r.approved === true,
          reviewedAt: r.reviewed_at ?? null,
          reviewedBy: r.reviewed_by ?? null,
        })),
      });
    } catch (err: any) {
      sendServerError(res, err);
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
      sendServerError(res, err);
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
      sendServerError(res, err);
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
      manifest.successCount = cards.filter((c) => c.videoUrl).length;
      manifest.failCount = cards.length - manifest.successCount;

      try {
        await uploadToR2(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"), "application/json");
      } catch (err: any) {
        return res.status(500).json({ error: "manifest re-upload failed" });
      }

      res.json({ ok: true, videoUrl, error });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── Content enhancement uploads (intro / outro / music) ────────────────

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
        sendServerError(res, err);
      }
    };
  }

  app.post(
    "/api/admin/weekly-reel/upload-intro",
    requireAdmin,
    reelAssetUpload.single("file"),
    makeAssetUploadHandler({
      r2Key: "weekly-reel/intro.mp4",
      settingKey: "intro_video_r2_key",
      contentType: "video/mp4",
      logTag: "reel-asset:intro",
    })
  );
  app.post(
    "/api/admin/weekly-reel/upload-outro",
    requireAdmin,
    reelAssetUpload.single("file"),
    makeAssetUploadHandler({
      r2Key: "weekly-reel/outro.mp4",
      settingKey: "outro_video_r2_key",
      contentType: "video/mp4",
      logTag: "reel-asset:outro",
    })
  );
  app.post(
    "/api/admin/weekly-reel/upload-music",
    requireAdmin,
    reelAssetUpload.single("file"),
    makeAssetUploadHandler({
      r2Key: "weekly-reel/music.mp3",
      settingKey: "background_music_r2_key",
      contentType: "audio/mpeg",
      logTag: "reel-asset:music",
    })
  );

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
      const rows = (
        await db.execute(sql`
        SELECT entity_id, created_at
        FROM audit_log
        WHERE entity_type = 'weekly_reel' AND action = 'generated'
        ORDER BY created_at DESC
        LIMIT 24
      `)
      ).rows as Array<{ entity_id: string; created_at: Date }>;
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
      sendServerError(res, err);
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
      sendServerError(res, err);
    }
  });

  app.patch("/api/admin/ig/queue/:id/skip", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      await db.update(igPostQueue).set({ status: "skipped", deletedAt: new Date() }).where(eq(igPostQueue.id, id));
      try {
        await storage.writeAuditLog("ig_post", String(id), "skipped", adminEmail, {});
      } catch {}
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  app.patch("/api/admin/ig/queue/:id/retry", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const { igPostQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const adminEmail = (req.session as any)?.adminEmail ?? null;
      await db.update(igPostQueue).set({ status: "pending", errorDetail: null }).where(eq(igPostQueue.id, id));
      try {
        await storage.writeAuditLog("ig_post", String(id), "retry", adminEmail, {});
      } catch {}
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
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
      sendServerError(res, err);
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
        const tags = body.hashtags
          .split(/\s+/)
          .map((t: string) => t.trim())
          .filter(Boolean);
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
      try {
        await storage.writeAuditLog("ig_post", String(id), "manual_edit", adminEmail, {
          fields_changed: fieldsChanged,
        });
      } catch {}
      res.json({ ok: true, fieldsChanged });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── Replace queue row image (manual upload, overrides generated render) ──
  // Multer in-memory; 50 MB cap (TIFFs from the scanner are large).
  // Accepts JPEG, PNG, TIFF, WebP. Server-side converts EVERYTHING to JPEG
  // before R2 upload because the Meta Graph API only accepts JPEG for IG
  // posts — uniform output format means the publish path doesn't have to
  // branch by source type. R2 object is always .jpg with image/jpeg
  // content-type regardless of what the admin uploaded.
  app.post("/api/admin/ig/queue/:id/replace-image", requireAdmin, igImageUpload.single("image"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      if (!req.file) return res.status(400).json({ error: "No file provided (form field 'image')" });
      const uploadErr = await rejectInvalidUploads([req.file]);
      if (uploadErr) return res.status(400).json({ error: uploadErr });
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
      } catch {
        /* metadata extraction is best-effort */
      }

      // Always convert to JPEG @ q=92. Meta Graph API only accepts JPEG
      // for IG posts, so doing it here means the publish path stays format-
      // agnostic. JPEG @ 92 is a sensible quality/size trade-off — file
      // bytes drop ~70% vs PNG/TIFF for the same visual fidelity.
      const jpegBuffer = await sharp(req.file.buffer).jpeg({ quality: 92 }).toBuffer();

      const newKey = `ig/manual-upload/${id}-${Date.now()}.jpg`;
      const { uploadToR2 } = await import("./r2");
      await uploadToR2(newKey, jpegBuffer, "image/jpeg");

      await db.update(igPostQueue).set({ imageR2Key: newKey }).where(eq(igPostQueue.id, id));

      try {
        await storage.writeAuditLog("ig_post", String(id), "manual_image_upload", adminEmail, {
          old_key: row.imageR2Key,
          new_key: newKey,
          uploaded_mime: req.file.mimetype,
          uploaded_size: req.file.size,
          stored_mime: "image/jpeg",
          stored_size: jpegBuffer.length,
          converted: req.file.mimetype !== "image/jpeg",
          ...dimensions,
        });
      } catch {}
      res.json({ ok: true, r2Key: newKey, ...dimensions, converted: req.file.mimetype !== "image/jpeg" });
    } catch (err: any) {
      // Multer errors land here (file too big, unsupported format)
      res.status(400).json({ error: err.message });
    }
  });

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

      const { fetchCardRevealDataForCertPk, fetchGradeBreakdownDataForCertPk, fetchPostData } =
        await import("./ig/data-fetcher");
      let data;
      if (row.certId != null && row.postType === "card_reveal") {
        data = await fetchCardRevealDataForCertPk(row.certId);
      } else if (row.certId != null && row.postType === "grade_breakdown") {
        data = await fetchGradeBreakdownDataForCertPk(row.certId);
      } else {
        data = await fetchPostData(row.postType as any);
      }
      if (!data)
        return res
          .status(409)
          .json({ error: "Could not rebuild post data (cert may be deleted or post type unavailable)" });

      const { generateCaption } = await import("./ig/caption-generator");
      const { caption, hashtags, fromFallback } = await generateCaption(data);

      await db.update(igPostQueue).set({ caption, hashtags }).where(eq(igPostQueue.id, id));
      try {
        await storage.writeAuditLog("ig_post", String(id), "regenerate_caption", adminEmail, { fromFallback });
      } catch {}
      res.json({ ok: true, caption, hashtags, fromFallback });
    } catch (err: any) {
      sendServerError(res, err);
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

      const { fetchCardRevealDataForCertPk, fetchGradeBreakdownDataForCertPk, fetchPostData } =
        await import("./ig/data-fetcher");
      let data;
      if (row.certId != null && row.postType === "card_reveal") {
        data = await fetchCardRevealDataForCertPk(row.certId);
      } else if (row.certId != null && row.postType === "grade_breakdown") {
        data = await fetchGradeBreakdownDataForCertPk(row.certId);
      } else {
        data = await fetchPostData(row.postType as any);
      }
      if (!data)
        return res
          .status(409)
          .json({ error: "Could not rebuild post data (cert may be deleted or post type unavailable)" });

      const { generateIgImage } = await import("./ig/image-generator");
      const imageBuffer = await generateIgImage(data);

      const newKey = `ig/regen/${id}-${Date.now()}.png`;
      const { uploadToR2 } = await import("./r2");
      await uploadToR2(newKey, imageBuffer, "image/png");

      await db.update(igPostQueue).set({ imageR2Key: newKey }).where(eq(igPostQueue.id, id));

      try {
        await storage.writeAuditLog("ig_post", String(id), "image_regenerate", adminEmail, {
          old_key: row.imageR2Key,
          new_key: newKey,
        });
      } catch {}
      res.json({ ok: true, r2Key: newKey });
    } catch (err: any) {
      sendServerError(res, err);
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
      sendServerError(res, err);
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
      const rows = await db
        .select()
        .from(igPostQueue)
        .where(and(eq(igPostQueue.id, id), isNull(igPostQueue.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) return res.status(404).json({ error: "Queue row not found or already deleted" });

      if (row.status === "posted") {
        return res.status(409).json({ error: "Cannot delete a published post (preserves Meta post-ID audit trail)" });
      }

      await db.update(igPostQueue).set({ deletedAt: new Date() }).where(eq(igPostQueue.id, id));

      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
      try {
        await storage.writeAuditLog("ig_post_queue", String(id), "admin_delete", adminEmail, {
          prior_status: row.status,
          prior_scheduled_for: row.scheduledFor,
          post_type: row.postType,
          cert_id: row.certId,
          reason,
        });
      } catch {}
      res.status(204).end();
    } catch (err: any) {
      sendServerError(res, err);
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
      const certRows = await db
        .select()
        .from(certificates)
        .where(and(eq(certificates.id, certId), isNull(certificates.deletedAt)))
        .limit(1);
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
      const data =
        postType === "card_reveal"
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

      const [inserted] = await db
        .insert(igPostQueue)
        .values({
          scheduledFor: new Date(),
          postType,
          certId,
          imageR2Key: r2Key,
          caption,
          hashtags,
          status: "ready",
        })
        .returning();

      try {
        await storage.writeAuditLog("ig_post_queue", String(inserted.id), "admin_queue_from_cert", adminEmail, {
          cert_id: certId,
          post_type: postType,
          requested_type: requestedType,
          source: "admin_dashboard",
          caption_fallback: fromFallback,
        });
      } catch {}

      res.status(201).json({ ok: true, row: inserted, fromFallback });
    } catch (err: any) {
      console.error("[ig/queue/from-cert] failed:", err);
      sendServerError(res, err);
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
