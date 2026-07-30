/**
 * WP-16 — partner LOGIN rate-limit keying, end to end through the PRODUCTION-mounted public routes
 * on a disposable PostgreSQL 17 database.
 *
 * REGRESSION UNDER TEST (security review finding F2): `POST /api/partner/auth/login` was gated only
 * by partnerLoginLimiter, whose key includes the caller-supplied `email`. One source IP therefore
 * earned a fresh 10-attempt budget for every distinct address it submitted, so password spraying
 * from a single host was unbounded. partnerLoginIpLimiter (IP-only, always applied) now binds in
 * front of it. "throttles one IP rotating distinct emails" below is the test that must FAIL if that
 * limiter is removed or its key is put back to an email-derived one.
 *
 * Gated on the same wired env pair as tests/partner-public-routes-integration.test.ts
 * (PARTNER_PUBLIC_RT_ADMIN / PARTNER_PUBLIC_RT_RUNTIME) but provisions its OWN database, so it never
 * shares state with that suite or with tests/partner-reset-delivery-integration.test.ts.
 *
 * The rate-limit store is an in-process singleton shared by every test in this file, so each test
 * below drives its OWN client IP and its buckets are independent of the others'.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
} from "./helpers/partner-realistic-db";

const SEED_ADMIN = process.env.PARTNER_PUBLIC_RT_ADMIN;
const SEED_RUNTIME = process.env.PARTNER_PUBLIC_RT_RUNTIME;
const isLocal = !!SEED_ADMIN && !!SEED_RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(SEED_ADMIN);

const OWN_DB = "mintvault_partner_login_rl";
const APP_ROLE = "partner_login_rl_app_test";
const APP_PASSWORD = "synthetic";

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const A = "cc31cc31-0000-0000-0000-000000000001";
const USER = "cc31cc31-0000-0000-0000-0000000000a1";
const MFA_USER = "cc31cc31-0000-0000-0000-0000000000a2";
const USER_EMAIL = "login-rl-user@example.test";
const MFA_EMAIL = "login-rl-mfa@example.test";
const UNKNOWN_EMAIL = "login-rl-nobody@example.test";
const PASSWORD = "login-rl-password-1";

// The limiters' configured budgets, restated here so the expectations below are explicit about what
// they are proving rather than looping until something happens.
const IP_MAX = 30; // partnerLoginIpLimiter — per IP, 15 min
const ACCOUNT_MAX = 10; // partnerLoginLimiter — per (email, IP), 15 min

/**
 * FAIL CLOSED IN CI.
 *
 * The DB-backed block below gates on a loopback URL pair so a developer without a local PostgreSQL
 * still gets a green run. That gate is a LOCAL convenience only: in CI a missing variable must be a
 * hard failure, because a silently-skipped suite is exactly how the Partner Master Dashboard and
 * Partner User Management coverage sat dormant while reporting green. Copied deliberately from
 * tests/partner-portal-mount-integration.test.ts.
 */
describe("Partner login rate-limit coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(
        isLocal,
        "PARTNER_PUBLIC_RT_ADMIN and PARTNER_PUBLIC_RT_RUNTIME must be set to loopback PostgreSQL " +
          "URLs in CI, or the partner login rate-limit suite does not run at all"
      ).toBe(true);
    }
  });
});

/**
 * Pure key-derivation unit checks. Deliberately OUTSIDE the database gate, so they run on every
 * `npm test` — including a developer machine with no PostgreSQL — and can never be skipped away.
 */
