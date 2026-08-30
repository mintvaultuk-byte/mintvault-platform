import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Store } from "express-rate-limit";

export const PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const PUBLIC_AUTH_RATE_LIMIT_MAX = 5;

/**
 * Key public-account authentication attempts on Express's resolved client address.
 *
 * `server/index.ts` trusts exactly one proxy hop, so `req.ip` is the right-most
 * forwarded address supplied by that hop rather than a caller-controlled prefix.
 * `ipKeyGenerator` also collapses IPv6 addresses to a /56 allocation; otherwise a
 * caller can rotate host or /64 addresses inside one prefix to mint fresh buckets.
 */
export function publicAuthRateLimitKey(req: Request): string {
  const address = req.ip || req.socket.remoteAddress || "public-auth-client-unresolved";
  return ipKeyGenerator(address, 56);
}

/** A factory keeps mounted test applications and the production process isolated. */
export function createPublicAuthRateLimit(store: Store, options: { max?: number; message?: string } = {}) {
  return rateLimit({
    windowMs: PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS,
    max: options.max ?? PUBLIC_AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store,
    // Store errors must deny the request. A transient database failure must not
    // mint a fresh per-Machine authentication/mail-abuse budget.
    passOnStoreError: false,
    message: { error: options.message ?? "Too many requests. Please try again in 15 minutes." },
    keyGenerator: publicAuthRateLimitKey,
  });
}
