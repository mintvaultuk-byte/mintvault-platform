import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  childStatus,
  cleanup,
  controlledEnvironment,
  main,
  parse,
  preparationExports,
  runChild,
  startDisposableServices,
} from "../scripts/ci/run-disposable-integration.mjs";

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
