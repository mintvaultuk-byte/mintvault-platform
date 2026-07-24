/**
 * print-workflow-routes.test.ts — DB-backed route-level PERMISSION tests.
 * Exercises the REAL requireAdmin + resolveActor/ensurePermission chain against a
 * disposable PostgreSQL 17 cluster (no UI, no mocked middleware): unauthenticated
 * is rejected, admin has full access, and a can_print staffer (reaching the routes
 * through the __graderProxy seam) may read + batch + reprint but is denied the
 * terminal Mark Completed. UI hiding is not relied on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import session from "express-session";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Client, Pool } = pg;
const ADMIN_EMAIL = "mintvaultuk@gmail.com";

const runtime: { db: unknown; pool: unknown } = { db: null, pool: null };
vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("db before setup");
    return runtime.db;
  },
  get pool() {
    return runtime.pool;
  },
}));
vi.mock("../server/r2", () => ({ uploadToR2: vi.fn(async (k: string) => k) }));

// requireAdmin re-validates the admin via storage.getUserByEmail (a drizzle
// select over the full users schema). Stub it so the route test needs only a
// minimal DB; the queue/complete SERVICE calls still hit the real cluster via db.
vi.mock("../server/storage", () => ({
  storage: {
    getUserByEmail: vi.fn(async (email: string) =>
      email.toLowerCase() === "mintvaultuk@gmail.com"
        ? { email: "mintvaultuk@gmail.com", role: "admin", credentialVersion: 1, deletedAt: null }
        : null
    ),
    listCertificates: vi.fn(async () => []),
    getOrGenerateClaimCode: vi.fn(async () => "CODE"),
  },
}));

const BASE_DDL = `
  CREATE TABLE users ( id serial PRIMARY KEY, email text UNIQUE NOT NULL, role text, credential_version integer DEFAULT 1, deleted_at timestamptz );
  CREATE TABLE certificates (
    id serial PRIMARY KEY, certificate_number text UNIQUE NOT NULL, grade_approved_at timestamptz, grade_approved_by text,
    deleted_at timestamptz, status varchar(10) NOT NULL DEFAULT 'active', ownership_status varchar(20) DEFAULT 'unclaimed',
    updated_at timestamptz DEFAULT now(), issued_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE label_prints ( id serial PRIMARY KEY, cert_id text UNIQUE NOT NULL, sheet_ref text, queued_at timestamptz DEFAULT now(), printed_at timestamptz );
  CREATE TABLE reprint_log ( id serial PRIMARY KEY, cert_id text NOT NULL, reprint_time timestamptz DEFAULT now() );
  CREATE TABLE audit_log ( id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, admin_user text, details jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now() );
  CREATE TABLE submission_items ( id serial PRIMARY KEY, submission_id integer );
  CREATE TABLE cards ( id serial PRIMARY KEY, submission_id integer );
  CREATE TABLE submissions ( id serial PRIMARY KEY, tracking_number text, customer_first_name text, customer_last_name text, customer_email text );
  ALTER TABLE certificates ADD COLUMN submission_item_id integer;
  ALTER TABLE certificates ADD COLUMN card_id integer;
  ALTER TABLE certificates ADD COLUMN card_name text;
  ALTER TABLE certificates ADD COLUMN card_game text;
  ALTER TABLE certificates ADD COLUMN set_name text;
  ALTER TABLE certificates ADD COLUMN card_number_display text;
  ALTER TABLE certificates ADD COLUMN grade numeric;
  ALTER TABLE certificates ADD COLUMN owner_name text;
  ALTER TABLE certificates ADD COLUMN owner_email text;
  ALTER TABLE certificates ADD COLUMN front_image_path text;
`;

let cluster: DisposablePostgres17;
let admin: InstanceType<typeof Client>;
let baseUrl: string;
let server: ReturnType<express.Express["listen"]>;

async function req(path: string, opts: { method?: string; body?: unknown; cookie?: string; staff?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.staff) headers["x-test-proxy-staff"] = opts.staff;
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("print-workflow routes — permission enforcement (DB-backed)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    cluster = await startPostgres17("print-workflow-routes");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await admin.query(BASE_DDL);
    await admin.query(`INSERT INTO users (email, role, credential_version) VALUES ($1, 'admin', 1)`, [ADMIN_EMAIL]);
    const file = listMigrationFiles().find((m) => m.filename.includes("0022_print_workflow"))!;
    await applyMigrations(admin, [file]);
    // A printed cert so 'complete' has something an admin can legitimately act on.
    await admin.query(`INSERT INTO certificates (certificate_number, print_state, grade_approved_at) VALUES ('MV-DONE', 'printed', now())`);

    runtime.pool = new Pool({ connectionString: cluster.url, max: 4 });
    runtime.db = drizzle(runtime.pool as InstanceType<typeof Pool>);
    const { registerPrintWorkflowRoutes } = await import("../server/routes/print-workflow");

    const app = express();
    app.use(express.json());
    app.use(
      session({ name: "mv.sid", secret: "print-workflow-routes-test", resave: false, saveUninitialized: false, cookie: { secure: false } })
    );
    // Test-only: simulate the internal can_print staff proxy (the real seam that
    // sets __graderProxy after a capability check). Never client-forgeable in prod.
    app.use((r, _res, next) => {
      const staff = r.headers["x-test-proxy-staff"];
      if (staff) {
        (r as express.Request & { __graderProxy?: boolean }).__graderProxy = true;
        (r.session as unknown as { staffEmail?: string }).staffEmail = String(staff);
      }
      next();
    });
    app.post("/__test/admin-session", (r, res) => {
      Object.assign(r.session, { isAdmin: true, adminEmail: ADMIN_EMAIL, credentialVersion: 1, authenticatedAt: Date.now() });
      r.session.save((e) => (e ? res.status(500).json({ error: e.message }) : res.json({ ok: true })));
    });
    registerPrintWorkflowRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const s = await req("/__test/admin-session", { method: "POST" });
    adminCookie = (s.headers.get("set-cookie") ?? "").split(";")[0];
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await (runtime.pool as InstanceType<typeof Pool>)?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("rejects unauthenticated access to the queue (401)", async () => {
    const r = await req("/api/admin/printing/workflow/queue");
    expect(r.status).toBe(401);
  });

  it("rejects unauthenticated mark-completed (401)", async () => {
    const r = await req("/api/admin/printing/workflow/complete", { method: "POST", body: { certIds: ["MV-DONE"] } });
    expect(r.status).toBe(401);
  });

  it("admin can read the queue and the batches", async () => {
    const q = await req("/api/admin/printing/workflow/queue", { cookie: adminCookie });
    expect(q.status).toBe(200);
    const b = await req("/api/admin/printing/workflow/batches", { cookie: adminCookie });
    expect(b.status).toBe(200);
  });

  it("admin can mark completed", async () => {
    const r = await req("/api/admin/printing/workflow/complete", { method: "POST", body: { certIds: ["MV-DONE"] }, cookie: adminCookie });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { applied: string[] };
    expect(body.applied).toEqual(["MV-DONE"]);
  });

  it("can_print staff may READ the queue (via proxy)", async () => {
    const r = await req("/api/admin/printing/workflow/queue", { staff: "staffer@mintvault" });
    expect(r.status).toBe(200);
  });

  it("can_print staff is DENIED mark-completed (403) — terminal is admin-only", async () => {
    const r = await req("/api/admin/printing/workflow/complete", { method: "POST", body: { certIds: ["MV-DONE"] }, staff: "staffer@mintvault" });
    expect(r.status).toBe(403);
  });

  it("can_print staff MAY reach create-batch (permission allows; no 401/403)", async () => {
    // Uses a non-existent cert so no rendering happens; we only assert the gate.
    const r = await req("/api/admin/printing/workflow/batch", { method: "POST", body: { certIds: ["MV-NOPE"] }, staff: "staffer@mintvault" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { applied: string[]; rejected: unknown[] };
    expect(body.applied).toEqual([]);
    expect(body.rejected.length).toBe(1);
  });
});
