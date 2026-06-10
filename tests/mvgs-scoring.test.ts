import { describe, it, expect } from "vitest";
import {
  computeMvgsScore,
  gradeFromMvgsScore,
  mvgsGradeLabel,
  legacyCeilingForFlags,
  DEFAULT_MVGS_CALIBRATION,
  type MvgsInput,
} from "../shared/mvgs-scoring";

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

describe("gradeFromMvgsScore — /standard band table", () => {
  // Each pair = the top and bottom of a band, mapped to its grade. The band
  // table is aligned to the /standard publication — full half-grade ladder
  // top to bottom, including 9.5 (Mint+) at 86-90.
  it.each([
    [100, 10], // Pristine 10P top
    [96, 10], // Pristine 10P bottom
    [95, 10], // Gem Mint top
    [91, 10], // Gem Mint bottom
    [90, 9.5], // Mint+ top
    [86, 9.5], // Mint+ bottom
    [85, 9], // Mint top
    [81, 9], // Mint bottom
    [80, 8.5], // NM-Mint+ top
    [76, 8.5], // NM-Mint+ bottom
    [75, 8], // NM-Mint top
    [71, 8], // NM-Mint bottom
    [70, 7.5], // NM+ top
    [66, 7.5], // NM+ bottom
    [65, 7], // Near Mint top
    [61, 7], // Near Mint bottom
    [60, 6.5], // EX-Mint+ top
    [56, 6.5], // EX-Mint+ bottom
    [55, 6], // EX-Mint top
    [51, 6], // EX-Mint bottom
    [50, 5.5], // Excellent+ top
    [46, 5.5], // Excellent+ bottom
    [45, 5], // Excellent top
    [41, 5], // Excellent bottom
    [40, 4.5], // VG-EX+ top
    [36, 4.5], // VG-EX+ bottom
    [35, 4], // VG-EX top
    [31, 4], // VG-EX bottom
    [30, 3.5], // VG+ top
    [26, 3.5], // VG+ bottom
    [25, 3], // Very Good top
    [21, 3], // Very Good bottom
    [20, 2.5], // Good+ top
    [16, 2.5], // Good+ bottom
    [15, 2], // Good top
    [11, 2], // Good bottom
    [10, 1.5], // Fair top
    [6, 1.5], // Fair bottom
    [5, 1], // Poor top
    [1, 1], // Poor bottom
  ])("score %i → grade %s", (score, expected) => {
    expect(gradeFromMvgsScore(score)).toBe(expected);
  });
});

describe("mvgsGradeLabel — /standard band table", () => {
  it.each([
    [100, "Pristine 10P"],
    [96, "Pristine 10P"],
    [95, "Gem Mint"],
    [91, "Gem Mint"],
    [90, "Mint+"],
    [86, "Mint+"],
    [85, "Mint"],
    [81, "Mint"],
    [80, "NM-Mint+"],
    [76, "NM-Mint+"],
    [75, "NM-Mint"],
    [71, "NM-Mint"],
    [70, "NM+"],
    [66, "NM+"],
    [65, "Near Mint"],
    [61, "Near Mint"],
    [60, "EX-Mint+"],
    [56, "EX-Mint+"],
    [55, "EX-Mint"],
    [51, "EX-Mint"],
    [50, "Excellent+"],
    [46, "Excellent+"],
    [45, "Excellent"],
    [41, "Excellent"],
    [40, "VG-EX+"],
    [36, "VG-EX+"],
    [35, "VG-EX"],
    [31, "VG-EX"],
    [30, "VG+"],
    [26, "VG+"],
    [25, "Very Good"],
    [21, "Very Good"],
    [20, "Good+"],
    [16, "Good+"],
    [15, "Good"],
    [11, "Good"],
    [10, "Fair"],
    [6, "Fair"],
    [5, "Poor"],
    [1, "Poor"],
  ])("score %i → %s", (score, expected) => {
    expect(mvgsGradeLabel(score)).toBe(expected);
  });
});

// ── MVGS v2 — measurement-based ceilings + whitening ladder ──────────────
// All tests below exercise the v2 additions (docs/MVGS-v2-spec.md). They
// assert on result fields that v1 didn't carry — ceiling, edgesSubgradeFromWhitening,
// tearForceNotGraded — and verify backward compat: omitting all v2 fields keeps
// existing scoring identical.

describe("MVGS v2 — backward compat", () => {
  it("perfect card with no v2 fields returns null ceiling, null whitening subgrade", () => {
    const r = computeMvgsScore(baseInput());
    expect(r.ceiling).toBeNull();
    expect(r.edgesSubgradeFromWhitening).toBeNull();
    expect(r.tearForceNotGraded).toBe(false);
  });
});

