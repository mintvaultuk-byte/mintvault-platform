/**
 * Vault Quest — server-authoritative generation-type → model-tier policy
 * (spend-guard Phase 3A, item 3). Pure, no I/O. Reuses the EXISTING model catalogue
 * (VQ_IMAGE_MODELS) and quality tiers (VQ_QUALITY_MODEL) from vq-schema.ts — no new
 * model identifiers are invented here.
 *
 * Real, currently configured models (verified in vq-schema.ts, not invented):
 *   z_image          — "Cheap / Fast"     — 0.15 credits/image — NOT ref-capable
 *   nano_banana      — "Nano Banana"      — 1 credit/image     — ref-capable
 *   nano_banana_pro  — "Nano Banana Pro"  — 2 credits/image    — ref-capable
 *
 * Default tier per generation type (founder decision, this task):
 *   face_closeup, turnaround_sheet, colour_sheet, action_pose → "draft" (z_image;
 *     auto-upgrades to nano_banana when an identity reference is attached — the
 *     EXISTING effectiveCreditsPerImage upgrade path, unchanged here).
 *   master_portrait, card_artwork → "draft" also, by explicit founder instruction
 *     ("low-cost draft tier by default") — premium (nano_banana_pro) is NEVER
 *     selected automatically for any type.
 *   replacement → inherits whatever tier the underlying requested type maps to.
 *
 * Premium (nano_banana_pro) is only ever reachable via an EXPLICIT, confirmed
 * override — see resolveRequestedModel below.
 */
import { VQ_IMAGE_MODELS, VQ_QUALITY_MODEL, vqValidImageModel, type VqImageModel } from "./vq-schema";

export type VqPolicyGenerationType =
  | "master_portrait"
  | "action_pose"
  | "face_closeup"
  | "turnaround_sheet"
  | "colour_sheet"
  | "card_artwork"
  | "replacement";

/** Every generation type defaults to the cheapest ("draft") tier — premium is
 *  NEVER the default for anything. `replacement` is resolved by the CALLER against
 *  whichever underlying type it's replacing (this map has no entry for it). */
export const VQ_DEFAULT_MODEL_TIER: Record<Exclude<VqPolicyGenerationType, "replacement">, keyof typeof VQ_QUALITY_MODEL> = {
  master_portrait: "draft",
  action_pose: "draft",
  face_closeup: "draft",
  turnaround_sheet: "draft",
  colour_sheet: "draft",
  card_artwork: "draft",
};

export function defaultModelFor(generationType: Exclude<VqPolicyGenerationType, "replacement">): VqImageModel {
  return VQ_QUALITY_MODEL[VQ_DEFAULT_MODEL_TIER[generationType]];
}

export interface PremiumOverrideRequest {
  /** Must be an actually-supported model (checked against VQ_IMAGE_MODELS). */
  model?: string;
  /** Explicit confirmation marker — a checkbox/confirm click, never implied. */
  confirmed?: boolean;
  /** A non-empty founder-supplied reason for choosing the expensive tier. */
  reason?: string;
}

export interface ResolvedModelDecision {
  ok: boolean;
  model?: VqImageModel;
  isPremium: boolean;
  error?: string;
}

/**
 * Resolve the model to actually use for a generation request.
 *  - No model requested → the type's default (draft) tier. Never premium.
 *  - A model requested that ISN'T in VQ_IMAGE_MODELS → rejected (ok:false) BEFORE
 *    any provider contact — no silent fallback, no guessing.
 *  - A requested model that IS supported but is the premium tier
 *    (nano_banana_pro) → requires an explicit PremiumOverrideRequest with
 *    confirmed===true and a non-empty reason; otherwise rejected.
 *  - A requested model that is supported and NOT premium (z_image/nano_banana) →
 *    always allowed, no override needed (only the MOST expensive tier is gated).
 */
export function resolveRequestedModel(
  generationType: Exclude<VqPolicyGenerationType, "replacement">,
  requestedModel: string | undefined,
  premium?: PremiumOverrideRequest,
): ResolvedModelDecision {
  if (!requestedModel) {
    return { ok: true, model: defaultModelFor(generationType), isPremium: false };
  }
  const valid = vqValidImageModel(requestedModel);
  if (!valid) {
    return {
      ok: false,
      isPremium: false,
      error: `"${requestedModel}" is not a supported model. Supported models: ${VQ_IMAGE_MODELS.map((m) => m.value).join(", ")}.`,
    };
  }
  const isPremium = valid === VQ_QUALITY_MODEL.premium;
  if (!isPremium) {
    return { ok: true, model: valid, isPremium: false };
  }
  // Premium requires an explicit, confirmed, reasoned override — never implicit.
  if (!premium?.confirmed) {
    return { ok: false, isPremium: true, error: "Premium Final quality requires explicit confirmation before generating." };
  }
  if (!premium.reason || !premium.reason.trim()) {
    return { ok: false, isPremium: true, error: "Premium Final quality requires a reason." };
  }
  if (premium.model && premium.model !== valid) {
    return { ok: false, isPremium: true, error: "Premium override model mismatch." };
  }
  return { ok: true, model: valid, isPremium: true };
}
