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
import {
  normaliseGradeType,
  kindOfGradeType,
  kindOfOverallGrade,
  rejectKindChange,
  gradeTypeToPersist,
} from "./lib/grade-kind";
import { checkPrintableGrade } from "@shared/printable-grade";
import { db } from "./db";
import { sql, type SQL } from "drizzle-orm";
import { storage } from "./storage";
import { getR2SignedUrl } from "./r2";
import { hashPassword, verifyPassword, validatePassword } from "./account-auth";
import { CORRECTION_DISPLAY_EXCLUDED_FIELDS } from "./lib/correction-fields";
import { GradeDraftValidationError, validateGradeDraftIdentityAndVariant } from "@shared/grading-draft-validation";

/**
 * AUTO-PUBLISH FLIP. When false (default) a grader's submit moves the card to
 * 'pending_review' for an admin to approve before it goes live. Flip to true to
 * let a grader's submit publish the grade directly (skip review). See
 * submitGraderGrade() — this is the single branch that changes the behaviour.
 */
export const GRADER_AUTO_PUBLISH = false;

export type GradingStatus = "unassigned" | "assigned" | "pending_review" | "approved";

/**
 * Keys that must NEVER reach a grader. The delegation proxy reuses unchanged
 * admin handlers, some of which return the full certificate (incl. owner/claim
 * fields) — so we recursively strip these from EVERY proxied response as
 * defence-in-depth, independent of any one handler's response shape. Covers
 * camelCase + snake_case owner/claim/customer/return fields and private_notes.
 */
const GRADER_PII_KEYS = new Set<string>([
  // Print-workflow queue exposes a computed full customer name; strip it for
  // proxied staff exactly like the other customer-identity fields below.
  "customerName",
  "ownerName",
  "ownerEmail",
  "ownershipStatus",
  "ownershipToken",
  "currentOwnerUserId",
  "claimCodeHash",
  "claimCodeUsedAt",
  "privateNotes",
  "customerEmail",
  "customerFirstName",
  "customerLastName",
  "phone",
  "returnAddressLine1",
  "returnAddressLine2",
  "returnCity",
  "returnCounty",
  "returnPostcode",
  "owner_name",
  "owner_email",
  "ownership_status",
  "ownership_token",
  "current_owner_user_id",
  "claim_code_hash",
  "claim_code_used_at",
  "private_notes",
  "customer_email",
  "customer_first_name",
  "customer_last_name",
  "return_address_line1",
  "return_address_line2",
  "return_city",
  "return_county",
  "return_postcode",
]);

/** Recursively remove any GRADER_PII_KEYS from a response value (object/array). */
export function stripGraderPii(value: any): any {
  if (Array.isArray(value)) return value.map(stripGraderPii);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (GRADER_PII_KEYS.has(k)) continue;
      out[k] = stripGraderPii(v);
    }
    return out;
  }
  return value;
}

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
// Phase 2 — re-validate the grader account is still live + still can_grade per
// request, cached 60s (same stale-session defense as staff.ts requireStaff;
// separate cache here to avoid a staff↔grader import cycle).
const graderSessionCache = new Map<string, { ok: boolean; expiry: number }>();
export function invalidateGraderSessionCache(graderId: string): void {
  graderSessionCache.delete(String(graderId));
}
async function validateGraderSession(graderId: string): Promise<boolean> {
  const c = graderSessionCache.get(graderId);
  if (c && Date.now() < c.expiry) return c.ok;
  const r = await db.execute(sql`SELECT deleted_at, can_grade FROM users WHERE id = ${graderId} LIMIT 1`);
  const row = r.rows[0] as any;
  const ok = !!row && !row.deleted_at && !!row.can_grade;
  graderSessionCache.set(graderId, { ok, expiry: Date.now() + 60_000 });
  return ok;
}

