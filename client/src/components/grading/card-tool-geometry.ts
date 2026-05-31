/**
 * Pure geometry for the 8-dot manual card tool (manual-card-tool.tsx).
 *
 * Extracted from the component so the load-bearing math — the deskew angle, the
 * crop box, and (critically) the border-width → centering-ratio conversion — can
 * be unit tested without React. No side effects.
 *
 * EDGE model (clockwise, side-by-side). The tool captures EIGHT points, working
 * one SIDE at a time, OUTER then INNER, clockwise TOP → RIGHT → BOTTOM → LEFT:
 *   - four OUTER edge points (on the card edge of each side), ordered
 *     [TOP, RIGHT, BOTTOM, LEFT],
 *   - four INNER edge points (where the border meets the artwork on each side),
 *     ordered [TOP, RIGHT, BOTTOM, LEFT].
 *
 * From those it derives:
 *   - a crop box (left = LEFT-outer x, right = RIGHT-outer x, top = TOP-outer y,
 *     bottom = BOTTOM-outer y, grown by a thin mat margin) sent to POST /recrop,
 *   - a deskew angle (the TOP-outer → BOTTOM-outer centre line should be
 *     vertical; its tilt, in PIXEL space, is the skew) sent as rotation_deg,
 *   - L/R + T/B centering ratios + subgrade routed through the ONE canonical PSA
 *     chart (shared/centering.ts via computeCentering) — never a new chart.
 *
 * The border width of each side is the gap along the RELEVANT axis only:
 *   TOP / BOTTOM  → vertical (Y) gap between that side's inner and outer points
 *   LEFT / RIGHT  → horizontal (X) gap between that side's inner and outer points
 * The X of the TOP/BOTTOM points and the Y of the LEFT/RIGHT points are ignored
 * for the centering math (they only matter for the deskew centre line / display).
 */

import type { CropQuad, Point } from "./crop-geometry";
import { computeCentering, type Rect } from "./centering-from-rects";
import type { CenteringSide } from "@shared/centering";

/**
 * "full"        — 8 dots: crop + deskew + centering (front/back graded).
 * "outer-only"  — 4 outer dots only: crop + deskew, centering SKIPPED. For
 *                 full-art / borderless cards that have no inner frame.
 */
export type CardToolMode = "full" | "outer-only";

/** Edge-array indices. Points are captured/stored clockwise from the top. */
export const TOP = 0;
export const RIGHT = 1;
export const BOTTOM = 2;
export const LEFT = 3;

/** Crop box in percentage-of-image units (same shape as the recrop body). */
export interface CropBox {
  left_pct: number;
  top_pct: number;
  width_pct: number;
  height_pct: number;
}

