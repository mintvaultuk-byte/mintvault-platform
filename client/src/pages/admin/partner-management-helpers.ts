/**
 * G5 Partner-management admin UI — pure helpers.
 *
 * DOM-free and side-effect-free so they are unit-testable without a browser/RTL harness (the repo has
 * none). Status→badge mapping, the client mirror of the server status lifecycle, reason validation,
 * and query-key/query-string builders live here; the page components are thin renderers over these.
 */
import type { AdminBadgeVariant } from "@/components/admin";

export const PARTNER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/** Deterministic status → admin badge variant (never colour-only: the badge also carries the text). */
export function statusBadgeVariant(status: string): AdminBadgeVariant {
  switch (status) {
    case "ACTIVE":
      return "act";
    case "PENDING":
      return "wait";
    case "SUSPENDED":
      return "prog";
    case "REVOKED":
      return "red";
    default:
      return "neu";
  }
}

/** Client mirror of the server's business-status lifecycle (label-only; the server re-validates). */
const STATUS_TRANSITIONS: Record<PartnerStatus, PartnerStatus[]> = {
  PENDING: ["ACTIVE", "REVOKED"],
  ACTIVE: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
};

export function isPartnerStatus(s: string): s is PartnerStatus {
  return (PARTNER_STATUSES as readonly string[]).includes(s);
}

export function allowedNextStatuses(from: string): PartnerStatus[] {
  return isPartnerStatus(from) ? [...STATUS_TRANSITIONS[from]] : [];
}

/** SUSPENDED/REVOKED are destructive-sounding business labels → require a typed confirmation. */
export function isHighRiskStatus(to: string): boolean {
  return to === "SUSPENDED" || to === "REVOKED";
}

export const CONTACT_TYPES = ["general", "billing", "technical", "operations"] as const;
export const ORGANISATION_KINDS = [
  "shop",
  "independent_grader",
  "franchise",
  "scanning_centre",
  "enterprise",
  "other",
] as const;

/** A mutation reason is valid when non-blank and within bounds. */
export function reasonValid(reason: string): boolean {
  const t = (reason ?? "").trim();
  return t.length > 0 && t.length <= 2000;
}

/** A note body is valid when non-blank and within bounds. */
export function noteValid(body: string): boolean {
  const t = (body ?? "").trim();
  return t.length > 0 && t.length <= 10000;
}

/** Human label for an unavailable metric (never rendered as a fake 0). */
export const UNAVAILABLE_LABEL = "Unavailable — no tenant-linked source yet";

export const PARTNER_PILOT_FLAG_BASE = "/api/super-admin/partner-flags";
export const PARTNER_PILOT_READONLY_FLAG = "partner_portal_enabled" as const;
export const PARTNER_PILOT_MUTABLE_FLAGS = ["partner_onboarding_enabled", "partner_login_enabled"] as const;
export type PartnerPilotMutableFlag = (typeof PARTNER_PILOT_MUTABLE_FLAGS)[number];
export type PartnerPilotDisplayFlag = PartnerPilotMutableFlag | typeof PARTNER_PILOT_READONLY_FLAG;

export const PARTNER_PILOT_FLAG_LABELS: Record<PartnerPilotDisplayFlag, string> = {
  partner_portal_enabled: "Partner Portal",
  partner_onboarding_enabled: "Partner Onboarding",
  partner_login_enabled: "Partner Login",
};

export function isPartnerPilotMutableFlag(flag: string): flag is PartnerPilotMutableFlag {
  return (PARTNER_PILOT_MUTABLE_FLAGS as readonly string[]).includes(flag);
}

// ---- Query-key builders (literal API paths so prefix-invalidation works) --------------------------
const BASE = "/api/super-admin/partner-management";
export const pmKeys = {
  partners: (filters: Record<string, unknown>) => [`${BASE}/partners`, filters] as const,
  pilotFlags: () => [PARTNER_PILOT_FLAG_BASE] as const,
  partner: (id: string) => [`${BASE}/partners/${id}`] as const,
  users: (id: string) => [`${BASE}/partners/${id}/users`] as const,
  contacts: (id: string) => [`${BASE}/partners/${id}/contacts`] as const,
  branding: (id: string) => [`${BASE}/partners/${id}/branding`] as const,
  notes: (id: string) => [`${BASE}/partners/${id}/notes`] as const,
  activity: (id: string) => [`${BASE}/partners/${id}/activity`] as const,
  statistics: (id: string) => [`${BASE}/partners/${id}/statistics`] as const,
  audit: (id: string) => [`${BASE}/partners/${id}/audit`] as const,
};

/** Deterministic query-string for the partners list (only set filters emitted). */
export function partnersQueryString(filters: {
  search?: string;
  status?: string;
  kind?: string;
  page?: number;
  pageSize?: number;
}): string {
  const p = new URLSearchParams();
  if (filters.status) p.set("status", filters.status);
  if (filters.kind) p.set("kind", filters.kind);
  if (filters.search) p.set("search", filters.search);
  if (filters.page) p.set("page", String(filters.page));
  if (filters.pageSize) p.set("pageSize", String(filters.pageSize));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}
