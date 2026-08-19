import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const app = read("client/src/App.tsx");
const inventory = read("docs/partner/PARTNER_NETWORK_LEGACY_PARITY_INVENTORY.md");
const connectorRoutes = read("server/partner/connector-admin-routes.ts");
const stationRoutes = read("server/partner/station-admin-routes.ts");
const management = read("client/src/pages/admin/partner-management.tsx");
const overview = read("client/src/pages/admin/partner-network-overview.tsx");
const detail = read("client/src/pages/admin/partner-management-detail.tsx");
const dashboard = read("client/src/pages/admin/partner-dashboard.tsx");

describe("Partner Network P10 parity and retirement contract", () => {
  it("preserves legacy redirect state and records application-only telemetry", () => {
    expect(app).toContain("window.location.search");
    expect(app).toContain("window.location.hash");
    expect(app).toContain('console.info("[partner-network] legacy route redirected"');
    expect(app).toContain("following an old bookmark does not mutate");
    expect(app).not.toContain("legacy_route_redirected");
  });

  it("keeps canonical direct destinations intact through the login continuation", () => {
    for (const page of [overview, management, detail, dashboard]) {
      expect(page).toContain("encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)");
    }
  });

  it("does not send a canonical control through a legacy Partner Network URL", () => {
    expect(management).toContain('href="/admin/partners/directory"');
    expect(management).toContain("Open Partner Credits");
    expect(management).not.toContain('href="/admin/partners/dashboard"');
    expect(detail).toContain('navigate("/admin/partners/infrastructure")');
    expect(detail).toContain('isLegacyPath ? "/admin/partner-network/partners" : "/admin/partners/directory"');
  });

  it("records every required legacy surface and its authority outcome", () => {
    for (const surface of [
      "Partner Master Dashboard",
      "Partner Management",
      "Partner detail",
      "Connector Operations",
      "WALLET-BACKFILL1",
      "Google Maps",
      "Fleet station",
    ]) {
      expect(inventory).toContain(surface);
    }
    for (const outcome of ["MIGRATED", "REDIRECTED", "RETAINED"]) expect(inventory).toContain(outcome);
    expect(inventory).toContain("two releases or 90 days");
    expect(inventory).toContain("/admin/partners/directory");
    expect(app).toContain('path="/admin/partners/directory"');
    expect(app).toContain('PartnerNetworkLegacyRoute canonical="/admin/partners/directory"');
  });

  it("keeps the inherited connector and station mutation guards intact", () => {
    expect(connectorRoutes).toContain("r.use(requireAdmin)");
    expect(stationRoutes).toContain("r.use(requireSuperAdmin)");
    expect(stationRoutes).toContain("requireAdminStepUp()");
    expect(management).toContain("const showLegacyFleetControls");
    expect(management).toContain("enabled: authed === true && showLegacyFleetControls");
    expect(management).toContain("const showSettingsControls = showLegacyFleetControls || isCanonicalSettings");
    expect(management).toContain("const showDirectory = showLegacyFleetControls || !isCanonicalSettings");
    expect(management).toMatch(/\{showSettingsControls && \(\s*<Panel title="Partner Pilot Flags"/);
    expect(management).toMatch(/\{showDirectory && \(\s*<Panel/);
  });
});
