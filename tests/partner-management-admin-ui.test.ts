/**
 * G5 Partner-management admin UI — unit + source-assertion coverage (the repo has no DOM/RTL harness).
 * Page logic lives in exported pure helpers (unit-tested here); the page components are verified by
 * source assertion: required data-testids present, mutations reason/version/typed-confirm gated,
 * accessible modals, unavailable metrics labeled, and the single WALLET-BACKFILL1 staging control is
 * wired through the authenticated Super Admin API client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  statusBadgeVariant,
  allowedNextStatuses,
  isHighRiskStatus,
  isPartnerStatus,
  reasonValid,
  noteValid,
  partnersQueryString,
  pmKeys,
  PARTNER_STATUSES,
  PARTNER_PILOT_MUTABLE_FLAGS,
  PARTNER_PILOT_READONLY_FLAG,
  isPartnerPilotMutableFlag,
} from "../client/src/pages/admin/partner-management-helpers";

describe("G5 UI pure helpers", () => {
  it("statusBadgeVariant maps each status to a valid admin badge variant", () => {
    expect(statusBadgeVariant("ACTIVE")).toBe("act");
    expect(statusBadgeVariant("PENDING")).toBe("wait");
    expect(statusBadgeVariant("SUSPENDED")).toBe("prog");
    expect(statusBadgeVariant("REVOKED")).toBe("red");
    expect(statusBadgeVariant("weird")).toBe("neu");
  });

  it("status lifecycle matches the server (existing PENDING/ACTIVE/SUSPENDED/REVOKED values)", () => {
    expect(PARTNER_STATUSES).toEqual(["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]);
    expect(allowedNextStatuses("PENDING").sort()).toEqual(["ACTIVE", "REVOKED"]);
    expect(allowedNextStatuses("ACTIVE").sort()).toEqual(["REVOKED", "SUSPENDED"]);
    expect(allowedNextStatuses("SUSPENDED").sort()).toEqual(["ACTIVE", "REVOKED"]);
    expect(allowedNextStatuses("REVOKED")).toEqual([]);
    expect(allowedNextStatuses("nope")).toEqual([]);
    expect(isPartnerStatus("ACTIVE")).toBe(true);
    expect(isPartnerStatus("nope")).toBe(false);
  });

  it("isHighRiskStatus flags SUSPENDED/REVOKED only", () => {
    expect(isHighRiskStatus("SUSPENDED")).toBe(true);
    expect(isHighRiskStatus("REVOKED")).toBe(true);
    expect(isHighRiskStatus("ACTIVE")).toBe(false);
  });

  it("reasonValid / noteValid reject blank + over-long", () => {
    expect(reasonValid("")).toBe(false);
    expect(reasonValid("  ")).toBe(false);
    expect(reasonValid("ok")).toBe(true);
    expect(reasonValid("x".repeat(2001))).toBe(false);
    expect(noteValid("")).toBe(false);
    expect(noteValid("note")).toBe(true);
    expect(noteValid("x".repeat(10001))).toBe(false);
  });

  it("partnersQueryString is deterministic and only emits set filters", () => {
    expect(partnersQueryString({})).toBe("");
    expect(partnersQueryString({ status: "ACTIVE" })).toBe("?status=ACTIVE");
    expect(partnersQueryString({ search: "acme", page: 2 })).toBe("?search=acme&page=2");
  });

  it("pmKeys build literal API paths for prefix-invalidation", () => {
    expect(pmKeys.partner("abc")[0]).toBe("/api/super-admin/partner-management/partners/abc");
    expect(pmKeys.notes("abc")[0]).toBe("/api/super-admin/partner-management/partners/abc/notes");
    expect(pmKeys.walletBackfill()[0]).toBe("/api/super-admin/partner-management/wallet-backfills/WALLET-BACKFILL1");
  });

  it("pilot flag helpers expose only onboarding/login as mutable and portal as read-only", () => {
    expect(PARTNER_PILOT_READONLY_FLAG).toBe("partner_portal_enabled");
    expect(PARTNER_PILOT_MUTABLE_FLAGS).toEqual(["partner_onboarding_enabled", "partner_login_enabled"]);
    expect(isPartnerPilotMutableFlag("partner_onboarding_enabled")).toBe(true);
    expect(isPartnerPilotMutableFlag("partner_login_enabled")).toBe(true);
    expect(isPartnerPilotMutableFlag("partner_portal_enabled")).toBe(false);
    expect(isPartnerPilotMutableFlag("partner_connector_enabled")).toBe(false);
    expect(isPartnerPilotMutableFlag("partner_grading_enabled")).toBe(false);
    expect(isPartnerPilotMutableFlag("partner_payments_enabled")).toBe(false);
  });
});

describe("G5 list page source assertions", () => {
  const src = readFileSync(join(process.cwd(), "client/src/pages/admin/partner-management.tsx"), "utf8");
  it("uses the admin shell + admin session gate", () => {
    expect(src).toContain("AdminShell");
    expect(src).toContain("/api/admin/session");
    expect(src).toContain("/admin/login?next=/admin/partner-network/partners");
  });
  it("carries required data-testids (list, filters, table, create modal)", () => {
    for (const id of [
      "pm-list-root",
      "pm-search",
      "pm-filter-all",
      "pm-table",
      "pm-create-modal",
      "pm-create-confirm",
      "pm-pilot-flags",
      "pm-pilot-flag-toggle-",
      "pm-pilot-portal-readonly",
      "pm-wallet-backfill",
      "pm-wallet-backfill-scope",
      "pm-wallet-backfill-targets",
      "pm-wallet-backfill-confirm",
      "pm-wallet-backfill-submit",
      "pm-wallet-backfill-result",
    ]) {
      expect(src).toContain(id);
    }
  });
  it("wires WALLET-BACKFILL1 through the same-origin admin API client with explicit targets and audit result", () => {
    expect(src).toContain("Provision Missing Partner Wallets");
    expect(src).toContain("All ACTIVE partner organisations missing wallets");
    expect(src).toContain("/wallet-backfills/WALLET-BACKFILL1");
    expect(src).toContain('apiRequest("POST"');
    expect(src).toContain('confirm: "WALLET-BACKFILL1"');
    expect(src).toContain("targetTenantIds: walletTargets.map");
    expect(src).toContain('idempotencyKey: "WALLET-BACKFILL1-ui"');
    expect(src).toContain("ledgerEntriesCreated");
    expect(src).not.toContain("document.cookie");
    expect(src).not.toContain("localStorage");
    expect(src).not.toContain("/api/partner/");
  });
  it("hardcodes the pilot controls to the canonical flag API and no connector/grading/payment flags", () => {
    expect(src).toContain("PARTNER_PILOT_FLAG_BASE");
    expect(src).toContain("window.confirm");
    expect(src).toContain("Pilot setup:");
    expect(src).not.toContain("partner_connector_enabled");
    expect(src).not.toContain("partner_grading_enabled");
    expect(src).not.toContain("partner_payments_enabled");
  });
});

describe("shared admin API client source assertions", () => {
  const queryClientSrc = readFileSync(join(process.cwd(), "client/src/lib/queryClient.ts"), "utf8");
  it("sends admin mutations as same-origin credentialed JSON requests", () => {
    expect(queryClientSrc).toContain('credentials: "include"');
    expect(queryClientSrc).toContain('"Content-Type": "application/json"');
  });
});

describe("G5 detail page source assertions", () => {
  const src = readFileSync(join(process.cwd(), "client/src/pages/admin/partner-management-detail.tsx"), "utf8");
  it("has the eight tabs (rendered from the TABS list) + admin session gate", () => {
    expect(src).toContain("pm-tab-"); // tabs render via `pm-tab-${k}`
    for (const key of [
      "overview",
      "users",
      "profile",
      "contacts",
      "branding",
      "activity",
      "notes",
      "audit",
      "connector",
    ]) {
      expect(src).toContain(`"${key}"`);
    }
    for (const label of [
      "Overview",
      "Users",
      "Company Profile",
      "Contacts",
      "Branding",
      "Activity",
      "Internal Notes",
      "Audit",
      "Connector Summary",
    ]) {
      expect(src).toContain(label);
    }
    expect(src).toContain("/api/admin/session");
  });
  it("adds partner user management UI without password display or retrieval", () => {
    for (const id of [
      "pm-tab-",
      "pm-users",
      "pm-users-empty",
      "pm-user-modal",
      "pm-user-first-name",
      "pm-user-last-name",
      "pm-user-email",
      "pm-user-role",
      "pm-user-confirm",
      "pm-user-revoke-invite-",
      "pm-create-owner-login",
      "pm-setup-checklist",
    ]) {
      expect(src).toContain(id);
    }
    expect(src).toContain("Create owner login");
    expect(src).toContain("Create invitation");
    expect(src).not.toContain("password_hash");
    expect(src).not.toContain("existing password");
  });
  it("gates mutations on reason + expectedVersion + typed-confirm for high-risk; a11y modal", () => {
    expect(src).toContain("reasonValid(reason)");
    expect(src).toContain("expectedVersion: version");
    expect(src).toContain("typed.trim() !== TYPED_CONFIRM");
    expect(src).toContain('aria-labelledby="pm-modal-title"');
    // Escape handling is asserted by BEHAVIOUR-shape, not by one literal spelling: the handler was
    // refactored to an early-return (`e.key !== "Escape"`) when the profile and invitation editors
    // were added to it, which is equivalent and covers strictly more dialogs.
    expect(src).toMatch(/e\.key (===|!==) "Escape"/);
  });
  it("status change carries the business-label-only note and no side-effect language", () => {
    expect(src).toContain("business-status label only");
    expect(src).toContain("No accounts, devices, sessions or feature flags are changed");
  });
  it("internal notes are append-only + labeled internal; unavailable stats labeled", () => {
    expect(src).toContain("Append-only (no edit/delete)");
    expect(src).toContain("never visible to partners");
    expect(src).toContain("UNAVAILABLE_LABEL");
    expect(src).toContain("pm-stat-unavailable");
  });
  it("does NOT expose any future-phase controls (wallet/credits/slots/billing/devices/pricing/marketplace/portal)", () => {
    const forbidden = [
      "/wallet",
      "/credits",
      "/slots",
      "/billing",
      "/devices",
      "/pricing",
      "/marketplace",
      "Buy Credits",
      "wallet balance",
      "/api/partner/",
    ];
    for (const f of forbidden) expect(src).not.toContain(f);
  });
});

describe("G5 nav + routes source assertions", () => {
  const app = readFileSync(join(process.cwd(), "client/src/App.tsx"), "utf8");
  const shell = readFileSync(join(process.cwd(), "client/src/components/admin/admin-shell.tsx"), "utf8");
  it("adds the two new routes most-specific-first and keeps the G4 ops route", () => {
    const detailIdx = app.indexOf('path="/admin/partner-network/partners/:partnerId"');
    const listIdx = app.indexOf('path="/admin/partner-network/partners"');
    const opsIdx = app.indexOf('path="/admin/partner-network"');
    expect(detailIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(-1);
    expect(opsIdx).toBeGreaterThan(-1);
    expect(detailIdx).toBeLessThan(listIdx); // :partnerId before the bare list
    expect(listIdx).toBeLessThan(opsIdx); // both before the existing G4 ops route (kept)
  });
  it("adds one additive Partners NavLink and keeps Partner Connectors", () => {
    expect(shell).toContain('label: "Partner Connectors"');
    expect(shell).toContain('href: "/admin/partner-network/partners", label: "Partners"');
  });
});
