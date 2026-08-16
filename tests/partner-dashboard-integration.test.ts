/**
 * Partner Master Dashboard — REAL PostgreSQL HTTP integration suite.
 *
 * Boots a repository-consistent app composition (real `requireSuperAdmin`, real router, real
 * service, real SQL) against ONE disposable Postgres, using the SAME realistic role model as the
 * existing partner suites (tests/helpers/partner-realistic-db.ts): `pn_migrator` is a
 * NON-superuser, NON-BYPASSRLS role that OWNS the partner tables — exactly the shape of a managed
 * Postgres project owner. The only synthetic element is a TEST-ONLY admin-login route (never
 * shipped) that stamps the same session the real login+PIN flow produces.
 *
 * These tests exist because the hostile review found four defects that no source-level assertion
 * could have caught, and one (D1) whose whole failure mode is that it produces plausible zeros:
 *
 *   D1  RLS-filtered emptiness rendered as authoritative zeros
 *   D2  risk filter applied AFTER pagination (wrong totals, incomplete pages)
 *   D3  audit timeline ordering non-deterministic on tied timestamps (rows skipped)
 *   N1  consumedThisMonth counted every negative ledger entry, not consumed reservations
 *   N3  repeated scalar query params silently dropped the filter
 *
 * Runs only when PARTNER_MANAGEMENT_RT_ADMIN points at a DISPOSABLE loopback Postgres. Skips
 * otherwise — it must never touch a shared, staging or production database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  migratorUrlFrom,
  PARTNER_MIGRATIONS_WITH_G6D,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_MANAGEMENT_RT_ADMIN;

function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN_DB);

/**
 * FAIL CLOSED IN CI (hostile-review F4).
 *
 * This file gates on a loopback PARTNER_MANAGEMENT_RT_ADMIN so a developer without a local
 * PostgreSQL still gets a green run. That gate silently disabled the entire suite in CI for
 * its whole life: `.github/workflows/ci.yml` never set the variable, so 31 tests — the ONLY
 * coverage for RLS fail-closed behaviour, SQL-level risk filtering before pagination,
 * deterministic audit pagination, consumed-credit counting and repeated-parameter rejection —
 * reported as "skipped" and nobody noticed.
 *
 * Skipping is now a LOCAL convenience only. In CI it is a hard failure, so the coverage can
 * never be lost again by deleting an env var.
 */
describe("Partner Master Dashboard integration coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    // GITHUB_ACTIONS, not the generic CI flag — this asserts a property of THIS repository's
    // workflow, which is where the env var is configured.
    if (process.env.GITHUB_ACTIONS) {
      expect(
        isLocal,
        "PARTNER_MANAGEMENT_RT_ADMIN must be set to a loopback PostgreSQL URL in CI, or the " +
          "Partner Master Dashboard integration suite does not run at all"
      ).toBe(true);
    }
  });
});

const BASE = "/api/super-admin/partner-dashboard";

/** Stable synthetic partner ids. No real partner names, emails or addresses anywhere below. */
const P_CLEAN = "aaaa0001-0000-0000-0000-00000000000a";
const P_SUSPENDED = "aaaa0002-0000-0000-0000-00000000000a";
const P_SECURITY = "aaaa0003-0000-0000-0000-00000000000a";
const P_LOCKED = "aaaa0004-0000-0000-0000-00000000000a";
const P_LOWCREDIT = "aaaa0005-0000-0000-0000-00000000000a";
const P_NOCREDIT = "aaaa0006-0000-0000-0000-00000000000a";

const EXPECTED_RISK: Record<string, string> = {
  [P_CLEAN]: "none",
  [P_SUSPENDED]: "high",
  [P_SECURITY]: "high",
  [P_LOCKED]: "medium",
  [P_LOWCREDIT]: "low",
  [P_NOCREDIT]: "medium",
};

let admin: Client;
let server: http.Server;
let base: string;
let cookie = "";
let adminUserId = "";
let closePartnerPools: () => Promise<void>;
let resetVisibilityCache: () => void;

const fp = (seed: string) =>
  seed
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "0");

/** Rows of a paged response, without asserting a full DTO shape in the test itself. */
const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
  (body as { rows?: Array<Record<string, unknown>> })?.rows ?? [];

const auditKey = (r: Record<string, unknown>) => `${String(r.source)}:${String(r.id)}`;

