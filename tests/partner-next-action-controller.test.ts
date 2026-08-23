/**
 * THE ONE NEXT ACTION — proving the onboarding controller picks exactly one thing, in the
 * authority's own order, and never invents a step.
 *
 * WHY THIS SUITE EXISTS. The 10-step readiness model was already correct, but every surface that
 * asked "so what do I do first?" answered it independently: the Super Admin lifecycle helper ranked
 * blockers by `Object.keys(dimensions)` (JavaScript insertion order, not the authority's fix-first
 * order) and Needs Attention re-derived blockers from the DASHBOARD projection instead of from
 * readiness at all. Two calculations over one question is how they drift. These tests pin the
 * single answer, so a future surface has nothing left to guess.
 */
import { describe, expect, it } from "vitest";
import { PARTNER_READINESS_DIMENSION_ORDER, PARTNER_SETUP_STAGE_BY_DIMENSION } from "@shared/partner-readiness";
import {
  derivePartnerOperationalReadiness,
  type PartnerReadinessFacts,
} from "../server/partner/operational-readiness";

const now = Date.UTC(2026, 7, 23, 12, 0, 0);

/** A shop with nothing wrong and a finished test card. Every case below spoils exactly one thing. */
const healthy = (over: Partial<PartnerReadinessFacts> = {}): PartnerReadinessFacts => ({
  orgStatus: "ACTIVE",
  portalEnabled: true,
  loginFlagEnabled: true,
  emergencyStop: false,
  owner: {
    userStatus: "ACTIVE",
    passwordConfigured: true,
    invitationValid: false,
    mfaRequired: true,
    mfaConfigured: true,
  },
  locationEligible: true,
  staff: { scanCapableCount: 1, locationScopedWithoutLocation: 0 },
  deliveryAddressReady: true,
  operationsContactReady: true,
  station: {
    enrolledCount: 1,
    approvedActiveCount: 1,
    pendingApprovalCount: 0,
    active: {
      scannerConnected: true,
      lastSeenAt: new Date(now - 60_000).toISOString(),
      calibrationStatus: "VALID",
      currentCalibrationId: "calibration",
      currentProfileRevisionId: "revision",
      appVersion: "1.4.0",
      minimumSupportedVersion: "1.2.0",
    },
  },
  credits: 5,
  testCard: { completedCount: 1, latest: null },
  nowMs: now,
  ...over,
});

const next = (over: Partial<PartnerReadinessFacts> = {}) => derivePartnerOperationalReadiness(healthy(over)).nextAction;

describe("next action — exactly one, from server authority", () => {
  it("always returns exactly one next action, never a list", () => {
    const action = next({ credits: 0 });
    expect(Array.isArray(action)).toBe(false);
    expect(typeof action.code).toBe("string");
    expect(typeof action.title).toBe("string");
    // One control at most. The UI renders a single dominant button; it cannot render 'some'.
    expect(action.action === null || typeof action.action.label === "string").toBe(true);
  });

  it("is DERIVED from readiness — its code and message are the dimension's own, never re-worded", () => {
    const readiness = derivePartnerOperationalReadiness(healthy({ credits: 0 }));
    expect(readiness.nextAction.source).toBe("credits");
    expect(readiness.nextAction.code).toBe(readiness.dimensions.credits.code);
    expect(readiness.nextAction.message).toBe(readiness.dimensions.credits.message);
  });

  it("agrees with overall.code while any operational dimension is unresolved", () => {
    const readiness = derivePartnerOperationalReadiness(healthy({ credits: 0 }));
    expect(readiness.overall.ready).toBe(false);
    expect(readiness.nextAction.code).toBe(readiness.overall.code);
  });
});

describe("priority order is the canonical one, not the client's guess", () => {
  it("exports one order and follows it", () => {
    expect([...PARTNER_READINESS_DIMENSION_ORDER]).toEqual([
      "organisation",
      "location",
      "delivery",
      "operationsContact",
      "owner",
      "staff",
      "station",
      "scanner",
      "credits",
    ]);
  });

  it("picks the EARLIEST blocker when several are unresolved at once", () => {
    // Address, owner, scanner approval and credits are all wrong. Address wins: it is earliest.
    const action = next({
      deliveryAddressReady: false,
      owner: null,
      station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 1, active: null },
      credits: 0,
    });
    expect(action.source).toBe("delivery");
    expect(action.code).toBe("DELIVERY_ADDRESS_REQUIRED");
  });

  it("advances to the NEXT blocker once the earlier one is resolved", () => {
    const broken = { owner: null, credits: 0 } as Partial<PartnerReadinessFacts>;
    expect(next(broken).source).toBe("owner");
    // Fix only the owner; the controller moves on by itself, with no client sequencing.
    expect(next({ ...broken, owner: healthy().owner }).source).toBe("credits");
  });

  it("lets a security/authority blocker override the normal sequence", () => {
    // Emergency stop with a broken address further down: organisation is first, so it wins.
    const action = next({ emergencyStop: true, deliveryAddressReady: false });
    expect(action.source).toBe("organisation");
    expect(action.code).toBe("EMERGENCY_STOP");
  });
});

