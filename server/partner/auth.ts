/**
 * Partner Portal — authentication service (Phase 1).
 *
 * bcrypt passwords, generic failures (no account-existence disclosure), active-state checks,
 * login throttling + temporary lockout, session rotation on success, logout + revoke-all, and a
 * single-use password-reset foundation. Pre-auth user lookup uses the narrow SECURITY DEFINER
 * function partner_auth_lookup() so the runtime connects only as the restricted role.
 */
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { partnerRuntimeQuery, withTenant } from "./db";
import { writePartnerAudit, writePartnerSecurity } from "./audit";
import { readEmergencyState } from "./emergency";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;
export const SESSION_ABSOLUTE_HOURS = 12;

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export interface LoginResult {
  ok: boolean;
  reason?: "invalid" | "locked" | "suspended" | "mfa_required";
  // present only on ok:
  sessionToken?: string;
  userId?: string;
  tenantId?: string;
  partnerId?: string;
  mfaPending?: boolean;
}

interface AuthRow {
  user_id: string;
  tenant_id: string;
  partner_id: string;
  password_hash: string | null;
  user_status: string;
  org_status: string;
  credential_version: number;
  failed_login_count: number;
  locked_until: string | null;
  mfa_required: boolean;
}

/**
 * Authenticate by email + password. Generic failure for unknown/invalid/suspended so account
 * existence is never disclosed. On success rotates in a fresh session; if MFA is required, returns
 * an mfa-pending session (mfa_passed=false) that cannot perform sensitive operations.
 */
