import type { Request, Response, NextFunction } from "express";

/**
 * Same-origin (Origin/Referer) CSRF defense for cookie-authenticated,
 * state-changing requests (Phase 2: security/access-control-and-csrf).
 *
 * The session cookie is SameSite=lax, which already blocks most cross-site
 * cookie attachment; this is defense-in-depth on top of it. A forged request
 * from a malicious site that DOES ride the cookie will carry that site's Origin
 * (browsers always attach Origin on cross-site state-changing requests and the
 * attacker page cannot suppress or forge it), so we reject when a present
 * Origin/Referer does not match our own host.
 *
 * Deliberately NON-breaking:
 *   - Safe methods (GET/HEAD/OPTIONS) are never checked.
 *   - Requests with NO Origin and NO Referer pass — non-browser API clients
 *     (curl, server-to-server) are not a browser-CSRF vector. (Absence cannot
 *     be exploited from a browser; the browser would attach Origin.)
 *   - The Stripe webhook (signature-authed, no cookie) and any request carrying
 *     an X-Scanner-Token (custom header — browsers cannot set it cross-site
 *     without a CORS preflight the attacker can't satisfy) are exempt.
 */

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths that authenticate by signature/token rather than the session cookie.
const EXEMPT_PATHS = new Set(["/api/stripe/webhook"]);

function hostOf(urlish: string | undefined): string | null {
  if (!urlish) return null;
  try {
    return new URL(urlish).host.toLowerCase();
  } catch {
    return null; // malformed / "null" origin — cannot verify → treat as cross-site
  }
}

export interface OriginCheckInput {
  method: string;
  origin?: string;
  referer?: string;
  host?: string;
}

/**
 * Pure decision: returns true when the request is a CSRF violation that should
 * be BLOCKED. Exemptions (path, scanner token) are handled by the middleware,
 * not here.
 */
export function isCrossOriginViolation(input: OriginCheckInput): boolean {
  if (!STATE_CHANGING.has(input.method.toUpperCase())) return false;
  const host = (input.host || "").toLowerCase();
  if (!host) return false; // no Host header to compare against — don't block

  // Prefer Origin; fall back to Referer. If neither present, not a browser CSRF.
  if (input.origin) {
    const o = hostOf(input.origin);
    return o !== host;
  }
  if (input.referer) {
    const r = hostOf(input.referer);
    return r !== host;
  }
  return false;
}

export function csrfOriginCheck(req: Request, res: Response, next: NextFunction) {
  if (!STATE_CHANGING.has(req.method.toUpperCase())) return next();
  // req.path strips the query string; normalize trailing nuances are not a concern here.
  if (EXEMPT_PATHS.has(req.path)) return next();
  // Scanner daemon authenticates via a custom header — inherently CSRF-immune.
  if (req.headers["x-scanner-token"]) return next();

  const violation = isCrossOriginViolation({
    method: req.method,
    origin: req.headers["origin"] as string | undefined,
    referer: req.headers["referer"] as string | undefined,
    host: req.headers["host"] as string | undefined,
  });

  if (violation) {
    return res.status(403).json({ error: "Cross-origin request blocked" });
  }
  return next();
}
