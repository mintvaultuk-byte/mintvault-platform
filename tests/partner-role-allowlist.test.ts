import { describe, expect, it } from "vitest";
import { isAdminPartnerRole } from "../server/partner/partner-management-service";
import { requirePortalTeamRole } from "../server/partner/team-service";

const PROTOTYPE_KEYS = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"];

describe("partner user role allowlists", () => {
  it("rejects prototype keys for Super Admin partner roles", () => {
    for (const key of PROTOTYPE_KEYS) expect(isAdminPartnerRole(key)).toBe(false);
  });

  it("rejects prototype keys for Partner Portal team roles", () => {
    for (const key of PROTOTYPE_KEYS) expect(() => requirePortalTeamRole(key)).toThrow(/Unknown team role/);
  });

  it("accepts only explicit supported roles", () => {
    for (const role of ["OWNER", "ADMIN", "GRADER", "STAFF"]) {
      expect(isAdminPartnerRole(role)).toBe(true);
      expect(requirePortalTeamRole(role)).toBe(role);
    }
    for (const role of ["FINANCE_VIEWER", "TRAINEE", "", "owner"]) {
      expect(isAdminPartnerRole(role)).toBe(false);
      expect(() => requirePortalTeamRole(role)).toThrow();
    }
  });
});
