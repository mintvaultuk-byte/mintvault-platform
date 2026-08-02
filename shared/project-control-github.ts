/**
 * Project Control — GitHub live-evidence model (pure).
 *
 * THE PROBLEM THIS SOLVES
 *
 * A hand-maintained programme dashboard is wrong the moment someone merges a branch and forgets
 * to update it. The seed model failed exactly that way: one commit in its history, a tracked
 * branch that had since been declared dead, and no knowledge of eight shipped systems.
 *
 * So repository status is not stored here — it is OBSERVED. GitHub is the authority for what
 * exists in the repository (branches, pull requests, CI conclusions, commits, tags); this module
 * turns a fetched snapshot into evidence the already-approved readiness engine can grade.
 *
 * THE RULE THAT MATTERS MOST
 *
 * Absence of evidence is never evidence of success. If GitHub could not be reached, or the
 * snapshot is too old to trust, this module reports UNKNOWN or STALE. It never falls back to
 * "nothing found, therefore fine" — that is precisely how a dashboard learns to lie. Every
 * consumer receives a `freshness` verdict alongside the data and must render it.
 *
 * SEPARATION OF CONCERNS
 *
 * Pure. No network, no token, no filesystem, no clock of its own (every function that needs
 * "now" takes it as an argument, so results are deterministic and testable). The fetching, the
 * credentials and the caching all live server-side in project-control/github-scan.ts. Nothing in
 * this file can leak a token, because nothing in this file ever sees one.
 */

/* ------------------------------------------------------------------------------------------ */
/* Freshness — the honesty layer                                                                */
/* ------------------------------------------------------------------------------------------ */

export const GITHUB_FRESHNESS = ["fresh", "stale", "unknown"] as const;
export type GitHubFreshness = (typeof GITHUB_FRESHNESS)[number];

/**
 * How old a snapshot may be before it stops counting as current.
 *
 * Deliberately short. This dashboard's job is to answer "what is true right now", and a
 * half-hour-old view of a repository that several agents are pushing to is not that. Past this
 * boundary the data is still SHOWN — hiding it would be its own kind of lie — but it is labelled
 * `stale` so nobody reads it as live.
 */
export const GITHUB_SNAPSHOT_STALE_AFTER_MS = 15 * 60 * 1000;

export interface GitHubFreshnessVerdict {
  freshness: GitHubFreshness;
  /** Human-readable, always populated — rendered verbatim, so it must stand alone. */
  reason: string;
  /** Age in milliseconds, or null when there is no snapshot at all. */
  ageMs: number | null;
}

/**
 * Classify a snapshot's trustworthiness.
 *
 * FAILS CLOSED in every ambiguous case: no snapshot, an unparseable timestamp, or a timestamp in
 * the future (a clock skew we cannot reason about) all read as `unknown` rather than `fresh`.
 */
export function classifyFreshness(
  fetchedAt: string | null | undefined,
  now: Date = new Date(),
  staleAfterMs: number = GITHUB_SNAPSHOT_STALE_AFTER_MS
): GitHubFreshnessVerdict {
  if (!fetchedAt) {
    return {
      freshness: "unknown",
      reason: "GitHub has not been read yet, so repository status is unknown — not assumed complete.",
      ageMs: null,
    };
  }

  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) {
    return {
      freshness: "unknown",
      reason: "The recorded GitHub read time could not be parsed, so its age cannot be trusted.",
      ageMs: null,
    };
  }

  const ageMs = now.getTime() - at;
  if (ageMs < 0) {
    return {
      freshness: "unknown",
      reason: "The recorded GitHub read time is in the future, so the clock cannot be trusted.",
      ageMs,
    };
  }

  if (ageMs > staleAfterMs) {
    return {
      freshness: "stale",
      reason: `GitHub was last read ${Math.round(ageMs / 60000)} minute(s) ago; this view may be out of date.`,
      ageMs,
    };
  }

  return {
    freshness: "fresh",
    reason: `GitHub was read ${Math.round(ageMs / 1000)} second(s) ago.`,
    ageMs,
  };
}

/** True only for a snapshot we are willing to treat as current. Never true for stale/unknown. */
export function isTrustworthy(verdict: GitHubFreshnessVerdict): boolean {
  return verdict.freshness === "fresh";
}

/* ------------------------------------------------------------------------------------------ */
/* Observed GitHub facts                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface GitHubBranch {
  name: string;
  headSha: string;
  /** Commits this branch is ahead of the default branch. Null when GitHub did not report it. */
  aheadOfDefault: number | null;
  behindDefault: number | null;
  lastCommitAt: string | null;
}

