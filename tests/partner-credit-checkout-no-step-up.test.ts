/**
 * Grading-credit checkout must reach Stripe without an extra MintVault password prompt.
 *
 * The prompt was never a client invention: POST /credits/checkout carried requireRecentAuth(), the
 * server answered 403 `step_up_required`, and the Portal's generic runProtected wrapper turned that
 * into the password modal. Owner decision 2026-08-22: creating a Checkout Session grants nothing —
 * price and quantity are the server's, and credits arrive only with the verified webhook — so the
 * password bought no protection Stripe was not already providing.
 *
 * What this proves is narrow and behavioural: the step-up gate is gone from checkout creation, every
 * OTHER guard on that route still refuses, and step-up still protects the routes that change who can
 * act. The money authority itself (canonical price/quantity, webhook-only granting, replay safety,
 * cross-tenant binding) is proven separately and at length in tests/partner-credit-purchase.test.ts
 * and is untouched by this change.
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

const STEP_UP = "step_up_required";
let cluster: DisposablePostgres17;
let admin: Client;
let server: http.Server;
let base = "";
let adminCookie = "";
let ownerCookie = "";
let partnerId = "";
let adminEmail = "";

async function call(method: string, path: string, body?: unknown, cookie?: string) {
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
    /* status is what matters */
  }
  const code = ((json.error as Record<string, unknown> | undefined)?.code ?? json.error ?? null) as string | null;
  return { status: res.status, json, text, code, setCookie: res.headers.get("set-cookie") };
}

