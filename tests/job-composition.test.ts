import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRegistry, type JobDefinition } from "../server/lib/job-registry";
import {
  __resetLifecycleForTests,
  activeJobCount,
  beginShutdown,
  cancelAllTimers,
  runGracefulShutdown,
} from "../server/lib/lifecycle";

function job(name: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
  return { name, startup: "immediate", run: vi.fn(async () => {}), onError: vi.fn(), ...overrides };
}

beforeEach(() => {
  __resetLifecycleForTests();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  cancelAllTimers();
  __resetLifecycleForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("declarative job composition foundation", () => {
  it("starts in declaration order without awaiting earlier jobs; intervals anchor at installation", async () => {
    const events: string[] = [];
    const record = (name: string) => async () => {
      events.push(`${name}:${Date.now()}`);
    };
    createJobRegistry().install([
      job("first", { run: record("first"), everyMs: 20 }),
      job("second", { run: record("second"), startup: { delayMs: 10 }, everyMs: 20 }),
      job("third", { run: record("third") }),
    ]);
    expect(events).toEqual(["first:0", "third:0"]);
    await vi.advanceTimersByTimeAsync(40);
    expect(events).toEqual(["first:0", "third:0", "second:10", "first:20", "second:20", "first:40", "second:40"]);
  });

  it("supports interval-only work without an initial launch", async () => {
    const definition = job("interval", { startup: "none", everyMs: 30 });
    createJobRegistry().install([definition]);
    expect(definition.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(definition.run).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid delay %s atomically", (delay) => {
    const first = job("first");
    const registry = createJobRegistry();
    expect(() => registry.install([first, job("invalid", { startup: { delayMs: delay } })])).toThrow();
    expect(first.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    registry.install([first]); // Refused manifests did not reserve earlier names.
    expect(first.run).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid interval %s before any timer", (everyMs) => {
    const first = job("first", { startup: { delayMs: 10 } });
    expect(() => createJobRegistry().install([first, job("invalid", { everyMs })])).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects duplicate names within and across installations without starting the new batch", () => {
    const registry = createJobRegistry();
    const definition = job("same");
    expect(() => registry.install([definition, definition])).toThrow();
    expect(definition.run).not.toHaveBeenCalled();
    registry.install([definition]);
    const other = job("other");
    expect(() => registry.install([other, definition])).toThrow();
    expect(other.run).not.toHaveBeenCalled();
    expect(definition.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "" },
    { name: "unsafe name" },
    { startup: "unknown" },
    { startup: "none" },
    { startup: null },
    { run: null },
    { onError: null },
  ])("rejects malformed definition %j", (override) => {
    expect(() => createJobRegistry().install([job("bad", override as Partial<JobDefinition>)])).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snapshots callbacks and nested timing before caller mutation", async () => {
    const run = vi.fn(async () => {});
    const replacement = vi.fn(async () => {});
    const definition = { name: "snapshot", startup: { delayMs: 10 }, everyMs: 20, run, onError: vi.fn() };
    createJobRegistry().install([definition]);
    definition.startup.delayMs = 1;
    definition.everyMs = 1;
    definition.run = replacement;
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("preserves overlapping ticks and drains all admitted jobs before closing pools", async () => {
    const releases: Array<() => void> = [];
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );
    createJobRegistry().install([job("pending", { run: pending, everyMs: 10 })]);
    await vi.advanceTimersByTimeAsync(10);
    expect(activeJobCount()).toBe(2);
    const events: string[] = [];
    const shutdown = runGracefulShutdown({
      closeServer: () => {
        events.push("server");
      },
      closePools: () => {
        events.push("pools");
      },
      exit: () => {
        events.push("exit");
      },
      deadlineMs: 1_000,
      drainPollMs: 1,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual(["server"]);
    expect(pending).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(events).toEqual(["server", "pools", "exit"]);
    expect(activeJobCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses both new installation and already-armed callbacks after shutdown begins", async () => {
    const definition = job("later", { startup: { delayMs: 10 }, everyMs: 10 });
    const registry = createJobRegistry();
    registry.install([definition]);
    beginShutdown();
    const rejected = job("rejected", { everyMs: 5 });
    registry.install([rejected]);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(definition.run).not.toHaveBeenCalled();
    expect(rejected.run).not.toHaveBeenCalled();
    expect(activeJobCount()).toBe(0);
    cancelAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm timers after an immediate callback synchronously starts shutdown", async () => {
    const later = job("later", { everyMs: 10 });
    createJobRegistry().install([
      job("stop", {
        run: async () => {
          beginShutdown();
          cancelAllTimers();
        },
        everyMs: 10,
      }),
      later,
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(later.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("contains rejected/synchronous work (sync=%s) and drains error reporting", async (sync) => {
    const error = new Error("synthetic");
    const onError = vi.fn(async () => {});
    const run = sync
      ? () => {
          throw error;
        }
      : async () => {
          throw error;
        };
    createJobRegistry().install([job("failure", { run, onError })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(activeJobCount()).toBe(0);
  });

  it("contains an error reporter rejection without leaking the underlying error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    createJobRegistry().install([
      job("reporter", {
        run: async () => {
          throw new Error("private work detail");
        },
        onError: async () => {
          throw new Error("private reporter detail");
        },
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledExactlyOnceWith("[jobs] error reporter failed for reporter");
    expect(activeJobCount()).toBe(0);
  });
});
