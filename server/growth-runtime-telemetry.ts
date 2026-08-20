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

type RequestEvent = { at: number; durationMs: number; statusCode: number };
type OutcomeEvent = { at: number; outcome: ApplicationOutcome };

const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUEST_EVENTS = 20_000;
const MAX_OUTCOME_EVENTS = 4_000;
const requestEvents: RequestEvent[] = [];
let requestTruncatedAt: number | null = null;
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
  if (!path.startsWith("/api/")) return;
  requestEvents.push({
    at,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    statusCode: Number.isInteger(statusCode) ? statusCode : 0,
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

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
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
}
