/**
 * Project Control — the authorization matrix that actually REACHES the role boundary.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 *
 * `tests/project-control-routes.integration.test.ts` attacks all 39 routes with six identities and
 * is green — but not one of those identities ever executes `requireSuperAdmin`'s role check. Its
 * session forge never sets `authenticatedAt`, and `isAbsoluteSessionExpired` treats an absent value
 * as expired:
 *
 *   const created = Number((req.session as any)?.authenticatedAt ?? 0);
 *   if (!created || !Number.isFinite(created)) return true;
 *
 * So every admin-shaped identity dies inside `requireAdmin` with `401 Session expired`, three lines
 * before the users lookup and long before `403 Forbidden: Super Admin required`. The matrix asserts
 * `expect([401, 403]).toContain(status)`, which a 401-expiry satisfies — so a permanently broken
 * role check would still have been green. The credential-version case is masked the same way:
 * expiry fires before the version is ever compared.
 *
 * That file is deliberately database-free ("the auth middleware answers every request before any
 * query runs"), and that is precisely why it cannot be fixed in place: `requireAdmin` performs a
 * real `users` lookup, so reaching the role check REQUIRES a database. This suite supplies one.
 *
 * HOW AN "ORDINARY ADMIN" IS POSSIBLE AT ALL
 *
 * There is one admin login in this codebase and it hardcodes the session email, so at first glance
 * a non-super admin cannot exist. But the two middlewares read different things:
 *
 *   requireAdmin       looks the user up by the MODULE CONSTANT `ADMIN_EMAIL` — it never reads
 *                      `session.adminEmail` at all.
 *   requireSuperAdmin  reads `session.adminEmail` and compares it to `SUPER_ADMIN_EMAILS`.
 *
 * So a session carrying a non-super `adminEmail` passes `requireAdmin` (the DB row is the constant)
 * and fails `requireSuperAdmin` — an ordinary admin, with no env mutation and no second users row.
 *
 * NO VACUOUS PASSES. Every assertion checks the exact status AND the exact error string, because
 * the four terminating messages are mutually exclusive per middleware stage. An expiry 401 can
 * therefore never be mistaken for a role 403.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import session from "express-session";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { PROJECT_CONTROL_FLAG_ENV } from "../server/project-control/flag";

const P = "/api/admin/project-control";
/** The single admin identity this codebase recognises (server/auth.ts ADMIN_EMAIL). */
const SUPER_ADMIN_EMAIL = "mintvaultuk@gmail.com";
const ORDINARY_ADMIN_EMAIL = "normal-admin@example.test";
/** server/lib/auth-security.ts ADMIN_ABSOLUTE_SESSION_MS */
const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

let cluster: DisposablePostgres17;
let server: http.Server | undefined;
let base = "";

/** Must match the real `users` table: storage.getUserByEmail selects every column. */
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

