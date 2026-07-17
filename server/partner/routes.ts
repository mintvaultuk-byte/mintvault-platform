/**
 * Partner Portal — API routes (Phase 1). Mounted under /api/partner only. No admin/staff/VQ/cert
 * routes are ever mounted here (see app.ts + the route-isolation test).
 */
import { Router } from "express";
import {
  partnerLogin, partnerLogout, revokeAllSessions, markSessionMfaPassed,
  createPasswordResetToken, consumePasswordResetToken,
} from "./auth";
import {
  requirePartnerAuth, requirePartnerCapability, setPartnerCookie, clearPartnerCookie, PARTNER_COOKIE,
  requireNotViewOnly, requireNotSensitiveFrozen,
} from "./session";
import { partnerLoginLimiter, partnerMfaLimiter, partnerResetLimiter } from "./rate-limit";
import { withTenant, partnerRuntimeQuery } from "./db";
import { decryptSecret, verifyTotp, recoveryHash, mfaEncryptionConfigured } from "./mfa";
import { writePartnerAudit } from "./audit";

export function partnerApiRouter(): Router {
  const r = Router();

  // ---- auth ----
  r.post("/auth/login", partnerLoginLimiter, async (req, res) => {
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
          [req.partner!.userId, recoveryHash(recoveryCode)],
        );
        return (rc.rowCount ?? 0) === 1;
      }
      if (typeof code === "string") {
        const m = await c.query<{ secret_ref: string }>(
          "SELECT secret_ref FROM partner_mfa_methods WHERE user_id=$1 AND method='totp' AND status='ACTIVE' AND secret_ref IS NOT NULL LIMIT 1",
          [req.partner!.userId],
        );
        if (m.rowCount !== 1) return false;
        return verifyTotp(decryptSecret(m.rows[0].secret_ref), code, Date.now());
      }
      return false;
    });
    if (!ok) {
      res.status(401).json({ error: "invalid code" });
      return;
    }
    await markSessionMfaPassed(req.partner.tenantId, req.partner.sessionId);
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
        const { rows } = await partnerRuntimeQuery<{ user_id: string; tenant_id: string; user_status: string; org_status: string }>(
          "SELECT user_id, tenant_id, user_status, org_status FROM partner_auth_lookup($1)",
          [email],
        );
        if (rows.length === 1 && rows[0].user_status === "ACTIVE" && rows[0].org_status === "ACTIVE") {
          await createPasswordResetToken(rows[0].tenant_id, rows[0].user_id);
        }
      } catch {
        /* swallow — response stays generic */
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

  // ---- session ----
  r.get("/session", (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    // L1: withhold identity + permissions until MFA is complete — a password-only (mfa-pending)
    // session must not disclose the account's full authorization profile.
    if (!req.partner.mfaPassed) {
      res.json({ mfaPassed: false, mfaRequired: true });
      return;
    }
    // no secrets — principal summary only
    res.json({
      userId: req.partner.userId, tenantId: req.partner.tenantId, locationId: req.partner.locationId,
      mfaPassed: req.partner.mfaPassed, viewOnly: req.partner.viewOnly,
      permissions: [...req.partner.permissions],
    });
  });

  // ---- permission-gated foundation reads ----
  r.get("/dashboard", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    const data = await withTenant({ tenantId: req.partner!.tenantId, locationId: req.partner!.locationId }, async (c) => {
      const org = await c.query("SELECT id, legal_name, status, accreditation_level FROM partner_organisations");
      const locs = await c.query("SELECT count(*)::int n FROM partner_locations");
      return { org: org.rows[0] ?? null, locationCount: locs.rows[0]?.n ?? 0 };
    });
    res.json(data);
  });

  r.get("/users", requirePartnerCapability("partner.users.view"), async (req, res) => {
    const rows = await withTenant({ tenantId: req.partner!.tenantId }, async (c) => {
      const u = await c.query("SELECT id, email, status FROM partner_users ORDER BY email");
      return u.rows;
    });
    res.json(rows);
  });

  r.post("/users/:id/revoke-sessions", requirePartnerCapability("partner.sessions.revoke"), requireNotViewOnly, requireNotSensitiveFrozen, async (req, res) => {
    const targetId = String(req.params.id);
    const n = await withTenant({ tenantId: req.partner!.tenantId }, async (c) => {
      // RLS guarantees this only affects same-tenant users.
      const r2 = await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [targetId]);
      await writePartnerAudit(c, { tenantId: req.partner!.tenantId, actorUserId: req.partner!.userId, action: "partner_admin_revoke_sessions", recordType: "partner_user", recordId: targetId });
      return r2.rowCount ?? 0;
    });
    res.json({ ok: true, revoked: n });
  });

  return r;
}

export { PARTNER_COOKIE };
