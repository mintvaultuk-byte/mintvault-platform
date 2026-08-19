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
  const actual = await importOriginal<typeof import("../server/partner/public-presence-service")>();
  return {
    ...actual,
    getPublicPartnerDirectoryState: spies.directory,
    listPublicPartnerLocations: spies.list,
    getPublicPartnerLocation: spies.profile,
  };
});

import { PublicPartnerPresenceUnavailableError } from "../server/partner/public-presence-service";
import { registerPublicPartnerPresenceRoutes } from "../server/partner/public-presence-routes";

describe("public Partner HTTP availability semantics", () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    spies.directory.mockReset().mockResolvedValue("ENABLED");
    spies.list.mockReset().mockResolvedValue([]);
    spies.profile.mockReset().mockResolvedValue(null);
    const app = express();
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
});
