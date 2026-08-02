import { AlertTriangle, CheckCircle2, Clock3, HelpCircle, LoaderCircle, WifiOff } from "lucide-react";
import { Badge, type AdminBadgeVariant } from "@/components/admin";
import type { CiConclusion } from "@shared/project-control-overview";

export type EvidenceState =
  | "current"
  | "stale"
  | "unknown"
  | "unavailable"
  | "contradictory"
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "expired"
  | "rate_limited";

const presentation: Record<EvidenceState, { label: string; variant: AdminBadgeVariant; Icon: typeof CheckCircle2 }> = {
  current: { label: "Current", variant: "act", Icon: CheckCircle2 },
  stale: { label: "Stale", variant: "gold", Icon: Clock3 },
  unknown: { label: "Unknown", variant: "wait", Icon: HelpCircle },
  unavailable: { label: "Unavailable", variant: "wait", Icon: WifiOff },
  contradictory: { label: "Contradictory", variant: "red", Icon: AlertTriangle },
  queued: { label: "Queued", variant: "prog", Icon: LoaderCircle },
  running: { label: "Running", variant: "prog", Icon: LoaderCircle },
  succeeded: { label: "Succeeded", variant: "act", Icon: CheckCircle2 },
  partial: { label: "Partial", variant: "gold", Icon: AlertTriangle },
  failed: { label: "Failed", variant: "red", Icon: AlertTriangle },
  expired: { label: "Expired", variant: "red", Icon: Clock3 },
  rate_limited: { label: "Rate limited", variant: "gold", Icon: Clock3 },
};

/**
 * Severity order, lowest = worst. A TOTAL Record over EvidenceState, not an array searched with
 * indexOf, for two reasons hostile review found in the array version:
 *
 *   - it listed only six of the twelve states, and `indexOf` returns -1 for a miss — so any
 *     unlisted state (failed, rate_limited, expired…) silently outranked even "unavailable";
 *   - it placed "unknown" as MILDER than "stale", so a flag that had never been observed was
 *     presented as healthier than one that was merely old. This module's whole doctrine is that
 *     UNKNOWN and STALE are different problems, and "never looked" is not the better of the two.
 *
 * Being a Record keyed by the union, the compiler now refuses a new EvidenceState without a rank.
 */
const EVIDENCE_SEVERITY: Record<EvidenceState, number> = {
  unavailable: 0,
  failed: 1,
  contradictory: 2,
  expired: 3,
  rate_limited: 4,
  unknown: 5,
  stale: 6,
  partial: 7,
  queued: 8,
  running: 9,
  succeeded: 10,
  current: 11,
};

export function evidenceStateFrom(value: string | null | undefined): EvidenceState {
  const normalized = String(value ?? "unknown")
    .toLowerCase()
    .replace(/\s+/g, "_");
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

/**
 * Map the server's CI verdict onto a badge state.
 *
 * The server speaks GitHub's vocabulary (`"success"` / `"failure"`, see CiConclusion in
 * shared/project-control-overview.ts); this component's own vocabulary is `"succeeded"` /
 * `"failed"`. Those are different words, and the generic normaliser above matched only the latter,
 * so a green build AND a red build both rendered "Unknown".
 *
 * This switch is TOTAL over the shared union. The `never` assignment in the default branch means
 * adding a member to CiConclusion fails compilation here rather than silently producing another
 * way to show Unknown — the drift is caught by tsc instead of by a founder reading a wrong badge.
 *
 * `null` stays Unknown deliberately, and truthfully: no run for this commit, or only queued /
 * in-progress / cancelled ones. That is genuinely not a verdict.
 */
export function ciEvidenceState(conclusion: CiConclusion | null | undefined): EvidenceState {
  if (conclusion == null) return "unknown";
  switch (conclusion) {
    case "success":
      return "succeeded";
    case "failure":
      return "failed";
    default: {
      const exhaustive: never = conclusion;
      return exhaustive;
    }
  }
}

/**
 * Badge state for the Flags tile — the WORST freshness across the reported flags.
 *
 * This tile used to be hard-coded: `flags.length > 0 ? "current" : "unknown"`. It was the only
 * evidence tile that could never go stale, so flag evidence past FLAG_VALID_MS rendered Current
 * while every neighbouring tile correctly showed its age.
 *
 * Worst-wins rather than first-wins or newest-wins: one stale flag among five fresh ones means the
 * picture is stale, and hiding it behind a fresh sibling is the kind of averaging that makes a
 * dashboard confidently wrong.
 */
export function flagsEvidenceState(
  flags: { meta?: { freshness?: string | null } }[] | null | undefined
): EvidenceState {
  if (!flags || flags.length === 0) return "unknown";
  let worst: EvidenceState = "current";
  for (const f of flags) {
    const s = evidenceStateFrom(f.meta?.freshness);
    if (EVIDENCE_SEVERITY[s] < EVIDENCE_SEVERITY[worst]) worst = s;
  }
  return worst;
}

export function EvidenceStateBadge({
  state,
  testId,
}: {
  state: EvidenceState | string | null | undefined;
  testId?: string;
}) {
  const item = presentation[evidenceStateFrom(state)];
  const Icon = item.Icon;
  return (
    <Badge variant={item.variant} testId={testId}>
      <Icon size={12} aria-hidden="true" /> {item.label}
    </Badge>
  );
}
