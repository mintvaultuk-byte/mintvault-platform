/**
 * HTTP-level negative RBAC proof for the GB-04 API. The real auth middleware is
 * used; rejected identities never reach the database-backed Growth service.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

process.env.MINTVAULT_DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
process.env.SUPER_ADMIN_EMAILS = "growth-super-admin@example.test";

type FakeSession = Record<string, unknown>;
let server: Server;
let base: string;
let registerCommercialGrowthRoutes: typeof import("../server/routes/admin/commercial-growth").registerCommercialGrowthRoutes;
let COMMERCIAL_GROWTH_BASE: string;

function app(): Express {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    const raw = req.headers["x-test-session"];
    (req as unknown as { session: FakeSession }).session = typeof raw === "string" ? JSON.parse(raw) as FakeSession : {};
    if (req.headers["x-test-grader-proxy"] === "true") (req as unknown as { __graderProxy: boolean }).__graderProxy = true;
    next();
  });
  registerCommercialGrowthRoutes(instance);
  return instance;
}

function headers(session?: FakeSession, superProxy = false): HeadersInit {
  return {
    ...(session ? { "x-test-session": JSON.stringify(session) } : {}),
    ...(superProxy ? { "x-test-grader-proxy": "true" } : {}),
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${COMMERCIAL_GROWTH_BASE}${path}`, init);
}

beforeAll(async () => {
  ({ registerCommercialGrowthRoutes, COMMERCIAL_GROWTH_BASE } = await import("../server/routes/admin/commercial-growth"));
  const instance = app();
  await new Promise<void>((resolve) => { server = instance.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("GB-04 Super Admin Growth API boundary", () => {
  it.each(["/summary", "/leads", "/link-options"])("returns 401 to an unauthenticated request for %s", async (path) => {
    expect((await request(path)).status).toBe(401);
  });

  it("rejects customer, Partner and staff principals before any Growth handler runs", async () => {
    for (const session of [
      { userId: "customer-1", userEmail: "customer@example.test" },
      { partnerUserId: "partner-1", tenantId: "tenant-1" },
      { isStaff: true, staffId: "staff-1", staffEmail: "staff@example.test", capGrade: true },
    ]) {
      expect((await request("/summary", { headers: headers(session) })).status).toBe(401);
    }
  });

  it("returns 403, not data, to a grader and forged Super Admin claims", async () => {
    expect((await request("/summary", { headers: headers({ isGrader: true, graderId: "grader-1" }) })).status).toBe(403);
    expect((await request("/summary", { headers: { "x-super-admin": "true", "x-role": "admin" } })).status).toBe(401);
  });

  it("allows the real Super Admin gate to reach strict request validation without calling Growth data", async () => {
    const response = await request("/summary?period=not-a-period", {
      headers: headers({ isAdmin: true, adminEmail: "growth-super-admin@example.test" }, true),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "period must be today, 7d, 30d, 90d, or all" });
  });

  it("does not let an unauthenticated mutation parse or mutate an application", async () => {
    const response = await request("/leads/11111111-1111-4111-8111-111111111111/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ONBOARDING" }),
    });
    expect(response.status).toBe(401);
  });
});
