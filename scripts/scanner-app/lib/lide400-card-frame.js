/*
 * Local pre-Accept guard for the generous LiDE hardware frame. It analyses a
 * downscaled copy of the completed TIFF only; it never crops/re-encodes the
 * canonical TIFF and it has no server/evidence-upload capability. The server
 * repeats this guard independently before immutable persistence.
 */
const sharp = require("sharp");
/*
 * THE CANONICAL DETECTOR — the SAME module the server runs against the uploaded master.
 *
 * This local guard used to call `detectCardBounds`, which returns coordinates through the placement
 * Preview's 180-degree presentation transform, while the server ran a different algorithm in raw
 * raster coordinates. The two disagreed on identical bytes (63.49 x 89.05 mm here, 100.0 x 114.0 mm
 * there) and reported the same card at two different positions. Both are now the same call.
 *
 * Evidence geometry is CANONICAL coordinates — acquisition-rect millimetres, no inversion. The
 * inversion remains where it belongs, in the Preview's display/proposal path.
 */
const { detectLide400CardBounds } = require("../../../shared/lide400-card-geometry.cjs");

const MIN_EVIDENCE_MARGIN_MM = 4;

async function assessLide400CardFrame(tiffPath, acquisition) {
  const widthMm = Number(acquisition?.width);
  const heightMm = Number(acquisition?.height);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    return { accepted: false, reason: "LiDE acquisition geometry is unavailable; this TIFF cannot be accepted" };
  }
  try {
    const image = sharp(tiffPath, { limitInputPixels: 30_000_000 }).rotate();
    const metadata = await image.metadata();
    if (metadata.format !== "tiff" || !metadata.width || !metadata.height) {
      return { accepted: false, reason: "Local card-boundary safety check could not decode the TIFF" };
    }
    const { data, info } = await image
      .resize({ width: Math.min(1400, metadata.width), height: 1800, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) return { accepted: false, reason: "Local card-boundary safety check requires RGB TIFF pixels" };
    const candidate = detectLide400CardBounds(data, info.width, info.height, info.channels, {
      width: widthMm,
      height: heightMm,
    });
    if (!candidate) {
      return { accepted: false, reason: "Card edges could not be safely determined; rescan with visible scanner background on all sides" };
    }
    const margin = candidate.evidenceMarginMm;
    const closest = Math.min(margin.left, margin.top, margin.right, margin.bottom);
    const result = {
      coordinateSpace: candidate.coordinateSpace,
      cardBoundsMm: candidate.cardBoundsMm,
      evidenceMarginMm: margin,
      detector: { backgroundRgb: candidate.backgroundRgb },
    };
    if (closest < MIN_EVIDENCE_MARGIN_MM) {
      return {
        accepted: false,
        reason: `Card is too close to the hardware acquisition boundary (${closest.toFixed(1)} mm; ${MIN_EVIDENCE_MARGIN_MM} mm required); rescan`,
        ...result,
      };
    }
    return { accepted: true, reason: null, ...result };
  } catch (error) {
    return { accepted: false, reason: `Local card-boundary safety check failed: ${error.message || String(error)}` };
  }
}

module.exports = { MIN_EVIDENCE_MARGIN_MM, assessLide400CardFrame };
