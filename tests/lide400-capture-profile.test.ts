/**
 * The canonical capture profile: the FIXED capture area, the calibrated origin, and the single
 * number that governs placement — the 4 mm EVIDENCE FLOOR.
 *
 * Rewritten 2026-08-17 when the owner collapsed the two-number design (a 10 mm operator zone gating
 * SCAN, a 4 mm floor gating evidence) into one. The old suite was a faithful test of that design;
 * these assertions replace it rather than relaxing it, and several are deliberately INVERSIONS of
 * what this file used to claim. Where that is so, the comment says why.
 *
 * These tests are pure geometry and run in milliseconds. The real-artifact proofs live in
 * `lide400-capture-corpus.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  STANDARD_TCG,
  PLATEN_MM,
  MIN_PLATEN_INSET_MM,
  PLACEMENT,
  PLACEMENT_MESSAGE,
  placementBoundaryRectMm,
  previewGreenMinMarginMm,
  clampCaptureOriginMm,
  captureWindowRectMm,
  evaluatePlacement,
  placementToleranceMm,
  assertPlacementBoundaryIsRotationInvariant,
  profileById,
} from "@shared/lide400-capture-profile.cjs";

const P = STANDARD_TCG;

describe("Standard TCG capture geometry", () => {
  it("locks the geometry the owner approved on 2026-08-17", () => {
    expect(P.outerWindowMm).toEqual({ width: 100, height: 130 });
    expect(P.evidenceMinMarginMm).toBe(4);
    // Removed by owner decision: an 80 x 110 safe window and a 10 mm operator inset.
    expect((P as Record<string, unknown>).safeWindowMm).toBeUndefined();
    expect((P as Record<string, unknown>).operatorInsetMm).toBeUndefined();
    expect(P.defaultOriginMm).toEqual({ x: 20, y: 20 });
    expect(P.cardMm.minWidth).toBe(62.5);
    expect(P.cardMm.maxWidth).toBe(65.0);
    expect(P.cardMm.minHeight).toBe(87.5);
    expect(P.cardMm.maxHeight).toBe(90.5);
  });

  it("DERIVES the preview threshold rather than storing it, so 5.6 exists nowhere as a literal", () => {
    /*
     * The preview threshold is master floor + proven acquisition uncertainty. Asserting the SUM
     * rather than the value is the point: improve the card-shift measurement and the threshold moves
     * on its own, with no stale constant left behind in a second file.
     */
    expect(P.evidenceMinMarginMm).toBe(4);
    expect(P.previewToMasterBudgetMm).toBe(1.6);
    expect(previewGreenMinMarginMm(P)).toBeCloseTo(P.evidenceMinMarginMm + P.previewToMasterBudgetMm, 9);
    expect(previewGreenMinMarginMm(P)).toBeCloseTo(5.6, 9);

    // And it genuinely tracks the budget rather than being a coincidence.
    expect(previewGreenMinMarginMm({ ...P, previewToMasterBudgetMm: 0 } as never)).toBeCloseTo(4, 9);
    expect(previewGreenMinMarginMm({ ...P, previewToMasterBudgetMm: 3 } as never)).toBeCloseTo(7, 9);
  });

  it("derives the placement boundary from the PREVIEW threshold, so the drawn line is the applied rule", () => {
    /*
     * Inset by 5.6, not by the 4.0 master floor. Drawing the master floor while gating at the preview
     * threshold would put a card visibly inside the box and still refuse it.
     */
    const boundary = placementBoundaryRectMm(P);
    expect(boundary.x).toBeCloseTo(5.6, 9);
    expect(boundary.y).toBeCloseTo(5.6, 9);
    expect(boundary.width).toBeCloseTo(88.8, 9);
    expect(boundary.height).toBeCloseTo(118.8, 9);
  });

  it("proves the placement boundary is centred and therefore its own 180-degree image", () => {
    const boundary = placementBoundaryRectMm(P);
    // Closeness, not equality: the inset is a sum of two decimals, so the rotated edge lands at
    // 5.6000000000000085. That is binary floating point, not asymmetry.
    expect(P.outerWindowMm.width - (boundary.x + boundary.width)).toBeCloseTo(boundary.x, 9);
    expect(P.outerWindowMm.height - (boundary.y + boundary.height)).toBeCloseTo(boundary.y, 9);
    expect(assertPlacementBoundaryIsRotationInvariant(P)).toBe(true);
  });

  it("refuses a profile whose widest card cannot fit inside its own placement boundary", () => {
    const tooTight = { ...P, outerWindowMm: { width: 70, height: 130 }, cardMm: { ...P.cardMm } };
    expect(() => assertPlacementBoundaryIsRotationInvariant(tooTight as never)).toThrow(/does not fit/);
  });
});

