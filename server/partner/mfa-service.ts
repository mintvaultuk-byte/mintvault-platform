/**
 * Partner Portal — MFA enrolment lifecycle (Phase 1, Item 3).
 *
 * enrol → confirm → (recovery codes) → regenerate / disable. Every state-changing operation requires
 * ELEVATED verification (recent password re-confirmation). Secrets are encrypted at rest via the
 * fail-closed abstraction; a PENDING method does not satisfy MFA until confirmed. Recovery codes are
 * shown once, stored only as hashes, single-use. Secrets and codes never appear in responses beyond
 * the one-time enrolment/regeneration payload, and never in logs or audit.
 */
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { withTenant } from "./db";
import { writePartnerAudit, writePartnerSecurity } from "./audit";
import {
  generateTotpSecret, currentTotp, verifyTotp, matchTotpCounter, encryptSecret, decryptSecret, mfaEncryptionConfigured,
  generateRecoveryCodes, recoveryHash,
} from "./mfa";

/**
 * Verify a TOTP against the user's ACTIVE method with REPLAY PROTECTION (F3): a code whose counter is
 * ≤ the last-accepted counter is rejected, and the accepted counter is advanced atomically. Must be
 * called inside a tenant transaction (`c`).
 */
export async function verifyActiveTotpNoReplay(c: PoolClient, userId: string, code: string): Promise<boolean> {
  const m = await c.query<{ id: string; secret_ref: string; last_totp_counter: string | null }>(
    "SELECT id, secret_ref, last_totp_counter FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='ACTIVE' AND secret_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [userId],
  );
  if (m.rowCount !== 1) return false;
  const counter = matchTotpCounter(decryptSecret(m.rows[0].secret_ref), code, Date.now());
  if (counter === null) return false;
  const last = m.rows[0].last_totp_counter == null ? null : Number(m.rows[0].last_totp_counter);
  if (last !== null && counter <= last) return false; // replay within window
  await c.query("UPDATE partner_mfa_methods SET last_totp_counter=$2 WHERE id=$1", [m.rows[0].id, counter]);
  return true;
}

/** Re-verify the user's password inside the tenant (elevated verification). */
async function verifyPassword(c: PoolClient, userId: string, password: string): Promise<boolean> {
  const { rows } = await c.query<{ password_hash: string | null }>("SELECT password_hash FROM partner_users WHERE id=$1", [userId]);
  if (rows.length !== 1 || !rows[0].password_hash) return false;
  return bcrypt.compare(password, rows[0].password_hash);
}

export type EnrolResult =
  | { ok: true; secret: string; otpauthUri: string }
  | { ok: false; reason: "unauthorised" | "encryption_unavailable" | "requires_current_factor" };

