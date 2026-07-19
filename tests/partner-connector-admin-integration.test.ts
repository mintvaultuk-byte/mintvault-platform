/**
 * G4 Super-Admin connector operations — HTTP integration test.
 *
 * Boots a repository-consistent main-app composition mounting the REAL requireAdmin and the real
 * registerConnectorOpsRoutes against ONE disposable Postgres. requireAdmin runs fully; the only
 * synthetic element is a TEST-ONLY admin-login route (never shipped) that stamps the same session the
 * real login+PIN flow produces. Mutations delegate to the real G3F services (connector runtime pool).
 *
 * Proves: auth boundary (unauth / forged-header rejected, admin allowed); reads (partners, records,
 * worker status) deterministic + secret-free; reason-required (400); not-found (404); a real mutation
 * (mark-manual-review) transitions state AND writes the append-only admin-action audit (attempt +
 * terminal); idempotency-key short-circuit returns alreadyCompleted without a second effect; no
 * forbidden side effect (no destination submission / import mapping created).
 *
 * Runs only when PARTNER_CONNECTOR_ADMIN_TEST (superuser URL) and PARTNER_CONNECTOR_ADMIN_TEST_RUNTIME
 * (connector-runtime URL) are set and loopback. Skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_G4,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_CONNECTOR_ADMIN_TEST;
const RUNTIME_DB = process.env.PARTNER_CONNECTOR_ADMIN_TEST_RUNTIME;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN_DB) && isLoopback(RUNTIME_DB);

const A = "aaaa1111-0000-0000-0000-000000000001";
const B = "bbbb2222-0000-0000-0000-000000000002";
const LA1 = "1a1a0000-0000-0000-0000-0000000000c1";
const UA = "0a0a0000-0000-0000-0000-0000000000a1";

let admin: Client;
let server: http.Server;
let base: string;
let ADMIN_EMAIL: string;
let recordId: string;

const OPS = "/api/super-admin/connector-ops";

(isLocal ? describe : describe.skip)("G4 connector operations (main app, real requireAdmin, disposable DB)", () => {
  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_CONNECTOR_DATABASE_URL = RUNTIME_DB;
    process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    // MintVault-internal tables the connector migrations (0010+) grant against — owned by pn_migrator.
    // Full users shape so the REAL requireAdmin (getUserByEmail) can re-validate the admin row.
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
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE, status text, payment_intent_id text, payment_status text)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_G4);

    // connector-runtime login role for the connector pool
    await admin.query("DROP ROLE IF EXISTS partner_conn_g4_test").catch(() => {});
    await admin.query("CREATE ROLE partner_conn_g4_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_connector_runtime TO partner_conn_g4_test");
    const rt = new URL(RUNTIME_DB!);
    rt.username = "partner_conn_g4_test";
    rt.password = "synthetic";
    process.env.PARTNER_CONNECTOR_DATABASE_URL = rt.toString();
    // partner_runtime login role for the tenant-runtime pool (resolveGlobalFlag reads flags there)
    await admin.query("DROP ROLE IF EXISTS partner_rt_g4_test").catch(() => {});
    await admin.query("CREATE ROLE partner_rt_g4_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_rt_g4_test");
    const prt = new URL(RUNTIME_DB!);
    prt.username = "partner_rt_g4_test";
    prt.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = prt.toString();

    const authMod = await import("../server/auth");
    ADMIN_EMAIL = authMod.ADMIN_EMAIL;
    await admin.query(
      "INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1) ON CONFLICT (email) DO UPDATE SET role='admin', credential_version=1",
      [ADMIN_EMAIL.toLowerCase()]
    );

    // partner fixtures
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'rA','A Ltd','ACTIVE'),($2,'rB','B Ltd','ACTIVE')",
      [A, B]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'la1',$2,$2,'LA1','ACTIVE')",
      [LA1, A]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status) VALUES ($1,'ua1',$2,$2,'owner@a.com','x','ACTIVE')",
      [UA, A]
    );
    // global connector flags: enabled ON, emergency stop OFF (so assertConnectorActive passes)
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_connector_enabled',true),(NULL,'partner_emergency_stop',false)"
    );
    // a connector record in 'failed' (manual-review-reachable), plus its submission + handoff
    const sub = await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id, location_id, created_by, service_tier_code, estimated_price_pence, card_count, status)
       VALUES ($1,$2,$3,'standard',3000,1,'submitted_to_mintvault') RETURNING id`,
      [A, LA1, UA]
    );
    const h = await admin.query<{ id: string }>(
      "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
      [A, sub.rows[0].id]
    );
    const rec = await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id, state, version)
       VALUES ($1,$2,$3,'failed',1) RETURNING id`,
      [A, sub.rows[0].id, h.rows[0].id]
    );
    recordId = rec.rows[0].id;

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerConnectorOpsRoutes } = await import("../server/partner/connector-admin-routes");
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
      s.authUserId = "00000000-0000-0000-0000-0000000000ad";
      s.credentialVersion = 1;
      s.authenticatedAt = Date.now();
      req.session.save(() => res.json({ ok: true }));
    });
    registerConnectorOpsRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    const { closePartnerPools } = await import("../server/partner/db");
    const { closeConnectorPool } = await import("../server/partner/connector-db");
    await closePartnerPools().catch(() => {});
    await closeConnectorPool().catch(() => {});
    await admin?.query("DROP ROLE IF EXISTS partner_conn_g4_test").catch(() => {});
    await admin?.query("DROP ROLE IF EXISTS partner_rt_g4_test").catch(() => {});
    await admin?.end().catch(() => {});
  });

  async function adminCookie(): Promise<string> {
    const r = await fetch(`${base}/__test/admin-login`, { method: "POST" });
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  const aget = (p: string, cookie = "") => fetch(`${base}${p}`, { headers: cookie ? { cookie } : {} });
  const apost = (p: string, body: unknown, cookie = "") =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("auth boundary: unauth 401; forged header 401; real admin 200", async () => {
    expect((await aget(`${OPS}/partners`)).status).toBe(401);
    expect((await fetch(`${base}${OPS}/partners`, { headers: { "x-admin": "true", "x-role": "admin" } })).status).toBe(
      401
    );
    const ac = await adminCookie();
    expect((await aget(`${OPS}/partners`, ac)).status).toBe(200);
  });

  it("reads: partners list + records list + worker status are deterministic and secret-free", async () => {
    const ac = await adminCookie();
    const partners = await (await aget(`${OPS}/partners`, ac)).json();
    expect(partners.partners.length).toBe(2);
    expect(partners.partners.map((p: any) => p.legal_name).sort()).toEqual(["A Ltd", "B Ltd"]);
    const records = await (await aget(`${OPS}/records`, ac)).json();
    expect(records.records.length).toBeGreaterThanOrEqual(1);
    const health = await (await aget(`${OPS}/worker/status`, ac)).json();
    expect(health.featureEnabled).toBe(true); // read-only flag visibility
    expect(health.emergencyStop).toBe(false);
    expect(typeof health.eligibleCount).toBe("number");
    // no secret material anywhere in the read payloads
    const blob = JSON.stringify(partners) + JSON.stringify(records) + JSON.stringify(health);
    expect(blob).not.toMatch(/password|pin_hash|secret|token|\$2[aby]\$/i);
  });

  it("mutation: reason required (400); unknown record (404)", async () => {
    const ac = await adminCookie();
    expect((await apost(`${OPS}/records/${recordId}/mark-manual-review`, {}, ac)).status).toBe(400);
    const r404 = await apost(
      `${OPS}/records/00000000-0000-0000-0000-0000000000ff/mark-manual-review`,
      { reason: "x" },
      ac
    );
    expect(r404.status).toBe(404);
  });

  it("mark-manual-review: transitions state + writes append-only audit (attempt + terminal); no forbidden side effect", async () => {
    const ac = await adminCookie();
    const r = await apost(`${OPS}/records/${recordId}/mark-manual-review`, { reason: "operator escalation" }, ac);
    expect(r.status).toBe(200);
    const state = await admin.query<{ state: string }>("SELECT state FROM partner_connector_records WHERE id=$1", [
      recordId,
    ]);
    expect(state.rows[0].state).toBe("manual_review");
    // audit: one attempt + one succeeded terminal for this record
    const audit = await admin.query<{ result: string; action_type: string; actor_email: string; reason: string }>(
      "SELECT result, action_type, actor_email, reason FROM partner_connector_admin_actions WHERE connector_record_id=$1 ORDER BY created_at",
      [recordId]
    );
    expect(audit.rows.length).toBe(2);
    expect(audit.rows.map((x) => x.result).sort()).toEqual(["attempted", "succeeded"]);
    expect(audit.rows[1].action_type).toBe("reconcile_mark_manual");
    expect(audit.rows[1].actor_email).toBe(ADMIN_EMAIL);
    // no forbidden side effect: no destination submission or completed import mapping created
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_connector_imports WHERE connector_record_id=$1 AND state='completed'",
          [recordId]
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (await admin.query("SELECT count(*)::int n FROM submissions WHERE payment_intent_id IS NOT NULL")).rows[0].n
    ).toBe(0);
  });

  it("idempotency: same idempotency key short-circuits with alreadyCompleted and no second effect", async () => {
    const ac = await adminCookie();
    // resolve the manual_review record with an idempotency key
    const body = {
      reason: "resolve cancel",
      resolution: "cancel",
      expectedVersion: undefined as unknown,
      idempotencyKey: "idem-g4-1",
    };
    // read current version
    const v = await admin.query<{ version: number }>("SELECT version FROM partner_connector_records WHERE id=$1", [
      recordId,
    ]);
    (body as any).expectedVersion = v.rows[0].version;
    const r1 = await apost(`${OPS}/records/${recordId}/manual-review/resolve`, body, ac);
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.ok).toBe(true);
    const stateAfter = await admin.query<{ state: string }>("SELECT state FROM partner_connector_records WHERE id=$1", [
      recordId,
    ]);
    expect(stateAfter.rows[0].state).toBe("cancelled");
    const succeededCount1 = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_connector_admin_actions WHERE idempotency_key='idem-g4-1' AND result='succeeded'",
      []
    );
    expect(succeededCount1.rows[0].n).toBe(1);
    // replay with the same key → short-circuit, no second effect
    const r2 = await apost(`${OPS}/records/${recordId}/manual-review/resolve`, body, ac);
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.alreadyCompleted).toBe(true);
    const succeededCount2 = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_connector_admin_actions WHERE idempotency_key='idem-g4-1' AND result='succeeded'",
      []
    );
    expect(succeededCount2.rows[0].n).toBe(1); // still exactly one — no duplicate effect
  });

  it("runtime role cannot mutate the append-only admin-actions table", async () => {
    const rt = new Client({ connectionString: process.env.PARTNER_CONNECTOR_DATABASE_URL });
    await rt.connect();
    try {
      await rt.query("SET ROLE partner_connector_runtime");
      await expect(rt.query("UPDATE partner_connector_admin_actions SET result='succeeded'")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(rt.query("DELETE FROM partner_connector_admin_actions")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await rt.query("RESET ROLE").catch(() => {});
      await rt.end();
    }
  });
});
