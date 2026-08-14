/**
 * AT-23 mount-order regression (2026-08-14).
 *
 * partnerPortalRouter() mounts the catalogue router BEFORE the grading and station routers. The
 * catalogue router used a PATHLESS `r.use(requirePartnerAuth)`, which runs for every request that
 * falls through the API router — so a signed-station request (Ed25519 headers, no session cookie)
 * was 401-rejected here and could never reach the station router: the whole scanner-station
 * surface was dead in the composed app while every per-router suite stayed green.
 *
 * This pins the exact mechanism: the catalogue router must let non-catalogue paths FALL THROUGH
 * to later routers, while /catalogue itself stays session-guarded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

let server: ReturnType<express.Express["listen"]>;
let base = "";

beforeAll(async () => {
  // The import chain reaches server/db.ts, whose config asserts at load time. No query ever runs
  // in this suite — requirePartnerAuth rejects before any DB access.
  process.env.MINTVAULT_DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";
  const { partnerCatalogueRouter } = await import("../server/partner/catalogue-routes");
  const app = express();
  app.use(partnerCatalogueRouter());
  // Stands in for the station router mounted AFTER the catalogue router in mount.ts.
  app.post("/stations/heartbeat", (_req, res) => res.status(418).json({ reached: "station-router" }));
  app.post("/card-jobs", (_req, res) => res.status(418).json({ reached: "station-router" }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("partner catalogue router auth scope", () => {
  it("lets a cookie-less non-catalogue request FALL THROUGH to later routers", async () => {
    for (const path of ["/stations/heartbeat", "/card-jobs"]) {
      const r = await fetch(base + path, { method: "POST" });
      expect(r.status, `${path} must reach the next router, not die at catalogue auth`).toBe(418);
      expect(((await r.json()) as { reached: string }).reached).toBe("station-router");
    }
  });

  it("still refuses an unauthenticated /catalogue request", async () => {
    const r = await fetch(base + "/catalogue/snapshot");
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe("authentication required");
  });
});
