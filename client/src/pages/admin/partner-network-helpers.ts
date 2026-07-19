/**
 * G4 Partner-network operations UI — pure helpers.
 *
 * DOM-free and side-effect-free so they are unit-testable without a browser/RTL harness (the repo has
 * none). All action-availability logic, status→badge mapping, reason validation, and query-key
 * construction lives here; the page component is a thin renderer over these.
 */
import type { AdminBadgeVariant } from "@/components/admin";

export type ConnectorRecordState =
  | "queued"
  | "claimed"
  | "validating"
  | "ready_for_import"
  | "importing"
  | "reconciliation_required"
  | "manual_review"
  | "rejected"
  | "failed"
  | "cancelled"
  | "imported";

/** Deterministic state → admin badge variant. */
export function stateBadgeVariant(state: string): AdminBadgeVariant {
  switch (state) {
    case "imported":
      return "act";
    case "ready_for_import":
    case "validating":
    case "importing":
      return "prog";
    case "queued":
    case "claimed":
      return "neu";
    case "reconciliation_required":
    case "manual_review":
      return "wait";
    case "failed":
    case "rejected":
    case "cancelled":
      return "red";
    default:
      return "neu";
  }
}

/** Whether a "retry" action is offered for a record (client-side gating; server re-enforces). */
export function canRetry(state: string, mappingState?: string | null): boolean {
  if (mappingState === "reserved") return true;
  return state === "ready_for_import" || state === "importing";
}

/** Whether a "resolve manual review" action is offered. */
export function canResolveManualReview(state: string): boolean {
  return state === "manual_review";
}

/** Whether an "acknowledge permanent failure" action is offered. */
export function canAckFailure(state: string): boolean {
  return state === "failed";
}

/** Whether a "request reconciliation" action is offered (not on terminal-clean states). */
export function canReconcile(state: string): boolean {
  return state !== "cancelled" && state !== "rejected";
}

/** Whether a "release expired claim" action is offered (client hint; server enforces expiry). */
export function canReleaseClaim(record: { claimExpiresAt?: string | null }): boolean {
  if (!record.claimExpiresAt) return false;
  return new Date(record.claimExpiresAt).getTime() <= Date.now();
}

/** Human-readable "why this action is unavailable" for a disabled control. */
export function unavailableReason(action: string, state: string): string {
  switch (action) {
    case "retry":
      return `Retry is only available for ready-for-import / interrupted records (this is '${state}').`;
    case "resolve":
      return `Manual-review resolution is only available while in manual_review (this is '${state}').`;
    case "ack":
      return `Acknowledging a permanent failure is only available while in failed (this is '${state}').`;
    default:
      return `Not available in state '${state}'.`;
  }
}

/** A mutation reason is valid when non-blank and within length bounds. */
export function reasonValid(reason: string): boolean {
  const t = (reason ?? "").trim();
  return t.length > 0 && t.length <= 2000;
}

/** High-risk actions require a typed confirmation phrase; safe ops only need a reason. */
export function requiresTypedConfirm(action: string): boolean {
  return action === "ack" || action === "resolve-cancel";
}

// ---- Query-key builders (literal API paths so the default fetcher + prefix-invalidation work) ----
const BASE = "/api/super-admin/connector-ops";
export const opsKeys = {
  partners: (search?: string) => [`${BASE}/partners`, search ?? ""] as const,
  records: (filters: Record<string, unknown>) => [`${BASE}/records`, filters] as const,
  record: (id: string) => [`${BASE}/records/${id}`] as const,
  attempts: (id: string) => [`${BASE}/records/${id}/attempts`] as const,
  audit: (id: string) => [`${BASE}/records/${id}/audit`] as const,
  manualReview: () => [`${BASE}/manual-review`] as const,
  reconciliation: () => [`${BASE}/reconciliation`] as const,
  workerStatus: () => [`${BASE}/worker/status`] as const,
};

/** Build the query-string for the records list from a filter object (deterministic order). */
export function recordsQueryString(filters: {
  partnerId?: string;
  state?: string;
  reconciliationRequired?: boolean;
  manualReview?: boolean;
  failed?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}): string {
  const p = new URLSearchParams();
  if (filters.partnerId) p.set("partnerId", filters.partnerId);
  if (filters.state) p.set("state", filters.state);
  if (filters.reconciliationRequired) p.set("reconciliationRequired", "true");
  if (filters.manualReview) p.set("manualReview", "true");
  if (filters.failed) p.set("failed", "true");
  if (filters.search) p.set("search", filters.search);
  if (filters.page) p.set("page", String(filters.page));
  if (filters.pageSize) p.set("pageSize", String(filters.pageSize));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}
