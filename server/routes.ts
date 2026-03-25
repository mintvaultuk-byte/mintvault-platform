import type { Express } from "express";
import { createServer, type Server } from "http";
import { BUILD_STAMP, pricingTiers, calculateOrderTotals, gradeLabel, gradeLabelFull, isNonNumericGrade, SUBMISSION_STATUS_TRANSITIONS, SUBMISSION_STATUS_LABELS, serviceTierToPricingTier } from "@shared/schema";
import type { PublicCertificate, ServiceTierRecord } from "@shared/schema";
import { storage } from "./storage";
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
import { sendSubmissionConfirmation, sendCardsReceived, sendGradingComplete, sendShipped, sendClaimVerification } from "./email";

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
  limits: { fileSize: 10 * 1024 * 1024 },
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

async function certToPublic(c: any): Promise<PublicCertificate> {
  const gradeType = c.gradeType || "numeric";
  const isNonNum = isNonNumericGrade(gradeType);
  const grade = isNonNum ? 0 : parseFloat(c.gradeOverall || "0");

  let frontUrl: string | null = null;
  let backUrl: string | null = null;
  if (c.frontImagePath) {
    try { frontUrl = await getR2SignedUrl(c.frontImagePath, 3600); } catch { frontUrl = null; }
  }
  if (c.backImagePath) {
    try { backUrl = await getR2SignedUrl(c.backImagePath, 3600); } catch { backUrl = null; }
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
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
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

    const dbCert = await findCertByIdFlex(certId);
    if (!dbCert) {
      return res.status(404).json({ error: "Certificate not found" });
    }
    return res.json(await certToPublic(dbCert));
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
      res.json(pricingData);
    } catch (error: any) {
      console.error("Error fetching service tiers:", error.message);
      res.status(500).json({ error: "Failed to fetch service tiers" });
    }
  });

  app.post("/api/create-payment-intent", async (req, res) => {
    try {
      const {
        type, tier, quantity, declaredValue, notes, submissionName,
        email, firstName, lastName, shippingAddress, phone, cardItems,
        crossoverCompany, crossoverOriginalGrade, crossoverCertNumber,
        reholderCompany, reholderReason, reholderCondition,
        authReason, authConcerns,
      } = req.body;

      const VALID_SERVICE_TYPES = ["grading", "reholder", "crossover", "authentication"];
      if (!type || !VALID_SERVICE_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid or missing service type "${type || ""}". Must be one of: ${VALID_SERVICE_TYPES.join(", ")}` });
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

      const { liabilityAccepted, termsAccepted } = req.body;
      if (!liabilityAccepted) {
        return res.status(400).json({ error: "You must accept the Liability & Shipping Policy before proceeding." });
      }
      if (!termsAccepted) {
        return res.status(400).json({ error: "Terms & Conditions must be accepted." });
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
      const total = totals.total;

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
        status: "DRAFT",
        email: email?.toLowerCase(),
        firstName,
        lastName,
        phone: phone || null,
        shippingAddress,
        turnaroundDays,
        shippingCost: totals.shipping,
        shippingInsuranceTier: totals.shippingLabel,
        gradingCost: totals.discountedSubtotal,
        pricePerCardAtPurchase: tierData.pricePerCard,
        insuranceFee: totals.totalInsuranceFee,
        insuranceSurchargePerCard: totals.insuranceSurchargePerCard,
        liabilityAccepted: true,
        liabilityAcceptedAt: new Date(),
        liabilityAcceptedIp: clientIp,
        termsAccepted: true,
        termsAcceptedAt: new Date(),
        termsVersion: "Feb-2026",
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
      });

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
          discountPercent: String(totals.discountPercent),
          discountAmount: String(totals.discountAmount),
          declaredValue: String(totalDeclaredValue),
          declaredValuePerCard: String(declaredValuePerCard),
          shippingInsurance: totals.shippingLabel,
          insuranceFee: String(totals.totalInsuranceFee),
          highValue: String(highValueFlag),
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
      });
    } catch (error: any) {
      console.error("Error creating payment intent:", error.message);
      res.status(500).json({ error: "Failed to create payment" });
    }
  });

  app.post("/api/confirm-payment", async (req, res) => {
    try {
      const { submissionId, paymentIntentId } = req.body;

      const submission = await storage.getSubmissionBySubmissionId(submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const stripe = await getUncachableStripeClient();
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === "succeeded") {
        await storage.updateSubmission(submission.id, {
          status: "new",
        });

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

        sendSubmissionConfirmation({
          email: submission.email || "",
          firstName: submission.firstName || "Customer",
          submissionId: submission.submissionId,
          cardCount: submission.cardCount || 0,
          tier: submission.serviceTier || "standard",
          total: paymentIntent.amount || 0,
          serviceType: submission.serviceType || undefined,
          crossoverCompany: submission.crossover_company || undefined,
          crossoverOriginalGrade: submission.crossover_original_grade || undefined,
          crossoverCertNumber: submission.crossover_cert_number || undefined,
        }).catch(() => {});

        const packingSlipToken = crypto.createHmac("sha256", getSignedUrlSecret()).update(submission.submissionId).digest("hex").slice(0, 16);

        return res.json({
          success: true,
          submissionId: submission.submissionId,
          status: "new",
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
      const id = parseInt(req.params.id, 10);
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
      const submission = await storage.getSubmissionBySubmissionId(req.params.id);
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
      const submission = await storage.getSubmissionBySubmissionId(req.params.id);
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
      }

      res.json({ success: true, submission: updated });
    } catch (error: any) {
      console.error("Update submission status error:", error.message);
      res.status(500).json({ error: "Failed to update submission status" });
    }
  });

  app.patch("/api/admin/submissions/:id/items/:itemId", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(req.params.id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const itemId = parseInt(req.params.itemId, 10);
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
      const submission = await storage.getSubmissionBySubmissionId(req.params.id);
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
      const submission = await storage.getSubmissionBySubmissionId(req.params.id);
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
      const submission = await storage.getSubmissionBySubmissionId(req.params.id);
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

      const certs = await storage.listCertificates(Object.keys(filters).length > 0 ? filters : undefined);
      const certsWithUrls = await Promise.all(certs.map(async (c: any) => {
        let frontImageUrl: string | null = null;
        let backImageUrl: string | null = null;
        if (c.frontImagePath) {
          try { frontImageUrl = await getR2SignedUrl(c.frontImagePath, 3600); } catch {}
        }
        if (c.backImagePath) {
          try { backImageUrl = await getR2SignedUrl(c.backImagePath, 3600); } catch {}
        }
        return { ...c, certId: normalizeCertId(c.certId), frontImageUrl, backImageUrl };
      }));
      res.json(certsWithUrls);
    } catch (error: any) {
      console.error("List certs error:", error.message, error.stack);
      res.status(500).json({ error: `Failed to list certificates: ${error.message}` });
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

        const data = {
          labelType: "Standard",
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
        const id = parseInt(req.params.id, 10);
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

        const data: any = {
          labelType: "Standard",
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
    await storage.writeAuditLog("certificate", req.params.id, "delete_attempt_blocked", req.session.adminEmail || "admin", {
      message: "Hard delete is disabled. Use void instead.",
    });
    res.status(405).json({ error: "DELETE is disabled. Certificates cannot be deleted — use Void instead." });
  });

  app.post("/api/admin/certificates/:id/void", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
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
      const id = parseInt(req.params.id, 10);
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
      const detail = await storage.getSheetDetail(req.params.sheetRef);
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
      const certId = req.params.certId;
      const filename = req.params.filename; // e.g. "front.png", "back.pdf"
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
      const override = await storage.getLabelOverride(req.params.certId);
      res.json(override ?? null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/printing/override/:certId", requireAdmin, async (req, res) => {
    try {
      const { cardNameOverride, setOverride, variantOverride, languageOverride, yearOverride } = req.body;
      const override = await storage.upsertLabelOverride(req.params.certId, {
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
      await storage.clearLabelOverride(req.params.certId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REPRINT SINGLE LABEL ───────────────────────────────────────────────────
  // Generates a 70×20mm PDF, logs the reprint. Does NOT affect the printed flag.
  app.post("/api/admin/printing/reprint/:certId", requireAdmin, async (req, res) => {
    try {
      const certId = req.params.certId;
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
      const id = parseInt(req.params.id, 10);
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
      const target = await storage.getCertificateById(id);
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
      const id = parseInt(req.params.id, 10);
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
      const id = parseInt(req.params.id, 10);
      await storage.recordNfcVerified(id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to record verification" });
    }
  });

  app.delete("/api/admin/certificates/:id/nfc", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
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
        redirectTo: `/cert/${cert.certId}`,
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
  app.post("/api/claim/request", async (req, res) => {
    try {
      const { certId, claimCode, email } = req.body;
      if (!certId || !claimCode || !email) {
        return res.status(400).json({ error: "Certificate number, claim code, and email are required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Please provide a valid email address." });
      }

      const valid = await storage.validateClaimCode(certId.trim(), claimCode.trim());
      if (!valid) {
        return res.status(400).json({ error: "Invalid certificate number or claim code." });
      }

      const token = await storage.createClaimVerification(certId.trim(), email.trim());

      const baseUrl = process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : process.env.REPLIT_DOMAINS
          ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
          : "https://mintvaultuk.com";
      const verifyUrl = `${baseUrl}/api/claim/verify?token=${token}`;

      await sendClaimVerification({ email: email.trim(), certId: certId.trim(), verifyUrl });

      return res.json({ success: true, message: "Verification email sent. Please check your inbox to complete the claim." });
    } catch (err: any) {
      console.error("[claim] Error processing claim request:", err);
      return res.status(500).json({ error: "An error occurred processing your claim. Please try again." });
    }
  });

  app.get("/api/claim/verify", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/claim?error=missing_token");

      const result = await storage.completeClaimByToken(token);
      if (result.success) {
        return res.redirect(`/claim?success=true&certId=${encodeURIComponent(result.certId || "")}`);
      } else {
        return res.redirect(`/claim?error=${encodeURIComponent(result.error || "unknown")}`);
      }
    } catch (err: any) {
      console.error("[claim] Error verifying claim:", err);
      return res.redirect("/claim?error=server_error");
    }
  });

  // ── ADMIN OWNERSHIP ROUTES ────────────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/ownership", requireAdmin, async (req, res) => {
    try {
      const cert = await storage.getCertificateByCertId(req.params.certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const history = await storage.getOwnershipHistory(req.params.certId);

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
        history,
      });
    } catch (err: any) {
      console.error("[admin] Error fetching ownership:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/certificates/:certId/regenerate-claim-code", requireAdmin, async (req, res) => {
    try {
      const cert = await storage.getCertificateByCertId(req.params.certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const claimCode = await storage.generateClaimCode(req.params.certId);
      await storage.writeAuditLog("certificate", req.params.certId, "CLAIM_CODE_REGENERATED", "admin", {});

      return res.json({ certId: req.params.certId, claimCode });
    } catch (err: any) {
      console.error("[admin] Error regenerating claim code:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/certificates/:certId/assign-owner", requireAdmin, async (req, res) => {
    try {
      const { email, notes } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      const cert = await storage.getCertificateByCertId(req.params.certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      await storage.assignOwnerManual(req.params.certId, email, "admin", notes);
      return res.json({ success: true });
    } catch (err: any) {
      console.error("[admin] Error assigning owner:", err);
      return res.status(500).json({ error: "Server error" });
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

  // ── CLAIM INSERT GENERATION ──────────────────────────────────────────────────
  app.post("/api/admin/certificates/:certId/claim-insert", requireAdmin, async (req, res) => {
    try {
      const cert = await storage.getCertificateByCertId(req.params.certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const claimCode = await storage.generateClaimCode(req.params.certId);
      await storage.writeAuditLog("certificate", req.params.certId, "CLAIM_INSERT_GENERATED", "admin", {});

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

        const claimCode = await storage.generateClaimCode(cid);
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
    const baseUrl = "https://mintvault.co.uk";
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
    const baseUrl = "https://mintvault.co.uk";
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

  return httpServer;
}
