import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { formatGrowthMoneyGBP, formatProviderMoney } from "../client/src/pages/admin/growth";
import {
  buildInfrastructureIntelligence,
  deriveCampaignReadiness,
  deriveIncidentMode,
  deriveRevenueVelocity,
} from "../server/growth-infrastructure-intelligence";
import { deriveCapacityStatus, getLivePulse, type IntelligenceMetric } from "../server/growth-intelligence-service";

const dialect = new PgDialect();

const metric = (
  status: "GREEN" | "AMBER" | "RED" | "UNKNOWN",
  state: IntelligenceMetric["state"] = "REAL"
): IntelligenceMetric => ({
  state,
  status,
  value: status,
  source: "test authority",
  reason: status === "RED" ? "test red condition" : undefined,
  lastUpdated: "2026-08-19T12:00:00.000Z",
});

const greenCapacity = {
  status: "GREEN" as const,
  label: "HEALTHY_HEADROOM" as const,
  recommendation: "NO_ACTION_REQUIRED" as const,
  evidence: ["green"],
  thresholdModel: "test",
  automaticScalingEnabled: false as const,
};

describe("Growth infrastructure control and GBP truth", () => {
  it("formats every MintVault revenue value as canonical GBP", () => {
    expect(formatGrowthMoneyGBP(2_759_100)).toBe("£27,591.00");
    expect(formatGrowthMoneyGBP(0)).toBe("£0.00");
    expect(formatProviderMoney(123.45, "EUR")).toBe("€123.45");
    expect(formatProviderMoney(123.45, "not-a-currency")).toBeNull();
    const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(page).toContain('currency: "GBP"');
    expect(page).not.toMatch(/currency:\s*["'](?:USD|AUD)["']/);
    expect(page).not.toMatch(/\b(?:USD|AUD)\b/);
  });

  it("withholds tiny-sample revenue velocity and reports an exact verified rolling hour", () => {
    const now = "2026-08-19T12:00:00.000Z";
    const tiny = deriveRevenueVelocity({ paidSubmissions: 2, paidCards: 5, revenuePence: 3800 }, now);
    expect(tiny.paidSubmissionsPerHour.state).toBe("INSUFFICIENT_DATA");
    expect(tiny.revenuePencePerHour.value).toBeUndefined();

    const sufficient = deriveRevenueVelocity({ paidSubmissions: 3, paidCards: 8, revenuePence: 7600 }, now);
    expect(sufficient.paidSubmissionsPerHour).toMatchObject({ state: "REAL", value: 3 });
    expect(sufficient.paidCardsPerHour).toMatchObject({ state: "REAL", value: 8 });
    expect(sufficient.revenuePencePerHour).toMatchObject({ state: "REAL", value: 7600, unit: "GBP pence/hour" });
    expect(sufficient.comparison.state).toBe("NOT_INSTRUMENTED");
    expect(sufficient.definition).toContain("not a forecast");
  });

  it("binds rolling-hour revenue velocity to verified GBP paid authority", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const replies = [
      { rows: [{ submission_starts: 4, paid_submissions: 3, paid_cards: 8, revenue_pence: 7600 }] },
      { rows: [{ partner_applications: 1 }] },
      { rows: [{ checkout_starts: 3 }] },
    ];
    let index = 0;
    const pulse = await getLivePulse({
      execute: async (query) => {
        queries.push(dialect.sqlToQuery(query));
        return replies[index++];
      },
    });
    expect(queries[0].sql).toContain("payment_status = 'paid'");
    expect(queries[0].sql).toContain("payment_intent_id IS NOT NULL");
    expect(queries[0].sql).toContain("payment_timestamp IS NOT NULL");
    expect(queries[0].sql).toContain("payment_currency = 'GBP'");
    expect(queries[0].sql).toContain("INTERVAL '60 minutes'");
    expect(pulse.revenueVelocity.revenuePencePerHour).toMatchObject({ state: "REAL", value: 7600 });
  });

  it("derives deterministic green, amber, red and unknown campaign readiness", () => {
    const readiness = (overrides: Partial<Parameters<typeof deriveCampaignReadiness>[0]> = {}) =>
      deriveCampaignReadiness({
        site: metric("GREEN"),
        payments: metric("GREEN"),
        database: metric("GREEN"),
        fiveXErrorRate: metric("GREEN"),
        flyMachines: metric("GREEN"),
        capacity: greenCapacity,
        ...overrides,
      });
    expect(readiness()).toMatchObject({ status: "GREEN", label: "READY", advisoryOnly: true });
    expect(readiness({ fiveXErrorRate: metric("AMBER") })).toMatchObject({ status: "AMBER", label: "CAUTION" });
    expect(readiness({ database: metric("RED", "ERROR") })).toMatchObject({ status: "RED", label: "NOT_READY" });
    expect(readiness({ payments: metric("UNKNOWN", "NOT_INSTRUMENTED") })).toMatchObject({
      status: "UNKNOWN",
      label: "INSUFFICIENT_TELEMETRY",
    });
  });

  it("prioritises a red payment incident above other insights and revenue-path failures", () => {
    const incident = deriveIncidentMode({
      payments: metric("RED", "ERROR"),
      site: metric("RED", "ERROR"),
      database: metric("RED", "ERROR"),
      fiveXErrorRate: metric("RED", "ERROR"),
      flyMachines: metric("RED", "ERROR"),
      capacity: greenCapacity,
      partnerApi: metric("RED", "ERROR"),
    });
    expect(incident).toMatchObject({ status: "ACTIVE", severity: "RED", priorityKey: "PAYMENTS" });
    const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(page.indexOf("<IncidentBanner")).toBeLessThan(page.indexOf("<Insights"));
    expect(page).toContain('data-testid="growth-incident-mode"');
  });

  it("promotes a correlated red capacity state into Incident Mode", () => {
    const redCapacity = {
      ...greenCapacity,
      status: "RED" as const,
      label: "CAPACITY_OR_SERVICE_PRESSURE" as const,
      recommendation: "CONSIDER_ADDITIONAL_FLY_CAPACITY" as const,
      evidence: ["CPU and p95 latency are above approved sustained thresholds."],
    };
    expect(
      deriveIncidentMode({
        payments: metric("GREEN"),
        site: metric("GREEN"),
        database: metric("GREEN"),
        fiveXErrorRate: metric("GREEN"),
        flyMachines: metric("GREEN"),
        capacity: redCapacity,
        partnerApi: metric("GREEN"),
      })
    ).toMatchObject({ status: "ACTIVE", priorityKey: "CAPACITY" });
  });

  it("restores fleet redundancy before recommending a machine resize", () => {
    const degraded = deriveCapacityStatus(
      {
        cpuPercent: 20,
        memoryPercent: 95,
        p95Ms: 100,
        fiveXRate: 0,
        requestCount: 100,
        healthyMachines: 1,
        expectedMachines: 2,
      },
      {
        cpuWarningPercent: 70,
        cpuCriticalPercent: 90,
        memoryWarningPercent: 70,
        memoryCriticalPercent: 90,
        p95WarningMs: 500,
        p95CriticalMs: 1500,
        fiveXWarningRate: 1,
        fiveXCriticalRate: 5,
        minimumErrorRateRequests: 20,
      }
    );
    expect(degraded).toMatchObject({ status: "RED", recommendation: "RESTORE_EXPECTED_FLEET" });
  });

  it("renders radial gauges from server status without inventing a capacity percentage", () => {
    const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(page).toContain("conic-gradient");
    expect(page).toContain("aria-label={`${label}: ${metric.status}; ${text(metric)}`}");
    expect(page).not.toMatch(/capacity remaining/i);
  });

  it("keeps the URL authoritative for tabs and clears stale generated-link feedback", () => {
    const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(page).toContain("const searchLocation = useSearch()");
    expect(page).toContain("const tab = growthTabFromSearch(searchLocation)");
    expect(page).not.toContain("const [tab, setTab]");
    expect(page).toContain('setCopyState("idle")');
    expect(page).toContain("link.reset()");
  });

  it("keeps Fly, Neon, provider cost and budget intelligence truthful and recommendation-only", () => {
    const capacity = deriveCapacityStatus(null, null);
    const infrastructure = buildInfrastructureIntelligence(
      { database: metric("GREEN"), capacity },
      "2026-08-19T12:00:00.000Z"
    );
    expect(infrastructure.control).toMatchObject({
      currentMode: "MANUAL",
      currentAuthority: "MONITOR_DETECT_RECOMMEND",
      mutationEnabled: false,
      automaticScalingEnabled: false,
      futureModeAvailable: false,
    });
    expect(infrastructure.fly.connection.state).toBe("NOT_CONNECTED");
    expect(infrastructure.fly.machines).toEqual([]);
    expect(JSON.stringify(infrastructure)).not.toMatch(
      /(?:api[_-]?key|access[_-]?token|secret|credential|hostname|machineId)/i
    );
    expect(infrastructure.neon.availability.status).toBe("GREEN");
    expect(infrastructure.neon.connectionPressure.state).toBe("NOT_CONNECTED");
    expect(infrastructure.costs.providers).toHaveLength(4);
    expect(infrastructure.costs.providers.every((provider) => provider.amountMajor === undefined)).toBe(true);
    expect(infrastructure.costs.normalisedTotalGBP.state).toBe("NOT_CONNECTED");
    expect(infrastructure.budget).toMatchObject({
      state: "NOT_CONFIGURED",
      monthlyBudgetPence: null,
      automaticShutdownEnabled: false,
      automaticSpendEnabled: false,
    });
  });

  it("exposes no infrastructure control or MCP mutation surface", () => {
    const mcp = fs.readFileSync("server/routes/growth-mcp.ts", "utf8");
    const infrastructure = fs.readFileSync("server/growth-infrastructure-intelligence.ts", "utf8");
    const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(mcp).toContain("get_infrastructure_status");
    expect(mcp).toContain("readOnlyHint: true");
    expect(mcp).not.toMatch(/scale_machine|resize_machine|set_budget|enable_autoscal/i);
    expect(infrastructure).not.toMatch(/fetch\(|flyctl|neonctl|machines\/|compute\/.*(?:post|patch|delete)/i);
    expect(page).not.toMatch(/>\s*(?:Scale|Resize|Enable auto|Set budget)\s*</i);
  });
});
