/**
 * PARTNER NETWORK — SHOPS. The one canonical list of shops in the network.
 *
 * WHY THIS FILE EXISTS. This list was previously built THREE times: on the old Partner Master
 * Dashboard, on the consolidated Overview, and again inside Partner Management. Three layouts, three
 * sets of columns, one set of facts — and each one had to be kept in step by hand. This is now the
 * only place the network-wide shop list is rendered; Overview links here, and Partner Management no
 * longer carries a copy.
 *
 * "SHOPS", NOT "PARTNERS", in the operator's language. The underlying authority is unchanged and is
 * still `partner_organisations` — no database, legal or API concept is renamed. This is a label.
 *
 * COLUMNS EARN THEIR PLACE. Public reference ids were dropped from the primary table: an operator
 * scanning for the shop that needs attention does not read a UUID, and the id is one click away in
 * the shop's own workspace. Every remaining column either states a status or is a link to the exact
 * place that fixes it.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminButton, AdminShell, Badge, Panel } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";
import type { PartnerNetworkOverview, PartnerTableRow } from "@shared/partner-dashboard";
import {
  formatCount,
  formatCredits,
  relativeTime,
  riskBadgeVariant,
  riskLabel,
  statusBadgeVariant,
} from "./partner-dashboard-helpers";
import { LOW_CREDIT_THRESHOLD } from "./partner-network-attention";
import { nextActionHref } from "./partner-network-lifecycle";

const BASE = "/api/super-admin/partner-dashboard";

type ShopFilter = "all" | "attention" | "onboarding" | "active";

/** Does this shop need a human? The same conditions Overview's Needs Attention acts on. */
function needsAttention(shop: PartnerTableRow): boolean {
  return (
    shop.stationsPendingApproval > 0 ||
    shop.activeLocations === 0 ||
    shop.stationAttention > 0 ||
    shop.alertCount > 0 ||
    (shop.availableCredits !== null && shop.availableCredits < LOW_CREDIT_THRESHOLD)
  );
}

function ScannerCell({ shop }: { shop: PartnerTableRow }) {
  if (shop.stationsPendingApproval > 0) {
    return (
      <Link href={`/admin/partners/${shop.partnerId}/onboarding`} className="underline">
        <Badge variant="wait">{shop.stationsPendingApproval} TO APPROVE</Badge>
      </Link>
    );
  }
  if (shop.stationAttention > 0) {
    return (
      <Link href={`/admin/partners/${shop.partnerId}/stations`} className="underline">
        <Badge variant="red">{shop.stationAttention} NEEDS ATTENTION</Badge>
      </Link>
    );
  }
  return (
    <Link href={`/admin/partners/${shop.partnerId}/stations`} className="underline opacity-70">
      OK
    </Link>
  );
}

function CreditsCell({ shop }: { shop: PartnerTableRow }) {
  // null is "the wallet authority could not be read" and must never render as a zero balance.
  if (shop.availableCredits === null) return <span title="Credit balance unavailable">—</span>;
  const low = shop.availableCredits < LOW_CREDIT_THRESHOLD;
  return (
    <Link href={`/admin/partners/${shop.partnerId}/credits`} className="underline">
      {low ? (
        <Badge variant={shop.availableCredits <= 0 ? "red" : "wait"}>{formatCredits(shop.availableCredits)}</Badge>
      ) : (
        formatCredits(shop.availableCredits)
      )}
    </Link>
  );
}

