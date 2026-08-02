import { AlertTriangle, CheckCircle2, Clock3, HelpCircle, LoaderCircle, WifiOff } from "lucide-react";
import { Badge, type AdminBadgeVariant } from "@/components/admin";

export type EvidenceState = "current" | "stale" | "unknown" | "unavailable" | "contradictory" | "queued" | "running" | "succeeded" | "partial" | "failed" | "expired" | "rate_limited";

const presentation: Record<EvidenceState, { label: string; variant: AdminBadgeVariant; Icon: typeof CheckCircle2 }> = {
  current: { label: "Current", variant: "act", Icon: CheckCircle2 }, stale: { label: "Stale", variant: "gold", Icon: Clock3 }, unknown: { label: "Unknown", variant: "wait", Icon: HelpCircle }, unavailable: { label: "Unavailable", variant: "wait", Icon: WifiOff }, contradictory: { label: "Contradictory", variant: "red", Icon: AlertTriangle }, queued: { label: "Queued", variant: "prog", Icon: LoaderCircle }, running: { label: "Running", variant: "prog", Icon: LoaderCircle }, succeeded: { label: "Succeeded", variant: "act", Icon: CheckCircle2 }, partial: { label: "Partial", variant: "gold", Icon: AlertTriangle }, failed: { label: "Failed", variant: "red", Icon: AlertTriangle }, expired: { label: "Expired", variant: "red", Icon: Clock3 }, rate_limited: { label: "Rate limited", variant: "gold", Icon: Clock3 },
};

export function evidenceStateFrom(value: string | null | undefined): EvidenceState {
  const normalized = String(value ?? "unknown").toLowerCase().replace(/\s+/g, "_");
  if (normalized === "fresh" || normalized === "current") return "current";
  if (normalized === "stale") return "stale";
  if (normalized === "unavailable") return "unavailable";
  if (normalized === "contradictory") return "contradictory";
  if (normalized === "queued") return "queued";
  if (normalized === "running") return "running";
  if (normalized === "succeeded") return "succeeded";
  if (normalized === "partial") return "partial";
  if (normalized === "failed" || normalized === "cancelled") return "failed";
  if (normalized === "expired") return "expired";
  if (normalized === "rate_limited") return "rate_limited";
  return "unknown";
}

export function EvidenceStateBadge({ state, testId }: { state: EvidenceState | string | null | undefined; testId?: string }) {
  const item = presentation[evidenceStateFrom(state)];
  const Icon = item.Icon;
  return <Badge variant={item.variant} testId={testId}><Icon size={12} aria-hidden="true" /> {item.label}</Badge>;
}
