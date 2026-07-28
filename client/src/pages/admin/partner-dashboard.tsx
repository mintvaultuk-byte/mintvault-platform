/**
 * Super Admin Partner Master Dashboard — /admin/partners/dashboard
 *
 * Cross-tenant control centre for the partner network. READ-ONLY: this page issues no
 * mutations. Wallet balances shown here are derived server-side from the append-only credit
 * ledger and are never computed from component state.
 *
 * HONESTY RULE: where the platform has no data source (partner quality rating, device
 * registry, scanner telemetry, per-partner certificate counts, credit purchases), the server
 * returns a typed `MetricUnavailable` and this page renders the REASON. It never renders a
 * zero in place of "we cannot know" — a fake metric on an operations console is worse than a
 * blank one, because it gets acted on.
 *
 * Renders <AdminShell> as its outermost element: the repo-wide shell guard parses App.tsx and
 * fails any /admin route whose page is not shell-unified.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Panel, StatCard, Badge, AdminButton, Chip } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";
import type {
  DashboardAlert,
  Metric,
  MetricUnavailable,
  NetworkSummary,
  Paged,
  PartnerCorrectionsView,
  PartnerDevicesView,
  PartnerOverview,
  PartnerQualityView,
  PartnerSecurityView,
  PartnerStaffRow,
  PartnerSubmissionsView,
  PartnerTableRow,
  PartnerWalletView,
  AuditTimelineEntry,
} from "@shared/partner-dashboard";
import {
  alertBadgeVariant,
  dashboardErrorMessage,
  dashboardQueryString,
  dashKeys,
  DEFAULT_FILTERS,
  DRILLDOWN_TABS,
  formatCount,
  formatCredits,
  formatDateTime,
  isAuthError,
  isDrilldownTab,
  PARTNER_DASHBOARD_BASE,
  relativeTime,
  RISK_FILTERS,
  riskBadgeVariant,
  riskLabel,
  SORT_OPTIONS,
  statusBadgeVariant,
  STATUS_FILTERS,
  truncateName,
  type DrilldownTab,
  type PartnerListFilterState,
} from "./partner-dashboard-helpers";

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/** Renders the REASON a metric is missing. This is the anti-fake-metric primitive. */
function Unavailable({ metric, compact }: { metric: MetricUnavailable; compact?: boolean }) {
  return (
    <span
      title={metric.detail}
      data-testid="pd-unavailable"
      style={{ color: "var(--admin-muted, #8a8a8a)", fontSize: compact ? 11 : 12, fontStyle: "italic" }}
    >
      {compact ? "No data" : "Not available"}
    </span>
  );
}

function MetricValue({ metric: m, format }: { metric: Metric<number>; format?: (n: number) => string }) {
  if (!m.available) return <Unavailable metric={m} />;
  return <>{format ? format(m.value) : formatCount(m.value)}</>;
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      data-testid="pd-error"
      style={{
        border: "1px solid rgba(220,80,80,.45)",
        background: "rgba(220,80,80,.08)",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13 }}>{message}</span>
      {onRetry && (
        <AdminButton size="sm" variant="ghost" onClick={onRetry} data-testid="pd-retry">
          Retry
        </AdminButton>
      )}
    </div>
  );
}

function Loading({ label, testId }: { label: string; testId: string }) {
  return (
    <div role="status" aria-live="polite" data-testid={testId} style={{ padding: 12, fontSize: 13 }}>
      {label}
    </div>
  );
}

function Empty({ label, testId }: { label: string; testId: string }) {
  return (
    <div data-testid={testId} style={{ padding: 12, fontSize: 13, opacity: 0.75 }}>
      {label}
    </div>
  );
}

