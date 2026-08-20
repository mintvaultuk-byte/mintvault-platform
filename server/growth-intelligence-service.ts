/**
 * GB-04B Growth Intelligence — aggregate-only operational read boundary.
 *
 * This module deliberately does not create a telemetry firehose, use local
 * request logs as fleet metrics, or expose provider configuration.  The
 * current runtime has authoritative commercial/Partner data and a bounded
 * database readiness check. Fly, Neon-pressure and Search Console adapters
 * are deliberately represented as NOT_CONNECTED until a separately managed
 * server-side integration exists.
 */
import { sql, type SQL } from "drizzle-orm";
import { getSitemapEntries, isKnownPublicRoute } from "./seo-config";
import { getGrowthSummary, type GrowthPeriod, type GrowthSummary } from "./commercial-growth-service";
import { getConversionEventSummary, type GrowthConversionExecutor } from "./growth-conversion-service";
import { getCommercialScoreboard, type CommercialScoreboard } from "./growth-scoreboard-service";
import {
  buildInfrastructureIntelligence,
  deriveCampaignReadiness,
  deriveIncidentMode,
  deriveRevenueVelocity,
  type CampaignReadiness,
  type IncidentMode,
  type InfrastructureIntelligence,
  type RevenueVelocity,
} from "./growth-infrastructure-intelligence";

export type IntelligenceState = "REAL" | "NOT_CONNECTED" | "NOT_INSTRUMENTED" | "INSUFFICIENT_DATA" | "STALE" | "ERROR";
export type HealthStatus = "GREEN" | "AMBER" | "RED" | "UNKNOWN";

export type IntelligenceMetric = {
  state: IntelligenceState;
  status: HealthStatus;
  value?: number | string;
  unit?: string;
  source: string;
  reason?: string;
  lastUpdated: string | null;
};

export type CapacityThresholds = {
  cpuWarningPercent: number;
  cpuCriticalPercent: number;
  memoryWarningPercent: number;
  memoryCriticalPercent: number;
  p95WarningMs: number;
  p95CriticalMs: number;
  fiveXWarningRate: number;
  fiveXCriticalRate: number;
  minimumErrorRateRequests: number;
};

export type FleetTelemetry = {
  cpuPercent?: number;
  memoryPercent?: number;
  p95Ms?: number;
  fiveXRate?: number;
  requestRatePerMinute?: number;
  requestCount?: number;
  healthyMachines?: number;
  expectedMachines?: number;
  databasePressure?: HealthStatus;
};

export type CapacityStatus = {
  status: HealthStatus;
  label: "HEALTHY_HEADROOM" | "REDUCED_HEADROOM" | "CAPACITY_OR_SERVICE_PRESSURE" | "INSUFFICIENT_TELEMETRY";
  recommendation:
    | "NO_ACTION_REQUIRED"
    | "INVESTIGATE_APPLICATION_LATENCY"
    | "INVESTIGATE_DATABASE_PRESSURE"
    | "CONSIDER_ADDITIONAL_FLY_CAPACITY"
    | "CONSIDER_MORE_MEMORY"
    | "ERROR_RATE_ELEVATED_SCALING_MAY_NOT_HELP"
    | "TELEMETRY_INCOMPLETE";
  evidence: string[];
  thresholdModel: string;
  automaticScalingEnabled: false;
};

export type LivePulse = {
  window: "60m";
  submissionStarts: IntelligenceMetric;
  checkoutStarts: IntelligenceMetric;
  paidSubmissions: IntelligenceMetric;
  paidCards: IntelligenceMetric;
  revenuePence: IntelligenceMetric;
  partnerApplications: IntelligenceMetric;
  requestsPerMinute: IntelligenceMetric;
  requestsLastHour: IntelligenceMetric;
  revenueVelocity: RevenueVelocity;
  lastUpdated: string;
};