export async function partnerLogin(email: string, password: string, ip?: string | null): Promise<LoginResult> {
  const { rows } = await partnerRuntimeQuery<AuthRow>("SELECT * FROM partner_auth_lookup($1)", [email]);
  // Unknown or ambiguous email → generic invalid (constant-ish work: still run a bcrypt compare).
  if (rows.length !== 1) {
    await bcrypt.compare(password, "$2a$12$0000000000000000000000000000000000000000000000000000a").catch(() => {});
    return { ok: false, reason: "invalid" };
  }
  const u = rows[0];

  // L3 (timing oracle): ALWAYS run the bcrypt compare first — before the suspended/locked branches —
  // so locked/suspended accounts incur the same cost as an active wrong-password attempt.
  const good = u.password_hash ? await bcrypt.compare(password, u.password_hash) : false;

  if (u.org_status !== "ACTIVE" || u.user_status !== "ACTIVE") {
    await recordFailure(u, ip, "suspended");
    return { ok: false, reason: "suspended" };
  }
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    await recordFailure(u, ip, "locked");
    return { ok: false, reason: "locked" };
  }
  if (!good) {
    await recordFailure(u, ip, "invalid");
    return { ok: false, reason: "invalid" };
  }

  // M1: refuse to mint a session if a login freeze or a partner/location hard-stop is active.
  const emergencyBlocked = await withTenant({ tenantId: u.tenant_id }, async (c) => {
    const em = await readEmergencyState(c, { tenantId: u.tenant_id });
    return em.loginDisabled || em.partnerFrozen || em.locationFrozen;
  });
  if (emergencyBlocked) return { ok: false, reason: "suspended" };

  // success — reset lockout state, rotate a new session
  const mfaPending = u.mfa_required;
  const token = crypto.randomBytes(32).toString("base64url");
  await withTenant({ tenantId: u.tenant_id }, async (c) => {
    await c.query(
      "UPDATE partner_users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1",
      [u.user_id],
    );
    // rotation: any prior live session for this user is revoked before minting a new one.
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [u.user_id]);
    await c.query(
      `INSERT INTO partner_sessions (tenant_id, user_id, token_hash, credential_version, mfa_passed, ip, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
      [u.tenant_id, u.user_id, sha256(token), u.credential_version, !mfaPending, ip ?? null, String(SESSION_ABSOLUTE_HOURS)],
    );
    await writePartnerAudit(c, {
      tenantId: u.tenant_id, actorUserId: u.user_id, action: mfaPending ? "partner_login_mfa_pending" : "partner_login",
      ip: ip ?? null,
    });
  });
  return { ok: true, sessionToken: token, userId: u.user_id, tenantId: u.tenant_id, partnerId: u.partner_id, mfaPending };
}

async function recordFailure(u: AuthRow, ip: string | null | undefined, kind: string): Promise<void> {
  await withTenant({ tenantId: u.tenant_id }, async (c) => {
    // M3: increment ATOMICALLY in SQL (failed_login_count + 1) so concurrent failed logins can't
    // lost-update the counter and evade lockout. Lock is set in the same statement at the threshold.
    const { rows } = await c.query<{ failed_login_count: number; locked: boolean }>(
      `UPDATE partner_users
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2
                                  THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1
        RETURNING failed_login_count, (failed_login_count >= $2) AS locked`,
      [u.user_id, LOCKOUT_THRESHOLD, String(LOCKOUT_MINUTES)],
    );
    if (rows[0]?.locked) {
      await writePartnerSecurity(c, { tenantId: u.tenant_id, severity: "medium", kind: "partner_account_locked", detail: { userId: u.user_id } });
    }
    await writePartnerAudit(c, { tenantId: u.tenant_id, actorUserId: u.user_id, action: "partner_login_failure", ip: ip ?? null, reason: kind });
  });
}

/** Mark the MFA challenge passed for the current session (after verifyTotp/recovery succeeds). */
export async function markSessionMfaPassed(tenantId: string, sessionId: string): Promise<void> {
  await withTenant({ tenantId }, (c) => c.query("UPDATE partner_sessions SET mfa_passed=true WHERE id=$1", [sessionId]));
}

export async function partnerLogout(tenantId: string, sessionId: string): Promise<void> {
  await withTenant({ tenantId }, async (c) => {
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", [sessionId]);
    await writePartnerAudit(c, { tenantId, sessionId, action: "partner_logout" });
  });
}

export async function revokeAllSessions(tenantId: string, userId: string, reason = "revoke_all"): Promise<number> {
  return withTenant({ tenantId }, async (c) => {
    const r = await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    await writePartnerAudit(c, { tenantId, actorUserId: userId, action: "partner_sessions_revoked", reason });
    return r.rowCount ?? 0;
  });
}

// ---------------- password reset (single use, expiring) ----------------
export const RESET_TOKEN_MINUTES = 30;

export async function createPasswordResetToken(tenantId: string, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await withTenant({ tenantId }, async (c) => {
    await c.query(
      `INSERT INTO partner_password_reset_tokens (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [tenantId, userId, sha256(token), String(RESET_TOKEN_MINUTES)],
    );
    await writePartnerAudit(c, { tenantId, actorUserId: userId, action: "partner_password_reset_requested" });
  });
  return token; // delivered out-of-band (email); never logged
}

/**
 * Consume a reset token (single-use, unexpired), set the new password, revoke all sessions.
 * L6: the tenant is derived FROM the token via a SECURITY DEFINER lookup — never from a request
 * body — so no attacker-controlled tenant id reaches RLS.
 */
export async function consumePasswordResetToken(token: string, newPassword: string): Promise<boolean> {
  const { rows: tRows } = await partnerRuntimeQuery<{ tenant: string | null }>(
    "SELECT partner_reset_token_tenant($1) AS tenant",
    [sha256(token)],
  );
  const tenantId = tRows[0]?.tenant;
  if (!tenantId) return false; // unknown/expired/used token
  const newHash = await hashPassword(newPassword);
  return withTenant({ tenantId }, async (c) => {
    const { rows } = await c.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM partner_password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(token)],
    );
    if (rows.length !== 1) return false;
    const { id, user_id } = rows[0];
    await c.query("UPDATE partner_password_reset_tokens SET used_at=now() WHERE id=$1", [id]);
    await c.query("UPDATE partner_users SET password_hash=$2, credential_version=credential_version+1 WHERE id=$1", [user_id, newHash]);
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [user_id]);
    await writePartnerAudit(c, { tenantId, actorUserId: user_id, action: "partner_password_reset_completed" });
    return true;
  });
}
