import { describe, expect, it } from "vitest";
import {
  batchConfirmationButtonText,
  batchMaximumCredits,
  canSubmitGeneration,
  expectedResolvedModel,
  featureForReferenceType,
  generationBlockedReason,
  generationBlockedReasonWithProvider,
  planGenerationGate,
  providerGenerationBlockedReason,
  providerHardBlockReason,
  providerReadiness,
  resolveFounderFeatureMap,
  resolveFounderFeatureReasons,
  type FounderFeatureStatus,
  type ProviderConnection,
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

  it("configured, expired, not-configured and unknown provider states disable paid generation", () => {
    const states = ["configured", "token_expired", "not_configured", "unknown"] as const;
    for (const status of states) {
      expect(providerGenerationBlockedReason({ status, generationAllowed: false })).toBe("Reconnect provider first");
    }
    expect(providerGenerationBlockedReason({ status: "configured", generationAllowed: true, remoteVerified: false })).toBe("Reconnect provider first");
  });

  it("connected or expiring provider enables generation only when remotely verified and flags also allow it", () => {
    const flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }, { feature: "gen_action_pose", enabled: true }]);
    expect(generationBlockedReasonWithProvider(flags, "gen_action_pose", { status: "connected", generationAllowed: true, remoteVerified: true })).toBeNull();
    expect(generationBlockedReasonWithProvider(flags, "gen_action_pose", { status: "token_expiring", generationAllowed: true, remoteVerified: true })).toBeNull();
    expect(generationBlockedReasonWithProvider(flags, "gen_action_pose", { status: "connected", generationAllowed: true, remoteVerified: false })).toBe("Reconnect provider first");
    expect(generationBlockedReasonWithProvider({ ...flags, generation: false }, "gen_action_pose", { status: "connected", generationAllowed: true, remoteVerified: true })).toBe("AI Generation is Locked.");
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

// ── One-click "Generate Action Pose" gate resolution ───────────────────────────
// The founder's single click must resolve the two legitimate spend gates in place
// (enable a never-used type; run the free provider verification) WITHOUT ever
// bypassing a deliberate owner Off or the master lock, and without a hidden step.
// planGenerationGate is the pure decision the click handler drives. The server
// still re-checks both gates on the actual generate call — these tests assert the
// client only ever routes through sanctioned enable/verify/generate actions.

const READY_PROVIDER: ProviderConnection = { status: "connected", generationAllowed: true, remoteVerified: true };
const CONFIGURED_UNVERIFIED: ProviderConnection = { status: "configured", generationAllowed: false, remoteVerified: false };
const EXPIRED_PROVIDER: ProviderConnection = { status: "token_expired", generationAllowed: false, remoteVerified: false };

describe("provider readiness classification", () => {
  it("connected + remotely verified is ready", () => {
    expect(providerReadiness(READY_PROVIDER)).toBe("ready");
    expect(providerReadiness({ status: "token_expiring", generationAllowed: true, remoteVerified: true })).toBe("ready");
  });

  it("configured/unknown/checking/absent only need the free verification", () => {
    expect(providerReadiness(CONFIGURED_UNVERIFIED)).toBe("needs_verify");
    expect(providerReadiness({ status: "unknown", generationAllowed: false })).toBe("needs_verify");
    expect(providerReadiness({ status: "checking", generationAllowed: false })).toBe("needs_verify");
    expect(providerReadiness(null)).toBe("needs_verify");
    expect(providerReadiness(undefined, false)).toBe("needs_verify");
  });

  it("connected-but-not-remotely-verified still needs verification (never falsely ready)", () => {
    expect(providerReadiness({ status: "connected", generationAllowed: true, remoteVerified: false })).toBe("needs_verify");
  });

  it("expired / not-configured / disconnected are hard-blocked with a real, specific reason", () => {
    for (const status of ["token_expired", "not_configured", "disconnected"] as const) {
      expect(providerReadiness({ status, generationAllowed: false })).toBe("hard_blocked");
    }
    expect(providerHardBlockReason(EXPIRED_PROVIDER)).toMatch(/token has expired/i);
    expect(providerHardBlockReason({ status: "not_configured", generationAllowed: false })).toMatch(/not configured/i);
    expect(providerHardBlockReason({ status: "disconnected", generationAllowed: false })).toMatch(/disconnected/i);
  });
});

