import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveCapacityStatus,
  getConversionSummary,
  getGrowthInsights,
  getLivePulse,
  getSeoSummary,
  getSiteHealth,
  staleGrowthSnapshot,
  type CapacityThresholds,
} from "../server/growth-intelligence-service";
import type { GrowthSummary } from "../server/commercial-growth-service";
import { consumeManualGrowthRefresh, growthIntelligenceUrl } from "../client/src/pages/admin/growth";

const thresholds: CapacityThresholds = {
  cpuWarningPercent: 65,
  cpuCriticalPercent: 85,
  memoryWarningPercent: 75,
  memoryCriticalPercent: 90,
  p95WarningMs: 750,
  p95CriticalMs: 1500,
  fiveXWarningRate: 0.01,
  fiveXCriticalRate: 0.05,
  minimumErrorRateRequests: 100,
};

const summary: GrowthSummary = {
  period: "30d",
  timezone: "Europe/London",
  paid: {
    paidSubmissions: { state: "MEASURED", value: 2 },
    paidCards: { state: "MEASURED", value: 5 },
    revenuePence: { state: "MEASURED", value: 3800 },
    averageCardsPerPaidOrder: { state: "MEASURED", value: 2.5 },
    unattributedPaidSubmissions: { state: "MEASURED", value: 1 },
  },
  sourcePerformance: [],
  campaignPerformance: [],
  partnerApplications: {
    total: { state: "MEASURED", value: 3 },
    new: { state: "MEASURED", value: 1 },
    contacted: { state: "MEASURED", value: 1 },
    qualified: { state: "MEASURED", value: 1 },
    notAFit: { state: "MEASURED", value: 0 },
    onboarding: { state: "MEASURED", value: 0 },
  },
  activePartners: { state: "MEASURED", value: 0 },
  partnerCardsPerPartner: { state: "NOT_INSTRUMENTED", reason: "No link" },
  partnerRevenue: { state: "NOT_INSTRUMENTED", reason: "No link" },
  repeatCustomerRate: { state: "NOT_INSTRUMENTED", reason: "No link" },
  historical: { state: "NOT_INSTRUMENTED", reason: "No link" },
};

const unavailableConversionExecutor = {
  execute: async () => {
    throw new Error("growth conversion event authority unavailable");
  },
};

