import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const spies = vi.hoisted(() => ({
  fresh: vi.fn(async () => false),
  complete: vi.fn(async () => ({ locationId: "11111111-1111-4111-8111-111111111111", candidateCount: 1 })),
}));
let callbackTestIp = 10;

vi.mock("../server/partner/step-up", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/step-up")>();
  return { ...actual, hasRecentStepUp: spies.fresh };
});

vi.mock("../server/partner/google-presence-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/google-presence-service")>();
  return {
    ...actual,
    getGooglePresenceCapability: vi.fn(async () => ({
      available: true as const,
      config: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://mintvaultuk.com/api/partner/google-business/callback",
        encryptionKey: Buffer.alloc(32, 1),
        keyVersion: 1,
      },
    })),
    completeGoogleBusinessOAuth: spies.complete,
  };
});

import { partnerApiRouter } from "../server/partner/routes";

describe("Google OAuth callback mutation guards (HTTP)", () => {
  let server: http.Server;
  let base: string;
  let userId: string;
  let clientIp: string;

  beforeEach(async () => {
    spies.fresh.mockReset().mockResolvedValue(false);
    spies.complete.mockReset().mockResolvedValue({
      locationId: "11111111-1111-4111-8111-111111111111",
      candidateCount: 1,
    });
    userId = randomUUID();
    clientIp = `198.51.100.${callbackTestIp++}`;
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { configurable: true, value: clientIp });
      const mode = req.headers["x-test-mode"];
      req.partner = {
        sessionId: "22222222-2222-4222-8222-222222222222",
        tenantId: "33333333-3333-4333-8333-333333333333",
        userId,
        locationId: "11111111-1111-4111-8111-111111111111",
        mfaPassed: true,
        permissions: new Set(["partner.location.view"]),
        viewOnly: mode === "view-only",
        sensitiveDisabled: mode === "sensitive-frozen",
        orgWide: true,
      };
      next();
    });
    app.use("/api/partner", partnerApiRouter());
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function callback(mode: string): Promise<Response> {
    return fetch(`${base}/api/partner/google-business/callback?state=opaque&code=code`, {
      headers: { "x-test-mode": mode },
      redirect: "manual",
    });
  }

  it("redirects view-only and sensitive-frozen sessions before step-up, state consumption or provider exchange", async () => {
    for (const mode of ["view-only", "sensitive-frozen"]) {
      const response = await callback(mode);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/partner/public-profile?google=frozen");
    }
    expect(spies.fresh).not.toHaveBeenCalled();
    expect(spies.complete).not.toHaveBeenCalled();
  });

  it("redirects a stale step-up before state consumption or provider exchange", async () => {
    spies.fresh.mockResolvedValue(false);
    const response = await callback("normal");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/partner/public-profile?google=step_up_required");
    expect(spies.complete).not.toHaveBeenCalled();
  });

  it("allows a fresh, mutable owner session to reach the bound callback service", async () => {
    spies.fresh.mockResolvedValue(true);
    const response = await callback("normal");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/partner/public-profile?google=select");
    expect(spies.complete).toHaveBeenCalledTimes(1);
  });

  it("bounds a Google OAuth callback before repeated provider exchanges", async () => {
    spies.fresh.mockResolvedValue(true);
    const responses: Response[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) responses.push(await callback("normal"));
    expect(responses.slice(0, 30).every((response) => response.status === 303)).toBe(true);
    expect(responses[30].status).toBe(429);
    expect(spies.complete).toHaveBeenCalledTimes(30);
  });
});
