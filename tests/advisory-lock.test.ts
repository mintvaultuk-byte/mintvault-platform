import { describe, it, expect, vi } from "vitest";
import { hashLockKey, withAdvisoryLock } from "../server/lib/advisory-lock";

describe("hashLockKey", () => {
  it("is deterministic and positive within 31-bit range", () => {
    const a = hashLockKey("transfer-v2-sweep");
    expect(a).toBe(hashLockKey("transfer-v2-sweep"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(0x7fffffff);
  });

  it("gives distinct keys for distinct job names", () => {
    expect(hashLockKey("scan-reconciler")).not.toBe(hashLockKey("archival-sweep"));
  });
});

// Mock pool whose connect() returns a single dedicated client, so we can assert
// lock + unlock happen on the SAME client and the client is always released.
function mockPool(opts: { locked?: boolean; connectThrows?: boolean; acquireThrows?: boolean } = {}) {
  const { locked = true, connectThrows = false, acquireThrows = false } = opts;
  const calls: string[] = [];
  let released = false;
  const client = {
    query: vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("pg_try_advisory_lock")) {
        if (acquireThrows) throw new Error("acquire failed");
        return { rows: [{ locked }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(() => {
      released = true;
    }),
  };
  const pool = {
    connect: vi.fn(async () => {
      if (connectThrows) throw new Error("no connection");
      return client;
    }),
  };
  return { pool, client, calls, released: () => released };
}

describe("withAdvisoryLock", () => {
  it("runs fn, then unlocks and releases the client (same connection)", async () => {
    const { pool, client, calls, released } = mockPool({ locked: true });
    const fn = vi.fn(async () => {});
    const out = await withAdvisoryLock(pool, "job-a", fn);
    expect(out.ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
    expect(released()).toBe(true);
  });

  it("skips fn when the lock is held elsewhere, still releases the client", async () => {
    const { pool, client } = mockPool({ locked: false });
    const fn = vi.fn(async () => {});
    const out = await withAdvisoryLock(pool, "job-b", fn);
    expect(out.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("releases the lock and client even if fn throws", async () => {
    const { pool, client, calls } = mockPool({ locked: true });
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withAdvisoryLock(pool, "job-c", fn)).rejects.toThrow("boom");
    expect(calls.some((c) => c.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it("fails closed (skips fn) if acquiring the lock errors", async () => {
    const { pool, client } = mockPool({ acquireThrows: true });
    const fn = vi.fn(async () => {});
    const out = await withAdvisoryLock(pool, "job-d", fn);
    expect(out.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("fails closed if a connection cannot be obtained", async () => {
    const { pool } = mockPool({ connectThrows: true });
    const fn = vi.fn(async () => {});
    const out = await withAdvisoryLock(pool, "job-e", fn);
    expect(out.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
