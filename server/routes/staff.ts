/**
 * server/routes/staff.ts — unified staff surface (capabilities) + admin staff mgmt.
 *
 *  • /api/staff/login + /session + /logout — one staff login that loads the
 *    person's capabilities into the session.
 *  • /api/staff/scan/*  — can_scan only. PII-FREE. Submission-grained queue +
 *    raw front/back upload onto certs (the grader crops later).
 *  • /api/staff/print/* — can_print only. A re-dispatch proxy to the admin
 *    SLAB-label paths ONLY (never /api/submissions shipping labels), so a
 *    printer can never reach a customer address; JSON responses are PII-sanitised.
 *  • /api/admin/staff/* — admin only: account list+create, capability toggles,
 *    scan assignment.
 *
 * The existing grader routes (server/routes/grader.ts) are re-gated on
 * requireCapability('grade'); the grade session aliases graderId=staffId so that
 * machinery (proxy, ownership, sanitizer) is reused unchanged.
 */
import { sendServerError } from "../lib/error-response";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { requireAdmin } from "../auth";
import { storage } from "../storage";
import { db } from "../db";
import { sql } from "drizzle-orm";
import {
  requireCapability,
  authenticateStaff,
  createStaffAccount,
  deleteStaffAccount,
  listStaffWithCounts,
  setStaffCapabilities,
  setStaffReviewRate,
  updateStaffEmail,
  resetStaffPassword,
  revokeStaffSessions,
  assignScanSubmissions,
  unassignScanSubmissions,
  getScanQueue,
  authorizeScanCert,
  recordScanUpload,
} from "../staff";
import { stripGraderPii, getGraderAnalytics } from "../grader";
import {
  STAFF_ABSOLUTE_SESSION_MS,
  clearSessionCookie,
  credentialVersionOf,
  isAbsoluteSessionExpired,
  stampAuthSession,
} from "../lib/auth-security";
import {
  listSetLibrary,
  recordSetReviewDecision,
  SetLibraryError,
  updateSetLibraryRecord,
} from "../services/set-library";

const staffLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

const adminStaffSecurityLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait 15 minutes and try again." },
});

const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const staffSetLibraryMutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many set library changes. Please wait a few minutes and try again." },
});

function sendSetLibraryError(res: Response, err: unknown): void {
  if (err instanceof SetLibraryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("[staff set-library] request failed:", err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: "Set library request failed" });
}

