/**
 * WP-1 — Partner portal MAIN-APP mount + GLOBAL feature-flag administration.
 *
 * WHY THIS SUITE EXISTS
 *
 * Before WP-1 the entire authenticated partner surface (session, submissions, customers, team,
 * MFA) lived inside `createPartnerApp()` — an Express app with ZERO production callers. The
 * deployed server mounted four public routes and nothing else, so:
 *
 *   • every /api/partner authenticated route was simply absent in production (404, not 503);
 *   • `partner_portal_enabled`, the documented master switch, gated only the unmounted factory,
 *     so on the live public routes it was dead code; and
 *   • no API in the product could write a GLOBAL flag row — the only writer scoped every row to a
 *     tenant, so enabling the platform required hand-written SQL.
 *
 * tests/partner-runtime-integration.test.ts proves the behaviour of the FACTORY. It cannot prove
 * that the production composition (`registerPartnerPublicRoutes` then `mountPartnerPortal`, the
 * exact order and only the partner surface, in server/routes.ts) preserves those gates — a mount
 * that dropped one would leave that suite green. This suite drives the production composition over
 * real HTTP against a real PostgreSQL 17, and asserts the flag-admin surface that operates it.
 *
 * The app assembled below deliberately mirrors server/routes.ts's partner registration lines rather
 * than calling `registerRoutes()`: the full application requires a pushed Drizzle schema, Stripe,
 * R2 and Resend configuration, none of which bear on the partner mount. This is the same technique
 * the existing tests/partner-public-routes-integration.test.ts uses for the public slice.
 *
 * Reproduce (host must be loopback; the database is DISPOSABLE and is dropped/recreated):
 *   PARTNER_MOUNT_RT_ADMIN=postgres://postgres:postgres@127.0.0.1:5561/mintvault_partner_mount \
 *   PARTNER_MOUNT_RT_RUNTIME=postgres://partner_app_test_mount:synthetic@127.0.0.1:5561/mintvault_partner_mount \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-portal-mount-integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_CREDITS,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_MOUNT_RT_ADMIN;
const RUNTIME_DB = process.env.PARTNER_MOUNT_RT_RUNTIME;

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

/**
 * FAIL CLOSED IN CI.
 *
 * The suite gates on loopback URLs so a developer without a local PostgreSQL still gets a green
 * run. That gate is a LOCAL convenience only: in CI a missing variable must be a hard failure,
 * because a silently-skipped suite is exactly how the Partner Master Dashboard and Partner User
 * Management coverage sat dormant for their whole lives while reporting green. Copied deliberately
 * from tests/partner-dashboard-integration.test.ts.
 */
describe("Partner portal mount integration coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(
        isLocal,
        "PARTNER_MOUNT_RT_ADMIN and PARTNER_MOUNT_RT_RUNTIME must be set to loopback PostgreSQL " +
          "URLs in CI, or the partner portal mount suite does not run at all"
      ).toBe(true);
    }
  });
});

const FLAGS_BASE = "/api/super-admin/partner-flags";

/**
 * Distinctive status + marker for the terminal sentinel handler (see the app assembly below). 599
 * is deliberately not a status any partner route can produce, so "reached the sentinel" and "the
 * partner surface answered" can never be confused.
 */
const SENTINEL_STATUS = 599;
const SENTINEL_MARKER = "not-the-partner-surface";

/** The exact body every gate in server/partner/mount.ts returns when it closes. */
const GATED_BODY = { error: "partner portal unavailable" };

/**
 * What an UNAUTHENTICATED GET /api/partner/session returns once it has passed all four gates: the
 * route handler itself answers 401. Distinguishing 401 from 503 is the whole point of the
 * gate-by-gate block — 503 means a gate closed, 401 means every gate opened and the request
 * genuinely reached the partner router.
 */
const PAST_THE_GATES = 401;

/** Stable synthetic ids. No real partner names, emails or addresses anywhere in this file. */
const TENANT = "cccc0001-0000-0000-0000-00000000000f";
const OWNER_ID = "cccc0001-0000-0000-0000-0000000000a1";
const OWNER_EMAIL = "mount-owner@example.test";
const OWNER_PASSWORD = "mount-owner-password-1";
const LOCATION = "cccc0001-0000-0000-0000-0000000000c1";
const INVITED_ID = "cccc0001-0000-0000-0000-0000000000a2";
const INVITED_EMAIL = "mount-invited@example.test";
const INVITE_TOKEN = "mount-invite-token-abcdefghijklmnopqrstuvwxyz";
const INVITE_PASSWORD = "mount-invited-password-1";

let admin: Client;
let server: http.Server;
let base = "";
let adminCookie = "";
let closePartnerPools: () => Promise<void>;

