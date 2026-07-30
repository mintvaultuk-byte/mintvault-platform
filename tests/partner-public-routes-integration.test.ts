import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_PUBLIC_RT_ADMIN;
const RUNTIME = process.env.PARTNER_PUBLIC_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aa31aa31-0000-0000-0000-000000000001";
const OWNER = "aa31aa31-0000-0000-0000-0000000000a1";

(isLocal ? describe : describe.skip)("Partner public routes mounted in production app path", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);
    await admin.query("DROP ROLE IF EXISTS partner_app_test").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test");
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'pubA','Public A','ACTIVE')",
      [A]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES ($1,'pubOwner',$2,$2,'public-owner@example.test','INVITED')",
      [OWNER, A]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [A, OWNER]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true)"
    );

    const token = "public-route-token-abcdefghijklmnopqrstuvwxyz";
    await admin.query(
      "INSERT INTO partner_invitations (tenant_id, user_id, email, role_code, token_hash, expires_at) VALUES ($1,$2,'public-owner@example.test','PARTNER_OWNER',encode(sha256($3::bytea),'hex'),now()+interval '1 day')",
      [A, OWNER, token]
    );
    process.env.__PARTNER_PUBLIC_TEST_TOKEN = token;

    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const app = express();
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  it("accepts setup through the production-mounted public route and can log in while authenticated routes stay absent", async () => {
    const token = process.env.__PARTNER_PUBLIC_TEST_TOKEN!;
    const accepted = await fetch(`${base}/api/partner/invitations/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "new-public-password-1" }),
    });
    expect(accepted.status).toBe(200);
    const stored = await admin.query<{ status: string; ok: boolean }>(
      "SELECT status, password_hash IS NOT NULL AS ok FROM partner_users WHERE id=$1",
      [OWNER]
    );
    expect(stored.rows[0]).toEqual({ status: "ACTIVE", ok: true });

    const login = await fetch(`${base}/api/partner/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "public-owner@example.test", password: "new-public-password-1" }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("mv.partner.sid=");
    expect((await fetch(`${base}/api/partner/session`)).status).toBe(404);
  });

  it("fails closed when onboarding is disabled and cannot replace an ACTIVE user's password", async () => {
    await admin.query("DELETE FROM partner_feature_flags WHERE flag='partner_onboarding_enabled'");
    const token = "disabled-onboarding-token-abcdefghijklmnopqrstuvwxyz";
    await admin.query(
      "INSERT INTO partner_invitations (tenant_id, user_id, email, role_code, token_hash, expires_at) VALUES ($1,$2,'public-owner@example.test','PARTNER_OWNER',encode(sha256($3::bytea),'hex'),now()+interval '1 day')",
      [A, OWNER, token]
    );
    const disabled = await fetch(`${base}/api/partner/invitations/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "another-public-password-1" }),
    });
    expect(disabled.status).toBe(503);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_onboarding_enabled',true)"
    );
    const activeBlocked = await fetch(`${base}/api/partner/invitations/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "another-public-password-1" }),
    });
    expect(activeBlocked.status).toBe(400);
    expect(
      await bcrypt.compare(
        "another-public-password-1",
        (await admin.query<{ password_hash: string }>("SELECT password_hash FROM partner_users WHERE id=$1", [OWNER]))
          .rows[0].password_hash
      )
    ).toBe(false);
  });
});
