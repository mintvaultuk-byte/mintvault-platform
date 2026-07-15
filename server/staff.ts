/**
 * server/staff.ts — unified staff accounts + capability toggles.
 *
 * One staff account carries any of three capabilities: can_grade / can_scan /
 * can_print. role stays customer/admin/staff; capabilities (not role) decide
 * which tools a staffer may use. ADMIN implicitly has ALL capabilities and is
 * NEVER gated on these flags. Builds on the existing grader machinery (session,
 * delegation proxy, PII sanitizer) — re-gates it on capabilities, never rewrites.
 *
 * Grain: SCAN is whole-submission (a physical box). GRADE is cert-level (grader
 * v2). PRINT is a global slab-label queue. PII (customer name/email/address)
 * lives only on submissions and is NEVER returned by any /api/staff/* surface.
 */
import type { Request, Response, NextFunction } from "express";
import sharp from "sharp";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { hashPassword, verifyPassword, validatePassword } from "./account-auth";
import { uploadToR2 } from "./r2";
import { invalidateGraderSessionCache } from "./grader";
import {
  STAFF_ABSOLUTE_SESSION_MS,
  credentialVersionOf,
  destroySessionAndClearCookie,
  isAbsoluteSessionExpired,
} from "./lib/auth-security";

export type Capability = "grade" | "scan" | "print";
export interface Caps {
  grade: boolean;
  scan: boolean;
  print: boolean;
}

// ── Boot migrations (idempotent, additive, collision-checked: confirmed new) ──

/** users.can_grade / can_scan / can_print + backfill grader→can_grade. */
export async function migrateStaffCapabilitiesSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS can_grade BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_scan  BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_print BOOLEAN NOT NULL DEFAULT false
  `);
  // Backfill: existing grader / senior_grader users get can_grade. Only touches
  // rows still at the false default, so it's idempotent and never flips a flag
  // an admin set. NEVER touches customer/admin roles.
  await db.execute(sql`
    UPDATE users SET can_grade = true
    WHERE role IN ('grader', 'senior_grader') AND can_grade = false AND deleted_at IS NULL
  `);
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    SELECT 'schema', 'users', 'staff_capabilities_migrate', NULL,
           ${{ columns: ["can_grade", "can_scan", "can_print"], backfill: "role IN (grader,senior_grader) -> can_grade" }}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'staff_capabilities_migrate')
  `);
  console.log("[staff-caps-migrate] users capability columns ensured + grader backfill");
}

/** submissions.scan_assigned_to / scan_status / scan_assigned_at (NEW — not the
 *  dead v1 grader columns). */
export async function migrateScanSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE submissions
      ADD COLUMN IF NOT EXISTS scan_assigned_to VARCHAR,
      ADD COLUMN IF NOT EXISTS scan_status VARCHAR(20) NOT NULL DEFAULT 'unassigned',
      ADD COLUMN IF NOT EXISTS scan_assigned_at TIMESTAMPTZ
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_submissions_scan_assigned ON submissions (scan_assigned_to)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_submissions_scan_status ON submissions (scan_status)`);
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    SELECT 'schema', 'submissions', 'scan_schema_migrate', NULL,
           ${{ columns: ["scan_assigned_to", "scan_status", "scan_assigned_at"] }}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'scan_schema_migrate')
  `);
  console.log("[scan-migrate] submissions scan columns + indexes ensured");
}

// ── Middleware ────────────────────────────────────────────────────────────────

// ── Live-account re-validation (Phase 2 — stale-session defense) ──────────────
// Session fields (isStaff/capGrade/…) are stamped at login; without a re-check a
// soft-deleted OR capability-revoked staffer keeps full access until the cookie
// expires (hours/days). We re-validate against the DB per request — cached 60 s
// per user so it stays cheap (one PK lookup, ~zero on a cache hit) and shrinks
// the stale window from "cookie lifetime" to ≤60 s. Fails CLOSED on DB error.
interface CachedStaff {
  exists: boolean;
  capGrade: boolean;
  capScan: boolean;
  capPrint: boolean;
  credentialVersion: number;
  expiry: number;
}
const staffSessionCache = new Map<string, CachedStaff>();

export function invalidateStaffSessionCache(staffId: string): void {
  staffSessionCache.delete(String(staffId));
}

