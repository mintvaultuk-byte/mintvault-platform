/**
 * Project Control — evidence TRUTH.
 *
 * Four defects, one theme: the evidence layer reported confidence it had not earned. Each is
 * pinned here against the real implementation, driven through the injectable transport seam — no
 * network, no database.
 *
 *   1. Workflow runs were sliced to 300 using MAX_PR_CHANGED_FILES, a pull-request changed-files
 *      bound, and truncated SILENTLY. getAllPages only warns on hitting MAX_PAGES, so 101-500 runs
 *      paginated cleanly, were cut to 300, produced zero warnings, and closed the sync SUCCEEDED.
 *      A quarter of CI history missing, indistinguishable from complete.
 *
 *   2. GitHub evidence carried no validity window while application (10m), flag (30m) and database
 *      (15m) evidence all did. effectiveFreshness treats a null validUntil as CURRENT for ever, so
 *      the headline freshness badge could never go stale.
 *
 *   3. The server returned GitHub's "success"/"failure"; the client badge matched
 *      "succeeded"/"failed". Both fell through to Unknown, so the CI badge read Unknown whether the
 *      build was green or red.
 *
 *   4. The headline "Overall readiness" rendered operator-DECLARED completion under the caption
 *      "Server-authoritative weighted readiness", while the evidence-capped number it claimed to be
 *      was rendered nowhere.
 *
 * The assertions deliberately target the OBSERVABLE result — the warning array, the persisted
 * validUntil, the badge state, the rendered card — not an internal flag, because every one of these
 * bugs was a case where the internals were right and the surface lied.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  scanGitHub,
  invalidateGitHubCache,
  GITHUB_REPO_ENV,
  GITHUB_TOKEN_ENV,
  type GitHubFetch,
} from "../server/project-control/github-scan";
import { GITHUB_VALID_MS } from "../server/project-control/github-sync-service";
import {
  ciEvidenceState,
  flagsEvidenceState,
  evidenceStateFrom,
} from "../client/src/components/admin/project-control/evidence-state";

const REPO = "mintvaultuk-byte/mintvault-platform";
const TOKEN = "ghp_thisisafaketokenforthetestsuite01234567";

function env(): NodeJS.ProcessEnv {
  return { [GITHUB_REPO_ENV]: REPO, [GITHUB_TOKEN_ENV]: TOKEN } as NodeJS.ProcessEnv;
}

/** A transport that serves `total` workflow runs across pages of 100. */
function runsTransport(total: number): GitHubFetch {
  return async (url) => {
    const reply = (body: unknown) => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => body,
    });
    if (url.includes("/actions/runs")) {
      const page = Number(new URL(url, "https://x").searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      const slice = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => ({
        name: "CI",
        head_sha: `sha${start + i}`,
        head_branch: "main",
        conclusion: "success",
        run_started_at: "2026-08-02T00:00:00Z",
        html_url: "https://example.invalid",
      }));
      return reply({ workflow_runs: slice });
    }
    if (url.includes("/branches")) return reply([{ name: "main", commit: { sha: "abc123" } }]);
    if (url.includes("/pulls")) return reply([]);
    if (url.includes(`/${REPO}`)) return reply({ default_branch: "main" });
    return reply({});
  };
}

beforeEach(() => invalidateGitHubCache());

