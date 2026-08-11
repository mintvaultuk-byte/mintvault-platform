import sharp from "sharp";
import { detectCardBoundary } from "../image-processing";
import type { ScannerEvidenceInspection } from "./image-evidence";

/**
 * The hardware capture is intentionally larger than a card. This is a
 * fail-closed assessment of the *full* acquired TIFF: it neither crops the
 * master nor treats a downstream working crop as proof that the hardware frame
 * contained all four card edges.
 */
export const LIDE_400_MIN_EVIDENCE_MARGIN_MM = 4;
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

    // Preserve raw detected edges: the established working crop's aspect
    // tightening/padding is intentionally not appropriate for an acceptance
    // boundary check, where any uncertainty must fail closed.
    const boundary = detectCardBoundary(new Uint8Array(data), info.width, info.height, info.channels, undefined, {
      safetyPadPx: 0,
      preserveRawBounds: true,
    });
    if (!boundary)
      return rejected(
        "Card edges could not be determined inside the acquired frame; rescan with clear scanner background on all sides"
      );

    const xScale = inspection.width / info.width;
    const yScale = inspection.height / info.height;
    const leftPx = Math.max(0, Math.round(boundary.minX * xScale));
    const topPx = Math.max(0, Math.round(boundary.minY * yScale));
    const rightPx = Math.min(inspection.width - 1, Math.round(boundary.maxX * xScale));
    const bottomPx = Math.min(inspection.height - 1, Math.round(boundary.maxY * yScale));
    const widthPx = rightPx - leftPx + 1;
    const heightPx = bottomPx - topPx + 1;
    if (widthPx <= 0 || heightPx <= 0) return rejected("Card-boundary analysis produced an invalid frame; rescan");

    const xMmPerPixel = acquisition.width / inspection.width;
    const yMmPerPixel = acquisition.height / inspection.height;
    const cardBoundsMm = {
      left: leftPx * xMmPerPixel,
      top: topPx * yMmPerPixel,
      width: widthPx * xMmPerPixel,
      height: heightPx * yMmPerPixel,
    };
    const evidenceMarginMm = {
      left: cardBoundsMm.left,
      top: cardBoundsMm.top,
      right: Math.max(0, (inspection.width - 1 - rightPx) * xMmPerPixel),
      bottom: Math.max(0, (inspection.height - 1 - bottomPx) * yMmPerPixel),
    };
    const common = {
      cardBoundsPx: { left: leftPx, top: topPx, width: widthPx, height: heightPx },
      cardBoundsMm,
      evidenceMarginMm,
      detector: { nonBackgroundPercent: boundary.nonBlackPct, matRgb: boundary.matRgb },
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
