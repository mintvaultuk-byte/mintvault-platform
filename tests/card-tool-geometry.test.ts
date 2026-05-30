import { describe, it, expect } from "vitest";
import {
  computeCardTool,
  cropBoxForOuter,
  effectiveDeskew,
  centeringRectsForCrop,
  quadToRect,
  ptsToQuad,
  routePlacement,
  nextPass,
} from "@/components/grading/card-tool-geometry";
import { computeCentering } from "@/components/grading/centering-from-rects";
import { centeringAxisGrade } from "../shared/centering";
import type { CropQuad, Point } from "@/components/grading/crop-geometry";

// Helper: build a corner-keyed quad from [TL, TR, BR, BL] coordinate pairs.
const quad = (tl: [number, number], tr: [number, number], br: [number, number], bl: [number, number]): CropQuad =>
  ptsToQuad([
    { x: tl[0], y: tl[1] },
    { x: tr[0], y: tr[1] },
    { x: br[0], y: br[1] },
    { x: bl[0], y: bl[1] },
  ]);

// Axis-aligned outer card box: left 10, top 10, right 90, bottom 90 (80×80).
const OUTER_SQUARE = quad([10, 10], [90, 10], [90, 90], [10, 90]);

describe("border-width → centering ratio (known dot positions)", () => {
  // Inner frame: left 30, top 20, right 80, bottom 80 against OUTER_SQUARE.
  //   left border  = 30 − 10 = 20    right border = 90 − 80 = 10  → L/R 67/33
  //   top border   = 20 − 10 = 10    bottom border = 90 − 80 = 10 → T/B 50/50
  const INNER = quad([30, 20], [80, 20], [80, 80], [30, 80]);

  it("front is strict — 67/33 L/R, 50/50 T/B → subgrade 7", () => {
    const r = computeCardTool("full", OUTER_SQUARE, INNER, "front", 0, 0, 600, 900);
    expect(r.centering).not.toBeNull();
    expect(r.centering!.lr).toBe("67/33");
    expect(r.centering!.tb).toBe("50/50");
    // min(front 67/33 → 7, front 50/50 → 10) = 7, via the canonical chart.
    expect(r.centering!.subgrade).toBe(
      Math.min(centeringAxisGrade("67/33", "front"), centeringAxisGrade("50/50", "front"))
    );
    expect(r.centering!.subgrade).toBe(7);
  });

  it("back is lenient — identical dots grade 10 (front-strict/back-lenient routing)", () => {
    const r = computeCardTool("full", OUTER_SQUARE, INNER, "back", 0, 0, 600, 900);
    expect(r.centering!.lr).toBe("67/33");
    expect(r.centering!.subgrade).toBe(10);
  });

  it("persisted rects are normalized into the post-crop frame (outer = full image)", () => {
    const r = computeCardTool("full", OUTER_SQUARE, INNER, "front", 0, 0, 600, 900);
    expect(r.centering!.outer).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
    // inner remapped into outer bbox (left10 top10 w80 h80):
    //   left (30-10)/80*100=25, right (80-10)/80*100=87.5, top (20-10)/80*100=12.5, bottom 87.5
    expect(r.centering!.inner.left).toBeCloseTo(25, 6);
    expect(r.centering!.inner.right).toBeCloseTo(87.5, 6);
    expect(r.centering!.inner.top).toBeCloseTo(12.5, 6);
    expect(r.centering!.inner.bottom).toBeCloseTo(87.5, 6);
  });

  it("normalizing preserves the ratio EXACTLY — raw rects vs normalized rects give the same grade", () => {
    // Off-centre inner so L/R and T/B are both non-trivial.
    const inner = quad([22, 16], [78, 16], [78, 84], [22, 84]);
    const raw = computeCentering(quadToRect(OUTER_SQUARE), quadToRect(inner), "front");
    const norm = centeringRectsForCrop(OUTER_SQUARE, inner);
    const normGraded = computeCentering(norm.outer, norm.inner, "front");
    expect(normGraded.lr).toBe(raw.lr);
    expect(normGraded.tb).toBe(raw.tb);
    expect(normGraded.subgrade).toBe(raw.subgrade);
  });
});

describe("deskew angle from outer-dot tilt (pixel space, non-square image)", () => {
  // Top edge tilts down 5% L→R on a 600×900 portrait card.
  const TILTED = quad([10, 10], [90, 15], [90, 90], [10, 85]);

  it("uses pixel-space conversion — NOT the aspect-distorted percentage angle", () => {
    const deg = effectiveDeskew(TILTED, 0, 600, 900);
    // pixel angle = atan2((5/100)*900, (80/100)*600) = atan2(45, 480) ≈ 5.356°
    expect(deg).toBeCloseTo(5.356, 1);
    // the naive percentage angle would be atan2(5, 80) ≈ 3.576° — prove they diverge
    const naive = Math.atan2(5, 80) * (180 / Math.PI);
    expect(Math.abs(deg - naive)).toBeGreaterThan(1);
  });

  it("a non-zero override wins over the auto angle", () => {
    expect(effectiveDeskew(TILTED, 2, 600, 900)).toBe(2);
    expect(effectiveDeskew(TILTED, -3.5, 600, 900)).toBe(-3.5);
  });

  it("a sub-0.3° auto tilt is treated as no rotation", () => {
    const almostFlat = quad([10, 10], [90, 10.2], [90, 90], [10, 90]);
    expect(effectiveDeskew(almostFlat, 0, 600, 900)).toBe(0);
  });

  it("a flat quad yields 0°", () => {
    const flat = quad([5, 5], [95, 5], [95, 95], [5, 95]);
    expect(effectiveDeskew(flat, 0, 600, 900)).toBe(0);
  });
});

