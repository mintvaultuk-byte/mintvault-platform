/**
 * Pure geometry helpers for the manual perspective-crop tool (manual-crop.tsx).
 * Extracted from the component so the load-bearing deskew angle can be unit
 * tested without React. No imports, no side effects.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CropQuad {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

/** Axis-aligned bounding box of the quad, in the same percentage units. */
export function quadBounds(q: CropQuad) {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x];
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left_pct: left, top_pct: top, width_pct: right - left, height_pct: bottom - top };
}

/**
 * Deskew angle from the top edge of the quad (TL → TR), in degrees.
 *
 * The quad corners are stored as PERCENTAGES of the displayed image box, so a
 * naive atan2(dy%, dx%) is aspect-distorted whenever the image is non-square:
 * a 1% vertical drop on a tall image spans far fewer pixels than a 1%
 * horizontal run, so the percentage angle understates (or overstates) the real
 * tilt. Convert both deltas to PIXELS using the image's natural dimensions
 * before taking the angle. This IS the rotation fed to the backend recrop, so
 * the conversion is load-bearing.
 *
 * When dimensions are unknown (0 / not yet loaded) we fall back to a
 * square-pixel assumption (w = h = 1), which reproduces the old percentage
 * angle rather than returning NaN — callers always get a usable number.
 */
export function quadRotation(q: CropQuad, naturalWidth = 0, naturalHeight = 0): number {
  const w = naturalWidth > 0 ? naturalWidth : 1;
  const h = naturalHeight > 0 ? naturalHeight : 1;
  const dxPx = ((q.tr.x - q.tl.x) / 100) * w;
  const dyPx = ((q.tr.y - q.tl.y) / 100) * h;
  return Math.atan2(dyPx, dxPx) * (180 / Math.PI);
}

/**
 * The deskew priority shared by EVERY crop tool: a non-zero manual slider
 * override (|slider| > 0.1) always wins; otherwise the auto-derived angle is
 * used only when it is visibly skewed (|auto| > 0.3); otherwise 0 (no rotation).
 *
 * This is the ONE implementation of that rule — Manual Crop (quadRotation as the
 * auto source) and the 8-dot Card Tool (edgeRotation as the auto source) both
 * delegate here, so the slider→auto→zero blend can never drift apart between the
 * two tools. The small dead-zone keeps a slightly-off auto angle (from two
 * hand-placed points) from nudging an otherwise-straight card.
 */
export function resolveDeskew(autoAngle: number, sliderDeg: number): number {
  if (Math.abs(sliderDeg) > 0.1) return sliderDeg;
  if (Math.abs(autoAngle) > 0.3) return autoAngle;
  return 0;
}
