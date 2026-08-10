import { describe, expect, it } from "vitest";
import {
  googleMapsDirectionsUrl,
  googleMapsSearchUrl,
  publicShopMapPoints,
} from "../client/src/components/partner/public-shop-coordinate-map";

const baseShop = {
  displayName: "Kent Cards",
  slug: "kent-cards",
  tradingName: null,
  townCity: "Canterbury",
  county: "Kent",
  postcode: "CT1 1AA",
  country: "GB",
  latitude: 51.28,
  longitude: 1.08,
  distanceKm: null,
  verified: true,
  rating: {
    available: false,
    isOverride: false,
    rating: null,
    label: "Rating Building",
    sampleSize: 2,
    minimumSample: 20,
    version: null,
    calculatedAt: null,
  },
};

describe("public Partner shop map", () => {
  it("plots only approved-coordinate results and preserves a selectable pin per coordinate-bearing shop", () => {
    const points = publicShopMapPoints([
      baseShop,
      { ...baseShop, slug: "also-kent", displayName: "Also Kent" },
      { ...baseShop, slug: "no-coordinate", latitude: null, longitude: null },
    ]);
    expect(points).toHaveLength(2);
    expect(new Set(points.map((point) => point.shop.slug))).toEqual(new Set(["kent-cards", "also-kent"]));
    expect(points.every((point) => point.left >= 5 && point.left <= 95 && point.top >= 5 && point.top <= 95)).toBe(
      true
    );
    expect(points[0]).not.toMatchObject({ left: points[1]!.left, top: points[1]!.top });
  });

  it("builds Google Maps and directions links only from approved shop coordinates or public address", () => {
    expect(googleMapsSearchUrl(baseShop)).toContain("maps/search/?api=1&query=51.28%2C1.08");
    expect(googleMapsDirectionsUrl(baseShop)).toContain("maps/dir/?api=1&destination=51.28%2C1.08");
    expect(googleMapsSearchUrl({ ...baseShop, latitude: null, longitude: null })).toContain("Canterbury");
  });
});
