/**
 * server/grader.ts — restricted grader role + card-assignment system.
 *
 * Builds on the EXISTING auth model (users.role column, bcrypt password helpers,
 * mv.sid session, audit_log) — NOT a parallel auth system. A "grader" is just a
 * users row with role='grader'; admins create them, there is no self-signup.
 *
 * Assignment lives on the SUBMISSION (assigned_grader_id + grading_status), per
 * spec; the grade itself stays on the linked CERTIFICATE (cert.card_id →
 * cards.submission_id is the join back to the owning submission). A grader may
 * only read/grade certificates whose owning submission is assigned to them, and
 * never sees customer PII (PII lives only on submissions and is never returned
 * by any /api/grader/* endpoint).
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { getR2SignedUrl } from "./r2";
import { hashPassword, verifyPassword, validatePassword } from "./account-auth";

/**
 * AUTO-PUBLISH FLIP. When false (default) a grader's submit moves the card to
 * 'pending_review' for an admin to approve before it goes live. Flip to true to
 * let a grader's submit publish the grade directly (skip review). See
 * submitGraderGrade() — this is the single branch that changes the behaviour.
 */
export const GRADER_AUTO_PUBLISH = false;

export type GradingStatus = "unassigned" | "assigned" | "pending_review" | "approved";

// ── Boot migration (idempotent, additive) ─────────────────────────────────────

/**
 * Adds the assignment columns + indexes to submissions. Safe on every boot
 * (ADD COLUMN IF NOT EXISTS). Backfill rule (documented): a submission whose
 * linked certificate is already graded-live (grade_approved_at IS NOT NULL) is
 * marked 'approved'; everything else keeps the 'unassigned' default. Writes a
 * one-time audit_log row (entity_type='schema') the first time it runs.
 */
export async function migrateGraderSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE submissions
      ADD COLUMN IF NOT EXISTS assigned_grader_id VARCHAR,
      ADD COLUMN IF NOT EXISTS grading_status VARCHAR(20) NOT NULL DEFAULT 'unassigned',
      ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS graded_at TIMESTAMPTZ
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_submissions_assigned_grader ON submissions (assigned_grader_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_submissions_grading_status ON submissions (grading_status)`);

  // Backfill: mark already-graded-live submissions 'approved'. Only touches rows
  // still at the 'unassigned' default, so it's idempotent and never clobbers an
  // active assignment/review.
  await db.execute(sql`
    UPDATE submissions s SET grading_status = 'approved'
    WHERE s.grading_status = 'unassigned'
      AND EXISTS (
        SELECT 1 FROM cards c
        JOIN certificates cert ON cert.card_id = c.id
        WHERE c.submission_id = s.id AND cert.grade_approved_at IS NOT NULL
      )
  `);

  // One-time audit (no per-boot spam).
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    SELECT 'schema', 'submissions', 'grader_schema_migrate', NULL,
           ${{ columns: ["assigned_grader_id", "grading_status", "assigned_at", "graded_at"] }}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'grader_schema_migrate')
  `);

  console.log("[grader-migrate] submissions assignment columns + indexes ensured");
}

// ── Role middleware ───────────────────────────────────────────────────────────

/**
 * Gate a route to authenticated graders only. 401 otherwise. The `!isAdmin`
 * clause enforces mutual exclusivity at the enforcement point: a session can act
 * as a grader OR an admin, never both, regardless of any stale field — so this
 * is robust even if a login handler forgot to clear the other role's fields.
 */
