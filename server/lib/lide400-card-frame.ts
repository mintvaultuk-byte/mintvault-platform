import sharp from "sharp";
import { detectLide400CardBounds } from "@shared/lide400-card-geometry.cjs";
import { STANDARD_TCG } from "@shared/lide400-capture-profile.cjs";
import type { ScannerEvidenceInspection } from "./image-evidence";

/**
 * The hardware capture is intentionally larger than a card. This is a
 * fail-closed assessment of the *full* acquired TIFF: it neither crops the
 * master nor treats a downstream working crop as proof that the hardware frame
 * contained all four card edges.
 */
/**
 * THE ABSOLUTE EVIDENCE FLOOR. 4 mm, unchanged, and deliberately NOT the 10 mm the operator is
 * guided to. The placement gate's safe zone gives staff real latitude; this decides whether a
 * captured master is admissible. A green preview never reaches this number — the server re-derives
 * the geometry from the immutable master and applies it here, on its own.
 */
export const LIDE_400_MIN_EVIDENCE_MARGIN_MM = STANDARD_TCG.evidenceMinMarginMm;
/**
 * Outer sanity bound: is this a card-shaped object at all. Deliberately wider than any one profile,
 * and checked first so an obviously wrong object gets an obviously right error message.
 */
const CARD_WIDTH_MM = { min: 55, max: 78 } as const;
const CARD_HEIGHT_MM = { min: 80, max: 105 } as const;
const DETECTION_MAX_EDGE_PX = 1800;

export type Lide400FrameAssessment = {
  accepted: boolean;
  reason: string | null;
  cardBoundsPx: { left: number; top: number; width: number; height: number } | null;
  cardBoundsMm: { left: number; top: number; width: number; height: number } | null;
  evidenceMarginMm: { left: number; top: number; right: number; bottom: number } | null;
  detector: { nonBackgroundPercent: number; matRgb: { r: number; g: number; b: number } } | null;
};

type AcquisitionArea = { width: number; height: number };

function rejected(reason: string): Lide400FrameAssessment {
  return {
    accepted: false,
    reason,
    cardBoundsPx: null,
    cardBoundsMm: null,
    evidenceMarginMm: null,
    detector: null,
  };
}

/**
 * Validate a candidate frame before it can be accepted. All calculations are
 * made from a downscaled copy only for speed; physical distances are mapped
 * back to the full ImageCaptureCore acquisition region. No image is written
 * or cropped by this function.
 */
