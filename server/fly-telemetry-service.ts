import { createHash } from "node:crypto";
import { recordGrowthDependency } from "./growth-runtime-telemetry";
import type {
  CapacityThresholds,
  FleetTelemetry,
  HealthStatus,
  IntelligenceMetric,
  IntelligenceState,
} from "./growth-intelligence-service";
import type { FlyMachineSnapshot } from "./growth-infrastructure-intelligence";

const FLY_APP = "mintvault";
const FLY_ORGANISATION = "personal";
const EXPECTED_MACHINES = 2;
const MACHINES_URL = `https://api.machines.dev/v1/apps/${FLY_APP}/machines`;
const PROMETHEUS_URL = `https://api.fly.io/prometheus/${FLY_ORGANISATION}/api/v1/query`;
const CACHE_MS = 30_000;
const STALE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 7_000;

export const FLY_CAPACITY_THRESHOLDS: Readonly<CapacityThresholds> = Object.freeze({
  cpuWarningPercent: 70,
  cpuCriticalPercent: 90,
  memoryWarningPercent: 70,
  memoryCriticalPercent: 90,
  p95WarningMs: 500,
  p95CriticalMs: 1_500,
  fiveXWarningRate: 1,
  fiveXCriticalRate: 5,
  minimumErrorRateRequests: 20,
});

const QUERIES = {
  cpu:
    `100 * (1 - (sum by (instance, region) (rate(fly_instance_cpu{app="${FLY_APP}",mode="idle"}[5m])) / ` +
    `sum by (instance, region) (rate(fly_instance_cpu{app="${FLY_APP}",mode=~"user|nice|system|idle|iowait|irq|softirq|steal"}[5m]))))`,
  memory:
    `100 * (1 - (avg_over_time(fly_instance_memory_mem_available{app="${FLY_APP}"}[5m]) / ` +
    `avg_over_time(fly_instance_memory_mem_total{app="${FLY_APP}"}[5m])))`,
  requestRate: `60 * sum by (instance, region) (rate(fly_app_http_responses_count{app="${FLY_APP}"}[5m]))`,
  p95:
    `1000 * histogram_quantile(0.95, sum by (instance, region, le) ` +
    `(rate(fly_app_http_response_time_seconds_bucket{app="${FLY_APP}"}[5m])))`,
  requestCount: `sum by (instance, region) (increase(fly_app_http_responses_count{app="${FLY_APP}"}[5m]))`,
  fiveXCount: `sum by (instance, region) (increase(fly_app_http_responses_count{app="${FLY_APP}",status=~"5.."}[5m]))`,
} as const;

type FetchLike = typeof fetch;
type FlyState = "REAL" | "NOT_CONNECTED" | "ERROR" | "STALE";
type PrometheusVector = Map<string, { value: number; region: string | null }>;
type FlyMachineApi = {
  id?: unknown;
  state?: unknown;
  region?: unknown;
  image_ref?: unknown;
  updated_at?: unknown;
  checks?: unknown;
};

export type FlyTelemetrySnapshot = {
  state: FlyState;
  connection: IntelligenceMetric;
  overallStatus: HealthStatus;
  metrics: {
    cpu: IntelligenceMetric;
    memory: IntelligenceMetric;
    requestRate: IntelligenceMetric;
    p95Latency: IntelligenceMetric;
    fiveXErrorRate: IntelligenceMetric;
    machineHealth: IntelligenceMetric;
  };
  fleet: FleetTelemetry | null;
  machines: FlyMachineSnapshot[];
  lastUpdated: string;
};

type CacheEntry = {
  value: FlyTelemetrySnapshot;
  authority: string;
  expiresAt: number;
  staleUntil: number;
};

let cache: CacheEntry | null = null;
let inFlight: { authority: string; promise: Promise<FlyTelemetrySnapshot> } | null = null;

function metric(
  state: IntelligenceState,
  status: HealthStatus,
  source: string,
  now: string | null,
  value?: number | string,
  unit?: string,
  reason?: string
): IntelligenceMetric {
  return { state, status, source, lastUpdated: now, value, unit, reason };
}

