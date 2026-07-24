/**
 * Pure builder for the in-memory certificate object the FRONT-label preview
 * renders from unsaved workstation values. No I/O — the server route casts the
 * result to CertificateRecord and passes it to the UNMODIFIED generateLabelPNG.
 * Kept pure so it is unit-testable without importing the render pipeline.
 */
const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Grading/measurement fields copied through when present so the black/white
 *  (Pristine) label decision matches print. */
const GRADE_PASSTHROUGH = [
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
] as const;

export function buildPreviewFields(body: Record<string, unknown>): Record<string, unknown> {
  const cert: Record<string, unknown> = {
    // Non-empty placeholder id — the renderer strips "MV" before printing.
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
  for (const key of GRADE_PASSTHROUGH) {
    if (body[key] != null) cert[key] = num(body[key]);
  }
  // Cap the defect array — the preview render iterates it; an unbounded array
  // from the client is a needless CPU sink (200 is well above any real card).
  if (Array.isArray(body.defects)) cert.defects = body.defects.slice(0, 200);
  return cert;
}
