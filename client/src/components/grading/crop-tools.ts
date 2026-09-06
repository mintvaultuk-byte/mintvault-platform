import { adminFetch } from "@/lib/queryClient";
/**
 * Shared crop-tool helpers consumed by BOTH the perspective Manual Crop
 * (manual-crop.tsx) AND the 8-dot Card Tool (manual-card-tool.tsx). This is the
 * single home for the side-effecting Auto-Detect call and the bounds → geometry
 * mappers, so the auto-detect + bounds logic has ONE implementation rather than
 * a per-tool copy. The PURE deskew priority lives in crop-geometry.ts
 * (resolveDeskew) so this module stays the only place that does I/O.
 *
 * No React here — these are plain async/util functions, unit-testable in
 * isolation and importable from either tool.
 */
import type { Point, CropQuad } from "./crop-geometry";
import type { CropBox } from "./card-tool-geometry";

/**
 * Auto-detect the card's bounding box on the server. Returns the bounds in 0–100
 * percentage units, or null when detection fails (the caller falls back to
 * manual placement). The same endpoint Manual Crop has always used; extracted
 * here verbatim so the Card Tool can call it without duplicating the fetch.
 */
export async function detectCardBounds(
  certId: number,
  side: "front" | "back",
  apiBase = "/api/admin"
): Promise<CropBox | null> {
  const r = await adminFetch(`${apiBase}/certificates/${certId}/detect-card-bounds`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.ok && j.bounds) {
    const { left_pct, top_pct, width_pct, height_pct } = j.bounds;
    return { left_pct, top_pct, width_pct, height_pct };
  }
  return null;
}

/** Map a detected bounding box to Manual Crop's four free corners (tl/tr/br/bl). */
export function boundsToQuad(b: CropBox): CropQuad {
  const { left_pct: l, top_pct: t, width_pct: w, height_pct: h } = b;
  return {
    tl: { x: l, y: t },
    tr: { x: l + w, y: t },
    br: { x: l + w, y: t + h },
    bl: { x: l, y: t + h },
  };
}

/**
 * Map a detected bounding box to the Card Tool's four OUTER edge points, in the
 * tool's clockwise [TOP, RIGHT, BOTTOM, LEFT] order. Each point is the MIDPOINT
 * of its edge, so card-tool-geometry's edgesToRect() recovers exactly
 * {left, top, right, bottom} of the box and the TOP→BOTTOM centre line is
 * vertical (auto deskew = 0). The operator then places the inner dots and
 * fine-tunes the outer ones.
 */
export function boundsToOuterEdges(b: CropBox): Point[] {
  const { left_pct: l, top_pct: t, width_pct: w, height_pct: h } = b;
  const cx = l + w / 2;
  const cy = t + h / 2;
  // [TOP, RIGHT, BOTTOM, LEFT]
  return [
    { x: cx, y: t },
    { x: l + w, y: cy },
    { x: cx, y: t + h },
    { x: l, y: cy },
  ];
}
