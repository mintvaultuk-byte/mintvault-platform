/**
 * WALLET-BACKFILL1 — audited Super Admin route proof on PostgreSQL 17.
 *
 * This test is intentionally self-provisioning so the new route cannot hide behind the older
 * PARTNER_MANAGEMENT_RT_ADMIN skip gate. It boots the real Partner management router with the real
 * requireAdmin/requireSuperAdmin middleware against a disposable PostgreSQL 17 database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_LIFECYCLE,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let server: http.Server;
let base: string;
let adminEmail: string;
const ordinaryAdminEmail = "ordinary-wallet-admin@example.test";

const ACTIVE = "11111111-4242-4444-9444-111111111111";
const PENDING = "22222222-4242-4444-9444-222222222222";
const FAIL_FIRST = "33333333-4242-4444-9444-333333333333";
const FAIL_SECOND = "44444444-4242-4444-9444-444444444444";
const PM = "/api/super-admin/partner-management";

function dbUrlAsRole(raw: string, username: string, password: string): string {
  const u = new URL(raw);
  u.username = username;
  u.password = password;
  return u.toString();
}

async function seedMintVaultTables(): Promise<void> {
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
  await admin.query(
    "CREATE TABLE submissions (id serial PRIMARY KEY, user_id varchar, status varchar(30), tracking_number text UNIQUE, deleted_at timestamptz, status_history jsonb NOT NULL DEFAULT '[]'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())"
  );
  await admin.query("CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)");
  await admin.query("CREATE TABLE certificates (id serial PRIMARY KEY, cert_id text, secret text)");
  await admin.query(
    "CREATE TABLE label_prints (id serial PRIMARY KEY, certificate_id integer, created_at timestamptz NOT NULL DEFAULT now())"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
  for (const t of ["users", "submissions", "submission_items", "certificates", "label_prints", "audit_log"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

describe("WALLET-BACKFILL1 route (PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("wallet-backfill-route");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    process.env.SESSION_SECRET = "synthetic-wallet-backfill-route-secret";
    process.env.PARTNER_WALLET_BACKFILL1_ENABLED = "true";
    process.env.APP_URL = "http://127.0.0.1";

    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_LIFECYCLE);
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_admin_bypass_wallet_backfill LOGIN PASSWORD 'synthetic-admin' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_admin_bypass_wallet_backfill WITH LOGIN PASSWORD 'synthetic-admin' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       END$$;`
    );
    await admin.query("GRANT USAGE ON SCHEMA public TO partner_admin_bypass_wallet_backfill");
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partner_admin_bypass_wallet_backfill"
    );
    await admin.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO partner_admin_bypass_wallet_backfill");
    process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAsRole(
      cluster.url,
      "partner_admin_bypass_wallet_backfill",
      "synthetic-admin"
    );
    const { resetPartnerAdminCapabilityCache } = await import("../server/partner/admin-capability");
    resetPartnerAdminCapabilityCache();

    const authMod = await import("../server/auth");
    adminEmail = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [adminEmail.toLowerCase()]
    );
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [ordinaryAdminEmail]
    );
    await admin.query(
      `INSERT INTO partner_organisations (id, public_ref, legal_name, status)
       VALUES ($1,'wbfA','Backfill Active Route Ltd','ACTIVE'),($2,'wbfP','Backfill Pending Route Ltd','PENDING')`,
      [ACTIVE, PENDING]
    );

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");
    const app = express();
    app.use(express.json());
    app.use(
      session({
        name: "mv.sid",
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax" },
      })
    );
    app.post("/__test/admin-login", (req, res) => {
      req.session.isAdmin = true;
      req.session.adminEmail = adminEmail;
      req.session.authUserId = "00000000-0000-0000-0000-000000004242";
      req.session.credentialVersion = 1;
      req.session.authenticatedAt = Date.now();
      req.session.save(() => res.json({ ok: true }));
    });
    app.post("/__test/ordinary-admin-login", (req, res) => {
      req.session.isAdmin = true;
      req.session.adminEmail = ordinaryAdminEmail;
      req.session.authUserId = "00000000-0000-0000-0000-000000004243";
      req.session.credentialVersion = 1;
      req.session.authenticatedAt = Date.now();
      req.session.save(() => res.json({ ok: true }));
    });
    registerPartnerManagementRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 240_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  async function cookie(): Promise<string> {
    const response = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  async function ordinaryAdminCookie(): Promise<string> {
    const response = await fetch(`${base}/__test/ordinary-admin-login`, { method: "POST" });
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  const post = (path: string, body: unknown, cookieHeader = "") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      body: JSON.stringify(body),
    });

  it("requires authentication and the exact confirmation phrase", async () => {
    expect(
      (
        await post(`${PM}/wallet-backfills/WALLET-BACKFILL1`, {
          confirm: "WALLET-BACKFILL1",
          reason: "owner-approved staging backfill",
        })
      ).status
    ).toBe(401);

    const c = await cookie();
    const missingConfirm = await post(`${PM}/wallet-backfills/WALLET-BACKFILL1`, { reason: "missing" }, c);
    expect(missingConfirm.status).toBe(400);
    expect((await missingConfirm.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses an authenticated ordinary admin before wallet or audit writes", async () => {
    const c = await ordinaryAdminCookie();
    const before = await admin.query<{ wallets: number; audit: number }>(
      `SELECT
        (SELECT count(*)::int FROM partner_wallets) AS wallets,
        (SELECT count(*)::int FROM partner_management_audit WHERE action_type='partner_wallet_backfilled') AS audit`
    );
    const response = await post(
      `${PM}/wallet-backfills/WALLET-BACKFILL1`,
      { confirm: "WALLET-BACKFILL1", reason: "ordinary admin must not run", targetTenantIds: [ACTIVE] },
      c
    );
    expect(response.status).toBe(403);
    const after = await admin.query<{ wallets: number; audit: number }>(
      `SELECT
        (SELECT count(*)::int FROM partner_wallets) AS wallets,
        (SELECT count(*)::int FROM partner_management_audit WHERE action_type='partner_wallet_backfilled') AS audit`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("refuses production even when the feature flag is enabled", async () => {
    const c = await cookie();
    try {
      process.env.NODE_ENV = "production";
      process.env.APP_URL = "https://mintvault.fly.dev";
      process.env.FLY_APP_NAME = "mintvault";
      const response = await post(
        `${PM}/wallet-backfills/WALLET-BACKFILL1`,
        { confirm: "WALLET-BACKFILL1", reason: "must not run in production", targetTenantIds: [ACTIVE] },
        c
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("WALLET_BACKFILL_DISABLED");
    } finally {
      process.env.NODE_ENV = "test";
      process.env.APP_URL = "http://127.0.0.1";
      delete process.env.FLY_APP_NAME;
    }
  });

  it("refuses a staging app whose configured database identity is not the expected staging identity", async () => {
    const c = await cookie();
    try {
      process.env.NODE_ENV = "production";
      process.env.APP_URL = "https://mintvault-v2.fly.dev";
      process.env.FLY_APP_NAME = "mintvault-v2";
      process.env.PARTNER_WALLET_BACKFILL1_EXPECTED_DATABASE_IDENTITY =
        "postgresql://different-staging-db.local:5432/different";
      const before = await admin.query<{ wallets: number; audit: number }>(
        `SELECT
          (SELECT count(*)::int FROM partner_wallets) AS wallets,
          (SELECT count(*)::int FROM partner_management_audit WHERE action_type='partner_wallet_backfilled') AS audit`
      );
      const response = await post(
        `${PM}/wallet-backfills/WALLET-BACKFILL1`,
        { confirm: "WALLET-BACKFILL1", reason: "wrong db identity", targetTenantIds: [ACTIVE] },
        c
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("WALLET_BACKFILL_DISABLED");
      const after = await admin.query<{ wallets: number; audit: number }>(
        `SELECT
          (SELECT count(*)::int FROM partner_wallets) AS wallets,
          (SELECT count(*)::int FROM partner_management_audit WHERE action_type='partner_wallet_backfilled') AS audit`
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      process.env.NODE_ENV = "test";
      process.env.APP_URL = "http://127.0.0.1";
      delete process.env.FLY_APP_NAME;
      delete process.env.PARTNER_WALLET_BACKFILL1_EXPECTED_DATABASE_IDENTITY;
    }
  });

  it("rolls back the whole batch if a later wallet insert fails", async () => {
    await admin.query(
      `INSERT INTO partner_organisations (id, public_ref, legal_name, status)
       VALUES ($1,'wbfF1','Backfill Failure First Ltd','ACTIVE'),($2,'wbfF2','Backfill Failure Second Ltd','ACTIVE')
       ON CONFLICT (id) DO UPDATE SET status='ACTIVE'`,
      [FAIL_FIRST, FAIL_SECOND]
    );
    await admin.query(
      `CREATE OR REPLACE FUNCTION test_wallet_backfill_fail_second()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.tenant_id = '${FAIL_SECOND}'::uuid THEN
           RAISE EXCEPTION 'synthetic wallet backfill failure';
         END IF;
         RETURN NEW;
       END $$`
    );
    await admin.query(
      `CREATE TRIGGER test_wallet_backfill_fail_second
       BEFORE INSERT ON partner_wallets
       FOR EACH ROW EXECUTE FUNCTION test_wallet_backfill_fail_second()`
    );
    try {
      const c = await cookie();
      const response = await post(
        `${PM}/wallet-backfills/WALLET-BACKFILL1`,
        {
          confirm: "WALLET-BACKFILL1",
          reason: "synthetic partial failure proof",
          idempotencyKey: "route-wallet-backfill-failure-proof",
          targetTenantIds: [FAIL_FIRST, FAIL_SECOND],
        },
        c
      );
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
      const counts = await admin.query<{ wallets: number; audit: number; ledger: number }>(
        `SELECT
          (SELECT count(*)::int FROM partner_wallets WHERE tenant_id = ANY($1::uuid[])) AS wallets,
          (SELECT count(*)::int FROM partner_management_audit WHERE tenant_id = ANY($1::uuid[]) AND action_type='partner_wallet_backfilled') AS audit,
          (SELECT count(*)::int FROM partner_credit_ledger WHERE tenant_id = ANY($1::uuid[])) AS ledger`,
        [[FAIL_FIRST, FAIL_SECOND]]
      );
      expect(counts.rows[0]).toEqual({ wallets: 0, audit: 0, ledger: 0 });
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_wallet_backfill_fail_second ON partner_wallets");
      await admin.query("DROP FUNCTION IF EXISTS test_wallet_backfill_fail_second()");
    }
  });

  it("provisions ACTIVE missing wallets, skips non-ACTIVE organisations, audits internally and creates zero credits", async () => {
    const c = await cookie();
    const response = await post(
      `${PM}/wallet-backfills/WALLET-BACKFILL1`,
      {
        confirm: "WALLET-BACKFILL1",
        reason: "owner-approved staging wallet provisioning",
        idempotencyKey: "route-wallet-backfill-proof",
        targetTenantIds: [ACTIVE, PENDING],
      },
      c
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toMatchObject({ backfillId: "WALLET-BACKFILL1", considered: 2, ledgerEntriesCreated: 0 });
    expect(body.result.provisioned).toHaveLength(1);
    expect(body.result.provisioned[0]).toMatchObject({ tenantId: ACTIVE });
    expect(body.result.skipped).toEqual([
      {
        tenantId: PENDING,
        legalName: "Backfill Pending Route Ltd",
        status: "PENDING",
        reason: "organisation_not_active",
      },
    ]);

    const counts = await admin.query<{ wallets: number; ledger: number }>(
      `SELECT
        (SELECT count(*)::int FROM partner_wallets WHERE tenant_id = ANY($1::uuid[])) AS wallets,
        (SELECT count(*)::int FROM partner_credit_ledger WHERE tenant_id = ANY($1::uuid[])) AS ledger`,
      [[ACTIVE, PENDING]]
    );
    expect(counts.rows[0]).toEqual({ wallets: 1, ledger: 0 });

    const audit = await admin.query<{ result: string; action_type: string; reason: string; idempotency_key: string }>(
      `SELECT result, action_type, reason, idempotency_key
         FROM partner_management_audit
        WHERE tenant_id=$1 AND action_type='partner_wallet_backfilled'
        ORDER BY CASE result
                   WHEN 'attempted' THEN 0
                   WHEN 'succeeded' THEN 1
                   WHEN 'no_op' THEN 2
                   ELSE 3
                 END, created_at, id`,
      [ACTIVE]
    );
    expect(audit.rows.map((row) => row.result)).toEqual(["attempted", "succeeded"]);
    expect(audit.rows[1]).toMatchObject({
      action_type: "partner_wallet_backfilled",
      reason: "owner-approved staging wallet provisioning",
      idempotency_key: `route-wallet-backfill-proof:${ACTIVE}`,
    });
  });
});