async function validateStaffSession(staffId: string): Promise<CachedStaff> {
  const cached = staffSessionCache.get(staffId);
  if (cached && Date.now() < cached.expiry) return cached;
  const r = await db.execute(sql`
    SELECT deleted_at, can_grade, can_scan, can_print, credential_version FROM users WHERE id = ${staffId} LIMIT 1
  `);
  const row = r.rows[0] as any;
  const live = !!row && !row.deleted_at;
  const v: CachedStaff = {
    exists: live,
    capGrade: live && !!row.can_grade,
    capScan: live && !!row.can_scan,
    capPrint: live && !!row.can_print,
    credentialVersion: live ? credentialVersionOf(row) : 1,
    expiry: Date.now() + 60_000,
  };
  staffSessionCache.set(staffId, v);
  return v;
}

/** Authenticated staff only (mutually exclusive with admin). 401 otherwise.
 *  Now also re-validates the account is still live (not soft-deleted) per request. */
export async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const s = req.session as any;
  if (!(s && s.isStaff && s.staffId && !s.isAdmin)) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (isAbsoluteSessionExpired(req, STAFF_ABSOLUTE_SESSION_MS)) {
      await destroySessionAndClearCookie(req, res);
      return res.status(401).json({ error: "Unauthorized" });
    }
    const live = await validateStaffSession(String(s.staffId));
    if (!live.exists) return res.status(401).json({ error: "Unauthorized" });
    if (Number(s.credentialVersion ?? 1) !== live.credentialVersion) {
      await destroySessionAndClearCookie(req, res);
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  } catch {
    return res.status(500).json({ error: "Internal server error" }); // fail-closed
  }
}

/** Staff session that holds a specific capability. 401 if not staff/gone, 403 if
 *  the capability is missing. Re-checks BOTH liveness and the capability against
 *  the DB per request. Put on EVERY tool endpoint — a missed gate is a hole. */