export type SiteHealth = {
  site: IntelligenceMetric;
  cpu: IntelligenceMetric;
  memory: IntelligenceMetric;
  requestRate: IntelligenceMetric;
  p95Latency: IntelligenceMetric;
  fiveXErrorRate: IntelligenceMetric;
  database: IntelligenceMetric;
  flyMachines: IntelligenceMetric;
  payments: IntelligenceMetric;
  email: IntelligenceMetric;
  partnerApi: IntelligenceMetric;
  scannerApi: IntelligenceMetric;
  lastUpdated: string;
};

export type SeoSummary = {
  searchConsole: IntelligenceMetric;
  impressions: IntelligenceMetric;
  clicks: IntelligenceMetric;
  ctr: IntelligenceMetric;
  averagePosition: IntelligenceMetric;
  topQueries: IntelligenceMetric;
  topPages: IntelligenceMetric;
  technical: {
    sitemap: IntelligenceMetric;
    robots: IntelligenceMetric;
    indexabilityPolicy: IntelligenceMetric;
  };
  lastUpdated: string;
};

export type ConversionStage = {
  key: "SUBMISSION_STARTS" | "CHECKOUT_STARTS" | "PAID_SUBMISSIONS" | "PAID_CARDS";
  label: string;
  metric: IntelligenceMetric;
};

export type ConversionSummary = {
  period: GrowthPeriod;
  stages: ConversionStage[];
  dropOff: IntelligenceMetric;
  comparison: IntelligenceMetric;
  definition: string;
  lastUpdated: string;
};

export type GrowthInsight = {
  id: string;
  priority: "CRITICAL" | "ACTION" | "OPPORTUNITY" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
  trace: { ruleId: string; window: string; inputs: Record<string, number | string>; result: string };
};

export type GrowthIntelligence = {
  period: GrowthPeriod;
  summary: GrowthSummary;
  partnerPipeline: GrowthSummary["partnerApplications"];
  livePulse: LivePulse;
  siteHealth: SiteHealth;
  capacity: CapacityStatus;
  infrastructure: InfrastructureIntelligence;
  campaignReadiness: CampaignReadiness;
  incident: IncidentMode;
  revenueVelocity: RevenueVelocity;
  seo: SeoSummary;
  conversion: ConversionSummary;
  scoreboard: CommercialScoreboard;
  insights: GrowthInsight[];
  freshness: "CURRENT" | "STALE";
  generatedAt: string;
  expiresAt: string;
};

/**
 * Preserve the timestamp from the last successful snapshot when a later
 * refresh fails. Cache expiry is a freshness boundary, not an update time.
 */
export function staleGrowthSnapshot<T extends { generatedAt: string; freshness: string; expiresAt: string }>(
  value: T,
  staleUntil: number
): Omit<T, "freshness" | "expiresAt"> & { freshness: "STALE"; expiresAt: string } {
  return { ...value, freshness: "STALE", expiresAt: new Date(staleUntil).toISOString() };
}

type QueryResult = { rows: unknown[] };
type QueryExecutor = { execute(query: SQL): Promise<QueryResult> };

const CACHE_TTL_MS = 30_000;
const STALE_TTL_MS = 5 * 60_000;
const snapshots = new Map<GrowthPeriod, { value: GrowthIntelligence; expiresAt: number; staleUntil: number }>();

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function real(
  value: number | string,
  unit: string | undefined,
  source: string,
  now: string,
  status: HealthStatus = "GREEN"
): IntelligenceMetric {
  return { state: "REAL", status, value, unit, source, lastUpdated: now };
}

function unavailable(
  state: Exclude<IntelligenceState, "REAL">,
  source: string,
  reason: string,
  now: string | null = null
): IntelligenceMetric {
  return { state, status: "UNKNOWN", source, reason, lastUpdated: now };
}

/**
 * Capacity thresholds are intentionally not defaulted in production. Their
 * values must come from an approved server-side Fly telemetry configuration,
 * because an arbitrary request count or provider-free CPU guess is not a
 * capacity signal. The pure model below is exercised by tests and is ready for
 * that adapter without exposing a browser-configurable threshold surface.
 */
