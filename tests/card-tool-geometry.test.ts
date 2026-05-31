import { describe, it, expect } from "vitest";
import {
  computeCardTool,
  cropBoxForEdges,
  edgesToRect,
  edgeRotation,
  effectiveDeskew,
  centeringRectsForEdges,
  outerEdgesToBboxQuad,
  routePlacement,
  nextPass,
  TOP,
  RIGHT,
  BOTTOM,
  LEFT,
} from "@/components/grading/card-tool-geometry";
import { computeCentering } from "@/components/grading/centering-from-rects";
import { quadRotation, type CropQuad, type Point } from "@/components/grading/crop-geometry";
import { centeringAxisGrade } from "../shared/centering";

// Build a clockwise edge-point array [TOP, RIGHT, BOTTOM, LEFT] from [x,y] pairs.
// Each point is where the operator clicks on that SIDE; only the relevant axis
// is load-bearing (TOP/BOTTOM → y, LEFT/RIGHT → x).
const edges = (
  top: [number, number],
  right: [number, number],
  bottom: [number, number],
  left: [number, number]
): Point[] => [
  { x: top[0], y: top[1] },
  { x: right[0], y: right[1] },
  { x: bottom[0], y: bottom[1] },
  { x: left[0], y: left[1] },
];

// Square outer card: edges at x/y = 10 and 90 → an 80×80 card box.
//   TOP y=10, BOTTOM y=90, LEFT x=10, RIGHT x=90 (along-edge coord parked at 50).
const OUTER_SQUARE = edges([50, 10], [90, 50], [50, 90], [10, 50]);

