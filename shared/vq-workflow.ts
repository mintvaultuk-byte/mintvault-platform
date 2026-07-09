// =============================================================================
// VAULT QUEST — card status workflow (Phase 6)
// Pure, dependency-free, shared by server (transition gating) and client (badges,
// buttons, readiness). The status column is plain text; this module is the single
// source of truth for the state set, allowed transitions, gate rules and the
// readiness score. Zero schema — history is the existing vq_card_revisions snapshot.
// =============================================================================

export const VQ_STATUSES = [
  "draft",
  "needs_data",
  "needs_artwork",
  "needs_qa",
  "ready_for_review",
  "approved",
  "export_ready",
  "printed_proxy",
  "rejected",
  "archived",
] as const;
export type VqStatus = (typeof VQ_STATUSES)[number];

export function isVqStatus(s: string): s is VqStatus {
  return (VQ_STATUSES as readonly string[]).includes(s);
}

// Badge presentation — a semantic tone the client maps to VQ design tokens.
export type VqTone = "neutral" | "info" | "warn" | "success" | "danger";
export const STATUS_META: Record<VqStatus, { label: string; tone: VqTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  needs_data: { label: "Needs data", tone: "warn" },
  needs_artwork: { label: "Needs artwork", tone: "warn" },
  needs_qa: { label: "Needs QA", tone: "warn" },
  ready_for_review: { label: "Ready for review", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  export_ready: { label: "Export ready", tone: "success" },
  printed_proxy: { label: "Printed proxy", tone: "info" },
  rejected: { label: "Rejected", tone: "danger" },
  archived: { label: "Archived", tone: "neutral" },
};

/**
 * Gate facts a caller computes for a card (server runs renderCard + field checks;
 * the client can pass a cheaper subset for button enable/disable).
 */
export interface VqGates {
  dataComplete: boolean; // required identity + gameplay present (base card, resolved for variants)
  artworkPresent: boolean; // main artwork uploaded
  renderPasses: boolean; // renderCard QA status !== "reject"
  hasBlockingQa: boolean; // any blocking QA reject
  isVariant: boolean; // baseCardId set
  baseApproved: boolean; // variant's base is approved/export_ready/printed_proxy
}

// The states that count a card as "approved-or-beyond" (for variant-base gating).
const APPROVED_PLUS: VqStatus[] = ["approved", "export_ready", "printed_proxy"];

/**
 * Which target states each button offers from a given state. Informational
 * (needs_*) buckets are freely settable from an in-progress card; the gated
 * forward steps (ready_for_review / approved / export_ready / printed_proxy) are
 * enforced by canTransition regardless.
 */
export function allowedTargets(from: VqStatus): VqStatus[] {
  if (from === "archived") return ["draft"];
  if (from === "rejected") return ["draft", "archived"];
  const common: VqStatus[] = ["draft", "rejected", "archived"];
  switch (from) {
    case "draft":
    case "needs_data":
    case "needs_artwork":
    case "needs_qa":
      return [...new Set<VqStatus>([...common, "needs_data", "needs_artwork", "needs_qa", "ready_for_review"])];
    case "ready_for_review":
      return [...new Set<VqStatus>([...common, "approved"])];
    case "approved":
      return [...new Set<VqStatus>([...common, "export_ready"])];
    case "export_ready":
      return [...new Set<VqStatus>([...common, "printed_proxy"])];
    case "printed_proxy":
      return [...new Set<VqStatus>([...common, "export_ready"])];
    default:
      return common;
  }
}

/**
 * Can a card move from `from` to `to`? Returns the blocking reasons if not.
 * `override` bypasses the variant-base gate only (records a reason on the caller side).
 */
export function canTransition(
  from: VqStatus,
  to: VqStatus,
  gates: VqGates,
  override = false,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (from === to) return { ok: true, reasons: [] };
  if (!allowedTargets(from).includes(to)) {
    return { ok: false, reasons: [`cannot move from "${STATUS_META[from].label}" to "${STATUS_META[to].label}"`] };
  }
  // gated forward steps
  if (to === "ready_for_review") {
    if (gates.hasBlockingQa) reasons.push("has blocking QA errors — fix them before review");
  }
  if (to === "approved") {
    if (!gates.dataComplete) reasons.push("required gameplay data is missing");
    if (!gates.artworkPresent) reasons.push("artwork is missing");
    if (!gates.renderPasses) reasons.push("the card does not render (QA reject)");
    if (gates.isVariant && !gates.baseApproved && !override) {
      reasons.push("this variant's base card is not approved (override to force)");
    }
  }
  if (to === "export_ready") {
    if (!gates.renderPasses) reasons.push("the card does not render — cannot be export-ready");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * A suggested status for an in-progress card based on what's missing — used to
 * bucket drafts on the dashboard (Needs data / Needs artwork / Needs QA).
 */
export function derivedBucket(status: VqStatus, gates: VqGates): VqStatus {
  if (status !== "draft") return status;
  if (!gates.dataComplete) return "needs_data";
  if (!gates.artworkPresent) return "needs_artwork";
  if (gates.hasBlockingQa || !gates.renderPasses) return "needs_qa";
  return "draft";
}

/** 0–100 readiness for the dashboard. Weighted: data 35, artwork 25, render 25, approved 15. */
export function readinessScore(status: VqStatus, gates: VqGates): number {
  if (status === "archived" || status === "rejected") return 0;
  let s = 0;
  if (gates.dataComplete) s += 35;
  if (gates.artworkPresent) s += 25;
  if (gates.renderPasses) s += 25;
  if (APPROVED_PLUS.includes(status)) s += 15;
  return Math.min(100, s);
}

export function isApprovedPlus(status: string): boolean {
  return (APPROVED_PLUS as string[]).includes(status);
}
