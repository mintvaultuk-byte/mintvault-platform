import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const spies = vi.hoisted(() => ({
  directory: vi.fn(),
  list: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("../server/partner/public-presence-service", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../server/partner/public-presence-service");
  return {
    ...actual,
    getPublicPartnerDirectoryState: spies.directory,
    listPublicPartnerLocations: spies.list,
    getPublicPartnerLocation: spies.profile,
  };
});

import { PublicPartnerPresenceUnavailableError } from "../server/partner/public-presence-service";
import { registerPublicPartnerPresenceRoutes } from "../server/partner/public-presence-routes";
import { createRequestLogger } from "../server/lib/request-logger";

describe("public Partner HTTP availability semantics", () => {
  let server: http.Server;
  let base: string;
  let logLines: string[];

  beforeEach(async () => {
    spies.directory.mockReset().mockResolvedValue("ENABLED");
    spies.list.mockReset().mockResolvedValue([]);
    spies.profile.mockReset().mockResolvedValue(null);
    logLines = [];
    const app = express();
    app.use(createRequestLogger((line) => logLines.push(line)));
    app.get("/api/super-admin/grading-partners/test/public-profile", (_req, res) => {
      res.json({ operationalAddress: "PRIVATE-HOME-MARKER", publicEmail: "PRIVATE-DRAFT-MARKER@example.test" });
    });
    app.get("/find-a-partner", (_req, res) => res.status(200).send("directory-html"));
    app.get("/partners/location/storefront-ref-a", (_req, res) => res.status(503).send("profile-html"));
    app.get("/sitemap.xml", (_req, res) => res.status(200).type("application/xml").send("<urlset />"));
    registerPublicPartnerPresenceRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uses 404 for a genuinely disabled directory and a missing/unpublished profile", async () => {
    spies.directory.mockResolvedValue("DISABLED");
    const directory = await fetch(`${base}/api/public/partners`);
    expect(directory.status).toBe(404);
    expect(directory.headers.get("cache-control")).toBe("no-store");

    const profile = await fetch(`${base}/api/public/partners/storefront-ref-a`);
    expect(profile.status).toBe(404);
    expect(profile.headers.get("cache-control")).toBe("no-store");
  });

  it("returns generic 503 plus Retry-After when the DB-backed directory or profile is unavailable", async () => {
    spies.directory.mockRejectedValueOnce(new PublicPartnerPresenceUnavailableError());
    const directory = await fetch(`${base}/api/public/partners`);
    expect(directory.status).toBe(503);
    expect(directory.headers.get("retry-after")).toBe("60");
    expect(await directory.text()).not.toMatch(/postgres|partner_public_profiles|SELECT/i);

    spies.profile.mockRejectedValueOnce(new PublicPartnerPresenceUnavailableError());
    const profile = await fetch(`${base}/api/public/partners/storefront-ref-a`);
    expect(profile.status).toBe(503);
    expect(profile.headers.get("retry-after")).toBe("60");
  });

  it("rejects malformed public refs before any profile query", async () => {
    const response = await fetch(`${base}/api/public/partners/${encodeURIComponent("../admin")}`);
    expect(response.status).toBe(404);
    expect(spies.profile).not.toHaveBeenCalled();
  });

  it("logs private Super Admin profile reads without their response body", async () => {
    const path = "/api/super-admin/grading-partners/test/public-profile";
    expect((await fetch(`${base}${path}`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const line = logLines.find((candidate) => candidate.includes(path));
    expect(line).toContain(`GET ${path} 200`);
    expect(line).not.toContain(" :: ");
    expect(line).not.toContain("PRIVATE-HOME-MARKER");
    expect(line).not.toContain("PRIVATE-DRAFT-MARKER");
  });

  it("emits status and duration telemetry for every non-API rollout path", async () => {
    const expected = [
      ["/find-a-partner", 200],
      ["/partners/location/storefront-ref-a", 503],
      ["/sitemap.xml", 200],
    ] as const;
    for (const [path, status] of expected) {
      expect((await fetch(`${base}${path}`)).status).toBe(status);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [path, status] of expected) {
      expect(logLines.find((line) => line.includes(`GET ${path} ${status} in `))).toBeTruthy();
    }
  });
});
