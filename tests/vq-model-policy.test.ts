/**
 * Vault Quest low-cost model policy (Phase 3A item 3) — pure unit coverage.
 * NOTE: this module is DESIGNED and LOCALLY VERIFIED but NOT yet wired into any
 * live route this pass (see the final report) — these tests cover the pure logic
 * only, not route enforcement.
 */
import { describe, it, expect } from "vitest";
import { defaultModelFor, resolveRequestedModel, VQ_DEFAULT_MODEL_TIER } from "../shared/vq-model-policy";

describe("defaultModelFor / VQ_DEFAULT_MODEL_TIER", () => {
  it("every generation type defaults to the draft (cheapest) tier — never premium", () => {
    for (const type of Object.keys(VQ_DEFAULT_MODEL_TIER) as (keyof typeof VQ_DEFAULT_MODEL_TIER)[]) {
      expect(VQ_DEFAULT_MODEL_TIER[type]).toBe("draft");
      expect(defaultModelFor(type)).toBe("z_image");
    }
  });
});

describe("resolveRequestedModel", () => {
  it("no model requested → the type's draft default, never premium", () => {
    const r = resolveRequestedModel("action_pose", undefined);
    expect(r).toEqual({ ok: true, model: "z_image", isPremium: false });
  });
  it("a supported non-premium model (nano_banana) is always allowed, no override needed", () => {
    const r = resolveRequestedModel("master_portrait", "nano_banana");
    expect(r).toEqual({ ok: true, model: "nano_banana", isPremium: false });
  });
  it("an unsupported model string is rejected before any provider contact", () => {
    const r = resolveRequestedModel("action_pose", "made_up_model_9000");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a supported model/);
  });
  it("premium (nano_banana_pro) WITHOUT confirmation is rejected", () => {
    const r = resolveRequestedModel("master_portrait", "nano_banana_pro");
    expect(r.ok).toBe(false);
    expect(r.isPremium).toBe(true);
    expect(r.error).toMatch(/explicit confirmation/);
  });
  it("premium WITH confirmed=true but no reason is rejected", () => {
    const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { confirmed: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reason/);
  });
  it("premium WITH confirmed=true and a non-empty reason is allowed", () => {
    const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { confirmed: true, reason: "Founder wants the highest-fidelity final art for this hero character." });
    expect(r).toEqual({ ok: true, model: "nano_banana_pro", isPremium: true });
  });
  it("premium is never selected implicitly just because a prior request used it — each call is independent", () => {
    // No memory/state exists in this pure function — calling it twice with no
    // override the second time must NOT remember the first call's premium choice.
    resolveRequestedModel("master_portrait", "nano_banana_pro", { confirmed: true, reason: "test" });
    const second = resolveRequestedModel("master_portrait", undefined);
    expect(second.isPremium).toBe(false);
    expect(second.model).toBe("z_image");
  });
});
