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

describe("Shop #1 save actions over real HTTP", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-first-shop-save-actions");
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
    await admin.query("DROP ROLE IF EXISTS partner_app_test_saveactions").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_saveactions LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_saveactions");
    process.env.PARTNER_DATABASE_URL = cluster.url.replace(
      /\/\/[^@/]+@/,
      "//partner_app_test_saveactions:synthetic@"
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

  it("creates the Shop #1 fixture through the real guided route", async () => {
    const created = await call(
      "POST",
      "/api/super-admin/partner-management/first-shop",
      {
        legalName: "Save Actions Shop Ltd",
        locationName: "Main location",
        deliveryAddress: {
          line1: "2 Temple Gardens",
          line2: "Kent",
          city: "Rochester",
          postcode: "ME2 2NG",
          country: "United Kingdom",
        },
        operationsContact: { fullName: "Original Contact", email: "original@save-actions.test" },
        owner: { firstName: "Save", lastName: "Owner", email: "owner@save-actions.test" },
        idempotencyKey: "shop1-save-actions-create-0001",
        reason: "save-actions fixture",
      },
      adminCookie
    );
    expect(created.status).toBe(200);
    partnerId = ((created.json.result as Record<string, unknown>)?.partnerId as string) ?? "";
    expect(partnerId).toMatch(/^[0-9a-f-]{36}$/);
    const loc = await admin.query<{ id: string }>("SELECT id FROM partner_locations WHERE tenant_id=$1", [partnerId]);
    locationId = loc.rows[0].id;
  });

  it("SAVE MAIN LOCATION ADDRESS persists, advances updated_at and writes partner_location_updated", async () => {
    const before = await admin.query<{ updated_at: string; address_line1: string }>(
      "SELECT updated_at, address_line1 FROM partner_locations WHERE id=$1",
      [locationId]
    );
    // The live symptom: the value already looks right because CREATE wrote it, so the save must be
    // proven by a CHANGED value, an advanced timestamp and an audit event — not by the field's
    // contents alone.
    expect(before.rows[0].address_line1).toBe("2 Temple Gardens");

    const saved = await call(
      "PATCH",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop/location`,
      {
        deliveryAddress: {
          line1: "17 Corporation Street",
          line2: "Unit 4",
          city: "Rochester",
          postcode: "ME1 1NN",
          country: "United Kingdom",
        },
        reason: "owner confirmed the delivery address",
      },
      adminCookie
    );
    expect(saved.status).toBe(200);

    const after = await admin.query<{ updated_at: string; address_line1: string; address_postcode: string; address: string }>(
      "SELECT updated_at, address_line1, address_postcode, address FROM partner_locations WHERE id=$1",
      [locationId]
    );
    expect(after.rows[0].address_line1).toBe("17 Corporation Street");
    expect(after.rows[0].address_postcode).toBe("ME1 1NN");
    expect(after.rows[0].address).toContain("17 Corporation Street");
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime()
    );

    const audit = await admin.query<{ n: string }>(
      "SELECT count(*) n FROM partner_management_audit WHERE tenant_id=$1 AND action_type='partner_location_updated' AND result='succeeded'",
      [partnerId]
    );
    expect(Number(audit.rows[0].n)).toBe(1);

    // Read-back through the SAME route the console reads, not the database.
    const readBack = await call(
      "GET",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop`,
      undefined,
      adminCookie
    );
    expect(readBack.status).toBe(200);
    expect(JSON.stringify(readBack.json)).toContain("17 Corporation Street");
  });

  it("refuses the EXACT payload the console used to send, and writes nothing", async () => {
    // This is the live failure, reproduced. The inputs displayed the saved address, but the
    // mutation posted the raw edit state — empty until the operator retyped line 1. The route
    // rejects it before any write, which is why the value looked correct, updated_at never moved,
    // and no audit row was ever written for the attempt.
    const auditBefore = await admin.query<{ n: string }>(
      "SELECT count(*) n FROM partner_management_audit WHERE tenant_id=$1 AND action_type='partner_location_updated'",
      [partnerId]
    );
    const before = await admin.query<{ updated_at: string }>(
      "SELECT updated_at FROM partner_locations WHERE id=$1",
      [locationId]
    );

    const blank = await call(
      "PATCH",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop/location`,
      { deliveryAddress: { line1: "", line2: "", city: "", postcode: "", country: "" }, reason: "blank" },
      adminCookie
    );
    expect(blank.status).toBe(400);
    expect(JSON.stringify(blank.json)).toContain("deliveryAddress.line1");

    const after = await admin.query<{ updated_at: string }>(
      "SELECT updated_at FROM partner_locations WHERE id=$1",
      [locationId]
    );
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
    const auditAfter = await admin.query<{ n: string }>(
      "SELECT count(*) n FROM partner_management_audit WHERE tenant_id=$1 AND action_type='partner_location_updated'",
      [partnerId]
    );
    expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
  });

  it("refuses a HALF-filled operations contact — the shape an operator produced by editing one field", async () => {
    const nameOnly = await call(
      "PUT",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop/operations-contact`,
      { fullName: "Cornelius Oliver", email: "", reason: "half" },
      adminCookie
    );
    expect(nameOnly.status).toBe(400);
    const emailOnly = await call(
      "PUT",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop/operations-contact`,
      { fullName: "", email: "ops@save-actions.test", reason: "half" },
      adminCookie
    );
    expect(emailOnly.status).toBe(400);
  });

  it("SAVE PRIMARY OPERATIONS CONTACT persists and is returned by the read-back route", async () => {
    const saved = await call(
      "PUT",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop/operations-contact`,
      { fullName: "Cornelius Oliver", email: "ops@save-actions.test", reason: "owner confirmed the operations contact" },
      adminCookie
    );
    expect(saved.status).toBe(200);

    const rows = await admin.query<{ full_name: string; email: string; is_primary: boolean; active: boolean }>(
      "SELECT full_name, email, is_primary, active FROM partner_contacts WHERE tenant_id=$1 AND contact_type='operations' AND active=true",
      [partnerId]
    );
    // Exactly ONE active primary operations contact — an upsert must not leave two.
    expect(rows.rows.filter((r) => r.is_primary)).toHaveLength(1);
    expect(rows.rows.find((r) => r.is_primary)).toMatchObject({
      full_name: "Cornelius Oliver",
      email: "ops@save-actions.test",
    });

    const readBack = await call(
      "GET",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop`,
      undefined,
      adminCookie
    );
    expect(readBack.status).toBe(200);
    expect(JSON.stringify(readBack.json)).toContain("ops@save-actions.test");
  });

  /*
   * CREDITS & BILLING — "authentication required".
   *
   * That string is the literal 401 body from requirePartnerCapability, which fires when there is no
   * principal or mfaPassed is false. It is NOT a permissions answer (that is 403), and the Owner
   * holds partner.credits.view and partner.credits.purchase. So the question this proves is narrow:
   * does a genuinely authenticated, MFA-complete Owner session reach the credits and pack-catalogue
   * handlers on the composed application — the same composition production mounts?
   */
  it("signs the Shop #1 Owner in through the real invitation, password and MFA flow", async () => {
    // The guided flow creates the Partner PENDING and the operator activates it after review;
    // partnerLogin refuses a non-ACTIVE organisation, so the rehearsal order matters here too.
    const snapshot = await call(
      "GET",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop`,
      undefined,
      adminCookie
    );
    expect(snapshot.status).toBe(200);
    const activated = await call(
      "POST",
      `/api/super-admin/partner-management/partners/${partnerId}/status`,
      {
        status: "ACTIVE",
        expectedVersion: (snapshot.json as Record<string, unknown>).profileVersion,
        reason: "guided first-shop activation after review",
      },
      adminCookie
    );
    expect(activated.status).toBe(200);

    const invite = delivery.sent.at(-1) as { token?: string } | undefined;
    expect(typeof invite?.token).toBe("string");

    const accepted = await call("POST", "/api/partner/invitations/accept", {
      token: invite!.token,
      password: "shop-one-owner-password-1",
    });
    expect(accepted.status).toBe(200);

    const login = await call("POST", "/api/partner/auth/login", {
      email: "owner@save-actions.test",
      password: "shop-one-owner-password-1",
    });
    expect(login.status).toBe(200);
    ownerCookie = (login.setCookie ?? "").split(";")[0];
    expect(ownerCookie).toContain("mv.partner.sid=");

    // Mandatory enrolment for a newly accepted owner (P0-E), then the code challenge.
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: "shop-one-owner-password-1" }, ownerCookie);
    expect(enrol.status).toBe(200);
    const mfa = await import("../server/partner/mfa");
    const secret = String((enrol.json as Record<string, unknown>).secret);
    const confirmed = await call(
      "POST",
      "/api/partner/mfa/confirm",
      { enrolmentId: (enrol.json as Record<string, unknown>).enrolmentId, code: mfa.currentTotp(secret, Date.now()) },
      ownerCookie
    );
    expect(confirmed.status).toBe(200);

    const session = await call("GET", "/api/partner/session", undefined, ownerCookie);
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({ mfaPassed: true });
    // partner.credits.view is the capability that gates BOTH /credits and /credits/packs — the two
    // calls the Credits & Billing page makes. (Live staging additionally grants
    // partner.credits.purchase from a later RBAC migration than this harness's set applies; the
    // 401 under investigation was never a permissions answer, so view is what must be asserted.)
    expect(session.json.permissions).toEqual(expect.arrayContaining(["partner.credits.view"]));
  });

  it("serves Credits AND the pack catalogue to that same session — never 401", async () => {
    const credits = await call("GET", "/api/partner/credits", undefined, ownerCookie);
    const packs = await call("GET", "/api/partner/credits/packs", undefined, ownerCookie);
    // The exact failure being guarded: 401 "authentication required" from requirePartnerCapability.
    expect(credits.text).not.toContain("authentication required");
    expect(packs.text).not.toContain("authentication required");
    expect(credits.status).toBe(200);
    expect(packs.status).toBe(200);
    expect(Array.isArray((packs.json as Record<string, unknown>).packs)).toBe(true);
  });

  it("serves the endpoints that were already working, from the same cookie", async () => {
    // /dashboard/operations is deliberately NOT asserted here: it reads partner_stations, which
    // this partner-only migration set does not create, so it 500s for a harness reason rather than
    // an authentication one. The point of this case is the CONTRAST — another capability-gated
    // route reached on the same cookie — and onboarding-readiness makes it without that noise.
    for (const path of ["/api/partner/onboarding-readiness", "/api/partner/session"]) {
      const res = await call("GET", path, undefined, ownerCookie);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it("401s the SAME endpoints without a cookie — proving the guard is real, not bypassed", async () => {
    for (const path of ["/api/partner/credits", "/api/partner/credits/packs"]) {
      const res = await call("GET", path);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});