describe("border widths come from edge-pair gaps (relevant axis only)", () => {
  // Inner edges: top gap 10, bottom gap 10, left gap 20, right gap 10.
  //   TOP-inner y=20 (gap 20−10=10)      BOTTOM-inner y=80 (gap 90−80=10) → T/B 50/50
  //   LEFT-inner x=30 (gap 30−10=20)     RIGHT-inner x=80 (gap 90−80=10)  → L/R 67/33
  const INNER = edges([50, 20], [80, 50], [50, 80], [30, 50]);

  it("left gap 20 / right gap 10 → 67/33; top gap 10 / bottom gap 10 → 50/50 (front → subgrade 7)", () => {
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

  it("back is lenient — identical gaps grade 10 (front-strict/back-lenient routing)", () => {
    const r = computeCardTool("full", OUTER_SQUARE, INNER, "back", 0, 0, 600, 900);
    expect(r.centering!.lr).toBe("67/33");
    expect(r.centering!.subgrade).toBe(10);
  });

  it("uses the gap along the RELEVANT axis only — sliding a point along its own edge changes nothing", () => {
    // Same outer, but TOP/BOTTOM clicked off-centre in X and LEFT/RIGHT off in Y.
    // The relevant axis (TOP/BOTTOM y, LEFT/RIGHT x) is unchanged → same rect.
    const skewedOuter = edges([20, 10], [90, 25], [80, 90], [10, 70]);
    expect(edgesToRect(skewedOuter)).toEqual(edgesToRect(OUTER_SQUARE));
    const skewedInner = edges([35, 20], [80, 33], [70, 80], [30, 66]);
    expect(edgesToRect(skewedInner)).toEqual(edgesToRect(INNER));
    const a = computeCardTool("full", OUTER_SQUARE, INNER, "front", 0, 0, 600, 900).centering!;
    const b = computeCardTool("full", skewedOuter, skewedInner, "front", 0, 0, 600, 900).centering!;
    expect(b.lr).toBe(a.lr);
    expect(b.tb).toBe(a.tb);
    expect(b.subgrade).toBe(a.subgrade);
  });

  it("persisted rects are normalized into the post-crop frame (outer = full image)", () => {
    const r = computeCardTool("full", OUTER_SQUARE, INNER, "front", 0, 0, 600, 900);
    expect(r.centering!.outer).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
    // inner remapped into the outer bbox (left10 top10 w80 h80):
    //   left (30-10)/80*100=25, right (80-10)/80*100=87.5, top (20-10)/80*100=12.5, bottom 87.5
    expect(r.centering!.inner.left).toBeCloseTo(25, 6);
    expect(r.centering!.inner.right).toBeCloseTo(87.5, 6);
    expect(r.centering!.inner.top).toBeCloseTo(12.5, 6);
    expect(r.centering!.inner.bottom).toBeCloseTo(87.5, 6);
  });

  it("normalizing preserves the ratio EXACTLY — raw edge rects vs normalized rects give the same grade", () => {
    // Off-centre inner so L/R and T/B are both non-trivial.
    const inner = edges([50, 16], [78, 50], [50, 84], [22, 50]);
    const raw = computeCentering(edgesToRect(OUTER_SQUARE), edgesToRect(inner), "front");
    const norm = centeringRectsForEdges(OUTER_SQUARE, inner);
    const normGraded = computeCentering(norm.outer, norm.inner, "front");
    expect(normGraded.lr).toBe(raw.lr);
    expect(normGraded.tb).toBe(raw.tb);
    expect(normGraded.subgrade).toBe(raw.subgrade);
  });
});

describe("deskew from the TOP-outer → BOTTOM-outer centre line (pixel space)", () => {
  // A rigid PIXEL rotation by θ about the image centre. The edge-pair method and
  // the trusted top-edge method (crop-geometry.quadRotation) must agree, since
  // both recover the true pixel-space angle once % is converted to px.
  const W = 600;
  const H = 900;
  function rotPx(p: Point, deg: number, cx: number, cy: number): Point {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }
  const toPct = (p: Point): Point => ({ x: (p.x / W) * 100, y: (p.y / H) * 100 });

  it("edge-pair angle equals the top-edge angle AND ≈ the rotation, for a rigid rotation", () => {
    const theta = 4;
    const cx = W / 2;
    const cy = H / 2;
    // Card corners (px) at 10%..90%, plus the four edge midpoints (px).
    const tlPx = { x: 60, y: 90 };
    const trPx = { x: 540, y: 90 };
    const brPx = { x: 540, y: 810 };
    const blPx = { x: 60, y: 810 };
    const topPx = { x: 300, y: 90 };
    const rightPx = { x: 540, y: 450 };
    const bottomPx = { x: 300, y: 810 };
    const leftPx = { x: 60, y: 450 };

    const quad: CropQuad = {
      tl: toPct(rotPx(tlPx, theta, cx, cy)),
      tr: toPct(rotPx(trPx, theta, cx, cy)),
      br: toPct(rotPx(brPx, theta, cx, cy)),
      bl: toPct(rotPx(blPx, theta, cx, cy)),
    };
    const edgePts: Point[] = [
      toPct(rotPx(topPx, theta, cx, cy)),
      toPct(rotPx(rightPx, theta, cx, cy)),
      toPct(rotPx(bottomPx, theta, cx, cy)),
      toPct(rotPx(leftPx, theta, cx, cy)),
    ];

    const autoEdge = edgeRotation(edgePts, W, H);
    const autoQuad = quadRotation(quad, W, H);
    expect(autoEdge).toBeCloseTo(autoQuad, 4); // edge method == trusted top-edge method
    expect(Math.abs(autoEdge)).toBeCloseTo(theta, 2); // and equals the rotation magnitude
  });

  it("a non-zero override wins over the auto angle", () => {
    expect(effectiveDeskew(OUTER_SQUARE, 2, W, H)).toBe(2);
    expect(effectiveDeskew(OUTER_SQUARE, -3.5, W, H)).toBe(-3.5);
  });

  it("a sub-0.3° auto tilt is treated as no rotation", () => {
    const almostFlat = edges([50, 10], [90, 50], [50.1, 90], [10, 50]);
    expect(effectiveDeskew(almostFlat, 0, W, H)).toBe(0);
  });

  it("a flat (perfectly vertical) centre line yields 0°", () => {
    expect(edgeRotation(OUTER_SQUARE, W, H)).toBe(0);
    expect(effectiveDeskew(OUTER_SQUARE, 0, W, H)).toBe(0);
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
    const inner = edges([50, 20], [80, 50], [50, 80], [30, 50]);
    const r = computeCardTool("outer-only", OUTER_SQUARE, inner, "front", 0, 0, 600, 900);
    expect(r.centering).toBeNull();
  });
});

describe("crop box = outer edge bounds + thin margin, clamped 0–100", () => {
  it("no margin → exact outer edge bounding box", () => {
    expect(cropBoxForEdges(OUTER_SQUARE, 0)).toEqual({ left_pct: 10, top_pct: 10, width_pct: 80, height_pct: 80 });
  });

  it("grows the box by the margin on every side", () => {
    expect(cropBoxForEdges(OUTER_SQUARE, 2)).toEqual({ left_pct: 8, top_pct: 8, width_pct: 84, height_pct: 84 });
  });

  it("clamps to the image so the box never exceeds 0–100", () => {
    const edge = edges([50, 0], [100, 50], [50, 100], [0, 50]);
    expect(cropBoxForEdges(edge, 5)).toEqual({ left_pct: 0, top_pct: 0, width_pct: 100, height_pct: 100 });
  });

  it("outerEdgesToBboxQuad is an axis-aligned quad over the outer edge bounds", () => {
    expect(outerEdgesToBboxQuad(OUTER_SQUARE)).toEqual({
      tl: { x: 10, y: 10 },
      tr: { x: 90, y: 10 },
      br: { x: 90, y: 90 },
      bl: { x: 10, y: 90 },
    });
  });
});

describe("clockwise side-by-side capture builds [TOP,RIGHT,BOTTOM,LEFT]", () => {
  // For each SIDE the operator clicks OUTER (card edge) then INNER (border→art).
  const O = { TOP: { x: 50, y: 10 }, RIGHT: { x: 90, y: 50 }, BOTTOM: { x: 50, y: 90 }, LEFT: { x: 10, y: 50 } };
  const I = { TOP: { x: 50, y: 20 }, RIGHT: { x: 80, y: 50 }, BOTTOM: { x: 50, y: 80 }, LEFT: { x: 30, y: 50 } };

  // Click order: TOP-out, TOP-in, RIGHT-out, RIGHT-in, BOTTOM-out, BOTTOM-in, LEFT-out, LEFT-in.
  const CLICK_SEQUENCE: Point[] = [O.TOP, I.TOP, O.RIGHT, I.RIGHT, O.BOTTOM, I.BOTTOM, O.LEFT, I.LEFT];

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

  it("full mode: pass alternates outer→inner per side and arrays end [TOP,RIGHT,BOTTOM,LEFT]", () => {
    const expectedPasses = ["outer", "inner", "outer", "inner", "outer", "inner", "outer", "inner"];
    let outer: Point[] = [];
    let inner: Point[] = [];
    CLICK_SEQUENCE.forEach((pt, k) => {
      expect(nextPass("full", outer, inner)).toBe(expectedPasses[k]);
      const next = routePlacement("full", outer, inner, pt);
      outer = next.outer;
      inner = next.inner;
    });
    expect(outer).toEqual([O.TOP, O.RIGHT, O.BOTTOM, O.LEFT]);
    expect(inner).toEqual([I.TOP, I.RIGHT, I.BOTTOM, I.LEFT]);
    // Index constants line up with the captured order.
    expect(outer[TOP]).toEqual(O.TOP);
    expect(outer[RIGHT]).toEqual(O.RIGHT);
    expect(outer[BOTTOM]).toEqual(O.BOTTOM);
    expect(outer[LEFT]).toEqual(O.LEFT);
    // A 9th click is a no-op and returns the same array refs (React bail-out).
    expect(nextPass("full", outer, inner)).toBe("outer");
    const noop = routePlacement("full", outer, inner, { x: 1, y: 1 });
    expect(noop.outer).toBe(outer);
    expect(noop.inner).toBe(inner);
  });

  it("the capture order matches the downstream order — lr/tb/subgrade + deskew are stable", () => {
    const seq = capture("full", CLICK_SEQUENCE);
    const fromSequence = computeCardTool("full", seq.outer, seq.inner, "front", 0, 0, 600, 900);
    const direct = computeCardTool(
      "full",
      [O.TOP, O.RIGHT, O.BOTTOM, O.LEFT],
      [I.TOP, I.RIGHT, I.BOTTOM, I.LEFT],
      "front",
      0,
      0,
      600,
      900
    );
    expect(fromSequence.centering!.lr).toBe(direct.centering!.lr);
    expect(fromSequence.centering!.tb).toBe(direct.centering!.tb);
    expect(fromSequence.centering!.subgrade).toBe(direct.centering!.subgrade);
    expect(fromSequence.deskewDeg).toBe(direct.deskewDeg);
  });

  it("outer-only mode: every click is an outer dot, inner stays empty", () => {
    const clicks = [O.TOP, O.RIGHT, O.BOTTOM, O.LEFT];
    let outer: Point[] = [];
    let inner: Point[] = [];
    clicks.forEach((pt) => {
      expect(nextPass("outer-only", outer, inner)).toBe("outer");
      const next = routePlacement("outer-only", outer, inner, pt);
      outer = next.outer;
      inner = next.inner;
    });
    expect(outer).toEqual([O.TOP, O.RIGHT, O.BOTTOM, O.LEFT]);
    expect(inner).toEqual([]);
  });
});
