/**
 * server/account-auth.ts
 *
 * Unified email + password account authentication for MintVault.
 * Handles: password hashing, token management, and DB queries.
 *
 * Uses bcrypt cost 12 for password hashing.
 * All tokens are 32-byte random hex strings stored in the DB.
 * Schema is owned exclusively by the numbered migration runner.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { enqueueCustomerNotification } from "./customer-notification-outbox";

const BCRYPT_ROUNDS = 12;

// ── Password helpers ──────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 10) return { valid: false, message: "Password must be at least 10 characters" };
  if (!/[a-zA-Z]/.test(password)) return { valid: false, message: "Password must contain at least one letter" };
  if (!/[0-9]/.test(password)) return { valid: false, message: "Password must contain at least one number" };
  return { valid: true };
}

// ── Token helpers ─────────────────────────────────────────────────────────────

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createEmailVerificationToken(
  userId: string,
  transaction?: Pick<typeof db, "execute">
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const create = async (tx: Pick<typeof db, "execute">) => {
    const owner = await tx.execute(sql`
      SELECT email, display_name FROM public.users WHERE id=${userId} AND deleted_at IS NULL FOR KEY SHARE
    `);
    const row = owner.rows[0] as { email: string; display_name: string | null } | undefined;
    if (!row) throw new Error("email verification owner unavailable");
    await tx.execute(sql`
      INSERT INTO public.email_verification_tokens (user_id, token, expires_at)
      VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
    `);
    await enqueueCustomerNotification(tx, {
      eventKey: `account-verify:${userId}:${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`,
      kind: "ACCOUNT_VERIFY",
      aggregateType: "user",
      aggregateId: userId,
      recipient: row.email,
      payload: { token, displayName: row.display_name },
      expiresAt,
    });
  };
  if (transaction) await create(transaction);
  else await db.transaction(create);
  return token;
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`
      SELECT email FROM public.users WHERE id=${userId} AND deleted_at IS NULL FOR KEY SHARE
    `);
    const row = owner.rows[0] as { email: string } | undefined;
    if (!row) throw new Error("password reset owner unavailable");
    await tx.execute(sql`
      INSERT INTO public.password_reset_tokens (user_id, token, expires_at)
      VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
    `);
    await enqueueCustomerNotification(tx, {
      eventKey: `password-reset:${userId}:${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`,
      kind: "PASSWORD_RESET",
      aggregateType: "user",
      aggregateId: userId,
      recipient: row.email,
      payload: { token },
      expiresAt,
    });
  });
  return token;
}

export async function createAccountMagicLinkToken(userId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1_000);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`
      SELECT email FROM public.users WHERE id=${userId} AND deleted_at IS NULL FOR KEY SHARE
    `);
    const row = owner.rows[0] as { email: string } | undefined;
    if (!row) throw new Error("account magic-link owner unavailable");
    await tx.execute(sql`
      INSERT INTO public.account_magic_link_tokens (user_id, token, expires_at)
      VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
    `);
    await enqueueCustomerNotification(tx, {
      eventKey: `account-magic:${userId}:${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`,
      kind: "ACCOUNT_MAGIC_LINK",
      aggregateType: "user",
      aggregateId: userId,
      recipient: row.email,
      payload: { token },
      expiresAt,
    });
  });
  return token;
}

// ── User queries ──────────────────────────────────────────────────────────────

export async function findUserByEmail(email: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(sql`
    SELECT id, email, password_hash, display_name, email_verified,
           email_verified_at, failed_login_count, locked_until, deleted_at,
           last_login_at, last_login_ip, role, created_at, public_name,
           last_failed_login_at, credential_version, admin_passphrase_hash
    FROM users
    WHERE LOWER(email) = LOWER(${email.trim()})
    LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) || null;
}

export async function findUserById(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(sql`
    SELECT id, email, password_hash, display_name, email_verified,
           email_verified_at, failed_login_count, locked_until, deleted_at,
           last_login_at, last_login_ip, role, created_at, public_name,
           last_failed_login_at, credential_version, admin_passphrase_hash
    FROM users
    WHERE id = ${id}
    LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) || null;
}

// ── Rate limiting via DB ──────────────────────────────────────────────────────

export async function countRecentFailedAttempts(email: string, windowMinutes: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM login_attempts
    WHERE LOWER(email) = LOWER(${email})
      AND success = false
      AND created_at > NOW() - INTERVAL '1 hour' * ${windowMinutes / 60.0}
  `);
  return parseInt((rows.rows[0] as any)?.cnt ?? "0", 10);
}

export async function logLoginAttempt(email: string, ip: string, success: boolean, userAgent?: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO login_attempts (email, ip, success, user_agent, created_at)
      VALUES (${email.toLowerCase()}, ${ip}, ${success}, ${userAgent ?? null}, NOW())
    `);
  } catch {
    /* non-critical */
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function writeAuthAudit(
  action: string,
  userId: string,
  ip: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, details)
      VALUES ('auth', ${userId}, ${action}, ${JSON.stringify({ ip, ...extra })}::jsonb)
    `);
  } catch {
    /* non-critical */
  }
}
