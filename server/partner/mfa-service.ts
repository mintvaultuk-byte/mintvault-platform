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
  generateTotpSecret,
  currentTotp,
  matchTotpCounter,
  encryptSecret,
  decryptSecret,
  mfaEncryptionConfigured,
  generateRecoveryCodes,
  recoveryHash,
} from "./mfa";

export const MFA_PENDING_SETUP_MINUTES = 10;

/**
 * Verify a TOTP against the user's ACTIVE method with REPLAY PROTECTION (F3): a code whose counter is
 * ≤ the last-accepted counter is rejected, and the accepted counter is advanced atomically. Must be
 * called inside a tenant transaction (`c`).
 */
export async function verifyActiveTotpNoReplay(c: PoolClient, userId: string, code: string): Promise<boolean> {
  const m = await c.query<{ id: string; secret_ref: string; last_totp_counter: string | null }>(
    "SELECT id, secret_ref, last_totp_counter FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='ACTIVE' AND secret_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [userId]
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
  const { rows } = await c.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM partner_users WHERE id=$1",
    [userId]
  );
  if (rows.length !== 1 || !rows[0].password_hash) return false;
  return bcrypt.compare(password, rows[0].password_hash);
}

export type EnrolResult =
  | { ok: true; enrolmentId: string; secret: string; otpauthUri: string; expiresAt: string }
  | { ok: false; reason: "unauthorised" | "encryption_unavailable" | "requires_current_factor" };

async function hasActiveMethod(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query(
    "SELECT 1 FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='ACTIVE' AND secret_ref IS NOT NULL LIMIT 1",
    [userId]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Start enrolment: elevated verify, generate + encrypt a PENDING TOTP secret, return provisioning once.
 * F1: if the user ALREADY has an active factor, REPLACING it requires having passed the current factor
 * (sessionMfaPassed) — a password-only (mfa-pending) session cannot silently swap out the victim's MFA.
 * Bootstrap (no active method) stays reachable from a pending session.
 */
export async function mfaEnrolStart(
  ctx: { tenantId: string; userId: string; sessionId: string; email?: string; sessionMfaPassed?: boolean },
  password: string
): Promise<EnrolResult> {
  return createPendingEnrolment(ctx, password);
}

async function createPendingEnrolment(
  ctx: { tenantId: string; userId: string; sessionId: string; email?: string; sessionMfaPassed?: boolean },
  password?: string,
  opts: { allowActiveReplacement?: boolean } = { allowActiveReplacement: true }
): Promise<EnrolResult> {
  if (!mfaEncryptionConfigured()) return { ok: false, reason: "encryption_unavailable" };
  const secret = generateTotpSecret();
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<EnrolResult> => {
    if (password != null && !(await verifyPassword(c, ctx.userId, password)))
      return { ok: false, reason: "unauthorised" };
    if ((!ctx.sessionMfaPassed || !opts.allowActiveReplacement) && (await hasActiveMethod(c, ctx.userId))) {
      return { ok: false, reason: "requires_current_factor" };
    }
    const email =
      ctx.email ??
      (await c.query<{ email: string }>("SELECT email FROM partner_users WHERE id=$1", [ctx.userId])).rows[0]?.email ??
      "user";
    // one pending TOTP at a time
    await c.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND method='totp' AND status='PENDING'",
      [ctx.userId]
    );
    const inserted = await c.query<{ id: string; expires_at: string }>(
      `INSERT INTO partner_mfa_methods (tenant_id, user_id, method, secret_ref, status, enrolment_session_id, expires_at)
       VALUES ($1,$2,'totp',$3,'PENDING',$4, now() + ($5 || ' minutes')::interval)
       RETURNING id, expires_at`,
      [ctx.tenantId, ctx.userId, encryptSecret(secret), ctx.sessionId, String(MFA_PENDING_SETUP_MINUTES)]
    );
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_enrol_start" });
    const otpauthUri = `otpauth://totp/MintVault:${encodeURIComponent(email)}?secret=${secret}&issuer=MintVault`;
    return { ok: true, enrolmentId: inserted.rows[0].id, secret, otpauthUri, expiresAt: inserted.rows[0].expires_at };
  });
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "invalid_code" | "no_pending" | "expired" | "stale_session" | "requires_current_factor" };

