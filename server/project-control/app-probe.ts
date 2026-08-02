/**
 * Project Control — read-only application version probes.
 *
 * Answers "what commit is ACTUALLY running in this environment?" — the question a merged pull
 * request cannot answer and a deployment row typed by a human only claims to.
 *
 * SAFETY RULES
 * ------------
 *  - READ ONLY. One GET to one allowlisted `/api/version` per environment. Nothing here deploys,
 *    restarts, or writes.
 *  - NO CALLER-SUPPLIED URLS. The environment name selects from a fixed table below. There is no
 *    code path from a request body to a hostname, so this cannot be turned into an SSRF pivot.
 *    That matters more than usual here: this module runs behind Super Admin auth on a server that
 *    can reach internal networks.
 *  - HTTPS ONLY, bounded, and short. A hung probe must not hold a dashboard request open.
 *  - FAILS SOFT, NEVER FAILS OPTIMISTIC. Unreachable is UNAVAILABLE, not "not deployed".
 *    Undeployed and unreachable are different facts and the dashboard must never merge them.
 *  - NO SENSITIVE HEADERS RETURNED. Only the parsed commit/build fields cross the boundary.
 *
 * WHAT THIS DELIBERATELY DOES NOT CONCLUDE
 * ----------------------------------------
 * Reaching an app proves the app is up. It does NOT prove its migrations are applied, its flags
 * are on, or that anyone smoke-tested it. Those are separate authorities with separate evidence,
 * and collapsing them is exactly how a dashboard starts lying. This module answers one question.
 */

/** The four states a probe can end in. `unknown` is a first-class answer, not a failure to report. */
export const PROBE_STATES = ["current", "unavailable", "unknown", "contradictory"] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

export interface AppProbeResult {
  environment: string;
  /** Host only — never a full URL with credentials, never a query string. */
  host: string;
  state: ProbeState;
  /** The deployed commit, when the app reported one. Null in every non-current state. */
  commit: string | null;
  build: string | null;
  /** Server-reported build/deploy timestamp, when present. */
  timestamp: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  observedAt: string;
  /** Operator-facing reason. Never contains a URL with userinfo, never a raw exception. */
  reason: string | null;
}

/**
 * THE ALLOWLIST. Adding an environment is a code change and a review, deliberately.
 *
 * These are the two MintVault Fly applications. `mintvaultuk.com` is intentionally absent: it is a
 * CNAME onto the same production app, so probing it would double-count one environment as two.
 */
export const PROBE_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  staging: "https://mintvault-v2.fly.dev",
  production: "https://mintvault.fly.dev",
});

export const PROBE_TIMEOUT_MS = 8_000;
/** A /api/version body is a few hundred bytes; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

/** The narrow transport this module uses, so a test can supply a fake. See github-scan.ts. */
export type ProbeFetch = (
  url: string,
  init: { method: string; signal: AbortSignal; headers: Record<string, string> }
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const realFetch: ProbeFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ProbeFetch>;

/** Reduce anything credential-shaped to its shape. A probe must never be why a token is logged. */
function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]*@[^\s]*/gi, "[REDACTED_URL]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]")
    .slice(0, 200);
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "unknown-host";
  }
}

function unknownResult(environment: string, reason: string): AppProbeResult {
  return {
    environment,
    host: PROBE_TARGETS[environment] ? hostOf(PROBE_TARGETS[environment]) : "unknown-host",
    state: "unknown",
    commit: null,
    build: null,
    timestamp: null,
    httpStatus: null,
    latencyMs: null,
    observedAt: new Date().toISOString(),
    reason,
  };
}

/**
 * Probe one environment.
 *
 * `now` is injectable so latency is deterministic in a test; production passes the real clock.
 */
