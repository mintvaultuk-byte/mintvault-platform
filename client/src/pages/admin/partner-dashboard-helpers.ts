/**
 * Partner Master Dashboard — pure helpers.
 *
 * House convention (same as partner-management-helpers.ts): all branching logic lives here,
 * DOM-free and unit-testable, so the .tsx stays a thin renderer. No imports from React,
 * no side effects.
 */
import type { AlertSeverity, DashboardPartnerStatus, PartnerRisk } from "@shared/partner-dashboard";

export const PARTNER_DASHBOARD_BASE = "/api/super-admin/partner-dashboard";

/** Query keys. First element is the literal API path so prefix-invalidation works. */
export const dashKeys = {
  summary: () => [`${PARTNER_DASHBOARD_BASE}/summary`] as const,
  alerts: () => [`${PARTNER_DASHBOARD_BASE}/alerts`] as const,
  partners: (filters: Record<string, unknown>) => [`${PARTNER_DASHBOARD_BASE}/partners`, filters] as const,
  section: (partnerId: string, section: string) =>
    [`${PARTNER_DASHBOARD_BASE}/partners/${partnerId}/${section}`] as const,
};

export interface PartnerListFilterState {
  search: string;
  status: string;
  risk: string;
  sort: string;
  direction: string;
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: PartnerListFilterState = {
  search: "",
  status: "",
  risk: "",
  sort: "created_at",
  direction: "desc",
  page: 1,
  pageSize: 25,
};

/** Deterministic querystring — same input always yields the same string (stable query keys). */
export function dashboardQueryString(f: PartnerListFilterState): string {
  const params = new URLSearchParams();
  if (f.search.trim()) params.set("search", f.search.trim());
  if (f.status) params.set("status", f.status);
  if (f.risk) params.set("risk", f.risk);
  if (f.sort) params.set("sort", f.sort);
  if (f.direction) params.set("direction", f.direction);
  params.set("page", String(f.page));
  params.set("pageSize", String(f.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Status → Badge variant. Text always accompanies the colour (never colour-only). */
export function statusBadgeVariant(status: string): "act" | "neu" | "prog" | "wait" | "gold" | "red" {
  switch (status as DashboardPartnerStatus) {
    case "ACTIVE":
      return "act";
    case "PENDING":
      return "wait";
    case "SUSPENDED":
      return "red";
    case "REVOKED":
      return "red";
    default:
      return "neu";
  }
}

export function riskBadgeVariant(level: PartnerRisk["level"]): "act" | "neu" | "prog" | "wait" | "gold" | "red" {
  switch (level) {
    case "high":
      return "red";
    case "medium":
      return "wait";
    case "low":
      return "prog";
    default:
      return "act";
  }
}

export function alertBadgeVariant(severity: AlertSeverity): "act" | "neu" | "prog" | "wait" | "gold" | "red" {
  switch (severity) {
    case "critical":
    case "high":
      return "red";
    case "medium":
      return "wait";
    default:
      return "neu";
  }
}

export function riskLabel(level: PartnerRisk["level"]): string {
  return level === "none" ? "OK" : level.toUpperCase();
}

/**
 * Super-admin endpoints return `{error:{code,message}}`, and `throwIfResNotOk` puts that OBJECT
 * into `new Error(...)`, which stringifies to "[object Object]". Always read `err.body`, never
 * `err.message`. Same defect the portal's partnerErrorMessage exists to solve.
 */
export function dashboardErrorMessage(err: unknown, fallback = "Something went wrong."): string {
  const body = (err as { body?: { error?: { message?: string } | string } })?.body;
  if (body && typeof body.error === "object" && body.error?.message) return body.error.message;
  if (body && typeof body.error === "string") return body.error;
  const status = (err as { status?: number })?.status;
  if (status === 403) return "Super Admin access is required to view this dashboard.";
  if (status === 401) return "Your admin session has expired. Please sign in again.";
  return fallback;
}

/** True when the error means "signed out", so the page can route to login instead of showing an empty grid. */
export function isAuthError(err: unknown): boolean {
  return (err as { status?: number })?.status === 401;
}

/** Compact number formatting for dense KPI tiles. Large values must not blow the layout. */
export function formatCount(n: number | null | undefined): string {
  if (n == null) return "—";
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-GB");
}

/** Credits are whole units; null means "no wallet / schema not present here", not zero. */
export function formatCredits(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-GB");
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3d ago" style relative time — there is no shared helper for this in the repo. */
export function relativeTime(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return "Never";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, now - t);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/** Long shop names must truncate predictably rather than break the table layout. */
export function truncateName(name: string, max = 42): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1).trimEnd()}…`;
}

/** Drill-down tabs, in the order the brief specifies. */
export const DRILLDOWN_TABS = [
  { key: "overview", label: "Overview" },
  { key: "staff", label: "Staff" },
  { key: "wallet", label: "Wallet & Ledger" },
  { key: "submissions", label: "Submissions" },
  { key: "quality", label: "Quality" },
  { key: "corrections", label: "Corrections" },
  { key: "devices", label: "Devices" },
  { key: "security", label: "Security" },
  { key: "audit", label: "Audit Timeline" },
] as const;

export type DrilldownTab = (typeof DRILLDOWN_TABS)[number]["key"];

export function isDrilldownTab(v: unknown): v is DrilldownTab {
  return typeof v === "string" && DRILLDOWN_TABS.some((t) => t.key === v);
}

export const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "PENDING", label: "Onboarding" },
  { key: "SUSPENDED", label: "Suspended" },
  { key: "REVOKED", label: "Revoked" },
] as const;

export const RISK_FILTERS = [
  { key: "", label: "Any risk" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "none", label: "OK" },
] as const;

export const SORT_OPTIONS = [
  { key: "created_at", label: "Newest" },
  { key: "legal_name", label: "Shop name" },
  { key: "status", label: "Status" },
  { key: "submissions", label: "Submissions" },
  { key: "last_activity", label: "Last activity" },
] as const;
