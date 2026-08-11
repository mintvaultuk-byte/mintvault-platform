/**
 * Partner Portal — API routes (Phase 1). Mounted under /api/partner only. No admin/staff/VQ/cert
 * routes are ever mounted here (see app.ts + the route-isolation test).
 */
import { Router } from "express";
import {
  partnerLogin,
  partnerLogout,
  revokeAllSessions,
  markSessionMfaPassed,
  createPasswordResetToken,
  consumePasswordResetToken,
} from "./auth";
import {
  requirePartnerAuth,
  requirePartnerCapability,
  setPartnerCookie,
  clearPartnerCookie,
  PARTNER_COOKIE,
  requireNotViewOnly,
  requireNotSensitiveFrozen,
} from "./session";
import {
  partnerLoginIpLimiter,
  partnerLoginLimiter,
  partnerMfaLimiter,
  partnerResetLimiter,
  partnerLocationSwitchLimiter,
  partnerInviteLimiter,
  partnerTeamMutationLimiter,
} from "./rate-limit";
import { withTenant, partnerRuntimeQuery } from "./db";
import { auditInOwnTxn } from "./audit";
import { recoveryHash, mfaEncryptionConfigured } from "./mfa";
import { resetDeliveryConfigured, deliverResetToken } from "./delivery";
import { switchLocation } from "./location";
import { acceptPartnerInvitation } from "./partner-management-service";
import { toG5Error, g5StatusFor, requireReason, optionalReason, G5RequestError } from "./partner-management-errors";
import {
  changeTeamMemberRole,
  deliverTeamInvitationAfterCommit,
  inviteTeamMember,
  listTeamMembers,
  requirePortalTeamRole,
  resendTeamInvitation,
  revokeTeamInvitation,
  revokeTeamMemberSessions,
  setTeamMemberStatus,
} from "./team-service";
import {
  mfaEnrolStart,
  mfaEnrolConfirm,
  mfaEnrolRestart,
  mfaEnrolCancel,
  mfaRegenerateRecovery,
  mfaDisable,
  verifyActiveTotpNoReplay,
  getMfaStatus,
} from "./mfa-service";
import {
  getPartnerCreditView,
  getPartnerPortalContext,
  listOwnPartnerSessions,
  revokeOwnPartnerSession,
} from "./portal-view-service";

function sendPartnerTeamError(res: import("express").Response, err: unknown): void {
  const g5 = toG5Error(err);
  res.status(g5StatusFor(g5.code)).json({ error: { code: g5.code, message: g5.message } });
}