export function requireCapability(cap: Capability) {
  const key = cap === "grade" ? "capGrade" : cap === "scan" ? "capScan" : "capPrint";
  return async (req: Request, res: Response, next: NextFunction) => {
    const s = req.session as any;
    if (!(s && s.isStaff && s.staffId && !s.isAdmin)) return res.status(401).json({ error: "Unauthorized" });
    if (!s[key]) return res.status(403).json({ error: `Forbidden: missing '${cap}' capability` });
    try {
      if (isAbsoluteSessionExpired(req, STAFF_ABSOLUTE_SESSION_MS)) {
        await destroySessionAndClearCookie(req, res);
        return res.status(401).json({ error: "Unauthorized" });
      }
      const live = await validateStaffSession(String(s.staffId));
      if (!live.exists) return res.status(401).json({ error: "Unauthorized" });
      if (Number(s.credentialVersion ?? 1) !== live.credentialVersion) {
        await destroySessionAndClearCookie(req, res);
        return res.status(401).json({ error: "Unauthorized" });
      }
      const liveCap = cap === "grade" ? live.capGrade : cap === "scan" ? live.capScan : live.capPrint;
      if (!liveCap) return res.status(403).json({ error: `Forbidden: missing '${cap}' capability` });
      return next();
    } catch {
      return res.status(500).json({ error: "Internal server error" }); // fail-closed
    }
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** A user is "staff" iff they have ≥1 capability (admins use the admin login). */
export async function authenticateStaff(
  email: string,
  password: string
): Promise<
  | { ok: true; id: string; email: string; displayName: string | null; caps: Caps; credentialVersion: number }
  | { ok: false }
> {
  const cleanEmail = String(email || "")
    .toLowerCase()
    .trim();
  if (!cleanEmail || !password) return { ok: false };
  const r = await db.execute(sql`
    SELECT id, email, display_name, password_hash, role, deleted_at, can_grade, can_scan, can_print,
           failed_login_count, locked_until, credential_version
    FROM users WHERE LOWER(email) = ${cleanEmail} LIMIT 1
  `);
  const u = r.rows[0] as any;
  if (!u || u.deleted_at || u.role === "admin" || !u.password_hash) return { ok: false };
  const lockedUntil = u.locked_until ? new Date(u.locked_until) : null;
  if (lockedUntil && lockedUntil > new Date()) return { ok: false };
  if (lockedUntil && lockedUntil <= new Date()) {
    await db.execute(sql`
      UPDATE users
      SET failed_login_count = 0,
          locked_until = NULL,
          last_failed_login_at = NULL
      WHERE id = ${u.id}
    `);
    u.failed_login_count = 0;
    u.locked_until = null;
  }
  const caps: Caps = { grade: !!u.can_grade, scan: !!u.can_scan, print: !!u.can_print };
  if (!caps.grade && !caps.scan && !caps.print) return { ok: false };
  const valid = await verifyPassword(password, u.password_hash);
  if (!valid) {
    await db.execute(sql`
      UPDATE users
      SET failed_login_count = failed_login_count + 1,
          last_failed_login_at = NOW(),
          locked_until = CASE
            WHEN failed_login_count + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
            ELSE locked_until
          END,
          updated_at = NOW()
      WHERE id = ${u.id}
    `);
    return { ok: false };
  }
  await db.execute(sql`
    UPDATE users
    SET last_login_at = NOW(),
        failed_login_count = 0,
        locked_until = NULL,
        last_failed_login_at = NULL
    WHERE id = ${u.id}
  `);
  return {
    ok: true,
    id: u.id,
    email: u.email,
    displayName: u.display_name ?? null,
    caps,
    credentialVersion: credentialVersionOf(u),
  };
}

// ── Admin: staff accounts + capability toggles ────────────────────────────────

/** All staff (any capability), with their caps + grade/scan workload counts. */
export async function listStaffWithCounts() {
  const r = await db.execute(sql`
    SELECT u.id, u.email, u.display_name, u.can_grade, u.can_scan, u.can_print, u.review_rate,
      u.deleted_at, u.failed_login_count, u.locked_until,
      (SELECT COUNT(*) FROM certificates c WHERE c.assigned_grader_id = u.id AND c.deleted_at IS NULL AND c.grader_status = 'assigned')::int AS grade_assigned,
      (SELECT COUNT(*) FROM certificates c WHERE c.assigned_grader_id = u.id AND c.deleted_at IS NULL AND c.grader_status = 'pending_review')::int AS grade_pending,
      (SELECT COUNT(*) FROM certificates c WHERE c.assigned_grader_id = u.id AND c.deleted_at IS NULL AND c.grader_status = 'approved')::int AS grade_approved,
      (SELECT COUNT(*) FROM submissions s WHERE s.scan_assigned_to = u.id AND s.deleted_at IS NULL AND s.scan_status = 'assigned')::int AS scan_assigned
    FROM users u
    WHERE u.deleted_at IS NULL AND u.role <> 'admin' AND u.role <> 'customer'
      AND (u.can_grade OR u.can_scan OR u.can_print)
    ORDER BY u.created_at DESC
  `);
  return (r.rows as any[]).map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name ?? null,
    caps: { grade: !!u.can_grade, scan: !!u.can_scan, print: !!u.can_print },
    enabled: !u.deleted_at,
    failedLoginCount: Number(u.failed_login_count || 0),
    lockedUntil: u.locked_until ? new Date(u.locked_until).toISOString() : null,
    reviewRate: u.review_rate == null ? 100 : Number(u.review_rate),
    gradeAssigned: Number(u.grade_assigned || 0),
    gradePending: Number(u.grade_pending || 0),
    gradeApproved: Number(u.grade_approved || 0),
    scanAssigned: Number(u.scan_assigned || 0),
  }));
}

/**
 * PHASE 4 — set a grader's per-operator review_rate (0..100). Staff-only (never
 * admin/customer). Audited. The rate decides what fraction of that operator's
 * submissions get manually reviewed vs auto-approved at submit time.
 */
export async function setStaffReviewRate(userId: string, rate: number, adminUser: string) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { ok: false as const, status: 400, error: "review_rate must be an integer 0–100" };
  }
  const clean = Math.round(rate);
  const u = await db.execute(sql`SELECT id, role FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1`);
  const row = u.rows[0] as any;
  if (!row) return { ok: false as const, status: 404, error: "User not found" };
  if (row.role === "admin") return { ok: false as const, status: 400, error: "Admins are never operator-graded" };
  await db.execute(sql`UPDATE users SET review_rate = ${clean}, updated_at = NOW() WHERE id = ${userId}`);
  await storage.writeAuditLog("user", userId, "staff_review_rate_set", adminUser, { review_rate: clean });
  return { ok: true as const, reviewRate: clean };
}

