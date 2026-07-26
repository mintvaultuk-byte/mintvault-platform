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
      const cert = buildPreviewFields(req.body ?? {}) as unknown as CertificateRecord;
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
