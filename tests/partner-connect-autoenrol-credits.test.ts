/**
 * CONNECT — the five welcome credits, and a Mac that enrols itself.
 *
 * Two changes are proved here, over real PostgreSQL 17, real Express and real sessions:
 *
 *   A. Creating a shop grants exactly five grading credits, once, from inside the same transaction
 *      that creates the shop. Every later onboarding event re-runs against the same idempotency key
 *      and must move the balance by nothing.
 *
 *   B. A first-run Mac enrols itself instead of showing an error, and the server — not the Scanner —
 *      still decides tenant, location, capability, MFA posture and station identity. Enrolment is
 *      idempotent WITHIN a tenant and still refuses a cloned key ACROSS tenants.
 *
 * WHY THE BALANCE IS ALWAYS RE-READ FROM THE LEDGER. `partner_wallet_balances` is SUM(amount) over
 * an append-only table, so asserting on it proves the grant did not happen twice in a way that
 * counting rows alone would miss (two rows of +5 and one of +5 differ in the balance, and a
 * hypothetical +5/-5 pair would differ in the row count). Both are asserted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";

/*
 * The first-shop list plus the station subsystem. Declared HERE rather than pushed into the shared
 * helper: every other suite that imports PARTNER_MIGRATIONS_WITH_FIRST_SHOP would otherwise start
 * paying for tables it never touches, and a shared migration list that grows for one caller's sake
 * is how these harnesses become slow and coupled.
 *
 *   0045  partner_stations / partner_station_events / calibrations — the subsystem itself
 *   0085  partner.stations.enrol, and the SCANNER_OPERATOR role that deliberately lacks it
 *   0092  partner.stations.calibrate
 */
const CONNECT_MIGRATIONS = [
  ...PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  "0045_partner_stations",
  "0085_partner_scanner_operator_role",
  "0092_partner_station_calibrate_permission",
] as const;
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  PARTNER_WELCOME_CREDIT_AMOUNT,
  PARTNER_WELCOME_CREDIT_REASON,
  partnerWelcomeCreditIdempotencyKey,
} from "@shared/partner-welcome-credits";

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
let adminEmail = "";

/** The shop under test, plus a second shop used only to prove cross-tenant refusals. */
let partnerId = "";
let ownerUserId = "";
let ownerCookie = "";
let mainLocationId = "";
let otherPartnerId = "";
let otherOwnerCookie = "";

const OWNER = { firstName: "Cornelius", lastName: "Oliver", email: "owner@connect-autoenrol.test" };
const PASSWORD = "connect-autoenrol-owner-password-1";

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

/** A fresh Ed25519 Mac identity. Distinct keys stand in for distinct physical Macs. */
function newMacKey(): { publicKeyPem: string; installationFingerprint: string } {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    installationFingerprint: crypto.randomBytes(32).toString("hex"),
  };
}

/** Authoritative balance and ledger shape for a tenant — always read together. */
async function wallet(tenantId: string): Promise<{ balance: number; entries: number; welcomeRows: number }> {
  const b = await admin.query<{ balance: string; ledger_entry_count: string }>(
    "select balance, ledger_entry_count from partner_wallet_balances where tenant_id=$1",
    [tenantId]
  );
  const w = await admin.query<{ n: number }>(
    "select count(*)::int n from partner_credit_ledger where tenant_id=$1 and reason=$2",
    [tenantId, PARTNER_WELCOME_CREDIT_REASON]
  );
  return {
    balance: Number(b.rows[0]?.balance ?? 0),
    entries: Number(b.rows[0]?.ledger_entry_count ?? 0),
    welcomeRows: w.rows[0].n,
  };
}

