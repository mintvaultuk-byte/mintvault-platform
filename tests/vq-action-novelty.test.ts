/**
 * Action Reference REPLACEMENT novelty gate — pure verdict + threshold.
 * Mirrors tests/vq-pose-diversity.test.ts. No network, no DB.
 */
import { describe, it, expect, afterEach } from "vitest";
import { evaluateActionNovelty, actionReplacementDifferenceThreshold } from "../server/vault-quest/ai/action-novelty";

const OLD = process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN;
afterEach(() => {
  if (OLD == null) delete process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN;
  else process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN = OLD;
});

describe("actionReplacementDifferenceThreshold", () => {
  it("defaults to 65 (stricter than the pose-vs-Master 55)", () => {
    delete process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN;
    expect(actionReplacementDifferenceThreshold()).toBe(65);
  });
  it("honours a valid env override", () => {
    process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN = "80";
    expect(actionReplacementDifferenceThreshold()).toBe(80);
  });
  it("ignores an out-of-range / non-numeric override", () => {
    process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN = "abc";
    expect(actionReplacementDifferenceThreshold()).toBe(65);
    process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN = "200";
    expect(actionReplacementDifferenceThreshold()).toBe(65);
  });
});

describe("evaluateActionNovelty", () => {
  it("below threshold → fail (too similar to the existing Action)", () => {
    delete process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN;
    const v = evaluateActionNovelty(40);
    expect(v).toEqual({ difference: 40, verdict: "fail", threshold: 65 });
  });
  it("at/above threshold → pass (clearly different action)", () => {
    delete process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN;
    expect(evaluateActionNovelty(65).verdict).toBe("pass");
    expect(evaluateActionNovelty(90).verdict).toBe("pass");
  });
  it("clamps + rounds the raw score", () => {
    expect(evaluateActionNovelty(150).difference).toBe(100);
    expect(evaluateActionNovelty(-5).difference).toBe(0);
    expect(evaluateActionNovelty(64.6).difference).toBe(65);
    expect(evaluateActionNovelty(Number.NaN).difference).toBe(0);
  });
});
