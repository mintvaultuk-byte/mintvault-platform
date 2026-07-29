/**
 * Super Admin partner-management shell (Phase 1). Lives in the EXISTING MintVault admin app, gated
 * by the existing requireAdmin. It is an INTERNAL control surface — it never authenticates partner
 * users and never grants them access to the admin app. Cross-tenant reads/writes use the privileged
 * admin connection (partnerAdminQuery); suspensions require a reason and write audit + security
 * events. Mounted additively under /api/super-admin/grading-partners.
 */
import { Router, type Express, type Request, type Response } from "express";
import { requireAdmin } from "../auth";
import { partnerAdminQuery } from "./db";
import { PARTNER_FLAGS } from "./flags";
import { g5StatusFor, toG5Error } from "./partner-management-errors";
import { setPartnerUserStatus, type ActorContext } from "./partner-management-service";

async function adminAudit(
  tenantId: string,
  action: string,
  reason: string | null,
  adminEmail: string,
  recordType?: string,
  recordId?: string
) {
  await partnerAdminQuery(
    `INSERT INTO partner_audit_events (tenant_id, action, reason, record_type, record_id, after_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, action, reason, recordType ?? null, recordId ?? null, JSON.stringify({ by: adminEmail })]
  );
}

function actorOf(req: Request): ActorContext {
  const session = req.session as { authUserId?: string; adminEmail?: string };
  return {
    actorUserId: session.authUserId ?? "00000000-0000-0000-0000-000000000000",
    actorEmail: session.adminEmail ?? "admin",
    requestId: String(req.headers["x-request-id"] ?? `legacy-gp-${req.method}-${Date.now()}`),
    idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
  };
}

function sendManagementError(res: Response, err: unknown): void {
  const g5 = toG5Error(err);
  res.status(g5StatusFor(g5.code)).json({ error: g5.message, code: g5.code });
}

export function superAdminPartnerRouter(): Router {
  const r = Router();
  r.use(requireAdmin);

  r.get("/", async (_req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, legal_name, status, accreditation_level, health, created_at FROM partner_organisations ORDER BY created_at DESC"
    );
    res.json(rows);
  });

  r.get("/:partnerId", async (req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, legal_name, status, accreditation_level, health FROM partner_organisations WHERE id=$1",
      [req.params.partnerId]
    );
    if (rows.length !== 1) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(rows[0]);
  });

  r.get("/:partnerId/locations", async (req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, name, status FROM partner_locations WHERE tenant_id=$1 ORDER BY name",
      [req.params.partnerId]
    );
    res.json(rows);
  });

  r.get("/:partnerId/users", async (req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, email, status, mfa_enabled, last_login_at FROM partner_users WHERE tenant_id=$1 ORDER BY email",
      [req.params.partnerId]
    );
    res.json(rows);
  });

  r.get("/:partnerId/sessions", async (req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, user_id, mfa_passed, created_at, absolute_expires_at, revoked_at FROM partner_sessions WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200",
      [req.params.partnerId]
    );
    res.json(rows);
  });

  r.get("/:partnerId/audit", async (req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, action, actor_user_id, reason, created_at FROM partner_audit_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 200",
      [req.params.partnerId]
    );
    res.json(rows);
  });

  r.get("/:partnerId/security", async (req, res) => {
    const { rows } = await partnerAdminQuery(
      "SELECT id, severity, kind, created_at FROM partner_security_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 200",
      [req.params.partnerId]
    );
    res.json(rows);
  });

  // ---- controls (require reason; audited; revoke live sessions where appropriate) ----
  r.post("/:partnerId/suspend", async (req, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "reason required" });
      return;
    }
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    await partnerAdminQuery("UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1", [req.params.partnerId]);
    await partnerAdminQuery("UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL", [
      req.params.partnerId,
    ]);
    await partnerAdminQuery(
      "INSERT INTO partner_security_events (tenant_id, severity, kind) VALUES ($1,'high','partner_suspended')",
      [req.params.partnerId]
    );
    await adminAudit(req.params.partnerId, "partner_suspended", reason, email);
    res.json({ ok: true });
  });

  r.post("/:partnerId/locations/:locationId/suspend", async (req, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "reason required" });
      return;
    }
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    await partnerAdminQuery("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1 AND tenant_id=$2", [
      req.params.locationId,
      req.params.partnerId,
    ]);
    // H3: revoke live sessions bound to the suspended location so it stops immediately.
    await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE location_id=$1 AND revoked_at IS NULL",
      [req.params.locationId]
    );
    await adminAudit(
      req.params.partnerId,
      "partner_location_suspended",
      reason,
      email,
      "partner_location",
      req.params.locationId
    );
    res.json({ ok: true });
  });

  r.post("/:partnerId/users/:userId/suspend", async (req, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "reason required" });
      return;
    }
    try {
      await setPartnerUserStatus(actorOf(req), req.params.partnerId, req.params.userId, "SUSPENDED", reason);
      res.json({ ok: true });
    } catch (err) {
      sendManagementError(res, err);
    }
  });

  // Trusted Super Admin MFA reset (force-disable a user's MFA). Requires a reason; audited; revokes
  // sessions + bumps credential_version. Partner users have NO route to reset another user's MFA.
  r.post("/:partnerId/users/:userId/mfa-reset", async (req, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "reason required" });
      return;
    }
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    await partnerAdminQuery("UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1 AND tenant_id=$2", [
      req.params.userId,
      req.params.partnerId,
    ]);
    await partnerAdminQuery("DELETE FROM partner_recovery_codes WHERE user_id=$1 AND tenant_id=$2", [
      req.params.userId,
      req.params.partnerId,
    ]);
    await partnerAdminQuery(
      "UPDATE partner_users SET mfa_enabled=false, mfa_required=false, credential_version=credential_version+1 WHERE id=$1 AND tenant_id=$2",
      [req.params.userId, req.params.partnerId]
    );
    await partnerAdminQuery("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [
      req.params.userId,
    ]);
    await partnerAdminQuery(
      "INSERT INTO partner_security_events (tenant_id, severity, kind) VALUES ($1,'high','partner_mfa_admin_reset')",
      [req.params.partnerId]
    );
    await adminAudit(req.params.partnerId, "partner_mfa_admin_reset", reason, email, "partner_user", req.params.userId);
    res.json({ ok: true });
  });

  r.post("/:partnerId/revoke-sessions", async (req, res) => {
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    const rr = await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL",
      [req.params.partnerId]
    );
    await adminAudit(req.params.partnerId, "partner_sessions_revoked_admin", null, email);
    res.json({ ok: true, revoked: rr.rowCount ?? 0 });
  });

  r.post("/:partnerId/flags", async (req, res) => {
    const { flag, enabled, locationId } = req.body ?? {};
    if (!PARTNER_FLAGS.includes(flag)) {
      res.status(400).json({ error: "unknown flag" });
      return;
    }
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    // H2: deterministic set — remove any existing row for this exact (tenant, location, flag) then
    // insert one, so resolution can never return a stale prior value and disabling always takes.
    await partnerAdminQuery(
      "DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND location_id IS NOT DISTINCT FROM $3",
      [flag, req.params.partnerId, locationId ?? null]
    );
    await partnerAdminQuery(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES ($1,$2,$3,$4)",
      [req.params.partnerId, locationId ?? null, flag, !!enabled]
    );
    await adminAudit(req.params.partnerId, "partner_flag_set", `${flag}=${!!enabled}`, email);
    res.json({ ok: true });
  });

  r.post("/:partnerId/emergency-stop", async (req, res) => {
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    await partnerAdminQuery(
      "INSERT INTO partner_emergency_controls (tenant_id, scope, frozen, set_by, reason) VALUES ($1,'partner',true,$2,$3)",
      [req.params.partnerId, email, String(req.body?.reason ?? "")]
    );
    await partnerAdminQuery("UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL", [
      req.params.partnerId,
    ]);
    await partnerAdminQuery(
      "INSERT INTO partner_security_events (tenant_id, severity, kind) VALUES ($1,'critical','partner_emergency_stop')",
      [req.params.partnerId]
    );
    await adminAudit(req.params.partnerId, "partner_emergency_stop", String(req.body?.reason ?? ""), email);
    res.json({ ok: true });
  });

  return r;
}

/** Additive registration into the existing MintVault admin app (Phase 1 super-admin control shell). */
export function registerSuperAdminPartnerRoutes(app: Express): void {
  app.use("/api/super-admin/grading-partners", superAdminPartnerRouter());
}
