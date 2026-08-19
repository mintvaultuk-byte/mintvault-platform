import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import type {
  CommandCentreDashboardResponse,
  CommandCentreKpiEnvelope,
  CommandCentreKpiStatus,
  CommandCentrePeriod,
} from "@shared/command-centre";
import AdminShell from "@/components/admin/admin-shell";
import { apiRequest } from "@/lib/queryClient";

const REFRESH_COOLDOWN_MS = 30_000;
const KPI_LABELS: Record<string, string> = {
  "partner-network-state": "Partner network state",
  "partner-onboarding-blocked": "Blocked Partner onboarding",
  "partner-credit-projection": "Partner credit projection",
  "station-lifecycle-state": "Station lifecycle state",
  "connector-exception-count": "Connector exceptions",
  "non-terminal-submissions": "Non-terminal submissions",
  "scan-queue-backlog": "Scan queue backlog",
  "grading-queue-backlog": "Grading queue backlog",
  "grade-review-awaiting-decision": "Grades awaiting review",
  "print-batch-exceptions": "Print batch exceptions",
  "ownership-transfer-exceptions": "Ownership transfer exceptions",
  "paid-submissions-recorded": "Paid submissions recorded",
};

function displayValue(kpi: CommandCentreKpiEnvelope): string {
  if (kpi.status === "VALUE" || kpi.status === "ZERO") {
    return typeof kpi.value === "number"
      ? String(kpi.value)
      : Object.entries(kpi.value).map(([key, value]) => key + ": " + value).join(" · ");
  }
  if (kpi.status === "STALE") {
    return typeof kpi.lastValue === "number"
      ? String(kpi.lastValue)
      : Object.entries(kpi.lastValue).map(([key, value]) => key + ": " + value).join(" · ");
  }
  return "—";
}

function statusDescription(kpi: CommandCentreKpiEnvelope): string {
  if (kpi.status === "VALUE" || kpi.status === "ZERO") return "Canonical source value";
  if (kpi.status === "STALE") return "Last known source value; refresh is required";
  if (kpi.status === "NOT_AUTHORISED") return "This source is not authorised for this session";
  return "Source unavailable: " + kpi.reasonCode;
}

function isProblemStatus(status: CommandCentreKpiStatus): boolean {
  return !["VALUE", "ZERO"].includes(status);
}