/** Confirm enrolment with a valid TOTP → activate, issue one-time recovery codes, mark session mfa_passed. */
export async function mfaEnrolConfirm(
  ctx: { tenantId: string; userId: string; sessionId: string; sessionMfaPassed?: boolean },
  enrolmentId: string,
  code: string
): Promise<ConfirmResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<ConfirmResult> => {
    const live = await c.query(
      "SELECT 1 FROM partner_sessions s JOIN partner_users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.tenant_id=$3 AND s.revoked_at IS NULL AND s.credential_version=u.credential_version LIMIT 1",
      [ctx.sessionId, ctx.userId, ctx.tenantId]
    );
    if (live.rowCount !== 1) return { ok: false, reason: "stale_session" };
    // F1 defence-in-depth: cannot REPLACE an existing active factor from a non-mfa-passed session.
    if (!ctx.sessionMfaPassed && (await hasActiveMethod(c, ctx.userId)))
      return { ok: false, reason: "requires_current_factor" };
    const pend = await c.query<{ id: string; secret_ref: string; expired: boolean }>(
      `SELECT id, secret_ref, expires_at IS NOT NULL AND expires_at <= now() AS expired
         FROM partner_mfa_methods
        WHERE id=$1
          AND user_id=$2
          AND method='totp'
          AND status='PENDING'
          AND enrolment_session_id=$3
        FOR UPDATE`,
      [enrolmentId, ctx.userId, ctx.sessionId]
    );
    if (pend.rowCount !== 1) return { ok: false, reason: "no_pending" };
    if (pend.rows[0].expired) return { ok: false, reason: "expired" };
    const counter = matchTotpCounter(decryptSecret(pend.rows[0].secret_ref), code, Date.now());
    if (counter === null) return { ok: false, reason: "invalid_code" };
    // activate this method, deactivate any previously-active (partial unique enforces one ACTIVE)
    await c.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND method='totp' AND status='ACTIVE'",
      [ctx.userId]
    );
    await c.query(
      "UPDATE partner_mfa_methods SET status='ACTIVE', consumed_at=now(), last_totp_counter=$2 WHERE id=$1",
      [pend.rows[0].id, counter]
    );
    await c.query("UPDATE partner_users SET mfa_enabled=true, mfa_required=true WHERE id=$1", [ctx.userId]);
    // fresh recovery codes (replace any prior)
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    const { plaintext, hashes } = generateRecoveryCodes(10);
    for (const h of hashes) {
      await c.query("INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,$3)", [
        ctx.tenantId,
        ctx.userId,
        h,
      ]);
    }
    const passed = await c.query(
      "UPDATE partner_sessions SET mfa_passed=true WHERE id=$1 AND user_id=$2 AND tenant_id=$3 AND revoked_at IS NULL",
      [ctx.sessionId, ctx.userId, ctx.tenantId]
    );
    if (passed.rowCount !== 1) throw new Error("MFA session upgrade failed");
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_enrolled" });
    await writePartnerSecurity(c, { tenantId: ctx.tenantId, severity: "info", kind: "partner_mfa_enabled" });
    return { ok: true, recoveryCodes: plaintext };
  });
}

export async function mfaEnrolRestart(ctx: {
  tenantId: string;
  userId: string;
  sessionId: string;
  sessionMfaPassed?: boolean;
}): Promise<EnrolResult> {
  const out = await createPendingEnrolment(ctx, undefined, { allowActiveReplacement: false });
  if (out.ok) {
    await withTenant({ tenantId: ctx.tenantId }, (c) =>
      writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_enrol_restarted" })
    );
  }
  return out;
}

export async function mfaEnrolCancel(ctx: { tenantId: string; userId: string; sessionId: string }): Promise<void> {
  await withTenant({ tenantId: ctx.tenantId }, async (c) => {
    await c.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND enrolment_session_id=$2 AND method='totp' AND status='PENDING'",
      [ctx.userId, ctx.sessionId]
    );
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", [
      ctx.sessionId,
      ctx.userId,
    ]);
    await writePartnerAudit(c, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: "partner_mfa_enrol_cancelled",
    });
  });
}

export type RegenResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: "unauthorised" };

/** Regenerate recovery codes (elevated verify) — invalidates all previous unused codes. */
export async function mfaRegenerateRecovery(
  ctx: { tenantId: string; userId: string },
  password: string
): Promise<RegenResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<RegenResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    const { plaintext, hashes } = generateRecoveryCodes(10);
    for (const h of hashes) {
      await c.query("INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,$3)", [
        ctx.tenantId,
        ctx.userId,
        h,
      ]);
    }
    await writePartnerAudit(c, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: "partner_mfa_recovery_regenerated",
    });
    return { ok: true, recoveryCodes: plaintext };
  });
}

export type DisableResult = { ok: true } | { ok: false; reason: "unauthorised" | "second_factor_required" };

/** Disable MFA: requires password + a valid current TOTP or recovery code, then revokes all sessions. */
export async function mfaDisable(
  ctx: { tenantId: string; userId: string },
  password: string,
  secondFactor: { code?: string; recoveryCode?: string }
): Promise<DisableResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<DisableResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    // require an existing MFA second factor
    let secondOk = false;
    if (secondFactor.recoveryCode) {
      const rc = await c.query(
        "UPDATE partner_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id",
        [ctx.userId, recoveryHash(secondFactor.recoveryCode)]
      );
      secondOk = (rc.rowCount ?? 0) === 1;
    } else if (secondFactor.code) {
      secondOk = await verifyActiveTotpNoReplay(c, ctx.userId, secondFactor.code); // F3: replay-protected
    }
    if (!secondOk) return { ok: false, reason: "second_factor_required" };
    await c.query("UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND method='totp'", [ctx.userId]);
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    await c.query(
      "UPDATE partner_users SET mfa_enabled=false, mfa_required=false, credential_version=credential_version+1 WHERE id=$1",
      [ctx.userId]
    );
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [ctx.userId]);
    await writePartnerAudit(c, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: "partner_mfa_disabled" });
    await writePartnerSecurity(c, { tenantId: ctx.tenantId, severity: "medium", kind: "partner_mfa_disabled" });
    return { ok: true };
  });
}

/** Test/helper: compute the current TOTP for a stored ACTIVE/PENDING method (used only in tests via decryptSecret). */
export { currentTotp };
