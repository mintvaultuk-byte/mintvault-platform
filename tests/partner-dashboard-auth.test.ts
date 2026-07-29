/**
 * Partner Master Dashboard — auth boundary.
 *
 * This is the highest-privilege cross-tenant READ in the application, so the gate matters more
 * than any single query. These cases are deliberately chosen to run WITHOUT a database: each
 * one is rejected by `requireSuperAdmin` before any storage call is reached, which is exactly
 * the property being asserted — an unauthorised caller must never reach the data layer at all.
 *
 * The admin-but-not-super-admin case does need a DB (requireAdmin re-loads the admin user), so
 * it is covered by the DB-backed integration suite rather than fabricated here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

/**
 * `server/auth.ts` imports the storage layer, which reads MINTVAULT_DATABASE_URL at module
 * load. A placeholder is set here so the module graph can load. NOTHING in this suite executes
 * a query — every request is rejected by the guard before any handler runs — and `pg`/Neon
 * pools connect lazily, so no connection is ever opened to this or any other host.
 */
process.env.MINTVAULT_DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";

/** Session shape injected per-request by a test header, so no session store is needed. */
type FakeSession = Record<string, unknown>;

let server: Server;
let base: string;
let partnerDashboardRouter: () => express.Router;
let PARTNER_DASHBOARD_BASE: string;

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  // Inject a synthetic session / proxy flag from test headers BEFORE the router.
  app.use((req, _res, next) => {
    const raw = req.headers["x-test-session"];
    if (typeof raw === "string" && raw.length > 0) {
      (req as unknown as { session: FakeSession }).session = JSON.parse(raw) as FakeSession;
    } else {
      (req as unknown as { session: FakeSession }).session = {} as FakeSession;
    }
    if (req.headers["x-test-grader-proxy"] === "true") {
      (req as unknown as { __graderProxy: boolean }).__graderProxy = true;
    }
    next();
  });

  app.use(PARTNER_DASHBOARD_BASE, partnerDashboardRouter());
  return app;
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${PARTNER_DASHBOARD_BASE}${path}`, { headers });
}

beforeAll(async () => {
  // Imported dynamically so the env placeholder above is set before the module graph loads.
  const mod = await import("../server/partner/dashboard-routes");
  partnerDashboardRouter = mod.partnerDashboardRouter;
  PARTNER_DASHBOARD_BASE = mod.PARTNER_DASHBOARD_BASE;

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ENDPOINTS = [
  "/summary",
  "/partners",
  "/alerts",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/overview",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/staff",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/wallet",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/submissions",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/quality",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/devices",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/corrections",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/security",
  "/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/audit",
];

describe("every dashboard endpoint rejects an unauthenticated caller", () => {
  it.each(ENDPOINTS)("401 for %s with no session", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(401);
  });
});

describe("non-admin identities cannot reach the dashboard", () => {
  it("rejects a partner-portal principal (partner sessions live on a different cookie entirely)", async () => {
    const res = await get("/summary", {
      "x-test-session": JSON.stringify({ partnerUserId: "abc", tenantId: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a customer session", async () => {
    const res = await get("/summary", {
      "x-test-session": JSON.stringify({ userId: "u1", userEmail: "customer@example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a staff session, including one carrying every capability flag", async () => {
    const res = await get("/partners", {
      "x-test-session": JSON.stringify({
        isStaff: true,
        staffId: "s1",
        staffEmail: "staff@example.com",
        capGrade: true,
        capScan: true,
        capPrint: true,
        capEditSets: true,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a grader session with 403, never 200", async () => {
    const res = await get("/summary", {
      "x-test-session": JSON.stringify({ isGrader: true, graderId: "g1" }),
    });
    expect(res.status).toBe(403);
  });

  it("cannot be forged with headers claiming admin", async () => {
    const res = await get("/summary", { "x-admin": "true", "x-role": "admin", "x-super-admin": "true" });
    expect(res.status).toBe(401);
  });

  it("ignores a body/query-supplied admin claim", async () => {
    const res = await get("/partners?isAdmin=true&superAdmin=1");
    expect(res.status).toBe(401);
  });
});

describe("the __graderProxy bypass in requireAdmin does NOT open this surface", () => {
  // requireAdmin returns next() unconditionally when __graderProxy is set. requireSuperAdmin
  // wraps that and then checks session.adminEmail, which a proxied request does not have —
  // so the proxy path terminates at 403. This is a primary reason the dashboard uses the
  // stricter gate rather than requireAdmin.
  it.each(ENDPOINTS)("403 for %s when proxied with no admin identity", async (path) => {
    const res = await get(path, { "x-test-grader-proxy": "true" });
    expect(res.status).toBe(403);
  });

  it("still refuses when the proxy flag is combined with a staff session", async () => {
    const res = await get("/summary", {
      "x-test-grader-proxy": "true",
      "x-test-session": JSON.stringify({ isStaff: true, staffId: "s1", staffEmail: "s@example.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a proxied request whose adminEmail is not in the super-admin allowlist", async () => {
    const res = await get("/summary", {
      "x-test-grader-proxy": "true",
      "x-test-session": JSON.stringify({ isAdmin: true, adminEmail: "not-the-super-admin@example.com" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(JSON.stringify(body)).toMatch(/super admin/i);
  });
});

describe("rejections leak nothing", () => {
  it("does not return partner data or internals in an unauthorised response", async () => {
    const res = await get("/partners");
    const text = await res.text();
    expect(res.status).toBe(401);
    for (const leak of ["legal_name", "password_hash", "token_hash", "tenant_id", "partner_organisations", "SELECT"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("returns no rows array on a rejected drill-down", async () => {
    const res = await get("/partners/3f2504e0-4f89-11d3-9a0c-0305e82c3301/staff", {
      "x-test-grader-proxy": "true",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.staff).toBeUndefined();
    expect(body.rows).toBeUndefined();
  });
});
