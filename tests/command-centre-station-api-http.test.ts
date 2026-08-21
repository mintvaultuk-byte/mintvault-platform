import express, { type Express } from "express";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/storage", () => ({ storage: { getUserByEmail: vi.fn(async () => ({ id: "super-admin", email: "mintvaultuk@gmail.com", credentialVersion: 1, deletedAt: null })) } }));
vi.mock("../server/account-auth", () => ({ verifyPassword: vi.fn(async () => true) }));
vi.mock("../server/db", () => ({ db: { execute: vi.fn() } }));
vi.mock("../server/partner/station-service", () => ({
  listFleetStations: vi.fn(async () => ({ stations: [], total: 0, page: 1, pageSize: 20 })),
  transitionStationStatus: vi.fn(), rejectPendingStation: vi.fn(),
}));

import { registerPartnerStationAdminRoutes } from "../server/partner/station-admin-routes";

const sessions: Record<string, Record<string, unknown>> = {
  anonymous: {}, customer: { isCustomer: true }, partner: { partnerUserId: "partner" }, staff: { isStaff: true }, grader: { isGrader: true },
  admin: { isAdmin: true, adminEmail: "ordinary@example.com", credentialVersion: 1, authenticatedAt: Date.now() },
  super: { isAdmin: true, adminEmail: "mintvaultuk@gmail.com", credentialVersion: 1, authenticatedAt: Date.now() },
};
function app(): Express {
  const application = express();
  application.use((request, _response, next) => { (request as unknown as { session: Record<string, unknown> }).session = sessions[String(request.headers["x-test-role"] ?? "anonymous")] ?? {}; next(); });
  registerPartnerStationAdminRoutes(application);
  return application;
}
async function start(application: Express): Promise<Server> { return new Promise((resolve) => { const server = application.listen(0, "127.0.0.1", () => resolve(server)); }); }
async function get(server: Server, role: string) {
  const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
  return fetch("http://127.0.0.1:" + port + "/api/super-admin/fleet/stations", { headers: { "x-test-role": role } });
}

describe("canonical station-management API Super Admin boundary", () => {
  it.each([["anonymous", 401], ["customer", 401], ["partner", 401], ["staff", 401], ["grader", 403], ["admin", 403], ["super", 200]])("returns canonical status %i for %s", async (role, expectedStatus) => {
    process.env.SUPER_ADMIN_EMAILS = "mintvaultuk@gmail.com";
    const server = await start(app());
    try { expect((await get(server, role)).status).toBe(expectedStatus); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
