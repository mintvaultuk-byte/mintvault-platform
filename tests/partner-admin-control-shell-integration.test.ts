/**
 * Phase 1 closeout — Super Admin Partner Network control-shell HTTP integration test.
 *
 * Boots a repository-consistent MAIN-app composition that genuinely mounts the REAL requireAdmin and
 * the real superAdminPartnerRouter (registerSuperAdminPartnerRoutes), plus the isolated Partner Portal
 * app for effect assertions — both against ONE disposable Postgres. requireAdmin is NOT bypassed: it
 * runs fully (session.isAdmin + absolute expiry + getUserByEmail(ADMIN_EMAIL) + credential_version).
 * The only synthetic element is a TEST-ONLY admin-login route that stamps the same session the real
 * login+PIN flow would — it lives ONLY on this test app instance, never in shipped server/ code.
 *
 * Runs only when PARTNER_ADMIN_TEST (superuser URL to a DISPOSABLE local Postgres) and
 * PARTNER_ADMIN_TEST_RUNTIME (restricted-role URL) are set and local. Skips otherwise; refuses non-local.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_ADMIN_TEST;
const RUNTIME_DB = process.env.PARTNER_ADMIN_TEST_RUNTIME;
// LOW-1/LOW-2: guard BOTH URLs by parsing the real hostname (not a substring regex that a crafted
// multi-@ URL could spoof). Fails closed to skip unless both resolve to a loopback host.
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN_DB) && isLoopback(RUNTIME_DB);

const A = "aaaa1111-0000-0000-0000-000000000001";
const B = "bbbb2222-0000-0000-0000-000000000002";
const LA1 = "1a1a0000-0000-0000-0000-0000000000c1";
const LA2 = "1a1a0000-0000-0000-0000-0000000000c2";
const UA_OWNER = "0a0a0000-0000-0000-0000-0000000000a1";
const UA_TECH = "0a0a0000-0000-0000-0000-0000000000a2";
const UB_OWNER = "0b0b0000-0000-0000-0000-0000000000b1";

const USERS_DDL = `CREATE TABLE IF NOT EXISTS users (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
  profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), password_hash text,
  display_name text, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamp, last_login_at timestamp,
  last_login_ip text, failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp, last_failed_login_at timestamp,
  credential_version integer NOT NULL DEFAULT 1, admin_passphrase_hash text, pin_hash text, pin_set_at timestamp,
  pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp, public_name boolean NOT NULL DEFAULT false,
  can_grade boolean NOT NULL DEFAULT false, can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
  can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100)`;

let admin: Client;
/** userId → the plaintext TOTP secret its seeded authenticator holds, so logins can complete MFA. */
const totpSecrets = new Map<string, string>();
let adminServer: http.Server;
let partnerServer: http.Server;
let adminBase: string;
let partnerBase: string;
let ADMIN_EMAIL: string;
/** Row id of the seeded admin user — the fixture must stamp this as `authUserId`, exactly as the
 *  real PIN step does via stampAuthSession (server/routes/auth.ts). Without it the session is not
 *  attributable and every audited super-admin mutation is correctly refused as UNAUTHENTICATED. */
let ADMIN_USER_ID: string;

