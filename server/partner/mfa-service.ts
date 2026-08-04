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
  | {
      ok: false;
      reason: "unauthorised" | "encryption_unavailable" | "requires_current_factor" | "second_factor_required";
    };

/** A current second factor as supplied by the caller. Exactly one form is used; recovery wins. */
export interface SecondFactorInput {
  code?: string;
  recoveryCode?: string;
}

async function hasActiveMethod(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query(
    "SELECT 1 FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='ACTIVE' AND secret_ref IS NOT NULL LIMIT 1",
    [userId]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Verify — and CONSUME — one current second factor against the user's ACTIVE method.
 *
 * Extracted verbatim from `mfaDisable` so the enrolment-REPLACEMENT path (F3) demands exactly the
 * same proof as disabling, rather than a weaker one. Recovery codes are single-use (the UPDATE is
 * the consumption) and TOTP is replay-protected. Must be called inside a tenant transaction.
 */
async function verifySecondFactor(c: PoolClient, userId: string, secondFactor: SecondFactorInput): Promise<boolean> {
  if (secondFactor.recoveryCode) {
    const rc = await c.query(
      "UPDATE partner_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id",
      [userId, recoveryHash(secondFactor.recoveryCode)]
    );
    return (rc.rowCount ?? 0) === 1;
  }
  if (secondFactor.code) return verifyActiveTotpNoReplay(c, userId, secondFactor.code); // F3: replay-protected
  return false;
}

/**
 * P0-E: the MFA state the Portal is allowed to show the signed-in user about THEMSELVES.
 *
 * Booleans only — no secret_ref is selected, nothing is decrypted, and no recovery code is read.
 * `enrolmentRequired` is what makes mandatory enrolment reachable: a user whose account requires MFA
 * but has no ACTIVE authenticator must be sent to enrolment, not to a code prompt they cannot
 * satisfy. Callers must already hold a valid session for `userId` (tenant comes from the session).
 */
export interface MfaStatus {
  /** MFA is mandatory for this account (partner_users.mfa_required). */
  required: boolean;
  /** An ACTIVE TOTP authenticator exists. A PENDING (unconfirmed) secret is NOT a factor. */
  enrolled: boolean;
  /** Required but not yet enrolled — the enrolment flow is the only reachable next step. */
  enrolmentRequired: boolean;
  /** Unused recovery codes remaining (count only — never the codes or their hashes). */
  recoveryCodesRemaining: number;
}

export async function getMfaStatus(ctx: { tenantId: string; userId: string }): Promise<MfaStatus> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<MfaStatus> => {
    const u = await c.query<{ mfa_required: boolean }>("SELECT mfa_required FROM partner_users WHERE id=$1", [
      ctx.userId,
    ]);
    const required = u.rows[0]?.mfa_required ?? false;
    const enrolled = await hasActiveMethod(c, ctx.userId);
    const rc = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_recovery_codes WHERE user_id=$1 AND used_at IS NULL",
      [ctx.userId]
    );
    return {
      required,
      enrolled,
      enrolmentRequired: required && !enrolled,
      recoveryCodesRemaining: Number(rc.rows[0]?.n ?? 0),
    };
  });
}

