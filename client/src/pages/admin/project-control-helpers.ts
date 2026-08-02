/**
 * Project Control — presentation helpers.
 *
 * The repo has no DOM test harness, so all page logic that is worth asserting lives here as
 * pure functions and the page components stay thin renderers. Nothing here talks to the network.
 */
import {
  EVIDENCE_CONFIDENCE_LABELS,
  WORK_STATUS_LABELS,
  type EvidenceConfidence,
  type NextAction,
  type RiskLevel,
  type WorkStatus,
} from "@shared/project-control";
import type { AdminBadgeVariant } from "@/components/admin";

/** Status → badge colour. Green-ish (`act`) is reserved for genuinely finished work. */
export function statusBadgeVariant(status: WorkStatus): AdminBadgeVariant {
  switch (status) {
    case "production_verified":
      return "act";
    case "deployed":
    case "merged":
    case "committed":
    case "awaiting_deployment":
    case "ready_for_landing":
      return "gold";
    case "in_progress":
    case "built":
    case "awaiting_test_evidence":
    case "awaiting_review":
    case "awaiting_production_verification":
      return "prog";
    // Anything unhealthy is red — a founder should never have to read the label to see it.
    case "blocked":
    case "review_failed":
    case "tests_failing":
    case "needs_fixing":
    case "built_with_known_defects":
      return "red";
    case "paused":
    case "superseded":
    case "unknown":
      return "wait";
    case "not_started":
    case "planned":
    default:
      return "neu";
  }
}

export function confidenceBadgeVariant(confidence: EvidenceConfidence): AdminBadgeVariant {
  switch (confidence) {
    case "automatically_verified":
      return "act";
    case "verified_by_review":
      return "gold";
    case "reported":
      return "prog";
    case "contradictory":
      return "red";
    case "stale":
    case "unknown":
    default:
      return "wait";
  }
}

export function riskBadgeVariant(risk: RiskLevel): AdminBadgeVariant {
  switch (risk) {
    case "critical":
      return "red";
    case "high":
      return "gold";
    case "moderate":
      return "prog";
    case "low":
    default:
      return "neu";
  }
}

export function statusLabel(status: WorkStatus): string {
  return WORK_STATUS_LABELS[status] ?? status;
}

export function confidenceLabel(confidence: EvidenceConfidence): string {
  return EVIDENCE_CONFIDENCE_LABELS[confidence] ?? confidence;
}

/** "3 days ago" / "in 2 hours" / "just now" — plain English, no library. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const diffMs = now.getTime() - then;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const phrase = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let text: string;
  if (abs < minute) return "just now";
  else if (abs < hour) text = phrase(Math.floor(abs / minute), "minute");
  else if (abs < day) text = phrase(Math.floor(abs / hour), "hour");
  else if (abs < 60 * day) text = phrase(Math.floor(abs / day), "day");
  else text = phrase(Math.floor(abs / (30 * day)), "month");

  return diffMs >= 0 ? `${text} ago` : `in ${text}`;
}

/**
 * A percentage that never lies about being complete: 99.6% shows as 99%, not 100%.
 * The server floors too (shared clampPercent), so the API and the screen agree.
 */
export function displayPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const clamped = Math.max(0, Math.min(100, value));
  const floored = clamped >= 100 ? 100 : Math.floor(clamped);
  return `${floored}%`;
}

/** Plain-English explanation of why a readiness figure is what it is. */
export function explainReadiness(r: {
  overall: number;
  rawScore: number;
  appliedCaps: { cap: number; reason: string }[];
  confidenceMultiplier: number;
}): string {
  if (r.appliedCaps.length > 0) {
    const lowest = r.appliedCaps.reduce((a, b) => (a.cap <= b.cap ? a : b));
    return `Capped at ${lowest.cap}% — ${lowest.reason}`;
  }
  if (r.confidenceMultiplier < 1) {
    return `Weighted score ${r.rawScore}%, discounted to ${r.overall}% because the evidence is not fully verified.`;
  }
  return `Weighted across the ten readiness categories.`;
}

