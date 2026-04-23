import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { requireAdmin } from "../auth";

/**
 * Timing-safe comparison of two strings of any length.
 * Returns false on length mismatch without running the full compare
 * (the length itself isn't secret — the token value is).
 */
function tokensMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Allow a request through if EITHER:
 *   1. it presents a valid X-Scanner-Token matching SCANNER_API_TOKEN, OR
 *   2. it passes the existing admin cookie check (requireAdmin).
 *
 * Intended for endpoints that a long-running scanner daemon calls with a
 * static token, while preserving interactive admin access via the cookie
 * session. Scoped to one endpoint — do NOT apply broadly.
 */
export function requireScannerOrAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.SCANNER_API_TOKEN;
  const provided = req.header("x-scanner-token");

  if (expected && provided && tokensMatch(provided, expected)) {
    console.log("[scan-ingest] auth: scanner-token");
    return next();
  }

  // Tag the cookie path if it will succeed; the actual gate is requireAdmin.
  if (req.session?.isAdmin) {
    console.log("[scan-ingest] auth: cookie");
  }
  return requireAdmin(req, res, next);
}
