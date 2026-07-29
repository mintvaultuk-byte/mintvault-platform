/**
 * Mat-measurement plausibility regressions.
 *
 * Derived from the 500-card scanner-failure audit (1000 real faces):
 *   horizontal mat share  p50 0.054  p90 0.085  p95 0.091  p99 0.110
 *   vertical   mat share  p50 0.053  p90 0.065  p95 0.073  p99 0.084
 *   remaining aspect      p50 0.7329 p95 0.7456 p99 0.7535
 * Two faces fell far outside — MV305 (h 0.658 / v 0.542) and MV581 (h 0.545) —
 * where the walk entered a pale card body, and MV586 returned four zeros from a
 * collapsed reference. Geometry below reproduces those shapes without using any
 * certificate-specific constant.
 */
import { describe, it, expect } from "vitest";
import {
  assessMatPlausibility,
  MAX_PLAUSIBLE_MAT_SHARE,
  CARD_ASPECT_RATIO,
} from "../server/image-processing";

// Representative real frame from the population.
const W = 1425;
const H = 1927;

describe("implausible measurements must never influence acceptance", () => {
  it("MV305-style: pale card body consumed as mat (66% horizontal)", () => {
    const p = assessMatPlausibility({ top: 558, bottom: 486, left: 469, right: 469 }, W, H);
    expect(p.state).toBe("implausibly_large");
    expect(p.usableForAcceptance).toBe(false);
    expect(p.matShare.horizontal).toBeGreaterThan(MAX_PLAUSIBLE_MAT_SHARE);
    expect(p.reasons.join(" ")).toMatch(/mat share|occupies only/);
  });

  it("MV581-style: asymmetric over-measurement (54% horizontal, normal vertical)", () => {
    const p = assessMatPlausibility({ top: 229, bottom: 130, left: 309, right: 466 }, 1423, 1926);
    expect(p.state).toBe("implausibly_large");
    expect(p.usableForAcceptance).toBe(false);
    // Vertical alone was plausible — a single bad axis must still fail the whole
    // measurement, or the inflated horizontal value would widen acceptance.
    expect(p.matShare.vertical).toBeLessThan(MAX_PLAUSIBLE_MAT_SHARE);
  });

  it("MV586-style: all-zero collapse is explicit, not four plausible zeros", () => {
    const p = assessMatPlausibility({ top: 0, bottom: 0, left: 0, right: 0 }, 1458, 2004);
    expect(p.state).toBe("all_zero");
    expect(p.usableForAcceptance).toBe(false);
    expect(p.reasons.join(" ")).toMatch(/reference collapse/);
  });

  it("reference_unusable is distinct from a numeric result", () => {
    const p = assessMatPlausibility({ top: 60, bottom: 60, left: 30, right: 30 }, W, H, {
      sourceUnknown: true,
    });
    expect(p.state).toBe("reference_unusable");
    expect(p.usableForAcceptance).toBe(false);
  });

  it("partial collapse (two zero edges) is flagged separately", () => {
    const p = assessMatPlausibility({ top: 60, bottom: 60, left: 0, right: 0 }, W, H);
    expect(p.state).toBe("partially_collapsed");
    expect(p.usableForAcceptance).toBe(false);
  });

  it("geometrically inconsistent remainder is caught even when shares pass", () => {
    // Shares are individually modest but the implied card is not card-shaped.
    const p = assessMatPlausibility({ top: 5, bottom: 5, left: 200, right: 200 }, W, H);
    expect(["implausibly_large", "geometrically_inconsistent"]).toContain(p.state);
    expect(p.usableForAcceptance).toBe(false);
  });
});

describe("normal population measurements stay usable", () => {
  const cases: Array<[string, { top: number; bottom: number; left: number; right: number }]> = [
    ["p50 centred card", { top: 51, bottom: 51, left: 38, right: 39 }],
    ["p90 mat", { top: 63, bottom: 62, left: 60, right: 61 }],
    ["p95 mat", { top: 70, bottom: 70, left: 65, right: 65 }],
    ["p99 mat (near boundary)", { top: 81, bottom: 81, left: 78, right: 78 }],
    ["off-centre but valid", { top: 30, bottom: 90, left: 20, right: 100 }],
    ["max legitimate asymmetry (~157px)", { top: 60, bottom: 60, left: 10, right: 150 }],
    ["single true-zero edge", { top: 60, bottom: 60, left: 0, right: 70 }],
  ];
  for (const [name, mat] of cases) {
    it(`accepts: ${name}`, () => {
      const p = assessMatPlausibility(mat, W, H);
      expect(p.usableForAcceptance, `${name} -> ${p.state}: ${p.reasons.join("; ")}`).toBe(true);
      expect(["valid", "valid_after_artefact_skip"]).toContain(p.state);
    });
  }

  it("an artefact skip is recorded but remains usable", () => {
    const p = assessMatPlausibility({ top: 58, bottom: 58, left: 108, right: 19 }, 1439, 1946, {
      skipped: true,
    });
    expect(p.state).toBe("valid_after_artefact_skip");
    expect(p.usableForAcceptance).toBe(true);
  });

  it("the implied remaining card stays card-like for every accepted case", () => {
    for (const [, mat] of cases) {
      const p = assessMatPlausibility(mat, W, H);
      expect(Math.abs(p.remaining.aspect - CARD_ASPECT_RATIO)).toBeLessThan(0.15);
    }
  });
});

describe("bound separation against the measured population", () => {
  it("sits well above the healthy p99 and well below the failures", () => {
    // healthy p99: h 0.110, v 0.084 — the bound is ~3x higher, so a normal card
    // cannot reach it; the two real failures exceed it by a wide margin.
    expect(MAX_PLAUSIBLE_MAT_SHARE).toBeGreaterThan(0.11 * 2);
    expect(MAX_PLAUSIBLE_MAT_SHARE).toBeLessThan(0.545);
  });
});
