/**
 * NEEDS ATTENTION — turning the Partner Network projection into a list of things to actually do.
 *
 * WHY THIS IS A PURE FUNCTION IN ITS OWN FILE. It is the one piece of judgement on the Overview
 * screen, and the whole point of the screen is that an operator can trust it: if this list is empty
 * the network is genuinely fine, and if it is not empty every row is something a human can act on
 * right now. A rule buried in JSX gets verified by looking at it, once.
 *
 * IT DECIDES NOTHING NEW. Every input is already an authoritative value on the server projection —
 * `stationsPendingApproval`, `availableCredits`, `activeLocations`, `status`, `riskStatus`, and the
 * server's own `alerts[]`. Nothing here recomputes readiness, invents a threshold the server
 * disagrees with, or turns an unavailable metric into a number. `availableCredits === null` means
 * the wallet authority could not be read, and it is deliberately NOT reported as "no credits":
 * "we cannot tell" and "zero" are different facts, exactly as the dashboard contract requires.
 *
 * ORDERING IS THE PRODUCT. The operator reads top-down and stops when they run out of time, so the
 * order is "what blocks a shop from working", not "what is most numerous".
 */
import type { DashboardAlert, PartnerNetworkOverview, PartnerTableRow } from "@shared/partner-dashboard";

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionItem {
  /** Stable within a render, so React keys and tests do not depend on array position. */
  id: string;
  shopId: string;
  shopName: string;
  severity: AttentionSeverity;
  /** What is wrong, in the operator's words. Never a code, never a table name. */
  message: string;
  /** The single thing to do about it. */
  actionLabel: string;
  /** Where that action lives. Always inside the shop's own workspace unless genuinely network-wide. */
  href: string;
}

/** Below this a shop cannot start many more cards, so it is worth raising before it hits zero. */
export const LOW_CREDIT_THRESHOLD = 5;

/**
 * Deep links for the server's own alert feed.
 *
 * `alert.kind` is raw event data (e.g. partner_mfa_admin_reset) and is NOT a navigation taxonomy;
 * `getAlerts` owns the source-prefixed id, so that explicit contract is what is matched here. This
 * mirrors the mapping the Overview page already used, kept in one place now that two surfaces need
 * it.
 */
export function alertDestination(alert: Pick<DashboardAlert, "id" | "partnerId">): string {
  if (alert.id.startsWith("sec-")) return `/admin/partners/${alert.partnerId}/security`;
  if (alert.id.startsWith("credit-")) return `/admin/partners/${alert.partnerId}/credits`;
  if (alert.id.startsWith("lock-")) return `/admin/partners/${alert.partnerId}/staff`;
  if (alert.id.startsWith("org-")) return `/admin/partners/${alert.partnerId}/onboarding`;
  if (alert.id.startsWith("esc-")) return "/admin/partners/settings/infrastructure";
  // A paid supplies order stuck behind a human decision. Network-wide, so it goes to Supplies.
  if (alert.id.startsWith("supply-")) return "/admin/partners/supplies";
  return `/admin/partners/${alert.partnerId}`;
}

function alertAction(alert: Pick<DashboardAlert, "id">): string {
  if (alert.id.startsWith("sec-")) return "Review security";
  if (alert.id.startsWith("credit-")) return "Open credits";
  if (alert.id.startsWith("lock-")) return "Open staff";
  if (alert.id.startsWith("org-")) return "Continue onboarding";
  if (alert.id.startsWith("esc-")) return "Open infrastructure";
  if (alert.id.startsWith("supply-")) return "Open supplies";
  return "Open shop";
}

