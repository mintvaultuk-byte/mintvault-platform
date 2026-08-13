import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { storage } from "./storage";
import { verifyPassword } from "./account-auth";
import {
  ADMIN_ABSOLUTE_SESSION_MS,
  clearSessionCookie,
  credentialVersionOf,
  destroySessionAndClearCookie,
  isAbsoluteSessionExpired,
} from "./lib/auth-security";

// Aligned 2026-05-04 with the user row migrated to role='admin' by
// migrateAccountSchema(). PIN auth flow uses storage.getUserByEmail(ADMIN_EMAIL)
// to locate the admin's pin_hash; the constant must match the actual row's email.
const ADMIN_EMAIL = "mintvaultuk@gmail.com";

/**
 * ADVISORY-ONLY per-process counters (invariant I19).
 *
 * These remain as a cheap first-line check, but they are NO LONGER the only control on the admin
 * password step. On the two-Machine production topology a per-process Map gives an attacker double
 * the advertised budget and is wiped by every rolling deploy. The AUTHORITATIVE control is now the
 * durable, shared lockout below (password_failed_count / password_locked_until on `users`,
 * migration 0079), which mirrors the PIN step's long-standing DB-backed lockout in server/pin.ts.
 *
 * Keeping both is deliberate: the in-memory check short-circuits obvious floods without a query,
 * while correctness no longer depends on it.
 */
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const pinAttempts = new Map<string, { count: number; firstAttempt: number }>();

/** Mirrors server/pin.ts so both admin credential steps lock out identically. */
const PASSWORD_LOCKOUT_THRESHOLD = 5;
const PASSWORD_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Durable, fleet-wide lockout state for the admin PASSWORD step.
 *
 * Degrades to "not locked" when the 0079 columns are absent, so this is safe to deploy either side
 * of the migration (expand → migrate → deploy) — the pre-existing in-memory control still applies in
 * that window, which is exactly the previous behaviour rather than a regression.
 */
export async function isAdminPasswordLockedOut(): Promise<{ locked: boolean; retryAfter?: Date }> {
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const r = await db.execute(sql`
      SELECT password_locked_until FROM users
       WHERE LOWER(email) = LOWER(${ADMIN_EMAIL}) AND deleted_at IS NULL LIMIT 1
    `);
    const row = r.rows[0] as { password_locked_until: string | null } | undefined;
    if (!row?.password_locked_until) return { locked: false };
    const until = new Date(row.password_locked_until);
    return until > new Date() ? { locked: true, retryAfter: until } : { locked: false };
  } catch {
    // Pre-0079 database, or a transient error. Do NOT fail closed here: that would let a database
    // blip lock the owner out of their own admin panel entirely. The in-memory limiter and the
    // separate PIN step (which has its own durable lockout) still apply.
    return { locked: false };
  }
}

/** Atomic increment-and-maybe-lock, matching server/pin.ts's registerFailure(). */
export async function registerAdminPasswordFailure(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      UPDATE users
         SET password_failed_count = COALESCE(password_failed_count, 0) + 1,
             password_locked_until = CASE
               WHEN COALESCE(password_failed_count, 0) + 1 >= ${PASSWORD_LOCKOUT_THRESHOLD}
               THEN NOW() + ${sql.raw(`INTERVAL '${PASSWORD_LOCKOUT_DURATION_MS / 1000} seconds'`)}
               ELSE password_locked_until
             END,
             updated_at = NOW()
       WHERE LOWER(email) = LOWER(${ADMIN_EMAIL}) AND deleted_at IS NULL
    `);
  } catch {
    /* pre-0079 database — the in-memory counter still records the attempt */
  }
}

/** Clear the durable counter on a successful password step. */
export async function clearAdminPasswordFailures(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      UPDATE users
         SET password_failed_count = 0, password_locked_until = NULL, updated_at = NOW()
       WHERE LOWER(email) = LOWER(${ADMIN_EMAIL}) AND deleted_at IS NULL
    `);
  } catch {
    /* pre-0079 database — nothing durable to clear */
  }
}
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_PIN_ATTEMPTS = 5;
const FAILED_LOGIN_DELAY_MS = 400;
const PENDING_ADMIN_TTL_MS = 5 * 60 * 1000;

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB);
}

export function isLoginRateLimited(req: Request): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry) return false;

  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }

  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

export function isPinRateLimited(req: Request): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = pinAttempts.get(ip);

  if (!entry) return false;

  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    pinAttempts.delete(ip);
    return false;
  }

  return entry.count >= MAX_PIN_ATTEMPTS;
}

export function recordFailedLogin(req: Request): void {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

export function recordFailedPin(req: Request): number {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = pinAttempts.get(ip);

  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    pinAttempts.set(ip, { count: 1, firstAttempt: now });
    return 1;
  } else {
    entry.count++;
    return entry.count;
  }
}

export function clearLoginAttempts(req: Request): void {
  const ip = getClientIp(req);
  loginAttempts.delete(ip);
}

export function clearPinAttempts(req: Request): void {
  const ip = getClientIp(req);
  pinAttempts.delete(ip);
}

export type AdminPasswordVerification =
  | { valid: true; source: "db_hash" | "break_glass"; adminUser?: unknown }
  | { valid: false; source: "db_hash" | "break_glass" | "missing"; adminUser?: unknown };

