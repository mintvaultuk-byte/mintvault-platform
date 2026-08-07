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
import rateLimit from "express-rate-limit";

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
 * WHAT THIS IS AND IS NOT WORTH, stated precisely: the budget is 30 per quarter hour per source
 * PER MACHINE, because the backing store is the in-process MemoryRateLimitStore (see the file
 * header). Across N machines a sprayer's real ceiling is 30 × N per window, and a deploy or
 * restart clears every bucket. That is still a hard bound where there was none, but it is not a
 * global one, and it does not become one until the shared store this module was designed for is
 * actually provided. Two further known limits, logged rather than fixed: a shared-NAT partner shop
 * shares one bucket, and successful logins consume budget alongside failed ones.
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
/**
 * The bucket key for the SECOND-FACTOR limiters below: the authenticated identity carried by the
 * session cookie, never anything from the request body.
 *
 * Every route these guard runs behind partnerSessionMiddleware (server/partner/mount.ts:154), so
 * `req.partner` is already resolved by the time the limiter executes — resolvePartnerSession has
 * validated the session hash, its credential version, the user's ACTIVE status, the org's status
 * and the emergency state before setting it. The caller therefore cannot choose its own bucket:
 * moving to a different `userId` requires completing a different account's password login.
 *
 * `userId`, deliberately NOT `sessionId`. partnerLogin revokes any prior live session before
 * minting a new one, but an attacker holding the password can still log in repeatedly; keying on
 * the session would hand it a fresh budget per login and bound nothing. The user id survives
 * re-login, so the ceiling holds across the whole attack.
 *
 * The `anon|<ip>` fallback covers the unauthenticated case (no cookie, or a session that failed
 * validation). Those requests are refused 401 by the handler anyway; the fallback exists so they
 * still land in SOME bucket rather than sharing one literal key. This is the same shape actorKey
 * already uses for the team-mutation limiters below.
 */
const mfaActorKey = (req: Request): string => req.partner?.userId ?? `anon|${partnerRateLimitClientKey(req)}`;

/**
 * MFA CHALLENGE, IP bucket. Applied to POST /auth/mfa only (the four /mfa/* management routes now
 * have their own namespace — see partnerMfaManagementLimiter). Value and key are UNCHANGED from
 * the original single limiter; nothing here is loosened.
 */
export const partnerMfaLimiter = partnerRateLimit({
  name: "partner_mfa",
  windowMs: 15 * 60_000,
  max: 20,
  failClosed: true,
});
/**
 * MFA CHALLENGE, per-ACCOUNT bucket — defence in depth, applied IN ADDITION to the IP bucket above
 * (never instead of it), exactly as partnerLoginLimiter layers behind partnerLoginIpLimiter.
 *
 * WHAT THIS FIXES. The challenge previously had ONLY the IP bucket. An attacker holding a phished
 * or credential-stuffed password logs in, receives an mfa-pending session, and then grinds TOTP
 * codes: verifyTotp accepts a ±1 step window, so 3 of 10^6 codes are live at any moment. Twenty
 * guesses from one address is negligible, but the ceiling was PER SOURCE — across a hundred proxy
 * addresses the same victim account absorbed ~2,000 guesses per validity window, and the success
 * probability accumulates. The password was, in effect, the only real factor. This bucket is keyed
 * on the victim rather than the attacker, so rotating addresses no longer buys attempts.
 *
 * 10 per 15 minutes, matching partnerLoginLimiter. It sits deliberately ABOVE the 5-failure MFA
 * lockout in server/partner/auth.ts, so for a genuinely wrong code the LOCKOUT arms first and this
 * bucket is the backstop that also counts successes, replays and malformed bodies — the classes a
 * failure counter cannot see. A legitimate user fumbling one code is nowhere near either.
 *
 * SAME CAVEAT AS EVERY OTHER LIMITER IN THIS FILE: the backing store is the in-process
 * MemoryRateLimitStore, so the real ceiling is 10 per account per window PER MACHINE and a deploy
 * clears it. The account LOCKOUT is the control that is genuinely global, because it is a column
 * in PostgreSQL — that is why this finding is repaired with both and not with a limiter alone.
 */
export const partnerMfaAccountLimiter = partnerRateLimit({
  name: "partner_mfa_acct",
  windowMs: 15 * 60_000,
  max: 10,
  failClosed: true,
  keyFn: mfaActorKey,
});
/**
 * MFA MANAGEMENT (enrol / confirm / recovery-code regenerate / disable).
 *
 * Its OWN namespace, for the reason the partner_reset_request / partner_accept split already
 * documents: these four routes previously shared the single `partner_mfa` IP bucket with the
 * challenge, so the two flows could starve each other outright.
 *
 * Keyed on the AUTHENTICATED ACTOR rather than the source IP, which is the availability half of
 * this repair. All four handlers require a resolved session (enrol/confirm check `req.partner`
 * directly; regenerate/disable sit behind requirePartnerAuth), so the actor is always available
 * for a request that can do anything at all. Under the old IP-only key a partner shop behind one
 * NAT egress shared ONE 20-per-15-minute enrolment budget across all its staff — a rollout day
 * exhausted it by itself, and a co-located actor could deny enrolment to the entire shop by
 * spending it deliberately. Per-actor keying removes both: each member of staff has their own
 * budget and cannot consume anyone else's.
 *
 * This is not a loosening. Enrolment and recovery-code minting already demand the account
 * password (and, for a REPLACEMENT, the current factor) inside mfa-service.ts, so the bucket is
 * not the control that stops an attacker here — it is a flood ceiling. Unauthenticated callers
 * fall back to `anon|<ip>` and are bounded per address as before.
 */
export const partnerMfaManagementLimiter = partnerRateLimit({
  name: "partner_mfa_mgmt",
  windowMs: 15 * 60_000,
  max: 20,
  failClosed: true,
  keyFn: mfaActorKey,
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
  keyFn: acct,
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

// Partner grading bridge. Every grading route performs authorization but none carried a ceiling.
//
// These two use express-rate-limit DIRECTLY rather than the partnerRateLimit wrapper above, and
// that is deliberate. The wrapper is hand-rolled middleware over MemoryRateLimitStore; CodeQL's
// js/missing-rate-limiting query recognises known limiter libraries, not bespoke ones, so with the
// wrapper applied it still reported six HIGH "missing rate limiting" alerts on routes that were
// demonstrably limited at runtime. A security control the scanner cannot see is a control the next
// reviewer has to re-derive by hand, so this uses the shape dashboard-routes.ts already uses and
// that CodeQL does not flag.
//
// Behaviourally equivalent: MemoryRateLimitStore is in-process, and so is express-rate-limit's
// default MemoryStore, so the per-Fly-machine scope is unchanged. The credential-path limiters
// above stay on the wrapper — they need failClosed, which express-rate-limit does not offer, and
// CodeQL does not flag them.
//
// Two ceilings rather than one. Reads are generous because the grading workstation legitimately
// polls the queue and re-fetches a card payload and signed image URLs while an operator works.
// Mutations are tighter: draft saves, submits and edits are human-paced and each performs a
// guarded state transition.
//
// Keyed per authenticated partner user, not per IP, so the ceiling bounds one account's volume
// regardless of source address — matching partnerSubmissionMutationLimiter.
const gradingUserKey = (req: Request): string => req.partner?.userId ?? req.ip ?? "unknown";
export const partnerGradingReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "too many requests" },
  keyGenerator: gradingUserKey,
});

export const partnerGradingMutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "too many requests" },
  keyGenerator: gradingUserKey,
});