async function hasActiveMethod(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query("SELECT 1 FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='ACTIVE' LIMIT 1", [userId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Start enrolment: elevated verify, generate + encrypt a PENDING TOTP secret, return provisioning once.
 * F1: if the user ALREADY has an active factor, REPLACING it requires having passed the current factor
 * (sessionMfaPassed) — a password-only (mfa-pending) session cannot silently swap out the victim's MFA.
 * Bootstrap (no active method) stays reachable from a pending session.
 */
export async function mfaEnrolStart(
  ctx: { tenantId: string; userId: string; email?: string; sessionMfaPassed?: boolean },
  password: string,
): Promise<EnrolResult> {
  if (!mfaEncryptionConfigured()) return { ok: false, reason: "encryption_unavailable" };
  const secret = generateTotpSecret();
  const result = await withTenant({ tenantId: ctx.tenantId }, async (c): Promise<EnrolResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    if (!ctx.sessionMfaPassed && (await hasActiveMethod(c, ctx.userId))) return { ok: false, reason: "requires_current_factor" };
    const email = ctx.email ?? (await c.query<{ email: string }>("SELECT email FROM partner_users WHERE id=$1", [ctx.userId])).rows[0]?.email ?? "user";
    // one pending TOTP at a time
    await c.query("DELETE FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='PENDING'", [ctx.userId]);
    await c.query(
      "INSERT INTO partner_mfa_methods (tenant_id, user_id, method, secret_ref, status) VALUES ($1,$2,'totp',$3,'PENDING')",
      [ctx.tenantId, ctx.userId, encryptSecret(secret)],
    );
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_enrol_start" });
    const otpauthUri = `otpauth://totp/MintVault:${encodeURIComponent(email)}?secret=${secret}&issuer=MintVault`;
    return { ok: true, secret, otpauthUri };
  });
  return result;
}

export type ConfirmResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: "invalid_code" | "no_pending" | "requires_current_factor" };

/** Confirm enrolment with a valid TOTP → activate, issue one-time recovery codes, mark session mfa_passed. */
export async function mfaEnrolConfirm(
  ctx: { tenantId: string; userId: string; sessionId?: string; sessionMfaPassed?: boolean },
  code: string,
): Promise<ConfirmResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<ConfirmResult> => {
    // F1 defence-in-depth: cannot REPLACE an existing active factor from a non-mfa-passed session.
    if (!ctx.sessionMfaPassed && (await hasActiveMethod(c, ctx.userId))) return { ok: false, reason: "requires_current_factor" };
    const pend = await c.query<{ id: string; secret_ref: string }>(
      "SELECT id, secret_ref FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='PENDING' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [ctx.userId],
    );
    if (pend.rowCount !== 1) return { ok: false, reason: "no_pending" };
    if (!verifyTotp(decryptSecret(pend.rows[0].secret_ref), code, Date.now())) return { ok: false, reason: "invalid_code" };
    // activate this method, deactivate any previously-active (partial unique enforces one ACTIVE)
    await c.query("UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND method='totp' AND status='ACTIVE'", [ctx.userId]);
    await c.query("UPDATE partner_mfa_methods SET status='ACTIVE' WHERE id=$1", [pend.rows[0].id]);
    await c.query("UPDATE partner_users SET mfa_enabled=true, mfa_required=true WHERE id=$1", [ctx.userId]);
    // fresh recovery codes (replace any prior)
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    const { plaintext, hashes } = generateRecoveryCodes(10);
    for (const h of hashes) {
      await c.query("INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,$3)", [ctx.tenantId, ctx.userId, h]);
    }
    if (ctx.sessionId) await c.query("UPDATE partner_sessions SET mfa_passed=true WHERE id=$1", [ctx.sessionId]);
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_enrolled" });
    await writePartnerSecurity(c, { tenantId: ctx.tenantId, severity: "info", kind: "partner_mfa_enabled" });
    return { ok: true, recoveryCodes: plaintext };
  });
}

export type RegenResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: "unauthorised" };

/** Regenerate recovery codes (elevated verify) — invalidates all previous unused codes. */
export async function mfaRegenerateRecovery(ctx: { tenantId: string; userId: string }, password: string): Promise<RegenResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<RegenResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    const { plaintext, hashes } = generateRecoveryCodes(10);
    for (const h of hashes) {
      await c.query("INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,$3)", [ctx.tenantId, ctx.userId, h]);
    }
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_recovery_regenerated" });
    return { ok: true, recoveryCodes: plaintext };
  });
}

export type DisableResult = { ok: true } | { ok: false; reason: "unauthorised" | "second_factor_required" };

/** Disable MFA: requires password + a valid current TOTP or recovery code, then revokes all sessions. */
export async function mfaDisable(
  ctx: { tenantId: string; userId: string },
  password: string,
  secondFactor: { code?: string; recoveryCode?: string },
): Promise<DisableResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<DisableResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    // require an existing MFA second factor
    let secondOk = false;
    if (secondFactor.recoveryCode) {
      const rc = await c.query("UPDATE partner_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id", [ctx.userId, recoveryHash(secondFactor.recoveryCode)]);
      secondOk = (rc.rowCount ?? 0) === 1;
    } else if (secondFactor.code) {
      secondOk = await verifyActiveTotpNoReplay(c, ctx.userId, secondFactor.code); // F3: replay-protected
    }
    if (!secondOk) return { ok: false, reason: "second_factor_required" };
    await c.query("UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND method='totp'", [ctx.userId]);
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    await c.query("UPDATE partner_users SET mfa_enabled=false, mfa_required=false, credential_version=credential_version+1 WHERE id=$1", [ctx.userId]);
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [ctx.userId]);
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_disabled" });
    await writePartnerSecurity(c, { tenantId: ctx.tenantId, severity: "medium", kind: "partner_mfa_disabled" });
    return { ok: true };
  });
}

/** Test/helper: compute the current TOTP for a stored ACTIVE/PENDING method (used only in tests via decryptSecret). */
export { currentTotp };
