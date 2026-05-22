import { describe, it, expect } from "vitest";
import { computeMvgsScore, gradeFromMvgsScore, mvgsGradeLabel, type MvgsInput } from "../shared/mvgs-scoring";

function baseInput(overrides: Partial<MvgsInput> = {}): MvgsInput {
  return {
    centeringFrontLr: "50/50",
    centeringFrontTb: "50/50",
    centeringBackLr: "50/50",
    centeringBackTb: "50/50",
    defects: [],
    darkBorderFront: false,
    darkBorderBack: false,
    eyeAppealModifier: 0,
    ...overrides,
  };
}

describe("computeMvgsScore", () => {
  it("returns Pristine 10P for a perfect card", () => {
    const r = computeMvgsScore(baseInput());
    expect(r.score).toBe(100);
    expect(r.grade).toBe("Pristine 10P");
    expect(Object.keys(r.deductions)).toHaveLength(0);
  });

  it("deducts centering front when off-centre", () => {
    const r = computeMvgsScore(baseInput({ centeringFrontLr: "65/35" }));
    expect(r.deductions.centering_front).toBe(-5);
    expect(r.score).toBeLessThan(100);
  });

  it("uses worst of LR vs TB for front centering", () => {
    const r = computeMvgsScore(baseInput({ centeringFrontLr: "55/45", centeringFrontTb: "70/30" }));
    expect(r.deductions.centering_front).toBe(-8);
  });

  it("deducts centering back only at 75+", () => {
    const ok = computeMvgsScore(baseInput({ centeringBackLr: "70/30" }));
    expect(ok.deductions.centering_back).toBeUndefined();

    const bad = computeMvgsScore(baseInput({ centeringBackLr: "80/20" }));
    expect(bad.deductions.centering_back).toBe(-1);
  });

  it("deducts for front corner D1 defects", () => {
    const r = computeMvgsScore(
      baseInput({
        defects: [{ tier: "D1", mvgsCode: "DN", zone: "FC1" }],
      })
    );
    expect(r.deductions.corners).toBe(-4);
  });

  it("deducts less for back corner D1 defects", () => {
    const r = computeMvgsScore(
      baseInput({
        defects: [{ tier: "D1", mvgsCode: "DN", zone: "BC1" }],
      })
    );
    expect(r.deductions.corners).toBe(-2);
  });

  it("caps corner deductions at -25", () => {
    // 4 front D1 corners = -16, 4 back D1 corners = -8, total -24, need more
    // Add duplicate front corners to exceed -25
    const defects = [
      ...Array.from({ length: 4 }, (_, i) => ({
        tier: "D1",
        mvgsCode: "DN",
        zone: `FC${i + 1}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        tier: "D1",
        mvgsCode: "DN",
        zone: `FC${i + 1}`,
      })),
    ];
    const r = computeMvgsScore(baseInput({ defects }));
    expect(r.deductions.corners).toBe(-25);
  });

  it("applies WH dark-border multiplier on front edges only", () => {
    const withDark = computeMvgsScore(
      baseInput({
        darkBorderFront: true,
        defects: [{ tier: "D1", mvgsCode: "WH", zone: "FE1" }],
      })
    );
    const withoutDark = computeMvgsScore(
      baseInput({
        darkBorderFront: false,
        defects: [{ tier: "D1", mvgsCode: "WH", zone: "FE1" }],
      })
    );
    expect(withDark.deductions.edges).toBe(-3 * 1.25);
    expect(withoutDark.deductions.edges).toBe(-3);
  });

  it("does not apply dark-border multiplier to back edges when only front is dark", () => {
    const r = computeMvgsScore(
      baseInput({
        darkBorderFront: true,
        darkBorderBack: false,
        defects: [{ tier: "D1", mvgsCode: "WH", zone: "BE1" }],
      })
    );
    expect(r.deductions.edges).toBe(-2);
  });

  it("CR D1 forces a 74 cap", () => {
    const r = computeMvgsScore(
      baseInput({
        defects: [{ tier: "D1", mvgsCode: "CR", zone: "FA" }],
      })
    );
    expect(r.score).toBeLessThanOrEqual(74);
  });

  it("SP D1 in art/holo zone gets 1.5x multiplier", () => {
    const artZone = computeMvgsScore(
      baseInput({
        defects: [{ tier: "D1", mvgsCode: "SP", zone: "FA" }],
      })
    );
    const backZone = computeMvgsScore(
      baseInput({
        defects: [{ tier: "D1", mvgsCode: "SP", zone: "BA" }],
      })
    );
    expect(artZone.deductions.surface).toBe(-4 * 1.5);
    expect(backZone.deductions.surface).toBe(-4 * 0.5);
  });

  it("back-surface defects get 0.5x multiplier", () => {
    const r = computeMvgsScore(
      baseInput({
        defects: [{ tier: "D1", mvgsCode: "SC", zone: "BA" }],
      })
    );
    expect(r.deductions.surface).toBe(-2 * 0.5);
  });

  it("applies eye appeal modifier clamped to ±2", () => {
    const plus = computeMvgsScore(baseInput({ eyeAppealModifier: 5 }));
    expect(plus.deductions.eye_appeal).toBe(2);

    const minus = computeMvgsScore(baseInput({ eyeAppealModifier: -10 }));
    expect(minus.deductions.eye_appeal).toBe(-2);
  });

  it("clamps final score to 1..100", () => {
    const defects = [
      ...Array.from({ length: 4 }, (_, i) => ({
        tier: "D1" as const,
        mvgsCode: "DN",
        zone: `FC${i + 1}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        tier: "D1" as const,
        mvgsCode: "DN",
        zone: `FE${i + 1}`,
      })),
      { tier: "D1", mvgsCode: "CR", zone: "FA" },
    ];
    const r = computeMvgsScore(
      baseInput({
        centeringFrontLr: "90/10",
        defects,
        eyeAppealModifier: -2,
      })
    );
    expect(r.score).toBeGreaterThanOrEqual(1);
  });

  it("D3 defects cause no deductions", () => {
    const r = computeMvgsScore(
      baseInput({
        defects: [
          { tier: "D3", mvgsCode: "WH", zone: "FC1" },
          { tier: "D3", mvgsCode: "WH", zone: "FE1" },
          { tier: "D3", mvgsCode: "SC", zone: "FA" },
        ],
      })
    );
    expect(r.score).toBe(100);
  });
});

