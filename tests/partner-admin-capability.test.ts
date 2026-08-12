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
import { PARTNER_ROLE_CODES } from "../shared/partner-schema";
import { PARTNER_PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS } from "../server/partner/permissions";

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
    // The readiness endpoint now also reports RBAC reference-data state (added after the
    // first-owner-invitation incident, where the app reported healthy while invitations were
    // impossible). Startup/readiness validation is READ-ONLY and checks the FULL canonical
    // catalogue — every role, permission AND role→permission mapping — so a fixture holding only
    // PARTNER_OWNER reports `incomplete` and readiness answers 503 for an RBAC reason, masking the
    // CAPABILITY gate this suite exists to test.
    //
    // So the fixture seeds the COMPLETE canonical catalogue — but never by hand-writing a second
    // copy of it. The values below come from the same TypeScript source of truth the validator
    // reads (PARTNER_ROLE_CODES / PARTNER_PERMISSIONS / ROLE_PERMISSIONS / ROLE_LABELS), so there
    // remains exactly ONE definition of Partner RBAC; if the canonical catalogue grows, this
    // fixture grows with it automatically and nothing here has to be edited.
    //
    // Seeding is done through this suite's own superuser `admin` client rather than
    // seedPartnerRbac(), which writes via partnerAdminQuery and would therefore resolve a pool from
    // PARTNER_ADMIN_DATABASE_URL/MINTVAULT_DATABASE_URL — env vars this beforeAll deliberately
    // repoints partway through, and pools this suite opens/closes around the BYPASSRLS capability
    // flip. Keeping the seed on the fixture's own connection keeps it independent of that dance.
    //
    // Migrations are deliberately NOT run here: this suite hand-builds a deliberately smaller
    // schema, and applying 0034 would drag in the whole partner migration chain it exists without.
    // Column shapes below match migrations/0001_partner_foundation.sql.
    await admin.query(
      "CREATE TABLE IF NOT EXISTS partner_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, label text NOT NULL)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS partner_permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, label text NOT NULL)"
    );
    await admin.query(`CREATE TABLE IF NOT EXISTS partner_role_permissions (
      role_id uuid NOT NULL REFERENCES partner_roles(id) ON DELETE CASCADE,
      permission_id uuid NOT NULL REFERENCES partner_permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    )`);
    for (const code of PARTNER_ROLE_CODES) {
      await admin.query("INSERT INTO partner_roles (code, label) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING", [
        code,
        ROLE_LABELS[code],
      ]);
    }
    for (const perm of PARTNER_PERMISSIONS) {
      await admin.query("INSERT INTO partner_permissions (code, label) VALUES ($1,$1) ON CONFLICT (code) DO NOTHING", [
        perm,
      ]);
    }
    for (const code of PARTNER_ROLE_CODES) {
      for (const perm of ROLE_PERMISSIONS[code]) {
        await admin.query(
          `INSERT INTO partner_role_permissions (role_id, permission_id)
           SELECT r.id, p.id FROM partner_roles r, partner_permissions p
           WHERE r.code=$1 AND p.code=$2
           ON CONFLICT DO NOTHING`,
          [code, perm]
        );
      }
    }
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
    await admin.query("DROP OWNED BY partner_app_test_cap").catch(() => {});
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
         CREATE ROLE partner_app_test_cap LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE partner_app_test_cap WITH LOGIN PASSWORD 'synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END$$;`
    );
    await admin.query("GRANT USAGE ON SCHEMA public TO partner_admin_bypass_test, partner_admin_plain_test");
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partner_admin_bypass_test, partner_admin_plain_test"
    );

    process.env.MINTVAULT_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_plain_test", "synthetic-plain");
    process.env.PARTNER_ADMIN_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_plain_test", "synthetic-plain");
    process.env.PARTNER_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_app_test_cap", "synthetic");
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
    expect(ready.status).toBe(403);
    expect(await ready.json()).toMatchObject({ error: "Forbidden: Super Admin required" });

    const list = await fetch(`${base}/api/super-admin/partner-management/partners`, { headers: { cookie: c } });
    expect(list.status).toBe(403);
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
    expect(invite.status).toBe(403);
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
  /**
   * PART 9 — the RUNTIME credential must be restricted, and that must be ENFORCED, not documented.
   *
   * The failure this guards is a configuration slip, not an exploit: PARTNER_DATABASE_URL pointed at
   * an owner/BYPASSRLS login (neondb_owner) instead of the restricted partner_runtime_app member.
   * Under that URL every tenant boundary in the Partner runtime is silently off — RLS does not apply
   * to a BYPASSRLS role — and each tenant's queries return every tenant's rows.
   *
   * definerModelViolations cannot see this: it inspects the `partner_runtime` GROUP role's
   * attributes, which stay NOBYPASSRLS regardless of which login actually connected. Only a
   * current_user check catches it, and until this was wired into mount.ts's Gate 2 nothing in
   * production called one.
   */
  it("REJECTS a BYPASSRLS runtime credential (current_user, not the group role)", async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    const restored = process.env.PARTNER_DATABASE_URL;
    try {
      // Point the RUNTIME pool at the BYPASSRLS login. The partner_runtime GROUP role is untouched
      // and still NOBYPASSRLS, which is exactly why a group-role check would pass here.
      process.env.PARTNER_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_admin_bypass_test", "synthetic-admin");
      await closePartnerPools();
      expect(await getPartnerRuntimeCapability()).toMatchObject({
        ok: false,
        code: "PARTNER_RUNTIME_BYPASSRLS_FORBIDDEN",
      });
    } finally {
      process.env.PARTNER_DATABASE_URL = restored;
      await closePartnerPools();
    }
  });

  it("ACCEPTS the restricted runtime credential — the check is not simply always-false", async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    process.env.PARTNER_DATABASE_URL = dbUrlAsRole(ADMIN!, "partner_app_test_cap", "synthetic");
    await closePartnerPools();
    expect(await getPartnerRuntimeCapability()).toMatchObject({ ok: true });
  });

  it("mount.ts Gate 2 consumes that probe and fails closed BEFORE the definer inspection", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const mount = readFileSync(join(process.cwd(), "server", "partner", "mount.ts"), "utf8");
    const gate = mount.slice(mount.indexOf("async function checkDefinerModelOnce"));
    const body = gate.slice(0, gate.indexOf("\n}"));
    const capabilityAt = body.indexOf("getPartnerRuntimeCapability()");
    const definerAt = body.indexOf("definerModelViolations(");
    expect(capabilityAt, "Gate 2 no longer calls getPartnerRuntimeCapability").toBeGreaterThan(-1);
    expect(definerAt, "Gate 2 no longer calls definerModelViolations").toBeGreaterThan(-1);
    // Ordering matters: the credential check must short-circuit, so a BYPASSRLS runtime URL is
    // rejected even on a database whose definer model happens to be intact.
    expect(capabilityAt, "the credential check must run BEFORE the definer inspection").toBeLessThan(definerAt);
    // …and its failure must close the surface rather than merely log.
    const afterCapability = body.slice(capabilityAt, definerAt);
    expect(afterCapability).toMatch(/if \(!capability\.ok\)/);
    expect(afterCapability).toMatch(/return false/);
  });
});
