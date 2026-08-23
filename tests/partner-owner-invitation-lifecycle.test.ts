/**
 * Shop #1 staging blockers, reproduced over REAL HTTP against real PostgreSQL 17.
 *
 * Three actions were reported failing on the live Shop #1 ("shop test"):
 *   1. Super Admin — SAVE MAIN LOCATION ADDRESS
 *   2. Super Admin — SAVE PRIMARY OPERATIONS CONTACT
 *   3. Partner Owner — Credits & Billing returning "authentication required"
 *
 * The canonical data could not settle 1 and 2: both fields were already populated by the
 * first-shop CREATE, so a failed save is indistinguishable from a successful one by value alone.
 * The only distinguishing evidence is `updated_at` advancing and the audit event being written —
 * and `withAudit` writes its "attempted" row INSIDE the transaction, so a failed save rolls back
 * its own evidence and leaves no trace at all. Hence: drive the real routes.
 *
 * Acceptance here is HTTP + read-back, never a direct DB mutation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const delivery = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));
vi.mock("../server/partner/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/delivery")>();
  return {
    ...actual,
    invitationDeliveryConfigured: () => true,
    deliverInvitationToken: vi.fn(async (payload: Record<string, unknown>) => {
      delivery.sent.push(payload);
    }),
  };
});

let cluster: DisposablePostgres17;
let admin: Client;
let server: http.Server;
let base = "";
let adminCookie = "";
let partnerId = "";
let locationId = "";
let adminEmail = "";
let ownerCookie = "";

async function call(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string
): Promise<{ status: number; json: Record<string, unknown>; text: string; setCookie: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body — status is what matters */
  }
  return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
}

