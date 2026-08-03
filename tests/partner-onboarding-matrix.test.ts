/**
 * Partner Shop Pilot — INVITATION ONBOARDING MATRIX (PostgreSQL 17 integration).
 *
 * WHY THIS SUITE EXISTS
 *
 * Two independent code paths mint partner invitation tokens and both can reach the Resend
 * transport:
 *
 *   (a) SUPER-ADMIN  server/partner/partner-management-service.ts  createInvitationRecord()
 *   (b) PARTNER-SIDE server/partner/team-service.ts                createInvitationRecord()
 *
 * Both call `deliverInvitationToken()` whenever `invitationDeliveryConfigured()` is true, and that
 * predicate is true when EITHER a test adapter is installed OR `RESEND_API_KEY` is present. The
 * existing suites install the capture adapter and therefore never exercise the question that
 * matters for a pilot running against a real Resend key: *is the adapter genuinely in front of the
 * transport, and does anything in a full create+accept cycle reach the wire?* An adapter that
 * silently stopped being consulted would leave every existing partner suite green while sending
 * real email to synthetic `@example.test` addresses.
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE (deliberately NOT repeated here)
 *   • tests/partner-runtime-integration.test.ts — capture adapter installs, token_hash != raw
 *     token, resend supersedes, team-path accept is single-use/expiry-aware/role-bound.
 *   • tests/partner-management-integration.test.ts — super-admin create/resend/revoke, token_hash
 *     is 64-hex and != raw token, list/detail payloads do not leak token_hash.
 *   • tests/partner-portal-mount-integration.test.ts — the four mount gates and the master switch.
 *
 * WHAT THIS SUITE ADDS
 *   1. A transport-level Resend probe (`vi.mock("resend")`) asserting EXACTLY ZERO outbound sends
 *      across create+accept on BOTH paths, with a positive control proving the probe would have
 *      fired had the adapter been absent.
 *   2. The invitation URL contract (scheme/host/path/query) on both the email surface and the
 *      super-admin link-copy surface, under `APP_URL=https://mintvault-v2.fly.dev`.
 *   3. A token rejection matrix driven through the REAL public HTTP route.
 *   4. Acceptance correctness stated against what the code actually does (no user is created at
 *      acceptance — the INVITED row is activated — and NO session is issued).
 *   5. Validation rejection leaves the DB byte-identical; genuine mid-transaction invitation
 *      rollback is covered in tests/partner-management-integration.test.ts.
 *   6. Deterministic concurrency over the real HTTP surface using a test-only transaction barrier.
 *   7. Cross-tenant isolation over the NOBYPASSRLS runtime role, including identifier guessing.
 *   8. The `partner_onboarding_enabled` gate, and that `partner_portal_enabled` alone does not
 *      open onboarding.
 *   9. Whole-suite console capture asserting no token, password, DB URL or session secret is logged.
 *
 * DATABASE. The suite gates on the PARTNER_MOUNT_RT_ADMIN / PARTNER_MOUNT_RT_RUNTIME pair (already
 * provisioned by .github/workflows/ci.yml on the disposable PostgreSQL 17 service) but does NOT use
 * the mount suite's database: it CREATEs its OWN disposable database on the same server and its own
 * cluster-unique login roles, so the two suites can never race on `DROP SCHEMA public`.
 *
 * SYNTHETIC DATA ONLY — every address is `@example.test`, every organisation name is explicitly
 * marked SYNTHETIC, and no raw token, password or connection string is ever printed.
 *
 * Reproduce (host must be loopback; the database is created and dropped by this file):
 *   PARTNER_MOUNT_RT_ADMIN=postgres://postgres@127.0.0.1:5599/postgres \
 *   PARTNER_MOUNT_RT_RUNTIME=postgres://partner_app_test_mount:synthetic@127.0.0.1:5599/postgres \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-onboarding-matrix.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
} from "./helpers/partner-realistic-db";

// ---------------------------------------------------------------------------
// RESEND TRANSPORT PROBE
//
// server/email.ts does `import { Resend } from "resend"` and lazily constructs the client inside
// getResend(). Replacing the PACKAGE (not server/email.ts) keeps the whole production email module
// — template rendering, sendViaResend's error handling, the invitation URL construction — running
// for real while making the network boundary itself observable and inert. `vi.mock` is hoisted
// above the imports, so the counters must live in `vi.hoisted`.
// ---------------------------------------------------------------------------
const resendProbe = vi.hoisted(() => ({
  constructions: 0,
  sends: 0,
  payloads: [] as Array<{ to?: unknown; subject?: unknown; html?: string }>,
}));

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = {
      send: async (payload: { to?: unknown; subject?: unknown; html?: string }) => {
        resendProbe.sends += 1;
        resendProbe.payloads.push(payload);
        // Shape sendViaResend() expects on success. No network, no credentials, no retries.
        return { data: { id: "synthetic-mock-message-id" }, error: null };
      },
    };
    constructor(_apiKey?: string) {
      resendProbe.constructions += 1;
    }
  },
}));

function probeSnapshot(): { constructions: number; sends: number } {
  return { constructions: resendProbe.constructions, sends: resendProbe.sends };
}

// ---------------------------------------------------------------------------
// Environment gate (loopback only) + the CI fail-closed guard.
// ---------------------------------------------------------------------------
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
 * The loopback gate is a LOCAL convenience so a developer without PostgreSQL still gets a green
 * run. In CI a missing variable must be a hard failure — a silently-skipped suite is exactly how
 * the Partner Master Dashboard and Partner User Management coverage sat dormant for their whole
 * lives while reporting green. Copied deliberately from
 * tests/partner-portal-mount-integration.test.ts.
 */
