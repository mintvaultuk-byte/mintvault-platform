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
import { buildPreviewFields } from "@shared/label-preview-fields";
import { canReadCatalogue } from "@shared/catalogue-access";
import { applyStructuredVariantFromBody } from "../../lib/structured-variant";
import { getCatalogueSnapshot } from "../../lib/catalogue-provider";
import { storage } from "../../storage";

// Every certificate column the Pristine / black-label gate reads. When the preview
// is editing a SAVED cert these are restored from the saved row so a request body
// can never flip the black↔white decision away from what the printed slab shows.
// Keep in sync with buildPreviewFields' GRADE_PASSTHROUGH + the grade + defect fields.
const PRISTINE_GATE_COLUMNS = [
  "gradeType",
  "gradeOverall",
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
  "defects",
] as const;

const previewLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many preview requests. Please slow down." },
});

function adminOrStaffRead(req: Request, res: Response, next: NextFunction): void {
  if (canReadCatalogue(req.session as { isAdmin?: boolean; isGrader?: boolean } | undefined)) return next();
  res.status(401).json({ error: "Authentication required" });
}

export function registerLabelPreviewRoutes(app: Express): void {
  app.post("/api/admin/certificates/label/preview", previewLimit, adminOrStaffRead, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const preview = buildPreviewFields(body) as unknown as CertificateRecord;

      // Black-label (Pristine 10P) fidelity: when the workstation is editing an
      // EXISTING cert, start from its SAVED grade / subgrade / defect / measurement
      // columns — the exact inputs the Pristine gate reads — and overlay only the
      // capped, label-relevant metadata (name/set/variant/rarity/…). This is a
      // read-only lookup (never writes, gated to admin/staff) and reproduces the
      // 1:1 fidelity model the Review-stage preview shipped with, so a premium
      // black-label cert previews black, not white. Absent a saved row (create
      // flow) the preview is the pure function of the posted fields.
      let cert = preview;
      const rawId = body.certificateId ?? body.id;
      const numericId = rawId != null && rawId !== "" ? parseInt(String(rawId), 10) : NaN;
      if (Number.isFinite(numericId)) {
        const saved = await storage.getCertificate(numericId);
        if (saved) {
          cert = { ...(saved as CertificateRecord), ...preview } as CertificateRecord;
          // Grade is READ-ONLY in the workstation and the Pristine/black-label gate
          // must stay internally consistent with the printed slab, so EVERY column
          // the gate reads comes SOLELY from the saved row — never the request body.
          // buildPreviewFields will copy grade/subgrade/defect fields through when a
          // body supplies them, which would let a preview request flip the black↔white
          // decision away from print; restoring them from `saved` here forecloses that.
          const s = saved as Record<string, unknown>;
          const c = cert as Record<string, unknown>;
          for (const key of PRISTINE_GATE_COLUMNS) c[key] = s[key];
        }
      }

      // Apply the SAME server-authoritative, catalogue-validated structured-variant
      // derivation the save routes use, so the live preview shows the ONE consolidated
      // variant line (structuredVariantVersion 2 → labels.ts consolidatedVariantForLabel)
      // and therefore matches the printed label 1:1. Best-effort: invalid structured
      // input simply isn't applied (the renderer falls back to the legacy line) — a
      // preview must never fail on unsaved, half-typed values. getCatalogueSnapshot
      // falls back to the seed catalogue if catalogue_items is absent (pre-migration).
      try {
        applyStructuredVariantFromBody(
          body,
          cert as unknown as Record<string, unknown>,
          await getCatalogueSnapshot(),
          (cert as unknown as { structuredVariantVersion?: number | null }).structuredVariantVersion,
        );
      } catch {
        /* preview stays on the legacy variant line if structured derivation throws */
      }
      const png = await generateLabelPNG(cert, "front");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(png);
    } catch (err) {
      console.error("[label-preview] render failed:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to render preview." });
    }
  });
}
