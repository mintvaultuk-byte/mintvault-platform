/**
 * Pure geometry for the 8-dot manual card tool (manual-card-tool.tsx).
 *
 * Extracted from the component so the load-bearing math — the deskew angle, the
 * crop box, and (critically) the border-width → centering-ratio conversion — can
 * be unit tested without React. No imports beyond the two sibling pure modules
 * and the canonical chart. No side effects.
 *
 * The tool captures EIGHT points: four OUTER dots on the card edge and four
 * INNER dots where the border meets the artwork, each in CORNER order
 * [TL, TR, BR, BL]. From those it derives:
 *   - a crop box (axis-aligned bounding box of the outer dots + a thin mat
 *     margin) sent to POST /recrop,
 *   - a deskew angle (top-edge tilt of the outer quad, in PIXEL space) sent as
 *     rotation_deg,
 *   - L/R + T/B centering ratios + subgrade routed through the ONE canonical
 *     PSA chart (shared/centering.ts via computeCentering) — never a new chart.
 */

import { quadBounds, quadRotation, type CropQuad } from "./crop-geometry";
import { computeCentering, type Rect } from "./centering-from-rects";
import type { CenteringSide } from "@shared/centering";

/**
 * "full"        — 8 dots: crop + deskew + centering (front/back graded).
 * "outer-only"  — 4 outer dots only: crop + deskew, centering SKIPPED. For
 *                 full-art / borderless cards that have no inner frame.
 */
export type CardToolMode = "full" | "outer-only";

/** Crop box in percentage-of-image units (same shape as quadBounds). */
export interface CropBox {
  left_pct: number;
  top_pct: number;
  width_pct: number;
  height_pct: number;
}

export interface CardToolComputed {
  /** Crop box (outer bbox + margin, clamped 0–100) for POST /recrop. */
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

/** Build a corner-keyed quad from an ordered [TL, TR, BR, BL] point list. */
export function ptsToQuad(pts: { x: number; y: number }[]): CropQuad {
  return { tl: pts[0], tr: pts[1], br: pts[2], bl: pts[3] };
}

/** Axis-aligned bounding rect of a quad's four points, in the same % units. */
export function quadToRect(q: CropQuad): Rect {
  const b = quadBounds(q);
  return { left: b.left_pct, top: b.top_pct, right: b.left_pct + b.width_pct, bottom: b.top_pct + b.height_pct };
}

/**
 * Crop box = bounding box of the OUTER quad, grown by `marginPct` on each side
 * and clamped to the image (0–100). The thin margin keeps a hair of mat around
 * the card so a deskew rotation doesn't clip the card corners.
 */
export function cropBoxForOuter(outer: CropQuad, marginPct = 0): CropBox {
  const b = quadBounds(outer);
  const left = clampPct(b.left_pct - marginPct);
  const top = clampPct(b.top_pct - marginPct);
  const right = clampPct(b.left_pct + b.width_pct + marginPct);
  const bottom = clampPct(b.top_pct + b.height_pct + marginPct);
  return { left_pct: left, top_pct: top, width_pct: right - left, height_pct: bottom - top };
}

/**
 * Effective deskew angle, mirroring manual-crop.tsx exactly: a non-zero manual
 * override (|slider| > 0.1) wins; otherwise the quad-derived auto angle is used
 * only when it is visibly skewed (|auto| > 0.3); otherwise 0 (no rotation). The
 * auto angle is computed in PIXEL space (quadRotation needs the natural image
 * dimensions) so it isn't aspect-distorted on a non-square card.
 */
export function effectiveDeskew(outer: CropQuad, sliderDeg: number, naturalWidth = 0, naturalHeight = 0): number {
  const auto = quadRotation(outer, naturalWidth, naturalHeight);
  if (Math.abs(sliderDeg) > 0.1) return sliderDeg;
  if (Math.abs(auto) > 0.3) return auto;
  return 0;
}

/**
 * Normalize the inner quad's bounding rect INTO the outer quad's bounding box,
 * so the outer rect becomes the full frame (0–100) — which is exactly what the
 * image becomes after POST /recrop crops to the outer box. A linear remap
 * preserves the ratio of every border width EXACTLY, so the centering subgrade
 * is identical whether computed on the raw or the normalized rects; normalizing
 * only re-anchors the saved overlay to the post-crop image. The result rects
 * also match the shape the existing centering display/overlay expects
 * (outer ≈ full image, inner inset).
 */
export function centeringRectsForCrop(outer: CropQuad, inner: CropQuad): { outer: Rect; inner: Rect } {
  const ob = quadBounds(outer);
  const ir = quadToRect(inner);
  const w = ob.width_pct || 1;
  const h = ob.height_pct || 1;
  const remapX = (v: number) => ((v - ob.left_pct) / w) * 100;
  const remapY = (v: number) => ((v - ob.top_pct) / h) * 100;
  return {
    outer: { left: 0, top: 0, right: 100, bottom: 100 },
    inner: { left: remapX(ir.left), top: remapY(ir.top), right: remapX(ir.right), bottom: remapY(ir.bottom) },
  };
}

/**
 * One-shot compute for the COMPUTE button: crop box + deskew + (in full mode)
 * centering. In outer-only mode `centering` is null and `inner` is ignored.
 */
export function computeCardTool(
  mode: CardToolMode,
  outer: CropQuad,
  inner: CropQuad | null,
  side: CenteringSide,
  sliderDeg: number,
  marginPct: number,
  naturalWidth = 0,
  naturalHeight = 0
): CardToolComputed {
  const crop = cropBoxForOuter(outer, marginPct);
  const deskewDeg = effectiveDeskew(outer, sliderDeg, naturalWidth, naturalHeight);

  let centering: CardToolComputed["centering"] = null;
  if (mode === "full" && inner) {
    const rects = centeringRectsForCrop(outer, inner);
    const c = computeCentering(rects.outer, rects.inner, side);
    centering = { outer: rects.outer, inner: rects.inner, lr: c.lr, tb: c.tb, subgrade: c.subgrade };
  }

  return { crop, deskewDeg, centering };
}