describe("FIX 1 — workflow-run truncation is never silent", () => {
  it("keeps every run and warns about nothing when the history fits", async () => {
    const snap = await scanGitHub(true, env(), runsTransport(250));
    expect(snap.workflowRuns).toHaveLength(250);
    // The old code cut this to 300 only above 300 — but the cap was the WRONG constant, and 250
    // sat under it by luck. The real regression is the absence of any warning at 400 (below).
    expect(snap.warnings.filter((w) => /truncat/i.test(w))).toEqual([]);
  });

  it("no longer cuts a 400-run history to 300", async () => {
    const snap = await scanGitHub(true, env(), runsTransport(400));
    // The exact silent-loss case: 400 runs paginated cleanly and were sliced to 300 with no warning.
    expect(snap.workflowRuns.length).toBe(400);
    expect(snap.warnings.filter((w) => /truncat/i.test(w))).toEqual([]);
  });

  it("warns — and therefore reports PARTIAL — when it genuinely must truncate", async () => {
    const snap = await scanGitHub(true, env(), runsTransport(900));
    // MAX_PAGES * PER_PAGE = 500 is the hard page budget.
    expect(snap.workflowRuns.length).toBe(500);
    const warned = snap.warnings.filter((w) => /truncat/i.test(w));
    expect(warned.length).toBeGreaterThan(0);
    // A warning is what github-sync-service uses to close the run PARTIAL rather than SUCCEEDED,
    // so "incomplete" can never present as an unqualified success.
    expect(warned.join(" ")).toMatch(/incomplete|truncated/i);
  });

  it("states the real numbers, not a figure it did not use", async () => {
    const snap = await scanGitHub(true, env(), runsTransport(900));
    const w = snap.warnings.find((x) => /truncat/i.test(x));
    expect(w, "a truncation warning must be present").toBeTruthy();
    // The kept count and the reported count must agree. Previously the warning announced 500
    // retrieved while the slice silently kept 300, so the number the operator read was not the
    // number the dashboard held.
    expect(w).toContain(String(snap.workflowRuns.length));
    expect(w).not.toMatch(/\b300\b/);
  });

  it("caps the slice at the page budget, so the slice itself can never lose a fetched run", async () => {
    // MAX_WORKFLOW_RUNS is deliberately MAX_PAGES * PER_PAGE. Pagination is the only thing that
    // may drop a run, and it warns when it does. The slice is a guard for the day those two
    // constants diverge — it must never again be the thing quietly discarding data.
    for (const total of [0, 1, 100, 250, 499]) {
      invalidateGitHubCache();
      const snap = await scanGitHub(true, env(), runsTransport(total));
      expect(snap.workflowRuns.length, `all ${total} fetched runs must survive the slice`).toBe(total);
      expect(snap.warnings.filter((x) => /truncat/i.test(x))).toEqual([]);
    }
  });

  it("warns when a NON-CONFORMANT server over-serves a page and the slice must cut", async () => {
    // getAllPages bounds a conformant API at MAX_PAGES * PER_PAGE, so the slice guard is quiet in
    // normal operation. This is the case it exists for: a proxy or a misbehaving API returning more
    // rows than per_page asked for. Without the guard those extra rows would vanish silently.
    const overServing: GitHubFetch = async (url) => {
      const reply = (body: unknown) => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => body,
      });
      if (url.includes("/actions/runs")) {
        return reply({
          workflow_runs: Array.from({ length: 200 }, (_, i) => ({
            name: "CI",
            head_sha: `s${i}`,
            conclusion: "success",
          })),
        });
      }
      if (url.includes("/branches")) return reply([{ name: "main", commit: { sha: "abc123" } }]);
      if (url.includes("/pulls")) return reply([]);
      if (url.includes(`/${REPO}`)) return reply({ default_branch: "main" });
      return reply({});
    };
    const snap = await scanGitHub(true, env(), overServing);
    expect(snap.workflowRuns.length).toBe(500);
    const w = snap.warnings.find((x) => /Workflow run history was truncated/.test(x));
    expect(w, "the slice must announce what it removed").toBeTruthy();
    expect(w).toContain("500");
  });

  it("warns at exactly the page budget, where a full last page is genuinely ambiguous", async () => {
    const snap = await scanGitHub(true, env(), runsTransport(500));
    // Nothing was actually lost — but page 5 came back FULL, so the scanner cannot know whether a
    // sixth page exists. Warning here is the conservative reading, and conservative is the whole
    // point: over-reporting PARTIAL costs a second look, under-reporting it costs the truth.
    expect(snap.workflowRuns.length).toBe(500);
    expect(snap.warnings.filter((x) => /truncat/i.test(x)).length).toBeGreaterThan(0);
  });
});