/**
 * Create OR promote a staff account (admin only). A brand-new email creates a
 * fresh role='staff' account. An EXISTING email PROMOTES that account: grants the
 * requested capabilities (merged, never clobbering existing caps), flips a
 * customer to role='staff' so they show in the staff list, reactivates a
 * soft-deleted account, and fills an empty display name — but NEVER touches the
 * password (they keep signing in with their existing one) and NEVER modifies an
 * admin account. `promoted` distinguishes the two outcomes for the UI.
 */
export async function createStaffAccount(
  email: string,
  password: string,
  displayName: string | null,
  caps: Caps,
  adminUser: string
): Promise<
  | { ok: true; id: string; email: string; promoted: boolean; reactivated: boolean }
  | { ok: false; status: number; error: string }
> {
  const cleanEmail = String(email || "")
    .toLowerCase()
    .trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return { ok: false, status: 400, error: "Invalid email address" };

  const existing = await db.execute(
    sql`SELECT id, role, deleted_at FROM users WHERE LOWER(email) = ${cleanEmail} LIMIT 1`
  );
  const row = existing.rows[0] as any;

  if (row) {
    // ── PROMOTE an existing account — never touches the password ──────────────
    if (row.role === "admin") return { ok: false, status: 400, error: "That email is an admin account" };
    const reactivated = !!row.deleted_at;
    // Reactivate (clear deleted_at), promote customer→staff so they appear in the
    // staff list, and fill an EMPTY display name only. setStaffCapabilities below
    // grants the caps without clobbering — this UPDATE deliberately leaves caps alone.
    await db.execute(sql`
      UPDATE users SET
        deleted_at = NULL,
        role = CASE WHEN role = 'customer' THEN 'staff' ELSE role END,
        display_name = COALESCE(NULLIF(display_name, ''), ${displayName?.trim() || null}),
        updated_at = NOW()
      WHERE id = ${row.id}
    `);
    // Grant only the requested-true caps via the existing capability path, so an
    // existing capability is never turned off (merge, not replace).
    const grant: Partial<Caps> = {};
    if (caps.grade) grant.grade = true;
    if (caps.scan) grant.scan = true;
    if (caps.print) grant.print = true;
    if (Object.keys(grant).length) await setStaffCapabilities(row.id, grant, adminUser);
    await storage.writeAuditLog("user", row.id, "staff_promoted", adminUser, {
      email: cleanEmail,
      caps,
      was_existing: true,
      reactivated,
    });
    return { ok: true, id: row.id, email: cleanEmail, promoted: true, reactivated };
  }

  // ── CREATE a brand-new staff account (password required + validated here only) ──
  const pw = validatePassword(password || "");
  if (!pw.valid) return { ok: false, status: 400, error: pw.message || "Weak password" };
  const hash = await hashPassword(password);
  const r = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, email_verified, can_grade, can_scan, can_print, created_at, updated_at)
    VALUES (${cleanEmail}, ${hash}, ${displayName?.trim() || null}, 'staff', true, ${!!caps.grade}, ${!!caps.scan}, ${!!caps.print}, NOW(), NOW())
    RETURNING id, email
  `);
  const newRow = r.rows[0] as any;
  await storage.writeAuditLog("user", newRow.id, "staff_create", adminUser, { email: cleanEmail, caps });
  return { ok: true, id: newRow.id, email: newRow.email, promoted: false, reactivated: false };
}

/** Set a staffer's capability flags (admin). Audited. */
export async function setStaffCapabilities(userId: string, caps: Partial<Caps>, adminUser: string) {
  const u = await db.execute(sql`SELECT id, role FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1`);
  if (!(u.rows[0] as any)) return { ok: false as const, status: 404, error: "User not found" };
  if ((u.rows[0] as any).role === "admin")
    return { ok: false as const, status: 400, error: "Admins already have all capabilities" };
  await db.execute(sql`
    UPDATE users SET
      can_grade = ${caps.grade === undefined ? sql`can_grade` : caps.grade},
      can_scan  = ${caps.scan === undefined ? sql`can_scan` : caps.scan},
      can_print = ${caps.print === undefined ? sql`can_print` : caps.print},
      updated_at = NOW()
    WHERE id = ${userId}
  `);
  await storage.writeAuditLog("user", userId, "staff_capabilities_set", adminUser, caps as Record<string, unknown>);
  // Phase 2 — invalidate the session caches NOW so the capability change takes
  // effect immediately rather than waiting out the 60s validation TTL.
  invalidateStaffSessionCache(userId);
  invalidateGraderSessionCache(userId);
  return { ok: true as const };
}

/**
 * Guard shared by the email/password edit endpoints. A row is editable here ONLY
 * if it is a LIVE staff account (deleted_at IS NULL), NEVER an admin, and NEVER a
 * plain customer — "staff" = role in (staff/grader/senior_grader) AND ≥1
 * capability, mirroring listStaffWithCounts + setStaffCapabilities's refusal
 * pattern. Returns the current row or a typed refusal.
 */
async function loadStaffForEdit(
  userId: string
): Promise<
  { ok: true; row: { id: string; email: string; role: string } } | { ok: false; status: number; error: string }
> {
  const r = await db.execute(sql`
    SELECT id, email, role, can_grade, can_scan, can_print
    FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
  `);
  const row = r.rows[0] as any;
  if (!row) return { ok: false, status: 404, error: "Staff account not found" };
  if (row.role === "admin") return { ok: false, status: 400, error: "Admin accounts cannot be edited here" };
  const isStaffRole = row.role === "staff" || row.role === "grader" || row.role === "senior_grader";
  const hasCap = !!(row.can_grade || row.can_scan || row.can_print);
  if (!isStaffRole || !hasCap) return { ok: false, status: 400, error: "Not a staff account" };
  return { ok: true, row: { id: String(row.id), email: String(row.email), role: String(row.role) } };
}

/**
 * Change a staffer's login email (admin). Staff-only via loadStaffForEdit (never
 * admin/customer). Normalises to lowercase (same as createStaffAccount), enforces
 * uniqueness against every OTHER row case-insensitively (with the users.email
 * unique index as a backstop → 409), and audits staff_email_changed
 * {old_email,new_email}. Because authenticateStaff matches on LOWER(email), this
 * changes their /staff/login email.
 */
export async function updateStaffEmail(
  userId: string,
  email: string,
  adminUser: string
): Promise<{ ok: true; email: string } | { ok: false; status: number; error: string }> {
  const guard = await loadStaffForEdit(userId);
  if (!guard.ok) return guard;
  const cleanEmail = String(email || "")
    .toLowerCase()
    .trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return { ok: false, status: 400, error: "Invalid email address" };
  const oldEmail = guard.row.email;
  // Same email (case-insensitive) → no-op; don't write a spurious audit row.
  if (
    cleanEmail ===
    String(oldEmail || "")
      .toLowerCase()
      .trim()
  )
    return { ok: true, email: cleanEmail };

  const dup = await db.execute(
    sql`SELECT id FROM users WHERE LOWER(email) = ${cleanEmail} AND id <> ${userId} LIMIT 1`
  );
  if (dup.rows.length) return { ok: false, status: 409, error: "That email is already in use" };

  try {
    const upd = await db.execute(
      sql`UPDATE users SET email = ${cleanEmail}, updated_at = NOW()
          WHERE id = ${userId} AND deleted_at IS NULL AND role <> 'admin' RETURNING id`
    );
    // Zero rows = the row vanished/changed between guard and UPDATE — surface, never succeed silently.
    if (!upd.rows.length) return { ok: false, status: 409, error: "Email not updated" };
  } catch (e: any) {
    if (e?.code === "23505") return { ok: false, status: 409, error: "That email is already in use" };
    throw e;
  }
  await storage.writeAuditLog("user", userId, "staff_email_changed", adminUser, {
    old_email: oldEmail,
    new_email: cleanEmail,
  });
  return { ok: true, email: cleanEmail };
}

/**
 * Reset a staffer's login password (admin). Staff-only via loadStaffForEdit
 * (never admin/customer). Runs the SAME validatePassword rules + hashPassword
 * path as createStaffAccount; NEVER stores or logs plain text. Audits
 * staff_password_reset with NO password value in details. Changes /staff/login.
 */
export async function resetStaffPassword(
  userId: string,
  password: string,
  adminUser: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const guard = await loadStaffForEdit(userId);
  if (!guard.ok) return guard;
  const pw = validatePassword(password || "");
  if (!pw.valid) return { ok: false, status: 400, error: pw.message || "Weak password" };
  const hash = await hashPassword(password);
  const upd = await db.execute(
    sql`UPDATE users SET password_hash = ${hash},
        credential_version = credential_version + 1,
        failed_login_count = 0,
        locked_until = NULL,
        last_failed_login_at = NULL,
        updated_at = NOW()
        WHERE id = ${userId} AND deleted_at IS NULL AND role <> 'admin' RETURNING id`
  );
  if (!upd.rows.length) return { ok: false, status: 409, error: "Password not updated" };
  // details is intentionally empty — NEVER the password (plain OR hash).
  await storage.writeAuditLog("user", userId, "staff_password_reset", adminUser, {});
  invalidateStaffSessionCache(userId);
  invalidateGraderSessionCache(userId);
  return { ok: true };
}

export async function revokeStaffSessions(
  userId: string,
  adminUser: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const guard = await loadStaffForEdit(userId);
  if (!guard.ok) return guard;
  const upd = await db.execute(sql`
    UPDATE users
    SET credential_version = credential_version + 1,
        updated_at = NOW()
    WHERE id = ${userId} AND deleted_at IS NULL AND role <> 'admin'
    RETURNING id
  `);
  if (!upd.rows.length) return { ok: false, status: 409, error: "Sessions not revoked" };
  await storage.writeAuditLog("user", userId, "staff_sessions_revoked", adminUser, {});
  invalidateStaffSessionCache(userId);
  invalidateGraderSessionCache(userId);
  return { ok: true };
}

/**
 * Soft-delete a staff account (sets deleted_at — NEVER a hard delete). Refuses
 * admin accounts, and refuses anyone still holding open grading work
 * (grader_status 'assigned'/'pending_review') until those certs are reassigned.
 * Audited.
 */
export async function deleteStaffAccount(staffId: string, adminUser: string) {
  const u = await db.execute(
    sql`SELECT id, email, role, can_grade, can_scan, can_print FROM users WHERE id = ${staffId} AND deleted_at IS NULL LIMIT 1`
  );
  const row = u.rows[0] as any;
  if (!row) return { ok: false as const, status: 404, error: "Staff account not found" };
  if (row.role === "admin") return { ok: false as const, status: 400, error: "Admin accounts cannot be deleted here" };

  const open = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM certificates
        WHERE assigned_grader_id = ${staffId} AND grader_status IN ('assigned', 'pending_review') AND deleted_at IS NULL`
  );
  const n = Number((open.rows[0] as any)?.n || 0);
  if (n > 0) return { ok: false as const, status: 400, error: `Reassign ${n} card(s) before deleting.` };

  const r = await db.execute(
    sql`UPDATE users SET deleted_at = NOW(),
        credential_version = credential_version + 1,
        updated_at = NOW()
        WHERE id = ${staffId} AND role <> 'admin' AND deleted_at IS NULL RETURNING id`
  );
  if (!r.rows.length) return { ok: false as const, status: 409, error: "Account is not deletable or already deleted" };

  await storage.writeAuditLog("user", staffId, "staff_deleted", adminUser, {
    email: row.email,
    role: row.role,
    caps: { grade: !!row.can_grade, scan: !!row.can_scan, print: !!row.can_print },
  });
  // Phase 2 — kill the session caches NOW so the deleted account can't keep acting
  // for up to 60s on a stale cache entry.
  invalidateStaffSessionCache(staffId);
  invalidateGraderSessionCache(staffId);
  return { ok: true as const };
}

