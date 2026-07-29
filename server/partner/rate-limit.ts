/**
 * Partner Portal — rate-limit abstraction (Phase 1).
 *
 * A pluggable store interface so the final architecture can be backed by a SHARED store (Postgres/
 * Redis) — the in-memory store here is per-machine and is a LOCAL-ONLY default. INFRASTRUCTURE
 * PREREQUISITE for production: a shared store (documented in the master rollback/infra notes).
 *
 * Fail behaviour is per-endpoint sensitivity: a `failClosed` limiter DENIES when its backing store
 * errors/is unavailable (login, MFA, reset, session, location-switch, super-admin partner controls);
 * a non-failClosed limiter allows through on store failure.
 */
import type { Request, Response, NextFunction } from "express";

export interface RateLimitStore {
  /** Increment the counter for key within the window; returns the current count. Throws if unavailable. */
  hit(key: string, windowMs: number): Promise<number>;
}

/** Local, per-machine store. Not for multi-machine production (documented). */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  async hit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    b.count += 1;
    return b.count;
  }
}

let store: RateLimitStore = new MemoryRateLimitStore();
export function setPartnerRateLimitStore(s: RateLimitStore): void {
  store = s;
}

export interface LimiterOpts {
  name: string;
  windowMs: number;
  max: number;
  failClosed: boolean;
  keyFn?: (req: Request) => string;
}

export function partnerRateLimit(opts: LimiterOpts) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${opts.name}:${opts.keyFn ? opts.keyFn(req) : req.ip}`;
    let count: number;
    try {
      count = await store.hit(key, opts.windowMs);
    } catch {
      if (opts.failClosed) {
        res.status(503).json({ error: "rate limiter unavailable" });
        return;
      }
      next();
      return;
    }
    if (count > opts.max) {
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  };
}

// Canonical Phase 1 limiters (all sensitive → fail closed). L2: sensitive limiters key on BOTH the
// account identifier and the IP, so credential-stuffing across accounts from rotating IPs and
// shared-NAT budget exhaustion are both bounded.
const acct = (req: Request): string => `${(req.body?.email ?? "").toString().toLowerCase()}|${req.ip}`;
export const partnerLoginLimiter = partnerRateLimit({
  name: "partner_login",
  windowMs: 15 * 60_000,
  max: 10,
  failClosed: true,
  keyFn: acct,
});
export const partnerMfaLimiter = partnerRateLimit({
  name: "partner_mfa",
  windowMs: 15 * 60_000,
  max: 20,
  failClosed: true,
});
export const partnerResetLimiter = partnerRateLimit({
  name: "partner_reset",
  windowMs: 15 * 60_000,
  max: 5,
  failClosed: true,
  keyFn: acct,
});
export const partnerLocationSwitchLimiter = partnerRateLimit({
  name: "partner_locswitch",
  windowMs: 60_000,
  max: 30,
  failClosed: true,
});
export const partnerInviteLimiter = partnerRateLimit({
  name: "partner_invite",
  windowMs: 15 * 60_000,
  max: 20,
  failClosed: true,
  keyFn: acct,
});

// Phase 2: submission-mutation limiter. Runs AFTER requirePartnerAuth (so req.partner is set) —
// keys per authenticated user, not per-IP, so it bounds one account's write volume regardless of
// the caller's source IP. Not failClosed: a rate-limit-store outage should not block legitimate
// submission work when the account itself has done nothing suspicious (unlike login/reset/MFA,
// where fail-closed protects against credential attacks specifically).
const userKey = (req: Request): string => req.partner?.userId ?? req.ip ?? "unknown";
export const partnerSubmissionMutationLimiter = partnerRateLimit({
  name: "partner_submission_mutation",
  windowMs: 60_000,
  max: 60,
  failClosed: false,
  keyFn: userKey,
});
