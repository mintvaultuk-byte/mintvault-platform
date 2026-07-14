/**
 * Pure unit tests for the spend-guard hardening additions to vq-feature-state.ts:
 * per-generation-type feature mapping (item B) and the automatic-paid-retry
 * default-OFF helper (item E). No DB, no network.
 */
import { describe, it, expect } from "vitest";
import {
  generationTypeFeatureFor,
  isAutomaticPaidRetryEnabled,
  VQ_GENERATION_TYPE_FEATURES,
  AUTO_RETRY_FEATURE,
  vqFeatureState,
} from "../server/vault-quest/lib/vq-feature-state";

describe("generationTypeFeatureFor", () => {
  it("maps each known VqReferenceType to its own dedicated toggle", () => {
    expect(generationTypeFeatureFor("master_portrait")).toBe("gen_master_portrait");
    expect(generationTypeFeatureFor("action_pose")).toBe("gen_action_pose");
    expect(generationTypeFeatureFor("face_closeup")).toBe("gen_face_closeup");
    expect(generationTypeFeatureFor("turnaround_sheet")).toBe("gen_turnaround_sheet");
    expect(generationTypeFeatureFor("colour_sheet")).toBe("gen_colour_sheet");
  });
  it("falls back to gen_replacement for an unrecognised type (fail-safe: still gated by SOME toggle)", () => {
    expect(generationTypeFeatureFor("something_new")).toBe("gen_replacement");
  });
  it("VQ_GENERATION_TYPE_FEATURES lists exactly the 7 required generation types", () => {
    expect(VQ_GENERATION_TYPE_FEATURES).toEqual([
      "gen_master_portrait", "gen_action_pose", "gen_face_closeup",
      "gen_turnaround_sheet", "gen_colour_sheet", "gen_card_artwork", "gen_replacement",
    ]);
  });
});

describe("a per-generation-type toggle defaults OFF (correction A) — DELIBERATELY the inverse of 'generation'/'exports'/'writes'", () => {
  it("missing row → DISABLED (a newly deployed type is unavailable until an owner explicitly turns it on)", () => {
    const state = vqFeatureState("gen_action_pose", {}, {});
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("not_yet_enabled");
  });
  it("explicit DB flag off → still disabled", () => {
    expect(vqFeatureState("gen_action_pose", {}, { gen_action_pose: false }).enabled).toBe(false);
  });
  it("explicit DB flag on → enabled (the owner's opt-in is respected)", () => {
    expect(vqFeatureState("gen_action_pose", {}, { gen_action_pose: true }).enabled).toBe(true);
  });
  it("enabling ONE type does not enable any other type — a sibling with no row stays OFF", () => {
    const db = { gen_action_pose: true };
    expect(vqFeatureState("gen_action_pose", {}, db).enabled).toBe(true);
    expect(vqFeatureState("gen_master_portrait", {}, db).enabled).toBe(false);
  });
  it("disabling one type explicitly does not touch a sibling that IS explicitly enabled", () => {
    const db = { gen_action_pose: false, gen_master_portrait: true };
    expect(vqFeatureState("gen_action_pose", {}, db).enabled).toBe(false);
    expect(vqFeatureState("gen_master_portrait", {}, db).enabled).toBe(true);
  });
});

describe("correction A does NOT touch the original three flags — they remain default-ON, unaffected", () => {
  it("'generation' with no row → still enabled", () => {
    expect(vqFeatureState("generation", {}, {}).enabled).toBe(true);
  });
  it("'exports' with no row → still enabled", () => {
    expect(vqFeatureState("exports", {}, {}).enabled).toBe(true);
  });
  it("'writes' with no row → still enabled", () => {
    expect(vqFeatureState("writes", {}, {}).enabled).toBe(true);
  });
  it("the global 'generation' flag still overrides an explicitly-enabled type when checked independently by the route (each check is independent; both must pass)", () => {
    // vqFeatureState itself only evaluates ONE feature at a time — the route layer
    // calls it twice (generation, then the specific gen_* type) and requires BOTH
    // to be ok. This test proves each half's own state is correct in isolation;
    // the AND-of-both-gates behaviour is proven end-to-end in
    // vq-spend-guard-phase2.integration.test.ts.
    const db = { generation: false, gen_action_pose: true };
    expect(vqFeatureState("generation", {}, db).enabled).toBe(false);
    expect(vqFeatureState("gen_action_pose", {}, db).enabled).toBe(true);
  });
});

describe("isAutomaticPaidRetryEnabled — the ONE flag that inverts the default-on precedent", () => {
  it("absent row → false (spend-safe default: no automatic paid retries)", () => {
    expect(isAutomaticPaidRetryEnabled({})).toBe(false);
  });
  it("explicit true → true", () => {
    expect(isAutomaticPaidRetryEnabled({ [AUTO_RETRY_FEATURE]: true })).toBe(true);
  });
  it("explicit false → false", () => {
    expect(isAutomaticPaidRetryEnabled({ [AUTO_RETRY_FEATURE]: false })).toBe(false);
  });
  it("a degraded/missing-table read (loadVqDbFlags' {} fallback) resolves to false, never true", () => {
    expect(isAutomaticPaidRetryEnabled({})).toBe(false);
  });
});