/**
 * Start enrolment: elevated verify, generate + encrypt a PENDING TOTP secret, return provisioning once.
 *
 * TWO DIFFERENT OPERATIONS SHARE THIS ENTRY POINT, and they carry very different risk:
 *
 *   • BOOTSTRAP — no ACTIVE method exists. The password alone is sufficient, and must remain so: this
 *     is the only path a mandatory-MFA account with no authenticator (a freshly-accepted owner, or a
 *     user who just disabled their method) has back into the Portal. Gating it harder would strand
 *     them, since there is no factor to present.
 *
 *   • REPLACEMENT — an ACTIVE method already exists and is about to be swapped out. This is a full
 *     account takeover primitive, and it is what F3 found under-defended:
 *       F1 already required `sessionMfaPassed`, but from an already-MFA-passed session that left the
 *       PASSWORD as the only thing standing between a hijacked session and a new authenticator —
 *       strictly weaker than `mfaDisable`, which has always demanded password PLUS a current factor
 *       for the *less* dangerous operation. Replacement now demands the same proof as disabling:
 *       `sessionMfaPassed` AND a live TOTP (replay-protected) or a single-use recovery code.
 *
 * Gating REPLACEMENT here — at the point the new secret is issued — is sufficient, not merely
 * convenient: `mfaEnrolConfirm` can only activate a PENDING secret by presenting a valid TOTP FOR
 * THAT SECRET, and the secret is disclosed exactly once, by this function, to a caller that has just
 * proved the current factor. An abandoned PENDING row is therefore useless to anyone else.
 */
export async function mfaEnrolStart(
  ctx: { tenantId: string; userId: string; sessionId: string; email?: string; sessionMfaPassed?: boolean },
  password: string,
  secondFactor: SecondFactorInput = {}
): Promise<EnrolResult> {
  return createPendingEnrolment(ctx, { password, secondFactor, allowActiveReplacement: true });
}

async function createPendingEnrolment(
  ctx: { tenantId: string; userId: string; sessionId: string; email?: string; sessionMfaPassed?: boolean },
  opts: { password?: string; secondFactor?: SecondFactorInput; allowActiveReplacement: boolean }
): Promise<EnrolResult> {
  if (!mfaEncryptionConfigured()) return { ok: false, reason: "encryption_unavailable" };
  const secret = generateTotpSecret();
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<EnrolResult> => {
    await c.query("SELECT id FROM partner_users WHERE id=$1 FOR UPDATE", [ctx.userId]);
    if (opts.password != null && !(await verifyPassword(c, ctx.userId, opts.password)))
      return { ok: false, reason: "unauthorised" };
    if (await hasActiveMethod(c, ctx.userId)) {
      if (!opts.allowActiveReplacement) return { ok: false, reason: "requires_current_factor" };
      // F1 (unchanged): a password-only, mfa-pending session may never replace an existing factor.
      if (!ctx.sessionMfaPassed) return { ok: false, reason: "requires_current_factor" };
      // F3: …and neither may a password alone from an mfa-passed session.
      if (!(await verifySecondFactor(c, ctx.userId, opts.secondFactor ?? {})))
        return { ok: false, reason: "second_factor_required" };
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

/**
 * Confirm enrolment with a valid TOTP → activate, issue one-time recovery codes, mark session mfa_passed.
 *
 * F3: when this ACTIVATION REPLACES an existing factor it is a credential change, and is now treated
 * as one — `credential_version` is bumped and every OTHER live session is revoked, so a second,
 * stolen session cannot outlive the authenticator swap it did not perform. The session that
 * completed the replacement is re-pinned to the new version rather than killed: it has just proved
 * password + the OLD factor (at enrol-start) + the NEW factor (here), which is strictly more than
 * any other session on the account can show. The security event is raised from 'info' to 'medium',
 * matching `partner_mfa_disabled` — the two operations carry comparable risk.
 *
 * `mfa_required` is preserved as true on both paths, and the OLD secret is never read or returned.
 */
export async function mfaEnrolConfirm(
  ctx: { tenantId: string; userId: string; sessionId: string; sessionMfaPassed?: boolean },
  enrolmentId: string,
  code: string
): Promise<ConfirmResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<ConfirmResult> => {
    await c.query("SELECT id FROM partner_users WHERE id=$1 FOR UPDATE", [ctx.userId]);
    const live = await c.query(
      "SELECT 1 FROM partner_sessions s JOIN partner_users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.tenant_id=$3 AND s.revoked_at IS NULL AND s.credential_version=u.credential_version LIMIT 1",
      [ctx.sessionId, ctx.userId, ctx.tenantId]
    );
    if (live.rowCount !== 1) return { ok: false, reason: "stale_session" };
    const replacing = await hasActiveMethod(c, ctx.userId);
    // F1 defence-in-depth: cannot REPLACE an existing active factor from a non-mfa-passed session.
    if (!ctx.sessionMfaPassed && replacing) return { ok: false, reason: "requires_current_factor" };
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
    if (pend.rows[0].expired) {
      await c.query("UPDATE partner_mfa_methods SET status='DISABLED' WHERE id=$1", [pend.rows[0].id]);
      return { ok: false, reason: "expired" };
    }
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
    await c.query(
      replacing
        ? "UPDATE partner_users SET mfa_enabled=true, mfa_required=true, credential_version=credential_version+1 WHERE id=$1"
        : "UPDATE partner_users SET mfa_enabled=true, mfa_required=true WHERE id=$1",
      [ctx.userId]
    );
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
    if (replacing) {
      // Every OTHER live session dies with the factor it was issued under.
      await c.query(
        "UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2",
        [ctx.userId, ctx.sessionId ?? null]
      );
      // …and the acting session is carried across the credential_version bump it just caused, so the
      // user is not signed out of the flow they are completing. Without this the bump above would
      // invalidate it at session.ts's `session_cred_version !== user_cred_version` check.
      if (ctx.sessionId) {
        await c.query(
          "UPDATE partner_sessions SET credential_version=(SELECT credential_version FROM partner_users WHERE id=$1) WHERE id=$2",
          [ctx.userId, ctx.sessionId]
        );
      }
    }
    const passed = await c.query(
      `UPDATE partner_sessions s
          SET mfa_passed=true
         FROM partner_users u
        WHERE s.id=$1
          AND s.user_id=$2
          AND s.tenant_id=$3
          AND s.revoked_at IS NULL
          AND u.id=s.user_id
          AND u.credential_version=s.credential_version`,
      [ctx.sessionId, ctx.userId, ctx.tenantId]
    );
    if (passed.rowCount !== 1) throw new Error("MFA session upgrade failed");
    await writePartnerAudit(c, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: replacing ? "partner_mfa_replaced" : "partner_mfa_enrolled",
    });
    await writePartnerSecurity(c, {
      tenantId: ctx.tenantId,
      severity: replacing ? "medium" : "info",
      kind: replacing ? "partner_mfa_replaced" : "partner_mfa_enabled",
    });
    return { ok: true, recoveryCodes: plaintext };
  });
}