describe("Operator placement tolerance", () => {
  it("gives the owner's stated latitude for a nominal card", () => {
    const tolerance = placementToleranceMm({ width: 63.5, height: 88.9 }, P);
    // Latitude inside the 88.8 x 118.8 preview boundary, not the retired 80 x 110 safe window.
    expect(tolerance.horizontal).toBeCloseTo(12.65, 2);
    expect(tolerance.vertical).toBeCloseTo(14.95, 2);
  });

  it("still fits the WIDEST card the Standard TCG profile admits", () => {
    // The number that actually matters: latitude for the worst in-profile card, not the nominal one.
    const tolerance = placementToleranceMm({ width: P.cardMm.maxWidth, height: P.cardMm.maxHeight }, P);
    expect(tolerance.horizontal).toBeCloseTo(11.9, 2);
    expect(tolerance.vertical).toBeCloseTo(14.15, 2);
    expect(tolerance.horizontal).toBeGreaterThan(0);
    expect(tolerance.vertical).toBeGreaterThan(0);
  });

  it("beats the placement precision the corner-registered window demanded", () => {
    // MV272 BACK missed by 0.2 mm. Anything above a millimetre or two is a different job.
    expect(
      placementToleranceMm({ width: P.cardMm.maxWidth, height: P.cardMm.maxHeight }, P).horizontal
    ).toBeGreaterThan(5);
  });
});

describe("Capture-window origin", () => {
  it("accepts the approved default of 20, 20", () => {
    const result = clampCaptureOriginMm({ x: 20, y: 20 }, P);
    expect(result.clamped).toBe(false);
    expect(result.originMm).toEqual({ x: 20, y: 20 });
  });

  it("ACCEPTS the platen origin, because forbidding it stranded every station", () => {
    /*
     * INVERTED, and this is the inversion that mattered most. A 5 mm floor on the ORIGIN was added on
     * the strength of a real bezel measurement (~1.23 mm top, ~0.72 mm left on all eight masters).
     * But every VALID station calibration in staging sat at (0, 0), `jigOrigin()` refuses rather than
     * clamps, and the server applies this same constant — so 0 of 11 capture sessions ever acquired
     * an acquisition_region. No station could arm anything, MV272 included.
     *
     * The bezel is handled where it bites: the connected-component detector, and the 4 mm floor
     * measured on the master. `defaultOriginMm` is still (20, 20), so the RECOMMENDED origin is
     * unchanged — this only governs what an operator is FORBIDDEN to choose.
     */
    expect(MIN_PLATEN_INSET_MM).toBe(0);
    const result = clampCaptureOriginMm({ x: 0, y: 0 }, P);
    expect(result.clamped).toBe(false);
    expect(result.originMm).toEqual({ x: 0, y: 0 });
  });

  it("hard-clamps a drag that would push the window off the glass, in both directions", () => {
    const far = clampCaptureOriginMm({ x: 9999, y: 9999 }, P);
    expect(far.clamped).toBe(true);
    expect(far.originMm.x + P.outerWindowMm.width).toBeLessThanOrEqual(PLATEN_MM.width);
    expect(far.originMm.y + P.outerWindowMm.height).toBeLessThanOrEqual(PLATEN_MM.height);
    /*
     * The owner's stated ranges, X 0 -> 115.9 and Y 0 -> 167.0, and they come out exactly because
     * PLATEN_MM is the ImageCaptureCore-reported 215.9 x 297.0107 rather than a tidy 216 x 297.
     * Rounding the platen UP put the far bound at 116, permitting a window whose right edge lands
     * 0.1 mm past the addressable glass — invisible while the origin was inset 5 mm, exposed the
     * moment that inset became 0.
     */
    expect(far.boundsMm.minX).toBe(0);
    expect(far.boundsMm.minY).toBe(0);
    expect(far.boundsMm.maxX).toBeCloseTo(115.9, 6);
    expect(far.boundsMm.maxY).toBeCloseTo(167.01, 2);
    expect(far.boundsMm.maxX + P.outerWindowMm.width).toBeLessThanOrEqual(PLATEN_MM.width);

    // The impossible rectangle the card-chasing solve used to propose is clamped back onto the glass.
    const negative = clampCaptureOriginMm({ x: -11.54, y: -15.09 }, P);
    expect(negative.clamped).toBe(true);
    expect(negative.originMm).toEqual({ x: 0, y: 0 });
  });

  it("rejects a non-finite origin rather than guessing one", () => {
    expect(() => clampCaptureOriginMm({ x: Number.NaN, y: 20 }, P)).toThrow(/finite/);
  });

  it("builds the acquisition rectangle at a NON-ZERO origin", () => {
    expect(captureWindowRectMm({ x: 20, y: 20 }, P)).toEqual({ x: 20, y: 20, width: 100, height: 130 });
  });
});

