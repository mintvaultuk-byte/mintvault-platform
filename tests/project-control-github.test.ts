/**
 * Project Control — GitHub live-evidence model.
 *
 * These tests attack ONE property above all others: that missing or unreliable GitHub data can
 * never be mistaken for a clean result. A dashboard that reports "no problems found" when it
 * actually failed to look is worse than no dashboard, because it is trusted.
 *
 * So most of what follows is adversarial: unreachable GitHub, a clock running backwards, an
 * unparseable timestamp, a branch with no pull request, a commit with no CI run, a suite that was
 * skipped rather than passed. In every case the assertion is that the model refuses to round up.
 *
 * Pure functions only — no network, no token, injected clock.
 */
import { describe, it, expect } from "vitest";
import {
  GITHUB_SNAPSHOT_STALE_AFTER_MS,
  branchDrift,
  checkConclusionForSha,
  classifyFreshness,
  isBranchMerged,
  isTrustworthy,
  migrationFilesTouched,
  openPullRequestsFor,
  resolveLaneBranch,
  unavailableSnapshot,
  type GitHubBranch,
  type GitHubPullRequest,
  type GitHubWorkflowRun,
} from "@shared/project-control-github";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function branch(over: Partial<GitHubBranch> = {}): GitHubBranch {
  return {
    name: "feature/example",
    headSha: "a".repeat(40),
    aheadOfDefault: 0,
    behindDefault: 0,
    lastCommitAt: iso(0),
    ...over,
  };
}

function pr(over: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 1,
    title: "Example",
    state: "open",
    headRef: "feature/example",
    baseRef: "main",
    headSha: "a".repeat(40),
    mergedAt: null,
    updatedAt: iso(0),
    changedFiles: [],
    ...over,
  };
}

