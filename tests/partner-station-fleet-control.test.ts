/**
 * Fleet control drift guard. The database service carries the actual row lock
 * and audit insert; these assertions keep the internal Super Admin surface
 * from silently regressing to a generic unaudited status toggle.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const service = read("server/partner/station-service.ts");
const routes = read("server/partner/station-admin-routes.ts");
const fleetUi = read("client/src/pages/admin/partner-management.tsx");

describe("Super Admin Partner station fleet controls", () => {
  it("makes rejection a pending-only, reasoned, credential-rotating action", () => {
    expect(service).toContain("export async function rejectPendingStation");
    expect(service).toContain("Only a pending station can be rejected");
    expect(service).toContain("'station_rejected'");
    expect(service).toContain("SET status='REJECTED', credential_epoch=credential_epoch+1");
    expect(service).toContain("JSON.stringify({ reason: cleanReason, previousStatus: row.status, credentialEpochRotated: true })");
  });

  it("keeps pending cancellation, replacement and same-tenant location transfer explicit and audited", () => {
    expect(service).toContain("export async function cancelPendingStation");
    expect(service).toContain("export async function activateReplacementStation");
    expect(service).toContain("export async function transferStationLocation");
    expect(service).toContain("Replacement stations must be in the same tenant and location");
    expect(service).toContain("Station has unresolved capture or evidence state");
    expect(service).toContain("station_location_transferred_from");
    expect(service).toContain("station_replacement_activated");
    for (const path of [
      '"/stations/:stationCode/cancel"',
      '"/stations/:stationCode/replace"',
      '"/stations/:stationCode/transfer-location"',
    ]) {
      expect(routes).toContain(path);
    }
  });

  it("exposes the distinct reject route behind the existing Super Admin router", () => {
    expect(routes).toContain("r.use(requireSuperAdmin)");
    expect(routes).toContain('r.post("/stations/:stationCode/reject"');
    expect(routes).toContain("rejectPendingStation(String(req.params.stationCode), actorId(req), reason)");
    expect(routes).toContain('app.use("/api/super-admin/fleet", partnerStationAdminRouter())');
  });

  it("offers only reason-confirmed pending/active station operations to the canonical admin UI", () => {
    expect(fleetUi).toContain('const FLEET_BASE = "/api/super-admin/fleet"');
    expect(fleetUi).toContain('data-testid="pm-station-fleet"');
    expect(fleetUi).toContain('station.status === "PENDING"');
    expect(fleetUi).toContain('action: "reject"');
    expect(fleetUi).toContain('action: "replace"');
    expect(fleetUi).toContain('action: "transfer-location"');
    expect(fleetUi).toContain("fleetReason.trim().length < 3");
    expect(fleetUi).toContain("credential epoch");
    expect(fleetUi).not.toContain("MINTVAULT_STATION_SECRET");
  });
});