describe("MVGS v2 — crease ceiling (spec §4)", () => {
  it("minor crease <25% span caps at 4.5", () => {
    const r = computeMvgsScore(baseInput({ creaseSpanPct: 10 }));
    expect(r.ceiling?.source).toBe("crease");
    expect(r.ceiling?.grade).toBe(4.5);
    // Floor rule caps score at top of 4.5 bracket = 40.
    expect(r.score).toBeLessThanOrEqual(40);
  });

  it("~half-across crease (25-50%) caps at 4", () => {
    const r = computeMvgsScore(baseInput({ creaseSpanPct: 40 }));
    expect(r.ceiling?.grade).toBe(4);
    expect(r.score).toBeLessThanOrEqual(35);
  });

  it("~three-quarters crease (50-75%) caps at 3.5", () => {
    const r = computeMvgsScore(baseInput({ creaseSpanPct: 60 }));
    expect(r.ceiling?.grade).toBe(3.5);
    expect(r.score).toBeLessThanOrEqual(30);
  });

  it("full-length crease >75% caps at 3", () => {
    const r = computeMvgsScore(baseInput({ creaseSpanPct: 90 }));
    expect(r.ceiling?.grade).toBe(3);
    expect(r.score).toBeLessThanOrEqual(25);
  });

  it("zero / null crease span = no ceiling", () => {
    expect(computeMvgsScore(baseInput({ creaseSpanPct: 0 })).ceiling).toBeNull();
    expect(computeMvgsScore(baseInput({ creaseSpanPct: null })).ceiling).toBeNull();
  });
});

describe("MVGS v2 — wrinkle ceiling (spec §4)", () => {
  it.each([
    ["tiny_back", 6.5],
    ["longer_back", 6],
    ["small_front", 5.5],
    ["multiple_front", 5],
  ] as const)("severity %s caps at %s", (sev, expected) => {
    const r = computeMvgsScore(baseInput({ wrinkleSeverity: sev }));
    expect(r.ceiling?.source).toBe("wrinkle");
    expect(r.ceiling?.grade).toBe(expected);
  });
});

describe("MVGS v2 — tear ceiling + NO routing (spec §4)", () => {
  it("minor tear caps at 2", () => {
    const r = computeMvgsScore(baseInput({ tearSeverity: "minor" }));
    expect(r.ceiling?.grade).toBe(2);
    expect(r.tearForceNotGraded).toBe(false);
  });

  it("significant tear caps at 1.5", () => {
    const r = computeMvgsScore(baseInput({ tearSeverity: "significant" }));
    expect(r.ceiling?.grade).toBe(1.5);
    expect(r.tearForceNotGraded).toBe(false);
  });

  it("major tear forces NO (non-numeric) outcome", () => {
    const r = computeMvgsScore(baseInput({ tearSeverity: "major" }));
    expect(r.tearForceNotGraded).toBe(true);
    expect(r.ceiling?.source).toBe("tear");
    // Caller treats forceNotGraded=true as gradeType=non_numeric / "NO".
    // Engine still surfaces a numeric score for completeness.
    expect(r.score).toBeGreaterThanOrEqual(1);
  });
});

describe("MVGS v2 — worst-ceiling resolution (spec §5 DINGS)", () => {
  it("wrinkle + minor tear → tear wins (lower ceiling)", () => {
    const r = computeMvgsScore(baseInput({ wrinkleSeverity: "tiny_back", tearSeverity: "minor" }));
    expect(r.ceiling?.source).toBe("tear");
    expect(r.ceiling?.grade).toBe(2);
  });

  it("crease + wrinkle → strictest wins (crease half-across vs small-front wrinkle)", () => {
    const r = computeMvgsScore(baseInput({ creaseSpanPct: 40, wrinkleSeverity: "small_front" }));
    // crease 25-50% → 4; small_front wrinkle → 5.5; crease (4) is stricter.
    expect(r.ceiling?.source).toBe("crease");
    expect(r.ceiling?.grade).toBe(4);
  });
});

