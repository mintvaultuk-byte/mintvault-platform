/**
 * SECOND-FACTOR BRUTE FORCE — runtime proof on a disposable PostgreSQL 17.
 *
 * THE FINDING. `partnerMfaLimiter` was declared with no keyFn, so it fell back to
 * partnerRateLimitClientKey — IP ONLY — and it was the ONLY ceiling on POST /api/partner/auth/mfa.
 * The asymmetry is what makes it a defect rather than a choice: the PASSWORD step is defended on
 * both axes (partnerLoginIpLimiter 30/IP + partnerLoginLimiter 10/account) AND carries a 5-failure
 * account lockout. The SECOND factor — the control that exists precisely to survive a stolen
 * password — had neither an account bucket nor a lockout, and a failed verification returned a bare
 * 401 with no audit row and no security event, so the attack was also invisible.
 *
 * The attack it enabled: an attacker holding a phished or stuffed password logs in, receives an
 * mfa-pending session, and loops the challenge from a proxy pool. verifyTotp accepts a ±1 step
 * window, so 3 of 10^6 codes are live at any instant; 20 guesses per address across ~100 addresses
 * is ~2,000 per validity window, and success accumulates. The in-process MemoryRateLimitStore
 * multiplies that by the machine count.
 *
 * WHAT IS PROVEN HERE, and by what means:
 *
 *   1. THE EXPOSURE, reproduced. The pre-fix middleware chain (IP bucket alone) is mounted in front
 *      of a counting handler and driven from 1 and then 10 rotated addresses against ONE victim.
 *      Attempts scale LINEARLY with address count — 20 and 200 — which is the reviewer's measurement.
 *   2. THE FIX, same probe. With the account bucket added the ceiling is flat: the same 10 addresses
 *      buy no more attempts than one.
 *   3. THE DURABLE CEILING, end to end on the REAL route against the REAL database. Five wrong codes
 *      lock the account; every further attempt is refused REGARDLESS of source address; and the
 *      limiter caps total requests at 10 per window on top of that.
 *   4. LOCKOUT RELEASE, and that a legitimate user is not bricked by one mistyped code.
 *   5. OBSERVABILITY: the failure now writes a partner_audit_events row, and arming the lock writes
 *      a high-severity partner_security_events row.
 *   6. AVAILABILITY: /auth/mfa and the four /mfa/* management routes no longer share one IP bucket,
 *      so a shop cannot exhaust its own enrolment budget by answering code challenges.
 *
 * THE MUTATION. Test 2 is the mutation control: it drives the SAME probe through a chain with the
 * account bucket removed and asserts the flat ceiling. Delete partnerMfaAccountLimiter from that
 * chain (or from the route) and it goes RED with the linear count from test 1.
 *
 * Reproduce (host must be loopback; the database is dropped and recreated):
 *   PARTNER_MFA_BF_RT_ADMIN=postgresql://postgres:postgres@127.0.0.1:55433/mv_mfa_bruteforce \
 *   PARTNER_MFA_BF_RT_RUNTIME=postgresql://partner_app_test_mfa_bf:synthetic@127.0.0.1:55433/mv_mfa_bruteforce \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-mfa-bruteforce-hardening.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Request, Response } from "express";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_MFA_BF_RT_ADMIN;
const RUNTIME = process.env.PARTNER_MFA_BF_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const TENANT = "bf000000-0000-0000-0000-000000000001";
const VICTIM = "bf000000-0000-0000-0000-0000000000a1";
const BYSTANDER = "bf000000-0000-0000-0000-0000000000a2";
const VICTIM_EMAIL = "bf-victim@example.test";
const BYSTANDER_EMAIL = "bf-bystander@example.test";
const PASSWORD = "bf-victim-password-1";

/** Restated from the implementation so the expectations below say what they are proving. */
const MFA_IP_MAX = 20; // partnerMfaLimiter        — per IP, 15 min
const MFA_ACCOUNT_MAX = 10; // partnerMfaAccountLimiter — per account, 15 min
const LOCKOUT_THRESHOLD = 5; // server/partner/auth.ts

describe("Partner MFA brute-force coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_MFA_BF_RT_ADMIN must be a disposable loopback PostgreSQL URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-mfa-bruteforce] skipped: PARTNER_MFA_BF_RT_ADMIN not loopback");
    expect(true).toBe(true);
  });
});

