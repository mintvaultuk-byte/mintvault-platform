/**
 * Partner lockout DECAY — runtime proof over real HTTP on a disposable PostgreSQL 17.
 *
 * THE CLAIM UNDER TEST (raised by hostile review as a static code-reading finding, deliberately
 * NOT acted on until reproduced here): `partner_users.failed_login_count` is cleared in only three
 * places — successful login, successful password reset, invitation acceptance. Nothing clears it
 * when a lockout INTERVAL merely elapses. So the steady state after any lockout is
 * `failed_login_count = 5, locked_until = <past>`, and the arming expression in `recordFailure`
 *
 *     locked_until = CASE WHEN failed_login_count + 1 >= threshold THEN now() + 15 min ... END
 *
 * is satisfied by the very first failure after expiry (5 + 1 >= 5). One unauthenticated request
 * per 15 minutes would then hold a named partner account offline indefinitely — comfortably inside
 * both login limiters.
 *
 * This suite reproduces that end-to-end rather than by reading, and then pins the fixed behaviour:
 * a spent lockout is retired, so re-locking again costs a full fresh threshold of failures.
 * Brute-force protection is unchanged — five failures inside a window still lock the account.
 *
 * Reproduce (host must be loopback; the database is dropped and recreated):
 *   PARTNER_LOCKOUT_DECAY_RT_ADMIN=postgresql://postgres@127.0.0.1:55444/mv_lockout_decay \
 *   PARTNER_LOCKOUT_DECAY_RT_RUNTIME=postgresql://partner_app_test_lockdecay:synthetic@127.0.0.1:55444/mv_lockout_decay \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-lockout-decay.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_LOCKOUT_DECAY_RT_ADMIN;
const RUNTIME = process.env.PARTNER_LOCKOUT_DECAY_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const TENANT = "e5013000-0000-0000-0000-000000000001";
const VICTIM = "e5013000-0000-0000-0000-0000000000a1";
const VICTIM_EMAIL = "decay-victim@example.test";
const PASSWORD = "decay-victim-password-1";
/** Mirrors LOCKOUT_THRESHOLD in server/partner/auth.ts. */
const THRESHOLD = 5;

describe("partner lockout decay coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_LOCKOUT_DECAY_RT_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(
        true
      );
    }
    if (!isLocal) console.warn("[partner-lockout-decay] skipped: PARTNER_LOCKOUT_DECAY_RT_ADMIN not loopback");
    expect(true).toBe(true);
  });
});