export interface CardToolComputed {
  /** Crop box (outer edge bounds + margin, clamped 0–100) for POST /recrop. */
  crop: CropBox;
  /** Deskew angle in degrees for POST /recrop rotation_deg. */
  deskewDeg: number;
  /**
   * Centering result, or null in outer-only mode (no inner frame to measure).
   * `outer`/`inner` are the rects to PERSIST: normalized into the post-crop
   * frame (outer = full image, inner inset) so the saved overlay aligns with
   * the re-cropped image. The ratios/subgrade are unchanged by that normalize.
   */
  centering: { outer: Rect; inner: Rect; lr: string; tb: string; subgrade: number } | null;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/**
 * Axis-aligned rect from the four EDGE points: each side contributes only its
 * relevant coordinate — left = LEFT.x, right = RIGHT.x, top = TOP.y,
 * bottom = BOTTOM.y. Feeding the outer and inner edge rects into
 * computeCentering makes every inset equal that side's edge-pair gap exactly.
 */
export function edgesToRect(pts: Point[]): Rect {
  return { left: pts[LEFT].x, top: pts[TOP].y, right: pts[RIGHT].x, bottom: pts[BOTTOM].y };
}

/**
 * Axis-aligned bounding quad from the outer edge points, for the (server-side
 * unused) `quad` field of the recrop request — kept so the request shape is
 * stable. Built from edgesToRect so it never implies a perspective transform.
 */
export function outerEdgesToBboxQuad(outerPts: Point[]): CropQuad {
  const r = edgesToRect(outerPts);
  return {
    tl: { x: r.left, y: r.top },
    tr: { x: r.right, y: r.top },
    br: { x: r.right, y: r.bottom },
    bl: { x: r.left, y: r.bottom },
  };
}

/**
 * Crop box = bounds of the four OUTER edge points (left = LEFT-outer x,
 * right = RIGHT-outer x, top = TOP-outer y, bottom = BOTTOM-outer y), grown by
 * `marginPct` on each side and clamped to the image (0–100). The thin margin
 * keeps a hair of mat around the card so a deskew rotation doesn't clip corners.
 */
export function cropBoxForEdges(outerPts: Point[], marginPct = 0): CropBox {
  const r = edgesToRect(outerPts);
  const left = clampPct(r.left - marginPct);
  const top = clampPct(r.top - marginPct);
  const right = clampPct(r.right + marginPct);
  const bottom = clampPct(r.bottom + marginPct);
  return { left_pct: left, top_pct: top, width_pct: right - left, height_pct: bottom - top };
}

/**
 * Auto deskew angle from the TOP-outer → BOTTOM-outer centre line, in degrees.
 *
 * That line should be vertical on a square-on card; its tilt off-vertical is
 * the skew. The percentage deltas are converted to PIXELS first (using the
 * natural image dims) so the angle isn't aspect-distorted on a non-square card.
 * atan2(-dxPx, dyPx) yields the SAME sign and magnitude as the old top-edge
 * angle (crop-geometry.quadRotation) for a rigid rotation, so the recrop
 * rotate() behaves byte-for-byte identically to the corner-based tool.
 *
 * When dims are unknown (0 / not yet loaded) we fall back to a square-pixel
 * assumption (w = h = 1) so callers always get a usable number, never NaN.
 */
export function edgeRotation(outerPts: Point[], naturalWidth = 0, naturalHeight = 0): number {
  const w = naturalWidth > 0 ? naturalWidth : 1;
  const h = naturalHeight > 0 ? naturalHeight : 1;
  const top = outerPts[TOP];
  const bottom = outerPts[BOTTOM];
  const dxPx = ((bottom.x - top.x) / 100) * w;
  const dyPx = ((bottom.y - top.y) / 100) * h;
  const deg = Math.atan2(-dxPx, dyPx) * (180 / Math.PI);
  // Collapse signed zero so a perfectly vertical line reads "0.00°", not "-0.00°".
  return deg === 0 ? 0 : deg;
}

/**
 * Effective deskew angle, mirroring manual-crop.tsx exactly: a non-zero manual
 * override (|slider| > 0.1) wins; otherwise the auto angle is used only when it
 * is visibly skewed (|auto| > 0.3); otherwise 0 (no rotation). The auto angle is
 * the TOP→BOTTOM centre-line tilt in PIXEL space (see edgeRotation). Because
 * that line is two operator-placed points on different edges, a wrong auto
 * angle is possible — the dead-zone + slider override keep it safe.
 */
export function effectiveDeskew(outerPts: Point[], sliderDeg: number, naturalWidth = 0, naturalHeight = 0): number {
  const auto = edgeRotation(outerPts, naturalWidth, naturalHeight);
  if (Math.abs(sliderDeg) > 0.1) return sliderDeg;
  if (Math.abs(auto) > 0.3) return auto;
  return 0;
}

/**
 * Normalize the inner edge rect INTO the outer edge rect, so the outer rect
 * becomes the full frame (0–100) — which is exactly what the image becomes
 * after POST /recrop crops to the outer box. A linear remap preserves the ratio
 * of every border width EXACTLY, so the centering subgrade is identical whether
 * computed on the raw or the normalized rects; normalizing only re-anchors the
 * saved overlay to the post-crop image. The result rects also match the shape
 * the existing centering display/overlay expects (outer ≈ full image, inner
 * inset).
 */
export function centeringRectsForEdges(outerPts: Point[], innerPts: Point[]): { outer: Rect; inner: Rect } {
  const o = edgesToRect(outerPts);
  const ir = edgesToRect(innerPts);
  const w = o.right - o.left || 1;
  const h = o.bottom - o.top || 1;
  const remapX = (v: number) => ((v - o.left) / w) * 100;
  const remapY = (v: number) => ((v - o.top) / h) * 100;
  return {
    outer: { left: 0, top: 0, right: 100, bottom: 100 },
    inner: { left: remapX(ir.left), top: remapY(ir.top), right: remapX(ir.right), bottom: remapY(ir.bottom) },
  };
}

/**
 * One-shot compute for the COMPUTE button: crop box + deskew + (in full mode)
 * centering. `outerPts` / `innerPts` are the edge arrays [TOP, RIGHT, BOTTOM,
 * LEFT]. In outer-only mode `centering` is null and `innerPts` is ignored.
 */
export function computeCardTool(
  mode: CardToolMode,
  outerPts: Point[],
  innerPts: Point[] | null,
  side: CenteringSide,
  sliderDeg: number,
  marginPct: number,
  naturalWidth = 0,
  naturalHeight = 0
): CardToolComputed {
  const crop = cropBoxForEdges(outerPts, marginPct);
  const deskewDeg = effectiveDeskew(outerPts, sliderDeg, naturalWidth, naturalHeight);

  let centering: CardToolComputed["centering"] = null;
  if (mode === "full" && innerPts) {
    const rects = centeringRectsForEdges(outerPts, innerPts);
    const c = computeCentering(rects.outer, rects.inner, side);
    centering = { outer: rects.outer, inner: rects.inner, lr: c.lr, tb: c.tb, subgrade: c.subgrade };
  }

  return { crop, deskewDeg, centering };
}

/**
 * Which pass the NEXT placement click belongs to, for the side-by-side capture
 * flow. The tool captures one SIDE at a time — OUTER then INNER for each of
 * TOP → RIGHT → BOTTOM → LEFT. The rule: when the two arrays are level, the next
 * click is this side's OUTER; when outer is one ahead, it's that side's INNER.
 * In "outer-only" mode every click is an outer dot.
 */
export function nextPass(mode: CardToolMode, outer: Point[], inner: Point[]): "outer" | "inner" {
  if (mode === "outer-only") return "outer";
  return outer.length === inner.length ? "outer" : "inner";
}

/**
 * Route a freshly-clicked point into the outer/inner arrays for the side-by-side
 * flow. Returns the NEXT arrays (immutable; the unchanged array is returned by
 * reference, so it's a no-op for React state). The outer/inner arrays END
 * ordered [TOP, RIGHT, BOTTOM, LEFT] — the clockwise capture order — so every
 * downstream calculation (border widths, L/R + T/B ratios, crop bounds, deskew
 * centre line, PSA subgrade) reads a known, fixed layout. Clicks past the 8th
 * (4th in outer-only) are ignored.
 */
export function routePlacement(
  mode: CardToolMode,
  outer: Point[],
  inner: Point[],
  pt: Point
): { outer: Point[]; inner: Point[] } {
  if (nextPass(mode, outer, inner) === "outer") {
    return outer.length < 4 ? { outer: [...outer, pt], inner } : { outer, inner };
  }
  return inner.length < 4 ? { outer, inner: [...inner, pt] } : { outer, inner };
}