/** Explains an entire section that has no backing data, rather than showing an empty table. */
function NoDataSection({ title, explanation, testId }: { title: string; explanation: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        border: "1px dashed rgba(212,175,55,.35)",
        borderRadius: 8,
        padding: 16,
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <strong style={{ display: "block", marginBottom: 6 }}>{title}</strong>
      <span style={{ opacity: 0.85 }}>{explanation}</span>
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontSize: 11, textTransform: "uppercase", opacity: 0.7 };
const td: React.CSSProperties = { padding: "6px 8px", fontSize: 13, verticalAlign: "top" };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPartnerDashboardPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [filters, setFilters] = useState<PartnerListFilterState>(DEFAULT_FILTERS);
  const [searchDraft, setSearchDraft] = useState("");
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const [tab, setTab] = useState<DrilldownTab>("overview");

  // Admin session gate — same idiom as the other admin partner pages. The server is the real
  // gate; this only avoids rendering a broken shell to a signed-out operator.
  useEffect(() => {
    let live = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setAuthed(!!d?.authenticated))
      .catch(() => live && setAuthed(false));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/partners/dashboard", { replace: true });
  }, [authed, navigate]);

  // Deep-link support: ?partner=<uuid>&tab=<tab>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("partner");
    const t = params.get("tab");
    if (p) setSelectedPartner(p);
    if (isDrilldownTab(t)) setTab(t);
  }, []);

  const enabled = authed === true;

  const summary = useQuery<{ summary: NetworkSummary }>({
    queryKey: dashKeys.summary(),
    queryFn: () => apiRequest("GET", `${PARTNER_DASHBOARD_BASE}/summary`).then((r) => r.json()),
    enabled,
    // Global defaults are staleTime:Infinity + no focus refetch, so an ops console would
    // otherwise freeze at its first paint. 60s matches AdminShell's own env-strip poll.
    refetchInterval: 60_000,
  });

  const alerts = useQuery<{ alerts: DashboardAlert[] }>({
    queryKey: dashKeys.alerts(),
    queryFn: () => apiRequest("GET", `${PARTNER_DASHBOARD_BASE}/alerts`).then((r) => r.json()),
    enabled,
    refetchInterval: 60_000,
  });

  const partners = useQuery<Paged<PartnerTableRow>>({
    queryKey: dashKeys.partners(filters as unknown as Record<string, unknown>),
    queryFn: () =>
      apiRequest("GET", `${PARTNER_DASHBOARD_BASE}/partners${dashboardQueryString(filters)}`).then((r) => r.json()),
    enabled,
  });

  // Any 401 anywhere means the shared mv.sid session was evicted (a staff login in the same
  // browser does exactly that) — route to login rather than show an empty cross-tenant grid.
  useEffect(() => {
    if (isAuthError(summary.error) || isAuthError(partners.error) || isAuthError(alerts.error)) {
      navigate("/admin/login?next=/admin/partners/dashboard", { replace: true });
    }
  }, [summary.error, partners.error, alerts.error, navigate]);

  const rows = partners.data?.rows ?? [];
  const s = summary.data?.summary;

  const applySearch = () => setFilters((f) => ({ ...f, search: searchDraft, page: 1 }));

  const openPartner = (id: string) => {
    setSelectedPartner(id);
    setTab("overview");
  };

  if (authed === null) {
    return (
      <div className="admin-root" style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div role="status" aria-live="polite">
          Loading…
        </div>
      </div>
    );
  }

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Partner Master Dashboard"
      crumb="Partner Network"
    >
      {/* ---- A. Network overview ---- */}
      <Panel title="Network overview" sub="Live figures across every partner shop">
        {summary.isError ? (
          <ErrorBanner message={dashboardErrorMessage(summary.error)} onRetry={() => summary.refetch()} />
        ) : summary.isLoading ? (
          <Loading label="Loading network summary…" testId="pd-summary-loading" />
        ) : s ? (
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}
            data-testid="pd-summary-grid"
          >
            <StatCard label="Total shops" value={formatCount(s.shops.total)} mono testId="pd-kpi-shops" />
            <StatCard label="Active" value={formatCount(s.shops.active)} mono testId="pd-kpi-active" />
            <StatCard label="Onboarding" value={formatCount(s.shops.onboarding)} mono testId="pd-kpi-onboarding" />
            <StatCard label="Suspended" value={formatCount(s.shops.suspended)} mono testId="pd-kpi-suspended" />
            <StatCard label="Partner staff" value={formatCount(s.staff.total)} mono testId="pd-kpi-staff" />
            <StatCard
              label="Active graders"
              value={<MetricValue metric={s.staff.activeGraders} />}
              mono
              testId="pd-kpi-graders"
            />
            <StatCard
              label="Cards in progress"
              value={formatCount(s.work.inProgress)}
              mono
              testId="pd-kpi-inprogress"
            />
            <StatCard
              label="Completed today"
              value={<MetricValue metric={s.work.completedToday} />}
              mono
              testId="pd-kpi-today"
            />
            <StatCard
              label="Completed this month"
              value={<MetricValue metric={s.work.completedThisMonth} />}
              mono
              testId="pd-kpi-month"
            />
            <StatCard
              label="Open corrections"
              value={formatCount(s.corrections.openEscalations)}
              mono
              testId="pd-kpi-corrections"
            />
            <StatCard
              label="Security alerts"
              value={formatCount(s.security.openAlerts)}
              mono
              testId="pd-kpi-security"
            />
            <StatCard
              label="Available credits"
              value={<MetricValue metric={s.credits.totalAvailable} format={formatCredits} />}
              mono
              testId="pd-kpi-credits-available"
            />
            <StatCard
              label="Reserved credits"
              value={<MetricValue metric={s.credits.totalReserved} format={formatCredits} />}
              mono
              testId="pd-kpi-credits-reserved"
            />
            <StatCard
              label="Credits used (month)"
              value={<MetricValue metric={s.credits.consumedThisMonth} format={formatCredits} />}
              mono
              testId="pd-kpi-credits-consumed"
            />
          </div>
        ) : (
          <Empty label="No summary available." testId="pd-summary-empty" />
        )}
      </Panel>

      {/* ---- E. Operational workflow ---- */}
      {s && (
        <Panel
          title="Operational pipeline"
          sub="Partner work by real pipeline state — bottleneck states highlighted"
          className="mt-4"
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="pd-pipeline">
            {Object.entries(s.work.byState).map(([state, n]) => {
              const isBottleneck = ["manual_review", "reconciliation_required", "failed"].includes(state);
              return (
                <div
                  key={state}
                  title={isBottleneck ? "Bottleneck — needs a human" : undefined}
                  style={{
                    border: `1px solid ${isBottleneck && n > 0 ? "rgba(220,80,80,.5)" : "rgba(255,255,255,.12)"}`,
                    borderRadius: 6,
                    padding: "6px 10px",
                    minWidth: 120,
                  }}
                >
                  <div style={{ fontSize: 10, textTransform: "uppercase", opacity: 0.7 }}>
                    {state.replace(/_/g, " ")}
                  </div>
                  <div style={{ fontSize: 16, fontVariantNumeric: "tabular-nums" }}>{formatCount(n)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            Partner submissions:{" "}
            {Object.entries(s.work.submissionsByStatus)
              .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
              .join(" · ")}
          </div>
        </Panel>
      )}

      {/* ---- I. Alerts ---- */}
      <Panel title="Alerts" sub="Prioritised, derived from real conditions only" className="mt-4">
        {alerts.isError ? (
          <ErrorBanner message={dashboardErrorMessage(alerts.error)} onRetry={() => alerts.refetch()} />
        ) : alerts.isLoading ? (
          <Loading label="Loading alerts…" testId="pd-alerts-loading" />
        ) : (alerts.data?.alerts ?? []).length === 0 ? (
          <Empty label="No alerts. Nothing needs attention right now." testId="pd-alerts-empty" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="min-w-full text-left text-sm" data-testid="pd-alerts-table">
              <thead>
                <tr>
                  <th scope="col" style={th}>
                    Severity
                  </th>
                  <th scope="col" style={th}>
                    Partner
                  </th>
                  <th scope="col" style={th}>
                    Reason
                  </th>
                  <th scope="col" style={th}>
                    Recommended action
                  </th>
                  <th scope="col" style={th}>
                    Detected
                  </th>
                </tr>
              </thead>
              <tbody>
                {(alerts.data?.alerts ?? []).map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                    <td style={td}>
                      <Badge variant={alertBadgeVariant(a.severity)}>{a.severity.toUpperCase()}</Badge>
                    </td>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => openPartner(a.partnerId)}
                        style={{ textDecoration: "underline", cursor: "pointer" }}
                      >
                        {truncateName(a.partnerName)}
                      </button>
                    </td>
                    <td style={td}>{a.reason}</td>
                    <td style={td}>{a.recommendedAction}</td>
                    <td style={td} title={formatDateTime(a.detectedAt)}>
                      {relativeTime(a.detectedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ---- B. Partner table ---- */}
      <Panel title="Partners" sub={`${partners.data?.total ?? 0} shop(s)`} className="mt-4">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <label htmlFor="pd-search" style={{ fontSize: 12, opacity: 0.8 }}>
            Search
          </label>
          <input
            id="pd-search"
            className="admin-input"
            data-testid="pd-search"
            placeholder="Shop name, reference or trading name"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
            style={{ minWidth: 260 }}
          />
          <AdminButton size="sm" variant="ghost" onClick={applySearch} data-testid="pd-search-go">
            Search
          </AdminButton>

          {STATUS_FILTERS.map((f) => (
            <Chip
              key={f.key || "all"}
              active={filters.status === f.key}
              onClick={() => setFilters((p) => ({ ...p, status: f.key, page: 1 }))}
              testId={`pd-filter-status-${f.key || "all"}`}
            >
              {f.label}
            </Chip>
          ))}

          <label htmlFor="pd-risk" style={{ fontSize: 12, opacity: 0.8, marginLeft: 8 }}>
            Risk
          </label>
          <select
            id="pd-risk"
            className="admin-input"
            data-testid="pd-filter-risk"
            value={filters.risk}
            onChange={(e) => setFilters((p) => ({ ...p, risk: e.target.value, page: 1 }))}
          >
            {RISK_FILTERS.map((f) => (
              <option key={f.key || "any"} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>

          <label htmlFor="pd-sort" style={{ fontSize: 12, opacity: 0.8 }}>
            Sort
          </label>
          <select
            id="pd-sort"
            className="admin-input"
            data-testid="pd-sort"
            value={filters.sort}
            onChange={(e) => setFilters((p) => ({ ...p, sort: e.target.value, page: 1 }))}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <AdminButton
            size="sm"
            variant="ghost"
            data-testid="pd-direction"
            onClick={() => setFilters((p) => ({ ...p, direction: p.direction === "asc" ? "desc" : "asc", page: 1 }))}
          >
            {filters.direction === "asc" ? "Ascending" : "Descending"}
          </AdminButton>
        </div>

        {partners.isError ? (
          <ErrorBanner message={dashboardErrorMessage(partners.error)} onRetry={() => partners.refetch()} />
        ) : partners.isLoading ? (
          <Loading label="Loading partners…" testId="pd-partners-loading" />
        ) : rows.length === 0 ? (
          <Empty label="No partners match these filters." testId="pd-partners-empty" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="min-w-full text-left text-sm" data-testid="pd-partners-table">
              <thead>
                <tr>
                  {[
                    "Shop",
                    "Partner ID",
                    "Status",
                    "Stage",
                    "Quality",
                    "Risk",
                    "Available",
                    "Reserved",
                    "Submissions",
                    "In pipeline",
                    "Corrections",
                    "Devices",
                    "Staff",
                    "Last activity",
                    "Alerts",
                  ].map((h) => (
                    <th key={h} scope="col" style={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.partnerId}
                    data-testid={`pd-row-${p.partnerId}`}
                    style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}
                  >
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => openPartner(p.partnerId)}
                        title={p.shopName}
                        style={{ textDecoration: "underline", cursor: "pointer", textAlign: "left" }}
                        data-testid={`pd-open-${p.partnerId}`}
                      >
                        {truncateName(p.shopName)}
                      </button>
                      {p.tradingName && (
                        <div style={{ fontSize: 11, opacity: 0.6 }}>{truncateName(p.tradingName, 32)}</div>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{p.publicRef}</td>
                    <td style={td}>
                      <Badge variant={statusBadgeVariant(p.status)}>{p.status}</Badge>
                    </td>
                    <td style={td}>{p.onboardingStage}</td>
                    <td style={td}>
                      <Unavailable metric={p.qualityRating} compact />
                    </td>
                    <td style={td} title={p.riskStatus.reasons.join(" · ") || "No risk signals"}>
                      <Badge variant={riskBadgeVariant(p.riskStatus.level)}>{riskLabel(p.riskStatus.level)}</Badge>
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCredits(p.availableCredits)}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCredits(p.reservedCredits)}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCount(p.activeSubmissions)}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCount(p.cardsInPipeline)}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCount(p.openCorrections)}</td>
                    <td style={td}>
                      <Unavailable metric={p.approvedDevices} compact />
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCount(p.activeStaff)}</td>
                    <td style={td} title={formatDateTime(p.lastActivityAt)}>
                      {relativeTime(p.lastActivityAt)}
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{formatCount(p.alertCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }} data-testid="pd-pager">
          <AdminButton
            size="sm"
            variant="ghost"
            disabled={filters.page <= 1}
            onClick={() => setFilters((p) => ({ ...p, page: Math.max(1, p.page - 1) }))}
            data-testid="pd-prev"
          >
            Previous
          </AdminButton>
          <span style={{ fontSize: 12 }}>
            Page {partners.data?.page ?? filters.page} of {partners.data?.totalPages ?? 1}
          </span>
          <AdminButton
            size="sm"
            variant="ghost"
            disabled={(partners.data?.totalPages ?? 1) <= filters.page}
            onClick={() => setFilters((p) => ({ ...p, page: p.page + 1 }))}
            data-testid="pd-next"
          >
            Next
          </AdminButton>
        </div>
      </Panel>

      {/* ---- C. Drill-down ---- */}
      {selectedPartner && (
        <Panel
          title="Partner detail"
          className="mt-4"
          actions={
            <AdminButton size="sm" variant="ghost" onClick={() => setSelectedPartner(null)} data-testid="pd-close">
              Close
            </AdminButton>
          }
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }} data-testid="pd-tabs">
            {DRILLDOWN_TABS.map((t) => (
              <Chip key={t.key} active={tab === t.key} onClick={() => setTab(t.key)} testId={`pd-tab-${t.key}`}>
                {t.label}
              </Chip>
            ))}
          </div>
          <PartnerDrilldown partnerId={selectedPartner} tab={tab} />
        </Panel>
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
// Drill-down — each tab fetches only when it is visible.
// ---------------------------------------------------------------------------

function useSection<T>(partnerId: string, section: string, active: boolean) {
  return useQuery<T>({
    queryKey: dashKeys.section(partnerId, section),
    queryFn: () =>
      apiRequest("GET", `${PARTNER_DASHBOARD_BASE}/partners/${partnerId}/${section}`).then((r) => r.json()),
    enabled: active,
  });
}

function SectionState({
  q,
  children,
}: {
  q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void };
  children: React.ReactNode;
}) {
  if (q.isError) return <ErrorBanner message={dashboardErrorMessage(q.error)} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <Loading label="Loading…" testId="pd-section-loading" />;
  return <>{children}</>;
}

function PartnerDrilldown({ partnerId, tab }: { partnerId: string; tab: DrilldownTab }) {
  const overview = useSection<PartnerOverview>(partnerId, "overview", tab === "overview");
  const staff = useSection<{ staff: PartnerStaffRow[] }>(partnerId, "staff", tab === "staff");
  const wallet = useSection<PartnerWalletView>(partnerId, "wallet", tab === "wallet");
  const submissions = useSection<PartnerSubmissionsView>(partnerId, "submissions", tab === "submissions");
  const quality = useSection<PartnerQualityView>(partnerId, "quality", tab === "quality");
  const corrections = useSection<PartnerCorrectionsView>(partnerId, "corrections", tab === "corrections");
  const devices = useSection<PartnerDevicesView>(partnerId, "devices", tab === "devices");
  const security = useSection<PartnerSecurityView>(partnerId, "security", tab === "security");
  const audit = useSection<Paged<AuditTimelineEntry>>(partnerId, "audit", tab === "audit");

  const wrap = useMemo(() => ({ overflowX: "auto" as const }), []);

  if (tab === "overview") {
    return (
      <SectionState q={overview}>
        {overview.data && (
          <div data-testid="pd-detail-overview" style={{ display: "grid", gap: 10, fontSize: 13 }}>
            <div>
              <strong>{overview.data.shopName}</strong>{" "}
              <Badge variant={statusBadgeVariant(overview.data.status)}>{overview.data.status}</Badge>
            </div>
            <div style={{ opacity: 0.8 }}>
              Reference {overview.data.publicRef} · Created {formatDateTime(overview.data.createdAt)}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span>Locations: {overview.data.counts.locations}</span>
              <span>Users: {overview.data.counts.users}</span>
              <span>Submissions: {overview.data.counts.submissions}</span>
              <span>Connector records: {overview.data.counts.connectorRecords}</span>
            </div>
            {overview.data.profile && (
              <div style={{ opacity: 0.85 }}>
                {overview.data.profile.tradingName ?? "—"} · {overview.data.profile.organisationKind ?? "—"} ·{" "}
                {overview.data.profile.addressCity ?? "—"}, {overview.data.profile.addressCountry ?? "—"}
              </div>
            )}
            <div style={{ display: "grid", gap: 6 }}>
              <div>
                Grading origin: <Unavailable metric={overview.data.gradingOrigin} />
              </div>
              <div>
                Certificates graded: <Unavailable metric={overview.data.certificatesGraded} />
              </div>
            </div>
          </div>
        )}
      </SectionState>
    );
  }

  if (tab === "staff") {
    return (
      <SectionState q={staff}>
        {(staff.data?.staff ?? []).length === 0 ? (
          <Empty label="No staff accounts for this partner." testId="pd-staff-empty" />
        ) : (
          <div style={wrap}>
            <table className="min-w-full text-left text-sm" data-testid="pd-staff-table">
              <thead>
                <tr>
                  {["Email", "Status", "Roles", "MFA", "Last login", "Sessions", "Lock state"].map((h) => (
                    <th key={h} scope="col" style={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(staff.data?.staff ?? []).map((u) => (
                  <tr key={u.userId} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                    <td style={td}>{u.email}</td>
                    <td style={td}>
                      <Badge variant={u.status === "ACTIVE" ? "act" : "red"}>{u.status}</Badge>
                    </td>
                    <td style={td}>{u.roles.length ? u.roles.join(", ") : "—"}</td>
                    <td style={td}>{u.mfaEnabled ? "Enabled" : "Off"}</td>
                    <td style={td} title={formatDateTime(u.lastLoginAt)}>
                      {relativeTime(u.lastLoginAt)}
                    </td>
                    <td style={td}>{u.activeSessions}</td>
                    <td style={td}>
                      {u.locked ? (
                        <Badge variant="red">Locked until {formatDateTime(u.lockedUntil)}</Badge>
                      ) : u.failedLoginCount > 0 ? (
                        `${u.failedLoginCount} failed`
                      ) : (
                        "OK"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionState>
    );
  }

  if (tab === "wallet") {
    return (
      <SectionState q={wallet}>
        {wallet.data && (
          <div data-testid="pd-detail-wallet" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
              <StatCard label="Available" value={formatCredits(wallet.data.availableCredits)} mono />
              <StatCard label="Reserved" value={formatCredits(wallet.data.reservedCredits)} mono />
              <StatCard label="Ledger balance" value={formatCredits(wallet.data.ledgerBalance)} mono />
              <StatCard label="Lifetime consumed" value={formatCredits(wallet.data.consumedReservations)} mono />
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{wallet.data.note}</div>
            <div style={{ fontSize: 12 }}>
              Credit purchases: <Unavailable metric={wallet.data.purchases} />
            </div>
            {wallet.data.recentLedger.length === 0 ? (
              <Empty label="No ledger entries." testId="pd-ledger-empty" />
            ) : (
              <div style={wrap}>
                <table className="min-w-full text-left text-sm" data-testid="pd-ledger-table">
                  <thead>
                    <tr>
                      {["When", "Amount", "Type", "Source", "Reason", "Actor"].map((h) => (
                        <th key={h} scope="col" style={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {wallet.data.recentLedger.map((e) => (
                      <tr key={e.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td style={td}>{formatDateTime(e.createdAt)}</td>
                        <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                          {e.amount > 0 ? `+${e.amount}` : e.amount}
                        </td>
                        <td style={td}>{e.entryType}</td>
                        <td style={td}>{e.source}</td>
                        <td style={td}>{e.reason}</td>
                        <td style={td}>{e.actorEmail ?? e.actorType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </SectionState>
    );
  }

  if (tab === "submissions") {
    return (
      <SectionState q={submissions}>
        {submissions.data && (
          <div data-testid="pd-detail-submissions" style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {Object.entries(submissions.data.byStatus)
                .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                .join(" · ")}
            </div>
            {submissions.data.recent.length === 0 ? (
              <Empty label="No submissions for this partner." testId="pd-submissions-empty" />
            ) : (
              <div style={wrap}>
                <table className="min-w-full text-left text-sm" data-testid="pd-submissions-table">
                  <thead>
                    <tr>
                      {["Reference", "Status", "Cards", "Estimated", "Created", "Submitted"].map((h) => (
                        <th key={h} scope="col" style={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.data.recent.map((sub) => (
                      <tr key={sub.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td style={td}>{sub.publicRef}</td>
                        <td style={td}>{sub.status.replace(/_/g, " ")}</td>
                        <td style={td}>{sub.cardCount}</td>
                        <td style={td}>
                          {sub.estimatedPricePence == null
                            ? "—"
                            : `£${(sub.estimatedPricePence / 100).toFixed(2)} (estimated)`}
                        </td>
                        <td style={td}>{formatDateTime(sub.createdAt)}</td>
                        <td style={td}>{formatDateTime(sub.submittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </SectionState>
    );
  }

  if (tab === "quality") {
    return (
      <SectionState q={quality}>
        {quality.data && (
          <NoDataSection
            title="Partner Quality Rating is not yet implemented"
            explanation={quality.data.explanation}
            testId="pd-quality-unavailable"
          />
        )}
      </SectionState>
    );
  }

  if (tab === "corrections") {
    return (
      <SectionState q={corrections}>
        {corrections.data && (
          <div data-testid="pd-detail-corrections" style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.85 }}>{corrections.data.explanation}</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
              <span>Manual review: {corrections.data.counts.manualReview}</span>
              <span>Reconciliation required: {corrections.data.counts.reconciliationRequired}</span>
              <span>Failed: {corrections.data.counts.failed}</span>
            </div>
            {corrections.data.escalations.length === 0 ? (
              <Empty label="No open escalations." testId="pd-corrections-empty" />
            ) : (
              <div style={wrap}>
                <table className="min-w-full text-left text-sm" data-testid="pd-corrections-table">
                  <thead>
                    <tr>
                      {["Record", "State", "Attempts", "Error", "Updated"].map((h) => (
                        <th key={h} scope="col" style={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.data.escalations.map((e) => (
                      <tr key={e.recordId} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{e.recordId}</td>
                        <td style={td}>{e.state.replace(/_/g, " ")}</td>
                        <td style={td}>{e.attemptCount}</td>
                        <td style={td}>{e.lastErrorCode ?? e.lastErrorCategory ?? "—"}</td>
                        <td style={td}>{formatDateTime(e.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </SectionState>
    );
  }

  if (tab === "devices") {
    return (
      <SectionState q={devices}>
        {devices.data && (
          <div data-testid="pd-detail-devices" style={{ display: "grid", gap: 12 }}>
            <NoDataSection
              title="No device registry exists"
              explanation={devices.data.explanation}
              testId="pd-devices-unavailable"
            />
            {devices.data.recentSessions.length > 0 && (
              <div style={wrap}>
                <table className="min-w-full text-left text-sm" data-testid="pd-sessions-table">
                  <thead>
                    <tr>
                      {["Session", "Started", "Last seen", "MFA", "State"].map((h) => (
                        <th key={h} scope="col" style={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {devices.data.recentSessions.map((se) => (
                      <tr key={se.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                          {se.id.slice(0, 8)}
                        </td>
                        <td style={td}>{formatDateTime(se.createdAt)}</td>
                        <td style={td}>{relativeTime(se.lastSeenAt)}</td>
                        <td style={td}>{se.mfaPassed ? "Passed" : "No"}</td>
                        <td style={td}>{se.revokedAt ? "Revoked" : "Live"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </SectionState>
    );
  }

  if (tab === "security") {
    return (
      <SectionState q={security}>
        {security.data && (
          <div data-testid="pd-detail-security" style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 13 }}>Locked staff accounts: {security.data.lockedUsers}</div>
            {security.data.emergencyControls.length > 0 && (
              <div style={{ fontSize: 13 }}>
                Emergency controls:{" "}
                {security.data.emergencyControls.map((c) => `${c.scope}${c.frozen ? " (FROZEN)" : ""}`).join(", ")}
              </div>
            )}
            {security.data.events.length === 0 ? (
              <Empty label="No security events recorded." testId="pd-security-empty" />
            ) : (
              <div style={wrap}>
                <table className="min-w-full text-left text-sm" data-testid="pd-security-table">
                  <thead>
                    <tr>
                      {["Severity", "Kind", "When"].map((h) => (
                        <th key={h} scope="col" style={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {security.data.events.map((e) => (
                      <tr key={e.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td style={td}>
                          <Badge variant={e.severity === "critical" || e.severity === "high" ? "red" : "neu"}>
                            {e.severity}
                          </Badge>
                        </td>
                        <td style={td}>{e.kind}</td>
                        <td style={td}>{formatDateTime(e.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </SectionState>
    );
  }

  return (
    <SectionState q={audit}>
      {(audit.data?.rows ?? []).length === 0 ? (
        <Empty label="No audit events recorded for this partner." testId="pd-audit-empty" />
      ) : (
        <div style={wrap}>
          <table className="min-w-full text-left text-sm" data-testid="pd-audit-table">
            <thead>
              <tr>
                {["When", "Source", "Action", "Actor", "Result", "Record", "Reason"].map((h) => (
                  <th key={h} scope="col" style={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(audit.data?.rows ?? []).map((e) => (
                <tr key={`${e.source}-${e.id}`} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                  <td style={td}>{formatDateTime(e.createdAt)}</td>
                  <td style={td}>
                    {/* Source is shown explicitly so distinct evidence ledgers are never conflated. */}
                    <Badge variant="neu">{e.source.replace(/_/g, " ")}</Badge>
                  </td>
                  <td style={td}>{e.action}</td>
                  <td style={td}>{e.actorEmail ?? "—"}</td>
                  <td style={td}>{e.result ?? e.severity ?? "—"}</td>
                  <td style={td}>{e.recordType ? `${e.recordType} ${e.recordId ?? ""}` : "—"}</td>
                  <td style={td}>{e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionState>
  );
}
