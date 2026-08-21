import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLY_CAPACITY_THRESHOLDS,
  getFlyTelemetrySnapshot,
  resetFlyTelemetryCacheForTests,
} from "../server/fly-telemetry-service";
import {
  deriveCapacityStatus,
  getCapacityStatus,
  getInfrastructureStatus,
  getSiteHealth,
} from "../server/growth-intelligence-service";

const TOKEN = "fm2_test_read_only_token_abcdefghijklmnopqrstuvwxyz0123456789";
const SHA = "da9c4406e4249c35dcb54fd3f3f3171d1f7e9a9d";
const MACHINE_A = "683720eb5127d8";
const MACHINE_B = "83d479c745d0d8";

type RequestRecord = { url: URL; init?: RequestInit };
type FixtureOptions = {
  machineBState?: string;
  omitMachineB?: boolean;
  omitP95ForMachineB?: boolean;
  fiveX?: Array<[string, number]>;
};

function vector(values: Array<[string, number]>) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: values.map(([instance, value]) => ({
        metric: { instance, region: "lhr" },
        value: [1_776_000_000, String(value)],
      })),
    },
  };
}

function fixtures(options: FixtureOptions = {}) {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.hostname === "api.machines.dev") {
      return Response.json(
        [
          {
            id: MACHINE_A,
            state: "started",
            region: "lhr",
            image_ref: {
              registry: "registry.fly.io",
              repository: "mintvault",
              tag: "deployment-01M0FVMKY1KSZMWDN6WHDD3185",
              digest: "sha256:must-never-be-exposed",
            },
            checks: [{ status: "passing", output: "must never be exposed" }],
          },
          options.omitMachineB
            ? null
            : {
                id: MACHINE_B,
                state: options.machineBState ?? "started",
                region: "lhr",
                image_ref: {
                  registry: "registry.fly.io",
                  repository: "mintvault",
                  tag: "deployment-01M0FVMKY1KSZMWDN6WHDD3185",
                  digest: "sha256:must-never-be-exposed",
                },
                checks: [{ status: "passing", output: "must never be exposed" }],
              },
        ].filter((machine) => machine !== null)
      );
    }
    const query = url.searchParams.get("query") ?? "";
    if (query.includes("fly_instance_cpu"))
      return Response.json(
        vector([
          [MACHINE_A, 25],
          [MACHINE_B, 30],
        ])
      );
    if (query.includes("fly_instance_memory"))
      return Response.json(
        vector([
          [MACHINE_A, 40],
          [MACHINE_B, 50],
        ])
      );
    if (query.includes("response_time_seconds_bucket")) {
      return Response.json(
        vector(
          options.omitP95ForMachineB
            ? [[MACHINE_A, 120]]
            : [
                [MACHINE_A, 120],
                [MACHINE_B, 180],
              ]
        )
      );
    }
    if (query.includes('status=~"5.."')) return Response.json(vector(options.fiveX ?? []));
    if (query.includes("increase(fly_app_http_responses_count")) {
      return Response.json(
        vector([
          [MACHINE_A, 50],
          [MACHINE_B, 70],
        ])
      );
    }
    if (query.includes("rate(fly_app_http_responses_count")) {
      return Response.json(
        vector([
          [MACHINE_A, 10],
          [MACHINE_B, 15],
        ])
      );
    }
    return Response.json({ status: "error" }, { status: 500 });
  });
  return { fetcher: fetcher as typeof fetch, requests };
}

const env = () => ({ FLY_TELEMETRY_TOKEN: TOKEN, GIT_SHA: SHA }) as NodeJS.ProcessEnv;
const database = { execute: async () => ({ rows: [{ ok: 1, certificates: "certificates" }] }) };

