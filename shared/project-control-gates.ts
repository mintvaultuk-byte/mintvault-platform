/**
 * Project Control — delivery gates and the contradiction engine.
 *
 * Pure logic, no I/O. The composed overview service supplies observations; this decides what they
 * mean. Kept in `shared/` because the gate vocabulary is part of the API contract the UI renders,
 * and a second copy on the client would be a second source of truth.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------
 *   MERGED  ≠  DEPLOYED  ≠  MIGRATED  ≠  FLAG-ENABLED  ≠  VERIFIED
 *
 * Each is evidence from a DIFFERENT authority, and no authority may satisfy another's gate:
 * GitHub knows what is merged and cannot know what is deployed; an application knows its own
 * commit and cannot know whether its migrations ran; a migration ledger cannot know whether a flag
 * is on; and none of them can know whether a human verified the result.
 *
 * Collapsing any pair is how a dashboard starts saying "done" about something nobody shipped.
 *
 * AND THE COROLLARY: absence of evidence is never evidence of completion. `UNKNOWN` and
 * `UNAVAILABLE` are first-class outcomes here, distinct from `FAILED`, and none of them can
 * satisfy a gate.
 */

/** The ten gates, in delivery order. Order matters: it is how "current phase" is derived. */
export const GATES = [
  "AUTHORED",
  "MERGED",
  "CI_PASSED",
  "MIGRATION_AUTHORED",
  "MIGRATION_APPLIED_STAGING",
  "DEPLOYED_STAGING",
  "FEATURE_ENABLED_STAGING",
  "VERIFIED_STAGING",
  "DEPLOYED_PRODUCTION",
  "VERIFIED_PRODUCTION",
] as const;
export type Gate = (typeof GATES)[number];

/**
 * A gate's outcome.
 *
 * `UNKNOWN` (no evidence was collected) and `UNAVAILABLE` (evidence was sought and the source
 * could not answer) are deliberately separate. They call for different operator actions — one
 * means "go and look", the other means "the thing you looked at is down" — and merging them would
 * discard the distinction the entire evidence layer was built to preserve.
 */
export const GATE_STATES = ["SATISFIED", "NOT_SATISFIED", "STALE", "UNKNOWN", "UNAVAILABLE", "CONTRADICTORY"] as const;
export type GateState = (typeof GATE_STATES)[number];

/** Only this counts as passing. Everything else — including STALE — does not. */
export function isSatisfied(state: GateState): boolean {
  return state === "SATISFIED";
}

export interface GateResult {
  gate: Gate;
  state: GateState;
  /** Which authority answered. Null when nothing did. */
  source: string | null;
  observedAt: string | null;
  /** Why the gate is not satisfied, in operator language. Null when it is. */
  reason: string | null;
}

/**
 * One observation, reduced to what a gate needs.
 *
 * `satisfied` is the source's own verdict; `freshness` is how much that verdict can be trusted.
 * Both are required, because a source can be perfectly reachable and still be reporting something
 * from an hour ago.
 */
export interface GateObservation {
  source: string;
  satisfied: boolean;
  freshness: "CURRENT" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | "CONTRADICTORY" | "FAILED";
  observedAt: string | null;
  detail?: string | null;
}

/**
 * Resolve one gate from one observation.
 *
 * `null` means no evidence exists at all — UNKNOWN, never NOT_SATISFIED. The difference matters:
 * "we have not looked" is not "it has not happened", and rendering the first as the second sends
 * an operator to fix something that may already be fine.
 */
export function resolveGate(gate: Gate, observation: GateObservation | null): GateResult {
  if (!observation) {
    return {
      gate,
      state: "UNKNOWN",
      source: null,
      observedAt: null,
      reason: "No evidence has been collected for this gate.",
    };
  }

  const base = { gate, source: observation.source, observedAt: observation.observedAt };

  switch (observation.freshness) {
    case "UNAVAILABLE":
    case "FAILED":
      return {
        ...base,
        state: "UNAVAILABLE",
        reason: observation.detail ?? "The evidence source could not be reached, so this gate is UNKNOWN.",
      };
    case "CONTRADICTORY":
      return {
        ...base,
        state: "CONTRADICTORY",
        reason: observation.detail ?? "The evidence for this gate contradicts another source.",
      };
    case "UNKNOWN":
      return { ...base, state: "UNKNOWN", reason: observation.detail ?? "The evidence source returned no answer." };
    case "STALE":
      // A stale observation retains its VALUE — the caller can still show the last known SHA —
      // but it cannot satisfy a gate. "It was true an hour ago" is not "it is true".
      return {
        ...base,
        state: "STALE",
        reason: "The evidence is older than its validity window; refresh before relying on it.",
      };
    case "CURRENT":
    default:
      return observation.satisfied
        ? { ...base, state: "SATISFIED", reason: null }
        : { ...base, state: "NOT_SATISFIED", reason: observation.detail ?? null };
  }
}

