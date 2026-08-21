/**
 * Super Admin partner-management shell (Phase 1). Lives in the EXISTING MintVault admin app, gated
 * by the existing requireAdmin. It is an INTERNAL control surface — it never authenticates partner
 * users and never grants them access to the admin app. Cross-tenant reads/writes use the privileged
 * admin connection (partnerAdminQuery); suspensions require a reason and write audit + security
 * events. Mounted additively under /api/super-admin/grading-partners.
 */
import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import { requireAdminStepUp } from "../lib/admin-step-up";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import { PARTNER_FLAGS } from "./flags";
import { PUBLIC_DIRECTORY_FLAG } from "./public-presence-service";
import {
  getAdminPublicProfileStatus,
  PublicPublicationError,
  setAdminPublicPublication,
} from "./public-publication-service";
import { getPartnerAdminCapability } from "./admin-capability";
import { G5RequestError, g5StatusFor, toG5Error } from "./partner-management-errors";
import { setPartnerUserStatus, resetPartnerUserMfa, type ActorContext } from "./partner-management-service";
import { adminClientIpRateLimitKey } from "../lib/admin-client-ip";

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

/**
 * Mutation ceiling for this legacy router. /api/super-admin/* sits outside the /api/admin prefix, so
 * it inherits neither adminIpAllowlist nor adminRateLimit — this router previously had no limiter at
 * all, which meant the legacy MFA-reset URL was an unthrottled route to a security-relevant action.
 * Keyed on the same Fly-aware client authority as every protected Admin network control.
 */
const legacyMutationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "Too many operations, please slow down.", code: "RATE_LIMITED" },
  keyGenerator: adminClientIpRateLimitKey,
});

function actorOf(req: Request): ActorContext {
  const session = req.session as { authUserId?: string; adminEmail?: string };
  // Fail rather than attribute a privileged partner mutation to a phantom actor. The previous
  // null-UUID/"admin" fallback meant an MFA reset or account change could be recorded against
  // 00000000-0000-0000-0000-000000000000 with no real identity — an unattributable audit entry for
  // exactly the actions that most need attribution. The canonical partner-management router already
  // throws here; these two must agree.
  if (!session?.authUserId || !session?.adminEmail) {
    throw new G5RequestError("UNAUTHENTICATED", "An identified admin session is required.");
  }
  return {
    actorUserId: session.authUserId,
    actorEmail: session.adminEmail,
    requestId: String(req.headers["x-request-id"] ?? `legacy-gp-${req.method}-${Date.now()}`),
    idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
  };
}

function sendManagementError(res: Response, err: unknown): void {
  const g5 = toG5Error(err);
  res.status(g5StatusFor(g5.code)).json({ error: g5.message, code: g5.code });
}

async function requirePartnerAdminCapability(_req: Request, res: Response, next: () => void): Promise<void> {
  const capability = await getPartnerAdminCapability();
  if (!capability.ok) {
    res.status(503).json({
      error: "Partner Super Admin management is not ready.",
      code: "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE",
    });
    return;
  }
  next();
}

