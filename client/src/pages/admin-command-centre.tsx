import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import {
  COMMAND_CENTRE_DEPARTMENTS,
  type CommandCentreDashboardResponse,
  type CommandCentreDescriptor,
  type CommandCentreKpiEnvelope,
  type CommandCentreKpiStatus,
  type CommandCentrePeriod,
} from "@shared/command-centre";
import AdminShell from "@/components/admin/admin-shell";
import { apiRequest } from "@/lib/queryClient";

const REFRESH_COOLDOWN_MS = 30_000;
const COMMAND_CENTRE_QUERY_PREFIX = ["protected", "command-centre"] as const;
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

type CommandView = "overview" | "attention" | "tree" | "skills";
const VIEW_LABELS: Record<CommandView, string> = {
  overview: "Overview",
  attention: "Attention",
  tree: "Work Tree",
  skills: "Skills",
};

function currentView(search: string): CommandView {
  const requested = new URLSearchParams(search).get("view");
  return requested === "attention" || requested === "tree" || requested === "skills" ? requested : "overview";
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

function displayValue(kpi: CommandCentreKpiEnvelope): string {
  const value =
    kpi.status === "STALE" ? kpi.lastValue : kpi.status === "VALUE" || kpi.status === "ZERO" ? kpi.value : null;
  if (value === null) return "—";
  return typeof value === "number"
    ? String(value)
    : Object.entries(value)
        .map(([key, entry]) => `${key}: ${entry}`)
        .join(" · ");
}

function statusDescription(kpi: CommandCentreKpiEnvelope): string {
  if (kpi.status === "VALUE") return "Canonical source value";
  if (kpi.status === "ZERO") return "Authoritative zero from the canonical source";
  if (kpi.status === "STALE") return "Last known source value; refresh is required";
  if (kpi.status === "NOT_AUTHORISED") return "This source is not authorised for this session";
  return `Source unavailable: ${kpi.reasonCode}`;
}

function timingText(asOf: string, ttlSeconds: number, stale = false): string {
  const label = new Date(asOf).toLocaleString();
  return stale ? `As of ${label} · stale after ${ttlSeconds}s` : `As of ${label} · freshness ${ttlSeconds}s`;
}

function isProblemStatus(status: CommandCentreKpiStatus): boolean {
  return !["VALUE", "ZERO"].includes(status);
}

function capabilityTiming(capability: CommandCentreDescriptor, dashboard: CommandCentreDashboardResponse): string {
  const envelopes = capability.kpiIds.map((id) => dashboard.kpis[id]);
  const timestamps = envelopes.flatMap((kpi) => (kpi.asOf ? [kpi.asOf] : []));
  const ttl = envelopes.flatMap((kpi) =>
    "freshnessSeconds" in kpi ? [kpi.freshnessSeconds] : "staleAfterSeconds" in kpi ? [kpi.staleAfterSeconds] : []
  );
  return timestamps.length > 0
    ? timingText(
        timestamps.sort()[0],
        ttl.length > 0 ? Math.min(...ttl) : 0,
        envelopes.some((kpi) => kpi.status === "STALE")
      )
    : "Live value unavailable; see source status below.";
}

function LoadingSkeleton() {
  return (
    <div role="status" aria-live="polite" data-testid="command-centre-loading" className="space-y-3">
      <span className="sr-only">Loading source-labelled Command Centre dashboard</span>
      {[1, 2, 3].map((item) => (
        <div key={item} className="h-20 rounded border border-border bg-[var(--admin-panel)]" />
      ))}
    </div>
  );
}

function AttentionSection({ dashboard }: { dashboard: CommandCentreDashboardResponse }) {
  return (
    <section id="command-centre-attention" aria-labelledby="command-centre-attention-heading" tabIndex={-1}>
      <h2 id="command-centre-attention-heading" className="mb-3 text-lg font-semibold">
        Attention Centre
      </h2>
      {dashboard.attention.length === 0 ? (
        <p
          data-testid="command-centre-attention-empty"
          className="rounded border border-border p-4 text-sm text-muted-foreground"
        >
          No deterministic attention items are currently present.
        </p>
      ) : (
        <div className="space-y-2">
          {dashboard.attention.map((item) => (
            <Link
              key={item.itemId}
              href={item.deepLink}
              data-testid={`command-centre-attention-${item.ruleId}`}
              className="command-centre-surface block rounded border border-border p-4 hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">{item.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>
                </div>
                <span className="text-xs font-semibold text-[var(--admin-amber)]">{item.severity}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Source: {item.source}</p>
              <p className="mt-1 text-xs text-muted-foreground">{timingText(item.asOf, item.freshnessSeconds)}</p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function KpiSection({ dashboard }: { dashboard: CommandCentreDashboardResponse }) {
  const groups = COMMAND_CENTRE_DEPARTMENTS.map((department) => ({
    ...department,
    ids: dashboard.registry.filter((item) => item.departmentId === department.id).flatMap((item) => item.kpiIds),
  }));
  return (
    <section aria-labelledby="command-centre-kpis">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="command-centre-kpis" className="text-lg font-semibold">
          Key performance indicators
        </h2>
        <span className="text-xs text-muted-foreground">{Object.keys(dashboard.kpis).length} canonical KPI cards</span>
      </div>
      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`kpi-domain-${group.id}`}>
            <h3 id={`kpi-domain-${group.id}`} className="mb-2 text-sm font-semibold text-[var(--admin-gold-hi)]">
              {group.displayName}
            </h3>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.ids.map((id) => {
                const kpi = dashboard.kpis[id];
                return (
                  <Link
                    key={id}
                    href={kpi.deepLink}
                    data-testid={`command-centre-kpi-${id}`}
                    className="command-centre-surface rounded border border-border p-4 hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="font-medium">{KPI_LABELS[id] ?? id}</h4>
                      <span
                        className={
                          isProblemStatus(kpi.status) ? "text-[var(--admin-amber)]" : "text-[var(--admin-green)]"
                        }
                      >
                        {kpi.status}
                      </span>
                    </div>
                    <p className="mt-3 text-xl font-semibold">{displayValue(kpi)}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{statusDescription(kpi)}</p>
                    <p className="mt-2 text-xs text-muted-foreground">Source: {kpi.source}</p>
                    {kpi.asOf && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {"freshnessSeconds" in kpi
                          ? timingText(kpi.asOf, kpi.freshnessSeconds)
                          : "staleAfterSeconds" in kpi
                            ? timingText(kpi.asOf, kpi.staleAfterSeconds, true)
                            : `As of ${new Date(kpi.asOf).toLocaleString()}`}
                      </p>
                    )}
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function CapabilityDialog({
  capability,
  dashboard,
  onClose,
  trigger,
}: {
  capability: CommandCentreDescriptor;
  dashboard: CommandCentreDashboardResponse;
  onClose: () => void;
  trigger: HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ),
    ];
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", keydown);
    return () => {
      dialog.removeEventListener("keydown", keydown);
      trigger?.focus();
    };
  }, [onClose, trigger]);
  const workspaceLinks = capability.safeInternalLinks.filter(
    (href) => !href.includes("{") && href !== "/admin/command"
  );
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-centre-detail-title"
        data-testid="command-centre-detail-dialog"
        className="command-centre-surface fixed inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-xl border p-5 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:w-[min(42rem,90vw)] md:max-h-none md:rounded-none"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {capability.kind} · {capability.status}
            </p>
            <h2 id="command-centre-detail-title" className="mt-1 text-xl font-semibold">
              {capability.displayName}
            </h2>
          </div>
          <button
            type="button"
            data-testid="command-centre-detail-close"
            onClick={onClose}
            className="rounded border border-input px-3 py-1 text-sm"
          >
            Close
          </button>
        </div>
        <dl className="mt-5 space-y-4 text-sm">
          <div>
            <dt className="font-semibold">Outcome</dt>
            <dd className="mt-1 text-muted-foreground">{capability.outcome}</dd>
          </div>
          <div>
            <dt className="font-semibold">Owner role</dt>
            <dd className="mt-1 text-muted-foreground">MintVault Super Admin · human-governed</dd>
          </div>
          <div>
            <dt className="font-semibold">Canonical sources</dt>
            <dd className="mt-1 text-muted-foreground">{capability.canonicalSourceRefs.join(", ")}</dd>
          </div>
          <div>
            <dt className="font-semibold">Freshness and failure state</dt>
            <dd className="mt-1 text-muted-foreground">{capabilityTiming(capability, dashboard)}</dd>
          </div>
        </dl>
        <section className="mt-5" aria-labelledby="detail-kpis">
          <h3 id="detail-kpis" className="font-semibold">
            KPI relationships
          </h3>
          {capability.kpiIds.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">Deterministic policy; no standalone KPI.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {capability.kpiIds.map((id) => (
                <li key={id} className="rounded border border-border p-3 text-sm">
                  <span className="font-medium">{KPI_LABELS[id] ?? id}</span>
                  <span className="ml-2 text-muted-foreground">
                    {dashboard.kpis[id].status} · {dashboard.kpis[id].source}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="mt-5" aria-labelledby="detail-workspaces">
          <h3 id="detail-workspaces" className="font-semibold">
            Canonical MintVault workspaces
          </h3>
          {workspaceLinks.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No record-specific destination is available until an authorised Partner record resolves the route.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {workspaceLinks.map((href) => (
                <Link
                  key={href}
                  href={href}
                  data-testid={`command-centre-link-${capability.id}`}
                  className="rounded border border-input px-3 py-2 text-sm"
                >
                  Open canonical workspace
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function WorkTree({
  dashboard,
  skillsOnly = false,
  selectedId,
  setSelectedId,
  triggerRef,
}: {
  dashboard: CommandCentreDashboardResponse;
  skillsOnly?: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  triggerRef: MutableRefObject<HTMLElement | null>;
}) {
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");
  const [kpiStatus, setKpiStatus] = useState("all");
  const [registryStatus, setRegistryStatus] = useState("all");
  const capabilities = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return dashboard.registry.filter((capability) => {
      if (skillsOnly && capability.kind !== "CAPABILITY") return false;
      if (department !== "all" && capability.departmentId !== department) return false;
      if (kpiStatus !== "all" && !capability.kpiIds.some((kpiId) => dashboard.kpis[kpiId]?.status === kpiStatus))
        return false;
      if (registryStatus !== "all" && capability.status !== registryStatus) return false;
      return (
        !needle ||
        [capability.displayName, capability.outcome, capability.id, capability.departmentId]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      );
    });
  }, [dashboard, department, kpiStatus, registryStatus, search, skillsOnly]);
  return (
    <section
      id="command-centre-work-tree"
      aria-labelledby="command-centre-explorer"
      className="rounded border border-border p-4"
    >
      <div>
        <h2 id="command-centre-explorer" className="text-lg font-semibold">
          {skillsOnly ? "Governed V1 skills and capabilities" : "MintVault Work Tree"}
        </h2>
        <p className="text-sm text-muted-foreground">
          MintVault → departments → governed capabilities → canonical workspaces.
        </p>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm">
          Search capabilities
          <input
            data-testid="command-centre-search"
            maxLength={80}
            value={search}
            onChange={(event) => setSearch(event.target.value.slice(0, 80))}
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground"
          />
        </label>
        <label className="text-sm">
          KPI status
          <select
            data-testid="command-centre-kpi-status-filter"
            value={kpiStatus}
            onChange={(event) => setKpiStatus(event.target.value)}
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground"
          >
            <option value="all">All KPI states</option>
            {(["VALUE", "ZERO", "UNKNOWN", "STALE", "UNAVAILABLE", "ERROR", "NOT_AUTHORISED"] as const).map(
              (status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              )
            )}
          </select>
        </label>
        <label className="text-sm">
          Department
          <select
            data-testid="command-centre-department-filter"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground"
          >
            <option value="all">All departments</option>
            {COMMAND_CENTRE_DEPARTMENTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Registry status
          <select
            data-testid="command-centre-registry-status-filter"
            value={registryStatus}
            onChange={(event) => setRegistryStatus(event.target.value)}
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-foreground"
          >
            <option value="all">Active and deferred</option>
            <option value="ACTIVE">Active</option>
            <option value="DEFERRED">Deferred</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground" data-testid="command-centre-explorer-count">
        {capabilities.length} registry items match the current controls.
      </p>
      <details open className="mt-3 rounded border border-border p-3">
        <summary className="cursor-pointer font-semibold">MintVault</summary>
        <div className="mt-3 space-y-3">
          {COMMAND_CENTRE_DEPARTMENTS.map((group) => {
            const groupCapabilities = capabilities.filter((item) => item.departmentId === group.id);
            if (groupCapabilities.length === 0) return null;
            return (
              <details open key={group.id} className="rounded border border-border p-3">
                <summary className="cursor-pointer font-medium">
                  {group.displayName} · {groupCapabilities.length}
                </summary>
                <div className="mt-3 space-y-2">
                  {groupCapabilities.map((capability) => (
                    <article key={capability.id} className="command-centre-surface rounded border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="font-medium">{capability.displayName}</h3>
                          <p className="text-xs text-muted-foreground">
                            {capability.kind} · {capability.status}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-testid={`command-centre-detail-${capability.id}`}
                          onClick={(event) => {
                            triggerRef.current = event.currentTarget;
                            setSelectedId(capability.id);
                          }}
                          className="rounded border border-input px-3 py-1 text-sm"
                          aria-haspopup="dialog"
                        >
                          Open details
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </details>
      {selectedId &&
        (() => {
          const selected = dashboard.registry.find((item) => item.id === selectedId);
          return selected ? (
            <CapabilityDialog
              capability={selected}
              dashboard={dashboard}
              trigger={triggerRef.current}
              onClose={() => setSelectedId(null)}
            />
          ) : null;
        })()}
    </section>
  );
}

export default function AdminCommandCentrePage() {
  const [location, navigate] = useLocation();
  const searchLocation = useSearch();
  const queryClient = useQueryClient();
  const view = currentView(searchLocation);
  const [period, setPeriod] = useState<CommandCentrePeriod>("today");
  const [lastRefreshAt, setLastRefreshAt] = useState(0);
  const [validatedPeriod, setValidatedPeriod] = useState<CommandCentrePeriod | null>(null);
  const [accessStatus, setAccessStatus] = useState<number | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<string | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const queryKey = [...COMMAND_CENTRE_QUERY_PREFIX, "dashboard", period] as const;
  const dashboardQuery = useQuery<CommandCentreDashboardResponse>({
    queryKey,
    queryFn: async () => {
      setAccessStatus(null);
      try {
        return await (await apiRequest("GET", `/api/admin/command/dashboard?period=${period}`)).json();
      } catch (error) {
        setAccessStatus(errorStatus(error) ?? 503);
        throw error;
      }
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
  useEffect(() => {
    setValidatedPeriod(null);
  }, [period]);
  useEffect(() => {
    if (dashboardQuery.isSuccess && !dashboardQuery.isFetching) setValidatedPeriod(period);
  }, [dashboardQuery.isFetching, dashboardQuery.isSuccess, dashboardQuery.dataUpdatedAt, period]);
  useEffect(() => {
    if (accessStatus === 401 || accessStatus === 403 || accessStatus === 404) {
      queryClient.removeQueries({ queryKey: COMMAND_CENTRE_QUERY_PREFIX });
    }
    if (accessStatus === 401) {
      const target = `${location}${searchLocation}`;
      navigate(`/admin/login?next=${encodeURIComponent(target)}`, { replace: true });
    }
  }, [accessStatus, location, navigate, queryClient, searchLocation]);
  useEffect(
    () => () => {
      queryClient.removeQueries({ queryKey: COMMAND_CENTRE_QUERY_PREFIX });
    },
    [queryClient]
  );
  useEffect(() => {
    if (!lastRefreshAt) return;
    const timer = window.setTimeout(() => setLastRefreshAt(0), REFRESH_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [lastRefreshAt]);
  const dashboard = validatedPeriod === period && !dashboardQuery.isError ? dashboardQuery.data : undefined;
  const refreshRemaining = Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt));
  const canRefresh = refreshRemaining === 0 && !dashboardQuery.isFetching;
  const refresh = async () => {
    if (!canRefresh) return;
    setLastRefreshAt(Date.now());
    await dashboardQuery.refetch();
  };
  const handleLogout = async () => {
    await apiRequest("POST", "/api/admin/logout");
    queryClient.removeQueries({ queryKey: COMMAND_CENTRE_QUERY_PREFIX });
    queryClient.removeQueries({ queryKey: ["/api/admin/db-info"] });
    queryClient.removeQueries({ queryKey: ["/api/admin/session"] });
    navigate("/cert");
  };
  const selected = dashboard?.registry.find((item) => item.id === selectedCapability);
  const selectedDepartment = selected
    ? COMMAND_CENTRE_DEPARTMENTS.find((department) => department.id === selected.departmentId)
    : undefined;
  return (
    <AdminShell
      activeTab="command-centre"
      onTabChange={() => navigate("/admin")}
      onLogout={handleLogout}
      title="Command Centre"
      crumb="MINTVAULT · INSIGHT"
      disableEnvironmentPolling
      commandCentreMode
      commandCentreAvailable={dashboard !== undefined}
    >
      <section className="space-y-6 p-4 md:p-6" aria-live="polite" data-testid="command-centre-page">
        <nav aria-label="Command Centre breadcrumb" className="text-sm text-muted-foreground">
          <Link href="/admin" data-testid="command-centre-breadcrumb-admin" className="underline">
            Admin
          </Link>
          <span aria-hidden="true"> / </span>
          <Link href="/admin/command" className="underline">
            Command Centre
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{VIEW_LABELS[view]}</span>
          {selected && (
            <>
              <span aria-hidden="true"> / </span>
              <span>{selectedDepartment?.displayName ?? selected.departmentId}</span>
              <span aria-hidden="true"> / </span>
              <span>{selected.displayName}</span>
            </>
          )}
        </nav>
        <div className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">
              {view === "tree"
                ? "MintVault Work Tree"
                : view === "skills"
                  ? "Command Centre Skills"
                  : view === "attention"
                    ? "Attention Centre"
                    : "Command Centre"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Read-only, source-labelled operational control.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="text-sm" htmlFor="command-centre-period">
              Period
            </label>
            <select
              id="command-centre-period"
              data-testid="command-centre-period"
              value={period}
              onChange={(event) => setPeriod(event.target.value as CommandCentrePeriod)}
              className="rounded border border-input bg-background px-2 py-1 text-foreground"
            >
              <option value="today">Today</option>
              <option value="month_to_date">Month to date</option>
            </select>
            <button
              type="button"
              data-testid="command-centre-refresh"
              onClick={refresh}
              disabled={!canRefresh}
              className="rounded border border-input px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dashboardQuery.isFetching && dashboard
                ? "Refreshing…"
                : refreshRemaining > 0
                  ? "Refresh available shortly"
                  : "Refresh"}
            </button>
          </div>
        </div>
        {!dashboard && !dashboardQuery.isError && <LoadingSkeleton />}
        {dashboardQuery.isError && accessStatus === 403 && (
          <div data-testid="command-centre-forbidden">
            <h2 className="text-lg font-semibold">Super Admin access required</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This read-only workspace is restricted to the Super Admin role.
            </p>
          </div>
        )}
        {dashboardQuery.isError && accessStatus !== 403 && accessStatus !== 401 && (
          <div data-testid="command-centre-unavailable">
            <h2 className="text-lg font-semibold">Command Centre unavailable</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This workspace is not available for the current feature state.
            </p>
          </div>
        )}
        {dashboard && (
          <>
            <p className="text-xs text-muted-foreground" data-testid="command-centre-as-of">
              Snapshot: {new Date(dashboard.asOf).toLocaleString()}
            </p>
            {dashboard.partialSourceIds.length > 0 && (
              <p
                className="rounded border border-[var(--admin-amber)] bg-amber-500/10 p-3 text-sm"
                data-testid="command-centre-partial"
              >
                Affected canonical sources: {dashboard.partialSourceIds.join(", ")}. Their KPI cards show the applicable
                state.
              </p>
            )}
            {(view === "overview" || view === "attention") && <AttentionSection dashboard={dashboard} />}
            {view === "overview" && <KpiSection dashboard={dashboard} />}
            {view === "overview" && (
              <WorkTree
                dashboard={dashboard}
                selectedId={selectedCapability}
                setSelectedId={setSelectedCapability}
                triggerRef={detailTrigger}
              />
            )}
            {view === "tree" && (
              <WorkTree
                dashboard={dashboard}
                selectedId={selectedCapability}
                setSelectedId={setSelectedCapability}
                triggerRef={detailTrigger}
              />
            )}
            {view === "skills" && (
              <WorkTree
                dashboard={dashboard}
                skillsOnly
                selectedId={selectedCapability}
                setSelectedId={setSelectedCapability}
                triggerRef={detailTrigger}
              />
            )}
          </>
        )}
      </section>
    </AdminShell>
  );
}
