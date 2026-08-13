import { describe, it, expect } from "vitest";
import { isPristine, isBlackLabel, DEFECT_DEDUCTION_KEYS } from "../shared/pristine";

const TEN = { centering: 10, corners: 10, edges: 10, surface: 10 };

describe("isPristine / isBlackLabel gate", () => {
  it("true when overall 10 + all subgrades 10 and no deductions supplied", () => {
    expect(isPristine(TEN, 10)).toBe(true);
  });

  it("true when every defect deduction is zero", () => {
    expect(isPristine(TEN, 10, { centering_front: 0, centering_back: 0, corners: 0, edges: 0, surface: 0 })).toBe(true);
  });

  it("false when any raw defect deduction is negative (corners -1.5)", () => {
    expect(isPristine(TEN, 10, { corners: -1.5 })).toBe(false);
  });

  it("false for a negative deduction in each individual defect category", () => {
    for (const k of DEFECT_DEDUCTION_KEYS) {
      expect(isPristine(TEN, 10, { [k]: -0.5 })).toBe(false);
    }
  });

  it("ignores eye_appeal — it is a subjective modifier, not a defect", () => {
    expect(isPristine(TEN, 10, { eye_appeal: -2 })).toBe(true);
  });

  it("false when any subgrade is below 10", () => {
    expect(isPristine({ ...TEN, corners: 9 }, 10)).toBe(false);
    expect(isPristine({ ...TEN, centering: 9 }, 10)).toBe(false);
    expect(isPristine({ ...TEN, edges: 9 }, 10)).toBe(false);
    expect(isPristine({ ...TEN, surface: 9 }, 10)).toBe(false);
  });

  it("false when overall is below 10 even if all subgrades are 10", () => {
    expect(isPristine(TEN, 9)).toBe(false);
  });

  it("isBlackLabel is the exact same gate as isPristine", () => {
    expect(isBlackLabel).toBe(isPristine);
  });

  it("keeps the Pristine gate in the canonical shared module", () => {
    expect(typeof isBlackLabel).toBe("function");
  });
});