/**
 * The furthest gate reached, and the first one that is not satisfied.
 *
 * Deliberately sequential: a later gate cannot count while an earlier one is open, because the
 * gates describe a pipeline. Production deployed while staging is unverified is not progress — it
 * is a contradiction, and the contradiction engine below reports it as one.
 */
export function summariseGates(results: GateResult[]): {
  reached: Gate | null;
  next: Gate | null;
  satisfiedCount: number;
  blocked: GateResult[];
} {
  const byGate = new Map(results.map((r) => [r.gate, r]));
  let reached: Gate | null = null;
  let next: Gate | null = null;

  for (const gate of GATES) {
    const result = byGate.get(gate);
    if (result && isSatisfied(result.state)) {
      reached = gate;
      continue;
    }
    next = gate;
    break;
  }

  return {
    reached,
    next,
    satisfiedCount: results.filter((r) => isSatisfied(r.state)).length,
    blocked: results.filter((r) => !isSatisfied(r.state) && r.state !== "UNKNOWN"),
  };
}

/* ── Contradiction engine ─────────────────────────────────────────────────────────────────── */

export const CONTRADICTION_CODES = [
  "GITHUB_NEWER_THAN_DEPLOYMENT",
  "DEPLOYMENT_NEWER_THAN_GITHUB",
  "MIGRATION_MISSING",
  "FLAGS_ENABLED_WITHOUT_DEPLOYMENT",
  "DEPLOYMENT_WITHOUT_MIGRATION",
  "MIGRATION_WITHOUT_DEPLOYMENT",
  "UNKNOWN_REPOSITORY",
  "UNKNOWN_APPLICATION",
  "UNKNOWN_DATABASE",
  "UNKNOWN_FLAGS",
] as const;
export type ContradictionCode = (typeof CONTRADICTION_CODES)[number];

export interface Contradiction {
  code: ContradictionCode;
  /** Plain-English, operator-facing. Never a raw error, never a URL. */
  summary: string;
  /** Which authorities disagreed, so the operator knows where to look. */
  evidenceSources: string[];
  severity: "high" | "medium" | "low";
}

export interface ContradictionInputs {
  repositoryHeadSha: string | null;
  repositoryKnown: boolean;
  stagingCommit: string | null;
  stagingKnown: boolean;
  productionCommit: string | null;
  productionKnown: boolean;
  migrationsPending: number | null;
  databaseKnown: boolean;
  projectControlFlagEnabled: boolean | null;
  flagsKnown: boolean;
}

/** Prefix-tolerant SHA comparison: `/api/version` reports short, GitHub reports full. */
function sameCommit(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length < 7) return null;
  return longer.startsWith(shorter);
}

/**
 * Find every disagreement between authorities.
 *
 * Every "unknown" is reported as its own contradiction rather than silently skipped: a dashboard
 * that quietly omits what it does not know looks identical to one where everything is fine, and
 * the operator has no way to tell the difference.
 */