export function deriveCapacityStatus(
  telemetry: FleetTelemetry | null,
  thresholds: CapacityThresholds | null
): CapacityStatus {
  const common = {
    thresholdModel:
      "Requires fleet-wide CPU, memory, p95, 5xx and machine-health telemetry with server-configured sustained-window thresholds. Request rate is contextual only.",
    automaticScalingEnabled: false as const,
  };
  if (
    !telemetry ||
    !thresholds ||
    telemetry.cpuPercent == null ||
    telemetry.memoryPercent == null ||
    telemetry.p95Ms == null ||
    telemetry.fiveXRate == null ||
    telemetry.healthyMachines == null ||
    telemetry.expectedMachines == null
  ) {
    return {
      ...common,
      status: "UNKNOWN",
      label: "INSUFFICIENT_TELEMETRY",
      recommendation: "TELEMETRY_INCOMPLETE",
      evidence: ["Fleet-wide Fly telemetry is not connected. Request rate alone never sets capacity state."],
    };
  }

  const errorsElevated =
    telemetry.requestCount != null &&
    telemetry.requestCount >= thresholds.minimumErrorRateRequests &&
    telemetry.fiveXRate >= thresholds.fiveXWarningRate;
  const errorsCritical =
    telemetry.requestCount != null &&
    telemetry.requestCount >= thresholds.minimumErrorRateRequests &&
    telemetry.fiveXRate >= thresholds.fiveXCriticalRate;
  const machinesDegraded = telemetry.healthyMachines < telemetry.expectedMachines;
  const cpuCritical = telemetry.cpuPercent >= thresholds.cpuCriticalPercent;
  const memoryCritical = telemetry.memoryPercent >= thresholds.memoryCriticalPercent;
  const latencyCritical = telemetry.p95Ms >= thresholds.p95CriticalMs;
  const cpuWarning = telemetry.cpuPercent >= thresholds.cpuWarningPercent;
  const memoryWarning = telemetry.memoryPercent >= thresholds.memoryWarningPercent;
  const latencyWarning = telemetry.p95Ms >= thresholds.p95WarningMs;

  if (errorsCritical) {
    return {
      ...common,
      status: "RED",
      label: "CAPACITY_OR_SERVICE_PRESSURE",
      recommendation: "ERROR_RATE_ELEVATED_SCALING_MAY_NOT_HELP",
      evidence: ["5xx rate is above the configured critical threshold with a sufficient request sample."],
    };
  }
  if (telemetry.databasePressure === "RED") {
    return {
      ...common,
      status: "RED",
      label: "CAPACITY_OR_SERVICE_PRESSURE",
      recommendation: "INVESTIGATE_DATABASE_PRESSURE",
      evidence: ["Authoritative database pressure telemetry is red."],
    };
  }
  if (machinesDegraded || (cpuCritical && latencyCritical) || (memoryCritical && latencyCritical)) {
    return {
      ...common,
      status: "RED",
      label: "CAPACITY_OR_SERVICE_PRESSURE",
      recommendation: memoryCritical ? "CONSIDER_MORE_MEMORY" : "CONSIDER_ADDITIONAL_FLY_CAPACITY",
      evidence: [
        ...(machinesDegraded ? ["Healthy Fly machines are below the expected fleet count."] : []),
        ...(cpuCritical ? ["CPU is above the configured critical threshold."] : []),
        ...(memoryCritical ? ["Memory is above the configured critical threshold."] : []),
        ...(latencyCritical ? ["p95 latency is above the configured critical threshold."] : []),
      ],
    };
  }
  if (latencyCritical && !cpuWarning && !memoryWarning) {
    return {
      ...common,
      status: "AMBER",
      label: "REDUCED_HEADROOM",
      recommendation: "INVESTIGATE_APPLICATION_LATENCY",
      evidence: ["p95 latency is elevated without correlated CPU or memory pressure."],
    };
  }
  if (errorsElevated || telemetry.databasePressure === "AMBER" || cpuWarning || memoryWarning || latencyWarning) {
    return {
      ...common,
      status: "AMBER",
      label: "REDUCED_HEADROOM",
      recommendation:
        telemetry.databasePressure === "AMBER" ? "INVESTIGATE_DATABASE_PRESSURE" : "INVESTIGATE_APPLICATION_LATENCY",
      evidence: [
        ...(errorsElevated ? ["5xx rate is above the configured warning threshold."] : []),
        ...(cpuWarning ? ["CPU is above the configured warning threshold."] : []),
        ...(memoryWarning ? ["Memory is above the configured warning threshold."] : []),
        ...(latencyWarning ? ["p95 latency is above the configured warning threshold."] : []),
      ],
    };
  }
  return {
    ...common,
    status: "GREEN",
    label: "HEALTHY_HEADROOM",
    recommendation: "NO_ACTION_REQUIRED",
    evidence: [
      "Fleet telemetry is within configured thresholds. Request rate is shown as context, not a capacity trigger.",
    ],
  };
}

