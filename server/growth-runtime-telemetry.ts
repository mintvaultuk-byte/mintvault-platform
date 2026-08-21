/**
 * Privacy-minimised, process-local Growth telemetry.
 *
 * Only timestamps, durations, status classes and a fixed service enum are kept.
 * No URL, query string, request body, identity, address, provider id or error
 * message is retained. The one-hour ring is intentionally volatile: it is
 * useful evidence for the current application instance, not a fleet total or
 * durable analytics system.
 */

export type ApplicationService = "payments" | "email" | "partnerApi" | "scannerApi";
export type ApplicationOutcome = "SUCCESS" | "EXPECTED_REJECTION" | "PLATFORM_FAILURE";
export type GrowthTrafficClass =
  | "PUBLIC_CUSTOMER"
  | "SUBMISSION_CHECKOUT"
  | "VERIFY_CERTIFICATE"
  | "PARTNER"
  | "SCANNER"
  | "SUPER_ADMIN"
  | "GROWTH_COMMAND"
  | "AI_MODEL"
  | "HEALTH_INTERNAL"
  | "OTHER";
export type GrowthDependency =
  | "DATABASE"
  | "FLY_TELEMETRY"
  | "STRIPE"
  | "RESEND"
  | "R2"
  | "AI_MODEL"
  | "OTHER_EXTERNAL";

type RequestEvent = {
  at: number;
  durationMs: number;
  statusCode: number;
  routeGroup: string;
  trafficClass: GrowthTrafficClass;
  machineRef: string;
};
type OutcomeEvent = { at: number; outcome: ApplicationOutcome };
type DependencyEvent = { at: number; durationMs: number; failed: boolean };

const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUEST_EVENTS = 20_000;
const MAX_OUTCOME_EVENTS = 4_000;
const MAX_DEPENDENCY_EVENTS = 4_000;
export const MINIMUM_LATENCY_SAMPLE = 5;
export const MINIMUM_P99_SAMPLE = 20;
const requestEvents: RequestEvent[] = [];
let requestTruncatedAt: number | null = null;
const dependencyEvents = new Map<GrowthDependency, DependencyEvent[]>([
  ["DATABASE", []],
  ["FLY_TELEMETRY", []],
  ["STRIPE", []],
  ["RESEND", []],
  ["R2", []],
  ["AI_MODEL", []],
  ["OTHER_EXTERNAL", []],
]);
const dependencyTruncatedAt = new Map<GrowthDependency, number | null>(
  [...dependencyEvents.keys()].map((dependency) => [dependency, null])
);
const outcomeEvents = new Map<ApplicationService, OutcomeEvent[]>([
  ["payments", []],
  ["email", []],
  ["partnerApi", []],
  ["scannerApi", []],
]);
const outcomeTruncatedAt = new Map<ApplicationService, number | null>([
  ["payments", null],
  ["email", null],
  ["partnerApi", null],
  ["scannerApi", null],
]);

function trim<T extends { at: number }>(events: T[], now: number, max: number): boolean {
  const cutoff = now - WINDOW_MS;
  let firstCurrent = 0;
  while (firstCurrent < events.length && events[firstCurrent].at < cutoff) firstCurrent += 1;
  if (firstCurrent > 0) events.splice(0, firstCurrent);
  if (events.length > max) {
    events.splice(0, events.length - max);
    return true;
  }
  return false;
}

export function classifyGrowthService(path: string): ApplicationService | null {
  if (
    path === "/api/create-payment-intent" ||
    path === "/api/confirm-payment" ||
    path === "/api/stripe/webhook" ||
    path === "/api/tools/estimate/checkout" ||
    path === "/api/partner/credits/checkout"
  ) {
    return "payments";
  }
  if (path === "/api/partner-applications" || path.startsWith("/api/partner/")) return "partnerApi";
  if (
    path.includes("/scanner/") ||
    path.includes("/scanner-") ||
    path.includes("/scan-") ||
    path.endsWith("/scanner")
  ) {
    return "scannerApi";
  }
  return null;
}

