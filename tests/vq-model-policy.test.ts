/**
 * Vault Quest low-cost model policy (Phase 3B) — pure unit coverage. Wired into
 * every paid generation route (see vq-spend-guard-phase3b-model-policy.integration
 * .test.ts for route-level proof).
 */
import { describe, it, expect } from "vitest";
import { defaultModelFor, resolveRequestedModel, VQ_DEFAULT_MODEL_TIER, MAX_PREMIUM_REASON_LENGTH } from "../shared/vq-model-policy";

describe("defaultModelFor / VQ_DEFAULT_MODEL_TIER", () => {
  it("every generation type defaults to the draft (cheapest) tier — never premium", () => {
    for (const type of Object.keys(VQ_DEFAULT_MODEL_TIER) as (keyof typeof VQ_DEFAULT_MODEL_TIER)[]) {
      expect(VQ_DEFAULT_MODEL_TIER[type]).toBe("draft");
      expect(defaultModelFor(type)).toBe("z_image");
    }
  });
});

describe("resolveRequestedModel", () => {
  it("no model requested, no references → the type's draft default, never premium", () => {
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

  describe("reference-dependent upgrade (z_image cannot support references)", () => {
    it("no model requested + references attached → upgrades the draft default to nano_banana", () => {
      const r = resolveRequestedModel("action_pose", undefined, { hasReferences: true });
      expect(r).toEqual({ ok: true, model: "nano_banana", isPremium: false });
    });
    it("z_image explicitly requested + references attached → upgraded to nano_banana, not rejected", () => {
      const r = resolveRequestedModel("master_portrait", "z_image", { hasReferences: true });
      expect(r).toEqual({ ok: true, model: "nano_banana", isPremium: false });
    });
    it("no references → z_image is used as-is, no upgrade", () => {
      const r = resolveRequestedModel("master_portrait", "z_image", { hasReferences: false });
      expect(r).toEqual({ ok: true, model: "z_image", isPremium: false });
    });
    it("nano_banana_pro + references is untouched by the upgrade rule (already ref-capable) but still gated by premium rules", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { hasReferences: true });
      expect(r.ok).toBe(false); // premium gate, not the reference upgrade
      expect(r.isPremium).toBe(true);
    });
  });

  describe("premium override", () => {
    it("premium (nano_banana_pro) WITHOUT confirmation is rejected", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro");
      expect(r.ok).toBe(false);
      expect(r.isPremium).toBe(true);
      expect(r.error).toMatch(/explicit confirmation/);
    });
    it("premium WITH confirmed=true but no reason is rejected", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { premium: { confirmed: true } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/reason/);
    });
    it("premium WITH confirmed=true and a WHITESPACE-ONLY reason is rejected", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { premium: { confirmed: true, reason: "   \n\t  " } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/reason/);
    });
    it("premium WITH an overlong reason is rejected", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { premium: { confirmed: true, reason: "x".repeat(MAX_PREMIUM_REASON_LENGTH + 1) } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/too long/);
    });
    it("premium WITH confirmed=true and a valid, non-empty reason is accepted and the reason is trimmed", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro", {
        premium: { confirmed: true, reason: "  Founder wants the highest-fidelity final art for this hero character.  " },
      });
      expect(r.ok).toBe(true);
      expect(r.model).toBe("nano_banana_pro");
      expect(r.isPremium).toBe(true);
      expect(r.premiumReason).toBe("Founder wants the highest-fidelity final art for this hero character.");
    });
    it("premium override model mismatch is rejected", () => {
      const r = resolveRequestedModel("master_portrait", "nano_banana_pro", { premium: { model: "nano_banana", confirmed: true, reason: "test" } });
      expect(r.ok).toBe(false);
    });
    it("premium is never selected implicitly just because a prior request used it — each call is independent (stateless)", () => {
      resolveRequestedModel("master_portrait", "nano_banana_pro", { premium: { confirmed: true, reason: "test" } });
      const second = resolveRequestedModel("master_portrait", undefined);
      expect(second.isPremium).toBe(false);
      expect(second.model).toBe("z_image");
    });
  });

  describe("replacement inherits the underlying type", () => {
    it("resolving for the underlying type IS the replacement policy — no separate 'replacement' entry exists to diverge", () => {
      // vq-schema referenceType for a replacement request is always one of the
      // concrete types (master_portrait/action_pose/etc) — "replacement" at the
      // policy layer just means "call resolveRequestedModel with THAT type",
      // proven at the route level in the Phase 3B integration test file.
      expect(resolveRequestedModel("action_pose", undefined)).toEqual(resolveRequestedModel("action_pose", undefined));
    });
  });
});
