/**
 * Project Control — the seed execution API, over real HTTP against real PostgreSQL 17.
 *
 * The engine underneath is already proven. What is proven HERE is the seam: that the routes
 * authorise correctly, that they cannot be handed a manifest, that they project stable codes
 * rather than driver text, and that the production blockade survives contact with a request body
 * that is actively trying to get round it.
 *
 * These are the tests that would catch a route accidentally becoming the weakest link in an
 * otherwise careful system — a `force: true` that is silently ignored and therefore reads as
 * accepted, an error handler that echoes a constraint message, an apply that trusts a body field.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import session from "express-session";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PROJECT_CONTROL_FLAG_ENV } from "../server/project-control/flag";

const ROOT = join(__dirname, "..");
const M0030 = readFileSync(join(ROOT, "migrations/0030_project_control.sql"), "utf8");
const M0040 = readFileSync(join(ROOT, "migrations/0040_project_control_seed_reconciliation.sql"), "utf8");

const ADMIN_URL =
  process.env.PROJECT_CONTROL_TEST_ADMIN_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:5432/postgres`;
const DB_NAME = `pc_seed_routes_${process.pid}`;
const OPTIONAL = process.env.PROJECT_CONTROL_DB_TESTS === "optional";
const P = "/api/admin/project-control";
/** The single admin identity this codebase recognises (server/auth.ts). */
const SUPER_ADMIN_EMAIL = "mintvaultuk@gmail.com";

let admin: pg.Client | undefined;
let server: http.Server | undefined;
let base = "";
let reachable = false;
let bootError = "";
let clearConfirmations: () => void;