export function requireGrader(req: Request, res: Response, next: NextFunction) {
  const s = req.session as any;
  if (s && s.isGrader && s.graderId && !s.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── cert ↔ submission resolution ──────────────────────────────────────────────

/** The submission that owns a certificate (via cert.card_id → cards.submission_id). */
export async function getSubmissionIdForCert(certId: number): Promise<number | null> {
  const r = await db.execute(sql`
    SELECT c.submission_id AS sid
    FROM certificates cert
    JOIN cards c ON cert.card_id = c.id
    WHERE cert.id = ${certId}
    LIMIT 1
  `);
  const row = r.rows[0] as { sid: number } | undefined;
  return row ? Number(row.sid) : null;
}

/**
 * True if a certificate's owning submission is assigned to a grader and still in
 * their workflow (assignedGraderId set && grading_status !== 'approved') — in
 * which case an ADMIN must not grade/publish it directly (use the approval flow).
 * An ORPHAN cert with no owning submission returns false: it cannot be assigned
 * to a grader (assignment lives on submissions), so there is nothing to lock and
 * normal admin grading proceeds. Used to gate every admin grade/approve handler.
 */
export async function isGraderLocked(certId: number): Promise<boolean> {
  const sid = await getSubmissionIdForCert(certId);
  if (!sid) return false;
  const a = await getSubmissionAssignment(sid);
  return !!(a && a.assignedGraderId && a.gradingStatus !== "approved");
}

export interface SubmissionAssignment {
  id: number;
  assignedGraderId: string | null;
  gradingStatus: GradingStatus;
}

export async function getSubmissionAssignment(submissionId: number): Promise<SubmissionAssignment | null> {
  const r = await db.execute(sql`
    SELECT id, assigned_grader_id, grading_status
    FROM submissions WHERE id = ${submissionId} AND deleted_at IS NULL LIMIT 1
  `);
  const row = r.rows[0] as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    assignedGraderId: row.assigned_grader_id ?? null,
    gradingStatus: (row.grading_status ?? "unassigned") as GradingStatus,
  };
}

/** The certificate(s) for a submission, with PII-FREE card metadata only. */
export async function getCertificatesForSubmission(
  submissionId: number
): Promise<
  Array<{
    certId: number;
    certIdStr: string;
    cardGame: string | null;
    setName: string | null;
    cardName: string | null;
    cardNumber: string | null;
    year: string | null;
    variant: string | null;
    grade: string | null;
    gradeApprovedAt: string | null;
  }>
> {
  const r = await db.execute(sql`
    SELECT cert.id AS cert_id, cert.cert_id AS cert_id_str, cert.card_game, cert.set_name,
           cert.card_name, cert.card_number, cert.year, cert.variant,
           cert.grade AS grade, cert.grade_approved_at AS grade_approved_at
    FROM certificates cert
    JOIN cards c ON cert.card_id = c.id
    WHERE c.submission_id = ${submissionId} AND cert.deleted_at IS NULL
    ORDER BY cert.id ASC
  `);
  return (r.rows as any[]).map((row) => ({
    certId: Number(row.cert_id),
    certIdStr: row.cert_id_str,
    cardGame: row.card_game ?? null,
    setName: row.set_name ?? null,
    cardName: row.card_name ?? null,
    cardNumber: row.card_number ?? null,
    year: row.year ?? null,
    variant: row.variant ?? null,
    grade: row.grade ?? null,
    gradeApprovedAt: row.grade_approved_at ?? null,
  }));
}

// ── Grader accounts (admin-managed; no self-signup) ───────────────────────────

export async function listGraders(): Promise<
  Array<{ id: string; email: string; displayName: string | null; createdAt: string }>
> {
  const r = await db.execute(sql`
    SELECT id, email, display_name, created_at FROM users
    WHERE role = 'grader' AND deleted_at IS NULL ORDER BY created_at DESC
  `);
  return (r.rows as any[]).map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name ?? null,
    createdAt: u.created_at,
  }));
}

/** Create a grader account (role='grader'). Rejects if the email already exists. */
export async function createGraderAccount(
  email: string,
  password: string,
  displayName: string | null,
  adminUser: string
): Promise<{ ok: true; id: string; email: string } | { ok: false; status: number; error: string }> {
  const cleanEmail = String(email || "")
    .toLowerCase()
    .trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return { ok: false, status: 400, error: "Invalid email address" };
  const pw = validatePassword(password || "");
  if (!pw.valid) return { ok: false, status: 400, error: pw.message || "Weak password" };

  const existing = await db.execute(sql`SELECT id, deleted_at FROM users WHERE LOWER(email) = ${cleanEmail} LIMIT 1`);
  if ((existing.rows[0] as any) && !(existing.rows[0] as any).deleted_at) {
    return { ok: false, status: 409, error: "An account with that email already exists" };
  }

  const hash = await hashPassword(password);
  const r = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, email_verified, created_at, updated_at)
    VALUES (${cleanEmail}, ${hash}, ${displayName?.trim() || null}, 'grader', true, NOW(), NOW())
    RETURNING id, email
  `);
  const row = r.rows[0] as any;
  await storage.writeAuditLog("user", row.id, "grader_create", adminUser, {
    email: cleanEmail,
    display_name: displayName ?? null,
  });
  return { ok: true, id: row.id, email: row.email };
}

/** Authenticate a grader by email+password. Generic failure (no enumeration). */
export async function authenticateGrader(
  email: string,
  password: string
): Promise<{ ok: true; id: string; email: string; displayName: string | null } | { ok: false }> {
  const cleanEmail = String(email || "")
    .toLowerCase()
    .trim();
  if (!cleanEmail || !password) return { ok: false };
  const r = await db.execute(sql`
    SELECT id, email, display_name, password_hash, role, deleted_at FROM users WHERE LOWER(email) = ${cleanEmail} LIMIT 1
  `);
  const u = r.rows[0] as any;
  if (!u || u.deleted_at || u.role !== "grader" || !u.password_hash) return { ok: false };
  const valid = await verifyPassword(password, u.password_hash);
  if (!valid) return { ok: false };
  await db.execute(sql`UPDATE users SET last_login_at = NOW() WHERE id = ${u.id}`);
  return { ok: true, id: u.id, email: u.email, displayName: u.display_name ?? null };
}

// ── Assignment (admin) ────────────────────────────────────────────────────────

async function isGrader(graderId: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT 1 FROM users WHERE id = ${graderId} AND role = 'grader' AND deleted_at IS NULL LIMIT 1`
  );
  return r.rows.length > 0;
}