export async function requireGrader(req: Request, res: Response, next: NextFunction) {
  const s = req.session as any;
  if (!(s && s.isGrader && s.graderId && !s.isAdmin)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    if (!(await validateGraderSession(String(s.graderId)))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  } catch {
    return res.status(500).json({ error: "Internal server error" }); // fail-closed
  }
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

export interface CertAssignment {
  certId: number;
  assignedGraderId: string | null;
  gradedBy: string | null;
  gradingStatus: GradingStatus;
  redoCount: number;
  rejectionReason: string | null;
}

/** Cert-level assignment/workflow read (grader v2 — no submission join). */
export async function getCertAssignment(certId: number): Promise<CertAssignment | null> {
  const r = await db.execute(sql`
    SELECT id, assigned_grader_id, graded_by, grader_status, redo_count, rejection_reason
    FROM certificates WHERE id = ${certId} AND deleted_at IS NULL LIMIT 1
  `);
  const row = r.rows[0] as any;
  if (!row) return null;
  return {
    certId: Number(row.id),
    assignedGraderId: row.assigned_grader_id ?? null,
    gradedBy: row.graded_by ?? null,
    gradingStatus: (row.grader_status ?? "unassigned") as GradingStatus,
    redoCount: Number(row.redo_count ?? 0),
    rejectionReason: row.rejection_reason ?? null,
  };
}

/**
 * True if a CERTIFICATE is assigned to a grader and still in their workflow
 * (assigned_grader_id set && grading_status !== 'approved') — in which case an
 * ADMIN must not grade/publish it directly (use the grader approve/reject flow).
 * Cert-level (grader v2): reads certificates directly, no submission resolution.
 * Gates every admin GRADE-WRITE handler; admin approve/reject use their own
 * pending_review gate and are exempt from this lock.
 */
export async function isGraderLocked(certId: number): Promise<boolean> {
  const a = await getCertAssignment(certId);
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
export async function getCertificatesForSubmission(submissionId: number): Promise<
  Array<{
    certId: number;
    certIdStr: string;
    cardGame: string | null;
    setName: string | null;
    cardName: string | null;
    cardNumber: string | null;
    year: string | null;
    language: string | null;
    variant: string | null;
    grade: string | null;
    gradeApprovedAt: string | null;
    assignedGraderId: string | null;
    gradingStatus: string;
    redoCount: number;
  }>
> {
  const r = await db.execute(sql`
    SELECT cert.id AS cert_id, cert.cert_id AS cert_id_str, cert.card_game, cert.set_name,
           cert.card_name, cert.card_number_display AS card_number, cert.year_text AS year, cert.language, cert.variant,
           cert.grade AS grade, cert.grade_approved_at AS grade_approved_at,
           cert.assigned_grader_id, cert.grader_status, cert.redo_count
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
    language: row.language ?? null,
    variant: row.variant ?? null,
    grade: row.grade ?? null,
    gradeApprovedAt: row.grade_approved_at ?? null,
    assignedGraderId: row.assigned_grader_id ?? null,
    gradingStatus: row.grader_status ?? "unassigned",
    redoCount: Number(row.redo_count ?? 0),
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

/**
 * A user is assignable for grading iff they hold the grade capability — NOT iff
 * role='grader'. The unified-staff model (e670cea) grants grading via the
 * can_grade flag on role='staff'/'grader'/'senior_grader' accounts, so gating on
 * role alone silently rejected valid staff graders: assign/reassign returned 400
 * "Not a valid grader" and the card never moved. This mirrors the admin picker,
 * which lists can_grade users. Admins/customers have can_grade=false, so they are
 * correctly excluded.
 */
async function isGrader(graderId: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT 1 FROM users WHERE id = ${graderId} AND can_grade = true AND deleted_at IS NULL LIMIT 1`
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

  // Phase 58A: the immutable-evidence ledger owns native-geometry browser
  // working assets. Keep this additive and fail closed to the established
  // legacy URL map while a rolling deployment is creating the new table.
  // A TIFF master is deliberately never handed to the browser workstation.
  try {
    const rows = (
      await db.execute(sql`
        SELECT side, working_object_key
        FROM certificate_image_evidence
        WHERE certificate_id = ${certId}
          AND evidence_class = 'NEW_IMMUTABLE_MASTER'
          AND is_current = true
      `)
    ).rows as Array<{ side: string; working_object_key: string | null }>;
    await Promise.all(
      rows.map(async (row) => {
        if ((row.side !== "front" && row.side !== "back") || !row.working_object_key) return;
        try {
          urls[`${row.side}_working`] = await getR2SignedUrl(row.working_object_key, 3600);
        } catch {
          urls[`${row.side}_working`] = null;
        }
      })
    );
  } catch {
    // The evidence table is additive and may not exist during a rolling
    // deployment. Legacy image URLs remain available; new evidence does not
    // silently fall back until its working derivative has been recorded.
  }
  return { urls, quality: c.imageQualityChecks || {} };
}

/** The grading state for a certificate. NO customer PII — grade/measurement data only. */
export async function buildCertGradingPayload(certId: number): Promise<any | null> {
  const cert = await storage.getCertificate(certId);
  if (!cert) return null;
  const c = cert as any;
  return {
    // Resolved card identity — the grader panel re-syncs its editable idName/idSet
    // fields from these once the on-open identify has run (the panel mounts before
    // identify completes, so its props are stale). Without this the grader's
    // empty-seeded fields would persist "" over the freshly-resolved name.
    cardName: c.cardName ?? null,
    setName: c.setName ?? null,
    cardNumber: c.cardNumber ?? null,
    year: c.year ?? null,
    variant: c.variant ?? null,
    // Structured rarity/finish/promo — the SAME canonical fields the /admin
    // CertificateForm rarity picker uses. Exposed additively so the shared
    // four-stage workstation's Rarity stage works on the role routes too.
    rarityCode: c.rarityCode ?? null,
    finishVariant: c.finishVariant ?? null,
    promoType: c.promoType ?? null,
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
    // Cert-level workflow state — drives the grader panel's "rejected, redo"
    // banner and the queue chips.
    gradingStatus: (c as any).graderStatus || "unassigned",
    rejectionReason: (c as any).rejectionReason || null,
    redoCount: (c as any).redoCount ?? 0,
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

// Identity strings (card_name / set_name / number / year): an omitted OR blank
// payload value must NEVER overwrite a resolved value. The grader panel always
// sends these trimmed in graderMode, so a card whose name was resolved by the
// on-open identify AFTER the panel mounted (its idName seeded empty) would
// otherwise have its real name clobbered to "" on the next auto-save. A grader
// who genuinely wants to blank a name uses the admin Manual Override instead.
const keepStr = (a: any, b: any) =>
  a === undefined || a === null || (typeof a === "string" && a.trim() === "") ? (b ?? null) : a;

/**
 * Persist a grader's grade as a DRAFT on the certificate (grade_approved_at
 * stays NULL — only the admin approval publishes). Mirrors the column set the
 * admin draft-save writes for the fields the grading panel round-trips, merging
 * the incoming payload over the cert's current values so an omitted field is
 * never wiped.
 */
/** Thrown when a draft save is refused for a business-rule reason (not a race). Carries an
 *  HTTP status so routes can surface the operator message instead of a generic 500. */
export class GradeDraftRejected extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GradeDraftRejected";
    this.status = status;
  }
}

export async function applyCertGradeDraft(certId: number, body: any, extraWhere: SQL = sql``): Promise<boolean> {
  const cert = (await storage.getCertificate(certId)) as any;
  if (!cert) throw new Error("Certificate not found");
  const { nextLanguage, nextRarityCode, nextFinishVariant, nextPromoType } = validateGradeDraftIdentityAndVariant(
    cert,
    body
  );

  const overall = body.overall_grade;
  // grade_type used to be written VERBATIM from the request body, and the column is plain
  // `text` with no CHECK constraint — so an arbitrary value ("banana") could be persisted
  // and would then be treated as numeric everywhere while leaking into the public
  // population labels, which emit the raw column. Normalise, and derive the kind through
  // the SAME shared decision the approval routes use so the paths cannot diverge.
  const storedGradeType = normaliseGradeType(cert.gradeType);
  const requestedGradeTypeRaw = pick(body.grade_type, cert.gradeType) || "numeric";
  // Malformed grade_type is refused rather than silently coerced, so a typo can never
  // reclassify a certificate.
  if (
    body.grade_type != null &&
    String(body.grade_type).trim() !== "" &&
    normaliseGradeType(body.grade_type) !== String(body.grade_type).trim()
  ) {
    throw new GradeDraftRejected("Unrecognised grade type.");
  }
  // Kind follows either signal: an explicit NO/AA overall_grade, or a non-numeric
  // grade_type. (The previous condition omitted the SHORT NO/AA forms from the grade_type
  // side, so {"overall_grade":"NO"} nulled the grade while grade_type stayed 'numeric'.)
  const requestedKind =
    kindOfOverallGrade(overall) !== "numeric" ? kindOfOverallGrade(overall) : kindOfGradeType(requestedGradeTypeRaw);
  // A draft may set the kind on a never-approved certificate (ordinary grading work) but
  // may never convert a PUBLISHED one — that is Super Admin Correction Mode's job. This
  // helper's own UPDATE is scoped `grade_approved_at IS NULL`, so a published row cannot
  // be reached anyway; the check makes the intent explicit and fails closed if that
  // scoping is ever relaxed.
  const kindRejection = rejectKindChange({
    storedGradeType,
    requestedKind,
    isApproved: (cert as { gradeApprovedAt?: unknown }).gradeApprovedAt != null,
    allowChangeWhenUnapproved: true,
  });
  if (kindRejection) throw new GradeDraftRejected(kindRejection);
  const gradeType = gradeTypeToPersist(storedGradeType, requestedKind);
  const isNonNum = requestedKind !== "numeric";
  const parsed = parseFloat(overall);
  const gradeNum = isNonNum ? null : Number.isNaN(parsed) ? pick(undefined, cert.gradeOverall) : parsed;

  const num = (v: any, cur: any) => (v === undefined || v === null || v === "" ? (cur ?? null) : v);
  const jb = (v: any, cur: any) => JSON.stringify(v === undefined ? (cur ?? null) : v);

  const r = await db.execute(sql`
    UPDATE certificates SET
      grade = ${gradeNum},
      grade_type = ${gradeType},
      card_name           = ${keepStr(body.card_name, cert.cardName)},
      set_name            = ${keepStr(body.set_name, cert.setName)},
      card_number_display = ${keepStr(body.card_number_display, cert.cardNumber)},
      year_text           = ${keepStr(body.year_text, cert.year)},
      language            = ${keepStr(nextLanguage, cert.language)},
      variant             = ${pick(body.variant, cert.variant)},
      rarity_code         = ${nextRarityCode},
      finish_variant      = ${nextFinishVariant},
      promo_type          = ${nextPromoType},
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
    WHERE id = ${certId} AND grade_approved_at IS NULL ${extraWhere}
    RETURNING id
  `);
  return r.rows.length > 0;
}

/** Publish a certificate's grade (admin approval): set approved_at + live status. */
export async function approveCertGrade(certId: number, adminUser: string): Promise<boolean> {
  // Phase 2 — atomic CAS publish: only publishes while still pending_review (its
  // sole caller, approveGraderCert, requires that). 0 rows ⇒ state changed
  // concurrently (e.g. a racing reject) → caller returns 409 instead of double-publishing.
  const r = await db.execute(sql`
    UPDATE certificates
    SET grade_approved_at = NOW(), grade_approved_by = ${adminUser}, status = 'active',
        grader_status = 'approved', graded_at = NOW(), updated_at = NOW(),
        print_state = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END
    WHERE id = ${certId} AND grader_status = 'pending_review'
    RETURNING id
  `);
  return r.rows.length > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// GRADER V2 — cert-level migration, assignment, reject/approve, earnings
// ════════════════════════════════════════════════════════════════════════════

/**
 * Grader v2 boot migration: cert-level assignment + workflow columns. Idempotent
 * + additive (ADD COLUMN IF NOT EXISTS). Backfill: certs already graded-live
 * (grade_approved_at NOT NULL) → 'approved', only touching the 'unassigned'
 * default. One-time audit row. The v1 submission-level columns (migrateGraderSchema)
 * stay in place but are now DEAD.
 */
export async function migrateGraderCertSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE certificates
      ADD COLUMN IF NOT EXISTS assigned_grader_id VARCHAR,
      ADD COLUMN IF NOT EXISTS grader_status VARCHAR(20) NOT NULL DEFAULT 'unassigned',
      ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS graded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS redo_count INTEGER NOT NULL DEFAULT 0
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_certificates_assigned_grader ON certificates (assigned_grader_id)`
  );
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_certificates_grader_status ON certificates (grader_status)`);
  await db.execute(sql`
    UPDATE certificates SET grader_status = 'approved'
    WHERE grader_status = 'unassigned' AND grade_approved_at IS NOT NULL
  `);
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    SELECT 'schema', 'certificates', 'grader_cert_schema_migrate', NULL,
           ${{ columns: ["assigned_grader_id", "grader_status", "assigned_at", "graded_at", "rejection_reason", "redo_count"] }}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'grader_cert_schema_migrate')
  `);
  console.log("[grader-cert-migrate] certificates assignment columns + indexes ensured");
}

// ── Per-operator grading pipeline schema (Phase 0) ──────────────────────────
// Additive-only foundation for the per-operator pipeline. The certificates
// columns are all nullable and UN-backfillable — captured at scan/submit from
// Phase 1/3 onward; existing inventory stays NULL (forward-only). users.review_rate
// defaults 100 (every card manually reviewed) and is dialled down as an operator
// earns trust (Phase 4). NOTHING reads or writes these columns yet — Phase 0 is a
// pure migration. Idempotent (IF NOT EXISTS) + resume-safe; one-time audit row.
// assigned_grader_id is already indexed (migrateGraderCertSchema), so only the new
// attribution columns get indexes here (ahead of Phase 3/5 read-scaling).
export async function migratePerOperatorSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE certificates
      ADD COLUMN IF NOT EXISTS scanned_by VARCHAR,
      ADD COLUMN IF NOT EXISTS graded_by VARCHAR,
      ADD COLUMN IF NOT EXISTS operator_grade NUMERIC,
      ADD COLUMN IF NOT EXISTS operator_subgrades JSONB,
      ADD COLUMN IF NOT EXISTS review_required BOOLEAN
  `);
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS review_rate INTEGER NOT NULL DEFAULT 100
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_certificates_graded_by ON certificates (graded_by)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_certificates_scanned_by ON certificates (scanned_by)`);
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    SELECT 'schema', 'certificates', 'per_operator_schema_migrate', NULL,
           ${{
             certificates: ["scanned_by", "graded_by", "operator_grade", "operator_subgrades", "review_required"],
             users: ["review_rate"],
             indexes: ["idx_certificates_graded_by", "idx_certificates_scanned_by"],
             phase: 0,
           }}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'per_operator_schema_migrate')
  `);
  console.log("[per-operator-migrate] certificates operator columns + users.review_rate + indexes ensured");
}