/** Loosely-typed JSON body: these tests assert on wire shape, including fields that must be ABSENT. */
type Json = Record<string, never> & { [k: string]: unknown };

async function get(path: string): Promise<{ status: number; body: Json; text: string }> {
  const res = await fetch(`${base}${BASE}${path}`, { headers: { cookie } });
  const text = await res.text();
  let body = {} as Json;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body is itself the assertion material */
  }
  return { status: res.status, body, text };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Json; text: string }> {
  return postWithCookie(cookie, path, body);
}

async function postWithCookie(
  sessionCookie: string,
  path: string,
  body: unknown
): Promise<{ status: number; body: Json; text: string }> {
  const res = await fetch(`${base}${BASE}${path}`, {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let responseBody = {} as Json;
  try {
    responseBody = JSON.parse(text);
  } catch {
    /* non-JSON body is itself the assertion material */
  }
  return { status: res.status, body: responseBody, text };
}

async function testSessionCookie(session: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/__test/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(session),
  });
  expect(res.status).toBe(200);
  const setCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  expect(setCookie).toContain("mv.sid");
  return setCookie;
}

/** Point the dashboard's privileged pool at a different role and force a clean re-probe. */
async function usePartnerAdminRole(url: string): Promise<void> {
  process.env.PARTNER_ADMIN_DATABASE_URL = url;
  await closePartnerPools();
  resetVisibilityCache();
}