/** Assign a batch of submissions to a grader. Sets assigned + assigned_at. */
export async function assignSubmissions(graderId: string, ids: number[], adminUser: string) {
  if (!(await isGrader(graderId))) return { ok: false as const, status: 400, error: "Not a valid grader" };
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No submission ids" };
  const r = await db.execute(sql`
    UPDATE submissions
    SET assigned_grader_id = ${graderId}, grading_status = 'assigned', assigned_at = NOW(), updated_at = NOW()
    WHERE id = ANY(${clean}::int[]) AND deleted_at IS NULL AND grading_status <> 'approved'
    RETURNING id
  `);
  const count = r.rows.length;
  await storage.writeAuditLog("submission", clean.join(","), "grader_assign", adminUser, {
    grader_id: graderId,
    ids: clean,
    count,
  });
  return { ok: true as const, count };
}

/** Reassign a batch to a different grader; audits from/to per submission. */
export async function reassignSubmissions(graderId: string, ids: number[], adminUser: string) {
  if (!(await isGrader(graderId))) return { ok: false as const, status: 400, error: "Not a valid grader" };
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No submission ids" };
  const before = await db.execute(sql`SELECT id, assigned_grader_id FROM submissions WHERE id = ANY(${clean}::int[])`);
  const fromMap = Object.fromEntries((before.rows as any[]).map((x) => [String(x.id), x.assigned_grader_id ?? null]));
  const r = await db.execute(sql`
    UPDATE submissions
    SET assigned_grader_id = ${graderId}, grading_status = 'assigned', assigned_at = NOW(), updated_at = NOW()
    WHERE id = ANY(${clean}::int[]) AND deleted_at IS NULL AND grading_status <> 'approved'
    RETURNING id
  `);
  await storage.writeAuditLog("submission", clean.join(","), "grader_reassign", adminUser, {
    to: graderId,
    from: fromMap,
    ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

/** Unassign a batch (back to 'unassigned', clears grader + assigned_at). */
export async function unassignSubmissions(ids: number[], adminUser: string) {
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No submission ids" };
  const before = await db.execute(sql`SELECT id, assigned_grader_id FROM submissions WHERE id = ANY(${clean}::int[])`);
  const fromMap = Object.fromEntries((before.rows as any[]).map((x) => [String(x.id), x.assigned_grader_id ?? null]));
  const r = await db.execute(sql`
    UPDATE submissions
    SET assigned_grader_id = NULL, grading_status = 'unassigned', assigned_at = NULL, updated_at = NOW()
    WHERE id = ANY(${clean}::int[]) AND deleted_at IS NULL AND grading_status <> 'approved'
    RETURNING id
  `);
  await storage.writeAuditLog("submission", clean.join(","), "grader_unassign", adminUser, {
    from: fromMap,
    ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

/** Assignment map for a set of submission ids (admin UI: show assignee per card). */
export async function getAssignmentsForSubmissions(ids: number[]) {
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return {};
  const r = await db.execute(sql`
    SELECT s.id, s.assigned_grader_id, s.grading_status, u.email AS grader_email, u.display_name AS grader_name
    FROM submissions s LEFT JOIN users u ON u.id = s.assigned_grader_id
    WHERE s.id = ANY(${clean}::int[])
  `);
  const out: Record<
    string,
    { assignedGraderId: string | null; graderEmail: string | null; graderName: string | null; gradingStatus: string }
  > = {};
  for (const row of r.rows as any[]) {
    out[String(row.id)] = {
      assignedGraderId: row.assigned_grader_id ?? null,
      graderEmail: row.grader_email ?? null,
      graderName: row.grader_name ?? null,
      gradingStatus: row.grading_status ?? "unassigned",
    };
  }
  return out;
}

// ── PII-free certificate read payloads (reused shape from the admin handlers) ──

const IMAGE_KEY_MAP: Array<[string, (c: any) => string | null]> = [
  ["front_original", (c) => c.gradingFrontOriginal || c.frontImagePath || null],
  ["front_cropped", (c) => c.gradingFrontCropped || null],
  ["front_greyscale", (c) => c.gradingFrontGreyscale || null],
  ["front_highcontrast", (c) => c.gradingFrontHighcontrast || null],
  ["front_edgeenhanced", (c) => c.gradingFrontEdgeenhanced || null],
  ["front_inverted", (c) => c.gradingFrontInverted || null],
  ["back_original", (c) => c.gradingBackOriginal || c.backImagePath || null],
  ["back_cropped", (c) => c.gradingBackCropped || null],
  ["back_greyscale", (c) => c.gradingBackGreyscale || null],
  ["back_highcontrast", (c) => c.gradingBackHighcontrast || null],
  ["back_edgeenhanced", (c) => c.gradingBackEdgeenhanced || null],
  ["back_inverted", (c) => c.gradingBackInverted || null],
  ["front_display", (c) => c.gradingFrontDisplay || c.gradingFrontCropped || c.frontImagePath || null],
  ["back_display", (c) => c.gradingBackDisplay || c.gradingBackCropped || c.backImagePath || null],
];

/** Signed image URLs for a certificate. NO customer PII — card images only. */
export async function buildCertImagesPayload(
  certId: number
): Promise<{ urls: Record<string, string | null>; quality: any } | null> {
  const cert = await storage.getCertificate(certId);
  if (!cert) return null;
  const c = cert as any;
  const urls: Record<string, string | null> = {};
  await Promise.all(
    IMAGE_KEY_MAP.map(async ([k, pick]) => {
      const key = pick(c);
      if (!key) {
        urls[k] = null;
        return;
      }
      try {
        urls[k] = await getR2SignedUrl(key, 3600);
      } catch {
        urls[k] = null;
      }
    })
  );
  return { urls, quality: c.imageQualityChecks || {} };
}

/** The grading state for a certificate. NO customer PII — grade/measurement data only. */
export async function buildCertGradingPayload(certId: number): Promise<any | null> {
  const cert = await storage.getCertificate(certId);
  if (!cert) return null;
  const c = cert as any;
  return {
    centeringFrontLr: c.centeringFrontLr || null,
    centeringFrontTb: c.centeringFrontTb || null,
    centeringBackLr: c.centeringBackLr || null,
    centeringBackTb: c.centeringBackTb || null,
    centeringOuterFront: c.centeringOuterFront || null,
    centeringInnerFront: c.centeringInnerFront || null,
    centeringOuterBack: c.centeringOuterBack || null,
    centeringInnerBack: c.centeringInnerBack || null,
    centeringMethod: c.centeringMethod || null,
    corners: c.cornerValues || null,
    edges: c.edgeValues || null,
    surface: c.surfaceValues || null,
    defects: c.defects || [],
    authStatus: c.authStatus || "genuine",
    authNotes: c.authNotes || "",
    gradeExplanation: c.gradeExplanation || "",
    // private_notes are admin-internal and may reference the customer — NEVER
    // surface them to a grader. Returned empty; the grader never reads or
    // overwrites the admin's private notes (the grader form omits this field, so
    // applyCertGradeDraft's pick() preserves the existing value on submit).
    privateNotes: "",
    gradeApprovedBy: c.gradeApprovedBy || null,
    gradeApprovedAt: c.gradeApprovedAt || null,
    gradeStrengthScore: c.gradeStrengthScore ?? null,
    darkBorder: !!c.darkBorder,
    darkBorderFront: c.darkBorderFront ?? !!c.darkBorder,
    darkBorderBack: c.darkBorderBack ?? !!c.darkBorder,
    eyeAppealModifier: Number(c.eyeAppealModifier ?? 0) || 0,
    whiteningLines: Array.isArray(c.whiteningLines) ? c.whiteningLines : [],
    creaseLines: Array.isArray(c.creaseLines) ? c.creaseLines : [],
    creaseSpanPct: c.creaseSpanPct != null ? Number(c.creaseSpanPct) : null,
    wrinkleSeverity: c.wrinkleSeverity ?? null,
    tearSeverity: c.tearSeverity ?? null,
    centeringScore: c.gradeCentering ?? null,
    cornersScore: c.gradeCorners ?? null,
    edgesScore: c.gradeEdges ?? null,
    surfaceScore: c.gradeSurface ?? null,
    grade: c.gradeOverall ?? null,
    aiDraftGrade: c.aiDraftGrade ?? null,
    aiAnalysis: c.aiAnalysis ?? null,
    aiDefectCandidates: c.aiDefectCandidates ?? [],
  };
}

// ── Grade write (draft) — focused, faithful core-column update ────────────────

const pick = (a: any, b: any) => (a === undefined ? (b ?? null) : a);

/**
 * Persist a grader's grade as a DRAFT on the certificate (grade_approved_at
 * stays NULL — only the admin approval publishes). Mirrors the column set the
 * admin draft-save writes for the fields the grading panel round-trips, merging
 * the incoming payload over the cert's current values so an omitted field is
 * never wiped.
 */
export async function applyCertGradeDraft(certId: number, body: any): Promise<void> {
  const cert = (await storage.getCertificate(certId)) as any;
  if (!cert) throw new Error("Certificate not found");

  const overall = body.overall_grade;
  const gradeType = pick(body.grade_type, cert.gradeType) || "numeric";
  const isNonNum =
    overall === "AA" || overall === "NO" || gradeType === "authentic_altered" || gradeType === "not_original";
  const parsed = parseFloat(overall);
  const gradeNum = isNonNum ? null : Number.isNaN(parsed) ? pick(undefined, cert.gradeOverall) : parsed;

  const num = (v: any, cur: any) => (v === undefined || v === null || v === "" ? (cur ?? null) : v);
  const jb = (v: any, cur: any) => JSON.stringify(v === undefined ? (cur ?? null) : v);

  await db.execute(sql`
    UPDATE certificates SET
      grade = ${gradeNum},
      grade_type = ${gradeType},
      centering_score = ${num(body.grade_centering, cert.gradeCentering)},
      corners_score   = ${num(body.grade_corners, cert.gradeCorners)},
      edges_score     = ${num(body.grade_edges, cert.gradeEdges)},
      surface_score   = ${num(body.grade_surface, cert.gradeSurface)},
      centering_front_lr = ${pick(body.centering_front_lr, cert.centeringFrontLr)},
      centering_front_tb = ${pick(body.centering_front_tb, cert.centeringFrontTb)},
      centering_back_lr  = ${pick(body.centering_back_lr, cert.centeringBackLr)},
      centering_back_tb  = ${pick(body.centering_back_tb, cert.centeringBackTb)},
      corner_values  = ${jb(body.corners, cert.cornerValues)}::jsonb,
      edge_values    = ${jb(body.edges, cert.edgeValues)}::jsonb,
      surface_values = ${jb(body.surface, cert.surfaceValues)}::jsonb,
      defects        = ${jb(body.defects, cert.defects)}::jsonb,
      whitening_lines = ${jb(body.whitening_lines, cert.whiteningLines)}::jsonb,
      crease_lines    = ${jb(body.crease_lines, cert.creaseLines)}::jsonb,
      auth_status = ${pick(body.auth_status, cert.authStatus)},
      auth_notes  = ${pick(body.auth_notes, cert.authNotes)},
      grade_explanation = ${pick(body.grade_explanation, cert.gradeExplanation)},
      private_notes     = ${pick(body.private_notes, cert.privateNotes)},
      dark_border_front = ${pick(body.dark_border_front, cert.darkBorderFront)},
      dark_border_back  = ${pick(body.dark_border_back, cert.darkBorderBack)},
      eye_appeal_modifier = ${num(body.eye_appeal_modifier, cert.eyeAppealModifier)},
      wrinkle_severity = ${pick(body.wrinkle_severity, cert.wrinkleSeverity)},
      tear_severity    = ${pick(body.tear_severity, cert.tearSeverity)},
      updated_at = NOW()
    WHERE id = ${certId}
  `);
}

/** Publish a certificate's grade (admin approval): set approved_at + live status. */
export async function approveCertGrade(certId: number, adminUser: string): Promise<void> {
  await db.execute(sql`
    UPDATE certificates
    SET grade_approved_at = NOW(), grade_approved_by = ${adminUser}, status = 'active', updated_at = NOW()
    WHERE id = ${certId}
  `);
}