describe("GB-04B Growth intelligence authority", () => {
  it("never converts request rate alone into a capacity alert", () => {
    const result = deriveCapacityStatus({ requestRatePerMinute: 9999 }, thresholds);
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendation).toBe("TELEMETRY_INCOMPLETE");
  });

  it("uses correlated provider signals for green, amber and red capacity states", () => {
    expect(
      deriveCapacityStatus(
        {
          cpuPercent: 20,
          memoryPercent: 30,
          p95Ms: 100,
          fiveXRate: 0,
          requestCount: 1000,
          healthyMachines: 2,
          expectedMachines: 2,
        },
        thresholds
      )
    ).toMatchObject({ status: "GREEN", recommendation: "NO_ACTION_REQUIRED" });
    expect(
      deriveCapacityStatus(
        {
          cpuPercent: 70,
          memoryPercent: 30,
          p95Ms: 100,
          fiveXRate: 0,
          requestCount: 1000,
          healthyMachines: 2,
          expectedMachines: 2,
        },
        thresholds
      )
    ).toMatchObject({ status: "AMBER" });
    expect(
      deriveCapacityStatus(
        {
          cpuPercent: 90,
          memoryPercent: 30,
          p95Ms: 1700,
          fiveXRate: 0,
          requestCount: 1000,
          healthyMachines: 2,
          expectedMachines: 2,
        },
        thresholds
      )
    ).toMatchObject({ status: "RED", recommendation: "CONSIDER_ADDITIONAL_FLY_CAPACITY" });
    expect(
      deriveCapacityStatus(
        {
          cpuPercent: 20,
          memoryPercent: 30,
          p95Ms: 100,
          fiveXRate: 0.06,
          requestCount: 1000,
          healthyMachines: 2,
          expectedMachines: 2,
        },
        thresholds
      )
    ).toMatchObject({ status: "RED", recommendation: "ERROR_RATE_ELEVATED_SCALING_MAY_NOT_HELP" });
  });

  it("returns recent persisted activity and labels an empty process request window honestly", async () => {
    const replies = [
      { rows: [{ submission_starts: "4", paid_submissions: "2", paid_cards: "5", revenue_pence: "3800" }] },
      { rows: [{ partner_applications: "1" }] },
    ];
    let index = 0;
    const pulse = await getLivePulse({ execute: async () => replies[index++] });
    expect(pulse.submissionStarts).toMatchObject({ state: "REAL", value: 4 });
    expect(pulse.paidCards).toMatchObject({ state: "REAL", value: 5 });
    expect(pulse.revenuePence).toMatchObject({ state: "REAL", value: 3800, unit: "GBP pence" });
    expect(pulse.revenueVelocity.revenuePencePerHour.state).toBe("INSUFFICIENT_DATA");
    expect(pulse.checkoutStarts.state).toBe("NOT_INSTRUMENTED");
    expect(pulse.requestsPerMinute).toMatchObject({ state: "INSUFFICIENT_DATA", status: "UNKNOWN" });
    expect(JSON.stringify(pulse)).not.toMatch(/"(?:email|phone|address|ipAddress)"/i);
  });

  it("preserves the successful update time when a snapshot becomes stale", () => {
    const snapshot = {
      generatedAt: "2026-08-19T09:00:00.000Z",
      freshness: "CURRENT",
      expiresAt: "2026-08-19T09:00:30.000Z",
      metricLastUpdated: "2026-08-19T09:00:00.000Z",
    };
    const stale = staleGrowthSnapshot(snapshot, Date.parse("2026-08-19T09:05:00.000Z"));
    expect(stale).toMatchObject({
      freshness: "STALE",
      generatedAt: "2026-08-19T09:00:00.000Z",
      metricLastUpdated: "2026-08-19T09:00:00.000Z",
      expiresAt: "2026-08-19T09:05:00.000Z",
    });
  });

  it("uses the cache-bypass flag once for manual refresh, then returns to the normal cached URL", () => {
    const manualRefresh = { current: true };
    expect(growthIntelligenceUrl("30d", consumeManualGrowthRefresh(manualRefresh))).toContain("refresh=1");
    expect(growthIntelligenceUrl("30d", consumeManualGrowthRefresh(manualRefresh))).not.toContain("refresh=1");
  });

  it("keeps database availability separate from database pressure and provider metrics", async () => {
    const health = await getSiteHealth({ execute: async () => ({ rows: [{ ok: 1, certificates: "certificates" }] }) });
    expect(health.site).toMatchObject({ state: "REAL", status: "GREEN" });
    expect(health.database).toMatchObject({ state: "REAL", status: "GREEN" });
    expect(health.cpu).toMatchObject({ state: "NOT_CONNECTED", status: "UNKNOWN" });
    expect(health.payments.state).toBe("INSUFFICIENT_DATA");
  });

  it("shows Search Console as not connected and technical SEO only as MintVault-owned configuration", () => {
    const seo = getSeoSummary();
    expect(seo.searchConsole).toMatchObject({ state: "NOT_CONNECTED", status: "UNKNOWN" });
    expect(seo.impressions.state).toBe("NOT_CONNECTED");
    expect(seo.technical.sitemap).toMatchObject({ state: "REAL", status: "GREEN" });
    expect(seo.technical.sitemap.value).toBeGreaterThan(0);
  });

  it("does not calculate a checkout conversion percentage without an authoritative checkout event", async () => {
    const conversion = await getConversionSummary("30d", summary, unavailableConversionExecutor);
    expect(conversion.stages.find((stage) => stage.key === "CHECKOUT_STARTS")?.metric.state).toBe("NOT_INSTRUMENTED");
    expect(conversion.dropOff.state).toBe("NOT_INSTRUMENTED");
    expect(conversion.comparison.state).toBe("NOT_INSTRUMENTED");
  });

  it("generates traceable deterministic insights without a provider or AI claim", async () => {
    const health = await getSiteHealth({ execute: async () => ({ rows: [{ ok: 1, certificates: "certificates" }] }) });
    const seo = getSeoSummary();
    const conversion = await getConversionSummary("30d", summary, unavailableConversionExecutor);
    const capacity = deriveCapacityStatus(null, null);
    const insights = getGrowthInsights({ period: "30d", summary, siteHealth: health, capacity, seo, conversion });
    expect(insights.map((insight) => insight.trace.ruleId)).toEqual(
      expect.arrayContaining([
        "SITE_READINESS_GREEN",
        "CAPACITY_UNKNOWN",
        "SEO_NOT_CONNECTED",
        "CONVERSION_NOT_INSTRUMENTED",
        "PARTNER_PIPELINE_ACTION",
      ])
    );
    expect(JSON.stringify(insights)).not.toMatch(/llm|artificial intelligence|revenue is great/i);
    expect(insights.find((insight) => insight.id === "partner-pipeline-action")?.recommendation).toContain(
      "advance it to onboarding"
    );
  });

  it("keeps detailed health out of the public health response and routes intelligence through Super Admin", () => {
    const routes = fs.readFileSync("server/routes.ts", "utf8");
    const growthRoute = fs.readFileSync("server/routes/admin/commercial-growth.ts", "utf8");
    expect(routes).toContain('app.get("/api/health", publicHealthRateLimit');
    expect(routes).toContain('json({ status: "ok" })');
    expect(routes).not.toContain("uptime_ms");
    expect(routes).not.toContain('db: "failed"');
    expect(growthRoute).toContain('router.get("/intelligence"');
    expect(growthRoute).toContain("router.use(requireSuperAdmin, readLimit)");
    const growthPage = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(growthPage).toContain("Active Partners");
    expect(growthPage).toContain("Partner-originated cards");
    expect(growthPage).toContain("Demand band");
    expect(growthPage).toContain("Existing grading submissions");
  });
});
