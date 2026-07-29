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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
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

const A = "aaaa1111-0000-0000-0000-0000000000c5";
const B = "bbbb2222-0000-0000-0000-0000000000d5";

let admin: Client;
let server: http.Server;
let base: string;
let ADMIN_EMAIL: string;

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
    await admin.query("DROP OWNED BY partner_app_test").catch(() => {});
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_admin_bypass_test LOGIN PASSWORD 'synthetic-admin' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_admin_bypass_test WITH LOGIN PASSWORD 'synthetic-admin' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_app_test LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_app_test WITH LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END$$;`
    );
    await admin.query("GRANT USAGE ON SCHEMA public TO partner_admin_bypass_test");
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partner_admin_bypass_test"
    );
    await admin.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO partner_admin_bypass_test");
    await admin.query("GRANT partner_runtime TO partner_app_test");

    process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAsRole(ADMIN_DB!, "partner_admin_bypass_test", "synthetic-admin");
    process.env.PARTNER_DATABASE_URL = dbUrlAsRole(ADMIN_DB!, "partner_app_test", "synthetic");
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

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
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

  it("create is idempotent for a repeated key: no duplicate org, second call alreadyCompleted", async () => {
    const c = await cookie();
    const key = "create-key-1";
    const r1 = await post(`${PM}/partners`, { legalName: "Idem Cards Ltd", idempotencyKey: key }, c);
    expect(r1.status).toBe(200);
    const r2 = await post(`${PM}/partners`, { legalName: "Idem Cards Ltd", idempotencyKey: key }, c);
    expect(r2.status).toBe(200);
    expect((await r2.json()).alreadyCompleted).toBe(true);
    // exactly ONE org was created for this name (the org insert is now behind the idempotency pre-check)
    const n = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_organisations WHERE legal_name='Idem Cards Ltd'"
    );
    expect(n.rows[0].n).toBe(1);
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
    expect(states.rows.map((r) => r.status)).toEqual(["REVOKED", "PENDING"]);
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
