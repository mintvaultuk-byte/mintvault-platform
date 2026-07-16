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
  | "configured"
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
  return provider.generationAllowed && provider.remoteVerified === true && (provider.status === "connected" || provider.status === "token_expiring") ? null : "Reconnect provider first";
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

// ── Founder one-click gate resolution ──────────────────────────────────────────
// The "Generate Action Pose" button used to be silently disabled whenever a
// per-type flag was still at its safe default-Off, or the provider had not yet
// had a (zero-cost) remote verification. Both are legitimate spend gates — they
// stay fully enforced server-side and are NOT weakened here. These pure helpers
// let the founder's SINGLE click resolve those gates through the sanctioned
// actions (enable the type they explicitly asked to generate; run the free
// provider verification) instead of hunting for two separate hidden panels.

/** The provider's connection state reduced to what the generate flow must do:
 *  ready (generate now), needs_verify (a free remote check may unblock it), or
 *  hard_blocked (a real reason a click cannot fix — expired/not-configured/etc.). */
export type ProviderReadiness = "ready" | "needs_verify" | "hard_blocked";

export function providerReadiness(provider: ProviderConnection | null | undefined, statusLoaded = true): ProviderReadiness {
  if (
    provider &&
    provider.generationAllowed &&
    provider.remoteVerified === true &&
    (provider.status === "connected" || provider.status === "token_expiring")
  ) {
    return "ready";
  }
  // Hard states cannot be cleared by a click — they need a server-side token/config fix.
  if (provider && (provider.status === "token_expired" || provider.status === "not_configured" || provider.status === "disconnected")) {
    return "hard_blocked";
  }
  // configured / unknown / checking / not-yet-loaded → a zero-cost verify can resolve it.
  void statusLoaded;
  return "needs_verify";
}

/** Founder-readable reason for a hard-blocked provider (never a dead end). */
export function providerHardBlockReason(provider: ProviderConnection | null | undefined): string {
  switch (provider?.status) {
    case "token_expired":
      return "AI provider token has expired — refresh the Higgsfield token on the server, then press Verify Connection.";
    case "not_configured":
      return "AI provider is not configured — the Higgsfield API key is missing on the server.";
    case "disconnected":
      return "AI provider is disconnected — press Verify Connection to retry.";
    default:
      return "Reconnect provider first";
  }
}

/** Per-feature disable *reason* map from the ops/status feature list. Lets the
 *  gate tell a deliberate owner Off (db_flag_off) from a type that has simply
 *  never been enabled (not_yet_enabled / no row). */
export type FounderFeatureReasons = Partial<Record<FounderFeatureKey, string>>;

export function resolveFounderFeatureReasons(features: FounderFeatureStatus[] | undefined): FounderFeatureReasons {
  const known = new Set<string>(FOUNDER_GENERATION_CONTROLS.map((c) => c.feature));
  const out: FounderFeatureReasons = {};
  for (const entry of features ?? []) {
    if (known.has(entry.feature) && entry.reason) out[entry.feature as FounderFeatureKey] = entry.reason;
  }
  return out;
}

/** What the Generate button must do next for one generation type. The handler
 *  runs this repeatedly against a FRESH server snapshot after each resolving
 *  action, until it reaches `generate` or `blocked`. */
export type GenerationGatePlan =
  | { kind: "generate" }
  | { kind: "enable_then_continue"; feature: FounderFeatureKey; label: string }
  | { kind: "verify_then_continue" }
  | { kind: "blocked"; reason: string };

export function planGenerationGate(
  flags: FounderFeatureMap,
  feature: FounderFeatureKey,
  featureReason: string | undefined,
  provider: ProviderConnection | null | undefined,
  statusLoaded = true,
): GenerationGatePlan {
  // 1) Master lock is a deliberate owner block — never auto-bypassed by a click.
  if (!flags.generation) return { kind: "blocked", reason: "AI Generation is Locked. Turn it back on in Founder Spend Controls." };
  // 2) Per-type flag. A deliberate owner Off (db_flag_off) is respected; a type
  //    that has simply never been enabled (default not_yet_enabled / no row) is
  //    enabled by the founder's explicit, confirmed click on this very button.
  if (!flags[feature]) {
    const label = FOUNDER_GENERATION_CONTROLS.find((c) => c.feature === feature)?.label ?? "This generation type";
    if (featureReason === "db_flag_off") return { kind: "blocked", reason: `${label} is turned Off in Founder Spend Controls.` };
    return { kind: "enable_then_continue", feature, label };
  }
  // 3) Provider — free verify if it might unblock, real reason if it cannot.
  const readiness = providerReadiness(provider, statusLoaded);
  if (readiness === "hard_blocked") return { kind: "blocked", reason: providerHardBlockReason(provider) };
  if (readiness === "needs_verify") return { kind: "verify_then_continue" };
  return { kind: "generate" };
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