/**
 * Maps a request to a fixed safe template before any telemetry is retained.
 * It intentionally never returns a raw path, identifier, query or customer URL.
 */
export function classifyGrowthRequest(path: string): { routeGroup: string; trafficClass: GrowthTrafficClass } | null {
  const pathname = path.split("?", 1)[0] ?? "";
  if (!pathname || pathname.includes("\\") || pathname.length > 2_048) return null;
  if (/\.(?:js|css|map|png|jpe?g|gif|svg|ico|woff2?|txt)$/i.test(pathname)) return null;
  if (pathname.startsWith("/api/super-admin/growth"))
    return { routeGroup: "SUPER_ADMIN_GROWTH", trafficClass: "GROWTH_COMMAND" };
  if (pathname.startsWith("/api/super-admin/")) return { routeGroup: "SUPER_ADMIN_API", trafficClass: "SUPER_ADMIN" };
  if (pathname.startsWith("/api/create-payment-intent") || pathname.startsWith("/api/confirm-payment")) {
    return { routeGroup: "CHECKOUT_API", trafficClass: "SUBMISSION_CHECKOUT" };
  }
  if (pathname.startsWith("/api/submissions") || pathname.startsWith("/api/grading/quote")) {
    return { routeGroup: "SUBMISSION_API", trafficClass: "SUBMISSION_CHECKOUT" };
  }
  if (pathname.startsWith("/api/cert") || pathname.startsWith("/api/verify")) {
    return { routeGroup: "VERIFY_CERTIFICATE_API", trafficClass: "VERIFY_CERTIFICATE" };
  }
  if (pathname.startsWith("/api/partner")) return { routeGroup: "PARTNER_API", trafficClass: "PARTNER" };
  if (pathname.includes("/scanner") || pathname.includes("/scan-"))
    return { routeGroup: "SCANNER_API", trafficClass: "SCANNER" };
  if (
    pathname.startsWith("/api/ai") ||
    pathname.startsWith("/api/vault-quest/ai") ||
    pathname.startsWith("/api/grading/ai") ||
    pathname.startsWith("/api/pre-grade") ||
    /^\/api\/admin\/certificates\/[^/]+\/(?:measure-centering|measure-defects|ai-grade|analyze)$/.test(pathname)
  ) {
    return { routeGroup: "AI_MODEL_API", trafficClass: "AI_MODEL" };
  }
  if (pathname === "/health" || pathname === "/api/health" || pathname === "/api/version") {
    return { routeGroup: "HEALTH_INTERNAL", trafficClass: "HEALTH_INTERNAL" };
  }
  if (pathname.startsWith("/api/")) return { routeGroup: "OTHER_API", trafficClass: "OTHER" };
  if (pathname === "/admin/growth") return { routeGroup: "GROWTH_COMMAND_PAGE", trafficClass: "GROWTH_COMMAND" };
  if (pathname.startsWith("/admin/")) return { routeGroup: "SUPER_ADMIN_PAGE", trafficClass: "SUPER_ADMIN" };
  if (pathname.startsWith("/")) return { routeGroup: "PUBLIC_WEB", trafficClass: "PUBLIC_CUSTOMER" };
  return null;
}

function currentMachineRef(): string {
  const value = process.env.FLY_MACHINE_ID?.trim() ?? "";
  return /^[a-f0-9]{14,32}$/i.test(value) ? value.toLowerCase() : "local";
}

export function recordApplicationOutcome(
  service: ApplicationService,
  outcome: ApplicationOutcome,
  at = Date.now()
): void {
  const events = outcomeEvents.get(service)!;
  events.push({ at, outcome });
  if (trim(events, at, MAX_OUTCOME_EVENTS)) outcomeTruncatedAt.set(service, at);
}

