/**
 * MVGS v2 measurement math — shared by every line-drawing surface (image-viewer
 * mark mode, manual-card-tool defects phase). Pure functions, no React, no DOM
 * — safe to import from tests and from server-side helpers if ever needed.
 *
 * The coverage / span calculations match the values verified across the v2
 * commits (Phase 2 from MeasurementTool, then 9084ad4's start/end persistence).
 * Extracted here so the retiring MeasurementTool component can be deleted
 * without losing the math.
 *
 * Engine input semantics:
 *   - WhiteningEdge.coveragePct  = run along the chosen edge axis, as % of
 *                                  the image's edge dimension. Drives spec §3.
 *   - CreaseLine.spanPct         = max(|dx|, |dy|) — dominant-axis run, as % of
 *                                  the card. Drives spec §4 crease ceiling.
 */

export type EdgeKey = "top" | "right" | "bottom" | "left";

export interface Pt {
  /** 0..100 — image-relative percent on the X axis (left → right). */
  x: number;
  /** 0..100 — image-relative percent on the Y axis (top → bottom). */
  y: number;
}

/** Round 0..100 to 1 decimal and clamp to [0, 100]. */
function clamp01_1dp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** Edge auto-detect from line DIRECTION (not midpoint proximity).
 *
 *  Whitening lines follow an edge — the line's orientation is the strongest
 *  signal. Horizontal stroke → it's a top OR bottom edge; vertical stroke →
 *  left OR right. The midpoint's near-side then picks which of the two.
 *
 *  This is correct far more often than nearest-midpoint (e.g. a horizontal
 *  whitening line drawn near the centre of the card is unambiguously a
 *  top/bottom call from orientation, even though the midpoint may be roughly
 *  equidistant from all four edges). Operator can still override via the
 *  edge chip in the defect list. */
export function detectEdge(start: Pt, end: Pt): EdgeKey {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if (dx >= dy) {
    // Horizontal line → top or bottom, whichever the midpoint is nearer.
    return (start.y + end.y) / 2 < 50 ? "top" : "bottom";
  }
  // Vertical line → left or right, whichever the midpoint is nearer.
  return (start.x + end.x) / 2 < 50 ? "left" : "right";
}

/** Coverage % from a drawn segment, given the edge it belongs to. For
 *  top/bottom edges the coverage axis is X (horizontal run); for left/right
 *  it's Y (vertical run). The segment can be slightly off-axis (operator
 *  drawing along a near-horizontal edge); we still project onto the edge
 *  axis to read coverage cleanly. Result clamped + rounded to 0.1 %. */
export function coverageFromSegment(start: Pt, end: Pt, edge: EdgeKey): number {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  const along = edge === "top" || edge === "bottom" ? dx : dy;
  return clamp01_1dp(along);
}

/** Crease span % = dominant axis run of the drawn line, as % of the card.
 *  Matches the spec's "by how far it runs proportionally" definition — TAG's
 *  "half across", "three-quarters across" language. Clamped + rounded to 0.1 %. */
export function creaseSpanFromSegment(start: Pt, end: Pt): number {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  return clamp01_1dp(Math.max(dx, dy));
}