/** Per-shop conditions the projection can prove. Ordered by how hard they block real work. */
function shopItems(shop: PartnerTableRow): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. A Mac is enrolled and waiting on US. Nothing the shop does clears this.
  if (shop.stationsPendingApproval > 0) {
    items.push({
      id: `station-approval-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "critical",
      message:
        shop.stationsPendingApproval === 1
          ? "A Scanner is waiting for approval."
          : `${shop.stationsPendingApproval} Scanners are waiting for approval.`,
      actionLabel: "Approve Scanner",
      // The onboarding wizard approves inline; it is the surface that already owns this decision.
      href: `/admin/partners/${shop.partnerId}/onboarding`,
    });
  }

  // 2. No active location means no operator can be assigned and no station can enrol against it.
  if (shop.activeLocations === 0) {
    items.push({
      id: `location-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "critical",
      message: "No active location, so no Scanner can be set up.",
      actionLabel: "Fix location",
      href: `/admin/partners/${shop.partnerId}/locations`,
    });
  }

  // 3. Zero credits stops NEW cards outright; low credits is a warning, not a stoppage.
  //    `null` is withheld deliberately — see the note at the top of this file.
  if (shop.availableCredits !== null && shop.availableCredits <= 0) {
    items.push({
      id: `credits-zero-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "critical",
      message: "No Grading Credits left, so this shop cannot start a card.",
      actionLabel: "Open credits",
      href: `/admin/partners/${shop.partnerId}/credits`,
    });
  } else if (shop.availableCredits !== null && shop.availableCredits < LOW_CREDIT_THRESHOLD) {
    items.push({
      id: `credits-low-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "warning",
      message: `Only ${shop.availableCredits} Grading Credit${shop.availableCredits === 1 ? "" : "s"} left.`,
      actionLabel: "Open credits",
      href: `/admin/partners/${shop.partnerId}/credits`,
    });
  }

  /*
   * 4. Scanner health. Reported only for stations that are NOT merely pending approval, so a shop
   *    whose only station is awaiting our approval gets one clear instruction rather than two rows
   *    describing the same Mac.
   */
  const unhealthy = shop.stationAttention - shop.stationsPendingApproval;
  if (unhealthy > 0) {
    items.push({
      id: `scanner-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "warning",
      message:
        unhealthy === 1
          ? "A Scanner is offline or needs calibration."
          : `${unhealthy} Scanners are offline or need calibration.`,
      actionLabel: "Open Scanner",
      href: `/admin/partners/${shop.partnerId}/stations`,
    });
  }

  // 5. Still in onboarding. Last, because it is a state to finish rather than a fault to repair.
  if (shop.status === "PENDING") {
    items.push({
      id: `onboarding-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "info",
      message: "Onboarding is not finished.",
      actionLabel: "Continue onboarding",
      href: `/admin/partners/${shop.partnerId}/onboarding`,
    });
  }

  return items;
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** The server's alert severities, mapped onto the three the operator sees. */
function severityOf(alert: DashboardAlert): AttentionSeverity {
  if (alert.severity === "critical" || alert.severity === "high") return "critical";
  if (alert.severity === "medium") return "warning";
  return "info";
}

/**
 * Everything that needs a human, most-blocking first.
 *
 * Server alerts and derived shop conditions are merged rather than shown as two lists, because an
 * operator does not care which query produced a problem — and two lists is how the surface being
 * replaced ended up rendering the same shop three times.
 */
export function needsAttention(overview: PartnerNetworkOverview | undefined): AttentionItem[] {
  if (!overview) return [];

  const fromAlerts: AttentionItem[] = overview.alerts.map((alert) => ({
    id: alert.id,
    shopId: alert.partnerId,
    shopName: alert.partnerName,
    severity: severityOf(alert),
    message: alert.reason,
    actionLabel: alertAction(alert),
    href: alertDestination(alert),
  }));

  const fromShops = overview.partners.rows.flatMap(shopItems);

  /*
   * De-duplicated by (shop, action destination). The server may already be alerting on low credits
   * for the same shop this file would flag, and telling the operator twice about one problem is the
   * duplication this whole consolidation exists to remove. First writer wins: server alerts are
   * listed first and carry the server's own wording.
   */
  const seen = new Set<string>();
  const merged: AttentionItem[] = [];
  for (const item of [...fromAlerts, ...fromShops]) {
    const key = `${item.shopId}|${item.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  // Stable: severity first, then shop name, so the list does not reshuffle between refreshes.
  return merged.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.shopName.localeCompare(b.shopName)
  );
}

/**
 * The operational pipeline, but only when it has something to say.
 *
 * The screen being replaced permanently reserved a wide band for QUEUED 0 / CLAIMED 0 /
 * VALIDATING 0 / READY FOR IMPORT 0 / IMPORTING 0 …, which is a lot of desk space spent proving
 * nothing is happening. Returning an empty array when every state is zero lets the caller render
 * nothing at all.
 */
export function activePipeline(byState: Record<string, number> | undefined): Array<{ state: string; count: number }> {
  if (!byState) return [];
  return Object.entries(byState)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
}

/** Connector states that mean work is stuck behind a human decision. */
const BOTTLENECKS = new Set(["manual_review", "reconciliation_required", "failed"]);

export function isBottleneck(state: string): boolean {
  return BOTTLENECKS.has(state);
}