export async function assessLide400CardFrame(
  tiff: Buffer,
  inspection: Pick<ScannerEvidenceInspection, "width" | "height">,
  acquisition: AcquisitionArea
): Promise<Lide400FrameAssessment> {
  if (
    !Number.isFinite(acquisition.width) ||
    !Number.isFinite(acquisition.height) ||
    acquisition.width <= 0 ||
    acquisition.height <= 0
  ) {
    return rejected("LiDE acquisition geometry is unavailable; capture cannot be accepted");
  }
  try {
    const targetWidth = Math.min(DETECTION_MAX_EDGE_PX, inspection.width);
    const { data, info } = await sharp(tiff, { limitInputPixels: 30_000_000, failOn: "error" })
      .rotate()
      .resize({ width: targetWidth, height: DETECTION_MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.channels < 3)
      return rejected("LiDE card-boundary analysis could not decode RGB pixels");

    /*
     * THE CANONICAL DETECTOR, run here on the IMMUTABLE MASTER, independently of anything the
     * Scanner reported. The server remains the final authority and re-derives the geometry itself —
     * it just no longer does so with a DIFFERENT algorithm.
     *
     * WHAT THIS REPLACES. `detectCardBoundary(..., { preserveRawBounds: true })` reduces to
     * `boundingBox(allForegroundPixels)`. On the MV272 master its segmentation was correct — 42.18%
     * card pixels against 43.4% for a real card — but ~0.5% of those pixels, at the platen corner
     * the 0,0-anchored acquisition region includes, stretched the box from 62.8 mm to the full
     * 100 mm width. It reported a 100.0 x 114.0 mm "card" and the plausibility rule below correctly
     * refused it, after a 52-second physical scan. The Scanner's own detector, on the same bytes,
     * found 63.49 x 89.05 mm.
     *
     * A global bounding box measures the extent of everything that is not background. That is the
     * card only when the frame is otherwise spotless, which no real platen ever is.
     *
     * NOTHING BELOW IS RELAXED. The plausibility window and the 4 mm evidence margin are byte-for-
     * byte the rules they were; only the measurement handed to them changed.
     */
    const detected = detectLide400CardBounds(new Uint8Array(data), info.width, info.height, info.channels, acquisition);
    if (!detected)
      return rejected(
        "Card edges could not be determined inside the acquired frame; rescan with clear scanner background on all sides"
      );

    // Map the detector's downscaled pixel bounds back onto the full master for the record.
    const xScale = inspection.width / info.width;
    const yScale = inspection.height / info.height;
    const leftPx = Math.max(0, Math.round(detected.cardBoundsPx.left * xScale));
    const topPx = Math.max(0, Math.round(detected.cardBoundsPx.top * yScale));
    const widthPx = Math.max(1, Math.round(detected.cardBoundsPx.width * xScale));
    const heightPx = Math.max(1, Math.round(detected.cardBoundsPx.height * yScale));

    const cardBoundsMm = {
      left: detected.cardBoundsMm.x,
      top: detected.cardBoundsMm.y,
      width: detected.cardBoundsMm.width,
      height: detected.cardBoundsMm.height,
    };
    const evidenceMarginMm = detected.evidenceMarginMm;
    const common = {
      cardBoundsPx: { left: leftPx, top: topPx, width: widthPx, height: heightPx },
      cardBoundsMm,
      evidenceMarginMm,
      detector: { nonBackgroundPercent: detected.cardPixelPercent, matRgb: detected.backgroundRgb },
    };

    if (
      cardBoundsMm.width < CARD_WIDTH_MM.min ||
      cardBoundsMm.width > CARD_WIDTH_MM.max ||
      cardBoundsMm.height < CARD_HEIGHT_MM.min ||
      cardBoundsMm.height > CARD_HEIGHT_MM.max
    ) {
      return {
        accepted: false,
        reason:
          "Detected card geometry is implausible for a complete standard card; rescan with all four edges visible",
        ...common,
      };
    }
    /*
     * PROFILE CONFORMANCE, after the outer sanity bound and before the margin rule.
     *
     * The Standard TCG profile declares 62.5-65.0 x 87.5-90.5 mm, and the placement gate refuses to
     * go green outside it. Enforcing the same range here is what stops the two from drifting: a
     * client-side-only range would be a rule the server does not actually hold, and every one of
     * those eventually gets bypassed. All eight preserved masters of 2026-08-17 measure
     * 63.27-63.85 x 88.75-89.18 mm and pass comfortably.
     */
    const range = STANDARD_TCG.cardMm;
    if (
      cardBoundsMm.width < range.minWidth ||
      cardBoundsMm.width > range.maxWidth ||
      cardBoundsMm.height < range.minHeight ||
      cardBoundsMm.height > range.maxHeight
    ) {
      return {
        accepted: false,
        reason:
          `Detected card (${cardBoundsMm.width.toFixed(1)} x ${cardBoundsMm.height.toFixed(1)} mm) is outside the ` +
          `${STANDARD_TCG.label} profile range (${range.minWidth}-${range.maxWidth} x ${range.minHeight}-${range.maxHeight} mm); ` +
          `use the correct card profile`,
        ...common,
      };
    }

    const closestMargin = Math.min(...Object.values(evidenceMarginMm));
    if (closestMargin < LIDE_400_MIN_EVIDENCE_MARGIN_MM) {
      return {
        accepted: false,
        reason: `Card is too close to the hardware acquisition boundary (${closestMargin.toFixed(1)} mm; ${LIDE_400_MIN_EVIDENCE_MARGIN_MM} mm required); rescan`,
        ...common,
      };
    }
    return { accepted: true, reason: null, ...common };
  } catch (error: any) {
    return rejected(`Card-boundary safety check failed: ${error?.message || "unreadable TIFF"}`);
  }
}
