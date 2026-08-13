import { describe, expect, it, vi } from "vitest";

vi.mock("../server/lib/mvgs-calibration", () => ({
  loadMvgsCalibration: async () => ({
    edgeAffectedPct: 10,
    minorVisibleSplitPct: 25,
    darkBorderMultiplier: 1.25,
    creaseMinorMaxPct: 25,
    creaseHalfMaxPct: 50,
    creaseThreeQuarterMaxPct: 75,
    locked: true,
  }),
}));

import { resolveDraftGradeAuthority } from "../server/lib/draft-grade-authority";

const pristineObservations = {
  gradeType: "numeric",
  authStatus: "genuine",
  centeringFrontLr: "50/50",
  centeringFrontTb: "50/50",
  centeringBackLr: "50/50",
  centeringBackTb: "50/50",
  cornerValues: {},
  edgeValues: {},
  surfaceValues: { hasCrease: false, hasTear: false },
  defects: [],
};

describe("draft grade authority", () => {
  it("ignores browser-supplied overall and subgrade outputs", async () => {
    const authority = await resolveDraftGradeAuthority(pristineObservations, {
      overall_grade: 1,
      grade_centering: 1,
      grade_corners: 1,
      grade_edges: 1,
      grade_surface: 1,
    });

    expect(authority).toMatchObject({
      overall: "10",
      gradeType: "numeric",
      subgrades: { centering: 10, corners: 10, edges: 10, surface: 10 },
      pristine: true,
    });
  });

  it("resolves a lower grade from submitted observations, even when the browser asks for ten", async () => {
    const authority = await resolveDraftGradeAuthority(pristineObservations, {
      overall_grade: 10,
      grade_centering: 10,
      centering_front_lr: "67/33",
    });

    expect(authority.overall).toBe("8");
    expect(authority.subgrades.centering).toBe(7);
  });

  it("issues authentication-only outcomes from the server-owned finding", async () => {
    const altered = await resolveDraftGradeAuthority(pristineObservations, { auth_status: "authentic_altered" });
    const notOriginal = await resolveDraftGradeAuthority(pristineObservations, { auth_status: "not_original" });

    expect(altered).toMatchObject({ overall: "AA", gradeType: "AA", pristine: false });
    expect(notOriginal).toMatchObject({ overall: "NO", gradeType: "NO", pristine: false });
    expect(altered.subgrades).toEqual({ centering: null, corners: null, edges: null, surface: null });
    expect(notOriginal.subgrades).toEqual({ centering: null, corners: null, edges: null, surface: null });
  });

  it("preserves a historical authentication-only kind when no replacement finding is submitted", async () => {
    const authority = await resolveDraftGradeAuthority(
      { ...pristineObservations, gradeType: "NO", authStatus: null },
      {}
    );
    expect(authority).toMatchObject({ overall: "NO", gradeType: "NO", pristine: false });
  });

  it("keeps legacy persisted subgrades when a historical record has no complete measurements", async () => {
    const authority = await resolveDraftGradeAuthority(
      {
        ...pristineObservations,
        centeringFrontLr: null,
        centeringFrontTb: null,
        centeringBackLr: null,
        centeringBackTb: null,
        gradeCentering: 8,
        gradeCorners: 7,
        gradeEdges: 6,
        gradeSurface: 5,
      },
      { overall_grade: 10, grade_centering: 10, grade_corners: 10, grade_edges: 10, grade_surface: 10 }
    );

    expect(authority.subgrades).toEqual({ centering: 8, corners: 7, edges: 6, surface: 5 });
    expect(authority.overall).toBe("6");
  });
});
