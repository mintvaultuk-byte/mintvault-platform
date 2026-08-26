/**
 * Drift guards for the distributed-station capture boundary. These assertions
 * deliberately cover the route/service seams where a browser must stop and a
 * signed Mac identity becomes mandatory; scanner state-machine tests cover the
 * subsequent candidate/side lifecycle.
 */
import { describe, expect, it, vi } from "vitest";
import { stationPathAllowed } from "../server/lib/station-request-scope";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const routes = read("server/routes.ts");
const staffRoutes = read("server/routes/staff.ts");
const sessions = read("server/scanner-capture-service.ts");
const stations = read("server/partner/station-service.ts");
const partnerStationRoutes = read("server/partner/station-routes.ts");
const partnerGrading = read("client/src/pages/partner/grading.tsx");
const stationMigration = read("migrations/0075_partner_station_single_active_capture.sql");
const physicalReleaseMigration = read("migrations/0094_scanner_capture_physical_release.sql");
const escapedRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
      "/api/admin/scanner/capture-sessions/next",
      "/api/admin/scanner/capture-sessions/:sessionId",
      "/api/admin/scanner/capture-sessions/:sessionId/keepalive",
      "/api/admin/scanner/capture-sessions/:sessionId/failed",
      "/api/admin/scanner/capture-sessions/:sessionId/staged-upload",
    ]) {
      expect(routes).toMatch(
        new RegExp(
          `app\\.(?:get|post)\\(\\s*"${escapedRegex(path)}",\\s*requireScannerOrAdmin,\\s*requireStationCaptureAgent`
        )
      );
    }
    expect(routes).toMatch(
      /staged-upload\/:stagingId\/finalise",\s*requireScannerOrAdmin,\s*requireStationCaptureAgent/
    );
    expect(routes).toMatch(
      /capture-sessions\/:sessionId\/evidence",\s*requireScannerOrAdmin,\s*requireStationCaptureAgent/
    );
  });

  it("invalidates calibration when the locked scanner profile changes", () => {
    expect(stations).toMatch(
      /const profileChanged\s*=\s*input\.scannerConnected === true &&\s*previous\.scanner_profile_version != null &&\s*previous\.scanner_profile_version !== reportedScannerProfileVersion/
    );
    expect(stations).toContain("const calibrationInvalidated = hardwareChanged || profileChanged");
    expect(stations).toContain("current_calibration_id=CASE");
    expect(stations).toContain("WHEN $11 THEN NULL");
    expect(stations).toContain('"scanner_profile_changed"');
  });

  it("lets a Partner browser arm only a server-listed station target", () => {
    expect(partnerStationRoutes).toContain('"/stations/capture-ready"');
    expect(partnerStationRoutes).toContain("listPartnerCaptureStations(req.partner!)");
    expect(partnerStationRoutes).toContain('"/stations/:stationCode/capture-sessions"');
    expect(partnerStationRoutes).toContain("authorizePartnerScannerCertificate(req.partner!, certificateId)");
    expect(partnerGrading).toContain('fetch("/api/partner/stations/capture-ready"');
    expect(partnerGrading).toContain("/api/partner/stations/${encodeURIComponent(stationCode)}/capture-sessions");
    expect(partnerGrading).not.toContain("mintvault-scanner-workstation-id");
  });

  it("enforces exactly one physical target per signed Partner station", () => {
    expect(sessions).toContain("SET state='expired'");
    expect(sessions).toContain("uq_scanner_capture_one_active_station");
    expect(sessions).toContain("This station already has an active capture target");
    expect(stationMigration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_one_active_station");
    expect(stationMigration).toContain("ON scanner_capture_sessions (station_id)");
    expect(stationMigration).toContain("state IN ('armed', 'claimed', 'capturing')");
    expect(physicalReleaseMigration).toContain("physical_released = false");
    expect(physicalReleaseMigration).toContain("DROP INDEX IF EXISTS uq_scanner_capture_one_active_station");
    expect(sessions).toContain("s.physical_released = true AND s.certificate_id <> $2");
    expect(sessions).toContain("already being finished on another approved station");
    expect(sessions).toContain("FOR UPDATE");
    expect(read("server/partner/capture-authority.ts")).toContain("CAPTURE_HELD_BY_OTHER_STATION");
    expect(read("scripts/scanner-app/lib/watcher.js")).toContain("Accepted local TIFF is missing");
    expect(sessions).toContain("NOT EXISTS (");
    expect(sessions).toContain("capture_metadata ->> 'captureSessionId' = scanner_capture_sessions.id");
    expect(sessions).toContain("pg_advisory_xact_lock");
    expect(read("server/partner/card-job-cancellation.ts")).toContain("pg_advisory_xact_lock");
    expect(routes).toContain("return res.status(409).json({ ok: false, ...result })");
    expect(partnerStationRoutes).toContain("recapture: false");
  });

  it("shows Next Card only from the server-persisted paired capture result", () => {
    const scannerRoutes = routes;
    const watcher = read("scripts/scanner-app/lib/watcher.js");
    const renderer = read("scripts/scanner-app/renderer/app.js");
    const scannerMain = read("scripts/scanner-app/main.js");
    expect(sessions).toContain("isScannerCaptureCardRegistered");
    expect(scannerRoutes).toContain("card_registered: cardRegistered");
    expect(watcher).toContain("cardRegistered: uploaded.body?.card_registered === true");
    expect(renderer).toContain("state.lastAcceptedCapture?.cardRegistered === true && !active");
    expect(renderer).toContain("window.scanner.acknowledgeCardRegistered()");
    expect(scannerMain).toContain('"acknowledge-card-registered"');
  });
});

