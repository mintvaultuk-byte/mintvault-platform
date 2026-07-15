import { VQ_IMAGE_MODELS, VQ_QUALITY_MODEL, vqCreditsPerImage, type VqImageModel } from "./vq-schema";
import type { VqPolicyGenerationType } from "./vq-model-policy";

export type VqAiProviderId = "higgsfield" | "openai_gpt_image" | "flux" | "ideogram";
export type VqProviderSelection = VqAiProviderId;
export type VqGenerateWith = "auto" | VqImageModel;

export interface VqProviderModel {
  id: VqGenerateWith;
  label: string;
  creditsPerImage: number | null;
  available: boolean;
  isAuto?: boolean;
  providerModel?: VqImageModel;
}

export interface VqProviderDescriptor {
  id: VqAiProviderId;
  label: string;
  recommended?: boolean;
  available: boolean;
  comingSoon?: boolean;
  expectedCreditSource: string;
  models: VqProviderModel[];
}

export const VQ_DEFAULT_PROVIDER: VqAiProviderId = "higgsfield";
export const VQ_PROVIDER_CONFIG_KEY = "provider.ai.selected";

const autoModel: VqProviderModel = {
  id: "auto",
  label: "Auto",
  creditsPerImage: null,
  available: true,
  isAuto: true,
};

export const VQ_PROVIDER_CATALOG: readonly VqProviderDescriptor[] = [
  {
    id: "higgsfield",
    label: "Higgsfield",
    recommended: true,
    available: true,
    expectedCreditSource: "Founder Higgsfield Pro subscription credits",
    models: [
      autoModel,
      ...VQ_IMAGE_MODELS.map((m) => ({
        id: m.value,
        providerModel: m.value,
        label: m.label,
        creditsPerImage: m.creditsPerImage,
        available: true,
      })),
    ],
  },
  {
    id: "openai_gpt_image",
    label: "OpenAI GPT Image",
    available: false,
    comingSoon: true,
    expectedCreditSource: "Unavailable until a provider adapter is implemented",
    models: [{ id: "auto", label: "Auto", creditsPerImage: null, available: false, isAuto: true }],
  },
  {
    id: "flux",
    label: "Flux",
    available: false,
    comingSoon: true,
    expectedCreditSource: "Unavailable until a provider adapter is implemented",
    models: [{ id: "auto", label: "Auto", creditsPerImage: null, available: false, isAuto: true }],
  },
  {
    id: "ideogram",
    label: "Ideogram",
    available: false,
    comingSoon: true,
    expectedCreditSource: "Unavailable until a provider adapter is implemented",
    models: [{ id: "auto", label: "Auto", creditsPerImage: null, available: false, isAuto: true }],
  },
] as const;

export function isVqAiProviderId(value: string | undefined | null): value is VqAiProviderId {
  return VQ_PROVIDER_CATALOG.some((p) => p.id === value);
}

export function getVqProvider(id: VqAiProviderId): VqProviderDescriptor {
  return VQ_PROVIDER_CATALOG.find((p) => p.id === id) ?? VQ_PROVIDER_CATALOG[0];
}

export function resolveStoredProviderSelection(value: string | undefined | null): VqAiProviderId {
  if (!isVqAiProviderId(value)) return VQ_DEFAULT_PROVIDER;
  const provider = getVqProvider(value);
  return provider.available ? provider.id : VQ_DEFAULT_PROVIDER;
}

export function canSelectVqProvider(id: VqAiProviderId): boolean {
  return getVqProvider(id).available;
}

export function resolveGenerateWith(selection: VqGenerateWith, generationType: Exclude<VqPolicyGenerationType, "replacement">): VqImageModel {
  if (selection === "auto") return VQ_AUTO_MODEL_POLICY[generationType];
  return selection;
}

export function requestModelForGenerateWith(selection: VqGenerateWith): VqImageModel | undefined {
  return selection === "auto" ? undefined : selection;
}

export function resetGenerateWithAfterAttempt(): VqGenerateWith {
  return "auto";
}

export function estimatedCreditsForGenerateWith(selection: VqGenerateWith, generationType: Exclude<VqPolicyGenerationType, "replacement">): number {
  return vqCreditsPerImage(resolveGenerateWith(selection, generationType));
}

export const VQ_AUTO_MODEL_POLICY: Record<Exclude<VqPolicyGenerationType, "replacement">, VqImageModel> = {
  master_portrait: VQ_QUALITY_MODEL.draft,
  action_pose: VQ_QUALITY_MODEL.draft,
  face_closeup: VQ_QUALITY_MODEL.draft,
  turnaround_sheet: VQ_QUALITY_MODEL.draft,
  colour_sheet: VQ_QUALITY_MODEL.draft,
  card_artwork: VQ_QUALITY_MODEL.draft,
};
