/** GB-04B Super Admin Growth Command. All unavailable authority stays visible as unavailable. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
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
  ["health", "Site Health"],
  ["campaigns", "Campaigns"],
] as const;
const LEAD_STATES = ["NEW", "CONTACTED", "QUALIFIED", "NOT_A_FIT", "ONBOARDING"] as const;
type Period = (typeof PERIODS)[number];
type Tab = (typeof TABS)[number][0];
type LeadState = (typeof LEAD_STATES)[number];
type Health = "GREEN" | "AMBER" | "RED" | "UNKNOWN";
type State = "REAL" | "NOT_CONNECTED" | "NOT_INSTRUMENTED" | "STALE" | "ERROR";
type Metric = {
  state: State;
  status: Health;
  value?: number | string;
  unit?: string;
  source: string;
  reason?: string;
  lastUpdated: string | null;
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
type Intelligence = {
  period: Period;
  summary: Summary;
  partnerPipeline: Summary["partnerApplications"];
  livePulse: {
    submissionStarts: Metric;
    checkoutStarts: Metric;
    paidSubmissions: Metric;
    paidCards: Metric;
    partnerApplications: Metric;
    requestsPerMinute: Metric;
    requestsLastHour: Metric;
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
    | "flyMachines"
    | "payments"
    | "email"
    | "partnerApi"
    | "scannerApi",
    Metric
  > & { lastUpdated: string };
  capacity: {
    status: Health;
    label: string;
    recommendation: string;
    evidence: string[];
    thresholdModel: string;
    automaticScalingEnabled: false;
  };
  seo: {
    searchConsole: Metric;
    impressions: Metric;
    clicks: Metric;
    ctr: Metric;
    averagePosition: Metric;
    topQueries: Metric;
    topPages: Metric;
    technical: { sitemap: Metric; robots: Metric; indexabilityPolicy: Metric };
    lastUpdated: string;
  };
  conversion: {
    stages: Array<{ key: string; label: string; metric: Metric }>;
    dropOff: Metric;
    comparison: Metric;
    definition: string;
  };
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

const money = (pence: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
const number = (value: number) => new Intl.NumberFormat("en-GB").format(value);
const date = (value: string | null) =>
  value && !Number.isNaN(new Date(value).getTime())
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "Not available";
const text = (metric: Metric) =>
  metric.state === "REAL"
    ? `${metric.value ?? "Measured"}${metric.unit ? ` ${metric.unit}` : ""}`
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
const initialTab = (): Tab => {
  const raw = new URLSearchParams(window.location.search).get("tab");
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
function Gauge({ label, metric }: { label: string; metric: Metric }) {
  return (
    <div
      className={`rounded border p-3 ${tone(metric.status)}`}
      data-testid={`growth-gauge-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}
    >
      <div className="flex justify-between gap-2">
        <p className="text-xs font-medium uppercase">{label}</p>
        <span className="text-[10px] font-semibold">{metric.status}</span>
      </div>
      <p className="mt-2 text-xl font-semibold">{text(metric)}</p>
      <p className="mt-2 text-xs opacity-80">{metric.reason ?? metric.source}</p>
    </div>
  );
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
      className={`rounded-full border px-3 py-1.5 text-xs font-medium ${active ? "border-[var(--admin-gold,#d4af37)] bg-[rgba(212,175,55,.12)] text-[var(--admin-gold-hi,#ecd585)]" : "border-[var(--admin-line,#333)] text-[var(--admin-muted,#8a8a8a)]"}`}
    >
      {label}
    </button>
  );
}

export default function GrowthCommandPage() {
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<Period>("30d");
  const [tab, setTab] = useState<Tab>(initialTab);
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
  const refreshCommand = () => {
    manualRefresh.current = true;
    setRefreshing(true);
    void command.refetch().finally(() => setRefreshing(false));
  };
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
  });
  const data = command.data;
  const summary = data?.summary;
  const selected = detail.data?.lead;
  const external = safeExternalUrl(selected?.webPresence);
  const selectTab = (next: Tab) => {
    setTab(next);
    navigate(`/admin/growth?tab=${next}`);
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
              Revenue, paid cards, Partner leads, site evidence and controlled campaigns.
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
              disabled={command.isFetching || refreshing}
              data-testid="growth-refresh"
            >
              <RefreshCw size={14} /> {command.isFetching || refreshing ? "Refreshing" : "Refresh"}
            </AdminButton>
          </div>
        </header>
        <nav aria-label="Growth Command sections" className="flex gap-2 overflow-x-auto pb-1" data-testid="growth-tabs">
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
            {tab === "overview" && (
              <section className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <StatCard
                    label="Paid cards"
                    value={number(summary.paid.paidCards.value)}
                    foot="Stripe-verified"
                    testId="growth-paid-cards"
                  />
                  <StatCard
                    label="Grading revenue"
                    value={money(summary.paid.revenuePence.value)}
                    foot="Actual Stripe amount"
                    testId="growth-revenue"
                  />
                  <StatCard
                    label="Paid submissions"
                    value={number(summary.paid.paidSubmissions.value)}
                    foot="Verified payment only"
                    testId="growth-paid-submissions"
                  />
                  <StatCard
                    label="Average cards / order"
                    value={summary.paid.averageCardsPerPaidOrder.value.toFixed(2)}
                    foot="Measured paid orders"
                    testId="growth-average-cards"
                  />
                  <StatCard
                    label="Qualified Partner leads"
                    value={number(summary.partnerApplications.qualified.value)}
                    foot="No automatic provisioning"
                    testId="growth-qualified-leads"
                  />
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Panel
                    title="Live Pulse"
                    sub="Recent persisted business activity; fleet request telemetry needs a secure provider adapter."
                  >
                    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                      <MetricCard label="Submission records" metric={data.livePulse.submissionStarts} />
                      <MetricCard label="Checkout starts" metric={data.livePulse.checkoutStarts} />
                      <MetricCard label="Paid submissions" metric={data.livePulse.paidSubmissions} />
                      <MetricCard label="Paid cards" metric={data.livePulse.paidCards} />
                      <MetricCard label="Partner applications" metric={data.livePulse.partnerApplications} />
                      <MetricCard label="Requests / min" metric={data.livePulse.requestsPerMinute} />
                    </div>
                  </Panel>
                  <Panel
                    title="Capacity headroom"
                    sub="Qualitative recommendation only; automatic scaling is disabled."
                  >
                    <div className="space-y-3 p-4">
                      <Gauge
                        label="Capacity"
                        metric={{
                          state: data.capacity.status === "UNKNOWN" ? "NOT_CONNECTED" : "REAL",
                          status: data.capacity.status,
                          value: data.capacity.label.replaceAll("_", " "),
                          source: data.capacity.thresholdModel,
                          reason: data.capacity.evidence.join(" "),
                          lastUpdated: data.generatedAt,
                        }}
                      />
                      <p className="text-sm">
                        Recommendation: <strong>{data.capacity.recommendation.replaceAll("_", " ")}</strong>
                      </p>
                    </div>
                  </Panel>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <PerformancePanel title="Acquisition mix" rows={summary.sourcePerformance} />
                  <Insights insights={data.insights} />
                </div>
              </section>
            )}
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
                  <MetricCard label="Drop-off" metric={data.conversion.dropOff} />
                  <MetricCard label="Previous-period comparison" metric={data.conversion.comparison} />
                </div>
                <p className="px-4 pb-4 text-xs text-[var(--admin-muted,#8a8a8a)]">{data.conversion.definition}</p>
              </Panel>
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
                  </div>
                </Panel>
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
                            <p className="font-medium">Ready for manual Partner Management handoff</p>
                            <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">
                              No tenant, user, location, station, credit or approval has been created.
                            </p>
                            <Link
                              className={`${adminButtonClass({ size: "sm", variant: "gold", className: "mt-2 inline-flex" })}`}
                              href={`/admin/partners/settings?growthLead=${encodeURIComponent(selected.id)}`}
                            >
                              Open Partner Management <ArrowUpRight size={14} />
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
                          onChange={(value) => setForm((current) => ({ ...current, target: value }))}
                        />
                        <Select
                          label="Source"
                          value={form.source}
                          options={options.data.sources.map((value) => ({ value, label: value }))}
                          onChange={(value) => setForm((current) => ({ ...current, source: value }))}
                        />
                        <Select
                          label="Medium"
                          value={form.medium}
                          options={options.data.mediums.map((value) => ({ value, label: value }))}
                          onChange={(value) => setForm((current) => ({ ...current, medium: value }))}
                        />
                        <Select
                          label="Campaign"
                          value={form.campaign}
                          options={options.data.campaigns.map((value) => ({ value, label: value }))}
                          onChange={(value) => setForm((current) => ({ ...current, campaign: value }))}
                        />
                        <Select
                          label="Content (optional)"
                          value={form.content}
                          options={[
                            { value: "", label: "No content variant" },
                            ...options.data.contents.map((value) => ({ value, label: value })),
                          ]}
                          onChange={(value) => setForm((current) => ({ ...current, content: value }))}
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

function Insights({ insights }: { insights: Intelligence["insights"] }) {
  return (
    <Panel title="Actionable insights" sub="Deterministic rules with traceable inputs — not AI-generated commentary.">
      {insights.length === 0 ? (
        <Empty>Insufficient measured activity for an insight.</Empty>
      ) : (
        <div className="divide-y divide-[var(--admin-line,#333)]">
          {insights.map((item) => (
            <article key={item.id} className="p-4">
              <div className="flex gap-2">
                <Badge
                  variant={
                    item.priority === "CRITICAL"
                      ? "red"
                      : item.priority === "ACTION"
                        ? "act"
                        : item.priority === "OPPORTUNITY"
                          ? "prog"
                          : "neu"
                  }
                >
                  {item.priority}
                </Badge>
                <h3 className="font-medium">{item.title}</h3>
              </div>
              <p className="mt-2 text-sm text-[var(--admin-ink-dim,#b9b2a1)]">{item.detail}</p>
              <p className="mt-2 text-xs">Recommended: {item.recommendation}</p>
              <p className="mt-2 text-[10px] text-[var(--admin-muted,#8a8a8a)]">
                Rule {item.trace.ruleId} · {item.trace.window} · {item.trace.result}
              </p>
            </article>
          ))}
        </div>
      )}
    </Panel>
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
                  <td className="p-3">{money(row.revenuePence)}</td>
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
                  <td className="p-3">{money(row.revenuePence)}</td>
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
