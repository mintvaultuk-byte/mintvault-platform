/**
 * Drift guards for the distributed-station capture boundary. These assertions
 * deliberately cover the route/service seams where a browser must stop and a
 * signed Mac identity becomes mandatory; scanner state-machine tests cover the
 * subsequent candidate/side lifecycle.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const routes = read("server/routes.ts");
const staffRoutes = read("server/routes/staff.ts");
const sessions = read("server/scanner-capture-service.ts");
const stations = read("server/partner/station-service.ts");

describe("signed-station capture boundary", () => {
  it("requires a resolved, calibrated canonical station before admin or staff can arm", () => {
    expect(routes).toContain("if (!requestedStation)");
    expect(routes).toContain("assertStationCaptureReady(requestedStation, CANON_LIDE_400_PROFILE.version)");
    expect(routes).toContain("workstationId: requestedStation.code");
    expect(routes).toContain("stationId: requestedStation.id");
    expect(routes).not.toContain("workstationId: requestedStation?.code ?? req.body?.workstation_id");
    expect(staffRoutes).toContain("const station = await resolveActiveStationByCode(req.body?.workstation_id)");
    expect(staffRoutes).toContain("assertStationCaptureReady(station, CANON_LIDE_400_PROFILE.version)");
    expect(staffRoutes).toContain("workstationId: station.code");
    expect(staffRoutes).toContain("stationId: station.id");
  });

  it("binds station-owned sessions through the actual connector tenant/location bridge", () => {
    expect(sessions).toContain("FROM partner_stations station");
    expect(sessions).toContain("imported.partner_organisation_id=station.tenant_id");
    expect(sessions).toContain("imported.partner_location_id=station.location_id");
    expect(sessions).toContain("Certificate is not bound to this station's tenant and location");
  });

  it("denies production capture operations without the signed Mac principal", async () => {
    process.env.MINTVAULT_DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/unused";
    const { requireStationCaptureAgent } = await import("../server/lib/scanner-auth");
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    try {
      const noStationRequest = { scannerStation: undefined } as unknown as Parameters<
        typeof requireStationCaptureAgent
      >[0];
      const response = { status, json } as unknown as Parameters<typeof requireStationCaptureAgent>[1];
      const signedStationRequest = { scannerStation: { id: "station" } } as unknown as Parameters<
        typeof requireStationCaptureAgent
      >[0];
      requireStationCaptureAgent(noStationRequest, response, next);
      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: "A signed station identity is required for scanner capture" });
      expect(next).not.toHaveBeenCalled();

      requireStationCaptureAgent(signedStationRequest, response, next);
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("puts the production signed-station gate ahead of every target mutation", () => {
    for (const path of [
      '"/api/admin/scanner/capture-sessions/next", requireScannerOrAdmin, requireStationCaptureAgent',
      '"/api/admin/scanner/capture-sessions/:sessionId", requireScannerOrAdmin, requireStationCaptureAgent',
      '"/api/admin/scanner/capture-sessions/:sessionId/keepalive", requireScannerOrAdmin, requireStationCaptureAgent',
      '"/api/admin/scanner/capture-sessions/:sessionId/failed", requireScannerOrAdmin, requireStationCaptureAgent',
      '"/api/admin/scanner/capture-sessions/:sessionId/staged-upload", requireScannerOrAdmin, requireStationCaptureAgent',
    ]) {
      expect(routes).toContain(path);
    }
    expect(routes).toMatch(
      /staged-upload\/:stagingId\/finalise",\s*requireScannerOrAdmin,\s*requireStationCaptureAgent/
    );
    expect(routes).toMatch(
      /capture-sessions\/:sessionId\/evidence",\s*requireScannerOrAdmin,\s*requireStationCaptureAgent/
    );
  });

  it("invalidates calibration when the locked scanner profile changes", () => {
    expect(stations).toContain(
      "const profileChanged = previous.scanner_profile_version != null && previous.scanner_profile_version !== scannerProfileVersion"
    );
    expect(stations).toContain("const calibrationInvalidated = hardwareChanged || profileChanged");
    expect(stations).toContain("current_calibration_id=CASE WHEN $11 THEN NULL ELSE current_calibration_id END");
    expect(stations).toContain('"scanner_profile_changed"');
  });
});