describe("The placement gate", () => {
  const centred = { x: 18.25, y: 20.55, width: 63.5, height: 88.9 };

  it("goes GREEN for a centred card", () => {
    const verdict = evaluatePlacement(centred, P);
    expect(verdict.state).toBe(PLACEMENT.READY);
    expect(verdict.message).toBe(PLACEMENT_MESSAGE.ready);
  });

  it("has NO third state: AMBER is gone from the profile entirely", () => {
    /*
     * INVERTED. The amber band ran from 5.6 mm to 10 mm and unlocked nothing, so the Scanner refused
     * cards that satisfied the only rule governing evidence — MV272's own accepted FRONT sits at a
     * 4.62 mm margin and would have been shown a rejection. Collapsing to one number removed it.
     */
    expect(Object.values(PLACEMENT)).toEqual(["GREEN", "RED"]);
    expect((PLACEMENT as Record<string, unknown>).MARGINAL).toBeUndefined();
    expect((PLACEMENT_MESSAGE as Record<string, unknown>).marginal).toBeUndefined();
  });

  it("is boundary-exact at the derived preview threshold: 5.59 RED, 5.60 GREEN, 6 and 10 GREEN", () => {
    // The locked truth table. A hundredth of a millimetre decides it — no soft edge on an approval.
    for (const margin of [10, 6.0, 5.6]) {
      const verdict = evaluatePlacement({ ...centred, x: margin, y: margin }, P);
      expect(verdict.state, `${margin} mm must be GREEN`).toBe(PLACEMENT.READY);
      expect(verdict.minMarginMm).toBeCloseTo(margin, 6);
    }
    expect(evaluatePlacement({ ...centred, x: 5.59, y: 5.59 }, P).state).toBe(PLACEMENT.REPOSITION);
  });

  it("refuses a placement that would PROBABLY pass the master, and says so in diagnostics", () => {
    /*
     * Between the 4.0 mm master floor and the 5.6 mm preview threshold the capture would most likely
     * succeed. It is still refused, because GREEN has to mean expected-to-pass rather than
     * probably-passes — and the operator is told which of the two situations they are in.
     */
    const verdict = evaluatePlacement({ ...centred, x: 4.62, y: 4.62 }, P);
    expect(verdict.state).toBe(PLACEMENT.REPOSITION);
    expect(verdict.code).toBe("card_inside_preview_margin");
    expect(verdict.message).toBe("MOVE CARD AWAY FROM EDGE");
    expect(verdict.wouldLikelyPassMaster).toBe(true);
    expect(verdict.moveInwardMm).toBeCloseTo(0.98, 2);

    // Genuinely below the master floor: same colour to the operator, different fact underneath.
    const below = evaluatePlacement({ ...centred, x: 3.9, y: 3.9 }, P);
    expect(below.state).toBe(PLACEMENT.REPOSITION);
    expect(below.wouldLikelyPassMaster).toBe(false);
  });

  it("NEVER lets the preview threshold leak into the master floor", () => {
    // The two numbers must stay independent: the preview may tighten without the evidence rule moving.
    const generous = { ...P, previewToMasterBudgetMm: 20 } as never;
    expect(previewGreenMinMarginMm(generous)).toBeCloseTo(24, 9);
    expect((generous as typeof P).evidenceMinMarginMm).toBe(4);
    expect(evaluatePlacement({ ...centred, x: 10, y: 10 }, generous).evidenceMinMarginMm).toBe(4);
  });

  it("is RED when the card touches or crosses the capture boundary", () => {
    expect(evaluatePlacement({ ...centred, x: 0, y: 0 }, P).state).toBe(PLACEMENT.REPOSITION);
    expect(evaluatePlacement({ ...centred, x: -5, y: 20 }, P).state).toBe(PLACEMENT.REPOSITION);
  });

  it("NO FALSE GREEN: every GREEN clears the master floor with the whole proven budget to spare", () => {
    /*
     * THE PROPERTY THE WHOLE THRESHOLD EXISTS FOR. Swept finely across the band where a false green
     * could hide, this asserts that a GREEN verdict always leaves at least the full measured
     * uncertainty above the master floor — so the master cannot refuse a placement the preview
     * approved, even in the linear worst case.
     */
    for (let margin = 4.0; margin <= 12.0; margin += 0.01) {
      const verdict = evaluatePlacement({ ...centred, x: margin, y: margin }, P);
      if (verdict.state !== PLACEMENT.READY) continue;
      const worstCaseAtMaster = (verdict.minMarginMm as number) - P.previewToMasterBudgetMm;
      expect(worstCaseAtMaster, `GREEN at ${margin.toFixed(2)} mm must survive the master`).toBeGreaterThanOrEqual(
        P.evidenceMinMarginMm - 1e-9
      );
    }
  });

  it("goes RED when no card was detected at all", () => {
    expect(evaluatePlacement(null, P).state).toBe(PLACEMENT.REPOSITION);
    expect(evaluatePlacement(null, P).code).toBe("card_not_detected");
  });

  it("tells the operator a different thing when the card can never fit, instead of 'move it'", () => {
    // Telling someone to reposition an oversized card is an instruction that cannot succeed.
    const verdict = evaluatePlacement({ x: 15, y: 15, width: 70, height: 100 }, P);
    expect(verdict.state).toBe(PLACEMENT.REPOSITION);
    expect(verdict.code).toBe("card_outside_profile_range");
    expect(verdict.message).toBe(PLACEMENT_MESSAGE.wrongProfile);
  });

  it("is exactly boundary-accurate: flush with the 4 mm boundary is GREEN, a hair outside is not", () => {
    const boundary = placementBoundaryRectMm(P);
    const flush = { x: boundary.x, y: boundary.y, width: 63.5, height: 88.9 };
    expect(evaluatePlacement(flush, P).state).toBe(PLACEMENT.READY);
    // A hundredth of a millimetre outside stops being an approval immediately — no soft edge on the
    // thing that unlocks a capture.
    expect(evaluatePlacement({ ...flush, x: boundary.x - 0.01 }, P).state).not.toBe(PLACEMENT.READY);
    expect(evaluatePlacement({ ...flush, y: boundary.y - 0.01 }, P).state).not.toBe(PLACEMENT.READY);
  });

  it("GREEN always implies the preview threshold, swept over every in-profile card size", () => {
    const boundary = placementBoundaryRectMm(P);
    for (const width of [P.cardMm.minWidth, 63.5, P.cardMm.maxWidth]) {
      for (const height of [P.cardMm.minHeight, 88.9, P.cardMm.maxHeight]) {
        for (const x of [boundary.x, boundary.x + (boundary.width - width) / 2, boundary.x + boundary.width - width]) {
          for (const y of [boundary.y, boundary.y + (boundary.height - height) / 2, boundary.y + boundary.height - height]) {
            const verdict = evaluatePlacement({ x, y, width, height }, P);
            expect(verdict.state).toBe(PLACEMENT.READY);
            expect(verdict.minMarginMm).toBeGreaterThanOrEqual(previewGreenMinMarginMm(P) - 1e-9);
          }
        }
      }
    }
  });

  /*
   * ALL FOUR EDGES ON THE GATE TOO. `Math.min(marginMm.left, marginMm.top)` — i.e. deleting the two
   * far edges from the placement gate entirely — failed only ONE of the eighty-six tests in this
   * commit, and that one was an accident of a rotation proof in the corpus. This suite, the one that
   * exists to test the gate, had no discriminating power on right or bottom at all.
   */
  for (const edge of ["left", "top", "right", "bottom"] as const) {
    it(`is RED when only the ${edge.toUpperCase()} margin is inside the preview threshold`, () => {
      const w = 63.5;
      const h = 88.9;
      const floor = previewGreenMinMarginMm(P);
      const tight = floor - 1;
      const centredX = (P.outerWindowMm.width - w) / 2;
      const centredY = (P.outerWindowMm.height - h) / 2;
      const card =
        edge === "left"
          ? { x: tight, y: centredY, width: w, height: h }
          : edge === "top"
            ? { x: centredX, y: tight, width: w, height: h }
            : edge === "right"
              ? { x: P.outerWindowMm.width - w - tight, y: centredY, width: w, height: h }
              : { x: centredX, y: P.outerWindowMm.height - h - tight, width: w, height: h };

      const verdict = evaluatePlacement(card, P);
      expect(verdict.marginMm![edge]).toBeCloseTo(tight, 6);
      expect(verdict.state, `a ${tight} mm ${edge} margin must be RED`).toBe(PLACEMENT.REPOSITION);
      expect(verdict.code).toBe("card_inside_preview_margin");
    });
  }

  it("uses the REAL detected bounds, never a nominal card size", () => {
    // Two cards at the same position but different real sizes must be able to disagree.
    const small = evaluatePlacement({ x: 10, y: 10, width: 62.5, height: 87.5 }, P);
    const oversized = evaluatePlacement({ x: 10, y: 10, width: 82, height: 87.5 }, P);
    expect(small.state).toBe(PLACEMENT.READY);
    expect(oversized.state).toBe(PLACEMENT.REPOSITION);
    expect(small.cardBoundsMm).toEqual({ x: 10, y: 10, width: 62.5, height: 87.5 });
  });

  it("reports canonical coordinates, never a rotated presentation space", () => {
    expect(evaluatePlacement(centred, P).coordinateSpace).toBe("lide400-acquisition-rect-mm-v1");
  });

  it("returns an identical verdict for a card and its 180-degree image", () => {
    /*
     * PROOF 15. The safe window is centred, so rotating the whole frame must not change the answer.
     * If this ever fails, the operator's view and the evidence path have stopped agreeing.
     */
    const rotate = (card: { x: number; y: number; width: number; height: number }) => ({
      x: P.outerWindowMm.width - (card.x + card.width),
      y: P.outerWindowMm.height - (card.y + card.height),
      width: card.width,
      height: card.height,
    });
    for (const card of [
      centred,
      { x: 10, y: 10, width: 63.5, height: 88.9 },
      { x: 9, y: 30, width: 63.5, height: 88.9 },
    ]) {
      expect(evaluatePlacement(rotate(card), P).state).toBe(evaluatePlacement(card, P).state);
    }
  });
});

describe("Profile registry", () => {
  it("resolves the default profile and refuses an unknown one", () => {
    expect(profileById().id).toBe("standard-tcg");
    expect(profileById("standard-tcg").id).toBe("standard-tcg");
    expect(() => profileById("oversized")).toThrow(/Unknown LiDE capture profile/);
  });

  it("carries a version identity that a calibration record can be pinned to", () => {
    expect(P.version).toBe("capture-geometry-v1");
    expect(P.scannerProfileVersion).toBe("mintvault-canon-lide-400-v3");
  });
});
