import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("first-shop guided onboarding UI contract", () => {
  it("collects the canonical delivery/contact/Owner fields and labels the current scope", () => {
    const page = read("client/src/pages/admin/partner-first-shop-onboarding.tsx");
    for (const required of [
      "Legal / shop name",
      "Address line 1",
      "Town / city",
      "Postcode",
      "Country",
      "Primary operations contact",
      "Operational email",
      "Partner Owner",
      "Current Partner:",
      "Current location:",
      "Station enrolment must come from the real shop Scanner",
      "Open credits / billing readiness",
    ]) expect(page).toContain(required);
    expect(page).toContain("/first-shop/location");
    expect(page).toContain("/first-shop/operations-contact");
    expect(page).toContain("first-shop-create-submit");
    const routes = read("server/partner/partner-management-routes.ts");
    expect(routes).toContain("snapshot.mainLocation.id");
  });

  it("routes both a new shop and an existing Partner to the guided workflow before generic partner matching", () => {
    const app = read("client/src/App.tsx");
    const newGuide = app.indexOf('path="/admin/partners/onboarding"');
    const existingGuide = app.indexOf('path="/admin/partners/:partnerId/onboarding"');
    const genericPartner = app.indexOf('path="/admin/partners/:partnerId"');
    expect(newGuide).toBeGreaterThan(-1);
    expect(existingGuide).toBeGreaterThan(-1);
    expect(genericPartner).toBeGreaterThan(existingGuide);
    expect(app).toContain("AdminPartnerFirstShopOnboardingPage");
  });

  it("replaces the primary generic create control with the guided first-shop entry", () => {
    const directory = read("client/src/pages/admin/partner-management.tsx");
    expect(directory).toContain('href="/admin/partners/onboarding"');
    expect(directory).toContain("Onboard first shop");
  });

  it("gives the authenticated Partner Owner one scoped confirmation page rather than a second authority", () => {
    const ownerPage = read("client/src/pages/partner/onboarding.tsx");
    const app = read("client/src/App.tsx");
    const routes = read("server/partner/routes.ts");
    const dashboard = read("client/src/pages/partner/dashboard.tsx");

    for (const required of [
      "Current Partner:",
      "Current location:",
      "Confirm delivery address",
      "Confirm operations contact",
      "Security &amp; Account",
      "Open Credits &amp; Billing",
      "ReadinessPanel",
    ]) expect(ownerPage).toContain(required);
    expect(app).toContain('path="/partner/onboarding"');
    expect(routes).toContain('r.get("/onboarding"');
    expect(routes).toContain('roles.includes("PARTNER_OWNER")');
    expect(routes).toContain('"/onboarding/main-location"');
    expect(routes).toContain('"/onboarding/operations-contact"');
    expect(routes).toContain("requireNotViewOnly");
    expect(routes).toContain("requireNotSensitiveFrozen");
    expect(dashboard).toContain('href="/partner/onboarding"');
    expect(dashboard).toContain("Complete shop setup");
  });
});

/**
 * The two confirmed Shop #1 blockers, proven at the wizard.
 *
 * Staging 2026-08-21 cost a whole onboarding session to these: a location-scoped operator with no
 * location (the Scanner offered nothing to enrol against) and a station approval that could only be
 * reached by hunting through Station Fleet. Both are now actions inside onboarding.
 */
describe("first-shop onboarding owns staff assignment and station approval", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("has a Staff step that assigns an authorised location to a location-scoped operator", () => {
    const p = page();
    expect(p).toContain("Staff and operator access");
    expect(p).toContain("first-shop-staff-unassigned");
    expect(p).toContain("first-shop-staff-location-select");
    expect(p).toContain("first-shop-assign-location-");
    // Canonical audited authority — never a direct write.
    expect(p).toContain("/users/${userId}/locations");
    expect(p).toContain("locationIds");
    expect(p).toContain("reason:");
  });

  it("only offers assignment for LOCATION-SCOPED operators — org-wide roles keep their semantics", () => {
    const p = page();
    expect(p).toContain("ORG_WIDE_ROLE_CODES");
    expect(p).toContain('"PARTNER_OWNER", "PARTNER_MANAGER", "PARTNER_FINANCE_VIEWER"');
    expect(p).toContain("location_eligible !== true");
  });

  it("blocks assignment when the shop has no ACTIVE location, instead of offering a dead control", () => {
    expect(page()).toContain("first-shop-staff-no-location");
  });

  it("surfaces SCANNER WAITING FOR APPROVAL with an inline Approve Scanner action", () => {
    const p = page();
    expect(p).toContain("SCANNER WAITING FOR APPROVAL");
    expect(p).toContain("Approve Scanner");
    expect(p).toContain("first-shop-approve-station-");
    // The EXISTING canonical station transition, behind the EXISTING admin step-up.
    expect(p).toContain("/api/super-admin/fleet/stations/");
    expect(p).toContain("/active");
    expect(p).toContain("runAdminProtected");
  });

  it("refreshes onboarding state after approval rather than requiring a manual reload", () => {
    const p = page();
    expect(p).toContain("invalidateQueries");
    expect(p).toContain("refetchInterval");
  });

  it("renders calibration and credits state from the server readiness, not a client calculation", () => {
    const p = page();
    expect(p).toContain("dimensions.scanner.message");
    expect(p).toContain("dimensions.credits.message");
    expect(p).toContain("dimensions.staff?.message");
    // Ready remains server-authoritative.
    expect(p).toContain("shop.operational.overall.ready");
  });
});
