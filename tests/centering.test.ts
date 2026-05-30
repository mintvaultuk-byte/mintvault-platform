import { describe, it, expect } from "vitest";
import {
  centeringAxisGrade,
  centeringAxisGradeOrNull,
  centeringSubgrade,
  centeringSubgradeStrict,
  centeringScoreDeductions,
} from "../shared/centering";

describe("centeringSubgrade — five spec verification cases", () => {
  it("a. perfectly centred → 10", () => {
    const r = centeringSubgrade("50/50", "50/50", "50/50", "50/50");
    expect(r.subgrade).toBe(10);
  });

  it("b. Sinistcha reference (Front L/R 55/45, Back L/R 56/44) → 10, worst axis backLR", () => {
    const r = centeringSubgrade("55/45", "50/50", "56/44", "50/50");
    expect(r.subgrade).toBe(10);
    // Tie at grade 10 across all four axes — worst axis is the one with the
    // largest RAW deviation (back 56/44 = 12 beats front 55/45 = 10).
    expect(r.worstAxis).toBe("backLR");
  });

  it("c. front 60/40 → 9", () => {
    const r = centeringSubgrade("60/40", "50/50", "50/50", "50/50");
    expect(r.subgrade).toBe(9);
    expect(r.worstAxis).toBe("frontLR");
  });

  it("d. back 88/12 → 8", () => {
    const r = centeringSubgrade("50/50", "50/50", "88/12", "50/50");
    expect(r.subgrade).toBe(8);
    expect(r.worstAxis).toBe("backLR");
  });

  it("e. front 70/30 → 7", () => {
    const r = centeringSubgrade("70/30", "50/50", "50/50", "50/50");
    expect(r.subgrade).toBe(7);
    expect(r.worstAxis).toBe("frontLR");
  });
});

describe("centeringAxisGrade — float boundary regression", () => {
  // 55/45 computes to 55.00000000000001 (0.55 is not exact in IEEE-754).
  // Without the band epsilon this spills past the ≤55 boundary into grade 9.
  it("55/45 front is exactly grade 10 (not 9) despite float noise", () => {
    expect(centeringAxisGrade("55/45", "front")).toBe(10);
  });
  it("60/40 front is grade 9", () => {
    expect(centeringAxisGrade("60/40", "front")).toBe(9);
  });
  it("75/25 back is exactly grade 10 (boundary)", () => {
    expect(centeringAxisGrade("75/25", "back")).toBe(10);
  });
  it("front strict vs back lenient diverge at the same ratio (70/30)", () => {
    expect(centeringAxisGrade("70/30", "front")).toBe(7);
    expect(centeringAxisGrade("70/30", "back")).toBe(10);
  });
});

describe("centeringAxisGradeOrNull — display leniency", () => {
  it("returns null for malformed/empty input (display highlights nothing)", () => {
    expect(centeringAxisGradeOrNull("", "front")).toBeNull();
    expect(centeringAxisGradeOrNull(null, "front")).toBeNull();
    expect(centeringAxisGradeOrNull("abc", "front")).toBeNull();
  });
  it("parses a valid ratio", () => {
    expect(centeringAxisGradeOrNull("65/35", "front")).toBe(8);
  });
});

describe("centeringAxisGrade — scoring leniency", () => {
  it("treats missing/malformed axis as a perfect 10 (no penalty)", () => {
    expect(centeringAxisGrade("", "front")).toBe(10);
    expect(centeringAxisGrade(undefined, "back")).toBe(10);
  });
});

describe("centeringSubgradeStrict — requires all four ratios", () => {
  it("returns null when any ratio is missing", () => {
    expect(centeringSubgradeStrict("55/45", "50/50", "56/44", "")).toBeNull();
  });
  it("returns a result when all four are present", () => {
    const r = centeringSubgradeStrict("55/45", "50/50", "56/44", "50/50");
    expect(r?.subgrade).toBe(10);
    expect(r?.worstAxis).toBe("backLR");
  });
});

describe("centeringScoreDeductions — front-20 / back-5 budget", () => {
  it("perfectly centred → zero deductions", () => {
    expect(centeringScoreDeductions("50/50", "50/50", "50/50", "50/50")).toEqual({ front: 0, back: 0 });
  });
  it("worst front axis drives the front deduction", () => {
    // front 65/35 → -5, front 50/50 → 0; worst (min) is -5
    expect(centeringScoreDeductions("65/35", "50/50", "50/50", "50/50").front).toBe(-5);
  });
  it("worst back axis drives the back deduction", () => {
    // back 88/12 → grade 8 → -2
    expect(centeringScoreDeductions("50/50", "50/50", "88/12", "50/50").back).toBe(-2);
  });
  it("55/45 front boundary spends nothing (grade 10)", () => {
    expect(centeringScoreDeductions("55/45", "50/50", "50/50", "50/50").front).toBe(0);
  });
});