export function registerStaffRoutes(app: Express): void {
  // ── Staff auth ──────────────────────────────────────────────────────────────
  app.post("/api/staff/login", staffLoginLimit, async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      const r = await authenticateStaff(email, password);
      if (!r.ok) {
        await storage.writeAuditLog("staff_auth", String(email || "unknown"), "staff_login_failure", null, {});
        return res.status(401).json({ error: "invalid_credentials" });
      }
      await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
      const s = req.session as any;
      s.isStaff = true;
      s.staffId = r.id;
      s.staffEmail = r.email;
      s.capGrade = r.caps.grade;
      s.capScan = r.caps.scan;
      s.capPrint = r.caps.print;
      s.capEditSets = r.caps.editSets;
      // Back-compat: the grade routes + delegation proxy read graderId/graderEmail
      // and gate on the 'grade' capability — alias them to the staff identity so
      // the grader machinery is reused unchanged.
      s.graderId = r.id;
      s.graderEmail = r.email;
      s.isGrader = r.caps.grade;
      // Clear every other login type (no privilege bleed).
      s.isAdmin = false;
      s.adminEmail = undefined;
      s.pendingAdmin = false;
      s.userId = undefined;
      s.userEmail = undefined;
      s.customerEmail = undefined;
      stampAuthSession(req, { userId: r.id, credentialVersion: r.credentialVersion, role: "staff" });
      await storage.writeAuditLog("staff_auth", r.id, "staff_login", r.email, { caps: r.caps });
      return res.json({ email: r.email, displayName: r.displayName, caps: r.caps });
    } catch (e: any) {
      console.error("[staff] login error:", e.message);
      return res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/staff/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      clearSessionCookie(res);
      res.json({ ok: true });
    });
  });

  app.get("/api/staff/session", async (req: Request, res: Response) => {
    const s = req.session as any;
    if (s && s.isStaff && s.staffId && !s.isAdmin) {
      if (isAbsoluteSessionExpired(req, STAFF_ABSOLUTE_SESSION_MS)) {
        return req.session.destroy(() => {
          clearSessionCookie(res);
          res.status(401).json({ authenticated: false, reason: "session_expired" });
        });
      }
      const live = await db.execute(
        sql`SELECT credential_version, deleted_at FROM users WHERE id = ${String(s.staffId)} LIMIT 1`
      );
      const row = live.rows[0] as any;
      if (!row || row.deleted_at || Number(s.credentialVersion ?? 1) !== credentialVersionOf(row)) {
        return req.session.destroy(() => {
          clearSessionCookie(res);
          res.status(401).json({ authenticated: false, reason: "session_expired" });
        });
      }
      return res.json({
        authenticated: true,
        email: s.staffEmail,
        caps: { grade: !!s.capGrade, scan: !!s.capScan, print: !!s.capPrint, editSets: !!s.capEditSets },
      });
    }
    return res.json({ authenticated: false });
  });

  // ── Grader analytics (can_grade) — PII-FREE dashboard for the GradeTab ──────
  app.get("/api/staff/analytics", requireCapability("grade"), async (req: Request, res: Response) => {
    try {
      return res.json(await getGraderAnalytics((req.session as any).staffId));
    } catch (e: any) {
      return sendServerError(res, e);
    }
  });

  // ── Set Library (can_edit_sets) — shared set review/edit surface, no grading data writes.
  app.get("/api/staff/sets", requireCapability("editSets"), async (req: Request, res: Response) => {
    try {
      return res.json(await listSetLibrary(req.query));
    } catch (err) {
      return sendSetLibraryError(res, err);
    }
  });

  app.patch(
    "/api/staff/sets/:source/:setId",
    staffSetLibraryMutationLimit,
    requireCapability("editSets"),
    async (req: Request, res: Response) => {
      try {
        const session = req.session as { staffEmail?: string; staffId?: string };
        const actor = { id: session.staffEmail || session.staffId || "staff", role: "staff" as const };
        return res.json(await updateSetLibraryRecord(req.params.source, req.params.setId, req.body || {}, actor));
      } catch (err) {
        return sendSetLibraryError(res, err);
      }
    }
  );

  app.post(
    "/api/staff/sets/:source/:setId/review",
    staffSetLibraryMutationLimit,
    requireCapability("editSets"),
    async (req: Request, res: Response) => {
      try {
        const session = req.session as { staffEmail?: string; staffId?: string };
        const actor = { id: session.staffEmail || session.staffId || "staff", role: "staff" as const };
        return res.json(
          await recordSetReviewDecision(
            req.params.source,
            req.params.setId,
            req.body?.suggestionKey,
            req.body?.decision,
            req.body?.reason,
            actor
          )
        );
      } catch (err) {
        return sendSetLibraryError(res, err);
      }
    }
  );

  // ── Scanner (can_scan) — PII-FREE, submission-grained ───────────────────────
  app.get("/api/staff/scan/queue", requireCapability("scan"), async (req: Request, res: Response) => {
    try {
      return res.json({ items: await getScanQueue((req.session as any).staffId) });
    } catch (e: any) {
      return sendServerError(res, e);
    }
  });

  app.post(
    "/api/staff/scan/certificates/:id/upload",
    requireCapability("scan"),
    scanUpload.fields([
      { name: "front", maxCount: 1 },
      { name: "back", maxCount: 1 },
    ]),
    async (req: Request, res: Response) => {
      try {
        const certId = parseInt(String(req.params.id), 10);
        const staffId = (req.session as any).staffId as string;
        const staffEmail = (req.session as any).staffEmail as string;
        const sid = await authorizeScanCert(staffId, certId);
        if (!sid) return res.status(403).json({ error: "This card is not in your scan queue" });
        const cr = await db.execute(sql`SELECT cert_id FROM certificates WHERE id = ${certId} LIMIT 1`);
        const certIdStr = (cr.rows[0] as any)?.cert_id;
        if (!certIdStr) return res.status(404).json({ error: "Not found" });
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        if (!files?.front?.[0] && !files?.back?.[0]) return res.status(400).json({ error: "No front/back image" });
        let scanned = false;
        if (files?.front?.[0]) {
          ({ submissionScanned: scanned } = await recordScanUpload(
            certId,
            certIdStr,
            "front",
            files.front[0].buffer,
            sid,
            staffEmail
          ));
        }
        if (files?.back?.[0]) {
          ({ submissionScanned: scanned } = await recordScanUpload(
            certId,
            certIdStr,
            "back",
            files.back[0].buffer,
            sid,
            staffEmail
          ));
        }
        return res.json({ ok: true, submissionScanned: scanned });
      } catch (e: any) {
        console.error("[staff] scan upload error:", e.message);
        return sendServerError(res, e);
      }
    }
  );

  // ── Printer (can_print) — re-dispatch proxy to admin SLAB paths ONLY ────────
  // Sets __graderProxy (the same authorized-staff flag requireAdmin honours),
  // sanitises JSON responses, and rewrites ONLY to admin slab/print/browser
  // paths — never /api/submissions, so a customer ADDRESS is never reachable.
  function printProxy(adminPath: (req: Request) => string) {
    return (req: Request, res: Response) => {
      (req as any).__graderProxy = true;
      const origJson = res.json.bind(res);
      (res as any).json = (body: any) => origJson(stripGraderPii(body));
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      req.url = adminPath(req) + qs;
      return (req.app as any).handle(req, res);
    };
  }
  // ── Print console — staff-authed proxies for the FULL admin Label Sheet
  // Printing dashboard. The client mounts <PrintingConsole apiBase="/api/staff/print">
  // (the SAME admin component), so a print-capable staff user gets full parity.
  // Each route below is EXPLICITLY whitelisted and maps 1:1 to its admin
  // counterpart by swapping the `/api/staff/print` prefix → `/api/admin` — there is
  // NO wildcard, so no other admin endpoint is reachable (no privilege escalation).
  // requireAdmin on the target passes only via the internal __graderProxy flag that
  // printProxy sets AFTER the capability check. Printing is a fulfilment step over
  // ALL printable certs (parity with admin) — it is NOT scoped per-grader, matching
  // the previous /api/staff/print/browser behaviour.
  const swapToAdmin = (req: Request) => req.path.replace(/^\/api\/staff\/print/, "/api/admin");
  const printConsole = (sub: string) => `/api/staff/print${sub}`;
  // GET routes
  for (const sub of [
    "/printing/queue",
    "/printing/sheets",
    "/printing/sheets/:sheetRef",
    "/printing/override/:certId",
    "/print-batch/:batchId/:filename",
    "/certificates/label/:certId/:filename",
    "/certificates/:certId/certificate-document",
    "/certificates/:certId/claim-insert",
    // Print-workflow lifecycle reads (Approval → Printing → Printed).
    "/printing/workflow/queue",
    "/printing/workflow/batches",
    "/printing/workflow/batches/:batchId",
    "/printing/workflow/events",
  ]) {
    app.get(printConsole(sub), requireCapability("print"), printProxy(swapToAdmin));
  }
  // POST routes. NOTE: /printing/workflow/complete is intentionally NOT here —
  // marking a cert Completed is a terminal, admin-only action.
  for (const sub of [
    "/printing/override/:certId",
    "/printing/mark-printed",
    "/print-batch",
    "/print-batch/reprint",
    "/claim-insert-sheet",
    // Print-workflow lifecycle writes permitted for can_print staff.
    "/printing/workflow/batch",
    "/printing/workflow/mark-printed",
    "/printing/workflow/reprint",
  ]) {
    app.post(printConsole(sub), requireCapability("print"), printProxy(swapToAdmin));
  }

  // ── Admin: staff accounts + capability toggles + scan assignment ────────────
  app.get("/api/admin/staff", requireAdmin, async (_req: Request, res: Response) => {
    return res.json({ staff: await listStaffWithCounts() });
  });

  app.post("/api/admin/staff", requireAdmin, async (req: Request, res: Response) => {
    const { email, password, display_name, can_grade, can_scan, can_print, can_edit_sets } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const result = await createStaffAccount(
      email,
      password,
      display_name ?? null,
      { grade: !!can_grade, scan: !!can_scan, print: !!can_print, editSets: !!can_edit_sets },
      adminUser
    );
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res
      .status(result.promoted ? 200 : 201)
      .json({ id: result.id, email: result.email, promoted: result.promoted, reactivated: result.reactivated });
  });

  app.post("/api/admin/staff/:id/capabilities", requireAdmin, async (req: Request, res: Response) => {
    const adminUser = (req.session as any).adminEmail || "admin";
    const { can_grade, can_scan, can_print, can_edit_sets } = req.body || {};
    const caps: { grade?: boolean; scan?: boolean; print?: boolean; editSets?: boolean } = {};
    if (typeof can_grade === "boolean") caps.grade = can_grade;
    if (typeof can_scan === "boolean") caps.scan = can_scan;
    if (typeof can_print === "boolean") caps.print = can_print;
    if (typeof can_edit_sets === "boolean") caps.editSets = can_edit_sets;
    const r = await setStaffCapabilities(String(req.params.id), caps, adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true });
  });

  // PHASE 4 — set a grader's per-operator review_rate (0..100). 100 = everything
  // manually reviewed (default for new operators); lower dials in sampling.
  app.post("/api/admin/staff/:id/review-rate", requireAdmin, async (req: Request, res: Response) => {
    const adminUser = (req.session as any).adminEmail || "admin";
    const raw = (req.body || {}).review_rate;
    const rate = Number(raw);
    if (raw === undefined || raw === null || raw === "" || !Number.isFinite(rate)) {
      return res.status(400).json({ error: "review_rate is required (0–100)" });
    }
    const r = await setStaffReviewRate(String(req.params.id), rate, adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, reviewRate: r.reviewRate });
  });

  // Change a staffer's login email. Staff-only (never admin/customer); enforces
  // case-insensitive uniqueness (409); audits staff_email_changed {old,new}.
  app.patch("/api/admin/staff/:id/email", requireAdmin, async (req: Request, res: Response) => {
    const adminUser = (req.session as any).adminEmail || "admin";
    const { email } = req.body || {};
    const r = await updateStaffEmail(String(req.params.id), String(email ?? ""), adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, email: r.email });
  });

  // Reset a staffer's login password. Staff-only; same validate/hash path as
  // create; audits staff_password_reset with NO password in details.
  app.patch("/api/admin/staff/:id/password", requireAdmin, async (req: Request, res: Response) => {
    const adminUser = (req.session as any).adminEmail || "admin";
    const { password } = req.body || {};
    const r = await resetStaffPassword(String(req.params.id), String(password ?? ""), adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true });
  });

  app.post(
    "/api/admin/staff/:id/revoke-sessions",
    adminStaffSecurityLimit,
    requireAdmin,
    async (req: Request, res: Response) => {
      const adminUser = (req.session as any).adminEmail || "admin";
      const r = await revokeStaffSessions(String(req.params.id), adminUser);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.json({ ok: true });
    }
  );

  // Soft-delete a staff account (deleted_at). Blocks admins + staffers with open
  // grading work; audited. See deleteStaffAccount.
  app.delete("/api/admin/staff/:id", requireAdmin, async (req: Request, res: Response) => {
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await deleteStaffAccount(String(req.params.id), adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true });
  });

  app.post("/api/admin/staff/scan/assign", requireAdmin, async (req: Request, res: Response) => {
    const { staff_id, submission_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await assignScanSubmissions(
      String(staff_id),
      Array.isArray(submission_ids) ? submission_ids.map(Number) : [],
      adminUser
    );
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });

  app.post("/api/admin/staff/scan/unassign", requireAdmin, async (req: Request, res: Response) => {
    const { submission_ids } = req.body || {};
    const adminUser = (req.session as any).adminEmail || "admin";
    const r = await unassignScanSubmissions(Array.isArray(submission_ids) ? submission_ids.map(Number) : [], adminUser);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.json({ ok: true, count: r.count });
  });
}