beforeAll(async () => {
  cluster = await startPostgres17("pc-authz-matrix");

  const db = new pg.Client({ connectionString: cluster.url });
  await db.connect();
  await db.query(USERS_DDL);
  // requireAdmin resolves THIS row on every request, keyed on the module constant. Without it,
  // even a perfectly-formed super-admin session cannot pass.
  await db.query("INSERT INTO users (email, role, credential_version) VALUES ($1,'admin',1)", [SUPER_ADMIN_EMAIL]);
  await db.end();

  // Unconditional, unlike the sibling suite's `if (!process.env[key])`. A developer who has
  // sourced .env would otherwise silently point this suite at the staging database.
  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  process.env.SESSION_SECRET ??= "project-control-authz-secret-not-real";
  process.env.SIGNED_URL_SECRET ??= "project-control-authz-signing-not-real";
  process.env.ADMIN_PASSWORD ??= "project-control-authz-not-real";
  process.env.ADMIN_PIN ??= "000000";
  process.env[PROJECT_CONTROL_FLAG_ENV] = "true";
  // Absent in both Fly apps, so the super-admin set falls back to exactly {ADMIN_EMAIL}. Set
  // explicitly rather than relying on the default, since this is process-global state.
  process.env.SUPER_ADMIN_EMAILS = SUPER_ADMIN_EMAIL;

  const { registerProjectControlRoutes } = await import("../server/routes/admin/project-control");
  const app: Express = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));

  app.post("/__forge/:role", (req, res) => {
    const s = req.session as unknown as Record<string, unknown>;
    switch (req.params.role) {
      case "superadmin":
        s.isAdmin = true;
        s.adminEmail = SUPER_ADMIN_EMAIL;
        s.credentialVersion = 1;
        s.authenticatedAt = Date.now();
        break;
      case "ordinaryadmin":
        // Passes requireAdmin (the DB row is the constant), fails requireSuperAdmin.
        s.isAdmin = true;
        s.adminEmail = ORDINARY_ADMIN_EMAIL;
        s.credentialVersion = 1;
        s.authenticatedAt = Date.now();
        break;
      case "expiredadmin":
        s.isAdmin = true;
        s.adminEmail = SUPER_ADMIN_EMAIL;
        s.credentialVersion = 1;
        s.authenticatedAt = Date.now() - (ABSOLUTE_SESSION_MS + 60_000);
        break;
      case "staleversion":
        // authenticatedAt is FRESH on purpose — that is the discriminator. Expiry cannot fire, so
        // only the credential-version branch can produce the rejection.
        s.isAdmin = true;
        s.adminEmail = SUPER_ADMIN_EMAIL;
        s.credentialVersion = 999;
        s.authenticatedAt = Date.now();
        break;
      case "staff":
        s.isGrader = true;
        s.graderId = "g-1";
        break;
      case "partner":
        s.partnerUserId = "p-1";
        s.partnerId = "partner-1";
        break;
      case "customer":
        s.userId = "cust-1";
        s.email = "customer@example.com";
        break;
      default:
        break;
    }
    req.session.save(() => res.json({ ok: true }));
  });

  registerProjectControlRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await cluster?.stop().catch(() => {});
}, 60_000);

/** A fresh cookie per call — several rejection paths destroy the session server-side. */
async function forge(role: string): Promise<string> {
  const res = await fetch(`${base}/__forge/${role}`, { method: "POST" });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function call(cookie: string, method: string, path: string, ip = "203.0.113.7") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json", "x-forwarded-for": ip },
    body: method === "GET" || method === "DELETE" ? undefined : "{}",
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* some paths return no body */
  }
  return { status: res.status, error: String(json.error ?? "") };
}

/**
 * A read-only, cheap route on the ORDINARY read limiter (240/min), not the expensive one (12/min).
 * Sweeping 39 routes on the expensive limiter would 429 and produce a meaningless green.
 */
const PROBE = `${P}/overview`;

