import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  aiModelServiceMetric,
  deriveAttribution,
  deriveCampaigns,
  kpiValueClass,
  stageDropOff,
  summariseExperienceBand,
} from "../client/src/pages/admin/growth";

const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");

const metric = (value: number | string | undefined, status: "GREEN" | "AMBER" | "UNKNOWN" = "GREEN") => ({
  state: (value === undefined ? "NOT_INSTRUMENTED" : "REAL") as "NOT_INSTRUMENTED" | "REAL",
  status,
  ...(value === undefined ? {} : { value, unit: "count" }),
  source: "test",
  lastUpdated: null,
});

const route = (
  trafficClass: string,
  label: string,
  requestCount: number,
  p95LatencyMs: number | null,
  status: "GREEN" | "AMBER" | "RED" | "UNKNOWN",
  confidence: "SUFFICIENT" | "LOW_SAMPLE" | "INSUFFICIENT_DATA" = "SUFFICIENT"
) => ({ trafficClass, label, requestCount, p95LatencyMs, status, confidence });

describe("KPI values never truncate an operational state", () => {
  it("steps the font down instead of clipping the words an owner acts on", () => {
    // The live defects were "INSUFFICIENT TEL..." and "HEALTHY HEADRO...".
    expect(kpiValueClass("INSUFFICIENT TELEMETRY")).toContain("text-xs");
    expect(kpiValueClass("HEALTHY HEADROOM")).toContain("text-sm");
    expect(kpiValueClass("NOT CONNECTED")).toContain("text-sm");
    expect(kpiValueClass("HEADROOM")).toContain("text-lg");
    expect(kpiValueClass("46")).toContain("text-xl");
  });

  it("never assigns the largest tier to a word too wide for the narrowest cell", () => {
    // A seven-column strip at 1440px leaves ~127px of content width, which
    // "HEADROOM" exceeds at 24px — that is what split it into "HEADROO / M".
    expect(kpiValueClass("HEADROOM")).not.toContain("text-2xl");
  });

  it("uses no ellipsis utility on the KPI value", () => {
    expect(page).toContain("break-words font-semibold tracking-tight ${kpiValueClass(value)}");
    expect(page).not.toMatch(/truncate[^"]*text-xl font-semibold/);
  });
});

describe("customer experience is scored separately from this console", () => {
  const entries = [
    route("PUBLIC_CUSTOMER", "Public customer", 214, 64, "GREEN"),
    route("SUBMISSION_CHECKOUT", "Submission / checkout", 48, 128, "GREEN"),
    route("VERIFY_CERTIFICATE", "Verify / certificate", 96, 71, "GREEN"),
    route("SUPER_ADMIN", "Super Admin", 26, 318, "AMBER"),
    route("GROWTH_COMMAND", "Growth Command", 42, 2448, "RED"),
  ];

  it("keeps the customer band green while the internal console is red", () => {
    const customer = summariseExperienceBand(entries, ["PUBLIC_CUSTOMER", "SUBMISSION_CHECKOUT", "VERIFY_CERTIFICATE"]);
    const internal = summariseExperienceBand(entries, ["SUPER_ADMIN", "GROWTH_COMMAND", "HEALTH_INTERNAL"]);
    expect(customer.status).toBe("GREEN");
    expect(customer.worstP95LatencyMs).toBe(128);
    expect(internal.status).toBe("RED");
    expect(internal.worstP95LatencyMs).toBe(2448);
  });

  it("never lets an internal route class reach the customer band", () => {
    const customer = summariseExperienceBand(entries, ["PUBLIC_CUSTOMER", "SUBMISSION_CHECKOUT", "VERIFY_CERTIFICATE"]);
    expect(customer.contributors).not.toContain("Growth Command");
    expect(customer.contributors).not.toContain("Super Admin");
  });

  it("reports unknown rather than healthy when no class has a sufficient sample", () => {
    const quiet = [route("PUBLIC_CUSTOMER", "Public customer", 2, 40, "GREEN", "LOW_SAMPLE")];
    const band = summariseExperienceBand(quiet, ["PUBLIC_CUSTOMER"]);
    expect(band.status).toBe("UNKNOWN");
    expect(band.measured).toBe(false);
    expect(band.headline).toBe("INSUFFICIENT TELEMETRY");
  });

  it("reports unknown for an empty window instead of throwing", () => {
    expect(summariseExperienceBand([], ["PUBLIC_CUSTOMER"]).status).toBe("UNKNOWN");
  });
});

describe("acquisition and campaign figures are summed, never modelled", () => {
  const sources = [
    { category: "DIRECT", paidSubmissions: 5, paidCards: 19, revenuePence: 52300, partnerApplications: 2 },
    { category: "OUTREACH", paidSubmissions: 4, paidCards: 16, revenuePence: 41200, partnerApplications: 7 },
  ];

  it("computes coverage from measured rows and the unattributed count", () => {
    const result = deriveAttribution(sources, 1, null);
    expect(result.attributedPaidSubmissions).toBe(9);
    expect(result.attributedRevenuePence).toBe(93500);
    expect(result.coveragePercent).toBeCloseTo(90, 5);
    expect(result.bestSourceLabel).toBe("DIRECT");
  });

  it("does not divide by zero when nothing has been measured", () => {
    const empty = deriveAttribution([], 0, null);
    expect(empty.coveragePercent).toBe(0);
    expect(empty.bestSourceLabel).toBe("No measured source");
  });

  it("counts a campaign as active only where it produced a measured outcome", () => {
    const result = deriveCampaigns([
      { category: "OUTREACH", campaign: "used", paidSubmissions: 3, paidCards: 12, revenuePence: 31800, partnerApplications: 5 },
      { category: "OUTREACH", campaign: "unused", paidSubmissions: 0, paidCards: 0, revenuePence: 0, partnerApplications: 0 },
    ]);
    expect(result.activeCount).toBe(1);
    expect(result.bestLabel).toBe("used");
  });

  it("reports no measured campaign rather than an empty name", () => {
    expect(deriveCampaigns([]).bestLabel).toBe("No measured campaign");
  });
});

describe("funnel drop-off is only attributed between measured stages", () => {
  it("skips a pair where either stage is unmeasured", () => {
    const rows = stageDropOff([
      { key: "a", label: "Submission starts", metric: metric(18) },
      { key: "b", label: "Checkout starts", metric: metric(undefined) },
      { key: "c", label: "Paid", metric: metric(12) },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("reports the loss between two consecutive measured stages", () => {
    const rows = stageDropOff([
      { key: "a", label: "Submission starts", metric: metric(18) },
      { key: "b", label: "Checkout starts", metric: metric(15) },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(3);
    expect(rows[0]!.display).toContain("16.7%");
  });

  it("never reports a negative loss where a stage changes unit", () => {
    const rows = stageDropOff([
      { key: "paid", label: "Paid submissions", metric: metric(12) },
      { key: "cards", label: "Paid cards", metric: metric(46) },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("shows a multiplier rather than a percentage above one hundred", () => {
    expect(page).toContain('`×${((step.value as number) / previous.value).toFixed(1)}`');
  });
});

describe("AI and model health is never borrowed from another service", () => {
  const diagnostics = (classes: ReturnType<typeof route>[]) =>
    ({ trafficClasses: classes }) as unknown as Parameters<typeof aiModelServiceMetric>[0];

  it("reports not instrumented when the class was never exercised", () => {
    const result = aiModelServiceMetric(diagnostics([]), null);
    expect(result.state).toBe("NOT_INSTRUMENTED");
    expect(result.status).toBe("UNKNOWN");
  });

  it("does not colour a low sample as healthy", () => {
    const result = aiModelServiceMetric(diagnostics([route("AI_MODEL", "AI / model", 5, 880, "AMBER", "LOW_SAMPLE")]), null);
    expect(result.status).toBe("UNKNOWN");
    expect(result.state).toBe("INSUFFICIENT_DATA");
  });
});

describe("every tab shares one visual system", () => {
  it("gives all eight tabs the canonical KPI strip", () => {
    // Overview plus the seven tabs that were on the older generation.
    expect(page.match(/<GrowthKpiStrip/g) ?? []).toHaveLength(8);
  });

  it("keeps exactly one implementation of each shared primitive", () => {
    for (const component of [
      "GrowthKpiStrip",
      "GrowthEmptyState",
      "GrowthBarSeries",
      "GrowthFunnel",
      "RoutePerformanceTable",
      "StatusTile",
      "RadialRing",
      "DigitalMetric",
      "Sparkline",
    ]) {
      expect(page.match(new RegExp(`function ${component}\\(`, "g")) ?? [], component).toHaveLength(1);
    }
  });

  it("no longer ships the superseded card components", () => {
    for (const dead of ["function Gauge(", "function MetricCard(", "function Value("]) {
      expect(page).not.toContain(dead);
    }
  });

  it("presents route performance as a table with the operator's columns", () => {
    for (const column of ["Route class", "Requests", "P50", "P95", "Errors", "Status", "Trend"]) {
      expect(page).toContain(`>${column}<`);
    }
  });

  it("keeps request detail off the route surface", () => {
    // Labels come from the server's fixed safe templates; nothing derives a
    // route label from a URL, query string or identifier on the client.
    expect(page).not.toMatch(/location\.search|req\.query|searchParams\.get\("(?:email|id|cert)/);
  });
});
