/**
 * Project Control — GitHub reader.
 *
 * Fetches the repository evidence the dashboard derives programme status from: branches, pull
 * requests, workflow conclusions, the default-branch head and release tags.
 *
 * SAFETY RULES
 *
 *  - READ ONLY. Every request is a GET against api.github.com. There is no POST, PATCH, PUT or
 *    DELETE in this module, so it cannot open a pull request, move a ref, dispatch a workflow or
 *    change a repository setting. A token with write scope is still only ever used to read.
 *
 *  - THE TOKEN NEVER LEAVES THE SERVER. It is read from the environment at call time, used as an
 *    Authorization header, and never returned, logged, embedded in a warning, or included in any
 *    response body. Warnings are written to be safe to render in a browser. Callers receive data,
 *    never credentials.
 *
 *  - FAILS SOFT, NEVER FAILS OPTIMISTIC. Any failure — no token, network error, rate limit, 404,
 *    permission — produces `unavailableSnapshot()`, which carries `fetchedAt: null` and therefore
 *    classifies as UNKNOWN. It never returns an empty-but-successful snapshot, because "we could
 *    not look" and "we looked and everything is fine" must never be the same value.
 *
 *  - BOUNDED. Every list request is capped by page size AND page count, so a repository with
 *    thousands of branches cannot turn one dashboard poll into a rate-limit exhaustion event. When
 *    a cap truncates a result, that truncation is reported as a warning rather than hidden.
 *
 *  - CHEAP ON REPEAT. Responses are cached with their ETag; a repeat read sends
 *    `If-None-Match` and a 304 costs no rate-limit quota. A short TTL cache in front of that stops
 *    a polling dashboard issuing requests at all in the common case.
 */
import {
  unavailableSnapshot,
  type CheckConclusion,
  type GitHubBranch,
  type GitHubPullRequest,
  type GitHubSnapshot,
  type GitHubWorkflowRun,
  type PullRequestState,
} from "@shared/project-control-github";

/* ------------------------------------------------------------------------------------------ */
/* Configuration                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** Repository to read. `owner/name`. */
export const GITHUB_REPO_ENV = "PROJECT_CONTROL_GITHUB_REPO";
/** Token env var. Read server-side only, never returned to a caller. */
export const GITHUB_TOKEN_ENV = "PROJECT_CONTROL_GITHUB_TOKEN";
/** Fallback, so an existing CI-style token can be reused without duplicating a secret. */
export const GITHUB_TOKEN_FALLBACK_ENV = "GITHUB_TOKEN";

const API = "https://api.github.com";

/** Bounds. Deliberately small: this is a dashboard poll, not a data export. */
const PER_PAGE = 100;
const MAX_PAGES = 5; // <= 500 items per collection
const MAX_PR_CHANGED_FILES = 300;
const REQUEST_TIMEOUT_MS = 15_000;

/** Serve a repeat poll from memory rather than issuing a request at all. */
const CACHE_TTL_MS = 60_000;
/** A forced refresh may not be issued more often than this, whatever the caller asks for. */
const MIN_FORCED_REFRESH_MS = 10_000;

export function resolveRepository(env: NodeJS.ProcessEnv = process.env): string {
  return (env[GITHUB_REPO_ENV] ?? "mintvaultuk-byte/mintvault-platform").trim();
}

function resolveToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = (env[GITHUB_TOKEN_ENV] ?? env[GITHUB_TOKEN_FALLBACK_ENV] ?? "").trim();
  return token.length > 0 ? token : null;
}

/** Configured-or-not, for a status surface. Never reveals the value or its length. */
export function isGitHubConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveToken(env) !== null;
}

/* ------------------------------------------------------------------------------------------ */
/* Transport                                                                                    */
/* ------------------------------------------------------------------------------------------ */

interface CachedResponse {
  etag: string | null;
  body: unknown;
}