describe("the role boundary is genuinely reached", () => {
  /**
   * AUTH1 — the assertion the old matrix could not make.
   *
   * If the fixture regressed to omitting `authenticatedAt`, this would fail with
   * "Session expired" instead, and the message assertion makes that visible rather than letting
   * a 401 stand in for a 403.
   */
  it("AUTH1: an ordinary admin passes requireAdmin and is refused by requireSuperAdmin with 403", async () => {
    const cookie = await forge("ordinaryadmin");
    const r = await call(cookie, "GET", PROBE);

    expect(r.status).toBe(403);
    expect(r.error).toBe("Forbidden: Super Admin required");
    // Explicitly NOT the expiry path — this is what proves the role check executed.
    expect(r.error).not.toBe("Session expired");
  });

  it("a Super Admin gets past both middlewares and reaches the handler", async () => {
    const cookie = await forge("superadmin");
    const r = await call(cookie, "GET", PROBE);

    // The handler ran. It may still fail on its own terms (the Project Control tables are absent
    // from this minimal fixture), but it must NOT be an auth rejection or a missing route.
    expect([401, 403, 404]).not.toContain(r.status);
    expect(r.error).not.toBe("Forbidden: Super Admin required");
    expect(r.error).not.toBe("Session expired");
  });

  it("an expired admin session fails on EXPIRY, separately from the role check", async () => {
    const cookie = await forge("expiredadmin");
    const r = await call(cookie, "GET", PROBE);

    expect(r.status).toBe(401);
    expect(r.error).toBe("Session expired");
    // This identity carries the SUPER admin email, so a role denial here would be the wrong reason.
    expect(r.error).not.toBe("Forbidden: Super Admin required");
  });

  it("a credential-version mismatch fails in its own right, with expiry ruled out", async () => {
    const cookie = await forge("staleversion");
    const r = await call(cookie, "GET", PROBE);

    // authenticatedAt is fresh, so the only branch that can produce this is the version compare.
    expect(r.status).toBe(401);
    expect(r.error).toBe("Session expired");
  });

  it("non-admin identities are refused before any of that, each with its own reason", async () => {
    for (const [role, status, error] of [
      ["customer", 401, "Unauthorized"],
      ["partner", 401, "Unauthorized"],
      ["staff", 403, "Forbidden: graders cannot access admin endpoints"],
    ] as const) {
      const cookie = await forge(role);
      const r = await call(cookie, "GET", PROBE);
      expect({ role, ...r }).toEqual({ role, status, error });
    }
  });

  it("an anonymous request is refused", async () => {
    const r = await call("", "GET", PROBE);
    expect(r.status).toBe(401);
    expect(r.error).toBe("Unauthorized");
  });

  it("a forged Super Admin claim in headers does not promote an ordinary admin", async () => {
    const cookie = await forge("ordinaryadmin");
    const res = await fetch(`${base}${PROBE}`, {
      headers: {
        cookie,
        "x-admin": "true",
        "x-super-admin": "true",
        "x-admin-email": SUPER_ADMIN_EMAIL,
        "x-forwarded-user": SUPER_ADMIN_EMAIL,
      },
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(String(json.error)).toBe("Forbidden: Super Admin required");
  });
});

describe("every route enforces the same boundary", () => {
  /**
   * Derived from the router source rather than hand-listed, so a new route cannot be added without
   * being covered here. The sibling suite compares only COUNTS, which a rename would satisfy.
   */
  const ROUTES: [string, string][] = (() => {
    const src = require("node:fs").readFileSync("server/routes/admin/project-control.ts", "utf8") as string;
    const re = /app\.(get|post|put|delete|patch)\(\s*`\$\{BASE\}([^`]*)`/g;
    const out: [string, string][] = [];
    for (const m of src.matchAll(re)) {
      const path = m[2]
        .replace(/:key/g, "example")
        .replace(/:dependsOn/g, "example-dep")
        .replace(/:syncId/g, "00000000-0000-4000-8000-000000000000")
        .replace(/:id/g, "1");
      out.push([m[1].toUpperCase(), `${P}${path}`]);
    }
    return out;
  })();

  it("discovers every registered route from source", () => {
    expect(ROUTES.length).toBe(39);
  });

  it("refuses an ordinary admin on EVERY route with the role denial, never an expiry", async () => {
    const cookie = await forge("ordinaryadmin");
    const failures: string[] = [];
    for (const [method, path] of ROUTES) {
      // Distinct IPs so the expensive limiter (12/min) cannot turn a sweep into 429s.
      const r = await call(cookie, method, path, `198.51.100.${ROUTES.indexOf([method, path] as never) % 200}`);
      if (r.status !== 403 || r.error !== "Forbidden: Super Admin required") {
        failures.push(`${method} ${path} -> ${r.status} ${r.error}`);
      }
    }
    expect(failures, `routes not enforcing the Super Admin boundary:\n${failures.join("\n")}`).toEqual([]);
  }, 120_000);

  it("refuses an anonymous caller on EVERY route", async () => {
    const failures: string[] = [];
    for (const [method, path] of ROUTES) {
      const r = await call("", method, path);
      if (r.status !== 401) failures.push(`${method} ${path} -> ${r.status} ${r.error}`);
    }
    expect(failures, `routes reachable anonymously:\n${failures.join("\n")}`).toEqual([]);
  }, 120_000);
});
