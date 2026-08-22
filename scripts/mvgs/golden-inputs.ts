/**
 * The MVGS v1.4 golden corpus INPUTS.
 *
 * Inputs live in source (reviewable, diffable); EXPECTATIONS live in the
 * generated fixture. That split matters: adding a case is an ordinary reviewed
 * change, whereas changing what the engine is expected to return requires the
 * deliberate regeneration flag.
 *
 * Coverage is driven by what actually broke or could break, not by round
 * numbers: every grade rung including the half grades, the 9.5 rung whose
 * unreachability went unnoticed for months, every centering band boundary and
 * the point either side of it, the floor rule, the structural ceilings, the
 * Pristine gate and its false-positive rejection.
 */
import type { MvgsV2PersistedFields } from "../../shared/mvgs-input-builder";

export interface GoldenCase {
  id: string;
  description: string;
  input: MvgsV2PersistedFields;
}

const D = (tier: string, mvgsCode: string, zone: string) => ({ tier, mvgsCode, zone });
const many = (n: number, d: ReturnType<typeof D>) => Array.from({ length: n }, () => d);

const CORNER_D1 = D("D1", "CN", "FC1");
const CORNER_D1_B = D("D1", "CN", "FC2");
const EDGE_D1 = D("D1", "WH", "FE1");
const SURFACE_SC = D("D1", "SC", "FA");
const SURFACE_SP = D("D1", "SP", "FA");
const CORNER_D2 = D("D2", "CN", "FC3");
const EDGE_D2 = D("D2", "WH", "FE2");
const SURFACE_PL = D("D2", "PL", "FB");
const BACK_CORNER_D1 = D("D1", "CN", "BC1");
const BACK_SURFACE_SC = D("D1", "SC", "BA");

function base(over: Partial<MvgsV2PersistedFields> = {}): MvgsV2PersistedFields {
  return {
    centeringFrontLr: "50/50",
    centeringFrontTb: "50/50",
    centeringBackLr: "50/50",
    centeringBackTb: "50/50",
    defects: [],
    darkBorderFront: false,
    darkBorderBack: false,
    eyeAppealModifier: 0,
    whiteningLines: [],
    creaseLines: [],
    creaseSpanPct: null,
    wrinkleSeverity: null,
    tearSeverity: null,
    hasCrease: false,
    hasTear: false,
    ...over,
  } as MvgsV2PersistedFields;
}