async function seedCoreTables(): Promise<void> {
  // requireAdmin re-loads the acting admin from `users`, so the columns it reads (role,
  // credential_version) must exist or every Super Admin route 500s before its handler runs.
  await admin.query(`CREATE TABLE users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
    profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), password_hash text,
    display_name text, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamp, last_login_at timestamp,
    last_login_ip text, failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp, last_failed_login_at timestamp,
    credential_version integer NOT NULL DEFAULT 1, admin_passphrase_hash text, pin_hash text, pin_set_at timestamp,
    pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp, public_name boolean NOT NULL DEFAULT false,
    can_grade boolean NOT NULL DEFAULT false, can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
    can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100)`);
  for (const statement of [
    "CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)",
    "CREATE TABLE submission_items (id serial primary key, submission_id integer not null)",
    "CREATE TABLE certificates (id serial PRIMARY KEY, cert_id text, submission_id integer, secret text)",
    "CREATE TABLE label_prints (id serial PRIMARY KEY, certificate_id integer, created_at timestamptz NOT NULL DEFAULT now())",
    "CREATE TABLE audit_log (id serial primary key, entity_type text not null, entity_id text not null, action text not null, admin_user text, details jsonb, created_at timestamptz not null default now())",
  ]) {
    await admin.query(statement);
  }
  for (const table of ["users", "submissions", "submission_items", "certificates", "label_prints", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

describe("Partner Owner invitation lifecycle — real PostgreSQL, real HTTP, real session", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-owner-invitation-lifecycle");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    // PARTNER_DATABASE_URL is assigned AFTER the restricted role exists — mount.ts's first gate
    // refuses to serve the portal at all when the runtime connects as a superuser.
    process.env.PARTNER_CREDIT_DATABASE_URL = cluster.url;
    process.env.SESSION_SECRET ||= "shop1-save-actions-synthetic-secret";
    // Synthetic key, disposable database only. Without it mount.ts's runtime gate closes the whole
    // authenticated partner surface, and every assertion below would pass for the wrong reason.
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedCoreTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_FIRST_SHOP);
    // The authenticated surface must connect as a NON-superuser role holding partner_runtime.
    await admin.query("DROP ROLE IF EXISTS partner_app_test_invlifecycle").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_invlifecycle LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_invlifecycle");
    process.env.PARTNER_DATABASE_URL = cluster.url.replace(
      /\/\/[^@/]+@/,
      "//partner_app_test_invlifecycle:synthetic@"
    );

    const authMod = await import("../server/auth");
    adminEmail = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [adminEmail.toLowerCase()]
    );

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");
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
      s.adminEmail = adminEmail;
      s.authUserId = "00000000-0000-0000-0000-0000000000a5";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      s.adminStepUpAt = new Date().toISOString();
      req.session.save(() => res.json({ ok: true }));
    });
    registerPartnerManagementRoutes(app);
    // PRODUCTION composition order: public partner routes first, then the gated authenticated mount.
    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true) ON CONFLICT DO NOTHING"
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await call("POST", "/__test/admin-login");
    adminCookie = (login.setCookie ?? "").split(";")[0];
    expect(adminCookie).toContain("mv.sid=");
  }, 180_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });


  const OWNER = { firstName: "Cornelius", lastName: "Oliver", email: "owner@inv-lifecycle.test" };
  const PASSWORD = "inv-lifecycle-owner-password-1";
  let ownerUserId = "";
  let firstToken = "";

  /** The newest token addressed to the OWNER. Never `.at(-1)`: other users are invited in between. */
  const ownerToken = (): string => {
    const mine = delivery.sent.filter((m) => m.email === OWNER.email);
    expect(mine.length).toBeGreaterThan(0);
    return String((mine.at(-1) as { token: string }).token);
  };

  const liveInvitations = async () =>
    (
      await admin.query<{ id: string; status: string; superseded_by: string | null; revoked_at: string | null }>(
        "select id,status,superseded_by,revoked_at from partner_invitations where user_id=$1 order by created_at desc",
        [ownerUserId]
      )
    ).rows;

  it("PHASE 7 — one CREATE click makes exactly one of everything, atomically", async () => {
    const before = delivery.sent.length;
    const created = await call(
      "POST",
      "/api/super-admin/partner-management/first-shop",
      {
        legalName: "Invitation Lifecycle Ltd",
        deliveryAddress: { line1: "2 Temple Gardens", city: "Rochester", postcode: "ME2 2NG", country: "United Kingdom" },
        owner: OWNER,
        idempotencyKey: "inv-lifecycle-create-0001",
        reason: "lifecycle fixture",
      },
      adminCookie
    );
    expect(created.status).toBe(200);
    partnerId = String((created.json.result as Record<string, unknown>).partnerId);

    // Exactly one of every canonical record, from ONE click.
    const one = async (sql: string) => (await admin.query<{ n: number }>(sql, [partnerId])).rows[0].n;
    expect(await one("select count(*)::int n from partner_organisations where id=$1")).toBe(1);
    expect(await one("select count(*)::int n from partner_locations where tenant_id=$1")).toBe(1);
    expect(await one("select count(*)::int n from partner_contacts where tenant_id=$1 and contact_type='operations'")).toBe(1);
    expect(await one("select count(*)::int n from partner_users where tenant_id=$1")).toBe(1);
    expect(await one("select count(*)::int n from partner_invitations where tenant_id=$1")).toBe(1);
    // Exactly one email request.
    expect(delivery.sent.length).toBe(before + 1);

    // Server-supplied defaults: Main location named, Owner is the operations contact.
    const loc = await admin.query<{ name: string }>("select name from partner_locations where tenant_id=$1", [partnerId]);
    expect(loc.rows[0].name).toBe("Main location");
    const contact = await admin.query<{ full_name: string; email: string }>(
      "select full_name,email from partner_contacts where tenant_id=$1", [partnerId]);
    expect(contact.rows[0]).toMatchObject({ full_name: "Cornelius Oliver", email: OWNER.email });

    ownerUserId = (await admin.query<{ id: string }>("select id from partner_users where tenant_id=$1", [partnerId])).rows[0].id;
    firstToken = String((delivery.sent.at(-1) as { token: string }).token);
  });

  it("PHASE 7 — a duplicate Owner email is refused and writes NOTHING", async () => {
    const orgsBefore = (await admin.query<{ n: number }>("select count(*)::int n from partner_organisations")).rows[0].n;
    const emailsBefore = delivery.sent.length;
    const dup = await call(
      "POST",
      "/api/super-admin/partner-management/first-shop",
      {
        legalName: "Should Never Exist Ltd",
        deliveryAddress: { line1: "9 Ghost Lane", city: "Leeds", postcode: "LS2 2AA", country: "United Kingdom" },
        owner: OWNER,
        idempotencyKey: "inv-lifecycle-duplicate-0002",
        reason: "duplicate proof",
      },
      adminCookie
    );
    expect(dup.status).toBeGreaterThanOrEqual(400);
    // No ghost Partner, and no email attempted.
    expect((await admin.query<{ n: number }>("select count(*)::int n from partner_organisations")).rows[0].n).toBe(orgsBefore);
    expect(await admin.query("select 1 from partner_organisations where legal_name='Should Never Exist Ltd'")).toMatchObject({ rowCount: 0 });
    expect(delivery.sent.length).toBe(emailsBefore);
  });

  it("PHASE 7 — eligibility agrees with the transaction, per Owner status", async () => {
    const q = async (email: string) =>
      call("GET", `/api/super-admin/partner-management/first-shop/owner-email-eligibility?email=${encodeURIComponent(email)}`, undefined, adminCookie);
    const free = await q("nobody@inv-lifecycle.test");
    expect(free.json).toMatchObject({ available: true, conflict: null });
    const taken = await q(OWNER.email);
    expect(taken.json).toMatchObject({ available: false });
    expect((taken.json.conflict as Record<string, unknown>).userStatus).toBe("INVITED");
  });

  it("PHASE 8 — ONE resend mints one invitation, supersedes the old, sends one email", async () => {
    const snapshot = await call("GET", `/api/super-admin/partner-management/partners/${partnerId}/first-shop`, undefined, adminCookie);
    await call("POST", `/api/super-admin/partner-management/partners/${partnerId}/status`,
      { status: "ACTIVE", expectedVersion: (snapshot.json as Record<string, unknown>).profileVersion, reason: "activate" }, adminCookie);

    const emailsBefore = delivery.sent.length;
    const resend = await call("POST", `/api/super-admin/partner-management/partners/${partnerId}/users/${ownerUserId}/resend-invitation`,
      { reason: "lifecycle resend" }, adminCookie);
    expect(resend.status).toBe(200);

    const rows = await liveInvitations();
    expect(rows).toHaveLength(2);
    const [fresh, old] = rows;
    expect(fresh.status).toBe("SENT");
    expect(fresh.superseded_by).toBeNull();
    expect(old.status).toBe("REVOKED");
    expect(old.superseded_by).toBe(fresh.id);
    // Exactly ONE new provider call.
    expect(delivery.sent.length).toBe(emailsBefore + 1);
    // Owner is untouched by a resend.
    const u = await admin.query<{ status: string }>("select status from partner_users where id=$1", [ownerUserId]);
    expect(u.rows[0].status).toBe("INVITED");
  });

  it("PHASE 8 — CONCURRENT resends send exactly ONE email and leave ONE live invitation", async () => {
    /*
     * A SEPARATE invited user, so this measures the race itself rather than the previous test's
     * resend. Creating a user writes a partner_user_invited audit row, not a resend one, so the
     * duplicate-collapse window starts clean here.
     */
    const invited = await call(
      "POST",
      `/api/super-admin/partner-management/partners/${partnerId}/users`,
      { firstName: "Race", lastName: "Case", email: "race@inv-lifecycle.test", role: "STAFF", reason: "concurrency proof" },
      adminCookie
    );
    expect(invited.status).toBe(200);
    const raceUser = (
      await admin.query<{ id: string }>("select id from partner_users where email='race@inv-lifecycle.test'")
    ).rows[0].id;

    const emailsBefore = delivery.sent.length;
    const [a, b] = await Promise.all([
      call("POST", `/api/super-admin/partner-management/partners/${partnerId}/users/${raceUser}/resend-invitation`, { reason: "race a" }, adminCookie),
      call("POST", `/api/super-admin/partner-management/partners/${partnerId}/users/${raceUser}/resend-invitation`, { reason: "race b" }, adminCookie),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const rows = await admin.query<{ status: string }>(
      "select status from partner_invitations where user_id=$1", [raceUser]);
    const live = rows.rows.filter((r) => r.status === "SENT" || r.status === "PENDING");
    const sends = delivery.sent.length - emailsBefore;
    console.log(`CONCURRENCY_RESULT providerSends=${sends} liveInvitations=${live.length}`);

    /*
     * ONE live invitation AND exactly ONE email.
     *
     * Before the advisory lock this measured two sends: the recipient got two invitations and only
     * the second link worked, because each mint supersedes the last. Server authority now collapses
     * the duplicate — a disabled button protects one tab, not two, and not a retry.
     */
    expect(live).toHaveLength(1);
    expect(sends).toBe(1);
  });

  it("PHASE 9 — the superseded token is dead and the newest one previews", async () => {
    const dead = await call("POST", "/api/partner/invitations/accept", { token: firstToken, password: PASSWORD });
    expect(dead.status).toBeGreaterThanOrEqual(400);
    // Still INVITED: a rejected token must not half-activate anybody.
    const u = await admin.query<{ status: string }>("select status from partner_users where id=$1", [ownerUserId]);
    expect(u.rows[0].status).toBe("INVITED");

    const garbage = await call("POST", "/api/partner/invitations/accept", { token: "not-a-real-token", password: PASSWORD });
    expect(garbage.status).toBeGreaterThanOrEqual(400);
  });

  it("PHASE 9 — tokens are stored hashed and never appear in the audit payload", async () => {
    const token = ownerToken();
    const stored = await admin.query<{ token_hash: string }>("select token_hash from partner_invitations where user_id=$1 order by created_at desc limit 1", [ownerUserId]);
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(stored.rows[0].token_hash).not.toContain(token);
    const audit = await admin.query<{ blob: string }>(
      "select coalesce(after_state::text,'') || coalesce(before_state::text,'') as blob from partner_management_audit where tenant_id=$1", [partnerId]);
    for (const row of audit.rows) expect(row.blob).not.toContain(token);
  });

  it("PHASE 10 — the Owner activates: accept, password, MFA, login, dashboard", async () => {
    const token = ownerToken();
    const accepted = await call("POST", "/api/partner/invitations/accept", { token, password: PASSWORD });
    expect(accepted.status).toBe(200);

    const consumed = await admin.query<{ consumed_at: string | null; status: string }>(
      "select consumed_at,status from partner_invitations where user_id=$1 order by created_at desc limit 1", [ownerUserId]);
    expect(consumed.rows[0].consumed_at).not.toBeNull();

    // SINGLE USE: the same token cannot be replayed.
    const replay = await call("POST", "/api/partner/invitations/accept", { token, password: "another-password-99" });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    const login = await call("POST", "/api/partner/auth/login", { email: OWNER.email, password: PASSWORD });
    expect(login.status).toBe(200);
    ownerCookie = (login.setCookie ?? "").split(";")[0];
    expect(ownerCookie).toContain("mv.partner.sid=");

    // MFA IS MANDATORY: the session is not fully authenticated until it is enrolled and confirmed.
    const preMfa = await call("GET", "/api/partner/session", undefined, ownerCookie);
    expect(preMfa.json).toMatchObject({ mfaPassed: false });

    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD }, ownerCookie);
    expect(enrol.status).toBe(200);
    const mfa = await import("../server/partner/mfa");
    const secret = String((enrol.json as Record<string, unknown>).secret);

    // A WRONG code must be refused.
    const wrong = await call("POST", "/api/partner/mfa/confirm",
      { enrolmentId: (enrol.json as Record<string, unknown>).enrolmentId, code: "000000" }, ownerCookie);
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const confirmed = await call("POST", "/api/partner/mfa/confirm",
      { enrolmentId: (enrol.json as Record<string, unknown>).enrolmentId, code: mfa.currentTotp(secret, Date.now()) }, ownerCookie);
    expect(confirmed.status).toBe(200);

    const session = await call("GET", "/api/partner/session", undefined, ownerCookie);
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({ mfaPassed: true });
  });

  it("PHASE 10 — NO LOGIN LOOP: an authenticated session keeps working across repeated reads", async () => {
    /*
     * The regression this pins: after MFA the session was written but not yet readable, so the
     * client bounced straight back to /partner/login. Three consecutive authenticated reads must
     * all succeed on the SAME cookie.
     */
    for (let i = 0; i < 3; i += 1) {
      const me = await call("GET", "/api/partner/me", undefined, ownerCookie);
      expect(me.status).toBe(200);
      expect(me.json).toMatchObject({ mfaPassed: true });
    }
  });

  it("PHASE 11 — the controller advances: Owner ACTIVE, no resend offered", async () => {
    const u = await admin.query<{ status: string }>("select status from partner_users where id=$1", [ownerUserId]);
    expect(u.rows[0].status).toBe("ACTIVE");

    const shop = await call("GET", `/api/super-admin/partner-management/partners/${partnerId}/first-shop`, undefined, adminCookie);
    expect(shop.status).toBe(200);
    const operational = (shop.json as Record<string, any>).operational;
    // The owner dimension has stopped blocking, so the stage has moved past ACTIVATE.
    expect(operational.dimensions.owner.status).toBe("PASS");
    expect(operational.nextAction.stage).not.toBe("ACTIVATE");
    // And the resend control is gated on INVITED, which no longer holds.
    const owner = (shop.json as Record<string, any>).owner;
    expect(owner.userStatus).toBe("ACTIVE");
  });

  it("PHASE 13 — a provider failure is recorded as DELIVERY_FAILED, never as sent", async () => {
    const deliveryMod = await import("../server/partner/delivery");
    const spy = vi.spyOn(deliveryMod, "deliverInvitationToken").mockRejectedValueOnce(new Error("Resend API error: 500 upstream"));
    try {
      // A second user, so the ACTIVE owner is untouched.
      const invited = await call("POST", `/api/super-admin/partner-management/partners/${partnerId}/users`,
        { firstName: "Fail", lastName: "Case", email: "failcase@inv-lifecycle.test", role: "STAFF", reason: "failure injection" }, adminCookie);
      expect(invited.status).toBe(200);
      const row = await admin.query<{ status: string; delivery_error: string | null }>(
        "select status,delivery_error from partner_invitations where email='failcase@inv-lifecycle.test' order by created_at desc limit 1");
      expect(row.rows[0].status).toBe("DELIVERY_FAILED");
      expect(row.rows[0].delivery_error).toContain("Resend API error");
    } finally {
      spy.mockRestore();
    }
  });
});