export function superAdminPartnerRouter(): Router {
  const r = Router();
  // requireSuperAdmin, NOT requireAdmin. This legacy router reaches the SAME hardened services as
  // /api/super-admin/partner-management (which has always required Super Admin) — including
  // resetPartnerUserMfa, which disables every MFA method, burns recovery codes and revokes sessions
  // for an arbitrary partner user in an arbitrary tenant. Gating it on plain `requireAdmin` meant any
  // non-super-admin admin session could strip a partner OWNER's second factor cross-tenant, then
  // drive that owner's password reset — full tenant takeover without Super Admin. The two routers
  // must not disagree about who may perform an identical state change.
  r.use(requireSuperAdmin);
  r.use(requirePartnerAdminCapability);

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

  r.get("/:partnerId/public-profile", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      res.json(await getAdminPublicProfileStatus(String(req.params.partnerId)));
    } catch (err) {
      if (err instanceof PublicPublicationError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[partner-publication] admin status failed:", (err as Error)?.message ?? "unknown");
      res.status(503).json({ error: "Public profile status is temporarily unavailable." });
    }
  });

  r.post(
    "/:partnerId/locations/:locationId/publication",
    legacyMutationRateLimit,
    requireAdminStepUp(),
    async (req, res) => {
      try {
        if (typeof req.body?.enabled !== "boolean") {
          res.status(400).json({ error: 'The "enabled" field must be true or false.' });
          return;
        }
        if (
          req.body.enabled &&
          (!Number.isInteger(req.body?.expectedProfileVersion) || req.body.expectedProfileVersion < 1 ||
            !Number.isInteger(req.body?.expectedLocationVersion) || req.body.expectedLocationVersion < 1)
        ) {
          res.status(400).json({
            error: "The exact reviewed profile and location versions are required for publication.",
          });
          return;
        }
        await setAdminPublicPublication({
          tenantId: String(req.params.partnerId),
          locationId: String(req.params.locationId),
          enabled: req.body.enabled,
          expectedProfileVersion: req.body.expectedProfileVersion,
          expectedLocationVersion: req.body.expectedLocationVersion,
          reason: req.body?.reason,
          adminEmail: (req.session as { adminEmail?: string }).adminEmail ?? "unknown-admin",
        });
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof PublicPublicationError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        console.error("[partner-publication] admin mutation failed:", (err as Error)?.message ?? "unknown");
        res.status(503).json({ error: "Public profile publication is temporarily unavailable." });
      }
    }
  );

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
      String(req.params.partnerId),
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
      String(req.params.partnerId),
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

  /**
   * LEGACY Super Admin MFA reset — RETAINED for URL compatibility, but it no longer has its own
   * implementation. It DELEGATES to the single canonical service, exactly as the sibling
   * suspend/reactivate routes above already delegate.
   *
   * WHY IT WAS CONSOLIDATED. The old inline implementation diverged from the hardened path in four
   * security-relevant ways:
   *   1. it set `mfa_required=false`, so the next login minted a fully-authenticated session with a
   *      password alone — the account was left protected by nothing, which is precisely what the
   *      canonical service exists to prevent;
   *   2. it ran five separate autocommit statements, so a mid-sequence failure could leave MFA
   *      disabled but sessions still live;
   *   3. its session revoke was keyed on user_id ALONE, without a tenant predicate;
   *   4. it sat behind no mutation rate limiter.
   * Keeping two implementations meant the hardening could be bypassed by using the older URL.
   *
   * The route is kept rather than deleted because it is an established admin surface with an
   * existing integration-test contract; deleting a working URL is a bigger change than making it
   * correct. Both URLs now produce byte-identical state and exactly one security event.
   */
  r.post("/:partnerId/users/:userId/mfa-reset", legacyMutationRateLimit, requireAdminStepUp(), async (req, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "reason required" });
      return;
    }
    try {
      // String() because adding a middleware to the route signature widens Express's inferred
      // param type to string | string[]; the values are single path segments either way.
      await resetPartnerUserMfa(actorOf(req), String(req.params.partnerId), String(req.params.userId), reason);
      res.json({ ok: true });
    } catch (err) {
      sendManagementError(res, err);
    }
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

  const sensitiveFlagStepUp = requireAdminStepUp();
  const requireSensitiveFlagStepUp = (req: Request, res: Response, next: NextFunction) => {
    const flag = req.body?.flag;
    if (flag === PUBLIC_DIRECTORY_FLAG || flag === "google_partner_presence_enabled") {
      sensitiveFlagStepUp(req, res, next);
      return;
    }
    next();
  };

  r.post("/:partnerId/flags", legacyMutationRateLimit, requireSensitiveFlagStepUp, async (req, res) => {
    const { flag, enabled, locationId } = req.body ?? {};
    if (!PARTNER_FLAGS.includes(flag)) {
      res.status(400).json({ error: "unknown flag" });
      return;
    }
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: 'The "enabled" field must be true or false.' });
      return;
    }
    if (flag === PUBLIC_DIRECTORY_FLAG) {
      res.status(400).json({ error: "This flag is global-only. Use the global Partner flag control." });
      return;
    }
    if (locationId != null) {
      const location = await partnerAdminQuery(
        "SELECT 1 FROM partner_locations WHERE id=$1 AND tenant_id=$2 AND partner_id=$2 LIMIT 1",
        [locationId, req.params.partnerId]
      );
      if (location.rows.length !== 1) {
        // Do not disclose whether the supplied location belongs to another tenant.
        res.status(404).json({ error: "location not found" });
        return;
      }
    }
    const reason = String(req.body?.reason ?? "").trim();
    const email = (req.session as { adminEmail?: string })?.adminEmail ?? "admin";
    // H2: deterministic set — remove any existing row for this exact (tenant, location, flag) then
    // insert one, so resolution can never return a stale prior value and disabling always takes.
    await withPartnerAdminTransaction(async (client) => {
      await client.query(
        "DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND location_id IS NOT DISTINCT FROM $3",
        [flag, req.params.partnerId, locationId ?? null]
      );
      await client.query(
        "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES ($1,$2,$3,$4)",
        [req.params.partnerId, locationId ?? null, flag, enabled]
      );
    });
    await adminAudit(
      String(req.params.partnerId),
      "partner_flag_set",
      reason || `${flag}=${enabled}`,
      email,
      "partner_flag",
      locationId ?? flag
    );
    res.json({ ok: true });
  });

  // AG-3b: emergency stop halts every NEW card for a partner instantly. It is the right tool in a
  // real incident and the wrong one in anybody else's hands.
  r.post("/:partnerId/emergency-stop", requireAdminStepUp(), async (req, res) => {
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
    await adminAudit(String(req.params.partnerId), "partner_emergency_stop", String(req.body?.reason ?? ""), email);
    res.json({ ok: true });
  });

  return r;
}

