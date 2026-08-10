import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("Super Admin public-listing operations UI", () => {
  const page = read("client/src/pages/admin/partner-public-listings.tsx");
  const routes = read("server/partner/public-network-routes.ts");

  it("is a same-origin client of the existing Super Admin route, never a client-side authority", () => {
    expect(page).toContain('const BASE = "/api/super-admin/partner-listings"');
    expect(page).toContain('apiRequest("POST"');
    expect(page).toContain('apiRequest("GET"');
    expect(page).not.toContain("partnerAdminQuery(");
    expect(page).not.toContain("localStorage");
  });

  it("exposes the existing audited lifecycle, address/coordinate and rating operations", () => {
    for (const id of [
      "partner-listings-create-draft",
      "partner-listing-reason",
      "partner-listing-save-details",
      "partner-listing-verify",
      "partner-listing-recalculate-rating",
      "partner-listing-create-override",
      "partner-listing-remove-override",
      "partner-listing-rating-inspection",
    ]) {
      expect(page).toContain(id);
    }
    expect(page).toContain("nextListingStatuses(selected.listing_status)");
    expect(page).toContain("parseCoordinatePair(details.latitude, details.longitude)");
    expect(page).toContain("listingReasonValid(reason)");
    expect(page).toContain("ratingOverrideValid(");
  });

  it("gets draft choices from a server-derived unlisted-location endpoint", () => {
    expect(routes).toContain('r.get("/locations"');
    expect(routes).toContain("LEFT JOIN partner_public_listings p ON p.location_id = l.id");
    expect(routes).toContain("l.status = 'ACTIVE' AND o.status = 'ACTIVE' AND p.id IS NULL");
    expect(page).toContain("`${BASE}/locations`");
  });
});
