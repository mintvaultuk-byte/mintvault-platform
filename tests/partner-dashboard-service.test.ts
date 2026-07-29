/**
 * Partner Master Dashboard — pure-logic tests.
 *
 * No DB required: these cover the input-validation, allowlisting, bounding and derivation
 * logic that protects the cross-tenant surface. The DB-backed behaviour is covered separately
 * and needs a live Postgres fixture.
 */
import { describe, it, expect } from "vitest";
import {
  ALERT_SEVERITY_RANK,
  BOTTLENECK_STATES,
  clampDashboardPagination,
  DASHBOARD_CONNECTOR_STATES,
  DASHBOARD_MAX_PAGE,
  DASHBOARD_MAX_PAGE_SIZE,
  DASHBOARD_SUBMISSION_STATUSES,
  isDashboardPartnerStatus,
  isPartnerSortKey,
  isSortDirection,
  metric,
  sortAlerts,
  unavailable,
  type DashboardAlert,
} from "@shared/partner-dashboard";
import { deriveRisk, requirePartnerId, DashboardError } from "../server/partner/dashboard-service";

describe("pagination is bounded on BOTH axes", () => {
  it("applies defaults for absent input", () => {
    const p = clampDashboardPagination(undefined, undefined);
    expect(p).toEqual({ page: 1, pageSize: 25, offset: 0 });
  });

  it("clamps pageSize to the maximum", () => {
    expect(clampDashboardPagination(1, 5000).pageSize).toBe(DASHBOARD_MAX_PAGE_SIZE);
  });

  it("clamps page, so a huge page cannot produce a deep OFFSET scan", () => {
    const p = clampDashboardPagination(1e12, 100);
    expect(p.page).toBe(DASHBOARD_MAX_PAGE);
    expect(p.offset).toBe((DASHBOARD_MAX_PAGE - 1) * 100);
    expect(p.offset).toBeLessThanOrEqual(DASHBOARD_MAX_PAGE * DASHBOARD_MAX_PAGE_SIZE);
  });

  it("degrades junk, negatives and NaN to the defaults rather than throwing", () => {
    for (const bad of ["abc", "-5", "0", "", null, {}, [], NaN, Infinity, -Infinity]) {
      const p = clampDashboardPagination(bad, bad);
      expect(p.page).toBeGreaterThanOrEqual(1);
      expect(p.pageSize).toBeGreaterThanOrEqual(1);
      expect(p.offset).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.offset)).toBe(true);
    }
  });

  it("never yields a fractional offset", () => {
    const p = clampDashboardPagination("3.9", "10.7");
    expect(Number.isInteger(p.page)).toBe(true);
    expect(Number.isInteger(p.offset)).toBe(true);
  });
});

describe("sort and filter allowlists (a client string must never reach SQL)", () => {
  it("accepts only the five known sort keys", () => {
    for (const k of ["created_at", "legal_name", "status", "submissions", "last_activity"]) {
      expect(isPartnerSortKey(k)).toBe(true);
    }
  });

  it("rejects injection-shaped and unknown sort keys", () => {
    for (const k of [
      "id; DROP TABLE partner_organisations",
      "o.created_at--",
      "password_hash",
      "1",
      "",
      null,
      undefined,
      {},
    ]) {
      expect(isPartnerSortKey(k)).toBe(false);
    }
  });

  it("accepts only asc/desc as a direction", () => {
    expect(isSortDirection("asc")).toBe(true);
    expect(isSortDirection("desc")).toBe(true);
    for (const d of ["ASC; --", "random()", "", null]) expect(isSortDirection(d)).toBe(false);
  });

  it("accepts only the four real partner statuses", () => {
    for (const s of ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]) {
      expect(isDashboardPartnerStatus(s)).toBe(true);
    }
    for (const s of ["active", "DELETED", "' OR 1=1", ""]) {
      expect(isDashboardPartnerStatus(s)).toBe(false);
    }
  });
});

describe("partner id validation fails closed before reaching Postgres", () => {
  it("accepts a well-formed uuid", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(requirePartnerId(id)).toBe(id);
  });

  it("rejects non-uuid input with INVALID_INPUT, not a database error", () => {
    for (const bad of ["not-a-uuid", "", "1", "'; DROP TABLE x; --", null, undefined, 42, {}, []]) {
      let caught: unknown;
      try {
        requirePartnerId(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DashboardError);
      expect((caught as DashboardError).code).toBe("INVALID_INPUT");
    }
  });
});

