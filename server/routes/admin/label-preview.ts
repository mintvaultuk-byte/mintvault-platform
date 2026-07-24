/**
 * Live certificate FRONT preview (read-only).
 *
 *   POST /api/admin/certificates/label/preview   → image/png (front slab label)
 *
 * Renders the REAL printed front label for UNSAVED workstation values by calling
 * the existing, UNMODIFIED generateLabelPNG(cert, "front") from server/labels.ts
 * with an in-memory certificate-shaped object. There is NO persistence, NO cert
 * lookup, NO R2 access — the preview is a pure function of the posted fields, so
 * it always matches what print will produce for those same values.
 *
 * This route does NOT modify the protected rendering pipeline; it only calls it.
 * Gated to admin OR staff/grader (the grading workstation runs in both contexts).
 */
import type { Express, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { generateLabelPNG } from "../../labels";
import type { CertificateRecord } from "@shared/schema";

const previewLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many preview requests. Please slow down." },
});

function adminOrStaffRead(req: Request, res: Response, next: NextFunction): void {
  const session = req.session as { isAdmin?: boolean; isGrader?: boolean } | undefined;
  if (session?.isAdmin || session?.isGrader) return next();
  res.status(401).json({ error: "Authentication required" });
}

const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Display + grade fields the FRONT render reads. Grading/measurement fields are
 * optional; when present they let the Pristine (black-label) gate match print for
 * borderline cards, exactly as the real print path computes it.
 */
function buildPreviewCert(body: Record<string, unknown>): CertificateRecord {
  const cert: Record<string, unknown> = {
    // Non-empty placeholder id — the renderer only prints "…" after stripping "MV".
    certId: str(body.certId) ?? "MV-PREVIEW",
    gradeType: str(body.gradeType) ?? "numeric",
    gradeOverall: num(body.gradeOverall),
    cardName: str(body.cardName) ?? "",
    setName: str(body.setName) ?? "",
    year: str(body.year, 12) ?? "",
    cardNumber: str(body.cardNumber, 24) ?? "",
    variant: str(body.variant) ?? "",
    variantOther: str(body.variantOther) ?? "",
    rarity: str(body.rarity) ?? "",
    rarityOther: str(body.rarityOther) ?? "",
    labelType: str(body.labelType, 48) ?? "",
    language: str(body.language, 48) ?? "",
  };

  // Optional grading/measurement passthrough so the black/white decision matches
  // print. Copied only when provided; never fabricated.
  for (const key of [
    "gradeCentering",
    "gradeCorners",
    "gradeEdges",
    "gradeSurface",
    "centeringFrontLr",
    "centeringFrontTb",
    "centeringBackLr",
    "centeringBackTb",
    "darkBorderFront",
    "darkBorderBack",
    "eyeAppealModifier",
  ]) {
    if (body[key] != null) cert[key] = num(body[key]);
  }
  if (Array.isArray(body.defects)) cert.defects = body.defects;

  return cert as unknown as CertificateRecord;
}

export function registerLabelPreviewRoutes(app: Express): void {
  app.post("/api/admin/certificates/label/preview", previewLimit, adminOrStaffRead, async (req, res) => {
    try {
      const png = await generateLabelPNG(buildPreviewCert(req.body ?? {}), "front");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(png);
    } catch (err) {
      console.error("[label-preview] render failed:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to render preview." });
    }
  });
}