export default function AdminCommandCentrePage() {
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<CommandCentrePeriod>("today");
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [expandedCapability, setExpandedCapability] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState(0);
  const dashboardQuery = useQuery<CommandCentreDashboardResponse>({
    queryKey: ["/api/admin/command/dashboard?period=" + period],
    queryFn: async () => (await apiRequest("GET", "/api/admin/command/dashboard?period=" + period)).json(),
    retry: false,
  });
  const dashboard = dashboardQuery.isError ? undefined : dashboardQuery.data;
  const refreshRemaining = Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt));
  useEffect(() => {
    if (!lastRefreshAt) return;
    const timer = window.setTimeout(() => setLastRefreshAt(0), REFRESH_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [lastRefreshAt]);
  const canRefresh = refreshRemaining === 0 && !dashboardQuery.isFetching;
  const refresh = async () => {
    if (!canRefresh) return;
    setLastRefreshAt(Date.now());
    await dashboardQuery.refetch();
  };
  const capabilities = useMemo(() => {
    if (!dashboard) return [];
    const needle = search.trim().toLowerCase();
    return dashboard.registry.filter((capability) => {
      if (department !== "all" && capability.departmentId !== department) return false;
      if (needle && ![capability.displayName, capability.outcome, capability.id].join(" ").toLowerCase().includes(needle)) return false;
      if (statusFilter !== "all" && !capability.kpiIds.some((id) => dashboard.kpis[id].status === statusFilter)) return false;
      return true;
    });
  }, [dashboard, department, search, statusFilter]);

  const handleLogout = async () => {
    await apiRequest("POST", "/api/admin/logout");
    navigate("/cert");
  };

  return (
    <AdminShell activeTab="command-centre" onTabChange={() => navigate("/admin")} onLogout={handleLogout} title="Command Centre" crumb="MINTVAULT · INSIGHT" disableEnvironmentPolling commandCentreMode commandCentreAvailable={dashboard !== undefined}>
      <section className="space-y-6 p-4 md:p-6" aria-live="polite" data-testid="command-centre-page">
        <nav aria-label="Command Centre breadcrumb" className="text-sm text-muted-foreground">
          <Link href="/admin" data-testid="command-centre-breadcrumb-admin" className="underline">Admin</Link>
          <span aria-hidden="true"> / </span><span>Command Centre</span>
        </nav>
        <div className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Command Centre</h1>
            <p className="mt-1 text-sm text-muted-foreground">Read-only, source-labelled operational overview.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="text-sm" htmlFor="command-centre-period">Period</label>
            <select id="command-centre-period" data-testid="command-centre-period" value={period} onChange={(event) => setPeriod(event.target.value as CommandCentrePeriod)} className="rounded border border-input bg-background px-2 py-1 text-foreground">
              <option className="bg-background text-foreground" value="today">Today</option><option className="bg-background text-foreground" value="month_to_date">Month to date</option>
            </select>
            <button type="button" data-testid="command-centre-refresh" onClick={refresh} disabled={!canRefresh} className="rounded border border-input px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60">
              {dashboardQuery.isFetching ? "Refreshing…" : refreshRemaining > 0 ? "Refresh available shortly" : "Refresh"}
            </button>
          </div>
        </div>

        {dashboardQuery.isLoading && <p data-testid="command-centre-loading">Loading source-labelled dashboard…</p>}
        {dashboardQuery.isError && <div data-testid="command-centre-unavailable"><h2 className="text-lg font-semibold">Command Centre unavailable</h2><p className="mt-1 text-sm text-muted-foreground">This workspace is not available for the current session or source state.</p></div>}
        {dashboard && <>
          <p className="text-xs text-muted-foreground" data-testid="command-centre-as-of">Snapshot: {new Date(dashboard.asOf).toLocaleString()}</p>
          {dashboard.partialSourceIds.length > 0 && <p className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="command-centre-partial">Some canonical sources are unavailable or need review. Their KPI cards show the applicable status.</p>}
          <section aria-labelledby="command-centre-kpis"><div className="mb-3 flex items-center justify-between"><h2 id="command-centre-kpis" className="text-lg font-semibold">Key performance indicators</h2><span className="text-xs text-muted-foreground">{Object.keys(dashboard.kpis).length} canonical KPI cards</span></div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Object.entries(dashboard.kpis).map(([id, kpi]) => <Link key={id} href={kpi.deepLink} data-testid={"command-centre-kpi-" + id} className="command-centre-surface rounded border border-border p-4 hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"><div className="flex items-start justify-between gap-3"><h3 className="font-medium">{KPI_LABELS[id] ?? id}</h3><span className={isProblemStatus(kpi.status) ? "text-amber-700" : "text-emerald-700"}>{kpi.status}</span></div><p className="mt-3 text-xl font-semibold">{displayValue(kpi)}</p><p className="mt-2 text-xs text-muted-foreground">{statusDescription(kpi)}</p><p className="mt-2 text-xs text-muted-foreground">Source: {kpi.source}</p></Link>)}
            </div>
          </section>
          <section aria-labelledby="command-centre-attention"><h2 id="command-centre-attention" className="mb-3 text-lg font-semibold">Attention Centre</h2>{dashboard.attention.length === 0 ? <p data-testid="command-centre-attention-empty" className="rounded border border-border p-4 text-sm text-muted-foreground">No deterministic attention items are currently present.</p> : <div className="space-y-2">{dashboard.attention.map((item) => <Link key={item.itemId} href={item.deepLink} data-testid={"command-centre-attention-" + item.ruleId} className="command-centre-surface block rounded border border-border p-4 hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"><div className="flex items-start justify-between gap-3"><div><h3 className="font-medium">{item.title}</h3><p className="mt-1 text-sm text-muted-foreground">{item.reason}</p></div><span className="text-xs font-semibold">{item.severity}</span></div><p className="mt-2 text-xs text-muted-foreground">Source: {item.source}</p></Link>)}</div>}</section>
          <section aria-labelledby="command-centre-explorer" className="rounded border border-border p-4"><div className="flex items-center justify-between gap-4"><div><h2 id="command-centre-explorer" className="text-lg font-semibold">Company and domain explorer</h2><p className="text-sm text-muted-foreground">The approved V1 capability registry and its canonical destinations.</p></div><button type="button" data-testid="command-centre-explorer-toggle" onClick={() => setExplorerOpen((open) => !open)} className="rounded border border-input px-3 py-1 text-sm" aria-expanded={explorerOpen}>{explorerOpen ? "Collapse" : "Expand"}</button></div>
            {explorerOpen && <><div className="mt-4 grid gap-2 md:grid-cols-3"><label className="text-sm">Search capabilities<input data-testid="command-centre-search" value={search} onChange={(event) => setSearch(event.target.value)} className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground" /></label><label className="text-sm">Department<select data-testid="command-centre-department-filter" value={department} onChange={(event) => setDepartment(event.target.value)} className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground"><option className="bg-background text-foreground" value="all">All departments</option>{[...new Set(dashboard.registry.map((item) => item.departmentId))].map((id) => <option className="bg-background text-foreground" key={id} value={id}>{id}</option>)}</select></label><label className="text-sm">KPI status<select data-testid="command-centre-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground"><option className="bg-background text-foreground" value="all">All statuses</option>{["VALUE", "ZERO", "UNKNOWN", "UNAVAILABLE", "STALE", "ERROR", "NOT_AUTHORISED"].map((status) => <option className="bg-background text-foreground" key={status} value={status}>{status}</option>)}</select></label></div>
              <p className="mt-3 text-xs text-muted-foreground" data-testid="command-centre-explorer-count">{capabilities.length} registry items match the current controls.</p><div className="mt-3 space-y-2">{capabilities.map((capability) => <article key={capability.id} className="rounded border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">{capability.displayName}</h3><p className="text-sm text-muted-foreground">{capability.departmentId}</p></div><button type="button" data-testid={"command-centre-detail-" + capability.id} onClick={() => setExpandedCapability((current) => current === capability.id ? null : capability.id)} className="rounded border border-input px-3 py-1 text-sm" aria-expanded={expandedCapability === capability.id}>{expandedCapability === capability.id ? "Hide details" : "Open details"}</button></div>{expandedCapability === capability.id && <div className="mt-3 border-t border-border pt-3 text-sm"><p>{capability.outcome}</p><p className="mt-2 text-xs text-muted-foreground">Sources: {capability.canonicalSourceRefs.join(", ") || "Deterministic policy"}</p><div className="mt-3 flex flex-wrap gap-2">{capability.safeInternalLinks.filter((href) => !href.includes("{") && href !== "/admin/command").map((href) => <Link key={href} href={href} data-testid={"command-centre-link-" + capability.id} className="rounded border border-input px-3 py-1 text-sm">Open canonical workspace</Link>)}</div></div>}</article>)}</div></>}
          </section>
        </>}
      </section>
    </AdminShell>
  );
}
