import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  childStatus,
  cleanup,
  controlledEnvironment,
  main,
  parse,
  preparationExports,
  runChild,
  startDisposableServices,
  startDisposableObjectStore,
  validateR2ProofReport,
  MINIO_IMAGE,
  R2_PROOF_CHECKS,
  ADMIN_BROWSER_PROOF_CHECKS,
  validateAdminBrowserReport,
  PARTNER_BROWSER_PROOF_CHECKS,
  validatePartnerBrowserReport,
  stopOwnedChild,
} from "../scripts/ci/run-disposable-integration.mjs";
import { objectProofEnvironment } from "../scripts/ci/run-r2-object-store-proof.mjs";

function fakeDriver({ failSecondStart = false, unowned = false } = {}) {
  const owned = new Set<string>();
  const removed: string[] = [];
  let starts = 0;
  return {
    owned,
    removed,
    run(args: string[]) {
      if (args[0] === "run") {
        starts += 1;
        if (failSecondStart && starts === 2) throw new Error("pg17 start failed");
        const id = `abcdefabcdef${starts}`;
        owned.add(id);
        return id;
      }
      if (args[0] === "exec") {
        if (args.at(-1)?.includes("pg_available_extensions")) return "1";
        return args[1].endsWith("1") ? "160010" : "170006";
      }
      return "";
    },
    inspect(id: string, _token: string) {
      return !unowned && owned.has(id);
    },
    port(id: string) {
      return `127.0.0.1:${41000 + Number(id.at(-1))}`;
    },
    remove(id: string) {
      removed.push(id);
      owned.delete(id);
      return "";
    },
  };
}

