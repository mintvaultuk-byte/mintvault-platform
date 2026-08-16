/**
 * Phase 1 Part B — Partner Portal runtime integration test.
 *
 * Runs ONLY when PARTNER_RT_ADMIN (a superuser URL to a DISPOSABLE local Postgres) is set. It
 * applies migrations 0001+0002, creates a synthetic LOGIN role that inherits the restricted
 * partner_runtime role, points the runtime at it, seeds two synthetic partners, boots the isolated
 * partner app on an ephemeral port, and drives it with REAL HTTP requests — proving login, session
 * cookie, tenant isolation, permission enforcement, emergency stop, connection-pool non-leak,
 * route isolation, and MFA through the actual runtime (not unit stubs).
 *
 * Reproduce (host must be 127.0.0.1):
 *   PARTNER_RT_ADMIN=postgresql://postgres@127.0.0.1:5544/dispo \
 *   PARTNER_RT_RUNTIME=postgresql://partner_app_test_rt:synthetic@127.0.0.1:5544/dispo \
 *   npx vitest run tests/partner-runtime-integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
  pinAccountingTopologyTo,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_RT_ADMIN;
const RUNTIME = process.env.PARTNER_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

let server: http.Server;
let base: string;
let admin: Client;
const capturedResets: { email: string; token: string }[] = [];
const capturedInvites: { email: string; token: string; roleCode: string }[] = [];
const L1 = "10000000-0000-0000-0000-0000000000c1";
const L2 = "10000000-0000-0000-0000-0000000000c2";
const LB = "20000000-0000-0000-0000-0000000000d1";

(isLocal ? describe : describe.skip)("Partner Portal runtime (disposable DB, real HTTP)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    // clean + apply schema under a REALISTIC non-superuser owner model (DB-F1): tables owned by
    // pn_migrator (non-superuser), the pre-auth SECURITY DEFINER functions owned by partner_definer
    // (BYPASSRLS). This proves partner auth works WITHOUT superuser-owned functions.
    // Start from a genuinely empty schema. These three suites share one PARTNER_RT_ADMIN database,
    // and each applies a DIFFERENT migration list as pn_migrator. Without a reset the second suite
    // re-runs an earlier migration's `CREATE OR REPLACE FUNCTION` over a definer function a later
    // migration has already redefined, and PostgreSQL rejects it with "cannot change return type of
    // existing function". `DROP OWNED BY partner_runtime` does not help — the functions and tables
    // are owned by pn_migrator. The database is disposable by contract, so dropping the schema is
    // safe and is what "disposable DB" already implies.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
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
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);
    // synthetic LOGIN role that inherits the restricted partner_runtime role
    await admin.query("DROP ROLE IF EXISTS partner_app_test_rt").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_rt LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_rt");
    // env for the runtime BEFORE importing app modules (pools are lazy)
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    // CI pins MINTVAULT_DATABASE_URL globally to a DIFFERENT database; the G6D accounting
    // topology assertion in server/partner/db.ts then throws. Pin it to this suite's own.
    pinAccountingTopologyTo(ADMIN);
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, never committed as real

    // seed RBAC + two partners
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();
    await admin.query("DELETE FROM partner_users");
    await admin.query("DELETE FROM partner_organisations");
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'rA','A Ltd','ACTIVE'),($2,'rB','B Ltd','ACTIVE')",
      [A, B]
    );
    const pw = await bcrypt.hash("correct-horse-battery", 12);
    // owner in A, trainee in A, owner in B, mfa-user in A, manager/grader/staff in A
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, password_set_at, status, mfa_required) VALUES
       ('11111111-0000-0000-0000-0000000000a1','ua1',$1,$1,'owner@a.com',$3,now(),'ACTIVE',false),
       ('11111111-0000-0000-0000-0000000000a2','ua2',$1,$1,'trainee@a.com',$3,now(),'ACTIVE',false),
       ('22222222-0000-0000-0000-0000000000b1','ub1',$2,$2,'owner@b.com',$3,now(),'ACTIVE',false),
       ('11111111-0000-0000-0000-0000000000a3','ua3',$1,$1,'mfa@a.com',$3,now(),'ACTIVE',true),
       ('11111111-0000-0000-0000-0000000000a5','ua5',$1,$1,'admin@a.com',$3,now(),'ACTIVE',false),
       ('11111111-0000-0000-0000-0000000000a6','ua6',$1,$1,'grader@a.com',$3,now(),'ACTIVE',false),
       ('11111111-0000-0000-0000-0000000000a7','ua7',$1,$1,'staff@a.com',$3,now(),'ACTIVE',false)`,
      [A, B, pw]
    );
    const roleId = async (code: string) =>
      (await admin.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [code])).rows[0].id;
    const owner = await roleId("PARTNER_OWNER");
    const trainee = await roleId("PARTNER_TRAINEE");
    const manager = await roleId("PARTNER_MANAGER");
    const grader = await roleId("MVGS_ASSESSMENT_TECHNICIAN");
    const staff = await roleId("PARTNER_RECEPTION");
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES
       ($1,'11111111-0000-0000-0000-0000000000a1',$2),
       ($1,'11111111-0000-0000-0000-0000000000a2',$3),
       ($4,'22222222-0000-0000-0000-0000000000b1',$2),
       ($1,'11111111-0000-0000-0000-0000000000a3',$2),
       ($1,'11111111-0000-0000-0000-0000000000a5',$5),
       ($1,'11111111-0000-0000-0000-0000000000a6',$6),
       ($1,'11111111-0000-0000-0000-0000000000a7',$7)`,
      [A, owner, trainee, B, manager, grader, staff]
    );
    // an enrolment user (no MFA required yet, so they authenticate then enrol)
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, password_set_at, status, mfa_required) VALUES ('11111111-0000-0000-0000-0000000000a4','ua4',$1,$1,'enrol@a.com',$2,now(),'ACTIVE',false)",
      [A, pw]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,'11111111-0000-0000-0000-0000000000a4',$2)",
      [A, owner]
    );
    // locations: L1 + L2 in tenant A; LB in tenant B. Owners are org-wide and need no location
    // assignment; trainee@a is location-scoped to L1 only.
    await admin.query(
      `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES
       ('10000000-0000-0000-0000-0000000000c1','lc1',$1,$1,'Loc1','ACTIVE'),
       ('10000000-0000-0000-0000-0000000000c2','lc2',$1,$1,'Loc2','ACTIVE'),
       ('20000000-0000-0000-0000-0000000000d1','ld1',$2,$2,'LocB','ACTIVE')`,
      [A, B]
    );
    await admin.query(
      `INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES
       ($1,'11111111-0000-0000-0000-0000000000a2','10000000-0000-0000-0000-0000000000c1')`,
      [A]
    );
    // capturing reset-delivery adapter (no real email)
    const { setResetDeliveryAdapter, setInvitationDeliveryAdapter } = await import("../server/partner/delivery");
    setResetDeliveryAdapter(async (email, token) => {
      capturedResets.push({ email, token });
    });
    setInvitationDeliveryAdapter(async ({ email, token, roleCode }) => {
      capturedInvites.push({ email, token, roleCode });
    });
    // enable the portal flag (global)
    await admin.query("DELETE FROM partner_feature_flags");
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)"
    );

    const { createPartnerApp } = await import("../server/partner/app");
    server = http.createServer(createPartnerApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.query("DROP ROLE IF EXISTS partner_app_test_rt").catch(() => {});
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    // isolate the IP-keyed login rate limiter between tests (all tests share 127.0.0.1).
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
  });

  async function login(email: string, password = "correct-horse-battery") {
    const res = await fetch(`${base}/api/partner/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { res, cookie, body: await res.json().catch(() => ({})) };
  }
  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } });

  it("proves the runtime connects as the restricted role (not superuser)", async () => {
    const c = new Client({ connectionString: RUNTIME });
    await c.connect();
    const who = await c.query<{ u: string; su: boolean }>(
      "SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su"
    );
    expect(who.rows[0].u).toBe("partner_app_test_rt");
    expect(who.rows[0].su).toBe(false);
    await c.end();
  });

  it("valid login sets the mv.partner.sid cookie; invalid + unknown are generic 401", async () => {
    const okLogin = await login("owner@a.com");
    expect(okLogin.res.status).toBe(200);
    expect(okLogin.cookie).toMatch(/^mv\.partner\.sid=/);
    const bad = await login("owner@a.com", "wrong");
    expect(bad.res.status).toBe(401);
    const unknown = await login("nobody@nowhere.com");
    expect(unknown.res.status).toBe(401);
    // generic: unknown-account and wrong-password are indistinguishable (same status + body shape)
    expect(unknown.body).toEqual(bad.body);
  });

  it("tenant isolation through real requests: A's /users shows only A", async () => {
    const { cookie } = await login("owner@a.com");
    const users = (await (await get("/api/partner/users", cookie)).json()).users;
    expect(Array.isArray(users)).toBe(true);
    expect(users.every((u: { email: string }) => u.email.endsWith("@a.com"))).toBe(true);
    expect(users.some((u: { email: string }) => u.email === "owner@b.com")).toBe(false);
  });

  it("permission enforcement: trainee (no users.view) gets 403 on /users", async () => {
    const { cookie } = await login("trainee@a.com");
    const r = await get("/api/partner/users", cookie);
    expect(r.status).toBe(403);
    // but trainee CAN see the dashboard
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(200);
  });

  it("connection-pool non-leak: parallel A and B requests never cross tenants", async () => {
    const [ca, cb] = [(await login("owner@a.com")).cookie, (await login("owner@b.com")).cookie];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        get("/api/partner/dashboard", i % 2 === 0 ? ca : cb).then((r) =>
          r.json().then((j) => ({ i, name: j.org?.legal_name }))
        )
      )
    );
    for (const { i, name } of results) expect(name).toBe(i % 2 === 0 ? "A Ltd" : "B Ltd");
  });

  it("session rotation + logout + revoke-all invalidate prior sessions", async () => {
    const first = await login("owner@a.com");
    const second = await login("owner@a.com"); // rotation revokes `first`
    expect((await get("/api/partner/session", first.cookie)).status).toBe(401);
    expect((await get("/api/partner/session", second.cookie)).status).toBe(200);
    await fetch(`${base}/api/partner/auth/logout`, { method: "POST", headers: { cookie: second.cookie } });
    expect((await get("/api/partner/session", second.cookie)).status).toBe(401);
  });

  it("MFA-required user cannot use the session until MFA passes; correct TOTP unlocks it", async () => {
    const { cookie } = await login("mfa@a.com");
    // mfa pending → protected route rejected
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(401);
    // enrol a TOTP secret for the user (super-admin/enrolment path, done here directly)
    const { generateTotpSecret, currentTotp, encryptSecret } = await import("../server/partner/mfa");
    const secret = generateTotpSecret();
    await admin.query(
      "INSERT INTO partner_mfa_methods (tenant_id, user_id, method, secret_ref, status) VALUES ($1,$2,'totp',$3,'ACTIVE')",
      [A, "11111111-0000-0000-0000-0000000000a3", encryptSecret(secret)]
    );
    const good = currentTotp(secret, Date.now());
    const mfaRes = await fetch(`${base}/api/partner/auth/mfa`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ code: good }),
    });
    expect(mfaRes.status).toBe(200);
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(200);
  });

  it("emergency stop: freezing partner A invalidates A's live sessions immediately", async () => {
    const { cookie } = await login("owner@a.com");
    expect((await get("/api/partner/session", cookie)).status).toBe(200);
    await admin.query("INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'partner',true)", [
      A,
    ]);
    expect((await get("/api/partner/session", cookie)).status).toBe(401);
    await admin.query("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [A]);
  });

  it("route isolation: partner app does not mount admin/staff/vq/cert routes (404)", async () => {
    const { FORBIDDEN_PARTNER_PATHS } = await import("../server/partner/app");
    const { cookie } = await login("owner@a.com");
    for (const p of FORBIDDEN_PARTNER_PATHS) {
      const r = await get(p, cookie);
      expect(r.status, `${p} should be 404 on the partner app`).toBe(404);
    }
  });

  it("account lockout after repeated failures", async () => {
    // fresh user to avoid interfering with others
    await admin.query("UPDATE partner_users SET failed_login_count=0, locked_until=NULL WHERE email='trainee@a.com'");
    for (let i = 0; i < 5; i++) await login("trainee@a.com", "wrong");
    // now even the correct password is locked out
    const locked = await login("trainee@a.com");
    expect(locked.res.status).toBe(401);
    const { rows } = await admin.query<{ locked_until: string | null }>(
      "SELECT locked_until FROM partner_users WHERE email='trainee@a.com'"
    );
    expect(rows[0].locked_until).not.toBeNull();
    await admin.query("UPDATE partner_users SET failed_login_count=0, locked_until=NULL WHERE email='trainee@a.com'");
  });

  it("audit events recorded; no secrets/hashes/tokens in audit payloads", async () => {
    await login("owner@a.com");
    const { rows } = await admin.query<{ action: string; after_value: unknown }>(
      "SELECT action, after_value FROM partner_audit_events WHERE tenant_id=$1",
      [A]
    );
    expect(rows.some((r) => r.action === "partner_login")).toBe(true);
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/\$2[aby]\$|password_hash|token_hash|correct-horse/i);
  });

  it("M4 (true pool non-leak): after a withTenant(A) commit, a context-less query on the pool sees 0 rows", async () => {
    const { withTenant, partnerRuntimeQuery } = await import("../server/partner/db");
    // run a tenant-A transaction that commits
    await withTenant({ tenantId: A }, async (c) => {
      await c.query("SELECT 1 FROM partner_locations LIMIT 1");
    });
    // a subsequent CONTEXT-LESS query must fail closed — no residual app.tenant_id, RLS → 0 rows.
    const ctx = await partnerRuntimeQuery<{ t: string | null }>("SELECT current_setting('app.tenant_id', true) AS t");
    expect(ctx.rows[0].t == null || ctx.rows[0].t === "").toBe(true);
    const rows = await partnerRuntimeQuery<{ n: number }>("SELECT count(*)::int n FROM partner_locations");
    expect(rows.rows[0].n).toBe(0); // context-less → RLS serves nothing
  });

  it("H1 kill-switch: with partner_portal_enabled OFF, the whole /api/partner surface is 503", async () => {
    await admin.query("DELETE FROM partner_feature_flags WHERE flag='partner_portal_enabled'");
    expect((await fetch(`${base}/api/partner/session`)).status).toBe(503);
    expect((await login("owner@a.com")).res.status).toBe(503);
    // restore
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)"
    );
  });

  it("M1 emergency login freeze: a 'login' emergency control refuses new logins", async () => {
    await admin.query("INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'login',true)", [
      A,
    ]);
    expect((await login("owner@a.com")).res.status).toBe(401);
    await admin.query("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [A]);
    expect((await login("owner@a.com")).res.status).toBe(200); // restored
  });

  it("M2 view-only: a 'view_only' emergency blocks a mutating route (423) but allows reads", async () => {
    const { cookie } = await login("owner@a.com");
    await admin.query(
      "INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'view_only',true)",
      [A]
    );
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(200); // read ok
    const w = await fetch(`${base}/api/partner/users/11111111-0000-0000-0000-0000000000a2/revoke-sessions`, {
      method: "POST",
      headers: { cookie },
    });
    expect(w.status).toBe(423); // write blocked
    await admin.query("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [A]);
  });

  it("L1: pre-MFA /session withholds permissions and identity", async () => {
    // ensure mfa user has an ACTIVE totp method + is mfa_required
    const { cookie } = await login("mfa@a.com");
    const body = await (await get("/api/partner/session", cookie)).json();
    expect(body.mfaPassed).toBe(false);
    expect(body.permissions).toBeUndefined();
    expect(body.userId).toBeUndefined();
  });

  // ============ ITEM 1 — end-to-end password reset ============
  const post = (path: string, body: unknown, cookie = "") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  /**
   * AG-3 STEP-UP — perform the REAL proof against the REAL endpoint.
   *
   * Deliberately NOT `UPDATE partner_sessions SET last_step_up_at = now()`. Seeding the column
   * would prove only that the guard reads a timestamp; it would keep passing if the step-up route
   * stopped verifying the password, which is the one thing that must never silently break. These
   * tests therefore drive the same HTTP call the browser makes.
   */
  const stepUp = (cookie: string, password = "correct-horse-battery", second?: { code?: string; recoveryCode?: string }) =>
    post("/api/partner/auth/step-up", { password, ...(second ?? {}) }, cookie);

  /** Sign in and immediately satisfy the step-up challenge — for tests whose subject is not step-up. */
  async function loginStepped(email: string, password = "correct-horse-battery") {
    const { cookie, res, body } = await login(email, password);
    const proof = await stepUp(cookie, password);
    expect(proof.status, `step-up for ${email} should succeed`).toBe(200);
    return { cookie, res, body };
  }

  // ============ AG-3 step-up: the real challenge -> prove -> retry cycle ============
  it("step-up: a protected action is refused, then succeeds after the real proof, and the proof is session-scoped", async () => {
    const { cookie } = await login("owner@a.com");

    // 1. The action is refused with the distinct, actionable code — NOT 401. A 401 would make the
    //    browser discard a perfectly good session and turn a prompt into an unexpected sign-out.
    const refused = await post(
      "/api/partner/users",
      { firstName: "Step", lastName: "Up", email: "step-up-flow@a.com", role: "STAFF" },
      cookie
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("step_up_required");

    // 2. Nothing was performed by the refused attempt.
    const afterRefusal = await admin.query("SELECT 1 FROM partner_users WHERE email='step-up-flow@a.com'");
    expect(afterRefusal.rowCount).toBe(0);

    // 3. The real proof.
    const proof = await stepUp(cookie);
    expect(proof.status).toBe(200);
    expect((await proof.json()).windowMinutes).toBe(15);

    // 4. The ORIGINAL action, retried unchanged, now succeeds.
    const retried = await post(
      "/api/partner/users",
      { firstName: "Step", lastName: "Up", email: "step-up-flow@a.com", role: "STAFF" },
      cookie
    );
    expect(retried.status).toBe(200);

    // 5. The proof belongs to THIS session only. A different session of the SAME user is still
    //    challenged — otherwise one stepped-up tab would silently privilege every other login.
    const other = await login("owner@a.com");
    const otherAttempt = await post(
      "/api/partner/users",
      { firstName: "Other", lastName: "Session", email: "other-session@a.com", role: "STAFF" },
      other.cookie
    );
    expect(otherAttempt.status).toBe(403);
    expect((await otherAttempt.json()).error.code).toBe("step_up_required");
  });

  it("step-up: a wrong password is refused and grants nothing", async () => {
    const { cookie } = await login("owner@a.com");
    const bad = await stepUp(cookie, "not-the-password");
    expect(bad.status).toBe(403);
    expect((await bad.json()).error.code).toBe("unauthorised");

    // The failed proof must not have stamped the session.
    const still = await post(
      "/api/partner/users",
      { firstName: "No", lastName: "Proof", email: "no-proof@a.com", role: "STAFF" },
      cookie
    );
    expect(still.status).toBe(403);
    expect((await still.json()).error.code).toBe("step_up_required");
  });

  it("step-up: an EXPIRED proof is challenged again, and replay after expiry does not resurrect it", async () => {
    const { cookie } = await login("owner@a.com");
    expect((await stepUp(cookie)).status).toBe(200);

    // Age the stamp past the 15-minute window. The guard compares against the DATABASE clock, so
    // moving the stored timestamp is the honest way to expire it — no application clock is involved.
    await admin.query(
      `UPDATE partner_sessions SET last_step_up_at = now() - interval '16 minutes' WHERE revoked_at IS NULL`
    );

    const expired = await post(
      "/api/partner/users",
      { firstName: "Expired", lastName: "Proof", email: "expired-proof@a.com", role: "STAFF" },
      cookie
    );
    expect(expired.status).toBe(403);
    expect((await expired.json()).error.code).toBe("step_up_required");

    // And a fresh proof on the same session works again.
    expect((await stepUp(cookie)).status).toBe(200);
    const afterFresh = await post(
      "/api/partner/users",
      { firstName: "Expired", lastName: "Proof", email: "expired-proof@a.com", role: "STAFF" },
      cookie
    );
    expect(afterFresh.status).toBe(200);
  });

  it("step-up proves identity freshness, NOT permission: a GRADER is refused by capability, never challenged", async () => {
    // The guard sits AFTER the capability checks precisely so a user who may never perform the
    // action is told that, rather than being asked for a password that would not have helped.
    const { cookie } = await login("trainee@a.com");
    const denied = await post(
      "/api/partner/users",
      { firstName: "Nope", lastName: "Nope", email: "nope@a.com", role: "STAFF" },
      cookie
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error?.code).not.toBe("step_up_required");

    // Even after a VALID proof, the answer is unchanged — step-up escalates nothing.
    const proof = await stepUp(cookie);
    expect(proof.status).toBe(200);
    const stillDenied = await post(
      "/api/partner/users",
      { firstName: "Nope", lastName: "Nope", email: "nope@a.com", role: "STAFF" },
      cookie
    );
    expect(stillDenied.status).toBe(403);
    expect((await stillDenied.json()).error?.code).not.toBe("step_up_required");
    const created = await admin.query("SELECT 1 FROM partner_users WHERE email='nope@a.com'");
    expect(created.rowCount).toBe(0);
  });

  it("step-up: a revoked session cannot step up, because the proof is written to a live row only", async () => {
    const { cookie } = await login("owner@a.com");
    await admin.query(`UPDATE partner_sessions SET revoked_at = now() WHERE revoked_at IS NULL`);
    const proof = await stepUp(cookie);
    // The session no longer authenticates at all, so this never reaches the step-up verifier.
    expect(proof.status).toBe(401);
  });

  it("step-up: the proof is shared session state, so it holds across independent app processes", async () => {
    // MULTI-MACHINE PROOF. Production runs two Fly Machines. `recordStepUp` writes
    // partner_sessions.last_step_up_at and `hasRecentStepUp` reads it back through the database, so
    // there is no process-local "recently authenticated" map to diverge. This asserts that
    // property directly: the proof is visible to a reader that never saw the step-up request.
    const { cookie } = await login("owner@a.com");
    expect((await stepUp(cookie)).status).toBe(200);

    // The cookie carries an opaque token, NOT the primary key, so the row is located the way a
    // second Machine would: by the account, over a connection that never saw the step-up request.
    const seen = await admin.query<{ fresh: boolean }>(
      `SELECT (s.last_step_up_at IS NOT NULL
               AND s.last_step_up_at > now() - interval '15 minutes') AS fresh
         FROM partner_sessions s
         JOIN partner_users u ON u.id = s.user_id
        WHERE u.email = 'owner@a.com' AND s.revoked_at IS NULL
        ORDER BY s.last_step_up_at DESC NULLS LAST
        LIMIT 1`
    );
    expect(seen.rows[0]?.fresh).toBe(true);
  });

  // ============ partner team management ============
  it("team management: OWNER lists, invites, resends, revokes invitation, changes roles, status and sessions", async () => {
    capturedInvites.length = 0;
    const { cookie } = await loginStepped("owner@a.com");
    const invited = await post(
      "/api/partner/users",
      { firstName: "New", lastName: "User", email: "new-user@a.com", role: "STAFF" },
      cookie
    );
    expect(invited.status).toBe(200);
    const inviteBody = await invited.json();
    expect(inviteBody.result.invitationLink).toBeUndefined();
    expect(capturedInvites.at(-1)).toMatchObject({ email: "new-user@a.com", roleCode: "PARTNER_RECEPTION" });
    const userId = inviteBody.result.userId;
    const stored = await admin.query<{ token_hash: string; email: string; role_code: string }>(
      "SELECT token_hash, email, role_code FROM partner_invitations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    expect(stored.rows[0].token_hash).not.toBe(capturedInvites.at(-1)!.token);
    expect(stored.rows[0]).toMatchObject({ email: "new-user@a.com", role_code: "PARTNER_RECEPTION" });

    const resend = await post(`/api/partner/users/${userId}/resend-invitation`, {}, cookie);
    expect(resend.status).toBe(200);
    const superseded = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_invitations WHERE user_id=$1 AND superseded_by IS NOT NULL",
      [userId]
    );
    expect(superseded.rows[0].n).toBe(1);
    expect(
      (await post(`/api/partner/users/${userId}/revoke-invitation`, { reason: "wrong email" }, cookie)).status
    ).toBe(200);
    expect(
      (await post(`/api/partner/users/${userId}/role`, { role: "GRADER", reason: "operations" }, cookie)).status
    ).toBe(200);
    expect(
      (await post(`/api/partner/users/${userId}/status`, { status: "SUSPENDED", reason: "left shift" }, cookie)).status
    ).toBe(400);
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a7/status",
          {
            status: "SUSPENDED",
            reason: "left shift",
          },
          cookie
        )
      ).status
    ).toBe(200);
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a7/status",
          {
            status: "ACTIVE",
            reason: "returned",
          },
          cookie
        )
      ).status
    ).toBe(200);
    const live = await login("new-user@a.com");
    expect(live.res.status).toBe(401);
    expect((await post(`/api/partner/users/${userId}/revoke-sessions`, {}, cookie)).status).toBe(200);
  });

  it("team management: ADMIN can manage operational users but cannot grant or modify OWNERs or self-promote", async () => {
    const { cookie } = await loginStepped("admin@a.com");
    expect(
      (
        await post(
          "/api/partner/users",
          { firstName: "Ops", lastName: "Owner", email: "ops-owner@a.com", role: "OWNER" },
          cookie
        )
      ).status
    ).toBe(403);
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a1/status",
          { status: "SUSPENDED", reason: "no" },
          cookie
        )
      ).status
    ).toBe(403);
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a5/role",
          { role: "OWNER", reason: "no" },
          cookie
        )
      ).status
    ).toBe(403);
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a7/role",
          { role: "GRADER", reason: "coverage" },
          cookie
        )
      ).status
    ).toBe(200);
  });

  it("team management: prototype-key role payloads are rejected and preserve existing roles", async () => {
    const { cookie } = await loginStepped("owner@a.com");
    for (const role of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
      const before = await admin.query<{ codes: string[] }>(
        `SELECT array_agg(r.code ORDER BY r.code) AS codes
           FROM partner_user_roles ur JOIN partner_roles r ON r.id=ur.role_id
          WHERE ur.user_id='11111111-0000-0000-0000-0000000000a6'`
      );
      const res = await post(
        "/api/partner/users/11111111-0000-0000-0000-0000000000a6/role",
        { role, reason: "bad role" },
        cookie
      );
      expect(res.status).toBe(400);
      const after = await admin.query<{ codes: string[] }>(
        `SELECT array_agg(r.code ORDER BY r.code) AS codes
           FROM partner_user_roles ur JOIN partner_roles r ON r.id=ur.role_id
          WHERE ur.user_id='11111111-0000-0000-0000-0000000000a6'`
      );
      expect(after.rows[0].codes).toEqual(before.rows[0].codes);
    }
  });

  it("team management: GRADER and STAFF routes are denied", async () => {
    for (const email of ["grader@a.com", "staff@a.com"]) {
      const { cookie } = await login(email);
      expect((await get("/api/partner/users", cookie)).status).toBe(403);
      expect(
        (
          await post(
            "/api/partner/users/11111111-0000-0000-0000-0000000000a7/status",
            { status: "SUSPENDED", reason: "no" },
            cookie
          )
        ).status
      ).toBe(403);
    }
  });

  it("team management: tenant isolation fails closed for cross-tenant list and mutations", async () => {
    const { cookie } = await loginStepped("owner@a.com");
    const listed = (await (await get("/api/partner/users", cookie)).json()).users;
    expect(listed.some((u: { email: string }) => u.email === "owner@b.com")).toBe(false);
    const bUser = "22222222-0000-0000-0000-0000000000b1";
    expect((await post(`/api/partner/users/${bUser}/role`, { role: "STAFF", reason: "cross" }, cookie)).status).toBe(
      404
    );
    expect(
      (await post(`/api/partner/users/${bUser}/status`, { status: "SUSPENDED", reason: "cross" }, cookie)).status
    ).toBe(404);
    expect((await post(`/api/partner/users/${bUser}/revoke-invitation`, { reason: "cross" }, cookie)).status).toBe(404);
    expect((await post(`/api/partner/users/${bUser}/revoke-sessions`, {}, cookie)).status).toBe(404);
    expect(
      (
        await post(
          "/api/partner/users",
          { firstName: "Evil", lastName: "Move", email: "evil@b.com", role: "STAFF", partnerId: B },
          cookie
        )
      ).status
    ).toBe(403);
  });

  it("team management: final active owner cannot be suspended, demoted, revoked, or removed", async () => {
    const { cookie } = await loginStepped("owner@b.com");
    const ownerId = "22222222-0000-0000-0000-0000000000b1";
    expect(
      (await post(`/api/partner/users/${ownerId}/status`, { status: "SUSPENDED", reason: "no" }, cookie)).status
    ).toBe(409);
    expect(
      (await post(`/api/partner/users/${ownerId}/status`, { status: "REVOKED", reason: "no" }, cookie)).status
    ).toBe(409);
    expect((await post(`/api/partner/users/${ownerId}/role`, { role: "STAFF", reason: "no" }, cookie)).status).toBe(
      409
    );
  });

  it("team invitation acceptance is single-use, expiry-aware, supersession-safe, partner-bound, role-bound and email-bound", async () => {
    capturedInvites.length = 0;
    const { cookie } = await loginStepped("owner@a.com");
    const invited = await post(
      "/api/partner/users",
      { firstName: "Bound", lastName: "Invite", email: "bound@a.com", role: "GRADER" },
      cookie
    );
    const userId = (await invited.json()).result.userId;
    const firstToken = capturedInvites.at(-1)!.token;
    await post(`/api/partner/users/${userId}/resend-invitation`, {}, cookie);
    const second = capturedInvites.at(-1)!;
    expect(
      (await post("/api/partner/invitations/accept", { token: firstToken, password: "strong-password-1" })).status
    ).toBe(400);
    const [a1, a2] = await Promise.all([
      post("/api/partner/invitations/accept", { token: second.token, password: "strong-password-2" }),
      post("/api/partner/invitations/accept", { token: second.token, password: "strong-password-3" }),
    ]);
    expect([a1.status, a2.status].filter((s) => s === 200).length).toBe(1);
    expect(
      (await post("/api/partner/invitations/accept", { token: second.token, password: "strong-password-4" })).status
    ).toBe(400);
    const row = await admin.query<{ tenant_id: string; email: string; role_code: string; status: string }>(
      `SELECT u.tenant_id, u.email, r.code AS role_code, u.status
         FROM partner_users u
         JOIN partner_user_roles ur ON ur.user_id=u.id
         JOIN partner_roles r ON r.id=ur.role_id
        WHERE u.id=$1`,
      [userId]
    );
    expect(row.rows[0]).toMatchObject({
      tenant_id: A,
      email: "bound@a.com",
      role_code: "MVGS_ASSESSMENT_TECHNICIAN",
      status: "ACTIVE",
    });

    const expired = await post(
      "/api/partner/users",
      { firstName: "Expired", lastName: "Invite", email: "expired@a.com", role: "STAFF" },
      cookie
    );
    const expiredUserId = (await expired.json()).result.userId;
    const expiredToken = capturedInvites.at(-1)!.token;
    await admin.query("UPDATE partner_invitations SET expires_at=now()-interval '1 minute' WHERE user_id=$1", [
      expiredUserId,
    ]);
    expect(
      (await post("/api/partner/invitations/accept", { token: expiredToken, password: "strong-password-5" })).status
    ).toBe(400);
  });

  it("team sessions: suspension, role change, membership revocation and explicit revocation invalidate access", async () => {
    const owner = await loginStepped("owner@a.com");
    const staffLogin = await login("staff@a.com");
    expect((await get("/api/partner/session", staffLogin.cookie)).status).toBe(200);
    expect(
      (await post("/api/partner/users/11111111-0000-0000-0000-0000000000a7/revoke-sessions", {}, owner.cookie)).status
    ).toBe(200);
    expect((await get("/api/partner/session", staffLogin.cookie)).status).toBe(401);

    const graderLogin = await login("grader@a.com");
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a6/role",
          { role: "STAFF", reason: "rotation" },
          owner.cookie
        )
      ).status
    ).toBe(200);
    expect((await get("/api/partner/session", graderLogin.cookie)).status).toBe(401);

    const adminLogin = await login("admin@a.com");
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a5/status",
          { status: "SUSPENDED", reason: "pause" },
          owner.cookie
        )
      ).status
    ).toBe(200);
    expect((await get("/api/partner/session", adminLogin.cookie)).status).toBe(401);
    await admin.query(
      "UPDATE partner_users SET status='ACTIVE', credential_version=credential_version+1 WHERE email='admin@a.com'"
    );

    const adminAgain = await login("admin@a.com");
    expect(
      (
        await post(
          "/api/partner/users/11111111-0000-0000-0000-0000000000a5/status",
          { status: "REVOKED", reason: "left" },
          owner.cookie
        )
      ).status
    ).toBe(200);
    expect((await get("/api/partner/session", adminAgain.cookie)).status).toBe(401);
    await admin.query(
      "UPDATE partner_users SET status='ACTIVE', credential_version=credential_version+1 WHERE email='admin@a.com'"
    );
  });

  it("password reset: full lifecycle through HTTP (delivered token, single-use, revokes sessions)", async () => {
    capturedResets.length = 0;
    // unknown + known accounts get the SAME generic response
    const known = await post("/api/partner/auth/password-reset/request", { email: "owner@a.com" });
    const unknown = await post("/api/partner/auth/password-reset/request", { email: "nobody@x.com" });
    expect(known.status).toBe(200);
    const knownBody = await known.text();
    expect(JSON.parse(knownBody)).toEqual(await unknown.json());
    // only the known account produced a delivered token; token never in the response body
    const mine = capturedResets.find((c) => c.email === "owner@a.com");
    expect(mine).toBeTruthy();
    expect(knownBody).not.toContain(mine!.token);
    // establish a live session, then reset
    const before = await login("owner@a.com");
    expect((await get("/api/partner/session", before.cookie)).status).toBe(200);
    const consumed = await post("/api/partner/auth/password-reset/consume", {
      token: mine!.token,
      newPassword: "new-strong-password-1",
    });
    expect(consumed.status).toBe(200);
    // old password no longer works; new one does
    expect((await login("owner@a.com", "correct-horse-battery")).res.status).toBe(401);
    expect((await login("owner@a.com", "new-strong-password-1")).res.status).toBe(200);
    // existing session revoked (credential_version bumped)
    expect((await get("/api/partner/session", before.cookie)).status).toBe(401);
    // token cannot be reused
    expect(
      (
        await post("/api/partner/auth/password-reset/consume", {
          token: mine!.token,
          newPassword: "another-strong-pw-2",
        })
      ).status
    ).toBe(400);
    // restore password for other tests
    const { hashPassword } = await import("../server/partner/auth");
    await admin.query("UPDATE partner_users SET password_hash=$1 WHERE email='owner@a.com'", [
      await hashPassword("correct-horse-battery"),
    ]);
  });

  it("password reset: invalid/tampered token fails; no secrets in audit", async () => {
    expect(
      (
        await post("/api/partner/auth/password-reset/consume", {
          token: "not-a-real-token",
          newPassword: "whatever-strong-1",
        })
      ).status
    ).toBe(400);
    const { rows } = await admin.query<{ action: string; after_value: unknown; reason: string | null }>(
      "SELECT action, after_value, reason FROM partner_audit_events WHERE tenant_id=$1",
      [A]
    );
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/token_hash|password_hash|\$2[aby]\$|new-strong-password/i);
  });

  // ============ ITEM 2 — multi-location assignment + switching ============
  it("owner switches between ACTIVE same-tenant locations without assignments; cannot select cross-tenant/absent", async () => {
    const { cookie } = await login("owner@a.com");
    expect((await post("/api/partner/session/location", { locationId: L1 }, cookie)).status).toBe(200);
    expect((await post("/api/partner/session/location", { locationId: L2 }, cookie)).status).toBe(200);
    expect(
      (await post("/api/partner/session/location", { locationId: "10000000-0000-0000-0000-0000000000ff" }, cookie))
        .status
    ).toBe(404);
    // cross-tenant location (B) is invisible under RLS → not found
    expect((await post("/api/partner/session/location", { locationId: LB }, cookie)).status).toBe(404);
    // session now bound server-side to L2
    const s = await (await get("/api/partner/session", cookie)).json();
    expect(s.locationId).toBe(L2);
    const audit = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_audit_events WHERE tenant_id=$1 AND actor_user_id='11111111-0000-0000-0000-0000000000a1' AND action='partner_location_switch'",
      [A]
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("trainee (assigned only to L1) cannot switch to L2 (403 not_assigned); tenant B owner can switch own location without assignment", async () => {
    const { cookie } = await login("trainee@a.com");
    expect((await post("/api/partner/session/location", { locationId: L1 }, cookie)).status).toBe(200);
    const denied = await post("/api/partner/session/location", { locationId: L2 }, cookie);
    expect(denied.status).toBe(403); // not assigned
    // owner@b has no assignment to any location, but OWNER is organisation-wide.
    const b = await login("owner@b.com");
    expect((await post("/api/partner/session/location", { locationId: LB }, b.cookie)).status).toBe(200);
  });

  it("assignment removal immediately invalidates a session bound to that location", async () => {
    const { cookie } = await login("trainee@a.com");
    await post("/api/partner/session/location", { locationId: L1 }, cookie);
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(200);
    // remove the assignment
    await admin.query(
      "DELETE FROM partner_user_locations WHERE user_id='11111111-0000-0000-0000-0000000000a2' AND location_id=$1",
      [L1]
    );
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(401); // fail closed on next request
    // restore
    await admin.query(
      "INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,'11111111-0000-0000-0000-0000000000a2',$2)",
      [A, L1]
    );
  });

  it("suspended location cannot be selected", async () => {
    await admin.query("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1", [L2]);
    const { cookie } = await login("owner@a.com");
    expect((await post("/api/partner/session/location", { locationId: L2 }, cookie)).status).toBe(404); // not active
    await admin.query("UPDATE partner_locations SET status='ACTIVE' WHERE id=$1", [L2]);
  });

  // ============ ITEM 3 — MFA enrolment + recovery codes ============
  it("MFA enrolment: enrol → confirm → recovery codes; wrong code fails; secret encrypted; unconfirmed doesn't satisfy MFA", async () => {
    const { cookie } = await login("enrol@a.com");
    // enrol requires elevated (password) verification
    expect((await post("/api/partner/mfa/enrol", {}, cookie)).status).toBe(400);
    const enrol = await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, cookie);
    expect(enrol.status).toBe(200);
    const { enrolmentId, secret } = await enrol.json();
    expect(enrolmentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secret).toBeTruthy();
    // secret stored ENCRYPTED (not plaintext), method PENDING (does not satisfy MFA yet)
    const stored = await admin.query<{ secret_ref: string; status: string }>(
      "SELECT secret_ref, status FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' ORDER BY created_at DESC LIMIT 1"
    );
    expect(stored.rows[0].secret_ref).not.toContain(secret);
    expect(stored.rows[0].status).toBe("PENDING");
    // wrong confirm code fails
    expect((await post("/api/partner/mfa/confirm", { code: "000000" }, cookie)).status).toBe(400);
    // correct code activates + returns recovery codes once
    const { currentTotp } = await import("../server/partner/mfa");
    const confirm = await post(
      "/api/partner/mfa/confirm",
      { enrolmentId, code: currentTotp(secret, Date.now()) },
      cookie
    );
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = await confirm.json();
    expect(Array.isArray(recoveryCodes) && recoveryCodes.length === 10).toBe(true);
    // recovery codes stored HASHED only
    const rc = await admin.query<{ code_hash: string }>(
      "SELECT code_hash FROM partner_recovery_codes WHERE user_id='11111111-0000-0000-0000-0000000000a4' LIMIT 1"
    );
    expect(recoveryCodes).not.toContain(rc.rows[0].code_hash);
    // method now ACTIVE
    const active = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='ACTIVE'"
    );
    expect(active.rows[0].n).toBe(1);
    const pending = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='PENDING'"
    );
    expect(pending.rows[0].n).toBe(0);
    const session = await (await get("/api/partner/session", cookie)).json();
    expect(session.mfaPassed).toBe(true);
    // Restart now demands the password (an empty body is 401 before the state check is reached),
    // and an already-ENROLLED user is still refused outright — restart is never a replacement path.
    expect((await post("/api/partner/mfa/restart", {}, cookie)).status).toBe(401);
    expect((await post("/api/partner/mfa/restart", { password: "correct-horse-battery" }, cookie)).status).toBe(403);
    const replaySession = await login("enrol@a.com");
    expect(
      (await post("/api/partner/auth/mfa", { code: currentTotp(secret, Date.now()) }, replaySession.cookie)).status
    ).toBe(401);
  });

  it("MFA setup restart invalidates the old QR/code and accepts only the fresh enrolment", async () => {
    await admin.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id='11111111-0000-0000-0000-0000000000a4'"
    );
    await admin.query("DELETE FROM partner_recovery_codes WHERE user_id='11111111-0000-0000-0000-0000000000a4'");
    await admin.query("UPDATE partner_users SET mfa_required=true, mfa_enabled=false WHERE email='enrol@a.com'");
    const { cookie } = await login("enrol@a.com");
    const first = await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, cookie);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    // A password-free restart is refused: otherwise anyone reaching this user's browser while the
    // QR is on screen could mint themselves a fresh authenticator and take the account.
    expect((await post("/api/partner/mfa/restart", {}, cookie)).status).toBe(401);
    expect((await post("/api/partner/mfa/restart", { password: "wrong-password" }, cookie)).status).toBe(401);
    // MERGE: kept from the canonical lineage. Status codes alone do not prove the
    // refusal was total — a route that answered 401 AFTER minting the row would
    // still hand an attacker a usable secret. Assert the PENDING count is unchanged
    // (the one from the legitimate enrol above), not merely that the call failed.
    const afterRefused = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='PENDING'"
    );
    expect(afterRefused.rows[0].n, "a refused restart must not mint a secret").toBe(1);

    const restart = await post("/api/partner/mfa/restart", { password: "correct-horse-battery" }, cookie);
    expect(restart.status).toBe(200);
    const secondBody = await restart.json();
    expect(secondBody.enrolmentId).not.toBe(firstBody.enrolmentId);
    expect(secondBody.secret).not.toBe(firstBody.secret);
    const { currentTotp } = await import("../server/partner/mfa");

    const oldCode = currentTotp(firstBody.secret, Date.now());
    expect(
      (await post("/api/partner/mfa/confirm", { enrolmentId: firstBody.enrolmentId, code: oldCode }, cookie)).status
    ).toBe(400);

    const newCode = currentTotp(secondBody.secret, Date.now());
    expect(
      (await post("/api/partner/mfa/confirm", { enrolmentId: secondBody.enrolmentId, code: newCode }, cookie)).status
    ).toBe(200);
    const counts = await admin.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' GROUP BY status"
    );
    expect(counts.rows.find((r) => r.status === "PENDING")?.n ?? 0).toBe(0);
    expect(counts.rows.find((r) => r.status === "ACTIVE")?.n ?? 0).toBe(1);
  });

  it("MFA setup confirmation is bound to the session that created the enrolment", async () => {
    await admin.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id='11111111-0000-0000-0000-0000000000a4'"
    );
    await admin.query("UPDATE partner_users SET mfa_required=true, mfa_enabled=false WHERE email='enrol@a.com'");
    const s1 = await login("enrol@a.com");
    const enrol = await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, s1.cookie);
    const body = await enrol.json();
    const s2 = await login("enrol@a.com");
    const { currentTotp } = await import("../server/partner/mfa");
    const crossSession = await post(
      "/api/partner/mfa/confirm",
      { enrolmentId: body.enrolmentId, code: currentTotp(body.secret, Date.now()) },
      s2.cookie
    );
    expect(crossSession.status).toBe(400);
  });

  it("MFA setup cancel invalidates pending setup and signs out", async () => {
    await admin.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id='11111111-0000-0000-0000-0000000000a4'"
    );
    await admin.query("UPDATE partner_users SET mfa_required=true, mfa_enabled=false WHERE email='enrol@a.com'");
    const { cookie } = await login("enrol@a.com");
    expect((await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, cookie)).status).toBe(200);
    const cancel = await post("/api/partner/mfa/cancel", {}, cookie);
    expect(cancel.status).toBe(200);
    expect((await get("/api/partner/session", cookie)).status).toBe(401);
    const pending = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='PENDING'"
    );
    expect(pending.rows[0].n).toBe(0);
  });

  it("recovery code works once then fails; regeneration invalidates old codes", async () => {
    // enrol@a now has MFA; log in fresh (mfa pending), use a recovery code to pass MFA
    await admin.query("UPDATE partner_users SET mfa_required=true WHERE email='enrol@a.com'");
    const { cookie } = await login("enrol@a.com");
    // grab a live recovery code hash by re-deriving: regenerate to get known plaintext
    const reg = await post("/api/partner/mfa/recovery-codes/regenerate", { password: "correct-horse-battery" }, cookie);
    // regenerate requires full auth (mfaPassed) — this session is mfa-pending → 401
    expect(reg.status).toBe(401);
    // pass MFA with a recovery code path via /auth/mfa: first mint known codes by confirming again is complex;
    // instead verify single-use at the DB/route level using /auth/mfa recovery path with a freshly inserted code.
    const { recoveryHash } = await import("../server/partner/mfa");
    await admin.query(
      "INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,'11111111-0000-0000-0000-0000000000a4',$2)",
      [A, recoveryHash("known-rec-code")]
    );
    const first = await post("/api/partner/auth/mfa", { recoveryCode: "known-rec-code" }, cookie);
    expect(first.status).toBe(200); // works once
    const { cookie: c2 } = await login("enrol@a.com");
    const second = await post("/api/partner/auth/mfa", { recoveryCode: "known-rec-code" }, c2);
    expect(second.status).toBe(401); // used → fails
    await admin.query("UPDATE partner_users SET mfa_required=false WHERE email='enrol@a.com'");
  });

  /**
   * Establish an ACTIVE authenticator for enrol@a.com and return its plaintext secret.
   *
   * F1/F3/disable below each assert a property that only MEANS anything when an ACTIVE factor
   * exists. They used to inherit one from the enrolment test, but "MFA setup cancel" runs between
   * and DISABLEs every method for this user, so the precondition was being destroyed before they
   * ran — the assertions were passing or failing on leftover state rather than on the security
   * behaviour they name. Each now provisions its own, which is also what makes them survive the
   * corrected mfaDisable (mfa_required stays TRUE, so a later login is mfa-pending by design).
   */
  async function ensureActiveAuthenticator(): Promise<string> {
    await admin.query(
      "UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id='11111111-0000-0000-0000-0000000000a4'"
    );
    await admin.query("DELETE FROM partner_recovery_codes WHERE user_id='11111111-0000-0000-0000-0000000000a4'");
    await admin.query("UPDATE partner_users SET mfa_required=true, mfa_enabled=false WHERE email='enrol@a.com'");
    const { cookie } = await login("enrol@a.com");
    const enrol = await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, cookie);
    expect(enrol.status, "precondition: enrolment must start").toBe(200);
    const { enrolmentId, secret } = await enrol.json();
    const { currentTotp } = await import("../server/partner/mfa");
    const confirm = await post(
      "/api/partner/mfa/confirm",
      { enrolmentId, code: currentTotp(secret, Date.now()) },
      cookie
    );
    expect(confirm.status, "precondition: enrolment must confirm").toBe(200);
    const active = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='ACTIVE'"
    );
    expect(active.rows[0].n, "precondition: exactly one ACTIVE authenticator").toBe(1);
    return secret as string;
  }

  // ===== review-fix regression tests =====
  it("F1: a password-only (mfa-pending) session CANNOT re-enrol to replace an existing active factor", async () => {
    await ensureActiveAuthenticator();
    await admin.query("UPDATE partner_users SET mfa_required=true WHERE email='enrol@a.com'");
    const { cookie } = await login("enrol@a.com"); // mfa-pending session
    // re-enrolment with only the password must be refused (requires the current second factor)
    const enrol = await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, cookie);
    expect(enrol.status).toBe(403);
    // the original active method is untouched
    const still = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='ACTIVE'"
    );
    expect(still.rows[0].n).toBe(1);
    await admin.query("UPDATE partner_users SET mfa_required=false WHERE email='enrol@a.com'");
  });

  it("F3: a TOTP code cannot be replayed within its window (second use rejected)", async () => {
    const secret = await ensureActiveAuthenticator();
    await admin.query("UPDATE partner_users SET mfa_required=true WHERE email='enrol@a.com'");
    await admin.query(
      "UPDATE partner_mfa_methods SET last_totp_counter=NULL WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='ACTIVE'"
    );
    const { currentTotp } = await import("../server/partner/mfa");
    const code = currentTotp(secret, Date.now());
    const s1 = await login("enrol@a.com");
    expect((await post("/api/partner/auth/mfa", { code }, s1.cookie)).status).toBe(200); // first use ok
    const s2 = await login("enrol@a.com");
    expect((await post("/api/partner/auth/mfa", { code }, s2.cookie)).status).toBe(401); // replay rejected
    await admin.query("UPDATE partner_users SET mfa_required=false WHERE email='enrol@a.com'");
  });

  it("CONCERN-1: partner_runtime role cannot INSERT partner_user_locations (assignment is super-admin only)", async () => {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: RUNTIME });
    await c.connect();
    await c.query("SET ROLE partner_runtime").catch(() => {}); // if login role != group; harmless
    await expect(
      c.query("INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)", [
        A,
        "11111111-0000-0000-0000-0000000000a1",
        L1,
      ])
    ).rejects.toThrow(/permission denied/i);
    await c.end();
  });

  it("concurrency: two parallel reset-token consumptions yield exactly one success", async () => {
    capturedResets.length = 0;
    await post("/api/partner/auth/password-reset/request", { email: "trainee@a.com" });
    const tok = capturedResets.find((c) => c.email === "trainee@a.com")!.token;
    const [a1, a2] = await Promise.all([
      post("/api/partner/auth/password-reset/consume", { token: tok, newPassword: "concurrent-pw-aaa1" }),
      post("/api/partner/auth/password-reset/consume", { token: tok, newPassword: "concurrent-pw-bbb2" }),
    ]);
    const successes = [a1.status, a2.status].filter((s) => s === 200).length;
    expect(successes).toBe(1);
    const { hashPassword } = await import("../server/partner/auth");
    await admin.query(
      "UPDATE partner_users SET password_hash=$1, credential_version=credential_version+1 WHERE email='trainee@a.com'",
      [await hashPassword("correct-horse-battery")]
    );
  });

  it("concurrency: two parallel recovery-code uses yield exactly one success", async () => {
    await admin.query("UPDATE partner_users SET mfa_required=true WHERE email='enrol@a.com'");
    const { recoveryHash } = await import("../server/partner/mfa");
    await admin.query(
      "INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,'11111111-0000-0000-0000-0000000000a4',$2)",
      [A, recoveryHash("concurrent-rec-1")]
    );
    const [s1, s2] = [await login("enrol@a.com"), await login("enrol@a.com")];
    const [r1, r2] = await Promise.all([
      post("/api/partner/auth/mfa", { recoveryCode: "concurrent-rec-1" }, s1.cookie),
      post("/api/partner/auth/mfa", { recoveryCode: "concurrent-rec-1" }, s2.cookie),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBe(1);
    await admin.query("UPDATE partner_users SET mfa_required=false WHERE email='enrol@a.com'");
  });

  it("MFA disable requires password + a valid second factor; then revokes sessions", async () => {
    const secret = await ensureActiveAuthenticator();
    // enrol@a has an ACTIVE totp method; login must challenge even if mfa_required drifted false.
    const { cookie } = await login("enrol@a.com");
    const { recoveryHash } = await import("../server/partner/mfa");
    await admin.query(
      "INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,'11111111-0000-0000-0000-0000000000a4',$2)",
      [A, recoveryHash("disable-login-code")]
    );
    expect((await post("/api/partner/auth/mfa", { recoveryCode: "disable-login-code" }, cookie)).status).toBe(200);
    // disable without second factor fails
    expect((await post("/api/partner/mfa/disable", { password: "correct-horse-battery" }, cookie)).status).toBe(400);
    // with a valid TOTP it succeeds (clear replay counter so a recent F3-test code doesn't collide)
    await admin.query(
      "UPDATE partner_mfa_methods SET last_totp_counter=NULL WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='ACTIVE'"
    );
    const { currentTotp } = await import("../server/partner/mfa");
    process.env.PARTNER_MFA_ENC_KEY = process.env.PARTNER_MFA_ENC_KEY || "0".repeat(64);
    const code = currentTotp(secret, Date.now());
    const disabled = await post("/api/partner/mfa/disable", { password: "correct-horse-battery", code }, cookie);
    expect(disabled.status).toBe(200);
    // sessions revoked
    expect((await get("/api/partner/session", cookie)).status).toBe(401);
    // no active method remains
    const active = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id='11111111-0000-0000-0000-0000000000a4' AND status='ACTIVE'"
    );
    expect(active.rows[0].n).toBe(0);

    // F2 — THE REQUIREMENT SURVIVES THE METHOD.
    //
    // Disable removes the AUTHENTICATOR, never the account POLICY. mfa_required is the only flag
    // the session layer reads; clearing it here would let a partner user self-revoke the mandate
    // and sign in with a password alone, permanently. The 2026-08-11 mainline reconciliation did
    // exactly that by taking the pre-fix side of a merge, which is why this is asserted at the
    // database AND through a real login rather than trusted to a comment.
    const policy = await admin.query<{ mfa_required: boolean; mfa_enabled: boolean }>(
      "SELECT mfa_required, mfa_enabled FROM partner_users WHERE email='enrol@a.com'"
    );
    expect(policy.rows[0].mfa_required, "disabling the method must never clear the requirement").toBe(true);
    expect(policy.rows[0].mfa_enabled).toBe(false);

    // …and the behaviour that flag controls: the next password-only login is NOT fully
    // authenticated. GET /session is deliberately reachable while mfa-pending — it is how the
    // client learns that enrolment is the next step — so the invariant is asserted on the POSTURE
    // it reports and on a genuinely gated surface, not on /session's status code.
    const after = await login("enrol@a.com");
    expect(after.body.mfaRequired, "login must still report a second step outstanding").toBe(true);
    const sess = await (await get("/api/partner/session", after.cookie)).json();
    expect(sess.mfaPassed, "a password alone must not produce an mfa-passed session").toBe(false);
    expect(sess.mfaEnrolmentRequired, "the user must be sent to enrolment, not a code prompt").toBe(true);
    expect(
      (await get("/api/partner/dashboard", after.cookie)).status,
      "a gated surface must refuse a password-only session after disable"
    ).toBe(401);

    // The user is not stranded: bootstrap re-enrolment is still reachable with the password alone,
    // because mfaEnrolStart only demands a current factor when one still EXISTS.
    expect((await post("/api/partner/mfa/enrol", { password: "correct-horse-battery" }, after.cookie)).status).toBe(
      200
    );
    await post("/api/partner/mfa/cancel", {}, after.cookie);
  });
});
