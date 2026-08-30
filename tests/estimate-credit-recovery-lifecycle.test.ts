import { afterEach, describe, expect, it, vi } from "vitest";
import { refundStaleEstimateCreditReservations } from "../server/estimate-credit-consumption";
import { __resetLifecycleForTests, activeJobCount, runGracefulShutdown, runTrackedJob } from "../server/lib/lifecycle";

vi.mock("../server/db", () => ({ db: {} }));

afterEach(() => {
  __resetLifecycleForTests();
  vi.restoreAllMocks();
});

describe("estimate credit recovery process lifecycle", () => {
  it("drains an admitted recovery before SIGTERM closes its database pool", async () => {
    __resetLifecycleForTests();
    let releaseQuery!: (value: { rows: Array<Record<string, number>> }) => void;
    const execute = vi.fn(
      () =>
        new Promise<{ rows: Array<Record<string, number>> }>((resolve) => {
          releaseQuery = resolve;
        })
    );
    const events: string[] = [];

    const recovery = runTrackedJob(() => refundStaleEstimateCreditReservations({}, { exec: { execute } as never }));
    expect(activeJobCount()).toBe(1);

    const shutdown = runGracefulShutdown({
      deadlineMs: 2_000,
      drainPollMs: 1,
      closeServer: async () => {
        events.push("server-closed");
      },
      closePools: async () => {
        events.push("pools-closed");
      },
      exit: () => {
        events.push("exit");
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["server-closed"]);
    expect(activeJobCount()).toBe(1);

    releaseQuery({ rows: [{ examined: 1, refunded: 1, unrecoverable: 0 }] });
    await recovery;
    await shutdown;
    expect(activeJobCount()).toBe(0);
    expect(events).toEqual(["server-closed", "pools-closed", "exit"]);
  });

  it("refuses to start a new recovery once shutdown has begun", async () => {
    __resetLifecycleForTests();
    const execute = vi.fn(async () => ({ rows: [{ examined: 0, refunded: 0, unrecoverable: 0 }] }));
    await runGracefulShutdown({
      deadlineMs: 100,
      closeServer: () => undefined,
      closePools: () => undefined,
      exit: () => undefined,
    });

    await expect(
      runTrackedJob(() => refundStaleEstimateCreditReservations({}, { exec: { execute } as never }))
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
