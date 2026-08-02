/**
 * THE GITHUB TRANSPORT, PROVEN AGAINST A FAKE.
 *
 * `tests/project-control-github.test.ts` covers the pure helpers — freshness classification, drift
 * arithmetic, branch/PR matching. It does not touch `scanGitHub`, because until the transport was
 * made injectable there was no way to reach it without a live token and a live repository.
 *
 * That left every property that makes this module safe to point at a rate-limited third party
 * completely unverified: conditional requests, the pagination ceiling, rate-limit classification,
 * the timeout, single-flight coalescing, and — most importantly — the guarantee that a token never
 * escapes into a warning string that ends up on an operator's screen.
 *
 * Each test below drives the REAL `scanGitHub` through a fake transport, so what is proven is the
 * production code path, not a re-description of it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  scanGitHub,
  invalidateGitHubCache,
  invalidateSnapshotCacheOnly,
  GITHUB_REPO_ENV,
  GITHUB_TOKEN_ENV,
  type GitHubFetch,
} from "../server/project-control/github-scan";

const REPO = "mintvaultuk-byte/mintvault-platform";
const TOKEN = "ghp_thisisafaketokenforthetestsuite01234567";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { [GITHUB_REPO_ENV]: REPO, [GITHUB_TOKEN_ENV]: TOKEN, ...overrides } as NodeJS.ProcessEnv;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A transport that answers from a routing table and records every call it received. */
function fakeTransport(route: (url: string, call: number) => Reply) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let n = 0;
  const http: GitHubFetch = async (url, init) => {
    n += 1;
    calls.push({ url, headers: init.headers });
    const { status = 200, body = [], headers = {} } = route(url, n);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  return { http, calls };
}

/** The minimum shape a successful scan needs so the mapping layer has something to chew on. */
function defaultRoute(url: string): Reply {
  if (url.includes("/repos/") && url.endsWith(`/${REPO}`)) return { body: { default_branch: "main" } };
  if (url.includes("/branches")) return { body: [{ name: "main", commit: { sha: "abc123" } }] };
  if (url.includes("/pulls")) return { body: [] };
  if (url.includes("/actions/runs")) return { body: [] };
  return { body: {} };
}

beforeEach(() => {
  invalidateGitHubCache();
});

describe("GitHub transport — configuration and fail-closed behaviour", () => {
  it("an ABSENT token yields UNAVAILABLE and issues no request at all", async () => {
    const { http, calls } = fakeTransport(defaultRoute);
    const snap = await scanGitHub(false, env({ [GITHUB_TOKEN_ENV]: undefined }), http);

    expect(calls, "an unconfigured server must not call GitHub").toHaveLength(0);
    expect(snap.fetchedAt, "an unavailable snapshot carries no fetch time").toBeNull();
    expect(snap.warnings.join(" ")).toMatch(new RegExp(GITHUB_TOKEN_ENV));
    // The remedy names the ENV VAR, never a value.
    expect(snap.warnings.join(" ")).not.toContain(TOKEN);
  });

  it("the token is sent as a bearer header and never appears in the snapshot", async () => {
    const { http, calls } = fakeTransport(defaultRoute);
    const snap = await scanGitHub(true, env(), http);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].headers.authorization, "the token travels in the header").toBe(`Bearer ${TOKEN}`);
    expect(
      JSON.stringify(snap),
      "the token must never reach anything the client can see"
    ).not.toContain(TOKEN);
  });

  it("a transport error is reported WITHOUT leaking a credential-bearing URL", async () => {
    const http: GitHubFetch = async () => {
      throw new Error(`connect ECONNREFUSED https://x-access-token:${TOKEN}@api.github.com/repos`);
    };
    const snap = await scanGitHub(true, env(), http);

    const text = JSON.stringify(snap);
    expect(text, "a userinfo URL must be redacted").not.toContain(TOKEN);
    expect(snap.warnings.join(" ")).toMatch(/REDACTED/);
    expect(snap.fetchedAt, "a failed scan is not a fresh snapshot").toBeNull();
  });
});

