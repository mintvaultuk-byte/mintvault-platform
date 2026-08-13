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
export const MIN_PASSWORD_LEN = 10;
/** bcrypt considers only the first 72 UTF-8 bytes. */
export const MAX_PASSWORD_BYTES = 72;

export function isValidPartnerPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_PASSWORD_LEN &&
    Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES
  );
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Logged once per process, not per request — same shape as mount.ts's incoherent-env report. */
let loggedMissingMfaProjection = false;
/** Same one-shot-per-process discipline as the MFA projection warning above. */
let loggedMissingPasswordProvenance = false;

export interface LoginResult {
  ok: boolean;
  reason?:
    | "invalid"
    | "locked"
    | "suspended"
    | "mfa_required"
    | "mfa_state_unavailable"
    | "credential_provenance_unavailable";
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
  /** Present after credential-lifecycle migration 0077; absence fails closed. */
  password_set_at?: string | null;
  /**
   * OPTIONAL BY TYPE, ON PURPOSE. `SELECT * FROM partner_auth_lookup($1)` returns
   * exactly the columns the DEPLOYED function declares, and this one exists only
   * from migration 0046 — 0002's original signature stops at `mfa_required`.
   * Declaring it non-optional was a claim the compiler could not check: on a
   * database without 0046 the value is `undefined`, `mfa_required || has_active_mfa`
   * evaluated to `undefined` for an account with `mfa_required = false` and an
   * ACTIVE authenticator, and the session was minted with `mfa_passed = !undefined
   * = true` — the second factor silently disabled. Optional so the fail-closed
   * check below is a real narrowing rather than a cast.
   */
  has_active_mfa?: boolean;
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

  // ── OWNER-AUTHORISED REPAIR (2026-08-11) — FAIL CLOSED ON A MISSING MFA PROJECTION ──
  //
  // `has_active_mfa` is the only thing stopping an account that HAS an authenticator
  // but does not carry `mfa_required` from being handed a fully-authenticated
  // session. It exists only in migration 0046's partner_auth_lookup signature.
  // Against a database still on 0002's ten-column form the column is simply absent
  // from the result row, `mfaPending` below evaluates to `undefined`, and every such
  // login is minted with `mfa_passed = true`. That is a silent MFA bypass caused by
  // schema drift, with no error, no log line and no failing request to notice it by.
  // Refusing is the only safe reading of "we cannot tell whether this account has a
  // second factor".
  //
  // POSITION IS DELIBERATE. It sits AFTER the constant-cost bcrypt compare above, so
  // the L3 timing property is untouched, and BEFORE every branch that mutates state
  // or mints a session — no lockout counter is armed, no session row is written. A
  // missing projection is a property of the DEPLOYMENT, identical for every caller,
  // so this adds no per-account oracle.
  //
  // BOUNDARY, NOT STARTUP GATE. The served login route (server/partner/public-routes.ts)
  // is mounted OUTSIDE partnerPortalRouter's four gates, so a gate in mount.ts would
  // not cover the one route that decides mfa_passed. Logged once per process — an
  // operator must be able to see WHY every partner login is suddenly refused.
  if (typeof u.has_active_mfa !== "boolean") {
    if (!loggedMissingMfaProjection) {
      loggedMissingMfaProjection = true;
      console.error(
        "[partner] refusing ALL partner logins: partner_auth_lookup() does not project has_active_mfa. " +
          "Apply migrations/0044_partner_mfa_pending_lifecycle.sql, then restart. " +
          "(Hosts whose journal already holds this migration as 0046 from the pre-2026-08-11 " +
          "canonical lineage are unaffected — the two files were byte-identical.)"
      );
    }
    return { ok: false, reason: "mfa_state_unavailable" };
  }

  // ── SAME FAIL-CLOSED REASONING, FOR THE CREDENTIAL-PROVENANCE PROJECTION (0077) ──
  //
  // `password_set_at` gates every login below. On a database that has NOT yet applied
  // 0077, partner_auth_lookup() simply does not project the column, so `SELECT *`
  // returns a row without the key, `!u.password_set_at` is `true` for EVERY account,
  // and all partner logins are refused as "suspended" → a generic 401 "invalid
  // credentials". The outcome is safe, but with no log line and no distinguishable
  // status it is indistinguishable from every partner suddenly having the wrong
  // password — the operator has nothing to diagnose from. That is the same silent
  // schema-drift trap the has_active_mfa guard above exists to prevent.
  //
  // ABSENT (schema drift) and NULL (a real user who has never set their own password)
  // are DIFFERENT states and must not be conflated: node-postgres omits the key
  // entirely when the function does not project it, and sets it to `null` when it
  // does and the value is NULL. `in` distinguishes them; a truthiness test cannot.
  //
  // Position matches the guard above: AFTER the constant-cost bcrypt compare, BEFORE
  // any state mutation or session mint. A missing projection is a property of the
  // DEPLOYMENT, identical for every caller, so this adds no per-account oracle.
  if (!("password_set_at" in u)) {
    if (!loggedMissingPasswordProvenance) {
      loggedMissingPasswordProvenance = true;
      console.error(
        "[partner] refusing ALL partner logins: partner_auth_lookup() does not project password_set_at. " +
          "Apply migrations/0077_partner_credential_lifecycle_hardening.sql, then restart. " +
          "(This is the migration-after-deploy ordering fault — 0077 must be applied BEFORE this build ships.)"
      );
    }
    return { ok: false, reason: "credential_provenance_unavailable" };
  }

