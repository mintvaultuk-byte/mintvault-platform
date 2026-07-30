/**
 * WAVE 1.5 P1 — Partner Shop Pilot INTEGRATION SEAM regressions.
 *
 * WHY THIS SUITE EXISTS
 *
 * Wave 1 integrated three work packages that each have their own strong suite. Two behaviours,
 * however, only exist WHERE TWO PACKAGES MEET, and no committed test covered either of them:
 *
 *   SEAM A — WP-1 owns the only API that can write a GLOBAL partner feature-flag row
 *            (PUT /api/super-admin/partner-flags/:flag). WP-3's connector driver reads those same
 *            global rows on every cycle. Whether an operator flipping the switch through the real
 *            HTTP surface is OBSERVED by an already-running driver — same process, no restart, no
 *            pool rebuild — is a property of the seam, not of either package. WP-1's suite proves
 *            the write lands in the table; WP-3's suite flips the flag with its own raw SQL. Put a
 *            per-process cache in front of the runtime's gate resolution and BOTH stay green.
 *
 *   SEAM B — /api/partner response bodies must never reach the application log: POST
 *            /api/partner/mfa/enrol returns `otpauthUri`, which embeds the raw TOTP seed as a query
 *            parameter, and `redactSensitive` keys off FIELD NAMES so it masks `secret` and misses
 *            `otpauthUri` entirely. The suppression lives in the request logger (server/index.ts
 *            before this package; server/lib/request-logger.ts now). The only prior coverage read
 *            the prefix list out of index.ts as TEXT and re-implemented the startsWith rule in the
 *            test — so it would have passed with the logger middleware deleted outright, and it
 *            never once observed a real log line.
 *
 * Both seams are therefore driven here through the INTEGRATED composition — real routers, real
 * middleware, real gates, real HTTP, real PostgreSQL 17 — and asserted on OBSERVED EFFECTS
 * (the driver's own gate report; the log lines the sink actually received), never on source text.
 *
 * MUTATION-WORTHINESS (both proven by performing the mutation, capturing the failure, reverting):
 *   (i)  delete "/api/partner" from BODY_LOG_SUPPRESSED_PREFIXES  -> seam B fails
 *   (ii) resolve the runtime's gate once and cache it             -> seam A fails
 *
 * Reproduce (host must be loopback; the database is DISPOSABLE and is dropped/recreated). This
 * suite creates and uses its OWN database (mintvault_partner_seams) derived from the admin URL, so
 * it never contends with tests/partner-portal-mount-integration.test.ts on mintvault_partner_mount:
 *   PARTNER_MOUNT_RT_ADMIN=postgres://postgres:postgres@127.0.0.1:55433/mintvault_partner_mount \
 *   PARTNER_MOUNT_RT_RUNTIME=postgres://partner_app_test:synthetic@127.0.0.1:55433/mintvault_partner_mount \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-integration-seams.test.ts
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
} from "./helpers/partner-realistic-db";

const MOUNT_ADMIN = process.env.PARTNER_MOUNT_RT_ADMIN;
const MOUNT_RUNTIME = process.env.PARTNER_MOUNT_RT_RUNTIME;

function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(MOUNT_ADMIN) && isLoopback(MOUNT_RUNTIME);

/**
 * FAIL CLOSED IN CI.
 *
 * The suite gates on loopback URLs so a developer without a local PostgreSQL still gets a green
 * run. That gate is a LOCAL convenience only: in CI a missing variable must be a hard failure,
 * because a silently-skipped suite is exactly how the Partner Master Dashboard and Partner User
 * Management coverage sat dormant for their whole lives while reporting green. Copied deliberately
 * from tests/partner-portal-mount-integration.test.ts.
 *
 * This suite reuses the PARTNER_MOUNT_RT_* variables (already wired in CI) purely as a SERVER
 * coordinate — it provisions its own database on that server, so adding it required no CI change.
 */