function unavailable(state: Exclude<IntelligenceState, "REAL">, source: string, reason: string): IntelligenceMetric {
  return metric(
    state,
    state === "ERROR" ? "RED" : state === "STALE" ? "AMBER" : "UNKNOWN",
    source,
    null,
    undefined,
    undefined,
    reason
  );
}

function emptySnapshot(state: "NOT_CONNECTED" | "ERROR", now: string, reason: string): FlyTelemetrySnapshot {
  const source = "Fly read-only fleet telemetry";
  const missing = () =>
    metric(
      state,
      state === "ERROR" ? "RED" : "UNKNOWN",
      source,
      state === "ERROR" ? now : null,
      undefined,
      undefined,
      reason
    );
  return {
    state,
    connection: missing(),
    overallStatus: state === "ERROR" ? "RED" : "UNKNOWN",
    metrics: {
      cpu: missing(),
      memory: missing(),
      requestRate: missing(),
      p95Latency: missing(),
      fiveXErrorRate: missing(),
      machineHealth: missing(),
    },
    fleet: null,
    machines: [],
    lastUpdated: now,
  };
}

function safeToken(env: NodeJS.ProcessEnv): string | null {
  const token = env.FLY_TELEMETRY_TOKEN?.trim() ?? "";
  return token.length >= 32 && token.length <= 2_048 && !/\s/.test(token) ? token : null;
}

function authority(token: string): string {
  return createHash("sha256").update(`${FLY_ORGANISATION}:${FLY_APP}:${token}`).digest("hex");
}

