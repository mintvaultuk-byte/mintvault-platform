/**
 * APPLICATION VERSION PROBES — behavioural proof.
 *
 * The dashboard's central honesty claim is that it never converts missing evidence into success.
 * The application probe is where that claim is easiest to break: an unreachable app and an app
 * with nothing deployed look identical if you only check whether a request succeeded.
 *
 * These tests drive the real `probeApplication` / `compareDeployment` through a fake transport and
 * pin the distinctions that matter: unreachable is not undeployed, a 200 serving the SPA shell is
 * not a version, and "we could not tell" is not "they differ".
 */
import { describe, it, expect } from "vitest";
import {
  probeApplication,
  probeAllApplications,
  compareDeployment,
  PROBE_TARGETS,
  type ProbeFetch,
  type AppProbeResult,
} from "../server/project-control/app-probe";

function transport(reply: (url: string) => { status?: number; body?: string; ok?: boolean }): {
  http: ProbeFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const http: ProbeFetch = async (url) => {
    urls.push(url);
    const { status = 200, body = "{}", ok } = reply(url);
    return {
      status,
      ok: ok ?? (status >= 200 && status < 300),
      headers: { get: () => null },
      text: async () => body,
    };
  };
  return { http, urls };
}

const clock = () => {
  let t = 1000;
  return () => (t += 25);
};

describe("application probe — allowlisting", () => {
  it("refuses an environment that is not on the allowlist, and issues NO request", async () => {
    const { http, urls } = transport(() => ({ body: '{"commit":"deadbeef"}' }));
    const res = await probeApplication("http://evil.example.com", http, clock());

    expect(urls, "an unrecognised environment must never become a request").toHaveLength(0);
    expect(res.state).toBe("unknown");
    expect(res.commit).toBeNull();
    expect(res.reason).toMatch(/allowlist/i);
  });

  it("only ever requests the fixed allowlisted origins over HTTPS", async () => {
    const { http, urls } = transport(() => ({ body: '{"commit":"abc1234"}' }));
    await probeAllApplications(http, clock());

    expect(urls).toHaveLength(Object.keys(PROBE_TARGETS).length);
    for (const u of urls) {
      expect(u.startsWith("https://"), `probe used a non-HTTPS URL: ${u}`).toBe(true);
      expect(u.endsWith("/api/version")).toBe(true);
      const origin = new URL(u).origin;
      expect(Object.values(PROBE_TARGETS)).toContain(origin);
    }
  });
});

describe("application probe — unreachable is never 'not deployed'", () => {
  it("a network failure is UNAVAILABLE with a null commit, and says the commit is UNKNOWN", async () => {
    const http: ProbeFetch = async () => {
      throw new Error("connect ETIMEDOUT 1.2.3.4:443");
    };
    const res = await probeApplication("staging", http, clock());

    expect(res.state).toBe("unavailable");
    expect(res.commit, "a failed probe must not report a commit").toBeNull();
    expect(res.reason).toMatch(/UNKNOWN/);
    expect(res.reason).not.toMatch(/not deployed/i);
  });

  it("a 5xx is UNAVAILABLE and explicitly denies being evidence of nothing deployed", async () => {
    const { http } = transport(() => ({ status: 503 }));
    const res = await probeApplication("production", http, clock());

    expect(res.state).toBe("unavailable");
    expect(res.httpStatus).toBe(503);
    expect(res.reason).toMatch(/not evidence that nothing is deployed/i);
  });

  it("a 200 serving the SPA shell is UNAVAILABLE, not a deployed version", async () => {
    const { http } = transport(() => ({ body: "<!doctype html><html><body>MintVault</body></html>" }));
    const res = await probeApplication("staging", http, clock());

    expect(res.state, "an SPA 200 is the classic false positive").toBe("unavailable");
    expect(res.commit).toBeNull();
    expect(res.reason).toMatch(/SPA shell/i);
  });

  it("a 200 with JSON but no commit field is UNAVAILABLE", async () => {
    const { http } = transport(() => ({ body: '{"build":"x","timestamp":"t"}' }));
    const res = await probeApplication("staging", http, clock());
    expect(res.state).toBe("unavailable");
    expect(res.commit).toBeNull();
  });

  it("an oversized body is refused rather than parsed", async () => {
    const { http } = transport(() => ({ body: "x".repeat(70 * 1024) }));
    const res = await probeApplication("staging", http, clock());
    expect(res.state).toBe("unavailable");
    expect(res.reason).toMatch(/oversized/i);
  });

  it("a credential-bearing error is redacted before it is reported", async () => {
    const token = "ghp_faketokenvaluethatmustnotleak00000001";
    const http: ProbeFetch = async () => {
      throw new Error(`fetch failed https://x:${token}@mintvault-v2.fly.dev/api/version`);
    };
    const res = await probeApplication("staging", http, clock());

    expect(JSON.stringify(res)).not.toContain(token);
    expect(res.reason).toMatch(/REDACTED/);
  });
});

describe("application probe — a healthy answer", () => {
  it("reports the commit, build, host and latency", async () => {
    const { http } = transport(() => ({
      body: '{"commit":"372a98f3","build":"MV-P5","timestamp":"2026-08-02T06:00:04.137Z"}',
    }));
    const res = await probeApplication("staging", http, clock());

    expect(res.state).toBe("current");
    expect(res.commit).toBe("372a98f3");
    expect(res.build).toBe("MV-P5");
    expect(res.host, "the host is reported; the full URL is not").toBe("mintvault-v2.fly.dev");
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(res.reason).toBeNull();
  });
});

describe("deployment drift — 'cannot tell' is never rendered as 'differ'", () => {
  const probe = (environment: string, commit: string | null): AppProbeResult => ({
    environment,
    host: `${environment}.example`,
    state: commit ? "current" : "unavailable",
    commit,
    build: null,
    timestamp: null,
    httpStatus: commit ? 200 : 503,
    latencyMs: 10,
    observedAt: new Date().toISOString(),
    reason: null,
  });

  it("an unknown repository head makes every comparison null, not false", () => {
    const d = compareDeployment(null, [probe("staging", "372a98f3"), probe("production", "6f182624")]);
    expect(d.stagingMatchesMain).toBeNull();
    expect(d.productionMatchesMain).toBeNull();
    expect(d.summary).toMatch(/Repository head is UNKNOWN/);
  });

  it("an unreachable environment yields null, not a false mismatch", () => {
    const d = compareDeployment("372a98f39f23e2e3", [probe("staging", null), probe("production", "6f182624")]);
    expect(d.stagingMatchesMain, "unreachable must not read as drifted").toBeNull();
    expect(d.productionMatchesMain).toBe(false);
    expect(d.summary).toMatch(/Staging version is UNKNOWN/);
  });

  it("a short deployed SHA matches the full repository SHA it prefixes", () => {
    const d = compareDeployment("372a98f39f23e2e39fdcadcaf57050308ba5a6d3", [
      probe("staging", "372a98f3"),
      probe("production", "6f182624"),
    ]);
    expect(d.stagingMatchesMain).toBe(true);
    expect(d.productionMatchesMain).toBe(false);
    expect(d.stagingMatchesProduction).toBe(false);
    expect(d.summary).toMatch(/Staging matches the repository head/);
    expect(d.summary).toMatch(/Production is NOT running the repository head/);
  });

  it("a SHA too short to identify anything is not treated as a match", () => {
    const d = compareDeployment("372a98f39f23e2e3", [probe("staging", "372a9"), probe("production", null)]);
    expect(d.stagingMatchesMain, "a 5-char prefix is not an identity claim").toBeNull();
  });
});