function workflowRun(over: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun {
  return {
    name: "CI",
    headSha: "a".repeat(40),
    headBranch: "main",
    conclusion: "success",
    runStartedAt: iso(0),
    url: null,
    ...over,
  };
}

describe("freshness — absence of evidence is never evidence of success", () => {
  it("reports UNKNOWN when GitHub has never been read", () => {
    const v = classifyFreshness(null, NOW);
    expect(v.freshness).toBe("unknown");
    expect(v.ageMs).toBeNull();
    expect(v.reason).toContain("not assumed complete");
  });

  it("reports UNKNOWN for an unparseable timestamp rather than guessing", () => {
    expect(classifyFreshness("not-a-date", NOW).freshness).toBe("unknown");
  });

  it("reports UNKNOWN for a future timestamp — clock skew is not freshness", () => {
    expect(classifyFreshness(new Date(NOW.getTime() + 60_000).toISOString(), NOW).freshness).toBe("unknown");
  });

  it("reports FRESH inside the window", () => {
    expect(classifyFreshness(iso(60_000), NOW).freshness).toBe("fresh");
  });

  it("reports STALE outside the window", () => {
    expect(classifyFreshness(iso(GITHUB_SNAPSHOT_STALE_AFTER_MS + 1000), NOW).freshness).toBe("stale");
  });

  it("treats the boundary itself as still fresh, and one millisecond past it as stale", () => {
    expect(classifyFreshness(iso(GITHUB_SNAPSHOT_STALE_AFTER_MS), NOW).freshness).toBe("fresh");
    expect(classifyFreshness(iso(GITHUB_SNAPSHOT_STALE_AFTER_MS + 1), NOW).freshness).toBe("stale");
  });

  it("always supplies a reason that stands alone when rendered", () => {
    for (const at of [null, "not-a-date", iso(60_000), iso(GITHUB_SNAPSHOT_STALE_AFTER_MS + 1000)]) {
      expect(classifyFreshness(at, NOW).reason.length).toBeGreaterThan(10);
    }
  });

  it("trusts ONLY fresh — never stale, never unknown", () => {
    expect(isTrustworthy(classifyFreshness(iso(1000), NOW))).toBe(true);
    expect(isTrustworthy(classifyFreshness(iso(GITHUB_SNAPSHOT_STALE_AFTER_MS + 1), NOW))).toBe(false);
    expect(isTrustworthy(classifyFreshness(null, NOW))).toBe(false);
  });
});

describe("the unavailable snapshot is never mistaken for a clean one", () => {
  const snap = unavailableSnapshot("owner/repo", "GitHub API unreachable");

  it("carries no fetchedAt, so it always classifies as unknown", () => {
    expect(snap.fetchedAt).toBeNull();
    expect(classifyFreshness(snap.fetchedAt, NOW).freshness).toBe("unknown");
  });

  it("surfaces the reason as a warning rather than swallowing it", () => {
    expect(snap.warnings).toContain("GitHub API unreachable");
  });

  it("is empty rather than optimistic", () => {
    expect(snap.branches).toEqual([]);
    expect(snap.pullRequests).toEqual([]);
    expect(snap.workflowRuns).toEqual([]);
    expect(snap.defaultBranchSha).toBeNull();
  });
});

describe("branch resolution follows the ordered candidate list", () => {
  const branches = [branch({ name: "psp/second" }), branch({ name: "psp/first" })];

  it("returns the FIRST candidate that exists, not the first branch found", () => {
    expect(resolveLaneBranch(["psp/first", "psp/second"], branches)?.name).toBe("psp/first");
    expect(resolveLaneBranch(["psp/second", "psp/first"], branches)?.name).toBe("psp/second");
  });

  it("returns null when no candidate resolves — the lane genuinely has no branch", () => {
    expect(resolveLaneBranch(["psp/missing"], branches)).toBeNull();
    expect(resolveLaneBranch([], branches)).toBeNull();
  });
});

describe("merge state is read from merged pull requests, never inferred", () => {
  it("is true only for a merged PR carrying a mergedAt", () => {
    expect(isBranchMerged("feature/example", [pr({ state: "merged", mergedAt: iso(1000) })])).toBe(true);
  });

  it("is false for an open PR", () => {
    expect(isBranchMerged("feature/example", [pr({ state: "open" })])).toBe(false);
  });

  it("is false for a CLOSED-but-unmerged PR — closed is not landed", () => {
    expect(isBranchMerged("feature/example", [pr({ state: "closed", mergedAt: null })])).toBe(false);
  });

  it("is false when a PR claims merged but carries no mergedAt", () => {
    expect(isBranchMerged("feature/example", [pr({ state: "merged", mergedAt: null })])).toBe(false);
  });

  it("does NOT infer merge from a branch being zero commits ahead", () => {
    // Zero-ahead is equally consistent with a branch freshly cut from main and never worked on.
    expect(isBranchMerged("feature/example", [])).toBe(false);
  });

  it("does not confuse another branch's merged PR for this one", () => {
    expect(
      isBranchMerged("feature/example", [pr({ headRef: "feature/other", state: "merged", mergedAt: iso(1) })])
    ).toBe(false);
  });
});

describe("open pull requests", () => {
  it("returns only open PRs for the branch, newest first", () => {
    const list = openPullRequestsFor("feature/example", [
      pr({ number: 1, updatedAt: iso(50_000) }),
      pr({ number: 2, updatedAt: iso(10_000) }),
      pr({ number: 3, state: "merged", mergedAt: iso(1) }),
      pr({ number: 4, headRef: "other" }),
    ]);
    expect(list.map((p) => p.number)).toEqual([2, 1]);
  });
});

describe("CI conclusions — skipped and cancelled are not successes", () => {
  const sha = "b".repeat(40);

  it("returns UNKNOWN when no run exists for the commit", () => {
    expect(checkConclusionForSha(sha, [])).toBe("unknown");
    expect(checkConclusionForSha(sha, [workflowRun({ headSha: "c".repeat(40) })])).toBe("unknown");
  });

  it("returns SUCCESS only on a genuine success", () => {
    expect(checkConclusionForSha(sha, [workflowRun({ headSha: sha, conclusion: "success" })])).toBe("success");
  });

  it("lets a failure outrank a success on the same commit", () => {
    expect(
      checkConclusionForSha(sha, [
        workflowRun({ headSha: sha, conclusion: "success" }),
        workflowRun({ headSha: sha, conclusion: "failure" }),
      ])
    ).toBe("failure");
  });

  it("treats a timeout as a failure", () => {
    expect(checkConclusionForSha(sha, [workflowRun({ headSha: sha, conclusion: "timed_out" })])).toBe("failure");
  });

  it("never promotes skipped, cancelled or neutral to success", () => {
    for (const conclusion of ["skipped", "cancelled", "neutral"] as const) {
      expect(checkConclusionForSha(sha, [workflowRun({ headSha: sha, conclusion })])).toBe("unknown");
    }
  });
});

describe("branch drift — unmeasured must not read as up to date", () => {
  it("propagates null rather than defaulting to zero", () => {
    const d = branchDrift(branch({ aheadOfDefault: null, behindDefault: null }));
    expect(d.ahead).toBeNull();
    expect(d.behind).toBeNull();
  });

  it("flags a genuinely diverged branch", () => {
    expect(branchDrift(branch({ aheadOfDefault: 3, behindDefault: 5 })).diverged).toBe(true);
  });

  it("does not flag a branch that is only ahead, or only behind", () => {
    expect(branchDrift(branch({ aheadOfDefault: 3, behindDefault: 0 })).diverged).toBe(false);
    expect(branchDrift(branch({ aheadOfDefault: 0, behindDefault: 5 })).diverged).toBe(false);
  });
});

describe("migration files touched by pull requests", () => {
  it("extracts numbered migrations and ignores everything else", () => {
    expect(
      migrationFilesTouched([
        pr({ changedFiles: ["migrations/0031_partner_user_management.sql", "server/routes.ts"] }),
        pr({ changedFiles: ["migrations/rollback-0031-partner-user-management.sql"] }),
      ])
    ).toEqual(["0031_partner_user_management.sql"]);
  });

  it("deduplicates across pull requests and sorts deterministically", () => {
    expect(
      migrationFilesTouched([
        pr({ changedFiles: ["migrations/0035_partner_certificate_origin.sql"] }),
        pr({
          changedFiles: [
            "migrations/0031_partner_user_management.sql",
            "migrations/0035_partner_certificate_origin.sql",
          ],
        }),
      ])
    ).toEqual(["0031_partner_user_management.sql", "0035_partner_certificate_origin.sql"]);
  });

  it("returns nothing when no migration was touched", () => {
    expect(migrationFilesTouched([pr({ changedFiles: ["client/src/App.tsx"] })])).toEqual([]);
  });
});