/** Submission tracking_number for a cert (queue display context only — no PII). */
export async function getSubmissionRefForCert(certId: number): Promise<string | null> {
  const r = await db.execute(sql`
    SELECT s.tracking_number AS ref
    FROM certificates cert JOIN cards c ON cert.card_id = c.id JOIN submissions s ON s.id = c.submission_id
    WHERE cert.id = ${certId} LIMIT 1
  `);
  return (r.rows[0] as any)?.ref ?? null;
}

// ── Cert-level assignment (admin) ─────────────────────────────────────────────

/**
 * Bind an int[] as ARRAY[$1, $2, …]::int[]. Interpolating a JS array directly —
 * ANY(${ids}::int[]) — makes the Neon driver pass it as a single scalar param,
 * which Postgres rejects with "malformed array literal". Binding each id as its
 * own parameter sidesteps that. Callers guarantee a non-empty, int-filtered array.
 */
const intArray = (ids: number[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::int[]`;

/** Assign a batch of CERTIFICATES to a grader. Never touches 'approved' certs. */
export async function assignCerts(graderId: string, certIds: number[], adminUser: string) {
  if (!(await isGrader(graderId))) return { ok: false as const, status: 400, error: "Not a valid grader" };
  const clean = certIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No certificate ids" };
  const r = await db.execute(sql`
    UPDATE certificates
    SET assigned_grader_id = ${graderId}, grader_status = 'assigned', assigned_at = NOW(),
        rejection_reason = NULL, updated_at = NOW()
    WHERE id = ANY(${intArray(clean)}) AND deleted_at IS NULL AND grader_status <> 'approved'
    RETURNING id
  `);
  await storage.writeAuditLog("certificate", clean.join(","), "grader_assign", adminUser, {
    grader_id: graderId,
    cert_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

/** Reassign a batch of certs to a different grader; audits from→to. */
export async function reassignCerts(graderId: string, certIds: number[], adminUser: string) {
  if (!(await isGrader(graderId))) return { ok: false as const, status: 400, error: "Not a valid grader" };
  const clean = certIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No certificate ids" };
  const before = await db.execute(
    sql`SELECT id, assigned_grader_id FROM certificates WHERE id = ANY(${intArray(clean)})`
  );
  const fromMap = Object.fromEntries((before.rows as any[]).map((x) => [String(x.id), x.assigned_grader_id ?? null]));
  const r = await db.execute(sql`
    UPDATE certificates
    SET assigned_grader_id = ${graderId}, grader_status = 'assigned', assigned_at = NOW(),
        rejection_reason = NULL, updated_at = NOW()
    WHERE id = ANY(${intArray(clean)}) AND deleted_at IS NULL AND grader_status <> 'approved'
    RETURNING id
  `);
  await storage.writeAuditLog("certificate", clean.join(","), "grader_reassign", adminUser, {
    grader_id: graderId,
    from: fromMap,
    cert_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

/** Unassign a batch of certs (back to 'unassigned'). Never touches 'approved'. */
export async function unassignCerts(certIds: number[], adminUser: string) {
  const clean = certIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No certificate ids" };
  const before = await db.execute(
    sql`SELECT id, assigned_grader_id FROM certificates WHERE id = ANY(${intArray(clean)})`
  );
  const fromMap = Object.fromEntries((before.rows as any[]).map((x) => [String(x.id), x.assigned_grader_id ?? null]));
  const r = await db.execute(sql`
    UPDATE certificates
    SET assigned_grader_id = NULL, grader_status = 'unassigned', assigned_at = NULL, updated_at = NOW()
    WHERE id = ANY(${intArray(clean)}) AND deleted_at IS NULL AND grader_status <> 'approved'
    RETURNING id
  `);
  await storage.writeAuditLog("certificate", clean.join(","), "grader_unassign", adminUser, {
    from: fromMap,
    cert_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

/** A submission's certs + current assignee (admin picker, PII-FREE). */
export async function getCertsForSubmission(submissionId: number) {
  const r = await db.execute(sql`
    SELECT cert.id AS cert_id, cert.cert_id AS cert_id_str, cert.card_name, cert.set_name,
           cert.card_number_display AS card_number, cert.year_text AS year, cert.language, cert.variant,
           cert.assigned_grader_id, cert.grader_status, cert.redo_count, u.email AS grader_email
    FROM certificates cert JOIN cards c ON cert.card_id = c.id
    LEFT JOIN users u ON u.id = cert.assigned_grader_id
    WHERE c.submission_id = ${submissionId} AND cert.deleted_at IS NULL
    ORDER BY cert.id ASC
  `);
  return (r.rows as any[]).map((row) => ({
    certId: Number(row.cert_id),
    certIdStr: row.cert_id_str,
    cardName: row.card_name ?? null,
    setName: row.set_name ?? null,
    cardNumber: row.card_number ?? null,
    year: row.year ?? null,
    language: row.language ?? null,
    variant: row.variant ?? null,
    assignedGraderId: row.assigned_grader_id ?? null,
    graderEmail: row.grader_email ?? null,
    gradingStatus: row.grader_status ?? "unassigned",
    redoCount: Number(row.redo_count ?? 0),
  }));
}

// ── Reject / approve (admin sanctioned actions on a pending_review cert) ───────

/** Reject a grader-submitted cert: pending_review → assigned, store reason, +redo. */
export async function rejectCertGrade(certId: number, reason: string | null, adminUser: string) {
  const a = await getCertAssignment(certId);
  if (!a) return { ok: false as const, status: 404, error: "Certificate not found" };
  if (a.gradingStatus !== "pending_review") {
    return { ok: false as const, status: 409, error: `Card is '${a.gradingStatus}', not pending review` };
  }
  // Phase 2 — atomic CAS: only reject while still pending_review; 0 rows ⇒ a
  // concurrent transition won, return 409 instead of clobbering the new state.
  const r = await db.execute(sql`
    UPDATE certificates
    SET grader_status = 'assigned', rejection_reason = ${reason || null}, redo_count = redo_count + 1,
        graded_at = NULL, updated_at = NOW()
    WHERE id = ${certId} AND grader_status = 'pending_review'
    RETURNING id
  `);
  if (r.rows.length === 0) {
    return { ok: false as const, status: 409, error: "Card status changed; refresh and try again" };
  }
  await storage.writeAuditLog("certificate", String(certId), "grade_reject", adminUser, { reason: reason || null });
  return { ok: true as const };
}

/**
 * Approve a grader-submitted cert (EXEMPT from the grade-write lock; allowed
 * ONLY from 'pending_review'). Publishes ONLY this cert (grade_approved_at +
 * status='active') and marks it 'approved' + graded_at — never touches sibling
 * certs of the same submission.
 */
export async function approveGraderCert(certId: number, adminUser: string) {
  const a = await getCertAssignment(certId);
  if (!a) return { ok: false as const, status: 404, error: "Certificate not found" };
  if (a.gradingStatus !== "pending_review") {
    return { ok: false as const, status: 409, error: `Card is '${a.gradingStatus}', not pending review` };
  }
  // B3 completeness gate (owner-approved 2026-07-02): a numeric grade (grade
  // NOT NULL — non-numeric NO/AA certs store grade=NULL so they're exempt)
  // must never publish with any of the four sub-grades blank, because the
  // MVGS overall is computed from them. Pure pre-publish check — the atomic
  // CAS publish below and all scoring logic are untouched.
  const subgradeGate = await db.execute(sql`
    SELECT 1 FROM certificates
    WHERE id = ${certId} AND grade IS NOT NULL
      AND (centering_score IS NULL OR corners_score IS NULL
        OR edges_score IS NULL OR surface_score IS NULL)
  `);
  if (subgradeGate.rows.length > 0) {
    return {
      ok: false as const,
      status: 409,
      error:
        "Cannot publish a numeric grade without all four sub-grades (centering, corners, edges, surface). Re-run the MVGS workstation so the sub-grades populate, then approve.",
    };
  }
  // The gate above is scoped `grade IS NOT NULL`, so a NUMERIC row carrying NO grade at
  // all skipped it entirely and published live with a blank grade — gradeLabelFull
  // ('numeric', null) renders "". That is the MV205 defect class on this path. Validate
  // the stored grade against the SAME printability rule the renderer uses, so a
  // certificate can never be published in a state it could not legitimately print.
  // Runs BEFORE any approval write: no timestamps, no approver, no print_state change.
  const gradeRow = await db.execute(sql`
    SELECT grade_type, grade::text AS grade FROM certificates WHERE id = ${certId}
  `);
  const gr = gradeRow.rows[0] as { grade_type: string | null; grade: string | null } | undefined;
  const verdict = checkPrintableGrade({ gradeType: gr?.grade_type ?? null, gradeOverall: gr?.grade ?? null });
  if (!verdict.printable) {
    return {
      ok: false as const,
      status: 409,
      error:
        verdict.reason === "missing_numeric_grade"
          ? "Cannot publish a numeric certificate with no grade. Re-run the MVGS workstation so the grade and sub-grades populate, then approve."
          : (verdict.message ?? "This certificate's grade is not valid, so it cannot be published."),
    };
  }
  // Phase 2 — the publish is an atomic CAS (pending_review→active); if it matched
  // 0 rows the state changed under us (e.g. a racing reject), so bail with 409
  // rather than flip grader_status on an unpublished grade.
  // The publish + grader_status flip is ONE atomic CAS UPDATE inside approveCertGrade
  // now, so there's no window for a racing reject to negate it. 0 rows ⇒ 409.
  const published = await approveCertGrade(certId, adminUser);
  if (!published) {
    return { ok: false as const, status: 409, error: "Card status changed; refresh and try again" };
  }
  // Snapshot the published grade into the approval audit row.
  const c = (await storage.getCertificate(certId)) as any;
  await storage.writeAuditLog("certificate", String(certId), "grade_approve", adminUser, {
    via: "grader_review",
    overall: c?.gradeOverall ?? null,
    subgrades: {
      centering: c?.gradeCentering ?? null,
      corners: c?.gradeCorners ?? null,
      edges: c?.gradeEdges ?? null,
      surface: c?.gradeSurface ?? null,
    },
  });
  return { ok: true as const };
}

/** {overall, subgrades} snapshot of a cert's current grade — for the admin-edit audit. */
async function gradeSnapshot(certId: number) {
  const c = (await storage.getCertificate(certId)) as any;
  return {
    language: c?.language ?? null,
    rarityCode: c?.rarityCode ?? null,
    finishVariant: c?.finishVariant ?? null,
    promoType: c?.promoType ?? null,
    overall: c?.gradeOverall ?? null,
    subgrades: {
      centering: c?.gradeCentering ?? null,
      corners: c?.gradeCorners ?? null,
      edges: c?.gradeEdges ?? null,
      surface: c?.gradeSurface ?? null,
    },
  };
}

function sameGradeSnapshot(
  a: Awaited<ReturnType<typeof gradeSnapshot>>,
  b: Awaited<ReturnType<typeof gradeSnapshot>>
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Admin edits a pending_review cert's DRAFT grade during review (the grading
 * panel in adminReview mode auto-saves here). Deliberately NOT grader-locked —
 * reviewing a grader's submission is the whole point — but pending_review-gated
 * and NON-publishing (only Approve publishes). Reuses the grader's draft writer
 * applyCertGradeDraft. Audits admin_grade_edit {before, after}.
 */
export async function adminReviewSaveDraft(certId: number, body: any, adminUser: string) {
  const a = await getCertAssignment(certId);
  if (!a) return { ok: false as const, status: 404, error: "Certificate not found" };
  if (a.gradingStatus !== "pending_review")
    return { ok: false as const, status: 409, error: `Card is '${a.gradingStatus}', not pending review` };
  const before = await gradeSnapshot(certId);
  let saved: boolean;
  try {
    saved = await applyCertGradeDraft(certId, body);
  } catch (e) {
    if (e instanceof GradeDraftValidationError) {
      return { ok: false as const, status: e.status, error: e.message };
    }
    throw e;
  }
  if (!saved) {
    return { ok: false as const, status: 409, error: "Card status changed; refresh and try again" };
  }
  const after = await gradeSnapshot(certId);
  if (!sameGradeSnapshot(before, after)) {
    await storage.writeAuditLog("certificate", String(certId), "admin_grade_edit", adminUser, { before, after });
  }
  return { ok: true as const };
}

// ── Earnings (display-only; NO deduction logic) ───────────────────────────────

/** Per-card grader rate from pipeline_settings (raw SQL; null/0 when unset). */
export async function getGraderRate(): Promise<number> {
  const r = await db.execute(sql`SELECT value FROM pipeline_settings WHERE key = 'grader_card_rate' LIMIT 1`);
  const v = (r.rows[0] as any)?.value;
  if (v == null) return 0;
  const n = typeof v === "number" ? v : typeof v === "object" && v.rate != null ? Number(v.rate) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Admin sets the per-card rate (audited). */
export async function setGraderRate(rate: number, adminUser: string): Promise<void> {
  const clean = Number.isFinite(rate) && rate >= 0 ? rate : 0;
  await db.execute(sql`
    INSERT INTO pipeline_settings (key, value, updated_by, updated_at)
    VALUES ('grader_card_rate', ${JSON.stringify({ rate: clean })}::jsonb, ${adminUser}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `);
  await storage.writeAuditLog("setting", "grader_card_rate", "grader_rate_set", adminUser, { rate: clean });
}

/** Admin-configurable daily card target (sibling pipeline_settings key — never
 *  touches grader_card_rate). Defaults to 20 when unset. */
export async function getGraderDailyTarget(): Promise<number> {
  const r = await db.execute(sql`SELECT value FROM pipeline_settings WHERE key = 'grader_daily_target' LIMIT 1`);
  const v = (r.rows[0] as any)?.value;
  if (v == null) return 20;
  const n = typeof v === "number" ? v : typeof v === "object" && v.target != null ? Number(v.target) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 20;
}

export async function setGraderDailyTarget(target: number, adminUser: string): Promise<void> {
  const clean = Number.isFinite(target) && target > 0 ? Math.round(target) : 20;
  await db.execute(sql`
    INSERT INTO pipeline_settings (key, value, updated_by, updated_at)
    VALUES ('grader_daily_target', ${JSON.stringify({ target: clean })}::jsonb, ${adminUser}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `);
  await storage.writeAuditLog("setting", "grader_daily_target", "grader_daily_target_set", adminUser, {
    target: clean,
  });
}

/**
 * PII-FREE analytics snapshot for one staffer/grader. All windows are UTC:
 * week = Monday 00:00, month = 1st 00:00, today = 00:00. earnings = approved ×
 * rate (rate may be 0/unset → caller shows "—"). Approval rate over the last 30
 * days; a cert that bounced (redo_count>0) then approved counts toward BOTH
 * approved and bounced (the honest rate). No customer/submission columns read.
 */
export async function getGraderAnalytics(graderId: string) {
  const now = new Date();
  const daysSinceMon = (now.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMon));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekISO = weekStart.toISOString();
  const monthISO = monthStart.toISOString();
  const dayISO = dayStart.toISOString();

  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE grader_status='approved' AND grade_approved_at >= ${weekISO}::timestamptz)::int  AS week_approved,
      COUNT(*) FILTER (WHERE grader_status='approved' AND grade_approved_at >= ${monthISO}::timestamptz)::int AS month_approved,
      COUNT(*) FILTER (WHERE grader_status='approved' AND grade_approved_at >= ${dayISO}::timestamptz)::int   AS today_approved,
      COUNT(*) FILTER (WHERE grader_status='approved')::int                                                   AS lifetime_approved,
      COUNT(*) FILTER (WHERE grader_status='assigned')::int                                                   AS q_assigned,
      COUNT(*) FILTER (WHERE grader_status='pending_review')::int                                             AS q_pending,
      COUNT(*) FILTER (WHERE grader_status='approved' AND grade_approved_at >= NOW() - INTERVAL '30 days')::int AS appr30,
      COUNT(*) FILTER (WHERE redo_count > 0 AND grade_approved_at >= NOW() - INTERVAL '30 days')::int           AS bounced30
    FROM certificates
    WHERE assigned_grader_id = ${graderId} AND deleted_at IS NULL
  `);
  const c = (r.rows[0] as any) || {};
  const num = (x: any) => Number(x || 0);
  const rate = await getGraderRate();
  const dailyTarget = await getGraderDailyTarget();
  const weekApproved = num(c.week_approved);
  const monthApproved = num(c.month_approved);
  const lifetimeApproved = num(c.lifetime_approved);
  const appr30 = num(c.appr30);
  const bounced30 = num(c.bounced30);
  const denom = appr30 + bounced30;
  return {
    rate,
    dailyTarget,
    week: { approved: weekApproved, earnings: weekApproved * rate, startDate: weekISO },
    month: { approved: monthApproved, earnings: monthApproved * rate, startDate: monthISO },
    today: { approved: num(c.today_approved) },
    queue: { assigned: num(c.q_assigned), pendingReview: num(c.q_pending) },
    approval: { approved: appr30, bounced: bounced30, rate: denom > 0 ? Math.round((appr30 / denom) * 100) : 0 },
    lifetime: { approved: lifetimeApproved, earnings: lifetimeApproved * rate },
  };
}

/**
 * A grader's own earnings snapshot. earned = approved × rate (display only —
 * flagged/rejected cards simply don't count until redone+approved; NEVER
 * subtract). Rate may be 0/unset.
 */
export async function getGraderEarnings(graderId: string) {
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE grader_status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE grader_status = 'pending_review')::int AS pending_review,
      COUNT(*) FILTER (WHERE redo_count > 0)::int AS flagged
    FROM certificates WHERE assigned_grader_id = ${graderId} AND deleted_at IS NULL
  `);
  const c = (r.rows[0] as any) || {};
  const rate = await getGraderRate();
  const approved = Number(c.approved || 0);
  return {
    approved,
    pendingReview: Number(c.pending_review || 0),
    flagged: Number(c.flagged || 0),
    rate,
    earned: approved * rate,
  };
}

/** Per-grader counts for the admin graders page. */
/**
 * PHASE 4 — a grader's per-operator review rate (0..100). New operators inherit
 * the users.review_rate column default of 100 (everything manually reviewed).
 * Returns 100 — the SAFE default (force review) — for a missing/unknown user or
 * any read error, so a lookup failure can never cause a silent auto-approve.
 */
export async function getOperatorReviewRate(userId: string | null): Promise<number> {
  if (!userId) return 100;
  try {
    const r = await db.execute(sql`SELECT review_rate FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1`);
    const row = r.rows[0] as any;
    if (!row || row.review_rate == null) return 100;
    const n = Number(row.review_rate);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, Math.round(n)));
  } catch {
    return 100;
  }
}

export async function getGraderCountsForAdmin() {
  const r = await db.execute(sql`
    SELECT u.id, u.email, u.display_name,
      COUNT(cert.id) FILTER (WHERE cert.grader_status = 'approved')::int AS approved,
      COUNT(cert.id) FILTER (WHERE cert.grader_status = 'pending_review')::int AS pending_review,
      COUNT(cert.id) FILTER (WHERE cert.grader_status = 'assigned')::int AS assigned,
      COUNT(cert.id) FILTER (WHERE cert.redo_count > 0)::int AS flagged
    FROM users u
    LEFT JOIN certificates cert ON cert.assigned_grader_id = u.id AND cert.deleted_at IS NULL
    WHERE u.role = 'grader' AND u.deleted_at IS NULL
    GROUP BY u.id, u.email, u.display_name
    ORDER BY u.created_at DESC
  `);
  return (r.rows as any[]).map((x) => ({
    id: x.id,
    email: x.email,
    displayName: x.display_name ?? null,
    approved: Number(x.approved || 0),
    pendingReview: Number(x.pending_review || 0),
    assigned: Number(x.assigned || 0),
    flagged: Number(x.flagged || 0),
  }));
}

// ── Phase 5 — per-operator grading stats (admin dashboard) ──────────────────
export interface OperatorStat {
  id: string;
  email: string;
  displayName: string | null;
  reviewRate: number;
  graded: number;
  scanned: number;
  pending: number;
  reviewFlagged: number;
  redos: number;
  avgOperatorGrade: number | null;
  avgFinalGrade: number | null;
  gradeDistribution: Record<string, number>;
  corrected: number;
  correctionPercentage: number;
  mostCorrectedField: string | null;
}

/**
 * Per-operator grading stats for the admin dashboard. Returns ONE row per
 * operator with can_grade=true (even with zero activity), so the dashboard lists
 * every operator with real zeros rather than a blank page. All SQL uses constant
 * literals only — no user input is interpolated.
 *
 * Built from a few grouped queries (graded / scanned / pending / distribution)
 * merged in JS rather than one multi-LEFT-JOIN query, which would fan out and
 * double-count across the independent attribution columns.
 */
export async function getOperatorStats(): Promise<OperatorStat[]> {
  const ops = (
    await db.execute(sql`
      SELECT id, email, display_name, review_rate
      FROM users
      WHERE can_grade = true AND deleted_at IS NULL
      ORDER BY created_at DESC
    `)
  ).rows as any[];

  // Graded aggregates by graded_by (active, non-deleted). operator_grade vs
  // grade (final) surfaces operator-vs-approved drift; AVG ignores NULLs.
  const graded = (
    await db.execute(sql`
      SELECT graded_by,
             COUNT(*)::int                                         AS graded,
             AVG(operator_grade)::float                            AS avg_operator,
             AVG(grade)::float                                     AS avg_final,
             SUM(CASE WHEN review_required THEN 1 ELSE 0 END)::int AS review_flagged,
             COALESCE(SUM(redo_count), 0)::int                     AS redos
      FROM certificates
      WHERE graded_by IS NOT NULL AND deleted_at IS NULL AND status = 'active'
      GROUP BY graded_by
    `)
  ).rows as any[];

  const scanned = (
    await db.execute(sql`
      SELECT scanned_by, COUNT(*)::int AS scanned
      FROM certificates
      WHERE scanned_by IS NOT NULL AND deleted_at IS NULL
      GROUP BY scanned_by
    `)
  ).rows as any[];

  const pending = (
    await db.execute(sql`
      SELECT assigned_grader_id, COUNT(*)::int AS pending
      FROM certificates
      WHERE assigned_grader_id IS NOT NULL AND grader_status = 'assigned' AND deleted_at IS NULL
      GROUP BY assigned_grader_id
    `)
  ).rows as any[];

  const dist = (
    await db.execute(sql`
      SELECT graded_by, grade::text AS grade, COUNT(*)::int AS n
      FROM certificates
      WHERE graded_by IS NOT NULL AND deleted_at IS NULL AND status = 'active' AND grade IS NOT NULL
      GROUP BY graded_by, grade
    `)
  ).rows as any[];

  const gradedMap = new Map(graded.map((r) => [r.graded_by, r]));
  const scannedMap = new Map(scanned.map((r) => [r.scanned_by, Number(r.scanned)]));
  const pendingMap = new Map(pending.map((r) => [r.assigned_grader_id, Number(r.pending)]));
  const distMap = new Map<string, Record<string, number>>();
  for (const r of dist) {
    const d = distMap.get(r.graded_by) ?? {};
    d[String(r.grade)] = Number(r.n);
    distMap.set(r.graded_by, d);
  }

  // Correction stats semantics:
  // - corrected   = distinct certificates corrected after publication whose graded_by is
  //                 this operator, scoped by the SAME three predicates as the `graded`
  //                 denominator above (graded_by NOT NULL, deleted_at NULL, status active),
  //                 so the numerator population is a strict subset of the denominator.
  // - field counts exclude internal/private fields (CORRECTION_DISPLAY_EXCLUDED_FIELDS).
  //
  // KNOWN ASYMMETRY: `graded` is all-time while `corrected` is bounded to the last 180 days
  // and the 10k most recent correction rows (the audit table is unbounded and this query
  // runs on a dashboard). correctionPercentage therefore UNDER-reports for operators with
  // history older than the window — it is a recent-quality signal, not a lifetime rate.
  // The Math.min(100, ...) below is defensive only; because the numerator is a subset of the
  // denominator the ratio cannot legitimately exceed 100.
  //
  // Supported by idx_audit_log_cert_correction_recent (migrations/0017), whose partial
  // predicate matches this WHERE clause exactly. Without it this is a full sequential scan
  // of audit_log — the LIMIT caps rows returned, not rows scanned.
  const corrections = (
    await db.execute(sql`
      WITH recent AS (
        SELECT entity_id, details, created_at
        FROM audit_log
        WHERE entity_type = 'certificate'
          AND action = 'cert_live_record_edit'
          AND created_at >= NOW() - INTERVAL '180 days'
        ORDER BY created_at DESC
        LIMIT 10000
      )
      SELECT cert.graded_by, cert.id AS cert_id, recent.details
      FROM recent
      JOIN certificates cert ON recent.entity_id = cert.id::text
      WHERE cert.graded_by IS NOT NULL
        AND cert.deleted_at IS NULL
        AND cert.status = 'active'
    `)
  ).rows as any[];
  // No silent caps: if the window is saturated the figures below are a floor, not a total.
  if (corrections.length >= 10000) {
    console.warn(
      "[operator-stats] correction window saturated at 10000 rows — correction counts are a lower bound; widen the cap or narrow the interval"
    );
  }
  const correctedCertsByOperator = new Map<string, Set<number>>();
  const correctedFieldsByOperator = new Map<string, Map<string, number>>();
  const fieldOrder = [
    "cardName",
    "setName",
    "year",
    "cardNumber",
    "variant",
    "rarity",
    "language",
    "game",
    "collection",
    "grade",
    "centering",
    "corners",
    "edges",
    "surface",
    "defects",
    "frontImage",
    "backImage",
  ];
  // Shared with the correction feedback UI so the two can never drift apart.
  const excludedFields = CORRECTION_DISPLAY_EXCLUDED_FIELDS;
  for (const row of corrections) {
    const operatorId = String(row.graded_by || "");
    if (!operatorId) continue;
    const certSet = correctedCertsByOperator.get(operatorId) ?? new Set<number>();
    certSet.add(Number(row.cert_id));
    correctedCertsByOperator.set(operatorId, certSet);

    const details = row.details && typeof row.details === "object" ? row.details : {};
    const fields = Array.isArray(details.changed_fields)
      ? details.changed_fields
      : details.changes && typeof details.changes === "object"
        ? Object.keys(details.changes)
        : [];
    const fieldMap = correctedFieldsByOperator.get(operatorId) ?? new Map<string, number>();
    for (const rawField of fields) {
      const field = String(rawField);
      if (!field || excludedFields.has(field)) continue;
      fieldMap.set(field, (fieldMap.get(field) ?? 0) + 1);
    }
    correctedFieldsByOperator.set(operatorId, fieldMap);
  }

  function commonField(operatorId: string): string | null {
    const counts = correctedFieldsByOperator.get(operatorId);
    if (!counts || counts.size === 0) return null;
    return [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const ai = fieldOrder.indexOf(a[0]);
      const bi = fieldOrder.indexOf(b[0]);
      if (ai !== bi) return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
      return a[0].localeCompare(b[0]);
    })[0][0];
  }

  return ops.map((u) => {
    const g = gradedMap.get(u.id) as any;
    const gradedCount = g ? Number(g.graded) : 0;
    const correctedCount = correctedCertsByOperator.get(u.id)?.size ?? 0;
    const correctionPercentage = gradedCount > 0 ? Math.min(100, Math.round((correctedCount / gradedCount) * 100)) : 0;
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name ?? null,
      reviewRate: u.review_rate == null ? 100 : Number(u.review_rate),
      graded: gradedCount,
      scanned: scannedMap.get(u.id) ?? 0,
      pending: pendingMap.get(u.id) ?? 0,
      reviewFlagged: g ? Number(g.review_flagged) : 0,
      redos: g ? Number(g.redos) : 0,
      avgOperatorGrade: g && g.avg_operator != null ? Number(g.avg_operator) : null,
      avgFinalGrade: g && g.avg_final != null ? Number(g.avg_final) : null,
      gradeDistribution: distMap.get(u.id) ?? {},
      corrected: correctedCount,
      correctionPercentage,
      mostCorrectedField: commonField(u.id),
    };
  });
}
