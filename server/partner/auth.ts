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
import type { PoolClient } from "pg";
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
    // P0-F: a suspended/invited/revoked account is refused REGARDLESS of the password, so counting
    // these attempts towards the lockout threshold protects nothing — it only accumulates a counter
    // that has no reset path while suspended, so the account is locked the instant it is
    // reactivated. Record the attempt (audit) but do not arm the lockout. The failure is still
    // generic to the caller.
    //
    // TIMING, stated honestly: this branch DOES do measurably less work than the active-account
    // failure path (it skips the lockout-arming UPDATE), and the bcrypt compare above does NOT mask
    // that — bcrypt is paid on BOTH arms, so it cancels out of the difference and hides nothing. An
    // earlier version of this comment claimed otherwise; that reasoning was wrong.
    //
    // What actually makes the residual signal unexploitable is that an attacker cannot collect
    // enough samples to lift a sub-millisecond difference out of network noise: partner login is
    // rate limited FAIL-CLOSED on two independent buckets — 30 attempts per IP per 15 minutes
    // (rate-limit.ts partnerLoginIpLimiter) and 10 per account per 15 minutes
    // (partnerLoginLimiter). Ten samples per account per quarter-hour is orders of magnitude short
    // of what distinguishing one skipped UPDATE would need. If either bucket is ever widened or
    // removed, this branch needs re-examining on its own merits.
    await recordFailure(u, ip, "suspended", { countTowardsLockout: false });
    return { ok: false, reason: "suspended" };
  }
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    // countTowardsLockout:false for the SAME reason as the suspended branch above. A locked
    // account is refused regardless of the password, so counting the attempt protects nothing —
    // but counting it re-evaluates `locked_until = now() + 15 minutes` on EVERY attempt, because
    // failed_login_count is already >= the threshold. That let an unauthenticated attacker hold a
    // named partner account offline indefinitely at ~4 requests/hour, well inside both login
    // limiters. The attempt is still audited below; only the clock stops extending.
    await recordFailure(u, ip, "locked", { countTowardsLockout: false });
    return { ok: false, reason: "locked" };
  }

  // The lockout INTERVAL has elapsed (we only reach here when locked_until is absent or past).
  // Retire the spent counter BEFORE this attempt is judged.
  //
  // Without this, failed_login_count stays at the threshold indefinitely — it is cleared only by a
  // successful login, a completed password reset, or invitation acceptance — so recordFailure's
  // arming expression `failed_login_count + 1 >= threshold` is satisfied by the FIRST failure after
  // every expiry. One unauthenticated request per interval then holds a named partner account
  // offline forever, comfortably inside both login limiters. The countTowardsLockout:false fix
  // above stopped a LIVE lock being extended; it did not stop a SPENT lock being instantly re-armed,
  // which is the other half of the same denial-of-service. Proven end-to-end in
  // tests/partner-lockout-decay.test.ts.
  //
  // Brute-force protection is unchanged: after a lock is served, re-locking costs a full fresh
  // THRESHOLD of failures again (asserted by that suite) rather than one. Stated precisely, because
  // the distinction matters to the next reader: this retires the counter when a LOCK EXPIRES; it is
  // not a general time-decay. An account sitting below the threshold with no lock still carries its
  // accumulated count indefinitely — unchanged, pre-existing behaviour, and deliberately so, since
  // decaying that would hand an attacker a slow-drip path under the threshold.
  //
  // This is the same expiry-retires-the-counter model server/staff.ts already uses for staff
  // accounts — the existing architecture, not a second, parallel lockout system.
  //
  // CLOCK NOTE (accepted residual): the expiry test above uses the app clock and this UPDATE uses
  // the database clock. If the app clock ran AHEAD of the database's, this reset would match no row
  // and the next failure would re-arm — but in that state the lock has genuinely not expired
  // database-side, so the outcome is a still-locked account, not a weakened one.
  //
  // `locked_until <= now()` is re-checked inside the UPDATE so a concurrent request that has just
  // armed a fresh lock cannot have it cleared by this reset.
  if (u.locked_until) {
    await withTenant({ tenantId: u.tenant_id }, (c) =>
      c.query(
        `UPDATE partner_users SET failed_login_count = 0, locked_until = NULL
          WHERE id = $1 AND locked_until IS NOT NULL AND locked_until <= now()`,
        [u.user_id],
      ),
    );
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

async function recordFailure(
  u: AuthRow,
  ip: string | null | undefined,
  kind: string,
  opts: { countTowardsLockout?: boolean } = {},
): Promise<void> {
  const countTowardsLockout = opts.countTowardsLockout !== false; // default UNCHANGED: count it
  await withTenant({ tenantId: u.tenant_id }, async (c) => {
    if (countTowardsLockout) {
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
    }
    await writePartnerAudit(c, { tenantId: u.tenant_id, actorUserId: u.user_id, action: "partner_login_failure", ip: ip ?? null, reason: kind });
  });
}

// ---------------- second-factor failure tracking + lockout (0053) ----------------
//
// The password step has had a lockout since Phase 1 (recordFailure above). The SECOND factor — the
// control whose entire purpose is to survive a stolen password — had none: a failed
// POST /auth/mfa returned 401 and left no trace anywhere. Combined with an IP-only rate limit,
// that made the challenge grindable from rotating addresses, so the password was effectively the
// only factor. These three functions are the account-side ceiling.
//
// SEPARATE COLUMNS, NOT failed_login_count / locked_until. See migration 0053's header for the
// full argument; the short version is that partnerLogin() zeroes the password counters on every
// SUCCESSFUL login, so an attacker holding the password owns a reset primitive and a shared
// counter would never have armed.

/**
 * True if this account is currently barred from attempting a second-factor verification.
 *
 * Read INSIDE the caller's tenant transaction so it is subject to the same RLS as everything else
 * and cannot be asked about another tenant's user.
 */
export async function isPartnerMfaLocked(c: PoolClient, userId: string): Promise<boolean> {
  const { rows } = await c.query<{ locked: boolean }>(
    "SELECT (mfa_locked_until IS NOT NULL AND mfa_locked_until > now()) AS locked FROM partner_users WHERE id=$1",
    [userId],
  );
  return rows[0]?.locked === true;
}

/**
 * Record a failed second-factor verification and arm the lockout at the threshold.
 *
 * Mirrors recordFailure() deliberately, including the details that were bug fixes there:
 *
 *   * The increment is ATOMIC in SQL (`failed_mfa_count + 1`), so concurrent guesses — the exact
 *     shape of the attack this defends against — cannot lost-update the counter and evade the lock.
 *   * The lock is armed in the SAME statement, at the same threshold and interval as the password
 *     path (LOCKOUT_THRESHOLD / LOCKOUT_MINUTES), so there is one lockout policy to reason about
 *     and not two.
 *   * Arming is guarded by `mfa_locked_until IS NULL OR mfa_locked_until <= now()`. Without that,
 *     an attempt made while a lock is LIVE would re-evaluate `now() + 15 minutes` on every request
 *     (failed_mfa_count is already past the threshold), letting a caller hold an account's second
 *     factor offline indefinitely — the denial-of-service already fixed on the login path via
 *     countTowardsLockout:false. Here the caller cannot even reach a live lock, because the route
 *     refuses first; the guard exists so that ordering is not the only thing preventing it.
 *
 * The failure is ALWAYS audited, whether or not it arms the lock — the finding was as much about
 * invisibility as about the missing ceiling.
 */
export async function recordPartnerMfaFailure(
  c: PoolClient,
  e: { tenantId: string; userId: string; sessionId?: string | null; ip?: string | null; reason: string },
): Promise<{ locked: boolean; count: number }> {
  const { rows } = await c.query<{ failed_mfa_count: number; armed: boolean }>(
    `UPDATE partner_users
        SET failed_mfa_count = failed_mfa_count + 1,
            mfa_locked_until = CASE
              WHEN failed_mfa_count + 1 >= $2
               AND (mfa_locked_until IS NULL OR mfa_locked_until <= now())
              THEN now() + ($3 || ' minutes')::interval
              ELSE mfa_locked_until END
      WHERE id = $1
      RETURNING failed_mfa_count, (mfa_locked_until IS NOT NULL AND mfa_locked_until > now()) AS armed`,
    [e.userId, LOCKOUT_THRESHOLD, String(LOCKOUT_MINUTES)],
  );
  const count = rows[0]?.failed_mfa_count ?? 0;
  const locked = rows[0]?.armed === true;
  await writePartnerAudit(c, {
    tenantId: e.tenantId,
    actorUserId: e.userId,
    sessionId: e.sessionId ?? null,
    action: "partner_mfa_failure",
    ip: e.ip ?? null,
    reason: e.reason,
  });
  if (locked && count === LOCKOUT_THRESHOLD) {
    // Only on the transition, so a security event means "this account just locked" rather than
    // "someone tried again while locked", which is a different and much noisier signal.
    await writePartnerSecurity(c, {
      tenantId: e.tenantId,
      severity: "high", // higher than the password lock: reaching this needs a VALID password first
      kind: "partner_mfa_locked",
      detail: { userId: e.userId, failures: count },
    });
  }
  return { locked, count };
}

/**
 * Retire the failure counter after a SUCCESSFUL second-factor verification.
 *
 * This is the only routine clearing path, and it is why a legitimate user who mistypes one code is
 * not affected: four wrong codes leave the counter at 4, the fifth correct one resets it to 0.
 * (A completed password reset also clears it — see consumePasswordResetToken — because that path
 * revokes every session and re-arms the whole login sequence anyway.)
 *
 * Note what is NOT here: a successful password login does not clear it. That omission is the whole
 * point of using separate columns.
 */
export async function clearPartnerMfaFailures(c: PoolClient, userId: string): Promise<void> {
  await c.query("UPDATE partner_users SET failed_mfa_count=0, mfa_locked_until=NULL WHERE id=$1", [userId]);
}

/**
 * Retire a SPENT lock before a fresh attempt is judged.
 *
 * Same reasoning as the login path's equivalent reset, and the same defect if omitted: once
 * failed_mfa_count sits at the threshold, the arming expression `failed_mfa_count + 1 >= threshold`
 * is satisfied by the FIRST failure after every expiry, so one request per interval would hold an
 * account's second factor offline forever. Re-locking must cost a full fresh THRESHOLD of failures.
 *
 * `mfa_locked_until <= now()` is re-checked inside the UPDATE so a concurrent request that has just
 * armed a live lock cannot have it cleared here.
 */
export async function retireExpiredPartnerMfaLock(c: PoolClient, userId: string): Promise<void> {
  await c.query(
    `UPDATE partner_users SET failed_mfa_count = 0, mfa_locked_until = NULL
      WHERE id = $1 AND mfa_locked_until IS NOT NULL AND mfa_locked_until <= now()`,
    [userId],
  );
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
export const MIN_PASSWORD_LEN = 10;
// Upper bound to reject absurdly long inputs (DoS guard). NOTE: bcrypt only hashes the first 72
// bytes, so bytes beyond 72 do not add entropy — this cap does NOT prevent that truncation; it is
// only an input-size limit. (Behaviour unchanged.)
export const MAX_PASSWORD_LEN = 200;

export async function consumePasswordResetToken(token: string, newPassword: string): Promise<boolean> {
  // F5: enforce the password policy in the SERVICE layer so every caller shares it, not just the route.
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LEN || newPassword.length > MAX_PASSWORD_LEN) {
    return false;
  }
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
    // P0-F: a successful reset must also END the lockout. `locked_until` / `failed_login_count`
    // were previously cleared ONLY on a successful login (auth.ts, unreachable while locked) and on
    // invitation acceptance (single-use, already spent), so a user locked out by five failed
    // attempts stayed locked even after proving control of their mailbox and setting a new
    // password. This is the recovery path; nothing else weakens. Note the ORDER of guarantees:
    // credential_version still increments and every live session is still revoked below.
    await c.query(
      // 0053: the SECOND-factor lock is cleared here too. A password reset is proof of mailbox
      // control and revokes every session below, so leaving an MFA lock armed across it would
      // strand a legitimate user for no security gain — the attacker's mfa-pending session is
      // already dead. This is the ONLY clearing path besides a successful verification; a
      // successful password LOGIN deliberately does not clear it (see recordPartnerMfaFailure).
      `UPDATE partner_users
          SET password_hash=$2, credential_version=credential_version+1,
              failed_login_count=0, locked_until=NULL,
              failed_mfa_count=0, mfa_locked_until=NULL
        WHERE id=$1`,
      [user_id, newHash],
    );
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [user_id]);
    await writePartnerAudit(c, { tenantId, actorUserId: user_id, action: "partner_password_reset_completed" });
    return true;
  });
}