export function buildVectorInputs(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const add = (id: string, description: string, input: MvgsV2PersistedFields) => cases.push({ id, description, input });

  // ── grade rungs, including every half grade ──────────────────────────────
  add("grade-10-flawless", "no defects, perfect centering → 10", base());
  add(
    "grade-9.5-one-front-corner",
    "1 front-corner D1 → 9.5 (the rung that was unreachable before v1.4)",
    base({ defects: [CORNER_D1] })
  );
  add("grade-9-low-variance", "1 corner + 1 edge D1 → 9, no +0.5 bump", base({ defects: [CORNER_D1, EDGE_D1] }));
  add("grade-8.5-two-front-corners", "2 front-corner D1 → 8.5", base({ defects: [CORNER_D1, CORNER_D1_B] }));
  add(
    "grade-8-spread",
    "corners + edges + surface spread → 8",
    base({ defects: [CORNER_D1, CORNER_D1_B, EDGE_D1, ...many(2, SURFACE_SC)] })
  );
  add(
    "grade-8-even-wear",
    "corners/edges/surface all bucket to 8, low variance → 8",
    base({
      defects: [...many(2, CORNER_D1), ...many(2, EDGE_D1), ...many(4, SURFACE_SC)],
    })
  );
  add(
    "grade-7-even-wear",
    "corners/edges/surface all bucket to 7, low variance → 7",
    base({
      defects: [
        ...many(2, CORNER_D1),
        ...many(2, CORNER_D2),
        ...many(3, EDGE_D1),
        ...many(4, SURFACE_SC),
        ...many(2, SURFACE_PL),
      ],
    })
  );
  add("grade-7.5-surface", "5 surface SC D1 → 7.5", base({ defects: many(5, SURFACE_SC) }));
  for (let n = 6; n <= 13; n++) {
    add(`surface-sc-x${n}`, `${n} surface SC D1 — walks the lower rungs`, base({ defects: many(n, SURFACE_SC) }));
  }
  for (let n = 1; n <= 6; n++) {
    add(`front-corner-d1-x${n}`, `${n} front-corner D1`, base({ defects: many(n, CORNER_D1) }));
  }
  for (let n = 1; n <= 8; n++) {
    add(`front-edge-d1-x${n}`, `${n} front-edge D1`, base({ defects: many(n, EDGE_D1) }));
  }

  // ── each defect category, and side asymmetry ─────────────────────────────
  add("category-corners-d2", "corner D2 pins only", base({ defects: many(4, CORNER_D2) }));
  add("category-edges-d2", "edge D2 pins only", base({ defects: many(4, EDGE_D2) }));
  add("category-surface-d2", "surface PL D2 pins only", base({ defects: many(4, SURFACE_PL) }));
  add("surface-sp-holo-multiplier", "SP D1 in the front art/holo zone (x1.5)", base({ defects: [SURFACE_SP] }));
  add("back-corner-is-lighter", "back-corner D1 vs front-corner D1", base({ defects: [BACK_CORNER_D1] }));
  add("back-surface-half-multiplier", "back-surface SC D1 (x0.5)", base({ defects: [BACK_SURFACE_SC] }));
  add(
    "dark-border-front-wh",
    "front-edge WH D1 with a dark front border (x1.25)",
    base({ defects: many(2, EDGE_D1), darkBorderFront: true })
  );
  add(
    "dark-border-back-only",
    "dark back border does not affect front edges",
    base({ defects: many(2, EDGE_D1), darkBorderBack: true })
  );

  // ── combinations ─────────────────────────────────────────────────────────
  add(
    "combo-all-four-categories",
    "centering + corners + edges + surface together",
    base({ centeringFrontLr: "62/38", defects: [CORNER_D1, EDGE_D1, SURFACE_SC] })
  );
  add("combo-eye-appeal-plus", "eye appeal +2", base({ defects: [CORNER_D1], eyeAppealModifier: 2 }));
  add("combo-eye-appeal-minus", "eye appeal -2", base({ defects: [CORNER_D1], eyeAppealModifier: -2 }));
  add("combo-crease-cr-d1", "CR D1 crease forces the hard 74 score cap", base({ defects: [D("D1", "CR", "FA")] }));

  // ── structural ceilings ──────────────────────────────────────────────────
  for (const pct of [10, 25, 26, 50, 51, 75, 76, 100]) {
    add(`ceiling-crease-span-${pct}`, `crease spanning ${pct}% of the card axis`, base({ creaseSpanPct: pct }));
  }
  for (const sev of ["tiny_back", "longer_back", "small_front", "multiple_front"] as const) {
    add(`ceiling-wrinkle-${sev}`, `wrinkle severity ${sev}`, base({ wrinkleSeverity: sev }));
  }
  for (const sev of ["minor", "significant", "major"] as const) {
    add(`ceiling-tear-${sev}`, `tear severity ${sev}`, base({ tearSeverity: sev }));
  }

  // ── whitening ladder ─────────────────────────────────────────────────────
  add(
    "whitening-one-edge",
    "one front edge, 40% coverage",
    base({ whiteningLines: [{ side: "front", edge: "top", coveragePct: 40 }] as never })
  );
  add(
    "whitening-all-four-front",
    "all four front edges affected",
    base({
      whiteningLines: (["top", "right", "bottom", "left"] as const).map((edge) => ({
        side: "front",
        edge,
        coveragePct: 40,
      })) as never,
    })
  );

  // ── centering: named boundaries, then every band edge and its neighbours ──
  for (const ratio of ["50/50", "52/48", "53/47", "54/46", "55/45", "56/44"]) {
    add(`centering-front-lr-${ratio.replace("/", "-")}`, `front L/R ${ratio}`, base({ centeringFrontLr: ratio }));
  }
  for (const b of [55, 60, 65, 70, 75, 80, 85, 90, 95]) {
    for (const v of [b, b + 1]) {
      add(
        `centering-front-boundary-${v}`,
        `front L/R ${v}/${100 - v} (band edge ${b} and just past)`,
        base({ centeringFrontLr: `${v}/${100 - v}` })
      );
    }
  }
  for (const b of [75, 85, 90, 95]) {
    for (const v of [b, b + 1]) {
      add(
        `centering-back-boundary-${v}`,
        `back L/R ${v}/${100 - v} (band edge ${b} and just past)`,
        base({ centeringBackLr: `${v}/${100 - v}` })
      );
    }
  }
  add(
    "centering-worst-of-four",
    "worst axis wins across front and back",
    base({ centeringFrontLr: "62/38", centeringBackLr: "92/8" })
  );
  add("centering-front-tb-axis", "front T/B drives the subgrade", base({ centeringFrontTb: "68/32" }));
  add("centering-back-tb-axis", "back T/B drives the subgrade", base({ centeringBackTb: "88/12" }));

  // ── Pristine / Black Label ───────────────────────────────────────────────
  add("pristine-eligible", "flawless, zero deductions → Black Label eligible", base());
  add(
    "pristine-rejected-tiny-d2",
    "buckets to 10 chips but carries a real D2 deduction",
    base({ defects: [CORNER_D2] })
  );
  add("pristine-rejected-centering", "centering below 10 blocks Black Label", base({ centeringFrontLr: "58/42" }));

  return cases;
}
