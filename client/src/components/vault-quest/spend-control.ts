import { VQ_IMAGE_MODELS, VQ_QUALITY_MODEL, vqCreditsPerImage, type VqImageModel } from "@shared/vq-schema";

export type FounderFeatureKey =
  | "generation"
  | "gen_master_portrait"
  | "gen_action_pose"
  | "gen_face_closeup"
  | "gen_turnaround_sheet"
  | "gen_colour_sheet"
  | "gen_card_artwork"
  | "gen_replacement"
  | "auto_paid_retry";

export type FounderFeatureStatus = {
  feature: string;
  enabled: boolean;
  source?: string;
  reason?: string;
};

export type ProviderConnectionStatus =
  | "connected"
  | "token_expiring"
  | "token_expired"
  | "not_configured"
  | "disconnected"
  | "unknown"
  | "checking";

export type ProviderConnection = {
  status: ProviderConnectionStatus;
  generationAllowed: boolean;
  providerPathLabel?: string;
  connectionMode?: string;
  remoteVerified?: boolean;
  tokenExpiryAt?: string | null;
  warningLevel?: "none" | "under_24h" | "under_1h" | "expired" | "unavailable";
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  lastAuthFailureAt?: string | null;
  message?: string;
  reconnectRequired?: boolean;
};

export const FOUNDER_GENERATION_CONTROLS: readonly { feature: FounderFeatureKey; label: string; offLabel: string; onLabel: string; warning?: string }[] = [
  { feature: "generation", label: "AI Generation", offLabel: "Locked", onLabel: "Enabled" },
  { feature: "gen_master_portrait", label: "Master artwork", offLabel: "Off", onLabel: "On" },
  { feature: "gen_action_pose", label: "Action references", offLabel: "Off", onLabel: "On" },
  { feature: "gen_face_closeup", label: "Face close-ups", offLabel: "Off", onLabel: "On" },
  { feature: "gen_turnaround_sheet", label: "Turnaround sheets", offLabel: "Off", onLabel: "On" },
  { feature: "gen_colour_sheet", label: "Colour sheets", offLabel: "Off", onLabel: "On" },
  { feature: "gen_card_artwork", label: "Card artwork", offLabel: "Off", onLabel: "On" },
  { feature: "gen_replacement", label: "Replacement generation", offLabel: "Off", onLabel: "On" },
  { feature: "auto_paid_retry", label: "Automatic paid retry", offLabel: "Off", onLabel: "On", warning: "May spend credits on a second provider call." },
];

export type FounderFeatureMap = Record<FounderFeatureKey, boolean>;

export const FEATURE_FOR_REFERENCE_TYPE: Record<string, FounderFeatureKey> = {
  master_portrait: "gen_master_portrait",
  action_pose: "gen_action_pose",
  face_closeup: "gen_face_closeup",
  turnaround_sheet: "gen_turnaround_sheet",
  colour_sheet: "gen_colour_sheet",
};

export function resolveFounderFeatureMap(features: FounderFeatureStatus[] | undefined, statusLoaded = true): FounderFeatureMap {
  const byFeature = new Map((features ?? []).map((entry) => [entry.feature, entry.enabled]));
  const resolved = Object.fromEntries(
    FOUNDER_GENERATION_CONTROLS.map((control) => {
      if (!statusLoaded) return [control.feature, false];
      if (control.feature === "generation") return [control.feature, byFeature.get(control.feature) === true];
      return [control.feature, byFeature.get(control.feature) === true];
    }),
  ) as FounderFeatureMap;
  return resolved;
}

export function generationBlockedReason(flags: FounderFeatureMap, feature: FounderFeatureKey): string | null {
  if (!flags.generation) return "AI Generation is Locked.";
  if (!flags[feature]) return `${FOUNDER_GENERATION_CONTROLS.find((c) => c.feature === feature)?.label ?? "This generation type"} is Off.`;
  return null;
}

export function providerGenerationBlockedReason(provider: ProviderConnection | null | undefined, statusLoaded = true): string | null {
  if (!statusLoaded || !provider) return "Reconnect provider first";
  return provider.generationAllowed && (provider.status === "connected" || provider.status === "token_expiring") ? null : "Reconnect provider first";
}

export function generationBlockedReasonWithProvider(
  flags: FounderFeatureMap,
  feature: FounderFeatureKey,
  provider: ProviderConnection | null | undefined,
  statusLoaded = true,
): string | null {
  return generationBlockedReason(flags, feature) ?? providerGenerationBlockedReason(provider, statusLoaded);
}

export function featureForReferenceType(referenceType: string): FounderFeatureKey {
  return FEATURE_FOR_REFERENCE_TYPE[referenceType] ?? "gen_replacement";
}

export function canSubmitGeneration(flags: FounderFeatureMap, feature: FounderFeatureKey): boolean {
  return generationBlockedReason(flags, feature) === null;
}

export function expectedResolvedModel(model: VqImageModel, hasReferences: boolean): VqImageModel {
  const meta = VQ_IMAGE_MODELS.find((m) => m.value === model);
  if (hasReferences && meta && !meta.refCapable) return VQ_QUALITY_MODEL.standard;
  return model;
}

export function batchMaximumCredits(images: number, model: VqImageModel, autoPaidRetryEnabled: boolean): number {
  const callsPerImage = autoPaidRetryEnabled ? 2 : 1;
  return Math.ceil(images * vqCreditsPerImage(model) * callsPerImage);
}

export function batchConfirmationButtonText(images: number, maxCredits: number): string {
  return `Generate ${images} image${images === 1 ? "" : "s"} — maximum ${maxCredits} credit${maxCredits === 1 ? "" : "s"}`;
}

export function isPremiumModel(model: VqImageModel): boolean {
  return model === VQ_QUALITY_MODEL.premium;
}