describe("risk derivation uses only real signals", () => {
  it("reports no risk for a healthy partner", () => {
    const r = deriveRisk({
      status: "ACTIVE",
      openCorrections: 0,
      securityAlerts: 0,
      lockedStaff: 0,
      availableCredits: 100,
    });
    expect(r.level).toBe("none");
    expect(r.reasons).toEqual([]);
  });

  it("treats suspension as high risk", () => {
    const r = deriveRisk({
      status: "SUSPENDED",
      openCorrections: 0,
      securityAlerts: 0,
      lockedStaff: 0,
      availableCredits: 100,
    });
    expect(r.level).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/suspended/i);
  });

  it("treats a high/critical security event as high risk", () => {
    const r = deriveRisk({
      status: "ACTIVE",
      openCorrections: 0,
      securityAlerts: 2,
      lockedStaff: 0,
      availableCredits: 100,
    });
    expect(r.level).toBe("high");
  });

  it("escalates but never de-escalates as signals accumulate", () => {
    const r = deriveRisk({
      status: "SUSPENDED",
      openCorrections: 5,
      securityAlerts: 1,
      lockedStaff: 2,
      availableCredits: 0,
    });
    expect(r.level).toBe("high");
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("distinguishes exhausted credits (medium) from merely low (low)", () => {
    expect(
      deriveRisk({ status: "ACTIVE", openCorrections: 0, securityAlerts: 0, lockedStaff: 0, availableCredits: 0 }).level
    ).toBe("medium");
    expect(
      deriveRisk({ status: "ACTIVE", openCorrections: 0, securityAlerts: 0, lockedStaff: 0, availableCredits: 5 }).level
    ).toBe("low");
  });

  it("does NOT invent a credit risk when the wallet schema is absent (null, not zero)", () => {
    const r = deriveRisk({
      status: "ACTIVE",
      openCorrections: 0,
      securityAlerts: 0,
      lockedStaff: 0,
      availableCredits: null,
    });
    expect(r.level).toBe("none");
    expect(r.reasons.join(" ")).not.toMatch(/credit/i);
  });
});

describe("alerts are ordered by severity then recency", () => {
  const mk = (id: string, severity: DashboardAlert["severity"], detectedAt: string): DashboardAlert => ({
    id,
    partnerId: "p",
    partnerName: "n",
    severity,
    kind: "k",
    reason: "r",
    recommendedAction: "a",
    detectedAt,
    link: "/",
  });

  it("puts critical first and low last", () => {
    const sorted = sortAlerts([
      mk("a", "low", "2026-01-01T00:00:00Z"),
      mk("b", "critical", "2026-01-01T00:00:00Z"),
      mk("c", "medium", "2026-01-01T00:00:00Z"),
      mk("d", "high", "2026-01-01T00:00:00Z"),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("breaks ties by most recent first", () => {
    const sorted = sortAlerts([mk("old", "high", "2026-01-01T00:00:00Z"), mk("new", "high", "2026-06-01T00:00:00Z")]);
    expect(sorted.map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("does not mutate the input array", () => {
    const input = [mk("a", "low", "2026-01-01T00:00:00Z"), mk("b", "critical", "2026-01-01T00:00:00Z")];
    const copy = [...input];
    sortAlerts(input);
    expect(input).toEqual(copy);
  });

  it("ranks every severity uniquely", () => {
    expect(new Set(Object.values(ALERT_SEVERITY_RANK)).size).toBe(4);
  });
});

describe("status ladders mirror the authoritative sources and are not invented", () => {
  it("partner submissions have exactly the three DB-constrained states", () => {
    // migrations/0007_partner_submissions.sql:76-77
    expect([...DASHBOARD_SUBMISSION_STATUSES]).toEqual(["draft", "submitted_to_mintvault", "cancelled"]);
  });

  it("connector states match the final widened ladder, including the post-0009 states", () => {
    // migrations/0011_partner_connector_reconciliation.sql:23
    expect(DASHBOARD_CONNECTOR_STATES).toHaveLength(11);
    expect(DASHBOARD_CONNECTOR_STATES).toContain("ready_for_import");
    expect(DASHBOARD_CONNECTOR_STATES).toContain("reconciliation_required");
    // 'awaiting_validation' was migrated away in 0009 and must not reappear.
    expect(DASHBOARD_CONNECTOR_STATES).not.toContain("awaiting_validation");
  });

  it("every bottleneck state is a real connector state", () => {
    for (const s of BOTTLENECK_STATES) {
      expect(DASHBOARD_CONNECTOR_STATES).toContain(s);
    }
  });
});

describe("the unavailable-metric contract keeps 'no data' distinct from zero", () => {
  it("an available metric carries its value", () => {
    const m = metric(0);
    expect(m.available).toBe(true);
    expect(m.value).toBe(0);
  });

  it("an unavailable metric carries a reason and no value field", () => {
    const m = unavailable("NO_DATA_SOURCE", "nothing exists");
    expect(m.available).toBe(false);
    expect(m.reason).toBe("NO_DATA_SOURCE");
    expect(m.detail).toBe("nothing exists");
    expect("value" in m).toBe(false);
  });

  it("zero and unavailable are not interchangeable", () => {
    expect(metric(0)).not.toEqual(unavailable("NO_DATA_SOURCE", "x"));
  });
});
