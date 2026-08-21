/** GB-04B Super Admin Growth Command. All unavailable authority stays visible as unavailable. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { AdminButton, AdminShell, Badge, Panel, StatCard, adminButtonClass } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";

const BASE = "/api/super-admin/growth";
const PERIODS = ["today", "7d", "30d", "90d", "all"] as const;
const TABS = [
  ["overview", "Overview"],
  ["acquisition", "Acquisition"],
  ["partners", "Partners"],
  ["seo", "SEO & Traffic"],
  ["conversion", "Conversion"],
  ["reviews", "Reviews"],
  ["health", "Site Health"],
  ["campaigns", "Campaigns"],
] as const;
const LEAD_STATES = ["NEW", "CONTACTED", "QUALIFIED", "NOT_A_FIT", "ONBOARDING"] as const;
type Period = (typeof PERIODS)[number];
type Tab = (typeof TABS)[number][0];
type LeadState = (typeof LEAD_STATES)[number];
type Health = "GREEN" | "AMBER" | "RED" | "UNKNOWN";
type State = "REAL" | "NOT_CONNECTED" | "NOT_INSTRUMENTED" | "INSUFFICIENT_DATA" | "STALE" | "ERROR";
type Metric = {
  state: State;
  status: Health;
  value?: number | string;
  unit?: string;
  source: string;
  reason?: string;
  lastUpdated: string | null;
};
type InfrastructureMachine = {
  machineRef: string;
  status: Health;
  region: string;
  cpu: Metric;
  memory: Metric;
  requestRate: Metric;
  requestCount: Metric;
  p95Latency: Metric;
  fiveXErrorRate: Metric;
  deployedVersion: Metric;
  deployedSha: Metric;
};
type PerformanceAggregate = {
  key: string;
  label: string;
  trafficClass: string;
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
  status: Health;
};
type PerformanceDiagnostics = {
  scope: "CURRENT_APPLICATION_PROCESS";
  machineRef: string;
  window: "60m";
  minimumLatencySample: number;
  minimumP99Sample: number;
  trafficClasses: PerformanceAggregate[];
  topSlowRoutes: PerformanceAggregate[];
  dependencies: Array<{
    dependency: string;
    sampleCount: number;
    p95LatencyMs: number | null;
    averageLatencyMs: number | null;
    failures: number;
    complete: boolean;
  }>;
  lastUpdated: string | null;
  complete: boolean;
};
type RevenueVelocity = {
  window: "60m";
  minimumPaidSample: 3;
  paidSubmissionsPerHour: Metric;
  paidCardsPerHour: Metric;
  revenuePencePerHour: Metric;
  comparison: Metric;
  definition: string;
  lastUpdated: string;
};
type Count = { state: "MEASURED"; value: number };
type PartnerOperationalMetric = Count | { state: "NOT_INSTRUMENTED"; reason: string };
type Performance = {
  category: string;
  paidSubmissions: number;
  paidCards: number;
  revenuePence: number;
  partnerApplications: number;
};
type Campaign = Performance & { campaign: string };
type Summary = {
  period: Period;
  paid: {
    paidSubmissions: Count;
    paidCards: Count;
    revenuePence: Count;
    averageCardsPerPaidOrder: Count;
    unattributedPaidSubmissions: Count;
  };
  sourcePerformance: Performance[];
  campaignPerformance: Campaign[];
  partnerApplications: Record<"total" | "new" | "contacted" | "qualified" | "notAFit" | "onboarding", Count>;
  activePartners: PartnerOperationalMetric;
  partnerCardsPerPartner: PartnerOperationalMetric;
  partnerRevenue: PartnerOperationalMetric;
  repeatCustomerRate: PartnerOperationalMetric;
  historical: { state: "NOT_INSTRUMENTED"; reason: string };
};
type Lead = {
  id: string;
  businessName: string;
  city: string;
  postcode: string;
  businessType: string;
  webPresence: string | null;
  status: LeadState;
  source: string;
  campaign: string;
  createdAt: string;
};
type LeadDetail = Lead & {
  contactName: string;
  email: string;
  phone: string | null;
  interestReason: string;
  physicalRetail: boolean | null;
  categories: string[];
  demandBand: string | null;
  existingGradingSubmissions: string | null;
};
type LinkOptions = {
  targets: Array<{ value: "partner" | "collector"; label: string }>;
  sources: string[];
  mediums: string[];
  campaigns: string[];
  contents: string[];
};
type CommercialMetricKey =
  "PAID_CARDS" | "REVENUE_GBP" | "PARTNER_APPLICATIONS" | "QUALIFIED_PARTNERS" | "GENUINE_REVIEWS";
type CommercialScoreboard = {
  period: {
    kind: "MONTHLY";
    timezone: "Europe/London";
    start: string;
    end: string;
    progressPercent: number;
  };
  targetAuthority:
    | { state: "READY"; mutationAuthority: "SUPER_ADMIN_ONLY"; mcpMutationEnabled: false }
    | {
        state: "NOT_INSTRUMENTED";
        mutationAuthority: "SUPER_ADMIN_ONLY";
        mcpMutationEnabled: false;
        reason: string;
      };
  metrics: Array<{
    key: CommercialMetricKey;
    label: string;
    unit: "COUNT" | "GBP_PENCE";
    actual: { state: "REAL"; value: number } | { state: "NOT_INSTRUMENTED"; reason: string };
    target:
      | { state: "SET"; value: number; authority: "SUPER_ADMIN"; lastSetAt: string }
      | { state: "NOT_SET"; authority: "SUPER_ADMIN"; lastSetAt: string | null };
    status: "GREEN" | "AMBER" | "RED" | "GREY";
    statusLabel: "ON_TRACK" | "ATTENTION" | "MATERIALLY_BEHIND" | "NO_TARGET_SET" | "INSUFFICIENT_DATA";
    actualProgressPercent: number | null;
    expectedProgressPercent: number;
    paceRatio: number | null;
    explanation: string;
  }>;
  insights: Array<{
    id: string;
    kind: "ON_TRACK" | "ACTION";
    metric: CommercialMetricKey;
    message: string;
  }>;
  definition: string;
  lastUpdated: string;
};
type Intelligence = {
  period: Period;
  summary: Summary;
  partnerPipeline: Summary["partnerApplications"];
  livePulse: {
    submissionStarts: Metric;
    checkoutStarts: Metric;
    paidSubmissions: Metric;
    paidCards: Metric;
    revenuePence: Metric;
    partnerApplications: Metric;
    requestsPerMinute: Metric;
    requestsLastHour: Metric;
    revenueVelocity: RevenueVelocity;
    lastUpdated: string;
  };
  siteHealth: Record<
    | "site"
    | "cpu"
    | "memory"
    | "requestRate"
    | "p95Latency"
    | "fiveXErrorRate"
    | "database"
    | "databasePressure"
    | "databaseLatency"
    | "flyMachines"
    | "payments"
    | "email"
    | "partnerApi"
    | "scannerApi",
    Metric
  > & { lastUpdated: string };
  performanceDiagnostics: PerformanceDiagnostics;
  performanceInsight: { status: Health; title: string; detail: string; recommendation: string };
  capacity: {
    status: Health;
    label: string;
    recommendation: string;
    evidence: string[];
    thresholdModel: string;
    automaticScalingEnabled: false;
  };
  infrastructure: {
    overallStatus: Health;
    control: {
      currentMode: "MANUAL";
      currentAuthority: "MONITOR_DETECT_RECOMMEND";
      mutationEnabled: false;
      automaticScalingEnabled: false;
      futureMode: "GUARDED_AUTO_REQUIRES_SEPARATE_APPROVAL";
      futureModeAvailable: false;
      safetyBoundary: string;
    };
    fly: {
      connection: Metric;
      overallStatus: Health;
      machines: InfrastructureMachine[];
      expectedMachineFields: string[];
    };
    neon: {
      availability: Metric;
      connectionPressure: Metric;
      latency: Metric;
      compute: Metric;
      storage: Metric;
      pointInTimeRecovery: Metric;
      mutationEnabled: false;
    };
    costs: {
      period: "MONTH_TO_DATE";
      providers: Array<{
        provider: "Fly" | "Neon" | "R2" | "Resend";
        state: State;
        status: Health;
        period: "MONTH_TO_DATE";
        sourceCurrency: string | null;
        amountMajor?: number;
        reason?: string;
        lastUpdated: string | null;
      }>;
      trend: Metric;
      normalisedTotalGBP: Metric;
      costPerPaidCardGBP: Metric;
      costPerPaidOrderGBP: Metric;
      currencyPolicy: string;
    };
    budget: {
      state: "NOT_CONFIGURED";
      status: "UNKNOWN";
      monthlyBudgetPence: null;
      automaticShutdownEnabled: false;
      automaticSpendEnabled: false;
      reason: string;
    };
    lastUpdated: string;
  };
  campaignReadiness: {
    status: Health;
    label: "READY" | "CAUTION" | "NOT_READY" | "INSUFFICIENT_TELEMETRY";
    recommendation: string;
    evidence: string[];
    advisoryOnly: true;
    definition: string;
  };
  incident:
    | {
        status: "ACTIVE";
        severity: "RED";
        priorityKey: string;
        title: string;
        detail: string;
        recommendation: string;
      }
    | {
        status: "CLEAR";
        severity: null;
        priorityKey: null;
        title: string;
        detail: string;
        recommendation: string;
      };
  revenueVelocity: RevenueVelocity;
  seo: {
    searchConsole: Metric;
    impressions: Metric;
    clicks: Metric;
    ctr: Metric;
    averagePosition: Metric;
    trend: Metric;
    topQueries: Metric;
    topPages: Metric;
    technical: { sitemap: Metric; robots: Metric; indexabilityPolicy: Metric };
    lastUpdated: string;
  };
  conversion: {
    stages: Array<{ key: string; label: string; metric: Metric }>;
    submissionToCheckout: Metric;
    checkoutToPaid: Metric;
    submissionToPaid: Metric;
    cardsPerPaidOrder: Metric;
    dropOff: Metric;
    comparison: Metric;
    definition: string;
  };
  scoreboard: CommercialScoreboard;
  insights: Array<{
    id: string;
    priority: "CRITICAL" | "ACTION" | "OPPORTUNITY" | "INFO";
    title: string;
    detail: string;
    recommendation: string;
    trace: { ruleId: string; window: string; result: string };
  }>;
  freshness: "CURRENT" | "STALE";
  generatedAt: string;
};
type AdminSession = { authenticated: boolean; isSuperAdmin?: boolean };
type GrowthReviewSummary = {
  period: Period;
  configuration: { state: "READY" | "NOT_CONFIGURED" | "INVALID"; reason?: string };
  eligible: number;
  scheduled: number;
  sent: number;
  deliveryFailed: number;
  deliveryUncertain: number;
  suppressed: number;
  cancelled: number;
  clicked: number;
  publicReviews: { state: "NOT_CONNECTED"; reason: string };
  definition: string;
  lastUpdated: string;
};

export const formatGrowthMoneyGBP = (pence: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
export function parseGbpTargetToPence(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return undefined;
  const [wholeText, fractionText = ""] = trimmed.split(".");
  const whole = Number(wholeText);
  const fraction = Number(fractionText.padEnd(2, "0"));
  const pence = whole * 100 + fraction;
  return Number.isSafeInteger(pence) && pence > 0 && pence <= 1_000_000_000_000 ? pence : undefined;
}
export function parseCountTarget(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) && count > 0 && count <= 1_000_000_000_000 ? count : undefined;
}
export function formatProviderMoney(amountMajor: number, sourceCurrency: string): string | null {
  if (!Number.isFinite(amountMajor) || !/^[A-Z]{3}$/.test(sourceCurrency)) return null;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: sourceCurrency }).format(amountMajor);
  } catch {
    return null;
  }
}
const number = (value: number) => new Intl.NumberFormat("en-GB").format(value);
const date = (value: string | null) =>
  value && !Number.isNaN(new Date(value).getTime())
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "Not available";
function performanceMetric(item: PerformanceAggregate, lastUpdated: string | null): Metric {
  const p95 = item.p95LatencyMs;
  const confidence =
    item.confidence === "SUFFICIENT"
      ? `P50 ${item.p50LatencyMs ?? "—"}ms · average ${item.averageLatencyMs ?? "—"}ms · ${item.fiveXCount} 5xx`
      : item.confidence === "LOW_SAMPLE"
        ? `LOW SAMPLE: ${item.requestCount}/${5} requests; p95 is shown without a health colour.`
        : "INSUFFICIENT DATA: no completed request sample in this rolling window.";
  return {
    state: item.requestCount ? "REAL" : "INSUFFICIENT_DATA",
    status: item.status,
    value: p95 == null ? "INSUFFICIENT DATA" : `${p95} ms`,
    source: "Bounded machine-local route telemetry",
    reason: confidence,
    lastUpdated,
  };
}
const text = (metric: Metric) =>
  (metric.state === "REAL" || metric.state === "STALE") && metric.value !== undefined
    ? `${metric.value}${metric.unit ? ` ${metric.unit}` : ""}${metric.state === "STALE" ? " · STALE" : ""}`
    : metric.state.replaceAll("_", " ");
const tone = (status: Health) =>
  status === "GREEN"
    ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-100"
    : status === "AMBER"
      ? "border-amber-400/35 bg-amber-400/10 text-amber-100"
      : status === "RED"
        ? "border-red-400/45 bg-red-400/10 text-red-100"
        : "border-slate-400/30 bg-slate-400/10 text-slate-200";
const leadTone = (status: LeadState): "act" | "neu" | "prog" | "wait" | "red" =>
  status === "NEW"
    ? "neu"
    : status === "CONTACTED"
      ? "wait"
      : status === "QUALIFIED"
        ? "prog"
        : status === "ONBOARDING"
          ? "act"
          : "red";
export const growthTabFromSearch = (search: string): Tab => {
  const raw = new URLSearchParams(search).get("tab");
  return TABS.some(([key]) => key === raw) ? (raw as Tab) : "overview";
};

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
export async function copyTrackedLink(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* restricted clipboard context: use the explicit fallback below */
  }
  if (typeof document === "undefined") return false;
  const target = document.createElement("textarea");
  target.value = value;
  target.readOnly = true;
  target.style.position = "fixed";
  target.style.opacity = "0";
  document.body.appendChild(target);
  target.select();
  const copied = document.execCommand("copy");
  target.remove();
  return copied;
}
export function growthIntelligenceUrl(period: Period, force = false): string {
  return `${BASE}/intelligence?period=${period}${force ? "&refresh=1" : ""}`;
}
export function consumeManualGrowthRefresh(flag: { current: boolean }): boolean {
  const force = flag.current;
  flag.current = false;
  return force;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-7 text-sm text-[var(--admin-muted,#8a8a8a)]">{children}</p>;
}
function Retry({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="m-4 rounded border border-red-400/50 bg-red-400/10 p-3 text-sm">
      <p>{message}</p>
      <AdminButton size="sm" className="mt-2" onClick={retry}>
        <RefreshCw size={14} /> Retry
      </AdminButton>
    </div>
  );
}
function statusAccent(status: Health) {
  return status === "GREEN" ? "#34d399" : status === "AMBER" ? "#fbbf24" : status === "RED" ? "#f87171" : "#8a8a8a";
}
function Sparkline({ values, status }: { values: Array<number | null>; status: Health }) {
  const known = values.filter((value): value is number => typeof value === "number");
  if (known.length < 2)
    return <p className="mt-3 text-[10px] uppercase tracking-[0.14em] opacity-55">Trend collecting</p>;
  const max = Math.max(...known);
  const min = Math.min(...known);
  const points = values
    .map((value, index) => {
      if (value == null) return null;
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = max === min ? 50 : 88 - ((value - min) / (max - min)) * 72;
      return `${x},${y}`;
    })
    .filter((value): value is string => value !== null)
    .join(" ");
  return (
    <svg className="mt-3 h-8 w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Rolling p95 trend">
      <path
        d="M0 88 H100"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="3"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        fill="none"
        points={points}
        stroke={statusAccent(status)}
        strokeWidth="4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
function RadialRing({ label, metric }: { label: string; metric: Metric }) {
  const numeric = typeof metric.value === "number" ? Math.min(100, Math.max(0, metric.value)) : null;
  const accent = statusAccent(metric.status);
  const progress = numeric == null ? 0 : numeric * 3.6;
  return (
    <div
      className={`rounded-xl border p-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,.05)] ${tone(metric.status)}`}
      data-testid={`growth-gauge-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}
    >
      <div className="flex justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">{label}</p>
        <span className="text-[10px] font-semibold tracking-[0.12em]">{metric.status}</span>
      </div>
      <div
        className="relative mx-auto mt-4 grid h-24 w-24 place-items-center rounded-full"
        role="img"
        aria-label={`${label}: ${metric.status}; ${text(metric)}`}
        style={{ background: `conic-gradient(${accent} ${progress}deg, rgba(255,255,255,.08) ${progress}deg 360deg)` }}
      >
        <div className="grid h-[5.1rem] w-[5.1rem] place-items-center rounded-full bg-[var(--admin-panel,#151515)] px-2">
          <span className="text-sm font-semibold leading-tight">{text(metric)}</span>
        </div>
      </div>
      <p className="mt-2 text-xs opacity-80">{metric.reason ?? metric.source}</p>
      <p className="mt-2 text-[10px] uppercase opacity-60">Updated {date(metric.lastUpdated)}</p>
    </div>
  );
}
function DigitalMetric({
  label,
  metric,
  sampleCount,
  trend,
}: {
  label: string;
  metric: Metric;
  sampleCount?: number;
  trend?: Array<number | null>;
}) {
  return (
    <div className={`rounded-xl border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.05)] ${tone(metric.status)}`}>
      <div className="flex justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">{label}</p>
        <span className="text-[10px] font-semibold">{metric.status}</span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight">{text(metric)}</p>
      {typeof sampleCount === "number" && (
        <p className="mt-1 text-[10px] uppercase tracking-[0.12em] opacity-70">{sampleCount} requests</p>
      )}
      {trend && <Sparkline values={trend} status={metric.status} />}
      <p className="mt-2 text-xs opacity-80">{metric.reason ?? metric.source}</p>
      <p className="mt-2 text-[10px] uppercase opacity-60">Updated {date(metric.lastUpdated)}</p>
    </div>
  );
}
function StatusTile({ label, metric }: { label: string; metric: Metric }) {
  return (
    <div className={`rounded-xl border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.05)] ${tone(metric.status)}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">{label}</p>
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: statusAccent(metric.status) }}
          aria-hidden="true"
        />
      </div>
      <p className="mt-3 text-lg font-semibold">{text(metric)}</p>
      <p className="mt-2 text-xs opacity-80">{metric.reason ?? metric.source}</p>
      <p className="mt-2 text-[10px] uppercase opacity-60">
        {metric.status} · {date(metric.lastUpdated)}
      </p>
    </div>
  );
}
function Gauge({ label, metric }: { label: string; metric: Metric }) {
  if (label === "CPU" || label === "RAM" || label === "Capacity headroom")
    return <RadialRing label={label} metric={metric} />;
  if (label.includes("P95") || label.includes("Request") || label.includes("5XX"))
    return <DigitalMetric label={label} metric={metric} />;
  return <StatusTile label={label} metric={metric} />;
}
function MetricCard({ label, metric }: { label: string; metric: Metric }) {
  return (
    <div className="rounded border border-[var(--admin-line,#333)] p-3">
      <p className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}</p>
      <p className="mt-1 font-semibold">{text(metric)}</p>
      <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">{metric.reason ?? metric.source}</p>
    </div>
  );
}
function IncidentBanner({ incident }: { incident: Intelligence["incident"] }) {
  if (incident.status !== "ACTIVE") return null;
  return (
    <section
      role="alert"
      data-testid="growth-incident-mode"
      className="rounded border-2 border-red-400 bg-red-950/70 p-4 shadow-[0_0_24px_rgba(248,113,113,.18)]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="red">INCIDENT MODE · RED</Badge>
        <h2 className="text-lg font-semibold text-red-50">{incident.title}</h2>
      </div>
      <p className="mt-2 text-sm text-red-100">{incident.detail}</p>
      <p className="mt-2 text-xs font-medium uppercase text-red-200">{incident.recommendation}</p>
    </section>
  );
}

