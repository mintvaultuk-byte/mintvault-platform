/**
 * server/account-auth.ts
 *
 * Unified email + password account authentication for MintVault.
 * Handles: password hashing, token management, DB queries, schema migration.
 *
 * Uses bcrypt cost 12 for password hashing.
 * All tokens are 32-byte random hex strings stored in the DB.
 * Schema migration is idempotent — safe to run on every startup.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";

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

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  await db.execute(sql`
    INSERT INTO email_verification_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);
  return token;
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
  await db.execute(sql`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);
  return token;
}

export async function createAccountMagicLinkToken(userId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1_000);
  await db.execute(sql`
    INSERT INTO account_magic_link_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);
  return token;
}

// ── User queries ──────────────────────────────────────────────────────────────

export async function findUserByEmail(email: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(sql`
    SELECT id, email, password_hash, display_name, email_verified,
           email_verified_at, failed_login_count, locked_until, deleted_at,
           last_login_at, last_login_ip, role, created_at
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
           last_login_at, last_login_ip, role, created_at
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

export async function logLoginAttempt(
  email: string,
  ip: string,
  success: boolean,
  userAgent?: string,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO login_attempts (email, ip, success, user_agent, created_at)
      VALUES (${email.toLowerCase()}, ${ip}, ${success}, ${userAgent ?? null}, NOW())
    `);
  } catch { /* non-critical */ }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function writeAuthAudit(
  action: string,
  userId: string,
  ip: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, details)
      VALUES ('auth', ${userId}, ${action}, ${JSON.stringify({ ip, ...extra })}::jsonb)
    `);
  } catch { /* non-critical */ }
}

// ── Schema migration (idempotent) ────────────────────────────────────────────

export async function migrateAccountSchema(): Promise<void> {
  // Add new columns to users table
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS display_name TEXT,
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_login_ip TEXT,
      ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP
  `);

  // Case-insensitive unique index on email
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))
  `);

  // Showroom columns
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS showroom_active BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS showroom_bio TEXT,
      ADD COLUMN IF NOT EXISTS showroom_claimed_at TIMESTAMP
  `);

  // Case-insensitive unique index on username
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))
  `);

  // Vault Club subscription columns
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS vault_club_tier TEXT,
      ADD COLUMN IF NOT EXISTS vault_club_status TEXT,
      ADD COLUMN IF NOT EXISTS vault_club_started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS vault_club_renews_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS vault_club_cancels_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS vault_club_billing_interval TEXT,
      ADD COLUMN IF NOT EXISTS vault_club_grace_until TIMESTAMP,
      ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
      ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS ai_credits_user_balance INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ai_credits_last_refilled_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS member_credits_last_granted_at TIMESTAMPTZ
  `);

  // Backfill member_credits_last_granted_at for users who already have reholder credits
  try {
    await db.execute(sql`
      UPDATE users SET member_credits_last_granted_at = NOW() - INTERVAL '92 days'
      WHERE member_credits_last_granted_at IS NULL
        AND id IN (SELECT DISTINCT user_id FROM reholder_credits)
    `);
  } catch (e: any) {
    console.log("[auth-schema] member_credits_last_granted_at backfill skipped:", e.message);
  }

  // Vault Club events audit table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vault_club_events (
      id               SERIAL PRIMARY KEY,
      user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
      stripe_event_id  TEXT UNIQUE NOT NULL,
      event_type       TEXT NOT NULL,
      tier             TEXT,
      status           TEXT,
      amount_pence     INTEGER,
      raw_payload      JSONB,
      created_at       TIMESTAMP DEFAULT NOW()
    )
  `);

  // Reholder credits table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reholder_credits (
      id                    SERIAL PRIMARY KEY,
      user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_at            TIMESTAMP DEFAULT NOW(),
      expires_at            TIMESTAMP,
      used_at               TIMESTAMP,
      used_for_submission_id INTEGER,
      source                TEXT NOT NULL
    )
  `);

  // Add user_id column to estimate_credits for logged-in users
  // (additive migration — anonymous email-based flow unchanged)
  await db.execute(sql`
    ALTER TABLE estimate_credits ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS estimate_credits_user_id_idx ON estimate_credits (user_id)
  `);

  // Password reset tokens
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token       TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Email verification tokens
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token       TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Magic link tokens for account logins
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS account_magic_link_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token       TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Login attempts (rate limiting + audit)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      ip         TEXT NOT NULL,
      success    BOOLEAN NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS login_attempts_email_created_idx
      ON login_attempts (email, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS login_attempts_ip_created_idx
      ON login_attempts (ip, created_at DESC)
  `);

  // ── Submission Tracking Dashboard columns ──────────────────────────────────
  await db.execute(sql`
    ALTER TABLE submissions
      ADD COLUMN IF NOT EXISTS royal_mail_outbound_tracking TEXT,
      ADD COLUMN IF NOT EXISTS royal_mail_return_status TEXT,
      ADD COLUMN IF NOT EXISTS royal_mail_return_status_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS estimated_completion_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS grading_started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS encapsulating_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS on_receipt_photo_urls TEXT,
      ADD COLUMN IF NOT EXISTS status_history JSONB DEFAULT '[]'::jsonb
  `);
}
