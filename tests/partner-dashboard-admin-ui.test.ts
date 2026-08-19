/**
 * Partner Master Dashboard — frontend helper units + source assertions.
 *
 * Follows the house pattern (partner-management-admin-ui.test.ts): the repo has no
 * @testing-library, so page behaviour is asserted by unit-testing the pure helpers and by
 * making structural assertions against the page source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  alertBadgeVariant,
  dashboardErrorMessage,
  dashboardQueryString,
  dashKeys,
  DEFAULT_FILTERS,
  DRILLDOWN_TABS,
  formatCount,
  formatCredits,
  formatDateTime,
  isAuthError,
  isDrilldownTab,
  PARTNER_DASHBOARD_BASE,
  relativeTime,
  riskBadgeVariant,
  riskLabel,
  statusBadgeVariant,
  truncateName,
} from "../client/src/pages/admin/partner-dashboard-helpers";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const PAGE = read("client/src/pages/admin/partner-dashboard.tsx");
const APP = read("client/src/App.tsx");
const SHELL = read("client/src/components/admin/admin-shell.tsx");

// ---------------------------------------------------------------------------
// Helper units
// ---------------------------------------------------------------------------

describe("query keys", () => {
  it("lead with the literal API path so prefix invalidation works", () => {
    expect(dashKeys.summary()[0]).toBe(`${PARTNER_DASHBOARD_BASE}/summary`);
    expect(dashKeys.alerts()[0]).toBe(`${PARTNER_DASHBOARD_BASE}/alerts`);
    expect(dashKeys.partners({ page: 1 })[0]).toBe(`${PARTNER_DASHBOARD_BASE}/partners`);
    expect(dashKeys.section("abc", "wallet")[0]).toBe(`${PARTNER_DASHBOARD_BASE}/partners/abc/wallet`);
  });

  it("target the dashboard's own base, never the partner portal surface", () => {
    expect(PARTNER_DASHBOARD_BASE).toBe("/api/super-admin/partner-dashboard");
    expect(PARTNER_DASHBOARD_BASE.startsWith("/api/partner/")).toBe(false);
  });
});

describe("querystring building is deterministic", () => {
  it("produces identical output for identical input", () => {
    expect(dashboardQueryString(DEFAULT_FILTERS)).toBe(dashboardQueryString({ ...DEFAULT_FILTERS }));
  });

  it("omits empty filters but always carries pagination", () => {
    const qs = dashboardQueryString(DEFAULT_FILTERS);
    expect(qs).toContain("page=1");
    expect(qs).toContain("pageSize=25");
    expect(qs).not.toContain("status=");
    expect(qs).not.toContain("risk=");
  });

  it("includes and trims a search term", () => {
    const qs = dashboardQueryString({ ...DEFAULT_FILTERS, search: "  card shop  " });
    expect(qs).toContain("search=card+shop");
  });

  it("url-encodes characters that would otherwise break the query", () => {
    const qs = dashboardQueryString({ ...DEFAULT_FILTERS, search: "a&b=c d" });
    expect(qs).not.toMatch(/search=a&b=c d/);
    expect(qs).toContain("search=a%26b%3Dc+d");
  });
});

describe("badge variants always pair colour with text", () => {
  it("maps every real partner status", () => {
    expect(statusBadgeVariant("ACTIVE")).toBe("act");
    expect(statusBadgeVariant("PENDING")).toBe("wait");
    expect(statusBadgeVariant("SUSPENDED")).toBe("red");
    expect(statusBadgeVariant("REVOKED")).toBe("red");
  });

  it("falls back to neutral for an unknown status rather than throwing", () => {
    expect(statusBadgeVariant("SOMETHING_NEW")).toBe("neu");
  });

  it("maps risk levels and labels them without relying on colour alone", () => {
    expect(riskBadgeVariant("high")).toBe("red");
    expect(riskBadgeVariant("none")).toBe("act");
    expect(riskLabel("none")).toBe("OK");
    expect(riskLabel("high")).toBe("HIGH");
  });

  it("maps alert severities", () => {
    expect(alertBadgeVariant("critical")).toBe("red");
    expect(alertBadgeVariant("high")).toBe("red");
    expect(alertBadgeVariant("medium")).toBe("wait");
    expect(alertBadgeVariant("low")).toBe("neu");
  });
});

describe("error normalisation avoids the [object Object] trap", () => {
  it("reads the nested super-admin error envelope", () => {
    const err = { body: { error: { code: "PARTNER_NOT_FOUND", message: "Partner not found." } } };
    expect(dashboardErrorMessage(err)).toBe("Partner not found.");
  });

  it("handles a plain string error body", () => {
    expect(dashboardErrorMessage({ body: { error: "Boom" } })).toBe("Boom");
  });

  it("explains a 403 as a permissions problem", () => {
    expect(dashboardErrorMessage({ status: 403 })).toMatch(/super admin/i);
  });

  it("explains a 401 as an expired session", () => {
    expect(dashboardErrorMessage({ status: 401 })).toMatch(/expired/i);
  });

  it("never returns [object Object]", () => {
    for (const err of [{}, null, undefined, new Error("x"), { body: {} }, { body: { error: {} } }]) {
      expect(dashboardErrorMessage(err)).not.toContain("[object Object]");
    }
  });

  it("detects auth errors so the page can redirect instead of showing an empty grid", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(false);
    expect(isAuthError({})).toBe(false);
  });
});

describe("formatting is safe for large numbers, nulls and long names", () => {
  it("distinguishes null (unknown) from zero", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(0)).toBe("0");
    expect(formatCredits(null)).toBe("—");
    expect(formatCredits(0)).toBe("0");
  });

  it("compacts large counts so a KPI tile cannot overflow", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(25_000)).toBe("25.0k");
    expect(formatCount(3_400_000)).toBe("3.4M");
  });

  it("handles non-finite input without rendering NaN", () => {
    expect(formatCount(NaN)).toBe("—");
    expect(formatCount(Infinity)).toBe("—");
  });

  it("truncates long shop names with an ellipsis and leaves short ones alone", () => {
    expect(truncateName("Corner Card Shop")).toBe("Corner Card Shop");
    const long = "A".repeat(80);
    const out = truncateName(long);
    expect(out.length).toBeLessThanOrEqual(42);
    expect(out.endsWith("…")).toBe(true);
  });

  it("renders relative time in operator-friendly units", () => {
    const now = Date.parse("2026-07-28T12:00:00Z");
    expect(relativeTime(null, now)).toBe("Never");
    expect(relativeTime("2026-07-28T11:59:30Z", now)).toBe("Just now");
    expect(relativeTime("2026-07-28T11:00:00Z", now)).toBe("1h ago");
    expect(relativeTime("2026-07-25T12:00:00Z", now)).toBe("3d ago");
  });

  it("never renders Invalid Date", () => {
    expect(formatDateTime("nonsense")).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(relativeTime("nonsense")).toBe("—");
  });
});

describe("drill-down tabs cover the required sections", () => {
  it("includes every section named in the requirement", () => {
    const keys = DRILLDOWN_TABS.map((t) => t.key);
    for (const required of [
      "overview",
      "staff",
      "wallet",
      "submissions",
      "quality",
      "corrections",
      "devices",
      "security",
      "audit",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("validates a tab name from a deep link", () => {
    expect(isDrilldownTab("wallet")).toBe(true);
    expect(isDrilldownTab("../../etc/passwd")).toBe(false);
    expect(isDrilldownTab(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

describe("page is shell-unified and correctly registered", () => {
  it("renders AdminShell as required by the repo-wide shell guard", () => {
    expect(PAGE).toMatch(/<AdminShell/);
  });

  it("is lazy-imported from @/pages so the guard's parser can resolve it", () => {
    expect(APP).toMatch(
      /const AdminPartnerDashboardPage = lazy\(\(\) => import\("@\/pages\/admin\/partner-dashboard"\)\)/
    );
  });

  it("retains the dashboard URL as a flag-gated redirect to the canonical overview", () => {
    expect(APP).toMatch(
      /<Route path="\/admin\/partners\/dashboard">\s*<PartnerNetworkLegacyRoute canonical="\/admin\/partners">\s*<AdminPartnerDashboardPage \/>\s*<\/PartnerNetworkLegacyRoute>\s*<\/Route>/
    );
  });

  it("keeps /admin/partners/dashboard above any future /admin/partners/:param route", () => {
    const dashboardAt = APP.indexOf('path="/admin/partners/dashboard"');
    expect(dashboardAt).toBeGreaterThan(-1);
    const paramRoute = APP.match(/path="\/admin\/partners\/:[^"]*"/);
    if (paramRoute && paramRoute.index !== undefined) {
      // If a param route is ever added it MUST come after, or wouter captures "dashboard".
      expect(dashboardAt).toBeLessThan(paramRoute.index);
    }
  });

  it("appears above the catch-all route so it renders in the admin shell", () => {
    const dashboardAt = APP.indexOf('path="/admin/partners/dashboard"');
    const notFoundAt = APP.indexOf("component={NotFound}");
    expect(dashboardAt).toBeGreaterThan(-1);
    if (notFoundAt > -1) expect(dashboardAt).toBeLessThan(notFoundAt);
  });

  it("is reached through the canonical Partner Network admin navigation", () => {
    expect(SHELL).toContain('href: "/admin/partners", label: "Partner Network"');
  });

  it("does not expose retired legacy Partner entries in the canonical admin navigation", () => {
    expect(SHELL).not.toContain('href: "/admin/partner-network", label: "Partner Connectors"');
    expect(SHELL).not.toContain('href: "/admin/partner-network/partners", label: "Partners"');
  });
});

describe("page follows admin auth and data conventions", () => {
  it("gates on the admin session while preserving its exact direct-link destination", () => {
    expect(PAGE).toContain('"/api/admin/session"');
    expect(PAGE).toContain("encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)");
  });

  it("passes an explicit queryFn (the default fetcher would join the key array into a bad URL)", () => {
    expect(PAGE).toContain("queryFn:");
    expect(PAGE).toContain("apiRequest(");
  });

  it("handles the error state explicitly, not as an empty state", () => {
    expect(PAGE).toContain("isError");
    expect(PAGE).toContain("pd-error");
    expect(PAGE).toMatch(/refetch\(\)/);
  });

  it("renders distinct loading, empty and error states", () => {
    expect(PAGE).toContain("pd-partners-loading");
    expect(PAGE).toContain("pd-partners-empty");
    expect(PAGE).toContain('role="alert"');
    expect(PAGE).toContain('aria-live="polite"');
  });

  it("opts back into refetching, since the global default is staleTime Infinity", () => {
    expect(PAGE).toContain("refetchInterval");
  });

  it("uses no `any` types", () => {
    expect(PAGE).not.toMatch(/:\s*any\b/);
  });
});

describe("page must not fabricate metrics", () => {
  it("renders an explicit unavailable affordance", () => {
    expect(PAGE).toContain("pd-unavailable");
    expect(PAGE).toMatch(/function Unavailable/);
  });

  it("surfaces the reason for each missing section rather than an empty table", () => {
    expect(PAGE).toContain("pd-quality-unavailable");
    expect(PAGE).toContain("pd-devices-unavailable");
    expect(PAGE).toMatch(/function NoDataSection/);
  });

  it("does not hardcode a quality score, rating or grade-variance number", () => {
    expect(PAGE).not.toMatch(/qualityRating\s*[:=]\s*\d/);
    expect(PAGE).not.toMatch(/overallRating\s*[:=]\s*\d/);
  });
});

describe("audited credit adjustment control", () => {
  it("posts only to the dedicated Super Admin adjustment endpoint", () => {
    expect(PAGE).toContain("useMutation");
    expect(PAGE).toContain("/credits/adjust`");
    expect(PAGE).toContain('"POST"');
    for (const verb of ['"PUT"', '"PATCH"', '"DELETE"']) expect(PAGE).not.toContain(verb);
  });

  it("requires a quantity, reason and explicit adjustment command", () => {
    expect(PAGE).toContain("pd-credit-adjustment");
    expect(PAGE).toContain("pd-credit-quantity");
    expect(PAGE).toContain("pd-credit-reason");
    expect(PAGE).toContain("pd-credit-idempotency-key");
    expect(PAGE).toContain("pd-credit-submit");
    expect(PAGE).toContain("idempotencyKey.trim()");
  });
});

describe("page never targets the partner portal API", () => {
  it("contains no /api/partner/ call", () => {
    expect(PAGE).not.toContain("/api/partner/");
  });
});

describe("table markup is accessible and density-safe", () => {
  it("uses scoped column headers", () => {
    expect(PAGE).toContain('scope="col"');
  });

  it("wraps wide tables so the page body never scrolls horizontally", () => {
    expect(PAGE).toContain('overflowX: "auto"');
  });

  it("labels its filter controls", () => {
    expect(PAGE).toContain('htmlFor="pd-search"');
    expect(PAGE).toContain('htmlFor="pd-risk"');
    expect(PAGE).toContain('htmlFor="pd-sort"');
  });
});
