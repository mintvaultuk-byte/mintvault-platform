/**
 * MintVault Logbook data aggregation service.
 * Builds the full logbook payload from a cert record.
 */
import { storage } from "./storage";
import { getR2SignedUrl } from "./r2";
import { signLogbook, certToCanonical, verifyLogbook } from "./logbook-signing";
import { gradeLabelFull, isNonNumericGrade } from "@shared/schema";
import { mvgsGradeLabel } from "@shared/mvgs-scoring";
import { getOwnerChain } from "./ownership-service";
import { APP_BASE_URL } from "./app-url";
import { db } from "./db";
import { sql } from "drizzle-orm";

function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  if (m) return `MV${m[1]}`;
  return raw;
}

async function signedOrNull(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  try {
    return await getR2SignedUrl(key, 3600);
  } catch {
    return null;
  }
}

export async function buildLogbookData(certIdInput: string) {
  // Flexible lookup: try by certId string, then normalised
  let cert = await storage.getCertificateByCertId(certIdInput);
  if (!cert) {
    const normalised = normalizeCertId(certIdInput);
    cert = await storage.getCertificateByCertId(normalised);
  }
  // Also try with zero-padded format
  if (!cert) {
    const num = certIdInput.replace(/^MV-?0*/i, "");
    if (num) {
      const padded = `MV-${num.padStart(10, "0")}`;
      cert = await storage.getCertificateByCertId(padded);
    }
  }
  if (!cert) return null;
  if (cert.status === "voided") return null;

  const c = cert as any;
  const certId = normalizeCertId(cert.certId);
  const gradeType = c.gradeType || "numeric";
  const isNonNum = isNonNumericGrade(gradeType);
  const gradeNum = isNonNum ? 0 : parseFloat(c.gradeOverall || "0");
  const isBlack = !isNonNum && gradeNum === 10 && c.labelType === "black";

  // Images
  const [frontUrl, backUrl] = await Promise.all([
    signedOrNull(c.gradingFrontCropped || c.gradingFrontOriginal || c.frontImagePath),
    signedOrNull(c.gradingBackCropped || c.gradingBackOriginal || c.backImagePath),
  ]);

  // Population
  let population: any = null;
  try {
    population = await storage.getPopulationData(cert);
  } catch {}

  // Signature
  const canonical = certToCanonical(c);
  let signature: string | null = null;
  try {
    signature = signLogbook(canonical);
  } catch {}

  // Defects
  const defects = Array.isArray(c.defects) ? c.defects : [];

  // Grading report
  const report = c.gradingReport && typeof c.gradingReport === "object" ? c.gradingReport : {};

  // Public-name surfacing (Q1) — same three-gate logic as /api/v1/verify
  // (server/routes.ts:1184): flag on, cert has owner, owner has opted in,
  // owner has a non-empty display_name. Field omitted entirely otherwise.
  // NEVER includes email, real name, or user ID.
  const { FEATURE_FLAGS } = await import("./config/feature-flags");
  let ownerDisplayName: string | undefined;
  const ownerUserId = c.currentOwnerUserId || c.current_owner_user_id;
  if (FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE && ownerUserId) {
    try {
      const row = await db.execute(sql`
        SELECT display_name, public_name FROM users
        WHERE id = ${ownerUserId} AND deleted_at IS NULL
        LIMIT 1
      `);
      const owner = row.rows[0] as any;
      if (owner?.public_name === true) {
        const dn = typeof owner.display_name === "string" ? owner.display_name.trim() : "";
        if (dn.length > 0) ownerDisplayName = dn;
      }
    } catch (e: any) {
      console.warn(`[logbook] owner display_name lookup skipped: ${e.message}`);
    }
  }

  return {
    certId,
    rawCertId: cert.certId,
    referenceNumber: c.referenceNumber || c.reference_number || null,
    currentOwnerUserId: c.currentOwnerUserId || c.current_owner_user_id || null,
    ownerEmail: c.ownerEmail || c.owner_email || null,
    ownerDisplayName,
    logbookVersion: c.logbookVersion || c.logbook_version || 1,
    logbookLastIssuedAt: c.logbookLastIssuedAt || c.logbook_last_issued_at || null,

    card: {
      name: c.cardName || null,
      set: c.setName || null,
      number: c.cardNumber || null,
      year: c.year || null,
      game: c.cardGame || null,
      variant: c.variant || c.variantOther || null,
      language: c.language || "English",
      rarity: c.rarity || c.rarityOther || null,
      collection: c.collection || c.collectionOther || null,
      designations: Array.isArray(c.designations) ? c.designations : [],
    },

    grades: {
      overall: isNonNum ? (gradeType === "authentic_altered" ? "AA" : "NO") : gradeNum,
      gradeLabel: isNonNum
        ? gradeType === "authentic_altered"
          ? "AUTHENTIC ALTERED"
          : "NOT ORIGINAL"
        : isBlack
          ? "PRISTINE 10P"
          : typeof c.gradeStrengthScore === "number" && c.gradeStrengthScore >= 1
            ? mvgsGradeLabel(c.gradeStrengthScore).toUpperCase()
            : gradeLabelFull("numeric", String(gradeNum)),
      centering: c.gradeCentering ? parseFloat(c.gradeCentering) : null,
      corners: c.gradeCorners ? parseFloat(c.gradeCorners) : null,
      edges: c.gradeEdges ? parseFloat(c.gradeEdges) : null,
      surface: c.gradeSurface ? parseFloat(c.gradeSurface) : null,
      isBlackLabel: isBlack,
      isNonNumeric: isNonNum,
      gradeType,
      labelType: c.labelType || "Standard",
    },

    centering: {
      frontLR: c.centeringFrontLr || null,
      frontTB: c.centeringFrontTb || null,
      backLR: c.centeringBackLr || null,
      backTB: c.centeringBackTb || null,
    },

    authentication: {
      status:
        c.gradeType === "authentic_altered"
          ? "authentic_altered"
          : c.gradeType === "not_original"
            ? "not_original"
            : "genuine",
      notes: report.overall || null,
    },

    defects: defects.map((d: any, i: number) => ({
      id: d.id ?? i + 1,
      type: d.type || "Unknown",
      location: d.location || d.image_side || "front",
      severity: d.severity || "minor",
      description: d.description || "",
      // Coordinates for the Condition Report overlay (Q2). Non-sensitive,
      // no flag gate. Flat fields match actual storage; the schema type
      // declaration is fixed in the same PR.
      x_percent: typeof d.x_percent === "number" ? d.x_percent : null,
      y_percent: typeof d.y_percent === "number" ? d.y_percent : null,
      image_side: d.image_side === "back" ? "back" : "front",
    })),

    gradingReport: {
      centering: report.centering || null,
      corners: report.corners || null,
      edges: report.edges || null,
      surface: report.surface || null,
      overall: report.overall || null,
    },

    images: { front: frontUrl, back: backUrl },

    population,

    provenance: {
      issuedAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
      gradedAt: c.gradeApprovedAt ? new Date(c.gradeApprovedAt).toISOString() : null,
      ownershipStatus: c.ownershipStatus || "unclaimed",
      nfcEnabled: !!c.nfcEnabled,
      nfcScanCount: c.nfcScanCount || 0,
      stolenStatus: c.stolenStatus || null,
      stolenReportedAt: c.stolenReportedAt ? new Date(c.stolenReportedAt).toISOString() : null,
      declaredNew: c.declaredNew === true,
    },

    verification: {
      signature,
      signedAt: new Date().toISOString(),
      verifyUrl: `${APP_BASE_URL}/api/logbook/${certId}/verify`,
    },

    ownership: await (async () => {
      try {
        const chain = await getOwnerChain(cert.certId);
        return {
          previousOwnersCount: Math.max(0, chain.length - 1),
          currentOwnerNumber: chain.length || 0,
          chain,
        };
      } catch {
        return { previousOwnersCount: 0, currentOwnerNumber: 0, chain: [] };
      }
    })(),
  };
}