describe("resolveFounderFeatureReasons distinguishes a deliberate Off from a never-enabled type", () => {
  it("keeps only known feature reasons", () => {
    const features: FounderFeatureStatus[] = [
      { feature: "generation", enabled: true, reason: "default_on" },
      { feature: "gen_action_pose", enabled: false, reason: "not_yet_enabled" },
      { feature: "gen_master_portrait", enabled: false, reason: "db_flag_off" },
      { feature: "totally_unknown", enabled: false, reason: "whatever" },
    ];
    const reasons = resolveFounderFeatureReasons(features);
    expect(reasons.gen_action_pose).toBe("not_yet_enabled");
    expect(reasons.gen_master_portrait).toBe("db_flag_off");
    expect((reasons as Record<string, string>).totally_unknown).toBeUndefined();
  });
});

describe("planGenerationGate — the founder single-click decision", () => {
  const onFlags = resolveFounderFeatureMap([
    { feature: "generation", enabled: true },
    { feature: "gen_action_pose", enabled: true },
  ]);

  it("type enabled + provider verified → generate immediately (no extra calls)", () => {
    expect(planGenerationGate(onFlags, "gen_action_pose", "db_flag_on", READY_PROVIDER)).toEqual({ kind: "generate" });
  });

  it("master AI-Generation lock is a deliberate owner block — never auto-bypassed", () => {
    const locked = resolveFounderFeatureMap([{ feature: "generation", enabled: false }, { feature: "gen_action_pose", enabled: true }]);
    const plan = planGenerationGate(locked, "gen_action_pose", "db_flag_on", READY_PROVIDER);
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toMatch(/AI Generation is Locked/i);
  });

  it("a NEVER-enabled type (not_yet_enabled / no row) → enable-then-continue (the founder's explicit click enables it)", () => {
    const offByDefault = resolveFounderFeatureMap([{ feature: "generation", enabled: true }]); // no gen_action_pose row
    const plan = planGenerationGate(offByDefault, "gen_action_pose", "not_yet_enabled", READY_PROVIDER);
    expect(plan).toEqual({ kind: "enable_then_continue", feature: "gen_action_pose", label: "Action references" });
    // ...and with no reason at all (older snapshot) it still treats it as never-enabled, not a deliberate Off.
    expect(planGenerationGate(offByDefault, "gen_action_pose", undefined, READY_PROVIDER).kind).toBe("enable_then_continue");
  });

  it("a DELIBERATE owner Off (db_flag_off) is respected — blocked, never silently re-enabled", () => {
    const deliberateOff = resolveFounderFeatureMap([{ feature: "generation", enabled: true }, { feature: "gen_action_pose", enabled: false }]);
    const plan = planGenerationGate(deliberateOff, "gen_action_pose", "db_flag_off", READY_PROVIDER);
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toMatch(/turned Off in Founder Spend Controls/i);
  });

  it("type enabled but provider not yet verified → verify-then-continue (zero-cost token check, no generate)", () => {
    expect(planGenerationGate(onFlags, "gen_action_pose", "db_flag_on", CONFIGURED_UNVERIFIED)).toEqual({ kind: "verify_then_continue" });
  });

  it("type enabled but provider hard-blocked → blocked with the real provider reason (a click cannot fix it)", () => {
    const plan = planGenerationGate(onFlags, "gen_action_pose", "db_flag_on", EXPIRED_PROVIDER);
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toMatch(/token has expired/i);
  });

  it("resolves in order enable → verify → generate over a fresh snapshot each step (never a dead end)", () => {
    // Step 1: never-enabled type, unverified provider → enable first.
    let flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }]);
    expect(planGenerationGate(flags, "gen_action_pose", "not_yet_enabled", CONFIGURED_UNVERIFIED).kind).toBe("enable_then_continue");
    // Step 2: after enabling (fresh snapshot), provider still unverified → verify.
    flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }, { feature: "gen_action_pose", enabled: true }]);
    expect(planGenerationGate(flags, "gen_action_pose", "db_flag_on", CONFIGURED_UNVERIFIED).kind).toBe("verify_then_continue");
    // Step 3: after a successful verify (fresh snapshot) → generate.
    expect(planGenerationGate(flags, "gen_action_pose", "db_flag_on", READY_PROVIDER).kind).toBe("generate");
  });

  it("the same decision holds for every reference type, not just action_pose", () => {
    const flags = resolveFounderFeatureMap([{ feature: "generation", enabled: true }]);
    for (const feature of ["gen_master_portrait", "gen_face_closeup", "gen_turnaround_sheet", "gen_colour_sheet"] as const) {
      expect(planGenerationGate(flags, feature, "not_yet_enabled", READY_PROVIDER).kind).toBe("enable_then_continue");
    }
  });
});