// ── Scanner: assignment (submission-level) ────────────────────────────────────

async function canScan(userId: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT 1 FROM users WHERE id = ${userId} AND can_scan = true AND deleted_at IS NULL LIMIT 1`
  );
  return r.rows.length > 0;
}

export async function assignScanSubmissions(staffId: string, submissionIds: number[], adminUser: string) {
  if (!(await canScan(staffId))) return { ok: false as const, status: 400, error: "Not a can_scan staffer" };
  const clean = submissionIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No submission ids" };
  const r = await db.execute(sql`
    UPDATE submissions
    SET scan_assigned_to = ${staffId}, scan_status = 'assigned', scan_assigned_at = NOW(), updated_at = NOW()
    WHERE id = ANY(${clean}::int[]) AND deleted_at IS NULL AND scan_status <> 'scanned'
    RETURNING id
  `);
  await storage.writeAuditLog("submission", clean.join(","), "scan_assign", adminUser, {
    staff_id: staffId,
    submission_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

export async function unassignScanSubmissions(submissionIds: number[], adminUser: string) {
  const clean = submissionIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No submission ids" };
  const r = await db.execute(sql`
    UPDATE submissions
    SET scan_assigned_to = NULL, scan_status = 'unassigned', scan_assigned_at = NULL, updated_at = NOW()
    WHERE id = ANY(${clean}::int[]) AND deleted_at IS NULL AND scan_status <> 'scanned'
    RETURNING id
  `);
  await storage.writeAuditLog("submission", clean.join(","), "scan_unassign", adminUser, {
    submission_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}

/** The cards a scanner must photograph for one submission (PII-FREE). */
async function scanCardsForSubmission(submissionId: number) {
  const r = await db.execute(sql`
    SELECT cert.id AS cert_id, cert.certificate_number AS cert_id_str, cert.card_name, cert.set_name,
           cert.card_number_display AS card_number, cert.year_text AS year, cert.variant,
           cert.grading_front_original, cert.grading_back_original, cert.front_image_path, cert.back_image_path
    FROM certificates cert JOIN cards c ON cert.card_id = c.id
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
    variant: row.variant ?? null,
    hasFront: !!(row.grading_front_original || row.front_image_path),
    hasBack: !!(row.grading_back_original || row.back_image_path),
  }));
}