export async function probeApplication(
  environment: string,
  http: ProbeFetch = realFetch,
  now: () => number = () => Date.now()
): Promise<AppProbeResult> {
  const base = PROBE_TARGETS[environment];
  if (!base) {
    // An unrecognised environment is a programming error, not a network answer. Say so plainly
    // rather than attempting a request against whatever string arrived.
    return unknownResult(
      environment,
      `Unknown environment "${String(environment).slice(0, 40)}". Probing is restricted to an allowlist.`
    );
  }

  const url = `${base}/api/version`;
  const host = hostOf(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = now();

  try {
    const res = await http(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "mintvault-project-control-probe" },
    });
    const latencyMs = now() - started;

    if (!res.ok) {
      return {
        environment,
        host,
        state: "unavailable",
        commit: null,
        build: null,
        timestamp: null,
        httpStatus: res.status,
        latencyMs,
        observedAt: new Date().toISOString(),
        reason: `${host} answered HTTP ${res.status}. The deployed commit is UNKNOWN — this is not evidence that nothing is deployed.`,
      };
    }

    const raw = await res.text();
    if (raw.length > MAX_BODY_BYTES) {
      return {
        environment,
        host,
        state: "unavailable",
        commit: null,
        build: null,
        timestamp: null,
        httpStatus: res.status,
        latencyMs,
        observedAt: new Date().toISOString(),
        reason: `${host} returned an oversized body (${raw.length} bytes); refusing to parse it.`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A 200 serving the SPA's index.html is the classic false positive: it looks alive and
      // says nothing. That is UNAVAILABLE evidence, not a deployed commit.
      return {
        environment,
        host,
        state: "unavailable",
        commit: null,
        build: null,
        timestamp: null,
        httpStatus: res.status,
        latencyMs,
        observedAt: new Date().toISOString(),
        reason: `${host} answered 200 but not JSON — most likely the SPA shell rather than /api/version.`,
      };
    }

    const body = (parsed ?? {}) as Record<string, unknown>;
    const commit = typeof body.commit === "string" && body.commit.trim() !== "" ? body.commit.trim() : null;

    if (!commit) {
      return {
        environment,
        host,
        state: "unavailable",
        commit: null,
        build: null,
        timestamp: null,
        httpStatus: res.status,
        latencyMs,
        observedAt: new Date().toISOString(),
        reason: `${host} answered 200 with JSON carrying no commit field.`,
      };
    }

    return {
      environment,
      host,
      state: "current",
      commit,
      build: typeof body.build === "string" ? body.build.slice(0, 120) : null,
      timestamp: typeof body.timestamp === "string" ? body.timestamp.slice(0, 40) : null,
      httpStatus: res.status,
      latencyMs,
      observedAt: new Date().toISOString(),
      reason: null,
    };
  } catch (error) {
    return {
      environment,
      host,
      state: "unavailable",
      commit: null,
      build: null,
      timestamp: null,
      httpStatus: null,
      latencyMs: now() - started,
      observedAt: new Date().toISOString(),
      reason: `Probe failed: ${safeReason(error)}. The deployed commit is UNKNOWN.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every allowlisted environment. One slow target must not stall the others. */
export async function probeAllApplications(
  http: ProbeFetch = realFetch,
  now: () => number = () => Date.now()
): Promise<AppProbeResult[]> {
  return Promise.all(Object.keys(PROBE_TARGETS).map((environment) => probeApplication(environment, http, now)));
}

export interface DeploymentDrift {
  /** The repository's default-branch head, when GitHub evidence was available. */
  mainSha: string | null;
  staging: AppProbeResult | null;
  production: AppProbeResult | null;
  stagingMatchesMain: boolean | null;
  productionMatchesMain: boolean | null;
  stagingMatchesProduction: boolean | null;
  /** Plain-English summary for the dashboard. Never asserts more than the evidence supports. */
  summary: string;
}

/**
 * Compare deployed commits against the repository head.
 *
 * Every comparison is TRI-STATE. When either side is unknown the answer is `null`, never `false`
 * — "we could not tell" and "they differ" are different facts, and rendering the first as the
 * second is how an operator gets sent to investigate a drift that does not exist.
 *
 * SHA comparison is prefix-tolerant in one direction only: `/api/version` reports a short SHA and
 * GitHub reports the full one, so a short value may prefix a long one. Two short SHAs must match
 * exactly.
 */
export function compareDeployment(mainSha: string | null, probes: AppProbeResult[]): DeploymentDrift {
  const staging = probes.find((p) => p.environment === "staging") ?? null;
  const production = probes.find((p) => p.environment === "production") ?? null;

  const sameCommit = (a: string | null, b: string | null): boolean | null => {
    if (!a || !b) return null;
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    const shorter = x.length <= y.length ? x : y;
    const longer = x.length <= y.length ? y : x;
    if (shorter.length < 7) return null; // too short to be a meaningful identity claim
    return longer.startsWith(shorter);
  };

  const stagingMatchesMain = sameCommit(mainSha, staging?.commit ?? null);
  const productionMatchesMain = sameCommit(mainSha, production?.commit ?? null);
  const stagingMatchesProduction = sameCommit(staging?.commit ?? null, production?.commit ?? null);

  const parts: string[] = [];
  if (!mainSha) parts.push("Repository head is UNKNOWN, so deployment drift cannot be judged.");
  if (staging?.state !== "current") parts.push("Staging version is UNKNOWN.");
  else if (stagingMatchesMain === true) parts.push("Staging matches the repository head.");
  else if (stagingMatchesMain === false) parts.push("Staging is NOT running the repository head.");

  if (production?.state !== "current") parts.push("Production version is UNKNOWN.");
  else if (productionMatchesMain === true) parts.push("Production matches the repository head.");
  else if (productionMatchesMain === false) parts.push("Production is NOT running the repository head.");

  return {
    mainSha,
    staging,
    production,
    stagingMatchesMain,
    productionMatchesMain,
    stagingMatchesProduction,
    summary: parts.join(" "),
  };
}
