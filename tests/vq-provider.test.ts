/**
 * Phase 10A-3 — imageProviders() honesty test: the Higgsfield entry's `connected`
 * boolean and `status` must be derived from a REAL observed outcome, not from the
 * env var being merely present. higgsfield.ts is mocked (no real network); the
 * observation store (provider-status.ts) is exercised for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetHiggsfieldOutcomeForTests } from "../server/vault-quest/ai/provider-status";

const connectedRef = { value: true };
let providerRows: { key: string; value: string }[] = [];
vi.mock("../server/vault-quest/ai/higgsfield", () => ({
  higgsfieldConnection: () => ({ connected: connectedRef.value, note: "", model: "nano_banana", baseUrl: "https://x" }),
}));
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: vi.fn() }));
// checkVqFeature("generation") reads server/db — stub to a no-DB-flags-set, no-error
// shape so these pre-existing tests aren't about the 10A-4 owner switch (that's
// covered by its own test file) and keep asserting purely on connection+outcome.
vi.mock("../server/db", () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: () => (fields && "key" in fields ? { where: async () => providerRows } : Promise.resolve([])),
    }),
  },
  pool: { end: () => Promise.resolve() },
}));

beforeEach(() => {
  __resetHiggsfieldOutcomeForTests();
  providerRows = [];
  connectedRef.value = true;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("imageProviders — shared Higgsfield status", () => {
  it("key present, no remote success → configured:false with local-only provider detail", async () => {
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("provider_unavailable");
    expect(h?.providerStatus).toBe("configured");
    expect(h?.connected).toBe(false);
    expect(h?.remoteVerified).toBe(false);
    expect(h?.note).toMatch(/remote connection not yet verified/i);
  });

  it("a real successful call → connected:true, status connected", async () => {
    providerRows = [
      { key: "provider.higgsfield.last_status", value: "connected" },
      { key: "provider.higgsfield.last_success_at", value: "2026-07-14T12:00:00.000Z" },
    ];
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("connected");
    expect(h?.connected).toBe(true);
  });

  it("no key at all → not_configured, connected:false", async () => {
    connectedRef.value = false;
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("not_configured");
    expect(h?.connected).toBe(false);
  });

  it("shared auth failure flips connected:false even though the env var is still set", async () => {
    vi.resetModules();
    vi.doMock("../server/db", () => ({
      db: {
        select: (fields?: Record<string, unknown>) => ({
          from: () => (fields && "key" in fields
            ? { where: async () => [{ key: "provider.higgsfield.last_status", value: "token_expired" }] }
            : Promise.resolve([])),
        }),
      },
      pool: { end: () => Promise.resolve() },
    }));
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("authentication_invalid");
    expect(h?.providerStatus).toBe("token_expired");
    expect(h?.connected).toBe(false);
  });
});
