import express, { type Express } from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveGlobalFlag = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: { getUserByEmail: vi.fn(async () => ({ id: "super-admin", email: "mintvaultuk@gmail.com", credentialVersion: 1, deletedAt: null })) },
}));
vi.mock("../server/account-auth", () => ({ verifyPassword: vi.fn(async () => true) }));
vi.mock("../server/command-centre/dashboard-service", () => ({
  composeCommandCentreDashboard: vi.fn(async (period: string) => ({ contractVersion: "1.0.0", asOf: "2026-08-19T00:00:00.000Z", period, kpis: {}, attention: [], registry: [], partialSourceIds: [] })),
}));
vi.mock("../server/partner/flags", () => ({
  resolveGlobalFlag,
}));

import { COMMAND_CENTRE_FLAG_ENV } from "../server/command-centre/flag";
import { registerCommandCentreRoutes } from "../server/command-centre/routes";

type FakeSession = Record<string, unknown>;
const sessions: Record<string, FakeSession> = {
  anonymous: {},
  customer: { isCustomer: true },
  partner: { partnerUserId: "partner" },
  staff: { isStaff: true, staffId: "staff" },
  grader: { isGrader: true, graderId: "grader" },
  admin: { isAdmin: true, adminEmail: "ordinary@example.com", credentialVersion: 1, authenticatedAt: Date.now() },
  super: { isAdmin: true, adminEmail: "mintvaultuk@gmail.com", credentialVersion: 1, authenticatedAt: Date.now() },
};

function app(): Express {
  const application = express();
  application.use((request, _response, next) => {
    const role = String(request.headers["x-test-role"] ?? "anonymous");
    (request as unknown as { session: FakeSession }).session = sessions[role] ?? sessions.anonymous;
    next();
  });
  registerCommandCentreRoutes(application);
  return application;
}

async function start(application: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = application.listen(0, "127.0.0.1", () => resolve(server));
  });
}
async function request(server: Server, role: string, suffix = ""): Promise<Response> {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return fetch("http://127.0.0.1:" + port + "/api/admin/command/dashboard" + suffix, { headers: { "x-test-role": role } });
}

describe("Command Centre dashboard route HTTP boundary", () => {
  const previousFlag = process.env[COMMAND_CENTRE_FLAG_ENV];
  const previousEmails = process.env.SUPER_ADMIN_EMAILS;
  afterEach(() => {
    if (previousFlag === undefined) delete process.env[COMMAND_CENTRE_FLAG_ENV]; else process.env[COMMAND_CENTRE_FLAG_ENV] = previousFlag;
    if (previousEmails === undefined) delete process.env.SUPER_ADMIN_EMAILS; else process.env.SUPER_ADMIN_EMAILS = previousEmails;
  });

  it("returns generic flag-off behaviour before the actual Super Admin route", async () => {
    resolveGlobalFlag.mockResolvedValue(false);
    const server = await start(app());
    try {
      const response = await request(server, "super");
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.each([
    ["anonymous", 401], ["customer", 401], ["partner", 401], ["staff", 401], ["grader", 403], ["admin", 403], ["super", 200],
  ])("enforces canonical status %i for %s on the registered dashboard endpoint", async (role, expectedStatus) => {
    resolveGlobalFlag.mockResolvedValue(true);
    process.env.SUPER_ADMIN_EMAILS = "mintvaultuk@gmail.com";
    const server = await start(app());
    try {
      const response = await request(server, role);
      expect(response.status).toBe(expectedStatus);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("rejects unknown and repeated query fields on the real registered route", async () => {
    resolveGlobalFlag.mockResolvedValue(true);
    process.env.SUPER_ADMIN_EMAILS = "mintvaultuk@gmail.com";
    const server = await start(app());
    try {
      expect((await request(server, "super", "?unknown=value")).status).toBe(400);
      expect((await request(server, "super", "?period=today&period=month_to_date")).status).toBe(400);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