/** Aggregate-only boundary for MCP/internal consumers; never enables scaling. */
export function getCapacityStatus(): CapacityStatus {
  return deriveCapacityStatus(null, null);
}

export async function getLivePulse(executor?: QueryExecutor): Promise<LivePulse> {
  const runner = executor ?? (await import("./db")).db;
  const now = new Date().toISOString();
  const result = await runner.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '60 minutes') AS submission_starts,
      COUNT(*) FILTER (WHERE payment_status = 'paid' AND deleted_at IS NULL AND payment_intent_id IS NOT NULL
        AND payment_timestamp IS NOT NULL AND payment_currency = 'GBP' AND payment_timestamp >= NOW() - INTERVAL '60 minutes') AS paid_submissions,
      COALESCE(SUM(card_count) FILTER (WHERE payment_status = 'paid' AND deleted_at IS NULL AND payment_intent_id IS NOT NULL
        AND payment_timestamp IS NOT NULL AND payment_currency = 'GBP' AND payment_timestamp >= NOW() - INTERVAL '60 minutes'), 0) AS paid_cards,
      COALESCE(SUM(ROUND(payment_amount * 100)) FILTER (WHERE payment_status = 'paid' AND deleted_at IS NULL
        AND payment_intent_id IS NOT NULL AND payment_timestamp IS NOT NULL AND payment_currency = 'GBP'
        AND payment_timestamp >= NOW() - INTERVAL '60 minutes'), 0) AS revenue_pence
    FROM submissions
  `);
  const partnerResult = await runner.execute(sql`
    SELECT COUNT(*) AS partner_applications FROM partner_applications
    WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '60 minutes'
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const partner = (partnerResult.rows[0] ?? {}) as Record<string, unknown>;
  let checkoutStarts = unavailable(
    "NOT_INSTRUMENTED",
    "MintVault growth_conversion_events",
    "The checkout-start event migration is not available in this environment."
  );
  try {
    const checkoutResult = await runner.execute(sql`
      SELECT COUNT(*)::int AS checkout_starts
      FROM growth_conversion_events
      WHERE event_kind = 'CHECKOUT_START' AND occurred_at >= NOW() - INTERVAL '60 minutes'
    `);
    checkoutStarts = real(
      numberValue((checkoutResult.rows[0] as Record<string, unknown> | undefined)?.checkout_starts),
      "server-created checkouts",
      "MintVault growth_conversion_events after Stripe PaymentIntent creation",
      now
    );
  } catch {
    // Mixed-version safety: an app node may start before migration 0101 is
    // applied. The dashboard remains truthful and checkout never depends on it.
  }
  const paidSubmissions = numberValue(row.paid_submissions);
  const paidCards = numberValue(row.paid_cards);
  const revenuePence = numberValue(row.revenue_pence);
  const revenueVelocity = deriveRevenueVelocity({ paidSubmissions, paidCards, revenuePence }, now);
  return {
    window: "60m",
    submissionStarts: real(
      numberValue(row.submission_starts),
      "submissions",
      "MintVault submissions.created_at (record creation)",
      now
    ),
    checkoutStarts,
    paidSubmissions: real(paidSubmissions, "paid submissions", "Verified Stripe payment_timestamp", now),
    paidCards: real(paidCards, "cards", "Verified Stripe payment_timestamp", now),
    revenuePence: real(revenuePence, "GBP pence", "Verified Stripe GBP payment_timestamp", now),
    partnerApplications: real(
      numberValue(partner.partner_applications),
      "applications",
      "MintVault partner_applications.created_at",
      now
    ),
    requestsPerMinute: unavailable(
      "NOT_CONNECTED",
      "Fly fleet telemetry",
      "Fleet-wide request telemetry is not connected; per-machine logs are not presented as site-wide requests."
    ),
    requestsLastHour: unavailable(
      "NOT_CONNECTED",
      "Fly fleet telemetry",
      "Fleet-wide request telemetry is not connected; per-machine logs are not presented as site-wide requests."
    ),
    revenueVelocity,
    lastUpdated: now,
  };
}

