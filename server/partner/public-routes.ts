import { Router, type Express } from "express";
import {
  partnerLogin,
  createPasswordResetToken,
  consumePasswordResetToken,
  MIN_PASSWORD_LEN,
  MAX_PASSWORD_LEN,
} from "./auth";
import { setPartnerCookie } from "./session";
import { partnerLoginLimiter, partnerResetLimiter, partnerAcceptLimiter } from "./rate-limit";
import { partnerRuntimeQuery } from "./db";
import { resolveGlobalFlag } from "./flags";
import { acceptPartnerInvitation } from "./partner-management-service";
import { resetDeliveryConfigured, deliverResetToken } from "./delivery";

async function flagEnabled(flag: string): Promise<boolean> {
  return resolveGlobalFlag(flag);
}

export function partnerPublicRouter(): Router {
  const r = Router();

  // Portal-wide kill switch. The unmounted app factory (app.ts:89-103) checked partner_emergency_stop
  // alongside partner_portal_enabled; hosting these routes in the main app must not silently drop it,
  // or flipping the documented global emergency stop would leave public login, password-reset consume
  // and invitation acceptance fully live.
  //
  // Note on failure modes: resolveGlobalFlag swallows errors and returns false, so a DB outage reads
  // the stop flag as "not stopped" and falls through here. That is still fail-closed overall, because
  // the same outage makes every positive gate below (partner_login_enabled / partner_onboarding_enabled)
  // read false too, and each of those 503s. The stop flag is an override on top of an already-closed
  // default, never the only thing holding the surface shut.
  r.use(async (_req, res, next) => {
    if (await resolveGlobalFlag("partner_emergency_stop")) {
      res.status(503).json({ error: "partner access temporarily unavailable" });
      return;
    }
    next();
  });

  r.post("/auth/login", partnerLoginLimiter, async (req, res) => {
    if (!(await flagEnabled("partner_login_enabled"))) {
      res.status(503).json({ error: "partner login unavailable" });
      return;
    }
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const result = await partnerLogin(email, password, req.ip);
    if (!result.ok) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    setPartnerCookie(res, result.sessionToken!);
    res.json({ ok: true, mfaRequired: !!result.mfaPending });
  });

  r.post("/auth/password-reset/request", partnerResetLimiter, async (req, res) => {
    if (!(await flagEnabled("partner_login_enabled"))) {
      res.json({ ok: true });
      return;
    }
    const { email } = req.body ?? {};
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
          await deliverResetToken(email, token);
        }
      } catch {
        /* generic response */
      }
    }
    res.json({ ok: true });
  });

  r.post("/auth/password-reset/consume", partnerResetLimiter, async (req, res) => {
    if (!(await flagEnabled("partner_login_enabled"))) {
      res.status(400).json({ ok: false });
      return;
    }
    const { token, newPassword } = req.body ?? {};
    if (
      typeof token !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < MIN_PASSWORD_LEN ||
      newPassword.length > MAX_PASSWORD_LEN
    ) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const ok = await consumePasswordResetToken(token, newPassword);
    res.status(ok ? 200 : 400).json({ ok });
  });

  r.post("/invitations/accept", partnerAcceptLimiter, async (req, res) => {
    if (!(await flagEnabled("partner_onboarding_enabled"))) {
      res.status(503).json({ error: "partner onboarding unavailable" });
      return;
    }
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

  return r;
}

export function registerPartnerPublicRoutes(app: Express): void {
  app.use("/api/partner", partnerPublicRouter());
}
