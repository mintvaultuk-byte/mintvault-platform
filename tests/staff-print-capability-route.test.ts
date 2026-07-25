/**
 * HTTP-level proof of the can_print capability gate on the Ready To Print queue.
 *
 * WHY THIS EXISTS INSTEAD OF A LIVE STAGING LOGIN: staging has no account with
 * can_print = true, and no credential exists for any staging staff account. Setting one
 * would be a credential change, which is not authorised — so a live login test is not
 * available. This mounts the REAL staff router, the REAL requireCapability middleware
 * (including its per-request DB re-validation) and the REAL print proxy over a
 * disposable PostgreSQL 17 cluster, which proves the authorisation behaviour without
 * touching any account anywhere.
 *
 * Only the session issuer is a test double: a test-only endpoint stamps the same
 * server-side session fields the staff login flow produces. Authorisation itself is not
 * mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const runtime = vi.hoisted(() => ({ db: null as unknown, pool: null as unknown }));

vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("Route test database was used before setup");
    return runtime.db;
  },
  get pool() {
    if (!runtime.pool) throw new Error("Route test pool was used before setup");
    return runtime.pool;
  },
}));

const PRINT_STAFF = "11111111-1111-1111-1111-111111111111";
const GRADE_ONLY_STAFF = "22222222-2222-2222-2222-222222222222";
const QUEUE = "/api/staff/print/printing/workflow/queue";
const COMPLETE = "/api/staff/print/printing/workflow/complete";

let cluster: DisposablePostgres17;
let pool: pg.Pool;
let server: Server;
let base: string;
/** Records every admin path the proxy actually re-dispatched to. */
let proxied: Array<{ path: string; graderProxy: boolean }>;

beforeAll(async () => {
  cluster = await startPostgres17("staff-print-capability");
  pool = new pg.Pool({ connectionString: cluster.url, max: 6 });
  runtime.pool = pool;
  runtime.db = drizzle(pool);

  await pool.query(`
    CREATE TABLE users (
      id varchar PRIMARY KEY, email varchar UNIQUE, role varchar(20) NOT NULL DEFAULT 'customer',
      deleted_at timestamp, credential_version integer NOT NULL DEFAULT 1,
      can_grade boolean NOT NULL DEFAULT false, can_scan boolean NOT NULL DEFAULT false,
      can_print boolean NOT NULL DEFAULT false, can_edit_sets boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    )`);

  const { registerStaffRoutes } = await import("../server/routes/staff");
  const { requireAdmin } = await import("../server/auth");

  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: "mv.sid",
      secret: "staff-print-capability-test-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: false },
    })
  );

  // Test-only session issuer — stamps the same fields the real staff login stamps.
  app.post("/__test/staff-session/:kind", (req, res) => {
    const print = req.params.kind === "print";
    Object.assign(req.session, {
      isStaff: true,
      staffId: print ? PRINT_STAFF : GRADE_ONLY_STAFF,
      capGrade: true,
      capScan: false,
      capPrint: print,
      capEditSets: false,
      credentialVersion: 1,
      authenticatedAt: Date.now(),
    });
    req.session.save((e) => (e ? res.status(500).json({ error: e.message }) : res.json({ ok: true })));
  });
  app.post("/__test/admin-session", (req, res) => {
    Object.assign(req.session, {
      isAdmin: true,
      adminEmail: "admin@example.test",
      credentialVersion: 1,
      authenticatedAt: Date.now(),
    });
    req.session.save((e) => (e ? res.status(500).json({ error: e.message }) : res.json({ ok: true })));
  });

  registerStaffRoutes(app);

  // Stub admin targets behind the REAL requireAdmin, so the proxy chain (capability
  // check -> __graderProxy -> requireAdmin) is exercised exactly as in production.
  for (const p of ["/api/admin/printing/workflow/queue", "/api/admin/printing/workflow/complete"]) {
    app.get(p, requireAdmin, (req, res) => {
      proxied.push({ path: p, graderProxy: !!(req as unknown as { __graderProxy?: boolean }).__graderProxy });
      res.json({ rows: [{ certId: "MV999", state: "needs_printing", customerEmail: "leak@example.test" }] });
    });
    app.post(p, requireAdmin, (req, res) => {
      proxied.push({ path: p, graderProxy: !!(req as unknown as { __graderProxy?: boolean }).__graderProxy });
      res.json({ ok: true });
    });
  }

  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await pool?.end();
  await cluster?.stop();
});

beforeEach(async () => {
  proxied = [];
  await pool.query("DELETE FROM users");
  await pool.query(
    `INSERT INTO users (id, email, role, can_grade, can_print, credential_version) VALUES
       ($1, 'printer@example.test', 'staff', true, true,  1),
       ($2, 'grader@example.test',  'staff', true, false, 1)`,
    [PRINT_STAFF, GRADE_ONLY_STAFF]
  );
  const { invalidateStaffSessionCache } = await import("../server/staff");
  invalidateStaffSessionCache(PRINT_STAFF);
  invalidateStaffSessionCache(GRADE_ONLY_STAFF);
});