describe("grading-credit checkout no longer demands a password", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-credit-checkout-no-step-up");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_CREDIT_DATABASE_URL = cluster.url;
    process.env.SESSION_SECRET ||= "credit-checkout-step-up-synthetic-secret";
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
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
    for (const t of ["users", "submissions", "submission_items", "certificates", "label_prints", "audit_log"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
      // Grants partner.credits.purchase and creates the pack catalogue.
      "0083_partner_credit_packs",
    ]);

    await admin.query("DROP ROLE IF EXISTS partner_app_test_stepup").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_stepup LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_stepup");
    process.env.PARTNER_DATABASE_URL = cluster.url.replace(/\/\/[^@/]+@/, "//partner_app_test_stepup:synthetic@");

    const authMod = await import("../server/auth");
    adminEmail = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin'",
      [adminEmail.toLowerCase()]
    );

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");
    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
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
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true) ON CONFLICT DO NOTHING"
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    adminCookie = ((await call("POST", "/__test/admin-login")).setCookie ?? "").split(";")[0];

    const created = await call(
      "POST",
      "/api/super-admin/partner-management/first-shop",
      {
        legalName: "Checkout Step Up Ltd",
        locationName: "Main location",
        deliveryAddress: { line1: "1 Pack Road", city: "London", postcode: "N1 1AA", country: "GB" },
        operationsContact: { fullName: "Ops", email: "ops@checkout-stepup.test" },
        owner: { firstName: "Buy", lastName: "Owner", email: "owner@checkout-stepup.test" },
        idempotencyKey: "checkout-step-up-create-0001",
        reason: "step-up fixture",
      },
      adminCookie
    );
    partnerId = ((created.json.result as Record<string, unknown>)?.partnerId as string) ?? "";

    const snapshot = await call(
      "GET",
      `/api/super-admin/partner-management/partners/${partnerId}/first-shop`,
      undefined,
      adminCookie
    );
    await call(
      "POST",
      `/api/super-admin/partner-management/partners/${partnerId}/status`,
      { status: "ACTIVE", expectedVersion: (snapshot.json as Record<string, unknown>).profileVersion, reason: "activate" },
      adminCookie
    );

    const invite = delivery.sent.at(-1) as { token?: string };
    await call("POST", "/api/partner/invitations/accept", { token: invite.token, password: "buy-owner-password-1" });
    const login = await call("POST", "/api/partner/auth/login", {
      email: "owner@checkout-stepup.test",
      password: "buy-owner-password-1",
    });
    ownerCookie = (login.setCookie ?? "").split(";")[0];
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: "buy-owner-password-1" }, ownerCookie);
    const mfa = await import("../server/partner/mfa");
    await call(
      "POST",
      "/api/partner/mfa/confirm",
      { enrolmentId: (enrol.json as Record<string, unknown>).enrolmentId, code: mfa.currentTotp(String((enrol.json as Record<string, unknown>).secret), Date.now()) },
      ownerCookie
    );
  }, 180_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("has an authenticated, MFA-complete Owner holding the purchase capability", async () => {
    const s = await call("GET", "/api/partner/session", undefined, ownerCookie);
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ mfaPassed: true });
    expect(s.json.permissions).toEqual(expect.arrayContaining(["partner.credits.purchase"]));
  });

  it("BUY does NOT answer step_up_required — the password gate is gone from checkout creation", async () => {
    const res = await call("POST", "/api/partner/credits/checkout", { packCode: "PACK_5" }, ownerCookie);
    // The whole defect in one assertion: this session has never performed a step-up.
    expect(res.code).not.toBe(STEP_UP);
    expect(res.text).not.toContain(STEP_UP);
    expect(res.text.toLowerCase()).not.toContain("confirm your password");
    // Reaching Stripe configuration proves the request passed capability, role, view-only and
    // sensitive-freeze — every gate that protects the money — with no password in between.
    expect(res.status).not.toBe(403);
  });

  it("still refuses an unauthenticated caller", async () => {
    const res = await call("POST", "/api/partner/credits/checkout", { packCode: "PACK_5" });
    expect(res.status).toBe(401);
    expect(res.code).not.toBe(STEP_UP);
  });

  it("still refuses a session whose role lacks the purchase capability", async () => {
    await admin.query(
      `DELETE FROM partner_role_permissions rp USING partner_permissions p, partner_roles r
        WHERE rp.permission_id=p.id AND rp.role_id=r.id AND p.code='partner.credits.purchase' AND r.code='PARTNER_OWNER'`
    );
    const res = await call("POST", "/api/partner/credits/checkout", { packCode: "PACK_5" }, ownerCookie);
    expect(res.status).toBe(403);
    // Refused for the honest reason, not by asking for a password that would not help.
    expect(res.code).not.toBe(STEP_UP);
    await admin.query(
      `INSERT INTO partner_role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM partner_roles r, partner_permissions p
        WHERE r.code='PARTNER_OWNER' AND p.code='partner.credits.purchase'
       ON CONFLICT DO NOTHING`
    );
  });

  it("still refuses when the Partner is no longer ACTIVE", async () => {
    await admin.query("UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1", [partnerId]);
    const res = await call("POST", "/api/partner/credits/checkout", { packCode: "PACK_5" }, ownerCookie);
    // A suspended organisation invalidates the session itself (session.ts fails closed on org status).
    expect([401, 403]).toContain(res.status);
    expect(res.code).not.toBe(STEP_UP);
    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [partnerId]);
  });

  it("derives the tenant from the session, so a cross-tenant purchase is not expressible", async () => {
    // There is no tenant input on this route: the body carries a pack code and nothing else.
    const routes = (await import("node:fs")).readFileSync("server/partner/routes.ts", "utf8");
    const route = routes.slice(routes.indexOf('"/credits/checkout"'), routes.indexOf('"/credits/checkout"') + 4000);
    expect(route).toContain("const principal = req.partner!;");
    expect(route).not.toMatch(/req\.body\?\.(tenantId|partnerId)/);
  });

  it("KEEPS step-up on the routes that change who can act", async () => {
    // Case 13. Same session, same absence of a step-up proof — these must still demand one.
    const invite = await call(
      "POST",
      "/api/partner/users",
      { email: "someone@checkout-stepup.test", firstName: "A", lastName: "B", role: "PARTNER_MANAGER", reason: "x" },
      ownerCookie
    );
    expect(invite.status).toBe(403);
    expect(invite.code).toBe(STEP_UP);
  });
});
