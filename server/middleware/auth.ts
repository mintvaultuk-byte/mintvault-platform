import type { Request, Response, NextFunction } from "express";
export { requireAdmin } from "../auth";

/**
 * requireAuth — protects user-facing routes.
 * Sets req.userId from session so all downstream handlers use session identity.
 * NEVER read user identity from req.body, req.params, or req.query in protected routes.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "auth_required", message: "Please log in to continue." });
  }
  next();
}
