/**
 * PIN-based authentication helpers — bcrypt hash/verify, strength rules,
 * per-user lockout state machine, attempt logging.
 *
 * Used by: cert-owner /api/auth/pin/* endpoints AND admin two-step login.
 *
 * Strength rules (rejected):
 *   - not exactly 6 digits
 *   - all-same digit (000000, 111111, …, 999999)
 *   - sequential ascending (012345, 123456, …, 456789)
 *   - sequential descending (987654, 876543, …, 543210)
 *   - DOB-shaped DDMMYY (first 2 in 01-31 AND next 2 in 01-12)
 *   - DOB-shaped MMDDYY (first 2 in 01-12 AND next 2 in 01-31)
 *   - DOB-shaped DDYYYY (first 2 in 01-31 AND last 4 in 1900-2099)
 *
 * Lockout: 3 failures → 15-min cooldown. Per-email, NOT per-IP — we want
 * lockout to follow the targeted account so an attacker spraying from many
 * IPs still hits the wall. IP rate limit lives at the route layer.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";

const BCRYPT_ROUNDS = 12;
const LOCKOUT_THRESHOLD = 3;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export class WeakPinError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "WeakPinError";
    this.reason = reason;
  }
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export async function verifyPin(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/** Throws WeakPinError if the PIN fails any strength rule. */
export function validatePinStrength(pin: string): void {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    throw new WeakPinError("not_6_digits", "PIN must be exactly 6 digits.");
  }

  // All-same digit
  if (/^(\d)\1{5}$/.test(pin)) {
    throw new WeakPinError("all_same", "PIN cannot be all the same digit.");
  }

  // Sequential ascending (012345, 123456, …, 456789)
  if (isSequentialAscending(pin)) {
    throw new WeakPinError("sequential_ascending", "PIN cannot be a sequential run (e.g. 123456).");
  }

  // Sequential descending (987654, …, 543210)
  if (isSequentialDescending(pin)) {
    throw new WeakPinError("sequential_descending", "PIN cannot be a sequential run (e.g. 654321).");
  }

  const d1d2 = parseInt(pin.slice(0, 2), 10);
  const d3d4 = parseInt(pin.slice(2, 4), 10);
  const d3d4d5d6 = parseInt(pin.slice(2, 6), 10);

  // DOB-shaped DDMMYY (first 2 in 01-31, next 2 in 01-12)
  if (d1d2 >= 1 && d1d2 <= 31 && d3d4 >= 1 && d3d4 <= 12) {
    throw new WeakPinError("dob_ddmmyy", "PIN looks like a date of birth — pick something less guessable.");
  }

  // DOB-shaped MMDDYY (first 2 in 01-12, next 2 in 01-31)
  if (d1d2 >= 1 && d1d2 <= 12 && d3d4 >= 1 && d3d4 <= 31) {
    throw new WeakPinError("dob_mmddyy", "PIN looks like a date of birth — pick something less guessable.");
  }

  // DOB-shaped DDYYYY (first 2 in 01-31, last 4 in 1900-2099)
  if (d1d2 >= 1 && d1d2 <= 31 && d3d4d5d6 >= 1900 && d3d4d5d6 <= 2099) {
    throw new WeakPinError("dob_ddyyyy", "PIN looks like a date of birth — pick something less guessable.");
  }
}

function isSequentialAscending(pin: string): boolean {
  for (let i = 1; i < pin.length; i++) {
    if (parseInt(pin[i], 10) !== (parseInt(pin[i - 1], 10) + 1) % 10) return false;
  }
  // Reject only true asc runs (012345 wraps but we still treat it as sequential)
  return true;
}

function isSequentialDescending(pin: string): boolean {
  for (let i = 1; i < pin.length; i++) {
    if (parseInt(pin[i], 10) !== (parseInt(pin[i - 1], 10) - 1 + 10) % 10) return false;
  }
  return true;
}

/** HMAC-SHA256(ip, SIGNED_URL_SECRET).slice(0,16). Stable per-IP fingerprint
 *  for forensics without storing raw IP. Same pattern as account-switch. */
export function hashIp(ip: string): string {
  const secret = process.env.SIGNED_URL_SECRET;
  if (!secret) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 16);
}

export interface LockoutState {
  locked: boolean;
  retryAfter?: Date;
  failedCount: number;
}

