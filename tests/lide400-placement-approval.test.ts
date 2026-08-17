/**
 * PROOFS 17 and 18 — a stale Preview cannot enable a later capture, and a FRONT Preview can never
 * enable BACK.
 *
 * These are the safety conditions the whole per-side gate rests on. The rule is a pure function
 * precisely so it can be proved here rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { matchPlacementApproval, PLACEMENT_APPROVAL_TTL_MS } = require_(
  "../scripts/scanner-app/lib/placement-approval.js"
);

const NOW = 1_700_000_000_000;
const target = { sessionId: "session-a", side: "back", certId: "MV272" };
const green = {
  state: "GREEN",
  sessionId: "session-a",
  side: "back",
  certId: "MV272",
  approvedAtMs: NOW - 1_000,
  message: "CARD POSITION READY",
};

describe("A live GREEN approval for the exact side", () => {
  it("authorises the capture", () => {
    expect(matchPlacementApproval(green, target, NOW).ok).toBe(true);
  });
});

describe("PROOF 18 — a FRONT Preview never authorises BACK", () => {
  it("refuses a FRONT approval when BACK is awaiting Scan", () => {
    const front = { ...green, side: "front" };
    const result = matchPlacementApproval(front, target, NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("wrong_side");
    expect(result.error).toContain("MV272 back");
  });

  it("refuses a BACK approval when FRONT is awaiting Scan", () => {
    const result = matchPlacementApproval(green, { ...target, side: "front" }, NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("wrong_side");
  });
});

describe("PROOF 17 — a stale Preview never authorises a later capture", () => {
  it("refuses an approval older than its time-to-live", () => {
    const result = matchPlacementApproval({ ...green, approvedAtMs: NOW - PLACEMENT_APPROVAL_TTL_MS - 1 }, target, NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("expired");
  });

  it("accepts one that is only just inside it, so the rule is a real boundary and not a rounding", () => {
    expect(matchPlacementApproval({ ...green, approvedAtMs: NOW - PLACEMENT_APPROVAL_TTL_MS }, target, NOW).ok).toBe(
      true
    );
  });

  it("refuses an approval with no timestamp at all rather than treating it as fresh", () => {
    expect(matchPlacementApproval({ ...green, approvedAtMs: undefined }, target, NOW).code).toBe("expired");
  });

  it("refuses an approval stamped in the future, which cannot describe a card on the glass now", () => {
    expect(matchPlacementApproval({ ...green, approvedAtMs: NOW + 60_000 }, target, NOW).code).toBe("expired");
  });
});

describe("Every other way an approval can fail to apply", () => {
  it("refuses when there is no approval at all", () => {
    const result = matchPlacementApproval(null, target, NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_approval");
  });

  it("refuses a RED verdict and surfaces its operator message", () => {
    const red = { ...green, state: "RED", message: "PLACE THE WHOLE CARD INSIDE THE RED BOX" };
    const result = matchPlacementApproval(red, target, NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_green");
    expect(result.error).toBe("PLACE THE WHOLE CARD INSIDE THE RED BOX");
  });

  it("refuses an approval from a different capture session", () => {
    expect(matchPlacementApproval({ ...green, sessionId: "session-b" }, target, NOW).code).toBe("wrong_session");
  });

  it("refuses an approval belonging to a different card", () => {
    expect(matchPlacementApproval({ ...green, certId: "MV273" }, target, NOW).code).toBe("wrong_card");
  });

  it("cannot be satisfied by a truthy-but-wrong state string", () => {
    // "green", "ok", "READY" are all NOT the approval state. Only the exact GREEN passes.
    for (const state of ["green", "ok", "READY", "TRUE", "1"]) {
      expect(matchPlacementApproval({ ...green, state }, target, NOW).ok, state).toBe(false);
    }
  });
});