/**
 * PART 1 — THE EXPOSURE AND THE FIX, at the limiter layer.
 *
 * Deliberately OUTSIDE the database gate so it runs on every `npm test`, including a machine with
 * no PostgreSQL. These mount the REAL exported middleware — not a re-implementation — in front of a
 * terminal handler that counts how many requests got through, with a stub principal standing in for
 * the mfa-pending session that partnerSessionMiddleware would have resolved.
 */
describe("MFA rate-limit ceiling: per-IP alone vs per-IP + per-account", () => {
  /**
   * Build a probe server whose chain is exactly `middlewares`, with `victimUserId` injected as the
   * resolved principal (mirroring partnerSessionMiddleware, which runs before every one of these
   * limiters in production — server/partner/mount.ts).
   */
  async function probeServer(victimUserId: string, middlewares: unknown[]) {
    const app = express();
    // MIRRORS PRODUCTION: server/index.ts sets exactly this, and it is what makes req.ip resolve
    // from the rightmost X-Forwarded-For entry. Without it, rotating addresses would be untestable
    // because every request would carry the same loopback socket address.
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      req.partner = { userId: victimUserId } as unknown as Request["partner"];
      next();
    });
    let reached = 0;
    app.post("/probe", ...(middlewares as never[]), (_req: Request, res: Response) => {
      reached += 1;
      res.status(401).json({ error: "invalid code" }); // what a wrong code returns
    });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      reached: () => reached,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  /** Drive `perIp` attempts from each of `ips`, against the SAME victim. */
  async function drive(base: string, ips: string[], perIp: number): Promise<Record<number, number>> {
    const statuses: Record<number, number> = {};
    for (const ip of ips) {
      for (let i = 0; i < perIp; i++) {
        const res = await fetch(`${base}/probe`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ code: "000000" }),
        });
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }
    }
    return statuses;
  }

  const oneIp = ["203.0.113.10"];
  const tenIps = Array.from({ length: 10 }, (_, i) => `203.0.113.${20 + i}`);

  it("REPRODUCTION: with the IP bucket alone, attempts against one victim scale LINEARLY with source count", async () => {
    const rl = await import("../server/partner/rate-limit");

    // 20 from ONE address — the per-IP budget, exactly as configured.
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());
    const single = await probeServer(VICTIM, [rl.partnerMfaLimiter]);
    const a = await drive(single.base, oneIp, 40);
    expect(single.reached()).toBe(MFA_IP_MAX);
    expect(a[401]).toBe(MFA_IP_MAX);
    await single.close();

    // 200 from TEN addresses against the SAME victim. Nothing about the victim bounded anything:
    // the ceiling belonged to the attacker's network position, which the attacker chooses.
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());
    const rotated = await probeServer(VICTIM, [rl.partnerMfaLimiter]);
    await drive(rotated.base, tenIps, 40);
    expect(rotated.reached(), "this IS the finding: 10x the addresses bought 10x the guesses").toBe(
      MFA_IP_MAX * tenIps.length
    );
    expect(rotated.reached()).toBe(200);
    await rotated.close();
  }, 60_000);

  it("FIX + MUTATION CONTROL: adding the per-account bucket makes the ceiling flat in source count", async () => {
    const rl = await import("../server/partner/rate-limit");

    // The production chain: IP bucket FIRST (always applied, never replaced), account bucket behind.
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());
    const single = await probeServer(VICTIM, [rl.partnerMfaLimiter, rl.partnerMfaAccountLimiter]);
    await drive(single.base, oneIp, 40);
    expect(single.reached()).toBe(MFA_ACCOUNT_MAX);
    await single.close();

    // MUTATION TARGET. Remove partnerMfaAccountLimiter from the array below and this expectation
    // becomes 200 — the linear count from the reproduction above.
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());
    const rotated = await probeServer(VICTIM, [rl.partnerMfaLimiter, rl.partnerMfaAccountLimiter]);
    const statuses = await drive(rotated.base, tenIps, 40);
    expect(rotated.reached(), "ten addresses must buy no more attempts than one").toBe(MFA_ACCOUNT_MAX);
    expect(statuses[429]).toBe(40 * tenIps.length - MFA_ACCOUNT_MAX);
    await rotated.close();
  }, 60_000);

  it("the account bucket is keyed on the SESSION identity, never on the request body", async () => {
    const rl = await import("../server/partner/rate-limit");
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());
    const s = await probeServer(VICTIM, [rl.partnerMfaLimiter, rl.partnerMfaAccountLimiter]);
    // Every request carries a DIFFERENT email/userId/user_id in the body and a different address.
    // If any of those reached the bucket key the caller would mint itself a fresh budget per value.
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${s.base}/probe`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i + 1}` },
        body: JSON.stringify({ code: "000000", email: `x${i}@example.test`, userId: `u${i}`, user_id: `u${i}` }),
      });
      if (res.status === 401) allowed += 1;
    }
    expect(allowed, "nothing in the request body may move the caller to a fresh bucket").toBe(MFA_ACCOUNT_MAX);
    await s.close();
  }, 60_000);

  it("the four MFA management routes no longer share the challenge's bucket", async () => {
    const rl = await import("../server/partner/rate-limit");
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());

    // Exhaust the CHALLENGE budget completely.
    const challenge = await probeServer(VICTIM, [rl.partnerMfaLimiter, rl.partnerMfaAccountLimiter]);
    await drive(challenge.base, oneIp, 40);
    expect(challenge.reached()).toBe(MFA_ACCOUNT_MAX);
    await challenge.close();

    // Enrolment is still fully available — it is a different namespace now.
    const mgmt = await probeServer(VICTIM, [rl.partnerMfaManagementLimiter]);
    const res = await fetch(`${mgmt.base}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": oneIp[0] },
      body: JSON.stringify({}),
    });
    expect(res.status, "answering code challenges must not consume the shop's enrolment budget").toBe(401);
    await mgmt.close();
  }, 60_000);

  it("shared-NAT staff do not consume each other's enrolment budget", async () => {
    const rl = await import("../server/partner/rate-limit");
    rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());
    const NAT = "192.0.2.99"; // one shop, one egress address

    // Staff member 1 spends its entire management budget.
    const staff1 = await probeServer(VICTIM, [rl.partnerMfaManagementLimiter]);
    await drive(staff1.base, [NAT], 30);
    expect(staff1.reached()).toBe(20);
    await staff1.close();

    // Staff member 2, same egress address, is unaffected. Under the old IP-only key this was 0.
    const staff2 = await probeServer(BYSTANDER, [rl.partnerMfaManagementLimiter]);
    const res = await fetch(`${staff2.base}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": NAT },
      body: JSON.stringify({}),
    });
    expect(res.status, "a colleague must not be able to spend your enrolment budget").toBe(401);
    await staff2.close();
  }, 60_000);
});