(isLocal ? describe : describe.skip)("Super Admin control shell (main app, real requireAdmin, disposable DB)", () => {
  beforeAll(async () => {
    // env BEFORE importing storage/auth (server/db.ts reads MINTVAULT_DATABASE_URL at module load)
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_DATABASE_URL = RUNTIME_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query(USERS_DDL);
    // Apply partner migrations under the REALISTIC non-superuser owner model (DB-F1): the pre-auth
    // SECURITY DEFINER functions end up owned by partner_definer (BYPASSRLS), not a superuser.
    // Roles first: the stub tables below are handed to pn_migrator, which applyMigrationsRealistic
    // would otherwise not create until later.
    await provisionRealisticRoles(admin);
    // Migrations 0010+ touch these MintVault-internal stub tables and the non-superuser migrator must
    // own them — the same preamble tests/partner-management-integration.test.ts uses.
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar,
      last_name varchar, role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamp NOT NULL DEFAULT now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer)");
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    // The legacy MFA-reset route now DELEGATES to the canonical partner-management service, which
    // records into partner_management_audit (migration 0015) using an action type added by 0033.
    // The previous default set stopped at 0009, so those tables/values did not exist here.
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION);
    await admin.query("DROP ROLE IF EXISTS partner_app_test_shell").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_shell LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_shell");

    const authMod = await import("../server/auth");
    ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    // seed the admin user requireAdmin validates against
    const seededAdmin = await admin.query<{ id: string }>(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1 RETURNING id",
      [ADMIN_EMAIL.toLowerCase()]
    );
    ADMIN_USER_ID = String(seededAdmin.rows[0].id);

    // seed partners, locations, users, roles, assignments, flags
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'rA','A Ltd','ACTIVE'),($2,'rB','B Ltd','ACTIVE')",
      [A, B]
    );
    const pw = await bcrypt.hash("correct-horse-battery", 12);
    /*
     * `password_set_at` is REQUIRED for a login to succeed, and this fixture predates it.
     *
     * 0077 (credential lifecycle hardening) made partner_auth_lookup project password_set_at, and
     * auth.ts refuses any account without it — a password_hash alone now describes an invited user
     * who has never chosen their own password, which must not be able to sign in. The fixture set
     * the hash and nothing else, so EVERY login here returned "invalid credentials" and every
     * partner cookie was the empty string. The suite then read as five broken Super Admin controls.
     *
     * Setting it is not a relaxation: it states the fact the test needs to be true — these three
     * users really do have a self-set password — using the column the product now requires.
     */
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, password_set_at, status) VALUES
       ($1,'ua1',$4,$4,'owner@a.com',$6,now(),'ACTIVE'),($2,'ua2',$4,$4,'tech@a.com',$6,now(),'ACTIVE'),($3,'ub1',$5,$5,'owner@b.com',$6,now(),'ACTIVE')`,
      [UA_OWNER, UA_TECH, UB_OWNER, A, B, pw]
    );
    /*
     * MFA IS MANDATORY NOW, so the fixture must actually hold an authenticator.
     *
     * This suite was written before P2 made partner MFA fail-closed and was skipped for env reasons
     * throughout, so nobody saw it rot. Every user here logged in, received a cookie, and then got
     * 401 "mfa required" on the first authenticated call — which read as five broken Super Admin
     * controls when the truth was a fixture that had stopped resembling the product.
     *
     * Seeding an ACTIVE totp method with a secret the test KEEPS is what lets `partnerLogin` finish
     * the real /auth/mfa step below. The alternative — clearing mfa_required, or flipping
     * mfa_passed straight in the table — would make the suite green by removing the mandate it is
     * supposed to be running behind, which is how a suspension proof ends up proving nothing.
     */
    const { encryptSecret, generateTotpSecret } = await import("../server/partner/mfa");
    for (const [tenant, userId] of [
      [A, UA_OWNER],
      [A, UA_TECH],
      [B, UB_OWNER],
    ] as const) {
      const secret = generateTotpSecret();
      totpSecrets.set(userId, secret);
      await admin.query(
        "INSERT INTO partner_mfa_methods (tenant_id, user_id, method, secret_ref, status) VALUES ($1,$2,'totp',$3,'ACTIVE')",
        [tenant, userId, encryptSecret(secret)]
      );
    }
    await admin.query("UPDATE partner_users SET mfa_enabled=true WHERE id = ANY($1::uuid[])", [
      [UA_OWNER, UA_TECH, UB_OWNER],
    ]);

    const roleId = async (c: string) =>
      (await admin.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [c])).rows[0].id;
    const owner = await roleId("PARTNER_OWNER");
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$4),($1,$3,$4),($5,$6,$4)",
      [A, UA_OWNER, UA_TECH, owner, B, UB_OWNER]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'la1',$3,$3,'LA1','ACTIVE'),($2,'la2',$3,$3,'LA2','ACTIVE')",
      [LA1, LA2, A]
    );
    await admin.query(
      "INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3),($1,$2,$4)",
      [A, UA_OWNER, LA1, LA2]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)"
    );

    // ── main-app composition: real requireAdmin + real super-admin router + TEST-ONLY admin login ──
    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerSuperAdminPartnerRoutes } = await import("../server/partner/admin-routes");
    const app = express();
    app.use(express.json());
    app.use(
      session({
        name: "mv.sid",
        secret: process.env.SESSION_SECRET!,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax" },
      })
    );
    // TEST-ONLY admin session fixture — stamps the SAME session the real login+PIN flow produces.
    // Lives only on this ephemeral test app; never a shipped runtime route. requireAdmin still fully runs.
    app.post("/__test/admin-login", (req, res) => {
      const s = req.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = ADMIN_EMAIL;
      // authUserId is part of the REAL session: the PIN step calls stampAuthSession(), which sets
      // it (server/routes/auth.ts:215). Omitting it here made this fixture claim a parity it did
      // not have, and hid the fact that audited super-admin mutations require an identified actor.
      s.authUserId = ADMIN_USER_ID;
      s.authRole = "admin";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      /*
       * AG-3b step-up. This suite drives destructive Super Admin routes — emergency stop among
       * them — which now require a recent proof, and its test-only login stamped isAdmin without
       * one, so those calls correctly returned 403.
       *
       * The same repair was applied to partner-management-integration and
       * partner-dashboard-integration in 0cf568cb. This suite needed it too and did not get it,
       * because it was skipping for want of its database URLs and nobody could see it was red —
       * the same silent-skip trap, one suite further along.
       *
       * The real console obtains this from POST /api/admin/step-up after re-entering the passphrase
       * and PIN; stamping the equivalent lets the suite exercise the ROUTES rather than re-prove
       * that the guard refuses, which tests/partner-admin-step-up.test.ts already proves directly —
       * including that a missing stamp, an expired one and a partner session are all refused.
       */
      // Allow the integration test to prove the route guard itself: a normal authenticated
      // Super Admin session is not equivalent to a fresh destructive-action step-up.
      if (req.body?.stepUp !== false) s.adminStepUpAt = new Date().toISOString();
      req.session.save(() => res.json({ ok: true }));
    });
    registerSuperAdminPartnerRoutes(app);
    adminServer = http.createServer(app);
    await new Promise<void>((r) => adminServer.listen(0, "127.0.0.1", r));
    adminBase = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;

    const { createPartnerApp } = await import("../server/partner/app");
    partnerServer = http.createServer(createPartnerApp());
    await new Promise<void>((r) => partnerServer.listen(0, "127.0.0.1", r));
    partnerBase = `http://127.0.0.1:${(partnerServer.address() as AddressInfo).port}`;
  }, 40_000);

  afterAll(async () => {
    await new Promise<void>((r) => adminServer?.close(() => r()));
    await new Promise<void>((r) => partnerServer?.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.query("DROP ROLE IF EXISTS partner_app_test_shell").catch(() => {});
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    // isolate the account+IP-keyed partner login limiter between tests (all share 127.0.0.1).
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
  });

  // ── helpers ──
  async function adminCookie(stepUp = true): Promise<string> {
    const r = await fetch(`${adminBase}/__test/admin-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepUp }),
    });
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  const aget = (p: string, cookie = "") => fetch(`${adminBase}${p}`, { headers: cookie ? { cookie } : {} });
  const apost = (p: string, body: unknown, cookie = "") =>
    fetch(`${adminBase}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  /**
   * Log a partner user all the way in — password AND the mandatory second factor.
   *
   * A cookie from /auth/login alone is an MFA-PENDING session: auth.ts mints it with
   * mfa_passed=false whenever the user has an active authenticator, and requirePartnerAuth answers
   * 401 "mfa required" to every authenticated surface until /auth/mfa succeeds. Returning that
   * half-session was what made five Super Admin controls look broken.
   *
   * The TOTP is computed from the seeded secret and posted to the REAL route, so this exercises the
   * production login lifecycle rather than asserting a shortcut into the session table.
   *
   * Returns "" when the login itself is refused — several tests rely on that to prove a suspended
   * organisation or user can no longer get in, so a refusal must stay distinguishable from success.
   */
  async function partnerLogin(email: string): Promise<string> {
    const r = await fetch(`${partnerBase}/api/partner/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (!cookie) return "";

    const { rows } = await admin.query<{ id: string }>("SELECT id FROM partner_users WHERE email=$1", [email]);
    const secret = rows[0] ? totpSecrets.get(rows[0].id) : undefined;
    if (!secret) return cookie; // no authenticator seeded → the session is already mfa_passed

    /*
     * Clear the accepted-counter watermark first. This is a FIXTURE reset standing in for the clock
     * advancing, not a relaxation of replay protection: these tests sign the same users in several
     * times inside one 30-second step, and `verifyActiveTotpNoReplay` correctly refuses the second
     * code as a replay. Every code below is still computed from the real secret and verified by the
     * real route; the replay guard itself is proven in partner-mfa-factor-hardening, which uses this
     * same reset for the same reason.
     */
    await admin.query("UPDATE partner_mfa_methods SET last_totp_counter=NULL WHERE user_id=$1", [rows[0].id]);
    const { currentTotp } = await import("../server/partner/mfa");
    const mfa = await fetch(`${partnerBase}/api/partner/auth/mfa`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ code: currentTotp(secret, Date.now()) }),
    });
    // A rejected second factor leaves an unusable session; returning it would produce a confusing
    // downstream 401 far from the cause.
    if (mfa.status !== 200) return "";
    return cookie;
  }
  const psession = (cookie: string) => fetch(`${partnerBase}/api/partner/session`, { headers: { cookie } });
  const SA = "/api/super-admin/grading-partners";

  // ── auth + route boundary ──
  it("requireAdmin: unauth / partner-cookie / forged-body are all rejected; admin permitted", async () => {
    expect((await aget(SA)).status).toBe(401); // unauthenticated
    const pc = await partnerLogin("owner@a.com");
    expect((await aget(SA, pc)).status).toBe(401); // partner cookie is mv.partner.sid — not an admin session
    // forged admin identity in body/headers does nothing (requireAdmin reads session only)
    expect(
      (await fetch(`${adminBase}${SA}`, { method: "GET", headers: { "x-admin": "true", "x-role": "admin" } })).status
    ).toBe(401);
    const ac = await adminCookie();
    expect((await aget(SA, ac)).status).toBe(200); // real admin session accepted
  });

  it("partner app does NOT mount the super-admin routes (404 there); they live only in the main app", async () => {
    const pc = await partnerLogin("owner@a.com");
    expect((await fetch(`${partnerBase}${SA}`, { headers: { cookie: pc } })).status).toBe(404);
  });

  // ── partner suspension ──
  it("partner suspend: reason required; sessions die; login blocked; B unaffected; audited", async () => {
    const ac = await adminCookie();
    const ownerSession = await partnerLogin("owner@a.com");
    expect((await psession(ownerSession)).status).toBe(200);
    expect((await apost(`${SA}/${A}/suspend`, {}, ac)).status).toBe(400); // reason required
    expect((await apost(`${SA}/${A}/suspend`, { reason: "fraud check" }, ac)).status).toBe(200);
    expect((await psession(ownerSession)).status).toBe(401); // existing session unusable immediately
    expect(await partnerLogin("owner@a.com")).toBe(""); // suspended org → login yields no cookie (401)
    // B unaffected
    expect((await partnerLogin("owner@b.com")) !== "").toBe(true);
    // audit + security recorded, with reason + no secrets
    const au = await admin.query<{ action: string; reason: string }>(
      "SELECT action, reason FROM partner_audit_events WHERE tenant_id=$1 AND action='partner_suspended'",
      [A]
    );
    expect(au.rows[0].reason).toBe("fraud check");
    const sec = await admin.query(
      "SELECT 1 FROM partner_security_events WHERE tenant_id=$1 AND kind='partner_suspended'",
      [A]
    );
    expect(sec.rowCount).toBe(1);
    // partner user cannot call the suspend endpoint (no admin route on the partner app)
    const pc = await partnerLogin("owner@b.com");
    expect((await fetch(`${partnerBase}${SA}/${A}/suspend`, { method: "POST", headers: { cookie: pc } })).status).toBe(
      404
    );
    // reactivate A for later tests
    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [A]);
  });

  // ── location suspension ──
  it("location suspend: reason required; bound sessions stop; other location + B unaffected; not selectable; audited", async () => {
    const ac = await adminCookie();
    const oc = await partnerLogin("owner@a.com");
    await fetch(`${partnerBase}/api/partner/session/location`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: oc },
      body: JSON.stringify({ locationId: LA1 }),
    });
    expect((await psession(oc)).status).toBe(200);
    expect((await apost(`${SA}/${A}/locations/${LA1}/suspend`, {}, ac)).status).toBe(400);
    expect((await apost(`${SA}/${A}/locations/${LA1}/suspend`, { reason: "loc issue" }, ac)).status).toBe(200);
    expect((await psession(oc)).status).toBe(401); // session bound to LA1 stops
    // LA2 still selectable
    const oc2 = await partnerLogin("owner@a.com");
    expect(
      (
        await fetch(`${partnerBase}/api/partner/session/location`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: oc2 },
          body: JSON.stringify({ locationId: LA2 }),
        })
      ).status
    ).toBe(200);
    // suspended LA1 cannot be selected
    expect(
      (
        await fetch(`${partnerBase}/api/partner/session/location`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: oc2 },
          body: JSON.stringify({ locationId: LA1 }),
        })
      ).status
    ).toBe(404);
    const au = await admin.query(
      "SELECT 1 FROM partner_audit_events WHERE action='partner_location_suspended' AND record_id=$1",
      [LA1]
    );
    expect(au.rowCount).toBe(1);
    await admin.query("UPDATE partner_locations SET status='ACTIVE' WHERE id=$1", [LA1]);
  });

  // ── user suspension ──
  it("user suspend: reason required; user sessions die + login blocked; others + B unaffected; audited", async () => {
    const ac = await adminCookie();
    const tc = await partnerLogin("tech@a.com");
    expect((await psession(tc)).status).toBe(200);
    expect((await apost(`${SA}/${A}/users/${UA_TECH}/suspend`, {}, ac)).status).toBe(400);
    expect((await apost(`${SA}/${A}/users/${UA_TECH}/suspend`, { reason: "leaver" }, ac)).status).toBe(200);
    expect((await psession(tc)).status).toBe(401);
    expect(await partnerLogin("tech@a.com")).toBe("");
    // owner@a unaffected
    expect((await partnerLogin("owner@a.com")) !== "").toBe(true);
    /*
     * The audit lives in partner_management_audit, not partner_audit_events.
     *
     * This route no longer has its own implementation: it DELEGATES to setPartnerUserStatus, the
     * canonical service, because keeping two implementations meant the hardened path could be
     * bypassed by using the older URL. That consolidation moved the audit onto the canonical
     * append-only table, and this assertion was left pointing at the old one — invisibly, because
     * the suite was skipping.
     *
     * Asserting the terminal SUCCEEDED row specifically: recordAttempt writes a row before the work
     * happens, so a bare action match would also be satisfied by an attempt that then failed.
     */
    const au = await admin.query(
      `SELECT 1 FROM partner_management_audit
        WHERE action_type='partner_user_suspended' AND entity_id=$1 AND result='succeeded'`,
      [UA_TECH]
    );
    expect(au.rowCount).toBe(1);
    await admin.query("UPDATE partner_users SET status='ACTIVE', credential_version=credential_version+1 WHERE id=$1", [
      UA_TECH,
    ]);
  });

  // ── session revocation (revoke-all for partner) ──
  it("revoke partner sessions: all A sessions die; B's remain; token hashes never in response", async () => {
    const ac = await adminCookie();
    const oc = await partnerLogin("owner@a.com");
    const bc = await partnerLogin("owner@b.com");
    const r = await apost(`${SA}/${A}/revoke-sessions`, {}, ac);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toMatch(/token_hash|[0-9a-f]{64}/); // no session-token hash leaked
    expect((await psession(oc)).status).toBe(401); // A session revoked
    expect((await psession(bc)).status).toBe(200); // B untouched
  });

  // ── feature flags ──
  // NB: per-tenant flag runtime CONSUMERS arrive in later phases (e.g. grading = Phase 8); Phase 1
  // proves the super-admin write path: deterministic persistence (no duplicate rows), unknown-flag
  // rejection, partner-cannot-write, and audit. Portal-wide kill switches (global partner_portal_enabled /
  // partner_emergency_stop) ARE runtime-enforced and covered by the runtime-integration + emergency tests.
  it("feature flag write path: deterministic persistence (single row), unknown rejected, partner cannot write, audited", async () => {
    const ac = await adminCookie();
    expect((await apost(`${SA}/${A}/flags`, { flag: "partner_grading_enabled", enabled: true }, ac)).status).toBe(200);
    expect((await apost(`${SA}/${A}/flags`, { flag: "partner_grading_enabled", enabled: false }, ac)).status).toBe(200);
    // deterministic: exactly one row for (A, null-loc, flag)
    const rows = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_feature_flags WHERE tenant_id=$1 AND location_id IS NULL AND flag='partner_grading_enabled'",
      [A]
    );
    expect(rows.rows[0].n).toBe(1);
    // unknown flag rejected; partner cannot write flags (no such partner route)
    expect((await apost(`${SA}/${A}/flags`, { flag: "not_a_flag", enabled: true }, ac)).status).toBe(400);
    const pc = await partnerLogin("owner@b.com");
    expect((await fetch(`${partnerBase}${SA}/${A}/flags`, { method: "POST", headers: { cookie: pc } })).status).toBe(
      404
    );
    // audited
    expect(
      (await admin.query("SELECT 1 FROM partner_audit_events WHERE action='partner_flag_set' AND tenant_id=$1", [A]))
        .rowCount
    ).toBeGreaterThan(0);
  });

  // ── global emergency stop ──
  it("emergency stop: freezes A's portal ops; audited; partner cannot alter it; B/public unaffected", async () => {
    const ac = await adminCookie();
    const oc = await partnerLogin("owner@a.com");
    expect((await psession(oc)).status).toBe(200);
    expect((await apost(`${SA}/${A}/emergency-stop`, { reason: "incident" }, ac)).status).toBe(200);
    expect((await psession(oc)).status).toBe(401); // A frozen (partner-scope hard stop)
    // CONCERN-1: prove the FREEZE mechanism (not just revocation) — a brand-new login is refused
    // while frozen, so the partner_emergency_controls hard-stop is regression-protected.
    expect(await partnerLogin("owner@a.com")).toBe("");
    // B unaffected
    expect((await psession(await partnerLogin("owner@b.com"))).status).toBe(200);
    // and A logins resume after the stop is cleared
    await admin.query("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [A]);
    expect((await partnerLogin("owner@a.com")) !== "").toBe(true);
    // audited (audit + security)
    expect(
      (
        await admin.query("SELECT 1 FROM partner_audit_events WHERE action='partner_emergency_stop' AND tenant_id=$1", [
          A,
        ])
      ).rowCount
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT 1 FROM partner_security_events WHERE kind='partner_emergency_stop' AND tenant_id=$1",
          [A]
        )
      ).rowCount
    ).toBe(1);
  });

  // ── super-admin MFA reset ──
  it("MFA reset: reason required; disables method + recovery + revokes sessions; secrets never in response/audit; B unchanged", async () => {
    const noStepUp = await adminCookie(false);
    const rejected = await apost(`${SA}/${A}/users/${UA_OWNER}/mfa-reset`, { reason: "lost device" }, noStepUp);
    expect(rejected.status).toBe(403);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id=$1 AND status='ACTIVE'", [
          UA_OWNER,
        ])
      ).rows[0].n
    ).toBe(1);

    const ac = await adminCookie();
    // owner@a already has the ACTIVE authenticator every fixture user now carries (uq_partner_mfa
    // _one_active permits exactly one, and inserting a second here is what this test used to do
    // back when the fixture seeded none). It still needs recovery codes and a live session.
    const { recoveryHash } = await import("../server/partner/mfa");
    await admin.query("INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,$3)", [
      A,
      UA_OWNER,
      recoveryHash("rc-1"),
    ]);
    const oc = await partnerLogin("owner@a.com");
    expect((await apost(`${SA}/${A}/users/${UA_OWNER}/mfa-reset`, {}, ac)).status).toBe(400); // reason required
    const r = await apost(`${SA}/${A}/users/${UA_OWNER}/mfa-reset`, { reason: "lost device" }, ac);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toMatch(/secret|recovery|[0-9a-f]{40}/i); // no secrets in response
    // method disabled, recovery cleared, sessions revoked
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM partner_mfa_methods WHERE user_id=$1 AND status='ACTIVE'", [
          UA_OWNER,
        ])
      ).rows[0].n
    ).toBe(0);
    // Recovery codes are BURNED (used_at set), not deleted: the canonical service preserves them as
    // evidence while making them unusable (every redemption path requires used_at IS NULL). Assert
    // BOTH halves — the row survives AND none of them can be redeemed.
    expect(
      (await admin.query("SELECT count(*)::int n FROM partner_recovery_codes WHERE user_id=$1", [UA_OWNER])).rows[0].n
    ).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM partner_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [
          UA_OWNER,
        ])
      ).rows[0].n
    ).toBe(0);
    // the hardening the legacy implementation used to undo
    const mfaFlags = await admin.query<{ mfa_enabled: boolean; mfa_required: boolean; credential_version: number }>(
      "SELECT mfa_enabled, mfa_required, credential_version FROM partner_users WHERE id=$1",
      [UA_OWNER]
    );
    expect(mfaFlags.rows[0].mfa_enabled).toBe(false);
    expect(mfaFlags.rows[0].mfa_required).toBe(true);
    expect(mfaFlags.rows[0].credential_version).toBeGreaterThan(1);
    expect((await psession(oc)).status).toBe(401);
    // audit + security, no secrets in payload
    const au = await admin.query<{ reason: string; after_value: unknown }>(
      "SELECT reason, after_value FROM partner_audit_events WHERE action='partner_mfa_admin_reset' AND record_id=$1",
      [UA_OWNER]
    );
    expect(au.rows[0].reason).toBe("lost device");
    expect(JSON.stringify(au.rows)).not.toMatch(/secret|recovery|[0-9a-f]{40}/i);
    expect(
      (
        await admin.query(
          "SELECT 1 FROM partner_security_events WHERE kind='partner_mfa_admin_reset' AND tenant_id=$1",
          [A]
        )
      ).rowCount
    ).toBe(1);
    // …at severity high, and exactly ONE partner-visible audit row (no duplication via delegation)
    expect(
      (
        await admin.query(
          "SELECT 1 FROM partner_security_events WHERE kind='partner_mfa_admin_reset' AND severity='high' AND tenant_id=$1",
          [A]
        )
      ).rowCount
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT 1 FROM partner_audit_events WHERE action='partner_mfa_admin_reset' AND record_id=$1",
          [UA_OWNER]
        )
      ).rowCount
    ).toBe(1);
    // and the INTERNAL management ledger records the same operation exactly once
    expect(
      (
        await admin.query(
          "SELECT 1 FROM partner_management_audit WHERE action_type='partner_user_mfa_reset' AND result='succeeded' AND tenant_id=$1",
          [A]
        )
      ).rowCount
    ).toBe(1);
    // partner user cannot reset another user's MFA (no such partner route)
    const pc = await partnerLogin("owner@b.com");
    expect(
      (await fetch(`${partnerBase}${SA}/${A}/users/${UA_OWNER}/mfa-reset`, { method: "POST", headers: { cookie: pc } }))
        .status
    ).toBe(404);
    await admin.query("UPDATE partner_users SET credential_version=credential_version+1 WHERE id=$1", [UA_OWNER]);
  });

  // ── read-endpoint isolation + redaction ──
  it("read endpoints: admin can read; partner/customer cannot; no secret material in payloads; bounded", async () => {
    const ac = await adminCookie();
    const list = await (await aget(SA, ac)).json();
    expect(Array.isArray(list)).toBe(true);
    const users = await (await aget(`${SA}/${A}/users`, ac)).json();
    const blob = JSON.stringify(users);
    expect(blob).not.toMatch(/password_hash|pin_hash|secret_ref|token_hash|code_hash|\$2[aby]\$/i);
    // partner cookie cannot read
    const pc = await partnerLogin("owner@b.com");
    expect((await aget(`${SA}/${A}/users`, pc)).status).toBe(401);
    // audit/security endpoints bounded (LIMIT in handler) and admin-only
    expect((await aget(`${SA}/${A}/audit`, ac)).status).toBe(200);
    expect((await aget(`${SA}/${A}/security`, pc)).status).toBe(401);
    // unknown partner id → 404, no leak
    expect((await aget(`${SA}/00000000-0000-0000-0000-000000000000`, ac)).status).toBe(404);
  });

  // ── concurrency / idempotency ──
  it("concurrency: parallel partner-suspend requests converge (both 200, one SUSPENDED state, audited)", async () => {
    const ac = await adminCookie();
    const [r1, r2] = await Promise.all([
      apost(`${SA}/${A}/suspend`, { reason: "race a" }, ac),
      apost(`${SA}/${A}/suspend`, { reason: "race b" }, ac),
    ]);
    expect([r1.status, r2.status].every((s) => s === 200)).toBe(true);
    expect(
      (await admin.query<{ status: string }>("SELECT status FROM partner_organisations WHERE id=$1", [A])).rows[0]
        .status
    ).toBe("SUSPENDED");
    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [A]);
  });
});
