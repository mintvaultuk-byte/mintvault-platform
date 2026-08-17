/**
 * Types for the canonical LiDE 400 card-geometry detector.
 *
 * Hand-written because the implementation is CommonJS JavaScript: the Scanner is untranspiled CJS
 * running from a repository checkout and the server is an esbuild bundle, and a single shared `.js`
 * is the only form both consume without a second copy. See the module header for the algorithm and
 * for the canonical coordinate convention.
 */

/** Millimetres from the acquisition rectangle's top-left, +X right, +Y down, no 180° inversion. */
export declare const CANONICAL_COORDINATE_SPACE: "lide400-acquisition-rect-mm-v1";

export declare const CARD_SEARCH_MM: Readonly<{
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}>;

export declare const CARD_PIXEL_DISTANCE: number;

export interface Lide400CardBounds {
  coordinateSpace: string;
  detectionMethod: "dominant_run" | "dominant_component";
  cardBoundsPx: { left: number; top: number; width: number; height: number };
  cardBoundsMm: { x: number; y: number; width: number; height: number };
  evidenceMarginMm: { left: number; top: number; right: number; bottom: number };
  backgroundRgb: { r: number; g: number; b: number };
  cardPixelPercent: number;
}

/**
 * Detect the dominant physically plausible card region.
 *
 * `null` means no plausible card region was found and MUST be treated as a refusal. It is never a
 * licence to fall back to the whole frame.
 */
export declare function detectLide400CardBounds(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
  regionMm: { width: number; height: number }
): Lide400CardBounds | null;