/** This scanner's queue: assigned submissions + which cards still need front/back. PII-FREE. */
export async function getScanQueue(staffId: string) {
  const subs = await db.execute(sql`
    SELECT id, tracking_number, scan_status, scan_assigned_at, card_count, service_tier
    FROM submissions
    WHERE scan_assigned_to = ${staffId} AND scan_status IN ('assigned') AND deleted_at IS NULL
    ORDER BY scan_assigned_at DESC NULLS LAST, id DESC
  `);
  const items = await Promise.all(
    (subs.rows as any[]).map(async (s) => ({
      submissionId: Number(s.id),
      submissionRef: s.tracking_number,
      scanStatus: s.scan_status,
      cardCount: s.card_count,
      serviceTier: s.service_tier ?? null,
      cards: await scanCardsForSubmission(Number(s.id)),
    }))
  );
  return items;
}

/** The submission a cert belongs to, IF it is scan-assigned to this staffer. */
export async function authorizeScanCert(staffId: string, certId: number): Promise<number | null> {
  const r = await db.execute(sql`
    SELECT s.id AS sid
    FROM certificates cert JOIN cards c ON cert.card_id = c.id JOIN submissions s ON s.id = c.submission_id
    WHERE cert.id = ${certId} AND s.scan_assigned_to = ${staffId} AND s.scan_status = 'assigned' AND s.deleted_at IS NULL
    LIMIT 1
  `);
  const row = r.rows[0] as any;
  return row ? Number(row.sid) : null;
}