/** Called after a response finishes; it never participates in the response. */
export function recordGrowthRequest(path: string, statusCode: number, durationMs: number, at = Date.now()): void {
  const classification = classifyGrowthRequest(path);
  if (!classification) return;
  requestEvents.push({
    at,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    statusCode: Number.isInteger(statusCode) ? statusCode : 0,
    routeGroup: classification.routeGroup,
    trafficClass: classification.trafficClass,
    machineRef: currentMachineRef(),
  });
  if (trim(requestEvents, at, MAX_REQUEST_EVENTS)) requestTruncatedAt = at;

  const service = classifyGrowthService(path);
  if (!service) return;
  recordApplicationOutcome(
    service,
    statusCode >= 500 ? "PLATFORM_FAILURE" : statusCode >= 400 ? "EXPECTED_REJECTION" : "SUCCESS",
    at
  );
}

/** Records a fixed dependency class only; call sites never submit hostnames, IDs or payloads. */
export function recordGrowthDependency(
  dependency: GrowthDependency,
  durationMs: number,
  failed = false,
  at = Date.now()
): void {
  const events = dependencyEvents.get(dependency);
  if (!events) return;
  events.push({
    at,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    failed: Boolean(failed),
  });
  if (trim(events, at, MAX_DEPENDENCY_EVENTS)) dependencyTruncatedAt.set(dependency, at);
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
}

function percentile(values: number[], point: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * point) - 1)];
}

export type PerformanceAggregate = {
  key: string;
  label: string;
  trafficClass: GrowthTrafficClass;
  requestCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
  fiveXCount: number;
  errorRatePercent: number | null;
  trendP95LatencyMs: Array<number | null>;
  confidence: "INSUFFICIENT_DATA" | "LOW_SAMPLE" | "SUFFICIENT";
  status: "GREEN" | "AMBER" | "RED" | "UNKNOWN";
};

export type DependencyTimingAggregate = {
  dependency: GrowthDependency;
  sampleCount: number;
  p95LatencyMs: number | null;
  averageLatencyMs: number | null;
  failures: number;
  complete: boolean;
};

export type PerformanceDiagnostics = {
  scope: "CURRENT_APPLICATION_PROCESS";
  machineRef: string;
  window: "60m";
  minimumLatencySample: number;
  minimumP99Sample: number;
  trafficClasses: PerformanceAggregate[];
  topSlowRoutes: PerformanceAggregate[];
  dependencies: DependencyTimingAggregate[];
  lastUpdated: string | null;
  complete: boolean;
};

const TRAFFIC_LABELS: Record<GrowthTrafficClass, string> = {
  PUBLIC_CUSTOMER: "Public customer",
  SUBMISSION_CHECKOUT: "Submission / checkout",
  VERIFY_CERTIFICATE: "Verify / certificate",
  PARTNER: "Partner",
  SCANNER: "Scanner",
  SUPER_ADMIN: "Super Admin",
  GROWTH_COMMAND: "Growth Command",
  AI_MODEL: "AI / model",
  HEALTH_INTERNAL: "Health / internal",
  OTHER: "Other",
};

function aggregate(
  key: string,
  label: string,
  trafficClass: GrowthTrafficClass,
  events: RequestEvent[],
  now: number
): PerformanceAggregate {
  const durations = events.map((event) => event.durationMs);
  const requestCount = events.length;
  const fiveXCount = events.filter((event) => event.statusCode >= 500).length;
  const confidence =
    requestCount === 0 ? "INSUFFICIENT_DATA" : requestCount < MINIMUM_LATENCY_SAMPLE ? "LOW_SAMPLE" : "SUFFICIENT";
  const p95LatencyMs = percentile(durations, 0.95);
  const status =
    confidence !== "SUFFICIENT" || p95LatencyMs == null
      ? "UNKNOWN"
      : p95LatencyMs >= 1_500
        ? "RED"
        : p95LatencyMs >= 500
          ? "AMBER"
          : "GREEN";
  return {
    key,
    label,
    trafficClass,
    requestCount,
    p50LatencyMs: percentile(durations, 0.5),
    p95LatencyMs,
    p99LatencyMs: requestCount >= MINIMUM_P99_SAMPLE ? percentile(durations, 0.99) : null,
    averageLatencyMs: requestCount ? Math.round(durations.reduce((sum, value) => sum + value, 0) / requestCount) : null,
    maxLatencyMs: requestCount ? Math.max(...durations) : null,
    fiveXCount,
    errorRatePercent: requestCount ? Number(((fiveXCount / requestCount) * 100).toFixed(2)) : null,
    trendP95LatencyMs: Array.from({ length: 6 }, (_, index) => {
      const start = now - WINDOW_MS + index * 10 * 60 * 1000;
      const bucket = events.filter((event) => event.at >= start && event.at < start + 10 * 60 * 1000);
      return percentile(
        bucket.map((event) => event.durationMs),
        0.95
      );
    }),
    confidence,
    status,
  };
}

