// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReadinessPanel } from "../client/src/components/partner/readiness-panel";
import { derivePartnerOperationalReadiness, type PartnerReadinessFacts } from "../server/partner/operational-readiness";

const facts: PartnerReadinessFacts = {
  orgStatus: "ACTIVE", portalEnabled: true, loginFlagEnabled: true, emergencyStop: false,
  owner: { userStatus: "ACTIVE", passwordConfigured: true, invitationValid: false, mfaRequired: false, mfaConfigured: false },
  locationEligible: true,
  staff: { scanCapableCount: 1, locationScopedWithoutLocation: 0 },
  deliveryAddressReady: true,
  operationsContactReady: true,
  station: { enrolledCount: 1, approvedActiveCount: 1, pendingApprovalCount: 0, active: { scannerConnected: true, lastSeenAt: new Date().toISOString(), calibrationStatus: "VALID", currentCalibrationId: "calibration", currentProfileRevisionId: "revision", appVersion: "1.4.0", minimumSupportedVersion: null } },
  credits: 0, nowMs: Date.now(),
};

describe("P5 readiness renderer", () => {
  it("renders the same verdict for Partner and Super Admin, with audience-filtered actions", () => {
    const readiness = derivePartnerOperationalReadiness(facts);
    const partner = renderToStaticMarkup(createElement(ReadinessPanel, { readiness, audience: "PARTNER" }));
    const admin = renderToStaticMarkup(createElement(ReadinessPanel, { readiness, audience: "SUPER_ADMIN" }));
    expect(partner).toContain('data-code="CREDITS_REQUIRED"');
    expect(admin).toContain('data-code="CREDITS_REQUIRED"');
    expect(partner).toContain('href="/partner/billing"');
    expect(admin).not.toContain('href="/partner/billing"');
  });

  it("does not show a Partner a Super Admin-only station approval action", () => {
    const readiness = derivePartnerOperationalReadiness({ ...facts, station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 1, active: null } });
    const partner = renderToStaticMarkup(createElement(ReadinessPanel, { readiness, audience: "PARTNER" }));
    const admin = renderToStaticMarkup(createElement(ReadinessPanel, { readiness, audience: "SUPER_ADMIN" }));
    expect(partner).toContain("Waiting for MintVault approval");
    expect(partner).not.toContain("Approve the registered station");
    expect(admin).toContain("Approve the registered station");
  });

  it("renders missing and unknown readiness explicitly", () => {
    expect(renderToStaticMarkup(createElement(ReadinessPanel, { readiness: undefined, audience: "PARTNER" }))).toContain('data-ready="unknown"');
    const unknown = derivePartnerOperationalReadiness({ ...facts, station: null, credits: null });
    expect(renderToStaticMarkup(createElement(ReadinessPanel, { readiness: unknown, audience: "SUPER_ADMIN" }))).toContain('data-status="UNKNOWN"');
  });

  it("renders every dimension and an identical verdict for both audiences", () => {
    const ready = derivePartnerOperationalReadiness({ ...facts, credits: 5 });
    const partner = renderToStaticMarkup(createElement(ReadinessPanel, { readiness: ready, audience: "PARTNER" }));
    const admin = renderToStaticMarkup(createElement(ReadinessPanel, { readiness: ready, audience: "SUPER_ADMIN" }));
    for (const dimension of ["organisation", "owner", "location", "delivery", "operationsContact", "station", "scanner", "credits"]) {
      expect(partner).toContain(`readiness-dimension-${dimension}`);
      expect(admin).toContain(`readiness-dimension-${dimension}`);
    }
    expect(partner).toContain('data-code="READY"');
    expect(admin).toContain('data-code="READY"');
  });
});