export async function getInfrastructureStatus(executor?: QueryExecutor): Promise<InfrastructureIntelligence> {
  const siteHealth = await getSiteHealth(executor);
  return buildInfrastructureIntelligence(
    { database: siteHealth.database, capacity: getCapacityStatus() },
    siteHealth.lastUpdated
  );
}

export async function getCampaignReadinessStatus(executor?: QueryExecutor): Promise<CampaignReadiness> {
  const siteHealth = await getSiteHealth(executor);
  return deriveCampaignReadiness({
    site: siteHealth.site,
    payments: siteHealth.payments,
    database: siteHealth.database,
    fiveXErrorRate: siteHealth.fiveXErrorRate,
    flyMachines: siteHealth.flyMachines,
    capacity: getCapacityStatus(),
  });
}

export async function getRevenueVelocity(executor?: QueryExecutor): Promise<RevenueVelocity> {
  return (await getLivePulse(executor)).revenueVelocity;
}

export async function getSiteHealth(executor?: QueryExecutor): Promise<SiteHealth> {
  const runner = executor ?? (await import("./db")).db;
  const now = new Date().toISOString();
  let database: IntelligenceMetric;
  let site: IntelligenceMetric;
  try {
    const result = await runner.execute(sql`SELECT 1 AS ok, to_regclass('public.certificates') AS certificates`);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const ready = Number(row.ok) === 1 && row.certificates != null;
    database = ready
      ? real("Available", undefined, "Server-side database readiness query", now)
      : {
          state: "ERROR",
          status: "RED",
          source: "Server-side database readiness query",
          reason: "Required schema readiness check did not pass.",
          lastUpdated: now,
        };
    site = ready
      ? real("Ready", undefined, "Server-side database and schema readiness", now)
      : {
          state: "ERROR",
          status: "RED",
          source: "Server-side database and schema readiness",
          reason: "The current service could not complete its readiness check.",
          lastUpdated: now,
        };
  } catch {
    database = {
      state: "ERROR",
      status: "RED",
      source: "Server-side database readiness query",
      reason: "Database readiness check failed.",
      lastUpdated: now,
    };
    site = {
      state: "ERROR",
      status: "RED",
      source: "Server-side database and schema readiness",
      reason: "The current service could not complete its readiness check.",
      lastUpdated: now,
    };
  }
  const fleetReason = "Fly fleet telemetry is not connected in the application runtime.";
  return {
    site,
    cpu: unavailable("NOT_CONNECTED", "Fly fleet telemetry", fleetReason),
    memory: unavailable("NOT_CONNECTED", "Fly fleet telemetry", fleetReason),
    requestRate: unavailable("NOT_CONNECTED", "Fly fleet telemetry", fleetReason),
    p95Latency: unavailable("NOT_CONNECTED", "Fly fleet telemetry", fleetReason),
    fiveXErrorRate: unavailable("NOT_CONNECTED", "Fly fleet telemetry", fleetReason),
    database,
    flyMachines: unavailable("NOT_CONNECTED", "Fly fleet telemetry", fleetReason),
    payments: unavailable(
      "NOT_INSTRUMENTED",
      "MintVault payment authority",
      "Payment infrastructure failure classification is not instrumented; customer declines are not treated as an incident."
    ),
    email: unavailable(
      "NOT_INSTRUMENTED",
      "MintVault email authority",
      "Email provider health aggregation is not instrumented."
    ),
    partnerApi: unavailable(
      "NOT_INSTRUMENTED",
      "MintVault Partner authority",
      "Partner API error aggregation is not instrumented."
    ),
    scannerApi: unavailable(
      "NOT_INSTRUMENTED",
      "MintVault scanner authority",
      "Scanner API error aggregation is not instrumented."
    ),
    lastUpdated: now,
  };
}

