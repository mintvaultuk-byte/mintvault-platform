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