describe("Partner integration seam coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(
        isLocal,
        "PARTNER_MOUNT_RT_ADMIN and PARTNER_MOUNT_RT_RUNTIME must be set to loopback PostgreSQL " +
          "URLs in CI, or the partner integration seam suite does not run at all"
      ).toBe(true);
    }
  });
});

/** This suite's OWN database on the same server — never shared with another suite. */
const SEAMS_DB = "mintvault_partner_seams";

const FLAGS_BASE = "/api/super-admin/partner-flags";
const CONTROL_PATH = "/api/__seam/control";

/**
 * A body marker chosen so it can only come from the control route, and a field name
 * `redactSensitive` does NOT mask — the control assertion must prove the logger writes bodies, so
 * it must not be accidentally satisfied (or defeated) by redaction.
 */
const CONTROL_MARKER = "seam-b-control-body-marker";

/** Stable synthetic ids. No real partner names, emails or addresses anywhere in this file. */
const TENANT = "dddd0001-0000-0000-0000-00000000000f";
const OWNER_ID = "dddd0001-0000-0000-0000-0000000000a1";
const OWNER_EMAIL = "seams-owner@example.test";
const OWNER_PASSWORD = "seams-owner-password-1";
const LOCATION = "dddd0001-0000-0000-0000-0000000000c1";

let admin: Client;
let server: http.Server;
let base = "";
let adminCookie = "";
let closePartnerPools: () => Promise<void>;
let runtime: typeof import("../server/partner/connector-runtime");

/** Every line the REAL request logger emitted, in order. The injected sink writes here. */
let logLines: string[] = [];

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

/**
 * The logger writes on res.on("finish"), which can land a tick AFTER fetch() resolves. Poll briefly
 * for the line rather than sleeping a fixed amount — a flaky seam test is worse than no seam test.
 */
