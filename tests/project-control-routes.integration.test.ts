/**
 * Project Control — runtime authorization and activation-flag suite.
 *
 * This is a RUNTIME proof, not a source assertion. It boots a real Express app with only the
 * Project Control router attached, over real HTTP, and attacks every registered route with every
 * identity class.
 *
 * NO VACUOUS PASSES. The previous version wrapped every assertion in `if (!available) return;`,
 * so a router that failed to boot reported five green ticks having proved nothing. Here, a boot
 * failure FAILS the suite loudly in `beforeAll`.
 *
 * It never touches a database: the activation flag and the auth middleware answer every request
 * in this file before any query runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import session from "express-session";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_CONTROL_FLAG_ENV } from "../server/project-control/flag";

let server: http.Server;
let base = "";

/**
 * Startup config validation demands these exist. Obviously-fake placeholders are used and NO
 * connection is ever opened — the pool is constructed and never queried. Real values are never
 * read here.
 */
function stubRequiredConfig(): void {
  const placeholders: Record<string, string> = {
    MINTVAULT_DATABASE_URL: "postgres://project-control-test:not-a-real-password@127.0.0.1:1/none",
    SESSION_SECRET: "project-control-test-session-secret-not-real",
    SIGNED_URL_SECRET: "project-control-test-signing-secret-not-real",
    ADMIN_PASSWORD: "project-control-test-not-real",
    ADMIN_PIN: "000000",
  };
  for (const [key, value] of Object.entries(placeholders)) {
    if (!process.env[key]) process.env[key] = value;
  }
  /**
   * The database URL is overridden UNCONDITIONALLY, unlike the rest.
   *
   * The conditional form above means a developer who has sourced .env — which points at STAGING —
   * would silently run this suite against it. Nothing here should ever open a connection, but the
   * file's promise is "it never touches a database", and that promise must not depend on the
   * caller's shell.
   */
  process.env.MINTVAULT_DATABASE_URL = placeholders.MINTVAULT_DATABASE_URL;
}

beforeAll(async () => {
  stubRequiredConfig();
  // Enabled for the authorization tests; the flag itself is exercised separately below.
  process.env[PROJECT_CONTROL_FLAG_ENV] = "true";

  const { registerProjectControlRoutes } = await import("../server/routes/admin/project-control");
  const app: Express = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));

  // Forge each identity class straight into the session — the strongest possible attacker.
  app.post("/__forge/:role", (req, res) => {
    const s = req.session as unknown as Record<string, unknown>;
    switch (req.params.role) {
      case "customer":
        s.userId = "cust-1";
        s.email = "customer@example.com";
        break;
      case "staff":
        s.isGrader = true;
        s.graderId = "g1";
        break;
      case "partner":
        s.partnerUserId = "p1";
        s.tenantId = "t1";
        break;
      case "malformed":
        s.isAdmin = "yes";
        s.adminEmail = 12345;
        break;
      case "suspended":
        s.isAdmin = true;
        s.adminEmail = "";
        s.credentialVersion = 999;
        break;
      default:
        break;
    }
    req.session.save(() => res.json({ ok: true }));
  });

  registerProjectControlRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function cookieFor(role: string): Promise<string> {
  const r = await fetch(`${base}/__forge/${role}`, { method: "POST" });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

async function call(method: string, path: string, cookie = ""): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: method === "GET" || method === "DELETE" ? undefined : "{}",
  });
  return res.status;
}

const P = "/api/admin/project-control";

/**
 * EVERY registered route and verb. Kept in step with the router by a completeness test below that
 * counts `app.<verb>(` registrations in the source and fails if this list falls behind.
 */
