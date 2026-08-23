/**
 * The Super Admin lifecycle strip is PRESENTATION over the server's verdict.
 *
 * It used to rank blockers itself, by walking `Object.keys(readiness.dimensions)` — JavaScript
 * insertion order, which matched the authority's fix-first order only by coincidence. It now reads
 * `readiness.nextAction` and decides one thing only: where that answer's link points inside the
 * Super Admin product (the server's own hrefs are written for the Partner Portal). These tests pin
 * that split — the server chooses WHAT, this file chooses WHERE.
 */
import { describe, expect, it } from "vitest";
import { partnerLifecycleSummary } from "../client/src/pages/admin/partner-network-lifecycle";
import type {
  PartnerNextAction,
  PartnerOperationalReadiness,
  ReadinessDimension,
} from "../shared/partner-readiness";

const partnerId = "11111111-1111-4111-8111-111111111111";
const pass = (message: string): ReadinessDimension => ({ status: "PASS", code: "READY", message, actions: [] });

const readiness = (
  nextAction: PartnerNextAction,
  overrides: Partial<PartnerOperationalReadiness["dimensions"]> = {}
): PartnerOperationalReadiness =>
  ({
    overall:
      nextAction.state === "READY"
        ? { ready: true, code: "READY", message: "Ready." }
        : { ready: false, code: nextAction.code, message: nextAction.message },
    dimensions: {
      organisation: pass("Organisation ready."),
      location: pass("Location ready."),
      delivery: pass("Address ready."),
      operationsContact: pass("Contact ready."),
      owner: pass("Owner ready."),
      staff: pass("Staff ready."),
      station: pass("Station ready."),
      scanner: pass("Scanner ready."),
      credits: pass("Credits ready."),
      ...overrides,
    },
    actions: [],
    nextAction,
  }) as PartnerOperationalReadiness;

const blocked = (
  source: PartnerNextAction["source"],
  code: PartnerNextAction["code"],
  label: string | null
): PartnerNextAction => ({
  state: "BLOCKED",
  code,
  title: "Something to do",
  message: "Something to do.",
  source,
  action: label ? { audience: "SUPER_ADMIN", label } : null,
});

describe("Partner Network operator lifecycle presentation", () => {
  it("routes to the workspace that owns the server's chosen blocker", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness(blocked("location", "LOCATION_REQUIRED", "Add a location"), {
        location: { status: "BLOCKED", code: "LOCATION_REQUIRED", message: "Add a location.", actions: [] },
      })
    );
    expect(result?.nextAction).toEqual({
      label: "Add a location",
      href: `/admin/partners/${partnerId}/locations`,
    });
  });

  it("renders the SERVER's action wording, not a generic workspace name", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness(blocked("station", "STATION_APPROVAL_PENDING", "Approve Scanner"), {
        station: { status: "PENDING", code: "STATION_APPROVAL_PENDING", message: "Waiting.", actions: [] },
      })
    );
    expect(result?.nextAction?.label).toBe("Approve Scanner");
  });

  it("does NOT rank blockers itself — it follows nextAction even against object key order", () => {
    /*
     * `credits` is LAST in the canonical order and appears last in the dimensions literal, while
     * `organisation` is first and is also blocked. The server nominated credits, so credits is what
     * gets rendered. The old implementation would have returned organisation, because it re-derived
     * the choice from key order instead of reading the verdict.
     */
    const result = partnerLifecycleSummary(
      partnerId,
      readiness(blocked("credits", "CREDITS_REQUIRED", "Add credits"), {
        organisation: { status: "BLOCKED", code: "PARTNER_SUSPENDED", message: "Suspended.", actions: [] },
        credits: { status: "BLOCKED", code: "CREDITS_REQUIRED", message: "No credits.", actions: [] },
      })
    );
    expect(result?.nextAction?.href).toBe(`/admin/partners/${partnerId}/credits`);
  });

  it("sends portal, login, and emergency-stop blockers to programme Settings", () => {
    for (const code of ["PORTAL_DISABLED", "LOGIN_DISABLED", "EMERGENCY_STOP"] as const) {
      const result = partnerLifecycleSummary(
        partnerId,
        readiness(blocked("organisation", code, "Open Settings"), {
          organisation: { status: "BLOCKED", code, message: "Programme control blocks this shop.", actions: [] },
        })
      );
      expect(result?.nextAction?.href).toBe("/admin/partners/settings");
    }
  });

  it("sends the onboarding test card to the onboarding wizard that owns it", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness({
        state: "BLOCKED",
        code: "TEST_CARD_REQUIRED",
        title: "Test card required",
        message: "Scan one test card in MintVault Scanner.",
        source: "testCard",
        action: { audience: "SUPER_ADMIN", label: "Scan test card" },
      })
    );
    expect(result?.currentStage).toBe("Onboarding test card");
    expect(result?.nextAction).toEqual({
      label: "Scan test card",
      href: `/admin/partners/${partnerId}/onboarding`,
    });
  });

  it("falls back to the headline when a blocker has no clickable action", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness(
        { ...blocked("owner", "AWAITING_PASSWORD_SETUP", null), title: "Waiting for owner", state: "PENDING" },
        { owner: { status: "PENDING", code: "AWAITING_PASSWORD_SETUP", message: "Waiting.", actions: [] } }
      )
    );
    expect(result?.nextAction?.label).toBe("Waiting for owner");
  });

  it("never treats unknown readiness as completed", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness(blocked("organisation", "CONFIGURATION_UNAVAILABLE", "Review organisation"), {
        organisation: {
          status: "UNKNOWN",
          code: "CONFIGURATION_UNAVAILABLE",
          message: "Settings cannot be read.",
          actions: [],
        },
      })
    );
    expect(result?.completed).not.toContain("Organisation");
  });

  it("reports a ready shop without inventing a later cards or QA stage", () => {
    const result = partnerLifecycleSummary(
      partnerId,
      readiness({
        state: "READY",
        code: "READY",
        title: "Shop ready to grade",
        message: "This shop can grade a card now and its test card is complete.",
        source: null,
        action: null,
      })
    );
    expect(result).toMatchObject({ currentStage: "Ready to grade", blockers: [], nextAction: null });
  });
});