describe("each blocker is chosen correctly", () => {
  it("address", () => expect(next({ deliveryAddressReady: false }).code).toBe("DELIVERY_ADDRESS_REQUIRED"));
  it("operations contact", () =>
    expect(next({ operationsContactReady: false }).code).toBe("OPERATIONS_CONTACT_REQUIRED"));
  it("owner invitation required", () => expect(next({ owner: null }).code).toBe("OWNER_SETUP_REQUIRED"));

  it("expired invitation chooses RESEND, not a fresh invite", () => {
    const action = next({
      owner: { userStatus: "INVITED", passwordConfigured: false, invitationValid: false, mfaRequired: true, mfaConfigured: false },
    });
    expect(action.code).toBe("INVITATION_EXPIRED");
    expect(action.source).toBe("owner");
  });

  it("owner password not set is PENDING — waiting on a human, not a fault", () => {
    const action = next({
      owner: { userStatus: "INVITED", passwordConfigured: false, invitationValid: true, mfaRequired: true, mfaConfigured: false },
    });
    expect(action.code).toBe("AWAITING_PASSWORD_SETUP");
    expect(action.state).toBe("PENDING");
  });

  it("MFA", () => {
    const action = next({
      owner: { userStatus: "ACTIVE", passwordConfigured: true, invitationValid: false, mfaRequired: true, mfaConfigured: false },
    });
    expect(action.code).toBe("AWAITING_MFA_SETUP");
  });

  it("operator needs a location", () => {
    const action = next({ staff: { scanCapableCount: 1, locationScopedWithoutLocation: 1 } });
    expect(action.code).toBe("STAFF_LOCATION_ASSIGNMENT_REQUIRED");
    expect(action.source).toBe("staff");
  });

  it("no scanner registered", () => {
    const action = next({ station: { enrolledCount: 0, approvedActiveCount: 0, pendingApprovalCount: 0, active: null } });
    expect(action.code).toBe("STATION_SETUP_REQUIRED");
  });

  it("scanner waiting for approval", () => {
    const action = next({ station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 1, active: null } });
    expect(action.code).toBe("STATION_APPROVAL_PENDING");
    expect(action.title).toBe("Scanner waiting for approval");
  });

  it("calibration", () => {
    const h = healthy();
    const action = next({
      station: { ...h.station, active: { ...h.station.active!, calibrationStatus: "REQUIRED", currentCalibrationId: null } },
    });
    expect(action.code).toBe("CALIBRATION_REQUIRED");
    expect(action.source).toBe("scanner");
  });

  it("zero credits", () => {
    const action = next({ credits: 0 });
    expect(action.code).toBe("CREDITS_REQUIRED");
    expect(action.title).toBe("No Grading Credits");
  });

  it("an unreadable authority is UNKNOWN — never progress, never READY", () => {
    const action = next({ credits: null });
    expect(action.state).toBe("UNKNOWN");
    expect(action.state).not.toBe("READY");
  });
});

describe("the onboarding test card is last, and only once the shop could already grade", () => {
  it("is NOT chosen while an operational dimension is still unresolved", () => {
    const action = next({ credits: 0, testCard: { completedCount: 0, latest: null } });
    expect(action.source).toBe("credits");
  });

  it("test card required", () => {
    const action = next({ testCard: { completedCount: 0, latest: null } });
    expect(action.source).toBe("testCard");
    expect(action.code).toBe("TEST_CARD_REQUIRED");
  });

  it("capturing — complete front and back", () => {
    const action = next({
      testCard: { completedCount: 0, latest: { id: "j1", mvNumber: "MV900", status: "CAPTURING", sidesAccepted: ["front"] } },
    });
    expect(action.code).toBe("TEST_CARD_IN_PROGRESS");
  });

  it("ready for staff review", () => {
    const action = next({
      testCard: { completedCount: 0, latest: { id: "j1", mvNumber: "MV900", status: "READY_TO_GRADE", sidesAccepted: ["front", "back"] } },
    });
    expect(action.code).toBe("TEST_CARD_AWAITING_REVIEW");
  });
});

