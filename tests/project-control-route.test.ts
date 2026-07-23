import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const runtime = vi.hoisted(() => ({
  enabled: true,
  deleted: false,
  buildCalls: 0,
}));

vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({
  storage: {
    getUserByEmail: vi.fn(async () => ({
      id: "super-admin-user",
      email: "owner@example.test",
      credentialVersion: 1,
      deletedAt: runtime.deleted ? new Date() : null,
    })),
  },
}));
vi.mock("../server/project-control/service", () => ({
  isProjectControlEnabled: vi.fn(async () => runtime.enabled),
  buildProjectControlSnapshot: vi.fn(async () => {
    runtime.buildCalls++;
    return {
      requirements: [],
      evidence: [],
      statuses: [],
      summary: { readOnly: true, totals: {}, readiness: {}, recommendations: [] },
      prompt: { snapshotId: "test-snapshot", promptText: "safe", sourceEvidenceIds: [] },
    };
  }),
}));

let server: Server;
let base: string;

async function sessionCookie(kind: "super" | "normal" | "malformed" | "expired"): Promise<string> {
  const response = await fetch(`${base}/__test/session/${kind}`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";", 1)[0];
}

function request(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, options);
}

describe("Project Control HTTP authorization and feature gate", () => {
  beforeAll(async () => {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.test";
    const { registerProjectControlRoutes } = await import("../server/routes/project-control");
    const app = express();
    app.use(session({ secret: "project-control-route-test", resave: false, saveUninitialized: false, cookie: { secure: false } }));
    app.post("/__test/session/:kind", (req, res) => {
      const kind = req.params.kind as "super" | "normal" | "malformed" | "expired";
      Object.assign(req.session, {
        isAdmin: true,
        adminEmail: kind === "super" || kind === "expired" ? "owner@example.test" : kind === "normal" ? "normal@example.test" : undefined,
        credentialVersion: 1,
        authenticatedAt: kind === "expired" ? 0 : Date.now(),
      });
      req.session.save((error) => (error ? res.status(500).json({ error: "session" }) : res.json({ ok: true })));
    });
    registerProjectControlRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    runtime.enabled = true;
    runtime.deleted = false;
    runtime.buildCalls = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("rejects unauthenticated, normal-admin, malformed, expired, and revoked sessions before scanning", async () => {
    expect((await request("/api/super-admin/project-control/summary")).status).toBe(401);

    for (const kind of ["normal", "malformed", "expired"] as const) {
      const cookie = await sessionCookie(kind);
      const response = await request("/api/super-admin/project-control/summary", { headers: { cookie } });
      expect(response.status).toBe(kind === "expired" ? 401 : 403);
    }

    runtime.deleted = true;
    const revokedCookie = await sessionCookie("super");
    expect((await request("/api/super-admin/project-control/summary", { headers: { cookie: revokedCookie } })).status).toBe(401);
    expect(runtime.buildCalls).toBe(0);
  });

  it("fails closed when the configured runtime flag is unavailable or disabled", async () => {
    runtime.enabled = false;
    const cookie = await sessionCookie("super");
    const response = await request("/api/super-admin/project-control/summary", { headers: { cookie } });

    expect(response.status).toBe(403);
    expect(runtime.buildCalls).toBe(0);
  });

  it("allows a configured Super Admin only when the server-side gate succeeds and exposes no mutation route", async () => {
    const cookie = await sessionCookie("super");
    const response = await request("/api/super-admin/project-control/summary", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ readOnly: true });
    expect(runtime.buildCalls).toBe(1);
    expect((await request("/api/super-admin/project-control/summary", { method: "POST", headers: { cookie } })).status).toBe(404);
  });
});
