/**
 * MVGS half-grade + centering reconciliation — regression matrix.
 *
 * BACKGROUND
 * ==========================================================================
 * Grade 9.5 (Mint+) is published at /standard, listed in NUMERIC_GRADES, given
 * a bracket in GRADE_BRACKET_TOP, named by mvgsTierName, and rendered by both
 * the slab label and the certificate PDF — and had never been issued once. A
 * read of the live production database on 2026-08-22 found 0 of 714 graded
 * certificates holding 9.5, while 140 sat at a lowest subgrade of 9. Cards fell
 * from 10 straight to 9.
 *
 * The cause was not rounding. It was a boundary in the floor rule: the +0.5
 * high-variance bump required an aggregate gap of 4 between the lowest subgrade
 * and the others, but with lowest = 9 the other three subgrades top out at 10
 * and so can never exceed it by more than 3 in total. The bump was
 * arithmetically unreachable at the 9 rung and ONLY at the 9 rung.
 *
 * These tests drive the CANONICAL production code — computeMvgsScore,
 * gradeFromMvgsScore, centeringSubgrade, isPristine and the server-side
 * resolveDraftGradeAuthority that both the Staff and the Partner grading routes
 * call. None of them reimplements the MVGS formula. The one place a formula IS
 * restated is the OLD floor rule in "teeth", and it is restated precisely so
 * the suite can prove it used to fail.
 */
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeMvgsScore,
  gradeFromMvgsScore,
  mvgsTierName,
  MVGS_RULES_VERSION,
  MVGS_RULES_VERSION_LEGACY,
  remainingToGrade,
  type MvgsDefect,
} from "../shared/mvgs-scoring";
import { centeringAxisGrade, centeringSubgrade, centeringChartLines } from "../shared/centering";
import { isPristine, isBlackLabel } from "../shared/pristine";
import { NUMERIC_GRADE_VALUES, isValidNumericGrade, gradeLabel } from "../shared/schema";
import { resolveDraftGradeAuthority } from "../server/lib/draft-grade-authority";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const D = (tier: string, mvgsCode: string, zone: string): MvgsDefect => ({ tier, mvgsCode, zone });
const many = (n: number, d: MvgsDefect) => Array.from({ length: n }, () => d);

/** One front-corner D1 pin = -4 corners. Four of them destroy the category. */
const CORNER_D1 = D("D1", "CN", "FC1");
/** One front-edge D1 pin = -3 edges. */
const EDGE_D1 = D("D1", "WH", "FE1");
/** One front-surface SC D1 pin = -2 surface. */
const SURFACE_D1 = D("D1", "SC", "FA");

/** Score a card through the canonical engine with perfect centering unless told otherwise. */
function grade(
  defects: MvgsDefect[],
  centering: Partial<Record<"frontLr" | "frontTb" | "backLr" | "backTb", string>> = {}
) {
  const r = computeMvgsScore({
    centeringFrontLr: centering.frontLr ?? "50/50",
    centeringFrontTb: centering.frontTb ?? "50/50",
    centeringBackLr: centering.backLr ?? "50/50",
    centeringBackTb: centering.backTb ?? "50/50",
    defects,
    darkBorderFront: false,
    darkBorderBack: false,
    eyeAppealModifier: 0,
  });
  return { ...r, overall: gradeFromMvgsScore(r.score) };
}

// ───────────────────────────────────────────────────────────────────────────
// A–F · the grade values the engine must be able to produce
// ───────────────────────────────────────────────────────────────────────────