function noStore(res: import("express").Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

/**
 * Denial codes worth an audit row. A denied privilege escalation is the single most useful
 * forensic signal this surface produces, so it must survive the rollback that the denial itself
 * triggers — every team mutation runs inside withTenant(), whose catch issues ROLLBACK, so a row
 * written on that client is always erased. auditInOwnTxn() opens its own transaction on a fresh
 * pooled client AFTER the mutation transaction has already rolled back, so the row commits.
 */
const AUDITED_DENIAL_CODES = new Set([
  "FORBIDDEN",
  "FINAL_OWNER_REQUIRED",
  "INVALID_STATUS_TRANSITION",
  "DUPLICATE_PARTNER_USER",
  "PARTNER_USER_NOT_FOUND",
  "PARTNER_UNAVAILABLE",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
]);

/**
 * Record a denied team-management action. Never allowed to change the response: an audit failure
 * is logged, not surfaced, so a denial can never become a 500.
 */
async function auditTeamDenial(req: import("express").Request, action: string, err: unknown): Promise<void> {
  const g5 = toG5Error(err);
  if (!AUDITED_DENIAL_CODES.has(g5.code)) return;
  const principal = req.partner;
  if (!principal?.tenantId) return; // no authenticated tenant context → nothing to attribute it to
  try {
    await auditInOwnTxn({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      action: `${action}_denied`,
      recordType: "partner_user",
      recordId: typeof req.params?.id === "string" ? req.params.id : null,
      ip: req.ip ?? null,
      correlationId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null,
      reason: g5.code, // stable code only — never the target email or any free text
    });
  } catch (auditErr) {
    console.error("[partner team] denial audit write failed:", (auditErr as Error).message);
  }
}

/** Send the denial response and durably record it. */
function denyTeamAction(
  req: import("express").Request,
  res: import("express").Response,
  action: string,
  err: unknown
): void {
  sendPartnerTeamError(res, err);
  void auditTeamDenial(req, action, err);
}

export function partnerApiRouter(): Router {
  const r = Router();

  // ---- auth ----
  // SHADOWED DUPLICATE — the served implementation is server/partner/public-routes.ts, kept ahead of
  // this router by the registration-order invariant at server/routes.ts:2798. It carries the SAME
  // limiter pair anyway, in the SAME order, so the protection does not depend on that invariant
  // holding: partnerLoginIpLimiter (IP-only, always applied) must bind BEFORE partnerLoginLimiter,
  // whose key includes the caller-supplied `email` and on its own hands one source IP a fresh
  // budget per address it tries. If this route ever stops being shadowed it is still bounded.
  //
  // GATE DIFFERENCE, stated exactly: this router is NOT ungated. partnerPortalRouter
  // (server/partner/mount.ts) composes it behind requirePartnerRuntimeConfig, requireDefinerModel,
  // requireNoEmergencyStop and requirePortalEnabled, so the emergency stop and partner_portal_enabled
  // both apply here too. The ONE gate this handler lacks is the per-route partner_login_enabled
  // check that public-routes.ts performs before authenticating.
  r.post("/auth/login", partnerLoginIpLimiter, partnerLoginLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const result = await partnerLogin(email, password, req.ip);
    if (!result.ok) {
      // generic — never disclose which of unknown/invalid/locked/suspended (except a soft MFA hint)
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    setPartnerCookie(res, result.sessionToken!);
    // RESPONSE SHAPE IS DELIBERATELY UNCHANGED. Whether the outstanding second step is enrolment or
    // a code challenge is reported by GET /session (`mfaEnrolmentRequired`), which the client calls
    // immediately after login anyway. Keeping that bit off this response avoids widening the
    // login contract that tests/partner-login-rate-limit-integration.test.ts asserts exactly.
    res.json({ ok: true, mfaRequired: !!result.mfaPending });
  });

  r.post("/auth/mfa", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    if (req.partner.mfaPassed) {
      res.json({ ok: true });
      return;
    }
    if (!mfaEncryptionConfigured()) {
      res.status(503).json({ error: "mfa unavailable" }); // fail closed with no key
      return;
    }
    const { code, recoveryCode } = req.body ?? {};
    const ok = await withTenant({ tenantId: req.partner.tenantId }, async (c) => {
      if (typeof recoveryCode === "string" && recoveryCode) {
        const rc = await c.query(
          "UPDATE partner_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id",
          [req.partner!.userId, recoveryHash(recoveryCode)]
        );
        return (rc.rowCount ?? 0) === 1;
      }
      if (typeof code === "string") {
        return verifyActiveTotpNoReplay(c, req.partner!.userId, code); // F3: replay-protected
      }
      return false;
    });
    if (!ok) {
      res.status(401).json({ error: "invalid code" });
      return;
    }
    if (!(await markSessionMfaPassed(req.partner.tenantId, req.partner.sessionId, req.partner.userId))) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    res.json({ ok: true });
  });

  r.post("/auth/logout", async (req, res) => {
    if (req.partner) await partnerLogout(req.partner.tenantId, req.partner.sessionId);
    clearPartnerCookie(res);
    res.json({ ok: true });
  });

  r.post("/auth/revoke-all", requirePartnerAuth, requireNotSensitiveFrozen, async (req, res) => {
    const n = await revokeAllSessions(req.partner!.tenantId, req.partner!.userId);
    clearPartnerCookie(res);
    res.json({ ok: true, revoked: n });
  });

  r.post("/auth/password-reset/request", partnerResetLimiter, async (req, res) => {
    const { email } = req.body ?? {};
    // Always generic (never reveal account existence). If the email resolves to a single active
    // user, mint a single-use token, delivered OUT-OF-BAND (email) — never returned in the response.
    if (typeof email === "string" && email) {
      try {
        const { rows } = await partnerRuntimeQuery<{
          user_id: string;
          tenant_id: string;
          user_status: string;
          org_status: string;
        }>("SELECT user_id, tenant_id, user_status, org_status FROM partner_auth_lookup($1)", [email]);
        if (
          rows.length === 1 &&
          rows[0].user_status === "ACTIVE" &&
          rows[0].org_status === "ACTIVE" &&
          resetDeliveryConfigured()
        ) {
          const token = await createPasswordResetToken(rows[0].tenant_id, rows[0].user_id);
          await deliverResetToken(email, token); // out-of-band; token never returned in the response
        }
      } catch {
        /* swallow — response stays generic regardless */
      }
    }
    res.json({ ok: true });
  });

  r.post("/auth/password-reset/consume", partnerResetLimiter, async (req, res) => {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== "string" || typeof newPassword !== "string" || newPassword.length < 10) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    // tenant is derived from the token server-side (L6) — no client tenantId.
    const ok = await consumePasswordResetToken(token, newPassword);
    res.status(ok ? 200 : 400).json({ ok });
  });

  r.post("/invitations/accept", partnerResetLimiter, async (req, res) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid invitation" });
      return;
    }
    const result = await acceptPartnerInvitation(token, password);
    if (!result.ok) {
      res.status(400).json({ error: "invalid invitation" });
      return;
    }
    res.json({ ok: true });
  });

  // ---- session ----
  r.get("/session", async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    // L1: withhold identity + permissions until MFA is complete — a password-only (mfa-pending)
    // session must not disclose the account's full authorization profile.
    //
    // P0-E: the ONE extra bit added here is `mfaEnrolmentRequired` — whether the outstanding second
    // step is enrolment or a code challenge. Without it the Portal cannot route a first owner to the
    // only step they can complete. It is not an authorization profile, it is reachable only with a
    // valid session cookie, and the user could infer it anyway by calling /mfa/enrol.
    const status = await getMfaStatus({ tenantId: req.partner.tenantId, userId: req.partner.userId });
    if (!req.partner.mfaPassed) {
      res.json({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: status.enrolmentRequired });
      return;
    }
    try {
      const context = await getPartnerPortalContext(req.partner);
      // no secrets — principal, MFA posture and shop-facing identity summary only.
      // The four mfa* fields come from origin/main (P0-E) and the ...context spread from this
      // branch; their key sets are disjoint. The mfa* fields are listed AFTER the spread so a
      // future portal-context key can never silently override the authoritative MFA posture.
      res.json({
        userId: req.partner.userId,
        tenantId: req.partner.tenantId,
        locationId: req.partner.locationId,
        mfaPassed: req.partner.mfaPassed,
        viewOnly: req.partner.viewOnly,
        permissions: [...req.partner.permissions],
        ...context,
        mfaRequired: status.required,
        mfaEnrolled: status.enrolled,
        mfaEnrolmentRequired: status.enrolmentRequired,
        recoveryCodesRemaining: status.recoveryCodesRemaining,
      });
    } catch {
      res.status(503).json({ error: { code: "portal_context_unavailable", message: "Shop details are unavailable." } });
    }
  });

  r.get("/credits", requirePartnerCapability("partner.credits.view"), async (req, res) => {
    try {
      res.json(await getPartnerCreditView(req.partner!));
    } catch (err) {
      console.error("[partner credits] projection failed:", (err as Error).message);
      res
        .status(500)
        .json({ error: { code: "credit_view_unavailable", message: "Credit information is unavailable." } });
    }
  });

  r.get("/sessions", requirePartnerAuth, async (req, res) => {
    try {
      res.json({ sessions: await listOwnPartnerSessions(req.partner!) });
    } catch (err) {
      console.error("[partner sessions] list failed:", (err as Error).message);
      res.status(500).json({ error: { code: "session_view_unavailable", message: "Sessions are unavailable." } });
    }
  });

  r.post("/sessions/:id/revoke", requirePartnerAuth, async (req, res) => {
    try {
      const revoked = await revokeOwnPartnerSession(req.partner!, String(req.params.id));
      if (!revoked) {
        res.status(404).json({ error: { code: "session_not_found", message: "Session not found." } });
        return;
      }
      res.json({ ok: true, current: String(req.params.id) === req.partner!.sessionId });
    } catch (err) {
      console.error("[partner sessions] revoke failed:", (err as Error).message);
      res.status(500).json({ error: { code: "session_revoke_failed", message: "The session could not be revoked." } });
    }
  });

  // ---- permission-gated foundation reads ----
  r.get("/dashboard", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    const data = await withTenant(
      { tenantId: req.partner!.tenantId, locationId: req.partner!.locationId },
      async (c) => {
        const org = await c.query("SELECT id, legal_name, status, accreditation_level FROM partner_organisations");
        const locs = await c.query("SELECT count(*)::int n FROM partner_locations");
        return { org: org.rows[0] ?? null, locationCount: locs.rows[0]?.n ?? 0 };
      }
    );
    res.json(data);
  });

  r.get("/users", requirePartnerCapability("partner.users.view"), async (req, res) => {
    try {
      const rows = await withTenant({ tenantId: req.partner!.tenantId }, (c) => listTeamMembers(c));
      res.json({ users: rows });
    } catch (err) {
      sendPartnerTeamError(res, err);
    }
  });

  r.post(
    "/users",
    partnerInviteLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const reason = optionalReason(req.body?.reason, "Partner team member invited");
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          inviteTeamMember(c, req.partner!, req.body, reason)
        );
        await deliverTeamInvitationAfterCommit(req.partner!.tenantId, result.invitationId, result.delivery);
        const { delivery: _delivery, ...safeResult } = result;
        res.json({ ok: true, result: safeResult });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_invited", err);
      }
    }
  );

  r.post(
    "/users/:id/resend-invitation",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const reason = optionalReason(req.body?.reason, "Partner invitation resent");
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          resendTeamInvitation(c, req.partner!, String(req.params.id), reason)
        );
        await deliverTeamInvitationAfterCommit(req.partner!.tenantId, result.invitationId, result.delivery);
        const { delivery: _delivery, ...safeResult } = result;
        res.json({ ok: true, result: safeResult });
      } catch (err) {
        denyTeamAction(req, res, "partner_invitation_resent", err);
      }
    }
  );

  r.post(
    "/users/:id/revoke-invitation",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const reason = requireReason(req.body?.reason);
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          revokeTeamInvitation(c, req.partner!, String(req.params.id), reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_invitation_revoked", err);
      }
    }
  );

  r.post(
    "/users/:id/role",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const role = requirePortalTeamRole(req.body?.role);
        const reason = requireReason(req.body?.reason);
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          changeTeamMemberRole(c, req.partner!, String(req.params.id), role, reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_role_changed", err);
      }
    }
  );

  r.post(
    "/users/:id/status",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const status = req.body?.status;
        if (status !== "ACTIVE" && status !== "SUSPENDED" && status !== "REVOKED") {
          throw new G5RequestError("VALIDATION_ERROR", "Unknown team member status.");
        }
        const reason = requireReason(req.body?.reason);
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          setTeamMemberStatus(c, req.partner!, String(req.params.id), status, reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_status_changed", err);
      }
    }
  );

  // Locations the current user may operate at — org-wide roles (owner/manager/finance-viewer) see
  // every ACTIVE location; everyone else sees only their explicit partner_user_locations
  // assignments. Powers the Portal's location switcher (Increment A) and the "select a location"
  // step of the submission wizard (Increment B) — read-only, no client-supplied tenant/org filter.
  r.get("/locations", requirePartnerCapability("partner.location.view"), async (req, res) => {
    const rows = await withTenant({ tenantId: req.partner!.tenantId }, async (c) => {
      if (req.partner!.orgWide) {
        const l = await c.query("SELECT id, name, status FROM partner_locations WHERE status='ACTIVE' ORDER BY name");
        return l.rows;
      }
      const l = await c.query(
        `SELECT pl.id, pl.name, pl.status FROM partner_locations pl
           JOIN partner_user_locations pul ON pul.location_id = pl.id
          WHERE pul.user_id = $1 AND pl.status = 'ACTIVE' ORDER BY pl.name`,
        [req.partner!.userId]
      );
      return l.rows;
    });
    res.json(rows);
  });

  // ---- location switching (Item 2) ----
  r.post("/session/location", partnerLocationSwitchLimiter, requirePartnerAuth, async (req, res) => {
    const { locationId } = req.body ?? {}; // any submitted partner/tenant id is ignored
    if (typeof locationId !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const result = await switchLocation(req.partner!, locationId);
    if (!result.ok) {
      res.status(result.reason === "not_assigned" ? 403 : 404).json({ error: result.reason });
      return;
    }
    res.json({ ok: true, locationId });
  });

  // ---- MFA enrolment (Item 3) ----
  // enrol/confirm are reachable by an mfa-pending session (a user with mfa_required but no method yet).
  r.post("/mfa/enrol", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const { password, code, recoveryCode } = req.body ?? {};
    if (typeof password !== "string") {
      res.status(400).json({ error: "elevated verification required" });
      return;
    }
    const out = await mfaEnrolStart(
      {
        tenantId: req.partner.tenantId,
        userId: req.partner.userId,
        sessionId: req.partner.sessionId,
        sessionMfaPassed: req.partner.mfaPassed,
      },
      password,
      // F3: only consulted when an ACTIVE authenticator already exists (i.e. this is a REPLACEMENT).
      // First-time enrolment is unaffected and still needs the password alone.
      {
        code: typeof code === "string" ? code : undefined,
        recoveryCode: typeof recoveryCode === "string" ? recoveryCode : undefined,
      }
    );
    if (!out.ok) {
      const status =
        out.reason === "encryption_unavailable"
          ? 503
          : out.reason === "requires_current_factor" || out.reason === "second_factor_required"
            ? 403
            : 401;
      res.status(status).json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({
      ok: true,
      enrolmentId: out.enrolmentId,
      secret: out.secret,
      otpauthUri: out.otpauthUri,
      expiresAt: out.expiresAt,
    }); // shown once; never logged
  });

  r.post("/mfa/restart", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    // Elevated verification, same as /mfa/enrol. Without it, anyone reaching a bootstrap-state
    // user's browser could mint themselves a fresh authenticator from the QR screen.
    const { password } = req.body ?? {};
    if (typeof password !== "string" || password.length === 0) {
      res.status(401).json({ error: "unauthorised" });
      return;
    }
    const out = await mfaEnrolRestart(
      {
        tenantId: req.partner.tenantId,
        userId: req.partner.userId,
        sessionId: req.partner.sessionId,
        sessionMfaPassed: req.partner.mfaPassed,
      },
      password
    );
    if (!out.ok) {
      const status =
        out.reason === "encryption_unavailable" ? 503 : out.reason === "requires_current_factor" ? 403 : 401;
      res.status(status).json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({
      ok: true,
      enrolmentId: out.enrolmentId,
      secret: out.secret,
      otpauthUri: out.otpauthUri,
      expiresAt: out.expiresAt,
    });
  });

  r.post("/mfa/cancel", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    await mfaEnrolCancel({
      tenantId: req.partner.tenantId,
      userId: req.partner.userId,
      sessionId: req.partner.sessionId,
    });
    clearPartnerCookie(res);
    res.json({ ok: true });
  });

  r.post("/mfa/confirm", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const { code, enrolmentId } = req.body ?? {};
    const normalizedCode = typeof code === "string" ? code.replace(/\s/g, "") : "";
    if (typeof enrolmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(enrolmentId) || !/^\d{6}$/.test(normalizedCode)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const out = await mfaEnrolConfirm(
      {
        tenantId: req.partner.tenantId,
        userId: req.partner.userId,
        sessionId: req.partner.sessionId,
        sessionMfaPassed: req.partner.mfaPassed,
      },
      enrolmentId,
      normalizedCode
    );
    if (!out.ok) {
      res.status(out.reason === "requires_current_factor" ? 403 : 400).json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({ ok: true, recoveryCodes: out.recoveryCodes }); // shown once
  });

  r.post("/mfa/recovery-codes/regenerate", requirePartnerAuth, partnerMfaLimiter, async (req, res) => {
    const { password, code, recoveryCode } = req.body ?? {};
    if (typeof password !== "string") {
      res.status(400).json({ error: "elevated verification required" });
      return;
    }
    const out = await mfaRegenerateRecovery(
      {
        tenantId: req.partner!.tenantId,
        userId: req.partner!.userId,
        sessionMfaPassed: req.partner!.mfaPassed,
      },
      password,
      // C: only consulted when an ACTIVE authenticator already exists. Minting a fresh recovery set
      // for an enrolled user is a credential-class change and now demands the same current-factor
      // proof as replacing the authenticator. Bootstrap (no active method) is unaffected.
      {
        code: typeof code === "string" ? code : undefined,
        recoveryCode: typeof recoveryCode === "string" ? recoveryCode : undefined,
      }
    );
    if (!out.ok) {
      res
        .status(out.reason === "requires_current_factor" || out.reason === "second_factor_required" ? 403 : 401)
        .json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({ ok: true, recoveryCodes: out.recoveryCodes }); // shown once; never logged
  });

  r.post("/mfa/disable", requirePartnerAuth, partnerMfaLimiter, async (req, res) => {
    const { password, code, recoveryCode } = req.body ?? {};
    if (typeof password !== "string") {
      res.status(400).json({ error: "elevated verification required" });
      return;
    }
    const out = await mfaDisable({ tenantId: req.partner!.tenantId, userId: req.partner!.userId }, password, {
      code,
      recoveryCode,
    });
    if (!out.ok) {
      res.status(out.reason === "second_factor_required" ? 400 : 401).json({ error: out.reason });
      return;
    }
    clearPartnerCookie(res); // sessions revoked on disable
    res.json({ ok: true });
  });

  r.post(
    "/users/:id/revoke-sessions",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.sessions.revoke"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const reason = optionalReason(req.body?.reason, "Partner team member sessions revoked");
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          revokeTeamMemberSessions(c, req.partner!, String(req.params.id), reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_sessions_revoked", err);
      }
    }
  );

  return r;
}

export { PARTNER_COOKIE };
