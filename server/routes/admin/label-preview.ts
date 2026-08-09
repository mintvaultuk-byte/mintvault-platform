/**
 * Live certificate FRONT preview (read-only).
 *
 *   POST /api/admin/certificates/label/preview   → image/png (front slab label)
 *
 * Renders the REAL printed front label for UNSAVED workstation values by calling
 * the existing, UNMODIFIED generateLabelPNG(cert, "front") from server/labels.ts
 * with an in-memory certificate-shaped object. Existing-certificate adapters do
 * an authorised read before composition; the renderer itself performs no writes,
 * allocation, lifecycle transition, R2, NFC, claim-code, or credit action.
 *
 * This route does NOT modify the protected rendering pipeline; it only calls it.
 * Each role has a separate server-authorised adapter over the one renderer.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { checkPrintableGrade, UnprintableGradeError } from "@shared/printable-grade";
import type { CertificateRecord } from "@shared/schema";
import { storage } from "../../storage";
import { requireAdmin } from "../../auth";
import { requireCapability } from "../../staff";
import { getCertAssignment } from "../../grader";
import { buildLabelPreviewCertificate, generateLabelPreviewPNG } from "../../services/label-preview";
import { authorizeStaffLabelPreview, previewCertificateId } from "../../services/label-preview-access";

const previewLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many preview requests. Please slow down." },
});

async function renderPreview(req: Request, res: Response, authorisedId: number | null): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = authorisedId == null ? null : await storage.getCertificate(authorisedId);
    if (authorisedId != null && !saved) {
      res.status(404).json({ error: "Certificate not found" });
      return;
    }
    const cert = await buildLabelPreviewCertificate((saved as CertificateRecord | undefined) ?? null, body);
    // SAME rule as every print path, so the preview can never show something print
    // would refuse (and vice versa). A card that has not been graded yet gets an
    // explicit, honest 422 — the panel shows "not graded yet" instead of the invented
    // 0 / POOR panel the renderer used to produce.
    const verdict = checkPrintableGrade({
      gradeType: (cert as { gradeType?: string | null }).gradeType,
      gradeOverall: (cert as { gradeOverall?: string | number | null }).gradeOverall,
    });
    if (!verdict.printable) {
      res.status(422).json({
        // Concise wording for the small preview panel (the client renders body.error
        // verbatim). The print paths use the fuller explanation.
        error:
          verdict.reason === "missing_numeric_grade"
            ? "Not graded yet — the preview appears once a grade is set."
            : (verdict.message ?? "This certificate's grade cannot be previewed yet."),
        code: "UNPRINTABLE_GRADE",
        reason: verdict.reason,
      });
      return;
    }
    const png = await generateLabelPreviewPNG(cert);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (err) {
    if (err instanceof UnprintableGradeError) {
      res.status(422).json({ error: err.message, code: "UNPRINTABLE_GRADE", reason: err.reason });
      return;
    }
    console.error("[label-preview] render failed:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "Failed to render preview." });
  }
}

export function registerLabelPreviewRoutes(app: Express): void {
  app.post("/api/admin/certificates/label/preview", previewLimit, requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hasId = body.certificateId != null || body.id != null;
    const id = previewCertificateId(body);
    if (hasId && !id) return res.status(400).json({ error: "Valid certificateId required" });
    await renderPreview(req, res, id);
  });

  app.post("/api/admin/grade-review/certificates/label/preview", previewLimit, requireAdmin, async (req, res) => {
    const id = previewCertificateId((req.body ?? {}) as Record<string, unknown>);
    if (!id) return res.status(400).json({ error: "Valid certificateId required" });
    const assignment = await getCertAssignment(id);
    if (!assignment) return res.status(404).json({ error: "Certificate not found" });
    if (assignment.gradingStatus !== "pending_review") {
      return res.status(409).json({ error: "Certificate is not pending review" });
    }
    await renderPreview(req, res, id);
  });

  app.post("/api/grader/certificates/label/preview", previewLimit, requireCapability("grade"), async (req, res) => {
    const id = previewCertificateId((req.body ?? {}) as Record<string, unknown>);
    if (!id) return res.status(400).json({ error: "Valid certificateId required" });
    const assignment = await getCertAssignment(id);
    const access = authorizeStaffLabelPreview(req.session, assignment);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    await renderPreview(req, res, id);
  });
}