describe("A–F · producible grades", () => {
  it("F · awards a legitimate 10 to a flawless card", () => {
    const r = grade([]);
    expect(r.overall).toBe(10);
    expect(r.score).toBe(100);
  });

  it("A · awards a whole-number grade when variance is low", () => {
    // Damage spread evenly across three categories: no single category is far
    // enough below the others to earn the +0.5, so the overall lands whole.
    const r = grade([CORNER_D1, EDGE_D1, SURFACE_D1]);
    expect(r.overall % 1).toBe(0);
    expect(r.overall).toBe(9);
  });

  it("E · awards 9.5 — one front corner on an otherwise flawless card", () => {
    // THE REGRESSION. Subgrades 10 / 9 / 10 / 10, raw score 96. Under v1.3 the
    // aggregate gap of 3 could not reach the fixed threshold of 4, so this card
    // was capped at 9 and 9.5 was unreachable for every card ever graded.
    const r = grade([CORNER_D1]);
    expect(r.overall).toBe(9.5);
    expect(mvgsTierName(r.overall)).toBe("Mint+");
    expect(gradeLabel(r.overall)).toBe("MINT+");
  });

  it("D · awards 8.5", () => {
    const r = grade(many(2, CORNER_D1));
    expect(r.overall).toBe(8.5);
    expect(mvgsTierName(r.overall)).toBe("NM-Mint+");
  });

  it("C · awards 7.5", () => {
    const r = grade(many(5, SURFACE_D1));
    expect(r.overall).toBe(7.5);
    expect(mvgsTierName(r.overall)).toBe("NM+");
  });

  it("B · every half grade on the published ladder is reachable by the engine", () => {
    // Exhaustive sweep of the canonical engine. This is the assertion that
    // would have caught the defect on the day it shipped.
    const seen = new Set<number>();
    const CENTERINGS = ["50/50", "55/45", "58/42", "62/38", "68/32", "72/28", "78/22", "88/12"];
    for (const c of CENTERINGS) {
      for (let corners = 0; corners <= 7; corners++) {
        for (let edges = 0; edges <= 9; edges++) {
          for (let surface = 0; surface <= 14; surface++) {
            const r = grade([...many(corners, CORNER_D1), ...many(edges, EDGE_D1), ...many(surface, SURFACE_D1)], {
              frontLr: c,
            });
            seen.add(r.overall);
          }
        }
      }
    }
    const halves = NUMERIC_GRADE_VALUES.filter((g) => g % 1 !== 0);
    expect(halves.length).toBeGreaterThan(0);
    const unreachable = halves.filter((g) => !seen.has(g));
    expect(unreachable, `unreachable half grades: ${unreachable.join(", ")}`).toEqual([]);
  });

  it("A–F · every grade the engine emits is a legal MVGS grade", () => {
    for (let n = 0; n <= 14; n++) {
      const r = grade(many(n, SURFACE_D1));
      expect(isValidNumericGrade(r.overall), `grade ${r.overall} is not in NUMERIC_GRADE_VALUES`).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G · the lowest-subgrade floor rule
// ───────────────────────────────────────────────────────────────────────────

describe("G · lowest-subgrade cap", () => {
  it("never lets the overall exceed the lowest subgrade by more than 0.5", () => {
    for (let corners = 0; corners <= 7; corners++) {
      for (let surface = 0; surface <= 12; surface++) {
        const defects = [...many(corners, CORNER_D1), ...many(surface, SURFACE_D1)];
        const r = grade(defects);
        const subs = [
          centeringSubgrade("50/50", "50/50", "50/50", "50/50").subgrade,
          remainingToGrade(25 - Math.abs(r.deductions.corners ?? 0)),
          remainingToGrade(25 - Math.abs(r.deductions.edges ?? 0)),
          remainingToGrade(25 - Math.abs(r.deductions.surface ?? 0)),
        ];
        const lowest = Math.min(...subs);
        expect(r.overall, `subs ${subs.join("/")} produced ${r.overall}`).toBeLessThanOrEqual(lowest + 0.5);
      }
    }
  });

  it("a single destroyed category is never hidden by strong scores elsewhere", () => {
    // The example published at /standard: one category at 2, the rest at 10.
    const r = grade(many(11, SURFACE_D1)); // surface -22 → remaining 3 → subgrade 3
    expect(r.overall).toBeLessThanOrEqual(3.5);
  });

  it("low variance still caps hard at the lowest subgrade — no free bump", () => {
    // Subgrades 10 / 9 / 9 / 10: aggregate gap 2, below the rung's own maximum
    // of 3, so no +0.5. This is the case the v1.4 change must NOT loosen.
    const r = grade([CORNER_D1, EDGE_D1]);
    expect(r.overall).toBe(9);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// H–I · Pristine 10P / Black Label
// ───────────────────────────────────────────────────────────────────────────

describe("H–I · Black Label / Pristine 10P", () => {
  const perfect = { centering: 10, corners: 10, edges: 10, surface: 10 };

  it("H · eligible only with overall 10, all four subgrades 10 and zero deductions", () => {
    const r = grade([]);
    expect(isPristine(perfect, gradeFromMvgsScore(r.score), r.deductions)).toBe(true);
    expect(isBlackLabel(perfect, 10, r.deductions)).toBe(true);
  });

  it("I · rejected when one category is below 10", () => {
    expect(isPristine({ ...perfect, edges: 9 }, 10, {})).toBe(false);
    expect(isPristine({ ...perfect, centering: 9 }, 10, {})).toBe(false);
    expect(isPristine({ ...perfect, corners: 9 }, 10, {})).toBe(false);
    expect(isPristine({ ...perfect, surface: 9 }, 10, {})).toBe(false);
  });

  it("I · rejected when subgrades bucket to 10 but a real deduction exists", () => {
    // A card can carry -1.5 corners and still bucket to a 10 chip. It is not Pristine.
    const r = grade(many(3, D("D2", "CN", "FC1")));
    expect(r.deductions.corners).toBeLessThan(0);
    expect(isPristine(perfect, 10, r.deductions)).toBe(false);
  });

  it("I · a 9.5 can never be Black Label", () => {
    const r = grade([CORNER_D1]);
    expect(gradeFromMvgsScore(r.score)).toBe(9.5);
    expect(isPristine({ centering: 10, corners: 9, edges: 10, surface: 10 }, 9.5, r.deductions)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// J–R · centering
// ───────────────────────────────────────────────────────────────────────────

describe("J–R · centering bands", () => {
  const front = (ratio: string) => centeringAxisGrade(ratio, "front");
  const back = (ratio: string) => centeringAxisGrade(ratio, "back");

  it("J · 50/50 front is a 10", () => expect(front("50/50")).toBe(10));
  it("K · 52/48 front is a 10", () => expect(front("52/48")).toBe(10));
  it("L · 53/47 front is a 10 under the published chart", () => expect(front("53/47")).toBe(10));
  it("M · 54/46 front is a 10 under the published chart", () => expect(front("54/46")).toBe(10));
  it("N · 55/45 front is a 10 — the inclusive top of the band", () => expect(front("55/45")).toBe(10));
  it("N · 56/44 front drops to 9 — one point past the boundary", () => expect(front("56/44")).toBe(9));

  it("O · every FRONT band boundary is exact and inclusive", () => {
    const boundaries: Array<[string, number, string, number]> = [
      ["55/45", 10, "56/44", 9],
      ["60/40", 9, "61/39", 8],
      ["65/35", 8, "66/34", 7],
      ["70/30", 7, "71/29", 6],
      ["75/25", 6, "76/24", 5],
      ["80/20", 5, "81/19", 4],
      ["85/15", 4, "86/14", 3],
      ["90/10", 3, "91/9", 2],
      ["95/5", 2, "96/4", 1],
    ];
    for (const [onBand, onGrade, pastBand, pastGrade] of boundaries) {
      expect(front(onBand), `front ${onBand}`).toBe(onGrade);
      expect(front(pastBand), `front ${pastBand}`).toBe(pastGrade);
    }
  });

  it("O · every BACK band boundary is exact and inclusive", () => {
    const boundaries: Array<[string, number, string, number]> = [
      ["75/25", 10, "76/24", 9],
      ["85/15", 9, "86/14", 8],
      ["90/10", 8, "91/9", 6],
      ["95/5", 6, "96/4", 3],
    ];
    for (const [onBand, onGrade, pastBand, pastGrade] of boundaries) {
      expect(back(onBand), `back ${onBand}`).toBe(onGrade);
      expect(back(pastBand), `back ${pastBand}`).toBe(pastGrade);
    }
  });

  it("P · the band function is monotonic — a worse ratio never scores higher", () => {
    for (const side of ["front", "back"] as const) {
      let previous = 11;
      for (let bigger = 50; bigger <= 99; bigger++) {
        const g = centeringAxisGrade(`${bigger}/${100 - bigger}`, side);
        expect(g, `${side} ${bigger}/${100 - bigger} rose above ${bigger - 1}`).toBeLessThanOrEqual(previous);
        previous = g;
      }
    }
  });

  it("Q/R · front is strict and back is lenient at the same ratio", () => {
    expect(front("70/30")).toBe(7);
    expect(back("70/30")).toBe(10);
  });

  it("Q/R · the subgrade is the WORST of the four axes, not an average", () => {
    expect(centeringSubgrade("50/50", "50/50", "50/50", "50/50").subgrade).toBe(10);
    expect(centeringSubgrade("62/38", "50/50", "50/50", "50/50").subgrade).toBe(8);
    expect(centeringSubgrade("50/50", "50/50", "92/8", "50/50").subgrade).toBe(6);
    const worst = centeringSubgrade("62/38", "50/50", "92/8", "50/50");
    expect(worst.subgrade).toBe(6);
    expect(worst.worstAxis).toBe("backLR");
  });

  it("Q/R · centering feeds the overall grade through the floor rule", () => {
    // Front L/R 62/38 → centering subgrade 8, the lowest category on an
    // otherwise flawless card, so the overall cannot exceed 8.5.
    const r = grade([], { frontLr: "62/38" });
    expect(centeringSubgrade("62/38", "50/50", "50/50", "50/50").subgrade).toBe(8);
    expect(r.overall).toBeLessThanOrEqual(8.5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// S–U · server authority, Staff/Partner parity, persistence
// ───────────────────────────────────────────────────────────────────────────

const observations = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

describe("S–U · server authority", () => {
  it("S/T · the ONE authority emits 9.5 for the Staff and Partner paths alike", async () => {
    // Staff (server/routes/grader.ts, capability-gated) and Partner
    // (server/partner grading router) both persist through
    // applyCertGradeDraft → resolveDraftGradeAuthority. Driving the authority
    // directly is therefore driving both workflows' only grade producer.
    const cert = observations({ defects: [{ ...CORNER_D1 }] });
    const authority = await resolveDraftGradeAuthority(cert, {});
    expect(authority.overall).toBe("9.5");
    expect(authority.gradeType).toBe("numeric");
    expect(authority.label).toBe("Mint+");
    expect(authority.pristine).toBe(false);
  });

  it("S/T · a browser-supplied grade is discarded, half grade or not", async () => {
    const authority = await resolveDraftGradeAuthority(observations({ defects: [{ ...CORNER_D1 }] }), {
      overall_grade: 10,
      grade_centering: 10,
      grade_corners: 10,
      grade_edges: 10,
      grade_surface: 10,
    });
    expect(authority.overall).toBe("9.5");
    expect(authority.subgrades.corners).toBe(9);
  });

  it("S/T · Staff and Partner cannot diverge — neither surface computes a grade", () => {
    const partnerGrading = read("client/src/pages/partner/grading.tsx");
    const graderRoutes = read("server/routes/grader.ts");
    for (const src of [partnerGrading, graderRoutes]) {
      expect(src).not.toMatch(/computeMvgsScore|gradeFromMvgsScore\(/);
    }
    // And the one shared producer is the authority module.
    expect(read("server/grader.ts")).toContain("resolveDraftGradeAuthority");
  });

  it("U · a half grade survives persistence and reload unchanged", async () => {
    const first = await resolveDraftGradeAuthority(observations({ defects: [{ ...CORNER_D1 }] }), {});
    // Simulate the round-trip: numeric(4,1) returns a string, which is what the
    // next open feeds back in as the persisted certificate.
    const persisted = Number(first.overall).toFixed(1);
    expect(persisted).toBe("9.5");
    expect(Number(persisted)).toBe(9.5);
    const reopened = await resolveDraftGradeAuthority(
      observations({ defects: [{ ...CORNER_D1 }], gradeOverall: persisted }),
      {}
    );
    expect(reopened.overall).toBe("9.5");
  });

  it("U · the 0111 backfill names the ruleset historical grades were issued under", () => {
    // The migration's literal and the code constant must agree, or the 714 rows it stamps
    // would claim a ruleset they were not graded under.
    const migration = read("migrations/0111_mvgs_rules_version.sql");
    expect(MVGS_RULES_VERSION_LEGACY).toBe("v1.3");
    expect(MVGS_RULES_VERSION).not.toBe(MVGS_RULES_VERSION_LEGACY);
    expect(migration).toContain(`SET mvgs_rules_version = '${MVGS_RULES_VERSION_LEGACY}'`);
    // It must touch NOTHING but the new column. Checked against the EXECUTABLE SQL only —
    // the file's reversibility note quotes the undo statement in a comment, which is
    // documentation rather than something this migration runs.
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS mvgs_rules_version text");
    const executableSql = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(executableSql).not.toMatch(
      /SET\s+(grade|centering_score|corners_score|edges_score|surface_score|label_type)\b/i
    );
    expect(executableSql).not.toMatch(/\bDROP\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
  });

  it("U · every grade write is stamped with the MVGS ruleset version", async () => {
    const authority = await resolveDraftGradeAuthority(observations({ defects: [{ ...CORNER_D1 }] }), {});
    expect(authority.rulesVersion).toBe(MVGS_RULES_VERSION);
    expect(MVGS_RULES_VERSION).toMatch(/^v\d+\.\d+$/);
    // Non-numeric outcomes are stamped too — the ruleset governed the decision.
    const altered = await resolveDraftGradeAuthority(observations({ authStatus: "authentic_altered" }), {});
    expect(altered.gradeType).toBe("AA");
    expect(altered.rulesVersion).toBe(MVGS_RULES_VERSION);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// V–W · presentation
// ───────────────────────────────────────────────────────────────────────────

describe("V–W · certificate, label and PDF presentation", () => {
  it("V · the tier name matches the number for every half grade", () => {
    expect(mvgsTierName(9.5)).toBe("Mint+");
    expect(mvgsTierName(8.5)).toBe("NM-Mint+");
    expect(mvgsTierName(7.5)).toBe("NM+");
    // A half grade must never borrow the tier above it.
    expect(mvgsTierName(9.5)).not.toBe(mvgsTierName(10));
    expect(mvgsTierName(8.5)).not.toBe(mvgsTierName(9));
  });

  it("V · the slab abbreviation matches the number for every half grade", () => {
    expect(gradeLabel(9.5)).toBe("MINT+");
    expect(gradeLabel(9)).toBe("MINT");
    expect(gradeLabel(8.5)).toBe("NM-MT+");
  });

  it("W · the label renderer prints the true half grade, never a rounded one", () => {
    const labels = read("server/labels.ts");
    // The renderer parses the stored grade and prints it as-is. Any reintroduced
    // rounding of the grade value would overstate the card by half a tier.
    expect(labels).toContain("parseStoredGrade(cert.gradeOverall)");
    expect(labels).not.toMatch(/Math\.round\(\s*(parsedGrade|grade)\s*\)/);
  });

  it("W · the certificate PDF only drops the decimal on a whole grade", () => {
    const doc = read("server/certificate-document.ts");
    // parseInt is legitimate ONLY behind the `% 1 === 0` whole-number guard.
    expect(doc).toContain("parseFloat(String(cert.gradeOverall)) % 1 === 0");
    expect(doc).toContain("parseFloat(String(cert.gradeOverall)).toFixed(1)");
  });

  it("W · the grade column can hold a half grade", () => {
    const schema = read("shared/schema.ts");
    expect(schema).toContain('gradeOverall: decimal("grade", { precision: 4, scale: 1 })');
    expect(NUMERIC_GRADE_VALUES).toContain(9.5);
    expect(isValidNumericGrade(9.5)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §10 · TEETH — these must FAIL against the pre-fix behaviour
// ───────────────────────────────────────────────────────────────────────────

/**
 * The v1.3 floor rule, restated verbatim so the suite can demonstrate what it
 * used to do. This is the ONLY place in this file that reimplements MVGS
 * maths, and it exists precisely to be compared against the live engine.
 *
 *     let maxGrade = gap >= 4 ? lowest + 0.5 : lowest;
 */
function v13FloorRule(lowest: number, gap: number): number {
  return gap >= 4 ? lowest + 0.5 : lowest;
}

/** Resolve a card through the canonical engine, then re-resolve the same
 *  canonical inputs under the v1.3 floor rule. Inputs are restricted to plain
 *  corner/edge/surface pins and centering, so no structural ceiling or CR
 *  force-cap is in play and the raw score is simply 100 + deductions. */
function bothRules(defects: MvgsDefect[], frontLr = "50/50") {
  const r = grade(defects, { frontLr });
  const raw = Math.max(1, Math.min(100, Math.round(100 + Object.values(r.deductions).reduce((a, b) => a + b, 0))));
  const subs = [
    centeringSubgrade(frontLr, "50/50", "50/50", "50/50").subgrade,
    remainingToGrade(25 - Math.abs(r.deductions.corners ?? 0)),
    remainingToGrade(25 - Math.abs(r.deductions.edges ?? 0)),
    remainingToGrade(25 - Math.abs(r.deductions.surface ?? 0)),
  ];
  const lowest = Math.min(...subs);
  const gap = subs.filter((s) => s !== lowest).reduce((sum, s) => sum + (s - lowest), 0);
  const old = Math.min(gradeFromMvgsScore(raw), v13FloorRule(lowest, gap));
  return { current: r.overall, old, lowest, gap, subs };
}

describe("§10 · teeth — the fix is real and it is surgical", () => {
  it("would have FAILED before the fix: one front corner used to grade 9, not 9.5", () => {
    const { current, old, lowest, gap } = bothRules([CORNER_D1]);
    expect(lowest).toBe(9);
    expect(gap).toBe(3); // the maximum gap the 9 rung can ever produce
    expect(old).toBe(9); // v1.3 — the bug
    expect(current).toBe(9.5); // v1.4 — the fix
    expect(current).not.toBe(old);
  });

  it("9.5 was UNREACHABLE under v1.3 across an exhaustive sweep", () => {
    const oldSeen = new Set<number>();
    const newSeen = new Set<number>();
    for (const c of ["50/50", "55/45", "58/42", "62/38", "68/32", "72/28"]) {
      for (let corners = 0; corners <= 7; corners++) {
        for (let edges = 0; edges <= 9; edges++) {
          for (let surface = 0; surface <= 13; surface++) {
            const b = bothRules(
              [...many(corners, CORNER_D1), ...many(edges, EDGE_D1), ...many(surface, SURFACE_D1)],
              c
            );
            oldSeen.add(b.old);
            newSeen.add(b.current);
          }
        }
      }
    }
    expect(oldSeen.has(9.5), "v1.3 should never have been able to emit 9.5").toBe(false);
    expect(newSeen.has(9.5), "v1.4 must be able to emit 9.5").toBe(true);
  });

  it("SURGICAL: the two rules agree on every card whose lowest subgrade is not 9", () => {
    const divergences: string[] = [];
    for (const c of ["50/50", "55/45", "58/42", "62/38", "68/32", "72/28", "78/22", "88/12"]) {
      for (let corners = 0; corners <= 7; corners++) {
        for (let edges = 0; edges <= 9; edges++) {
          for (let surface = 0; surface <= 13; surface++) {
            const b = bothRules(
              [...many(corners, CORNER_D1), ...many(edges, EDGE_D1), ...many(surface, SURFACE_D1)],
              c
            );
            if (b.current === b.old) continue;
            if (b.lowest !== 9) {
              divergences.push(`subs ${b.subs.join("/")} · v1.3 ${b.old} → v1.4 ${b.current}`);
            }
          }
        }
      }
    }
    expect(divergences.slice(0, 10), `v1.4 moved a grade at a rung other than 9`).toEqual([]);
  });

  it("SURGICAL: at the 9 rung only maximum variance moves — 9/9/10/10 still grades 9", () => {
    const two = bothRules([CORNER_D1, EDGE_D1]); // subs 10/9/9/10
    expect(two.lowest).toBe(9);
    expect(two.gap).toBe(2);
    expect(two.current).toBe(9);
    expect(two.current).toBe(two.old); // unchanged by the fix
  });

  it("a perfect card is not bumped to 10.5 by the relative threshold", () => {
    const r = grade([]);
    expect(gradeFromMvgsScore(r.score)).toBe(10);
    expect(isValidNumericGrade(gradeFromMvgsScore(r.score))).toBe(true);
  });

  it("would have FAILED before the fix: subgrade 4 was unreachable in the grade authority", () => {
    // server/lib/draft-grade-authority.ts carried a hand-copied remainingToGrade
    // that was missing the `>= 5 → 4` rung, so a category holding 5–7 remaining
    // points persisted a 3 while the engine's own floor rule scored it a 4.
    const drifted = (remaining: number) => {
      if (remaining >= 23) return 10;
      if (remaining >= 20) return 9;
      if (remaining >= 17) return 8;
      if (remaining >= 14) return 7;
      if (remaining >= 11) return 6;
      if (remaining >= 8) return 5;
      if (remaining >= 3) return 3; // the `>= 5 → 4` rung is missing here
      if (remaining >= 1) return 2;
      return 1;
    };
    for (const remaining of [5, 6, 7]) {
      expect(drifted(remaining)).toBe(3);
      expect(remainingToGrade(remaining)).toBe(4);
    }
    // And every other input still agrees, so this really was a single missing rung.
    for (let remaining = 0; remaining <= 25; remaining++) {
      if (remaining >= 5 && remaining <= 7) continue;
      expect(drifted(remaining), `remaining ${remaining}`).toBe(remainingToGrade(remaining));
    }
  });

  it("would have FAILED before the fix: the authority now persists subgrade 4", async () => {
    // 9 x surface SC D1 = -18 -> 7 remaining -> subgrade 4. The drifted copy in
    // the authority returned 3 here, so no certificate could ever carry a
    // surface/corners/edges subgrade of 4 while the engine's floor rule scored
    // one. This is the behavioural half of the source guard below.
    const authority = await resolveDraftGradeAuthority(observations({ defects: many(9, SURFACE_D1) }), {});
    expect(authority.subgrades.surface).toBe(4);
    expect(remainingToGrade(7)).toBe(4);
  });

  it("the drifted copy cannot come back — the authority imports the canonical ladder", () => {
    const authority = read("server/lib/draft-grade-authority.ts");
    expect(authority).toContain('from "@shared/mvgs-scoring"');
    expect(authority).toContain("remainingToGrade");
    // No local redefinition of the ladder in the authority module.
    expect(authority).not.toMatch(/function\s+remainingToGrade\s*\(/);
  });

  it("would have FAILED before the fix: the AI prompts no longer restate the chart by hand", () => {
    const prompts = read("server/grading-prompt.ts");
    // The four hand-written charts all claimed thresholds the engine does not
    // use — two of them said a 10 required 52/48 or better while the engine and
    // the published standard both allow 55/45.
    expect(prompts).not.toContain("50/50 to 52/48");
    expect(prompts).not.toMatch(/10=55\/45 or better/);
    expect(prompts).toContain("centeringChartText");
    expect(prompts).toContain("CENTERING_CHART");
  });

  it("the AI advisory chart is generated from the SAME bands the engine scores against", () => {
    const lines = centeringChartLines("front");
    // The rendered chart must name 55/45 as the top of the 10 band, matching
    // centeringAxisGrade and the published /standard table.
    expect(lines[0]).toBe("- 10: 55/45 or better");
    expect(centeringAxisGrade("55/45", "front")).toBe(10);
    expect(centeringAxisGrade("56/44", "front")).toBe(9);
    // Back chart likewise.
    expect(centeringChartLines("back")[0]).toBe("- 10: 75/25 or better");
    expect(centeringAxisGrade("75/25", "back")).toBe(10);
  });

  it("the published /standard page states the rule the engine actually applies", () => {
    // Collapse JSX line-wrapping before matching prose — Prettier owns where
    // these sentences break, and the assertion is about the words, not the wrap.
    const std = read("client/src/pages/standard.tsx");
    const prose = std.replace(/\s+/g, " ");
    expect(prose).toContain("MVGS v1.4");
    expect(prose).toContain("the threshold is the largest gap that rung can produce");
    expect(prose).toContain("9 / 10 / 10 / 10 qualifies and 9 / 9 / 10 / 10 does not");
    expect(prose).toContain("Each certificate records the MVGS version it was graded under");
    // The published centering table still matches the engine's front bands.
    expect(std).toContain('{ ratio: "≤ 55/45", grade: "10", deduction: "0" }');
  });

  it("approved grades are protected: both write paths refuse an approved certificate", () => {
    const graderSrc = read("server/grader.ts");
    expect(graderSrc).toContain("grade_approved_at IS NULL");
    expect(graderSrc).toContain("mvgs_rules_version = ${authority.rulesVersion}");
  });
});