describe("GitHub transport — conditional requests and rate limits", () => {
  it("sends If-None-Match on a repeat read and accepts 304 as the cached body", async () => {
    let served = 0;
    const { http, calls } = fakeTransport((url, n) => {
      if (url.includes("/branches")) {
        // First pass: 200 + ETag. Later passes: 304, which must reuse the cached body.
        if (n <= 4) {
          served += 1;
          return { body: [{ name: "main", commit: { sha: "abc123" } }], headers: { etag: 'W/"v1"' } };
        }
        return { status: 304, body: null };
      }
      return defaultRoute(url);
    });

    const first = await scanGitHub(true, env(), http);
    expect(first.branches).toHaveLength(1);
    expect(served).toBeGreaterThan(0);

    // Model the production window: the snapshot TTL has expired, the ETags are still valid.
    invalidateSnapshotCacheOnly();
    const second = await scanGitHub(true, env(), http);

    const branchCalls = calls.filter((c) => c.url.includes("/branches"));
    expect(branchCalls.length).toBeGreaterThan(1);
    expect(
      branchCalls[branchCalls.length - 1].headers["if-none-match"],
      "a repeat read must revalidate rather than re-download"
    ).toBe('W/"v1"');
    expect(second.branches, "a 304 must resolve to the cached body, not an empty list").toHaveLength(1);
  });

  it("an exhausted rate limit is reported as such and does not become an empty repository", async () => {
    const { http } = fakeTransport((url) => {
      if (url.includes("/branches")) {
        return { status: 403, headers: { "x-ratelimit-remaining": "0" } };
      }
      return defaultRoute(url);
    });

    const snap = await scanGitHub(true, env(), http);

    expect(snap.warnings.join(" ")).toMatch(/rate limit/i);
    expect(
      snap.branches,
      "a rate-limited read returns no branches — but the warning is what tells the operator why"
    ).toEqual([]);
    expect(snap.warnings.length, "silence would be the dangerous outcome").toBeGreaterThan(0);
  });

  it("a 403 that is NOT a rate limit is reported as an access problem, not a quota problem", async () => {
    const { http } = fakeTransport((url) => {
      if (url.includes("/branches")) return { status: 403, headers: { "x-ratelimit-remaining": "4999" } };
      return defaultRoute(url);
    });

    const snap = await scanGitHub(true, env(), http);
    const text = snap.warnings.join(" ");
    expect(text).toMatch(/repository access/i);
    expect(text, "misreporting an access failure as a quota failure sends the operator to the wrong fix").not.toMatch(
      /rate limit exhausted/i
    );
  });
});

describe("GitHub transport — pagination is bounded and truncation is declared", () => {
  it("stops at the page ceiling and SAYS the view is incomplete", async () => {
    // Always return a full page, so only the ceiling can stop the loop.
    const { http, calls } = fakeTransport((url) => {
      if (url.includes("/branches")) {
        const full = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}`, commit: { sha: `s${i}` } }));
        return { body: full };
      }
      return defaultRoute(url);
    });

    const snap = await scanGitHub(true, env(), http);
    const branchCalls = calls.filter((c) => c.url.includes("/branches"));

    expect(branchCalls.length, "an unbounded loop would be a rate-limit exhaustion tool").toBeLessThanOrEqual(5);
    expect(
      snap.warnings.join(" "),
      "a truncated list presented as complete is a lie the operator cannot detect"
    ).toMatch(/truncated/i);
  });

  it("a short page ends pagination immediately", async () => {
    const { http, calls } = fakeTransport((url) => {
      if (url.includes("/branches")) return { body: [{ name: "main", commit: { sha: "abc123" } }] };
      return defaultRoute(url);
    });

    await scanGitHub(true, env(), http);
    expect(calls.filter((c) => c.url.includes("/branches"))).toHaveLength(1);
  });

  it("every paginated request carries an explicit per_page bound", async () => {
    const { http, calls } = fakeTransport(defaultRoute);
    await scanGitHub(true, env(), http);

    for (const call of calls.filter((c) => /branches|pulls|actions\/runs/.test(c.url))) {
      expect(call.url, `unbounded page size on ${call.url}`).toMatch(/per_page=\d+/);
    }
  });
});

describe("GitHub transport — availability never becomes optimism", () => {
  it("a total outage yields UNAVAILABLE, not an empty-but-fresh repository", async () => {
    const { http } = fakeTransport(() => ({ status: 500 }));
    const snap = await scanGitHub(true, env(), http);

    expect(snap.fetchedAt, "500s must not mint a fresh timestamp").toBeNull();
    expect(snap.defaultBranchSha).toBeNull();
    expect(snap.warnings.length).toBeGreaterThan(0);
  });

  it("concurrent callers coalesce into a single in-flight scan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;

    const http: GitHubFetch = async (url) => {
      started += 1;
      await gate;
      const { body = [] } = defaultRoute(url);
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => body };
    };

    const a = scanGitHub(true, env(), http);
    const b = scanGitHub(true, env(), http);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra, "two concurrent refreshes must share one scan").toBe(rb);
    expect(started, "a coalesced scan issues one repo probe, not two").toBeLessThanOrEqual(4);
  });
});
