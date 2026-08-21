/** GB-04B Super Admin Growth Command. All unavailable authority stays visible as unavailable. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { AdminButton, AdminShell, Badge, Panel, adminButtonClass } from "@/components/admin";
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
/**
 * The full-size thin radial gauge. Reserved for a bounded percentage — CPU, RAM
 * or pressure — where the proportion itself is the message. A boolean state uses
 * StatusTile instead, so a ring never implies a measurement that does not exist.
 */
function RadialRing({ label, metric }: { label: string; metric: Metric }) {
  const numeric = typeof metric.value === "number" ? Math.min(100, Math.max(0, metric.value)) : null;
  const accent = statusAccent(metric.status);
  const progress = numeric == null ? 0 : numeric * 3.6;
  return (
    <article
      className="rounded-lg border border-[var(--admin-line,#333)] bg-black/15 p-3 text-center"
      data-testid={`growth-gauge-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}
      title={metric.reason ?? metric.source}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="break-words text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</p>
        <span className="text-[10px] font-semibold tracking-[0.1em]" style={{ color: accent }}>
          {metric.status}
        </span>
      </div>
      <div
        className="relative mx-auto mt-3 grid h-20 w-20 place-items-center rounded-full"
        role="img"
        aria-label={`${label}: ${metric.status}; ${text(metric)}`}
        style={{ background: `conic-gradient(${accent} ${progress}deg, rgba(255,255,255,.10) ${progress}deg 360deg)` }}
      >
        <div className="grid h-[4.3rem] w-[4.3rem] place-items-center rounded-full bg-[var(--admin-panel,#151515)] px-1">
          <span className="break-words text-sm font-semibold leading-tight">{text(metric)}</span>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">{date(metric.lastUpdated)}</p>
    </article>
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
  const value = text(metric);
  return (
    <article
      className="rounded-lg border border-[var(--admin-line,#333)] bg-black/15 p-3"
      title={metric.reason ?? metric.source}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="break-words text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</p>
        <span className="text-[10px] font-semibold" style={{ color: statusAccent(metric.status) }}>
          {metric.status}
        </span>
      </div>
      <p className={`mt-2 break-words font-semibold tracking-tight ${kpiValueClass(value)}`}>{value}</p>
      {typeof sampleCount === "number" && (
        <p className="mt-1 text-[10px] uppercase tracking-[0.1em] opacity-70">{number(sampleCount)} requests</p>
      )}
      {trend && <Sparkline values={trend} status={metric.status} />}
      <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">{date(metric.lastUpdated)}</p>
    </article>
  );
}
/**
 * The canonical compact status tile. One label, one value, one dot. Used for
 * every service and configuration state across the console so a boolean never
 * occupies the space of a measured metric.
 */
function StatusTile({ label, metric }: { label: string; metric: Metric }) {
  return (
    <article
      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--admin-line,#333)] bg-black/15 px-3 py-2"
      title={metric.reason ?? metric.source}
    >
      <div className="min-w-0">
        <p className="break-words text-[10px] font-semibold uppercase tracking-[0.06em]">{label}</p>
        <p className="mt-0.5 break-words text-xs font-semibold leading-snug">{text(metric)}</p>
      </div>
      <span
        className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: statusAccent(metric.status) }}
        role="img"
        aria-label={`${label} status ${metric.status}`}
      />
    </article>
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

/**
 * Operational status values must stay readable. An ellipsis on a state such as
 * "INSUFFICIENT TELEMETRY" or "HEALTHY HEADROOM" hides the only word that tells
 * the owner what to do, so the value step-scales and may wrap to two lines
 * instead of truncating.
 */
export function kpiValueClass(value: string): string {
  // Sized against the narrowest cell the strip produces: a seven-column strip on
  // a 1440px viewport leaves about 127px of content width. A single word wider
  // than that would be split mid-word by the break-words safety net, which is
  // how "HEADROOM" became "HEADROO / M", so each tier is chosen to fit there.
  const length = value.length;
  if (length <= 6) return "text-xl sm:text-2xl";
  if (length <= 10) return "text-lg sm:text-xl";
  if (length <= 16) return "text-sm sm:text-base leading-snug";
  return "text-xs sm:text-sm leading-snug";
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
      <p className={`mt-1 break-words font-semibold tracking-tight ${kpiValueClass(value)}`} title={value}>
        {value}
      </p>
      <p className="mt-1 line-clamp-2 text-[10px] opacity-75" title={detail}>
        {detail}
      </p>
    </article>
  );
}

/** One KPI strip implementation. Every tab uses it so the top band never drifts. */
const KPI_STRIP_COLUMNS: Record<number, string> = {
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
  7: "sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7",
};
function GrowthKpiStrip({ label, columns = 5, children }: { label: string; columns?: number; children: ReactNode }) {
  return (
    <section
      className={`grid gap-px overflow-hidden rounded-xl border border-[var(--admin-line,#333)] bg-[var(--admin-line,#333)] ${KPI_STRIP_COLUMNS[columns] ?? KPI_STRIP_COLUMNS[5]}`}
      aria-label={label}
    >
      {children}
    </section>
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
          <p className="break-words text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</p>
          <p className="mt-1 break-words text-[10px] leading-tight opacity-75">
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

/**
 * A polished "nothing real to draw yet" panel. It preserves the chart's place in
 * the layout without inventing a single point, so an unconnected authority reads
 * as deliberate rather than broken.
 */
function GrowthEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-[8.5rem] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--admin-line,#333)] bg-black/20 px-4 py-6 text-center">
      <svg className="h-8 w-14 opacity-30" viewBox="0 0 56 32" aria-hidden="true">
        <path d="M2 26 H54" stroke="currentColor" strokeWidth="1.5" strokeOpacity=".5" />
        <path d="M2 20 H54 M2 12 H54" stroke="currentColor" strokeWidth="1" strokeOpacity=".22" />
        <path d="M4 24 L16 18 L28 21 L40 11 L52 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--admin-ink-dim,#b9b2a1)]">{title}</p>
      <p className="max-w-sm text-[11px] text-[var(--admin-muted,#8a8a8a)]">{detail}</p>
    </div>
  );
}

type BarRow = { key: string; label: string; value: number; display: string; status?: Health };

/**
 * The single categorical chart for the whole console. It plots measured
 * categories only; an empty input renders the empty state rather than a zeroed
 * axis, because a flat line at zero reads as a measurement and this is not one.
 */
function GrowthBarSeries({ rows, empty }: { rows: BarRow[]; empty: { title: string; detail: string } }) {
  const measured = rows.filter((row) => Number.isFinite(row.value) && row.value > 0);
  if (!measured.length) return <GrowthEmptyState title={empty.title} detail={empty.detail} />;
  const maximum = Math.max(...measured.map((row) => row.value));
  return (
    <ul className="space-y-2">
      {measured.map((row) => (
        <li key={row.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words text-[11px] leading-tight" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 text-[11px] font-semibold tabular-nums">{row.display}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-sm bg-white/[.06]">
            <div
              className="h-full rounded-sm"
              style={{
                width: `${Math.max(2, (row.value / maximum) * 100)}%`,
                background: row.status ? statusAccent(row.status) : "#d4af37",
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

type FunnelStep = { key: string; label: string; value: number | null; detail: string };

/**
 * Conversion funnel. Each step is drawn from its own measured count; a step with
 * no authority is drawn muted and labelled, never interpolated from neighbours.
 */
function GrowthFunnel({ steps }: { steps: FunnelStep[] }) {
  const known = steps.filter((step): step is FunnelStep & { value: number } => typeof step.value === "number");
  if (known.length < 2)
    return (
      <GrowthEmptyState
        title="Funnel collecting"
        detail="At least two canonical funnel stages must be measured before a funnel can be drawn."
      />
    );
  const head = Math.max(...known.map((step) => step.value), 1);
  return (
    <ol className="space-y-2">
      {steps.map((step, index) => {
        const measured = typeof step.value === "number";
        const width = measured ? Math.max(4, ((step.value as number) / head) * 100) : 100;
        const previous = steps[index - 1];
        // A stage that exceeds the one above it is a change of unit, not a
        // conversion — paid cards are counted per card, paid orders per order.
        // Showing a percentage there would read as a >100% conversion rate, so a
        // multiplier is shown instead.
        const carry =
          measured && previous && typeof previous.value === "number" && previous.value > 0
            ? (step.value as number) <= previous.value
              ? `${(((step.value as number) / previous.value) * 100).toFixed(1)}%`
              : `×${((step.value as number) / previous.value).toFixed(1)}`
            : null;
        return (
          <li key={step.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[11px]">{step.label}</span>
              <span className="shrink-0 text-[11px] font-semibold tabular-nums">
                {measured ? number(step.value as number) : "Not measured"}
                {carry && <span className="ml-2 opacity-60">{carry}</span>}
              </span>
            </div>
            <div className="mt-1 h-6 w-full overflow-hidden rounded-sm bg-white/[.05]">
              <div
                className="grid h-full place-items-start rounded-sm"
                style={{
                  width: `${width}%`,
                  background: measured
                    ? "linear-gradient(90deg,rgba(212,175,55,.85),rgba(212,175,55,.35))"
                    : "repeating-linear-gradient(135deg,rgba(255,255,255,.06) 0 6px,transparent 6px 12px)",
                }}
              />
            </div>
            <p className="mt-1 text-[10px] text-[var(--admin-muted,#8a8a8a)]">{step.detail}</p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * AI / model service health is only reported where the route class has actually
 * been exercised. There is no separate provider probe, so an unexercised class
 * reports NOT INSTRUMENTED rather than borrowing another service's colour.
 */
export function aiModelServiceMetric(diagnostics: PerformanceDiagnostics, lastUpdated: string | null): Metric {
  const entry = diagnostics.trafficClasses.find((item) => item.trafficClass === "AI_MODEL");
  if (!entry || entry.requestCount === 0) {
    return {
      state: "NOT_INSTRUMENTED",
      status: "UNKNOWN",
      source: "Bounded route telemetry",
      reason: "No AI or model request completed in this window, so no health can be claimed.",
      lastUpdated,
    };
  }
  return {
    state: entry.confidence === "SUFFICIENT" ? "REAL" : "INSUFFICIENT_DATA",
    status: entry.confidence === "SUFFICIENT" ? entry.status : "UNKNOWN",
    value: entry.p95LatencyMs == null ? `${entry.requestCount} requests` : `${entry.p95LatencyMs} ms p95`,
    unit: "",
    source: "Bounded route telemetry",
    ...(entry.confidence === "SUFFICIENT" ? {} : { reason: `Low sample · ${entry.requestCount} requests` }),
    lastUpdated,
  };
}

export type CampaignSummary = {
  activeCount: number;
  paidSubmissions: number;
  revenuePence: number;
  partnerApplications: number;
  bestLabel: string;
  bestDetail: string;
};

/**
 * Campaign headline figures, summed from the controlled-code rows the server
 * returns. A campaign counts as active only where it produced a measured
 * outcome, so an approved but unused code never inflates the count.
 */
export function deriveCampaigns(rows: Campaign[]): CampaignSummary {
  const measured = rows.filter((row) => row.paidSubmissions > 0 || row.revenuePence > 0 || row.partnerApplications > 0);
  const best = [...measured].sort(
    (a, b) => b.revenuePence - a.revenuePence || b.paidSubmissions - a.paidSubmissions
  )[0];
  return {
    activeCount: measured.length,
    paidSubmissions: rows.reduce((sum, row) => sum + row.paidSubmissions, 0),
    revenuePence: rows.reduce((sum, row) => sum + row.revenuePence, 0),
    partnerApplications: rows.reduce((sum, row) => sum + row.partnerApplications, 0),
    bestLabel: best ? best.campaign : "No measured campaign",
    bestDetail: best
      ? `${formatGrowthMoneyGBP(best.revenuePence)} · ${number(best.paidSubmissions)} paid orders`
      : "No controlled code has produced a measured outcome",
  };
}

/**
 * Review authorities are binary and server-owned. CONNECTED is only ever shown
 * for an authority the server itself reports as ready, so an unconfigured
 * destination, sender or public reputation source can never read as live.
 */
export function reviewAuthorityMetric(
  state: "CONNECTED" | "NOT_CONNECTED",
  reason: string,
  lastUpdated: string | null
): Metric {
  return {
    state: state === "CONNECTED" ? "REAL" : "NOT_CONNECTED",
    status: state === "CONNECTED" ? "GREEN" : "UNKNOWN",
    value: state.replaceAll("_", " "),
    unit: "",
    source: "Server-owned review authority",
    reason,
    lastUpdated,
  };
}

/**
 * Loss between consecutive measured funnel stages. A pair is skipped entirely
 * unless both stages are measured, so a missing stage never manufactures a
 * drop-off that nobody observed.
 */
export function stageDropOff(stages: Array<{ key: string; label: string; metric: Metric }>): BarRow[] {
  const rows: BarRow[] = [];
  for (let index = 1; index < stages.length; index += 1) {
    const previous = stages[index - 1];
    const current = stages[index];
    if (typeof previous?.metric.value !== "number" || typeof current?.metric.value !== "number") continue;
    const lost = previous.metric.value - current.metric.value;
    if (lost <= 0) continue;
    rows.push({
      key: `${previous.key}-${current.key}`,
      label: `${previous.label} → ${current.label}`,
      value: lost,
      display: `${number(lost)} lost · ${((lost / previous.metric.value) * 100).toFixed(1)}%`,
      status: "AMBER",
    });
  }
  return rows;
}

export type AttributionSummary = {
  attributedPaidSubmissions: number;
  attributedRevenuePence: number;
  partnerApplications: number;
  bestSourceLabel: string;
  bestSourceDetail: string;
  coveragePercent: number;
  attributedMetric: Metric;
  unattributedMetric: Metric;
};

/**
 * Acquisition headline figures, summed from the measured per-source rows the
 * server already returns. Nothing is modelled: an order without a controlled
 * code stays unattributed rather than being assigned to a best guess.
 */
export function deriveAttribution(
  sourcePerformance: Performance[],
  unattributedPaidSubmissions: number,
  lastUpdated: string | null
): AttributionSummary {
  const attributedPaidSubmissions = sourcePerformance.reduce((sum, row) => sum + row.paidSubmissions, 0);
  const attributedRevenuePence = sourcePerformance.reduce((sum, row) => sum + row.revenuePence, 0);
  const partnerApplications = sourcePerformance.reduce((sum, row) => sum + row.partnerApplications, 0);
  const best = [...sourcePerformance]
    .filter((row) => row.revenuePence > 0 || row.paidSubmissions > 0)
    .sort((a, b) => b.revenuePence - a.revenuePence || b.paidSubmissions - a.paidSubmissions)[0];
  const denominator = attributedPaidSubmissions + unattributedPaidSubmissions;
  return {
    attributedPaidSubmissions,
    attributedRevenuePence,
    partnerApplications,
    bestSourceLabel: best ? best.category.replaceAll("_", " ") : "No measured source",
    bestSourceDetail: best
      ? `${formatGrowthMoneyGBP(best.revenuePence)} · ${number(best.paidSubmissions)} paid orders`
      : "No paid order carried a controlled code",
    coveragePercent: denominator > 0 ? (attributedPaidSubmissions / denominator) * 100 : 0,
    attributedMetric: {
      state: "REAL",
      status: "GREEN",
      value: attributedPaidSubmissions,
      unit: "orders",
      source: "Controlled attribution",
      lastUpdated,
    },
    unattributedMetric: {
      state: "REAL",
      status: unattributedPaidSubmissions > 0 ? "AMBER" : "GREEN",
      value: unattributedPaidSubmissions,
      unit: "orders",
      source: "Paid orders with no controlled code",
      lastUpdated,
    },
  };
}

/**
 * A Search Console chart position. The layout reserves the space so the tab
 * reads as a finished dashboard awaiting a connection, but no series is drawn
 * and no number is implied until Google is the authority for it.
 */
function SearchConsoleChartSlot({ metric }: { metric: Metric }) {
  if (metric.state === "REAL")
    return (
      <div className="rounded-lg border border-[var(--admin-line,#333)] bg-black/15 p-3">
        <p className="break-words text-lg font-semibold leading-snug">{text(metric)}</p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.1em]" style={{ color: statusAccent(metric.status) }}>
          {metric.status} · {date(metric.lastUpdated)}
        </p>
        <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">{metric.source}</p>
      </div>
    );
  // NOT_CONNECTED and NOT_INSTRUMENTED both mean "Google is not an authority for
  // this yet". The heading says so plainly; the server's precise state stays
  // visible underneath so no distinction is lost.
  const awaiting = metric.state === "NOT_CONNECTED" || metric.state === "NOT_INSTRUMENTED";
  return (
    <GrowthEmptyState
      title={awaiting ? "Awaiting Search Console connection" : metric.state.replaceAll("_", " ")}
      detail={`${metric.state.replaceAll("_", " ")} · ${
        metric.reason ??
        "Search performance is only ever reported from Search Console. Nothing is estimated from request telemetry."
      }`}
    />
  );
}


/**
 * Route performance as one compact table rather than nine equally-weighted
 * boxes. Labels are the server's fixed safe templates, so no query string,
 * customer identifier or other request detail can reach this surface.
 */
function RoutePerformanceTable({ diagnostics }: { diagnostics: PerformanceDiagnostics }) {
  const rows = diagnostics.trafficClasses;
  if (!rows.length)
    return (
      <GrowthEmptyState
        title="No completed route telemetry"
        detail="No safe route class has completed a request in this rolling 60-minute window."
      />
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="border-y border-[var(--admin-line,#333)] uppercase tracking-[0.1em] text-[var(--admin-muted,#8a8a8a)]">
          <tr>
            <th className="px-3 py-2 font-medium">Route class</th>
            <th className="px-3 py-2 font-medium">Requests</th>
            <th className="px-3 py-2 font-medium">P50</th>
            <th className="px-3 py-2 font-medium">P95</th>
            <th className="px-3 py-2 font-medium">Errors</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr key={entry.key} className="border-b border-[var(--admin-line,#333)]">
              <td className="px-3 py-2">
                <span className="font-medium">{entry.label}</span>
                <span className="ml-2 text-[10px] uppercase tracking-[0.1em] opacity-55">{entry.trafficClass}</span>
              </td>
              <td className="px-3 py-2 tabular-nums">{number(entry.requestCount)}</td>
              <td className="px-3 py-2 tabular-nums">{entry.p50LatencyMs == null ? "—" : `${entry.p50LatencyMs} ms`}</td>
              <td className="px-3 py-2 font-semibold tabular-nums" style={{ color: statusAccent(entry.status) }}>
                {entry.p95LatencyMs == null ? "—" : `${entry.p95LatencyMs} ms`}
              </td>
              <td className="px-3 py-2 tabular-nums">{number(entry.fiveXCount)}</td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <i
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: statusAccent(entry.status) }}
                    aria-hidden="true"
                  />
                  <span className="text-[10px] uppercase tracking-[0.1em]">
                    {entry.confidence === "SUFFICIENT" ? entry.status : entry.confidence.replaceAll("_", " ")}
                  </span>
                </span>
              </td>
              <td className="w-24 px-3 py-2">
                <div className="-mt-3 w-20">
                  <Sparkline values={entry.trendP95LatencyMs} status={entry.status} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
        Fixed safe route templates only · current process · 60-minute window · updated {date(diagnostics.lastUpdated)}
      </p>
    </div>
  );
}

/**
 * Which fixed route classes represent a paying member of the public, and which
 * represent this console. Keys are the server's own traffic-class identifiers.
 * Classes outside both sets (Partner, Scanner, AI / model, Other) are shown in
 * the route table and named beneath the split rather than silently folded into
 * a headline they would misrepresent.
 */
const CUSTOMER_TRAFFIC_CLASSES = ["PUBLIC_CUSTOMER", "SUBMISSION_CHECKOUT", "VERIFY_CERTIFICATE"] as const;
const INTERNAL_TRAFFIC_CLASSES = ["SUPER_ADMIN", "GROWTH_COMMAND", "HEALTH_INTERNAL"] as const;

const HEALTH_RANK: Record<Health, number> = { GREEN: 0, UNKNOWN: 1, AMBER: 2, RED: 3 };

export type ExperienceBand = {
  status: Health;
  headline: string;
  worstP95LatencyMs: number | null;
  requestCount: number;
  contributors: string[];
  measured: boolean;
};

/**
 * Reduce one set of route classes to a single band. Only classes with a
 * sufficient sample can set a colour; anything else leaves the band UNKNOWN so a
 * quiet window is never painted as healthy.
 */
export function summariseExperienceBand(
  entries: Array<Pick<PerformanceAggregate, "trafficClass" | "label" | "requestCount" | "p95LatencyMs" | "status" | "confidence">>,
  classes: readonly string[]
): ExperienceBand {
  const scoped = entries.filter((entry) => classes.includes(entry.trafficClass));
  const measured = scoped.filter((entry) => entry.confidence === "SUFFICIENT" && entry.requestCount > 0);
  const requestCount = scoped.reduce((sum, entry) => sum + entry.requestCount, 0);
  if (!measured.length) {
    return {
      status: "UNKNOWN",
      headline: "INSUFFICIENT TELEMETRY",
      worstP95LatencyMs: null,
      requestCount,
      contributors: [],
      measured: false,
    };
  }
  const status = measured.reduce<Health>(
    (worst, entry) => (HEALTH_RANK[entry.status] > HEALTH_RANK[worst] ? entry.status : worst),
    "GREEN"
  );
  const latencies = measured
    .map((entry) => entry.p95LatencyMs)
    .filter((value): value is number => typeof value === "number");
  return {
    status,
    headline: status === "GREEN" ? "HEALTHY" : status === "AMBER" ? "INVESTIGATE" : status === "RED" ? "INVESTIGATE" : "UNKNOWN",
    worstP95LatencyMs: latencies.length ? Math.max(...latencies) : null,
    requestCount,
    contributors: measured.map((entry) => entry.label),
    measured: true,
  };
}

function ExperienceBandCard({
  title,
  sub,
  band,
}: {
  title: string;
  sub: string;
  band: ExperienceBand;
}) {
  const value = band.worstP95LatencyMs == null ? band.headline : `${band.headline} · ${band.worstP95LatencyMs} ms`;
  return (
    <article className={`rounded-xl border p-3 ${tone(band.status)}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.13em]">{title}</p>
        <span
          className="mt-1 h-2 w-2 shrink-0 rounded-full"
          style={{ background: statusAccent(band.status) }}
          aria-hidden="true"
        />
      </div>
      <p className={`mt-2 break-words font-semibold tracking-tight ${kpiValueClass(value)}`}>{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em] opacity-70">{sub}</p>
      <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
        {band.measured
          ? `Worst of ${band.contributors.join(", ")} · ${number(band.requestCount)} requests / 60m`
          : `${number(band.requestCount)} requests / 60m · no class reached a sufficient sample`}
      </p>
    </article>
  );
}

/**
 * The headline that stops an internal console latency reading as a customer
 * outage. Customer experience and this console are scored from separate route
 * classes and never share a colour.
 */
function ExperienceSplit({ data }: { data: Intelligence }) {
  const entries = data.performanceDiagnostics.trafficClasses;
  const customer = summariseExperienceBand(entries, CUSTOMER_TRAFFIC_CLASSES);
  const internal = summariseExperienceBand(entries, INTERNAL_TRAFFIC_CLASSES);
  const excluded = entries
    .filter(
      (entry) =>
        !CUSTOMER_TRAFFIC_CLASSES.includes(entry.trafficClass as (typeof CUSTOMER_TRAFFIC_CLASSES)[number]) &&
        !INTERNAL_TRAFFIC_CLASSES.includes(entry.trafficClass as (typeof INTERNAL_TRAFFIC_CLASSES)[number]) &&
        entry.requestCount > 0
    )
    .map((entry) => entry.label);
  const capacityValue = data.capacity.label.replaceAll("_", " ");
  return (
    <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-4">
      <ExperienceBandCard
        title="Customer experience"
        sub="Public site · submission · verify"
        band={customer}
      />
      <ExperienceBandCard
        title="Internal admin performance"
        sub="Super Admin · Growth Command"
        band={internal}
      />
      <article className={`rounded-xl border p-3 ${tone(data.capacity.status)}`}>
        <p className="text-[10px] font-semibold uppercase tracking-[0.13em]">Capacity</p>
        <p className={`mt-2 break-words font-semibold tracking-tight ${kpiValueClass(capacityValue)}`}>
          {capacityValue}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.1em] opacity-70">Owner decision only</p>
        <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">{data.capacity.thresholdModel}</p>
      </article>
      <article className="rounded-xl border border-[var(--admin-line,#333)] bg-black/15 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.13em]">Recommendation</p>
        <p
          className={`mt-2 break-words font-semibold tracking-tight ${kpiValueClass(data.capacity.recommendation.replaceAll("_", " "))}`}
        >
          {data.capacity.recommendation.replaceAll("_", " ")}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.1em] opacity-70">Advisory · no control mutates</p>
        <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
          {internal.status !== "GREEN" && customer.status === "GREEN"
            ? "Internal console latency does not indicate a customer-facing fault."
            : "Automatic scaling is disabled."}
        </p>
      </article>
      {excluded.length > 0 && (
        <p className="text-[10px] text-[var(--admin-muted,#8a8a8a)] sm:col-span-2 xl:col-span-4">
          Scored separately in the route table and excluded from both headlines: {excluded.join(", ")}.
        </p>
      )}
    </div>
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
              <p className="mt-1 break-words text-xs font-medium leading-snug">{text(metric as Metric)}</p>
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
      <GrowthKpiStrip label="Growth Command key signals" columns={7}>
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
      </GrowthKpiStrip>
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
  // Customer-facing latency is derived once and reused by the Site Health KPI
  // strip and the experience split, so the headline and the split can never
  // disagree about whether the public surface is healthy.
  const publicExperience = summariseExperienceBand(
    data?.performanceDiagnostics.trafficClasses ?? [],
    CUSTOMER_TRAFFIC_CLASSES
  );
  const attribution = deriveAttribution(
    summary?.sourcePerformance ?? [],
    summary?.paid.unattributedPaidSubmissions.value ?? 0,
    data?.generatedAt ?? null
  );
  // The first four canonical funnel stages drive both the KPI strip and the
  // funnel, so the two can never disagree.
  const conversionStages = (data?.conversion.stages ?? []).slice(0, 4);
  const conversionDropOff = stageDropOff(conversionStages);
  const campaigns = deriveCampaigns(summary?.campaignPerformance ?? []);
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
              <section className="space-y-3">
                <GrowthKpiStrip label="Acquisition key signals" columns={5}>
                  <OverviewKpi
                    label="Attributed paid orders"
                    value={number(attribution.attributedPaidSubmissions)}
                    detail="Controlled attribution only"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Attributed revenue"
                    value={formatGrowthMoneyGBP(attribution.attributedRevenuePence)}
                    detail="Verified paid authority"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Partner applications"
                    value={number(attribution.partnerApplications)}
                    detail="Distinct from paid orders"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Unattributed orders"
                    value={number(summary.paid.unattributedPaidSubmissions.value)}
                    detail="No controlled code present"
                    status={summary.paid.unattributedPaidSubmissions.value > 0 ? "AMBER" : "GREEN"}
                  />
                  <OverviewKpi
                    label="Best measured source"
                    value={attribution.bestSourceLabel}
                    detail={attribution.bestSourceDetail}
                    status={attribution.bestSourceLabel === "No measured source" ? "UNKNOWN" : "GREEN"}
                  />
                </GrowthKpiStrip>
                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel title="Revenue by source" sub="Verified paid revenue, GBP." bodyClassName="p-3">
                    <GrowthBarSeries
                      rows={summary.sourcePerformance.map((row) => ({
                        key: row.category,
                        label: row.category.replaceAll("_", " "),
                        value: row.revenuePence,
                        display: formatGrowthMoneyGBP(row.revenuePence),
                      }))}
                      empty={{
                        title: "No attributed revenue",
                        detail: "No paid order in this period carried a controlled attribution code.",
                      }}
                    />
                  </Panel>
                  <Panel
                    title="Orders and applications by source"
                    sub="Paid orders and Partner applications stay distinct measured outcomes."
                    bodyClassName="p-3"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                          Paid orders
                        </p>
                        <GrowthBarSeries
                          rows={summary.sourcePerformance.map((row) => ({
                            key: `orders-${row.category}`,
                            label: row.category.replaceAll("_", " "),
                            value: row.paidSubmissions,
                            display: number(row.paidSubmissions),
                          }))}
                          empty={{ title: "No paid orders", detail: "No attributed paid order in this period." }}
                        />
                      </div>
                      <div>
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                          Partner applications
                        </p>
                        <GrowthBarSeries
                          rows={summary.sourcePerformance.map((row) => ({
                            key: `apps-${row.category}`,
                            label: row.category.replaceAll("_", " "),
                            value: row.partnerApplications,
                            display: number(row.partnerApplications),
                          }))}
                          empty={{
                            title: "No applications",
                            detail: "No Partner application in this period carried a measured source.",
                          }}
                        />
                      </div>
                    </div>
                  </Panel>
                </div>
                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <Panel title="Campaign trend" sub="Revenue by controlled campaign code." bodyClassName="p-3">
                    <GrowthBarSeries
                      rows={summary.campaignPerformance.map((row) => ({
                        key: `${row.category}-${row.campaign}`,
                        label: row.campaign,
                        value: row.revenuePence,
                        display: formatGrowthMoneyGBP(row.revenuePence),
                      }))}
                      empty={{
                        title: "No campaign revenue",
                        detail: "No controlled campaign code has produced a paid order in this period.",
                      }}
                    />
                    {summary.historical.state === "NOT_INSTRUMENTED" && (
                      <p className="mt-3 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                        A time series is not drawn: {summary.historical.reason}
                      </p>
                    )}
                  </Panel>
                  <Panel
                    title="Attribution coverage"
                    sub="How much paid volume carries a controlled code."
                    bodyClassName="p-3"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <div
                        className="grid h-24 w-24 shrink-0 place-items-center rounded-full"
                        style={{
                          background: `conic-gradient(#d4af37 ${attribution.coveragePercent * 3.6}deg, rgba(255,255,255,.10) 0deg)`,
                        }}
                        role="img"
                        aria-label={`Attribution coverage ${attribution.coveragePercent.toFixed(1)} percent`}
                      >
                        <div className="grid h-[4.6rem] w-[4.6rem] place-items-center rounded-full bg-[var(--admin-panel,#151515)] text-center">
                          <strong className="text-base">{attribution.coveragePercent.toFixed(0)}%</strong>
                          <span className="text-[8px] uppercase tracking-[0.1em]">attributed</span>
                        </div>
                      </div>
                      <div className="grid min-w-0 flex-1 gap-2">
                        <CompactDigital label="Attributed orders" metric={attribution.attributedMetric} />
                        <CompactDigital
                          label="Unattributed orders"
                          metric={attribution.unattributedMetric}
                        />
                      </div>
                    </div>
                  </Panel>
                </div>
                <PerformancePanel title="Source performance" rows={summary.sourcePerformance} />
              </section>
            )}
            {tab === "seo" && (
              <section className="space-y-3">
                <GrowthKpiStrip label="Search performance key signals" columns={5}>
                  <OverviewKpi
                    label="Search Console"
                    value={text(data.seo.searchConsole)}
                    detail={data.seo.searchConsole.reason ?? data.seo.searchConsole.source}
                    status={data.seo.searchConsole.status}
                  />
                  <OverviewKpi
                    label="Impressions"
                    value={text(data.seo.impressions)}
                    detail="Search Console authority only"
                    status={data.seo.impressions.status}
                  />
                  <OverviewKpi
                    label="Clicks"
                    value={text(data.seo.clicks)}
                    detail="Search Console authority only"
                    status={data.seo.clicks.status}
                  />
                  <OverviewKpi
                    label="CTR"
                    value={text(data.seo.ctr)}
                    detail="Search Console authority only"
                    status={data.seo.ctr.status}
                  />
                  <OverviewKpi
                    label="Average position"
                    value={text(data.seo.averagePosition)}
                    detail="Search Console authority only"
                    status={data.seo.averagePosition.status}
                  />
                </GrowthKpiStrip>
                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel
                    title="Search visibility trend"
                    sub="Impressions and average position over time."
                    bodyClassName="p-3"
                  >
                    <SearchConsoleChartSlot metric={data.seo.trend} />
                  </Panel>
                  <Panel title="Clicks and impressions" sub="Click-through performance over time." bodyClassName="p-3">
                    <SearchConsoleChartSlot metric={data.seo.clicks} />
                  </Panel>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel title="Top queries" sub="Ranked search queries from Search Console." bodyClassName="p-3">
                    <SearchConsoleChartSlot metric={data.seo.topQueries} />
                  </Panel>
                  <Panel title="Top landing pages" sub="Ranked entry pages from Search Console." bodyClassName="p-3">
                    <SearchConsoleChartSlot metric={data.seo.topPages} />
                  </Panel>
                </div>
                <Panel
                  title="Technical SEO"
                  sub="MintVault-owned route configuration. This is not Google performance and never substitutes for it."
                  bodyClassName="grid gap-2 p-3 sm:grid-cols-3"
                >
                  <StatusTile label="Sitemap" metric={data.seo.technical.sitemap} />
                  <StatusTile label="Robots" metric={data.seo.technical.robots} />
                  <StatusTile label="Indexability" metric={data.seo.technical.indexabilityPolicy} />
                </Panel>
                <p className="text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                  Search performance comes only from Search Console; it is never guessed from request telemetry. Updated{" "}
                  {date(data.seo.lastUpdated)}
                </p>
              </section>
            )}
            {tab === "conversion" && (
              <section className="space-y-3">
                <GrowthKpiStrip label="Conversion key signals" columns={5}>
                  {conversionStages.map((stage) => (
                    <OverviewKpi
                      key={stage.key}
                      label={stage.label}
                      value={text(stage.metric)}
                      detail={stage.metric.reason ?? stage.metric.source}
                      status={stage.metric.status}
                    />
                  ))}
                  <OverviewKpi
                    label="Submission → paid"
                    value={text(data.conversion.submissionToPaid)}
                    detail="Canonical persisted events"
                    status={data.conversion.submissionToPaid.status}
                  />
                </GrowthKpiStrip>
                <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,.8fr)]">
                  <Panel
                    title="Conversion funnel"
                    sub="Submission → checkout → paid → cards. Each stage is its own measured count."
                    bodyClassName="p-3"
                  >
                    <GrowthFunnel
                      steps={conversionStages.map((stage) => ({
                        key: stage.key,
                        label: stage.label,
                        value: typeof stage.metric.value === "number" ? stage.metric.value : null,
                        detail: stage.metric.reason ?? stage.metric.source,
                      }))}
                    />
                  </Panel>
                  <Panel title="Stage conversion" sub="Rates require a canonical event and time authority." bodyClassName="p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <CompactDigital label="Submission → checkout" metric={data.conversion.submissionToCheckout} />
                      <CompactDigital label="Checkout → paid" metric={data.conversion.checkoutToPaid} />
                      <CompactDigital label="Submission → paid" metric={data.conversion.submissionToPaid} />
                      <CompactDigital label="Cards / paid order" metric={data.conversion.cardsPerPaidOrder} />
                    </div>
                  </Panel>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel title="Conversion trend" sub="Rate movement across periods." bodyClassName="p-3">
                    {data.conversion.comparison.state === "REAL" ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <CompactDigital label="Previous-period comparison" metric={data.conversion.comparison} />
                        <CompactDigital label="Submission → paid" metric={data.conversion.submissionToPaid} />
                      </div>
                    ) : (
                      <GrowthEmptyState
                        title="Trend collecting"
                        detail={
                          data.conversion.comparison.reason ??
                          "A conversion trend needs at least two comparable measured periods. None is invented in the meantime."
                        }
                      />
                    )}
                  </Panel>
                  <Panel title="Drop-off" sub="Shown only where cohort authority is sufficient." bodyClassName="p-3">
                    {data.conversion.dropOff.state === "REAL" ? (
                      <>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <CompactDigital label="Drop-off" metric={data.conversion.dropOff} />
                          <CompactDigital label="Cards / paid order" metric={data.conversion.cardsPerPaidOrder} />
                        </div>
                        <GrowthBarSeries
                          rows={conversionDropOff}
                          empty={{
                            title: "Insufficient data",
                            detail: "Consecutive measured stages are required before a drop-off can be attributed.",
                          }}
                        />
                      </>
                    ) : (
                      <GrowthEmptyState
                        title="Insufficient data"
                        detail={
                          data.conversion.dropOff.reason ??
                          "Cohort authority is not sufficient to attribute drop-off to a stage."
                        }
                      />
                    )}
                  </Panel>
                </div>
                <p className="text-[10px] text-[var(--admin-muted,#8a8a8a)]">{data.conversion.definition}</p>
              </section>
            )}
            {tab === "reviews" && (
              <section className="space-y-3" data-testid="growth-reviews">
                {reviews.isError ? (
                  <Retry message="Review reporting could not be loaded." retry={() => void reviews.refetch()} />
                ) : !reviews.data ? (
                  <Empty>Loading aggregate review lifecycle…</Empty>
                ) : (
                  <>
                    <GrowthKpiStrip label="Review lifecycle key signals" columns={7}>
                      <OverviewKpi
                        label="Eligible"
                        value={number(reviews.data.eligible)}
                        detail="Delivered completion"
                        status="GREEN"
                      />
                      <OverviewKpi
                        label="Scheduled"
                        value={number(reviews.data.scheduled)}
                        detail="Durable outbox"
                        status="GREEN"
                      />
                      <OverviewKpi
                        label="Sent"
                        value={number(reviews.data.sent)}
                        detail="Provider accepted"
                        status="GREEN"
                      />
                      <OverviewKpi
                        label="Clicked"
                        value={number(reviews.data.clicked)}
                        detail="Request link only"
                        status="GREEN"
                      />
                      <OverviewKpi
                        label="Failed"
                        value={number(reviews.data.deliveryFailed)}
                        detail="Bounded retry lifecycle"
                        status={reviews.data.deliveryFailed > 0 ? "AMBER" : "GREEN"}
                      />
                      <OverviewKpi
                        label="Suppressed"
                        value={number(reviews.data.suppressed)}
                        detail="Customer or admin preference"
                        status="GREEN"
                      />
                      <OverviewKpi
                        label="Published reviews"
                        value={reviews.data.publicReviews.state.replaceAll("_", " ")}
                        detail="No rating or count is ever inferred"
                        status="UNKNOWN"
                      />
                    </GrowthKpiStrip>
                    <div className="grid gap-3 xl:grid-cols-2">
                      <Panel
                        title="Review request lifecycle"
                        sub="Every request state, from eligibility to outcome."
                        bodyClassName="p-3"
                      >
                        <GrowthBarSeries
                          rows={[
                            ["eligible", "Eligible", reviews.data.eligible, "GREEN"],
                            ["scheduled", "Scheduled", reviews.data.scheduled, "GREEN"],
                            ["sent", "Sent", reviews.data.sent, "GREEN"],
                            ["clicked", "Clicked", reviews.data.clicked, "GREEN"],
                            ["failed", "Delivery failed", reviews.data.deliveryFailed, "RED"],
                            ["uncertain", "Delivery uncertain", reviews.data.deliveryUncertain, "AMBER"],
                            ["suppressed", "Suppressed", reviews.data.suppressed, "UNKNOWN"],
                            ["cancelled", "Cancelled", reviews.data.cancelled, "UNKNOWN"],
                          ].map(([key, label, value, status]) => ({
                            key: key as string,
                            label: label as string,
                            value: value as number,
                            display: number(value as number),
                            status: status as Health,
                          }))}
                          empty={{
                            title: "No review activity",
                            detail:
                              "No delivered completion has become eligible for a neutral review request in this period.",
                          }}
                        />
                      </Panel>
                      <Panel title="Delivery outcome" sub="Requests that reached a provider." bodyClassName="p-3">
                        {reviews.data.sent > 0 ? (
                          <GrowthFunnel
                            steps={[
                              { key: "eligible", label: "Eligible", value: reviews.data.eligible, detail: "Delivered completion" },
                              { key: "scheduled", label: "Scheduled", value: reviews.data.scheduled, detail: "Durable outbox" },
                              { key: "sent", label: "Sent", value: reviews.data.sent, detail: "Provider accepted" },
                              { key: "clicked", label: "Clicked", value: reviews.data.clicked, detail: "Request link only" },
                            ]}
                          />
                        ) : (
                          <GrowthEmptyState
                            title="No delivery yet"
                            detail="No review request has been accepted by a sending provider, so no delivery outcome exists to chart."
                          />
                        )}
                      </Panel>
                    </div>
                    <Panel
                      title="Review authority"
                      sub="Destination, sender and public reputation are separate authorities and are never inferred."
                      bodyClassName="grid gap-2 p-3 sm:grid-cols-3"
                    >
                      <StatusTile
                        label="Destination"
                        metric={reviewAuthorityMetric(
                          reviews.data.configuration.state === "READY" ? "CONNECTED" : "NOT_CONNECTED",
                          reviews.data.configuration.reason ?? "Approved HTTPS review destination is configured.",
                          reviews.data.lastUpdated
                        )}
                      />
                      <StatusTile
                        label="Sender"
                        metric={reviewAuthorityMetric(
                          reviews.data.configuration.state === "READY" ? "CONNECTED" : "NOT_CONNECTED",
                          reviews.data.configuration.reason ?? "Verified MintVault sender and token authority are configured.",
                          reviews.data.lastUpdated
                        )}
                      />
                      <StatusTile
                        label="Public reputation"
                        metric={reviewAuthorityMetric(
                          "NOT_CONNECTED",
                          reviews.data.publicReviews.reason,
                          reviews.data.lastUpdated
                        )}
                      />
                    </Panel>
                    <p className="text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                      {reviews.data.definition} · Updated {date(reviews.data.lastUpdated)}
                    </p>
                  </>
                )}
              </section>
            )}
            {tab === "health" && (
              <section className="space-y-3">
                <GrowthKpiStrip label="Site health key signals" columns={7}>
                  <OverviewKpi
                    label="Site status"
                    value={text(data.siteHealth.site)}
                    detail={data.siteHealth.site.source}
                    status={data.siteHealth.site.status}
                  />
                  <OverviewKpi
                    label="CPU"
                    value={text(data.siteHealth.cpu)}
                    detail="Current process"
                    status={data.siteHealth.cpu.status}
                  />
                  <OverviewKpi
                    label="RAM"
                    value={text(data.siteHealth.memory)}
                    detail="Current process"
                    status={data.siteHealth.memory.status}
                  />
                  <OverviewKpi
                    label="Public P95"
                    value={
                      publicExperience.worstP95LatencyMs == null
                        ? publicExperience.headline
                        : `${publicExperience.worstP95LatencyMs} ms`
                    }
                    detail="Customer-facing route classes"
                    status={publicExperience.status}
                  />
                  <OverviewKpi
                    label="5xx"
                    value={text(data.siteHealth.fiveXErrorRate)}
                    detail="Rolling window"
                    status={data.siteHealth.fiveXErrorRate.status}
                  />
                  <OverviewKpi
                    label="DB pressure"
                    value={text(data.siteHealth.databasePressure)}
                    detail={text(data.siteHealth.databaseLatency)}
                    status={data.siteHealth.databasePressure.status}
                  />
                  <OverviewKpi
                    label="Machines"
                    value={text(data.siteHealth.flyMachines)}
                    detail="Fly telemetry"
                    status={data.siteHealth.flyMachines.status}
                  />
                </GrowthKpiStrip>
                <Panel
                  title="Experience split"
                  sub="Customer-facing routes and this console are scored separately; one never colours the other."
                  bodyClassName=""
                >
                  <ExperienceSplit data={data} />
                </Panel>
                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <Panel title="Resource utilisation" sub="CPU and RAM · current process" bodyClassName="p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <RadialRing label="CPU" metric={data.siteHealth.cpu} />
                      <RadialRing label="RAM" metric={data.siteHealth.memory} />
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <DigitalMetric label="Request rate" metric={data.siteHealth.requestRate} />
                      <RadialRing label="DB pressure" metric={data.siteHealth.databasePressure} />
                    </div>
                  </Panel>
                  <Panel
                    title="Traffic and latency"
                    sub="Real p95 by fixed route class; no historical series is invented."
                    bodyClassName=""
                  >
                    <LatencyTrendChart diagnostics={data.performanceDiagnostics} />
                  </Panel>
                  <Panel title="Error trend" sub="5xx by route class in the rolling window." bodyClassName="p-3">
                    <GrowthBarSeries
                      rows={data.performanceDiagnostics.trafficClasses.map((entry) => ({
                        key: entry.key,
                        label: entry.label,
                        value: entry.fiveXCount,
                        display: `${number(entry.fiveXCount)} · ${entry.errorRatePercent == null ? "—" : `${entry.errorRatePercent.toFixed(2)}%`}`,
                        status: entry.fiveXCount > 0 ? ("RED" as Health) : ("GREEN" as Health),
                      }))}
                      empty={{
                        title: "No server errors",
                        detail:
                          "No route class recorded a 5xx response in this rolling 60-minute window. Nothing is plotted because nothing failed.",
                      }}
                    />
                  </Panel>
                </div>
                <Panel
                  title="Service health"
                  sub="Unknown means missing authority, not healthy."
                  bodyClassName="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6"
                >
                  <StatusTile label="Database" metric={data.siteHealth.database} />
                  <StatusTile label="Payments" metric={data.siteHealth.payments} />
                  <StatusTile label="Email" metric={data.siteHealth.email} />
                  <StatusTile label="Partner API" metric={data.siteHealth.partnerApi} />
                  <StatusTile label="Scanner API" metric={data.siteHealth.scannerApi} />
                  <StatusTile
                    label="AI / model"
                    metric={aiModelServiceMetric(data.performanceDiagnostics, data.siteHealth.lastUpdated)}
                  />
                </Panel>
                <Panel
                  title="Route performance"
                  sub={`Fixed safe route templates from machine ${data.performanceDiagnostics.machineRef}. No query string, customer identifier or request body reaches this table.`}
                  bodyClassName=""
                >
                  <RoutePerformanceTable diagnostics={data.performanceDiagnostics} />
                </Panel>
                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <Panel title="Performance signal" sub="Deterministic server rule." bodyClassName="p-3">
                    <div className={`rounded-xl border p-3 ${tone(data.performanceInsight.status)}`} data-testid="growth-performance-insight">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">{data.performanceInsight.title}</h3>
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
                      <p className="mt-2 text-xs">{data.performanceInsight.detail}</p>
                      <p className="mt-2 text-[10px] uppercase tracking-[0.1em] opacity-75">
                        {data.performanceInsight.recommendation}
                      </p>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {data.performanceDiagnostics.dependencies.length === 0 ? (
                        <p className="text-[11px] text-[var(--admin-muted,#8a8a8a)] sm:col-span-2">
                          No measured dependency timing is available in this window.
                        </p>
                      ) : (
                        data.performanceDiagnostics.dependencies.map((entry) => (
                          <div
                            key={entry.dependency}
                            className="rounded-lg border border-[var(--admin-line,#333)] bg-black/15 px-3 py-2"
                          >
                            <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                              {entry.dependency.replaceAll("_", " ")}
                            </p>
                            <p className="mt-1 text-xs font-semibold">
                              {entry.sampleCount
                                ? `${entry.p95LatencyMs ?? "—"} ms p95 · ${entry.sampleCount} samples`
                                : "Not instrumented"}
                            </p>
                            {entry.sampleCount > 0 && (
                              <p className="mt-0.5 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                                {entry.failures} failures
                              </p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </Panel>
                  <Panel
                    title="Infrastructure"
                    sub="Read-only provider telemetry; no control on this page mutates infrastructure."
                    bodyClassName=""
                  >
                    <InfrastructureOverview data={data} />
                  </Panel>
                </div>
                <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
                  <Panel
                    title="Fly machines"
                    sub="Machine detail appears only from an approved least-privilege server authority."
                    bodyClassName="p-3"
                  >
                    {data.infrastructure.fly.machines.length === 0 ? (
                      <GrowthEmptyState
                        title="Fly telemetry not connected"
                        detail="No machine count, health, version or SHA is inferred while the provider authority is absent."
                      />
                    ) : (
                      <div className="grid gap-2">
                        {data.infrastructure.fly.machines.map((machine) => (
                          <article
                            key={machine.machineRef}
                            className={`rounded-lg border p-3 ${tone(machine.status)}`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <strong className="text-xs">{machine.machineRef}</strong>
                              <span className="text-[10px] uppercase tracking-[0.1em]">
                                {machine.region} · {machine.status} · {text(machine.deployedVersion)}
                              </span>
                            </div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                              <CompactRing label="CPU" metric={machine.cpu} />
                              <CompactRing label="RAM" metric={machine.memory} />
                              <CompactDigital label="P95" metric={machine.p95Latency} />
                              <CompactDigital label="Requests" metric={machine.requestCount} />
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </Panel>
                  <Panel title="Database and cost" sub="Availability, pressure and month-to-date provider billing." bodyClassName="p-3">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <StatusTile label="Fly connection" metric={data.infrastructure.fly.connection} />
                      <StatusTile label="Availability" metric={data.infrastructure.neon.availability} />
                      <StatusTile label="Connections" metric={data.infrastructure.neon.connectionPressure} />
                      <StatusTile label="Latency" metric={data.infrastructure.neon.latency} />
                      <StatusTile label="Compute" metric={data.infrastructure.neon.compute} />
                      <StatusTile label="Storage" metric={data.infrastructure.neon.storage} />
                      <StatusTile label="Recovery" metric={data.infrastructure.neon.pointInTimeRecovery} />
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {data.infrastructure.costs.providers.map((cost) => (
                        <div
                          key={cost.provider}
                          className={`rounded-lg border px-3 py-2 ${tone(cost.status)}`}
                          title={cost.reason ?? "Authoritative provider billing"}
                        >
                          <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">{cost.provider} · MTD</p>
                          <p className="mt-1 break-words text-xs font-semibold leading-snug">
                            {cost.state === "REAL" && typeof cost.amountMajor === "number" && cost.sourceCurrency
                              ? (formatProviderMoney(cost.amountMajor, cost.sourceCurrency) ?? "Invalid currency")
                              : cost.state.replaceAll("_", " ")}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <StatusTile label="Normalised total" metric={data.infrastructure.costs.normalisedTotalGBP} />
                      <StatusTile label="Cost / paid card" metric={data.infrastructure.costs.costPerPaidCardGBP} />
                      <StatusTile label="Cost / paid order" metric={data.infrastructure.costs.costPerPaidOrderGBP} />
                    </div>
                    <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                      {data.infrastructure.costs.currencyPolicy} · Budget{" "}
                      {data.infrastructure.budget.state.replaceAll("_", " ")} · automatic shutdown DISABLED · automatic
                      spend DISABLED · Neon mutation UNAVAILABLE
                    </p>
                  </Panel>
                </div>
              </section>
            )}
            {tab === "partners" && (
              <section className="space-y-3">
                <GrowthKpiStrip label="Partner pipeline key signals" columns={6}>
                  <OverviewKpi
                    label="Applications"
                    value={number(data.partnerPipeline.total.value)}
                    detail="All measured applications"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="New"
                    value={number(data.partnerPipeline.new.value)}
                    detail="Awaiting first contact"
                    status={data.partnerPipeline.new.value > 0 ? "AMBER" : "GREEN"}
                  />
                  <OverviewKpi
                    label="Contacted"
                    value={number(data.partnerPipeline.contacted.value)}
                    detail="Outreach recorded"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Qualified"
                    value={number(data.partnerPipeline.qualified.value)}
                    detail="No automatic provisioning"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Onboarding"
                    value={number(data.partnerPipeline.onboarding.value)}
                    detail="Partner Management owns accounts"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Active Partners"
                    value={
                      summary.activePartners.state === "MEASURED"
                        ? number(summary.activePartners.value)
                        : "Not instrumented"
                    }
                    detail={
                      summary.activePartners.state === "MEASURED"
                        ? "Operational Partner accounts"
                        : summary.activePartners.reason
                    }
                    status={summary.activePartners.state === "MEASURED" ? "GREEN" : "UNKNOWN"}
                  />
                </GrowthKpiStrip>
                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <Panel
                    title="Pipeline progression"
                    sub="Each bar is a current application state, not a cumulative funnel stage, so a later state can exceed an earlier one."
                    bodyClassName="p-3"
                  >
                    <GrowthFunnel
                      steps={[
                        { key: "total", label: "All applications", value: data.partnerPipeline.total.value, detail: "Measured applications" },
                        { key: "contacted", label: "Contacted", value: data.partnerPipeline.contacted.value, detail: "Outreach recorded" },
                        { key: "qualified", label: "Qualified", value: data.partnerPipeline.qualified.value, detail: "Manually qualified" },
                        { key: "onboarding", label: "Onboarding", value: data.partnerPipeline.onboarding.value, detail: "Handed to Partner Management" },
                      ]}
                    />
                  </Panel>
                  <Panel title="Pipeline state" sub="Every application state, including closed." bodyClassName="p-3">
                    <GrowthBarSeries
                      rows={[
                        ["new", "New", data.partnerPipeline.new.value, "AMBER"],
                        ["contacted", "Contacted", data.partnerPipeline.contacted.value, "GREEN"],
                        ["qualified", "Qualified", data.partnerPipeline.qualified.value, "GREEN"],
                        ["onboarding", "Onboarding", data.partnerPipeline.onboarding.value, "GREEN"],
                        ["not_a_fit", "Not a fit", data.partnerPipeline.notAFit.value, "UNKNOWN"],
                      ].map(([key, label, value, status]) => ({
                        key: key as string,
                        label: label as string,
                        value: value as number,
                        display: number(value as number),
                        status: status as Health,
                      }))}
                      empty={{
                        title: "No applications",
                        detail: "No Partner application has been received in this measured view.",
                      }}
                    />
                  </Panel>
                  <Panel
                    title="Applications by source"
                    sub="Acquisition source of measured applications."
                    bodyClassName="p-3"
                  >
                    <GrowthBarSeries
                      rows={summary.sourcePerformance.map((row) => ({
                        key: `partner-${row.category}`,
                        label: row.category.replaceAll("_", " "),
                        value: row.partnerApplications,
                        display: number(row.partnerApplications),
                      }))}
                      empty={{
                        title: "No measured source",
                        detail: "No Partner application in this period carried a controlled acquisition source.",
                      }}
                    />
                  </Panel>
                </div>
                <Panel
                  title="Partner operational authority"
                  sub="Growth qualifies applications; Partner Management owns operational Partner accounts."
                  bodyClassName="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <PartnerValue label="Active Partners" value={summary.activePartners} />
                  <PartnerValue label="Partner-originated cards" value={summary.partnerCardsPerPartner} />
                  <PartnerValue label="Partner revenue" value={summary.partnerRevenue} />
                  <PartnerValue label="Repeat customer rate" value={summary.repeatCustomerRate} />
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
              <section className="space-y-3">
                <GrowthKpiStrip label="Campaign key signals" columns={5}>
                  <OverviewKpi
                    label="Active measured campaigns"
                    value={number(campaigns.activeCount)}
                    detail="Controlled codes with measured results"
                    status={campaigns.activeCount > 0 ? "GREEN" : "UNKNOWN"}
                  />
                  <OverviewKpi
                    label="Attributed orders"
                    value={number(campaigns.paidSubmissions)}
                    detail="Verified paid authority"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Attributed revenue"
                    value={formatGrowthMoneyGBP(campaigns.revenuePence)}
                    detail="Campaign-attributed, GBP"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Partner applications"
                    value={number(campaigns.partnerApplications)}
                    detail="Distinct from paid orders"
                    status="GREEN"
                  />
                  <OverviewKpi
                    label="Best campaign"
                    value={campaigns.bestLabel}
                    detail={campaigns.bestDetail}
                    status={campaigns.bestLabel === "No measured campaign" ? "UNKNOWN" : "GREEN"}
                  />
                </GrowthKpiStrip>
                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel title="Revenue by campaign" sub="Verified paid revenue by controlled code." bodyClassName="p-3">
                    <GrowthBarSeries
                      rows={summary.campaignPerformance.map((row) => ({
                        key: `rev-${row.category}-${row.campaign}`,
                        label: row.campaign,
                        value: row.revenuePence,
                        display: formatGrowthMoneyGBP(row.revenuePence),
                      }))}
                      empty={{
                        title: "No campaign revenue",
                        detail: "No controlled campaign code has produced a paid order in this period.",
                      }}
                    />
                  </Panel>
                  <Panel
                    title="Orders and applications by campaign"
                    sub="Paid orders and Partner applications remain distinct outcomes."
                    bodyClassName="p-3"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                          Paid orders
                        </p>
                        <GrowthBarSeries
                          rows={summary.campaignPerformance.map((row) => ({
                            key: `ord-${row.category}-${row.campaign}`,
                            label: row.campaign,
                            value: row.paidSubmissions,
                            display: number(row.paidSubmissions),
                          }))}
                          empty={{ title: "No paid orders", detail: "No campaign produced a paid order." }}
                        />
                      </div>
                      <div>
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                          Partner applications
                        </p>
                        <GrowthBarSeries
                          rows={summary.campaignPerformance.map((row) => ({
                            key: `app-${row.category}-${row.campaign}`,
                            label: row.campaign,
                            value: row.partnerApplications,
                            display: number(row.partnerApplications),
                          }))}
                          empty={{ title: "No applications", detail: "No campaign produced a Partner application." }}
                        />
                      </div>
                    </div>
                    {summary.historical.state === "NOT_INSTRUMENTED" && (
                      <p className="mt-3 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                        Performance over time is not drawn: {summary.historical.reason}
                      </p>
                    )}
                  </Panel>
                </div>
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
                        <div className="flex flex-col gap-2 rounded-lg border border-[var(--admin-gold,#d4af37)]/45 bg-[linear-gradient(115deg,rgba(212,175,55,.12),transparent_60%)] p-3 sm:flex-row sm:items-center">
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--admin-gold-hi,#ecd585)]">
                              Tracked link ready
                            </p>
                            <code className="mt-1 block min-w-0 break-all text-xs">{link.data.url}</code>
                          </div>
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
