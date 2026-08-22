import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_CENTRE_REGISTRY } from "../shared/command-centre";
import {
  isSafeInternalLinkTemplate,
  serialiseCommandCentreRegistryForBrowser,
  validateCommandCentreRegistry,
} from "../server/command-centre/registry";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Command Centre deep-link validation", () => {
  it("accepts every reviewed V1 route and template", () => {
    validateCommandCentreRegistry(COMMAND_CENTRE_REGISTRY);
    for (const descriptor of COMMAND_CENTRE_REGISTRY) {
      for (const link of descriptor.safeInternalLinks) {
        expect(isSafeInternalLinkTemplate(link)).toBe(true);
      }
    }
  });

  it.each([
    "https://mintvault.example/admin",
    "//mintvault.example/admin",
    "/admin/../staff",
    "/admin/%2e%2e/staff",
    "/admin?tab=anything",
    "/admin?tab=scans&tab=certs",
    "/admin?tab=scans&source=raw",
    "/admin/partners/{tenantId}/onboarding",
    "/admin#fragment",
  ])("rejects unsafe link %s", (link) => {
    expect(isSafeInternalLinkTemplate(link)).toBe(false);
  });

  it("maps every reviewed destination to an existing application route shape", () => {
    const app = read("client/src/App.tsx");
    const requiredRouteShapes = [
      'path="/admin/command"',
      'path="/admin"',
      'path="/admin/partners"',
      'path="/admin/partners/stations"',
      'path="/admin/partners/infrastructure"',
      'path="/admin/partners/:partnerId/onboarding"',
      'path="/admin/partners/:partnerId/credits"',
    ];

    for (const route of requiredRouteShapes) {
      expect(app).toContain(route);
    }
    /*
     * Stations left everyday navigation in the four-tab consolidation. Command Centre deep links to
     * /admin/partners/stations must therefore still RESOLVE — they now redirect to the full console
     * under Settings → Advanced rather than to the retired Partner Master Dashboard.
     */
    const stationRoute = app.slice(app.indexOf('path="/admin/partners/stations"'), app.indexOf('path="/admin/partners/infrastructure"'));
    expect(stationRoute).toContain('canonical="/admin/partners/settings/stations"');
  });

  it("does not turn unresolved route templates into browser-visible controls", () => {
    const browserRegistry = serialiseCommandCentreRegistryForBrowser();
    expect(browserRegistry.flatMap((entry) => entry.safeInternalLinks)).not.toContain(
      "/admin/partners/{partnerId}/onboarding",
    );
    expect(browserRegistry.flatMap((entry) => entry.safeInternalLinks)).not.toContain(
      "/admin/partners/{partnerId}/credits",
    );
  });

  it("allows only the fixed Command Centre tab deep-link set to select an admin tab", () => {
    const adminPage = read("client/src/pages/admin.tsx");
    for (const tab of ["submissions", "scans", "certs", "print-queue", "transfers"]) {
      expect(adminPage).toContain('"' + tab + '"');
    }
    expect(adminPage).toContain("ADMIN_DEEP_LINK_TABS.has");
  });
});
