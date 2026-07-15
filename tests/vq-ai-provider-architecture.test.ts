import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canSelectVqProvider,
  estimatedCreditsForGenerateWith,
  requestModelForGenerateWith,
  resetGenerateWithAfterAttempt,
  resolveGenerateWith,
  resolveStoredProviderSelection,
  VQ_DEFAULT_PROVIDER,
  VQ_PROVIDER_CATALOG,
  VQ_PROVIDER_CONFIG_KEY,
} from "../shared/vq-ai-provider";

const rows = new Map<string, string>();
const writes: Record<string, string>[] = [];
const providerProbe = vi.hoisted(() => vi.fn(async () => ({
  id: "higgsfield",
  label: "Higgsfield Provider",
  status: "configured",
  generationAllowed: false,
  connectionMode: "higgsfield_oauth_legacy",
  providerPath: "higgsfield_oauth_legacy",
  providerPathLabel: "Higgsfield OAuth / Legacy",
  remoteVerified: false,
  tokenExpiryAt: null,
  warningLevel: "unavailable",
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastAuthFailureAt: null,
  message: "Credentials configured — remote connection not yet verified.",
  reconnectRequired: true,
})));

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

vi.mock("../server/vault-quest/lib/vq-provider-connection", () => ({
  getHiggsfieldProviderConnection: providerProbe,
}));

describe("Vault Quest AI provider architecture", () => {
  beforeEach(() => {
    rows.clear();
    writes.length = 0;
    providerProbe.mockClear();
  });

  it("defaults to Higgsfield and keeps future providers unavailable", () => {
    expect(VQ_DEFAULT_PROVIDER).toBe("higgsfield");
    expect(canSelectVqProvider("higgsfield")).toBe(true);
    expect(canSelectVqProvider("openai_gpt_image")).toBe(false);
    expect(canSelectVqProvider("flux")).toBe(false);
    expect(canSelectVqProvider("ideogram")).toBe(false);
    expect(VQ_PROVIDER_CATALOG.find((p) => p.id === "higgsfield")?.expectedCreditSource).toMatch(/Pro subscription/i);
  });

  it("invalid or unavailable stored provider selections resolve back to Higgsfield", () => {
    expect(resolveStoredProviderSelection(null)).toBe("higgsfield");
    expect(resolveStoredProviderSelection("cloud_api")).toBe("higgsfield");
    expect(resolveStoredProviderSelection("openai_gpt_image")).toBe("higgsfield");
  });

  it("Auto resolves through the current safe model policy and sends no model override", () => {
    expect(resolveGenerateWith("auto", "master_portrait")).toBe("z_image");
    expect(resolveGenerateWith("auto", "action_pose")).toBe("z_image");
    expect(requestModelForGenerateWith("auto")).toBeUndefined();
    expect(requestModelForGenerateWith("nano_banana")).toBe("nano_banana");
    expect(estimatedCreditsForGenerateWith("auto", "card_artwork")).toBe(0.15);
  });

  it("one-time model override resets to Auto after an attempt", () => {
    expect(resetGenerateWithAfterAttempt()).toBe("auto");
  });

  it("registry reads default provider from shared config without probing the provider", async () => {
    const { getProviderRegistryView } = await import("../server/vault-quest/ai/provider-registry");
    const view = await getProviderRegistryView();
    expect(view.currentProvider).toBe("higgsfield");
    expect(view.selectedFromDb).toBe(false);
    expect(providerProbe).not.toHaveBeenCalled();
  });

  it("provider selection is centralized in vq_config and rejects unavailable providers", async () => {
    const { selectVqProvider } = await import("../server/vault-quest/ai/provider-registry");
    await expect(selectVqProvider("openai_gpt_image", "owner@test")).rejects.toThrow(/unavailable/i);
    expect(rows.has(VQ_PROVIDER_CONFIG_KEY)).toBe(false);
    await selectVqProvider("higgsfield", "owner@test");
    expect(rows.get(VQ_PROVIDER_CONFIG_KEY)).toBe("higgsfield");
    expect(writes[0].value).toBe("higgsfield");
    expect(providerProbe).not.toHaveBeenCalled();
  });

  it("provider panel reports unavailable credit balance and fails closed when unhealthy", async () => {
    const { getProviderPanelStatus } = await import("../server/vault-quest/ai/provider-registry");
    const status = await getProviderPanelStatus();
    expect(status.currentProvider).toBe("higgsfield");
    expect(status.creditBalance).toBeNull();
    expect(status.creditBalanceLabel).toBe("Unavailable");
    expect(status.status.generationAllowed).toBe(false);
    expect(status.status.remoteVerified).toBe(false);
    expect(providerProbe).toHaveBeenCalledTimes(1);
  });
});