describe("disposable integration runner", () => {
  it("closing owned pipes does not stand in for actual child termination", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean; stderr: { destroy: () => void } };
    const destroy = vi.fn();
    child.stderr = { destroy };
    child.kill = () => true;
    expect(await stopOwnedChild(child, { closeOwnedPipes: true, graceMs: 1, killMs: 1 })).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("installs the close observer before closing the owned browser pipe", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean; stderr: { destroy: () => void } };
    child.stderr = { destroy: () => child.emit("close", 0) };
    child.kill = () => false;
    expect(await stopOwnedChild(child, { closeOwnedPipes: true, graceMs: 1, killMs: 1 })).toBe(true);
  });
  it("awaits delayed close when kill returns false after process exit", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    child.kill = () => {
      queueMicrotask(() => child.emit("close", 0));
      return false;
    };
    expect(await stopOwnedChild(child, { graceMs: 20, killMs: 20 })).toBe(true);
  });
  it("confirms synchronous owned-child close without leaving a late kill timer", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    child.kill = () => {
      child.emit("close", 0);
      return true;
    };
    expect(await stopOwnedChild(child, { graceMs: 1, killMs: 1 })).toBe(true);
    expect(child.listenerCount("close")).toBe(0);
  });
  it.each(["denied", "silent", "throws"])("retains resources when owned-child termination is %s", async (failure) => {
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    const signals: string[] = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (failure === "throws") throw new Error("denied");
      return failure !== "denied";
    };
    expect(await stopOwnedChild(child, { graceMs: 1, killMs: 1 })).toBe(false);
    expect(signals).toEqual(failure === "silent" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
    expect(child.listenerCount("close")).toBe(0);
  });
  it("does not equate exit with close or release services before delayed close", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    child.kill = () => {
      queueMicrotask(() => child.emit("exit", 0));
      return true;
    };
    expect(await stopOwnedChild(child, { graceMs: 1, killMs: 1 })).toBe(false);
  });
  it("has one exclusive fixed Admin browser target, not arbitrary commands or inherited service selection", () => {
    expect(parse(["--docker-context", "owned", "--admin-browser-proof"])).toEqual({
      context: "owned",
      prepare: false,
      selection: [],
      adminBrowserProof: true,
    });
    for (const args of [["--r2-proof"], ["--prepare"], ["--all"], ["tests/a.test.ts"], ["--admin-browser-proof"]])
      expect(() => parse(["--docker-context", "owned", "--admin-browser-proof", ...args])).toThrow();
  });
  it("rejects missing, skipped, stale or foreign browser reports", () => {
    const report = {
      schemaVersion: 1,
      runId: "owned-run",
      url: "http://127.0.0.1:41003/",
      browser: "Chrome/test",
      passed: 7,
      failed: 0,
      skipped: 0,
      checks: ADMIN_BROWSER_PROOF_CHECKS.map((name: string) => ({ name, status: "passed" })),
    };
    expect(validateAdminBrowserReport(report, "owned-run")).toBe(report);
    for (const delta of [
      { runId: "stale" },
      { skipped: 1 },
      { failed: 1 },
      { passed: 0 },
      { checks: [] },
      { url: "https://remote.invalid/" },
      { url: "http://127.0.0.1/" },
      { browser: "" },
      { checks: report.checks.slice(1) },
    ])
      expect(() => validateAdminBrowserReport({ ...report, ...delta }, "owned-run")).toThrow();
  });
  it("requires an exclusive Partner browser target and its complete distinct report", () => {
    expect(parse(["--docker-context", "owned", "--partner-browser-proof"])).toEqual({
      context: "owned",
      prepare: false,
      selection: [],
      partnerBrowserProof: true,
    });
    for (const args of [
      ["--r2-proof"],
      ["--prepare"],
      ["--all"],
      ["tests/a.test.ts"],
      ["--partner-browser-proof"],
      ["--admin-browser-proof"],
    ])
      expect(() => parse(["--docker-context", "owned", "--partner-browser-proof", ...args])).toThrow();
    const report = {
      schemaVersion: 1,
      kind: "partner",
      runId: "owned-run",
      url: "http://127.0.0.1:41003/",
      browser: "Chrome/test",
      passed: 22,
      failed: 0,
      skipped: 0,
      checks: PARTNER_BROWSER_PROOF_CHECKS.map((name: string) => ({ name, status: "passed" })),
    };
    expect(validatePartnerBrowserReport(report, "owned-run")).toBe(report);
    expect(() => validateAdminBrowserReport(report, "owned-run")).toThrow();
    for (const delta of [
      { kind: "admin" },
      { kind: undefined },
      { runId: "stale" },
      { passed: 17 },
      { skipped: 1 },
      { failed: 1 },
      { checks: report.checks.slice(1) },
      { checks: [...report.checks].reverse() },
      { checks: report.checks.map((check) => ({ ...check, status: "skipped" })) },
    ])
      expect(() => validatePartnerBrowserReport({ ...report, ...delta }, "owned-run")).toThrow();
  });
  it.each([0, 1, 75])(
    "Partner browser child status %i requires its own proof and retains unknown termination",
    async (code) => {
      const driver = fakeDriver();
      const fakeSpawn = (_command: string, args: string[], options: { env: Record<string, string> }) => {
        expect(args.slice(0, 4)).toEqual([
          "--import",
          "tsx",
          "scripts/command-centre-runtime-harness.ts",
          "--partner-browser-proof",
        ]);
        expect(options.env.MINTVAULT_PARTNER_BROWSER_PASSWORD).toMatch(/^[a-f0-9]{48}$/);
        for (const key of [
          "MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PASSWORD",
          "MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN",
          "PARTNER_DATABASE_URL",
          "STRIPE_SECRET_KEY",
        ])
          expect(options.env).not.toHaveProperty(key);
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", code));
        return child;
      };
      const run = main(["--docker-context", "owned", "--partner-browser-proof"], { driver, spawnProcess: fakeSpawn });
      if (code === 0) await expect(run).rejects.toThrow("ENOENT");
      else if (code === 75) await expect(run).rejects.toThrow("retain owned services");
      else expect(await run).toBe(1);
      expect(driver.removed).toHaveLength(code === 75 ? 0 : 2);
    }
  );
  it.each([0, 1, 75])(
    "Admin browser child status %i is not accepted without proof and unknown closure retains services",
    async (code) => {
      const driver = fakeDriver();
      const fakeSpawn = (_command: string, args: string[], options: { env: Record<string, string> }) => {
        expect(args.slice(0, 4)).toEqual([
          "--import",
          "tsx",
          "scripts/command-centre-runtime-harness.ts",
          "--browser-proof",
        ]);
        expect(options.env.MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_URL).toBe(
          "postgresql://postgres:postgres@127.0.0.1:41002/postgres"
        );
        expect(options.env.MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN).toMatch(/^\d{8}$/);
        expect(options.env).not.toHaveProperty("STRIPE_SECRET_KEY");
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", code));
        return child;
      };
      const run = main(["--docker-context", "owned", "--admin-browser-proof"], { driver, spawnProcess: fakeSpawn });
      if (code === 0) await expect(run).rejects.toThrow("ENOENT");
      else if (code === 75) await expect(run).rejects.toThrow("retain owned services");
      else expect(await run).toBe(1);
      expect(driver.removed).toHaveLength(code === 75 ? 0 : 2);
    }
  );
  it("scrubs inherited credentials while preserving only process essentials", () => {
    const env = controlledEnvironment({
      PATH: "/bin",
      DATABASE_URL: "postgres://live",
      STRIPE_SECRET_KEY: "live",
      POSTGRES17_BIN: "/pg/bin",
    });
    expect(env).toMatchObject({ PATH: "/bin", POSTGRES17_BIN: "/pg/bin", NODE_ENV: "test" });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("STRIPE_SECRET_KEY");
  });

  it("starts labelled synthetic-password PostgreSQL services and cleans their exact owned IDs", async () => {
    const driver = fakeDriver();
    const services = await startDisposableServices({ driver, token: "11111111-2222-4333-8444-555555555555" });
    expect(services.env).toMatchObject({ MINTVAULT_TEST_PG16_PORT: "41001", MINTVAULT_TEST_PG17_PORT: "41002" });
    cleanup(driver, services.ids, services.token);
    expect(driver.removed).toEqual(["abcdefabcdef2", "abcdefabcdef1"]);
  });

  it("cleans the first owned ID when later startup fails", async () => {
    const driver = fakeDriver({ failSecondStart: true });
    await expect(startDisposableServices({ driver, token: "11111111-2222-4333-8444-555555555555" })).rejects.toThrow(
      "pg17 start failed"
    );
    expect(driver.removed).toEqual(["abcdefabcdef1"]);
  });

  it("does not remove an ID whose ownership label cannot be verified", () => {
    const driver = fakeDriver({ unowned: true });
    expect(() => cleanup(driver, ["abcdefabcdef1"], "run-uuid")).toThrow("cleanup failed");
    expect(driver.removed).toEqual([]);
  });

  it("maps successful and failed child exits without treating zero as false", () => {
    expect(childStatus({ code: 0 })).toBe(0);
    expect(childStatus({ code: 1 })).toBe(1);
    expect(childStatus({ code: null })).toBe(1);
  });

  it("awaits an executable child failure rather than inferring success", async () => {
    const fakeSpawn = () => {
      const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
      child.exitCode = null;
      queueMicrotask(() => child.emit("close", 1));
      return child;
    };
    const outcome = await runChild(["ignored"], { PATH: "/bin" }, fakeSpawn as never);
    expect(childStatus(outcome)).toBe(1);
  });

  it("accepts multiple suites and forwards JSON output without treating its path as a suite", () => {
    expect(
      parse(["--docker-context", "owned", "tests/a.test.ts", "tests/b.test.ts", "--json", "/tmp/reports"])
    ).toMatchObject({
      context: "owned",
      selection: ["tests/a.test.ts", "tests/b.test.ts", "--json", "/tmp/reports"],
    });
    expect(() => parse(["--all"])).toThrow();
    expect(() => parse(["--docker-context", "owned", "--all", "tests/a.test.ts"])).toThrow();
    expect(() => parse(["--docker-context", "owned", "--all", "--unknown"])).toThrow();
  });

  it("rejects flattened preparation URLs outside the exact owned ports", () => {
    const ports = { MINTVAULT_TEST_PG16_PORT: "41001", MINTVAULT_TEST_PG17_PORT: "41002" };
    expect(
      preparationExports("TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:41001/test\n", ports)
    ).toHaveProperty("TEST_DATABASE_URL");
    for (const url of [
      "postgresql://127.0.0.1:55432/test",
      "postgresql://remote.invalid:41001/test",
      "https://127.0.0.1:41001/test",
    ])
      expect(() => preparationExports(`TEST_DATABASE_URL=${url}`, ports)).toThrow("owned PostgreSQL");
    for (const key of ["PATH", "NODE_ENV", "LANG", "LC_ALL", "DOCKER_CONTEXT", "MINTVAULT_TEST_PG16_PORT"])
      expect(() => preparationExports(`${key}=postgresql://127.0.0.1:41001/test`, ports)).toThrow("export key");
    expect(() => controlledEnvironment({ PATH: "/bin" }, { PATH: "/other" })).toThrow("cannot override PATH");
  });

  it.each([0, 1])("propagates child status %i and removes both owned services", async (code) => {
    const driver = fakeDriver();
    const fakeSpawn = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", code));
      return child;
    };
    expect(await main(["--docker-context", "owned", "tests/a.test.ts"], { driver, spawnProcess: fakeSpawn })).toBe(
      code
    );
    expect(driver.removed).toEqual(["abcdefabcdef2", "abcdefabcdef1"]);
  });

  it("does not start tests after preparation failure and preserves the controlled PATH", async () => {
    const driver = fakeDriver();
    const calls: string[][] = [];
    const fakeSpawn = (_command: string, args: string[], options: { env: Record<string, string> }) => {
      calls.push(args);
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(options.env.DOCKER_CONTEXT).toBe("owned");
      expect(options.env.GITHUB_ENV).toMatch(/mintvault-ci-env-/);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    };
    expect(await main(["--docker-context", "owned", "--prepare", "--all"], { driver, spawnProcess: fakeSpawn })).toBe(
      1
    );
    expect(calls).toEqual([["scripts/ci/prepare-engineering-governance-db.mjs"]]);
    expect(driver.removed).toHaveLength(2);
  });

  it("awaits signalled child closure before removing either service", async () => {
    const driver = fakeDriver(),
      signals = new EventEmitter();
    const events: string[] = [];
    const remove = driver.remove;
    driver.remove = (id) => {
      events.push("remove");
      return remove(id);
    };
    const fakeSpawn = () => {
      const child = new EventEmitter() as EventEmitter & { kill: (kind: string) => void };
      child.kill = (kind) => {
        events.push(kind);
        expect(driver.removed).toEqual([]);
        queueMicrotask(() => {
          events.push("close");
          child.emit("close", null);
        });
      };
      queueMicrotask(() => signals.emit("SIGTERM"));
      return child;
    };
    expect(
      await main(["--docker-context", "owned", "--all"], { driver, spawnProcess: fakeSpawn, signalSource: signals })
    ).toBe(143);
    expect(events).toEqual(["SIGTERM", "close", "remove", "remove"]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("fails explicitly and retains services if the OS refuses to terminate the child", async () => {
    const driver = fakeDriver(),
      signals = new EventEmitter();
    const fakeSpawn = () => {
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      };
      queueMicrotask(() => signals.emit("SIGTERM"));
      return child;
    };
    await expect(
      main(["--docker-context", "owned", "--all"], { driver, spawnProcess: fakeSpawn, signalSource: signals })
    ).rejects.toThrow("termination could not be confirmed");
    expect(driver.removed).toEqual([]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});

const readyMinio = async () => new Response(null, { status: 200 });
function objectReport(env: Record<string, string>) {
  return {
    schemaVersion: 1,
    runId: env.MINTVAULT_OBJECT_PROOF_RUN_ID,
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET_NAME,
    image: MINIO_IMAGE,
    passed: R2_PROOF_CHECKS.length,
    failed: 0,
    skipped: 0,
    checks: R2_PROOF_CHECKS.map((name: string) => ({ name, status: "passed" })),
  };
}

describe("disposable real object-store proof", () => {
  it("bounds readiness even when the service never responds", async () => {
    vi.useFakeTimers();
    try {
      const driver = fakeDriver();
      const fetchReady = (_url: string | URL | Request, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        });
      const result = startDisposableObjectStore({ driver, fetchReady });
      const rejected = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      expect(driver.removed).toEqual(["abcdefabcdef1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds post-SIGKILL uncertainty and retains storage instead of hanging or deleting it", async () => {
    vi.useFakeTimers();
    try {
      const driver = fakeDriver(),
        signals = new EventEmitter(),
        killed: string[] = [];
      const fakeSpawn = () => {
        const child = new EventEmitter() as EventEmitter & { kill: (kind: string) => void };
        child.kill = (kind) => {
          killed.push(kind);
        };
        queueMicrotask(() => signals.emit("SIGTERM"));
        return child;
      };
      const result = main(["--docker-context", "owned", "--r2-proof"], {
        driver,
        fetchReady: readyMinio,
        spawnProcess: fakeSpawn,
        signalSource: signals,
      });
      const rejected = expect(result).rejects.toThrow("termination could not be confirmed");
      await vi.advanceTimersByTimeAsync(10_001);
      await rejected;
      expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
      expect(driver.removed).toEqual([]);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule a second termination after synchronous child closure", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(),
        killed: string[] = [];
      const fakeSpawn = () => {
        const child = new EventEmitter() as EventEmitter & { kill: (kind: string) => void };
        child.kill = (kind) => {
          killed.push(kind);
          child.emit("close", null);
        };
        return child;
      };
      const result = runChild(["ignored"], {}, fakeSpawn as never, controller.signal);
      controller.abort();
      expect(await result).toEqual({ code: null });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(killed).toEqual(["SIGTERM"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires an explicit context and an exclusive target", () => {
    expect(parse(["--docker-context", "owned", "--r2-proof"])).toMatchObject({ r2Proof: true, context: "owned" });
    for (const extra of [["--all"], ["--prepare"], ["--json", "/tmp/reports"], ["--r2-proof"], ["tests/a.test.ts"]])
      expect(() => parse(["--docker-context", "owned", "--r2-proof", ...extra])).toThrow();
    expect(() => parse(["--r2-proof"])).toThrow();
  });

  it("uses the pinned MinIO image, generated process-only credentials and random loopback mapping", async () => {
    const driver = fakeDriver();
    const original = driver.run;
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    driver.run = (args: string[], env?: Record<string, string>) => {
      calls.push({ args, env });
      return original(args);
    };
    const service = await startDisposableObjectStore({ driver, fetchReady: readyMinio });
    expect(calls[0].args).toEqual(expect.arrayContaining([MINIO_IMAGE, "127.0.0.1::9000", "MINIO_ROOT_PASSWORD"]));
    expect(calls[0].args).not.toContain(calls[0].env!.MINIO_ROOT_PASSWORD);
    expect(calls[0].args).not.toContain("--volume");
    expect(calls[0].env!.MINIO_ROOT_PASSWORD).toMatch(/^[a-f0-9]{48}$/);
    expect(service.env.R2_SECRET_ACCESS_KEY).toBe(calls[0].env!.MINIO_ROOT_PASSWORD);
    expect(service.env.R2_BUCKET_NAME).toBe(`proof-${service.token}`);
    expect(objectProofEnvironment({ ...service.env, NODE_ENV: "test" }).runId).toBe(service.token);
    cleanup(driver, service.ids, service.token);
    expect(driver.removed).toEqual(["abcdefabcdef1"]);
  });

  it.each(["0.0.0.0:9000", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:41001\n[::]:41001"])(
    "rejects invalid or exposed mapping %s and cleans only its owned ID",
    async (mapping) => {
      const driver = fakeDriver();
      driver.port = () => mapping;
      await expect(startDisposableObjectStore({ driver, fetchReady: readyMinio })).rejects.toThrow();
      expect(driver.removed).toEqual(["abcdefabcdef1"]);
    }
  );

  it("cleans the owned instance when startup is cancelled, without entering the child", async () => {
    const driver = fakeDriver(),
      controller = new AbortController();
    const fetchReady = async () => {
      controller.abort();
      return new Response(null, { status: 503 });
    };
    await expect(startDisposableObjectStore({ driver, signal: controller.signal, fetchReady })).rejects.toThrow();
    expect(driver.removed).toEqual(["abcdefabcdef1"]);
  });

  it("retains an instance whose ownership cannot be verified", async () => {
    const driver = fakeDriver({ unowned: true });
    await expect(startDisposableObjectStore({ driver, fetchReady: readyMinio })).rejects.toThrow("cleanup failed");
    expect(driver.removed).toEqual([]);
  });

  it("rejects inherited live, remote or local-filesystem proof configuration before importing the adapter", async () => {
    const driver = fakeDriver();
    const service = await startDisposableObjectStore({ driver, fetchReady: readyMinio });
    const env = { ...service.env, NODE_ENV: "test" };
    for (const override of [
      { NODE_ENV: "production" },
      { R2_ENDPOINT: "https://r2.example.test" },
      { R2_ENDPOINT: "http://localhost:9000" },
      { R2_ENDPOINT: "http://127.0.0.1:9000/path" },
      { R2_ENDPOINT: "http://127.0.0.1:9000/?x=y" },
      { R2_BUCKET_NAME: "live" },
      { R2_SECRET_ACCESS_KEY: "inherited" },
      { MINTVAULT_OBJECT_PROOF_RUN_ID: "wrong" },
      { MINTVAULT_LOCAL_EVIDENCE_DIR: "/tmp/local" },
    ])
      expect(() => objectProofEnvironment({ ...env, ...override })).toThrow();
    const controlled = controlledEnvironment({ ...env, STRIPE_SECRET_KEY: "live", MINTVAULT_DATABASE_URL: "live" });
    expect(controlled).not.toHaveProperty("R2_ENDPOINT");
    expect(controlled).not.toHaveProperty("R2_SECRET_ACCESS_KEY");
    expect(controlled).not.toHaveProperty("MINTVAULT_DATABASE_URL");
    expect(controlled).not.toHaveProperty("STRIPE_SECRET_KEY");
  });

  it("rejects absent, zero, skipped, duplicate, mismatched and failed proof reports", async () => {
    const service = await startDisposableObjectStore({ driver: fakeDriver(), fetchReady: readyMinio });
    const good = objectReport(service.env);
    expect(validateR2ProofReport(good, service)).toBe(good);
    for (const bad of [
      null,
      {},
      { ...good, passed: 0 },
      { ...good, skipped: 1 },
      { ...good, failed: 1 },
      { ...good, runId: "other" },
      { ...good, endpoint: "http://127.0.0.1:9000" },
      { ...good, bucket: "other" },
      { ...good, image: "minio/minio:latest" },
      { ...good, checks: [] },
      { ...good, checks: [...good.checks.slice(1), good.checks[1]] },
    ])
      expect(() => validateR2ProofReport(bad, service)).toThrow();
  });

  it.each(["success", "missing", "malformed", "empty", "child-failed"])(
    "requires a non-vacuous report even when child outcome is %s",
    async (scenario) => {
      const driver = fakeDriver();
      const fakeSpawn = (_command: string, args: string[], options: { env: Record<string, string> }) => {
        expect(args.slice(0, 3)).toEqual(["--import", "tsx", "scripts/ci/run-r2-object-store-proof.mjs"]);
        expect(options.env).not.toHaveProperty("MINTVAULT_DATABASE_URL");
        const report = scenario === "empty" ? {} : objectReport(options.env);
        if (scenario !== "missing") writeFileSync(args[3], scenario === "malformed" ? "{" : JSON.stringify(report));
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", scenario === "child-failed" ? 1 : 0));
        return child;
      };
      const operation = main(["--docker-context", "owned", "--r2-proof"], {
        driver,
        fetchReady: readyMinio,
        spawnProcess: fakeSpawn,
      });
      if (scenario === "success") expect(await operation).toBe(0);
      else if (scenario === "child-failed") expect(await operation).toBe(1);
      else await expect(operation).rejects.toThrow();
      expect(driver.removed).toEqual(["abcdefabcdef1"]);
    }
  );

  it("waits for object-proof child closure before signal cleanup", async () => {
    const driver = fakeDriver(),
      signals = new EventEmitter(),
      events: string[] = [];
    const original = driver.remove;
    driver.remove = (id) => {
      events.push("remove");
      return original(id);
    };
    const fakeSpawn = () => {
      const child = new EventEmitter() as EventEmitter & { kill: (kind: string) => void };
      child.kill = (kind) => {
        events.push(kind);
        expect(driver.removed).toEqual([]);
        queueMicrotask(() => {
          events.push("close");
          child.emit("close", null);
        });
      };
      queueMicrotask(() => signals.emit("SIGTERM"));
      return child;
    };
    expect(
      await main(["--docker-context", "owned", "--r2-proof"], {
        driver,
        fetchReady: readyMinio,
        spawnProcess: fakeSpawn,
        signalSource: signals,
      })
    ).toBe(143);
    expect(events).toEqual(["SIGTERM", "close", "remove"]);
  });
});
