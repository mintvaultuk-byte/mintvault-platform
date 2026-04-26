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

  // Backfill member_credits_last_granted_at for users who already have member credits
  try {
    await db.execute(sql`
      UPDATE users SET member_credits_last_granted_at = NOW() - INTERVAL '92 days'
      WHERE member_credits_last_granted_at IS NULL
        AND id IN (SELECT DISTINCT user_id FROM member_credits)
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

  // ── v230 rename: reholder_credits → member_credits ────────────────────────
  // RENAME runs first — before CREATE TABLE — so CREATE doesn't block the rename
  try {
    await db.execute(sql`ALTER TABLE IF EXISTS reholder_credits RENAME TO member_credits`);
    console.log("[v230-migrate] renamed reholder_credits → member_credits");
  } catch (e: any) {
    if (e.code !== "42P07" && e.code !== "42P01") console.error("[v230-migrate] rename failed:", e.message);
  }

  // Create table for fresh installs (no-op if rename already created it)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_credits (
      id                    SERIAL PRIMARY KEY,
      user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_at            TIMESTAMP DEFAULT NOW(),
      expires_at            TIMESTAMP,
      used_at               TIMESTAMP,
      used_for_submission_id INTEGER,
      source                TEXT NOT NULL
    )
  `);

  // Compat view so any lingering references to old name still resolve
  try {
    await db.execute(sql`DROP VIEW IF EXISTS reholder_credits`);
    await db.execute(sql`CREATE OR REPLACE VIEW reholder_credits AS SELECT * FROM member_credits`);
    console.log("[v230-migrate] compat view reholder_credits → member_credits created");
  } catch (e: any) {
    // If reholder_credits still exists as a base table (shouldn't after rename), skip
    console.log("[v230-migrate] compat view skipped:", e.message);
  }
  try {
    await db.execute(sql`ALTER TABLE member_credits ALTER COLUMN credit_type SET DEFAULT 'member'`);
    await db.execute(sql`UPDATE member_credits SET credit_type = 'member' WHERE credit_type = 'reholder'`);
  } catch (e: any) {
    // credit_type column may not exist yet on fresh installs — Phase 6 migration adds it
  }
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
      VALUES ('schema', 'member_credits', 'table_renamed',
              '{"from": "reholder_credits", "to": "member_credits", "compat_view_active": true, "compat_view_drop_after": "2026-04-23"}'::jsonb,
              NOW())
      ON CONFLICT DO NOTHING
    `);
  } catch (e: any) {
    // Non-critical
  }

  // ── v231: Deactivate Black Label Review tier (becomes auto-upgrade) ────────
  try {
    const r = await db.execute(sql`
      UPDATE service_tiers
      SET is_active = false, updated_at = NOW()
      WHERE tier_id = 'gold' AND name = 'BLACK LABEL REVIEW' AND is_active = true
      RETURNING id
    `);
    if (r.rows.length > 0) {
      console.log("[v231-migrate] Black Label tier deactivated (becomes auto-upgrade)");
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
        VALUES ('service_tier', 'gold', 'deactivated',
                '{"reason": "Black Label becomes free automatic upgrade, not paid tier", "effective_from": "2026-04-16"}'::jsonb,
                NOW())
        ON CONFLICT DO NOTHING
      `);
    }
  } catch (e: any) {
    console.log("[v231-migrate] Black Label deactivation skipped:", e.message);
  }

  // ── v232: Add source column to certificates for scan-ingest tracking ────────
  try {
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'customer_submission'`);
    console.log("[v232-migrate] certificates.source column ensured");
  } catch (e: any) {
    console.log("[v232-migrate] source column skipped:", e.message);
  }

  // ── v233: Backfill model_version on grading_sessions ───────────────────────
  try {
    // Backfill all existing rows (graded before Opus 4.7 switch) with the prior model
    await db.execute(sql`
      UPDATE grading_sessions SET model_version = 'claude-sonnet-4-6'
      WHERE model_version IS NULL
    `);
    console.log("[v233-migrate] grading_sessions.model_version backfilled");
  } catch (e: any) {
    console.log("[v233-migrate] model_version backfill skipped:", e.message);
  }

  // ── v234 (Phase Y): crop_geometry column for scanner/admin pipeline convergence ───
  // Stores reCentreBitmap pre-padding + post-asymmetry forensics per side.
  // Nullable — does not affect existing rows; new uploads populate via scan-ingest
  // and admin CaptureWizard pipelines.
  try {
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS crop_geometry JSONB`);
    console.log("[v234-migrate] certificates.crop_geometry column ensured");
  } catch (e: any) {
    console.log("[v234-migrate] crop_geometry column skipped:", e.message);
  }

  // ── v235 (Option B): ai_defect_candidates column for Haiku defect pass ────
  // Populated by scan-ingest's suggestDefectsFromBuffer call. Admin confirms
  // or rejects each candidate; confirmed ones move into the persisted
  // `defects` array. Nullable; pre-Option-B certs leave it null.
  try {
    await db.execute(sql`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS ai_defect_candidates JSONB`);
    console.log("[v235-migrate] certificates.ai_defect_candidates column ensured");
  } catch (e: any) {
    console.log("[v235-migrate] ai_defect_candidates column skipped:", e.message);
  }

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

  // Magic link tokens for customer dashboard logins
  // Email-identified (no users row required). Replaces in-memory Map that
  // failed on multi-machine prod — see audit_log entry below.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customer_magic_link_tokens (
      id          SERIAL PRIMARY KEY,
      email       TEXT NOT NULL,
      token       TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS customer_magic_link_tokens_email_created_idx
      ON customer_magic_link_tokens (email, created_at DESC)
  `);
  try {
    const existing = await db.execute(sql`
      SELECT 1 FROM audit_log
      WHERE entity_type = 'schema'
        AND entity_id = 'customer_magic_link_tokens'
        AND action = 'table_created'
      LIMIT 1
    `);
    if (existing.rows.length === 0) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
        VALUES ('schema', 'customer_magic_link_tokens', 'table_created',
                '{"reason":"fix magic-link failure on multi-machine prod","migration":"in-memory Map -> Postgres","ttl_minutes":15,"fixes":"~50% login failure rate when POST and GET landed on different Fly machines"}'::jsonb,
                NOW())
      `);
      console.log("[customer-magic-link-migrate] table created + audit logged");
    }
  } catch (e: any) {
    console.log("[customer-magic-link-migrate] audit_log skipped:", e.message);
  }

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