/**
 * A signed station principal is NOT an admin credential.
 *
 * requireScannerOrAdmin is shared with six pre-existing GLOBAL admin certificate routes that
 * address `certificates` by certificate_number with no tenant predicate — they were written when
 * the only principals were an admin cookie or the HQ scanner token. Admitting a partner station to
 * that shared middleware handed every approved partner cross-tenant read, evidence overwrite,
 * presigned-URL disclosure and soft-delete over the entire certificate estate.
 */
describe("signed-station principal is confined to capture work", () => {
  it("admits the station's own capture routes", () => {
    for (const p of [
      "/api/admin/scanner/capture-sessions/next?workstation_id=W1&device_id=D1",
      "/api/admin/scanner/capture-sessions/abc",
      "/api/admin/scanner/capture-sessions/abc/keepalive",
      "/api/admin/scanner/capture-sessions/abc/staged-upload",
      "/api/admin/scanner/capture-sessions/abc/staged-upload/s1/finalise",
      "/api/admin/scanner/capture-sessions/abc/evidence",
      "/api/admin/scanner/capture-sessions/abc/failed",
    ]) {
      expect(stationPathAllowed(p), `${p} must remain reachable by a signed station`).toBe(true);
    }
  });

  it("REFUSES every global certificate route that carries no tenant predicate", () => {
    for (const p of [
      "/api/admin/orphan-certs",
      "/api/admin/certs/MV837/preview",
      "/api/admin/certs/MV837/image",
      "/api/admin/certs/MV837",
      "/api/admin/scan-status/MV837",
      "/api/admin/certificates/new",
      "/api/admin/certificates",
    ]) {
      expect(stationPathAllowed(p), `${p} must NOT be reachable by a signed station`).toBe(false);
    }
  });

  it("allows only the advisory number hint, which exposes no certificate data", () => {
    expect(stationPathAllowed("/api/admin/next-cert-id")).toBe(true);
    // …and the allowlist is prefix-anchored, so a lookalike path cannot ride in on it.
    expect(stationPathAllowed("/api/admin/next-cert-id-evil")).toBe(false);
    expect(stationPathAllowed("/evil/api/admin/scanner/capture-sessions/next")).toBe(false);
  });

  it("the middleware refuses rather than falling through to the admin cookie check", () => {
    const src = read("server/lib/scanner-auth.ts");
    const branch = src.slice(src.indexOf('if (req.header("x-mintvault-station-id"))'));
    const guard = branch.slice(0, branch.indexOf("try {"));
    expect(guard).toMatch(/if \(!stationPathAllowed\(/);
    expect(guard).toMatch(/return res\.status\(403\)/);
  });
});