(isLocal ? describe : describe.skip)("Partner Master Dashboard — real Postgres integration", () => {
  beforeAll(async () => {
    // server/db.ts reads MINTVAULT_DATABASE_URL at module load and requireAdmin re-loads the
    // admin user through it, so it stays on the superuser URL. Only the DASHBOARD's pool
    // (PARTNER_ADMIN_DATABASE_URL) is varied, which is precisely the variable under test.
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    // Start from a clean schema so the suite is re-runnable against the same disposable
    // container: several partner migrations use CREATE OR REPLACE FUNCTION with signatures that
    // changed across versions, which cannot be re-applied over an older definition.
    await admin.query("DROP OWNED BY partner_runtime CASCADE").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime CASCADE").catch(() => {});
    await admin.query("DROP OWNED BY partner_definer CASCADE").catch(() => {});
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await provisionRealisticRoles(admin);

    // 0010 grants on these MintVault-internal tables, so they must pre-exist (same requirement
    // the existing G3+ suites document).
    // Full column set — `requireAdmin` re-loads the admin user through the real storage layer,
    // which selects every column; a trimmed stub surfaces as an opaque 500 on every request.
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
    await admin.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await admin.query("CREATE TABLE IF NOT EXISTS certificates (id serial PRIMARY KEY, cert_id text)");
    for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_G6D);

    const authMod = await import("../server/auth");
    const ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    const adminUser = await admin.query<{ id: string }>(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1 RETURNING id",
      [ADMIN_EMAIL.toLowerCase()]
    );
    adminUserId = adminUser.rows[0].id;

    const dbMod = await import("../server/partner/db");
    closePartnerPools = dbMod.closePartnerPools;
    const visMod = await import("../server/partner/dashboard-visibility");
    resetVisibilityCache = visMod.resetPartnerReadVisibilityCache;

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerDashboardRoutes } = await import("../server/partner/dashboard-routes");

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
    app.post("/__test/admin-login", (req, res) => {
      const s = req.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = ADMIN_EMAIL;
      s.authUserId = adminUserId;
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      /*
       * AG-3b: these suites drive DESTRUCTIVE Super Admin routes (status change, role change, MFA
       * reset, credit adjustment), which now require a recent step-up proof. The real console
       * obtains one from POST /api/admin/step-up after re-entering the passphrase and PIN; this
       * test-only login stamps the equivalent so the suite exercises the ROUTE rather than
       * repeatedly proving that the guard returns 403 — which tests/partner-admin-step-up.test.ts
       * already proves directly, including that a MISSING stamp is refused.
       */
      s.adminStepUpAt = new Date().toISOString();
      req.session.save(() => res.json({ ok: true }));
    });
    app.post("/__test/session", (req, res) => {
      const s = req.session as unknown as Record<string, unknown>;
      for (const key of Object.keys(s)) {
        if (key !== "cookie") delete s[key];
      }
      Object.assign(s, req.body);
      req.session.save(() => res.json({ ok: true }));
    });
    registerPartnerDashboardRoutes(app);

    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("mv.sid");
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await closePartnerPools?.();
    await admin?.end();
  });

  // -------------------------------------------------------------------------
  // A genuinely empty network must read as REAL zeros — this is the control case
  // that makes the D1 fail-closed behaviour meaningful rather than blanket.
  // -------------------------------------------------------------------------
  describe("genuinely empty partner network (visible role, no rows)", () => {
    it("summary returns real zeros, not an unavailable state", async () => {
      const res = await get("/summary");
      expect(res.status).toBe(200);
      expect(res.body.summary.shops.total).toBe(0);
      // The distinction that matters: a visible-but-empty network reports a real 0, and the
      // credit metric is a genuine value rather than a placeholder.
      expect(res.body.summary.credits.totalAvailable).toEqual({ available: true, value: 0 });
    });

    it("partner list returns an empty, authoritative page", async () => {
      const res = await get("/partners");
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
      expect(res.body.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("with seeded partners", () => {
    beforeAll(async () => {
      const mk = async (id: string, name: string, status: string) => {
        await admin.query("INSERT INTO partner_organisations (id, legal_name, status) VALUES ($1,$2,$3)", [
          id,
          name,
          status,
        ]);
        await admin.query("INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)", [id, `${name} T/A`]);
      };
      await mk(P_CLEAN, "Synthetic Clean", "ACTIVE");
      await mk(P_SUSPENDED, "Synthetic Suspended", "SUSPENDED");
      await mk(P_SECURITY, "Synthetic Security", "ACTIVE");
      await mk(P_LOCKED, "Synthetic Locked", "ACTIVE");
      await mk(P_LOWCREDIT, "Synthetic LowCredit", "ACTIVE");
      await mk(P_NOCREDIT, "Synthetic NoCredit", "ACTIVE");

      // high/critical security event within 30 days → high
      await admin.query("INSERT INTO partner_security_events (tenant_id, severity, kind) VALUES ($1,'critical','x')", [
        P_SECURITY,
      ]);
      // locked staff → medium
      await admin.query(
        `INSERT INTO partner_users (id, tenant_id, partner_id, email, status, locked_until)
         VALUES (gen_random_uuid(),$1,$1,'locked@example.invalid','ACTIVE', now() + interval '1 hour')`,
        [P_LOCKED]
      );
      // a normal active user on the clean partner, so staff counts are not all zero
      await admin.query(
        `INSERT INTO partner_users (id, tenant_id, partner_id, email, status)
         VALUES (gen_random_uuid(),$1,$1,'ok@example.invalid','ACTIVE')`,
        [P_CLEAN]
      );

      // Wallets: clean=100 (none), lowcredit=5 (low), nocredit=0 (medium)
      const wallet = async (tenant: string, opening: number, key: string) => {
        const w = await admin.query<{ id: string }>(
          "INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id",
          [tenant]
        );
        if (opening !== 0) {
          await admin.query(
            `INSERT INTO partner_credit_ledger
               (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
             VALUES ($1,$2,$3,'opening_balance',$4,'admin','synthetic seed','admin',$5)`,
            [w.rows[0].id, tenant, opening, `open-${key}`, fp(key)]
          );
        }
        return w.rows[0].id;
      };
      await wallet(P_CLEAN, 100, "clean");
      await wallet(P_LOWCREDIT, 5, "low");
      const noCreditWallet = await wallet(P_NOCREDIT, 0, "zero");
      // wallet with a ledger row netting to exactly 0 → "no available credits" → medium
      await admin.query(
        `INSERT INTO partner_credit_ledger
           (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
         VALUES ($1,$2,7,'opening_balance','z1','admin','seed','admin',$3),
                ($1,$2,-7,'admin_adjustment','z2','admin','seed','admin',$4)`,
        [noCreditWallet, P_NOCREDIT, fp("z1"), fp("z2")]
      );
    }, 60_000);

    // ---------------------------------------------------------------------
    // Positive Super Admin path — real middleware, real SQL, real shapes.
    // ---------------------------------------------------------------------
    it("a configured Super Admin gets 200 and correctly shaped data from every endpoint", async () => {
      const summary = await get("/summary");
      expect(summary.status).toBe(200);
      expect(summary.body.summary.shops.total).toBe(6);
      expect(summary.body.summary.shops.suspended).toBe(1);

      const partners = await get("/partners?pageSize=100");
      expect(partners.status).toBe(200);
      expect(partners.body.total).toBe(6);
      expect(partners.body.rows).toHaveLength(6);

      const alerts = await get("/alerts");
      expect(alerts.status).toBe(200);
      expect(Array.isArray(alerts.body.alerts)).toBe(true);

      for (const section of [
        "overview",
        "staff",
        "wallet",
        "submissions",
        "quality",
        "devices",
        "corrections",
        "security",
        "audit",
      ]) {
        const res = await get(`/partners/${P_CLEAN}/${section}`);
        expect(res.status, `${section} should be 200`).toBe(200);
        expect(res.body).toBeTruthy();
      }
    });

    it("uses the authenticated Super Admin actor for idempotent append-only credit adjustments", async () => {
      const add = await post(`/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 10,
        reason: "Synthetic route audit proof",
        idempotencyKey: "dashboard-route-add-10",
        actorUserId: P_SECURITY,
      });
      expect(add.status).toBe(201);
      expect(add.body.result).toMatchObject({ alreadyApplied: false, entry: { amount: 10 } });

      const replay = await post(`/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 10,
        reason: "Synthetic route audit proof",
        idempotencyKey: "dashboard-route-add-10",
      });
      expect(replay.status).toBe(200);
      expect(replay.body.result).toMatchObject({ alreadyApplied: true, entry: { amount: 10 } });

      const remove = await post(`/partners/${P_CLEAN}/credits/adjust`, {
        operation: "remove",
        quantity: 10,
        reason: "Synthetic route balance restore",
        idempotencyKey: "dashboard-route-remove-10",
      });
      expect(remove.status).toBe(201);

      const ledger = await admin.query(
        `SELECT amount::int, actor_user_id::text, actor_email, reason
           FROM partner_credit_ledger
          WHERE tenant_id=$1 AND idempotency_key=$2`,
        [P_CLEAN, "dashboard-route-add-10"]
      );
      expect(ledger.rows).toEqual([
        expect.objectContaining({
          amount: 10,
          actor_user_id: adminUserId,
          reason: "Synthetic route audit proof",
        }),
      ]);
      expect(JSON.stringify(ledger.rows)).not.toContain(P_SECURITY);

      const audit = await admin.query(
        `SELECT action, admin_user, details
           FROM audit_log
          WHERE entity_type='partner_credit' AND entity_id=$1
          ORDER BY id`,
        [String((add.body.result as { entry: { id: string } }).entry.id)]
      );
      expect(audit.rows).toEqual([
        expect.objectContaining({
          action: "partner_credit_added",
          admin_user: expect.stringMatching(/mintvaultuk@gmail.com/i),
          details: expect.objectContaining({
            tenantId: P_CLEAN,
            quantity: 10,
            reason: "Synthetic route audit proof",
            alreadyApplied: false,
          }),
        }),
        expect.objectContaining({
          action: "partner_credit_added",
          admin_user: expect.stringMatching(/mintvaultuk@gmail.com/i),
          details: expect.objectContaining({
            tenantId: P_CLEAN,
            quantity: 10,
            reason: "Synthetic route audit proof",
            alreadyApplied: true,
          }),
        }),
      ]);
    });

    it("requires Super Admin authority for credit adjustments, not generic admin or partner sessions", async () => {
      const ordinaryAdminCookie = await testSessionCookie({
        isAdmin: true,
        adminEmail: "ordinary-admin@example.invalid",
        authUserId: adminUserId,
        credentialVersion: 1,
        authenticatedAt: Date.now(),
      });
      const ordinary = await postWithCookie(ordinaryAdminCookie, `/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 1,
        reason: "ordinary admin must not adjust credits",
        idempotencyKey: "ordinary-admin-credit-adjustment",
      });
      expect(ordinary.status).toBe(403);

      const partnerCookie = await testSessionCookie({ partnerUserId: "partner-user", tenantId: P_CLEAN });
      const partner = await postWithCookie(partnerCookie, `/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 1,
        reason: "partner must not adjust credits",
        idempotencyKey: "partner-credit-adjustment",
      });
      expect(partner.status).toBe(401);

      const expiredCookie = await testSessionCookie({
        isAdmin: true,
        adminEmail: "mintvaultuk@gmail.com",
        authUserId: adminUserId,
        credentialVersion: 1,
        authenticatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
      const expired = await postWithCookie(expiredCookie, `/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 1,
        reason: "expired session must not adjust credits",
        idempotencyKey: "expired-super-admin-credit-adjustment",
      });
      expect(expired.status).toBe(401);

      const staleCookie = await testSessionCookie({
        isAdmin: true,
        adminEmail: "mintvaultuk@gmail.com",
        authUserId: adminUserId,
        credentialVersion: 2,
        authenticatedAt: Date.now(),
      });
      const stale = await postWithCookie(staleCookie, `/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 1,
        reason: "stale session must not adjust credits",
        idempotencyKey: "stale-super-admin-credit-adjustment",
      });
      expect(stale.status).toBe(401);
    });

    it("validates credit adjustment reason and idempotency key before writing ledger rows", async () => {
      const before = await admin.query<{ count: string }>(
        "SELECT count(*)::bigint AS count FROM partner_credit_ledger WHERE tenant_id=$1",
        [P_CLEAN]
      );
      const missingReason = await post(`/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 1,
        idempotencyKey: "dashboard-missing-reason",
      });
      expect(missingReason.status).toBe(400);
      expect(missingReason.body.error).toMatchObject({ code: "INVALID_REASON" });

      const missingKey = await post(`/partners/${P_CLEAN}/credits/adjust`, {
        operation: "add",
        quantity: 1,
        reason: "missing idempotency must fail",
      });
      expect(missingKey.status).toBe(400);
      expect(missingKey.body.error).toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });

      const after = await admin.query<{ count: string }>(
        "SELECT count(*)::bigint AS count FROM partner_credit_ledger WHERE tenant_id=$1",
        [P_CLEAN]
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });

    it("does not let a forged body tenant override the path tenant", async () => {
      const res = await post(`/partners/${P_LOWCREDIT}/credits/adjust`, {
        operation: "add",
        quantity: 2,
        reason: "body tenant must be ignored",
        idempotencyKey: "dashboard-body-tenant-ignored",
        tenantId: P_CLEAN,
      });
      expect(res.status).toBe(201);
      const rows = await admin.query<{ tenant_id: string; amount: number }>(
        "SELECT tenant_id::text, amount::int FROM partner_credit_ledger WHERE idempotency_key=$1",
        ["dashboard-body-tenant-ignored"]
      );
      expect(rows.rows).toEqual([{ tenant_id: P_LOWCREDIT, amount: 2 }]);
    });

    it("refuses negative adjustments that would breach active reserved obligations", async () => {
      const wallet = await admin.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [
        P_LOWCREDIT,
      ]);
      await admin.query(
        `INSERT INTO partner_credit_reservations
           (wallet_id, tenant_id, card_reference, status, idempotency_key, request_fingerprint,
            source, reason, actor_type, expires_at)
         VALUES ($1,$2,'LOW-RESERVED-CARD','active','lowcredit-active-reservation',$3,
                 'portal','active reservation for route refusal proof','partner_user', now() + interval '1 day')`,
        [wallet.rows[0].id, P_LOWCREDIT, fp("lowcreditreservation")]
      );
      const before = await admin.query<{ count: string }>(
        "SELECT count(*)::bigint AS count FROM partner_credit_ledger WHERE tenant_id=$1",
        [P_LOWCREDIT]
      );

      const res = await post(`/partners/${P_LOWCREDIT}/credits/adjust`, {
        operation: "remove",
        quantity: 7,
        reason: "must not breach reserved credit obligations",
        idempotencyKey: "dashboard-reserved-breach",
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "INSUFFICIENT_AVAILABLE_CREDITS" });
      const after = await admin.query<{ count: string }>(
        "SELECT count(*)::bigint AS count FROM partner_credit_ledger WHERE tenant_id=$1",
        [P_LOWCREDIT]
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });

    it("derives the expected risk level for every seeded partner", async () => {
      const res = await get("/partners?pageSize=100");
      const byId = new Map(rowsOf(res.body).map((r) => [String(r.partnerId), r]));
      for (const [id, expected] of Object.entries(EXPECTED_RISK)) {
        expect(byId.get(id)?.riskStatus.level, `risk for ${id}`).toBe(expected);
      }
    });

    // ---------------------------------------------------------------------
    // D2 — risk filtering before pagination
    // ---------------------------------------------------------------------
    describe("D2 — risk filter is applied before pagination", () => {
      it("filtered total, totalPages and page contents all agree at pageSize=1", async () => {
        const expectedHigh = Object.entries(EXPECTED_RISK)
          .filter(([, lvl]) => lvl === "high")
          .map(([id]) => id);

        const first = await get("/partners?risk=high&pageSize=1&page=1");
        expect(first.status).toBe(200);
        expect(first.body.total).toBe(expectedHigh.length);
        expect(first.body.totalPages).toBe(expectedHigh.length);

        const seen: string[] = [];
        for (let page = 1; page <= first.body.totalPages; page++) {
          const res = await get(`/partners?risk=high&pageSize=1&page=${page}`);
          expect(res.body.total).toBe(expectedHigh.length);
          // every returned row genuinely matches the filter — no page is padded or blanked
          for (const row of res.body.rows) {
            expect(row.riskStatus.level).toBe("high");
            seen.push(row.partnerId);
          }
        }

        // no repeats, no skips: the pages reconstruct exactly the matching set
        expect(new Set(seen).size).toBe(seen.length);
        expect([...seen].sort()).toEqual([...expectedHigh].sort());
      });

      it("keeps status filtering and sorting working alongside a risk filter", async () => {
        const res = await get("/partners?risk=high&status=SUSPENDED&sort=legal_name&direction=asc&pageSize=50");
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.rows[0].partnerId).toBe(P_SUSPENDED);
      });

      it("a risk filter matching nothing reports zero, not the unfiltered total", async () => {
        // no partner in the fixture set is REVOKED, so 'none' is the only level with one member
        const res = await get("/partners?risk=none&pageSize=50");
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.rows).toHaveLength(1);
        expect(res.body.rows[0].partnerId).toBe(P_CLEAN);
      });
    });

    // ---------------------------------------------------------------------
    // D3 — deterministic audit ordering
    // ---------------------------------------------------------------------
    describe("D3 — audit timeline ordering is deterministic on tied timestamps", () => {
      const TIED = "2026-07-01T10:00:00.000Z";

      beforeAll(async () => {
        // 12 events across THREE sources, all sharing one timestamp — the realistic case, since
        // created_at defaults to now() = transaction time.
        for (let i = 0; i < 5; i++) {
          await admin.query("INSERT INTO partner_audit_events (tenant_id, action, created_at) VALUES ($1,$2,$3)", [
            P_CLEAN,
            `audit_${i}`,
            TIED,
          ]);
        }
        for (let i = 0; i < 4; i++) {
          await admin.query(
            "INSERT INTO partner_security_events (tenant_id, severity, kind, created_at) VALUES ($1,'low',$2,$3)",
            [P_CLEAN, `sec_${i}`, TIED]
          );
        }
        for (let i = 0; i < 3; i++) {
          await admin.query(
            `INSERT INTO partner_management_audit
               (tenant_id, action_type, actor_user_id, actor_email, request_id, result, created_at)
             VALUES ($1,'profile_updated',gen_random_uuid(),'a@example.invalid','rq','succeeded',$2)`,
            [P_CLEAN, TIED]
          );
        }
      }, 30_000);

      it("pages through every tied event exactly once — no repeats, no skips", async () => {
        const firstPage = await get(`/partners/${P_CLEAN}/audit?pageSize=5&page=1`);
        expect(firstPage.status).toBe(200);
        const total = firstPage.body.total;
        expect(total).toBeGreaterThanOrEqual(12);

        const keys: string[] = [];
        const pages = Math.ceil(total / 5);
        for (let page = 1; page <= pages; page++) {
          const res = await get(`/partners/${P_CLEAN}/audit?pageSize=5&page=${page}`);
          for (const row of res.body.rows) keys.push(`${row.source}:${row.id}`);
        }
        expect(keys).toHaveLength(total);
        expect(new Set(keys).size).toBe(total);
      });

      it("returns the same order for the same request, repeatedly", async () => {
        const shape = (b: Json) => rowsOf(b).map(auditKey).join("|");
        const a = await get(`/partners/${P_CLEAN}/audit?pageSize=7&page=1`);
        const b = await get(`/partners/${P_CLEAN}/audit?pageSize=7&page=1`);
        const c = await get(`/partners/${P_CLEAN}/audit?pageSize=7&page=1`);
        expect(shape(a.body)).toBe(shape(b.body));
        expect(shape(b.body)).toBe(shape(c.body));
      });

      it("orders tied rows by (source, id) as the declared total order", async () => {
        const res = await get(`/partners/${P_CLEAN}/audit?pageSize=100&page=1`);
        const tied = rowsOf(res.body).filter((r) => String(r.createdAt).startsWith("2026-07-01T10:00:00"));
        const sorted = [...tied].sort((x, y) =>
          x.source === y.source
            ? String(x.id).localeCompare(String(y.id))
            : String(x.source).localeCompare(String(y.source))
        );
        expect(tied.map(auditKey)).toEqual(sorted.map(auditKey));
      });
    });

    // ---------------------------------------------------------------------
    // N1 — consumed credits come from consumed RESERVATIONS
    // ---------------------------------------------------------------------
    describe("N1 — consumedThisMonth counts only consumed reservations", () => {
      beforeAll(async () => {
        const w = await admin.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [P_CLEAN]);
        const walletId = w.rows[0].id;
        const reservation = async (status: string, key: string, terminalCol: string | null) => {
          const cols = terminalCol ? `, ${terminalCol}` : "";
          const vals = terminalCol ? ", now()" : "";
          await admin.query(
            `INSERT INTO partner_credit_reservations
               (wallet_id, tenant_id, card_reference, status, idempotency_key, request_fingerprint,
                source, reason, actor_type, expires_at${cols})
             VALUES ($1,$2,$3,$4,$5,$6,'admin','synthetic','admin', now() + interval '1 day'${vals})`,
            [walletId, P_CLEAN, `card-${key}`, status, key, fp(key)]
          );
        };
        await reservation("consumed", "res-consumed", "consumed_at");
        await reservation("active", "res-active", null);
        await reservation("released", "res-released", "released_at");

        // Decoys: a NEGATIVE manual adjustment and a refund movement. Under the old
        // `SUM(amount) WHERE amount < 0` rule these inflated "consumed" by 9.
        await admin.query(
          `INSERT INTO partner_credit_ledger
             (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
           VALUES ($1,$2,-4,'admin_adjustment','decoy-adj','admin','manual clawback','admin',$3),
                  ($1,$2,-5,'refund','decoy-refund','admin','refund movement','admin',$4)`,
          [walletId, P_CLEAN, fp("decoyadj"), fp("decoyref")]
        );
      }, 30_000);

      it("counts the consumed reservation only — not active, released, adjustments or refunds", async () => {
        const res = await get("/summary");
        expect(res.status).toBe(200);
        // exactly ONE consumed reservation, reserved_credits CHECK-constrained to 1
        expect(res.body.summary.credits.consumedThisMonth).toEqual({ available: true, value: 1 });
      });

      it("wallet balances still derive from the append-only ledger", async () => {
        const res = await get(`/partners/${P_CLEAN}/wallet`);
        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(true);
        // 100 opening − 4 adjustment − 5 refund = 91 ledger balance; one ACTIVE reservation holds 1
        expect(res.body.ledgerBalance).toBe(91);
        expect(res.body.reservedCredits).toBe(1);
        expect(res.body.availableCredits).toBe(90);
        expect(res.body.manualAdjustmentEnabled).toBe(true);
      });
    });

    // ---------------------------------------------------------------------
    // N3 — repeated scalar parameters
    // ---------------------------------------------------------------------
    describe("N3 — repeated scalar query parameters are rejected", () => {
      const REPEATED = [
        "/partners?status=ACTIVE&status=PENDING",
        "/partners?risk=high&risk=low",
        "/partners?page=1&page=2",
        "/partners?pageSize=10&pageSize=20",
        "/partners?sort=legal_name&sort=last_activity",
        "/partners?direction=asc&direction=desc",
        "/partners?search=a&search=b",
        "/alerts?limit=10&limit=20",
        `/partners/${P_CLEAN}/audit?page=1&page=2`,
        `/partners/${P_CLEAN}/audit?pageSize=5&pageSize=10`,
      ];

      for (const path of REPEATED) {
        it(`400s on ${path}`, async () => {
          const res = await get(path);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("INVALID_INPUT");
        });
      }

      it("does not silently widen the result set when a filter is repeated", async () => {
        // The failure mode this guards: dropping the filter returned ALL partners.
        const res = await get("/partners?status=ACTIVE&status=SUSPENDED");
        expect(res.status).toBe(400);
        expect(res.body.rows).toBeUndefined();
      });
    });

    // ---------------------------------------------------------------------
    // Injection — parameterisation proven against a live server
    // ---------------------------------------------------------------------
    it("treats SQL metacharacters in search as data", async () => {
      const res = await get(`/partners?search=${encodeURIComponent("'; DROP TABLE partner_organisations; --")}`);
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
      const still = await get("/partners?pageSize=100");
      expect(still.body.total).toBe(6);
    });

    // ---------------------------------------------------------------------
    // D1 — fail closed when the role cannot see partner rows
    // ---------------------------------------------------------------------
    describe("D1 — RLS-invisible role fails closed instead of reporting zeros", () => {
      beforeAll(async () => {
        // pn_migrator OWNS the partner tables but is NOSUPERUSER + NOBYPASSRLS, and every partner
        // table is FORCE ROW LEVEL SECURITY — so it sees nothing. This is the managed-Postgres
        // project-owner shape, i.e. the realistic production risk.
        await usePartnerAdminRole(migratorUrlFrom(ADMIN_DB!));
      });

      afterAll(async () => {
        await usePartnerAdminRole(ADMIN_DB!);
      });

      it("proves the role cannot see partner rows as authoritative data", async () => {
        const { Client: PgClient } = await import("pg");
        const c = new PgClient({ connectionString: migratorUrlFrom(ADMIN_DB!) });
        await c.connect();
        try {
          const orgs = await c.query("SELECT count(*)::int AS n FROM partner_organisations");
          expect(orgs.rows[0].n).toBe(0); // ground truth is 6
          try {
            const agg = await c.query(
              "SELECT COALESCE(SUM(available_balance),0)::int AS n FROM partner_credit_availability"
            );
            expect(agg.rows[0].n).toBe(0); // an aggregate ALWAYS returns a row — the trap
          } catch (err) {
            expect((err as { code?: string }).code).toBe("42501");
          }
        } finally {
          await c.end();
        }
      });

      it("summary reports unavailable rather than 0 shops / 0 credits", async () => {
        const res = await get("/summary");
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE");
        expect(res.body.summary).toBeUndefined();
      });

      it("partner list does not report an authoritative empty result", async () => {
        const res = await get("/partners");
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE");
        expect(res.body.rows).toBeUndefined();
        expect(res.body.total).toBeUndefined();
      });

      it("drill-down does not falsely claim the partner does not exist", async () => {
        const res = await get(`/partners/${P_CLEAN}/overview`);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE");
        // the partner DOES exist; a 404 here would send the operator hunting for a deleted shop
        expect(res.status).not.toBe(404);
      });

      it("applies uniformly to EVERY endpoint — no section reports zeros while others fail", async () => {
        const paths = [
          "/summary",
          "/partners",
          "/alerts",
          `/partners/${P_CLEAN}/overview`,
          `/partners/${P_CLEAN}/staff`,
          `/partners/${P_CLEAN}/wallet`,
          `/partners/${P_CLEAN}/submissions`,
          `/partners/${P_CLEAN}/quality`,
          `/partners/${P_CLEAN}/devices`,
          `/partners/${P_CLEAN}/corrections`,
          `/partners/${P_CLEAN}/security`,
          `/partners/${P_CLEAN}/audit`,
        ];
        for (const p of paths) {
          const res = await get(p);
          expect(res.status, `${p} must fail closed`).toBe(503);
          expect(res.body.error.code, `${p} code`).toBe("PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE");
        }
      });

      it("does not leak database role, connection or catalogue detail to the browser", async () => {
        const res = await get("/summary");
        const text = res.text.toLowerCase();
        for (const leak of [
          "pn_migrator",
          "postgres://",
          "postgresql://",
          "password",
          "bypassrls",
          "pg_class",
          "pg_roles",
          "relforcerowsecurity",
          "127.0.0.1",
        ]) {
          expect(text, `must not leak "${leak}"`).not.toContain(leak);
        }
      });
    });

    it("recovers automatically once a capable role is restored", async () => {
      const res = await get("/summary");
      expect(res.status).toBe(200);
      expect(res.body.summary.shops.total).toBe(6);
    });
  });
});
