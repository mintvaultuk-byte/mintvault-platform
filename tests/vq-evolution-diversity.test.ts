/**
 * Stage-to-stage Evolution Difference gate — pure threshold/verdict logic.
 * No network, no DB, no mocking: exercises the exact examples from the bug report
 * (identical stage forms and minor-appendage-only changes must fail; clearly
 * matured/developed stages must pass) straight through evaluateEvolutionDifference/
 * evolutionDifferenceThreshold.
 */
import { describe, it, expect, afterEach } from "vitest";
import { evaluateEvolutionDifference, evolutionDifferenceThreshold } from "../server/vault-quest/ai/evolution-diversity";

const ORIGINAL_S2 = process.env.VQ_EVOLUTION_DIFF_MIN_S2;
const ORIGINAL_S3 = process.env.VQ_EVOLUTION_DIFF_MIN_S3;
afterEach(() => {
  if (ORIGINAL_S2 === undefined) delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
  else process.env.VQ_EVOLUTION_DIFF_MIN_S2 = ORIGINAL_S2;
  if (ORIGINAL_S3 === undefined) delete process.env.VQ_EVOLUTION_DIFF_MIN_S3;
  else process.env.VQ_EVOLUTION_DIFF_MIN_S3 = ORIGINAL_S3;
});

describe("evolutionDifferenceThreshold", () => {
  it("defaults to 55 for stage 2 (vs stage 1) when unset", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    expect(evolutionDifferenceThreshold(2)).toBe(55);
  });
  it("defaults to 60 for stage 3 (vs stage 2) when unset", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S3;
    expect(evolutionDifferenceThreshold(3)).toBe(60);
  });
  it("stage 4+ (any later stage) uses the same S3 default/override as stage 3", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S3;
    expect(evolutionDifferenceThreshold(4)).toBe(60);
  });
  it("honours valid per-stage overrides independently", () => {
    process.env.VQ_EVOLUTION_DIFF_MIN_S2 = "70";
    process.env.VQ_EVOLUTION_DIFF_MIN_S3 = "80";
    expect(evolutionDifferenceThreshold(2)).toBe(70);
    expect(evolutionDifferenceThreshold(3)).toBe(80);
  });
  it("falls back to the stage-specific default on an invalid override (non-numeric, negative, >100)", () => {
    process.env.VQ_EVOLUTION_DIFF_MIN_S2 = "not-a-number";
    expect(evolutionDifferenceThreshold(2)).toBe(55);
    process.env.VQ_EVOLUTION_DIFF_MIN_S2 = "-5";
    expect(evolutionDifferenceThreshold(2)).toBe(55);
    process.env.VQ_EVOLUTION_DIFF_MIN_S2 = "150";
    expect(evolutionDifferenceThreshold(2)).toBe(55);
  });
});

describe("evaluateEvolutionDifference — identical/near-identical forms FAIL", () => {
  it("identical stage form (difference 0) fails", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    const r = evaluateEvolutionDifference(0, 2);
    expect(r.verdict).toBe("fail");
    expect(r.difference).toBe(0);
    expect(r.stageNumber).toBe(2);
  });
  it("minor appendage/fin-only change (difference ~15) fails — the exact bug report symptom", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    expect(evaluateEvolutionDifference(15, 2).verdict).toBe("fail");
  });
  it("simple uniform enlargement without structural development (difference ~30) still fails", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    expect(evaluateEvolutionDifference(30, 2).verdict).toBe("fail");
  });
  it("a moderate-but-insufficient change (difference 40) fails — below the 55 default", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    expect(evaluateEvolutionDifference(40, 2).verdict).toBe("fail");
  });
});

describe("evaluateEvolutionDifference — genuinely evolved forms PASS", () => {
  it.each([
    ["clearly matured Stage 2 (larger body, developed limbs)", 2, 70],
    ["substantially evolved Stage 2 (different silhouette + horns)", 2, 85],
    ["clearly developed Stage 3 (final, most powerful form)", 3, 75],
    ["dramatically evolved Stage 3 (unmistakably advanced)", 3, 92],
  ])("%s (stage %i, difference %i) passes", (_label, stage, difference) => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S3;
    expect(evaluateEvolutionDifference(difference, stage).verdict).toBe("pass");
  });
});

describe("evaluateEvolutionDifference — boundary + input safety", () => {
  it("exactly at the stage 2 threshold passes (>=, not >)", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    expect(evaluateEvolutionDifference(55, 2).verdict).toBe("pass");
    expect(evaluateEvolutionDifference(54, 2).verdict).toBe("fail");
  });
  it("exactly at the stage 3 threshold passes (>=, not >)", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S3;
    expect(evaluateEvolutionDifference(60, 3).verdict).toBe("pass");
    expect(evaluateEvolutionDifference(59, 3).verdict).toBe("fail");
  });
  it("stage 3 requires a stricter difference than stage 2 at the same raw score", () => {
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S2;
    delete process.env.VQ_EVOLUTION_DIFF_MIN_S3;
    expect(evaluateEvolutionDifference(57, 2).verdict).toBe("pass"); // clears 55
    expect(evaluateEvolutionDifference(57, 3).verdict).toBe("fail"); // does not clear 60
  });
  it("clamps out-of-range or non-finite input rather than throwing", () => {
    expect(evaluateEvolutionDifference(-20, 2).difference).toBe(0);
    expect(evaluateEvolutionDifference(500, 2).difference).toBe(100);
    expect(evaluateEvolutionDifference(Number.NaN, 2).difference).toBe(0);
  });
  it("a configured stricter threshold rejects a difference that would otherwise pass", () => {
    process.env.VQ_EVOLUTION_DIFF_MIN_S2 = "85";
    expect(evaluateEvolutionDifference(70, 2).verdict).toBe("fail"); // would have passed at the 55 default
    expect(evaluateEvolutionDifference(90, 2).verdict).toBe("pass");
  });
});