export async function checkLockout(email: string): Promise<LockoutState> {
  const r = await db.execute(sql`
    SELECT pin_failed_count, pin_locked_until
    FROM users
    WHERE LOWER(email) = LOWER(${email}) AND deleted_at IS NULL
    LIMIT 1
  `);
  const row = r.rows[0] as { pin_failed_count: number; pin_locked_until: string | null } | undefined;
  if (!row) return { locked: false, failedCount: 0 };
  const failedCount = row.pin_failed_count ?? 0;
  if (!row.pin_locked_until) return { locked: false, failedCount };
  const lockedUntil = new Date(row.pin_locked_until);
  if (lockedUntil <= new Date()) return { locked: false, failedCount };
  return { locked: true, retryAfter: lockedUntil, failedCount };
}

/** Atomic increment-and-maybe-lock. Increments pin_failed_count; if it
 *  reaches LOCKOUT_THRESHOLD, sets pin_locked_until = NOW() + cooldown.
 *  Returns the post-update lockout state. */
export async function registerFailure(email: string): Promise<LockoutState> {
  const lockedUntilExpr = `NOW() + INTERVAL '${LOCKOUT_DURATION_MS / 1000} seconds'`;
  const r = await db.execute(sql`
    UPDATE users
    SET pin_failed_count = pin_failed_count + 1,
        pin_locked_until = CASE
          WHEN pin_failed_count + 1 >= ${LOCKOUT_THRESHOLD}
          THEN ${sql.raw(lockedUntilExpr)}
          ELSE pin_locked_until
        END,
        updated_at = NOW()
    WHERE LOWER(email) = LOWER(${email}) AND deleted_at IS NULL
    RETURNING pin_failed_count, pin_locked_until
  `);
  const row = r.rows[0] as { pin_failed_count: number; pin_locked_until: string | null } | undefined;
  if (!row) return { locked: false, failedCount: 0 };
  const failedCount = row.pin_failed_count ?? 0;
  const lockedUntil = row.pin_locked_until ? new Date(row.pin_locked_until) : null;
  const locked = !!lockedUntil && lockedUntil > new Date();
  return { locked, retryAfter: locked ? lockedUntil! : undefined, failedCount };
}

export async function resetFailures(email: string): Promise<void> {
  await db.execute(sql`
    UPDATE users
    SET pin_failed_count = 0,
        pin_locked_until = NULL,
        updated_at = NOW()
    WHERE LOWER(email) = LOWER(${email}) AND deleted_at IS NULL
  `);
}

export type PinAttemptReason =
  | "ok"
  | "wrong_pin"
  | "no_user"
  | "no_pin_set"
  | "locked"
  | "lockout_triggered"
  | "weak_pin"
  | "pin_set"
  | "pin_reset"
  | "reset_link_sent"
  | "admin_blocked"
  // AG-3b: a Super Admin re-proving themselves before a destructive action. Recorded distinctly
  // rather than borrowed from "ok", because "logged in" and "authorised a station revocation"
  // are different events and an investigation needs to tell them apart.
  | "admin_step_up";

/** Single insert into pin_attempts plus a conditional audit_log row for
 *  security-relevant events (failures, lockouts, resets). Successful
 *  logins are NOT audited per brief. */
export async function logPinEvent(
  email: string,
  success: boolean,
  reason: PinAttemptReason,
  ipHash: string
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO pin_attempts (email, success, reason, ip_hash, attempted_at)
      VALUES (${email.toLowerCase()}, ${success}, ${reason}, ${ipHash}, NOW())
    `);
  } catch (e: any) {
    console.warn("[pin] pin_attempts insert failed:", e?.message ?? e);
  }
  // Audit security-relevant events only
  const auditWorthy: PinAttemptReason[] = [
    "wrong_pin",
    "lockout_triggered",
    "locked",
    "pin_reset",
    "reset_link_sent",
    "weak_pin",
    "admin_blocked",
  ];
  if (!auditWorthy.includes(reason)) return;
  try {
    const masked = maskEmail(email);
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
      VALUES ('auth', ${masked}, ${`pin_${reason}`}, 'system',
              ${JSON.stringify({ email_masked: masked, ip_hash: ipHash, success })}::jsonb,
              NOW())
    `);
  } catch (e: any) {
    console.warn("[pin] audit_log insert failed:", e?.message ?? e);
  }
}

function maskEmail(email: string): string {
  const idx = email.indexOf("@");
  if (idx < 1) return "[invalid]";
  return email.slice(0, 2) + "***@" + email.slice(idx + 1);
}

export const PIN_LOCKOUT_THRESHOLD = LOCKOUT_THRESHOLD;
export const PIN_LOCKOUT_DURATION_MS = LOCKOUT_DURATION_MS;