/** Strip owner-sensitive fields for the public JSON endpoint.
 *  ownerDisplayName is INTENTIONALLY KEPT — it's the only owner-identity field
 *  surfaced publicly, gated three ways inside buildLogbookData (flag + opt-in
 *  + non-empty value). All other identity fields (email, user id, ref number,
 *  internal version metadata) are stripped here. */
export function toPublicPayload(data: any) {
  if (!data) return data;
  const { referenceNumber, currentOwnerUserId, ownerEmail, logbookVersion, logbookLastIssuedAt, ...pub } = data;
  return pub;
}

export async function verifyLogbookSignature(
  certIdInput: string,
  providedSignature: string
): Promise<{ valid: boolean; certId: string }> {
  let cert = await storage.getCertificateByCertId(certIdInput);
  if (!cert) {
    const normalised = normalizeCertId(certIdInput);
    cert = await storage.getCertificateByCertId(normalised);
  }
  if (!cert) {
    const num = certIdInput.replace(/^MV-?0*/i, "");
    if (num) cert = await storage.getCertificateByCertId(`MV-${num.padStart(10, "0")}`);
  }
  if (!cert) return { valid: false, certId: certIdInput };

  const canonical = certToCanonical(cert as any);
  const valid = verifyLogbook(canonical, providedSignature);
  return { valid, certId: normalizeCertId(cert.certId) };
}
