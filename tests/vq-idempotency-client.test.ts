/**
 * Phase 10A D10 — client-side idempotency key persistence (client/src/lib/vq-idempotency.ts).
 * No jsdom configured in this project, so `window`/`localStorage` are stubbed directly via
 * vi.stubGlobal (works in the default node test environment). Proves the exact properties
 * the "reload" and "second tab" scenarios rely on: a key persists across separate reads
 * (simulating a reload), and is cleared on a terminal outcome so the next click is fresh.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.resetModules();
  const ls = makeMemoryStorage();
  vi.stubGlobal("window", { localStorage: ls, sessionStorage: makeMemoryStorage() });
  vi.stubGlobal("crypto", { randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}` });
});

describe("getOrCreateIdempotencyKey — reload/second-tab persistence", () => {
  it("the SAME scope key returns the SAME idempotency key on a second read (simulates a reload)", async () => {
    const { getOrCreateIdempotencyKey } = await import("../client/src/lib/vq-idempotency");
    const a = getOrCreateIdempotencyKey("character:GNV-F01-S1:master_portrait:nano_banana");
    const b = getOrCreateIdempotencyKey("character:GNV-F01-S1:master_portrait:nano_banana"); // "second tab" / reload re-read
    expect(a).toBe(b);
  });

  it("a DIFFERENT scope key (different character/type/model) gets a DIFFERENT key", async () => {
    const { getOrCreateIdempotencyKey } = await import("../client/src/lib/vq-idempotency");
    const a = getOrCreateIdempotencyKey("character:GNV-F01-S1:master_portrait:nano_banana");
    const b = getOrCreateIdempotencyKey("character:GNV-F02-S1:master_portrait:nano_banana");
    expect(a).not.toBe(b);
  });

  it("clearIdempotencyKey makes the NEXT read mint a fresh key (deliberate retry/new roll)", async () => {
    const { getOrCreateIdempotencyKey, clearIdempotencyKey } = await import("../client/src/lib/vq-idempotency");
    const scope = "card:GNV-001:main:main:default";
    const a = getOrCreateIdempotencyKey(scope);
    clearIdempotencyKey(scope); // simulates: terminal response received
    const b = getOrCreateIdempotencyKey(scope); // simulates: user clicks again, deliberately
    expect(a).not.toBe(b);
  });

  it("without clearing, the key is stable even across repeated calls (still-pending reuse)", async () => {
    const { getOrCreateIdempotencyKey } = await import("../client/src/lib/vq-idempotency");
    const scope = "family:GNV-F03:nano_banana";
    const keys = Array.from({ length: 5 }, () => getOrCreateIdempotencyKey(scope));
    expect(new Set(keys).size).toBe(1);
  });

  it("degrades to a fresh in-memory key (no throw) when window/storage is unavailable", async () => {
    vi.stubGlobal("window", undefined);
    const { getOrCreateIdempotencyKey } = await import("../client/src/lib/vq-idempotency");
    expect(() => getOrCreateIdempotencyKey("character:X:Y:Z")).not.toThrow();
    expect(typeof getOrCreateIdempotencyKey("character:X:Y:Z")).toBe("string");
  });
});
