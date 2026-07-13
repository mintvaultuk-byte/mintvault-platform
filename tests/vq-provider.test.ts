/**
 * Phase 10A-3 — imageProviders() honesty test: the Higgsfield entry's `connected`
 * boolean and `status` must be derived from a REAL observed outcome, not from the
 * env var being merely present. higgsfield.ts is mocked (no real network); the
 * observation store (provider-status.ts) is exercised for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetHiggsfieldOutcomeForTests, recordHiggsfieldOutcome } from "../server/vault-quest/ai/provider-status";

const connectedRef = { value: true };
vi.mock("../server/vault-quest/ai/higgsfield", () => ({
  higgsfieldConnection: () => ({ connected: connectedRef.value, note: "", model: "nano_banana", baseUrl: "https://x" }),
}));
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: vi.fn() }));
// checkVqFeature("generation") reads server/db — stub to a no-DB-flags-set, no-error
// shape so these pre-existing tests aren't about the 10A-4 owner switch (that's
// covered by its own test file) and keep asserting purely on connection+outcome.
vi.mock("../server/db", () => ({ db: { select: () => ({ from: async () => [] }) }, pool: { end: () => Promise.resolve() } }));

beforeEach(() => {
  __resetHiggsfieldOutcomeForTests();
  connectedRef.value = true;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("imageProviders — honest Higgsfield status (Phase 10A-3)", () => {
  it("key present, no call yet → connected:true (not scary-red) but status is configured_unverified", async () => {
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("configured_unverified");
    expect(h?.connected).toBe(true); // fresh restart shouldn't flash red before any real call
    expect(h?.note).toMatch(/not yet verified/i);
  });

  it("a real successful call → connected:true, status connected", async () => {
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    recordHiggsfieldOutcome({ ok: true });
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("connected");
    expect(h?.connected).toBe(true);
  });

  it("THE BUG FIX: a real auth failure flips connected:false even though the env var is still set", async () => {
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    recordHiggsfieldOutcome({ ok: false, kind: "auth_expired" });
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("authentication_invalid");
    expect(h?.connected).toBe(false); // previously this stayed true forever — the fixed bug
    expect(h?.note).toMatch(/invalid or expired/i);
  });

  it("no key at all → not_configured, connected:false", async () => {
    connectedRef.value = false;
    const { imageProviders } = await import("../server/vault-quest/ai/provider");
    const h = (await imageProviders()).find((p) => p.id === "higgsfield");
    expect(h?.status).toBe("not_configured");
    expect(h?.connected).toBe(false);
  });
});