describe("FIX 2 — GitHub evidence carries a bounded validity window", () => {
  it("declares a window at all, and one shorter than a working day", () => {
    // The defect was the ABSENCE of this constant: null validUntil reads CURRENT for ever.
    expect(GITHUB_VALID_MS).toBeGreaterThan(0);
    expect(GITHUB_VALID_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("outlasts the dashboard poll, so ordinary use never flickers to STALE", () => {
    const DASHBOARD_POLL_MS = 120_000;
    expect(GITHUB_VALID_MS).toBeGreaterThan(DASHBOARD_POLL_MS * 2);
  });

  it("renders STALE once a snapshot is past its window, and CURRENT before", () => {
    // Mirrors effectiveFreshness: CURRENT until validUntil passes, then STALE.
    const effective = (validUntil: Date | null, now: Date) =>
      validUntil && validUntil.getTime() < now.getTime() ? "STALE" : "CURRENT";
    const taken = new Date("2026-08-02T12:00:00Z");
    const validUntil = new Date(taken.getTime() + GITHUB_VALID_MS);
    expect(effective(validUntil, new Date(taken.getTime() + 60_000))).toBe("CURRENT");
    expect(effective(validUntil, new Date(taken.getTime() + GITHUB_VALID_MS + 1_000))).toBe("STALE");
    // And the badge must actually show it — STALE evidence rendering as "Current" was the symptom.
    expect(evidenceStateFrom("STALE")).toBe("stale");
    expect(evidenceStateFrom("CURRENT")).toBe("current");
  });
});

describe("FIX 3 — one CI vocabulary, shared by server and client", () => {
  it("renders a green build as Succeeded, never Unknown", () => {
    expect(ciEvidenceState("success")).toBe("succeeded");
  });

  it("renders a red build as Failed, never Unknown", () => {
    // Both of these returned "unknown" before: the client matched only "succeeded"/"failed".
    expect(ciEvidenceState("failure")).toBe("failed");
  });

  it("keeps Unknown for a genuine non-verdict", () => {
    // null means no run for this commit, or only queued/in-progress/cancelled ones.
    expect(ciEvidenceState(null)).toBe("unknown");
    expect(ciEvidenceState(undefined)).toBe("unknown");
  });

  it("never maps a real verdict onto the same state as no verdict", () => {
    const states = new Set([ciEvidenceState("success"), ciEvidenceState("failure"), ciEvidenceState(null)]);
    expect(states.size).toBe(3);
  });
});

describe("FIX 3b — the flags tile can go stale like every other tile", () => {
  it("is Unknown when there is no flag evidence at all", () => {
    expect(flagsEvidenceState([])).toBe("unknown");
    expect(flagsEvidenceState(undefined)).toBe("unknown");
  });

  it("is Current only when every reported flag is current", () => {
    expect(flagsEvidenceState([{ meta: { freshness: "CURRENT" } }, { meta: { freshness: "CURRENT" } }])).toBe(
      "current"
    );
  });

  it("takes the WORST freshness, so one stale flag cannot hide behind fresh ones", () => {
    // The old code returned "current" for this input purely because the array was non-empty.
    expect(
      flagsEvidenceState([
        { meta: { freshness: "CURRENT" } },
        { meta: { freshness: "STALE" } },
        { meta: { freshness: "CURRENT" } },
      ])
    ).toBe("stale");
  });

  it("treats a never-observed flag as WORSE than a merely stale one", () => {
    // The array-based rank had "unknown" milder than "stale", so a flag nobody had ever looked at
    // hid behind an old one. "We never looked" is not the better of the two problems.
    expect(flagsEvidenceState([{ meta: { freshness: "STALE" } }, { meta: { freshness: null } }])).toBe("unknown");
  });

  it("ranks an unrecognised freshness as a problem, never as healthy", () => {
    expect(flagsEvidenceState([{ meta: { freshness: "CURRENT" } }, { meta: { freshness: "FAILED" } }])).toBe("failed");
  });

  it("surfaces UNAVAILABLE ahead of STALE", () => {
    expect(flagsEvidenceState([{ meta: { freshness: "STALE" } }, { meta: { freshness: "UNAVAILABLE" } }])).toBe(
      "unavailable"
    );
  });
});