export interface FilterState {
  search: string;
  status: WorkStatus[];
  confidence: EvidenceConfidence[];
  risk: RiskLevel[];
  node: string[];
  blockedOnly: boolean;
  ownerActionOnly: boolean;
}

export const EMPTY_FILTER: FilterState = {
  search: "",
  status: [],
  confidence: [],
  risk: [],
  node: [],
  blockedOnly: false,
  ownerActionOnly: false,
};

/** Build the overview query string. Stable key order so TanStack Query caches predictably. */
export function overviewQueryString(filter: FilterState): string {
  const params = new URLSearchParams();
  if (filter.search.trim()) params.set("search", filter.search.trim());
  if (filter.status.length) params.set("status", filter.status.join(","));
  if (filter.confidence.length) params.set("confidence", filter.confidence.join(","));
  if (filter.risk.length) params.set("risk", filter.risk.join(","));
  if (filter.node.length) params.set("node", filter.node.join(","));
  if (filter.blockedOnly) params.set("blocked", "true");
  if (filter.ownerActionOnly) params.set("ownerAction", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function toggleInList<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function isFilterActive(filter: FilterState): boolean {
  return (
    filter.search.trim().length > 0 ||
    filter.status.length > 0 ||
    filter.confidence.length > 0 ||
    filter.risk.length > 0 ||
    filter.node.length > 0 ||
    filter.blockedOnly ||
    filter.ownerActionOnly
  );
}

/** One plain-English sentence explaining why an action is recommended. */
export function describeAction(action: NextAction): string {
  if (action.blockedBy.length > 0) {
    return `Cannot start yet — waiting on ${action.blockedBy.join(", ")}.`;
  }
  if (action.requiresOwnerApproval) {
    return "This needs your explicit go-ahead before anyone can do it.";
  }
  if (action.riskScore >= 60) return "Safe to do, but high-impact — check the plan first.";
  if (action.riskScore <= 20) return "Low risk — safe to do now.";
  return "Moderate risk — normal care applies.";
}

/** Colour band for a readiness percentage bar. */
export function readinessTone(percent: number): "low" | "mid" | "high" | "complete" {
  if (percent >= 100) return "complete";
  if (percent >= 75) return "high";
  if (percent >= 40) return "mid";
  return "low";
}

/**
 * Lay a dependency graph out in columns by depth, so the UI can draw it without a graph library.
 * Nodes in a cycle (or with a missing dependency) land in column 0 and are reported separately.
 */
export function layoutDependencyColumns(
  nodes: { key: string }[],
  edges: { from: string; to: string }[]
): { key: string; column: number }[] {
  const incoming = new Map<string, string[]>();
  nodes.forEach((n) => incoming.set(n.key, []));
  edges.forEach((e) => {
    if (incoming.has(e.to)) incoming.get(e.to)!.push(e.from);
  });

  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  /**
   * ITERATIVE by deliberate choice (third-review low-risk hardening). The previous version
   * recursed once per edge in the chain, so a long dependency chain could overflow the stack in
   * the browser — the same class of defect that was already fixed on the server side. This uses
   * an explicit work stack with a post-visit pass, so depth costs heap, not stack.
   */
  const resolve = (root: string): number => {
    if (depth.has(root)) return depth.get(root)!;

    // Each frame is visited twice: once to push its unresolved parents, once to combine them.
    const stack: { key: string; expanded: boolean }[] = [{ key: root, expanded: false }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (depth.has(frame.key)) {
        stack.pop();
        visiting.delete(frame.key);
        continue;
      }

      const parents = incoming.get(frame.key) ?? [];

      if (!frame.expanded) {
        frame.expanded = true;
        visiting.add(frame.key);
        for (const parent of parents) {
          // A parent already on the current path is a cycle: leave it unresolved and let the
          // combine step below treat it as column 0 rather than looping forever.
          if (!depth.has(parent) && !visiting.has(parent)) {
            stack.push({ key: parent, expanded: false });
          }
        }
        continue;
      }

      // Every resolvable parent is now settled. Unresolved parents are cycle members → 0.
      let value = 0;
      for (const parent of parents) {
        value = Math.max(value, (depth.get(parent) ?? 0) + 1);
      }
      depth.set(frame.key, value);
      visiting.delete(frame.key);
      stack.pop();
    }

    return depth.get(root) ?? 0;
  };

  return nodes.map((n) => ({ key: n.key, column: resolve(n.key) }));
}

/* ------------------------------------------------------------------------------------------ */
/* Load-failure diagnosis (defect F-3)                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface LoadDiagnosis {
  kind: "disabled" | "unauthenticated" | "forbidden" | "schema_missing" | "server" | "network" | "unknown";
  testId: string;
  headline: string;
  detail: string;
  tone: "neutral" | "error";
  canRetry: boolean;
}

/**
 * Turn a failed Project Control read into an HONEST diagnosis.
 *
 * DEFECT F-3. Every failure previously fell into one of two branches, decided by sniffing the
 * error MESSAGE for the substring "not enabled". Everything that did not match — a 401 after a
 * staff login evicted the shared `mv.sid` admin session, a 403 from a non-super-admin, a 500, a
 * dropped network — rendered:
 *
 *     "The most likely cause is that migration 0030 has not been applied to this environment."
 *
 * which is a confident, specific and usually WRONG diagnosis. It sends an operator to look at the
 * database when the real fix is to log in again.
 *
 * The HTTP status is already attached by `throwIfResNotOk` (`err.status`) and was simply unused.
 * This branches on it instead of on server prose, so a copy edit to a server message can no longer
 * change which screen the operator sees.
 *
 * NOTE ON 401: the shared query function is configured `on401: "returnNull"`, so an evicted
 * session yields `data === null` with NO error at all. That is why "no error and no data" is
 * treated as unauthenticated rather than as an unknown fault.
 */
export function diagnoseLoadFailure(error: unknown): LoadDiagnosis {
  const status = (error as { status?: number } | undefined)?.status;
  const message = String((error as Error | undefined)?.message ?? "");

  if (status === 404) {
    return {
      kind: "disabled",
      testId: "pc-disabled",
      headline: "Project Control is switched off here.",
      detail:
        "It is off by default in every environment and must be switched on deliberately by setting SUPER_ADMIN_PROJECT_CONTROL_ENABLED=true. Nothing is broken.",
      tone: "neutral",
      canRetry: false,
    };
  }

  if (status === 401 || error === null || error === undefined) {
    return {
      kind: "unauthenticated",
      testId: "pc-unauthenticated",
      headline: "Your admin session has ended.",
      detail:
        "Sign in again at /admin/login. A staff or grader login in the same browser replaces the shared admin session, which is the usual cause.",
      tone: "neutral",
      canRetry: true,
    };
  }

  if (status === 403) {
    return {
      kind: "forbidden",
      testId: "pc-forbidden",
      headline: "This account is not a Super Admin.",
      detail:
        "Project Control is restricted to Super Admin accounts. Your session is valid; it simply does not carry that privilege.",
      tone: "neutral",
      canRetry: false,
    };
  }

  // A missing relation is the ONLY case where blaming the migration is correct.
  if (/relation .*pc_|does not exist|undefined table/i.test(message)) {
    return {
      kind: "schema_missing",
      testId: "pc-schema-missing",
      headline: "The Project Control tables are missing here.",
      detail:
        "Migration 0030 has not been applied to this environment, so the tables do not exist yet. Nothing else in MintVault is affected.",
      tone: "error",
      canRetry: true,
    };
  }

  if (typeof status === "number" && status >= 500) {
    return {
      kind: "server",
      testId: "pc-server-error",
      headline: "Project Control failed on the server.",
      detail: `The server returned ${status}. This is a fault to investigate, not a configuration problem.`,
      tone: "error",
      canRetry: true,
    };
  }

  if (status === undefined) {
    return {
      kind: "network",
      testId: "pc-network-error",
      headline: "Could not reach the server.",
      detail: "The request did not complete. Check your connection and try again.",
      tone: "error",
      canRetry: true,
    };
  }

  return {
    kind: "unknown",
    testId: "pc-error",
    headline: "Project Control could not load.",
    detail: `The server returned ${status}. The cause is not one this screen recognises.`,
    tone: "error",
    canRetry: true,
  };
}