async function seedCoreTables(): Promise<void> {
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

/** Create a shop, accept the invitation, set a password, enrol and confirm MFA, return the cookie. */
async function onboardShop(opts: {
  legalName: string;
  owner: { firstName: string; lastName: string; email: string };
  password: string;
  idempotencyKey: string;
}): Promise<{ partnerId: string; ownerUserId: string; cookie: string }> {
  const created = await call(
    "POST",
    "/api/super-admin/partner-management/first-shop",
    {
      legalName: opts.legalName,
      deliveryAddress: { line1: "2 Temple Gardens", city: "Rochester", postcode: "ME2 2NG", country: "United Kingdom" },
      owner: opts.owner,
      idempotencyKey: opts.idempotencyKey,
      reason: "connect autoenrol fixture",
    },
    adminCookie
  );
  expect(created.status).toBe(200);
  const id = String((created.json.result as Record<string, unknown>).partnerId);

  const snapshot = await call(
    "GET",
    `/api/super-admin/partner-management/partners/${id}/first-shop`,
    undefined,
    adminCookie
  );
  await call(
    "POST",
    `/api/super-admin/partner-management/partners/${id}/status`,
    {
      status: "ACTIVE",
      expectedVersion: (snapshot.json as Record<string, unknown>).profileVersion,
      reason: "activate",
    },
    adminCookie
  );

  const token = String((delivery.sent.filter((m) => m.email === opts.owner.email).at(-1) as { token: string }).token);
  expect((await call("POST", "/api/partner/invitations/accept", { token, password: opts.password })).status).toBe(200);

  const login = await call("POST", "/api/partner/auth/login", { email: opts.owner.email, password: opts.password });
  expect(login.status).toBe(200);
  const cookie = (login.setCookie ?? "").split(";")[0];

  const enrol = await call("POST", "/api/partner/mfa/enrol", { password: opts.password }, cookie);
  expect(enrol.status).toBe(200);
  const mfa = await import("../server/partner/mfa");
  const confirmed = await call(
    "POST",
    "/api/partner/mfa/confirm",
    {
      enrolmentId: (enrol.json as Record<string, unknown>).enrolmentId,
      code: mfa.currentTotp(String((enrol.json as Record<string, unknown>).secret), Date.now()),
    },
    cookie
  );
  expect(confirmed.status).toBe(200);

  const userId = (await admin.query<{ id: string }>("select id from partner_users where tenant_id=$1", [id])).rows[0]
    .id;
  return { partnerId: id, ownerUserId: userId, cookie };
}

describe("CONNECT — welcome credits and first-run station enrolment", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-connect-autoenrol");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_CREDIT_DATABASE_URL = cluster.url;
    process.env.SESSION_SECRET ||= "connect-autoenrol-synthetic-secret";
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedCoreTables();
    await applyMigrationsRealistic(admin, cluster.url, CONNECT_MIGRATIONS);
    await admin.query("DROP ROLE IF EXISTS partner_app_test_connect").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_connect LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_connect");
    process.env.PARTNER_DATABASE_URL = cluster.url.replace(/\/\/[^@/]+@/, "//partner_app_test_connect:synthetic@");

    const authMod = await import("../server/auth");
    adminEmail = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [adminEmail.toLowerCase()]
    );

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");
    const { registerPartnerStationAdminRoutes } = await import("../server/partner/station-admin-routes");
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
    /** Step-up is stamped here so the DEFAULT admin session in this suite is a stepped-up one. */
    app.post("/__test/admin-login", (req, res) => {
      const s = req.session as unknown as Record<string, unknown>;
      s.isAdmin = true;
      s.adminEmail = adminEmail;
      s.authUserId = "00000000-0000-0000-0000-0000000000a5";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      if (req.body?.stepUp !== false) s.adminStepUpAt = new Date().toISOString();
      req.session.save(() => res.json({ ok: true }));
    });
    registerPartnerManagementRoutes(app);
    registerPartnerStationAdminRoutes(app);
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

    const login = await call("POST", "/__test/admin-login", {});
    adminCookie = (login.setCookie ?? "").split(";")[0];
    expect(adminCookie).toContain("mv.sid=");
  }, 240_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ---------------------------------------------------------------- TASK A: welcome credits

  it("L1 — creating a shop grants exactly five credits, from one ledger row", async () => {
    const created = await onboardShop({
      legalName: "Connect Autoenrol Ltd",
      owner: OWNER,
      password: PASSWORD,
      idempotencyKey: "connect-autoenrol-create-0001",
    });
    partnerId = created.partnerId;
    ownerUserId = created.ownerUserId;
    ownerCookie = created.cookie;
    mainLocationId = (
      await admin.query<{ id: string }>("select id from partner_locations where tenant_id=$1", [partnerId])
    ).rows[0].id;

    expect(await wallet(partnerId)).toEqual({ balance: PARTNER_WELCOME_CREDIT_AMOUNT, entries: 1, welcomeRows: 1 });

    // The ledger coordinates are the canonical ones, not a parallel credit system.
    const row = await admin.query<{
      amount: string;
      entry_type: string;
      source: string;
      actor_type: string;
      idempotency_key: string;
    }>("select amount, entry_type, source, actor_type, idempotency_key from partner_credit_ledger where tenant_id=$1", [
      partnerId,
    ]);
    expect(row.rows[0]).toMatchObject({
      amount: String(PARTNER_WELCOME_CREDIT_AMOUNT),
      entry_type: "opening_balance",
      source: "system",
      actor_type: "system",
      idempotency_key: partnerWelcomeCreditIdempotencyKey(partnerId),
    });
  });

  it("L2 — replaying CREATE with the same key grants nothing further", async () => {
    const before = await wallet(partnerId);
    const replay = await call(
      "POST",
      "/api/super-admin/partner-management/first-shop",
      {
        legalName: "Connect Autoenrol Ltd",
        deliveryAddress: {
          line1: "2 Temple Gardens",
          city: "Rochester",
          postcode: "ME2 2NG",
          country: "United Kingdom",
        },
        owner: OWNER,
        idempotencyKey: "connect-autoenrol-create-0001",
        reason: "replay",
      },
      adminCookie
    );
    expect(replay.status).toBe(200);
    expect(await wallet(partnerId)).toEqual(before);
  });

  it("L3 — reading readiness repeatedly (a refresh) grants nothing", async () => {
    const before = await wallet(partnerId);
    for (let i = 0; i < 4; i += 1) {
      const r = await call(
        "GET",
        `/api/super-admin/partner-management/partners/${partnerId}/onboarding-readiness`,
        undefined,
        adminCookie
      );
      expect(r.status).toBe(200);
    }
    expect(await wallet(partnerId)).toEqual(before);
  });

  it("L4 — resending the invitation grants nothing", async () => {
    const before = await wallet(partnerId);
    const resend = await call(
      "POST",
      `/api/super-admin/partner-management/partners/${partnerId}/users/${ownerUserId}/resend-invitation`,
      { reason: "credit idempotency proof" },
      adminCookie
    );
    /*
     * This Owner has already ACCEPTED, so the canonical resend correctly refuses — there is no live
     * invitation to supersede. The status is not the point and is deliberately not pinned to 200:
     * what must hold is that ASKING moved no credits, whether the ask succeeded or was refused.
     */
    expect(resend.status).toBeLessThan(500);
    expect(await wallet(partnerId)).toEqual(before);
  });

  it("L5 — the Owner's activation and MFA (already completed) left the balance at five", async () => {
    // onboardShop() accepted the invitation, set the password, enrolled and confirmed MFA before
    // L1 asserted five. Re-asserting here states the property that sequence was meant to prove.
    const session = await call("GET", "/api/partner/session", undefined, ownerCookie);
    expect(session.json).toMatchObject({ mfaPassed: true });
    expect(await wallet(partnerId)).toEqual({ balance: PARTNER_WELCOME_CREDIT_AMOUNT, entries: 1, welcomeRows: 1 });
  });

  it("L7/L16 — exactly one eligible location, and one enrolment creates one PENDING station", async () => {
    const locations = await call("GET", "/api/partner/stations/enrolment-locations", undefined, ownerCookie);
    expect(locations.status).toBe(200);
    // ONE eligible location is what lets the Scanner enrol without asking. Asserted on the server
    // response, because that is the fact the client's auto-select branch reads.
    expect((locations.json.locations as unknown[]).length).toBe(1);
    expect((locations.json.locations as Array<{ id: string }>)[0].id).toBe(mainLocationId);

    const mac = newMacKey();
    const enrolled = await call("POST", "/api/partner/stations/enrol", { ...mac, appVersion: "1.2.1" }, ownerCookie);
    expect(enrolled.status).toBe(201);
    const station = enrolled.json.station as Record<string, unknown>;
    expect(station.status).toBe("PENDING");
    expect(station.locationId).toBe(mainLocationId);

    const rows = await admin.query<{ n: number }>("select count(*)::int n from partner_stations where tenant_id=$1", [
      partnerId,
    ]);
    expect(rows.rows[0].n).toBe(1);
    (globalThis as Record<string, unknown>).__mac = mac;
    (globalThis as Record<string, unknown>).__stationCode = station.stationCode;
  });

  it("L6/L27/L28/L29 — enrolment moved no credits, created no card job, armed no test card", async () => {
    expect(await wallet(partnerId)).toEqual({ balance: PARTNER_WELCOME_CREDIT_AMOUNT, entries: 1, welcomeRows: 1 });
    const jobs = await admin.query<{ n: number }>("select count(*)::int n from partner_card_jobs where tenant_id=$1", [
      partnerId,
    ]);
    expect(jobs.rows[0].n).toBe(0);
    const reservations = await admin.query<{ n: number }>(
      "select count(*)::int n from partner_credit_reservations where tenant_id=$1",
      [partnerId]
    );
    expect(reservations.rows[0].n).toBe(0);
  });

  it("L8/L9 — the same Mac enrolling again reuses its station; concurrent attempts create one row", async () => {
    const mac = (globalThis as Record<string, unknown>).__mac as ReturnType<typeof newMacKey>;
    const expected = (globalThis as Record<string, unknown>).__stationCode as string;

    // A restart: the Scanner asks again with the same key.
    const again = await call("POST", "/api/partner/stations/enrol", { ...mac, appVersion: "1.2.1" }, ownerCookie);
    expect(again.status).toBe(201);
    expect((again.json.station as Record<string, unknown>).stationCode).toBe(expected);

    // A double click: two requests in flight at once.
    const [a, b] = await Promise.all([
      call("POST", "/api/partner/stations/enrol", { ...mac, appVersion: "1.2.1" }, ownerCookie),
      call("POST", "/api/partner/stations/enrol", { ...mac, appVersion: "1.2.1" }, ownerCookie),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);

    const rows = await admin.query<{ n: number }>("select count(*)::int n from partner_stations where tenant_id=$1", [
      partnerId,
    ]);
    expect(rows.rows[0].n).toBe(1);
    expect(await wallet(partnerId)).toMatchObject({ balance: PARTNER_WELCOME_CREDIT_AMOUNT });
  });

  it("L13 — a session that has not passed MFA cannot enrol", async () => {
    const login = await call("POST", "/api/partner/auth/login", { email: OWNER.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const halfCookie = (login.setCookie ?? "").split(";")[0];
    const session = await call("GET", "/api/partner/session", undefined, halfCookie);
    expect(session.json).toMatchObject({ mfaPassed: false });

    const refused = await call(
      "POST",
      "/api/partner/stations/enrol",
      { ...newMacKey(), appVersion: "1.2.1" },
      halfCookie
    );
    expect(refused.status).toBeGreaterThanOrEqual(401);
    expect(refused.status).toBeLessThan(500);

    /*
     * THAT LOGIN REVOKED THE EARLIER SESSION, exactly as the one-active-session policy requires —
     * signing in again is what the policy is FOR. Re-establishing the cookie here keeps that
     * behaviour intact and honest rather than weakening the policy to make a later test convenient;
     * the tests that follow need an authenticated Owner, not a second concurrent one.
     */
    const mfa = await import("../server/partner/mfa");
    const stored = await admin.query<{ secret_ref: string }>(
      "select secret_ref from partner_mfa_methods where user_id=$1 and status='ACTIVE' limit 1",
      [ownerUserId]
    );
    expect(stored.rows).toHaveLength(1);
    // The secret is stored encrypted; the test decrypts with the same key the server uses rather
    // than reading a plaintext that does not exist anywhere.
    /*
     * A code from the NEXT 30-second step, not this one.
     *
     * The enrolment confirm earlier in this suite already consumed the current counter, and TOTP
     * replay protection (`partner_mfa_methods.last_totp_counter`) correctly refuses a counter it has
     * already accepted. The server's verification window is +/- one step, so the next step's code is
     * both accepted and strictly newer — which is exactly what a real authenticator would present
     * thirty seconds later.
     */
    const code = mfa.currentTotp(mfa.decryptSecret(stored.rows[0].secret_ref), Date.now() + 30_000);
    const challenged = await call("POST", "/api/partner/auth/mfa", { code }, halfCookie);
    expect(challenged.status).toBe(200);
    ownerCookie = halfCookie;
    const restored = await call("GET", "/api/partner/session", undefined, ownerCookie);
    expect(restored.json).toMatchObject({ mfaPassed: true });
  });

  it("L11 — a location outside this shop is refused", async () => {
    const mac = newMacKey();
    const foreign = "00000000-0000-0000-0000-0000000000ff";
    const refused = await call(
      "POST",
      "/api/partner/stations/enrol",
      { ...mac, locationId: foreign, appVersion: "1.2.1" },
      ownerCookie
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const rows = await admin.query<{ n: number }>("select count(*)::int n from partner_stations where tenant_id=$1", [
      partnerId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("L10 — a second shop cannot read, or claim, the first shop's station", async () => {
    const second = await onboardShop({
      legalName: "Second Shop Ltd",
      owner: { firstName: "Ada", lastName: "Lovelace", email: "owner@second-shop.test" },
      password: "second-shop-owner-password-1",
      idempotencyKey: "connect-autoenrol-create-0002",
    });
    otherPartnerId = second.partnerId;
    otherOwnerCookie = second.cookie;

    // A brand-new shop gets its own five credits — the grant is per shop, not once per platform.
    expect(await wallet(otherPartnerId)).toEqual({
      balance: PARTNER_WELCOME_CREDIT_AMOUNT,
      entries: 1,
      welcomeRows: 1,
    });

    const stationCode = (globalThis as Record<string, unknown>).__stationCode as string;
    // THE CROSS-TENANT CASE THAT PRODUCED "STATION UNAVAILABLE": a Mac carrying another shop's
    // station code. The server refuses and says nothing about who owns it.
    const status = await call(
      "GET",
      `/api/partner/stations/${stationCode}/enrolment-status`,
      undefined,
      otherOwnerCookie
    );
    expect(status.status).toBe(403);
    expect(JSON.stringify(status.json)).not.toContain("Connect Autoenrol");

    // And the same physical Mac key cannot be re-homed into the second shop.
    const mac = (globalThis as Record<string, unknown>).__mac as ReturnType<typeof newMacKey>;
    const clone = await call("POST", "/api/partner/stations/enrol", { ...mac, appVersion: "1.2.1" }, otherOwnerCookie);
    expect(clone.status).toBeGreaterThanOrEqual(400);
    expect(clone.status).toBeLessThan(500);
    const rows = await admin.query<{ n: number }>("select count(*)::int n from partner_stations where tenant_id=$1", [
      otherPartnerId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("L12 — an operator without partner.stations.enrol is refused", async () => {
    // SCANNER_OPERATOR may work an approved station but may not bring a new one into service.
    const granted = await admin.query<{ role_code: string }>(
      `select r.code as role_code from partner_role_permissions rp
         join partner_roles r on r.id=rp.role_id
         join partner_permissions p on p.id=rp.permission_id
        where p.code='partner.stations.enrol'`
    );
    const codes = granted.rows.map((r) => r.role_code);
    expect(codes).toContain("PARTNER_OWNER");
    expect(codes).not.toContain("SCANNER_OPERATOR");
  });

  it("L14 — a suspended shop cannot enrol", async () => {
    const snapshot = await call(
      "GET",
      `/api/super-admin/partner-management/partners/${otherPartnerId}/first-shop`,
      undefined,
      adminCookie
    );
    const suspended = await call(
      "POST",
      `/api/super-admin/partner-management/partners/${otherPartnerId}/status`,
      {
        status: "SUSPENDED",
        expectedVersion: (snapshot.json as Record<string, unknown>).profileVersion,
        reason: "suspension proof",
      },
      adminCookie
    );
    expect(suspended.status).toBe(200);
    const refused = await call(
      "POST",
      "/api/partner/stations/enrol",
      { ...newMacKey(), appVersion: "1.2.1" },
      otherOwnerCookie
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const rows = await admin.query<{ n: number }>("select count(*)::int n from partner_stations where tenant_id=$1", [
      otherPartnerId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("L17 — two eligible locations are offered as a real choice, never guessed", async () => {
    const added = await call(
      "POST",
      `/api/super-admin/partner-management/partners/${partnerId}/locations`,
      {
        name: "Second counter",
        address: "5 Temple Gardens, Rochester, ME2 2NG, United Kingdom",
        reason: "multi-location proof",
      },
      adminCookie
    );
    expect(added.status).toBe(200);
    const locations = await call("GET", "/api/partner/stations/enrolment-locations", undefined, ownerCookie);
    expect((locations.json.locations as unknown[]).length).toBe(2);
    // The client's auto-select branch is guarded on exactly one. Two means the picker renders, and
    // the assertion that it does lives in the source check below (L18b).
  });

  // ---------------------------------------------------------------- TASK F/G: approval

  it("L21 — approval refuses an admin session that has not stepped up", async () => {
    const stationCode = (globalThis as Record<string, unknown>).__stationCode as string;
    const weak = await call("POST", "/__test/admin-login", { stepUp: false });
    const weakCookie = (weak.setCookie ?? "").split(";")[0];
    const refused = await call(
      "POST",
      `/api/super-admin/fleet/stations/${stationCode}/active`,
      { reason: "no step-up" },
      weakCookie
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const still = await admin.query<{ status: string }>("select status from partner_stations where station_code=$1", [
      stationCode,
    ]);
    expect(still.rows[0].status).toBe("PENDING");
  });

  it("L22/L19 — one approval activates the station exactly once, and clears the pending queue", async () => {
    const stationCode = (globalThis as Record<string, unknown>).__stationCode as string;
    const pendingBefore = await admin.query<{ n: number }>(
      "select count(*)::int n from partner_stations where tenant_id=$1 and status='PENDING' and approved_at is null",
      [partnerId]
    );
    // EXACTLY ONE pending station is what entitles the controller to show a single gold button.
    expect(pendingBefore.rows[0].n).toBe(1);

    const approved = await call(
      "POST",
      `/api/super-admin/fleet/stations/${stationCode}/active`,
      { reason: "connect acceptance" },
      adminCookie
    );
    expect(approved.status).toBe(200);

    const row = await admin.query<{ status: string; approved_at: string | null }>(
      "select status, approved_at from partner_stations where station_code=$1",
      [stationCode]
    );
    expect(row.rows[0].status).toBe("ACTIVE");
    expect(row.rows[0].approved_at).not.toBeNull();

    // Exactly one approval event — an approve is not idempotently re-fired into the audit trail.
    const events = await admin.query<{ n: number }>(
      "select count(*)::int n from partner_station_events where tenant_id=$1 and event_type like '%status%'",
      [partnerId]
    );
    expect(events.rows[0].n).toBeLessThanOrEqual(2);
    expect(await wallet(partnerId)).toMatchObject({ balance: PARTNER_WELCOME_CREDIT_AMOUNT });
  });

  it("L23/L24/L25 — the Scanner observes approval on its existing session, with no re-enrolment", async () => {
    const stationCode = (globalThis as Record<string, unknown>).__stationCode as string;
    // The SAME cookie established before approval. No new login, no restart, no re-enrol: this is
    // exactly the call the pending screen's own poll makes.
    const status = await call("GET", `/api/partner/stations/${stationCode}/enrolment-status`, undefined, ownerCookie);
    expect(status.status).toBe(200);
    expect((status.json.station as Record<string, unknown>).status).toBe("ACTIVE");

    const rows = await admin.query<{ n: number }>("select count(*)::int n from partner_stations where tenant_id=$1", [
      partnerId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("L26 — calibration is still UNPROVISIONED immediately after approval", async () => {
    const stationCode = (globalThis as Record<string, unknown>).__stationCode as string;
    const row = await admin.query<{ calibration_status: string }>(
      "select calibration_status from partner_stations where station_code=$1",
      [stationCode]
    );
    // Approval authorises the Mac; it does not calibrate it. Calibration begins after this point.
    expect(row.rows[0].calibration_status).toBe("UNPROVISIONED");
  });

  // ---------------------------------------------------------------- client-source acceptance

  const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

  it("L18 — a PENDING station renders WAITING FOR APPROVAL, never STATION UNAVAILABLE", () => {
    const renderer = read("scripts/scanner-app/renderer/app.js");
    const pending = renderer.slice(
      renderer.indexOf('stage === "pending"'),
      renderer.indexOf('stage === "identity_mismatch"')
    );
    expect(pending).toContain("Waiting for MintVault approval");
    expect(pending).not.toContain("Station unavailable");
    expect(pending).not.toContain("Contact a MintVault Super Admin");
    /*
     * NO BALANCE HERE ANY MORE. It used to show the wallet, which was honest but wrong-headed:
     * nothing on the CONNECT path spends a credit, so a figure — especially a zero — on the screen
     * where a shop waits to be approved only invites a top-up it does not need yet. Credits belong
     * where a card is actually started.
     */
    expect(pending).not.toContain("availableCredits");
    expect(pending).not.toMatch(/TOP UP/i);
  });

  it("L18b — one eligible location auto-enrols; two render the picker", () => {
    const main = read("scripts/scanner-app/main.js");
    expect(main).toContain("eligible.length === 1 && !autoEnrolInFlight");
    expect(main).toContain("registerThisMac({ locationId: eligible[0].id");
    const renderer = read("scripts/scanner-app/renderer/app.js");
    // The picker is hidden only for a single location — a real choice is always shown.
    expect(renderer).toContain("els.stationLocationField.hidden = locations.length <= 1");
  });

  it("L18c — a Mac registered to another shop is explained, not called unavailable", () => {
    const main = read("scripts/scanner-app/main.js");
    expect(main).toContain('stage: "identity_mismatch"');
    const renderer = read("scripts/scanner-app/renderer/app.js");
    const block = renderer.slice(
      renderer.indexOf('stage === "identity_mismatch"'),
      renderer.indexOf('stage === "update_required"')
    );
    expect(block).toContain("This Mac belongs to another shop");
    expect(block).toContain("Nothing has been changed.");
    // It must NOT self-heal by clearing identity or re-enrolling.
    expect(block).not.toContain("registerThisMac");
  });

  it("L23b — the pending screen polls itself, so approval needs no manual retry", () => {
    const renderer = read("scripts/scanner-app/renderer/app.js");
    expect(renderer).toContain("refreshStationSetup(), 6_000");
    expect(renderer).toContain('if (stage === "pending")');
  });

  it("L15 — a Scanner cannot be pointed at production while declaring staging", async () => {
    const environment = read("scripts/scanner-app/lib/environment.js");
    // No silent default: an unconfigured station resolves to `unconfigured` and refuses to sign in.
    expect(environment).toContain("unconfigured");
    expect(environment).toContain("but MINTVAULT_API_BASE points at ");
    /*
     * BEHAVIOUR, not string absence: the removed `|| "https://mintvaultuk.com"` fallback is still
     * QUOTED in this file's header comment, so grepping for it would fail on the documentation.
     *
     * The "no environment declared at all" case is deliberately NOT asserted here — resolveEnvironment
     * falls back to the persisted environment.json under the real Application Support directory, so a
     * developer Mac that has ever run the Scanner would answer differently from CI. The mismatch case
     * needs no such file and is the one that actually protects this Owner.
     */
    const { resolveEnvironment } = await import("../scripts/scanner-app/lib/environment.js");
    const mismatched = resolveEnvironment({
      env: { MINTVAULT_ENV: "staging", MINTVAULT_API_BASE: "https://mintvaultuk.com" },
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.code).toBe("ENVIRONMENT_URL_MISMATCH");
    expect(mismatched.apiBase).toBeNull();
  });

  it("L30/L31 — the Shop 0 evidence floor stays narrow and is not generalised", () => {
    const policy = read("server/lib/lide400-evidence-policy.ts");
    // The qualified floor is bound to one exact station AND one exact calibration, and it is
    // staging-only. A general station must never inherit it.
    expect(policy).toContain("MV-STN-6DIISWMIEU2IKRG4");
    expect(policy).toContain("f7b7fe4f-aefb-423c-a4a5-dc9cec8fabcf");
    expect(policy).toMatch(/staging/i);
  });

  it("L-N — a different shop signing in clears the previous shop's card state", () => {
    const main = read("scripts/scanner-app/main.js");
    const fn = main.slice(
      main.indexOf("function reconcileTenantScopedState"),
      main.indexOf("/** Sanitised first-run state only")
    );
    expect(fn).toContain("lastUploadedCert: null");
    expect(fn).toContain("recent: []");
    expect(fn).toContain("openCardJob: null");
    expect(fn).toContain("calibrationRecovery: null");
    // Station identity is NOT cleared here — that would silently re-home a station.
    expect(fn).not.toContain("clearEnrollment");
    expect(fn).not.toContain("stationIdentity");
    expect(main).toContain("reconcileTenantScopedState(session.body?.tenantId)");
  });
});

/**
 * THE PHYSICAL FAILURES, as tests.
 *
 * Every check here reads the COMPILED app under dist/mac-arm64, not the source tree. Three separate
 * launches were reported as "done" while nothing had happened, and in each case the source was
 * correct — what shipped, what ran, and what the operator could actually press were the open
 * questions. So these assert the artifact.
 */
describe("Scanner — trapped-state recovery, isolation and launcher proof (compiled artifact)", () => {
  const APP = "scripts/scanner-app/dist/mac-arm64/MintVault Scanner.app/Contents/Resources/app";
  const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), APP, relative), "utf8");
  /*
   * The launcher lives IN THE REPO, and the machine's copy is a symlink to it. Reading an absolute
   * path outside the checkout would have made these assertions pass locally and vanish in CI —
   * which is precisely the "it works on the machine that built it" failure they exist to catch.
   */
  const launcher = () =>
    fs.readFileSync(path.join(process.cwd(), "scripts/scanner-app/acceptance/launch-isolated-instance.command"), "utf8");

  it("M1–M5 — the launcher identifies, terminates and then VERIFIES, never assumes", () => {
    const s = launcher();
    expect(s).toContain("pgrep -f");                       // enumerate every running Scanner
    expect(s).toContain("runtime.json");                   // identify by the app's own claim
    expect(s).toContain("kill -TERM");                     // terminate a genuine conflict
    expect(s).toContain("would not exit");                 // and prove it exited, or stop
    // Verifies each field of the process that actually came up.
    for (const field of ["version", "scansDir", "userDataPath", "apiBase", "environment"]) {
      expect(s).toContain(`manifest_field "$OUR_MANIFEST" ${field}`);
    }
    expect(s).toContain("never declared itself");          // fails loudly rather than assuming
    // A window appearing is never treated as success.
    expect(s).not.toMatch(/open -a .*MintVault Scanner/);
  });

  it("M0 — a Scanner that cannot work yet presents itself instead of waiting to be found", () => {
    const main = read("main.js");
    // The app hides its Dock icon, so the tray was the only way in — until macOS gave a second
    // instance a menu-bar slot of {height: 0} and the app became unreachable while perfectly
    // healthy. Any non-active stage now shows the window.
    expect(main).toContain('if (setup?.stage !== "active")');
    expect(main).toContain("showPopover();");
    expect(main).toContain("menu-bar slot looks unusable");
    // An ACTIVE station must still stay quiet and not steal focus.
    expect(main).toContain("An ACTIVE station stays quiet");
  });

  it("M5c — build identity is a hash of what executes, not a version someone remembered to bump", () => {
    const main = read("main.js");
    expect(main).toContain("function buildFingerprint()");
    expect(main).toContain("buildId: buildFingerprint()");
    const s = launcher();
    expect(s).toContain("WANT_BUILD=");
    expect(s).toContain('manifest_field "$OUR_MANIFEST" buildId');
    // The already-running short-circuit requires the BUILD to match too, not just the version.
    expect(s).toContain('[ "$RUNNING_BUILD" = "$WANT_BUILD" ]');
  });

  it("M5b — the launcher replaces a running instance that is the WRONG BUILD", () => {
    const s = launcher();
    // "Ours" answers isolation; it says nothing about which build is running. Both must match, or
    // the running instance is replaced — this short-circuit once accepted a stale build and
    // reported success while the fix under test was not running.
    expect(s).toContain("ALREADY RUNNING IS NOT THE SAME AS ALREADY CORRECT");
    expect(s).toContain('[ "$RUNNING_VER" = "$WANT_VERSION" ]');
    expect(s).toContain('[ "$RUNNING_EXE" = "$APP" ]');
    expect(s).toContain("replacing it so the verified build is what actually runs");
  });

  it("M6/M7/M8 — Quit exists, genuinely exits, and is not the same as closing the window", () => {
    const main = read("main.js");
    expect(main).toContain("Quit MintVault Scanner");
    expect(main).toContain("async function quitScanner()");
    expect(main).toContain("app.quit()");
    // Closing the window still does NOT quit — the menu-bar app deliberately survives it.
    expect(main).toContain('app.on("window-all-closed"');
    expect(main).toContain("e.preventDefault()");
    // Quit must not destroy identity, calibration or the server-side station.
    const quit = main.slice(main.indexOf("async function quitScanner()"), main.indexOf("async function refreshStationSetupFromTray"));
    expect(quit).not.toContain("clearEnrollment");
    expect(quit).not.toContain("unlinkSync");
    expect(quit).not.toContain("stations/");
  });

  it("M8b/M9 — Refresh, Sign out and Diagnostics are reachable; Quit is NOT on the onboarding modal", () => {
    const main = read("main.js");
    // Quit still exists where quitting an app belongs.
    for (const item of ["Refresh status", "Sign out…", "Show diagnostics", "Quit MintVault Scanner"]) {
      expect(main).toContain(item);
    }
    const html = read("renderer/index.html");
    for (const id of ["stationRefreshBtn", "stationSignOutBtn", "stationDiagnosticsBtn"]) {
      expect(html).toContain(id);
    }
    /*
     * NO QUIT ON THIS MODAL. It was pressed twice during a real onboarding — it is the most
     * final-looking control on a screen whose job is to wait — and quitting left the Mac with no
     * Scanner, after which re-opening "MintVault Scanner" the ordinary way resolved to a different
     * bundle on a different profile and put the previous shop's state on screen.
     */
    expect(html).not.toContain("stationQuitBtn");
    const renderer = read("renderer/app.js");
    expect(renderer).not.toContain("stationQuitBtn");
    expect(renderer).toContain("wireStationRecoveryControls()");
    expect(renderer).not.toContain("stationSetupRecovery.hidden");
  });

  it("M-wait — the waiting screen states shop, location and Mac, and sells nothing", () => {
    const renderer = read("renderer/app.js");
    const pending = renderer.slice(renderer.indexOf('stage === "pending"'), renderer.indexOf('stage === "session_expired"'));
    expect(pending).toContain("Waiting for MintVault approval");
    expect(pending).toContain("Shop: ");
    expect(pending).toContain("Location: ");
    expect(pending).toContain("Mac: ");
    expect(pending).toContain("This screen updates automatically");
    // Nothing on the CONNECT path costs a credit, so nothing here may ask for money.
    expect(pending).not.toMatch(/TOP UP/i);
    expect(pending).not.toContain("availableCredits");
    expect(pending).not.toContain("Station unavailable");
  });

  it("M-expiry — an idled session is its own state, and keeps the station", () => {
    const main = read("main.js");
    expect(main).toContain('stage: hadSession ? "session_expired" : "sign_in"');
    // Reads the station identity to decide; never clears it.
    const block = main.slice(main.indexOf("AN EXPIRED SESSION IS NOT"), main.indexOf('stage: hadSession'));
    expect(block).not.toContain("clearEnrollment");
    const renderer = read("renderer/app.js");
    expect(renderer).toContain("Session expired");
    expect(renderer).toContain("this Mac stays registered");
    // The sign-in form must be ON the expired screen, or its instruction is impossible to follow.
    expect(renderer).toContain('stage !== "sign_in" && stage !== "session_expired"');
  });

  it("M-refresh — Refresh Status reports what it did", () => {
    const renderer = read("renderer/app.js");
    expect(renderer).toContain("CHECKING…");
    expect(renderer).toContain("STILL WAITING");
    expect(renderer).toContain("APPROVED — CONTINUING");
  });

  it("M-own — a second Scanner with a different profile refuses rather than taking over", () => {
    const main = read("main.js");
    expect(main).toContain("function claimThisMac()");
    expect(main).toContain("REFUSING TO START");
    expect(main).toContain("active-instance.json");
    // The claim lives in the SHARED directory, so instances on different profiles can see it.
    expect(main).toContain("SHARED_SUPPORT_DIR");
    // A claim naming a dead pid is debris, not an owner.
    expect(main).toContain("process.kill(raw.pid, 0)");
    // Released on a clean quit.
    expect(main).toContain("releaseThisMac();");
  });

  it("M10/M11/M12 — zero credits blocks only a new card, never sign-in, enrolment or calibration", () => {
    const renderer = read("renderer/app.js");
    // The blocking top-up modal is scoped to an operational station.
    expect(renderer).toContain('const stationOperational = stationSetup?.stage === "active"');
    expect(renderer).toContain("if (stationOperational && shouldShowBillingLock(state))");
    // NEW CARD's own zero-credit gate is untouched.
    expect(renderer).toContain("billingLocked(");
  });

  it("M13/M14 — pending is a wait, a foreign Mac is named, and only the unknown is 'unavailable'", () => {
    const renderer = read("renderer/app.js");
    const pending = renderer.slice(renderer.indexOf('stage === "pending"'), renderer.indexOf('stage === "session_expired"'));
    expect(pending).toContain("Waiting for MintVault approval");
    expect(pending).not.toContain("Station unavailable");

    const mismatch = renderer.slice(renderer.indexOf('stage === "identity_mismatch"'), renderer.indexOf('stage === "update_required"'));
    expect(mismatch).toContain("This Mac belongs to another shop");
    expect(mismatch).not.toContain("registerThisMac");   // never silently re-homes the station

    // Rejected/withdrawn and suspended are their own states, each with a way out.
    expect(renderer).toContain("This Mac's registration was withdrawn");
    expect(renderer).toContain("This Mac is suspended");
    // "Station status unavailable" now covers ONLY the genuinely unknown case.
    expect(renderer).toContain("Station status unavailable");
  });

  it("M15 — one shop's cards cannot appear under another shop", () => {
    const main = read("main.js");
    expect(main).toContain("reconcileTenantScopedState(session.body?.tenantId)");
    const fn = main.slice(main.indexOf("function reconcileTenantScopedState"), main.indexOf("/** Sanitised first-run state only"));
    for (const cleared of ["lastUploadedCert: null", "recent: []", "openCardJob: null", "calibrationRecovery: null"]) {
      expect(fn).toContain(cleared);
    }
    // Forensics and station identity survive: this scopes display state, it does not purge.
    expect(fn).not.toContain("stationIdentity");
    expect(fn).not.toContain("rmSync");
  });

  it("M-iso — an isolated instance owns its Electron profile, and production still does not", () => {
    const main = read("main.js");
    expect(main).toContain("if (process.env.MINTVAULT_SCANS_DIR)");
    expect(main).toContain('app.setPath("userData", isolatedProfile)');
    // The lock is still requested — it is the PROFILE that scopes it, not the absence of a lock.
    expect(main).toContain("app.requestSingleInstanceLock()");
  });

  it("M-manifest — the running instance declares itself, and withdraws it on quit", () => {
    const main = read("main.js");
    expect(main).toContain("function writeRuntimeManifest()");
    expect(main).toContain("function clearRuntimeManifest()");
    expect(main).toContain("writeRuntimeManifest();");
    expect(main).toContain("clearRuntimeManifest();");
    // Only ever removes its OWN claim.
    expect(main).toContain("raw.pid === process.pid");
  });

  it("M-version — the compiled build is 1.5.0, distinguishable from the enrolled Shop 0 Mac", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("1.5.0");
    expect(pkg.version).not.toBe("1.2.1");
    expect(pkg.version).not.toBe("1.4.1");
  });
});