describe("MVGS v2 — whitening edges ladder (spec §3)", () => {
  function whiteningOnly(edges: NonNullable<MvgsInput["whiteningEdges"]>): MvgsInput {
    return baseInput({ whiteningEdges: edges });
  }

  it("no edges supplied → null whitening subgrade (legacy path)", () => {
    expect(computeMvgsScore(baseInput()).edgesSubgradeFromWhitening).toBeNull();
  });

  it("empty array → null whitening subgrade", () => {
    expect(computeMvgsScore(baseInput({ whiteningEdges: [] })).edgesSubgradeFromWhitening).toBeNull();
  });

  it("clean / hi-res only (all under 10%) → 10", () => {
    const r = computeMvgsScore(
      whiteningOnly([
        { side: "front", edge: "top", coveragePct: 5 },
        { side: "front", edge: "left", coveragePct: 3 },
      ])
    );
    expect(r.edgesSubgradeFromWhitening).toBe(10);
  });

  it("minor whitening 1-2 edges (10-25% coverage) → 9", () => {
    const r = computeMvgsScore(
      whiteningOnly([
        { side: "front", edge: "top", coveragePct: 15 },
        { side: "front", edge: "left", coveragePct: 12 },
      ])
    );
    expect(r.edgesSubgradeFromWhitening).toBe(9);
  });

  it("visible multiple edges front (>25% on 2+ front edges) → 8.5", () => {
    const r = computeMvgsScore(
      whiteningOnly([
        { side: "front", edge: "top", coveragePct: 40 },
        { side: "front", edge: "left", coveragePct: 35 },
      ])
    );
    expect(r.edgesSubgradeFromWhitening).toBe(8.5);
  });

  it("all four edges affected → 8", () => {
    const r = computeMvgsScore(
      whiteningOnly([
        { side: "front", edge: "top", coveragePct: 15 },
        { side: "front", edge: "right", coveragePct: 15 },
        { side: "front", edge: "bottom", coveragePct: 15 },
        { side: "front", edge: "left", coveragePct: 15 },
      ])
    );
    expect(r.edgesSubgradeFromWhitening).toBe(8);
  });

  it("dark-border multiplier escalates coverage: 8% × 1.25 = 10% (affected)", () => {
    // Without dark border: 8% < 10% threshold → not affected → 10 (clean).
    const light = computeMvgsScore(
      baseInput({
        whiteningEdges: [
          { side: "front", edge: "top", coveragePct: 8 },
          { side: "front", edge: "left", coveragePct: 8 },
        ],
      })
    );
    expect(light.edgesSubgradeFromWhitening).toBe(10);
    // With dark front border: 8% × 1.25 = 10% → both edges affected → 9.
    const dark = computeMvgsScore(
      baseInput({
        darkBorderFront: true,
        whiteningEdges: [
          { side: "front", edge: "top", coveragePct: 8 },
          { side: "front", edge: "left", coveragePct: 8 },
        ],
      })
    );
    expect(dark.edgesSubgradeFromWhitening).toBe(9);
  });

  it("dedupe: same edge marked twice — only counts once with worst coverage", () => {
    const r = computeMvgsScore(
      whiteningOnly([
        { side: "front", edge: "top", coveragePct: 5 },
        { side: "front", edge: "top", coveragePct: 40 },
      ])
    );
    // Worst is 40% on a single edge → 1 affected edge → 9 (minor 1-2).
    expect(r.edgesSubgradeFromWhitening).toBe(9);
  });
});

describe("MVGS v2 — legacyCeilingForFlags (consolidation single source of truth)", () => {
  it("no flags → no ceiling", () => {
    expect(legacyCeilingForFlags({ hasCrease: false, hasTear: false })).toBeNull();
  });

  it("crease flag → 4.5 cap (least-severe new bracket)", () => {
    expect(legacyCeilingForFlags({ hasCrease: true, hasTear: false })?.grade).toBe(4.5);
  });

  it("tear flag → 2 cap (minor tear; major tear is its own explicit input)", () => {
    expect(legacyCeilingForFlags({ hasCrease: false, hasTear: true })?.grade).toBe(2);
  });

  it("both flags → tear wins (stricter)", () => {
    expect(legacyCeilingForFlags({ hasCrease: true, hasTear: true })?.grade).toBe(2);
  });
});

describe("MVGS v2 — calibration overrides", () => {
  it("custom edge-affected threshold changes the affected count", () => {
    // Edges at 6% coverage are NOT affected under the default 10% threshold,
    // so the engine returns 10 (clean).
    const def = computeMvgsScore(
      baseInput({
        whiteningEdges: [
          { side: "front", edge: "top", coveragePct: 6 },
          { side: "front", edge: "left", coveragePct: 6 },
        ],
      })
    );
    expect(def.edgesSubgradeFromWhitening).toBe(10);
    // Lower the threshold to 5% — now both count as affected.
    const lo = computeMvgsScore(
      baseInput({
        whiteningEdges: [
          { side: "front", edge: "top", coveragePct: 6 },
          { side: "front", edge: "left", coveragePct: 6 },
        ],
        calibration: { ...DEFAULT_MVGS_CALIBRATION, edgeAffectedPct: 5 },
      })
    );
    expect(lo.edgesSubgradeFromWhitening).toBe(9);
  });

  it("custom crease cutoff moves the ceiling boundary", () => {
    // Default: 30% span → 4 (25-50% bracket).
    expect(computeMvgsScore(baseInput({ creaseSpanPct: 30 })).ceiling?.grade).toBe(4);
    // Raise the minor cutoff to 35% — 30% now falls into the <minor bracket = 4.5.
    expect(
      computeMvgsScore(
        baseInput({
          creaseSpanPct: 30,
          calibration: { ...DEFAULT_MVGS_CALIBRATION, creaseMinorMaxPct: 35 },
        })
      ).ceiling?.grade
    ).toBe(4.5);
  });
});