const ALL_ROUTES: [string, string][] = [
  ["GET", `${P}/overview`],
  ["GET", `${P}/queues`],
  ["GET", `${P}/drift`],
  ["GET", `${P}/packages/example`],
  ["POST", `${P}/packages`],
  ["PUT", `${P}/packages/example`],
  ["POST", `${P}/packages/example/evidence`],
  ["POST", `${P}/packages/example/blockers`],
  ["POST", `${P}/blockers/1/resolve`],
  ["POST", `${P}/packages/example/dependencies`],
  ["DELETE", `${P}/packages/example/dependencies/other`],
  ["POST", `${P}/packages/example/prompt`],
  ["GET", `${P}/packages/example/prompts`],
  ["GET", `${P}/prompts`],
  ["GET", `${P}/repository`],
  ["GET", `${P}/evidence-scan`],
  ["GET", `${P}/deployments`],
  ["POST", `${P}/deployments`],
  ["GET", `${P}/tests`],
  ["POST", `${P}/tests`],
  ["GET", `${P}/audit`],
  ["GET", `${P}/views/shop-launch`],
  ["GET", `${P}/views/scanner`],
  // The distributed live-evidence programme view. Registered with `gatedExpensive` because it
  // shells out to git per lane and reads the migration ledger, so it must share /repository's
  // stricter limiter rather than the ordinary read budget.
  ["GET", `${P}/views/distributed-shop-launch`],
  // Live GitHub evidence. Expensive (external API) and read-only; the token is server-side
  // only and never appears in the response.
  ["GET", `${P}/github`],
  // GitHub + application-version + feature-flag evidence composed into one view. Expensive: it
  // fans out to the GitHub API and to both allowlisted /api/version endpoints. Every sub-probe
  // fails soft on its own, so one unreachable environment cannot blank the evidence beside it.
  ["GET", `${P}/live-evidence`],
  // Durable sync control. POST starts a run and returns 202 immediately — it never holds the
  // request open for a full GitHub scan. The two GETs poll the durable run; the database run and
  // lease are authoritative, so a client that disconnects loses nothing.
  ["POST", `${P}/sync/github`],
  ["GET", `${P}/sync/latest`],
  ["GET", `${P}/sync/example-id`],
  // Probe refresh. Same 202/coalesce contract as the GitHub sync; targets come from a frozen
  // allowlist, never from the request, so neither can be aimed at an arbitrary host.
  ["POST", `${P}/sync/applications`],
  ["POST", `${P}/sync/flags`],
  // Migration evidence for the CONNECTED environment only — not parameterised, because a staging
  // process cannot speak for production and accepting a target would imply it could.
  ["POST", `${P}/sync/databases`],
  // The composed overview. Ordinary read gate, not gatedExpensive, because it makes ZERO external
  // calls — looking at the dashboard must never spend GitHub quota.
  ["GET", `${P}/composed-overview`],
  // Seed reconciliation execution surface. Read routes use the ordinary budget; dry-run and
  // apply are `gatedExpensive` because they open a dedicated connection and take an advisory
  // lock. None accepts a caller-supplied manifest — the desired structure is compiled.
  ["GET", `${P}/seed/status`],
  ["POST", `${P}/seed/dry-run`],
  ["POST", `${P}/seed/apply`],
  ["POST", `${P}/seed/report/latest`],
  ["GET", `${P}/export`],
  ["POST", `${P}/seed`],
];

