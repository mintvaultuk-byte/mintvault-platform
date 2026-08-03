/**
 * G5 Super-Admin partner-management — HTTP integration test.
 *
 * Boots a repository-consistent main-app composition mounting the REAL requireAdmin and the real
 * registerPartnerManagementRoutes against ONE disposable Postgres. requireAdmin runs fully; the only
 * synthetic element is a TEST-ONLY admin-login route (never shipped) that stamps the same session the
 * real login+PIN flow produces. G5 reads/writes go via the privileged admin pool.
 *
 * Runs only when PARTNER_MANAGEMENT_RT_ADMIN (superuser URL to a DISPOSABLE, SSL-capable loopback
 * Postgres — server/db.ts forces ssl) is set and loopback. Skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_MANAGEMENT_RT_ADMIN;
const ORIGINAL_RESEND_API_KEY = process.env.RESEND_API_KEY;

const emailTransport = vi.hoisted(() => ({
  invitationCalls: [] as unknown[],
}));

vi.mock("../server/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/email")>();
  return {
    ...actual,
    sendPartnerInvitationEmail: vi.fn(async (data: unknown) => {
      emailTransport.invitationCalls.push(data);
      return { id: "synthetic-resend-mock" };
    }),
  };
});

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

describe("Partner management integration coverage is wired up", () => {
  it("is not silently skipped in CI", async () => {
    if (!isLocal) {
      console.warn(
        "[partner-management-integration] skipped locally because PARTNER_MANAGEMENT_RT_ADMIN is not a loopback PostgreSQL URL"
      );
    }
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_MANAGEMENT_RT_ADMIN must be set to a disposable loopback PostgreSQL 17 URL in CI").toBe(
        true
      );
      const u = new URL(ADMIN_DB!);
      expect(u.hostname).toMatch(/^(127\.0\.0\.1|localhost|::1)$/);
    }
  });
});

const A = "aaaa1111-0000-0000-0000-0000000000c5";
const B = "bbbb2222-0000-0000-0000-0000000000d5";

let admin: Client;
let server: http.Server;
let base: string;
let ADMIN_EMAIL: string;
let capturedInvites: Array<{
  email: string;
  token: string;
  partnerName: string;
  roleCode: string;
  expiresAt: Date;
}> = [];
let setInvitationDeliveryAdapter:
  | ((a: null | ((d: (typeof capturedInvites)[number]) => Promise<void>)) => void)
  | null = null;

const PM = "/api/super-admin/partner-management";

function dbUrlAsRole(raw: string, username: string, password: string): string {
  const u = new URL(raw);
  u.username = username;
  u.password = password;
  return u.toString();
}

(isLocal ? describe : describe.skip)("G5 partner management (main app, real requireAdmin, disposable DB)", () => {
  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_DATABASE_URL = ADMIN_DB;
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";
    process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY = "true";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    const version = await admin.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
    expect(Number(version.rows[0].n), "Partner management integration requires PostgreSQL 17").toBeGreaterThanOrEqual(
      170000
    );
    /**
     * PRISTINE SCHEMA FIRST (hostile-review F4 follow-on).
     *
     * This file and tests/partner-dashboard-integration.test.ts share PARTNER_MANAGEMENT_RT_ADMIN.
     * The dashboard suite applies PARTNER_MIGRATIONS_WITH_G6B; this one applies the shorter
     * _WITH_G5 set. `DROP OWNED BY` alone does not remove functions the other suite created, so
     * whichever ran second hit `cannot change return type of existing function` while replaying
     * a migration onto the other's leftovers.
     *
     * That was latent for as long as the suites were skipped; enabling them in CI surfaced it.
     * The dashboard suite already drops and recreates `public` for exactly this reason — doing
     * the same here makes both self-contained and order-independent. The database is disposable
     * (loopback-gated above), so this is safe by construction.
     */
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
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
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    await admin.query("DROP OWNED BY partner_admin_bypass_test").catch(() => {});
    await admin.query("DROP OWNED BY partner_app_test_mgmt").catch(() => {});
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_admin_bypass_test LOGIN PASSWORD 'synthetic-admin' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_admin_bypass_test WITH LOGIN PASSWORD 'synthetic-admin' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_app_test_mgmt LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_app_test_mgmt WITH LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END$$;`
    );
    await admin.query("GRANT USAGE ON SCHEMA public TO partner_admin_bypass_test");
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partner_admin_bypass_test"
    );
    await admin.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO partner_admin_bypass_test");
    await admin.query("GRANT partner_runtime TO partner_app_test_mgmt");

    process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAsRole(ADMIN_DB!, "partner_admin_bypass_test", "synthetic-admin");
    process.env.PARTNER_DATABASE_URL = dbUrlAsRole(ADMIN_DB!, "partner_app_test_mgmt", "synthetic");
    const { resetPartnerAdminCapabilityCache } = await import("../server/partner/admin-capability");
    resetPartnerAdminCapabilityCache();

    const authMod = await import("../server/auth");
    ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [ADMIN_EMAIL.toLowerCase()]
    );

    // two orgs; a secret-looking value seeded on B's profile to prove redaction never surfaces it
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'rAc5','A CRM Ltd','PENDING'),($2,'rBd5','B CRM Ltd','ACTIVE')",
      [A, B]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES (gen_random_uuid(),'lc5',$1,$1,'Loc','ACTIVE')",
      [A]
    );
    await admin.query(
      "INSERT INTO partner_profiles (tenant_id, primary_email) VALUES ($1,'sekret-token-abcdef@b.example')",
      [B]
    );

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");
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
    app.post("/__test/admin-login", (req, res) => {
      const s = req.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = ADMIN_EMAIL;
      s.authUserId = "00000000-0000-0000-0000-0000000000a5";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      req.session.save(() => res.json({ ok: true }));
    });
    registerPartnerManagementRoutes(app);
    registerSuperAdminPartnerRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  beforeEach(async () => {
    capturedInvites = [];
    emailTransport.invitationCalls = [];
    process.env.RESEND_API_KEY = "synthetic-resend-key-never-real";
    const delivery = await import("../server/partner/delivery");
    setInvitationDeliveryAdapter = delivery.setInvitationDeliveryAdapter as typeof setInvitationDeliveryAdapter;
    setInvitationDeliveryAdapter(async (data) => {
      capturedInvites.push({ ...data });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    if (ORIGINAL_RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
  });

  afterEach(async () => {
    const svc = await import("../server/partner/partner-management-service");
    svc.__setCreatePartnerFailurePointForTest(null);
    svc.__setInvitePartnerFailurePointForTest(null);
    svc.__setInvitePartnerBarrierForTest(null);
    svc.__setAcceptPartnerBarrierForTest(null);
    setInvitationDeliveryAdapter?.(null);
    capturedInvites = [];
    emailTransport.invitationCalls = [];
    if (ORIGINAL_RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
  });

  async function cookie(): Promise<string> {
    const r = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  const g = (p: string, c = "") => fetch(`${base}${p}`, { headers: c ? { cookie: c } : {} });
  const post = (p: string, body: unknown, c = "") =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
      body: JSON.stringify(body),
    });
  const patch = (p: string, body: unknown, c = "") =>
    fetch(`${base}${p}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
      body: JSON.stringify(body),
    });
  const put = (p: string, body: unknown, c = "") =>
    fetch(`${base}${p}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
      body: JSON.stringify(body),
    });

  it("auth boundary: unauth 401; forged header 401; admin 200", async () => {
    expect((await g(`${PM}/partners`)).status).toBe(401);
    expect((await fetch(`${base}${PM}/partners`, { headers: { "x-admin": "true", "x-role": "admin" } })).status).toBe(
      401
    );
    const c = await cookie();
    expect((await g(`${PM}/partners`, c)).status).toBe(200);
  });

  it("partners list + detail: deterministic, secret-free", async () => {
    const c = await cookie();
    const list = await (await g(`${PM}/partners`, c)).json();
    expect(list.partners.length).toBe(2);
    expect(list.partners.map((p: any) => p.legal_name).sort()).toEqual(["A CRM Ltd", "B CRM Ltd"]);
    const blob = JSON.stringify(list);
    expect(blob).not.toMatch(/password|pin_hash|secret|\$2[aby]\$/i);
    const status = await (await g(`${PM}/partners?status=PENDING`, c)).json();
    expect(status.partners.length).toBe(1);
  });

  it("profile update + version conflict", async () => {
    const c = await cookie();
    const r1 = await patch(
      `${PM}/partners/${A}/profile`,
      { trading_name: "A Trading", organisation_kind: "shop", expectedVersion: 1 },
      c
    );
    expect(r1.status).toBe(200);
    // stale version rejected
    const r2 = await patch(`${PM}/partners/${A}/profile`, { trading_name: "Again", expectedVersion: 1 }, c);
    expect(r2.status).toBe(409);
    expect((await r2.json()).error.code).toBe("VERSION_CONFLICT");
    const kind = await patch(`${PM}/partners/${A}/profile`, { organisation_kind: "not_a_kind", expectedVersion: 2 }, c);
    expect(kind.status).toBe(400);
  });

  it("status transition: valid + invalid + reason required; NO side effects; audited", async () => {
    const c = await cookie();
    // reason required
    expect((await post(`${PM}/partners/${A}/status`, { status: "ACTIVE", expectedVersion: 2 }, c)).status).toBe(400);
    // invalid transition (PENDING -> SUSPENDED not allowed)
    const inv = await post(`${PM}/partners/${A}/status`, { status: "SUSPENDED", reason: "x", expectedVersion: 2 }, c);
    expect(inv.status).toBe(400);
    expect((await inv.json()).error.code).toBe("INVALID_STATUS_TRANSITION");
    // valid PENDING -> ACTIVE
    const ok = await post(
      `${PM}/partners/${A}/status`,
      { status: "ACTIVE", reason: "onboarded", expectedVersion: 2 },
      c
    );
    expect(ok.status).toBe(200);
    const org = await admin.query<{ status: string }>("SELECT status FROM partner_organisations WHERE id=$1", [A]);
    expect(org.rows[0].status).toBe("ACTIVE");
    // NO side effects: no feature flag rows, no emergency controls created for A
    expect(
      (await admin.query("SELECT count(*)::int n FROM partner_feature_flags WHERE tenant_id=$1", [A])).rows[0].n
    ).toBe(0);
    expect(
      (await admin.query("SELECT count(*)::int n FROM partner_emergency_controls WHERE tenant_id=$1", [A])).rows[0].n
    ).toBe(0);
    // audited (attempt + terminal succeeded)
    const audit = await admin.query<{ result: string }>(
      "SELECT result FROM partner_management_audit WHERE tenant_id=$1 AND action_type='status_changed' ORDER BY created_at",
      [A]
    );
    expect(audit.rows.map((x) => x.result).sort()).toEqual(["attempted", "succeeded"]);
  });

  it("contacts: add + duplicate-primary + edit + soft-deactivate", async () => {
    const c = await cookie();
    const add = await post(
      `${PM}/partners/${A}/contacts`,
      { fullName: "Prime", contactType: "general", isPrimary: true },
      c
    );
    expect(add.status).toBe(200);
    const dup = await post(
      `${PM}/partners/${A}/contacts`,
      { fullName: "Second", contactType: "billing", isPrimary: true },
      c
    );
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("DUPLICATE_PRIMARY_CONTACT");
    const contactId = (await add.json()).result.contactId;
    const edit = await patch(`${PM}/partners/${A}/contacts/${contactId}`, { title: "Owner", expectedVersion: 1 }, c);
    expect(edit.status).toBe(200);
    const deact = await post(`${PM}/partners/${A}/contacts/${contactId}/deactivate`, { reason: "left" }, c);
    expect(deact.status).toBe(200);
    const row = await admin.query<{ active: boolean; is_primary: boolean }>(
      "SELECT active, is_primary FROM partner_contacts WHERE id=$1",
      [contactId]
    );
    expect(row.rows[0].active).toBe(false);
    expect(row.rows[0].is_primary).toBe(false); // never deleted; primary cleared
  });

  it("branding upsert (metadata only)", async () => {
    const c = await cookie();
    const r = await put(
      `${PM}/partners/${A}/branding`,
      { display_name: "A Cards", primary_colour: "#D4AF37", branding_status: "ready" },
      c
    );
    expect(r.status).toBe(200);
    const b = await (await g(`${PM}/partners/${A}/branding`, c)).json();
    expect(b.branding.display_name).toBe("A Cards");
    expect(b.branding.branding_status).toBe("ready");
  });

  it("internal note append + idempotency replay; runtime cannot mutate notes/audit", async () => {
    const c = await cookie();
    const r1 = await post(
      `${PM}/partners/${A}/notes`,
      { body: "internal escalation note", idempotencyKey: "note-key-1" },
      c
    );
    expect(r1.status).toBe(200);
    const n1 = await (await g(`${PM}/partners/${A}/notes`, c)).json();
    expect(n1.notes.some((x: any) => x.body === "internal escalation note")).toBe(true);
    // replay with same key → alreadyCompleted, no second note
    const r2 = await post(
      `${PM}/partners/${A}/notes`,
      { body: "internal escalation note", idempotencyKey: "note-key-1" },
      c
    );
    expect((await r2.json()).alreadyCompleted).toBe(true);
    const succeeded = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_management_audit WHERE idempotency_key='note-key-1' AND result='succeeded'"
    );
    expect(succeeded.rows[0].n).toBe(1);
    // append-only DB enforcement against the runtime role
    await admin.query("SET ROLE partner_connector_runtime");
    try {
      await expect(admin.query("UPDATE partner_internal_notes SET body='hacked'")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(admin.query("DELETE FROM partner_management_audit")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await admin.query("RESET ROLE");
    }
  });

  it("statistics: available counts present; certificate/grade counts labeled unavailable", async () => {
    const c = await cookie();
    const s = await (await g(`${PM}/partners/${A}/statistics`, c)).json();
    expect(typeof s.locationCount).toBe("number");
    expect(s.locationCount).toBeGreaterThanOrEqual(1);
    expect(s.certificatesCount).toBeNull();
    expect(s.gradedCount).toBeNull();
    expect(s.unavailable).toEqual(expect.arrayContaining(["certificatesCount", "gradedCount"]));
  });

  it("create atomically creates exactly one ACTIVE Main location and idempotent replay does not duplicate it", async () => {
    const c = await cookie();
    const key = "create-key-1";
    const r1 = await post(`${PM}/partners`, { legalName: "Idem Cards Ltd", idempotencyKey: key }, c);
    expect(r1.status).toBe(200);
    const firstBody = await r1.json();
    const r2 = await post(`${PM}/partners`, { legalName: "Idem Cards Ltd", idempotencyKey: key }, c);
    expect(r2.status).toBe(200);
    expect((await r2.json()).alreadyCompleted).toBe(true);
    // exactly ONE org was created for this name (the org insert is now behind the idempotency pre-check)
    const n = await admin.query<{ n: number; locations: number }>(
      `SELECT count(DISTINCT o.id)::int n, count(l.id)::int locations
         FROM partner_organisations o
         LEFT JOIN partner_locations l ON l.tenant_id=o.id AND l.partner_id=o.id AND l.name='Main location' AND l.status='ACTIVE'
        WHERE o.legal_name='Idem Cards Ltd'`
    );
    expect(n.rows[0].n).toBe(1);
    expect(n.rows[0].locations).toBe(1);
    expect(firstBody.result.partnerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("create rolls back the organisation when default-location creation fails mid-transaction", async () => {
    const svc = await import("../server/partner/partner-management-service");
    svc.__setCreatePartnerFailurePointForTest("after_default_location_insert");
    await expect(
      svc.createPartner(
        {
          actorUserId: "00000000-0000-0000-0000-0000000000a5",
          actorEmail: ADMIN_EMAIL,
          requestId: "create-rollback-test",
          idempotencyKey: "create-rollback-key-1",
        },
        { legalName: "Rollback Cards Ltd" },
        "rollback proof"
      )
    ).rejects.toThrow("synthetic_create_partner_after_default_location_insert");
    svc.__setCreatePartnerFailurePointForTest(null);
    const leaked = await admin.query<{ orgs: number; locations: number }>(
      `SELECT
         (SELECT count(*)::int FROM partner_organisations WHERE legal_name='Rollback Cards Ltd') AS orgs,
         (SELECT count(*)::int FROM partner_locations WHERE name='Main location' AND tenant_id IN
           (SELECT id FROM partner_organisations WHERE legal_name='Rollback Cards Ltd')) AS locations`
    );
    expect(leaked.rows[0]).toEqual({ orgs: 0, locations: 0 });
    const retry = await svc.createPartner(
      {
        actorUserId: "00000000-0000-0000-0000-0000000000a5",
        actorEmail: ADMIN_EMAIL,
        requestId: "create-rollback-retry",
        idempotencyKey: "create-rollback-key-2",
      },
      { legalName: "Rollback Cards Ltd" },
      "retry after rollback"
    );
    expect(retry.result?.partnerId).toMatch(/^[0-9a-f-]{36}$/);
    const after = await admin.query<{ orgs: number; locations: number }>(
      `SELECT
         (SELECT count(*)::int FROM partner_organisations WHERE legal_name='Rollback Cards Ltd') AS orgs,
         (SELECT count(*)::int FROM partner_locations WHERE name='Main location' AND status='ACTIVE' AND tenant_id IN
           (SELECT id FROM partner_organisations WHERE legal_name='Rollback Cards Ltd')) AS locations`
    );
    expect(after.rows[0]).toEqual({ orgs: 1, locations: 1 });
  });

  it("Super Admin creates owner invitation; invite is single-use; accepted owner can log in", async () => {
    const c = await cookie();
    const create = await post(
      `${PM}/partners/${A}/users`,
      {
        firstName: "Founder",
        lastName: "Owner",
        email: "owner-invite@a.example",
        role: "OWNER",
        reason: "founder setup",
      },
      c
    );
    expect(create.status).toBe(200);
    const body = await create.json();
    expect(body.result.invitationLink).toMatch(/\/partner\/invite\?token=/);
    const token = new URL(body.result.invitationLink).searchParams.get("token")!;
    const rawInvite = await admin.query<{ token_hash: string }>(
      "SELECT token_hash FROM partner_invitations WHERE id=$1",
      [body.result.invitationId]
    );
    expect(rawInvite.rows[0].token_hash).not.toBe(token);
    expect(rawInvite.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

    const users = await (await g(`${PM}/partners/${A}/users`, c)).json();
    const invited = users.users.find((u: any) => u.email === "owner-invite@a.example");
    expect(invited).toMatchObject({
      first_name: "Founder",
      last_name: "Owner",
      role: "OWNER",
      status: "INVITED",
    });
    expect(JSON.stringify(users)).not.toMatch(/password_hash|\$2[aby]\$|token_hash/i);

    const { acceptPartnerInvitation } = await import("../server/partner/partner-management-service");
    expect((await acceptPartnerInvitation(token, "owner-secure-password-1")).ok).toBe(true);
    expect((await acceptPartnerInvitation(token, "owner-secure-password-2")).ok).toBe(false);

    const stored = await admin.query<{ status: string; password_hash: string; raw: number }>(
      "SELECT status, password_hash, (password_hash = 'owner-secure-password-1')::int AS raw FROM partner_users WHERE email=$1",
      ["owner-invite@a.example"]
    );
    expect(stored.rows[0].status).toBe("ACTIVE");
    expect(stored.rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(stored.rows[0].raw).toBe(0);

    const consumed = await admin.query<{ status: string; consumed_at: string | null }>(
      "SELECT status, consumed_at FROM partner_invitations WHERE token_hash IS NOT NULL AND email=$1",
      ["owner-invite@a.example"]
    );
    expect(consumed.rows[0].status).toBe("CONSUMED");
    expect(consumed.rows[0].consumed_at).not.toBeNull();

    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [A]);
    const { partnerLogin } = await import("../server/partner/auth");
    const login = await partnerLogin("owner-invite@a.example", "owner-secure-password-1", "127.0.0.1");
    expect(login.ok).toBe(true);
    expect(login.tenantId).toBe(A);
    expect((await partnerLogin("owner-invite@a.example", "wrong-password", "127.0.0.1")).ok).toBe(false);
    expect((await partnerLogin("unknown-partner@a.example", "owner-secure-password-1", "127.0.0.1")).ok).toBe(false);
    const auditBlob = JSON.stringify(
      (await admin.query("SELECT before_state, after_state FROM partner_management_audit WHERE tenant_id=$1", [A])).rows
    );
    expect(auditBlob).not.toContain(token);
    expect(auditBlob).not.toMatch(/token_hash|owner-secure-password/i);
  });

  it("invite rolls back mid-transaction failures and the same email can be retried successfully", async () => {
    const svc = await import("../server/partner/partner-management-service");
    const points = [
      "after_user_insert",
      "after_role_assignment",
      "before_invitation_insert",
      "before_invitation_audit",
    ] as const;
    for (const point of points) {
      const email = `rollback-${point.replaceAll("_", "-")}@a.example`;
      svc.__setInvitePartnerFailurePointForTest(point);
      await expect(
        svc.invitePartnerUser(
          {
            actorUserId: "00000000-0000-0000-0000-0000000000a5",
            actorEmail: ADMIN_EMAIL,
            requestId: `invite-${point}`,
            idempotencyKey: `invite-${point}`,
          },
          A,
          { firstName: "Rollback", lastName: point, email, role: "STAFF" },
          "rollback proof"
        )
      ).rejects.toThrow(`synthetic_invite_partner_${point}`);
      svc.__setInvitePartnerFailurePointForTest(null);
      const leaked = await admin.query<{ users: number; roles: number; invites: number; succeeded_audits: number }>(
        `SELECT
           (SELECT count(*)::int FROM partner_users WHERE lower(email)=lower($1)) AS users,
           (SELECT count(*)::int FROM partner_user_roles ur JOIN partner_users u ON u.id=ur.user_id WHERE lower(u.email)=lower($1)) AS roles,
           (SELECT count(*)::int FROM partner_invitations WHERE lower(email)=lower($1)) AS invites,
           (SELECT count(*)::int FROM partner_management_audit WHERE result='succeeded' AND after_state::text ILIKE '%' || $1 || '%') AS succeeded_audits`,
        [email]
      );
      expect(leaked.rows[0]).toEqual({ users: 0, roles: 0, invites: 0, succeeded_audits: 0 });
      const retry = await svc.invitePartnerUser(
        {
          actorUserId: "00000000-0000-0000-0000-0000000000a5",
          actorEmail: ADMIN_EMAIL,
          requestId: `invite-${point}-retry`,
          idempotencyKey: `invite-${point}-retry`,
        },
        A,
        { firstName: "Rollback", lastName: "Retry", email, role: "STAFF" },
        "retry after rollback"
      );
      expect(retry.result?.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(retry)).not.toMatch(/synthetic_invite|token_hash|password/i);
    }
  });

  it("concurrent same-email invitations overlap and yield exactly one complete invitation", async () => {
    const svc = await import("../server/partner/partner-management-service");
    const c = await cookie();
    const email = "race-invite@a.example";
    svc.__setInvitePartnerBarrierForTest({ point: "after_duplicate_check", parties: 2 });
    const start = Date.now();
    const requests = [
      post(
        `${PM}/partners/${A}/users`,
        { firstName: "Race", lastName: "One", email, role: "STAFF", reason: "race one" },
        c
      ),
      post(
        `${PM}/partners/${A}/users`,
        { firstName: "Race", lastName: "Two", email, role: "STAFF", reason: "race two" },
        c
      ),
    ];
    const responses = await Promise.all(requests);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const success = bodies.find((b) => b.ok);
    const loser = bodies.find((b) => b.error);
    expect(success?.result?.invitationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loser?.error?.code).toBe("DUPLICATE_PARTNER_USER");
    expect(JSON.stringify(loser)).not.toMatch(/token=|token_hash|race-invite-token/i);
    const stored = await admin.query<{ users: number; roles: number; invites: number }>(
      `SELECT
         (SELECT count(*)::int FROM partner_users WHERE lower(email)=lower($1)) AS users,
         (SELECT count(*)::int FROM partner_user_roles ur JOIN partner_users u ON u.id=ur.user_id WHERE lower(u.email)=lower($1)) AS roles,
         (SELECT count(*)::int FROM partner_invitations WHERE lower(email)=lower($1)) AS invites`,
      [email]
    );
    expect(stored.rows[0]).toEqual({ users: 1, roles: 1, invites: 1 });
  });

  it("capture adapter handles management invitation delivery even when RESEND_API_KEY is present", async () => {
    const c = await cookie();
    const create = await post(
      `${PM}/partners/${A}/users`,
      {
        firstName: "Capture",
        lastName: "Proof",
        email: "capture-proof@a.example",
        role: "STAFF",
        reason: "capture proof",
      },
      c
    );
    expect(create.status).toBe(200);
    const body = await create.json();
    expect(capturedInvites.map((i) => i.email)).toContain("capture-proof@a.example");
    expect(emailTransport.invitationCalls).toHaveLength(0);
    const stored = await admin.query<{ status: string }>("SELECT status FROM partner_invitations WHERE id=$1", [
      body.result.invitationId,
    ]);
    expect(stored.rows[0].status).toBe("SENT");
  });

  it("delivery transport mock is non-vacuous when the capture adapter is removed", async () => {
    const delivery = await import("../server/partner/delivery");
    setInvitationDeliveryAdapter?.(null);
    await delivery.deliverInvitationToken({
      email: "transport-positive-control@example.test",
      token: "synthetic-token-not-logged",
      partnerName: "Transport Control Ltd",
      roleCode: "PARTNER_RECEPTION",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(emailTransport.invitationCalls).toHaveLength(1);
  });

  it("successful post-commit delivery cannot resurrect a revoked management invitation", async () => {
    const c = await cookie();
    let enteredDelivery!: () => void;
    let resumeDelivery!: () => void;
    const deliveryEntered = new Promise<void>((resolve) => {
      enteredDelivery = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeDelivery = resolve;
    });
    const order: string[] = [];
    setInvitationDeliveryAdapter?.(async (data) => {
      capturedInvites.push({ ...data });
      order.push("delivery-entered");
      enteredDelivery();
      await resume;
      order.push("delivery-resumed");
    });

    const createPromise = post(
      `${PM}/partners/${A}/users`,
      {
        firstName: "Race",
        lastName: "Success",
        email: "delivery-race-success@a.example",
        role: "STAFF",
        reason: "race success",
      },
      c
    );
    await deliveryEntered;
    const row = await admin.query<{ user_id: string; id: string; status: string }>(
      "SELECT user_id, id, status FROM partner_invitations WHERE email=$1",
      ["delivery-race-success@a.example"]
    );
    expect(row.rows[0].status).toBe("PENDING");
    order.push("revoke-started");
    const revoke = await post(
      `${PM}/partners/${A}/users/${row.rows[0].user_id}/revoke-invitation`,
      { reason: "concurrent revoke" },
      c
    );
    expect(revoke.status).toBe(200);
    order.push("revoked");
    resumeDelivery();
    const create = await createPromise;
    expect(create.status).toBe(200);
    expect((await create.clone().json()).result.deliveryStatus).toBe("DELIVERY_NOT_CONFIGURED");
    expect(order).toEqual(["delivery-entered", "revoke-started", "revoked", "delivery-resumed"]);
    const final = await admin.query<{ status: string }>("SELECT status FROM partner_invitations WHERE id=$1", [
      row.rows[0].id,
    ]);
    expect(final.rows[0].status).toBe("REVOKED");
    const token = capturedInvites[0].token;
    const { acceptPartnerInvitation } = await import("../server/partner/partner-management-service");
    expect(await acceptPartnerInvitation(token, "delivery-race-password-1")).toMatchObject({ ok: false });
    expect(emailTransport.invitationCalls).toHaveLength(0);
  });

  it("failed post-commit delivery cannot resurrect a revoked management invitation", async () => {
    const c = await cookie();
    let enteredDelivery!: () => void;
    let resumeDelivery!: () => void;
    const deliveryEntered = new Promise<void>((resolve) => {
      enteredDelivery = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeDelivery = resolve;
    });
    setInvitationDeliveryAdapter?.(async (data) => {
      capturedInvites.push({ ...data });
      enteredDelivery();
      await resume;
      throw new Error("synthetic-delivery-failure");
    });

    const createPromise = post(
      `${PM}/partners/${A}/users`,
      {
        firstName: "Race",
        lastName: "Failure",
        email: "delivery-race-failure@a.example",
        role: "STAFF",
        reason: "race failure",
      },
      c
    );
    await deliveryEntered;
    const row = await admin.query<{ user_id: string; id: string; status: string }>(
      "SELECT user_id, id, status FROM partner_invitations WHERE email=$1",
      ["delivery-race-failure@a.example"]
    );
    expect(row.rows[0].status).toBe("PENDING");
    const revoke = await post(
      `${PM}/partners/${A}/users/${row.rows[0].user_id}/revoke-invitation`,
      { reason: "concurrent failed delivery revoke" },
      c
    );
    expect(revoke.status).toBe(200);
    resumeDelivery();
    const create = await createPromise;
    expect(create.status).toBe(200);
    expect((await create.clone().json()).result.deliveryStatus).toBe("DELIVERY_NOT_CONFIGURED");
    const final = await admin.query<{ status: string; delivery_error: string | null }>(
      "SELECT status, delivery_error FROM partner_invitations WHERE id=$1",
      [row.rows[0].id]
    );
    expect(final.rows[0]).toEqual({ status: "REVOKED", delivery_error: null });
    const { acceptPartnerInvitation } = await import("../server/partner/partner-management-service");
    expect(await acceptPartnerInvitation(capturedInvites[0].token, "delivery-race-password-2")).toMatchObject({
      ok: false,
    });
  });

  it("ordinary failed management delivery records DELIVERY_FAILED while still PENDING", async () => {
    const c = await cookie();
    setInvitationDeliveryAdapter?.(async (data) => {
      capturedInvites.push({ ...data });
      throw new Error("synthetic ordinary failure");
    });
    const create = await post(
      `${PM}/partners/${A}/users`,
      {
        firstName: "Failed",
        lastName: "Delivery",
        email: "ordinary-failed-delivery@a.example",
        role: "STAFF",
        reason: "ordinary delivery failure",
      },
      c
    );
    expect(create.status).toBe(200);
    const body = await create.json();
    expect(body.result.deliveryStatus).toBe("DELIVERY_FAILED");
    const stored = await admin.query<{ status: string; delivery_error: string | null }>(
      "SELECT status, delivery_error FROM partner_invitations WHERE id=$1",
      [body.result.invitationId]
    );
    expect(stored.rows[0].status).toBe("DELIVERY_FAILED");
    expect(stored.rows[0].delivery_error).toContain("synthetic ordinary failure");
  });

  it("team post-commit delivery bookkeeping treats stale rowCount zero as benign", async () => {
    const svc = await import("../server/partner/partner-management-service");
    const { deliverTeamInvitationAfterCommit } = await import("../server/partner/team-service");
    const invited = await svc.invitePartnerUser(
      {
        actorUserId: "00000000-0000-0000-0000-0000000000a5",
        actorEmail: ADMIN_EMAIL,
        requestId: "team-stale-delivery",
        idempotencyKey: "team-stale-delivery",
      },
      A,
      {
        firstName: "Team",
        lastName: "Stale",
        email: "team-stale-delivery@a.example",
        role: "STAFF",
      },
      "team stale bookkeeping proof"
    );
    expect(invited.result?.invitationId).toMatch(/^[0-9a-f-]{36}$/);
    await admin.query("UPDATE partner_invitations SET status='REVOKED', revoked_at=now() WHERE id=$1", [
      invited.result!.invitationId,
    ]);
    await expect(
      deliverTeamInvitationAfterCommit(A, invited.result!.invitationId, invited.result!.delivery)
    ).resolves.toBeUndefined();
    const final = await admin.query<{ status: string }>("SELECT status FROM partner_invitations WHERE id=$1", [
      invited.result!.invitationId,
    ]);
    expect(final.rows[0].status).toBe("REVOKED");
    expect(emailTransport.invitationCalls).toHaveLength(0);
  });

  it("invitation resend supersedes old token; explicit revoke rejects the active token generically", async () => {
    const c = await cookie();
    const create = await post(
      `${PM}/partners/${A}/users`,
      {
        firstName: "Staff",
        lastName: "Pending",
        email: "staff-pending@a.example",
        role: "STAFF",
        reason: "staff setup",
      },
      c
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const token1 = new URL(created.result.invitationLink).searchParams.get("token")!;
    const userId = created.result.userId;
    const resend = await post(`${PM}/partners/${A}/users/${userId}/resend-invitation`, { reason: "resend" }, c);
    expect(resend.status).toBe(200);
    const token2 = new URL((await resend.json()).result.invitationLink).searchParams.get("token")!;
    expect(token2).not.toBe(token1);
    const states = await admin.query<{ status: string }>(
      "SELECT status FROM partner_invitations WHERE user_id=$1 ORDER BY created_at",
      [userId]
    );
    expect(states.rows.map((r) => r.status)).toEqual(["REVOKED", "SENT"]);
    const { acceptPartnerInvitation } = await import("../server/partner/partner-management-service");
    expect((await acceptPartnerInvitation(token1, "staff-secure-password-1")).ok).toBe(false);
    const revoke = await post(
      `${PM}/partners/${A}/users/${userId}/revoke-invitation`,
      { reason: "staging revoke test" },
      c
    );
    expect(revoke.status).toBe(200);
    expect((await acceptPartnerInvitation(token2, "staff-secure-password-1")).ok).toBe(false);
  });

  it("invitation expiry, malformed token, suspended/revoked partner and duplicate email are rejected safely", async () => {
    const c = await cookie();
    const { acceptPartnerInvitation } = await import("../server/partner/partner-management-service");
    expect((await acceptPartnerInvitation("malformed", "secure-password-1")).ok).toBe(false);

    const dup = await post(
      `${PM}/partners/${B}/users`,
      { firstName: "Other", lastName: "Owner", email: "owner-invite@a.example", role: "OWNER", reason: "dup" },
      c
    );
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("DUPLICATE_PARTNER_USER");

    const create = await post(
      `${PM}/partners/${A}/users`,
      { firstName: "Expired", lastName: "User", email: "expired@a.example", role: "STAFF", reason: "expiry" },
      c
    );
    const token = new URL((await create.json()).result.invitationLink).searchParams.get("token")!;
    await admin.query("UPDATE partner_invitations SET expires_at=now() - interval '1 minute' WHERE email=$1", [
      "expired@a.example",
    ]);
    expect((await acceptPartnerInvitation(token, "expired-secure-password-1")).ok).toBe(false);
    expect(
      (
        await admin.query<{ status: string }>("SELECT status FROM partner_invitations WHERE email=$1", [
          "expired@a.example",
        ])
      ).rows[0].status
    ).toBe("EXPIRED");

    await admin.query("UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1", [B]);
    const suspended = await post(
      `${PM}/partners/${B}/users`,
      { firstName: "Blocked", lastName: "User", email: "blocked@b.example", role: "OWNER", reason: "suspended" },
      c
    );
    expect(suspended.status).toBe(400);
    await admin.query("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [B]);
    const revoked = await post(
      `${PM}/partners/${B}/users`,
      { firstName: "Blocked", lastName: "Two", email: "blocked2@b.example", role: "OWNER", reason: "revoked" },
      c
    );
    expect(revoked.status).toBe(400);
    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [B]);
  });

  it("final active owner cannot be suspended or demoted", async () => {
    const c = await cookie();
    const row = await admin.query<{ id: string }>("SELECT id FROM partner_users WHERE email=$1", [
      "owner-invite@a.example",
    ]);
    const userId = row.rows[0].id;
    const suspend = await post(
      `${PM}/partners/${A}/users/${userId}/status`,
      { status: "SUSPENDED", reason: "test final owner guard" },
      c
    );
    expect(suspend.status).toBe(409);
    expect((await suspend.json()).error.code).toBe("FINAL_OWNER_REQUIRED");
    const legacySuspend = await post(
      `/api/super-admin/grading-partners/${A}/users/${userId}/suspend`,
      { reason: "legacy route final owner guard" },
      c
    );
    expect(legacySuspend.status).toBe(409);
    expect((await legacySuspend.json()).code).toBe("FINAL_OWNER_REQUIRED");
    const demote = await post(
      `${PM}/partners/${A}/users/${userId}/role`,
      { role: "STAFF", reason: "test final owner guard" },
      c
    );
    expect(demote.status).toBe(409);
  });

  it("suspension, membership revocation and role change invalidate active sessions", async () => {
    const c = await cookie();
    const { partnerLogin } = await import("../server/partner/auth");
    const before = await partnerLogin("owner-invite@a.example", "owner-secure-password-1", "127.0.0.1");
    expect(before.ok).toBe(true);
    const owner2 = await post(
      `${PM}/partners/${A}/users`,
      { firstName: "Backup", lastName: "Owner", email: "backup-owner@a.example", role: "OWNER", reason: "backup" },
      c
    );
    const token = new URL((await owner2.json()).result.invitationLink).searchParams.get("token")!;
    const { acceptPartnerInvitation } = await import("../server/partner/partner-management-service");
    expect((await acceptPartnerInvitation(token, "backup-owner-password-1")).ok).toBe(true);
    const row = await admin.query<{ id: string }>("SELECT id FROM partner_users WHERE email=$1", [
      "owner-invite@a.example",
    ]);
    const userId = row.rows[0].id;
    expect(
      (await post(`${PM}/partners/${A}/users/${userId}/role`, { role: "ADMIN", reason: "demote with backup" }, c))
        .status
    ).toBe(200);
    expect(
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int n FROM partner_sessions WHERE user_id=$1 AND revoked_at IS NULL",
          [userId]
        )
      ).rows[0].n
    ).toBe(0);
    const relogin = await partnerLogin("owner-invite@a.example", "owner-secure-password-1", "127.0.0.1");
    expect(relogin.ok).toBe(true);
    expect(
      (await post(`${PM}/partners/${A}/users/${userId}/status`, { status: "SUSPENDED", reason: "suspend test" }, c))
        .status
    ).toBe(200);
    expect((await partnerLogin("owner-invite@a.example", "owner-secure-password-1", "127.0.0.1")).ok).toBe(false);
    expect(
      (await post(`${PM}/partners/${A}/users/${userId}/status`, { status: "REVOKED", reason: "revoke test" }, c)).status
    ).toBe(200);
  });

  it("invalid branding_status is a friendly 400 VALIDATION_ERROR, not a 500", async () => {
    const c = await cookie();
    const r = await put(`${PM}/partners/${A}/branding`, { branding_status: "not_a_status" }, c);
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("not-found + redaction: unknown partner 404; no secret in any read payload", async () => {
    const c = await cookie();
    expect((await g(`${PM}/partners/00000000-0000-0000-0000-0000000000ff`, c)).status).toBe(404);
    // B's profile carries a secret-looking primary_email seed — it is a business field (email), not a
    // credential, but assert no credential material leaks anywhere in the partner detail/list.
    const detail = await (await g(`${PM}/partners/${B}`, c)).json();
    expect(JSON.stringify(detail)).not.toMatch(/password|pin_hash|admin_passphrase|\$2[aby]\$/i);
  });
});
