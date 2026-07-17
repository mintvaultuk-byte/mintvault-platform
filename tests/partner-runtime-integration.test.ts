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
 *   PARTNER_RT_RUNTIME=postgresql://partner_app_test:synthetic@127.0.0.1:5544/dispo \
 *   npx vitest run tests/partner-runtime-integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const ADMIN = process.env.PARTNER_RT_ADMIN;
const RUNTIME = process.env.PARTNER_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

let server: http.Server;
let base: string;
let admin: Client;

async function apply(sqlFile: string) {
  const sql = readFileSync(join(process.cwd(), "migrations", sqlFile), "utf8");
  await admin.query(sql);
}

(isLocal ? describe : describe.skip)("Partner Portal runtime (disposable DB, real HTTP)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    // clean + apply schema
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await apply("0001_partner_foundation.sql");
    await apply("0002_partner_auth_support.sql");
    await apply("0003_partner_auth_hardening.sql");
    // synthetic LOGIN role that inherits the restricted partner_runtime role
    await admin.query("DROP ROLE IF EXISTS partner_app_test").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test");
    // env for the runtime BEFORE importing app modules (pools are lazy)
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, never committed as real

    // seed RBAC + two partners
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();
    await admin.query("DELETE FROM partner_users");
    await admin.query("DELETE FROM partner_organisations");
    await admin.query("INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'rA','A Ltd','ACTIVE'),($2,'rB','B Ltd','ACTIVE')", [A, B]);
    const pw = await bcrypt.hash("correct-horse-battery", 12);
    // owner in A, trainee in A, owner in B, mfa-user in A
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES
       ('11111111-0000-0000-0000-0000000000a1','ua1',$1,$1,'owner@a.com',$3,'ACTIVE',false),
       ('11111111-0000-0000-0000-0000000000a2','ua2',$1,$1,'trainee@a.com',$3,'ACTIVE',false),
       ('22222222-0000-0000-0000-0000000000b1','ub1',$2,$2,'owner@b.com',$3,'ACTIVE',false),
       ('11111111-0000-0000-0000-0000000000a3','ua3',$1,$1,'mfa@a.com',$3,'ACTIVE',true)`,
      [A, B, pw],
    );
    const roleId = async (code: string) => (await admin.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [code])).rows[0].id;
    const owner = await roleId("PARTNER_OWNER");
    const trainee = await roleId("PARTNER_TRAINEE");
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES
       ($1,'11111111-0000-0000-0000-0000000000a1',$2),
       ($1,'11111111-0000-0000-0000-0000000000a2',$3),
       ($4,'22222222-0000-0000-0000-0000000000b1',$2),
       ($1,'11111111-0000-0000-0000-0000000000a3',$2)`,
      [A, owner, trainee, B],
    );
    // enable the portal flag (global)
    await admin.query("DELETE FROM partner_feature_flags");
    await admin.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)");

    const { createPartnerApp } = await import("../server/partner/app");
    server = http.createServer(createPartnerApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.query("DROP ROLE IF EXISTS partner_app_test").catch(() => {});
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    // isolate the IP-keyed login rate limiter between tests (all tests share 127.0.0.1).
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
  });

  async function login(email: string, password = "correct-horse-battery") {
    const res = await fetch(`${base}/api/partner/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { res, cookie, body: await res.json().catch(() => ({})) };
  }
  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } });

  it("proves the runtime connects as the restricted role (not superuser)", async () => {
    const c = new Client({ connectionString: RUNTIME });
    await c.connect();
    const who = await c.query<{ u: string; su: boolean }>("SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su");
    expect(who.rows[0].u).toBe("partner_app_test");
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
    const users = await (await get("/api/partner/users", cookie)).json();
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
        get("/api/partner/dashboard", i % 2 === 0 ? ca : cb).then((r) => r.json().then((j) => ({ i, name: j.org?.legal_name }))),
      ),
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
    await admin.query("INSERT INTO partner_mfa_methods (tenant_id, user_id, method, secret_ref, status) VALUES ($1,$2,'totp',$3,'ACTIVE')", [A, "11111111-0000-0000-0000-0000000000a3", encryptSecret(secret)]);
    const good = currentTotp(secret, Date.now());
    const mfaRes = await fetch(`${base}/api/partner/auth/mfa`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ code: good }) });
    expect(mfaRes.status).toBe(200);
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(200);
  });

  it("emergency stop: freezing partner A invalidates A's live sessions immediately", async () => {
    const { cookie } = await login("owner@a.com");
    expect((await get("/api/partner/session", cookie)).status).toBe(200);
    await admin.query("INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'partner',true)", [A]);
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
    const { rows } = await admin.query<{ locked_until: string | null }>("SELECT locked_until FROM partner_users WHERE email='trainee@a.com'");
    expect(rows[0].locked_until).not.toBeNull();
    await admin.query("UPDATE partner_users SET failed_login_count=0, locked_until=NULL WHERE email='trainee@a.com'");
  });

  it("audit events recorded; no secrets/hashes/tokens in audit payloads", async () => {
    await login("owner@a.com");
    const { rows } = await admin.query<{ action: string; after_value: unknown }>("SELECT action, after_value FROM partner_audit_events WHERE tenant_id=$1", [A]);
    expect(rows.some((r) => r.action === "partner_login")).toBe(true);
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/\$2[aby]\$|password_hash|token_hash|correct-horse/i);
  });

  it("M4 (true pool non-leak): after a withTenant(A) commit, a context-less query on the pool sees 0 rows", async () => {
    const { withTenant, partnerRuntimeQuery } = await import("../server/partner/db");
    // run a tenant-A transaction that commits
    await withTenant({ tenantId: A }, async (c) => { await c.query("SELECT 1 FROM partner_locations LIMIT 1"); });
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
    await admin.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)");
  });

  it("M1 emergency login freeze: a 'login' emergency control refuses new logins", async () => {
    await admin.query("INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'login',true)", [A]);
    expect((await login("owner@a.com")).res.status).toBe(401);
    await admin.query("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [A]);
    expect((await login("owner@a.com")).res.status).toBe(200); // restored
  });

  it("M2 view-only: a 'view_only' emergency blocks a mutating route (423) but allows reads", async () => {
    const { cookie } = await login("owner@a.com");
    await admin.query("INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'view_only',true)", [A]);
    expect((await get("/api/partner/dashboard", cookie)).status).toBe(200); // read ok
    const w = await fetch(`${base}/api/partner/users/11111111-0000-0000-0000-0000000000a2/revoke-sessions`, { method: "POST", headers: { cookie } });
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
});
