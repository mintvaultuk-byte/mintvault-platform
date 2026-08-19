/** Canonical R2 Partner Network overview: one bounded server projection, no client fan-out. */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Badge, Panel, StatCard } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";
import type { DashboardAlert, Metric, PartnerNetworkOverview, PartnerTableRow } from "@shared/partner-dashboard";
import {
  alertBadgeVariant,
  formatCount,
  formatCredits,
  relativeTime,
  riskBadgeVariant,
  riskLabel,
  statusBadgeVariant,
} from "./partner-dashboard-helpers";

const BASE = "/api/super-admin/partner-dashboard";

function metricValue(value: Metric<number>, format = formatCount) {
  return value.available ? format(value.value) : "—";
}

function alertDestination(alert: DashboardAlert): string {
  // `kind` is raw event data (for example partner_mfa_admin_reset), so it is not a stable
  // navigation taxonomy. getAlerts owns these source-prefixed ids; use that explicit contract.
  if (alert.id.startsWith("sec-")) return `/admin/partners/${alert.partnerId}/security`;
  if (alert.id.startsWith("credit-")) return `/admin/partners/${alert.partnerId}/credits`;
  if (alert.id.startsWith("lock-")) return `/admin/partners/${alert.partnerId}/staff`;
  if (alert.id.startsWith("org-")) return `/admin/partners/${alert.partnerId}/onboarding`;
  if (alert.id.startsWith("esc-")) return "/admin/partners/infrastructure";
  return `/admin/partners/${alert.partnerId}`;
}

function PartnerRow({ partner }: { partner: PartnerTableRow }) {
  return (
    <tr style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}`} className="underline">
          {partner.shopName}
        </Link>
        <div className="text-xs opacity-60">{partner.publicRef}</div>
      </td>
      <td>
        <Badge variant={statusBadgeVariant(partner.status)}>{partner.status}</Badge>
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/onboarding`} className="underline">
          {partner.onboardingStage}
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/staff`} className="underline">
          {formatCount(partner.activeStaff)}
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/locations`} className="underline">
          {partner.activeLocations === 0 ? "No active locations" : formatCount(partner.activeLocations)}
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/stations`} className="underline">
          {partner.stationAttention === 0 ? "No issues" : `${formatCount(partner.stationAttention)} need attention`}
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/cards`} className="underline">
          {formatCount(partner.cardsInPipeline)}
        </Link>
      </td>
      <td>
        {partner.availableCredits === null ? (
          "—"
        ) : (
          <Link href={`/admin/partners/${partner.partnerId}/credits`} className="underline">
            {formatCredits(partner.availableCredits)}
          </Link>
        )}
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/security`} className="underline">
          <Badge variant={riskBadgeVariant(partner.riskStatus.level)}>{riskLabel(partner.riskStatus.level)}</Badge>
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${partner.partnerId}/activity`} className="underline">
          {relativeTime(partner.lastActivityAt)}
        </Link>
      </td>
    </tr>
  );
}

export default function PartnerNetworkOverviewPage() {
  const [pathname, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setAuthed(d?.authenticated === true))
      .catch(() => live && setAuthed(false));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (authed === false)
      navigate(
        `/admin/login?next=${encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)}`,
        { replace: true }
      );
  }, [authed, navigate, pathname]);
  const network = useQuery<{ overview: PartnerNetworkOverview }>({
    queryKey: [BASE],
    queryFn: () => apiRequest("GET", BASE).then((r) => r.json()),
    enabled: authed === true,
    refetchInterval: 60_000,
  });
  const overview = network.data?.overview;
  const partners = useMemo(() => overview?.partners.rows ?? [], [overview]);
  if (authed === null || network.isLoading)
    return <div className="admin-root grid min-h-[60vh] place-items-center">Loading Partner Network…</div>;
  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Partner Network"
      crumb="Overview"
    >
      {network.isError ? (
        <Panel title="Partner Network unavailable">
          <div role="alert">The consolidated Partner Network overview could not be loaded.</div>
        </Panel>
      ) : (
        overview && (
          <>
            <Panel
              title="Network overview"
              sub="Authoritative consolidated projection; unavailable metrics are shown as —, never as zero."
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label="Partners" value={formatCount(overview.summary.shops.total)} mono />
                <StatCard label="Active" value={formatCount(overview.summary.shops.active)} mono />
                <StatCard label="Onboarding" value={formatCount(overview.summary.shops.onboarding)} mono />
                <StatCard label="Suspended" value={formatCount(overview.summary.shops.suspended)} mono />
                <StatCard label="Partner staff" value={formatCount(overview.summary.staff.active)} mono />
                <StatCard label="Cards in progress" value={formatCount(overview.summary.work.inProgress)} mono />
                <StatCard
                  label="Open corrections"
                  value={formatCount(overview.summary.corrections.openEscalations)}
                  mono
                />
                <StatCard label="Security alerts" value={formatCount(overview.summary.security.openAlerts)} mono />
                <StatCard
                  label="Available credits"
                  value={metricValue(overview.summary.credits.totalAvailable, formatCredits)}
                  mono
                />
                <StatCard
                  label="Reserved credits"
                  value={metricValue(overview.summary.credits.totalReserved, formatCredits)}
                  mono
                />
              </div>
            </Panel>
            <Panel title="Operational alerts" className="mt-4">
              {overview.alerts.length === 0 ? (
                <div>No alerts. Nothing needs attention right now.</div>
              ) : (
                <ul className="grid gap-2">
                  {overview.alerts.map((alert) => (
                    <li key={alert.id} className="flex flex-wrap items-center gap-2">
                      <Badge variant={alertBadgeVariant(alert.severity)}>{alert.severity.toUpperCase()}</Badge>
                      <Link href={alertDestination(alert)} className="underline">
                        {alert.partnerName}: {alert.reason}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <section id="partners">
              <Panel
                title="Partners"
                sub={`${overview.partners.total} partner(s); first ${partners.length} are shown in this bounded overview.`}
                className="mt-4"
              >
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm" data-testid="pn-overview-partners">
                    <thead>
                      <tr>
                        <th>Partner</th>
                        <th>Status</th>
                        <th>Readiness</th>
                        <th>Staff</th>
                        <th>Locations</th>
                        <th>Stations</th>
                        <th>Pipeline</th>
                        <th>Credits</th>
                        <th>Security</th>
                        <th>Activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {partners.map((partner) => (
                        <PartnerRow key={partner.partnerId} partner={partner} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </section>
          </>
        )
      )}
    </AdminShell>
  );
}
