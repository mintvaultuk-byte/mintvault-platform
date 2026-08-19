import { describe, expect, it, vi } from "vitest";

const partnerAdminQuery = vi.fn();
vi.mock("../server/partner/db", () => ({ partnerAdminQuery: (...args: unknown[]) => partnerAdminQuery(...args) }));

import { getPartnerStationReadVisibility } from "../server/partner/dashboard-visibility";

describe("Command Centre station readability probe", () => {
  it("fails closed when the cross-tenant role is blocked by FORCE RLS", async () => {
    partnerAdminQuery.mockImplementation((query: string) => Promise.resolve(query.includes("pg_roles")
      ? { rows: [{ role_name: "app_role", rolsuper: false, rolbypassrls: false }] }
      : { rows: [{ relname: "partner_stations", relkind: "r", relrowsecurity: true, relforcerowsecurity: true, owner: "owner_role" }] }));
    await expect(getPartnerStationReadVisibility()).resolves.toEqual({ ok: false, code: "PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE" });
  });

  it("fails closed when the station relation is missing instead of permitting a false zero", async () => {
    partnerAdminQuery.mockImplementation((query: string) => Promise.resolve(query.includes("pg_roles")
      ? { rows: [{ role_name: "app_role", rolsuper: false, rolbypassrls: true }] }
      : { rows: [] }));
    await expect(getPartnerStationReadVisibility()).resolves.toEqual({ ok: false, code: "PARTNER_ADMIN_SCHEMA_UNAVAILABLE" });
  });

  it("permits a station aggregate only for an RLS-capable read role", async () => {
    partnerAdminQuery.mockImplementation((query: string) => Promise.resolve(query.includes("pg_roles")
      ? { rows: [{ role_name: "app_role", rolsuper: false, rolbypassrls: true }] }
      : { rows: [{ relname: "partner_stations", relkind: "r", relrowsecurity: true, relforcerowsecurity: true, owner: "owner_role" }] }));
    await expect(getPartnerStationReadVisibility()).resolves.toEqual({ ok: true });
  });
});