const commercialTargetInput = (metric: CommercialScoreboard["metrics"][number]): string => {
  if (metric.target.state !== "SET") return "";
  if (metric.unit === "COUNT") return String(metric.target.value);
  const whole = Math.floor(metric.target.value / 100);
  return `${whole}.${String(metric.target.value % 100).padStart(2, "0")}`;
};

function CommercialScoreboardPanel({
  scoreboard,
  selectedPeriod,
}: {
  scoreboard: CommercialScoreboard;
  selectedPeriod: Period;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<CommercialMetricKey, string>>({
    PAID_CARDS: "",
    REVENUE_GBP: "",
    PARTNER_APPLICATIONS: "",
    QUALIFIED_PARTNERS: "",
    GENUINE_REVIEWS: "",
  });
  const updateTargets = useMutation<
    { update: { changed: boolean; changedMetrics: CommercialMetricKey[] }; scoreboard: CommercialScoreboard },
    Error,
    Record<CommercialMetricKey, number | null>
  >({
    mutationFn: async (targets) => (await apiRequest("PUT", `${BASE}/scoreboard/targets`, targets)).json(),
    onSuccess: ({ scoreboard: next }) => {
      queryClient.setQueryData<Intelligence>([BASE, "intelligence", selectedPeriod], (current) =>
        current ? { ...current, scoreboard: next } : current
      );
      void queryClient.invalidateQueries({ queryKey: [BASE, "intelligence"] });
      setEditing(false);
      setError(null);
    },
  });
  const beginEdit = () => {
    setDraft(
      Object.fromEntries(scoreboard.metrics.map((metric) => [metric.key, commercialTargetInput(metric)])) as Record<
        CommercialMetricKey,
        string
      >
    );
    setError(null);
    setEditing(true);
  };
  const submit = () => {
    const payload = {} as Record<CommercialMetricKey, number | null>;
    for (const metric of scoreboard.metrics) {
      const value =
        metric.unit === "GBP_PENCE" ? parseGbpTargetToPence(draft[metric.key]) : parseCountTarget(draft[metric.key]);
      if (value === undefined) {
        setError(
          `${metric.label} must be a positive whole count${metric.unit === "GBP_PENCE" ? " or GBP amount with at most two decimal places" : ""}.`
        );
        return;
      }
      payload[metric.key] = value;
    }
    setError(null);
    updateTargets.mutate(payload);
  };
  const month = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: scoreboard.period.timezone,
  }).format(new Date(scoreboard.period.start));
  return (
    <Panel
      title="Commercial Growth Targets"
      sub={`${month} · ${scoreboard.period.progressPercent.toFixed(1)}% of calendar month elapsed · owner-authoritative targets`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--admin-line,#333)] p-4">
        <div>
          <p className="text-xs font-medium uppercase text-[var(--admin-gold-hi,#ecd585)]">Monthly scoreboard</p>
          <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">
            Target pace compares actual progress with elapsed month progress. MCP is read-only and cannot change
            targets.
          </p>
        </div>
        {scoreboard.targetAuthority.state === "READY" ? (
          <AdminButton
            size="sm"
            onClick={editing ? () => setEditing(false) : beginEdit}
            disabled={updateTargets.isPending}
          >
            {editing ? "Cancel" : "Edit targets"}
          </AdminButton>
        ) : (
          <Badge variant="wait">TARGET STORE NOT INSTRUMENTED</Badge>
        )}
      </div>
      {scoreboard.targetAuthority.state === "NOT_INSTRUMENTED" && (
        <p
          role="status"
          className="mx-4 mt-4 rounded border border-amber-400/35 bg-amber-400/10 p-3 text-sm text-amber-100"
        >
          {scoreboard.targetAuthority.reason}
        </p>
      )}
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="commercial-scoreboard">
        {scoreboard.metrics.map((metric) => (
          <article
            key={metric.key}
            className={`min-w-0 rounded border p-3 ${tone(metric.status === "GREY" ? "UNKNOWN" : metric.status)}`}
            data-testid={`commercial-score-${metric.key.toLowerCase().replaceAll("_", "-")}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium uppercase">{metric.label}</p>
              <span className="text-right text-[10px] font-semibold">{metric.statusLabel.replaceAll("_", " ")}</span>
            </div>
            <p className="mt-3 text-xl font-semibold">
              {metric.actual.state === "REAL"
                ? metric.unit === "GBP_PENCE"
                  ? formatGrowthMoneyGBP(metric.actual.value)
                  : number(metric.actual.value)
                : "NOT INSTRUMENTED"}
            </p>
            <p className="mt-1 text-xs opacity-80">
              Actual · target{" "}
              {metric.target.state === "SET"
                ? metric.unit === "GBP_PENCE"
                  ? formatGrowthMoneyGBP(metric.target.value)
                  : number(metric.target.value)
                : "not set"}
            </p>
            {editing ? (
              <label className="mt-3 block text-xs font-medium">
                {metric.unit === "GBP_PENCE" ? "Target (£)" : "Target"}
                <input
                  inputMode={metric.unit === "GBP_PENCE" ? "decimal" : "numeric"}
                  value={draft[metric.key]}
                  onChange={(event) => setDraft((current) => ({ ...current, [metric.key]: event.target.value }))}
                  placeholder="Blank clears"
                  className="mt-1 w-full rounded border border-current/30 bg-black/25 px-2 py-1.5 text-sm text-white"
                  aria-label={`${metric.label} monthly target`}
                />
              </label>
            ) : (
              <>
                <div className="mt-3 h-1.5 overflow-hidden rounded bg-black/30" aria-hidden="true">
                  <div
                    className="h-full bg-current"
                    style={{ width: `${Math.min(metric.actualProgressPercent ?? 0, 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs opacity-80">
                  {metric.actualProgressPercent == null
                    ? metric.explanation
                    : `${metric.actualProgressPercent.toFixed(1)}% actual · ${metric.expectedProgressPercent.toFixed(1)}% expected`}
                </p>
              </>
            )}
          </article>
        ))}
      </div>
      {editing && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--admin-line,#333)] p-4">
          <p className="text-xs text-[var(--admin-muted,#8a8a8a)]">
            Blank clears a target by adding a revision; prior revisions remain auditable. No target is inferred.
          </p>
          <AdminButton size="sm" onClick={submit} disabled={updateTargets.isPending}>
            {updateTargets.isPending ? "Saving…" : "Save monthly targets"}
          </AdminButton>
        </div>
      )}
      {(error || updateTargets.isError) && (
        <p role="alert" className="mx-4 mb-4 rounded border border-red-400/45 bg-red-400/10 p-3 text-sm text-red-100">
          {error ?? updateTargets.error?.message ?? "Commercial targets could not be saved."}
        </p>
      )}
      {scoreboard.insights.length > 0 && !editing && (
        <div className="border-t border-[var(--admin-line,#333)] p-4">
          <p className="text-xs font-medium uppercase text-[var(--admin-muted,#8a8a8a)]">Scoreboard insights</p>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {scoreboard.insights.map((insight) => (
              <li key={insight.id} className="rounded border border-[var(--admin-line,#333)] p-2 text-sm">
                <strong>{insight.kind === "ACTION" ? "Action" : "On track"}:</strong> {insight.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="border-t border-[var(--admin-line,#333)] px-4 py-3 text-xs text-[var(--admin-muted,#8a8a8a)]">
        {scoreboard.definition} Qualified Partners means applications currently in QUALIFIED or ONBOARDING that were
        received this month.
      </p>
    </Panel>
  );
}
function Value({ label, value }: { label: string; value: Count | undefined }) {
  return (
    <div>
      <p className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value ? number(value.value) : "…"}</p>
    </div>
  );
}
function PartnerValue({ label, value }: { label: string; value: PartnerOperationalMetric }) {
  return (
    <div>
      <p className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}</p>
      {value.state === "MEASURED" ? (
        <p className="mt-1 text-2xl font-semibold">{number(value.value)}</p>
      ) : (
        <>
          <p className="mt-1 text-sm font-semibold">Not yet instrumented</p>
          <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">{value.reason}</p>
        </>
      )}
    </div>
  );
}
function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium ${active ? "border-[var(--admin-gold,#d4af37)] bg-[rgba(212,175,55,.12)] text-[var(--admin-gold-hi,#ecd585)]" : "border-[var(--admin-line,#333)] text-[var(--admin-muted,#8a8a8a)]"}`}
    >
      {label}
    </button>
  );
}

type TrafficDistributionSegment = {
  key: string;
  label: string;
  requestCount: number;
  percent: number;
  color: string;
};

const TRAFFIC_CHART_COLORS = ["#d4af37", "#5aa7ff", "#9b7bff", "#51c78b", "#f08a5d", "#7dd3fc", "#f5d76e", "#94a3b8"];

/** Uses only completed, fixed-class telemetry; this is never a people or session chart. */
export function trafficDistributionSegments(
  entries: Array<Pick<PerformanceAggregate, "key" | "label" | "requestCount">>
): TrafficDistributionSegment[] {
  const measured = entries.filter((entry) => Number.isFinite(entry.requestCount) && entry.requestCount > 0);
  const total = measured.reduce((sum, entry) => sum + entry.requestCount, 0);
  if (!total) return [];
  return measured.map((entry, index) => ({
    key: entry.key,
    label: entry.label,
    requestCount: entry.requestCount,
    percent: (entry.requestCount / total) * 100,
    color: TRAFFIC_CHART_COLORS[index % TRAFFIC_CHART_COLORS.length]!,
  }));
}

function OverviewKpi({
  label,
  value,
  detail,
  status,
}: {
  label: string;
  value: string;
  detail: string;
  status: Health;
}) {
  return (
    <article className={`min-w-0 border-l-2 px-3 py-2 ${tone(status)}`}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.13em] opacity-75">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tracking-tight sm:text-2xl" title={value}>
        {value}
      </p>
      <p className="mt-1 truncate text-[10px] opacity-75" title={detail}>
        {detail}
      </p>
    </article>
  );
}

function CompactRing({ label, metric }: { label: string; metric: Metric }) {
  const numeric = typeof metric.value === "number" ? Math.max(0, Math.min(100, metric.value)) : 0;
  const accent = statusAccent(metric.status);
  return (
    <article
      className="rounded-lg border border-[var(--admin-line,#333)] bg-black/15 p-3"
      title={metric.reason ?? metric.source}
    >
      <div className="flex items-center gap-3">
        <div
          className="grid h-14 w-14 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(${accent} ${numeric * 3.6}deg, rgba(255,255,255,.12) 0deg)` }}
          role="img"
          aria-label={`${label}: ${text(metric)}; ${metric.status}`}
        >
          <div className="grid h-11 w-11 place-items-center rounded-full bg-[var(--admin-panel,#151515)] text-center text-[10px] font-semibold leading-tight">
            {text(metric)}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</p>
          <p className="mt-1 text-xs opacity-75">
            {metric.status} · {date(metric.lastUpdated)}
          </p>
        </div>
      </div>
    </article>
  );
}

