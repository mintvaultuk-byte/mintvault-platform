import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
const app = read("client/src/App.tsx");
const workspace = read("client/src/pages/admin/partner-management-detail.tsx");
const stations = read("client/src/pages/admin/partner-network-stations.tsx");

describe("Partner Network P8 workspace contract", () => {
  it("mounts every canonical workspace tab before the generic Partner route", () => {
    const generic = app.indexOf('path="/admin/partners/:partnerId"');
    for (const tab of ["onboarding", "cards", "staff", "locations", "stations", "credits", "activity", "security"]) {
      const route = `path="/admin/partners/:partnerId/${tab}"`;
      expect(app.indexOf(route), route).toBeGreaterThan(-1);
      expect(app.indexOf(route), route).toBeLessThan(generic);
    }
    expect(workspace).toContain('data-testid="pm-workspace-tabs"');
    expect(stations).toContain('data-testid="pn-workspace-tabs"');
    for (const label of ["Overview", "Onboarding", "Cards", "Staff", "Locations", "Stations", "Credits", "Activity", "Security"]) {
      expect(workspace).toContain(`"${label}"`);
    }
  });

  it("fails an invalid Partner UUID safely before any Partner or fleet read", () => {
    expect(workspace).toContain("UUID_RE.test(partnerId)");
    expect(workspace).toContain("const on = authed === true && validPartnerId");
    expect(stations).toContain("const validPartnerId = !partnerId || UUID_RE.test(partnerId)");
    expect(stations).toContain("enabled: authed === true && validPartnerId");
    expect(stations).toContain("Partner not found.");
  });

  it("keeps fleet-wide Stations read-only and sends lifecycle mutations only from a Partner context through canonical step-up", () => {
    expect(stations).toContain("Read-only fleet view");
    expect(stations).toContain("{partnerId && <th>Actions</th>}");
    expect(stations).toContain("{partnerId && <td>");
    expect(stations).toContain("runAdminProtected");
    expect(stations).toContain('apiRequest("POST", `${BASE}/${encodeURIComponent(action.stationCode)}/${action.route}`');
    expect(stations).not.toContain("/api/partner/");
  });

  it("uses existing dashboard sections for cards and credits rather than a fourth read", () => {
    expect(workspace).toContain('<PartnerDrilldown partnerId={partnerId} tab="submissions" />');
    expect(workspace).toContain('<PartnerDrilldown partnerId={partnerId} tab="wallet" />');
  });
});