function ShopRow({ shop }: { shop: PartnerTableRow }) {
  return (
    <tr style={{ borderTop: "1px solid rgba(255,255,255,.08)" }} data-testid={`pn-shop-${shop.partnerId}`}>
      <td className="py-2">
        <Link href={`/admin/partners/${shop.partnerId}`} className="font-semibold underline">
          {shop.shopName}
        </Link>
        {shop.tradingName && shop.tradingName !== shop.shopName && (
          <div className="text-xs opacity-60">{shop.tradingName}</div>
        )}
      </td>
      <td>
        <Badge variant={statusBadgeVariant(shop.status)}>{shop.status}</Badge>
      </td>
      <td>
        {/*
          * CONCISE, and from the SAME next-action authority the onboarding wizard uses — so an
          * operator scanning many shops reads the same verdict here that they will see when they
          * open one. "Onboarding" / "Onboarded" said nothing actionable; "NEXT: Approve Scanner"
          * says what to do. `null` means readiness could not be read, which is reported as such
          * rather than dressed up as a stage.
          */}
        <Link
          href={shop.nextAction ? nextActionHref(shop.partnerId, shop.nextAction) : `/admin/partners/${shop.partnerId}/onboarding`}
          className="underline"
          data-testid={`shop-next-action-${shop.partnerId}`}
          data-state={shop.nextAction?.state ?? "UNAVAILABLE"}
          title={shop.nextAction?.message ?? undefined}
        >
          {!shop.nextAction
            ? "Status unavailable"
            : shop.nextAction.state === "READY"
              ? "READY"
              : `NEXT: ${shop.nextAction.title}`}
        </Link>
      </td>
      <td>
        <CreditsCell shop={shop} />
      </td>
      <td>
        <Link href={`/admin/partners/${shop.partnerId}/cards`} className="underline">
          {formatCount(shop.cardsInPipeline)}
        </Link>
      </td>
      <td>
        <ScannerCell shop={shop} />
      </td>
      <td>
        {/*
         * Locations comes free: `activeLocations` is already on the bounded projection, so this
         * column costs no extra query. A zero is authoritative and is the condition that blocks
         * every downstream step, so it is called out rather than shown as a bare 0.
         */}
        <Link href={`/admin/partners/${shop.partnerId}/locations`} className="underline">
          {shop.activeLocations === 0 ? <Badge variant="red">NONE</Badge> : formatCount(shop.activeLocations)}
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${shop.partnerId}/staff`} className="underline">
          {formatCount(shop.activeStaff)}
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${shop.partnerId}/security`} className="underline">
          <Badge variant={riskBadgeVariant(shop.riskStatus.level)}>{riskLabel(shop.riskStatus.level)}</Badge>
        </Link>
      </td>
      <td>
        <Link href={`/admin/partners/${shop.partnerId}/activity`} className="underline">
          {relativeTime(shop.lastActivityAt)}
        </Link>
      </td>
    </tr>
  );
}

export default function PartnerNetworkShopsPage() {
  const [pathname, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ShopFilter>("all");

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

  const shops = useMemo(() => {
    const rows = overview?.partners.rows ?? [];
    const term = search.trim().toLowerCase();
    return rows.filter((shop) => {
      if (term && !`${shop.shopName} ${shop.tradingName ?? ""}`.toLowerCase().includes(term)) return false;
      if (filter === "attention") return needsAttention(shop);
      if (filter === "onboarding") return shop.status === "PENDING";
      if (filter === "active") return shop.status === "ACTIVE";
      return true;
    });
  }, [overview, search, filter]);

  if (authed === null || network.isLoading)
    return <div className="admin-root grid min-h-[60vh] place-items-center">Loading shops…</div>;

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Partner Network"
      crumb="Shops"
    >
      <div data-testid="pn-shops-root">
        <Panel
          title="Shops"
          sub={overview ? `${overview.partners.total} shop(s) in the network.` : undefined}
          actions={
            <Link href="/admin/partners/onboarding">
              <AdminButton size="sm" variant="gold" data-testid="pn-shops-onboard">
                Onboard a shop
              </AdminButton>
            </Link>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search shops…"
              aria-label="Search shops"
              data-testid="pn-shops-search"
              className="rounded-md px-3 py-1.5"
              style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", border: "1px solid #555", minWidth: 220 }}
            />
            {(["all", "attention", "onboarding", "active"] as ShopFilter[]).map((key) => (
              <AdminButton
                key={key}
                size="sm"
                variant={filter === key ? "gold" : "ghost"}
                onClick={() => setFilter(key)}
                data-testid={`pn-shops-filter-${key}`}
              >
                {key === "all"
                  ? "All"
                  : key === "attention"
                    ? "Needs attention"
                    : key === "onboarding"
                      ? "Onboarding"
                      : "Active"}
              </AdminButton>
            ))}
          </div>

          {network.isError ? (
            <div role="alert">The shop list could not be loaded.</div>
          ) : shops.length === 0 ? (
            <div data-testid="pn-shops-empty">No shops match this filter.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm" data-testid="pn-shops-table">
                <thead>
                  <tr>
                    <th>Shop</th>
                    <th>Status</th>
                    <th>Onboarding</th>
                    <th>Credits</th>
                    <th>Cards</th>
                    <th>Scanner</th>
                    <th>Locations</th>
                    <th>Staff</th>
                    <th>Alerts</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.map((shop) => (
                    <ShopRow key={shop.partnerId} shop={shop} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </AdminShell>
  );
}
