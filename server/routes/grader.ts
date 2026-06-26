/**
 * server/routes/grader.ts — restricted-grader endpoints + admin grader management.
 * GRADER V2: cert-level. A grader is assigned individual CERTIFICATES (not whole
 * submissions), so each card in a multi-card submission is graded independently.
 *
 * Two surfaces:
 *  • /api/grader/*  — grader-only (requireGrader). PII-FREE: never returns a
 *    customer name/email/phone/address. Ownership-scoped to the grader's OWN
 *    assigned certs (authorizeGraderCert). The panel actions (crop/centre/
 *    analyse/identify/grade-card/generate-description) are served by a single
 *    DELEGATION PROXY that re-dispatches to the unchanged, PII-free admin
 *    handlers after verifying ownership — so the MVGS panel is reused, not forked.
 *  • /api/admin/graders/* etc. — admin-only (requireAdmin): accounts, cert-level
 *    assignment, approve/reject of pending_review certs, the per-card rate.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import { storage } from "../storage";
import { requireCapability, authenticateStaff } from "../staff";
import {
  authenticateGrader,
  createGraderAccount,
  getCertAssignment,
  assignCerts,
  reassignCerts,
  unassignCerts,
  getCertsForSubmission,
  buildCertImagesPayload,
  buildCertGradingPayload,
  applyCertGradeDraft,
  adminReviewSaveDraft,
  approveGraderCert,
  rejectCertGrade,
  getGraderEarnings,
  getGraderCountsForAdmin,
  getGraderRate,
  setGraderRate,
  getGraderDailyTarget,
  setGraderDailyTarget,
  stripGraderPii,
  GRADER_AUTO_PUBLISH,
  getOperatorReviewRate,
} from "../grader";
import { db } from "../db";
import { sql } from "drizzle-orm";

const graderLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

/** Panel actions the grader proxy may delegate to the admin handlers. */
const GRADER_PROXY_ACTIONS = new Set([
  "recrop",
  "manual-centering",
  "detect-card-bounds",
  "identify-and-analyze",
  "identify",
  "analyze",
  "grade-card",
  "generate-description",
]);

/** Ownership gate (cert-level): the cert must be assigned to THIS grader and not
 *  yet approved. Returns the current grader_status for status-specific checks. */
async function authorizeGraderCert(
  req: Request,
  certId: number
): Promise<{ ok: true; gradingStatus: string } | { ok: false; status: number; error: string }> {
  const graderId = (req.session as any).graderId as string;
  const a = await getCertAssignment(certId);
  if (!a) return { ok: false, status: 404, error: "Not found" };
  if (a.assignedGraderId !== graderId || a.gradingStatus === "approved") {
    return { ok: false, status: 403, error: "This card is not assigned to you" };
  }
  return { ok: true, gradingStatus: a.gradingStatus };
}

