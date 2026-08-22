/**
 * PARTNER NETWORK — OVERVIEW. The command centre.
 *
 * It answers one question: what needs me right now? Everything else lives one click away in Shops
 * or inside a shop's own workspace.
 *
 * WHAT WAS REMOVED, AND WHY. This page used to render the full ten-column partner table — the same
 * table Shops renders, and the same one the old Partner Master Dashboard rendered, so the network's
 * shop list existed three times in three layouts. It is now built once, on Shops. Overview links to
 * it rather than reproducing it.
 *
 * ONE BOUNDED SERVER PROJECTION, unchanged: /api/super-admin/partner-dashboard. No client fan-out,
 * no second authority, and an unavailable metric still renders as — rather than as a zero, because
 * "we cannot tell" and "none" are different facts.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminButton, AdminShell, Badge, Panel, StatCard, type AdminBadgeVariant } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";
import type { Metric, PartnerNetworkOverview } from "@shared/partner-dashboard";
import { formatCount, formatCredits } from "./partner-dashboard-helpers";
import { activePipeline, isBottleneck, needsAttention, type AttentionSeverity } from "./partner-network-attention";

const BASE = "/api/super-admin/partner-dashboard";

function metricValue(value: Metric<number>, format = formatCount) {
  return value.available ? format(value.value) : "—";
}

const SEVERITY_VARIANT: Record<AttentionSeverity, AdminBadgeVariant> = {
  critical: "red",
  warning: "wait",
  info: "act",
};

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
  const attention = useMemo(() => needsAttention(overview), [overview]);
  const pipeline = useMemo(() => activePipeline(overview?.summary.work.byState), [overview]);
  const scannersWaiting = useMemo(
    () => (overview?.partners.rows ?? []).reduce((total, shop) => total + shop.stationsPendingApproval, 0),
    [overview]
  );

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
          <div data-testid="pn-overview-root">
            {/*
             * SEVEN NUMBERS, not twenty. Each one either tells the operator the network is healthy
             * or sends them somewhere. Anything that could not move a decision was cut.
             */}
            <Panel title="Network" sub="Unavailable metrics show as — , never as zero.">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7" data-testid="pn-overview-summary">
                <StatCard label="Shops" value={formatCount(overview.summary.shops.total)} mono />
                <StatCard label="Active" value={formatCount(overview.summary.shops.active)} mono />
                <StatCard label="Onboarding" value={formatCount(overview.summary.shops.onboarding)} mono />
                <StatCard label="Cards in progress" value={formatCount(overview.summary.work.inProgress)} mono />
                <StatCard label="Scanners to approve" value={formatCount(scannersWaiting)} mono />
                <StatCard
                  label="Available credits"
                  value={metricValue(overview.summary.credits.totalAvailable, formatCredits)}
                  mono
                />
                <StatCard label="Security alerts" value={formatCount(overview.summary.security.openAlerts)} mono />
              </div>
            </Panel>

            {/* The reason this page exists. Directly under the numbers, above everything else. */}
            <Panel title="Needs attention" className="mt-4">
              {attention.length === 0 ? (
                <div data-testid="pn-attention-none" className="py-2">
                  ALL SHOPS OPERATING NORMALLY
                </div>
              ) : (
                <ul className="grid gap-2" data-testid="pn-attention-list">
                  {attention.map((item) => (
                    <li
                      key={item.id}
                      data-testid={`pn-attention-${item.id}`}
                      data-severity={item.severity}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Badge variant={SEVERITY_VARIANT[item.severity]}>{item.severity.toUpperCase()}</Badge>
                      <Link href={`/admin/partners/${item.shopId}`} className="font-semibold underline">
                        {item.shopName}
                      </Link>
                      <span>{item.message}</span>
                      <Link href={item.href} className="underline opacity-90">
                        {item.actionLabel} →
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/*
             * The pipeline appears ONLY when something is in it. The screen this replaces kept a
             * permanent band of QUEUED 0 / CLAIMED 0 / VALIDATING 0 / READY FOR IMPORT 0 …, which
             * spent a lot of desk space proving nothing was happening.
             */}
            {pipeline.length > 0 && (
              <Panel title="Work in progress" sub="Pipeline states with activity" className="mt-4">
                <div className="flex flex-wrap gap-2" data-testid="pn-overview-pipeline">
                  {pipeline.map(({ state, count }) => (
                    <div
                      key={state}
                      data-testid={`pn-pipeline-${state}`}
                      title={isBottleneck(state) ? "Bottleneck — needs a human" : undefined}
                      className="min-w-[120px] rounded-md px-3 py-1.5"
                      style={{
                        border: `1px solid ${isBottleneck(state) ? "rgba(220,80,80,.5)" : "rgba(255,255,255,.12)"}`,
                      }}
                    >
                      <div className="text-[10px] uppercase opacity-70">{state.replace(/_/g, " ")}</div>
                      <div className="text-base tabular-nums">{formatCount(count)}</div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            <Panel
              title="Shops"
              className="mt-4"
              actions={
                // The one thing an operator starts from this screen. It opens the same 10-step
                // wizard Shops links to — one onboarding authority, offered where it is reached for.
                <Link href="/admin/partners/onboarding">
                  <AdminButton size="sm" variant="gold" data-testid="pn-overview-onboard">
                    Onboard a shop
                  </AdminButton>
                </Link>
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  {overview.partners.total} shop{overview.partners.total === 1 ? "" : "s"} in the network.
                </span>
                <Link href="/admin/partners/shops" className="underline" data-testid="pn-overview-open-shops">
                  Open Shops →
                </Link>
              </div>
            </Panel>
          </div>
        )
      )}
    </AdminShell>
  );
}
