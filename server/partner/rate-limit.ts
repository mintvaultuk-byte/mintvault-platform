/**
 * Partner Portal — rate-limit abstraction (Phase 1).
 *
 * Production installs the shared PostgreSQL store. Until that installation has
 * completed, the default store is deliberately unavailable: sensitive limiters
 * fail closed instead of silently falling back to per-machine counters.
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

/** Secure boot/failure default. Tests may explicitly inject MemoryRateLimitStore. */
export class UnavailableRateLimitStore implements RateLimitStore {
  async hit(): Promise<number> {
    throw new Error("shared partner rate-limit store is not ready");
  }
}

let store: RateLimitStore = new UnavailableRateLimitStore();
let sharedPostgresStoreInstalled = false;

/**
 * General/test injection never satisfies production readiness. In particular,
 * MemoryRateLimitStore must not turn /ready green on a multi-Machine process.
 */
export function setPartnerRateLimitStore(s: RateLimitStore): void {
  store = s;
  sharedPostgresStoreInstalled = false;
}

/** Called only after rate-limit-store-pg has proved the shared relation exists. */
export function installSharedPostgresPartnerRateLimitStore(s: RateLimitStore): void {
  store = s;
  sharedPostgresStoreInstalled = true;
}

/** Fail closed before every installation attempt, including retries after a prior success. */
export function markSharedPostgresPartnerRateLimitStoreUnavailable(): void {
  store = new UnavailableRateLimitStore();
  sharedPostgresStoreInstalled = false;
}

/** Pure, name-safe process-readiness signal; performs no database operation. */
export function partnerSharedRateLimitStoreInstalled(): boolean {
  return sharedPostgresStoreInstalled;
}

export interface LimiterOpts {
  name: string;
  windowMs: number;
  max: number;
  failClosed: boolean;
  keyFn?: (req: Request) => string;
}

/** Expand an IPv6 literal to its 32 lowercase hex digits, or null if it is not parseable. */
function expandIpv6(ip: string): string | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  // A trailing dotted-quad (e.g. 64:ff9b::192.0.2.1) occupies the final TWO groups.
  const withQuad = tail.length ? tail : head;
  const last = withQuad[withQuad.length - 1];
  if (last?.includes(".")) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last);
    if (!m) return null;
    const b = m.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    withQuad.splice(
      withQuad.length - 1,
      1,
      (((b[0] << 8) | b[1]) >>> 0).toString(16),
      (((b[2] << 8) | b[3]) >>> 0).toString(16)
    );
  }
  const groups =
    halves.length === 2 ? head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail) : head;
  if (groups.length !== 8) return null;
  let out = "";
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out += g.toLowerCase().padStart(4, "0");
  }
  return out;
}

/**
 * R1 — normalise a client address BEFORE it becomes part of a bucket key.
 *
 * An IPv4 client has exactly one address, so an IP-keyed bucket bounds it. An IPv6 client does not:
 * the smallest routed allocation is a /64, and residential/mobile ISPs commonly delegate a /56 or
 * larger, so a single attacker can source each request from a different address it already owns.
 * Keying on the full 128-bit address therefore bounds nothing for IPv6 — it is the same
 * "attacker picks the bucket" defect as keying on the request body, just moved into the network
 * layer. Every simulated address in the first version of this suite was IPv4, which is precisely
 * why the tests could not see it.
 *
 * We bucket IPv6 on the /56. /64 would stop only the narrowest case (rotation inside one LAN
 * prefix); /56 also covers an attacker rotating across the /64s of a normal delegated allocation.
 * The residual is an ISP that hands out /48s — such a customer still commands 256 buckets — but
 * that is 2^8 rather than 2^64, and going broader than /56 would start aggregating unrelated
 * subscribers onto one bucket and turn this control into a denial-of-service vector against them.
 *
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) collapses to the plain IPv4 form, so the same host cannot
 * hold two buckets depending on how the socket happened to report it (R2). Zone indices are
 * stripped for the same reason. Anything unparseable is passed through verbatim: it still gets a
 * bucket, it simply is not normalised — never merged into a shared one.
 */
export function normalizePartnerRateLimitIp(raw: string | undefined | null): string {
  if (!raw) return "unknown";
  let ip = raw.trim();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip; // IPv4 (or anything else non-v6) — unchanged
  const hex = expandIpv6(ip);
  if (!hex) return ip;
  // An IPv4-mapped address written in any other form is still that IPv4 host.
  if (hex.startsWith("00000000000000000000ffff")) {
    const v4 = hex.slice(24);
    return [0, 2, 4, 6].map((i) => parseInt(v4.slice(i, i + 2), 16)).join(".");
  }
  const prefix = hex.slice(0, 14); // 56 bits
  return `${prefix.slice(0, 4)}:${prefix.slice(4, 8)}:${prefix.slice(8, 12)}:${prefix.slice(12, 14)}00::/56`;
}