export async function mfaEnrolRestart(ctx: {
  tenantId: string;
  userId: string;
  sessionId: string;
  sessionMfaPassed?: boolean;
}): Promise<EnrolResult> {
  const out = await createPendingEnrolment(ctx, { allowActiveReplacement: false });
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

export type RegenResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "unauthorised" | "requires_current_factor" | "second_factor_required" };

/**
 * Regenerate recovery codes — invalidates all previous unused codes.
 *
 * C: this used to accept the PASSWORD ALONE. Recovery codes ARE a second factor (`verifySecondFactor`
 * accepts one in place of a TOTP, and `POST /auth/mfa` completes a sign-in with one), so minting a
 * fresh set of ten is equivalent to issuing oneself a brand-new authenticator. Password-only was
 * therefore strictly weaker than BOTH `mfaDisable` and enrolment-REPLACEMENT, which have demanded
 * password PLUS a current factor since F3 — for operations of the same class. A stolen session plus a
 * phished/reused password yielded ten single-use factors, and the legitimate holder saw nothing.
 *
 * Now, for an ALREADY-ENROLLED user, this demands exactly what replacement demands, via exactly the
 * same helper (`verifySecondFactor` — one mechanism, not a second implementation):
 * `sessionMfaPassed` AND a live replay-protected TOTP or a single-use recovery code.
 *
 * BOOTSTRAP is deliberately untouched, for the same reason `mfaEnrolStart` leaves it untouched: when
 * NO active method exists there is no factor to present, so requiring one would strand the user.
 * First-time enrolment issues its initial codes from `mfaEnrolConfirm`, which this function does not
 * gate and which is unchanged.
 *
 * The prior codes are destroyed before the new ones are written, so a regeneration cannot leave an
 * older set live. Existing codes are never read back or returned — only the new plaintext, once.
 */