describe("route inventory", () => {
  it("covers every registered route — the list cannot silently fall behind the router", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "server/routes/admin/project-control.ts"), "utf8");
    const registered = [...source.matchAll(/^\s*app\.(get|post|put|delete)\(/gm)];
    expect(registered.length).toBe(ALL_ROUTES.length);
  });

  it("registers every route behind BOTH the activation flag and requireSuperAdmin", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "server/routes/admin/project-control.ts"), "utf8");
    // Two shared gates exist: the ordinary one and the expensive one, which adds a tighter
    // limiter for routes that spawn subprocesses or sweep whole tables. Every route uses one.
    const registrations = [
      ...source.matchAll(/app\.(get|post|put|delete)\(\s*`\$\{BASE\}([^`]*)`\s*,\s*\.\.\.gated(?:Expensive)?/g),
    ];
    expect(registrations.length).toBe(ALL_ROUTES.length);
    // The gate order is flag FIRST, then super-admin — so a disabled feature is indistinguishable
    // from an absent one even to an authenticated caller.
    expect(source).toMatch(
      /const gated = \[requireProjectControlEnabled, requireSuperAdmin, projectControlReadLimit\] as const/
    );
    expect(source).toMatch(/const gatedExpensive = \[\s*requireProjectControlEnabled,\s*requireSuperAdmin,/);
  });
});

describe("HOSTILE authorization — every route, every verb, every identity", () => {
  const ROLES = ["none", "customer", "staff", "partner", "malformed", "suspended"];

  for (const role of ROLES) {
    it(`rejects role="${role}" on all ${ALL_ROUTES.length} routes`, async () => {
      const cookie = role === "none" ? "" : await cookieFor(role);
      for (const [method, path] of ALL_ROUTES) {
        const status = await call(method, path, cookie);
        expect(status, `${role} ${method} ${path} returned ${status}`).not.toBe(404);
        expect(status, `${role} ${method} ${path} returned ${status}`).not.toBe(200);
        expect([401, 403], `${role} ${method} ${path} returned ${status}`).toContain(status);
      }
    });
  }

  it("cannot be reached by forging headers", async () => {
    const res = await fetch(`${base}${P}/overview`, {
      headers: {
        "x-admin": "true",
        "x-is-admin": "1",
        "x-admin-email": "attacker@example.com",
        "x-super-admin": "true",
        "x-forwarded-user": "admin@mintvaultuk.com",
      },
    });
    expect([401, 403]).toContain(res.status);
  });

  it("leaks nothing in a rejection body", async () => {
    for (const [method, path] of ALL_ROUTES) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" || method === "DELETE" ? undefined : "{}",
      });
      const text = await res.text();
      expect(text, `${method} ${path}`).not.toMatch(/postgres|password|sk_live|secret|token|npg_/i);
    }
  });

  it("a guessed package key is no more reachable than any other", async () => {
    for (const key of ["core-grading-engine", "partner-auth-rbac", "admin", "1", "x"]) {
      expect([401, 403]).toContain(await call("GET", `${P}/packages/${key}`));
    }
  });
});

describe("activation flag — fail closed", () => {
  const original = process.env[PROJECT_CONTROL_FLAG_ENV];
  afterAll(() => {
    process.env[PROJECT_CONTROL_FLAG_ENV] = original;
  });

  // Everything that is not an exact affirmative (after trimming) must disable the feature.
  const DISABLING_VALUES = ["", "false", "0", "no", "off", "TRUE-ish", "maybe", "  ", "yes please", "true1"];

  it.each(DISABLING_VALUES)("returns 404 for every route when the flag is %j", async (value) => {
    process.env[PROJECT_CONTROL_FLAG_ENV] = value;
    for (const [method, path] of ALL_ROUTES.slice(0, 6)) {
      expect(await call(method, path), `${method} ${path} with flag=${value}`).toBe(404);
    }
  });

  it("returns 404 when the flag is absent entirely", async () => {
    delete process.env[PROJECT_CONTROL_FLAG_ENV];
    for (const [method, path] of ALL_ROUTES) {
      expect(await call(method, path), `${method} ${path} with no flag`).toBe(404);
    }
  });

  it("the disabled response names the flag but never its value", async () => {
    delete process.env[PROJECT_CONTROL_FLAG_ENV];
    const res = await fetch(`${base}${P}/overview`);
    const body = (await res.json()) as { flag: string; enabled: boolean };
    expect(body.flag).toBe("super_admin_project_control_enabled");
    expect(body.enabled).toBe(false);
    expect(JSON.stringify(body)).not.toContain("SUPER_ADMIN_PROJECT_CONTROL_ENABLED=");
  });

  it("the flag gate runs BEFORE authentication, so a disabled feature is indistinguishable from an absent one", async () => {
    delete process.env[PROJECT_CONTROL_FLAG_ENV];
    const anonymous = await call("GET", `${P}/overview`);
    const withCookie = await call("GET", `${P}/overview`, await cookieFor("customer"));
    expect(anonymous).toBe(404);
    expect(withCookie).toBe(404);
  });

  it("only explicit affirmative values enable it", async () => {
    // Surrounding whitespace is trimmed — "1 " is still an explicit yes, not an accident.
    for (const value of ["true", "TRUE", " true ", "1", "1 ", "yes", "on", "enabled"]) {
      process.env[PROJECT_CONTROL_FLAG_ENV] = value;
      // Enabled ⇒ the auth gate answers instead of the flag gate.
      expect([401, 403], `flag=${value}`).toContain(await call("GET", `${P}/overview`));
    }
  });
});