/**
 * P12 — PARTNER OPERATIONS HEALTH, for Super Admin.
 *
 * WHY A SEPARATE ROUTER. The router above is per-partner and capability-gated for tenant management.
 * This one answers a different question — "is the Partner platform healthy right now, across every
 * tenant" — which is an estate-wide operational read, not a tenant administration action.
 *
 * NO FAKE METRICS. Every number here is a live COUNT over the real tables, computed at request time
 * by the SAME functions the scheduled reconciliation job runs. Nothing is cached, sampled, estimated
 * or derived from a counter that something else is responsible for incrementing — a dashboard whose
 * numbers can drift from the database is worse than no dashboard, because it is believed.
 *
 * STRICTLY READ-ONLY. The redrive is deliberately NOT exposed here. It runs on its own schedule with
 * its own audit trail; a button that silently mutates lifecycle state from a health screen is how an
 * operator repairs something they have not looked at.
 */
export function superAdminPartnerOpsRouter(): Router {
  const r = Router();
  r.use(requireSuperAdmin);

  /**
   * The signals that mean "somebody must do something", in one call.
   *
   * `qaDrift` is the documented split-transaction MEDIUM: an approved certificate whose Card Job
   * never left QA_REVIEW. It is fail-closed (output is refused) and the scheduled job repairs it
   * within 15 minutes, so a NON-ZERO value here is normal only briefly — a number that stays
   * non-zero across ticks means the redrive is refusing, and the audit trail says why.
   */
  r.get("/health", async (_req, res) => {
    try {
      const { detectQaCardJobDrift, detectStuckCardJobs, detectStaleLeases } =
        await import("./card-job-reconciliation");
      const [drift, stuck, stale] = await Promise.all([
        detectQaCardJobDrift(),
        detectStuckCardJobs(),
        detectStaleLeases(),
      ]);
      res.json({
        qaDrift: {
          // `ran: false` is reported rather than silently returning zero — "could not check" and
          // "nothing wrong" are different answers and must never look the same.
          checked: drift.ran,
          skippedReason: drift.skippedReason ?? null,
          count: drift.items.length,
          items: drift.items.slice(0, 50),
        },
        stuckCardJobs: { count: stuck.items.length, items: stuck.items.slice(0, 50) },
        staleLeases: { count: stale.items.length },
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[partner-ops-health] failed:", error instanceof Error ? error.message : error);
      res.status(503).json({ error: "Partner operations health is unavailable." });
    }
  });

  return r;
}

/** Additive registration into the existing MintVault admin app (Phase 1 super-admin control shell). */
export function registerSuperAdminPartnerRoutes(app: Express): void {
  app.use("/api/super-admin/grading-partners", superAdminPartnerRouter());
  // Estate-wide Partner operations health (P12). Read-only; the redrive stays on its schedule.
  app.use("/api/super-admin/partner-ops", superAdminPartnerOpsRouter());
}