function CompactDigital({ label, metric }: { label: string; metric: Metric }) {
  const value = text(metric);
  const compactValue = value.length > 14;
  return (
    <article
      className="rounded-lg border border-[var(--admin-line,#333)] bg-black/15 p-3"
      title={metric.reason ?? metric.source}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</p>
      <p
        className={`mt-2 break-words font-semibold tracking-tight ${compactValue ? "text-base leading-snug" : "text-2xl"}`}
      >
        {value}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em]" style={{ color: statusAccent(metric.status) }}>
        {metric.status} · {date(metric.lastUpdated)}
      </p>
    </article>
  );
}

function LatencyTrendChart({ diagnostics }: { diagnostics: PerformanceDiagnostics }) {
  const entries = diagnostics.trafficClasses
    .filter(
      (entry) => entry.trendP95LatencyMs.filter((value): value is number => typeof value === "number").length >= 2
    )
    .slice(0, 4);
  const values = entries.flatMap((entry) =>
    entry.trendP95LatencyMs.filter((value): value is number => typeof value === "number")
  );
  if (!entries.length || !values.length) {
    return <Empty>No authoritative multi-point p95 series has completed in this rolling 60-minute window.</Empty>;
  }
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  const points = (series: Array<number | null>) =>
    series
      .map((value, index) => {
        if (value == null) return null;
        const x = 4 + (index / Math.max(1, series.length - 1)) * 92;
        const y = maximum === minimum ? 48 : 88 - ((value - minimum) / (maximum - minimum)) * 76;
        return `${x},${y}`;
      })
      .filter((value): value is string => value !== null)
      .join(" ");
  return (
    <div className="p-3">
      <svg
        className="h-40 w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-label="Rolling 60-minute p95 latency by safe traffic class"
      >
        {[18, 38, 58, 78].map((y) => (
          <path
            key={y}
            d={`M4 ${y} H96`}
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeWidth=".65"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {entries.map((entry, index) => (
          <polyline
            key={entry.key}
            fill="none"
            points={points(entry.trendP95LatencyMs)}
            stroke={TRAFFIC_CHART_COLORS[index]!}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
        {entries.map((entry, index) => (
          <span key={entry.key} className="flex items-center gap-1">
            <i
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: TRAFFIC_CHART_COLORS[index] }}
              aria-hidden="true"
            />
            {entry.label} · {entry.requestCount} req · {entry.confidence.replaceAll("_", " ")}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
        Bounded current-process telemetry · six 10-minute buckets · updated {date(diagnostics.lastUpdated)}
      </p>
    </div>
  );
}

function TrafficDistribution({ diagnostics }: { diagnostics: PerformanceDiagnostics }) {
  const segments = trafficDistributionSegments(diagnostics.trafficClasses);
  if (!segments.length)
    return <Empty>No completed route telemetry is available in this rolling 60-minute window.</Empty>;
  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = cursor;
    cursor += segment.percent;
    return `${segment.color} ${start}% ${cursor}%`;
  });
  return (
    <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <div
        className="grid h-28 w-28 shrink-0 place-items-center rounded-full"
        style={{ background: `conic-gradient(${stops.join(",")})` }}
        role="img"
        aria-label="Traffic distribution by fixed safe route class"
      >
        <div className="grid h-20 w-20 place-items-center rounded-full bg-[var(--admin-panel,#151515)] text-center">
          <strong className="text-xl">{number(segments.reduce((sum, item) => sum + item.requestCount, 0))}</strong>
          <span className="text-[9px] uppercase tracking-[0.12em]">requests / 60m</span>
        </div>
      </div>
      <ul className="grid min-w-0 flex-1 gap-1 text-xs sm:grid-cols-2">
        {segments.map((segment) => (
          <li key={segment.key} className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              <i className="h-2 w-2 shrink-0 rounded-sm" style={{ background: segment.color }} aria-hidden="true" />
              <span className="truncate">{segment.label}</span>
            </span>
            <span className="shrink-0 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
              {number(segment.requestCount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EndpointDiagnostics({ diagnostics }: { diagnostics: PerformanceDiagnostics }) {
  return (
    <div className="overflow-x-auto">
      {diagnostics.topSlowRoutes.length ? (
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="border-y border-[var(--admin-line,#333)] uppercase tracking-[0.1em] text-[var(--admin-muted,#8a8a8a)]">
            <tr>
              <th className="px-3 py-2 font-medium">Endpoint group</th>
              <th className="px-3 py-2 font-medium">Requests</th>
              <th className="px-3 py-2 font-medium">P95</th>
              <th className="px-3 py-2 font-medium">5xx</th>
              <th className="px-3 py-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {diagnostics.topSlowRoutes.map((entry) => (
              <tr key={entry.key} className="border-b border-[var(--admin-line,#333)]">
                <td className="px-3 py-2 font-medium">{entry.label}</td>
                <td className="px-3 py-2">{number(entry.requestCount)}</td>
                <td className="px-3 py-2" style={{ color: statusAccent(entry.status) }}>
                  {entry.p95LatencyMs == null ? "—" : `${entry.p95LatencyMs} ms`}
                </td>
                <td className="px-3 py-2">{number(entry.fiveXCount)}</td>
                <td className="px-3 py-2">{entry.confidence.replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No safe route group has completed in this rolling window.</Empty>
      )}
    </div>
  );
}

function InfrastructureOverview({ data }: { data: Intelligence }) {
  const { infrastructure } = data;
  return (
    <div className="grid min-w-0 gap-3 p-3">
      <div className="min-w-0 rounded-lg border border-[var(--admin-line,#333)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--admin-line,#333)] px-3 py-2">
          <p className="text-xs font-semibold">Fly Machines ({infrastructure.fly.machines.length})</p>
          <span
            className="text-[10px] uppercase tracking-[0.1em]"
            style={{ color: statusAccent(infrastructure.fly.overallStatus) }}
          >
            {infrastructure.fly.overallStatus}
          </span>
        </div>
        {infrastructure.fly.machines.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[690px] text-left text-[10px]">
              <thead className="border-b border-[var(--admin-line,#333)] uppercase tracking-[0.1em] text-[var(--admin-muted,#8a8a8a)]">
                <tr>
                  <th className="px-3 py-2">Machine / region</th>
                  <th className="px-3 py-2">CPU</th>
                  <th className="px-3 py-2">RAM</th>
                  <th className="px-3 py-2">Req rate</th>
                  <th className="px-3 py-2">P95</th>
                  <th className="px-3 py-2">5xx</th>
                  <th className="px-3 py-2">Release</th>
                  <th className="px-3 py-2">Health</th>
                </tr>
              </thead>
              <tbody>
                {infrastructure.fly.machines.map((machine) => (
                  <tr key={machine.machineRef} className="border-b border-[var(--admin-line,#333)] last:border-0">
                    <td className="px-3 py-2 font-medium">
                      {machine.machineRef}
                      <span className="ml-1 opacity-60">{machine.region}</span>
                    </td>
                    <td className="px-3 py-2">{text(machine.cpu)}</td>
                    <td className="px-3 py-2">{text(machine.memory)}</td>
                    <td className="px-3 py-2">{text(machine.requestRate)}</td>
                    <td className="px-3 py-2">{text(machine.p95Latency)}</td>
                    <td className="px-3 py-2">{text(machine.fiveXErrorRate)}</td>
                    <td className="px-3 py-2">{text(machine.deployedVersion)}</td>
                    <td className="px-3 py-2 font-semibold" style={{ color: statusAccent(machine.status) }}>
                      {machine.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Fly telemetry is not connected; no machine data is inferred.</Empty>
        )}
      </div>
      <div className="min-w-0 rounded-lg border border-[var(--admin-line,#333)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--admin-line,#333)] px-3 py-2">
          <p className="text-xs font-semibold">Neon</p>
          <span
            className="text-[10px] uppercase tracking-[0.1em]"
            style={{ color: statusAccent(infrastructure.neon.availability.status) }}
          >
            {text(infrastructure.neon.availability)}
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--admin-line,#333)] sm:grid-cols-3">
          {[
            ["Connections", infrastructure.neon.connectionPressure],
            ["Latency", infrastructure.neon.latency],
            ["Compute", infrastructure.neon.compute],
            ["Storage", infrastructure.neon.storage],
            ["PITR", infrastructure.neon.pointInTimeRecovery],
          ].map(([label, metric]) => (
            <div key={label as string} className="p-2.5">
              <p className="text-[9px] uppercase tracking-[0.1em] opacity-65">{label as string}</p>
              <p className="mt-1 text-xs font-medium">{text(metric as Metric)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GrowthOverview({ data, summary, period }: { data: Intelligence; summary: Summary; period: Period }) {
  const release = data.infrastructure.fly.machines[0]?.deployedVersion;
  const healthScore = data.siteHealth.site;
  const activity = [
    ["Submission starts", data.livePulse.submissionStarts],
    ["Checkout starts", data.livePulse.checkoutStarts],
    ["Paid submissions", data.livePulse.paidSubmissions],
    ["Paid cards", data.livePulse.paidCards],
    ["Partner applications", data.livePulse.partnerApplications],
    ["Revenue / 60m", data.livePulse.revenuePence],
  ] as const;
  return (
    <section className="space-y-3" data-testid="growth-command-overview">
      <section className="rounded-xl border border-[var(--admin-line,#333)] bg-[linear-gradient(115deg,rgba(212,175,55,.10),transparent_30%)] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,.05)]">
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: statusAccent(data.freshness === "CURRENT" ? "GREEN" : "AMBER") }}
              aria-hidden="true"
            />
            <strong className="text-sm uppercase tracking-[0.12em]">
              {data.freshness === "CURRENT" ? "Live data" : "Stale snapshot"}
            </strong>
            <span className="text-[10px] text-[var(--admin-muted,#8a8a8a)]">Updated {date(data.generatedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.1em] text-[var(--admin-muted,#8a8a8a)]">
            <span>Auto refresh · 30 sec</span>
            <span>Release · {release ? text(release) : "not instrumented"}</span>
            <span>Role · Super Admin</span>
          </div>
        </div>
      </section>
      <section
        className="grid gap-px overflow-hidden rounded-xl border border-[var(--admin-line,#333)] bg-[var(--admin-line,#333)] sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7"
        aria-label="Growth Command key signals"
      >
        <OverviewKpi
          label="Requests / min"
          value={text(data.livePulse.requestsPerMinute)}
          detail="Current process telemetry"
          status={data.livePulse.requestsPerMinute.status}
        />
        <OverviewKpi
          label="Revenue"
          value={formatGrowthMoneyGBP(summary.paid.revenuePence.value)}
          detail={`${period === "today" ? "Today" : `Selected period · ${period}`}`}
          status="GREEN"
        />
        <OverviewKpi
          label="Paid cards"
          value={number(summary.paid.paidCards.value)}
          detail="Stripe-verified"
          status="GREEN"
        />
        <OverviewKpi
          label="Qualified leads"
          value={number(summary.partnerApplications.qualified.value)}
          detail="No automatic provisioning"
          status="GREEN"
        />
        <OverviewKpi
          label="Campaign readiness"
          value={data.campaignReadiness.label.replaceAll("_", " ")}
          detail="Advisory only"
          status={data.campaignReadiness.status}
        />
        <OverviewKpi
          label="Capacity"
          value={data.capacity.label.replaceAll("_", " ")}
          detail="Manual owner decision"
          status={data.capacity.status}
        />
        <OverviewKpi
          label="System status"
          value={text(healthScore)}
          detail={healthScore.source}
          status={healthScore.status}
        />
      </section>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <Panel
          title="System health overview"
          sub="Current value, status and evidence timing. Unknown is not healthy."
          bodyClassName="p-3"
        >
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <CompactRing label="CPU" metric={data.siteHealth.cpu} />
            <CompactRing label="RAM" metric={data.siteHealth.memory} />
            <CompactDigital label="P95 latency" metric={data.siteHealth.p95Latency} />
            <CompactDigital label="5xx error rate" metric={data.siteHealth.fiveXErrorRate} />
            <CompactDigital label="Request rate" metric={data.siteHealth.requestRate} />
            <CompactDigital label="DB pressure" metric={data.siteHealth.databasePressure} />
          </div>
        </Panel>
        <Panel
          title="Infrastructure overview"
          sub="Read-only provider telemetry; no controls mutate infrastructure."
          bodyClassName=""
        >
          <InfrastructureOverview data={data} />
        </Panel>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="Traffic overview"
          sub="Completed fixed route classes · current process · 60 minutes"
          bodyClassName=""
        >
          <TrafficDistribution diagnostics={data.performanceDiagnostics} />
        </Panel>
        <Panel title="Latency trend" sub="Real p95 only; no historical series is invented." bodyClassName="">
          <LatencyTrendChart diagnostics={data.performanceDiagnostics} />
        </Panel>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)_minmax(0,.85fr)]">
        <Panel title="Top endpoints" sub="Safe fixed route groups only" bodyClassName="">
          <EndpointDiagnostics diagnostics={data.performanceDiagnostics} />
        </Panel>
        <Panel
          title="Search Console"
          sub="External search authority remains distinct from request telemetry."
          bodyClassName="p-3"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <CompactDigital label="Connection" metric={data.seo.searchConsole} />
            <CompactDigital label="Impressions" metric={data.seo.impressions} />
            <CompactDigital label="Clicks" metric={data.seo.clicks} />
            <CompactDigital label="CTR" metric={data.seo.ctr} />
          </div>
        </Panel>
        <Panel
          title="Alerts & signals"
          sub="Deterministic server rules only."
          bodyClassName="divide-y divide-[var(--admin-line,#333)]"
        >
          {data.insights.slice(0, 3).map((insight) => (
            <article key={insight.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-xs">{insight.title}</strong>
                <Badge
                  variant={
                    insight.priority === "CRITICAL"
                      ? "red"
                      : insight.priority === "ACTION"
                        ? "act"
                        : insight.priority === "OPPORTUNITY"
                          ? "prog"
                          : "neu"
                  }
                >
                  {insight.priority}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-[var(--admin-muted,#8a8a8a)]">{insight.detail}</p>
            </article>
          ))}
          {data.insights.length === 0 && <Empty>Insufficient measured activity for a deterministic signal.</Empty>}
        </Panel>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,.65fr)]">
        <Panel
          title="Live activity"
          sub="Persisted business activity and bounded process telemetry; requests are not people."
          bodyClassName="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {activity.map(([label, metric]) => (
            <CompactDigital key={label} label={label} metric={metric} />
          ))}
        </Panel>
        <Panel title="Infrastructure control" sub="Monitor, detect and recommend only." bodyClassName="p-3">
          <div className="grid gap-2 text-xs">
            <div className="rounded border border-[var(--admin-line,#333)] p-2">
              <span className="opacity-65">Mode</span>
              <strong className="ml-2">{data.infrastructure.control.currentMode}</strong>
            </div>
            <div className="rounded border border-[var(--admin-line,#333)] p-2">
              <span className="opacity-65">Guarded auto</span>
              <strong className="ml-2">OFF</strong>
            </div>
            <div className="rounded border border-[var(--admin-line,#333)] p-2">
              <span className="opacity-65">Baseline</span>
              <strong className="ml-2">
                {data.infrastructure.fly.machines.length
                  ? `${data.infrastructure.fly.machines.length} observed machine${data.infrastructure.fly.machines.length === 1 ? "" : "s"}`
                  : "not connected"}
              </strong>
            </div>
            <div className="rounded border border-[var(--admin-line,#333)] p-2">
              <span className="opacity-65">Monthly budget</span>
              <strong className="ml-2">{data.infrastructure.budget.state.replaceAll("_", " ")}</strong>
            </div>
            <p className="pt-1 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
              Capacity changes are unavailable because no reviewed request, cost, safety and audit workflow is wired.
            </p>
          </div>
        </Panel>
      </div>
      <CommercialScoreboardPanel scoreboard={data.scoreboard} selectedPeriod={period} />
    </section>
  );
}

export default function GrowthCommandPage() {
  const [, navigate] = useLocation();
  const searchLocation = useSearch();
  const [period, setPeriod] = useState<Period>("30d");
  const tab = growthTabFromSearch(searchLocation);
  const manualRefresh = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [form, setForm] = useState({
    target: "partner",
    source: "outreach",
    medium: "email",
    campaign: "medway_cataclysm",
    content: "",
  });
  const session = useQuery<AdminSession>({
    queryKey: ["/api/admin/session"],
    queryFn: async () => {
      const response = await fetch("/api/admin/session", { credentials: "include" });
      return response.ok ? ((await response.json()) as AdminSession) : { authenticated: false };
    },
    retry: false,
  });
  const allowed = session.data?.authenticated === true && session.data.isSuperAdmin === true;
  useEffect(() => {
    if (session.data && !session.data.authenticated) navigate("/admin/login?next=/admin/growth", { replace: true });
    if (session.data?.authenticated && !session.data.isSuperAdmin) navigate("/admin", { replace: true });
  }, [navigate, session.data]);
  const command = useQuery<Intelligence>({
    queryKey: [BASE, "intelligence", period],
    queryFn: async () => {
      const response = await fetch(growthIntelligenceUrl(period, consumeManualGrowthRefresh(manualRefresh)), {
        credentials: "include",
      });
      if (!response.ok) throw new Error();
      return response.json() as Promise<Intelligence>;
    },
    enabled: allowed,
    refetchInterval: tab === "overview" || tab === "health" ? 30_000 : 120_000,
  });
  const leads = useQuery<{ leads: Lead[] }>({
    queryKey: [BASE, "leads"],
    queryFn: async () => {
      const response = await fetch(`${BASE}/leads`, { credentials: "include" });
      if (!response.ok) throw new Error();
      return response.json() as Promise<{ leads: Lead[] }>;
    },
    enabled: allowed && tab === "partners",
  });
  const detail = useQuery<{ lead: LeadDetail }>({
    queryKey: [BASE, "lead", leadId],
    queryFn: async () => {
      const response = await fetch(`${BASE}/leads/${leadId}`, { credentials: "include" });
      if (!response.ok) throw new Error();
      return response.json() as Promise<{ lead: LeadDetail }>;
    },
    enabled: allowed && tab === "partners" && !!leadId,
  });
  const options = useQuery<LinkOptions>({
    queryKey: [BASE, "link-options"],
    queryFn: async () => {
      const response = await fetch(`${BASE}/link-options`, { credentials: "include" });
      if (!response.ok) throw new Error();
      return response.json() as Promise<LinkOptions>;
    },
    enabled: allowed && tab === "campaigns",
  });
  const reviews = useQuery<GrowthReviewSummary>({
    queryKey: [BASE, "reviews", period],
    queryFn: async () => {
      const response = await fetch(`${BASE}/reviews?period=${period}`, { credentials: "include" });
      if (!response.ok) throw new Error();
      return response.json() as Promise<GrowthReviewSummary>;
    },
    enabled: allowed && tab === "reviews",
  });
  const refreshCommand = () => {
    manualRefresh.current = true;
    setRefreshing(true);
    const requests: Array<Promise<unknown>> = [command.refetch()];
    if (tab === "reviews") requests.push(reviews.refetch());
    void Promise.all(requests).finally(() => setRefreshing(false));
  };
  const statusChange = useMutation<{ changed: boolean; status: LeadState }, Error, { id: string; status: LeadState }>({
    mutationFn: async (input) =>
      (await apiRequest("POST", `${BASE}/leads/${input.id}/status`, { status: input.status })).json(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [BASE] });
    },
  });
  const link = useMutation<{ url: string }, Error, void>({
    mutationFn: async () =>
      (await apiRequest("POST", `${BASE}/links`, { ...form, content: form.content || undefined })).json(),
    onSuccess: () => setCopyState("idle"),
  });
  const data = command.data;
  const summary = data?.summary;
  const selected = detail.data?.lead;
  const external = safeExternalUrl(selected?.webPresence);
  const selectTab = (next: Tab) => {
    navigate(`/admin/growth?tab=${next}`);
  };
  const updateLinkForm = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setCopyState("idle");
    link.reset();
  };
  if (session.isLoading || !session.data) return <div className="min-h-screen bg-[#10110f]" />;
  if (!allowed) return null;
  return (
    <AdminShell
      activeTab="growth"
      onTabChange={(next) =>
        navigate(
          next === "growth"
            ? "/admin/growth"
            : next === "promotions"
              ? "/admin/promotions"
              : `/admin?tab=${encodeURIComponent(next)}`
        )
      }
      onLogout={() => window.location.assign("/api/admin/logout")}
      title="Growth Command"
      crumb="MINTVAULT · INSIGHT"
    >
      <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6" data-testid="growth-command">
        <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-sm text-[var(--admin-muted,#8a8a8a)]">
              Revenue, paid cards, Partner leads, genuine review lifecycle, site evidence and controlled campaigns.
            </p>
            <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">
              No request count is called a visitor. Provider absence is never shown as healthy.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              Period{" "}
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value as Period)}
                className="rounded border border-[var(--admin-line,#333)] bg-transparent px-2 py-1"
                data-testid="growth-period"
              >
                {PERIODS.map((item) => (
                  <option key={item} value={item}>
                    {item === "all" ? "All instrumented time" : item === "today" ? "Today" : `Last ${item}`}
                  </option>
                ))}
              </select>
            </label>
            <AdminButton
              size="sm"
              onClick={refreshCommand}
              disabled={command.isFetching || reviews.isFetching || refreshing}
              data-testid="growth-refresh"
            >
              <RefreshCw size={14} />{" "}
              {command.isFetching || reviews.isFetching || refreshing ? "Refreshing" : "Refresh"}
            </AdminButton>
          </div>
        </header>
        <nav
          aria-label="Growth Command sections"
          className="flex flex-wrap gap-2 pb-1 sm:flex-nowrap sm:overflow-x-auto"
          data-testid="growth-tabs"
        >
          {TABS.map(([key, label]) => (
            <TabButton key={key} active={tab === key} label={label} onClick={() => selectTab(key)} />
          ))}
        </nav>
        {command.isError ? (
          <Retry message="Growth Command intelligence could not be loaded." retry={() => void command.refetch()} />
        ) : !data || !summary ? (
          <Empty>Loading authoritative Growth Command data…</Empty>
        ) : (
          <>
            <p className="text-xs text-[var(--admin-muted,#8a8a8a)]">
              Last updated: {date(data.generatedAt)} ·{" "}
              {data.freshness === "STALE" ? "STALE — last known valid snapshot" : "CURRENT"}
            </p>
            <IncidentBanner incident={data.incident} />
            {tab === "overview" && <GrowthOverview data={data} summary={summary} period={period} />}
            {tab === "acquisition" && (
              <section className="space-y-4">
                <PerformancePanel title="Source performance" rows={summary.sourcePerformance} />
                <CampaignPanel title="Campaign performance" rows={summary.campaignPerformance} />
              </section>
            )}
            {tab === "seo" && (
              <section className="space-y-4">
                <Panel
                  title="SEO & Traffic"
                  sub="Search performance comes only from Search Console; it is not guessed from requests."
                >
                  <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Gauge label="Search Console" metric={data.seo.searchConsole} />
                    <MetricCard label="Impressions" metric={data.seo.impressions} />
                    <MetricCard label="Clicks" metric={data.seo.clicks} />
                    <MetricCard label="CTR" metric={data.seo.ctr} />
                    <MetricCard label="Average position" metric={data.seo.averagePosition} />
                    <MetricCard label="Click trend" metric={data.seo.trend} />
                    <MetricCard label="Top queries" metric={data.seo.topQueries} />
                    <MetricCard label="Top landing pages" metric={data.seo.topPages} />
                  </div>
                </Panel>
                <Panel
                  title="Technical SEO configuration"
                  sub="MintVault-owned route configuration, distinct from external crawler visibility."
                >
                  <div className="grid gap-3 p-4 sm:grid-cols-3">
                    <Gauge label="Sitemap" metric={data.seo.technical.sitemap} />
                    <Gauge label="Robots" metric={data.seo.technical.robots} />
                    <Gauge label="Indexability policy" metric={data.seo.technical.indexabilityPolicy} />
                  </div>
                </Panel>
              </section>
            )}
            {tab === "conversion" && (
              <Panel title="Conversion" sub="Funnel percentages require a canonical event and time authority.">
                <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                  {data.conversion.stages.map((stage) => (
                    <MetricCard key={stage.key} label={stage.label} metric={stage.metric} />
                  ))}
                </div>
                <div className="grid gap-3 border-t border-[var(--admin-line,#333)] p-4 md:grid-cols-2">
                  <MetricCard label="Submission → checkout" metric={data.conversion.submissionToCheckout} />
                  <MetricCard label="Checkout → paid" metric={data.conversion.checkoutToPaid} />
                  <MetricCard label="Submission → paid" metric={data.conversion.submissionToPaid} />
                  <MetricCard label="Cards / paid order" metric={data.conversion.cardsPerPaidOrder} />
                  <MetricCard label="Drop-off" metric={data.conversion.dropOff} />
                  <MetricCard label="Previous-period comparison" metric={data.conversion.comparison} />
                </div>
                <p className="px-4 pb-4 text-xs text-[var(--admin-muted,#8a8a8a)]">{data.conversion.definition}</p>
              </Panel>
            )}
            {tab === "reviews" && (
              <section className="space-y-4" data-testid="growth-reviews">
                {reviews.isError ? (
                  <Retry message="Review reporting could not be loaded." retry={() => void reviews.refetch()} />
                ) : !reviews.data ? (
                  <Empty>Loading aggregate review lifecycle…</Empty>
                ) : (
                  <>
                    <Panel
                      title="Reviews & Reputation"
                      sub="Neutral requests after genuine delivered completion. Grade, sentiment and marketing consent are never eligibility inputs."
                    >
                      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                        <StatCard label="Eligible" value={number(reviews.data.eligible)} foot="Delivered completion" />
                        <StatCard label="Scheduled" value={number(reviews.data.scheduled)} foot="Durable outbox" />
                        <StatCard label="Sent" value={number(reviews.data.sent)} foot="Provider accepted" />
                        <StatCard label="Clicked" value={number(reviews.data.clicked)} foot="Request link only" />
                        <StatCard
                          label="Failed"
                          value={number(reviews.data.deliveryFailed)}
                          foot="Bounded retry lifecycle"
                        />
                        <StatCard
                          label="Uncertain"
                          value={number(reviews.data.deliveryUncertain)}
                          foot="No invented delivery state"
                        />
                        <StatCard
                          label="Suppressed"
                          value={number(reviews.data.suppressed)}
                          foot="Customer/admin preference"
                        />
                        <StatCard
                          label="Cancelled"
                          value={number(reviews.data.cancelled)}
                          foot="Eligibility withdrawn"
                        />
                      </div>
                    </Panel>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <Panel title="Request delivery" sub="Activation is server-owned and fail-closed.">
                        <div className="p-4">
                          <Badge variant={reviews.data.configuration.state === "READY" ? "prog" : "wait"}>
                            {reviews.data.configuration.state.replaceAll("_", " ")}
                          </Badge>
                          <p className="mt-3 text-sm text-[var(--admin-ink-dim,#b9b2a1)]">
                            {reviews.data.configuration.reason ??
                              "Approved HTTPS destination, verified MintVault sender and token authority are configured."}
                          </p>
                        </div>
                      </Panel>
                      <Panel title="Public reputation authority" sub="No rating or public-review count is inferred.">
                        <div className="p-4">
                          <Badge variant="neu">{reviews.data.publicReviews.state.replaceAll("_", " ")}</Badge>
                          <p className="mt-3 text-sm text-[var(--admin-ink-dim,#b9b2a1)]">
                            {reviews.data.publicReviews.reason}
                          </p>
                        </div>
                      </Panel>
                    </div>
                    <p className="text-xs text-[var(--admin-muted,#8a8a8a)]">
                      {reviews.data.definition} · Updated {date(reviews.data.lastUpdated)}
                    </p>
                  </>
                )}
              </section>
            )}
            {tab === "health" && (
              <section className="space-y-4">
                <Panel
                  title="Site health"
                  sub="Status includes text as well as colour. Unknown means missing authority, not healthy."
                >
                  <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      ["Site", data.siteHealth.site],
                      ["CPU", data.siteHealth.cpu],
                      ["RAM", data.siteHealth.memory],
                      ["Request rate", data.siteHealth.requestRate],
                      ["P95 latency", data.siteHealth.p95Latency],
                      ["5XX error rate", data.siteHealth.fiveXErrorRate],
                      ["Database", data.siteHealth.database],
                      ["Database pressure", data.siteHealth.databasePressure],
                      ["Database latency", data.siteHealth.databaseLatency],
                      ["Fly machines", data.siteHealth.flyMachines],
                      ["Payments", data.siteHealth.payments],
                      ["Email", data.siteHealth.email],
                      ["Partner API", data.siteHealth.partnerApi],
                      ["Scanner API", data.siteHealth.scannerApi],
                    ].map(([label, metric]) => (
                      <Gauge key={label as string} label={label as string} metric={metric as Metric} />
                    ))}
                  </div>
                </Panel>
                <Panel
                  title="Performance diagnostics"
                  sub={`Bounded 60-minute telemetry from machine ${data.performanceDiagnostics.machineRef}. Route labels are fixed safe templates; low samples are never coloured as a latency incident.`}
                >
                  <div
                    className={`m-4 rounded-xl border p-4 ${tone(data.performanceInsight.status)}`}
                    data-testid="growth-performance-insight"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="font-semibold">{data.performanceInsight.title}</h3>
                      <Badge
                        variant={
                          data.performanceInsight.status === "GREEN"
                            ? "prog"
                            : data.performanceInsight.status === "RED"
                              ? "red"
                              : "wait"
                        }
                      >
                        {data.performanceInsight.status}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm">{data.performanceInsight.detail}</p>
                    <p className="mt-2 text-xs uppercase tracking-[0.1em] opacity-75">
                      {data.performanceInsight.recommendation}
                    </p>
                  </div>
                  <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 xl:grid-cols-3">
                    {data.performanceDiagnostics.trafficClasses.map((entry) => (
                      <DigitalMetric
                        key={entry.key}
                        label={entry.label}
                        metric={performanceMetric(entry, data.performanceDiagnostics.lastUpdated)}
                        sampleCount={entry.requestCount}
                        trend={entry.trendP95LatencyMs}
                      />
                    ))}
                  </div>
                  <div className="grid gap-4 border-t border-[var(--admin-line,#333)] p-4 xl:grid-cols-2">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">Top slow route groups</p>
                      {data.performanceDiagnostics.topSlowRoutes.length ? (
                        <div className="mt-3 space-y-2">
                          {data.performanceDiagnostics.topSlowRoutes.map((entry) => (
                            <div
                              key={entry.key}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--admin-line,#333)] px-3 py-2 text-sm"
                            >
                              <span className="font-medium">{entry.label}</span>
                              <span>
                                {entry.p95LatencyMs ?? "—"} ms p95 · {entry.requestCount} req · {entry.fiveXCount} 5xx ·{" "}
                                {entry.confidence.replaceAll("_", " ")}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty>No safe route group has completed in this window.</Empty>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">Measured dependencies</p>
                      <div className="mt-3 space-y-2">
                        {data.performanceDiagnostics.dependencies.map((entry) => (
                          <div
                            key={entry.dependency}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--admin-line,#333)] px-3 py-2 text-sm"
                          >
                            <span className="font-medium">{entry.dependency.replaceAll("_", " ")}</span>
                            <span>
                              {entry.sampleCount
                                ? `${entry.p95LatencyMs ?? "—"} ms p95 · ${entry.sampleCount} samples · ${entry.failures} failures`
                                : "NOT INSTRUMENTED"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </Panel>
                <Panel title="Capacity decision" sub="Scaling remains an owner decision.">
                  <div className="p-4">
                    <Gauge
                      label="Capacity headroom"
                      metric={{
                        state: data.capacity.status === "UNKNOWN" ? "NOT_CONNECTED" : "REAL",
                        status: data.capacity.status,
                        value: data.capacity.label.replaceAll("_", " "),
                        source: data.capacity.thresholdModel,
                        reason: data.capacity.evidence.join(" "),
                        lastUpdated: data.siteHealth.lastUpdated,
                      }}
                    />
                    <p className="mt-3 text-sm">
                      Recommended next action: <strong>{data.capacity.recommendation.replaceAll("_", " ")}</strong>
                    </p>
                    <p className="mt-2 text-xs text-[var(--admin-muted,#8a8a8a)]">
                      Automatic scaling: DISABLED · Infrastructure mutation: UNAVAILABLE
                    </p>
                  </div>
                </Panel>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Panel
                    title="Fly machine intelligence"
                    sub="Machine detail appears only from an approved least-privilege server authority."
                  >
                    <div className="p-4">
                      <Gauge label="Fly connection" metric={data.infrastructure.fly.connection} />
                      {data.infrastructure.fly.machines.length === 0 ? (
                        <p className="mt-3 text-sm text-[var(--admin-muted,#8a8a8a)]">
                          No machine rows are shown because Fly telemetry is not connected. No machine count, health,
                          version or SHA is inferred.
                        </p>
                      ) : (
                        <div className="mt-3 grid gap-3">
                          {data.infrastructure.fly.machines.map((machine) => (
                            <article key={machine.machineRef} className={`rounded border p-3 ${tone(machine.status)}`}>
                              <div className="flex flex-wrap justify-between gap-2">
                                <strong>{machine.machineRef}</strong>
                                <span>
                                  {machine.region} · {machine.status}
                                </span>
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                <MetricCard label="CPU" metric={machine.cpu} />
                                <MetricCard label="RAM" metric={machine.memory} />
                                <MetricCard label="Request rate" metric={machine.requestRate} />
                                <MetricCard label="Request count" metric={machine.requestCount} />
                                <MetricCard label="P95 latency" metric={machine.p95Latency} />
                                <MetricCard label="5XX error rate" metric={machine.fiveXErrorRate} />
                                <MetricCard label="Deployed version" metric={machine.deployedVersion} />
                                <MetricCard label="Deployed SHA" metric={machine.deployedSha} />
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                    </div>
                  </Panel>
                  <Panel
                    title="Neon database intelligence"
                    sub="Availability is distinct from provider pressure and cost."
                  >
                    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                      <Gauge label="Availability" metric={data.infrastructure.neon.availability} />
                      <MetricCard label="Connection pressure" metric={data.infrastructure.neon.connectionPressure} />
                      <MetricCard label="Latency" metric={data.infrastructure.neon.latency} />
                      <MetricCard label="Compute" metric={data.infrastructure.neon.compute} />
                      <MetricCard label="Storage" metric={data.infrastructure.neon.storage} />
                      <MetricCard
                        label="Point-in-time recovery"
                        metric={data.infrastructure.neon.pointInTimeRecovery}
                      />
                    </div>
                    <p className="px-4 pb-4 text-xs text-[var(--admin-muted,#8a8a8a)]">
                      Neon mutation: UNAVAILABLE · Monitor and recommend only
                    </p>
                  </Panel>
                </div>
                <div className="grid gap-4 xl:grid-cols-[1.4fr_.6fr]">
                  <Panel title="Infrastructure cost" sub="Month-to-date provider authority; estimates are forbidden.">
                    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                      {data.infrastructure.costs.providers.map((cost) => (
                        <div key={cost.provider} className={`rounded border p-3 ${tone(cost.status)}`}>
                          <p className="text-xs font-medium uppercase">{cost.provider} · MTD</p>
                          <p className="mt-2 text-lg font-semibold">
                            {cost.state === "REAL" && typeof cost.amountMajor === "number" && cost.sourceCurrency
                              ? (formatProviderMoney(cost.amountMajor, cost.sourceCurrency) ?? "INVALID CURRENCY")
                              : cost.state.replaceAll("_", " ")}
                          </p>
                          <p className="mt-2 text-xs opacity-80">{cost.reason ?? "Authoritative provider billing"}</p>
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-3 border-t border-[var(--admin-line,#333)] p-4 sm:grid-cols-3">
                      <MetricCard label="GBP-normalised total" metric={data.infrastructure.costs.normalisedTotalGBP} />
                      <MetricCard label="Cost / paid card" metric={data.infrastructure.costs.costPerPaidCardGBP} />
                      <MetricCard label="Cost / paid order" metric={data.infrastructure.costs.costPerPaidOrderGBP} />
                    </div>
                    <p className="px-4 pb-4 text-xs text-[var(--admin-muted,#8a8a8a)]">
                      {data.infrastructure.costs.currencyPolicy}
                    </p>
                  </Panel>
                  <Panel title="Monthly budget guardrail" sub="Owner-defined future boundary; no automatic shutdown.">
                    <div className="p-4">
                      <Gauge
                        label="Budget"
                        metric={{
                          state: "NOT_INSTRUMENTED",
                          status: data.infrastructure.budget.status,
                          source: "Owner-approved infrastructure budget",
                          reason: data.infrastructure.budget.reason,
                          lastUpdated: null,
                        }}
                      />
                      <p className="mt-3 text-xs text-[var(--admin-muted,#8a8a8a)]">
                        Automatic shutdown: DISABLED · Automatic spend: DISABLED
                      </p>
                    </div>
                  </Panel>
                </div>
              </section>
            )}
            {tab === "partners" && (
              <section className="space-y-4">
                <Panel
                  title="Partner pipeline"
                  sub="Growth qualifies applications; Partner Management owns operational Partner accounts."
                >
                  <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
                    <Value label="All applications" value={data.partnerPipeline.total} />
                    <Value label="New" value={data.partnerPipeline.new} />
                    <Value label="Contacted" value={data.partnerPipeline.contacted} />
                    <Value label="Qualified" value={data.partnerPipeline.qualified} />
                    <Value label="Not a fit" value={data.partnerPipeline.notAFit} />
                    <Value label="Onboarding" value={data.partnerPipeline.onboarding} />
                  </div>
                  <div className="grid gap-3 border-t border-[var(--admin-line,#333)] p-4 sm:grid-cols-2 xl:grid-cols-4">
                    <PartnerValue label="Active Partners" value={summary.activePartners} />
                    <PartnerValue label="Partner-originated cards" value={summary.partnerCardsPerPartner} />
                    <PartnerValue label="Partner revenue" value={summary.partnerRevenue} />
                    <PartnerValue label="Repeat customer rate" value={summary.repeatCustomerRate} />
                  </div>
                </Panel>
                <div className="grid gap-4 2xl:grid-cols-[1.35fr_.65fr]">
                  <Panel
                    title="Partner application leads"
                    sub="Review and classify interest applications. These actions never create a Partner account."
                  >
                    {leads.isError ? (
                      <Retry message="Partner applications could not be loaded." retry={() => void leads.refetch()} />
                    ) : !leads.data ? (
                      <Empty>Loading application pipeline…</Empty>
                    ) : leads.data.leads.length === 0 ? (
                      <Empty>No applications have been received in this measured view.</Empty>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[680px] text-left text-sm">
                          <thead className="border-y border-[var(--admin-line,#333)] text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">
                            <tr>
                              <th className="p-3">Business</th>
                              <th className="p-3">Location</th>
                              <th className="p-3">State</th>
                              <th className="p-3">Acquisition</th>
                              <th className="p-3" />
                            </tr>
                          </thead>
                          <tbody>
                            {leads.data.leads.map((item) => (
                              <tr key={item.id} className="border-b border-[var(--admin-line,#333)]">
                                <td className="p-3 font-medium">
                                  {item.businessName}
                                  <div className="text-xs text-[var(--admin-muted,#8a8a8a)]">{item.businessType}</div>
                                </td>
                                <td className="p-3">
                                  {item.city || "—"}
                                  <div className="text-xs text-[var(--admin-muted,#8a8a8a)]">
                                    {item.postcode || "—"}
                                  </div>
                                </td>
                                <td className="p-3">
                                  <Badge variant={leadTone(item.status)}>{item.status.replaceAll("_", " ")}</Badge>
                                </td>
                                <td className="p-3">
                                  {item.source}
                                  <div className="text-xs text-[var(--admin-muted,#8a8a8a)]">{item.campaign}</div>
                                </td>
                                <td className="p-3">
                                  <AdminButton size="sm" onClick={() => setLeadId(item.id)}>
                                    Review
                                  </AdminButton>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                  <Panel
                    title={selected ? selected.businessName : "Application detail"}
                    sub={
                      selected ? "Internal contact data — do not export." : "Choose a Partner application to review."
                    }
                  >
                    {!leadId ? (
                      <Empty>Select a lead to review it or update its state.</Empty>
                    ) : detail.isError ? (
                      <Retry
                        message="This Partner application could not be loaded."
                        retry={() => void detail.refetch()}
                      />
                    ) : !selected ? (
                      <Empty>Loading application…</Empty>
                    ) : (
                      <div className="space-y-3 p-4 text-sm">
                        <div className="flex gap-2">
                          <Badge variant={leadTone(selected.status)}>{selected.status.replaceAll("_", " ")}</Badge>
                          <span className="text-[var(--admin-muted,#8a8a8a)]">{date(selected.createdAt)}</span>
                        </div>
                        <p>
                          <strong>{selected.contactName}</strong> · {selected.email}
                          {selected.phone ? ` · ${selected.phone}` : ""}
                        </p>
                        <p className="text-[var(--admin-muted,#8a8a8a)]">
                          {selected.interestReason || "No reason supplied"}
                        </p>
                        <dl className="grid gap-2 text-xs sm:grid-cols-2">
                          <div>
                            <dt className="uppercase text-[var(--admin-muted,#8a8a8a)]">Location</dt>
                            <dd>{[selected.city, selected.postcode].filter(Boolean).join(" · ") || "Not supplied"}</dd>
                          </div>
                          <div>
                            <dt className="uppercase text-[var(--admin-muted,#8a8a8a)]">Business type</dt>
                            <dd>{selected.businessType || "Not supplied"}</dd>
                          </div>
                          <div>
                            <dt className="uppercase text-[var(--admin-muted,#8a8a8a)]">Retail presence</dt>
                            <dd>
                              {selected.physicalRetail === true
                                ? "Physical retail"
                                : selected.physicalRetail === false
                                  ? "Online only"
                                  : "Not supplied"}
                            </dd>
                          </div>
                          <div>
                            <dt className="uppercase text-[var(--admin-muted,#8a8a8a)]">Card categories</dt>
                            <dd>{selected.categories.length ? selected.categories.join(", ") : "Not supplied"}</dd>
                          </div>
                          <div>
                            <dt className="uppercase text-[var(--admin-muted,#8a8a8a)]">Demand band</dt>
                            <dd>{selected.demandBand ?? "Not supplied"}</dd>
                          </div>
                          <div>
                            <dt className="uppercase text-[var(--admin-muted,#8a8a8a)]">
                              Existing grading submissions
                            </dt>
                            <dd>{selected.existingGradingSubmissions ?? "Not supplied"}</dd>
                          </div>
                        </dl>
                        {external && (
                          <a
                            href={external}
                            target="_blank"
                            rel="noreferrer"
                            className={adminButtonClass({ size: "sm" })}
                          >
                            <ExternalLink size={14} /> Open website / profile
                          </a>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {LEAD_STATES.filter((state) => state !== selected.status).map((state) => (
                            <AdminButton
                              key={state}
                              size="sm"
                              variant={state === "ONBOARDING" ? "gold" : "ghost"}
                              disabled={statusChange.isPending}
                              onClick={() => statusChange.mutate({ id: selected.id, status: state })}
                            >
                              {state.replaceAll("_", " ")}
                            </AdminButton>
                          ))}
                        </div>
                        {statusChange.isError && (
                          <p role="alert" className="text-xs text-red-400">
                            The state change did not complete. Retry before another action.
                          </p>
                        )}
                        {selected.status === "ONBOARDING" && (
                          <div className="rounded border border-amber-400/35 bg-amber-400/5 p-3">
                            <p className="font-medium">Ready for manual Partner Management review</p>
                            <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">
                              {
                                "No selected-lead context is transferred. No tenant, user, location, station, credit or approval has been created."
                              }
                            </p>
                            <Link
                              className={`${adminButtonClass({ size: "sm", variant: "gold", className: "mt-2 inline-flex" })}`}
                              href="/admin/partners/settings"
                            >
                              Open Partner Management settings <ArrowUpRight size={14} />
                            </Link>
                          </div>
                        )}
                      </div>
                    )}
                  </Panel>
                </div>
              </section>
            )}
            {tab === "campaigns" && (
              <section className="space-y-4">
                <CampaignPanel title="Campaign performance" rows={summary.campaignPerformance} />
                <Panel
                  title="Controlled campaign link generator"
                  sub="Only MintVault-approved codes can be generated. Sending outreach is separate."
                >
                  {options.isError ? (
                    <Retry
                      message="Controlled link options could not be loaded."
                      retry={() => void options.refetch()}
                    />
                  ) : !options.data ? (
                    <Empty>Loading controlled campaign registry…</Empty>
                  ) : (
                    <div className="space-y-4 p-4">
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                        <Select
                          label="Audience"
                          value={form.target}
                          options={options.data.targets}
                          onChange={(value) => updateLinkForm("target", value)}
                        />
                        <Select
                          label="Source"
                          value={form.source}
                          options={options.data.sources.map((value) => ({ value, label: value }))}
                          onChange={(value) => updateLinkForm("source", value)}
                        />
                        <Select
                          label="Medium"
                          value={form.medium}
                          options={options.data.mediums.map((value) => ({ value, label: value }))}
                          onChange={(value) => updateLinkForm("medium", value)}
                        />
                        <Select
                          label="Campaign"
                          value={form.campaign}
                          options={options.data.campaigns.map((value) => ({ value, label: value }))}
                          onChange={(value) => updateLinkForm("campaign", value)}
                        />
                        <Select
                          label="Content (optional)"
                          value={form.content}
                          options={[
                            { value: "", label: "No content variant" },
                            ...options.data.contents.map((value) => ({ value, label: value })),
                          ]}
                          onChange={(value) => updateLinkForm("content", value)}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <AdminButton variant="gold" disabled={link.isPending} onClick={() => link.mutate()}>
                          Generate tracked link
                        </AdminButton>
                        <span className="text-xs text-[var(--admin-muted,#8a8a8a)]">
                          Default: Medway Cataclysm · Partner outreach · Email.
                        </span>
                      </div>
                      {link.isError && (
                        <p role="alert" className="text-sm text-red-400">
                          The link could not be generated. Use one of the controlled values shown above.
                        </p>
                      )}
                      {link.data?.url && (
                        <div className="flex flex-col gap-2 rounded border border-[var(--admin-line,#333)] p-3 sm:flex-row sm:items-center">
                          <code className="min-w-0 flex-1 break-all text-xs">{link.data.url}</code>
                          <AdminButton
                            size="sm"
                            onClick={() => {
                              void copyTrackedLink(link.data!.url).then((copied) =>
                                setCopyState(copied ? "copied" : "failed")
                              );
                            }}
                          >
                            <Copy size={14} /> {copyState === "copied" ? "Copied" : "Copy"}
                          </AdminButton>
                          {copyState === "failed" && (
                            <span role="alert" className="text-xs text-red-400">
                              Copy was blocked. Select the URL manually.
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Panel>
              </section>
            )}
          </>
        )}
      </div>
    </AdminShell>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-[var(--admin-line,#333)] bg-transparent px-2 py-2 text-sm normal-case text-inherit"
      >
        {options.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
function PerformancePanel({ title, rows }: { title: string; rows: Performance[] }) {
  return (
    <Panel title={title} sub="Paid orders and Partner applications remain distinct measured sources.">
      {rows.length === 0 ? (
        <Empty>No measured results in this period.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[580px] text-left text-sm">
            <thead className="border-y border-[var(--admin-line,#333)] text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">
              <tr>
                <th className="p-3">Source</th>
                <th className="p-3">Paid orders</th>
                <th className="p-3">Cards</th>
                <th className="p-3">Revenue</th>
                <th className="p-3">Applications</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.category} className="border-b border-[var(--admin-line,#333)]">
                  <td className="p-3">{row.category.replaceAll("_", " ")}</td>
                  <td className="p-3">{number(row.paidSubmissions)}</td>
                  <td className="p-3">{number(row.paidCards)}</td>
                  <td className="p-3">{formatGrowthMoneyGBP(row.revenuePence)}</td>
                  <td className="p-3">{number(row.partnerApplications)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
function CampaignPanel({ title, rows }: { title: string; rows: Campaign[] }) {
  return (
    <Panel title={title} sub="Only controlled campaign codes appear; unapproved history is unattributed.">
      {rows.length === 0 ? (
        <Empty>No measured campaign results in this period.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-y border-[var(--admin-line,#333)] text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">
              <tr>
                <th className="p-3">Campaign</th>
                <th className="p-3">Source</th>
                <th className="p-3">Paid orders</th>
                <th className="p-3">Revenue</th>
                <th className="p-3">Applications</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.category}-${row.campaign}`} className="border-b border-[var(--admin-line,#333)]">
                  <td className="p-3">{row.campaign}</td>
                  <td className="p-3">{row.category.replaceAll("_", " ")}</td>
                  <td className="p-3">{number(row.paidSubmissions)}</td>
                  <td className="p-3">{formatGrowthMoneyGBP(row.revenuePence)}</td>
                  <td className="p-3">{number(row.partnerApplications)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
