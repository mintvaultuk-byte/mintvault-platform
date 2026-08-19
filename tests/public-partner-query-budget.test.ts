import { beforeEach, describe, expect, it, vi } from "vitest";

const { partnerAdminQuery } = vi.hoisted(() => ({ partnerAdminQuery: vi.fn() }));
vi.mock("../server/partner/db", () => ({ partnerAdminQuery }));

import {
  getPublicPartnerLocation,
  listPublicPartnerLocations,
} from "../server/partner/public-presence-service";

const rows = Array.from({ length: 100 }, (_, index) => ({
  public_ref: `shop-ref-${String(index).padStart(3, "0")}`,
  display_name: `Shop ${index}`,
  location_name: `Town ${index}`,
  address: `${index} High Street, Town AB1 2CD`,
  website: null,
  phone: null,
  email: null,
  partner_since: null,
  cards_graded: "0",
}));

beforeEach(() => {
  partnerAdminQuery.mockReset();
  partnerAdminQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("to_regclass('public.partner_google_profile_cache')")) return { rows: [{ ready: true }] };
    if (sql.includes("FROM partner_google_profile_cache")) return { rows: [] };
    if (sql.includes("lower(public_ref) = lower($3)")) return { rows: [rows[0]] };
    return { rows };
  });
});

describe("public Partner fixed query budget", () => {
  it("uses three bounded SQL calls for 100 directory rows, not one call per Partner", async () => {
    expect(await listPublicPartnerLocations({ limit: 100 })).toHaveLength(100);
    expect(partnerAdminQuery).toHaveBeenCalledTimes(3);
  });

  it("keeps search and profile on the same three-call budget", async () => {
    expect(await listPublicPartnerLocations({ search: "Town", limit: 100 })).toHaveLength(100);
    expect(partnerAdminQuery).toHaveBeenCalledTimes(3);
    partnerAdminQuery.mockClear();
    expect(await getPublicPartnerLocation(rows[0].public_ref)).not.toBeNull();
    expect(partnerAdminQuery).toHaveBeenCalledTimes(3);
  });
});
