import { describe, expect, it } from "vitest";
import {
  batchConfirmationButtonText,
  batchMaximumCredits,
  canSubmitGeneration,
  expectedResolvedModel,
  featureForReferenceType,
  generationBlockedReason,
  generationBlockedReasonWithProvider,
  providerGenerationBlockedReason,
  resolveFounderFeatureMap,
} from "../client/src/components/vault-quest/spend-control";

describe("founder spend-control client state", () => {
  it("loads server state and treats missing gen_* rows as Off", () => {
    const flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }]);
    expect(flags.generation).toBe(true);
    expect(flags.gen_master_portrait).toBe(false);
    expect(flags.gen_action_pose).toBe(false);
  });

  it("failed status loading resolves to unavailable, not visually enabled", () => {
    const flags = resolveFounderFeatureMap(undefined, false);
    expect(Object.values(flags).every((enabled) => enabled === false)).toBe(true);
  });

  it("global lock blocks all generation controls while prompt/view actions remain separate", () => {
    const flags = resolveFounderFeatureMap([{ feature: "generation", enabled: false }, { feature: "gen_action_pose", enabled: true }]);
    expect(canSubmitGeneration(flags, "gen_action_pose")).toBe(false);
    expect(generationBlockedReason(flags, "gen_action_pose")).toBe("AI Generation is Locked.");
  });

  it("a type-specific Off state disables only that generation action", () => {
    const flags = resolveFounderFeatureMap([
      { feature: "generation", enabled: true },
      { feature: "gen_master_portrait", enabled: true },
      { feature: "gen_action_pose", enabled: false },
    ]);
    expect(canSubmitGeneration(flags, "gen_master_portrait")).toBe(true);
    expect(canSubmitGeneration(flags, "gen_action_pose")).toBe(false);
    expect(featureForReferenceType("action_pose")).toBe("gen_action_pose");
  });

  it("provider status load failure fails closed with the reconnect reason", () => {
    const flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }, { feature: "gen_action_pose", enabled: true }]);
    expect(providerGenerationBlockedReason(null, false)).toBe("Reconnect provider first");
    expect(generationBlockedReasonWithProvider(flags, "gen_action_pose", null, false)).toBe("Reconnect provider first");
  });

  it("expired, not-configured and unknown provider states disable paid generation", () => {
    const states = ["token_expired", "not_configured", "unknown"] as const;
    for (const status of states) {
      expect(providerGenerationBlockedReason({ status, generationAllowed: false })).toBe("Reconnect provider first");
    }
  });

  it("connected or expiring provider enables generation only when flags also allow it", () => {
    const flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }, { feature: "gen_action_pose", enabled: true }]);
    expect(generationBlockedReasonWithProvider(flags, "gen_action_pose", { status: "connected", generationAllowed: true })).toBeNull();
    expect(generationBlockedReasonWithProvider(flags, "gen_action_pose", { status: "token_expiring", generationAllowed: true })).toBeNull();
    expect(generationBlockedReasonWithProvider({ ...flags, generation: false }, "gen_action_pose", { status: "connected", generationAllowed: true })).toBe("AI Generation is Locked.");
  });
});

describe("client batch/family confirmation math", () => {
  it("shows final expected model when references require an upgrade from z_image", () => {
    expect(expectedResolvedModel("z_image", true)).toBe("nano_banana");
    expect(expectedResolvedModel("z_image", false)).toBe("z_image");
  });

  it("retry Off displays the one-call maximum", () => {
    expect(batchMaximumCredits(3, "nano_banana", false)).toBe(3);
    expect(batchConfirmationButtonText(3, 3)).toBe("Generate 3 images — maximum 3 credits");
  });

  it("retry On displays the two-call maximum where retries are possible", () => {
    expect(batchMaximumCredits(3, "nano_banana", true)).toBe(6);
  });

  it("premium totals use the premium per-image price", () => {
    expect(batchMaximumCredits(3, "nano_banana_pro", false)).toBe(6);
  });
});