export function getSeoSummary(): SeoSummary {
  const now = new Date().toISOString();
  const sitemapEntries = getSitemapEntries();
  const technicalSource = "MintVault sitemap/robots and SSR route policy";
  const disconnected = (label: string) =>
    unavailable("NOT_CONNECTED", "Google Search Console", `${label} requires a server-side Search Console connection.`);
  return {
    searchConsole: unavailable(
      "NOT_CONNECTED",
      "Google Search Console",
      "Search Console is not connected. No search-performance figures are inferred from page views or requests."
    ),
    impressions: disconnected("Search impressions"),
    clicks: disconnected("Search clicks"),
    ctr: disconnected("CTR"),
    averagePosition: disconnected("Average position"),
    topQueries: disconnected("Top queries"),
    topPages: disconnected("Top landing pages"),
    technical: {
      sitemap: real(sitemapEntries.length, "configured URLs", technicalSource, now),
      robots: real("Configured", undefined, technicalSource, now),
      indexabilityPolicy:
        isKnownPublicRoute("/submit") && !isKnownPublicRoute("/not-a-real-mintvault-route")
          ? real("Configured", undefined, technicalSource, now)
          : {
              state: "ERROR",
              status: "RED",
              source: technicalSource,
              reason: "The configured public-route policy is inconsistent.",
              lastUpdated: now,
            },
    },
    lastUpdated: now,
  };
}

export async function getConversionSummary(
  period: GrowthPeriod,
  summary?: GrowthSummary,
  executor?: GrowthConversionExecutor
): Promise<ConversionSummary> {
  const growth = summary ?? (await getGrowthSummary(period));
  const now = new Date().toISOString();
  let events: Awaited<ReturnType<typeof getConversionEventSummary>> | null = null;
  try {
    events = await getConversionEventSummary(period, executor);
  } catch {
    // An unavailable additive event table must never take down paid reporting.
  }
  const submissionStarts = events
    ? real(events.submissionStarts, "persisted submission starts", "Server-observed growth_conversion_events", now)
    : unavailable(
        "NOT_INSTRUMENTED",
        "MintVault growth_conversion_events",
        "The submission-start event migration is not available in this environment."
      );
  const checkoutStarts = events
    ? real(
        events.checkoutStarts,
        "server-created checkouts",
        "Stripe PaymentIntent creation followed by growth_conversion_events",
        now
      )
    : unavailable(
        "NOT_INSTRUMENTED",
        "MintVault growth_conversion_events",
        "The checkout-start event migration is not available in this environment."
      );
  const dropOff = !events
    ? unavailable(
        "NOT_INSTRUMENTED",
        "MintVault conversion authority",
        "No authoritative checkout-start cohort is available."
      )
    : events.checkoutStarts === 0
      ? unavailable(
          "INSUFFICIENT_DATA",
          "MintVault checkout cohort",
          "No checkout starts occurred in this period, so checkout-to-paid drop-off is not calculated.",
          now
        )
      : real(
          Number((((events.checkoutStarts - events.checkoutCohortPaid) / events.checkoutStarts) * 100).toFixed(1)),
          "% checkout-to-paid drop-off",
          "Server-created checkout cohort joined to verified Stripe-paid submission authority",
          now,
          events.checkoutCohortPaid < events.checkoutStarts ? "AMBER" : "GREEN"
        );
  return {
    period,
    stages: [
      {
        key: "SUBMISSION_STARTS",
        label: "Submission starts",
        metric: submissionStarts,
      },
      {
        key: "CHECKOUT_STARTS",
        label: "Checkout starts",
        metric: checkoutStarts,
      },
      {
        key: "PAID_SUBMISSIONS",
        label: "Paid submissions",
        metric: real(growth.paid.paidSubmissions.value, "paid submissions", "Verified Stripe payment_timestamp", now),
      },
      {
        key: "PAID_CARDS",
        label: "Paid cards",
        metric: real(growth.paid.paidCards.value, "cards", "Verified Stripe payment_timestamp", now),
      },
    ],
    dropOff,
    comparison: unavailable(
      "NOT_INSTRUMENTED",
      "MintVault conversion authority",
      "Previous-period conversion comparison needs the same canonical funnel events."
    ),
    definition:
      "Submission start is a persisted server submission. Checkout start is recorded only after Stripe creates a PaymentIntent. Checkout drop-off follows that period's checkout cohort to current verified paid state. Paid headline stages remain verified Stripe payments in the selected calendar window.",
    lastUpdated: now,
  };
}

