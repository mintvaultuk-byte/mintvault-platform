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
  /** Explicit confirmation marker — a checkbox/confirm click, never implied. Must
   *  apply to THIS prepared payload only — a caller must never persist/reuse a
   *  previous request's confirmation across a new one (each server call gets a
   *  fresh, independent PremiumOverrideRequest — this module holds no state). */
  confirmed?: boolean;
  /** A non-empty, non-whitespace founder-supplied reason for choosing the
   *  expensive tier. Trimmed and length-capped below. */
  reason?: string;
}

/** Reasonable cap so a founder-typed reason can't become an unbounded blob in
 *  the audit trail — long enough for a real sentence, short enough to stay a
 *  reason rather than an essay. */
export const MAX_PREMIUM_REASON_LENGTH = 300;

export interface ResolvedModelDecision {
  ok: boolean;
  model?: VqImageModel;
  isPremium: boolean;
  /** The trimmed reason, only present when a premium override was accepted. */
  premiumReason?: string;
  error?: string;
}

/**
 * Resolve the model to actually use for a generation request.
 *  - No model requested → the type's default (draft) tier, UPGRADED to the
 *    cheapest reference-capable model (nano_banana) when `hasReferences` is true
 *    and the default tier's model can't support references (mirrors the
 *    EXISTING effectiveCreditsPerImage upgrade path — never invents a new one).
 *    Never premium.
 *  - A model requested that ISN'T in VQ_IMAGE_MODELS → rejected (ok:false) BEFORE
 *    any provider contact — no silent fallback, no guessing.
 *  - A requested model that IS supported, is NOT ref-capable, and `hasReferences`
 *    is true → silently resolved UP to nano_banana (same upgrade rule as above;
 *    a caller asking for the cheap model when references are required gets the
 *    cheapest model that can actually do the job, not a rejection).
 *  - A requested model that IS supported but is the premium tier
 *    (nano_banana_pro) → requires an explicit PremiumOverrideRequest with
 *    confirmed===true and a non-empty (post-trim), not-overlong reason;
 *    otherwise rejected. This check ALWAYS applies to premium regardless of
 *    hasReferences (premium is always ref-capable already).
 *  - A requested model that is supported and NOT premium (z_image/nano_banana),
 *    once past the reference-capability upgrade above → always allowed, no
 *    override needed (only the MOST expensive tier is gated).
 */
export function resolveRequestedModel(
  generationType: Exclude<VqPolicyGenerationType, "replacement">,
  requestedModel: string | undefined,
  opts?: { hasReferences?: boolean; premium?: PremiumOverrideRequest },
): ResolvedModelDecision {
  const hasReferences = opts?.hasReferences ?? false;
  const premium = opts?.premium;

  const upgradeIfNeeded = (model: VqImageModel): VqImageModel => {
    if (hasReferences && !VQ_IMAGE_MODELS.find((m) => m.value === model)?.refCapable) {
      return VQ_QUALITY_MODEL.standard; // nano_banana — cheapest ref-capable model
    }
    return model;
  };

  if (!requestedModel) {
    return { ok: true, model: upgradeIfNeeded(defaultModelFor(generationType)), isPremium: false };
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
    return { ok: true, model: upgradeIfNeeded(valid), isPremium: false };
  }
  // Premium requires an explicit, confirmed, reasoned override — never implicit,
  // and never inherited from a previous request (the caller passes a fresh
  // `opts.premium` per call; this function is pure and stateless).
  if (!premium?.confirmed) {
    return { ok: false, isPremium: true, error: "Premium Final quality requires explicit confirmation before generating." };
  }
  const trimmedReason = (premium.reason ?? "").trim();
  if (!trimmedReason) {
    return { ok: false, isPremium: true, error: "Premium Final quality requires a reason." };
  }
  if (trimmedReason.length > MAX_PREMIUM_REASON_LENGTH) {
    return { ok: false, isPremium: true, error: `Premium reason is too long (max ${MAX_PREMIUM_REASON_LENGTH} characters).` };
  }
  if (premium.model && premium.model !== valid) {
    return { ok: false, isPremium: true, error: "Premium override model mismatch." };
  }
  return { ok: true, model: valid, isPremium: true, premiumReason: trimmedReason };
}
