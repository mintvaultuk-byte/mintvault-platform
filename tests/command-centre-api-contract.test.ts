import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Command Centre GET-only API contract", () => {
  it("registers exactly one guarded Command Centre read route in the required order", () => {
    const source = read("server/command-centre/routes.ts");
    const route = source.slice(source.indexOf("app.get("));
    const enabledAt = route.indexOf("requireCommandCentreEnabled");
    const superAdminAt = route.indexOf("requireSuperAdmin");
    const limiterAt = route.indexOf("commandCentreReadRateLimit");

    expect(source).toContain('"/api/admin/command/dashboard"');
    expect(enabledAt).toBeGreaterThan(-1);
    expect(superAdminAt).toBeGreaterThan(enabledAt);
    expect(limiterAt).toBeGreaterThan(superAdminAt);
    expect(source).toContain("max: 30");
    expect(source).toContain("dashboardQuerySchema.safeParse(request.query)");
  });

  it("has no Command Centre mutation route or forwarded station-list payload", () => {
    const routeSource = read("server/command-centre/routes.ts");
    const commandSource =
      read("server/command-centre/dashboard-service.ts") +
      read("server/command-centre/partner-read-adapter.ts");
    const stationSource = read("server/partner/station-service.ts");

    expect(routeSource).not.toMatch(/app\.(post|put|patch|delete)\(/i);
    expect(commandSource).not.toContain("listFleetStations");
    expect(stationSource).toContain("getFleetStationLifecycleSummary");
  });
});