async function waitForLogLine(match: string, timeoutMs = 2000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = logLines.find((l) => l.includes(match));
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Set a GLOBAL flag row directly. FIXTURE CONTROL ONLY — seam A drives the real HTTP route. */
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

/** Flip a GLOBAL flag through the REAL super-admin API. Returns the route's own response. */
async function flipFlagViaApi(flag: string, enabled: boolean): Promise<{ status: number; body: Json }> {
  const r = await req("PUT", `${FLAGS_BASE}/${flag}`, {
    body: { enabled, reason: `seam-a regression: set ${flag}=${enabled}` },
    cookie: adminCookie,
  });
  return { status: r.status, body: r.body };
}

/** Enable the flags the authenticated partner surface needs to serve a login + MFA enrol. */
async function enableLiveFlags(): Promise<void> {
  await clearAllFlags();
  for (const f of ["partner_portal_enabled", "partner_login_enabled"]) {
    await setGlobalFlag(f, true);
  }
}

async function login(): Promise<{ status: number; cookie: string; body: Json }> {
  const r = await req("POST", "/api/partner/auth/login", {
    body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  return { status: r.status, cookie: r.setCookie, body: r.body };
}

(isLocal ? describe : describe.skip)("Partner Shop Pilot — Wave 1 integration seams", () => {
  beforeAll(async () => {
    // ---- provision this suite's OWN database on the server the CI variables point at ----
    // CREATE DATABASE has no IF NOT EXISTS and cannot run inside a transaction, so existence is
    // queried first. The CI workflow's database-creation loop is owned by another package and is
    // not edited; doing this here is what lets the suite run in CI with no workflow change.
    const bootstrapUrl = new URL(MOUNT_ADMIN!);
    bootstrapUrl.pathname = "/postgres";
    const bootstrap = new Client({ connectionString: bootstrapUrl.toString() });
    await bootstrap.connect();
    const present = await bootstrap.query("SELECT 1 FROM pg_database WHERE datname=$1", [SEAMS_DB]);
    if (present.rowCount === 0) await bootstrap.query(`CREATE DATABASE ${SEAMS_DB}`);
    await bootstrap.end();

    const seamsAdminUrl = new URL(MOUNT_ADMIN!);
    seamsAdminUrl.pathname = `/${SEAMS_DB}`;
    const SEAMS_ADMIN = seamsAdminUrl.toString();

    // Distinct login-role names (NOT the mount suite's partner_app_test): roles are cluster-wide,
    // and that suite DROPs its role in afterAll. Sharing one would couple two suites through the
    // role catalogue for no benefit.
    const rtUrl = new URL(SEAMS_ADMIN);
    rtUrl.username = "partner_seams_rt";
    rtUrl.password = "synthetic";
    const connUrl = new URL(SEAMS_ADMIN);
    connUrl.username = "partner_seams_conn";
    connUrl.password = "synthetic";

    // server/db.ts (Drizzle) reads MINTVAULT_DATABASE_URL at module load; requireSuperAdmin
    // re-loads the admin user through it and storage.writeAuditLog writes audit_log through it.
    process.env.MINTVAULT_DATABASE_URL = SEAMS_ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = SEAMS_ADMIN;
    process.env.PARTNER_DATABASE_URL = rtUrl.toString();
    process.env.PARTNER_CONNECTOR_DATABASE_URL = connUrl.toString();
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, never a real key
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";

    admin = new Client({ connectionString: SEAMS_ADMIN });
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
    // surfaces as an opaque 500 on every request. submissions/submission_items must exist before
    // the migration list is applied (0010 grants the connector role access to them).
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
    await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
      id serial PRIMARY KEY, user_id varchar, status varchar(30) NOT NULL DEFAULT 'draft',
      tracking_number text UNIQUE, card_count integer NOT NULL DEFAULT 0,
      total_price decimal(10,2) NOT NULL DEFAULT 0, total_declared_value integer NOT NULL DEFAULT 0,
      service_type text, created_at timestamptz NOT NULL DEFAULT now())`);
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

    await applyMigrationsRealistic(admin, SEAMS_ADMIN, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);

    // Synthetic LOGIN roles inheriting the restricted partner roles — neither may be a superuser,
    // which the first test below proves rather than assumes.
    await admin.query("DROP ROLE IF EXISTS partner_seams_rt").catch(() => {});
    await admin.query("CREATE ROLE partner_seams_rt LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_seams_rt");
    await admin.query("DROP ROLE IF EXISTS partner_seams_conn").catch(() => {});
    await admin.query("CREATE ROLE partner_seams_conn LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_connector_runtime TO partner_seams_conn");

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    const authMod = await import("../server/auth");
    const ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [ADMIN_EMAIL.toLowerCase()]
    );

    // One synthetic partner with an ACTIVE owner, so seam B can drive a real authenticated route.
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'seamA','Seam A Ltd','ACTIVE')",
      [TENANT]
    );
    const pw = await bcrypt.hash(OWNER_PASSWORD, 12);
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required)
       VALUES ($1,'sOwner',$2,$2,$3,$4,'ACTIVE',false)`,
      [OWNER_ID, TENANT, OWNER_EMAIL, pw]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [TENANT, OWNER_ID]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'sLoc',$2,$2,'Seam Loc','ACTIVE')",
      [LOCATION, TENANT]
    );
    await admin.query("INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)", [
      TENANT,
      OWNER_ID,
      LOCATION,
    ]);

    const dbMod = await import("../server/partner/db");
    closePartnerPools = dbMod.closePartnerPools;

    // ---- the app under test: the production composition, plus the REAL request logger ----
    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { createRequestLogger } = await import("../server/lib/request-logger");
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

    // THE REAL MIDDLEWARE, with an injected sink instead of console output. Registered BEFORE the
    // routes, exactly as server/index.ts registers it before registerRoutes() — the res.json
    // capture only works if the logger wraps res.json before a handler calls it.
    app.use(createRequestLogger((message: string) => logLines.push(message)));

    // TEST-ONLY session stamp (never shipped) — mirrors what the real login + PIN flow produces.
    app.post("/__test/admin-login", (rq, rs) => {
      const s = rq.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = ADMIN_EMAIL;
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      rq.session.save(() => rs.json({ ok: true }));
    });

    // CONTROL ROUTE — an /api path that is NOT suppressed. Without it, "the partner body is absent
    // from the log" would pass just as well if the logger were never mounted, never wired to the
    // sink, or silently logging nothing at all. This is the positive half of seam B.
    app.get(CONTROL_PATH, (_rq, rs) => {
      rs.json({ marker: CONTROL_MARKER });
    });

    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    registerPartnerFlagAdminRoutes(app);

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const adminLogin = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    adminCookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0];
    expect(adminCookie).toContain("mv.sid");

    runtime = await import("../server/partner/connector-runtime");
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await runtime?.stopConnectorRuntime().catch(() => undefined);
    const { closeConnectorPool } = await import("../server/partner/connector-db");
    await closeConnectorPool().catch(() => undefined);
    await closePartnerPools?.().catch(() => undefined);
    await admin?.query("DROP ROLE IF EXISTS partner_seams_rt").catch(() => {});
    await admin?.query("DROP ROLE IF EXISTS partner_seams_conn").catch(() => {});
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    logLines = [];
    // Isolate the IP-keyed partner login limiter between tests (all tests share 127.0.0.1).
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
  });

  // =========================================================================
  // Control — the runtime connections really are restricted roles.
  // =========================================================================
  it("both partner runtime roles connect as NON-superusers", async () => {
    for (const url of [process.env.PARTNER_DATABASE_URL!, process.env.PARTNER_CONNECTOR_DATABASE_URL!]) {
      const c = new Client({ connectionString: url });
      await c.connect();
      const who = await c.query<{ u: string; su: boolean }>(
        "SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su"
      );
      expect(who.rows[0].su).toBe(false);
      await c.end();
    }
  });

  // =========================================================================
  // SEAM A — WP-1's real flag API is observed by WP-3's running driver.
  // =========================================================================
  describe("SEAM A — a global flag flipped through the real super-admin API reaches the connector driver", () => {
    /**
     * ONE test, deliberately. Every flip below happens in a SINGLE process against an ALREADY
     * IMPORTED runtime module: no re-import, no `__resetConnectorRuntimeForTest()`, no pool
     * rebuild, no server restart between them. That is precisely what makes the test sensitive to
     * mutation (ii): cache the gate resolution anywhere between the flag row and `resolveGate()`
     * and the second observation below still reports the FIRST value, and this fails.
     */
    it("off -> on -> off is observed by runConnectorCycle in the same process, with no restart", async () => {
      await clearAllFlags();

      // --- 1. Flip OFF through the real route. The route is the thing under test, so its own
      //        contract is asserted too: 200, and `effective` re-read through the RUNTIME pool
      //        (the split-brain check inside the route).
      const off1 = await flipFlagViaApi("partner_connector_enabled", false);
      expect(off1.status, JSON.stringify(off1.body)).toBe(200);
      expect(off1.body).toMatchObject({ flag: "partner_connector_enabled", enabled: false, effective: false });

      const closed1 = await runtime.runConnectorCycle({ singleCycle: true });
      expect(closed1.gateOpen).toBe(false);
      expect(closed1.idleReason).toBe("flag_disabled");

      // --- 2. Flip ON through the same route. No restart, no reset — if the driver caches the
      //        gate, it reports closed here and the assertion fails.
      const on = await flipFlagViaApi("partner_connector_enabled", true);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body).toMatchObject({ enabled: true, effective: true });

      const opened = await runtime.runConnectorCycle({ singleCycle: true });
      expect(opened.gateOpen, "the driver must observe the API-driven flag flip without a restart").toBe(true);
      expect(opened.idleReason).toBeNull();

      // --- 3. Flip OFF again. Proves the observation is bidirectional: a cache seeded on the
      //        first OPEN read would keep the connector running after an operator switched it off,
      //        which is the operationally dangerous direction.
      const off2 = await flipFlagViaApi("partner_connector_enabled", false);
      expect(off2.status, JSON.stringify(off2.body)).toBe(200);
      expect(off2.body).toMatchObject({ enabled: false, effective: false });

      const closed2 = await runtime.runConnectorCycle({ singleCycle: true });
      expect(closed2.gateOpen, "switching the connector OFF through the API must halt the driver").toBe(false);
      expect(closed2.idleReason).toBe("flag_disabled");
    }, 60_000);

    it("partner_emergency_stop set through the real API halts a driver whose own flag is ON", async () => {
      await clearAllFlags();

      // Connector explicitly enabled, emergency stop explicitly off — the gate is open.
      expect((await flipFlagViaApi("partner_connector_enabled", true)).status).toBe(200);
      expect((await flipFlagViaApi("partner_emergency_stop", false)).status).toBe(200);
      const running = await runtime.runConnectorCycle({ singleCycle: true });
      expect(running.gateOpen).toBe(true);
      expect(running.idleReason).toBeNull();

      // The platform-wide stop must OVERRIDE the connector's own enabled flag, and the driver must
      // say WHY it stopped — "emergency_stop", not the generic "flag_disabled".
      const stop = await flipFlagViaApi("partner_emergency_stop", true);
      expect(stop.status, JSON.stringify(stop.body)).toBe(200);
      expect(stop.body).toMatchObject({ enabled: true, effective: true });

      const halted = await runtime.runConnectorCycle({ singleCycle: true });
      expect(halted.gateOpen, "the emergency stop must halt the driver even with its own flag ON").toBe(false);
      expect(halted.idleReason).toBe("emergency_stop");

      // And releasing it through the same route lets the driver resume — a stop an operator could
      // not undo through the API would be an incident of its own.
      expect((await flipFlagViaApi("partner_emergency_stop", false)).status).toBe(200);
      const resumed = await runtime.runConnectorCycle({ singleCycle: true });
      expect(resumed.gateOpen).toBe(true);
      expect(resumed.idleReason).toBeNull();
    }, 60_000);

    it("the flag write is evidenced in the audit log with the acting super-admin", async () => {
      await clearAllFlags();
      await admin.query("DELETE FROM audit_log");
      expect((await flipFlagViaApi("partner_connector_enabled", true)).status).toBe(200);
      const { rows } = await admin.query<{ action: string; admin_user: string; entity_id: string }>(
        "SELECT action, admin_user, entity_id FROM audit_log WHERE entity_type='partner_feature_flag'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("partner_global_flag_enabled");
      expect(rows[0].entity_id).toBe("partner_connector_enabled");
      expect(rows[0].admin_user).toBeTruthy();
    }, 30_000);
  });

  // =========================================================================
  // SEAM B — the REAL request logger, driven over real HTTP, observed lines.
  // =========================================================================
  describe("SEAM B — /api/partner response bodies never reach the application log", () => {
    /**
     * POSITIVE CONTROL. Everything else in this block is an absence assertion, and an absence
     * assertion is worthless unless the logger is proven to be running and writing bodies. This is
     * that proof: a non-suppressed /api route's body IS present in a captured line.
     */
    it("a non-suppressed /api route's response body IS written to the log", async () => {
      const r = await req("GET", CONTROL_PATH);
      expect(r.status).toBe(200);
      expect(r.body.marker).toBe(CONTROL_MARKER);

      const line = await waitForLogLine(CONTROL_PATH);
      expect(line, "the request logger must be mounted and writing to the sink").toBeTruthy();
      expect(line).toContain(`GET ${CONTROL_PATH} 200`);
      expect(line, "a non-suppressed body must appear after the ' :: ' separator").toContain(CONTROL_MARKER);
    });

    it("a GATED /api/partner request is logged by method/path/status but WITHOUT its body", async () => {
      await clearAllFlags(); // every gate closed -> 503 with a fail-closed error body
      const r = await req("GET", "/api/partner/session");
      expect(r.status).toBe(503);

      // Whichever gate closed first owns the wording (the public router fronts the whole
      // /api/partner prefix, so it answers before mount.ts's gates). The seam assertion is
      // deliberately gate-agnostic: take the body the surface ACTUALLY returned and prove that
      // exact text never reached the log.
      const gatedError = String(r.body.error);
      expect(gatedError.length).toBeGreaterThan(8);

      const line = await waitForLogLine("/api/partner/session");
      expect(line, "the partner request must still be logged — only the BODY is suppressed").toBeTruthy();
      expect(line).toContain("GET /api/partner/session 503");
      expect(line).not.toContain(gatedError);
      expect(line, "no body separator may be emitted for a suppressed path").not.toContain(" :: ");
    });

    it("a 200 /api/partner body is suppressed — the MFA enrol TOTP seed never reaches the log", async () => {
      await enableLiveFlags();
      await admin.query("DELETE FROM partner_mfa_methods WHERE user_id=$1", [OWNER_ID]);

      const owner = await login();
      expect(owner.status, JSON.stringify(owner.body)).toBe(200);

      const enrol = await req("POST", "/api/partner/mfa/enrol", {
        body: { password: OWNER_PASSWORD },
        cookie: owner.cookie,
      });
      expect(enrol.status, JSON.stringify(enrol.body)).toBe(200);

      // The suppression is LOAD-BEARING, not decorative: the response really does carry the raw
      // seed in `otpauthUri`, a field name `redactSensitive` does not mask.
      const secret = String(enrol.body.secret);
      const otpauthUri = String(enrol.body.otpauthUri);
      expect(secret.length).toBeGreaterThan(8);
      expect(otpauthUri).toContain(`secret=${secret}`);

      const line = await waitForLogLine("/api/partner/mfa/enrol");
      expect(line, "the enrol request must be logged at all").toBeTruthy();
      expect(line).toContain("POST /api/partner/mfa/enrol 200");
      expect(line).not.toContain(" :: ");

      // The decisive assertion: the seed appears NOWHERE in anything the logger emitted during
      // this test — not on the enrol line, and not on the login line that preceded it.
      const everything = logLines.join("\n");
      expect(everything, "the raw TOTP seed must never appear in the application log").not.toContain(secret);
      expect(everything, "the otpauth URI embeds the seed and must never be logged").not.toContain("otpauth://");

      await admin.query("DELETE FROM partner_mfa_methods WHERE user_id=$1", [OWNER_ID]);
    }, 60_000);

    it("the partner LOGIN response body is suppressed while the request is still logged", async () => {
      await enableLiveFlags();
      const owner = await login();
      expect(owner.status).toBe(200);

      const line = await waitForLogLine("/api/partner/auth/login");
      expect(line).toBeTruthy();
      expect(line).toContain("POST /api/partner/auth/login 200");
      expect(line, "partner session/user PII must not be written to the log").not.toContain(" :: ");
      expect(logLines.join("\n")).not.toContain(OWNER_EMAIL);
    }, 30_000);

    it("suppression is prefix-scoped: it does not accidentally silence the rest of /api", async () => {
      // Guards the opposite failure mode — a broadened prefix (e.g. "/api") would suppress every
      // body in the product and this suite's other assertions would all still pass.
      const r = await req("GET", CONTROL_PATH);
      expect(r.status).toBe(200);
      const flags = await req("GET", FLAGS_BASE, { cookie: adminCookie });
      expect(flags.status).toBe(200);

      const controlLine = await waitForLogLine(CONTROL_PATH);
      expect(controlLine).toContain(CONTROL_MARKER);
      const flagsLine = await waitForLogLine(`GET ${FLAGS_BASE} 200`);
      expect(flagsLine, "the super-admin FLAG surface is not suppressed and must log its body").toBeTruthy();
      expect(flagsLine).toContain("partner_connector_enabled");
    }, 30_000);
  });
});