describe("gradeFromMvgsScore", () => {
  it.each([
    [100, 10],
    [96, 10],
    [95, 10],
    [91, 10],
    [90, 9.5],
    [86, 9.5],
    [85, 9],
    [81, 9],
    [80, 8.5],
    [76, 8.5],
    [75, 8],
    [71, 8],
    [70, 7.5],
    [66, 7.5],
    [65, 7],
    [61, 7],
    [60, 6],
    [51, 6],
    [50, 5],
    [41, 5],
    [40, 4],
    [31, 4],
    [30, 3],
    [21, 3],
    [20, 2],
    [11, 2],
    [10, 1],
    [1, 1],
  ])("score %i → grade %s", (score, expected) => {
    expect(gradeFromMvgsScore(score)).toBe(expected);
  });
});

describe("mvgsGradeLabel", () => {
  it.each([
    [100, "Pristine 10P"],
    [96, "Pristine 10P"],
    [91, "Gem Mint 10"],
    [86, "Mint+ 9.5"],
    [81, "Mint 9"],
    [76, "NM-Mint+ 8.5"],
    [71, "NM-Mint 8"],
    [66, "NM+ 7.5"],
    [61, "Near Mint 7"],
    [51, "Excellent-Mint 6"],
    [41, "Excellent 5"],
    [31, "Very Good-Excellent 4"],
    [21, "Good 3"],
    [11, "Fair 2"],
    [1, "Poor 1"],
  ])("score %i → %s", (score, expected) => {
    expect(mvgsGradeLabel(score)).toBe(expected);
  });
});
