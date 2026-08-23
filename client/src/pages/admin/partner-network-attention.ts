/**
 * NEEDS ATTENTION — turning the Partner Network projection into a list of things to actually do.
 *
 * WHY THIS IS A PURE FUNCTION IN ITS OWN FILE. It is the one piece of judgement on the Overview
 * screen, and the whole point of the screen is that an operator can trust it: if this list is empty
 * the network is genuinely fine, and if it is not empty every row is something a human can act on
 * right now. A rule buried in JSX gets verified by looking at it, once.
 *
 * IT NO LONGER DECIDES WHAT IS WRONG. It used to read raw projection counts —
 * `stationsPendingApproval`, `activeLocations`, `availableCredits`, `stationAttention`, `status` —
 * and rank them with its own severity rules. That was a SECOND blocker calculation over the same
 * question `derivePartnerOperationalReadiness` was already answering for the onboarding wizard, and
 * the two could disagree about the same shop: the wizard would say "address required" while this
 * list said "approve Scanner". Each row is now the server's single `nextAction` verdict for that
 * shop, rendered verbatim, with its destination resolved by the one shared helper.
 *
 * TWO JUDGEMENTS REMAIN, deliberately. Severity — how loudly to say it — is mapped from the
 * verdict's own state. And low credits stays as a WARNING, because readiness blocks at zero and
 * says nothing about "getting low"; that is a gap this surface fills rather than a rule it
 * duplicates. `availableCredits === null` means the wallet authority could not be read and is still
 * withheld: "we cannot tell" and "zero" are different facts.
 *
 * ORDERING IS THE PRODUCT. The operator reads top-down and stops when they run out of time, so the
 * order is "what blocks a shop from working", not "what is most numerous".
 */
import type { DashboardAlert, PartnerNetworkOverview, PartnerTableRow } from "@shared/partner-dashboard";
import { nextActionHref } from "./partner-network-lifecycle";

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

/**
 * ONE row per shop, from the ONE next-action authority.
 *
 * This used to re-derive blockers from raw projection counts — stationsPendingApproval,
 * activeLocations, availableCredits, stationAttention, status — and rank them with its own
 * severity list. That was a second calculation over the same question the onboarding wizard was
 * already answering from readiness, and the two could disagree about the same shop: the wizard
 * would say "address required" while this list said "approve Scanner", because they were reading
 * different things and ordering them differently.
 *
 * Now the server decides, once, and this file renders. The only judgement left here is severity —
 * how loudly to say it — and the low-credit WARNING below, which readiness deliberately does not
 * answer because it is not a blocker.
 */
function shopItems(shop: PartnerTableRow): AttentionItem[] {
  const items: AttentionItem[] = [];
  const next = shop.nextAction;

  if (next === null) {
    /*
     * Readiness could not be established. Say so rather than falling back to the old count-ranking
     * rules: a quiet second calculation is precisely what this consolidation removed, and "we
     * cannot tell" is a different fact from "nothing is wrong".
     */
    items.push({
      id: `readiness-unavailable-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      severity: "warning",
      message: "Setup status could not be read for this shop.",
      actionLabel: "Open shop",
      href: `/admin/partners/${shop.partnerId}`,
    });
  } else if (next.state !== "READY") {
    items.push({
      id: `next-${shop.partnerId}`,
      shopId: shop.partnerId,
      shopName: shop.shopName,
      // BLOCKED stops work outright; PENDING is correctly in progress; UNKNOWN is unproven.
      severity: next.state === "BLOCKED" ? "critical" : "warning",
      message: next.message,
      actionLabel: next.action?.label ?? next.title,
      href: nextActionHref(shop.partnerId, next),
    });
  }

  /*
   * Low credits is a WARNING the readiness contract deliberately does not make: it blocks at zero
   * and says nothing about "getting low". It is not a competing blocker calculation, so it stays —
   * but only when zero is not already the next action, so one shop never gets two credit rows.
   * `null` is withheld deliberately: "we cannot tell" is not "no credits".
   */
  if (
    next?.code !== "CREDITS_REQUIRED" &&
    shop.availableCredits !== null &&
    shop.availableCredits > 0 &&
    shop.availableCredits < LOW_CREDIT_THRESHOLD
  ) {
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