type Json = Record<string, unknown>;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: Json; setCookie: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    /* non-JSON body — assertions below use `status` */
  }
  return { status: res.status, body, setCookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

/** Set a GLOBAL flag row directly (fixture control, bypassing the API under test). */
async function setGlobalFlag(flag: string, enabled: boolean): Promise<void> {
  await admin.query("DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL", [
    flag,
  ]);
  await admin.query(
    "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,$1,$2)",
    [flag, enabled]
  );
}

async function clearAllFlags(): Promise<void> {
  await admin.query("DELETE FROM partner_feature_flags");
}

/** Enable the three flags the deployed surface needs to serve a full lifecycle. */
async function enableLiveFlags(): Promise<void> {
  await clearAllFlags();
  for (const f of [
    "partner_portal_enabled",
    "partner_login_enabled",
    "partner_onboarding_enabled",
    // B2: submitting a portal draft reserves credits and is gated by this flag, which is OFF by
    // default on every real host. A "full lifecycle" fixture must opt in or the submit step 503s.
    "partner_submission_intake_enabled",
  ]) {
    await setGlobalFlag(f, true);
  }
}

async function login(
  email = OWNER_EMAIL,
  password = OWNER_PASSWORD
): Promise<{ status: number; cookie: string; body: Json }> {
  const r = await req("POST", "/api/partner/auth/login", { body: { email, password } });
  return { status: r.status, cookie: r.setCookie, body: r.body };
}

(isLocal ? describe : describe.skip)("Partner portal mounted in the main application composition", () => {
  beforeAll(async () => {
    // server/db.ts (Drizzle) reads MINTVAULT_DATABASE_URL at module load; requireSuperAdmin
    // re-loads the admin user through it and storage.writeAuditLog writes audit_log through it.
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_DATABASE_URL = RUNTIME_DB;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, never a real key
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();

    // Start from a genuinely empty schema so the suite is re-runnable against the same disposable
    // container: several partner migrations use CREATE OR REPLACE FUNCTION with signatures that
    // changed across versions and cannot be re-applied over an older definition.
    await admin.query("DROP OWNED BY partner_runtime CASCADE").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime CASCADE").catch(() => {});
    await admin.query("DROP OWNED BY partner_definer CASCADE").catch(() => {});
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await provisionRealisticRoles(admin);

    // MintVault-internal tables. `users` carries the full column set because requireAdmin re-loads
    // the admin user through the real storage layer, which selects every column; a trimmed stub
    // surfaces as an opaque 500 on every request (same requirement the dashboard suite documents).
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
      profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), password_hash text,
      display_name text, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamp, last_login_at timestamp,
      last_login_ip text, failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp, last_failed_login_at timestamp,
      credential_version integer NOT NULL DEFAULT 1, admin_passphrase_hash text, pin_hash text, pin_set_at timestamp,
      pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp, public_name boolean NOT NULL DEFAULT false,
      can_grade boolean NOT NULL DEFAULT false, can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
      can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100)`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    // storage.writeAuditLog target (shared/schema.ts `auditLog`). The flag-admin surface audits
    // here because partner_audit_events and partner_management_audit both require a NOT NULL
    // tenant_id, and a GLOBAL flag has no tenant.
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
      admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamp NOT NULL DEFAULT now())`);
    for (const t of ["users", "submissions", "submission_items", "audit_log"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }

    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_CREDITS);

    // Synthetic LOGIN role inheriting the restricted partner_runtime role — the runtime must never
    // be a superuser, which the first test below proves rather than assumes.
    await admin.query("DROP ROLE IF EXISTS partner_app_test_mount").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_mount LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_mount");

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    const authMod = await import("../server/auth");
    const ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [ADMIN_EMAIL.toLowerCase()]
    );

    // One synthetic partner: an ACTIVE owner (password login) and an INVITED user (onboarding).
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'mountA','Mount A Ltd','ACTIVE')",
      [TENANT]
    );

    // Submit reserves a grading credit PER CARD, so any suite that drives a real submission needs
    // a funded wallet. Seeded AFTER the organisation rows exist — ensureWallet resolves the org
    // first and fails with ORG_NOT_FOUND otherwise.
    {
      const wallet = await import("../server/partner/partner-wallet-service");
      const actor = { actorUserId: null, actorEmail: "mount@example.test" };
      for (const [tenantId, key] of [[TENANT, "mount-integration-wallet"]] as const) {
        await wallet.ensureWallet(actor, tenantId);
        await wallet.appendFoundationCredit(actor, {
          tenantId,
          amount: 100,
          entryType: "purchase",
          source: "admin",
          reason: "Portal mount integration regression credits",
          idempotencyKey: key,
          actorType: "admin",
        });
      }
    }

    const pw = await bcrypt.hash(OWNER_PASSWORD, 12);
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, password_set_at, status, mfa_required)
       VALUES ($1,'mOwner',$2,$2,$3,$4,now(),'ACTIVE',false)`,
      [OWNER_ID, TENANT, OWNER_EMAIL, pw]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES ($1,'mInvited',$2,$2,$3,'INVITED')",
      [INVITED_ID, TENANT, INVITED_EMAIL]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [TENANT, OWNER_ID]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [TENANT, INVITED_ID]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'mLoc',$2,$2,'Mount Loc','ACTIVE')",
      [LOCATION, TENANT]
    );
    await admin.query("INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)", [
      TENANT,
      OWNER_ID,
      LOCATION,
    ]);
    await admin.query(
      `INSERT INTO partner_invitations (tenant_id, user_id, email, role_code, token_hash, expires_at)
       VALUES ($1,$2,$3,'PARTNER_OWNER',encode(sha256($4::bytea),'hex'),now()+interval '1 day')`,
      [TENANT, INVITED_ID, INVITED_EMAIL, INVITE_TOKEN]
    );

    const dbMod = await import("../server/partner/db");
    closePartnerPools = dbMod.closePartnerPools;

    // ---- the app under test: exactly server/routes.ts's partner registration lines ----
    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    const { registerPartnerFlagAdminRoutes } = await import("../server/partner/flag-admin-routes");

    const app = express();
    app.set("trust proxy", 1);
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
    // TEST-ONLY session stamp (never shipped) — mirrors what the real login + PIN flow produces.
    app.post("/__test/admin-login", (rq, rs) => {
      const s = rq.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = ADMIN_EMAIL;
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      if (rq.body?.stepUp === true) s.adminStepUpAt = new Date().toISOString();
      rq.session.save(() => rs.json({ ok: true }));
    });
    app.post("/__test/non-super-admin-login", (rq, rs) => {
      const s = rq.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = "ordinary-admin@example.test";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      rq.session.save(() => rs.json({ ok: true }));
    });
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    registerPartnerFlagAdminRoutes(app);

    // SENTINEL — stands in for "the rest of the real application" (the SPA, the admin routers,
    // the staff routers), which this composition deliberately does not build.
    //
    // Without it, asserting 404 on /api/admin would be tautological: nothing registered those
    // paths, so of course they 404 — the assertion would pass even if the partner mount were
    // deleted entirely. Reaching the sentinel instead proves something stronger and specific: the
    // request travelled PAST the partner surface without being intercepted by it, which is what
    // "the partner mount does not shadow the rest of the app" actually means.
    app.use((rq, rs) => {
      rs.status(SENTINEL_STATUS).json({ sentinel: SENTINEL_MARKER, path: rq.path });
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const adminLogin = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    adminCookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0];
    expect(adminCookie).toContain("mv.sid");
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await closePartnerPools?.();
    await admin?.query("DROP ROLE IF EXISTS partner_app_test_mount").catch(() => {});
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    // Isolate the IP-keyed partner login limiter between tests (all tests share 127.0.0.1).
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
  });

  // =========================================================================
  // A. The runtime is genuinely restricted (control for everything below).
  // =========================================================================
  it("the mounted portal's runtime connects as a NON-superuser restricted role", async () => {
    const c = new Client({ connectionString: RUNTIME_DB });
    await c.connect();
    const who = await c.query<{ u: string; su: boolean }>(
      "SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su"
    );
    expect(who.rows[0].u).toBe("partner_app_test_mount");
    expect(who.rows[0].su).toBe(false);
    await c.end();
  });

  // =========================================================================
  // B. Zero flag rows: the surface exists but is CLOSED. The distinction that
  //    matters is 503 (mounted, gated) vs 404 (absent) vs 500 (broken).
  // =========================================================================
  describe("with zero partner_feature_flags rows", () => {
    beforeEach(async () => {
      await clearAllFlags();
    });

    it("every authenticated /api/partner route 503s — never 404, never 500, never 200", async () => {
      const authenticatedRoutes: Array<[string, string]> = [
        ["GET", "/api/partner/session"],
        ["GET", "/api/partner/dashboard"],
        ["GET", "/api/partner/users"],
        ["GET", "/api/partner/locations"],
        ["POST", "/api/partner/auth/logout"],
        ["POST", "/api/partner/auth/revoke-all"],
        ["POST", "/api/partner/mfa/enrol"],
      ];
      for (const [method, path] of authenticatedRoutes) {
        const r = await req(method, path, { body: method === "POST" ? {} : undefined });
        expect(r.status, `${method} ${path} must be gated 503 with no flag rows`).toBe(503);
      }
    });

    it("the four public routes gain the portal gate and fail closed", async () => {
      expect((await login()).status).toBe(503);
      expect(
        (
          await req("POST", "/api/partner/invitations/accept", {
            body: { token: INVITE_TOKEN, password: INVITE_PASSWORD },
          })
        ).status
      ).toBe(503);
      expect(
        (
          await req("POST", "/api/partner/auth/password-reset/consume", {
            body: { token: "x", newPassword: "irrelevant-pw-1" },
          })
        ).status
      ).toBe(503);
      // The reset REQUEST route is deliberately generic (it must not disclose account existence),
      // so its closed shape is the same 503 the router applies before the handler runs.
      expect(
        (await req("POST", "/api/partner/auth/password-reset/request", { body: { email: OWNER_EMAIL } })).status
      ).toBe(503);
    });

    it("a gated 503 body never names which gate closed, and leaks no internals", async () => {
      const r = await req("GET", "/api/partner/session");
      expect(r.status).toBe(503);
      const blob = JSON.stringify(r.body);
      expect(blob).not.toMatch(/flag|definer|PARTNER_|postgres|password|role/i);
    });
  });

  // =========================================================================
  // C. Master switch: portal OFF closes the surface even when the per-route
  //    login/onboarding flags are ON. This is the defect WP-1 fixes.
  // =========================================================================
  describe("partner_portal_enabled as the master switch", () => {
    it("portal OFF with login+onboarding ON still closes the deployed public routes", async () => {
      await clearAllFlags();
      await setGlobalFlag("partner_login_enabled", true);
      await setGlobalFlag("partner_onboarding_enabled", true);
      // Before WP-1 this combination served login and invitation acceptance normally.
      expect((await login()).status).toBe(503);
      expect(
        (
          await req("POST", "/api/partner/invitations/accept", {
            body: { token: INVITE_TOKEN, password: INVITE_PASSWORD },
          })
        ).status
      ).toBe(503);
    });

    it("emergency stop overrides an enabled portal on both the public and authenticated surfaces", async () => {
      await enableLiveFlags();
      const live = await login();
      expect(live.status).toBe(200);
      await setGlobalFlag("partner_emergency_stop", true);
      expect((await login()).status).toBe(503);
      expect((await req("GET", "/api/partner/session", { cookie: live.cookie })).status).toBe(503);
      await setGlobalFlag("partner_emergency_stop", false);
      expect((await req("GET", "/api/partner/session", { cookie: live.cookie })).status).toBe(200);
    });
  });

  // =========================================================================
  // D. Full lifecycle through the MAIN-APP composition.
  // =========================================================================
  describe("full partner lifecycle through the mounted surface", () => {
    it("invitation accept → login → session → MFA enrol/confirm → customers → submission draft → submit", async () => {
      await enableLiveFlags();

      // --- 1. invitation acceptance (public route) ---
      const accepted = await req("POST", "/api/partner/invitations/accept", {
        body: { token: INVITE_TOKEN, password: INVITE_PASSWORD },
      });
      expect(accepted.status).toBe(200);
      const invitedRow = await admin.query<{ status: string; ok: boolean }>(
        "SELECT status, password_hash IS NOT NULL AS ok FROM partner_users WHERE id=$1",
        [INVITED_ID]
      );
      expect(invitedRow.rows[0]).toEqual({ status: "ACTIVE", ok: true });

      // --- 2. login as the accepted user (public route), through the SAME app ---
      const invitedLogin = await login(INVITED_EMAIL, INVITE_PASSWORD);
      expect(invitedLogin.status).toBe(200);
      expect(invitedLogin.cookie).toMatch(/^mv\.partner\.sid=/);

      // --- 3. authenticated session route (MOUNTED router — 404 before WP-1) ---
      const owner = await login();
      expect(owner.status).toBe(200);
      const session = await req("GET", "/api/partner/session", { cookie: owner.cookie });
      expect(session.status).toBe(200);
      expect(session.body.mfaPassed).toBe(true);

      // --- 4. dashboard + tenant-scoped reads through the mount ---
      const dash = await req("GET", "/api/partner/dashboard", { cookie: owner.cookie });
      expect(dash.status).toBe(200);
      expect((dash.body.org as Json).legal_name).toBe("Mount A Ltd");

      const users = await req("GET", "/api/partner/users", { cookie: owner.cookie });
      expect(users.status).toBe(200);
      expect((users.body.users as Array<{ email: string }>).every((u) => u.email.endsWith("@example.test"))).toBe(true);

      // --- 5. location switch (session state bound server-side) ---
      const switched = await req("POST", "/api/partner/session/location", {
        body: { locationId: LOCATION },
        cookie: owner.cookie,
      });
      expect(switched.status).toBe(200);
      expect((await req("GET", "/api/partner/session", { cookie: owner.cookie })).body.locationId).toBe(LOCATION);

      // --- 6. customers + submission draft → card → submit (Phase 2 routers, mounted here) ---
      // Deliberately BEFORE MFA enrolment: enrolling a factor makes every subsequent login
      // MFA-pending, which is correct product behaviour and would otherwise force this test to
      // re-authenticate mid-flow for reasons unrelated to what it proves.
      const relogin = owner;

      const customer = await req("POST", "/api/partner/customers", {
        body: { fullName: "Mount Customer", email: "mount-customer@example.test" },
        cookie: relogin.cookie,
      });
      expect(customer.status, JSON.stringify(customer.body)).toBe(201);
      const customerId = customer.body.id as string;
      expect(customerId).toBeTruthy();

      const draft = await req("POST", "/api/partner/submissions", {
        body: { locationId: LOCATION, customerId },
        cookie: relogin.cookie,
      });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      const submissionId = draft.body.id as string;
      expect(submissionId).toBeTruthy();

      const card = await req("POST", `/api/partner/submissions/${submissionId}/cards`, {
        body: { cardName: "Mount Test Card", game: "pokemon", quantity: 1 },
        cookie: relogin.cookie,
      });
      expect(card.status, JSON.stringify(card.body)).toBe(201);

      const submitted = await req("POST", `/api/partner/submissions/${submissionId}/submit`, {
        body: { idempotencyKey: `mount-suite-submit-${Date.now()}` },
        cookie: relogin.cookie,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

      // The submission really reached the handoff state through the MOUNTED router — not merely
      // a 200 from a route that did nothing.
      const persisted = await admin.query<{ status: string; handoffs: number }>(
        `SELECT s.status, (SELECT count(*)::int FROM partner_submission_handoffs h WHERE h.submission_id=s.id) AS handoffs
           FROM partner_submissions s WHERE s.id=$1`,
        [submissionId]
      );
      expect(persisted.rows[0]).toEqual({ status: "submitted_to_mintvault", handoffs: 1 });

      // --- 7. MFA enrolment through the mount (proves PARTNER_MFA_ENC_KEY is wired end to end) ---
      const enrol = await req("POST", "/api/partner/mfa/enrol", {
        body: { password: OWNER_PASSWORD },
        cookie: owner.cookie,
      });
      expect(enrol.status).toBe(200);
      const secret = enrol.body.secret as string;
      expect(secret).toBeTruthy();
      const storedSecret = await admin.query<{ secret_ref: string; status: string }>(
        "SELECT secret_ref, status FROM partner_mfa_methods WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [OWNER_ID]
      );
      expect(storedSecret.rows[0].secret_ref).not.toContain(secret); // stored ENCRYPTED, never plaintext
      expect(storedSecret.rows[0].status).toBe("PENDING"); // an unconfirmed factor does not satisfy MFA
      const { currentTotp } = await import("../server/partner/mfa");
      // Confirm is BY ENROLMENT ID since migration 0044 (applied in production): the pending secret
      // is bound to the session that issued it and expires, so it is confirmed explicitly.
      const confirmed = await req("POST", "/api/partner/mfa/confirm", {
        body: { enrolmentId: enrol.body.enrolmentId as string, code: currentTotp(secret, Date.now()) },
        cookie: owner.cookie,
      });
      expect(confirmed.status).toBe(200);
      expect((confirmed.body.recoveryCodes as string[]).length).toBe(10);

      // --- 8. the enrolled factor is now REQUIRED: a fresh login is MFA-pending until it passes ---
      await admin.query("UPDATE partner_users SET mfa_required=true WHERE id=$1", [OWNER_ID]);
      const pending = await login();
      expect(pending.status).toBe(200);
      expect(pending.body.mfaRequired).toBe(true);
      expect((await req("GET", "/api/partner/dashboard", { cookie: pending.cookie })).status).toBe(401);
      await admin.query("UPDATE partner_mfa_methods SET last_totp_counter=NULL WHERE user_id=$1", [OWNER_ID]);
      const passed = await req("POST", "/api/partner/auth/mfa", {
        body: { code: currentTotp(secret, Date.now()) },
        cookie: pending.cookie,
      });
      expect(passed.status).toBe(200);
      expect((await req("GET", "/api/partner/dashboard", { cookie: pending.cookie })).status).toBe(200);
      await admin.query("UPDATE partner_users SET mfa_required=false WHERE id=$1", [OWNER_ID]);
    }, 120_000);

    it("lets admin, staff, grader, scanner, Vault Quest and certificate paths travel PAST it to the rest of the app", async () => {
      await enableLiveFlags();
      const { FORBIDDEN_PARTNER_PATHS } = await import("../server/partner/app");
      const owner = await login();
      for (const p of FORBIDDEN_PARTNER_PATHS) {
        const r = await req("GET", p, { cookie: owner.cookie });
        // Reaching the sentinel — not merely "not 200" — is the assertion. A bare 404 check would
        // pass even with the partner mount deleted; this fails if the mount ever intercepts or
        // answers one of these paths, because then the sentinel is never reached.
        expect(r.status, `${p} must pass through the partner mount untouched`).toBe(SENTINEL_STATUS);
        expect(r.body.sentinel).toBe(SENTINEL_MARKER);
      }
    });

    it("does not shadow /partner — the request reaches the app behind it, where the SPA lives", async () => {
      await enableLiveFlags();
      // The factory's placeholder shell must NOT be registered by the mount, or it would occupy the
      // SPA's own route in the main application. Proven by the request reaching the sentinel (i.e.
      // whatever is mounted after the partner surface), and by the placeholder markup being absent.
      const r = await req("GET", "/partner");
      expect(r.status).toBe(SENTINEL_STATUS);
      expect(r.body.sentinel).toBe(SENTINEL_MARKER);
      expect(JSON.stringify(r.body)).not.toContain("partner-root");
    });

    it("suppresses /api/partner response bodies from the application log (R1 — TOTP seed + PII)", async () => {
      // BEHAVIOURAL SUCCESSOR: tests/partner-integration-seams.test.ts drives the real logger over
      // real HTTP and asserts on the log lines it actually emitted. This block now reads the real
      // exported rule instead of scraping index.ts for the declaration as text.
      const { BODY_LOG_SUPPRESSED_PREFIXES, isBodyLogSuppressed: suppressed } =
        await import("../server/lib/request-logger");
      expect(BODY_LOG_SUPPRESSED_PREFIXES).toContain("/api/partner");

      for (const p of [
        "/api/partner/mfa/enrol", // otpauthUri — embeds the raw TOTP seed
        "/api/partner/mfa/confirm", // recoveryCodes — one-time MFA bypass codes
        "/api/partner/customers", // customer PII
        "/api/partner/users", // team member PII
        "/api/partner/submissions",
        "/api/partner/session",
      ]) {
        expect(suppressed(p), `${p} response bodies must never be written to the log`).toBe(true);
      }

      // And the suppression is load-bearing, not decorative: the enrol response really does carry
      // the seed in a field name `redactSensitive` does not mask.
      await enableLiveFlags();
      await admin.query("DELETE FROM partner_mfa_methods WHERE user_id=$1", [OWNER_ID]);
      const owner = await login();
      const enrol = await req("POST", "/api/partner/mfa/enrol", {
        body: { password: OWNER_PASSWORD },
        cookie: owner.cookie,
      });
      expect(enrol.status).toBe(200);
      expect(String(enrol.body.otpauthUri)).toContain(`secret=${enrol.body.secret}`);
      expect(suppressed("/api/partner/mfa/enrol")).toBe(true);
      await admin.query("DELETE FROM partner_mfa_methods WHERE user_id=$1", [OWNER_ID]);
    });
  });

  // =========================================================================
  // E. GLOBAL flag administration surface.
  // =========================================================================
  describe("super-admin GLOBAL flag administration", () => {
    beforeEach(async () => {
      await enableLiveFlags();
    });

    it("rejects an unauthenticated caller on both read and write", async () => {
      expect((await req("GET", FLAGS_BASE)).status).toBe(401);
      const w = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        body: { enabled: false, reason: "unauthenticated attempt" },
      });
      expect(w.status).toBe(401);
      // and it changed nothing
      const { rows } = await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM partner_feature_flags WHERE flag='partner_portal_enabled' AND tenant_id IS NULL"
      );
      expect(rows[0].enabled).toBe(true);
    });

    it("rejects a signed-in admin who is not a Super Admin before any flag write", async () => {
      const login = await fetch(`${base}/__test/non-super-admin-login`, { method: "POST" });
      const nonSuperCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      expect(nonSuperCookie).toContain("mv.sid");

      expect((await req("GET", FLAGS_BASE, { cookie: nonSuperCookie })).status).toBe(403);
      const w = await req("PUT", `${FLAGS_BASE}/partner_onboarding_enabled`, {
        cookie: nonSuperCookie,
        body: { enabled: false, reason: "non-super-admin attempt" },
      });
      expect(w.status).toBe(403);

      const { rows } = await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM partner_feature_flags WHERE flag='partner_onboarding_enabled' AND tenant_id IS NULL"
      );
      expect(rows[0].enabled).toBe(true);
    });

    it("reports every canonical flag, including the ones with no global row", async () => {
      await clearAllFlags();
      const r = await req("GET", FLAGS_BASE, { cookie: adminCookie });
      expect(r.status).toBe(200);
      const { PARTNER_FLAGS } = await import("../server/partner/flags");
      const returned = r.body.flags as Array<{ flag: string; enabled: boolean; configured: boolean }>;
      expect(returned.map((f) => f.flag).sort()).toEqual([...PARTNER_FLAGS].sort());
      // An absent row must read as OFF and be visibly unconfigured — not a gap in the list.
      expect(returned.every((f) => f.enabled === false && f.configured === false)).toBe(true);
    });

    it("rejects an unknown flag name with 400 and writes nothing", async () => {
      const before = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_feature_flags");
      const r = await req("PUT", `${FLAGS_BASE}/partner_totally_made_up`, {
        cookie: adminCookie,
        body: { enabled: true, reason: "typo" },
      });
      expect(r.status).toBe(400);
      const after = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_feature_flags");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("requires a reason and a boolean, and bounds the reason length", async () => {
      const noReason = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        cookie: adminCookie,
        body: { enabled: false },
      });
      expect(noReason.status).toBe(400);
      const blankReason = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        cookie: adminCookie,
        body: { enabled: false, reason: "   " },
      });
      expect(blankReason.status).toBe(400);
      const notBoolean = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        cookie: adminCookie,
        body: { enabled: "yes", reason: "string not boolean" },
      });
      expect(notBoolean.status).toBe(400);
      const longReason = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        cookie: adminCookie,
        body: { enabled: false, reason: "x".repeat(501) },
      });
      expect(longReason.status).toBe(400);
      // the flag is untouched by all four rejections
      const { rows } = await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM partner_feature_flags WHERE flag='partner_portal_enabled' AND tenant_id IS NULL"
      );
      expect(rows[0].enabled).toBe(true);
    });

    it("requires a fresh Super Admin step-up before global public-directory activation", async () => {
      await admin.query(
        "DELETE FROM partner_feature_flags WHERE flag='public_partner_directory_enabled' AND tenant_id IS NULL"
      );
      const refused = await req("PUT", `${FLAGS_BASE}/public_partner_directory_enabled`, {
        cookie: adminCookie,
        body: { enabled: true, reason: "attempt without fresh proof" },
      });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("admin_step_up_required");

      const login = await fetch(`${base}/__test/admin-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepUp: true }),
      });
      const steppedUpCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const enabled = await req("PUT", `${FLAGS_BASE}/public_partner_directory_enabled`, {
        cookie: steppedUpCookie,
        body: { enabled: true, reason: "approved public directory activation" },
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body).toMatchObject({ flag: "public_partner_directory_enabled", enabled: true });
    });

    it("writes a GLOBAL row (tenant_id IS NULL AND location_id IS NULL) and flips resolveGlobalFlag in the same test", async () => {
      const { resolveGlobalFlag } = await import("../server/partner/flags");
      expect(await resolveGlobalFlag("partner_portal_enabled")).toBe(true);

      const off = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        cookie: adminCookie,
        body: { enabled: false, reason: "WP-1 evidence: disable the platform" },
      });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ flag: "partner_portal_enabled", enabled: false, scope: "global" });

      const { rows } = await admin.query<{ tenant_id: string | null; location_id: string | null; enabled: boolean }>(
        "SELECT tenant_id, location_id, enabled FROM partner_feature_flags WHERE flag='partner_portal_enabled'"
      );
      expect(rows).toHaveLength(1); // exactly one row — no stale duplicate
      expect(rows[0]).toEqual({ tenant_id: null, location_id: null, enabled: false });

      // The resolver the gates use now reads OFF, and the live surface closes.
      expect(await resolveGlobalFlag("partner_portal_enabled")).toBe(false);
      expect((await login()).status).toBe(503);
      expect((await req("GET", "/api/partner/session")).status).toBe(503);

      // ...and turning it back on re-opens it, through the API alone.
      const on = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
        cookie: adminCookie,
        body: { enabled: true, reason: "WP-1 evidence: re-enable the platform" },
      });
      expect(on.status).toBe(200);
      expect(await resolveGlobalFlag("partner_portal_enabled")).toBe(true);
      expect((await login()).status).toBe(200);
    });

    it("is idempotent: repeating the same write leaves exactly one row and the same value", async () => {
      for (let i = 0; i < 3; i++) {
        const r = await req("PUT", `${FLAGS_BASE}/partner_grading_enabled`, {
          cookie: adminCookie,
          body: { enabled: true, reason: `idempotency probe ${i}` },
        });
        expect(r.status).toBe(200);
      }
      const { rows } = await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM partner_feature_flags WHERE flag='partner_grading_enabled' AND tenant_id IS NULL AND location_id IS NULL"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].enabled).toBe(true);
    });

    it("never touches a TENANT-scoped row for the same flag", async () => {
      await admin.query(
        "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES ($1,NULL,'partner_payments_enabled',true)",
        [TENANT]
      );
      const r = await req("PUT", `${FLAGS_BASE}/partner_payments_enabled`, {
        cookie: adminCookie,
        body: { enabled: false, reason: "global off, tenant override must survive" },
      });
      expect(r.status).toBe(200);
      const { rows } = await admin.query<{ tenant_id: string | null; enabled: boolean }>(
        "SELECT tenant_id, enabled FROM partner_feature_flags WHERE flag='partner_payments_enabled' ORDER BY tenant_id NULLS FIRST"
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((x) => x.tenant_id === null)!.enabled).toBe(false);
      expect(rows.find((x) => x.tenant_id === TENANT)!.enabled).toBe(true);
      await admin.query("DELETE FROM partner_feature_flags WHERE tenant_id=$1", [TENANT]);
    });

    it("audits every change with the acting super-admin, the reason and the previous value", async () => {
      await admin.query("DELETE FROM audit_log WHERE entity_type='partner_feature_flag'");
      const { ADMIN_EMAIL } = await import("../server/auth");
      const reason = "WP-1 audit evidence probe";
      const r = await req("PUT", `${FLAGS_BASE}/partner_connector_enabled`, {
        cookie: adminCookie,
        body: { enabled: true, reason },
      });
      expect(r.status).toBe(200);
      expect(r.body.audited).toBe(true);

      const { rows } = await admin.query<{
        entity_id: string;
        action: string;
        admin_user: string;
        details: Record<string, unknown>;
      }>("SELECT entity_id, action, admin_user, details FROM audit_log WHERE entity_type='partner_feature_flag'");
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_id).toBe("partner_connector_enabled");
      expect(rows[0].action).toBe("partner_global_flag_enabled");
      expect(rows[0].admin_user).toBe(ADMIN_EMAIL);
      expect(rows[0].details).toMatchObject({
        flag: "partner_connector_enabled",
        scope: "global",
        enabled: true,
        reason,
        previouslyConfigured: false,
      });

      // a disable is audited as its own distinct action, carrying the value it replaced
      const off = await req("PUT", `${FLAGS_BASE}/partner_connector_enabled`, {
        cookie: adminCookie,
        body: { enabled: false, reason: "and back off again" },
      });
      expect(off.status).toBe(200);
      const after = await admin.query<{ action: string; details: Record<string, unknown> }>(
        "SELECT action, details FROM audit_log WHERE entity_type='partner_feature_flag' ORDER BY id DESC LIMIT 1"
      );
      expect(after.rows[0].action).toBe("partner_global_flag_disabled");
      expect(after.rows[0].details).toMatchObject({ previousEnabled: true, enabled: false });
    });

    it("audit payloads carry no credentials, tokens or hashes", async () => {
      const { rows } = await admin.query("SELECT details FROM audit_log WHERE entity_type='partner_feature_flag'");
      const blob = JSON.stringify(rows);
      expect(blob).not.toMatch(/\$2[aby]\$|password|token_hash|secret|postgres:\/\//i);
    });

    // ---- R2: the write is verified through the read path the gates actually use ----
    it("reports the EFFECTIVE value, read back through the runtime path, not just what was written", async () => {
      const on = await req("PUT", `${FLAGS_BASE}/partner_evidence_capture_enabled`, {
        cookie: adminCookie,
        body: { enabled: true, reason: "effective read-back, enable" },
      });
      expect(on.status).toBe(200);
      expect(on.body.effective).toBe(true);

      const off = await req("PUT", `${FLAGS_BASE}/partner_evidence_capture_enabled`, {
        cookie: adminCookie,
        body: { enabled: false, reason: "effective read-back, disable" },
      });
      expect(off.status).toBe(200);
      expect(off.body.effective).toBe(false);

      // `effective` is the runtime pool's answer, so it must agree with resolveGlobalFlag itself.
      const { resolveGlobalFlag } = await import("../server/partner/flags");
      expect(await resolveGlobalFlag("partner_evidence_capture_enabled")).toBe(false);
    });

    // ---- R2: the capability preflight ----
    it("503s with PARTNER_ADMIN_CAPABILITY_UNAVAILABLE when the admin role cannot see through RLS", async () => {
      const { resetPartnerAdminCapabilityCache } = await import("../server/partner/admin-capability");
      const originalAdminUrl = process.env.PARTNER_ADMIN_DATABASE_URL;

      // A synthetic privileged-ish role WITHOUT BYPASSRLS. Under FORCE RLS every statement this
      // router issues would address zero rows, so a write would report success having changed
      // nothing — the failure mode the preflight exists to convert into an explicit 503.
      await admin.query("DROP ROLE IF EXISTS partner_admin_norls").catch(() => {});
      await admin.query("CREATE ROLE partner_admin_norls LOGIN PASSWORD 'synthetic' NOBYPASSRLS");
      await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO partner_admin_norls");
      await admin.query("GRANT USAGE ON SCHEMA public TO partner_admin_norls");
      try {
        const noRlsUrl = new URL(ADMIN_DB!);
        noRlsUrl.username = "partner_admin_norls";
        noRlsUrl.password = "synthetic";
        process.env.PARTNER_ADMIN_DATABASE_URL = noRlsUrl.toString();
        await closePartnerPools(); // drop the pooled admin connection AND the capability cache
        resetPartnerAdminCapabilityCache();

        const read = await req("GET", FLAGS_BASE, { cookie: adminCookie });
        expect(read.status).toBe(503);
        expect((read.body.code as string) ?? (read.body.error as Json)?.code).toBe(
          "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE"
        );

        const write = await req("PUT", `${FLAGS_BASE}/partner_portal_enabled`, {
          cookie: adminCookie,
          body: { enabled: false, reason: "must never reach the database" },
        });
        expect(write.status).toBe(503);
      } finally {
        process.env.PARTNER_ADMIN_DATABASE_URL = originalAdminUrl;
        await closePartnerPools();
        resetPartnerAdminCapabilityCache();
        await admin.query("DROP OWNED BY partner_admin_norls").catch(() => {});
        await admin.query("DROP ROLE IF EXISTS partner_admin_norls").catch(() => {});
      }

      // the surface recovers once the capable role is restored, and nothing was written meanwhile
      const recovered = await req("GET", FLAGS_BASE, { cookie: adminCookie });
      expect(recovered.status).toBe(200);
      const { resolveGlobalFlag } = await import("../server/partner/flags");
      expect(await resolveGlobalFlag("partner_portal_enabled")).toBe(true);
    });
  });

  // =========================================================================
  // F. Each gate, individually, on a mount with NOTHING else in front of it.
  //
  //    Every test above reaches the mount through the production composition, where the public
  //    router sits in front. That means a gate could be deleted from mount.ts and those tests
  //    could still pass, because the public router's own emergency-stop and portal_enabled checks
  //    would mask its absence. This block removes that shadow: only mountPartnerPortal is
  //    registered, so each 503 can come from exactly one place. It also asserts the mount's exact
  //    body, so a gate cannot be replaced with a differently-shaped rejection and stay green.
  // =========================================================================
  describe("each mount gate fires individually (mount registered alone)", () => {
    let soloServer: http.Server;
    let soloBase = "";

    beforeAll(async () => {
      const express = (await import("express")).default;
      const { mountPartnerPortal } = await import("../server/partner/mount");
      const soloApp = express();
      soloApp.use(express.json());
      mountPartnerPortal(soloApp); // NOTHING else — no public router, no session, no SPA
      soloServer = http.createServer(soloApp);
      await new Promise<void>((r) => soloServer.listen(0, "127.0.0.1", r));
      soloBase = `http://127.0.0.1:${(soloServer.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((r) => soloServer?.close(() => r()));
    });

    /** Probe an authenticated path on the solo mount; returns status + parsed body. */
    async function probe(): Promise<{ status: number; body: Json }> {
      const res = await fetch(`${soloBase}/api/partner/session`);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
    }

    it("gate 1a — no PARTNER_DATABASE_URL: 503 with the mount's exact body", async () => {
      await enableLiveFlags();
      const original = process.env.PARTNER_DATABASE_URL;
      try {
        delete process.env.PARTNER_DATABASE_URL;
        const r = await probe();
        expect(r.status).toBe(503);
        expect(r.body).toEqual(GATED_BODY);
      } finally {
        process.env.PARTNER_DATABASE_URL = original;
      }
      expect((await probe()).status).toBe(PAST_THE_GATES); // unauthenticated but PAST the gates
    });

    it("gate 1b — PARTNER_DATABASE_URL set but PARTNER_MFA_ENC_KEY missing: 503 (coherence)", async () => {
      await enableLiveFlags();
      const original = process.env.PARTNER_MFA_ENC_KEY;
      try {
        delete process.env.PARTNER_MFA_ENC_KEY;
        const r = await probe();
        expect(r.status).toBe(503);
        expect(r.body).toEqual(GATED_BODY);
      } finally {
        process.env.PARTNER_MFA_ENC_KEY = original;
      }
      expect((await probe()).status).toBe(PAST_THE_GATES);
    });

    it("gate 2 — broken SECURITY DEFINER ownership model: 503, and it recovers when repaired", async () => {
      await enableLiveFlags();
      const { __resetDefinerHealthForTests } = await import("../server/partner/mount");
      // The guard requires partner_auth_lookup to be owned by the BYPASSRLS partner_definer role.
      // Reassigning it to the migrator breaks exactly that property and nothing else.
      const { rows } = await admin.query<{ sig: string }>(
        `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname='partner_auth_lookup' AND n.nspname='public'`
      );
      const sig = rows[0].sig;
      try {
        await admin.query(`ALTER FUNCTION ${sig} OWNER TO pn_migrator`);
        __resetDefinerHealthForTests(); // health is memoised only when HEALTHY; re-evaluate now
        const r = await probe();
        expect(r.status).toBe(503);
        expect(r.body).toEqual(GATED_BODY);
      } finally {
        await admin.query(`ALTER FUNCTION ${sig} OWNER TO partner_definer`);
        __resetDefinerHealthForTests();
      }
      expect((await probe()).status).toBe(PAST_THE_GATES); // a repaired model re-opens the surface
    });

    it("gate 3 — partner_emergency_stop ON: 503 with the mount's exact body", async () => {
      await enableLiveFlags();
      await setGlobalFlag("partner_emergency_stop", true);
      const r = await probe();
      expect(r.status).toBe(503);
      expect(r.body).toEqual(GATED_BODY);
      await setGlobalFlag("partner_emergency_stop", false);
      expect((await probe()).status).toBe(PAST_THE_GATES);
    });

    it("gate 4 — partner_portal_enabled OFF or absent: 503 with the mount's exact body", async () => {
      await enableLiveFlags();
      await setGlobalFlag("partner_portal_enabled", false);
      expect((await probe()).body).toEqual(GATED_BODY);
      expect((await probe()).status).toBe(503);
      // absent behaves identically to explicitly false (fail closed on a missing row)
      await admin.query("DELETE FROM partner_feature_flags WHERE flag='partner_portal_enabled'");
      const absent = await probe();
      expect(absent.status).toBe(503);
      expect(absent.body).toEqual(GATED_BODY);
      await setGlobalFlag("partner_portal_enabled", true);
      expect((await probe()).status).toBe(PAST_THE_GATES);
    });
  });
});