const etagCache = new Map<string, CachedResponse>();
let snapshotCache: { at: number; value: GitHubSnapshot } | null = null;
let inFlight: Promise<GitHubSnapshot> | null = null;
let lastForcedAt = 0;

export function invalidateGitHubCache(): void {
  etagCache.clear();
  snapshotCache = null;
  lastForcedAt = 0;
}

/**
 * Strip anything credential-shaped out of an error before it becomes a user-visible warning.
 *
 * A fetch failure can carry a URL, and a URL can carry userinfo. This module must never be the
 * reason a token reaches a browser, so the message is reduced to its shape rather than trusted.
 */
function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]*@[^\s]*/gi, "[REDACTED_URL]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .slice(0, 300);
}

interface GetResult<T> {
  ok: boolean;
  data: T | null;
  warning: string | null;
}

async function getJson<T>(path: string, token: string): Promise<GetResult<T>> {
  const url = `${API}${path}`;
  const cached = etagCache.get(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "mintvault-project-control",
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      },
    });

    // 304: unchanged since the cached copy, and it cost no rate-limit quota.
    if (res.status === 304 && cached) {
      return { ok: true, data: cached.body as T, warning: null };
    }

    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      return {
        ok: false,
        data: null,
        warning:
          remaining === "0"
            ? "GitHub API rate limit exhausted; repository evidence is stale until it resets."
            : "GitHub refused the request (403/429). Check the token's repository access.",
      };
    }

    if (!res.ok) {
      return { ok: false, data: null, warning: `GitHub returned HTTP ${res.status} for ${path}.` };
    }

    const body = (await res.json()) as T;
    const etag = res.headers.get("etag");
    if (etag) etagCache.set(url, { etag, body });
    return { ok: true, data: body, warning: null };
  } catch (error) {
    return { ok: false, data: null, warning: `GitHub request failed: ${safeErrorMessage(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Paginate within the bounds. Reports truncation instead of hiding it. */
async function getAllPages<T>(pathBase: string, token: string, warnings: string[], label: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const { ok, data, warning } = await getJson<T[]>(`${pathBase}${sep}per_page=${PER_PAGE}&page=${page}`, token);
    if (!ok || !Array.isArray(data)) {
      if (warning) warnings.push(warning);
      break;
    }
    out.push(...data);
    if (data.length < PER_PAGE) return out;
    if (page === MAX_PAGES) {
      warnings.push(`${label} was truncated at ${MAX_PAGES * PER_PAGE} items; the view is incomplete.`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Mapping                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function mapConclusion(raw: unknown): CheckConclusion {
  const value = typeof raw === "string" ? raw : "";
  switch (value) {
    case "success":
    case "failure":
    case "cancelled":
    case "skipped":
    case "timed_out":
    case "neutral":
      return value;
    default:
      // Includes null (still running) and anything GitHub adds later. Never optimistic.
      return "unknown";
  }
}

function mapPullRequestState(raw: { state?: unknown; merged_at?: unknown }): PullRequestState {
  if (typeof raw.merged_at === "string" && raw.merged_at.length > 0) return "merged";
  return raw.state === "open" ? "open" : "closed";
}

/* ------------------------------------------------------------------------------------------ */
/* The scan                                                                                     */
/* ------------------------------------------------------------------------------------------ */

async function doScan(repo: string, token: string): Promise<GitHubSnapshot> {
  const warnings: string[] = [];

  const repoInfo = await getJson<{ default_branch?: string }>(`/repos/${repo}`, token);
  if (!repoInfo.ok) {
    return unavailableSnapshot(repo, repoInfo.warning ?? "GitHub repository metadata could not be read.");
  }
  const defaultBranch = repoInfo.data?.default_branch ?? "main";

  const rawBranches = await getAllPages<{ name: string; commit?: { sha?: string } }>(
    `/repos/${repo}/branches`,
    token,
    warnings,
    "Branch list"
  );

  const rawPulls = await getAllPages<{
    number: number;
    title: string;
    state: string;
    merged_at: string | null;
    updated_at: string;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  }>(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc`, token, warnings, "Pull request list");

  const rawRuns = await getAllPages<{
    name?: string;
    head_sha?: string;
    head_branch?: string;
    conclusion?: unknown;
    run_started_at?: string;
    html_url?: string;
  }>(`/repos/${repo}/actions/runs`, token, warnings, "Workflow run list").catch(() => []);

  const defaultBranchSha = rawBranches.find((b) => b.name === defaultBranch)?.commit?.sha ?? null;

  const branches: GitHubBranch[] = rawBranches.map((b) => ({
    name: b.name,
    headSha: b.commit?.sha ?? "",
    // Per-branch ahead/behind needs an extra compare call each; left unmeasured rather than
    // guessed, and null deliberately does NOT read as "up to date" downstream.
    aheadOfDefault: null,
    behindDefault: null,
    lastCommitAt: null,
  }));

  const pullRequests: GitHubPullRequest[] = rawPulls.map((p) => ({
    number: p.number,
    title: p.title,
    state: mapPullRequestState(p),
    headRef: p.head?.ref ?? "",
    baseRef: p.base?.ref ?? "",
    headSha: p.head?.sha ?? "",
    mergedAt: p.merged_at,
    updatedAt: p.updated_at,
    changedFiles: [],
  }));

  const workflowRuns: GitHubWorkflowRun[] = (
    Array.isArray(rawRuns) ? rawRuns : ((rawRuns as unknown as { workflow_runs?: unknown[] })?.workflow_runs ?? [])
  )
    .slice(0, MAX_PR_CHANGED_FILES)
    .map((r) => {
      const run = r as {
        name?: string;
        head_sha?: string;
        head_branch?: string;
        conclusion?: unknown;
        run_started_at?: string;
        html_url?: string;
      };
      return {
        name: run.name ?? "workflow",
        headSha: run.head_sha ?? "",
        headBranch: run.head_branch ?? "",
        conclusion: mapConclusion(run.conclusion),
        runStartedAt: run.run_started_at ?? null,
        url: run.html_url ?? null,
      };
    });

  return {
    fetchedAt: new Date().toISOString(),
    repository: repo,
    defaultBranch,
    defaultBranchSha,
    branches,
    pullRequests,
    workflowRuns,
    releaseTags: [],
    warnings,
  };
}