export function getPartnerPipeline(summary: GrowthSummary): GrowthSummary["partnerApplications"] {
  return summary.partnerApplications;
}

export function getGrowthInsights(input: {
  period: GrowthPeriod;
  summary: GrowthSummary;
  siteHealth: SiteHealth;
  capacity: CapacityStatus;
  seo: SeoSummary;
  conversion: ConversionSummary;
}): GrowthInsight[] {
  const insights: GrowthInsight[] = [];
  if (input.siteHealth.site.status === "RED") {
    insights.push({
      id: "site-readiness-failed",
      priority: "CRITICAL",
      title: "Service readiness needs attention",
      detail: "The server-side database/schema readiness check did not pass.",
      recommendation: "Investigate application and database availability before changing capacity.",
      trace: {
        ruleId: "SITE_READINESS_RED",
        window: "current",
        inputs: { siteStatus: input.siteHealth.site.status },
        result: "critical",
      },
    });
  } else if (input.siteHealth.site.status === "GREEN") {
    insights.push({
      id: "site-readiness-healthy",
      priority: "INFO",
      title: "Core readiness check passed",
      detail:
        "The current service can reach the required database and schema. This is not a claim about unconnected fleet telemetry.",
      recommendation: "No immediate action from this readiness check.",
      trace: {
        ruleId: "SITE_READINESS_GREEN",
        window: "current",
        inputs: { siteStatus: input.siteHealth.site.status },
        result: "healthy",
      },
    });
  }
  if (input.capacity.status === "UNKNOWN") {
    insights.push({
      id: "capacity-telemetry-incomplete",
      priority: "INFO",
      title: "Capacity telemetry is incomplete",
      detail:
        "Fleet CPU, memory, latency, 5xx and machine telemetry are not connected, so no scaling recommendation is inferred.",
      recommendation:
        "Connect a server-side Fly telemetry adapter before making capacity decisions from this dashboard.",
      trace: {
        ruleId: "CAPACITY_UNKNOWN",
        window: "current",
        inputs: { capacityStatus: input.capacity.status },
        result: "telemetry_incomplete",
      },
    });
  }
  if (input.seo.searchConsole.state === "NOT_CONNECTED") {
    insights.push({
      id: "search-console-not-connected",
      priority: "INFO",
      title: "Search Console is not connected",
      detail: "Search impressions, clicks, CTR and position are unavailable rather than zero.",
      recommendation:
        "Connect a verified Google Search Console property through a server-side credential in a separate approved follow-up.",
      trace: {
        ruleId: "SEO_NOT_CONNECTED",
        window: "current",
        inputs: { searchConsole: input.seo.searchConsole.state },
        result: "not_connected",
      },
    });
  }
  if (input.conversion.dropOff.state === "NOT_INSTRUMENTED") {
    insights.push({
      id: "conversion-not-instrumented",
      priority: "INFO",
      title: "Checkout conversion is not yet instrumented",
      detail: "Paid cards and revenue are authoritative, but checkout-start cohorts are not yet recorded.",
      recommendation: "Add a separately reviewed checkout-start event before using funnel loss percentages.",
      trace: {
        ruleId: "CONVERSION_NOT_INSTRUMENTED",
        window: input.period,
        inputs: { paidSubmissions: input.summary.paid.paidSubmissions.value },
        result: "not_instrumented",
      },
    });
  }
  const qualified = input.summary.partnerApplications.qualified.value;
  const newApplications = input.summary.partnerApplications.new.value;
  if (qualified > 0 || newApplications > 0) {
    insights.push({
      id: "partner-pipeline-action",
      priority: qualified > 0 ? "ACTION" : "OPPORTUNITY",
      title: qualified > 0 ? "Qualified Partner leads need review" : "New Partner applications need review",
      detail:
        qualified > 0
          ? `${qualified} qualified application${qualified === 1 ? " is" : "s are"} in the selected period.`
          : `${newApplications} new application${newApplications === 1 ? " is" : "s are"} awaiting classification.`,
      recommendation:
        qualified > 0
          ? "Review the lead and advance it to onboarding when operationally ready; handoff is available only from onboarding."
          : "Review and classify the application in the Partner pipeline.",
      trace: {
        ruleId: "PARTNER_PIPELINE_ACTION",
        window: input.period,
        inputs: { qualified, newApplications },
        result: qualified > 0 ? "qualified" : "new",
      },
    });
  }
  return insights.slice(0, 5);
}

