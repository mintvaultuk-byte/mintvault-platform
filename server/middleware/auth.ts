import type { Request, Response, NextFunction } from "express";
import { destroySessionAndClearCookie } from "../lib/auth-security";
import { loadCustomerSessionAuthority } from "../customer-session-authority";
export { requireAdmin } from "../auth";

/**
 * requireAuth — protects user-facing routes.
 * Refreshes session identity from the live users row so downstream handlers use
 * current, version-checked authority.
 * NEVER read user identity from req.body, req.params, or req.query in protected routes.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authority = await loadCustomerSessionAuthority(req);
    if (!authority) {
      await destroySessionAndClearCookie(req, res);
      return res.status(401).json({ error: "auth_required", message: "Please log in to continue." });
    }
    req.session.userId = authority.userId;
    req.session.userEmail = authority.email;
    return next();
  } catch (err) {
    console.error("[auth] session authority check failed:", err);
    return res.status(503).json({ error: "Authentication service temporarily unavailable." });
  }
}
