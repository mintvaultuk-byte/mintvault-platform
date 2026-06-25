import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  trackInterval,
  trackTimeout,
  cancelAllTimers,
  registerCleanup,
  beginJob,
  endJob,
  activeJobCount,
  isShuttingDown,
  runGracefulShutdown,
  __resetLifecycleForTests,
} from "../server/lib/lifecycle";

beforeEach(() => __resetLifecycleForTests());

describe("timer tracking + cancellation (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancelAllTimers stops a tracked interval from firing again", () => {
    const fn = vi.fn();
    trackInterval(fn, 1000);
    vi.advanceTimersByTime(2500);
    expect(fn).toHaveBeenCalledTimes(2);
    cancelAllTimers();
    vi.advanceTimersByTime(10000);
    expect(fn).toHaveBeenCalledTimes(2); // no new ticks after cancel
  });

  it("cancelAllTimers stops a tracked timeout that has not yet fired", () => {
    const fn = vi.fn();
    trackTimeout(fn, 1000);
    cancelAllTimers();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("double-cleanup idempotency", () => {
  it("runs each cleanup exactly once even if cancelAllTimers is called twice", () => {
    const spy = vi.fn();
    registerCleanup(spy);
    cancelAllTimers();
    cancelAllTimers();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps cancelling remaining cleanups if one throws", () => {
    const ok = vi.fn();
    registerCleanup(() => {
      throw new Error("boom");
    });
    registerCleanup(ok);
    expect(() => cancelAllTimers()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("runGracefulShutdown — active-job drain", () => {
  it("waits for active jobs to drain before closing pools, then exits", async () => {
    const order: string[] = [];
    beginJob(); // one job in flight when shutdown begins
    const deps = {
      closeServer: () => {
        order.push("server-closed");
      },
      closePools: () => {
        order.push("pools-closed");
      },
      exit: () => {
        order.push("exit");
      },
      deadlineMs: 1000,
      drainPollMs: 5,
    };
    const p = runGracefulShutdown(deps);
    // job finishes shortly after shutdown starts
    setTimeout(() => endJob(), 20);
    await p;

    expect(isShuttingDown()).toBe(true);
    expect(activeJobCount()).toBe(0);
    // pools closed only AFTER the server closed and the job drained
    expect(order).toEqual(["server-closed", "pools-closed", "exit"]);
  });

  it("a tick's begin/finally-endJob stays balanced even when its locked section throws", async () => {
    // Mirrors the ig-daily-post / weekly-reel tick wiring: beginJob() then
    // try { withAdvisoryLock(...) } finally { endJob() }. A throw must not leak
    // the count, or graceful shutdown would drain forever.
    const tick = async () => {
      beginJob();
      try {
        throw new Error("advisory lock acquire failed");
      } finally {
        endJob();
      }
    };
    await expect(tick()).rejects.toThrow();
    expect(activeJobCount()).toBe(0);
  });
});

describe("runGracefulShutdown — forced deadline", () => {
  it("forces exit at the deadline even if a job never drains (pools not closed under it)", async () => {
    const closePools = vi.fn();
    const exit = vi.fn();
    beginJob(); // never ends
    await runGracefulShutdown({
      closeServer: () => {},
      closePools,
      exit,
      deadlineMs: 40,
      drainPollMs: 5,
    });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(closePools).not.toHaveBeenCalled(); // never close a pool under a live job
  });

  it("is idempotent — a second shutdown call is a no-op", async () => {
    const exit = vi.fn();
    const deps = { closeServer: () => {}, closePools: () => {}, exit, deadlineMs: 20, drainPollMs: 5 };
    await runGracefulShutdown(deps);
    await runGracefulShutdown(deps);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
