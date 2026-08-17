/**
 * The canonical capture profile: geometry, the placement gate, and the two numbers that must never
 * be confused — the 10 mm SAFE OPERATOR ZONE and the 4 mm ABSOLUTE EVIDENCE FLOOR.
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
  safeWindowRectMm,
  clampCaptureOriginMm,
  captureWindowRectMm,
  evaluatePlacement,
  placementToleranceMm,
  assertSafeWindowIsRotationInvariant,
  profileById,
} from "@shared/lide400-capture-profile.cjs";

const P = STANDARD_TCG;

describe("Standard TCG capture geometry", () => {
  it("locks the geometry the owner approved on 2026-08-17", () => {
    expect(P.outerWindowMm).toEqual({ width: 100, height: 130 });
    expect(P.safeWindowMm).toEqual({ width: 80, height: 110 });
    expect(P.operatorInsetMm).toBe(10);
    expect(P.evidenceMinMarginMm).toBe(4);
    expect(P.defaultOriginMm).toEqual({ x: 20, y: 20 });
    expect(P.cardMm.minWidth).toBe(62.5);
    expect(P.cardMm.maxWidth).toBe(65.0);
    expect(P.cardMm.minHeight).toBe(87.5);
    expect(P.cardMm.maxHeight).toBe(90.5);
  });

  it("keeps the 10 mm operator inset and the 4 mm evidence floor as different numbers", () => {
    // The whole point of the design. If these ever collapse into one value, either staff lose their
    // placement latitude or the evidence standard has been quietly weakened.
    expect(P.operatorInsetMm).toBeGreaterThan(P.evidenceMinMarginMm);
    expect(P.evidenceMinMarginMm).toBe(4);
  });

  it("derives the safe window from the inset so 80x110 and '10 mm' cannot drift apart", () => {
    expect(safeWindowRectMm(P)).toEqual({ x: 10, y: 10, width: 80, height: 110 });
  });

  it("proves the safe window is centred and therefore its own 180-degree image", () => {
    const safe = safeWindowRectMm(P);
    expect(P.outerWindowMm.width - (safe.x + safe.width)).toBe(safe.x);
    expect(P.outerWindowMm.height - (safe.y + safe.height)).toBe(safe.y);
    expect(assertSafeWindowIsRotationInvariant(P)).toBe(true);
  });

  it("refuses a profile whose declared safe window disagrees with its inset", () => {
    const broken = { ...P, safeWindowMm: { width: 84, height: 110 } };
    expect(() => assertSafeWindowIsRotationInvariant(broken as never)).toThrow(/disagrees with operatorInsetMm/);
  });

  it("refuses a profile whose safe window is off-centre, because the gate would then be rotation-dependent", () => {
    const offCentre = {
      ...P,
      outerWindowMm: { width: 100, height: 130 },
      operatorInsetMm: 10,
      safeWindowMm: { width: 80, height: 110 },
      cardMm: { ...P.cardMm },
    };
    // A 100 mm window inset 10 mm on the left must be inset 10 mm on the right. Declare a window
    // that is 80 wide inside a 95 wide outer and the centring identity breaks.
    const asymmetric = { ...offCentre, outerWindowMm: { width: 95, height: 130 } };
    expect(() => assertSafeWindowIsRotationInvariant(asymmetric as never)).toThrow();
  });
});

describe("Operator placement tolerance", () => {
  it("gives the owner's stated latitude for a nominal card", () => {
    const tolerance = placementToleranceMm({ width: 63.5, height: 88.9 }, P);
    expect(tolerance.horizontal).toBeCloseTo(8.25, 2);
    expect(tolerance.vertical).toBeCloseTo(10.55, 2);
  });

  it("still fits the WIDEST card the Standard TCG profile admits", () => {
    // The number that actually matters: latitude for the worst in-profile card, not the nominal one.
    const tolerance = placementToleranceMm({ width: P.cardMm.maxWidth, height: P.cardMm.maxHeight }, P);
    expect(tolerance.horizontal).toBeCloseTo(7.5, 2);
    expect(tolerance.vertical).toBeCloseTo(9.75, 2);
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

  it("clamps the platen ORIGIN, which is where the measured bezel contamination lives", () => {
    // The live station was calibrated to (0, 0). Non-card foreground on all eight preserved masters
    // sits in the first ~1.23 mm of the top edge and ~0.72 mm of the left edge — that is why.
    const result = clampCaptureOriginMm({ x: 0, y: 0 }, P);
    expect(result.clamped).toBe(true);
    expect(result.originMm).toEqual({ x: MIN_PLATEN_INSET_MM, y: MIN_PLATEN_INSET_MM });
  });

  it("keeps the whole window on the platen", () => {
    const result = clampCaptureOriginMm({ x: 9999, y: 9999 }, P);
    expect(result.originMm.x + P.outerWindowMm.width).toBeLessThanOrEqual(PLATEN_MM.width - MIN_PLATEN_INSET_MM);
    expect(result.originMm.y + P.outerWindowMm.height).toBeLessThanOrEqual(PLATEN_MM.height - MIN_PLATEN_INSET_MM);
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

  it("goes AMBER just outside the safe window, where the capture would probably still pass", () => {
    // 9 mm: outside the 10 mm operator zone, but well above the 4 mm floor plus the 1.6 mm budget.
    const verdict = evaluatePlacement({ ...centred, x: 9 }, P);
    expect(verdict.state).toBe(PLACEMENT.MARGINAL);
    expect(verdict.code).toBe("card_outside_safe_window_marginal");
    expect(verdict.message).toBe("ALMOST — MOVE THE CARD INSIDE THE GREEN BOX");
  });

  it("goes RED once the margin drops into the range where the 4 mm floor is at risk", () => {
    const verdict = evaluatePlacement({ ...centred, x: 5 }, P);
    expect(verdict.state).toBe(PLACEMENT.REPOSITION);
    expect(verdict.code).toBe("card_outside_safe_window");
    expect(verdict.message).toBe("PLACE THE WHOLE CARD INSIDE THE GREEN BOX");
  });

  it("puts the amber floor exactly at the evidence floor plus the measured budget", () => {
    const floor = P.evidenceMinMarginMm + P.previewToMasterBudgetMm;
    expect(floor).toBeCloseTo(5.6, 3);
    expect(evaluatePlacement({ ...centred, x: floor }, P).state).toBe(PLACEMENT.MARGINAL);
    expect(evaluatePlacement({ ...centred, x: floor - 0.01 }, P).state).toBe(PLACEMENT.REPOSITION);
  });

  it("NEVER lets amber authorise a capture — only GREEN is an approval", () => {
    /*
     * The load-bearing property of the amber band. If amber ever became an approval, the operator
     * zone would silently collapse back to the evidence floor and the 10 mm design would be gone.
     */
    for (const x of [9, 8, 7, 6, P.evidenceMinMarginMm + P.previewToMasterBudgetMm]) {
      expect(evaluatePlacement({ ...centred, x }, P).state).not.toBe(PLACEMENT.READY);
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

  it("is exactly boundary-accurate: flush with the safe window is GREEN, a hair outside is not", () => {
    const safe = safeWindowRectMm(P);
    const flush = { x: safe.x, y: safe.y, width: 63.5, height: 88.9 };
    expect(evaluatePlacement(flush, P).state).toBe(PLACEMENT.READY);
    // A hundredth of a millimetre outside stops being an approval immediately — no soft edge on the
    // thing that unlocks a capture.
    expect(evaluatePlacement({ ...flush, x: safe.x - 0.01 }, P).state).not.toBe(PLACEMENT.READY);
    expect(evaluatePlacement({ ...flush, y: safe.y - 0.01 }, P).state).not.toBe(PLACEMENT.READY);
  });

  it("GREEN always implies a margin far above the 4 mm evidence floor", () => {
    /*
     * PROOF 5 in miniature. The measured error budget between a green preview and the master is
     * 1.60 mm linear worst case, so the guaranteed floor is 10 - 1.60 = 8.40 mm against a 4 mm rule.
     * Swept over every in-profile card size at every legal position inside the safe window.
     */
    const safe = safeWindowRectMm(P);
    const BUDGET_MM = 1.6;
    for (const width of [P.cardMm.minWidth, 63.5, P.cardMm.maxWidth]) {
      for (const height of [P.cardMm.minHeight, 88.9, P.cardMm.maxHeight]) {
        for (const x of [safe.x, safe.x + (safe.width - width) / 2, safe.x + safe.width - width]) {
          for (const y of [safe.y, safe.y + (safe.height - height) / 2, safe.y + safe.height - height]) {
            const verdict = evaluatePlacement({ x, y, width, height }, P);
            expect(verdict.state).toBe(PLACEMENT.READY);
            expect(verdict.minMarginMm).toBeGreaterThanOrEqual(P.operatorInsetMm - 1e-9);
            expect((verdict.minMarginMm as number) - BUDGET_MM).toBeGreaterThan(P.evidenceMinMarginMm);
          }
        }
      }
    }
  });

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
