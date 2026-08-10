import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const APP = read("client/src/App.tsx");
const API = read("client/src/lib/partner-api.ts");
const FINDER = read("client/src/pages/shop-finder.tsx");
const PROFILE = read("client/src/pages/shop-profile.tsx");
const EDITOR = read("client/src/pages/partner/public-profile.tsx");

describe("partner public network UI", () => {
  it("mounts the real anonymous finder and profile routes", () => {
    expect(APP).toContain('path="/shops/:slug"');
    expect(APP).toContain('path="/shops"');
    expect(API).toContain('"GET", `/api/shops${suffix}`');
    expect(API).toContain('"GET", `/api/shops/${encodeURIComponent(slug)}`');
  });

  it("renders rating-building honestly and never substitutes a star rating", () => {
    expect(FINDER).toContain("rating.sampleSize} of {rating.minimumSample}");
    expect(PROFILE).toContain("shop.rating.sampleSize} of {shop.rating.minimumSample}");
    expect(FINDER).not.toMatch(/stars?|★★★★★|★/i);
    expect(PROFILE).not.toMatch(/stars?|★★★★★|★/i);
  });

  it("limits partner self-service to the five server-allowed contact fields", () => {
    expect(EDITOR).toContain("partnerPublicListings.update");
    for (const key of ["phone:", "email:", "website:", "openingInfo:", "description:"]) expect(EDITOR).toContain(key);
    expect(EDITOR).not.toMatch(/latitude:|longitude:|listing_status:.*setForm|current_public_rating:.*setForm/);
  });
});