export async function mfaRegenerateRecovery(
  ctx: { tenantId: string; userId: string; sessionMfaPassed?: boolean },
  password: string,
  secondFactor: SecondFactorInput = {}
): Promise<RegenResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<RegenResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    if (await hasActiveMethod(c, ctx.userId)) {
      // Mirrors mfaEnrolStart's REPLACEMENT gate exactly — same order, same reasons, same helper.
      if (!ctx.sessionMfaPassed) return { ok: false, reason: "requires_current_factor" };
      if (!(await verifySecondFactor(c, ctx.userId, secondFactor)))
        return { ok: false, reason: "second_factor_required" };
    }
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
    // Partner-VISIBLE evidence: replacing the recovery set is a credential-class change, so it is
    // surfaced at the same severity as partner_mfa_disabled / partner_mfa_replaced rather than being
    // recorded only in the internal audit ledger the account holder never sees.
    await writePartnerSecurity(c, {
      tenantId: ctx.tenantId,
      severity: "medium",
      kind: "partner_mfa_recovery_regenerated",
    });
    return { ok: true, recoveryCodes: plaintext };
  });
}

export type DisableResult = { ok: true } | { ok: false; reason: "unauthorised" | "second_factor_required" };

/**
 * Disable the user's MFA **METHOD** — never the MFA **REQUIREMENT**.
 *
 * F2: this used to clear `mfa_required` as well as `mfa_enabled`. `mfa_required` is the only flag the
 * session layer reads (auth.ts sets `mfa_passed = !mfa_required` at login; session.ts gates every
 * authenticated surface on `mfa_passed`), so clearing it let a partner user self-revoke the mandate
 * P0-E establishes and sign in with a password forever after. The requirement is an ACCOUNT POLICY —
 * only an admin reset (partner-management-service.resetPartnerUserMfa) or a policy change may move
 * it, and that path deliberately keeps `mfa_required=true` too. Mirrored here.
 *
 * The account is therefore left in exactly the bootstrap state a freshly-accepted owner is in:
 * required, not enrolled, no ACTIVE method. That state is reachable — `mfaEnrolStart` only demands a
 * current factor when one still EXISTS — so this cannot strand the user. Proven by
 * tests/partner-mfa-enrolment-mandatory.test.ts ("re-enrolment ... is reachable with the password
 * alone").
 *
 * Requires password + a valid current TOTP or recovery code, then revokes all sessions.
 */
export async function mfaDisable(
  ctx: { tenantId: string; userId: string },
  password: string,
  secondFactor: { code?: string; recoveryCode?: string }
): Promise<DisableResult> {
  return withTenant({ tenantId: ctx.tenantId }, async (c): Promise<DisableResult> => {
    if (!(await verifyPassword(c, ctx.userId, password))) return { ok: false, reason: "unauthorised" };
    // require an existing MFA second factor (shared with the enrolment-replacement gate — F3)
    if (!(await verifySecondFactor(c, ctx.userId, secondFactor)))
      return { ok: false, reason: "second_factor_required" };
    await c.query("UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND method='totp'", [ctx.userId]);
    await c.query("DELETE FROM partner_recovery_codes WHERE user_id=$1", [ctx.userId]);
    // F2: mfa_required stays TRUE. Only the METHOD is removed.
    await c.query(
      "UPDATE partner_users SET mfa_enabled=false, mfa_required=true, credential_version=credential_version+1 WHERE id=$1",
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