describe("Partner onboarding matrix coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(
        isLocal,
        "PARTNER_MOUNT_RT_ADMIN and PARTNER_MOUNT_RT_RUNTIME must be set to loopback PostgreSQL " +
          "URLs in CI, or the partner onboarding matrix suite does not run at all"
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic fixture constants. No real person, shop, address or phone number.
// ---------------------------------------------------------------------------
const OWN_DATABASE = "mintvault_psp_onboarding";
const RUNTIME_ROLE = "psp_onb_runtime"; // NOBYPASSRLS — the tenant-facing partner surface
const RUNTIME_ROLE_PASSWORD = "synthetic-psp-runtime-pw";
const ADMIN_ROLE = "psp_onb_admin"; // BYPASSRLS — the super-admin control shell
const ADMIN_ROLE_PASSWORD = "synthetic-psp-admin-pw";

const TENANT_A = "0a5b0001-0000-0000-0000-0000000000aa";
const TENANT_B = "0b5b0002-0000-0000-0000-0000000000bb";
const OWNER_A = "0a5b0001-0000-0000-0000-0000000000a1";
const OWNER_B = "0b5b0002-0000-0000-0000-0000000000b1";
const LOCATION_A = "0a5b0001-0000-0000-0000-0000000000c1";
const LOCATION_B = "0b5b0002-0000-0000-0000-0000000000c2";
const OWNER_A_EMAIL = "psp-owner-alpha@example.test";
const OWNER_B_EMAIL = "psp-owner-bravo@example.test";
const OWNER_PASSWORD = "synthetic-owner-password-a1";
const SESSION_SECRET = "synthetic-psp-onboarding-session-secret";

const PM = "/api/super-admin/partner-management";
const ACCEPT = "/api/partner/invitations/accept";
const EXPECTED_APP_URL = "https://mintvault-v2.fly.dev";

// Every raw token the suite ever sees, so the log-redaction test can assert against all of them.
// Never printed; only used for `includes` checks and parameterised SQL.
const seenTokens: string[] = [];
// Every password the suite ever submits, for the same reason.
const seenPasswords: string[] = [OWNER_PASSWORD];

type CapturedInvite = { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date };
const capturedInvites: CapturedInvite[] = [];

let adminDbUrl = "";
let runtimeDbUrl = "";
let admin: Client;
let server: http.Server;
let base = "";
let superAdminCookie = "";
let closePartnerPools: () => Promise<void>;
let setInvitationDeliveryAdapter: (a: null | ((d: CapturedInvite) => Promise<void>)) => void;
let deliverInvitationToken: (d: CapturedInvite) => Promise<void>;

// Whole-suite console capture (matrix item 9).
const consoleLines: string[] = [];
const realConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

// process.env keys this suite mutates — every one is restored in afterAll.
const ENV_KEYS = [
  "APP_URL",
  "RESEND_API_KEY",
  "MINTVAULT_DATABASE_URL",
  "PARTNER_ADMIN_DATABASE_URL",
  "PARTNER_DATABASE_URL",
  "PARTNER_MFA_ENC_KEY",
  "SESSION_SECRET",
  "PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY",
] as const;
const envBackup: Record<string, string | undefined> = {};

function dbUrlAs(raw: string, database: string, username?: string, password?: string): string {
  const u = new URL(raw);
  u.pathname = `/${database}`;
  if (username !== undefined) u.username = username;
  if (password !== undefined) u.password = password;
  return u.toString();
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

type Json = Record<string, unknown>;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: Json; raw: string; setCookie: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const raw = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(raw) as Json;
  } catch {
    /* non-JSON body — assertions use `status` and `raw` */
  }
  return { status: res.status, body, raw, setCookie: res.headers.get("set-cookie") };
}