export async function getGrowthIntelligence(
  period: GrowthPeriod,
  options: { force?: boolean } = {}
): Promise<GrowthIntelligence> {
  const now = Date.now();
  const cached = snapshots.get(period);
  if (!options.force && cached && cached.expiresAt > now) return cached.value;
  try {
    const summary = await getGrowthSummary(period);
    const [livePulse, siteHealth, conversion, scoreboard] = await Promise.all([
      getLivePulse(),
      getSiteHealth(),
      getConversionSummary(period, summary),
      getCommercialScoreboard(),
    ]);
    const seo = getSeoSummary();
    const capacity = deriveCapacityStatus(null, null);
    const generatedAt = new Date().toISOString();
    const infrastructure = buildInfrastructureIntelligence({ database: siteHealth.database, capacity }, generatedAt);
    const campaignReadiness = deriveCampaignReadiness({
      site: siteHealth.site,
      payments: siteHealth.payments,
      database: siteHealth.database,
      fiveXErrorRate: siteHealth.fiveXErrorRate,
      flyMachines: siteHealth.flyMachines,
      capacity,
    });
    const incident = deriveIncidentMode({
      site: siteHealth.site,
      payments: siteHealth.payments,
      database: siteHealth.database,
      fiveXErrorRate: siteHealth.fiveXErrorRate,
      flyMachines: siteHealth.flyMachines,
      capacity,
      partnerApi: siteHealth.partnerApi,
    });
    const value: GrowthIntelligence = {
      period,
      summary,
      partnerPipeline: getPartnerPipeline(summary),
      livePulse,
      siteHealth,
      capacity,
      infrastructure,
      campaignReadiness,
      incident,
      revenueVelocity: livePulse.revenueVelocity,
      seo,
      conversion,
      scoreboard,
      insights: getGrowthInsights({ period, summary, siteHealth, capacity, seo, conversion }),
      freshness: "CURRENT",
      generatedAt,
      expiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    };
    snapshots.set(period, { value, expiresAt: now + CACHE_TTL_MS, staleUntil: now + STALE_TTL_MS });
    return value;
  } catch (error) {
    if (cached && cached.staleUntil > now) {
      return staleGrowthSnapshot(cached.value, cached.staleUntil);
    }
    throw error;
  }
}

/** Test-only cache reset; production has no cache mutation route. */
export function clearGrowthIntelligenceCache(): void {
  snapshots.clear();
}
