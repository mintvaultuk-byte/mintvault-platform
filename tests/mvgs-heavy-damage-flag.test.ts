import { describe, it, expect } from "vitest";
import {
  computeMvgsScore,
  getHeavyDamageFlags,
  HEAVY_DAMAGE_THRESHOLD,
  type MvgsInput,
  type MvgsResult,
} from "../shared/mvgs-scoring";

/** Build a baseline input — clean card, no defects, no measurement state. */
function baseInput(): MvgsInput {
  return {
    centeringFrontLr: "50/50",
    centeringFrontTb: "50/50",
    centeringBackLr: "50/50",
    centeringBackTb: "50/50",
    defects: [],
    darkBorderFront: false,
    darkBorderBack: false,
    eyeAppealModifier: 0,
  };
}

/** Construct a synthetic MvgsResult for testing the flag helper in
 *  isolation. The engine's own floor rule catches catastrophic damage
 *  before getHeavyDamageFlags' overall>=5 gate fires (a card with raw
 *  surface -60 already buckets surface subgrade to 1, dropping overall
 *  to ~1.5). The flag exists for the cap-saturation case that bypasses
 *  the floor rule (unclassified pins, non-pin sources of damage, mould).
 *  Synthetic inputs let us exercise the threshold + gate logic. */
function syntheticResult(rawDeductions: MvgsResult["rawDeductions"]): MvgsResult {
  return {
    score: 90,
    grade: "Mint",
    deductions: {},
    ceiling: null,
    edgesSubgradeFromWhitening: null,
    tearForceNotGraded: false,
    rawDeductions,
  };
}

describe("rawDeductions — pre-clamp totals exposed on MvgsResult", () => {
  it("clean card: every category raw = 0", () => {
    const r = computeMvgsScore(baseInput());
    expect(r.rawDeductions).toEqual({ corners: 0, edges: 0, surface: 0, centering: 0 });
  });

  it("six D1 surface CR pins: surface raw blows past the -25 cap", () => {
    // CR D1 front = -10 each. Six front-art CRs → raw -60. The cap clamps
    // the score-side deduction to -25; the raw stays -60 for flag detection.
    const r = computeMvgsScore({
      ...baseInput(),
      defects: Array.from({ length: 6 }, () => ({ mvgsCode: "CR", tier: "D1", zone: "FA" })),
    });
    expect(r.rawDeductions.surface).toBe(-60);
    expect(r.deductions.surface).toBe(-25);
  });

  it("CH D1 edge pins accumulate past -40 on the raw value", () => {
    // CH D1 front edge = -3. 20 of them → -60 raw, -25 clamped.
    const r = computeMvgsScore({
      ...baseInput(),
      defects: Array.from({ length: 20 }, () => ({ mvgsCode: "CH", tier: "D1", zone: "FE1" })),
    });
    expect(r.rawDeductions.edges).toBeLessThanOrEqual(-40);
    expect(r.deductions.edges).toBe(-25);
  });
});

describe("getHeavyDamageFlags — threshold + grade gate (synthetic results)", () => {
  it("returns empty when no category trips the threshold", () => {
    const r = syntheticResult({ corners: -5, edges: -10, surface: -15, centering: -3 });
    expect(getHeavyDamageFlags(r, 9)).toEqual([]);
  });

  it("returns empty when category sits exactly at -25 (cap, not past)", () => {
    const r = syntheticResult({ corners: 0, edges: 0, surface: -25, centering: 0 });
    expect(getHeavyDamageFlags(r, 9)).toEqual([]);
  });

  it("returns empty when category is at the -40 threshold (boundary, not past)", () => {
    const r = syntheticResult({ corners: 0, edges: 0, surface: -40, centering: 0 });
    expect(getHeavyDamageFlags(r, 9)).toEqual([]);
  });

  it("fires when category blows past -40 AND overall >= 5", () => {
    const r = syntheticResult({ corners: 0, edges: 0, surface: -47, centering: 0 });
    const flags = getHeavyDamageFlags(r, 9);
    expect(flags).toHaveLength(1);
    expect(flags[0].category).toBe("surface");
    expect(flags[0].label).toBe("HEAVY SURFACE DAMAGE");
    expect(flags[0].rawDeduction).toBe(-47);
    expect(flags[0].threshold).toBe(HEAVY_DAMAGE_THRESHOLD);
  });

  it("suppresses flag when overall < 5 (low-graded card already reflects damage)", () => {
    const r = syntheticResult({ corners: 0, edges: 0, surface: -60, centering: 0 });
    expect(getHeavyDamageFlags(r, 4.5)).toEqual([]);
    expect(getHeavyDamageFlags(r, 5)).toHaveLength(1);
  });

  it("multiple categories past threshold yields multiple flags", () => {
    const r = syntheticResult({ corners: -50, edges: -45, surface: -70, centering: 0 });
    const flags = getHeavyDamageFlags(r, 8);
    expect(flags).toHaveLength(3);
    expect(new Set(flags.map((f) => f.category))).toEqual(new Set(["corners", "edges", "surface"]));
  });

  it("custom threshold lets the flag fire at a more lenient level", () => {
    const r = syntheticResult({ corners: 0, edges: 0, surface: -30, centering: 0 });
    expect(getHeavyDamageFlags(r, 9)).toEqual([]); // -30 > -40 (less negative)
    expect(getHeavyDamageFlags(r, 9, -25)).toHaveLength(1); // -30 < -25 trips it
  });

  it("HEAVY_DAMAGE_THRESHOLD is exported as a single tuneable constant", () => {
    expect(HEAVY_DAMAGE_THRESHOLD).toBe(-40);
  });

  it("centering raw is included for symmetry but can't normally trip (-40 unreachable from chart)", () => {
    // The PSA centering chart caps front at -20 + back at -5 = -25 max.
    // Synthetic -25 below threshold; in practice never reached.
    const r = syntheticResult({ corners: 0, edges: 0, surface: 0, centering: -45 });
    expect(getHeavyDamageFlags(r, 9)).toHaveLength(1);
    expect(getHeavyDamageFlags(r, 9)[0].category).toBe("centering");
  });
});