/** Count rows in `table` whose full row text contains `needle` (LIKE-wildcard safe via strpos). */
async function rowsContaining(table: string, needle: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} t WHERE strpos(to_jsonb(t)::text, $1) > 0`,
    [needle]
  );
  return rows[0].n;
}

async function setGlobalFlag(flag: string, enabled: boolean): Promise<void> {
  await admin.query("DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL", [
    flag,
  ]);
  await admin.query(
    "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,$1,$2)",
    [flag, enabled]
  );
}

async function enableLiveFlags(): Promise<void> {
  await admin.query("DELETE FROM partner_feature_flags");
  for (const f of ["partner_portal_enabled", "partner_login_enabled", "partner_onboarding_enabled"]) {
    await setGlobalFlag(f, true);
  }
}

/** Super-admin invite (path (a)). Returns the created userId and the token the ADAPTER captured. */
async function superAdminInvite(
  tenantId: string,
  email: string,
  role: "OWNER" | "ADMIN" | "GRADER" | "STAFF"
): Promise<{ status: number; body: Json; userId: string; invitationId: string; token: string }> {
  const before = capturedInvites.length;
  const r = await req("POST", `${PM}/partners/${tenantId}/users`, {
    body: {
      firstName: "Synthetic",
      lastName: "Invitee",
      email,
      role,
      reason: "synthetic onboarding matrix fixture",
    },
    cookie: superAdminCookie,
  });
  const result = (r.body.result ?? {}) as Json;
  const captured = capturedInvites.length > before ? capturedInvites[capturedInvites.length - 1] : null;
  if (captured) seenTokens.push(captured.token);
  return {
    status: r.status,
    body: r.body,
    userId: String(result.userId ?? ""),
    invitationId: String(result.invitationId ?? ""),
    token: captured?.token ?? "",
  };
}

/** Partner-side team invite (path (b)). Requires an authenticated partner OWNER cookie. */
async function partnerTeamInvite(
  cookie: string,
  email: string,
  role: "OWNER" | "ADMIN" | "GRADER" | "STAFF"
): Promise<{ status: number; body: Json; userId: string; token: string }> {
  const before = capturedInvites.length;
  const r = await req("POST", "/api/partner/users", {
    body: { firstName: "Synthetic", lastName: "Teammate", email, role, reason: "synthetic matrix fixture" },
    cookie,
  });
  const result = (r.body.result ?? {}) as Json;
  const captured = capturedInvites.length > before ? capturedInvites[capturedInvites.length - 1] : null;
  if (captured) seenTokens.push(captured.token);
  return { status: r.status, body: r.body, userId: String(result.userId ?? ""), token: captured?.token ?? "" };
}

async function partnerLoginCookie(email: string, password = OWNER_PASSWORD): Promise<string> {
  const r = await req("POST", "/api/partner/auth/login", { body: { email, password } });
  expect(r.status, `partner login for ${email} must succeed`).toBe(200);
  return (r.setCookie ?? "").split(";")[0];
}

/** Pull the invitation URL out of a captured Resend HTML payload (production-built, HTML-escaped). */
function inviteUrlFromHtml(html: string): string {
  const match = html.match(/href="([^"]*\/partner\/invite[^"]*)"/);
  expect(match, "the invitation email must contain exactly one /partner/invite anchor").toBeTruthy();
  return match![1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The shared URL-contract assertions (matrix item 2), applied to any invitation URL surface. */
function assertInvitationUrlContract(rawUrl: string, token: string): void {
  const url = new URL(rawUrl);
  expect(url.protocol).toBe("https:");
  expect(url.host).toBe("mintvault-v2.fly.dev");
  expect(url.hostname).toBe("mintvault-v2.fly.dev");
  expect(url.pathname).toBe("/partner/invite");
  // The token lives in the QUERY only — never in the path, never in a fragment.
  expect(url.pathname.includes(token)).toBe(false);
  expect(url.hash).toBe("");
  expect([...url.searchParams.keys()]).toEqual(["token"]);
  expect(url.searchParams.get("token") === token, "query token must match captured adapter token").toBe(true);
  // URL-encoded: the serialised query must decode back to the exact token, and the whole URL must
  // be byte-identical to encodeURIComponent's output (base64url tokens are already safe, so this
  // also proves no double-encoding was introduced).
  expect(decodeURIComponent(url.search.slice("?token=".length)) === token, "query must decode exactly once").toBe(true);
  expect(
    rawUrl === `${EXPECTED_APP_URL}/partner/invite?token=${encodeURIComponent(token)}`,
    "serialised URL must use the expected host, path and encoded query"
  ).toBe(true);
}

(isLocal ? describe : describe.skip)("Partner invitation onboarding matrix (disposable PG17, real HTTP)", () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];

    // Capture console for the whole suite (matrix item 9). Buffered, never re-printed.
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      console[level] = (...args: unknown[]) => {
        consoleLines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
      };
    }
    console.info("psp-log-capture-positive-control");

    // ---- our OWN disposable database on the CI-provisioned PostgreSQL 17 server ----
    const bootstrap = new Client({ connectionString: MOUNT_ADMIN });
    await bootstrap.connect();
    await bootstrap.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE} WITH (FORCE)`);
    await bootstrap.query(`CREATE DATABASE ${OWN_DATABASE}`);
    await bootstrap.end();

    adminDbUrl = dbUrlAs(MOUNT_ADMIN!, OWN_DATABASE);
    admin = new Client({ connectionString: adminDbUrl });
    await admin.connect();

    // APP_URL must be set BEFORE any application module is imported: server/app-url.ts freezes
    // APP_BASE_URL at module load, and the super-admin link-copy surface reads it from there.
    process.env.APP_URL = EXPECTED_APP_URL;
    // A synthetic Resend key is deliberately PRESENT. It makes invitationDeliveryConfigured() true
    // on its own, so "zero sends" below cannot be an artefact of delivery being switched off — it
    // can only mean the adapter branch ran first. The key never leaves this process: the `resend`
    // package is mocked above.
    process.env.RESEND_API_KEY = "synthetic-resend-key-never-real";
    process.env.MINTVAULT_DATABASE_URL = adminDbUrl;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);
    process.env.SESSION_SECRET = SESSION_SECRET;
    delete process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY;

    await provisionRealisticRoles(admin);

    // MintVault-internal tables. `users` carries the full column set because requireAdmin re-loads
    // the admin user through the real storage layer, which selects every column; a trimmed stub
    // surfaces as an opaque 500 on every request.
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
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
      admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamp NOT NULL DEFAULT now())`);
    for (const t of ["users", "submissions", "submission_items", "audit_log"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }

    await applyMigrationsRealistic(admin, adminDbUrl, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);

    // Cluster-unique login roles. Deliberately NOT a name shared with other partner suites on this
    // same PostgreSQL 17 server: roles are cluster-wide, so a suite that dropped or altered a shared
    // role mid-run would break our live pool.
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE ${RUNTIME_ROLE} WITH LOGIN PASSWORD '${RUNTIME_ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE ${ADMIN_ROLE} LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE ${ADMIN_ROLE} WITH LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       END$$;`
    );
    await admin.query(`GRANT partner_runtime TO ${RUNTIME_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ADMIN_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ADMIN_ROLE}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ADMIN_ROLE}`);

    runtimeDbUrl = dbUrlAs(adminDbUrl, OWN_DATABASE, RUNTIME_ROLE, RUNTIME_ROLE_PASSWORD);
    process.env.PARTNER_DATABASE_URL = runtimeDbUrl;
    process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAs(adminDbUrl, OWN_DATABASE, ADMIN_ROLE, ADMIN_ROLE_PASSWORD);

    const { resetPartnerAdminCapabilityCache } = await import("../server/partner/admin-capability");
    resetPartnerAdminCapabilityCache();

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    const authMod = await import("../server/auth");
    const ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [ADMIN_EMAIL.toLowerCase()]
    );

    // ---- two synthetic tenants, each with one ACTIVE owner and one location ----
    await admin.query(
      `INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES
         ($1,'pspAlpha','SYNTHETIC STAGING TEST ORG ALPHA','ACTIVE'),
         ($2,'pspBravo','SYNTHETIC STAGING TEST ORG BRAVO','ACTIVE')`,
      [TENANT_A, TENANT_B]
    );
    const pw = await bcrypt.hash(OWNER_PASSWORD, 12);
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES
         ($1,'pspOwnA',$3,$3,$5,$7,'ACTIVE',false),
         ($2,'pspOwnB',$4,$4,$6,$7,'ACTIVE',false)`,
      [OWNER_A, OWNER_B, TENANT_A, TENANT_B, OWNER_A_EMAIL, OWNER_B_EMAIL, pw]
    );
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
       SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'`,
      [TENANT_A, OWNER_A]
    );
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
       SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'`,
      [TENANT_B, OWNER_B]
    );
    await admin.query(
      `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES
         ($1,'pspLocA',$3,$3,'SYNTHETIC LOCATION ALPHA','ACTIVE'),
         ($2,'pspLocB',$4,$4,'SYNTHETIC LOCATION BRAVO','ACTIVE')`,
      [LOCATION_A, LOCATION_B, TENANT_A, TENANT_B]
    );
    await admin.query(
      `INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3),($4,$5,$6)`,
      [TENANT_A, OWNER_A, LOCATION_A, TENANT_B, OWNER_B, LOCATION_B]
    );

    // ---- the capture adapter: the seam the whole zero-Resend proof depends on ----
    const delivery = await import("../server/partner/delivery");
    setInvitationDeliveryAdapter = delivery.setInvitationDeliveryAdapter as typeof setInvitationDeliveryAdapter;
    deliverInvitationToken = delivery.deliverInvitationToken as typeof deliverInvitationToken;
    setInvitationDeliveryAdapter(async (data) => {
      capturedInvites.push(data);
    });

    const dbMod = await import("../server/partner/db");
    closePartnerPools = dbMod.closePartnerPools;

    // ---- the app under test: server/routes.ts's partner registration lines, plus G5 ----
    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");

    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use(
      session({
        name: "mv.sid",
        secret: SESSION_SECRET,
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
      s.authUserId = "00000000-0000-0000-0000-0000000000a5";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      rq.session.save(() => rs.json({ ok: true }));
    });
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    registerPartnerManagementRoutes(app);

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const adminLogin = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    superAdminCookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0];
    expect(superAdminCookie).toContain("mv.sid");

    await enableLiveFlags();
  }, 180_000);

  afterAll(async () => {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = realConsole[level];
    setInvitationDeliveryAdapter?.(null);
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePartnerPools?.().catch(() => {});
    await admin?.end().catch(() => {});
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  beforeEach(async () => {
    // Isolate the IP-keyed partner limiters between tests (every request comes from 127.0.0.1).
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
    const svc = await import("../server/partner/partner-management-service");
    svc.__setAcceptPartnerBarrierForTest(null);
  });

  afterEach(async () => {
    const svc = await import("../server/partner/partner-management-service");
    svc.__setAcceptPartnerBarrierForTest(null);
    setInvitationDeliveryAdapter?.(async (data) => {
      capturedInvites.push(data);
    });
  });

  // =========================================================================
  // 0. Controls. Every isolation and "which connection" claim below depends on
  //    these two roles genuinely being what the suite says they are.
  // =========================================================================
  it("control: the tenant-facing runtime role is NOBYPASSRLS and the control-shell role is BYPASSRLS", async () => {
    const runtime = new Client({ connectionString: runtimeDbUrl });
    await runtime.connect();
    const r = await runtime.query<{ u: string; su: boolean; bypass: boolean }>(
      "SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) bypass"
    );
    expect(r.rows[0].u).toBe(RUNTIME_ROLE);
    expect(r.rows[0].su).toBe(false);
    expect(r.rows[0].bypass).toBe(false);
    await runtime.end();

    const shell = new Client({ connectionString: process.env.PARTNER_ADMIN_DATABASE_URL });
    await shell.connect();
    const s = await shell.query<{ u: string; su: boolean; bypass: boolean }>(
      "SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) bypass"
    );
    expect(s.rows[0].u).toBe(ADMIN_ROLE);
    expect(s.rows[0].su).toBe(false);
    expect(s.rows[0].bypass).toBe(true);
    await shell.end();
  });

  // =========================================================================
  // 1. ZERO-RESEND PROOF — the highest-priority item.
  // =========================================================================
  it("zero Resend traffic: a SUPER-ADMIN invitation create + accept never reaches the transport", async () => {
    const email = "psp-zero-superadmin@example.test";
    const password = "synthetic-accept-password-1";
    seenPasswords.push(password);
    const before = probeSnapshot();

    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status, invited.raw ?? JSON.stringify(invited.body)).toBe(200);
    expect(invited.token).not.toBe("");
    // The adapter — not the transport — served the delivery.
    expect(capturedInvites.at(-1)!.email).toBe(email);
    expect(probeSnapshot()).toEqual(before);

    const accepted = await req("POST", ACCEPT, { body: { token: invited.token, password } });
    expect(accepted.status).toBe(200);

    // EXACTLY zero, across create AND accept, with RESEND_API_KEY present the whole time.
    expect(probeSnapshot().sends - before.sends).toBe(0);
    expect(probeSnapshot().constructions - before.constructions).toBe(0);
    // and the raw token never appeared in any HTTP response body.
    expect(invited.body ? JSON.stringify(invited.body).includes(invited.token) : false).toBe(false);
    expect(accepted.raw.includes(invited.token)).toBe(false);
  });

  it("zero Resend traffic: a PARTNER-SIDE team invitation create + accept never reaches the transport", async () => {
    const email = "psp-zero-teamside@example.test";
    const password = "synthetic-accept-password-2";
    seenPasswords.push(password);
    const before = probeSnapshot();

    const cookie = await partnerLoginCookie(OWNER_A_EMAIL);
    const invited = await partnerTeamInvite(cookie, email, "GRADER");
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    expect(invited.token).not.toBe("");
    expect(capturedInvites.at(-1)!.email).toBe(email);
    expect((invited.body.result as Json).invitationLink).toBeUndefined();

    const accepted = await req("POST", ACCEPT, { body: { token: invited.token, password } });
    expect(accepted.status).toBe(200);

    expect(probeSnapshot().sends - before.sends).toBe(0);
    expect(probeSnapshot().constructions - before.constructions).toBe(0);
    expect(JSON.stringify(invited.body).includes(invited.token)).toBe(false);
    expect(accepted.raw.includes(invited.token)).toBe(false);
  });

  it("positive control: with the adapter removed, delivery DOES reach the (mocked) Resend transport", async () => {
    // Everything above asserts an absence. Without this, a probe that could never fire would look
    // identical. Here the adapter is cleared for one controlled call, proving the counter is live
    // and that `deliverInvitationToken` only falls through to `await import("../email")` when no
    // adapter is installed. The `resend` package is mocked, so no network call is possible.
    const before = probeSnapshot();
    const syntheticToken = crypto.randomBytes(32).toString("base64url");
    seenTokens.push(syntheticToken);
    setInvitationDeliveryAdapter(null);
    try {
      await deliverInvitationToken({
        email: "psp-positive-control@example.test",
        token: syntheticToken,
        partnerName: "SYNTHETIC STAGING TEST ORG ALPHA",
        roleCode: "PARTNER_RECEPTION",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    } finally {
      setInvitationDeliveryAdapter(async (data) => {
        capturedInvites.push(data);
      });
    }
    expect(probeSnapshot().sends - before.sends).toBe(1);
    expect(probeSnapshot().constructions).toBeGreaterThanOrEqual(1);

    // Restored: the very next delivery is served by the adapter again and adds no transport traffic.
    const afterFallback = probeSnapshot();
    const invited = await superAdminInvite(TENANT_A, "psp-after-control@example.test", "STAFF");
    expect(invited.status).toBe(200);
    expect(invited.token).not.toBe("");
    expect(probeSnapshot().sends - afterFallback.sends).toBe(0);
  });

  // =========================================================================
  // 2. URL CONTRACT
  // =========================================================================
  it("URL contract: the delivered invitation URL is https://mintvault-v2.fly.dev/partner/invite?token=…", async () => {
    const syntheticToken = crypto.randomBytes(32).toString("base64url");
    seenTokens.push(syntheticToken);
    const before = resendProbe.payloads.length;
    setInvitationDeliveryAdapter(null);
    try {
      await deliverInvitationToken({
        email: "psp-url-contract@example.test",
        token: syntheticToken,
        partnerName: "SYNTHETIC STAGING TEST ORG ALPHA",
        roleCode: "PARTNER_RECEPTION",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    } finally {
      setInvitationDeliveryAdapter(async (data) => {
        capturedInvites.push(data);
      });
    }
    expect(resendProbe.payloads.length - before).toBe(1);
    const payload = resendProbe.payloads[resendProbe.payloads.length - 1];
    assertInvitationUrlContract(inviteUrlFromHtml(payload.html ?? ""), syntheticToken);
  });

  it("URL contract: the super-admin link-copy surface obeys the same contract and is OFF by default", async () => {
    // Default (flag absent): no link, and the raw token is nowhere in the response.
    const off = await superAdminInvite(TENANT_A, "psp-link-off@example.test", "STAFF");
    expect(off.status).toBe(200);
    expect((off.body.result as Json).invitationLink).toBeUndefined();
    expect(JSON.stringify(off.body).includes(off.token)).toBe(false);

    process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY = "true";
    try {
      const on = await superAdminInvite(TENANT_A, "psp-link-on@example.test", "STAFF");
      expect(on.status).toBe(200);
      const link = (on.body.result as Json).invitationLink;
      expect(typeof link).toBe("string");
      // The link's token must be the SAME token the delivery adapter received.
      assertInvitationUrlContract(String(link), on.token);
    } finally {
      delete process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY;
    }
  });

  it("super-admin copy-link endpoint is audited, staging-gated, and production-refused", async () => {
    const invited = await superAdminInvite(TENANT_A, "psp-copy-link@example.test", "STAFF");
    expect(invited.status).toBe(200);

    const off = await req("POST", `${PM}/partners/${TENANT_A}/users/${invited.userId}/copy-invitation-link`, {
      body: { reason: "copy link should be off by default" },
      cookie: superAdminCookie,
    });
    expect(off.status).toBe(403);
    expect(JSON.stringify(off.body)).not.toContain(invited.token);

    process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY = "true";
    try {
      const before = capturedInvites.length;
      const copied = await req("POST", `${PM}/partners/${TENANT_A}/users/${invited.userId}/copy-invitation-link`, {
        body: { reason: "staging copy link for internal demo" },
        cookie: superAdminCookie,
      });
      expect(copied.status).toBe(200);
      const newToken = capturedInvites[capturedInvites.length - 1].token;
      seenTokens.push(newToken);
      expect(capturedInvites.length).toBe(before + 1);
      assertInvitationUrlContract(String((copied.body.result as Json).invitationLink), newToken);
      expect(
        await req("POST", ACCEPT, { body: { token: invited.token, password: "copy-old-token-password-1" } })
      ).toMatchObject({
        status: 400,
      });

      const audit = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM partner_management_audit
          WHERE tenant_id=$1 AND action_type='partner_invitation_resent'
            AND reason LIKE '%admin link copy%'`,
        [TENANT_A]
      );
      expect(audit.rows[0].n).toBeGreaterThan(0);

      const env = { node: process.env.NODE_ENV, app: process.env.APP_URL, fly: process.env.FLY_APP_NAME };
      try {
        process.env.NODE_ENV = "production";
        process.env.APP_URL = "https://mintvaultuk.com";
        process.env.FLY_APP_NAME = "mintvault";
        const beforeProd = capturedInvites.length;
        const prod = await req("POST", `${PM}/partners/${TENANT_A}/users/${invited.userId}/copy-invitation-link`, {
          body: { reason: "must fail in production" },
          cookie: superAdminCookie,
        });
        expect(prod.status).toBe(403);
        expect(capturedInvites.length).toBe(beforeProd);
        expect(JSON.stringify(prod.body)).not.toMatch(/token=|token_hash|copy-link/i);
      } finally {
        if (env.node === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env.node;
        if (env.app === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = env.app;
        if (env.fly === undefined) delete process.env.FLY_APP_NAME;
        else process.env.FLY_APP_NAME = env.fly;
      }
    } finally {
      delete process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY;
    }
  });

  it("invitation preview and onboarding readiness expose server-authoritative login blockers", async () => {
    const email = "psp-readiness@example.test";
    const password = "synthetic-readiness-password-1";
    seenPasswords.push(password);
    const invited = await superAdminInvite(TENANT_A, email, "OWNER");
    expect(invited.status).toBe(200);

    const preview = await req("GET", `/api/partner/invitations/preview?token=${encodeURIComponent(invited.token)}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      ok: true,
      email,
      partnerName: "SYNTHETIC STAGING TEST ORG ALPHA",
      roleCode: "PARTNER_OWNER",
    });
    expect(preview.raw).not.toContain("token_hash");

    await admin.query("UPDATE partner_organisations SET status='PENDING' WHERE id=$1", [TENANT_A]);
    const pending = await req("GET", `${PM}/partners/${TENANT_A}/onboarding-readiness`, { cookie: superAdminCookie });
    expect(pending.status).toBe(200);
    const pendingUser = ((pending.body.users as Json[]) ?? []).find((u) => u.email === email) as Json;
    expect((pendingUser.readiness as Json).loginEnabled).toBe(false);
    expect((pendingUser.readiness as Json).blockedReasons).toContain("Organisation is PENDING.");
    expect((pendingUser.readiness as Json).blockedReasons).toContain(
      "Partner must accept the current invitation and create a password."
    );

    const accepted = await req("POST", ACCEPT, { body: { token: invited.token, password } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.organisationStatus).toBe("PENDING");

    const acceptedReadiness = await req("GET", `${PM}/partners/${TENANT_A}/onboarding-readiness`, {
      cookie: superAdminCookie,
    });
    const acceptedUser = ((acceptedReadiness.body.users as Json[]) ?? []).find((u) => u.email === email) as Json;
    expect((acceptedUser.readiness as Json).passwordConfigured).toBe(true);
    expect((acceptedUser.readiness as Json).userActive).toBe(true);
    expect((acceptedUser.readiness as Json).loginEnabled).toBe(false);
    expect((acceptedUser.readiness as Json).blockedReasons).toContain("Organisation is PENDING.");

    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [TENANT_A]);
    const ready = await req("GET", `${PM}/partners/${TENANT_A}/onboarding-readiness`, { cookie: superAdminCookie });
    const readyUser = ((ready.body.users as Json[]) ?? []).find((u) => u.email === email) as Json;
    expect((readyUser.readiness as Json).loginEnabled).toBe(true);
    expect((readyUser.readiness as Json).blockedReasons).toEqual([]);
  });

  // =========================================================================
  // 3. TOKEN SECURITY
  // =========================================================================
  it("token security: only the sha256 hash is stored, and the raw token appears in no audit row", async () => {
    const email = "psp-token-storage@example.test";
    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status).toBe(200);

    const stored = await admin.query<{ token_hash: string; matches: boolean }>(
      "SELECT token_hash, token_hash = encode(sha256($2::bytea),'hex') AS matches FROM partner_invitations WHERE id=$1",
      [invited.invitationId, invited.token]
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash === invited.token, "stored hash must not equal raw token").toBe(false);
    expect(stored.rows[0].token_hash).toBe(sha256Hex(invited.token));
    expect(stored.rows[0].matches).toBe(true);

    // The raw token must appear in NO row of ANY audit or invitation table (BYPASSRLS connection,
    // so this sees every tenant — a scoped read could hide a leak written under another tenant).
    for (const table of [
      "partner_management_audit",
      "partner_audit_events",
      "partner_invitations",
      "partner_users",
      "audit_log",
    ]) {
      expect(await rowsContaining(table, invited.token), `${table} must not contain the raw token`).toBe(0);
    }
    // Accepting it writes another audit row — that must not leak it either.
    const password = "synthetic-accept-password-3";
    seenPasswords.push(password);
    expect((await req("POST", ACCEPT, { body: { token: invited.token, password } })).status).toBe(200);
    for (const table of ["partner_management_audit", "partner_audit_events", "partner_users", "audit_log"]) {
      expect(await rowsContaining(table, invited.token), `${table} must not contain the raw token`).toBe(0);
      expect(await rowsContaining(table, password), `${table} must not contain the raw password`).toBe(0);
    }
  });

  it("token security: altered, random, hash-substituted, missing and empty tokens are all rejected", async () => {
    const email = "psp-token-matrix@example.test";
    const password = "synthetic-accept-password-4";
    seenPasswords.push(password);
    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status).toBe(200);
    const tokenHash = sha256Hex(invited.token);

    // Flip the last character to something else in the base64url alphabet.
    const altered = invited.token.slice(0, -1) + (invited.token.endsWith("A") ? "B" : "A");
    const random = crypto.randomBytes(32).toString("base64url");
    seenTokens.push(random);

    const rejections: Array<[string, unknown]> = [
      ["missing token field", { password }],
      ["empty token", { token: "", password }],
      ["non-string token", { token: 12345, password }],
      ["altered token", { token: altered, password }],
      ["unrelated random token", { token: random, password }],
      ["stored hash presented as the token", { token: tokenHash, password }],
    ];
    for (const [label, body] of rejections) {
      const r = await req("POST", ACCEPT, { body });
      expect(r.status, `${label} must be rejected`).toBe(400);
      // Generic body — never an oracle for which check failed.
      expect(r.body).toEqual({ error: "invalid invitation" });
    }

    // None of that touched the invitation.
    const still = await admin.query<{ status: string; consumed_at: string | null }>(
      "SELECT status, consumed_at FROM partner_invitations WHERE id=$1",
      [invited.invitationId]
    );
    expect(["PENDING", "SENT"]).toContain(still.rows[0].status);
    expect(still.rows[0].consumed_at).toBeNull();

    // The genuine token still succeeds — exactly once.
    expect((await req("POST", ACCEPT, { body: { token: invited.token, password } })).status).toBe(200);
    expect((await req("POST", ACCEPT, { body: { token: invited.token, password } })).status).toBe(400);
  });

  it("token security: an expired invitation is rejected, marked EXPIRED, and never activates the user", async () => {
    const email = "psp-token-expired@example.test";
    const password = "synthetic-accept-password-5";
    seenPasswords.push(password);
    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status).toBe(200);
    // Age the invitation on the disposable database (BYPASSRLS admin connection).
    await admin.query("UPDATE partner_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1", [
      invited.invitationId,
    ]);

    expect((await req("POST", ACCEPT, { body: { token: invited.token, password } })).status).toBe(400);

    const row = await admin.query<{ status: string; consumed_at: string | null }>(
      "SELECT status, consumed_at FROM partner_invitations WHERE id=$1",
      [invited.invitationId]
    );
    expect(row.rows[0].status).toBe("EXPIRED");
    expect(row.rows[0].consumed_at).toBeNull();
    const user = await admin.query<{ status: string; password_hash: string | null }>(
      "SELECT status, password_hash FROM partner_users WHERE id=$1",
      [invited.userId]
    );
    expect(user.rows[0].status).toBe("INVITED");
    expect(user.rows[0].password_hash).toBeNull();
  });

  // =========================================================================
  // 4. ACCEPTANCE CORRECTNESS — stated against what the code ACTUALLY does.
  // =========================================================================
  it("acceptance correctness: the INVITED row is activated in its own tenant, and NO session is issued", async () => {
    const email = "psp-acceptance@example.test";
    const password = "synthetic-accept-password-6";
    seenPasswords.push(password);

    const usersBefore = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_users");
    const invited = await superAdminInvite(TENANT_A, email, "GRADER");
    expect(invited.status).toBe(200);
    const usersAfterInvite = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_users");
    // The user row is created by the INVITE, not by acceptance.
    expect(usersAfterInvite.rows[0].n).toBe(usersBefore.rows[0].n + 1);

    const preAccept = await admin.query<{ status: string; credential_version: number }>(
      "SELECT status, credential_version FROM partner_users WHERE id=$1",
      [invited.userId]
    );
    expect(preAccept.rows[0].status).toBe("INVITED");

    const accepted = await req("POST", ACCEPT, { body: { token: invited.token, password } });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ ok: true });

    // NO SESSION. server/partner/public-routes.ts's accept handler returns `{ok:true}` and never
    // calls setPartnerCookie — asserted here as behaviour, not assumed.
    expect(accepted.setCookie).toBeNull();
    const sessions = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_sessions WHERE user_id=$1", [
      invited.userId,
    ]);
    expect(sessions.rows[0].n).toBe(0);

    // Acceptance creates NO new user row — it activates the invited one.
    const usersAfterAccept = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_users");
    expect(usersAfterAccept.rows[0].n).toBe(usersAfterInvite.rows[0].n);

    const user = await admin.query<{
      id: string;
      tenant_id: string;
      partner_id: string;
      status: string;
      password_hash: string;
      credential_version: number;
      raw: number;
    }>(
      `SELECT id, tenant_id, partner_id, status, password_hash, credential_version,
              (password_hash = $2)::int AS raw
         FROM partner_users WHERE email=$1`,
      [email, password]
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0].id).toBe(invited.userId);
    expect(user.rows[0].tenant_id).toBe(TENANT_A); // bound to the intended tenant ONLY
    expect(user.rows[0].partner_id).toBe(TENANT_A);
    expect(user.rows[0].status).toBe("ACTIVE");
    expect(user.rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(user.rows[0].raw).toBe(0);
    expect(user.rows[0].credential_version).toBe(preAccept.rows[0].credential_version + 1);

    // Role relationship: exactly one membership, in tenant A, for the invited role.
    const roles = await admin.query<{ tenant_id: string; code: string }>(
      `SELECT ur.tenant_id, r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id=ur.role_id
        WHERE ur.user_id=$1`,
      [invited.userId]
    );
    expect(roles.rows).toHaveLength(1);
    expect(roles.rows[0]).toEqual({ tenant_id: TENANT_A, code: "MVGS_ASSESSMENT_TECHNICIAN" });

    // Location relationship: acceptance grants NO location (assignment is a separate, super-admin
    // only action — see tests/partner-runtime-integration.test.ts CONCERN-1). Asserted, not assumed.
    const locs = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_user_locations WHERE user_id=$1",
      [invited.userId]
    );
    expect(locs.rows[0].n).toBe(0);

    // Zero footprint in the OTHER tenant.
    const crossTenant = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_users WHERE tenant_id=$1 AND email=$2",
      [TENANT_B, email]
    );
    expect(crossTenant.rows[0].n).toBe(0);

    const inv = await admin.query<{ status: string; consumed_at: string | null; superseded_by: string | null }>(
      "SELECT status, consumed_at, superseded_by FROM partner_invitations WHERE id=$1",
      [invited.invitationId]
    );
    expect(inv.rows[0].status).toBe("CONSUMED");
    expect(inv.rows[0].consumed_at).not.toBeNull();
    expect(inv.rows[0].superseded_by).toBeNull();
  });

  // =========================================================================
  // 5. VALIDATION REJECTION
  // =========================================================================
  it("validation rejection: a rejected acceptance leaves the database unchanged and the invitation still usable", async () => {
    const email = "psp-atomicity@example.test";
    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status).toBe(200);

    const snapshot = async () => {
      const user = await admin.query(
        "SELECT status, password_hash, credential_version, updated_at FROM partner_users WHERE id=$1",
        [invited.userId]
      );
      const inv = await admin.query(
        "SELECT status, consumed_at, revoked_at, updated_at FROM partner_invitations WHERE id=$1",
        [invited.invitationId]
      );
      const counts = await admin.query(
        `SELECT (SELECT count(*) FROM partner_users) AS users,
                (SELECT count(*) FROM partner_user_roles) AS roles,
                (SELECT count(*) FROM partner_sessions) AS sessions,
                (SELECT count(*) FROM partner_invitations) AS invitations,
                (SELECT count(*) FROM partner_management_audit) AS mgmt_audit`
      );
      return JSON.stringify({ user: user.rows, inv: inv.rows, counts: counts.rows });
    };

    const before = await snapshot();
    // Controlled validation failure: passwords outside [MIN_PASSWORD_LEN, MAX_PASSWORD_LEN] are
    // refused before the accept transaction opens. Mid-transaction invitation rollback is covered by
    // tests/partner-management-integration.test.ts using the shared service transaction helper.
    const tooShort = "9-chars-".slice(0, 9);
    const tooLong = "x".repeat(201);
    seenPasswords.push(tooShort, tooLong);
    for (const [label, password] of [
      ["password below the minimum length", tooShort],
      ["password above the maximum length", tooLong],
    ] as const) {
      const r = await req("POST", ACCEPT, { body: { token: invited.token, password } });
      expect(r.status, `${label} must be rejected`).toBe(400);
      expect(await snapshot(), `${label} must leave the database unchanged`).toBe(before);
    }

    // No partially-created user, no CONSUMED invitation without a user, no duplicate membership.
    const state = await admin.query<{ status: string; inv_status: string; memberships: number }>(
      `SELECT u.status,
              (SELECT i.status FROM partner_invitations i WHERE i.id=$2) AS inv_status,
              (SELECT count(*)::int FROM partner_user_roles ur WHERE ur.user_id=u.id) AS memberships
         FROM partner_users u WHERE u.id=$1`,
      [invited.userId, invited.invitationId]
    );
    expect(state.rows[0].status).toBe("INVITED");
    expect(["PENDING", "SENT"]).toContain(state.rows[0].inv_status);
    expect(state.rows[0].memberships).toBe(1);

    // The invitation was NOT burned by the failures.
    const password = "synthetic-accept-password-7";
    seenPasswords.push(password);
    expect((await req("POST", ACCEPT, { body: { token: invited.token, password } })).status).toBe(200);
    const after = await admin.query<{ status: string; inv_status: string; memberships: number }>(
      `SELECT u.status,
              (SELECT i.status FROM partner_invitations i WHERE i.id=$2) AS inv_status,
              (SELECT count(*)::int FROM partner_user_roles ur WHERE ur.user_id=u.id) AS memberships
         FROM partner_users u WHERE u.id=$1`,
      [invited.userId, invited.invitationId]
    );
    expect(after.rows[0]).toEqual({ status: "ACTIVE", inv_status: "CONSUMED", memberships: 1 });
  });

  // =========================================================================
  // 6. CONCURRENCY
  // =========================================================================
  it("concurrency: two simultaneous accepts of the same token yield exactly one user and one CONSUMED row", async () => {
    const email = "psp-concurrency@example.test";
    const passwordA = "synthetic-concurrent-pw-a1";
    const passwordB = "synthetic-concurrent-pw-b2";
    seenPasswords.push(passwordA, passwordB);
    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status).toBe(200);
    const beforeVersion = (
      await admin.query<{ credential_version: number }>("SELECT credential_version FROM partner_users WHERE id=$1", [
        invited.userId,
      ])
    ).rows[0].credential_version;

    const svc = await import("../server/partner/partner-management-service");
    svc.__setAcceptPartnerBarrierForTest({ point: "before_invitation_lock", parties: 2 });
    let r1: Awaited<ReturnType<typeof req>>;
    let r2: Awaited<ReturnType<typeof req>>;
    try {
      [r1, r2] = await Promise.all([
        req("POST", ACCEPT, { body: { token: invited.token, password: passwordA } }),
        req("POST", ACCEPT, { body: { token: invited.token, password: passwordB } }),
      ]);
    } finally {
      svc.__setAcceptPartnerBarrierForTest(null);
    }
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
    expect([r1.status, r2.status].filter((s) => s === 400)).toHaveLength(1);

    const users = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_users WHERE email=$1", [email]);
    expect(users.rows[0].n).toBe(1);
    const active = await admin.query<{ status: string; credential_version: number }>(
      "SELECT status, credential_version FROM partner_users WHERE id=$1",
      [invited.userId]
    );
    expect(active.rows[0].status).toBe("ACTIVE");
    // Exactly ONE credential bump — two winners would show +2.
    expect(active.rows[0].credential_version).toBe(beforeVersion + 1);
    const consumed = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_invitations WHERE user_id=$1 AND status='CONSUMED'",
      [invited.userId]
    );
    expect(consumed.rows[0].n).toBe(1);
    const memberships = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_user_roles WHERE user_id=$1",
      [invited.userId]
    );
    expect(memberships.rows[0].n).toBe(1);
  });

  // =========================================================================
  // 7. TENANT ISOLATION
  //
  // CONNECTION MAP for this block:
  //   • every /api/partner/* request is served by the partner runtime pool, i.e. the
  //     NOBYPASSRLS `psp_onb_runtime` role (PARTNER_DATABASE_URL) — proved by the control test
  //     above and by the context-less RLS assertion inside the first test here;
  //   • every /api/super-admin/* request is served by the BYPASSRLS `psp_onb_admin` role
  //     (PARTNER_ADMIN_DATABASE_URL);
  //   • every verification SELECT written with `admin.query(...)` in this file uses the superuser
  //     bootstrap client, deliberately, so it can see rows in BOTH tenants and cannot mistake an
  //     RLS-hidden row for an absent one.
  // =========================================================================
  it("tenant isolation: tenant A cannot see or resend tenant B's invitation over the runtime role", async () => {
    const bInvite = await superAdminInvite(TENANT_B, "psp-b-isolation@example.test", "STAFF");
    expect(bInvite.status).toBe(200);
    const beforeHash = (
      await admin.query<{ token_hash: string; status: string }>(
        "SELECT token_hash, status FROM partner_invitations WHERE id=$1",
        [bInvite.invitationId]
      )
    ).rows[0];

    // --- runtime role (NOBYPASSRLS), via A's authenticated partner session ---
    const cookieA = await partnerLoginCookie(OWNER_A_EMAIL);
    const list = await req("GET", "/api/partner/users", { cookie: cookieA });
    expect(list.status).toBe(200);
    const listed = list.body.users as Array<{ email: string }>;
    expect(listed.every((u) => u.email.endsWith("@example.test"))).toBe(true);
    expect(listed.some((u) => u.email === "psp-b-isolation@example.test")).toBe(false);
    expect(listed.some((u) => u.email === OWNER_B_EMAIL)).toBe(false);

    // Cross-tenant mutation attempts on B's invited user fail closed.
    for (const path of [
      `/api/partner/users/${bInvite.userId}/resend-invitation`,
      `/api/partner/users/${bInvite.userId}/revoke-invitation`,
    ]) {
      const r = await req("POST", path, { body: { reason: "cross-tenant probe" }, cookie: cookieA });
      expect(r.status, `${path} must not reach tenant B`).toBe(404);
    }

    // B's invitation is untouched: same hash, same status, no extra invitation row minted.
    const afterHash = (
      await admin.query<{ token_hash: string; status: string }>(
        "SELECT token_hash, status FROM partner_invitations WHERE id=$1",
        [bInvite.invitationId]
      )
    ).rows[0];
    expect(afterHash).toEqual(beforeHash);
    const bInvitations = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_invitations WHERE user_id=$1",
      [bInvite.userId]
    );
    expect(bInvitations.rows[0].n).toBe(1);

    // The runtime pool really is RLS-bound: a CONTEXT-LESS query on it serves nothing, while the
    // superuser verification client above sees every row.
    const { partnerRuntimeQuery } = await import("../server/partner/db");
    const contextless = await partnerRuntimeQuery<{ n: number }>("SELECT count(*)::int n FROM partner_invitations");
    expect(contextless.rows[0].n).toBe(0);
    const everything = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_invitations");
    expect(everything.rows[0].n).toBeGreaterThan(0);
  });

  it("tenant isolation: guessing tenant B's identifiers never accepts B's invitation", async () => {
    const bEmail = "psp-b-guess@example.test";
    const password = "synthetic-guess-password-1";
    seenPasswords.push(password);
    const bInvite = await superAdminInvite(TENANT_B, bEmail, "STAFF");
    expect(bInvite.status).toBe(200);
    const tokenHash = sha256Hex(bInvite.token);

    for (const [label, guess] of [
      ["B's user id", bInvite.userId],
      ["B's invitation id", bInvite.invitationId],
      ["B's stored token hash", tokenHash],
      ["B's tenant id", TENANT_B],
      ["B's invited email", bEmail],
      ["B's organisation public_ref", "pspBravo"],
    ] as const) {
      const r = await req("POST", ACCEPT, { body: { token: guess, password } });
      expect(r.status, `${label} must not be accepted as a token`).toBe(400);
    }

    const inv = await admin.query<{ status: string; consumed_at: string | null }>(
      "SELECT status, consumed_at FROM partner_invitations WHERE id=$1",
      [bInvite.invitationId]
    );
    expect(["PENDING", "SENT"]).toContain(inv.rows[0].status);
    expect(inv.rows[0].consumed_at).toBeNull();
    const user = await admin.query<{ status: string }>("SELECT status FROM partner_users WHERE id=$1", [
      bInvite.userId,
    ]);
    expect(user.rows[0].status).toBe("INVITED");
  });

  it("tenant isolation: accepting B's token while carrying A's session binds only to tenant B", async () => {
    const bEmail = "psp-b-crossbind@example.test";
    const password = "synthetic-crossbind-password-1";
    seenPasswords.push(password);
    const bInvite = await superAdminInvite(TENANT_B, bEmail, "STAFF");
    expect(bInvite.status).toBe(200);

    const aBefore = await admin.query<{ fingerprint: string }>(
      `SELECT COALESCE(string_agg(id || ':' || status, ',' ORDER BY id), '') AS fingerprint
         FROM partner_users WHERE tenant_id=$1`,
      [TENANT_A]
    );

    // The accept route is PUBLIC and token-authoritative. A tenant-A session cookie must not give
    // the request any tenant-A effect, and must not prevent the token binding to tenant B.
    const cookieA = await partnerLoginCookie(OWNER_A_EMAIL);
    const accepted = await req("POST", ACCEPT, { body: { token: bInvite.token, password }, cookie: cookieA });
    expect(accepted.status).toBe(200);
    expect(accepted.setCookie).toBeNull();

    const bound = await admin.query<{ tenant_id: string; partner_id: string; status: string }>(
      "SELECT tenant_id, partner_id, status FROM partner_users WHERE id=$1",
      [bInvite.userId]
    );
    expect(bound.rows[0]).toEqual({ tenant_id: TENANT_B, partner_id: TENANT_B, status: "ACTIVE" });
    const aAfter = await admin.query<{ fingerprint: string }>(
      `SELECT COALESCE(string_agg(id || ':' || status, ',' ORDER BY id), '') AS fingerprint
         FROM partner_users WHERE tenant_id=$1`,
      [TENANT_A]
    );
    expect(aAfter.rows[0].fingerprint).toBe(aBefore.rows[0].fingerprint);
    const aRows = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_users WHERE tenant_id=$1 AND email=$2",
      [TENANT_A, bEmail]
    );
    expect(aRows.rows[0].n).toBe(0);
  });

  // =========================================================================
  // 8. FLAG GATE
  // =========================================================================
  it("flag gate: partner_onboarding_enabled OFF closes the accept route, and portal ON alone does not open it", async () => {
    const email = "psp-flag-gate@example.test";
    const password = "synthetic-flag-password-1";
    seenPasswords.push(password);
    const invited = await superAdminInvite(TENANT_A, email, "STAFF");
    expect(invited.status).toBe(200);

    try {
      // (i) portal ON, login ON, onboarding OFF → the designed closed shape for this route is 503
      //     with the route's own message; the surrounding mount gates are open, so a 503 here can
      //     only be the onboarding gate.
      await setGlobalFlag("partner_onboarding_enabled", false);
      const gated = await req("POST", ACCEPT, { body: { token: invited.token, password } });
      expect(gated.status).toBe(503);
      expect(gated.body).toEqual({ error: "partner onboarding unavailable" });
      // Login still works, proving the portal itself is open and only onboarding is shut.
      expect(
        (await req("POST", "/api/partner/auth/login", { body: { email: OWNER_A_EMAIL, password: OWNER_PASSWORD } }))
          .status
      ).toBe(200);

      // (ii) partner_portal_enabled ALONE must not open onboarding.
      await admin.query("DELETE FROM partner_feature_flags");
      await setGlobalFlag("partner_portal_enabled", true);
      const portalOnly = await req("POST", ACCEPT, { body: { token: invited.token, password } });
      expect(portalOnly.status).toBe(503);
      expect(portalOnly.body).toEqual({ error: "partner onboarding unavailable" });

      // Nothing was consumed while the gate was shut.
      const inv = await admin.query<{ status: string; consumed_at: string | null }>(
        "SELECT status, consumed_at FROM partner_invitations WHERE id=$1",
        [invited.invitationId]
      );
      expect(["PENDING", "SENT"]).toContain(inv.rows[0].status);
      expect(inv.rows[0].consumed_at).toBeNull();
      expect(
        (await admin.query<{ status: string }>("SELECT status FROM partner_users WHERE id=$1", [invited.userId]))
          .rows[0].status
      ).toBe("INVITED");
    } finally {
      await enableLiveFlags();
    }

    // With the gate reopened the very same token works — the gate refused, it did not corrupt.
    expect((await req("POST", ACCEPT, { body: { token: invited.token, password } })).status).toBe(200);
  });

  // =========================================================================
  // 9. LOG REDACTION — asserted LAST so it covers everything above.
  // =========================================================================
  it("log redaction: no raw token, password, database URL or session secret was ever logged", () => {
    expect(seenTokens.length).toBeGreaterThan(5);
    expect(consoleLines).toContain("psp-log-capture-positive-control");
    const blob = consoleLines.join("\n");

    for (const token of seenTokens) {
      expect(blob.includes(token), "a raw invitation token was written to the console").toBe(false);
    }
    for (const password of seenPasswords) {
      expect(blob.includes(password), "a password was written to the console").toBe(false);
    }
    for (const secret of [
      adminDbUrl,
      runtimeDbUrl,
      process.env.PARTNER_ADMIN_DATABASE_URL ?? "",
      RUNTIME_ROLE_PASSWORD,
      ADMIN_ROLE_PASSWORD,
      SESSION_SECRET,
      process.env.RESEND_API_KEY ?? "",
    ]) {
      expect(secret).not.toBe("");
      expect(blob.includes(secret), "a connection string or secret was written to the console").toBe(false);
    }
    // Belt and braces: no bcrypt hash and no `token=` query string in any log line either.
    expect(/\$2[aby]\$/.test(blob)).toBe(false);
    expect(/\/partner\/invite\?token=/.test(blob)).toBe(false);
  });
});