export async function verifyAdminPassword(password: string, adminUser?: unknown): Promise<AdminPasswordVerification> {
  const user = adminUser ?? (await storage.getUserByEmail(ADMIN_EMAIL));
  const hash = (user as any)?.adminPassphraseHash ?? (user as any)?.admin_passphrase_hash;
  if (hash) {
    return { valid: await verifyPassword(password, String(hash)), source: "db_hash", adminUser: user };
  }
  const raw = process.env.ADMIN_PASSWORD;
  if (!raw) return { valid: false, source: "missing", adminUser: user };
  return { valid: timingSafeEqual(password.trim(), raw.trim()), source: "break_glass", adminUser: user };
}

// verifyAdminPin removed 2026-05-04 — admin PIN is now bcrypt-hashed on
// users.pin_hash and verified via storage.getUserByEmail(ADMIN_EMAIL) +
// verifyPin from server/pin.ts. ADMIN_PIN env var is obsolete.

export function isPendingAdminValid(req: Request): boolean {
  if (!req.session?.pendingAdmin) return false;
  if (!req.session?.pendingAdminAt) return false;
  const elapsed = Date.now() - req.session.pendingAdminAt;
  return elapsed < PENDING_ADMIN_TTL_MS;
}

export function clearPendingAdmin(req: Request): void {
  if (req.session) {
    req.session.pendingAdmin = false;
    req.session.pendingAdminAt = undefined;
    req.session.pinFailures = 0;
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Internal grader→admin delegation: the grader proxy (server/routes/grader.ts)
  // sets this request-local flag ONLY after verifying grader OWNERSHIP of the
  // cert, then re-dispatches to the unchanged admin handler. Not settable by any
  // client (no header/body path), so it can't be forged.
  if ((req as any).__graderProxy === true) {
    return next();
  }
  if (req.session && req.session.isAdmin) {
    try {
      if (isAbsoluteSessionExpired(req, ADMIN_ABSOLUTE_SESSION_MS)) {
        await destroySessionAndClearCookie(req, res);
        return res.status(401).json({ error: "Session expired" });
      }
      const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
      if (!adminUser || (adminUser as any).deletedAt) {
        await destroySessionAndClearCookie(req, res);
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionVersion = Number((req.session as any).credentialVersion ?? 1);
      if (sessionVersion !== credentialVersionOf(adminUser)) {
        await destroySessionAndClearCookie(req, res);
        return res.status(401).json({ error: "Session expired" });
      }
      return next();
    } catch {
      return res.status(500).json({ error: "Internal server error" });
    }
  }
  // A logged-in GRADER must NEVER reach an admin route — explicit 403 (not 401)
  // so it's unambiguous this is a role denial, not a missing session.
  if (req.session && (req.session as any).isGrader) {
    return res.status(403).json({ error: "Forbidden: graders cannot access admin endpoints" });
  }
  return res.status(401).json({ error: "Unauthorized" });
}

export function clearAuthCookie(res: Response) {
  clearSessionCookie(res);
}

export function superAdminEmails(): Set<string> {
  const configured = (process.env.SUPER_ADMIN_EMAILS || ADMIN_EMAIL)
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : [ADMIN_EMAIL.toLowerCase()]);
}

export function isSuperAdminEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return superAdminEmails().has(email.trim().toLowerCase());
}

export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  await requireAdmin(req, res, () => {
    const email = (req.session as any)?.adminEmail;
    if (!isSuperAdminEmail(email)) {
      return res.status(403).json({ error: "Forbidden: Super Admin required" });
    }
    return next();
  });
}

export function adminIpAllowlist(req: Request, res: Response, next: NextFunction) {
  const allowlist = process.env.ADMIN_IP_ALLOWLIST;
  if (!allowlist) return next();

  const allowed = allowlist
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (allowed.length === 0) return next();

  const clientIp = getClientIp(req);
  if (allowed.includes(clientIp)) return next();

  return res.status(403).json({ error: "Forbidden" });
}

export { ADMIN_EMAIL, FAILED_LOGIN_DELAY_MS };

declare module "express-session" {
  interface SessionData {
    // Admin auth
    isAdmin: boolean;
    adminEmail: string;
    pendingAdmin: boolean;
    pendingAdminAt: number | undefined;
    pinFailures: number;
    authUserId: string;
    authRole: string;
    credentialVersion: number;
    authenticatedAt: number;
    // Legacy customer magic link auth (dashboard)
    customerEmail: string;
    // Unified account auth
    userId: string; // UUID of the logged-in user
    userEmail: string; // email, cached for convenience
    // Restricted grader auth (server/grader.ts) — a 4th, mutually-exclusive
    // login type. Set ONLY by /api/grader/login; cleared on every other login.
    isGrader: boolean;
    graderId: string; // users.id of the grader (role='grader')
    graderEmail: string;
    // Unified staff auth (server/staff.ts) — one account + capability flags. The
    // grade routes alias graderId=staffId so the grader machinery is reused.
    isStaff: boolean;
    staffId: string;
    staffEmail: string;
    capGrade: boolean;
    capScan: boolean;
    capPrint: boolean;
    capEditSets: boolean;
  }
}
