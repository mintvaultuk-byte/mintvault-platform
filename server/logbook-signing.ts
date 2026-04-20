/**
 * MintVault Logbook cryptographic signing.
 * HMAC-SHA256 with SIGNED_URL_SECRET. Produces a tamper-evident
 * hash over the canonical cert data that can be verified publicly.
 */
import crypto from "crypto";

export interface LogbookCanonicalData {
  certId: string;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  year: string | number | null;
  gradeOverall: string | number | null;
  gradeCentering: string | number | null;
  gradeCorners: string | number | null;
  gradeEdges: string | number | null;
  gradeSurface: string | number | null;
  gradeApprovedAt: string | null;
}

export function canonicalize(data: LogbookCanonicalData): string {
  const keys = Object.keys(data).sort() as (keyof LogbookCanonicalData)[];
  return keys.map(k => `${k}=${String(data[k] ?? "")}`).join("|");
}

export function signLogbook(data: LogbookCanonicalData): string {
  const secret = process.env.SIGNED_URL_SECRET;
  if (!secret) throw new Error("SIGNED_URL_SECRET not configured");
  const canonical = canonicalize(data);
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function verifyLogbook(data: LogbookCanonicalData, signature: string): boolean {
  try {
    const expected = signLogbook(data);
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

/** Build canonical data from a cert record (any shape) */
export function certToCanonical(c: any): LogbookCanonicalData {
  return {
    certId: c.certId || c.certificate_number || "",
    cardName: c.cardName || c.card_name || null,
    setName: c.setName || c.set_name || null,
    cardNumber: c.cardNumber || c.card_number_display || null,
    year: c.year || c.year_text || null,
    gradeOverall: c.gradeOverall || c.grade || null,
    gradeCentering: c.gradeCentering || c.centering_score || null,
    gradeCorners: c.gradeCorners || c.corners_score || null,
    gradeEdges: c.gradeEdges || c.edges_score || null,
    gradeSurface: c.gradeSurface || c.surface_score || null,
    gradeApprovedAt: c.gradeApprovedAt ? (typeof c.gradeApprovedAt === "string" ? c.gradeApprovedAt : c.gradeApprovedAt.toISOString()) : null,
  };
}