afterEach(() => {
  resetFlyTelemetryCacheForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Fly read-only Growth telemetry", () => {
  it("uses only the immutable MintVault read endpoints and returns sanitized real fleet data", async () => {
    const { fetcher, requests } = fixtures();
    const snapshot = await getFlyTelemetrySnapshot({ fetcher, env: env(), force: true });

    expect(snapshot).toMatchObject({
      state: "REAL",
      overallStatus: "GREEN",
      fleet: {
        cpuPercent: 30,
        memoryPercent: 50,
        p95Ms: 180,
        requestRatePerMinute: 25,
        fiveXRate: 0,
        requestCount: 120,
        healthyMachines: 2,
        expectedMachines: 2,
      },
    });
    expect(snapshot.machines).toHaveLength(2);
    expect(snapshot.machines[0]).toMatchObject({
      machineRef: MACHINE_A,
      region: "lhr",
      status: "GREEN",
      deployedVersion: { state: "REAL", value: "deployment-01M0FVMKY1KSZMWDN6WHDD3185" },
      deployedSha: { state: "REAL", value: SHA },
    });
    expect(requests).toHaveLength(7);
    expect(new Set(requests.map(({ url }) => url.hostname))).toEqual(new Set(["api.machines.dev", "api.fly.io"]));
    expect(requests.filter(({ url }) => url.hostname === "api.machines.dev")[0].url.pathname).toBe(
      "/v1/apps/mintvault/machines"
    );
    expect(
      requests
        .filter(({ url }) => url.hostname === "api.fly.io")
        .every(
          ({ url }) =>
            url.pathname === "/prometheus/personal/api/v1/query" &&
            (url.searchParams.get("query") ?? "").includes('app="mintvault"')
        )
    ).toBe(true);
    expect(
      requests.every(
        ({ init }) =>
          init?.method === "GET" &&
          init.redirect === "error" &&
          new Headers(init.headers).get("authorization") === `FlyV1 ${TOKEN}`
      )
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(JSON.stringify(snapshot)).not.toContain("must never be exposed");
    expect(JSON.stringify(snapshot)).not.toContain("must-never-be-exposed");
    expect(deriveCapacityStatus(snapshot.fleet, FLY_CAPACITY_THRESHOLDS)).toMatchObject({
      status: "GREEN",
      recommendation: "NO_ACTION_REQUIRED",
      automaticScalingEnabled: false,
    });
  });

  it("keeps capacity unknown when one expected machine sample is absent", async () => {
    const { fetcher } = fixtures({ omitP95ForMachineB: true });
    const snapshot = await getFlyTelemetrySnapshot({ fetcher, env: env(), force: true });
    expect(snapshot.machines[1].p95Latency.state).toBe("INSUFFICIENT_DATA");
    expect(snapshot.fleet?.p95Ms).toBeUndefined();
    expect(deriveCapacityStatus(snapshot.fleet, FLY_CAPACITY_THRESHOLDS)).toMatchObject({
      status: "UNKNOWN",
      recommendation: "TELEMETRY_INCOMPLETE",
    });
  });

  it("preserves the approved two-machine floor and restores redundancy before scaling", async () => {
    const { fetcher } = fixtures({ machineBState: "stopped" });
    const snapshot = await getFlyTelemetrySnapshot({ fetcher, env: env(), force: true });
    expect(snapshot.metrics.machineHealth).toMatchObject({ state: "REAL", status: "RED", value: "1/2 healthy" });
    expect(deriveCapacityStatus(snapshot.fleet, FLY_CAPACITY_THRESHOLDS)).toMatchObject({
      status: "RED",
      recommendation: "RESTORE_EXPECTED_FLEET",
    });

    resetFlyTelemetryCacheForTests();
    const missingMachine = fixtures({ omitMachineB: true });
    const missingSnapshot = await getFlyTelemetrySnapshot({
      fetcher: missingMachine.fetcher,
      env: env(),
      force: true,
    });
    expect(missingSnapshot.metrics.machineHealth).toMatchObject({
      state: "REAL",
      status: "RED",
      value: "1/2 healthy",
    });
    expect(missingSnapshot.fleet?.p95Ms).toBeUndefined();
    expect(deriveCapacityStatus(missingSnapshot.fleet, FLY_CAPACITY_THRESHOLDS)).toMatchObject({
      status: "RED",
      recommendation: "RESTORE_EXPECTED_FLEET",
    });
  });

  it("shows bounded stale values but excludes them from capacity decisions", async () => {
    const { fetcher } = fixtures();
    const started = new Date("2026-08-20T17:00:00.000Z");
    await getFlyTelemetrySnapshot({ fetcher, env: env(), now: started, force: true });
    const failing = vi.fn(async () => Response.json({}, { status: 503 })) as typeof fetch;
    const stale = await getFlyTelemetrySnapshot({
      fetcher: failing,
      env: env(),
      now: new Date("2026-08-20T17:01:00.000Z"),
      force: true,
    });
    expect(stale).toMatchObject({ state: "STALE", fleet: null, overallStatus: "AMBER" });
    expect(stale.metrics.cpu.state).toBe("STALE");
    expect(deriveCapacityStatus(stale.fleet, FLY_CAPACITY_THRESHOLDS).status).toBe("UNKNOWN");

    const expired = await getFlyTelemetrySnapshot({
      fetcher: failing,
      env: env(),
      now: new Date("2026-08-20T17:06:00.001Z"),
      force: true,
    });
    expect(expired).toMatchObject({ state: "ERROR", fleet: null, machines: [] });
  });

  it("performs no network call without a dedicated token", async () => {
    const fetcher = vi.fn();
    const snapshot = await getFlyTelemetrySnapshot({ fetcher: fetcher as typeof fetch, env: {}, force: true });
    expect(snapshot).toMatchObject({ state: "NOT_CONNECTED", fleet: null, machines: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("feeds the existing site, capacity and infrastructure read paths without adding mutation authority", async () => {
    const { fetcher } = fixtures();
    vi.stubEnv("FLY_TELEMETRY_TOKEN", TOKEN);
    vi.stubEnv("GIT_SHA", SHA);
    vi.stubGlobal("fetch", fetcher);

    const [site, capacity, infrastructure] = await Promise.all([
      getSiteHealth(database),
      getCapacityStatus(),
      getInfrastructureStatus(database),
    ]);
    expect(site.cpu).toMatchObject({ state: "REAL", status: "GREEN", value: 30 });
    expect(site.flyMachines).toMatchObject({ state: "REAL", status: "GREEN", value: "2/2 healthy" });
    expect(capacity).toMatchObject({ status: "GREEN", recommendation: "NO_ACTION_REQUIRED" });
    expect(infrastructure.fly.overallStatus).toBe("GREEN");
    expect(infrastructure.fly.machines[0]).toMatchObject({ machineRef: MACHINE_A });
    expect(infrastructure.control).toMatchObject({
      currentMode: "MANUAL",
      currentAuthority: "MONITOR_DETECT_RECOMMEND",
      mutationEnabled: false,
      automaticScalingEnabled: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
});