export function getPerformanceDiagnostics(now = Date.now()): PerformanceDiagnostics {
  trim(requestEvents, now, MAX_REQUEST_EVENTS);
  const events = requestEvents.filter((event) => event.at >= now - WINDOW_MS);
  const trafficClasses = (Object.keys(TRAFFIC_LABELS) as GrowthTrafficClass[]).map((trafficClass) =>
    aggregate(
      trafficClass,
      TRAFFIC_LABELS[trafficClass],
      trafficClass,
      events.filter((event) => event.trafficClass === trafficClass),
      now
    )
  );
  const topSlowRoutes = [...new Set(events.map((event) => event.routeGroup))]
    .map((routeGroup) => {
      const routeEvents = events.filter((event) => event.routeGroup === routeGroup);
      return aggregate(routeGroup, routeGroup.replaceAll("_", " "), routeEvents[0]!.trafficClass, routeEvents, now);
    })
    .sort(
      (left, right) => (right.p95LatencyMs ?? -1) - (left.p95LatencyMs ?? -1) || right.requestCount - left.requestCount
    )
    .slice(0, 5);
  const dependencies = [...dependencyEvents.entries()].map(([dependency, values]) => {
    trim(values, now, MAX_DEPENDENCY_EVENTS);
    const current = values.filter((event) => event.at >= now - WINDOW_MS);
    const durations = current.map((event) => event.durationMs);
    const truncatedAt = dependencyTruncatedAt.get(dependency) ?? null;
    return {
      dependency,
      sampleCount: current.length,
      p95LatencyMs: percentile(durations, 0.95),
      averageLatencyMs: current.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / current.length)
        : null,
      failures: current.filter((event) => event.failed).length,
      complete: truncatedAt == null || truncatedAt < now - WINDOW_MS,
    };
  });
  return {
    scope: "CURRENT_APPLICATION_PROCESS",
    machineRef: events[events.length - 1]?.machineRef ?? currentMachineRef(),
    window: "60m",
    minimumLatencySample: MINIMUM_LATENCY_SAMPLE,
    minimumP99Sample: MINIMUM_P99_SAMPLE,
    trafficClasses,
    topSlowRoutes,
    dependencies,
    lastUpdated: events.length ? new Date(events[events.length - 1]!.at).toISOString() : null,
    complete: requestTruncatedAt == null || requestTruncatedAt < now - WINDOW_MS,
  };
}

export type RuntimeRequestSnapshot = {
  scope: "CURRENT_APPLICATION_PROCESS";
  window: "60m";
  requestsLast5Minutes: number;
  requestsLastHour: number;
  requestsPerMinute: number;
  p95LatencyMs: number | null;
  fiveXCount: number;
  fiveXRatePercent: number | null;
  lastUpdated: string | null;
  complete: boolean;
};

