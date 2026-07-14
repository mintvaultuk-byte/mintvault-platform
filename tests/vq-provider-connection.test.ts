import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, string>();
const writes: Record<string, string>[] = [];

vi.mock("../server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [...rows.entries()].map(([key, value]) => ({ key, value })),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, string>) => ({
        onConflictDoUpdate: async () => {
          rows.set(value.key, value.value);
          writes.push(value);
        },
      }),
    }),
  },
  pool: { end: () => Promise.resolve() },
}));

describe("Vault Quest provider connection state", () => {
  beforeEach(() => {
    rows.clear();
    writes.length = 0;
    process.env.HIGGSFIELD_API_KEY = "test-token";
    delete process.env.HIGGSFIELD_TOKEN_EXPIRES_AT;
    delete process.env.HIGGSFIELD_API_KEY_EXPIRES_AT;
  });

  it("reports not_configured when no server-side token is configured", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    const { getHiggsfieldProviderConnection } = await import("../server/vault-quest/lib/vq-provider-connection");
    const s = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(s.status).toBe("not_configured");
    expect(s.generationAllowed).toBe(false);
    expect(s.reconnectRequired).toBe(true);
  });

  it("healthy expiry is connected with no warning", async () => {
    process.env.HIGGSFIELD_TOKEN_EXPIRES_AT = "2026-07-16T12:00:00Z";
    const { getHiggsfieldProviderConnection } = await import("../server/vault-quest/lib/vq-provider-connection");
    const s = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(s.status).toBe("connected");
    expect(s.warningLevel).toBe("none");
    expect(s.tokenExpiryAt).toBe("2026-07-16T12:00:00.000Z");
  });

  it("under 24 hours and under 1 hour surface warning states", async () => {
    const { getHiggsfieldProviderConnection } = await import("../server/vault-quest/lib/vq-provider-connection");
    process.env.HIGGSFIELD_TOKEN_EXPIRES_AT = "2026-07-15T11:59:59Z";
    const under24 = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(under24.status).toBe("token_expiring");
    expect(under24.warningLevel).toBe("under_24h");
    process.env.HIGGSFIELD_TOKEN_EXPIRES_AT = "2026-07-14T12:59:59Z";
    const under1 = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(under1.status).toBe("token_expiring");
    expect(under1.warningLevel).toBe("under_1h");
  });

  it("expired, missing and malformed expiry are safe and explicit", async () => {
    const { getHiggsfieldProviderConnection } = await import("../server/vault-quest/lib/vq-provider-connection");
    process.env.HIGGSFIELD_TOKEN_EXPIRES_AT = "2026-07-14T12:00:00Z";
    const expired = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(expired.status).toBe("token_expired");
    expect(expired.generationAllowed).toBe(false);

    delete process.env.HIGGSFIELD_TOKEN_EXPIRES_AT;
    const missing = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(missing.status).toBe("connected");
    expect(missing.tokenExpiryAt).toBeNull();
    expect(missing.message).toMatch(/expiry is not available/i);

    process.env.HIGGSFIELD_TOKEN_EXPIRES_AT = "not-a-date";
    const malformed = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:00:00Z"));
    expect(malformed.status).toBe("connected");
    expect(malformed.tokenExpiryAt).toBeNull();
  });

  it("shared auth failure overrides local configuration and blocks generation", async () => {
    const { markHiggsfieldProviderAuthFailure, getHiggsfieldProviderConnection } = await import("../server/vault-quest/lib/vq-provider-connection");
    await markHiggsfieldProviderAuthFailure(Date.parse("2026-07-14T12:00:00Z"), "test-machine-a");
    const machineB = await getHiggsfieldProviderConnection(Date.parse("2026-07-14T12:01:00Z"));
    expect(machineB.status).toBe("token_expired");
    expect(machineB.lastAuthFailureAt).toBe("2026-07-14T12:00:00.000Z");
    expect(machineB.generationAllowed).toBe(false);
  });

  it("test connection is local-only, records last checked, and never verifies remote", async () => {
    const { refreshHiggsfieldProviderConnectionLocal } = await import("../server/vault-quest/lib/vq-provider-connection");
    const s = await refreshHiggsfieldProviderConnectionLocal("admin@example.test", Date.parse("2026-07-14T12:00:00Z"));
    expect(s.lastCheckedAt).toBe("2026-07-14T12:00:00.000Z");
    expect(s.remoteVerified).toBe(false);
    expect(s.message).toMatch(/free remote connection test is not available/i);
    expect(writes.some((w) => w.value.includes("test-token"))).toBe(false);
  });

  it("explicit local test connection can clear an auth lock without claiming remote verification", async () => {
    const { markHiggsfieldProviderAuthFailure, refreshHiggsfieldProviderConnectionLocal } = await import("../server/vault-quest/lib/vq-provider-connection");
    await markHiggsfieldProviderAuthFailure(Date.parse("2026-07-14T12:00:00Z"), "machine-a");
    process.env.HIGGSFIELD_TOKEN_EXPIRES_AT = "2026-07-15T12:00:00Z";
    const refreshed = await refreshHiggsfieldProviderConnectionLocal("admin@example.test", Date.parse("2026-07-14T12:05:00Z"));
    expect(refreshed.status).toBe("token_expiring");
    expect(refreshed.generationAllowed).toBe(true);
    expect(refreshed.remoteVerified).toBe(false);
    expect(refreshed.lastAuthFailureAt).toBe("2026-07-14T12:00:00.000Z");
  });
});