async function getJson(url: string, token: string, fetcher: FetchLike): Promise<unknown> {
  const response = await fetcher(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `FlyV1 ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Fly read authority rejected the bounded request");
  return response.json();
}

function cleanMachineRef(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{14,32}$/.test(value) ? value : null;
}

function cleanRegion(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9-]{2,20}$/.test(value) ? value : "unknown";
}

function vector(body: unknown): PrometheusVector {
  const output: PrometheusVector = new Map();
  if (!body || typeof body !== "object") throw new Error("Fly telemetry response was invalid");
  const top = body as { status?: unknown; data?: unknown };
  if (top.status !== "success" || !top.data || typeof top.data !== "object") {
    throw new Error("Fly telemetry response was unsuccessful");
  }
  const result = (top.data as { result?: unknown }).result;
  if (!Array.isArray(result)) throw new Error("Fly telemetry vector was invalid");
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const row = item as { metric?: unknown; value?: unknown };
    if (!row.metric || typeof row.metric !== "object" || !Array.isArray(row.value)) continue;
    const labels = row.metric as { instance?: unknown; region?: unknown };
    const machineRef = cleanMachineRef(labels.instance);
    const value = Number(row.value[1]);
    if (!machineRef || !Number.isFinite(value) || value < 0) continue;
    output.set(machineRef, { value, region: cleanRegion(labels.region) });
  }
  return output;
}

function health(value: number, warning: number, critical: number): HealthStatus {
  return value >= critical ? "RED" : value >= warning ? "AMBER" : "GREEN";
}

function machineStatus(machine: FlyMachineApi): HealthStatus {
  if (machine.state !== "started") return "RED";
  if (!Array.isArray(machine.checks) || machine.checks.length === 0) return "UNKNOWN";
  const statuses = machine.checks.map((check) =>
    check && typeof check === "object" ? (check as { status?: unknown }).status : undefined
  );
  if (statuses.some((status) => status !== "passing")) return "RED";
  return "GREEN";
}

function imageVersion(value: unknown): string | null {
  const candidate =
    typeof value === "string"
      ? value.match(/:([A-Za-z0-9._-]{1,128})$/)?.[1]
      : value && typeof value === "object"
        ? (value as { tag?: unknown }).tag
        : null;
  return typeof candidate === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(candidate) ? candidate : null;
}

function shaMetric(env: NodeJS.ProcessEnv, now: string): IntelligenceMetric {
  const sha = env.GIT_SHA?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{40}$/.test(sha)
    ? metric("REAL", "GREEN", "Immutable MintVault build provenance", now, sha)
    : unavailable(
        "NOT_INSTRUMENTED",
        "Immutable MintVault build provenance",
        "The running image did not expose an exact 40-character Git SHA."
      );
}

function machineMetric(
  values: PrometheusVector,
  machineRef: string,
  now: string,
  source: string,
  unit: string,
  warning: number | null,
  critical: number | null
): IntelligenceMetric {
  const row = values.get(machineRef);
  if (!row)
    return unavailable("INSUFFICIENT_DATA", source, `No five-minute sample was returned for machine ${machineRef}.`);
  return metric(
    "REAL",
    warning == null || critical == null ? "UNKNOWN" : health(row.value, warning, critical),
    source,
    now,
    Number(row.value.toFixed(3)),
    unit,
    warning == null ? "Throughput is context only and never sets capacity state by itself." : undefined
  );
}

function staleMetric(value: IntelligenceMetric, now: string): IntelligenceMetric {
  return {
    ...value,
    state: "STALE",
    status: value.status === "RED" ? "RED" : "AMBER",
    reason: "The latest Fly refresh failed; this is the last successful value and is not used for a capacity decision.",
    lastUpdated: value.lastUpdated ?? now,
  };
}

function staleSnapshot(value: FlyTelemetrySnapshot, now: string): FlyTelemetrySnapshot {
  return {
    ...value,
    state: "STALE",
    connection: staleMetric(value.connection, now),
    overallStatus: value.overallStatus === "RED" ? "RED" : "AMBER",
    metrics: {
      cpu: staleMetric(value.metrics.cpu, now),
      memory: staleMetric(value.metrics.memory, now),
      requestRate: staleMetric(value.metrics.requestRate, now),
      p95Latency: staleMetric(value.metrics.p95Latency, now),
      fiveXErrorRate: staleMetric(value.metrics.fiveXErrorRate, now),
      machineHealth: staleMetric(value.metrics.machineHealth, now),
    },
    fleet: null,
    machines: value.machines.map((machine) => ({
      ...machine,
      status: machine.status === "RED" ? "RED" : "AMBER",
      cpu: staleMetric(machine.cpu, now),
      memory: staleMetric(machine.memory, now),
      requestRate: staleMetric(machine.requestRate, now),
      requestCount: staleMetric(machine.requestCount, now),
      p95Latency: staleMetric(machine.p95Latency, now),
      fiveXErrorRate: staleMetric(machine.fiveXErrorRate, now),
      deployedVersion: staleMetric(machine.deployedVersion, now),
      deployedSha: staleMetric(machine.deployedSha, now),
    })),
    lastUpdated: value.lastUpdated,
  };
}

async function readSnapshot(
  token: string,
  fetcher: FetchLike,
  env: NodeJS.ProcessEnv,
  now: string
): Promise<FlyTelemetrySnapshot> {
  const prometheusUrls = Object.values(QUERIES).map((query) => {
    const url = new URL(PROMETHEUS_URL);
    url.searchParams.set("query", query);
    return url.toString();
  });
  const [machinesBody, ...metricBodies] = await Promise.all([
    getJson(MACHINES_URL, token, fetcher),
    ...prometheusUrls.map((url) => getJson(url, token, fetcher)),
  ]);
  if (!Array.isArray(machinesBody)) throw new Error("Fly Machines response was invalid");
  const [cpu, memory, requestRate, p95, requestCount, fiveXCount] = metricBodies.map(vector);
  const machinesApi = machinesBody.filter((item): item is FlyMachineApi => Boolean(item && typeof item === "object"));
  const machines: FlyMachineSnapshot[] = [];
  for (const machine of machinesApi) {
    const machineRef = cleanMachineRef(machine.id);
    if (!machineRef) continue;
    const total = requestCount.get(machineRef)?.value;
    const errors = fiveXCount.get(machineRef)?.value ?? (total == null ? undefined : 0);
    const errorRate = total == null || errors == null ? null : total > 0 ? (errors / total) * 100 : 0;
    const version = imageVersion(machine.image_ref);
    const status = machineStatus(machine);
    const errorMetric =
      errorRate == null
        ? unavailable(
            "INSUFFICIENT_DATA",
            "Fly Managed Prometheus five-minute application responses",
            `No request-status sample was returned for machine ${machineRef}.`
          )
        : metric(
            "REAL",
            total! < FLY_CAPACITY_THRESHOLDS.minimumErrorRateRequests
              ? "UNKNOWN"
              : health(errorRate, FLY_CAPACITY_THRESHOLDS.fiveXWarningRate, FLY_CAPACITY_THRESHOLDS.fiveXCriticalRate),
            "Fly Managed Prometheus five-minute application responses",
            now,
            Number(errorRate.toFixed(3)),
            "% 5xx / requests",
            total! < FLY_CAPACITY_THRESHOLDS.minimumErrorRateRequests
              ? `Fewer than ${FLY_CAPACITY_THRESHOLDS.minimumErrorRateRequests} requests; the value is real but no health colour is assigned.`
              : undefined
          );
    machines.push({
      machineRef,
      status,
      region: cleanRegion(machine.region),
      cpu: machineMetric(cpu, machineRef, now, "Fly Managed Prometheus five-minute CPU utilisation", "%", 70, 90),
      memory: machineMetric(
        memory,
        machineRef,
        now,
        "Fly Managed Prometheus five-minute memory utilisation",
        "%",
        70,
        90
      ),
      requestRate: machineMetric(
        requestRate,
        machineRef,
        now,
        "Fly Managed Prometheus five-minute request rate",
        "requests/minute",
        null,
        null
      ),
      requestCount: machineMetric(
        requestCount,
        machineRef,
        now,
        "Fly Managed Prometheus five-minute completed responses",
        "requests / 5 minutes",
        null,
        null
      ),
      p95Latency: machineMetric(
        p95,
        machineRef,
        now,
        "Fly Managed Prometheus five-minute application latency",
        "ms p95",
        500,
        1_500
      ),
      fiveXErrorRate: errorMetric,
      deployedVersion: version
        ? metric("REAL", "GREEN", "Fly Machines API image reference", now, version)
        : unavailable(
            "INSUFFICIENT_DATA",
            "Fly Machines API image reference",
            "The deployed image did not contain a safe release tag."
          ),
      deployedSha: shaMetric(env, now),
    });
  }
  machines.sort((left, right) => left.machineRef.localeCompare(right.machineRef));
  const healthy = machines.filter((machine) => machine.status === "GREEN").length;

  const machineRefs = machines.map((machine) => machine.machineRef);
  const complete = (values: PrometheusVector) =>
    machineRefs.length >= EXPECTED_MACHINES && machineRefs.every((id) => values.has(id));
  const totalsComplete = complete(requestCount);
  const totalRequests = totalsComplete
    ? machineRefs.reduce((sum, id) => sum + (requestCount.get(id)?.value ?? 0), 0)
    : undefined;
  const totalErrors = totalsComplete
    ? machineRefs.reduce((sum, id) => sum + (fiveXCount.get(id)?.value ?? 0), 0)
    : undefined;
  const fleet: FleetTelemetry = {
    cpuPercent: complete(cpu) ? Math.max(...machineRefs.map((id) => cpu.get(id)!.value)) : undefined,
    memoryPercent: complete(memory) ? Math.max(...machineRefs.map((id) => memory.get(id)!.value)) : undefined,
    requestRatePerMinute: complete(requestRate)
      ? machineRefs.reduce((sum, id) => sum + requestRate.get(id)!.value, 0)
      : undefined,
    p95Ms: complete(p95) ? Math.max(...machineRefs.map((id) => p95.get(id)!.value)) : undefined,
    fiveXRate:
      totalRequests == null || totalErrors == null
        ? undefined
        : totalRequests > 0
          ? (totalErrors / totalRequests) * 100
          : 0,
    requestCount: totalRequests,
    healthyMachines: healthy,
    expectedMachines: EXPECTED_MACHINES,
  };

  const values = (
    key: keyof Pick<FleetTelemetry, "cpuPercent" | "memoryPercent" | "requestRatePerMinute" | "p95Ms" | "fiveXRate">
  ) => fleet[key];
  const fleetMetric = (
    key: keyof Pick<FleetTelemetry, "cpuPercent" | "memoryPercent" | "requestRatePerMinute" | "p95Ms" | "fiveXRate">,
    source: string,
    unit: string,
    warning: number | null,
    critical: number | null
  ): IntelligenceMetric => {
    const value = values(key);
    if (value == null)
      return unavailable(
        "INSUFFICIENT_DATA",
        source,
        "One or more expected machine samples were absent from the five-minute provider window."
      );
    const sampleTooSmall =
      key === "fiveXRate" && (totalRequests ?? 0) < FLY_CAPACITY_THRESHOLDS.minimumErrorRateRequests;
    return metric(
      "REAL",
      warning == null || critical == null || sampleTooSmall ? "UNKNOWN" : health(value, warning, critical),
      source,
      now,
      Number(value.toFixed(3)),
      unit,
      warning == null
        ? "Throughput is context only and never sets capacity state by itself."
        : sampleTooSmall
          ? `Fewer than ${FLY_CAPACITY_THRESHOLDS.minimumErrorRateRequests} requests; the value is real but no health colour is assigned.`
          : undefined
    );
  };
  const overallStatus: HealthStatus =
    machines.length < EXPECTED_MACHINES || machines.some((machine) => machine.status === "RED")
      ? "RED"
      : machines.some((machine) => machine.status === "UNKNOWN")
        ? "UNKNOWN"
        : "GREEN";
  const machineHealth = metric(
    "REAL",
    overallStatus,
    "Fly Machines API runtime state and health checks",
    now,
    `${healthy}/${EXPECTED_MACHINES} healthy`,
    "machines",
    machines.length < EXPECTED_MACHINES
      ? "The observed fleet is below the approved two-machine production floor."
      : undefined
  );
  return {
    state: "REAL",
    connection: metric(
      "REAL",
      "GREEN",
      `Fly read-only authority allowlisted to ${FLY_ORGANISATION}/${FLY_APP}`,
      now,
      `Connected · ${machines.length} machines`
    ),
    overallStatus,
    metrics: {
      cpu: fleetMetric("cpuPercent", "Fly Managed Prometheus five-minute fleet CPU", "% max machine", 70, 90),
      memory: fleetMetric("memoryPercent", "Fly Managed Prometheus five-minute fleet memory", "% max machine", 70, 90),
      requestRate: fleetMetric(
        "requestRatePerMinute",
        "Fly Managed Prometheus five-minute fleet request rate",
        "requests/minute",
        null,
        null
      ),
      p95Latency: fleetMetric(
        "p95Ms",
        "Fly Managed Prometheus five-minute fleet application latency",
        "ms p95 max machine",
        500,
        1_500
      ),
      fiveXErrorRate: fleetMetric(
        "fiveXRate",
        "Fly Managed Prometheus five-minute fleet application responses",
        "% 5xx / requests",
        1,
        5
      ),
      machineHealth,
    },
    fleet,
    machines,
    lastUpdated: now,
  };
}

export async function getFlyTelemetrySnapshot(
  options: { fetcher?: FetchLike; env?: NodeJS.ProcessEnv; now?: Date; force?: boolean } = {}
): Promise<FlyTelemetrySnapshot> {
  const env = options.env ?? process.env;
  const nowMs = options.now?.getTime() ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const token = safeToken(env);
  if (!token) {
    return emptySnapshot(
      "NOT_CONNECTED",
      now,
      "A dedicated server-side Fly read-only token is not configured; no provider values are inferred."
    );
  }
  const key = authority(token);
  if (!options.force && cache?.authority === key && cache.expiresAt > nowMs) return cache.value;
  if (!options.force && inFlight?.authority === key) return inFlight.promise;

  const operation = (async () => {
    const startedAt = Date.now();
    try {
      const value = await readSnapshot(token, options.fetcher ?? fetch, env, now);
      recordGrowthDependency("FLY_TELEMETRY", Date.now() - startedAt);
      cache = { value, authority: key, expiresAt: nowMs + CACHE_MS, staleUntil: nowMs + STALE_MS };
      return value;
    } catch {
      recordGrowthDependency("FLY_TELEMETRY", Date.now() - startedAt, true);
      if (cache?.authority === key && cache.staleUntil > nowMs) return staleSnapshot(cache.value, now);
      return emptySnapshot(
        "ERROR",
        now,
        "The bounded Fly read-only request failed or returned an invalid response; no provider value is inferred."
      );
    }
  })();
  if (!options.force) inFlight = { authority: key, promise: operation };
  try {
    return await operation;
  } finally {
    if (inFlight?.promise === operation) inFlight = null;
  }
}

export function resetFlyTelemetryCacheForTests(): void {
  cache = null;
  inFlight = null;
}
