/**
 * Project Control — GitHub reader safety.
 *
 * The reader holds a credential, so the tests that matter are not "does it fetch" but:
 *
 *   1. an unconfigured or failing GitHub reads as UNKNOWN, never as a clean empty result;
 *   2. the token never reaches a caller — not in a snapshot, not in a warning, not in an error;
 *   3. the forced-refresh path cannot be turned into a rate-limit exhaustion tool.
 *
 * These run without network access. The no-token path is exercised directly; the redaction path is
 * exercised through the module's own exported surface plus a stubbed global fetch, so no request
 * ever leaves the machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GITHUB_TOKEN_ENV,
  GITHUB_TOKEN_FALLBACK_ENV,
  invalidateGitHubCache,
  isGitHubConfigured,
  resolveRepository,
  scanGitHub,
} from "../server/project-control/github-scan";
import { classifyFreshness } from "@shared/project-control-github";

/** A synthetic, non-functional token shaped like a real one. Never a real credential. */
const FAKE_TOKEN = "ghp_000000000000000000000000000000000000";

const realFetch = globalThis.fetch;

beforeEach(() => {
  invalidateGitHubCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("configuration is reported without revealing anything", () => {
  it("reports not-configured when no token is present", () => {
    expect(isGitHubConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("accepts the dedicated variable and the CI fallback", () => {
    expect(isGitHubConfigured({ [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isGitHubConfigured({ [GITHUB_TOKEN_FALLBACK_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("treats a blank or whitespace-only token as absent, not as configured", () => {
    expect(isGitHubConfigured({ [GITHUB_TOKEN_ENV]: "   " } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("resolves a repository without needing configuration", () => {
    expect(resolveRepository({} as NodeJS.ProcessEnv)).toContain("/");
  });
});

describe("an unconfigured GitHub reads as UNKNOWN, never as a clean result", () => {
  it("returns a snapshot with no fetchedAt, so it classifies as unknown", async () => {
    const snap = await scanGitHub(false, {} as NodeJS.ProcessEnv);
    expect(snap.fetchedAt).toBeNull();
    expect(classifyFreshness(snap.fetchedAt).freshness).toBe("unknown");
  });

  it("explains itself rather than returning a silent empty snapshot", async () => {
    const snap = await scanGitHub(false, {} as NodeJS.ProcessEnv);
    expect(snap.warnings.length).toBeGreaterThan(0);
    expect(snap.warnings.join(" ")).toContain("UNKNOWN rather than complete");
  });

  it("issues no network request at all when unconfigured", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await scanGitHub(false, {} as NodeJS.ProcessEnv);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the token never reaches a caller", () => {
  it("does not appear anywhere in an unconfigured snapshot", async () => {
    const snap = await scanGitHub(false, { [GITHUB_TOKEN_ENV]: "" } as unknown as NodeJS.ProcessEnv);
    expect(JSON.stringify(snap)).not.toContain(FAKE_TOKEN);
  });

  it("is redacted out of a failing request's warning, even when the error quotes it", async () => {
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED https://x-access-token:${FAKE_TOKEN}@api.github.com/repos/o/r`);
    }) as unknown as typeof fetch;

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);
    const serialised = JSON.stringify(snap);

    expect(serialised).not.toContain(FAKE_TOKEN);
    expect(serialised).toContain("REDACTED");
    // and it still fails closed rather than looking clean
    expect(snap.fetchedAt).toBeNull();
  });

  it("redacts a bare GitHub token that appears outside any URL", async () => {
    // Isolates the token-SHAPE rule. Not every leak arrives inside a URL — a driver or proxy can
    // quote a header value verbatim — so the shape list must stand on its own.
    globalThis.fetch = (async () => {
      throw new Error(`bad credentials supplied: authorization=Bearer ${FAKE_TOKEN}`);
    }) as unknown as typeof fetch;

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);
    const serialised = JSON.stringify(snap);

    expect(serialised).not.toContain(FAKE_TOKEN);
    expect(serialised).toContain("REDACTED_TOKEN");
  });

  it("redacts credentials embedded in a URL even when they do not look like a GitHub token", async () => {
    // Isolates the URL-userinfo rule. An opaque credential that matches none of the token SHAPE
    // patterns must still be stripped, or the only thing protecting us is the shape list.
    const OPAQUE = "s3cr3t-opaque-credential-value";
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED https://user:${OPAQUE}@api.github.com/repos/o/r`);
    }) as unknown as typeof fetch;

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);
    const serialised = JSON.stringify(snap);

    expect(serialised).not.toContain(OPAQUE);
    expect(serialised).toContain("REDACTED_URL");
  });

  it("fails closed on an HTTP error rather than returning an empty success", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);
    expect(snap.fetchedAt).toBeNull();
    expect(classifyFreshness(snap.fetchedAt).freshness).toBe("unknown");
  });

  it("names rate-limit exhaustion specifically, so it is not mistaken for an empty repository", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);
    expect(snap.warnings.join(" ")).toContain("rate limit");
    expect(snap.fetchedAt).toBeNull();
  });
});

describe("an unavailable snapshot is never cached as if it were good", () => {
  it("retries after a failure instead of serving the failure from cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await scanGitHub(false, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);
    const first = calls;
    await scanGitHub(false, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);

    expect(calls).toBeGreaterThan(first);
  });
});

/**
 * WORKFLOW-RUN ENVELOPE — the defect that produced a SUCCEEDED sync carrying `workflow_run: 0`
 * while the real repository held 743 runs.
 *
 * The GitHub REST API is not uniform. `/branches` and `/pulls` answer with a bare JSON array;
 * `/actions/runs` answers with `{ total_count, workflow_runs: [...] }`. The paginator guarded on
 * `Array.isArray(data)` and broke out of the loop on the FIRST page — returning `[]` with no
 * warning, because the HTTP call itself had succeeded. CI evidence was therefore permanently
 * empty and the dashboard said "Unknown" while claiming the sync had succeeded.
 *
 * These tests pin the shape, not the plumbing: given a realistic envelope, runs must arrive.
 */
describe("workflow runs are read from the /actions/runs envelope", () => {
  const RUN = {
    name: "CI",
    head_sha: "372a98f39f23e2e39fdcadcaf57050308ba5a6d3",
    head_branch: "main",
    conclusion: "success",
    run_started_at: "2026-08-02T10:00:00Z",
    html_url: "https://github.com/o/r/actions/runs/1",
  };

  /** Answers each collection in its REAL shape: arrays for branches/pulls, envelope for runs. */
  function githubLike(runsBody: unknown) {
    return (async (url: string) => {
      const body = url.includes("/actions/runs")
        ? runsBody
        : url.includes("/branches")
          ? [{ name: "main", commit: { sha: RUN.head_sha } }]
          : url.includes("/pulls")
            ? []
            : { default_branch: "main" };
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => body,
      };
    }) as unknown as typeof fetch;
  }

  it("parses the envelope, so CI evidence is populated rather than silently zero", async () => {
    globalThis.fetch = githubLike({ total_count: 1, workflow_runs: [RUN] });

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);

    expect(snap.workflowRuns, "an envelope of runs must not read as zero runs").toHaveLength(1);
    expect(snap.workflowRuns[0].name).toBe("CI");
    expect(snap.workflowRuns[0].headBranch).toBe("main");
    expect(snap.workflowRuns[0].conclusion).toBe("success");
    expect(snap.workflowRuns[0].headSha).toBe(RUN.head_sha);
  });

  it("still reads the sibling collections, which are bare arrays", async () => {
    globalThis.fetch = githubLike({ total_count: 1, workflow_runs: [RUN] });

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);

    expect(snap.branches, "unwrapping the envelope must not break array endpoints").toHaveLength(1);
    expect(snap.defaultBranchSha).toBe(RUN.head_sha);
  });

  it("an unexpected shape WARNS instead of reporting a clean zero", async () => {
    // The heart of the defect: HTTP 200 carrying something we cannot read used to be silent, and a
    // silent zero is indistinguishable from "CI has never run".
    globalThis.fetch = githubLike({ total_count: 1, unexpected_key: [RUN] });

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);

    expect(snap.workflowRuns).toHaveLength(0);
    expect(
      snap.warnings.join(" "),
      "a zero we cannot explain must be announced, not presented as fact"
    ).toContain("Workflow run list");
  });

  it("a genuinely empty repository reports zero runs with NO warning", async () => {
    // The truthful-zero case must stay quiet, or the warning above becomes noise operators ignore.
    globalThis.fetch = githubLike({ total_count: 0, workflow_runs: [] });

    const snap = await scanGitHub(true, { [GITHUB_TOKEN_ENV]: FAKE_TOKEN } as unknown as NodeJS.ProcessEnv);

    expect(snap.workflowRuns).toHaveLength(0);
    expect(snap.warnings.join(" ")).not.toContain("Workflow run list");
  });
});
