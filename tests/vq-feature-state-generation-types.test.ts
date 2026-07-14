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

describe("a per-generation-type toggle follows the SAME default-on precedent as the existing 'generation' switch", () => {
  it("missing row → enabled (never blocks a type nobody has touched)", () => {
    expect(vqFeatureState("gen_action_pose", {}, {}).enabled).toBe(true);
  });
  it("explicit DB flag off → disabled", () => {
    expect(vqFeatureState("gen_action_pose", {}, { gen_action_pose: false }).enabled).toBe(false);
  });
  it("explicit DB flag on → enabled", () => {
    expect(vqFeatureState("gen_action_pose", {}, { gen_action_pose: false, gen_master_portrait: true }).enabled).toBe(false);
  });
  it("one type's flag never affects another type's flag", () => {
    const db = { gen_action_pose: false };
    expect(vqFeatureState("gen_action_pose", {}, db).enabled).toBe(false);
    expect(vqFeatureState("gen_master_portrait", {}, db).enabled).toBe(true);
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