/**
 * The default bucket key for every IP-keyed partner limiter.
 *
 * R2 — `req.ip` can be undefined (no socket address on a synthetic/aborted request). Interpolating
 * that yielded the literal string "undefined", collapsing every such request into ONE shared
 * bucket: one malformed request could then throttle unrelated callers, and a caller who could
 * induce it would share a bucket with everyone else rather than owning one. The fallback chain
 * matches the four sibling call sites (dashboard-routes.ts, flag-admin-routes.ts,
 * partner-management-routes.ts, connector-admin-routes.ts).
 */
export function partnerRateLimitClientKey(req: Request): string {
  return normalizePartnerRateLimitIp(req.ip ?? req.socket?.remoteAddress ?? "unknown");
}

export function partnerRateLimit(opts: LimiterOpts) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${opts.name}:${opts.keyFn ? opts.keyFn(req) : partnerRateLimitClientKey(req)}`;
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
//
// `acct` mixes a REQUEST-BODY value into the bucket key. That is only ever safe as an ADDITIONAL
// bucket sitting behind an IP-only one: on its own it hands the caller a fresh budget for every
// distinct value it submits. See partnerLoginIpLimiter and partnerResetRequestLimiter.
const acct = (req: Request): string => `${(req.body?.email ?? "").toString().toLowerCase()}|${req.ip}`;
/**
 * TRULY per-account key — the identifier ONLY, with no IP component.
 *
 * `acct` above mixes in `req.ip`, which makes it per-(account, IP): an attacker rotating source
 * addresses mints a fresh budget for every address and the targeted account is not protected at all.
 * That defeated the stated purpose of the reset-request account bucket, whose whole job is to stop
 * ONE account being flooded FROM ROTATING IPs (the denial-of-recovery defect).
 *
 * Keying on a request-body value alone is only safe as an ADDITIONAL bucket sitting BEHIND an
 * IP-only limiter — otherwise a caller earns a fresh budget per submitted value. That precondition
 * holds here: partnerResetRequestLimiter (IP-only, normalised to a /56) is always mounted in front.
 */
const acctOnly = (req: Request): string => (req.body?.email ?? "").toString().toLowerCase();
/**
 * Login, IP bucket. ALWAYS applied, and mounted IN FRONT of partnerLoginLimiter (see
 * public-routes.ts) — this is the bucket that actually bounds password spraying.
 *
 * The per-account bucket below keys on `acct`, which includes the caller-supplied `email`. On its
 * own that meant one source IP earned a fresh 10-attempt budget for every distinct address it
 * submitted, so spraying one password across many accounts from a single host was unbounded — the
 * exact defect already fixed on the reset paths (partnerResetLimiter / partnerResetRequestLimiter
 * notes above). Keying on `req.ip` alone removes the escape: nothing in the request body can move
 * the caller to a different bucket.
 *
 * `req.ip` (not a hand-parsed X-Forwarded-For) because server/index.ts sets `trust proxy = 1`, so
 * Express resolves it through exactly one trusted hop. The address is normalised first — see
 * normalizePartnerRateLimitIp; without that an IPv6 caller simply rotates within its own prefix.
 *
 * Its OWN namespace (`partner_login_ip`, not `partner_login`) so the two login buckets can never
 * starve each other, matching the partner_reset_request / partner_reset_request_acct pair.
 *
 * 30 per 15 minutes: deliberately ABOVE the 10-per-account budget so a single legitimate user
 * fumbling their password is still bounded by the per-account bucket first, and a small partner
 * shop behind one egress IP (a few staff, a few typos each) is not locked out.
 *
 * The production budget is fleet-wide because the shared PostgreSQL store is
 * required. Before it is ready, this sensitive limiter returns 503; it never
 * grants a per-Machine fallback budget. A shared-NAT shop still shares one
 * bucket, and successful logins consume budget alongside failed ones.
 */
export const partnerLoginIpLimiter = partnerRateLimit({
  name: "partner_login_ip",
  windowMs: 15 * 60_000,
  max: 30,
  failClosed: true,
});
/**
 * Login, per-account bucket — defence in depth, applied IN ADDITION to the IP bucket above (never
 * instead of it), so one targeted account cannot be ground down from rotating IPs.
 */
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
/**
 * MFA, per-ACCOUNT bucket — defence in depth, applied IN ADDITION to the IP bucket above (never
 * instead of it), exactly as partnerLoginLimiter sits behind partnerLoginIpLimiter.
 *
 * WHY: password authentication has two layers — an IP bucket AND a durable per-account lockout
 * (partner_users.failed_login_count / locked_until). The MFA layer had NEITHER: partnerMfaLimiter
 * declares no keyFn, so it falls through to the normalised client IP with no account component, and
 * a wrong code wrote nothing at all. An attacker who already holds the password (phished or reused)
 * completes /auth/login to obtain an mfa-pending session, then grinds the six-digit code by rotating
 * source addresses — every address earns a fresh 20-attempt budget, and a single delegated IPv6 /48
 * supplies hundreds of them. The account holder sees no lockout and no security event.
 *
 * The key is the SESSION's user id, resolved by partnerSessionMiddleware before any route handler
 * runs — never a request-body value, so nothing the caller sends can move them to a fresh bucket.
 * An unauthenticated caller (no session yet) falls back to the IP key rather than sharing one global
 * bucket, which would let one attacker deny MFA to everyone.
 */
export const partnerMfaAccountLimiter = partnerRateLimit({
  name: "partner_mfa_acct",
  windowMs: 15 * 60_000,
  max: 10,
  failClosed: true,
  keyFn: (req) => req.partner?.userId ?? `anon|${partnerRateLimitClientKey(req)}`,
});
/**
 * Password-reset CONSUME. Keyed on IP only (no keyFn). A consume body carries a token, not an
 * email, so the previous `acct` key collapsed to `partner_reset:|<ip>` for well-formed traffic —
 * but any caller could ALSO supply an arbitrary `email` field and mint itself a fresh bucket per
 * value, making the limit unbounded. Dropping the body-derived key removes that escape entirely.
 * (Same defect class the invitation note at the bottom of this file documents.)
 */
export const partnerResetLimiter = partnerRateLimit({
  name: "partner_reset",
  windowMs: 15 * 60_000,
  max: 5,
  failClosed: true,
});
/**
 * Password-reset REQUEST, IP bucket. Its OWN namespace so reset requests and reset consumes cannot
 * starve each other (see the partnerAcceptLimiter note below for the same reasoning). This bucket
 * ALWAYS applies, so probing many addresses from one source is bounded no matter what email the
 * attacker supplies.
 */
export const partnerResetRequestLimiter = partnerRateLimit({
  name: "partner_reset_request",
  windowMs: 15 * 60_000,
  max: 10,
  failClosed: true,
});
/**
 * Password-reset REQUEST, per-account bucket — defence in depth, applied IN ADDITION to the IP
 * bucket above (never instead of it), so one targeted account cannot be flooded with reset mail
 * from rotating IPs.
 */
export const partnerResetRequestAccountLimiter = partnerRateLimit({
  name: "partner_reset_request_acct",
  windowMs: 15 * 60_000,
  max: 5,
  failClosed: true,
  // acctOnly, NOT acct: keying on (account, IP) meant rotating source addresses each earned a fresh
  // 5-request budget against the SAME account — precisely the flood this bucket is documented to
  // prevent. The IP-only limiter above still bounds per-source abuse.
  keyFn: acctOnly,
});
export const partnerLocationSwitchLimiter = partnerRateLimit({
  name: "partner_locswitch",
  windowMs: 60_000,
  max: 30,
  failClosed: true,
});
/**
 * Team-management mutations. Keyed on the AUTHENTICATED ACTOR, never on the request body — an
 * invite/resend body carries the *target's* email, so keying on it (as `acct` does) hands every
 * probed address its own fresh bucket and bounds nothing. This limiter runs after
 * requirePartnerCapability, so req.partner is always set; the IP fallback only covers the
 * theoretical unauthenticated path.
 */
const actorKey = (req: Request): string => req.partner?.userId ?? `anon|${req.ip}`;
export const partnerInviteLimiter = partnerRateLimit({
  name: "partner_invite",
  windowMs: 15 * 60_000,
  max: 20,
  failClosed: true,
  keyFn: actorKey,
});
/** Resend triggers a real outbound email per call — bound it per actor, not just per invite. */
export const partnerTeamMutationLimiter = partnerRateLimit({
  name: "partner_team_mutation",
  windowMs: 60_000,
  max: 30,
  failClosed: true,
  keyFn: actorKey,
});
/**
 * Public invitation acceptance. Deliberately its OWN bucket namespace: sharing `partner_reset`
 * meant an emailless accept body and an emailless password-reset-consume body collapsed to the same
 * `partner_reset:|<ip>` key, so one office behind a single egress IP got five combined attempts per
 * 15 minutes and either flow could starve the other.
 */
export const partnerAcceptLimiter = partnerRateLimit({
  name: "partner_accept",
  windowMs: 15 * 60_000,
  max: 10,
  failClosed: true,
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
