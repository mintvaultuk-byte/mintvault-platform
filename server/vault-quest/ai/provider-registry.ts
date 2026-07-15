import { inArray } from "drizzle-orm";
import { vqConfig } from "@shared/vq-config-schema";
import {
  canSelectVqProvider,
  getVqProvider,
  resolveStoredProviderSelection,
  VQ_DEFAULT_PROVIDER,
  VQ_PROVIDER_CATALOG,
  VQ_PROVIDER_CONFIG_KEY,
  type VqAiProviderId,
} from "@shared/vq-ai-provider";
import { isUndefinedTableOrColumn } from "../production-storage";
import { getHiggsfieldProviderConnection } from "../lib/vq-provider-connection";

export interface VqProviderRegistryView {
  currentProvider: VqAiProviderId;
  defaultProvider: VqAiProviderId;
  availableProviders: typeof VQ_PROVIDER_CATALOG;
  current: ReturnType<typeof getVqProvider>;
  selectedFromDb: boolean;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUndefinedTableOrColumn(err)) return fallback;
    throw err;
  }
}

async function readProviderSelection(): Promise<{ selected: VqAiProviderId; selectedFromDb: boolean }> {
  const rows = await safe(async () => {
    const { db } = await import("../../db");
    return db.select({ key: vqConfig.key, value: vqConfig.value }).from(vqConfig).where(inArray(vqConfig.key, [VQ_PROVIDER_CONFIG_KEY]));
  }, [] as { key: string; value: string }[]);
  const raw = rows.find((r) => r.key === VQ_PROVIDER_CONFIG_KEY)?.value;
  return { selected: resolveStoredProviderSelection(raw), selectedFromDb: !!raw };
}

export async function getProviderRegistryView(): Promise<VqProviderRegistryView> {
  const selection = await readProviderSelection();
  return {
    currentProvider: selection.selected,
    defaultProvider: VQ_DEFAULT_PROVIDER,
    availableProviders: VQ_PROVIDER_CATALOG,
    current: getVqProvider(selection.selected),
    selectedFromDb: selection.selectedFromDb,
  };
}

export async function selectVqProvider(provider: VqAiProviderId, updatedBy: string): Promise<VqProviderRegistryView> {
  if (!canSelectVqProvider(provider)) {
    throw new Error("Provider is unavailable and cannot be selected.");
  }
  await safe(async () => {
    const { db } = await import("../../db");
    await db.insert(vqConfig).values({
      key: VQ_PROVIDER_CONFIG_KEY,
      value: provider,
      description: "Vault Quest selected AI artwork provider (no secrets)",
      updatedBy,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: vqConfig.key,
      set: {
        value: provider,
        description: "Vault Quest selected AI artwork provider (no secrets)",
        updatedBy,
        updatedAt: new Date(),
      },
    });
  }, undefined);
  return getProviderRegistryView();
}

export async function getCurrentArtworkProviderOrThrow(): Promise<"higgsfield"> {
  const registry = await getProviderRegistryView();
  if (registry.currentProvider !== "higgsfield") {
    throw new Error("Selected provider is not available for generation.");
  }
  return "higgsfield";
}

export async function getProviderPanelStatus(nowMs = Date.now()) {
  const [registry, higgsfield] = await Promise.all([
    getProviderRegistryView(),
    getHiggsfieldProviderConnection(nowMs),
  ]);
  return {
    ...registry,
    status: higgsfield,
    creditBalance: null,
    creditBalanceLabel: "Unavailable",
  };
}