async function sql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const c = new pg.Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`) });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  try {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);

    // The router imports server/db at module load, so the URL must be set BEFORE that import.
    process.env.MINTVAULT_DATABASE_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);
    process.env.SESSION_SECRET ??= "project-control-seed-routes-not-real";
    process.env.SIGNED_URL_SECRET ??= "project-control-seed-routes-not-real";
    process.env.ADMIN_PASSWORD ??= "not-real";
    process.env.ADMIN_PIN ??= "000000";
    process.env[PROJECT_CONTROL_FLAG_ENV] = "true";
    delete process.env.PROJECT_CONTROL_ENV; // resolves to "local", never production

    const { registerProjectControlRoutes } = await import("../server/routes/admin/project-control");
    ({ clearConfirmations } = await import("../server/project-control/seed-repository"));

    const app: Express = express();
    // The expensive limiter (12/min) is real and shared process-wide. Rather than weaken it for
    // tests, each test calls from a DISTINCT client address, so the limiter is genuinely
    // exercised per-client instead of pooling this whole suite into one budget.
    app.set("trust proxy", true);
    app.use(express.json());
    app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
    app.post("/__forge/:role", (req, res) => {
      const s = req.session as unknown as Record<string, unknown>;
      switch (req.params.role) {
        case "superadmin":
          // The same fields production writes. requireAdmin then looks the admin user up in
          // storage and compares credentialVersion, so the users row below is load-bearing —
          // this exercises the UNMOCKED requireAdmin/requireSuperAdmin pair.
          s.isAdmin = true;
          s.adminEmail = SUPER_ADMIN_EMAIL;
          s.credentialVersion = 1;
          s.authenticatedAt = Date.now();
          break;
        case "staff":
          s.isGrader = true;
          break;
        case "partner":
          s.partnerUserId = "p1";
          s.tenantId = "t1";
          break;
        default:
          break;
      }
      req.session.save(() => res.json({ ok: true }));
    });
    registerProjectControlRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    reachable = true;
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  const { pool } = await import("../server/db").catch(() => ({ pool: undefined }) as never);
  await pool?.end?.().catch(() => {});
  if (admin) {
    await admin
      .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [
        DB_NAME,
      ])
      .catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {});
    await admin.end().catch(() => {});
  }
}, 60_000);

function guard(): void {
  if (!reachable) {
    if (OPTIONAL) throw new Error(`SKIPPED-BY-CONFIG: ${bootError}`);
    throw new Error(`Seed route suite could not boot, so the execution API was NOT proven: ${bootError}`);
  }
}

async function cookieFor(role: string): Promise<string> {
  const r = await fetch(`${base}/__forge/${role}`, { method: "POST" });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Distinct per test, so one test's expensive calls cannot exhaust another's rate budget. */
let clientId = 0;
let clientIp = "10.0.0.1";
function newClient(): void {
  clientId += 1;
  clientIp = `10.0.${Math.floor(clientId / 250)}.${(clientId % 250) + 1}`;
}

async function call(
  method: string,
  path: string,
  cookie = "",
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": clientIp,
      ...(cookie ? { cookie } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const USERS_DDL = `
  CREATE TABLE users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE,
    first_name varchar, last_name varchar, profile_image_url varchar,
    role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
    password_hash text, display_name text, email_verified boolean NOT NULL DEFAULT false,
    email_verified_at timestamp, last_login_at timestamp, last_login_ip text,
    failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp,
    last_failed_login_at timestamp, credential_version integer NOT NULL DEFAULT 1,
    admin_passphrase_hash text, pin_hash text, pin_set_at timestamp,
    pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp,
    public_name boolean NOT NULL DEFAULT false, can_grade boolean NOT NULL DEFAULT false,
    can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
    can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100
  )`;

async function resetSchema(): Promise<void> {
  newClient();
  await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await sql(M0030);
  await sql(M0040);
  // requireAdmin resolves the admin user from storage on every request, so the row must exist
  // for a super-admin session to be accepted at all.
  await sql(USERS_DDL);
  await sql("INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1)", [SUPER_ADMIN_EMAIL]);
  clearConfirmations();
}

const SEED_ROUTES: [string, string][] = [
  ["GET", `${P}/seed/status`],
  ["POST", `${P}/seed/dry-run`],
  ["POST", `${P}/seed/apply`],
  ["POST", `${P}/seed/report/latest`],
];

describe("seed execution API is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(process.env.PROJECT_CONTROL_TEST_ADMIN_URL).toBeTruthy();
      expect(OPTIONAL).toBe(false);
      expect(reachable, bootError).toBe(true);
    }
  });
});

describe("authorization — every seed route, every identity", () => {
  for (const role of ["none", "staff", "partner"]) {
    it(`rejects role="${role}" on all four seed routes`, async () => {
      guard();
      newClient();
      const cookie = role === "none" ? "" : await cookieFor(role);
      for (const [method, path] of SEED_ROUTES) {
        const { status } = await call(method, path, cookie);
        expect([401, 403], `${method} ${path} allowed role=${role}`).toContain(status);
      }
    });
  }

  it("returns 404 for every seed route when the feature flag is off", async () => {
    guard();
    newClient();
    const previous = process.env[PROJECT_CONTROL_FLAG_ENV];
    delete process.env[PROJECT_CONTROL_FLAG_ENV];
    try {
      const cookie = await cookieFor("superadmin");
      for (const [method, path] of SEED_ROUTES) {
        const { status } = await call(method, path, cookie);
        expect(status, `${method} ${path}`).toBe(404);
      }
    } finally {
      process.env[PROJECT_CONTROL_FLAG_ENV] = previous;
    }
  });
});

describe("status", () => {
  beforeEach(async () => {
    guard();
    await resetSchema();
  });

  it("reports a first-seed pending state on an empty database", async () => {
    const cookie = await cookieFor("superadmin");
    const { status, json } = await call("GET", `${P}/seed/status`, cookie);
    expect(status).toBe(200);
    expect(json.schemaPresent).toBe(true);
    expect(json.seedVersion).toBeNull();
    expect(json.mode).toBe("first_seed");
    expect(json.pending).toBe(true);
    expect(json.desiredManifestDigest).toBeTruthy();
    expect(json.latestReportId).toBeNull();
  });

  it("never leaks a connection string or database name", async () => {
    const cookie = await cookieFor("superadmin");
    const { json } = await call("GET", `${P}/seed/status`, cookie);
    const body = JSON.stringify(json);
    expect(body).not.toContain("postgres://");
    expect(body).not.toContain(DB_NAME);
  });
});

describe("dry run", () => {
  beforeEach(async () => {
    guard();
    await resetSchema();
  });

  it("returns a plan and a confirmation, and writes NOTHING", async () => {
    const cookie = await cookieFor("superadmin");
    const before = (
      await sql(
        "SELECT (SELECT count(*) FROM pc_work_packages) p,(SELECT count(*) FROM pc_seed_runs) r,(SELECT last_value FROM pc_work_packages_id_seq) s"
      )
    )[0];

    const { status, json } = await call("POST", `${P}/seed/dry-run`, cookie);
    expect(status).toBe(200);
    expect(json.confirmationToken).toBeTruthy();
    const plan = json.plan as Record<string, unknown>;
    expect(plan.mode).toBe("first_seed");
    expect(plan.applicable).toBe(true);

    const after = (
      await sql(
        "SELECT (SELECT count(*) FROM pc_work_packages) p,(SELECT count(*) FROM pc_seed_runs) r,(SELECT last_value FROM pc_work_packages_id_seq) s"
      )
    )[0];
    // Sequence included: an "apply then rollback" dry run would burn ids even with no rows left.
    expect(after).toEqual(before);
  }, 60_000);

  it("ignores nothing silently — a body carrying a manifest is REJECTED", async () => {
    const cookie = await cookieFor("superadmin");
    // Apply is the route with a body schema; a silently-dropped override reads as an accepted one.
    const { status, json } = await call("POST", `${P}/seed/apply`, cookie, {
      confirmationToken: "x".repeat(32),
      manifest: { version: 999, nodes: [], packages: [], supersessions: [] },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("Invalid request");
  });
});

describe("apply", () => {
  beforeEach(async () => {
    guard();
    await resetSchema();
  });

  async function preview(cookie: string): Promise<string> {
    const { json } = await call("POST", `${P}/seed/dry-run`, cookie);
    return String(json.confirmationToken);
  }

  it("executes exactly once and records a run", async () => {
    const cookie = await cookieFor("superadmin");
    const token = await preview(cookie);
    const { status, json } = await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: token });
    expect(status).toBe(200);
    expect(json.mode).toBe("first_seed");

    const counts = (
      await sql(
        "SELECT (SELECT count(*)::int FROM pc_work_packages) p,(SELECT count(*)::int FROM pc_seed_runs) r,(SELECT count(*)::int FROM pc_seed_state) s"
      )
    )[0];
    expect(Number(counts.p)).toBeGreaterThan(0);
    expect(Number(counts.r)).toBe(1);
    expect(Number(counts.s)).toBe(1);
  }, 120_000);

  it("refuses a replayed confirmation — apply is not idempotent by accident", async () => {
    const cookie = await cookieFor("superadmin");
    const token = await preview(cookie);
    expect((await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: token })).status).toBe(200);
    const replay = await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: token });
    expect(replay.status).toBe(409);
    expect(replay.json.code).toBe("digest_mismatch");
    // And nothing was applied twice.
    expect(Number((await sql("SELECT count(*)::int n FROM pc_seed_runs"))[0].n)).toBe(1);
  }, 120_000);

  it("refuses an unknown confirmation", async () => {
    const cookie = await cookieFor("superadmin");
    const { status, json } = await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: "n".repeat(48) });
    expect(status).toBe(409);
    expect(json.code).toBe("digest_mismatch");
    expect(Number((await sql("SELECT count(*)::int n FROM pc_work_packages"))[0].n)).toBe(0);
  });

  it("refuses a stale confirmation after the database moved", async () => {
    const cookie = await cookieFor("superadmin");
    const stale = await preview(cookie);
    const fresh = await preview(cookie);
    expect((await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: fresh })).status).toBe(200);
    const late = await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: stale });
    expect(late.status).toBe(409);
  }, 120_000);

  it("lets exactly one of two concurrent applies commit", async () => {
    const cookie = await cookieFor("superadmin");
    const t1 = await preview(cookie);
    const t2 = await preview(cookie);
    const [a, b] = await Promise.all([
      call("POST", `${P}/seed/apply`, cookie, { confirmationToken: t1 }),
      call("POST", `${P}/seed/apply`, cookie, { confirmationToken: t2 }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBe(1);
    expect(Number((await sql("SELECT count(*)::int n FROM pc_seed_runs"))[0].n)).toBe(1);
  }, 120_000);

  it("a second apply after a fresh preview is a no-op that inserts nothing", async () => {
    const cookie = await cookieFor("superadmin");
    await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: await preview(cookie) });
    const packagesAfterFirst = Number((await sql("SELECT count(*)::int n FROM pc_work_packages"))[0].n);

    const { status, json } = await call("POST", `${P}/seed/apply`, cookie, {
      confirmationToken: await preview(cookie),
    });
    expect(status).toBe(200);
    expect(json.noOp).toBe(true);
    expect(Number((await sql("SELECT count(*)::int n FROM pc_work_packages"))[0].n)).toBe(packagesAfterFirst);
  }, 120_000);

  it("never returns SQL, a driver error or a database name", async () => {
    const cookie = await cookieFor("superadmin");
    const token = await preview(cookie);
    await sql("ALTER TABLE pc_work_packages ADD CONSTRAINT tmp_break CHECK (title IS NULL)");
    try {
      const { status, json } = await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: token });
      expect(status).toBe(500);
      const body = JSON.stringify(json);
      expect(body).not.toMatch(/tmp_break|constraint|violates|relation|postgres:\/\/|syntax|SELECT |INSERT /i);
      expect(body).not.toContain(DB_NAME);
      expect(json.code).toBe("internal");
    } finally {
      await sql("ALTER TABLE pc_work_packages DROP CONSTRAINT IF EXISTS tmp_break");
    }
  }, 120_000);
});

describe("production blockade", () => {
  beforeEach(async () => {
    guard();
    await resetSchema();
  });

  it("refuses apply with 403 when the server resolves production, and writes nothing", async () => {
    const cookie = await cookieFor("superadmin");
    const { json: dry } = await call("POST", `${P}/seed/dry-run`, cookie);
    process.env.PROJECT_CONTROL_ENV = "production";
    try {
      const { status, json } = await call("POST", `${P}/seed/apply`, cookie, {
        confirmationToken: String(dry.confirmationToken),
      });
      expect(status).toBe(403);
      expect(json.code).toBe("production_blocked");
      expect(Number((await sql("SELECT count(*)::int n FROM pc_work_packages"))[0].n)).toBe(0);
    } finally {
      delete process.env.PROJECT_CONTROL_ENV;
    }
  }, 60_000);

  it("still allows a read-only dry run in production", async () => {
    const cookie = await cookieFor("superadmin");
    process.env.PROJECT_CONTROL_ENV = "production";
    try {
      expect((await call("POST", `${P}/seed/dry-run`, cookie)).status).toBe(200);
      expect(Number((await sql("SELECT count(*)::int n FROM pc_work_packages"))[0].n)).toBe(0);
    } finally {
      delete process.env.PROJECT_CONTROL_ENV;
    }
  }, 60_000);

  it("cannot be bypassed by a body field claiming otherwise", async () => {
    const cookie = await cookieFor("superadmin");
    const { json: dry } = await call("POST", `${P}/seed/dry-run`, cookie);
    process.env.PROJECT_CONTROL_ENV = "production";
    try {
      for (const body of [
        { confirmationToken: String(dry.confirmationToken), environment: "local" },
        { confirmationToken: String(dry.confirmationToken), productionOverride: true },
        { confirmationToken: String(dry.confirmationToken), environment: "local", force: true },
      ]) {
        const { status } = await call("POST", `${P}/seed/apply`, cookie, body);
        // .strict() rejects the unknown key (400); the blockade catches it otherwise (403).
        // What must never happen is 200.
        expect([400, 403]).toContain(status);
      }
      expect(Number((await sql("SELECT count(*)::int n FROM pc_work_packages"))[0].n)).toBe(0);
    } finally {
      delete process.env.PROJECT_CONTROL_ENV;
    }
  }, 60_000);
});

describe("latest report", () => {
  beforeEach(async () => {
    guard();
    await resetSchema();
  });

  it("is null before any run and populated after one", async () => {
    const cookie = await cookieFor("superadmin");
    expect((await call("POST", `${P}/seed/report/latest`, cookie)).json.report).toBeNull();

    const { json: dry } = await call("POST", `${P}/seed/dry-run`, cookie);
    await call("POST", `${P}/seed/apply`, cookie, { confirmationToken: String(dry.confirmationToken) });

    const { status, json } = await call("POST", `${P}/seed/report/latest`, cookie);
    expect(status).toBe(200);
    const report = json.report as Record<string, unknown>;
    expect(report.outcome).toBe("applied");
    expect(report.mode).toBe("first_seed");
    expect(String(report.summary).length).toBeLessThanOrEqual(4000);
  }, 120_000);
});
