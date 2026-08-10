import { describe, expect, it } from "vitest";
import {
  nextListingStatuses,
  parseCoordinatePair,
  publicListingSlugValid,
  listingReasonValid,
  ratingOverrideValid,
} from "../client/src/pages/admin/partner-public-listings-helpers";

describe("Super Admin public-listing helpers", () => {
  it("mirrors the server lifecycle without inventing a transition", () => {
    expect(nextListingStatuses("DRAFT")).toEqual(["PENDING_REVIEW", "REMOVED"]);
    expect(nextListingStatuses("PENDING_REVIEW")).toEqual(["ACTIVE", "DRAFT", "REMOVED"]);
    expect(nextListingStatuses("ACTIVE")).toEqual(["PAUSED", "SUSPENDED", "REMOVED"]);
    expect(nextListingStatuses("PAUSED")).toEqual(["ACTIVE", "SUSPENDED", "REMOVED"]);
    expect(nextListingStatuses("SUSPENDED")).toEqual(["ACTIVE", "REMOVED"]);
    expect(nextListingStatuses("REMOVED")).toEqual([]);
    expect(nextListingStatuses("unknown")).toEqual([]);
  });

  it("requires bounded audit reasons and safe draft slugs", () => {
    expect(listingReasonValid("")).toBe(false);
    expect(listingReasonValid("  ")).toBe(false);
    expect(listingReasonValid("approved after shop identity check")).toBe(true);
    expect(listingReasonValid("x".repeat(501))).toBe(false);
    expect(publicListingSlugValid("bristol-card-shop")).toBe(true);
    expect(publicListingSlugValid("Bristol-card-shop")).toBe(false);
    expect(publicListingSlugValid("a--b")).toBe(false);
  });

  it("accepts coordinate pairs only", () => {
    expect(parseCoordinatePair("51.4545", "-2.5879")).toEqual({ latitude: 51.4545, longitude: -2.5879 });
    expect(parseCoordinatePair("", "")).toEqual({ latitude: null, longitude: null });
    expect(parseCoordinatePair("51.4545", "")).toBeNull();
    expect(parseCoordinatePair("91", "0")).toBeNull();
  });

  it("requires a real exceptional rating input and audit reason", () => {
    expect(ratingOverrideValid("4.5", "", "manual evidence review")).toBe(true);
    expect(ratingOverrideValid("", "Temporarily unavailable", "manual evidence review")).toBe(true);
    expect(ratingOverrideValid("5.1", "", "manual evidence review")).toBe(false);
    expect(ratingOverrideValid("4", "", "")).toBe(false);
  });
});
