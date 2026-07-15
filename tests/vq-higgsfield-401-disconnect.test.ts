import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, string>();

vi.mock("../server/db", () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: () => (fields && "key" in fields
        ? { where: async () => [...rows.entries()].map(([key, value]) => ({ key, value })) }
        : Promise.resolve([])),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => rows.set(String(value.key), String(value.value)),
      }),
    }),
  },
  pool: { end: () => Promise.resolve() },
}));

describe("Higgsfield 401 auto-disconnect", () => {
  beforeEach(() => {
    rows.clear();
    process.env.HIGGSFIELD_API_KEY = "test-token";
    process.env.HIGGSFIELD_WORKSPACE_ID = "workspace-test";
    process.env.HIGGSFIELD_API_BASE = "https://example.invalid/fnf";
    delete process.env.HIGGSFIELD_TOKEN_EXPIRES_AT;
  });

  it("marks shared provider state token_expired and does not retry create", async () => {
    const fetchSpy = vi.fn(async () => new Response("auth failed", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { generateHiggsfieldArtwork } = await import("../server/vault-quest/ai/higgsfield");
    const { getHiggsfieldProviderConnection } = await import("../server/vault-quest/lib/vq-provider-connection");

    await expect(generateHiggsfieldArtwork({ prompt: "safe prompt", mode: "main", slot: "main", model: "nano_banana" })).rejects.toThrow(/rejected the token/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const snapshot = await getHiggsfieldProviderConnection(Date.now());
    expect(snapshot.status).toBe("token_expired");
    expect(snapshot.generationAllowed).toBe(false);
    expect(snapshot.lastAuthFailureAt).toBeTruthy();
    expect([...rows.values()].some((value) => value.includes("test-token"))).toBe(false);
  });
});