  if (u.org_status !== "ACTIVE" || u.user_status !== "ACTIVE" || !u.password_set_at) {
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
        [u.user_id]
      )
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
  const mfaPending = u.mfa_required || u.has_active_mfa;
  const token = crypto.randomBytes(32).toString("base64url");
  await withTenant({ tenantId: u.tenant_id }, async (c) => {
    await c.query("UPDATE partner_users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [
      u.user_id,
    ]);
    // rotation: any prior live session for this user is revoked before minting a new one.
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [u.user_id]);
    await c.query(
      `INSERT INTO partner_sessions (tenant_id, user_id, token_hash, credential_version, mfa_passed, ip, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
      [
        u.tenant_id,
        u.user_id,
        sha256(token),
        u.credential_version,
        !mfaPending,
        ip ?? null,
        String(SESSION_ABSOLUTE_HOURS),
      ]
    );
    await writePartnerAudit(c, {
      tenantId: u.tenant_id,
      actorUserId: u.user_id,
      action: mfaPending ? "partner_login_mfa_pending" : "partner_login",
      ip: ip ?? null,
    });
  });
  return {
    ok: true,
    sessionToken: token,
    userId: u.user_id,
    tenantId: u.tenant_id,
    partnerId: u.partner_id,
    mfaPending,
  };
}

async function recordFailure(
  u: AuthRow,
  ip: string | null | undefined,
  kind: string,
  opts: { countTowardsLockout?: boolean } = {}
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
        [u.user_id, LOCKOUT_THRESHOLD, String(LOCKOUT_MINUTES)]
      );
      if (rows[0]?.locked) {
        await writePartnerSecurity(c, {
          tenantId: u.tenant_id,
          severity: "medium",
          kind: "partner_account_locked",
          detail: { userId: u.user_id },
        });
      }
    }
    await writePartnerAudit(c, {
      tenantId: u.tenant_id,
      actorUserId: u.user_id,
      action: "partner_login_failure",
      ip: ip ?? null,
      reason: kind,
    });
  });
}

/** Mark the MFA challenge passed for the current session (after verifyTotp/recovery succeeds). */
export async function markSessionMfaPassed(tenantId: string, sessionId: string, userId: string): Promise<boolean> {
  return withTenant({ tenantId }, async (c) => {
    const updated = await c.query(
      `UPDATE partner_sessions s
          SET mfa_passed=true
         FROM partner_users u
        WHERE s.id=$1
          AND s.user_id=$2
          AND s.tenant_id=$3
          AND s.revoked_at IS NULL
          AND u.id=s.user_id
          AND u.credential_version=s.credential_version`,
      [sessionId, userId, tenantId]
    );
    return updated.rowCount === 1;
  });
}

export async function partnerLogout(tenantId: string, sessionId: string): Promise<void> {
  await withTenant({ tenantId }, async (c) => {
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", [sessionId]);
    await writePartnerAudit(c, { tenantId, sessionId, action: "partner_logout" });
  });
}

export async function revokeAllSessions(tenantId: string, userId: string, reason = "revoke_all"): Promise<number> {
  return withTenant({ tenantId }, async (c) => {
    const r = await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [
      userId,
    ]);
    await writePartnerAudit(c, { tenantId, actorUserId: userId, action: "partner_sessions_revoked", reason });
    return r.rowCount ?? 0;
  });
}

// ---------------- password reset (single use, expiring) ----------------
export const RESET_TOKEN_MINUTES = 30;

export async function createPasswordResetToken(tenantId: string, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await withTenant({ tenantId }, async (c) => {
    // Keep issuance and consumption serialised on the user row. A replacement
    // link invalidates every earlier link before the new hash is inserted.
    const user = await c.query("SELECT id FROM partner_users WHERE id=$1 FOR UPDATE", [userId]);
    if (user.rowCount !== 1) throw new Error("Partner user is unavailable for password reset.");
    await c.query("UPDATE partner_password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [
      userId,
    ]);
    await c.query(
      `INSERT INTO partner_password_reset_tokens (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [tenantId, userId, sha256(token), String(RESET_TOKEN_MINUTES)]
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
  // F5: enforce the password policy in the SERVICE layer so every caller shares it, not just the route.
  if (!isValidPartnerPassword(newPassword)) return false;
  const { rows: tRows } = await partnerRuntimeQuery<{ tenant: string | null }>(
    "SELECT partner_reset_token_tenant($1) AS tenant",
    [sha256(token)]
  );
  const tenantId = tRows[0]?.tenant;
  if (!tenantId) return false; // unknown/expired/used token
  const newHash = await hashPassword(newPassword);
  return withTenant({ tenantId }, async (c) => {
    const candidate = await c.query<{ user_id: string }>(
      `SELECT user_id FROM partner_password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`,
      [sha256(token)]
    );
    if (candidate.rows.length !== 1) return false;
    // Same lock order as creation (user first, token second) prevents an
    // issue-versus-consume deadlock and makes the one-live-token rule atomic.
    const user = await c.query("SELECT id FROM partner_users WHERE id=$1 FOR UPDATE", [candidate.rows[0].user_id]);
    if (user.rowCount !== 1) return false;
    const { rows } = await c.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM partner_password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(token)]
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
      `UPDATE partner_users
          SET password_hash=$2, credential_version=credential_version+1,
              password_set_at=now(), failed_login_count=0, locked_until=NULL
        WHERE id=$1`,
      [user_id, newHash]
    );
    await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [user_id]);
    await writePartnerAudit(c, { tenantId, actorUserId: user_id, action: "partner_password_reset_completed" });
    return true;
  });
}