/**
 * PART 2 — the durable, cross-machine ceiling: the account LOCKOUT, on the real route and the real
 * database. The limiters above are in-process and a restart clears them; this is the control that
 * does not care how many Fly machines are serving.
 */
(isLocal ? describe : describe.skip)("MFA account lockout (real routes, real DB)", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";
  let currentTotp: (secret: string, at: number) => string;
  let resetLimits: () => void;

  const jars: Record<string, string> = {};
  let jar = "victim";

  async function call(method: string, path: string, body?: unknown, xff = "203.0.113.1") {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": xff,
        ...(jars[jar] ? { cookie: jars[jar] } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) jars[jar] = setCookie.split(";")[0];
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* status is what matters */
    }
    return { status: res.status, json, text };
  }

  async function login(email: string) {
    resetLimits();
    const r = await call("POST", "/api/partner/auth/login", { email, password: PASSWORD });
    expect(r.status, r.text).toBe(200);
    return r;
  }

  async function mfaState(userId: string) {
    const r = await admin.query<{ failed_mfa_count: number; locked: boolean }>(
      `SELECT failed_mfa_count, (mfa_locked_until IS NOT NULL AND mfa_locked_until > now()) AS locked
         FROM partner_users WHERE id=$1`,
      [userId]
    );
    return r.rows[0];
  }

  async function auditActions(userId: string): Promise<string[]> {
    const r = await admin.query<{ action: string }>(
      "SELECT action FROM partner_audit_events WHERE actor_user_id=$1 ORDER BY created_at",
      [userId]
    );
    return r.rows.map((x) => x.action);
  }

  async function securityEvents(): Promise<{ kind: string; severity: string }[]> {
    const r = await admin.query<{ kind: string; severity: string }>(
      "SELECT kind, severity FROM partner_security_events WHERE tenant_id=$1 ORDER BY created_at",
      [TENANT]
    );
    return r.rows;
  }

  /** Enrol a fresh authenticator for the current jar's session; returns its secret. */
  async function enrolFresh(): Promise<string> {
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD });
    expect(enrol.status, enrol.text).toBe(200);
    const secret = enrol.json.secret as string;
    const confirm = await call("POST", "/api/partner/mfa/confirm", { code: currentTotp(secret, Date.now()) });
    expect(confirm.status, confirm.text).toBe(200);
    return secret;
  }

  /** A genuinely valid TOTP. Clearing the replay watermark is a FIXTURE reset — replay protection
   *  has dedicated coverage in partner-mfa-enrolment-mandatory.test.ts. */
  async function validCode(userId: string, secret: string): Promise<string> {
    await admin.query("UPDATE partner_mfa_methods SET last_totp_counter=NULL WHERE user_id=$1", [userId]);
    return currentTotp(secret, Date.now());
  }

  let victimSecret = "";

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic; disposable DB only

    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query(
      `DO $$ BEGIN CREATE ROLE partner_runtime NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(
      `DO $$ BEGIN CREATE ROLE partner_connector_runtime NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
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
    for (const t of ["users", "submissions", "submission_items"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_RBAC_SEED);
    await admin.query("DROP ROLE IF EXISTS partner_app_test_mfa_bf").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_mfa_bf LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_mfa_bf");

    const hash = bcrypt.hashSync(PASSWORD, 10);
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'orgBf','Bruteforce Ltd','ACTIVE')",
      [TENANT]
    );
    for (const [id, ref, email] of [
      [VICTIM, "bfVictim", VICTIM_EMAIL],
      [BYSTANDER, "bfBystander", BYSTANDER_EMAIL],
    ] as const) {
      await admin.query(
        `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status, password_hash, mfa_required)
         VALUES ($1,$2,$3,$3,$4,'ACTIVE',$5,true)`,
        [id, ref, TENANT, email, hash]
      );
      await admin.query(
        "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
        [TENANT, id]
      );
    }
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true)"
    );

    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    const mfa = await import("../server/partner/mfa");
    currentTotp = mfa.currentTotp;
    const rl = await import("../server/partner/rate-limit");
    resetLimits = () => rl.setPartnerRateLimitStore(new rl.MemoryRateLimitStore());

    const app = express();
    app.set("trust proxy", 1); // as production does — makes the rotated addresses below real
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The victim enrols an authenticator, so every failure below is a genuinely wrong CODE against
    // a real active factor rather than an unenrolled account taking a different branch.
    jar = "victim";
    await login(VICTIM_EMAIL);
    victimSecret = await enrolFresh();
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    resetLimits();
    await admin.query("UPDATE partner_users SET failed_mfa_count=0, mfa_locked_until=NULL WHERE tenant_id=$1", [TENANT]);
    await admin.query("DELETE FROM partner_security_events WHERE tenant_id=$1", [TENANT]);
  });

  it("THE CEILING: five wrong codes lock the account, and rotating source addresses buys nothing", async () => {
    jar = "victim";
    await login(VICTIM_EMAIL); // fresh mfa-pending session

    const ips = Array.from({ length: 10 }, (_, i) => `198.51.100.${100 + i}`);
    const seen: number[] = [];
    // Two attempts from each of ten distinct addresses. Under the old code all twenty would have
    // been evaluated; the account-side controls must stop that at five.
    for (const ip of ips) {
      for (let i = 0; i < 2; i++) seen.push((await call("POST", "/api/partner/auth/mfa", { code: "000000" }, ip)).status);
    }

    const evaluated = seen.filter((s) => s === 401).length;
    const refused = seen.filter((s) => s === 423).length;
    const throttled = seen.filter((s) => s === 429).length;

    // Four 401s, then the fifth failure ARMS the lock and is itself answered 423.
    expect(evaluated, "only four attempts may be answered as a plain wrong code").toBe(LOCKOUT_THRESHOLD - 1);
    expect(evaluated + refused + throttled).toBe(20);
    expect(refused).toBeGreaterThan(0);
    // Total requests that reached the handler at all are capped by the per-account limiter.
    expect(evaluated + refused).toBeLessThanOrEqual(MFA_ACCOUNT_MAX);
    expect(throttled).toBe(20 - MFA_ACCOUNT_MAX);

    const state = await mfaState(VICTIM);
    expect(state.locked, "the lock must be armed in the DATABASE, not just in a process bucket").toBe(true);
    expect(state.failed_mfa_count).toBe(LOCKOUT_THRESHOLD);

    // And the session was never upgraded.
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(401);
  }, 120_000);

  it("OBSERVABILITY: every failed verification is audited, and arming the lock raises a security event", async () => {
    jar = "victim";
    await login(VICTIM_EMAIL);
    const before = (await auditActions(VICTIM)).filter((a) => a === "partner_mfa_failure").length;

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await call("POST", "/api/partner/auth/mfa", { code: "000000" }, `198.51.100.${150 + i}`);
    }

    const after = (await auditActions(VICTIM)).filter((a) => a === "partner_mfa_failure").length;
    expect(after - before, "a failed second factor was previously silent — no audit row at all").toBe(
      LOCKOUT_THRESHOLD
    );

    const sec = await securityEvents();
    const locks = sec.filter((e) => e.kind === "partner_mfa_locked");
    expect(locks, "arming the lock must raise exactly one security event").toHaveLength(1);
    // Higher than the password lock's "medium": reaching this requires a VALID password first, so
    // it is evidence of a compromised credential, not of someone fumbling their own login.
    expect(locks[0].severity).toBe("high");
  }, 120_000);

  it("RELEASE: an expired lock is retired, and re-locking costs a full fresh threshold", async () => {
    jar = "victim";
    await login(VICTIM_EMAIL);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await call("POST", "/api/partner/auth/mfa", { code: "000000" }, "198.51.100.200");
    }
    expect((await mfaState(VICTIM)).locked).toBe(true);

    // Wind the clock: the lock has served its interval.
    await admin.query("UPDATE partner_users SET mfa_locked_until = now() - interval '1 second' WHERE id=$1", [VICTIM]);
    resetLimits();

    // The FIRST failure after expiry must be an ordinary wrong code (401), NOT an instant re-lock.
    // If the spent counter were not retired, `failed_mfa_count + 1 >= threshold` would be satisfied
    // immediately and one request per interval would hold this account's second factor offline
    // forever — the same denial-of-service already fixed on the password path.
    const first = await call("POST", "/api/partner/auth/mfa", { code: "000000" }, "198.51.100.201");
    expect(first.status, "a spent lock must not re-arm on the first subsequent failure").toBe(401);
    expect((await mfaState(VICTIM)).failed_mfa_count).toBe(1);
    expect((await mfaState(VICTIM)).locked).toBe(false);

    // A correct code still completes the challenge after the lock has expired.
    const ok = await call("POST", "/api/partner/auth/mfa", { code: await validCode(VICTIM, victimSecret) });
    expect(ok.status, ok.text).toBe(200);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);
  }, 120_000);

  it("USABILITY: mistyping one code does not brick a legitimate user", async () => {
    jar = "victim";
    await login(VICTIM_EMAIL);

    const wrong = await call("POST", "/api/partner/auth/mfa", { code: "111111" });
    expect(wrong.status).toBe(401);
    expect((await mfaState(VICTIM)).failed_mfa_count).toBe(1);

    const ok = await call("POST", "/api/partner/auth/mfa", { code: await validCode(VICTIM, victimSecret) });
    expect(ok.status, ok.text).toBe(200);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);

    // Success RETIRES the counter, so yesterday's typos never accumulate into tomorrow's lockout.
    const state = await mfaState(VICTIM);
    expect(state.failed_mfa_count).toBe(0);
    expect(state.locked).toBe(false);
  }, 120_000);

  it("the MFA lock is NOT resettable by logging in again with the stolen password", async () => {
    jar = "victim";
    await login(VICTIM_EMAIL);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await call("POST", "/api/partner/auth/mfa", { code: "000000" }, "198.51.100.210");
    }
    expect((await mfaState(VICTIM)).locked).toBe(true);

    // This is exactly why the counters are NOT failed_login_count / locked_until: partnerLogin
    // zeroes those on every successful password login, so an attacker holding the password would
    // have owned a counter-reset primitive and the lock could never have armed.
    await login(VICTIM_EMAIL);
    const state = await mfaState(VICTIM);
    expect(state.locked, "a successful password login must not clear the second-factor lock").toBe(true);
    expect(state.failed_mfa_count).toBe(LOCKOUT_THRESHOLD);

    resetLimits();
    expect((await call("POST", "/api/partner/auth/mfa", { code: "000000" }, "198.51.100.211")).status).toBe(423);
  }, 120_000);

  it("one account's lockout does not affect another user in the same shop", async () => {
    jar = "victim";
    await login(VICTIM_EMAIL);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await call("POST", "/api/partner/auth/mfa", { code: "000000" }, "192.0.2.50");
    }
    expect((await mfaState(VICTIM)).locked).toBe(true);

    // Same shop, same egress address, different person: unaffected, and can still enrol.
    jar = "bystander";
    resetLimits();
    await login(BYSTANDER_EMAIL);
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD }, "192.0.2.50");
    expect(enrol.status, "a colleague's lockout must not deny enrolment to the rest of the shop").toBe(200);
    expect((await mfaState(BYSTANDER)).locked).toBe(false);
  }, 120_000);
});