describe("READY", () => {
  it("is reached only when every required check passes AND the test card is finished", () => {
    const action = next();
    expect(action.state).toBe("READY");
    expect(action.code).toBe("READY");
    expect(action.source).toBeNull();
    expect(action.action).toBeNull();
  });

  it("is withheld when the shop can grade but has never proven a test card", () => {
    const readiness = derivePartnerOperationalReadiness(healthy({ testCard: { completedCount: 0, latest: null } }));
    // It CAN grade — that question is unchanged — but onboarding is not finished.
    expect(readiness.overall.ready).toBe(true);
    expect(readiness.onboarding.complete).toBe(false);
    expect(readiness.nextAction.state).not.toBe("READY");
  });

  it("is withheld whenever any authority is UNKNOWN", () => {
    expect(next({ credits: null }).state).not.toBe("READY");
    expect(next({ portalEnabled: null }).state).not.toBe("READY");
  });
});

describe("the five visible stages", () => {
  it("places every readiness dimension in exactly one stage", () => {
    // Total by construction, so a new dimension cannot ship without being placed.
    const stages = new Set(Object.values(PARTNER_SETUP_STAGE_BY_DIMENSION));
    expect([...stages].sort()).toEqual(["ACTIVATE", "CONNECT", "TEST"]);
    expect(Object.keys(PARTNER_SETUP_STAGE_BY_DIMENSION).sort()).toEqual([...PARTNER_READINESS_DIMENSION_ORDER].sort());
  });

  it("ACTIVATE covers becoming a real shop with a real owner", () => {
    expect(next({ orgStatus: "PENDING" }).stage).toBe("ACTIVATE");
    expect(next({ owner: null }).stage).toBe("ACTIVATE");
    expect(next({ deliveryAddressReady: false }).stage).toBe("ACTIVATE");
    expect(
      next({
        owner: { userStatus: "ACTIVE", passwordConfigured: true, invitationValid: false, mfaRequired: true, mfaConfigured: false },
      }).stage
    ).toBe("ACTIVATE");
  });

  it("CONNECT covers getting the Mac working", () => {
    expect(next({ station: { enrolledCount: 0, approvedActiveCount: 0, pendingApprovalCount: 0, active: null } }).stage).toBe("CONNECT");
    expect(next({ station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 1, active: null } }).stage).toBe("CONNECT");
    expect(next({ staff: { scanCapableCount: 1, locationScopedWithoutLocation: 1 } }).stage).toBe("CONNECT");
    const h = healthy();
    expect(
      next({ station: { ...h.station, active: { ...h.station.active!, calibrationStatus: "REQUIRED", currentCalibrationId: null } } }).stage
    ).toBe("CONNECT");
  });

  it("TEST covers credits and the test card, because credits are what let the card be scanned", () => {
    expect(next({ credits: 0 }).stage).toBe("TEST");
    expect(next({ testCard: { completedCount: 0, latest: null } }).stage).toBe("TEST");
  });

  it("LIVE only when the canonical authority says so", () => {
    expect(next().stage).toBe("LIVE");
    // Not live while anything is unresolved, including an unreadable authority.
    expect(next({ credits: null }).stage).not.toBe("LIVE");
    expect(next({ testCard: { completedCount: 0, latest: null } }).stage).not.toBe("LIVE");
  });

  it("the stage always agrees with the action it is shown beside", () => {
    // Same verdict said twice, never two opinions.
    const action = next({ station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 1, active: null } });
    expect(action.source).toBe("station");
    expect(action.stage).toBe(PARTNER_SETUP_STAGE_BY_DIMENSION.station);
  });

  it("low credits above zero is NOT an onboarding blocker", () => {
    // 4 credits still grades. Only zero stops a card, so only zero can be the next action.
    expect(next({ credits: 4 }).state).toBe("READY");
    expect(next({ credits: 4 }).stage).toBe("LIVE");
  });

  it("branding can never influence the verdict — it is not a dimension at all", () => {
    expect(Object.keys(PARTNER_SETUP_STAGE_BY_DIMENSION)).not.toContain("branding");
    expect([...PARTNER_READINESS_DIMENSION_ORDER]).not.toContain("branding" as never);
  });
});