export function registerGraderRoutes(app: Express): void {
  // ── Grader auth ─────────────────────────────────────────────────────────────
  app.post("/api/grader/login", graderLoginLimit, async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      // Unified: a "grader" is now a staffer with the 'grade' capability. This
      // legacy endpoint loads full capabilities (the client /grader/login page
      // redirects to /staff/login; this stays a working alias).
      const result = await authenticateStaff(email, password);
      if (!result.ok) {
        await storage.writeAuditLog("staff_auth", String(email || "unknown"), "grader_login_failure", null, {});
        return res.status(401).json({ error: "invalid_credentials" });
      }
      await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
      const s = req.session as any;
      s.isStaff = true;
      s.staffId = result.id;
      s.staffEmail = result.email;
      s.capGrade = result.caps.grade;
      s.capScan = result.caps.scan;
      s.capPrint = result.caps.print;
      s.isGrader = result.caps.grade;
      s.graderId = result.id;
      s.graderEmail = result.email;
      s.isAdmin = false;
      s.adminEmail = undefined;
      s.pendingAdmin = false;
      s.userId = undefined;
      s.userEmail = undefined;
      s.customerEmail = undefined;
      await storage.writeAuditLog("staff_auth", result.id, "grader_login", result.email, { caps: result.caps });
      return res.json({ email: result.email, displayName: result.displayName, caps: result.caps });
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
    if (s && s.isGrader && s.graderId && !s.isAdmin) return res.json({ authenticated: true, email: s.graderEmail });
    return res.json({ authenticated: false });
  });

  // ── Grader queue (PII-FREE, cert-level, grouped by submission) ──────────────
  app.get("/api/grader/queue", requireCapability("grade"), async (req: Request, res: Response) => {
    try {
      const graderId = (req.session as any).graderId as string;
      const rows = await db.execute(sql`
        SELECT cert.id AS cert_id, cert.certificate_number AS cert_id_str, cert.grader_status, cert.assigned_at,
               cert.rejection_reason, cert.redo_count, cert.card_game, cert.set_name, cert.card_name,
               cert.card_number_display AS card_number, cert.year_text AS year, cert.variant, cert.grade,
               c.submission_id, s.tracking_number AS submission_ref, s.service_tier
        FROM certificates cert
        -- LEFT JOIN: a cert assigned at the cert level can have a NULL card_id (no
        -- linked card row). getGraderAnalytics counts certs directly with no join,
        -- so an INNER JOIN here silently dropped those assigned certs from the queue
        -- (the count showed N "assigned" while the list was empty). Card name/set/etc.
        -- come from cert.* columns regardless; only submission grouping goes null.
        LEFT JOIN cards c ON cert.card_id = c.id
        LEFT JOIN submissions s ON s.id = c.submission_id
        WHERE cert.assigned_grader_id = ${graderId}
          AND cert.grader_status IN ('assigned', 'pending_review')
          AND cert.deleted_at IS NULL
        ORDER BY cert.assigned_at DESC NULLS LAST, cert.id DESC
      `);
      // Group certs by submission for the UI (one card row per cert).
      const bySub = new Map<string, any>();
      for (const r of rows.rows as any[]) {
        const key = String(r.submission_id);
        if (!bySub.has(key)) {
          bySub.set(key, {
            submissionId: Number(r.submission_id),
            submissionRef: r.submission_ref,
            serviceTier: r.service_tier ?? null,
            cards: [],
          });
        }
        bySub.get(key).cards.push({
          certId: Number(r.cert_id),
          certIdStr: r.cert_id_str,
          cardGame: r.card_game ?? null,
          setName: r.set_name ?? null,
          cardName: r.card_name ?? null,
          cardNumber: r.card_number ?? null,
          year: r.year ?? null,
          variant: r.variant ?? null,
          grade: r.grade ?? null,
          gradingStatus: r.grader_status,
          rejectionReason: r.rejection_reason ?? null,
          redoCount: Number(r.redo_count ?? 0),
        });
      }
      return res.json({ items: Array.from(bySub.values()) });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/grader/earnings", requireCapability("grade"), async (req: Request, res: Response) => {
    const graderId = (req.session as any).graderId as string;
    return res.json(await getGraderEarnings(graderId));
  });

  // ── Grader cert reads (ownership-scoped, PII-free) ──────────────────────────
  app.get("/api/grader/certificates/:id/images", requireCapability("grade"), async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const auth = await authorizeGraderCert(req, certId);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const payload = await buildCertImagesPayload(certId);
    if (!payload) return res.status(404).json({ error: "Certificate not found" });
    return res.json(payload);
  });

  app.get("/api/grader/certificates/:id/grading", requireCapability("grade"), async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const auth = await authorizeGraderCert(req, certId);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    let payload = await buildCertGradingPayload(certId);
    if (!payload) return res.status(404).json({ error: "Certificate not found" });
    // Card IDENTIFICATION is deferred off the scan path. If it hasn't run for this
    // cert, compute it NOW (bounded ~20s) and re-read, so it's present on first
    // paint — the grader sees a computing state during the wait, never silently
    // absent until refresh. Fails gracefully (cert still served).
    // Per-device AI-identify toggle: the client sends ?aiIdentify=0 when OFF, which
    // SKIPS the identify call entirely (grader enters the identity manually).
    const aiIdentifyOff = req.query.aiIdentify === "0";
    const ai = (payload as any).aiAnalysis;
    if (!aiIdentifyOff && (!ai || (typeof ai === "object" && Object.keys(ai).length === 0))) {
      const { ensureAiDraft } = await import("../scan-ingest-service");
      await ensureAiDraft(certId);
      payload = (await buildCertGradingPayload(certId)) ?? payload;
    }
    // Self-heal a card_name that was clobbered to "" (the on-open identify wrote
    // the real name to the snapshot, but a downstream save emptied the column).
    // Cheap, deterministic, no AI re-run. Re-read so the grader sees the fix now.
    if (!aiIdentifyOff && (!(payload as any).cardName || String((payload as any).cardName).trim() === "")) {
      const { repairEmptyIdentityFromSnapshot } = await import("../scan-ingest-service");
      if (await repairEmptyIdentityFromSnapshot(certId)) {
        payload = (await buildCertGradingPayload(certId)) ?? payload;
      }
    }
    return res.json(payload);
  });

  // ── Grader DRAFT save (repeatable; status stays 'assigned') ─────────────────
  app.put("/api/grader/certificates/:id/grade", requireCapability("grade"), async (req: Request, res: Response) => {
    try {
      const certId = parseInt(String(req.params.id), 10);
      const auth = await authorizeGraderCert(req, certId);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      if (auth.gradingStatus !== "assigned") {
        return res.status(409).json({ error: `Card is '${auth.gradingStatus}', not editable` });
      }
      await applyCertGradeDraft(certId, req.body || {});
      return res.json({ ok: true, gradingStatus: "assigned" });
    } catch (e: any) {
      console.error("[grader] draft save error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Grader SUBMIT for approval (assigned → pending_review) ───────────────────
  // Registered BEFORE the generic :action proxy so 'submit' isn't proxied.
  app.post("/api/grader/certificates/:id/submit", requireCapability("grade"), async (req: Request, res: Response) => {
    try {
      const certId = parseInt(String(req.params.id), 10);
      const auth = await authorizeGraderCert(req, certId);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      if (auth.gradingStatus !== "assigned") {
        return res.status(409).json({ error: `Card is '${auth.gradingStatus}', not submittable` });
      }
      const graderEmail = (req.session as any).graderEmail as string;
      const graderId = (req.session as any).graderId || null;
      // Persist any final edits in the same action, then transition.
      if (req.body && Object.keys(req.body).length) await applyCertGradeDraft(certId, req.body);

      // PHASE 3 — capture the OPERATOR's own submission as an immutable snapshot.
      // applyCertGradeDraft (above) has just written the operator's overall grade
      // and four subgrades onto the cert columns; we snapshot them here so a later
      // admin override of `grade`/subgrades never overwrites what the operator
      // actually submitted. graded_by records WHO graded (the operator), distinct
      // from grade_approved_by (WHO approved). Re-submits (redo) re-snapshot the
      // operator's latest attempt — the one that gets reviewed/approved.
      const captureOperatorSubmission = sql`
        graded_by = COALESCE(${graderId}, assigned_grader_id),
        operator_grade = grade,
        operator_subgrades = jsonb_build_object(
          'centering', centering_score, 'corners', corners_score,
          'edges', edges_score, 'surface', surface_score)`;

      if (GRADER_AUTO_PUBLISH) {
        // AUTO-PUBLISH FLIP: publish directly, skip admin review.
        await db.execute(sql`
          UPDATE certificates SET grade_approved_at = NOW(), grade_approved_by = ${graderEmail}, status = 'active',
            grader_status = 'approved', graded_at = NOW(), ${captureOperatorSubmission}, updated_at = NOW() WHERE id = ${certId}
        `);
        await storage.writeAuditLog("certificate", String(certId), "grade_submit", graderEmail, {
          auto_published: true,
        });
        return res.json({ ok: true, gradingStatus: "approved" });
      }

      // ── PHASE 4 — per-operator review gate (deterministic sampling) ──────────
      // Move to pending_review + snapshot the operator's submission (Phase 3).
      await db.execute(sql`
        UPDATE certificates SET grader_status = 'pending_review', graded_at = NOW(),
          ${captureOperatorSubmission}, updated_at = NOW() WHERE id = ${certId}
      `);

      // Read back exactly what we just snapshotted + the gate inputs.
      const gateRow = (
        await db.execute(sql`SELECT operator_grade, card_name FROM certificates WHERE id = ${certId}`)
      ).rows[0] as any;
      const operatorGrade = gateRow?.operator_grade;
      const cardName = gateRow?.card_name;
      // Hard overrides — never auto-approve: no grade to promote to final, or an
      // unidentified card (never push an unnamed card live).
      const gradeMissing = operatorGrade == null || String(operatorGrade).trim() === "";
      const nameMissing = !cardName || String(cardName).trim() === "";

      const reviewRate = await getOperatorReviewRate(graderId);
      // Deterministic sampling — Knuth multiplicative hash of the cert id, mod 100.
      // Review when bucket < rate, so ~rate% of a grader's cards are reviewed and
      // the rest auto-approve. Pure function of certId → the SAME cert always
      // decides the same way (reproducible, NOT random per call / per resubmit).
      const bucket = (Math.imul(certId, 2654435761) >>> 0) % 100;

      // rate 100 → always review; rate 0 → never review; else sample by bucket.
      const forceReview = gradeMissing || nameMissing;
      const reviewRequired = forceReview || reviewRate >= 100 || (reviewRate > 0 && bucket < reviewRate);

      if (reviewRequired) {
        await db.execute(sql`UPDATE certificates SET review_required = true, updated_at = NOW() WHERE id = ${certId}`);
        await storage.writeAuditLog("certificate", String(certId), "grade_submit", graderEmail, {
          review_required: true,
          review_rate: reviewRate,
          ...(forceReview
            ? { forced: gradeMissing ? "operator_grade_null" : "unidentified" }
            : { sampled_bucket: bucket }),
        });
        return res.json({ ok: true, gradingStatus: "pending_review", reviewRequired: true });
      }

      // AUTO-APPROVE — sampling cleared this card without manual review. Promote
      // the operator's grade to final and publish. grade_approved_by = 'auto' is a
      // deliberate system marker, distinguishable from any human approver.
      await db.execute(sql`
        UPDATE certificates SET
          review_required = false,
          grade = operator_grade,
          grade_approved_at = NOW(),
          grade_approved_by = 'auto',
          grader_status = 'approved',
          status = 'active',
          updated_at = NOW()
        WHERE id = ${certId}
      `);
      await storage.writeAuditLog("certificate", String(certId), "auto_approve", "system", {
        operator_grade: operatorGrade ?? null,
        graded_by: graderId,
        review_rate: reviewRate,
        sampled_bucket: bucket,
      });
      return res.json({ ok: true, gradingStatus: "approved", autoApproved: true });
    } catch (e: any) {
      console.error("[grader] submit error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Grader panel-action DELEGATION PROXY ────────────────────────────────────
  // Verify grader OWNERSHIP, then re-dispatch to the unchanged admin handler
  // (PII-free, cert-scoped). __graderProxy lets requireAdmin pass for this one
  // request only. Body is already parsed; express.json() is a no-op on re-handle.
  app.post("/api/grader/certificates/:id/:action", requireCapability("grade"), async (req: Request, res: Response) => {
    const action = String(req.params.action);
    if (!GRADER_PROXY_ACTIONS.has(action)) return res.status(404).json({ error: "Unknown action" });
    const certId = parseInt(String(req.params.id), 10);
    const auth = await authorizeGraderCert(req, certId);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    (req as any).__graderProxy = true;
    // PII GUARD (defence-in-depth): proxied admin handlers may return the full
    // certificate (incl. owner/claim fields). Strip every PII key from the
    // response before it reaches the grader, regardless of handler shape.
    const origJson = res.json.bind(res);
    (res as any).json = (body: any) => origJson(stripGraderPii(body));
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = `/api/admin/certificates/${certId}/${action}${qs}`;
    return (req.app as any).handle(req, res);
  });

  // ── Admin: grader accounts (+ per-grader counts) ────────────────────────────
  app.get("/api/admin/graders", requireAdmin, async (_req: Request, res: Response) => {
    return res.json({ graders: await getGraderCountsForAdmin() });
  });

  app.post("/api/admin/graders", requireAdmin, async (req: Request, res: Response) => {
    const { email, password, display_name } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const result = await createGraderAccount(email, password, display_name ?? null, adminUser);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({ id: result.id, email: result.email });
  });

  // ── Admin: per-card grader rate (earnings display) ──────────────────────────
  app.get("/api/admin/grader-rate", requireAdmin, async (_req: Request, res: Response) => {
    return res.json({ rate: await getGraderRate(), dailyTarget: await getGraderDailyTarget() });
  });
  app.post("/api/admin/grader-rate", requireAdmin, async (req: Request, res: Response) => {
    const adminUser = (req.session as any).adminEmail || "admin";
    const body = req.body || {};
    // rate and dailyTarget are independent — save each only when a valid value is
    // provided so saving one never clobbers the other (rate stays Cornelius's call).
    const rate = Number(body.rate);
    const hasRate = body.rate !== undefined && body.rate !== null && body.rate !== "";
    if (hasRate && (!Number.isFinite(rate) || rate < 0)) return res.status(400).json({ error: "Invalid rate" });
    const dailyTarget = Number(body.dailyTarget);
    const hasTarget = body.dailyTarget !== undefined && body.dailyTarget !== null && body.dailyTarget !== "";
    if (hasTarget && (!Number.isFinite(dailyTarget) || dailyTarget <= 0))
      return res.status(400).json({ error: "Invalid daily target" });
    if (hasRate) await setGraderRate(rate, adminUser);
    if (hasTarget) await setGraderDailyTarget(dailyTarget, adminUser);
    return res.json({ ok: true, rate: await getGraderRate(), dailyTarget: await getGraderDailyTarget() });
  });

  // ── Admin: cert-level assignment ────────────────────────────────────────────
  app.get("/api/admin/submissions/:id/certs", requireAdmin, async (req: Request, res: Response) => {
    const sid = parseInt(String(req.params.id), 10);
    return res.json({ certs: await getCertsForSubmission(sid) });
  });

  app.post("/api/admin/graders/assign", requireAdmin, async (req: Request, res: Response) => {
    const { grader_id, cert_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await assignCerts(String(grader_id), Array.isArray(cert_ids) ? cert_ids.map(Number) : [], adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  app.post("/api/admin/graders/reassign", requireAdmin, async (req: Request, res: Response) => {
    const { grader_id, cert_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await reassignCerts(String(grader_id), Array.isArray(cert_ids) ? cert_ids.map(Number) : [], adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  app.post("/api/admin/graders/unassign", requireAdmin, async (req: Request, res: Response) => {
    const { cert_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await unassignCerts(Array.isArray(cert_ids) ? cert_ids.map(Number) : [], adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  // ── Admin: approve / reject a grader-submitted (pending_review) cert ────────
  app.post("/api/admin/certificates/:id/approve-grader-grade", requireAdmin, async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await approveGraderCert(certId, adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, gradingStatus: "approved" });
  });

  app.post("/api/admin/certificates/:id/reject-grade", requireAdmin, async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const adminUser = (req.session as any).adminEmail || "admin";
    const reason = typeof (req.body || {}).reason === "string" ? (req.body.reason as string).slice(0, 1000) : null;
    const r = await rejectCertGrade(certId, reason, adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, gradingStatus: "assigned" });
  });

  // ── Admin grade-review namespace ────────────────────────────────────────────
  // Drives the SAME grading panel (mounted with apiBase="/api/admin/grade-review"
  // + adminReview) to review a grader-submitted (pending_review) cert with the
  // full inspection tools. requireAdmin, PII-free (reuses the grader builders),
  // NOT grader-locked, pending_review-gated, NON-publishing. Approve/Reject stay
  // the existing approve-grader-grade / reject-grade endpoints below.
  app.get("/api/admin/grade-review/certificates/:id/grading", requireAdmin, async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const a = await getCertAssignment(certId);
    if (!a) return res.status(404).json({ error: "Certificate not found" });
    if (a.gradingStatus !== "pending_review")
      return res.status(409).json({ error: `Card is '${a.gradingStatus}', not pending review` });
    let grading = await buildCertGradingPayload(certId);
    if (!grading) return res.status(404).json({ error: "Certificate not found" });
    // Self-heal an empty card_name from the confirmed snapshot (see grader GET).
    if (!(grading as any).cardName || String((grading as any).cardName).trim() === "") {
      const { repairEmptyIdentityFromSnapshot } = await import("../scan-ingest-service");
      if (await repairEmptyIdentityFromSnapshot(certId)) {
        grading = (await buildCertGradingPayload(certId)) ?? grading;
      }
    }
    return res.json(grading);
  });
  app.get("/api/admin/grade-review/certificates/:id/images", requireAdmin, async (req: Request, res: Response) => {
    const certId = parseInt(String(req.params.id), 10);
    const a = await getCertAssignment(certId);
    if (!a) return res.status(404).json({ error: "Certificate not found" });
    if (a.gradingStatus !== "pending_review")
      return res.status(409).json({ error: `Card is '${a.gradingStatus}', not pending review` });
    const images = await buildCertImagesPayload(certId);
    if (!images) return res.status(404).json({ error: "Certificate not found" });
    return res.json(images);
  });
  app.put("/api/admin/grade-review/certificates/:id/grade", requireAdmin, async (req: Request, res: Response) => {
    try {
      const adminUser = (req.session as any).adminEmail || "admin";
      const r = await adminReviewSaveDraft(parseInt(String(req.params.id), 10), req.body || {}, adminUser);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[admin grade-review save] error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // Card-tool / AI panel actions (recrop, manual-centering, detect-card-bounds,
  // identify, analyze, …). The review panel reuses the same inspection tools, so
  // proxy these to the unchanged admin handlers — exactly like the grader proxy,
  // but gated on requireAdmin + pending_review (no grader-ownership check). Without
  // this, the card tool's saves 404'd to the SPA in review mode ("Unexpected token
  // '<'" / Centering save failed). PII-stripped to match this namespace.
  app.post("/api/admin/grade-review/certificates/:id/:action", requireAdmin, async (req: Request, res: Response) => {
    const action = String(req.params.action);
    if (!GRADER_PROXY_ACTIONS.has(action)) return res.status(404).json({ error: "Unknown action" });
    const certId = parseInt(String(req.params.id), 10);
    const a = await getCertAssignment(certId);
    if (!a) return res.status(404).json({ error: "Certificate not found" });
    if (a.gradingStatus !== "pending_review")
      return res.status(409).json({ error: `Card is '${a.gradingStatus}', not pending review` });
    const origJson = res.json.bind(res);
    (res as any).json = (body: any) => origJson(stripGraderPii(body));
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = `/api/admin/certificates/${certId}/${action}${qs}`;
    return (req.app as any).handle(req, res);
  });
}