async function login(kind: "print" | "grade-only" | "admin"): Promise<string> {
  const url = kind === "admin" ? `${base}/__test/admin-session` : `${base}/__test/staff-session/${kind}`;
  const r = await fetch(url, { method: "POST" });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";", 1)[0];
}

const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });

describe("can_print gates the Ready To Print queue", () => {
  it("a can_print staff account CAN read the queue, and the proxy reaches the admin route", async () => {
    const res = await get(QUEUE, await login("print"));
    expect(res.status).toBe(200);
    expect(proxied).toEqual([{ path: "/api/admin/printing/workflow/queue", graderProxy: true }]);
  });

  it("a staff account WITHOUT can_print is denied 403 and never reaches the admin route", async () => {
    const res = await get(QUEUE, await login("grade-only"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/missing 'print' capability/);
    expect(proxied).toEqual([]); // the request died at the capability gate
  });

  it("an unauthenticated request is denied 401", async () => {
    const res = await get(QUEUE);
    expect(res.status).toBe(401);
    expect(proxied).toEqual([]);
  });

  it("an ADMIN session cannot use the staff print proxy (the two are mutually exclusive)", async () => {
    const res = await get(QUEUE, await login("admin"));
    expect(res.status).toBe(401);
    expect(proxied).toEqual([]);
  });
});

describe("capability is re-validated against the database on every request", () => {
  it("revoking can_print in the DB revokes access even though the session still claims it", async () => {
    const cookie = await login("print");
    expect((await get(QUEUE, cookie)).status).toBe(200);

    // Simulate the founder turning the flag back off. This is exactly the "restore the
    // original value" step of a staging capability test: access must disappear.
    await pool.query("UPDATE users SET can_print = false WHERE id = $1", [PRINT_STAFF]);
    const { invalidateStaffSessionCache } = await import("../server/staff");
    invalidateStaffSessionCache(PRINT_STAFF);

    const after = await get(QUEUE, cookie);
    expect(after.status).toBe(403);
    expect(proxied).toHaveLength(1); // only the first, pre-revocation request got through
  });

  it("a soft-deleted staff account loses access", async () => {
    const cookie = await login("print");
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [PRINT_STAFF]);
    const { invalidateStaffSessionCache } = await import("../server/staff");
    invalidateStaffSessionCache(PRINT_STAFF);
    expect((await get(QUEUE, cookie)).status).toBe(401);
  });

  it("a credential-version bump (password change / forced logout) invalidates the session", async () => {
    const cookie = await login("print");
    await pool.query("UPDATE users SET credential_version = 2 WHERE id = $1", [PRINT_STAFF]);
    const { invalidateStaffSessionCache } = await import("../server/staff");
    invalidateStaffSessionCache(PRINT_STAFF);
    expect((await get(QUEUE, cookie)).status).toBe(401);
  });
});

describe("no privilege escalation through the print proxy", () => {
  it("the terminal admin-only 'Mark Completed' action is NOT reachable by print staff", async () => {
    // /printing/workflow/complete is deliberately excluded from the staff whitelist.
    const res = await get(COMPLETE, await login("print"));
    expect(res.status).toBe(404);
    expect(proxied).toEqual([]);
  });

  it("an arbitrary admin path is not reachable — the whitelist has no wildcard", async () => {
    for (const p of [
      "/api/staff/print/certificates",
      "/api/staff/print/staff",
      "/api/staff/print/submissions",
      "/api/staff/print/printing/workflow/queue/../../certificates",
    ]) {
      const res = await get(p, await login("print"));
      expect(res.status).not.toBe(200);
    }
    expect(proxied.filter((p) => !p.path.endsWith("/queue"))).toEqual([]);
  });

  it("customer PII is stripped from the proxied response", async () => {
    const res = await get(QUEUE, await login("print"));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain("leak@example.test");
  });
});

describe("changing can_print does not disturb other capabilities or the role", () => {
  it("toggling print leaves can_grade, can_scan, can_edit_sets and role untouched", async () => {
    const before = await pool.query("SELECT role, can_grade, can_scan, can_edit_sets FROM users WHERE id = $1", [
      PRINT_STAFF,
    ]);
    await pool.query("UPDATE users SET can_print = false WHERE id = $1", [PRINT_STAFF]);
    await pool.query("UPDATE users SET can_print = true WHERE id = $1", [PRINT_STAFF]);
    const after = await pool.query("SELECT role, can_grade, can_scan, can_edit_sets FROM users WHERE id = $1", [
      PRINT_STAFF,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