(isLocal ? describe : describe.skip)("partner lockout decay (runtime)", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";
  let MemoryRateLimitStore: new () => unknown;
  let setPartnerRateLimitStore: (s: unknown) => void;

  async function login(password: string) {
    const res = await fetch(`${base}/api/partner/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: VICTIM_EMAIL, password }),
    });
    return { status: res.status, text: await res.text() };
  }

  async function lockState() {
    const { rows } = await admin.query<{ failed_login_count: number; locked_until: Date | null }>(
      "SELECT failed_login_count, locked_until FROM partner_users WHERE id=$1",
      [VICTIM]
    );
    return rows[0];
  }

  /** Simulate the lockout interval elapsing. Time-travel on the fixture, not a behaviour change. */
  async function expireLockout() {
    await admin.query("UPDATE partner_users SET locked_until = now() - interval '1 minute' WHERE id=$1", [VICTIM]);
  }

  async function resetAccount() {
    await admin.query("UPDATE partner_users SET failed_login_count=0, locked_until=NULL, status='ACTIVE' WHERE id=$1", [
      VICTIM,
    ]);
    setPartnerRateLimitStore(new MemoryRateLimitStore()); // the limiters stay installed; only the buckets reset
  }

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);

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
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_RBAC_SEED);
    await admin.query("DROP ROLE IF EXISTS partner_app_test_lockdecay").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_lockdecay LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_lockdecay");

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'decayOrg','Decay Ltd','ACTIVE')",
      [TENANT]
    );
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status, password_hash, password_set_at, mfa_required)
       VALUES ($1,'decayVictim',$2,$2,$3,'ACTIVE',$4,now(),false)`,
      [VICTIM, TENANT, VICTIM_EMAIL, bcrypt.hashSync(PASSWORD, 10)]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [TENANT, VICTIM]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true)"
    );

    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    const rl = await import("../server/partner/rate-limit");
    MemoryRateLimitStore = rl.MemoryRateLimitStore as unknown as new () => unknown;
    setPartnerRateLimitStore = rl.setPartnerRateLimitStore as unknown as (s: unknown) => void;

    const app = express();
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  beforeEach(resetAccount);

  it("CONTROL: five failures still lock the account (brute-force protection intact)", async () => {
    for (let i = 0; i < THRESHOLD; i++) expect((await login("wrong-password")).status).toBe(401);
    const st = await lockState();
    expect(Number(st.failed_login_count)).toBe(THRESHOLD);
    expect(st.locked_until).not.toBeNull();
    expect(new Date(st.locked_until!).getTime()).toBeGreaterThan(Date.now());
  });

  it("retires a SPENT lockout: one failure after expiry must not instantly re-lock", async () => {
    for (let i = 0; i < THRESHOLD; i++) await login("wrong-password");
    await expireLockout();

    // Exactly ONE failed attempt after the interval elapsed.
    expect((await login("wrong-password")).status).toBe(401);

    const st = await lockState();
    const relocked = st.locked_until !== null && new Date(st.locked_until).getTime() > Date.now();
    expect(
      relocked,
      "a single failure after a completed lockout interval must not re-arm a full lock from the historical counter"
    ).toBe(false);
    // The counter restarted rather than continuing from the threshold.
    expect(Number(st.failed_login_count)).toBeLessThan(THRESHOLD);
  });

  it("cannot be held offline indefinitely by one request per interval", async () => {
    for (let i = 0; i < THRESHOLD; i++) await login("wrong-password");

    // The attack loop: expire, send ONE bad attempt, repeat. If a single probe re-locks, the
    // account is offline permanently at ~4 requests/hour.
    for (let round = 0; round < 3; round++) {
      await expireLockout();
      await login("wrong-password");
      const st = await lockState();
      const relocked = st.locked_until !== null && new Date(st.locked_until).getTime() > Date.now();
      expect(relocked, `round ${round}: one probe re-locked the account`).toBe(false);
    }

    // …and the legitimate owner can still get in with the correct password.
    await expireLockout();
    expect((await login(PASSWORD)).status).toBe(200);
    const st = await lockState();
    expect(Number(st.failed_login_count)).toBe(0);
    expect(st.locked_until).toBeNull();
  });

  it("re-locking still costs a FULL fresh threshold of failures", async () => {
    for (let i = 0; i < THRESHOLD; i++) await login("wrong-password");
    await expireLockout();

    // Fresh window: the first THRESHOLD-1 failures must not lock…
    for (let i = 0; i < THRESHOLD - 1; i++) {
      expect((await login("wrong-password")).status).toBe(401);
      const mid = await lockState();
      const locked = mid.locked_until !== null && new Date(mid.locked_until).getTime() > Date.now();
      expect(locked, `locked after only ${i + 1} fresh failures`).toBe(false);
    }
    // …and the THRESHOLD-th does.
    expect((await login("wrong-password")).status).toBe(401);
    const st = await lockState();
    expect(st.locked_until).not.toBeNull();
    expect(new Date(st.locked_until!).getTime()).toBeGreaterThan(Date.now());
    expect(Number(st.failed_login_count)).toBe(THRESHOLD);
  });

  it("a correct password during an ACTIVE lockout is still refused, generically", async () => {
    for (let i = 0; i < THRESHOLD; i++) await login("wrong-password");
    const res = await login(PASSWORD);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text)).toEqual({ error: "invalid credentials" });
  });

  it("still audits every probe against a locked account", async () => {
    const before = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_audit_events WHERE actor_user_id=$1 AND reason='locked'",
      [VICTIM]
    );
    for (let i = 0; i < THRESHOLD; i++) await login("wrong-password");
    await login("wrong-password"); // probe while locked
    const after = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_audit_events WHERE actor_user_id=$1 AND reason='locked'",
      [VICTIM]
    );
    expect(Number(after.rows[0].n)).toBeGreaterThan(Number(before.rows[0].n));
  });
});
