/**
 * Partner Portal — session validation + auth middleware (Phase 1).
 *
 * Cookie `mv.partner.sid` (distinct from every existing MintVault cookie). A request is
 * authenticated only if: the session exists, is not revoked, is within its absolute lifetime and
 * idle timeout, its credential_version matches the user's current version (bumped on password reset
 * / revoke-all → instant invalidation), the user is ACTIVE, the org is ACTIVE, and no hard
 * emergency stop applies. Tenant context is derived from the session — never a request payload.
 */
import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { partnerRuntimeQuery, withTenant } from "./db";
import { getUserPermissions } from "./permissions";
import { readEmergencyState, isHardStopped } from "./emergency";

export const PARTNER_COOKIE = "mv.partner.sid";
export const IDLE_MINUTES = 30;

export interface PartnerPrincipal {
  sessionId: string;
  tenantId: string;
  userId: string;
  locationId: string | null;
  mfaPassed: boolean;
  permissions: Set<string>;
  viewOnly: boolean;
  sensitiveDisabled: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      partner?: PartnerPrincipal;
    }
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

interface SessionRow {
  session_id: string;
  tenant_id: string;
  user_id: string;
  location_id: string | null;
  session_cred_version: number;
  mfa_passed: boolean;
  absolute_expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
  user_status: string;
  user_cred_version: number;
  org_status: string;
  location_status: string | null;
}

/** Resolve + validate the current partner session. Returns the principal or null (never throws for a bad cookie). */
export async function resolvePartnerSession(token: string): Promise<PartnerPrincipal | null> {
  if (!token) return null;
  const { rows } = await partnerRuntimeQuery<SessionRow>("SELECT * FROM partner_session_lookup($1)", [sha256(token)]);
  if (rows.length !== 1) return null;
  const s = rows[0];
  const now = Date.now();
  if (s.revoked_at) return null;
  if (new Date(s.absolute_expires_at).getTime() <= now) return null;
  if (now - new Date(s.last_seen_at).getTime() > IDLE_MINUTES * 60_000) return null;
  if (s.session_cred_version !== s.user_cred_version) return null; // password reset / revoke-all
  if (s.user_status !== "ACTIVE" || s.org_status !== "ACTIVE") return null; // suspension → instant stop
  // H3: a session bound to a location fails closed the moment that location is not ACTIVE.
  if (s.location_id && s.location_status !== "ACTIVE") return null;

  // tenant-scoped: refresh idle clock, check emergency, resolve permissions
  return withTenant({ tenantId: s.tenant_id, locationId: s.location_id }, async (c) => {
    const em = await readEmergencyState(c, { tenantId: s.tenant_id, locationId: s.location_id });
    if (isHardStopped(em)) return null; // partner/location frozen → no operation, even with a session
    await c.query("UPDATE partner_sessions SET last_seen_at=now() WHERE id=$1", [s.session_id]);
    const permissions = await getUserPermissions(c, s.user_id);
    return {
      sessionId: s.session_id, tenantId: s.tenant_id, userId: s.user_id, locationId: s.location_id,
      mfaPassed: s.mfa_passed, permissions, viewOnly: em.viewOnly, sensitiveDisabled: em.sensitiveDisabled,
    } satisfies PartnerPrincipal;
  });
}

/** Attach req.partner if a valid session cookie is present (does not reject). */
export async function partnerSessionMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readCookie(req, PARTNER_COOKIE);
    if (token) req.partner = (await resolvePartnerSession(token)) ?? undefined;
  } catch {
    /* fail closed: no principal */
  }
  next();
}

/** Require an authenticated partner principal (MFA-complete). */
export function requirePartnerAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.partner) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  if (!req.partner.mfaPassed) {
    res.status(401).json({ error: "mfa required" });
    return;
  }
  next();
}

/** Require a specific granular permission (verified server-side, never by role name alone). */
export function requirePartnerCapability(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.partner || !req.partner.mfaPassed) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    if (!req.partner.permissions.has(permission)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}

/** Reject writes when the tenant/location is in view-only emergency mode. */
export function requireNotViewOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.partner?.viewOnly) {
    res.status(423).json({ error: "view-only mode" });
    return;
  }
  next();
}

/** Reject sensitive operations when a 'sensitive' emergency freeze is active. */
export function requireNotSensitiveFrozen(req: Request, res: Response, next: NextFunction): void {
  if (req.partner?.sensitiveDisabled) {
    res.status(423).json({ error: "sensitive operations frozen" });
    return;
  }
  next();
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setPartnerCookie(res: Response, token: string): void {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${PARTNER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}${secure ? "; Secure" : ""}`,
  );
}

export function clearPartnerCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${PARTNER_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