describe("partner rate-limit bucket key derivation", () => {
  it("leaves IPv4 alone and folds IPv4-mapped IPv6 onto the same bucket", async () => {
    const { normalizePartnerRateLimitIp } = await import("../server/partner/rate-limit");
    expect(normalizePartnerRateLimitIp("203.0.113.7")).toBe("203.0.113.7");
    // R2: the same host must not hold two buckets depending on how the socket reported it.
    expect(normalizePartnerRateLimitIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizePartnerRateLimitIp("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizePartnerRateLimitIp("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("collapses an IPv6 address to its /56 prefix so a client cannot rotate within its allocation", async () => {
    const { normalizePartnerRateLimitIp } = await import("../server/partner/rate-limit");
    const a = normalizePartnerRateLimitIp("2001:db8:abcd:0100::1");
    // Same /56, different /64s and different hosts — all one bucket.
    expect(normalizePartnerRateLimitIp("2001:db8:abcd:0100::9999")).toBe(a);
    expect(normalizePartnerRateLimitIp("2001:0db8:abcd:01ff:dead:beef:cafe:0001")).toBe(a);
    expect(normalizePartnerRateLimitIp("2001:db8:abcd:0155::42")).toBe(a);
    // A different /56 is a different bucket — normalisation must not over-aggregate.
    expect(normalizePartnerRateLimitIp("2001:db8:abcd:0200::1")).not.toBe(a);
    expect(normalizePartnerRateLimitIp("2001:db8:abce:0100::1")).not.toBe(a);
    // Zone index is cosmetic, not a second bucket.
    expect(normalizePartnerRateLimitIp("2001:db8:abcd:0100::1%en0")).toBe(a);
  });

  it('never derives the literal "undefined" and never merges distinct clients', async () => {
    const { partnerRateLimitClientKey } = await import("../server/partner/rate-limit");
    type Stub = Parameters<typeof partnerRateLimitClientKey>[0];
    const stub = (ip: unknown, remote?: unknown): Stub =>
      ({ ip, socket: remote === undefined ? undefined : { remoteAddress: remote } }) as unknown as Stub;

    // R2: req.ip absent must NOT stringify to "undefined" and collapse every such request into one
    // shared bucket. It falls back to the socket, then to an explicit "unknown".
    expect(partnerRateLimitClientKey(stub(undefined, "198.51.100.4"))).toBe("198.51.100.4");
    const orphan = partnerRateLimitClientKey(stub(undefined));
    expect(orphan).toBe("unknown");
    expect(orphan).not.toBe("undefined");
    expect(partnerRateLimitClientKey(stub(""))).not.toBe("undefined");
    // Two real clients never share a key.
    expect(partnerRateLimitClientKey(stub("198.51.100.4"))).not.toBe(partnerRateLimitClientKey(stub("198.51.100.5")));
  });
});

(isLocal ? describe : describe.skip)("Partner login rate-limit keying (production routes, real DB)", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";
  const OVERWRITTEN_ENV = ["MINTVAULT_DATABASE_URL", "PARTNER_ADMIN_DATABASE_URL", "PARTNER_DATABASE_URL"] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedEnv = Object.fromEntries(OVERWRITTEN_ENV.map((k) => [k, process.env[k]]));

    // --- provision our OWN database off the wired cluster ---
    const bootstrap = new Client({ connectionString: withDb(SEED_ADMIN!, "postgres") });
    await bootstrap.connect();
    await bootstrap.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [OWN_DB]
    );
    await bootstrap.query(`DROP DATABASE IF EXISTS "${OWN_DB}"`);
    await bootstrap.query(`CREATE DATABASE "${OWN_DB}"`);
    await bootstrap.end();

    const ADMIN_URL = withDb(SEED_ADMIN!, OWN_DB);
    const RUNTIME_URL = (() => {
      const u = new URL(withDb(SEED_RUNTIME!, OWN_DB));
      u.username = APP_ROLE;
      u.password = APP_PASSWORD;
      return u.toString();
    })();

    process.env.MINTVAULT_DATABASE_URL = ADMIN_URL;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_URL;
    process.env.PARTNER_DATABASE_URL = RUNTIME_URL;

    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN_URL, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);

    await admin.query(
      `DO $$ BEGIN CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
       EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(`GRANT partner_runtime TO ${APP_ROLE}`);

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    const { hashPassword } = await import("../server/partner/auth");
    const hash = await hashPassword(PASSWORD);
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'loginRlA','Login RL A','ACTIVE')",
      [A]
    );
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status, password_hash)
       VALUES ($1,'loginRlUser',$2,$2,$3,'ACTIVE',$4)`,
      [USER, A, USER_EMAIL, hash]
    );
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status, password_hash, mfa_required)
       VALUES ($1,'loginRlMfa',$2,$2,$3,'ACTIVE',$4,true)`,
      [MFA_USER, A, MFA_EMAIL, hash]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,u,id FROM partner_roles, unnest(ARRAY[$2::uuid,$3::uuid]) AS u WHERE code='PARTNER_OWNER'",
      [A, USER, MFA_USER]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true)"
    );

    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const app = express();
    // MIRRORS PRODUCTION: server/index.ts:45 sets exactly this. It is what makes req.ip — the key
    // partnerLoginIpLimiter buckets on — resolve through one trusted hop instead of being the raw
    // socket address. Without it this suite would be testing a different app than the one deployed.
    app.set("trust proxy", 1);
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    for (const k of OVERWRITTEN_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  }, 60_000);

  /**
   * `xff` is what the client puts in X-Forwarded-For. Under `trust proxy = 1` Express treats the
   * socket peer as the single trusted hop and takes the RIGHTMOST X-Forwarded-For entry as req.ip —
   * i.e. the value the adjacent proxy appended. Passing a single address here is therefore the
   * faithful simulation of "the trusted proxy saw this client IP".
   */
  const login = (body: unknown, xff?: string) =>
    fetch(`${base}/api/partner/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(xff ? { "x-forwarded-for": xff } : {}),
      },
      body: JSON.stringify(body),
    });

  async function clearLockout(): Promise<void> {
    await admin.query("UPDATE partner_users SET failed_login_count=0, locked_until=NULL WHERE tenant_id=$1", [A]);
  }

  // --- anti-enumeration and MFA: unchanged behaviour, proven from fresh IP buckets ---

  it("returns a byte-identical 401 for an unknown address and a known one with a bad password", async () => {
    await clearLockout();
    const unknown = await login({ email: UNKNOWN_EMAIL, password: "wrong-password-1" }, "198.51.100.10");
    const known = await login({ email: USER_EMAIL, password: "wrong-password-1" }, "198.51.100.10");

    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
    expect(await unknown.text()).toBe(await known.text());
    await clearLockout();
  }, 60_000);

  it("still authenticates a good password and still reports the MFA requirement", async () => {
    await clearLockout();
    const plain = await login({ email: USER_EMAIL, password: PASSWORD }, "198.51.100.11");
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ ok: true, mfaRequired: false });

    const mfa = await login({ email: MFA_EMAIL, password: PASSWORD }, "198.51.100.11");
    expect(mfa.status).toBe(200);
    expect(mfa.headers.get("set-cookie")).toContain("mv.partner.sid=");
    expect(await mfa.json()).toEqual({ ok: true, mfaRequired: true });
    // The session is minted UNPASSED — MFA is still owed before it is worth anything.
    const s = await admin.query<{ mfa_passed: boolean }>(
      "SELECT mfa_passed FROM partner_sessions WHERE user_id=$1 AND revoked_at IS NULL",
      [MFA_USER]
    );
    expect(s.rows.map((r) => r.mfa_passed)).toEqual([false]);
  }, 60_000);

  // --- F2 REGRESSION: the IP bucket must bound spraying regardless of the email submitted ---

  it("throttles one IP rotating distinct emails (the per-account key must not mint fresh budgets)", async () => {
    await clearLockout();
    const IP = "203.0.113.21";
    const seen: number[] = [];
    // Every address is DISTINCT and unknown, so the per-account bucket is on its first hit each
    // time and can never throttle. Only an IP-keyed bucket can stop this loop.
    for (let i = 0; i < IP_MAX + 5; i++) {
      seen.push((await login({ email: `spray-${i}@example.test`, password: "wrong-password-1" }, IP)).status);
    }
    const firstThrottled = seen.indexOf(429);
    expect(firstThrottled).toBeGreaterThanOrEqual(0); // <- fails outright without partnerLoginIpLimiter
    expect(seen.slice(0, firstThrottled).every((s) => s === 401)).toBe(true);
    // Exactly the configured IP budget was spent before the limiter bound, and it stayed bound.
    expect(firstThrottled).toBe(IP_MAX);
    expect(seen.slice(firstThrottled).every((s) => s === 429)).toBe(true);
    // Sanity: this loop rotated far more distinct emails than the per-account budget, confirming
    // the throttle came from the IP bucket and not from the per-account one.
    expect(seen.length).toBeGreaterThan(ACCOUNT_MAX);
  }, 120_000);

  it("does not share a bucket between two different client IPs", async () => {
    await clearLockout();
    const EXHAUSTED = "203.0.113.22";
    const FRESH = "203.0.113.23";
    let last = 0;
    for (let i = 0; i <= IP_MAX; i++) {
      last = (await login({ email: `nat-${i}@example.test`, password: "wrong-password-1" }, EXHAUSTED)).status;
    }
    expect(last).toBe(429);
    // A different source is untouched — the limiter is per-IP, not global.
    const other = await login({ email: "nat-0@example.test", password: "wrong-password-1" }, FRESH);
    expect(other.status).toBe(401);
    // ...and the exhausted IP is still throttled, including for an address it never tried.
    expect((await login({ email: USER_EMAIL, password: PASSWORD }, EXHAUSTED)).status).toBe(429);
  }, 120_000);

  it("resolves req.ip from the trusted hop, so prepended X-Forwarded-For entries cannot mint a bucket", async () => {
    // First, state plainly what `trust proxy = 1` produces, on a throwaway app with no DB in it.
    const probe = express();
    probe.set("trust proxy", 1); // identical to server/index.ts:45
    probe.get("/ip", (req, res) => res.json({ ip: req.ip }));
    const probeServer = http.createServer(probe);
    await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
    const probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
    const seenIp = async (xff: string) =>
      (await (await fetch(`${probeBase}/ip`, { headers: { "x-forwarded-for": xff } })).json()).ip;
    // RIGHTMOST wins: the entry the single trusted hop appended, NOT the attacker's prefix.
    expect(await seenIp("9.9.9.9, 203.0.113.24")).toBe("203.0.113.24");
    expect(await seenIp("1.1.1.1, 2.2.2.2, 203.0.113.24")).toBe("203.0.113.24");
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    // Therefore, varying the prefix cannot escape the bucket on the real login route.
    await clearLockout();
    const CLIENT = "203.0.113.24";
    let last = 0;
    for (let i = 0; i <= IP_MAX; i++) {
      // A different forged prefix AND a different email on every single attempt.
      last = (await login({ email: `forge-${i}@example.test`, password: "wrong-password-1" }, `10.0.0.${i}, ${CLIENT}`))
        .status;
    }
    expect(last).toBe(429);
  }, 120_000);

  /**
   * The protection must NOT depend on registration order.
   *
   * partnerApiRouter (server/partner/routes.ts) still defines its own /auth/login, kept permanently
   * shadowed only by the ordering invariant at server/routes.ts:2798 — registerPartnerPublicRoutes
   * before mountPartnerPortal. That invariant is one line-swap away from being wrong, so this test
   * mounts partnerApiRouter's login route DIRECTLY, on its own app, bypassing public-routes
   * entirely, and proves IP rotation is throttled there too. (Behavioural, not structural: mounting
   * the router in isolation turned out to be practical — that handler reaches partnerLogin without
   * any auth middleware in front of it.)
   *
   * Note the gate difference, stated exactly: this router is NOT ungated — partnerPortalRouter
   * (server/partner/mount.ts) composes it behind requirePartnerRuntimeConfig, requireDefinerModel,
   * requireNoEmergencyStop and requirePortalEnabled. The ONE gate it lacks is the per-route
   * partner_login_enabled check that public-routes.ts performs. Mounting partnerApiRouter directly
   * here therefore bypasses those four mount-level gates deliberately, in order to exercise the
   * handler and its limiters in isolation.
   */
  it("throttles IP rotation on the SHADOWED duplicate route too, so protection does not rely on mount order", async () => {
    await clearLockout();
    const { partnerApiRouter } = await import("../server/partner/routes");
    const shadow = express();
    shadow.set("trust proxy", 1); // identical to server/index.ts:45
    shadow.use(express.json());
    shadow.use("/api/partner", partnerApiRouter());
    const shadowServer = http.createServer(shadow);
    await new Promise<void>((resolve) => shadowServer.listen(0, "127.0.0.1", resolve));
    const shadowBase = `http://127.0.0.1:${(shadowServer.address() as AddressInfo).port}`;

    const IP = "203.0.113.30"; // a bucket no other test in this file has touched
    const seen: number[] = [];
    for (let i = 0; i < IP_MAX + 5; i++) {
      const res = await fetch(`${shadowBase}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": IP },
        body: JSON.stringify({ email: `shadow-spray-${i}@example.test`, password: "wrong-password-1" }),
      });
      seen.push(res.status);
    }
    await new Promise<void>((resolve) => shadowServer.close(() => resolve()));

    const firstThrottled = seen.indexOf(429);
    expect(firstThrottled).toBe(IP_MAX);
    expect(seen.slice(0, firstThrottled).every((s) => s === 401)).toBe(true);
    expect(seen.slice(firstThrottled).every((s) => s === 429)).toBe(true);
  }, 120_000);

  /**
   * R1, end to end over HTTP. Every other simulated client in this file is IPv4, which is exactly
   * why the original suite could not see this: an IPv6 caller owns its whole prefix, so keying on
   * the full 128-bit address let it rotate a fresh bucket per request and bypass the limiter
   * completely. Reverting normalizePartnerRateLimitIp to the identity function fails this test.
   */
  it("throttles an IPv6 client rotating addresses inside its own prefix, and keeps two /56s independent", async () => {
    await clearLockout();
    const PREFIX = "2001:db8:aaaa:01"; // the /56 under attack
    const seen: number[] = [];
    for (let i = 0; i < IP_MAX + 5; i++) {
      // A DIFFERENT source address every time — a different host, and every other request a
      // different /64 — all inside one allocation the attacker already controls.
      const ip = `${PREFIX}${i % 2 ? "55" : "00"}:${(i + 1).toString(16)}::${(i + 1).toString(16)}`;
      seen.push((await login({ email: `v6-spray-${i}@example.test`, password: "wrong-password-1" }, ip)).status);
    }
    const firstThrottled = seen.indexOf(429);
    expect(firstThrottled).toBe(IP_MAX);
    expect(seen.slice(0, firstThrottled).every((s) => s === 401)).toBe(true);
    expect(seen.slice(firstThrottled).every((s) => s === 429)).toBe(true);

    // A genuinely different /56 is a different customer and must be untouched — normalisation must
    // bound the attacker without aggregating unrelated subscribers into one shared bucket.
    const otherSlash56 = await login(
      { email: "v6-neighbour@example.test", password: "wrong-password-1" },
      "2001:db8:aaaa:0200::1"
    );
    expect(otherSlash56.status).toBe(401);
    // ...and so is a different /48.
    const otherSlash48 = await login(
      { email: "v6-stranger@example.test", password: "wrong-password-1" },
      "2001:db8:abcd:0100::1"
    );
    expect(otherSlash48.status).toBe(401);
  }, 120_000);
});