export function getRuntimeRequestSnapshot(now = Date.now()): RuntimeRequestSnapshot {
  trim(requestEvents, now, MAX_REQUEST_EVENTS);
  const lastHour = requestEvents.filter((event) => event.at >= now - WINDOW_MS);
  const lastFive = lastHour.filter((event) => event.at >= now - 5 * 60 * 1000);
  const fiveXCount = lastHour.filter((event) => event.statusCode >= 500).length;
  return {
    scope: "CURRENT_APPLICATION_PROCESS",
    window: "60m",
    requestsLast5Minutes: lastFive.length,
    requestsLastHour: lastHour.length,
    requestsPerMinute: Number((lastFive.length / 5).toFixed(1)),
    p95LatencyMs: percentile95(lastHour.map((event) => event.durationMs)),
    fiveXCount,
    fiveXRatePercent: lastHour.length ? Number(((fiveXCount / lastHour.length) * 100).toFixed(2)) : null,
    lastUpdated: lastHour.length ? new Date(lastHour[lastHour.length - 1].at).toISOString() : null,
    complete: requestTruncatedAt == null || requestTruncatedAt < now - WINDOW_MS,
  };
}

export type ApplicationHealthSnapshot = {
  scope: "CURRENT_APPLICATION_PROCESS";
  window: "60m";
  status: "GREEN" | "AMBER" | "RED" | "UNKNOWN";
  successful: number;
  expectedRejections: number;
  platformFailures: number;
  classifiedAttempts: number;
  platformFailureRatePercent: number | null;
  lastUpdated: string | null;
  reason: string;
  complete: boolean;
};

export function getApplicationHealthSnapshot(service: ApplicationService, now = Date.now()): ApplicationHealthSnapshot {
  const events = outcomeEvents.get(service)!;
  trim(events, now, MAX_OUTCOME_EVENTS);
  const truncatedAt = outcomeTruncatedAt.get(service);
  const complete = truncatedAt == null || truncatedAt < now - WINDOW_MS;
  const successful = events.filter((event) => event.outcome === "SUCCESS").length;
  const expectedRejections = events.filter((event) => event.outcome === "EXPECTED_REJECTION").length;
  const platformFailures = events.filter((event) => event.outcome === "PLATFORM_FAILURE").length;
  const classifiedAttempts = successful + platformFailures;
  const platformFailureRatePercent = classifiedAttempts
    ? Number(((platformFailures / classifiedAttempts) * 100).toFixed(2))
    : null;

  let status: ApplicationHealthSnapshot["status"] = "UNKNOWN";
  let reason = "No successful or platform-failure outcome has been observed by this process in the last 60 minutes.";
  if (!complete) {
    reason = "The bounded outcome ring reached its safety cap during this window, so no health colour is assigned.";
  } else if (platformFailures > 0) {
    status =
      classifiedAttempts >= 5 && (platformFailures >= 3 || (platformFailureRatePercent ?? 0) >= 20) ? "RED" : "AMBER";
    reason = `${platformFailures} platform failure${platformFailures === 1 ? "" : "s"} in ${classifiedAttempts} classified application outcomes; expected 4xx/auth/customer rejections are excluded.`;
  } else if (successful >= 3) {
    status = "GREEN";
    reason = `${successful} successful application outcomes and no observed platform failures; expected 4xx/auth/customer rejections are excluded.`;
  } else if (successful > 0) {
    reason = `Only ${successful} successful application outcome${successful === 1 ? "" : "s"} observed; at least 3 are required for a green classification.`;
  }

  return {
    scope: "CURRENT_APPLICATION_PROCESS",
    window: "60m",
    status,
    successful,
    expectedRejections,
    platformFailures,
    classifiedAttempts,
    platformFailureRatePercent,
    lastUpdated: events.length ? new Date(events[events.length - 1].at).toISOString() : null,
    reason,
    complete,
  };
}

/** Test-only reset; there is no production route that mutates telemetry. */
export function clearGrowthRuntimeTelemetry(): void {
  requestEvents.splice(0);
  requestTruncatedAt = null;
  for (const events of outcomeEvents.values()) events.splice(0);
  for (const service of outcomeTruncatedAt.keys()) outcomeTruncatedAt.set(service, null);
  for (const events of dependencyEvents.values()) events.splice(0);
  for (const dependency of dependencyTruncatedAt.keys()) dependencyTruncatedAt.set(dependency, null);
}
