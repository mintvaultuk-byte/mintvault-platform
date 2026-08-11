/*
 * Canonical coordinate contract for the local LiDE setup Preview.
 *
 * ImageCaptureCore reports an acquisition rectangle in millimetres. The
 * bridge requests `scanAreaOrientation = 1`, so only an upright (or absent
 * EXIF orientation) preview raster is accepted. Detection, the proposed final
 * acquisition rectangle, and the renderer all use this one mapping:
 *
 *   ImageCaptureCore scan-area mm <-> upright, 180° presentation raster pixels
 *     <-> the contained image rectangle inside the Scanner UI viewport.
 *
 * No calibration offset is stored here. Any unexpected rotation/mirror fails
 * closed instead of being silently compensated with an unexplained transform.
 */
(function exposePreviewTransform(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MintVaultLidePreviewTransform = api;
})(typeof globalThis === "undefined" ? this : globalThis, () => {
  // ImageCaptureCore reports physical scanner coordinates in the source raster
  // direction. A card placed upright for the operator is physically inverted
  // in the LiDE 400 output, so every *presentation* preview is turned 180°.
  // This contract maps a physical rectangle directly into that displayed
  // raster; overlays and detected bounds must never use a separate offset.
  const COORDINATE_SPACE = "imagecapturecore-scan-area-presentation-raster-rotate-180-v2";
  const PRESENTATION_ROTATION_DEGREES = 180;

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
    return number;
  }

  function rect(value, name = "rectangle") {
    if (!value || typeof value !== "object") throw new Error(`${name} is required`);
    const result = {
      x: finite(value.x, `${name}.x`),
      y: finite(value.y, `${name}.y`),
      width: finite(value.width, `${name}.width`),
      height: finite(value.height, `${name}.height`),
    };
    if (result.width <= 0 || result.height <= 0) throw new Error(`${name} must have positive width and height`);
    return result;
  }

  function raster(value, name = "raster") {
    if (!value || typeof value !== "object") throw new Error(`${name} is required`);
    const result = { width: finite(value.width, `${name}.width`), height: finite(value.height, `${name}.height`) };
    if (result.width <= 0 || result.height <= 0) throw new Error(`${name} must have positive width and height`);
    return result;
  }

  function assertUprightOrientation(orientation) {
    const resolved = orientation == null ? 1 : finite(orientation, "Preview EXIF orientation");
    if (resolved !== 1) {
      throw new Error(`LiDE positioning Preview must be upright (EXIF orientation 1); received ${resolved}`);
    }
    return resolved;
  }

  function physicalRectToRasterRect(physicalRect, acquisitionAreaMm, previewRaster) {
    const physical = rect(physicalRect, "physical rectangle");
    const area = rect(acquisitionAreaMm, "ImageCaptureCore acquisition area");
    const pixels = raster(previewRaster, "Preview raster");
    const sourceRect = {
      x: ((physical.x - area.x) / area.width) * pixels.width,
      y: ((physical.y - area.y) / area.height) * pixels.height,
      width: (physical.width / area.width) * pixels.width,
      height: (physical.height / area.height) * pixels.height,
    };
    return {
      x: pixels.width - (sourceRect.x + sourceRect.width),
      y: pixels.height - (sourceRect.y + sourceRect.height),
      width: sourceRect.width,
      height: sourceRect.height,
    };
  }

  function rasterRectToPhysicalRect(rasterRect, acquisitionAreaMm, previewRaster) {
    const pixels = rect(rasterRect, "raster rectangle");
    const area = rect(acquisitionAreaMm, "ImageCaptureCore acquisition area");
    const source = raster(previewRaster, "Preview raster");
    const sourceRect = {
      x: source.width - (pixels.x + pixels.width),
      y: source.height - (pixels.y + pixels.height),
      width: pixels.width,
      height: pixels.height,
    };
    return {
      x: area.x + (sourceRect.x / source.width) * area.width,
      y: area.y + (sourceRect.y / source.height) * area.height,
      width: (pixels.width / source.width) * area.width,
      height: (pixels.height / source.height) * area.height,
    };
  }

  function containedRasterRect(rasterRect, sourceRaster, viewportRaster) {
    const source = raster(sourceRaster, "source raster");
    const viewport = raster(viewportRaster, "viewport raster");
    const sourceRect = rect(rasterRect, "raster rectangle");
    const scale = Math.min(viewport.width / source.width, viewport.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    const offsetX = (viewport.width - width) / 2;
    const offsetY = (viewport.height - height) / 2;
    return {
      x: offsetX + sourceRect.x * scale,
      y: offsetY + sourceRect.y * scale,
      width: sourceRect.width * scale,
      height: sourceRect.height * scale,
      imageRect: { x: offsetX, y: offsetY, width, height },
      scale,
    };
  }

  function physicalRectToContainedViewportRect(physicalRect, acquisitionAreaMm, sourceRaster, viewportRaster) {
    return containedRasterRect(
      physicalRectToRasterRect(physicalRect, acquisitionAreaMm, sourceRaster),
      sourceRaster,
      viewportRaster,
    );
  }

  return {
    COORDINATE_SPACE,
    PRESENTATION_ROTATION_DEGREES,
    assertUprightOrientation,
    physicalRectToRasterRect,
    rasterRectToPhysicalRect,
    containedRasterRect,
    physicalRectToContainedViewportRect,
  };
});
