/**
 * Action Reference pose-diversity gate — pure threshold/verdict logic.
 * No network, no DB, no mocking: these are the exact examples from the bug
 * report (near-identical standing poses must fail; genuinely dynamic poses
 * must pass) run straight through evaluatePoseDiversity/poseDifferenceThreshold.
 */
import { describe, it, expect, afterEach } from "vitest";
import { evaluatePoseDiversity, poseDifferenceThreshold } from "../server/vault-quest/ai/pose-diversity";

const ORIGINAL_ENV = process.env.VQ_POSE_DIFFERENCE_MIN;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.VQ_POSE_DIFFERENCE_MIN;
  else process.env.VQ_POSE_DIFFERENCE_MIN = ORIGINAL_ENV;
});

describe("poseDifferenceThreshold", () => {
  it("defaults to 55 when unset", () => {
    delete process.env.VQ_POSE_DIFFERENCE_MIN;
    expect(poseDifferenceThreshold()).toBe(55);
  });
  it("honours a valid override", () => {
    process.env.VQ_POSE_DIFFERENCE_MIN = "70";
    expect(poseDifferenceThreshold()).toBe(70);
  });
  it("falls back to the default on an invalid override (non-numeric, negative, >100)", () => {
    process.env.VQ_POSE_DIFFERENCE_MIN = "not-a-number";
    expect(poseDifferenceThreshold()).toBe(55);
    process.env.VQ_POSE_DIFFERENCE_MIN = "-5";
    expect(poseDifferenceThreshold()).toBe(55);
    process.env.VQ_POSE_DIFFERENCE_MIN = "150";
    expect(poseDifferenceThreshold()).toBe(55);
  });
});

describe("evaluatePoseDiversity — identical/near-identical poses FAIL", () => {
  it("identical pose (difference 0) fails", () => {
    delete process.env.VQ_POSE_DIFFERENCE_MIN;
    const r = evaluatePoseDiversity(0);
    expect(r.verdict).toBe("fail");
    expect(r.difference).toBe(0);
  });
  it("near-identical pose — standing, feet/body-angle/head-rotation/tail barely changed (difference ~15) fails", () => {
    delete process.env.VQ_POSE_DIFFERENCE_MIN;
    expect(evaluatePoseDiversity(15).verdict).toBe("fail");
  });
  it("a minor camera-angle-only variation (difference 40) still fails — below the 55 default", () => {
    delete process.env.VQ_POSE_DIFFERENCE_MIN;
    expect(evaluatePoseDiversity(40).verdict).toBe("fail");
  });
});

describe("evaluatePoseDiversity — genuinely dynamic poses PASS", () => {
  it.each([
    ["running", 75],
    ["leaping", 82],
    ["crouching to pounce", 68],
    ["twisting mid-air", 90],
    ["attacking", 85],
    ["dynamic balance shift", 60],
  ])("%s (difference %i) passes", (_label, difference) => {
    delete process.env.VQ_POSE_DIFFERENCE_MIN;
    expect(evaluatePoseDiversity(difference).verdict).toBe("pass");
  });
});

describe("evaluatePoseDiversity — boundary + input safety", () => {
  it("exactly at the threshold passes (>=, not >)", () => {
    delete process.env.VQ_POSE_DIFFERENCE_MIN;
    expect(evaluatePoseDiversity(55).verdict).toBe("pass");
    expect(evaluatePoseDiversity(54).verdict).toBe("fail");
  });
  it("clamps out-of-range or non-finite input rather than throwing", () => {
    expect(evaluatePoseDiversity(-20).difference).toBe(0);
    expect(evaluatePoseDiversity(500).difference).toBe(100);
    expect(evaluatePoseDiversity(Number.NaN).difference).toBe(0);
  });
  it("a configured stricter threshold rejects a pose that would otherwise pass", () => {
    process.env.VQ_POSE_DIFFERENCE_MIN = "85";
    expect(evaluatePoseDiversity(75).verdict).toBe("fail"); // would have passed at the 55 default
    expect(evaluatePoseDiversity(90).verdict).toBe("pass");
  });
});
