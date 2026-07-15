/**
 * Read-only operational status for Vault Quest admin tooling (Phase 10A-5).
 * Composes ALREADY-BUILT subsystems (feature flags, provider status, spend
 * ceilings/windows, export job counts) into one bounded-aggregate snapshot.
 * Never mutates anything, never calls a paid provider, never dumps unbounded
 * rows — every number here is either a fixed-size config read or a GROUP BY
 * count. Per-machine numbers are explicitly labeled as such (P10-R4-F8).
 */
import { AUTO_RETRY_FEATURE, VQ_GENERATION_TYPE_FEATURES, vqFeatureState, type VqFeature, type VqFeatureState } from "./vq-feature-state";
import { loadVqDbFlags } from "./vq-feature-flags-store";
import { getSpendSnapshot } from "./generation-guard";
import { getExportJobCounts, type ExportJobCounts } from "../export-jobs";
import { providerStatuses, type ProviderStatus } from "../ai/provider";
import { getHiggsfieldProviderConnection, type VqProviderConnectionSnapshot } from "./vq-provider-connection";

export interface VqFeatureStatusEntry extends VqFeatureState {
  feature: VqFeature;
}

export interface VqOpsStatus {
  machineId: string; // labels every per-machine-only field below
  features: VqFeatureStatusEntry[];
  providers: ProviderStatus[];
  provider: VqProviderConnectionSnapshot;
  spend: {
    ceilings: Awaited<ReturnType<typeof getSpendSnapshot>>["ceilings"];
    requestsThisHour: number;
    creditsThisDay: number;
  };
  exports: ExportJobCounts;
  generatedAt: string;
}

const FEATURES: VqFeature[] = ["generation", "exports", "writes", ...VQ_GENERATION_TYPE_FEATURES, AUTO_RETRY_FEATURE];

function envSnapshot() {
  return {
    VQ_GENERATION_DISABLED: process.env.VQ_GENERATION_DISABLED,
    VQ_EXPORTS_DISABLED: process.env.VQ_EXPORTS_DISABLED,
    VQ_READONLY: process.env.VQ_READONLY,
    VQ_PROVIDER_OUTAGE: process.env.VQ_PROVIDER_OUTAGE,
  };
}

export async function getVqOpsStatus(nowMs: number): Promise<VqOpsStatus> {
  const [dbFlags, spend, exports, providers, provider] = await Promise.all([
    loadVqDbFlags(),
    getSpendSnapshot(nowMs),
    getExportJobCounts(),
    providerStatuses(),
    getHiggsfieldProviderConnection(nowMs),
  ]);
  const env = envSnapshot();
  const features = FEATURES.map((feature) => ({ feature, ...vqFeatureState(feature, env, dbFlags) }));
  return {
    machineId: process.env.FLY_MACHINE_ID || "local",
    features,
    providers,
    provider,
    spend,
    exports,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
