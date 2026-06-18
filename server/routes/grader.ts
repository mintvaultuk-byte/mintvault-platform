/**
 * server/routes/grader.ts — restricted-grader endpoints + admin grader management.
 *
 * Two surfaces:
 *  • /api/grader/*  — grader-only (requireGrader). PII-FREE: never returns a
 *    customer name/email/phone/address. Scoped to the grader's OWN assigned
 *    submissions; a grader can only read/grade certificates whose owning
 *    submission is assigned to them.
 *  • /api/admin/graders/* + /api/admin/submissions/:id/approve-grade —
 *    admin-only (requireAdmin) account management, batch assignment, approval.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import { storage } from "../storage";
import {
  requireGrader,
  authenticateGrader,
  createGraderAccount,
  listGraders,
  assignSubmissions,
  reassignSubmissions,
  unassignSubmissions,
  getAssignmentsForSubmissions,
  getSubmissionIdForCert,
  getSubmissionAssignment,
  getCertificatesForSubmission,
  buildCertImagesPayload,
  buildCertGradingPayload,
  applyCertGradeDraft,
  approveCertGrade,
  GRADER_AUTO_PUBLISH,
} from "../grader";
import { db } from "../db";
import { sql } from "drizzle-orm";

// Public grader login — generous for legit retries, tight enough to deter
// credential stuffing (mirrors the account-auth rate-limit posture).
const graderLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

/** Resolve + authorize: the cert's owning submission must be assigned to this grader. */
async function authorizeGraderCert(
  req: Request,
  certId: number
): Promise<{ ok: true; submissionId: number; gradingStatus: string } | { ok: false; status: number; error: string }> {
  const graderId = (req.session as any).graderId as string;
  const sid = await getSubmissionIdForCert(certId);
  if (!sid) return { ok: false, status: 404, error: "Not found" };
  const a = await getSubmissionAssignment(sid);
  if (!a || a.assignedGraderId !== graderId) {
    return { ok: false, status: 403, error: "This card is not assigned to you" };
  }
  return { ok: true, submissionId: sid, gradingStatus: a.gradingStatus };
}