export function detectContradictions(input: ContradictionInputs): Contradiction[] {
  const out: Contradiction[] = [];

  if (!input.repositoryKnown) {
    out.push({
      code: "UNKNOWN_REPOSITORY",
      summary: "Repository evidence is unavailable, so deployment alignment cannot be judged.",
      evidenceSources: ["github"],
      severity: "medium",
    });
  }
  if (!input.stagingKnown || !input.productionKnown) {
    out.push({
      code: "UNKNOWN_APPLICATION",
      summary: "At least one environment's deployed commit is unknown, so drift cannot be judged.",
      evidenceSources: ["application"],
      severity: "medium",
    });
  }
  if (!input.databaseKnown) {
    out.push({
      code: "UNKNOWN_DATABASE",
      summary: "Migration state is unavailable. This is NOT evidence that migrations are pending.",
      evidenceSources: ["database"],
      severity: "medium",
    });
  }
  if (!input.flagsKnown) {
    out.push({
      code: "UNKNOWN_FLAGS",
      summary: "Feature-flag state is unknown, so it cannot be said whether the feature is reachable.",
      evidenceSources: ["feature_flag"],
      severity: "low",
    });
  }

  const stagingMatchesHead = sameCommit(input.repositoryHeadSha, input.stagingCommit);
  if (stagingMatchesHead === false) {
    // Which side is ahead cannot be established from SHAs alone without ancestry, so both
    // directions are reported under the code that fits the common case, and the summary says so.
    out.push({
      code: "GITHUB_NEWER_THAN_DEPLOYMENT",
      summary:
        "The repository head and the staging deployment are different commits. Staging is not running the branch head.",
      evidenceSources: ["github", "application"],
      severity: "medium",
    });
  }

  if ((input.migrationsPending ?? 0) > 0 && input.stagingKnown && input.stagingCommit) {
    out.push({
      code: "DEPLOYMENT_WITHOUT_MIGRATION",
      summary: `Staging is deployed but ${input.migrationsPending} migration(s) are not applied. Code may reference schema that does not exist.`,
      evidenceSources: ["application", "database"],
      severity: "high",
    });
  }

  if (input.databaseKnown && input.migrationsPending === 0 && input.stagingKnown && !input.stagingCommit) {
    out.push({
      code: "MIGRATION_WITHOUT_DEPLOYMENT",
      summary: "Migrations are applied but no deployed commit could be established for staging.",
      evidenceSources: ["database", "application"],
      severity: "medium",
    });
  }

  if (input.projectControlFlagEnabled === true && input.stagingKnown && !input.stagingCommit) {
    out.push({
      code: "FLAGS_ENABLED_WITHOUT_DEPLOYMENT",
      summary: "A feature flag is enabled in an environment whose deployed commit is unknown.",
      evidenceSources: ["feature_flag", "application"],
      severity: "high",
    });
  }

  return out;
}

/* ── Readiness capping ────────────────────────────────────────────────────────────────────── */

/** Mirrors the existing readiness caps so there is one vocabulary, not two. */
export const CAP_CONTRADICTION = 69;
export const CAP_UNAVAILABLE_EVIDENCE = 79;
export const CAP_UNKNOWN_EVIDENCE = 89;

export interface ReadinessVerdict {
  /** 0–100. Floored, never rounded up — 99 must never present as 100. */
  percent: number;
  cappedBy: string[];
  satisfiedGates: number;
  totalGates: number;
}

/**
 * Turn gate results and contradictions into a percentage.
 *
 * Two rules do the real work:
 *
 *   - Only SATISFIED counts toward the numerator. STALE, UNKNOWN and UNAVAILABLE all contribute
 *     nothing, so absence of evidence can never inflate the number.
 *   - The result is FLOORED and every cap is applied afterwards. 100% is therefore unreachable
 *     unless every gate is genuinely satisfied and nothing contradicts — which is the only state
 *     in which "done" is true.
 */
export function computeGateReadiness(results: GateResult[], contradictions: Contradiction[]): ReadinessVerdict {
  const total = results.length || GATES.length;
  const satisfied = results.filter((r) => isSatisfied(r.state)).length;
  let percent = Math.floor((satisfied / total) * 100);

  const cappedBy: string[] = [];

  if (contradictions.length > 0) {
    if (percent > CAP_CONTRADICTION) {
      percent = CAP_CONTRADICTION;
      cappedBy.push(`contradictory evidence (${contradictions.length})`);
    }
  }
  if (results.some((r) => r.state === "UNAVAILABLE")) {
    if (percent > CAP_UNAVAILABLE_EVIDENCE) {
      percent = CAP_UNAVAILABLE_EVIDENCE;
      cappedBy.push("an evidence source is unavailable");
    }
  }
  if (results.some((r) => r.state === "UNKNOWN")) {
    if (percent > CAP_UNKNOWN_EVIDENCE) {
      percent = CAP_UNKNOWN_EVIDENCE;
      cappedBy.push("an evidence source is unknown");
    }
  }

  return { percent, cappedBy, satisfiedGates: satisfied, totalGates: total };
}