describe("outer-only mode skips centering cleanly", () => {
  it("returns null centering and a valid crop box (no inner frame)", () => {
    const r = computeCardTool("outer-only", OUTER_SQUARE, null, "front", 0, 1, 600, 900);
    expect(r.centering).toBeNull();
    expect(r.crop.width_pct).toBeGreaterThan(0);
    expect(r.crop.height_pct).toBeGreaterThan(0);
    expect(r.deskewDeg).toBe(0); // square outer → no skew
  });

  it("ignores any inner dots passed in outer-only mode", () => {
    const inner = quad([30, 20], [80, 20], [80, 80], [30, 80]);
    const r = computeCardTool("outer-only", OUTER_SQUARE, inner, "front", 0, 0, 600, 900);
    expect(r.centering).toBeNull();
  });
});

describe("crop box = outer bbox + thin margin, clamped 0–100", () => {
  it("no margin → exact outer bounding box", () => {
    expect(cropBoxForOuter(OUTER_SQUARE, 0)).toEqual({ left_pct: 10, top_pct: 10, width_pct: 80, height_pct: 80 });
  });

  it("grows the box by the margin on every side", () => {
    expect(cropBoxForOuter(OUTER_SQUARE, 2)).toEqual({ left_pct: 8, top_pct: 8, width_pct: 84, height_pct: 84 });
  });

  it("clamps to the image so the box never exceeds 0–100", () => {
    const edge = quad([0, 0], [100, 0], [100, 100], [0, 100]);
    expect(cropBoxForOuter(edge, 5)).toEqual({ left_pct: 0, top_pct: 0, width_pct: 100, height_pct: 100 });
  });
});

describe("corner-by-corner capture builds the same arrays + ratios as the old order", () => {
  // Physical card corners (percent units). For each corner the operator clicks
  // the OUTER (card edge) then the INNER (border → artwork) point.
  const O = { TL: { x: 10, y: 10 }, TR: { x: 90, y: 10 }, BR: { x: 90, y: 90 }, BL: { x: 10, y: 90 } };
  const I = { TL: { x: 30, y: 20 }, TR: { x: 80, y: 20 }, BR: { x: 80, y: 80 }, BL: { x: 30, y: 80 } };

  // New click order: TL-out, TL-in, TR-out, TR-in, BR-out, BR-in, BL-out, BL-in.
  const CLICK_SEQUENCE: Point[] = [O.TL, I.TL, O.TR, I.TR, O.BR, I.BR, O.BL, I.BL];

  // Feed a click list through routePlacement, returning the final arrays.
  function capture(mode: "full" | "outer-only", clicks: Point[]) {
    let outer: Point[] = [];
    let inner: Point[] = [];
    for (const pt of clicks) {
      const next = routePlacement(mode, outer, inner, pt);
      outer = next.outer;
      inner = next.inner;
    }
    return { outer, inner };
  }

  it("full mode: pass alternates outer→inner per corner and arrays end [TL,TR,BR,BL]", () => {
    const expectedPasses = ["outer", "inner", "outer", "inner", "outer", "inner", "outer", "inner"];
    let outer: Point[] = [];
    let inner: Point[] = [];
    CLICK_SEQUENCE.forEach((pt, k) => {
      // The pass for the click about to be placed must follow the corner cadence.
      expect(nextPass("full", outer, inner)).toBe(expectedPasses[k]);
      const next = routePlacement("full", outer, inner, pt);
      outer = next.outer;
      inner = next.inner;
    });
    expect(outer).toEqual([O.TL, O.TR, O.BR, O.BL]);
    expect(inner).toEqual([I.TL, I.TR, I.BR, I.BL]);
    // A 9th click is a no-op and returns the same array refs (React bail-out).
    expect(nextPass("full", outer, inner)).toBe("outer");
    const noop = routePlacement("full", outer, inner, { x: 1, y: 1 });
    expect(noop.outer).toBe(outer);
    expect(noop.inner).toBe(inner);
  });

  it("yields identical lr/tb/subgrade AND deskew to the old all-outer-then-all-inner order", () => {
    const seq = capture("full", CLICK_SEQUENCE);
    const fromSequence = computeCardTool("full", ptsToQuad(seq.outer), ptsToQuad(seq.inner), "front", 0, 0, 600, 900);

    // Old capture order: all four outer, then all four inner — same physical pts.
    const oldOuter = [O.TL, O.TR, O.BR, O.BL];
    const oldInner = [I.TL, I.TR, I.BR, I.BL];
    const fromOld = computeCardTool("full", ptsToQuad(oldOuter), ptsToQuad(oldInner), "front", 0, 0, 600, 900);

    expect(fromSequence.centering!.lr).toBe(fromOld.centering!.lr);
    expect(fromSequence.centering!.tb).toBe(fromOld.centering!.tb);
    expect(fromSequence.centering!.subgrade).toBe(fromOld.centering!.subgrade);
    // Deskew still derives from the two TOP outer corners (TL-out → TR-out).
    expect(fromSequence.deskewDeg).toBe(fromOld.deskewDeg);
    expect(seq.outer[0]).toEqual(O.TL);
    expect(seq.outer[1]).toEqual(O.TR);
  });

  it("outer-only mode: every click is an outer dot, inner stays empty", () => {
    const clicks = [O.TL, O.TR, O.BR, O.BL];
    let outer: Point[] = [];
    let inner: Point[] = [];
    clicks.forEach((pt) => {
      expect(nextPass("outer-only", outer, inner)).toBe("outer");
      const next = routePlacement("outer-only", outer, inner, pt);
      outer = next.outer;
      inner = next.inner;
    });
    expect(outer).toEqual([O.TL, O.TR, O.BR, O.BL]);
    expect(inner).toEqual([]);
  });
});
