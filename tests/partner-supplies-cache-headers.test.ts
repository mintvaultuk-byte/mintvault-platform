/**
 * Supplies routers are mounted beside partnerApiRouter(), not beneath it. Exercise their first
 * middleware on real HTTP requests so delivery/order PII cannot become cacheable if mounting or
 * refactoring changes again. Authentication denial is sufficient: the cache boundary must precede
 * every authentication, capability, and error response.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

describe("Partner supplies PII cache boundary", () => {
  let server: http.Server;
  let baseUrl = "";

  beforeAll(async () => {
    // The unauthenticated assertions below never contact storage, but the Super Admin middleware
    // imports the normal server module graph. Supply a parseable inert URL before that import so
    // this hermetic HTTP contract does not inherit a developer's local database configuration.
    process.env.MINTVAULT_DATABASE_URL ??= "postgresql://partner_cache_test:unused@127.0.0.1:1/unused";
    const [{ partnerSuppliesRouter }, { partnerSuppliesAdminRouter }] = await Promise.all([
      import("../server/partner/supplies-routes"),
      import("../server/partner/supplies-admin-routes"),
    ]);
    const app = express();
    app.use("/api/partner", partnerSuppliesRouter());
    app.use("/api/super-admin/partner-supplies", partnerSuppliesAdminRouter());
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const path of ["/api/partner/supplies/orders", "/api/super-admin/partner-supplies/orders"]) {
    it(`marks ${path} non-cacheable before its authentication response`, async () => {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
    });
  }
});