export function registerGraderRoutes(app: Express): void {
  // ── Grader auth ─────────────────────────────────────────────────────────────
  app.post("/api/grader/login", graderLoginLimit, async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      const result = await authenticateGrader(email, password);
      if (!result.ok) {
        await storage.writeAuditLog("grader_auth", String(email || "unknown"), "grader_login_failure", null, {});
        return res.status(401).json({ error: "invalid_credentials" });
      }
      // Regenerate to prevent session fixation, then set grader identity and
      // CLEAR every other login type's fields (no privilege bleed).
      await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
      const s = req.session as any;
      s.isGrader = true;
      s.graderId = result.id;
      s.graderEmail = result.email;
      s.isAdmin = false;
      s.adminEmail = undefined;
      s.pendingAdmin = false;
      s.userId = undefined;
      s.userEmail = undefined;
      s.customerEmail = undefined;
      await storage.writeAuditLog("grader_auth", result.id, "grader_login", result.email, {});
      return res.json({ email: result.email, displayName: result.displayName });
    } catch (e: any) {
      console.error("[grader] login error:", e.message);
      return res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/grader/logout", (req: Request, res: Response) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/grader/session", (req: Request, res: Response) => {
    const s = req.session as any;
    if (s && s.isGrader && s.graderId) return res.json({ authenticated: true, email: s.graderEmail });
    return res.json({ authenticated: false });
  });

  // ── Grader queue (PII-FREE) ─────────────────────────────────────────────────
  // ONLY this grader's submissions in 'assigned' | 'pending_review'. Selects
  // zero customer columns — submission ref + service tier + card metadata only.
  app.get("/api/grader/queue", requireGrader, async (req: Request, res: Response) => {
    try {
      const graderId = (req.session as any).graderId as string;
      const subs = await db.execute(sql`
        SELECT id, tracking_number, grading_status, assigned_at, card_count, service_tier, service_type
        FROM submissions
        WHERE assigned_grader_id = ${graderId}
          AND grading_status IN ('assigned', 'pending_review')
          AND deleted_at IS NULL
        ORDER BY assigned_at DESC NULLS LAST, id DESC
      `);
      const items = await Promise.all(
        (subs.rows as any[]).map(async (s) => ({
          submissionId: Number(s.id),
          submissionRef: s.tracking_number,
          gradingStatus: s.grading_status,
          assignedAt: s.assigned_at,
          cardCount: s.card_count,
          serviceTier: s.service_tier,
          serviceType: s.service_type,
          cards: await getCertificatesForSubmission(Number(s.id)),
        }))
      );
      return res.json({ items });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Grader cert reads (ownership-scoped, PII-free) ──────────────────────────
  app.get("/api/grader/certificates/:id/images", requireGrader, async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const auth = await authorizeGraderCert(req, certId);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const payload = await buildCertImagesPayload(certId);
    if (!payload) return res.status(404).json({ error: "Certificate not found" });
    return res.json(payload);
  });

  app.get("/api/grader/certificates/:id/grading", requireGrader, async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const auth = await authorizeGraderCert(req, certId);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const payload = await buildCertGradingPayload(certId);
    if (!payload) return res.status(404).json({ error: "Certificate not found" });
    return res.json(payload);
  });

  // ── Grader submit (STEP 4 enforcement) ──────────────────────────────────────
  app.put("/api/grader/certificates/:id/grade", requireGrader, async (req: Request, res: Response) => {
    try {
      const certId = parseInt(String(req.params.id), 10);
      const auth = await authorizeGraderCert(req, certId);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      // Must be in the 'assigned' state to submit (not already pending/approved).
      if (auth.gradingStatus !== "assigned") {
        return res.status(409).json({ error: `Card is '${auth.gradingStatus}', not gradeable` });
      }
      const graderEmail = (req.session as any).graderEmail as string;

      await applyCertGradeDraft(certId, req.body || {});

      if (GRADER_AUTO_PUBLISH) {
        // AUTO-PUBLISH FLIP: publish the grade directly, skip admin review.
        await approveCertGrade(certId, graderEmail);
        await db.execute(sql`
          UPDATE submissions SET grading_status = 'approved', graded_at = NOW(), updated_at = NOW()
          WHERE id = ${auth.submissionId}
        `);
        await storage.writeAuditLog("certificate", String(certId), "grade_submit", graderEmail, {
          submission_id: auth.submissionId,
          auto_published: true,
        });
        return res.json({ ok: true, gradingStatus: "approved" });
      }

      // Default: move to pending_review for an admin to approve.
      await db.execute(sql`
        UPDATE submissions SET grading_status = 'pending_review', graded_at = NOW(), updated_at = NOW()
        WHERE id = ${auth.submissionId}
      `);
      await storage.writeAuditLog("certificate", String(certId), "grade_submit", graderEmail, {
        submission_id: auth.submissionId,
      });
      return res.json({ ok: true, gradingStatus: "pending_review" });
    } catch (e: any) {
      console.error("[grader] submit error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: grader account management ────────────────────────────────────────
  app.get("/api/admin/graders", requireAdmin, async (_req: Request, res: Response) => {
    return res.json({ graders: await listGraders() });
  });

  app.post("/api/admin/graders", requireAdmin, async (req: Request, res: Response) => {
    const { email, password, display_name } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const result = await createGraderAccount(email, password, display_name ?? null, adminUser);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({ id: result.id, email: result.email });
  });

  // ── Admin: batch assignment ─────────────────────────────────────────────────
  app.post("/api/admin/graders/assign", requireAdmin, async (req: Request, res: Response) => {
    const { grader_id, submission_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await assignSubmissions(
      String(grader_id),
      Array.isArray(submission_ids) ? submission_ids.map(Number) : [],
      adminUser
    );
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  app.post("/api/admin/graders/reassign", requireAdmin, async (req: Request, res: Response) => {
    const { grader_id, submission_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await reassignSubmissions(
      String(grader_id),
      Array.isArray(submission_ids) ? submission_ids.map(Number) : [],
      adminUser
    );
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  app.post("/api/admin/graders/unassign", requireAdmin, async (req: Request, res: Response) => {
    const { submission_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await unassignSubmissions(Array.isArray(submission_ids) ? submission_ids.map(Number) : [], adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  app.post("/api/admin/graders/assignments", requireAdmin, async (req: Request, res: Response) => {
    const { submission_ids } = req.body || {};
    const map = await getAssignmentsForSubmissions(Array.isArray(submission_ids) ? submission_ids.map(Number) : []);
    return res.json({ assignments: map });
  });

  // ── Admin: approve a grader-submitted submission (pending_review → approved) ──
  app.post("/api/admin/submissions/:id/approve-grade", requireAdmin, async (req: Request, res: Response) => {
    try {
      const sid = parseInt(String(req.params.id), 10);
      const a = await getSubmissionAssignment(sid);
      if (!a) return res.status(404).json({ error: "Submission not found" });
      if (a.gradingStatus !== "pending_review") {
        return res.status(409).json({ error: `Submission is '${a.gradingStatus}', not pending review` });
      }
      const adminUser = (req.session as any).adminEmail || "admin";
      const certs = await getCertificatesForSubmission(sid);
      for (const c of certs) await approveCertGrade(c.certId, adminUser);
      await db.execute(sql`
        UPDATE submissions SET grading_status = 'approved', graded_at = NOW(), updated_at = NOW() WHERE id = ${sid}
      `);
      await storage.writeAuditLog("submission", String(sid), "grade_approve", adminUser, {
        cert_ids: certs.map((c) => c.certId),
      });
      return res.json({ ok: true, gradingStatus: "approved", approved: certs.length });
    } catch (e: any) {
      console.error("[grader] approve error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });
}