export const PULL_REQUEST_STATES = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: PullRequestState;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergedAt: string | null;
  updatedAt: string;
  /** Files touched, when the caller asked for it. Bounded server-side. */
  changedFiles: string[];
}

export const CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "neutral",
  "unknown",
] as const;
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

export interface GitHubWorkflowRun {
  name: string;
  headSha: string;
  headBranch: string;
  conclusion: CheckConclusion;
  runStartedAt: string | null;
  url: string | null;
}

export interface GitHubSnapshot {
  /** ISO timestamp of the read. Null means "never read" and forces `unknown`. */
  fetchedAt: string | null;
  repository: string;
  defaultBranch: string;
  /** Head of the default branch — the commit everything else is measured against. */
  defaultBranchSha: string | null;
  branches: GitHubBranch[];
  pullRequests: GitHubPullRequest[];
  workflowRuns: GitHubWorkflowRun[];
  releaseTags: string[];
  /** Non-fatal problems (rate limit, partial page, permission) surfaced rather than swallowed. */
  warnings: string[];
}

/** The empty snapshot. Used when GitHub is unreachable — never mistaken for a clean result. */
export function unavailableSnapshot(repository: string, reason: string): GitHubSnapshot {
  return {
    fetchedAt: null,
    repository,
    defaultBranch: "main",
    defaultBranchSha: null,
    branches: [],
    pullRequests: [],
    workflowRuns: [],
    releaseTags: [],
    warnings: [reason],
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Derivation                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Resolve a lane's branch from an ORDERED candidate list — first existing ref wins.
 *
 * This is how the dashboard reports the branch that actually exists rather than a branch name
 * quoted in a prompt months ago. A lane whose candidates all fail to resolve genuinely has no
 * branch, and the caller must treat that as not-started rather than as an error.
 */
export function resolveLaneBranch(candidates: string[], branches: GitHubBranch[]): GitHubBranch | null {
  for (const candidate of candidates) {
    const hit = branches.find((b) => b.name === candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Is this branch merged into the default branch?
 *
 * Answered ONLY from a pull request GitHub reports as merged. A branch that is zero commits ahead
 * is NOT treated as merged: that is equally consistent with a branch freshly cut from main and
 * never worked on, and guessing in the optimistic direction is exactly the failure this model
 * exists to prevent.
 */
export function isBranchMerged(branchName: string, pullRequests: GitHubPullRequest[]): boolean {
  return pullRequests.some((pr) => pr.headRef === branchName && pr.state === "merged" && pr.mergedAt !== null);
}

/** Open pull requests for a branch, most recently updated first. */
export function openPullRequestsFor(branchName: string, pullRequests: GitHubPullRequest[]): GitHubPullRequest[] {
  return pullRequests
    .filter((pr) => pr.headRef === branchName && pr.state === "open")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * The CI verdict for a commit.
 *
 * `skipped`, `cancelled` and `neutral` are NOT successes — they are the absence of a result, and
 * counting them as passes is the same vacuity the test-evidence rules already reject. A commit
 * with no runs at all returns "unknown", never "success".
 */
export function checkConclusionForSha(sha: string, runs: GitHubWorkflowRun[]): CheckConclusion {
  const forSha = runs.filter((r) => r.headSha === sha);
  if (forSha.length === 0) return "unknown";
  if (forSha.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) return "failure";
  if (forSha.some((r) => r.conclusion === "success")) return "success";
  return "unknown";
}

/**
 * How far a branch is behind the default branch, for drift reporting.
 * Null propagates rather than defaulting to zero — "unmeasured" must not read as "up to date".
 */
export function branchDrift(branch: GitHubBranch): { ahead: number | null; behind: number | null; diverged: boolean } {
  return {
    ahead: branch.aheadOfDefault,
    behind: branch.behindDefault,
    diverged: (branch.aheadOfDefault ?? 0) > 0 && (branch.behindDefault ?? 0) > 0,
  };
}

/**
 * Migration filenames touched by a lane's merged pull requests.
 *
 * Used to cross-reference "a migration was written" against "a migration was applied", which is
 * the pairing that catches the deploy-before-migrate incident class.
 */
export function migrationFilesTouched(pullRequests: GitHubPullRequest[]): string[] {
  const out = new Set<string>();
  for (const pr of pullRequests) {
    for (const file of pr.changedFiles) {
      const match = /^migrations\/(\d{4,}_.+\.sql)$/.exec(file);
      if (match) out.add(match[1]);
    }
  }
  return [...out].sort();
}
