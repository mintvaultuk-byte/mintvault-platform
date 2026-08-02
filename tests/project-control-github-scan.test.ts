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
