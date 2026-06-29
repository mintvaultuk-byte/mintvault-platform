import { describe, it, expect } from "vitest";
import { isClaimed, isValidReprintReason, buildReprintRequest } from "../client/src/lib/reprint";

describe("isClaimed", () => {
  it("treats unclaimed (or missing) as not claimed", () => {
    expect(isClaimed({ certId: "MV1", ownershipStatus: "unclaimed" })).toBe(false);
    expect(isClaimed({ certId: "MV1" })).toBe(false);
  });
  it("treats claimed / transfer_pending as claimed", () => {
    expect(isClaimed({ certId: "MV1", ownershipStatus: "claimed" })).toBe(true);
    expect(isClaimed({ certId: "MV1", ownershipStatus: "transfer_pending" })).toBe(true);
  });
});

describe("isValidReprintReason", () => {
  it("requires 10–500 trimmed characters", () => {
    expect(isValidReprintReason("too short")).toBe(false); // 9
    expect(isValidReprintReason("   short   ")).toBe(false);
    expect(isValidReprintReason("a reasonable reprint reason")).toBe(true);
    expect(isValidReprintReason("x".repeat(500))).toBe(true);
    expect(isValidReprintReason("x".repeat(501))).toBe(false);
    expect(isValidReprintReason(null)).toBe(false);
  });
});

describe("buildReprintRequest", () => {
  it("unclaimed cert -> print-batch with no reason", () => {
    expect(buildReprintRequest({ certId: "MV1", ownershipStatus: "unclaimed" })).toEqual({
      url: "/api/admin/print-batch",
      body: { certIds: ["MV1"] },
    });
  });

  it("claimed cert with a valid reason -> reprint endpoint carrying the reason", () => {
    expect(
      buildReprintRequest({ certId: "MV9", ownershipStatus: "claimed" }, "damaged slab, customer requested reprint")
    ).toEqual({
      url: "/api/admin/print-batch/reprint",
      body: { certIds: ["MV9"], reason: "damaged slab, customer requested reprint" },
    });
  });

  it("claimed cert without a reason throws (caller must collect one)", () => {
    expect(() => buildReprintRequest({ certId: "MV9", ownershipStatus: "claimed" })).toThrow(/reason/i);
    expect(() => buildReprintRequest({ certId: "MV9", ownershipStatus: "claimed" }, "short")).toThrow(/reason/i);
  });
});