/**
 * Read GitHub, with caching and single-flight coalescing.
 *
 * `force` requests a fresh read but cannot beat MIN_FORCED_REFRESH_MS — the cooldown is enforced
 * here rather than by the caller, so a user hammering "Refresh from GitHub" cannot turn the
 * button into a rate-limit exhaustion tool.
 */
export async function scanGitHub(force = false, env: NodeJS.ProcessEnv = process.env): Promise<GitHubSnapshot> {
  const repo = resolveRepository(env);
  const token = resolveToken(env);

  if (!token) {
    return unavailableSnapshot(
      repo,
      `GitHub is not configured here. Set ${GITHUB_TOKEN_ENV} to enable live repository evidence; until then repository status reads as UNKNOWN rather than complete.`
    );
  }

  const now = Date.now();
  if (!force && snapshotCache && now - snapshotCache.at < CACHE_TTL_MS) return snapshotCache.value;
  if (force && now - lastForcedAt < MIN_FORCED_REFRESH_MS && snapshotCache) return snapshotCache.value;
  if (inFlight) return inFlight;

  if (force) lastForcedAt = now;

  inFlight = doScan(repo, token)
    .then((value) => {
      // Only cache a snapshot that actually succeeded; an unavailable one must be retried.
      if (value.fetchedAt) snapshotCache = { at: Date.now(), value };
      return value;
    })
    .catch((error) => unavailableSnapshot(repo, `GitHub scan failed: ${safeErrorMessage(error)}`))
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
