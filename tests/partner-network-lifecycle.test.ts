import { describe, expect, it } from "vitest";
import { partnerLifecycleSummary } from "../client/src/pages/admin/partner-network-lifecycle";
import type { PartnerOperationalReadiness } from "../shared/partner-readiness";

const partnerId = "11111111-1111-4111-8111-111111111111";
const readiness = (
  overrides: Partial<PartnerOperationalReadiness["dimensions"]> = {}
): PartnerOperationalReadiness => ({
  overall: { ready: false, code: "LOCATION_REQUIRED", message: "Location required." },
  dimensions: {
    organisation: { status: "PASS", code: "READY", message: "Organisation ready.", actions: [] },
    owner: { status: "PASS", code: "READY", message: "Owner ready.", actions: [] },
    location: { status: "BLOCKED", code: "LOCATION_REQUIRED", message: "Add a location.", actions: [] },
    station: { status: "PENDING", code: "STATION_SETUP_REQUIRED", message: "Station pending.", actions: [] },
    scanner: { status: "PENDING", code: "STATION_SETUP_REQUIRED", message: "Scanner pending.", actions: [] },
    credits: { status: "PENDING", code: "CREDITS_REQUIRED", message: "Credits pending.", actions: [] },
    ...overrides,
  },
  actions: [],
});

describe("Partner Network operator lifecycle presentation", () => {
  it("uses the first non-pass server dimension for the corrective workspace route", () => {
    const result = partnerLifecycleSummary(partnerId, readiness());
    expect(result).toMatchObject({
      currentStage: "Location setup",
      completed: ["Organisation", "Staff"],
      nextAction: { label: "Open Locations", href: `/admin/partners/${partnerId}/locations` },
    });
  });

  it("never treats unknown readiness as completed", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness({
        organisation: {
          status: "UNKNOWN",
          code: "CONFIGURATION_UNAVAILABLE",
          message: "Settings cannot be read.",
          actions: [],
        },
      })
    );
    expect(result?.currentStage).toBe("Organisation details");
    expect(result?.completed).not.toContain("Organisation");
    expect(result?.nextAction).toEqual({ label: "Review organisation", href: `/admin/partners/${partnerId}` });
  });

  it("sends portal, login, and emergency-stop blockers to programme Settings", () => {
    for (const code of ["PORTAL_DISABLED", "LOGIN_DISABLED", "EMERGENCY_STOP"] as const) {
      const result = partnerLifecycleSummary(
        partnerId,
        readiness({
          organisation: { status: "BLOCKED", code, message: "Programme control blocks this shop.", actions: [] },
        })
      );
      expect(result?.nextAction).toEqual({ label: "Open Settings", href: "/admin/partners/settings" });
    }
  });

  it("keeps an unknown scanner condition in the Partner Stations workspace", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness({
        organisation: { status: "PASS", code: "READY", message: "Organisation ready.", actions: [] },
        owner: { status: "PASS", code: "READY", message: "Owner ready.", actions: [] },
        location: { status: "PASS", code: "READY", message: "Location ready.", actions: [] },
        station: { status: "PASS", code: "READY", message: "Station ready.", actions: [] },
        scanner: {
          status: "UNKNOWN",
          code: "CONFIGURATION_UNAVAILABLE",
          message: "Scanner details cannot be read.",
          actions: [],
        },
      })
    );
    expect(result?.nextAction).toEqual({ label: "Open Stations", href: `/admin/partners/${partnerId}/stations` });
  });

  it("reports a ready shop without inventing a later cards or QA stage", () => {
    const allPass = Object.fromEntries(
      Object.entries(readiness().dimensions).map(([key, value]) => [key, { ...value, status: "PASS", code: "READY" }])
    ) as PartnerOperationalReadiness["dimensions"];
    const result = partnerLifecycleSummary(partnerId, {
      overall: { ready: true, code: "READY", message: "Ready." },
      dimensions: allPass,
      actions: [],
    });
    expect(result).toMatchObject({ currentStage: "Ready to grade", blockers: [], nextAction: null });
  });
});
