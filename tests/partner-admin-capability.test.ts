import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  getPartnerRuntimeCapability,
  probePartnerAdminCapabilityForTest,
  probePartnerRuntimeCapabilityForTest,
  resetPartnerAdminCapabilityCache,
} from "../server/partner/admin-capability";

describe("Partner admin capability probe", () => {
  it("accepts only BYPASSRLS for the Partner Super Admin pool", async () => {
    const ok = await probePartnerAdminCapabilityForTest(async () => ({
      rows: [{ has_role: true, rolbypassrls: true }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    expect(ok.ok).toBe(true);

    const blocked = await probePartnerAdminCapabilityForTest(async () => ({
      rows: [{ has_role: true, rolbypassrls: false }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    expect(blocked).toMatchObject({ ok: false, code: "PARTNER_ADMIN_BYPASSRLS_REQUIRED" });
  });

  it("requires the Partner runtime pool to remain non-BYPASSRLS", async () => {
    const ok = await probePartnerRuntimeCapabilityForTest(async () => ({
      rows: [{ has_role: true, rolbypassrls: false }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    expect(ok.ok).toBe(true);

    const blocked = await probePartnerRuntimeCapabilityForTest(async () => ({
      rows: [{ has_role: true, rolbypassrls: true }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    expect(blocked).toMatchObject({ ok: false, code: "PARTNER_RUNTIME_BYPASSRLS_FORBIDDEN" });
  });

  it("fails closed for empty lookup, unavailable DB and timeout", async () => {
    await expect(
      probePartnerAdminCapabilityForTest(async () => ({
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      }))
    ).resolves.toMatchObject({ ok: false, code: "PART_ROLE_LOOKUP_EMPTY" });

    await expect(
      probePartnerAdminCapabilityForTest(async () => {
        throw new Error("synthetic outage");
      })
    ).resolves.toMatchObject({ ok: false, code: "PARTNER_ADMIN_DB_UNAVAILABLE" });

    await expect(
      probePartnerAdminCapabilityForTest(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }), 50);
          }),
        1
      )
    ).resolves.toMatchObject({ ok: false, code: "PARTNER_CAPABILITY_TIMEOUT" });
  });
});

const ADMIN = process.env.PARTNER_CAPABILITY_RT_ADMIN;
const isLocal = !!ADMIN && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

function dbUrlAsRole(raw: string, username: string, password: string): string {
  const u = new URL(raw);
  u.username = username;
  u.password = password;
  return u.toString();
}

(isLocal ? describe : describe.skip)("Partner admin capability gate (PostgreSQL 17)", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query(
      "CREATE TABLE partner_management_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), result text NOT NULL)"
    );
    await admin.query(`CREATE TABLE users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      email varchar UNIQUE,
      role varchar(20) NOT NULL DEFAULT 'customer',
      deleted_at timestamp,
      credential_version integer NOT NULL DEFAULT 1
    )`);
    await admin.query("INSERT INTO users (email, role, credential_version) VALUES ('mintvaultuk@gmail.com','admin',1)");
    await admin.query("DROP OWNED BY partner_admin_bypass_test").catch(() => {});
    await admin.query("DROP OWNED BY partner_admin_plain_test").catch(() => {});
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
         CREATE ROLE partner_admin_plain_test LOGIN PASSWORD 'synthetic-plain' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_admin_plain_test WITH LOGIN PASSWORD 'synthetic-plain' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_app_test LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_app_test WITH LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END$$;`
    );
    await admin.query("GRANT USAGE ON SCHEMA public TO partner_admin_bypass_test, partner_admin_plain_test");
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partner_admin_bypass_test, partner_admin_plain_test"
    );

    process.env.MINTVAULT_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_plain_test", "synthetic-plain");
    process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_plain_test", "synthetic-plain");
    process.env.PARTNER_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_app_test", "synthetic");
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";
    resetPartnerAdminCapabilityCache();
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerManagementRoutes } = await import("../server/partner/partner-management-routes");
    const app = express();
    app.use(express.json());
    app.use(
      session({
        secret: process.env.SESSION_SECRET!,
        resave: false,
        saveUninitialized: false,
      })
    );
    app.post("/__test/admin-login", (req, res) => {
      req.session.isAdmin = true;
      req.session.adminEmail = "admin@example.test";
      req.session.authUserId = "00000000-0000-0000-0000-0000000000a5";
      req.session.credentialVersion = 1;
      req.session.authenticatedAt = Date.now();
      req.session.save(() => res.json({ ok: true }));
    });
    app.post("/__test/use-bypass", async (_req, res) => {
      process.env.MINTVAULT_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_bypass_test", "synthetic-admin");
      process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_bypass_test", "synthetic-admin");
      resetPartnerAdminCapabilityCache();
      await closePartnerPools();
      res.json({ ok: true });
    });
    app.use("/api/super-admin/partner-management", (req, _res, next) => {
      (req as any).__graderProxy = true;
      next();
    });
    registerPartnerManagementRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

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

  it("fails Super Admin routes closed with a non-BYPASSRLS admin role and writes no success audit", async () => {
    const c = await cookie();
    const ready = await fetch(`${base}/api/super-admin/partner-management/readiness`, { headers: { cookie: c } });
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      checked: true,
      ready: false,
      failureCode: "PARTNER_ADMIN_BYPASSRLS_REQUIRED",
    });

    const list = await fetch(`${base}/api/super-admin/partner-management/partners`, { headers: { cookie: c } });
    expect(list.status).toBe(503);
    const invite = await fetch(`${base}/api/super-admin/partner-management/partners/p/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: c },
      body: JSON.stringify({
        firstName: "Blocked",
        lastName: "User",
        email: "blocked@example.test",
        role: "STAFF",
        reason: "blocked by capability",
      }),
    });
    expect(invite.status).toBe(503);
    const audit = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_management_audit WHERE result='succeeded'"
    );
    expect(audit.rows[0].n).toBe(0);
  });

  it("passes readiness with the dedicated BYPASSRLS admin role while runtime remains non-BYPASSRLS", async () => {
    const c = await cookie();
    await fetch(`${base}/__test/use-bypass`, { method: "POST", headers: { cookie: c } });
    const ready = await fetch(`${base}/api/super-admin/partner-management/readiness`, { headers: { cookie: c } });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ checked: true, ready: true, failureCode: null });
    expect(await getPartnerRuntimeCapability()).toMatchObject({ ok: true });
  });
});