/**
 * Store a raw scan onto a certificate (the scanner's job is capture; the grader
 * crops via the card tool). Re-encodes to JPEG (strips EXIF), uploads to the
 * same R2 key the admin upload path uses, sets the original + canonical display
 * path. Then, if every card in the submission now has front+back, flips the
 * submission to 'scanned'. PII-FREE. Returns whether the submission is complete.
 */
export async function recordScanUpload(
  certId: number,
  certIdStr: string,
  side: "front" | "back",
  buffer: Buffer,
  submissionId: number,
  staffEmail: string
): Promise<{ submissionScanned: boolean }> {
  const jpeg = await sharp(buffer).rotate().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const key = `grading/${certIdStr}/${side}_original.jpg`;
  await uploadToR2(key, jpeg, "image/jpeg");
  if (side === "front") {
    await db.execute(
      sql`UPDATE certificates SET grading_front_original = ${key}, front_image_path = ${key}, updated_at = NOW() WHERE id = ${certId}`
    );
  } else {
    await db.execute(
      sql`UPDATE certificates SET grading_back_original = ${key}, back_image_path = ${key}, updated_at = NOW() WHERE id = ${certId}`
    );
  }
  await storage.writeAuditLog("certificate", String(certId), "scan_upload", staffEmail, {
    side,
    submission_id: submissionId,
  });

  // Submission complete when every card has both originals.
  const cards = await scanCardsForSubmission(submissionId);
  const complete = cards.length > 0 && cards.every((c) => c.hasFront && c.hasBack);
  if (complete) {
    await db.execute(
      sql`UPDATE submissions SET scan_status = 'scanned', updated_at = NOW() WHERE id = ${submissionId} AND scan_status = 'assigned'`
    );
    await storage.writeAuditLog("submission", String(submissionId), "scan_complete", staffEmail, {
      cards: cards.length,
    });
  }
  return { submissionScanned: complete };
}
