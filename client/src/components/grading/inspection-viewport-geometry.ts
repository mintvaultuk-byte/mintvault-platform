/**
 * Presentation-only geometry for the grading evidence viewport.
 *
 * 100% is always FIT: the largest complete, uncropped rendering of the source
 * image inside the current CSS viewport. Zoom is relative to that fit. Focus is
 * stored as a normalised image point so browser resizing can recompute directly
 * from current authority without feeding a previous rendered size back in.
 *
 * This module never reads or rewrites defect, centering, crop or MVGS data.
 */

export interface InspectionSize {
  width: number;
  height: number;
}

export interface InspectionPoint {
  x: number;
  y: number;
}

export interface InspectionInsets {
  x: number;
  y: number;
}

export interface InspectionPlacement extends InspectionSize {
  left: number;
  top: number;
  fitWidth: number;
  fitHeight: number;
  focus: InspectionPoint;
}

const ZERO_SIZE: InspectionSize = { width: 0, height: 0 };
const DEFAULT_INSETS: InspectionInsets = { x: 0, y: 0 };

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function fitInspectionImage(
  viewport: InspectionSize,
  natural: InspectionSize,
  insets: InspectionInsets = DEFAULT_INSETS
): InspectionSize {
  if (
    !finitePositive(viewport.width) ||
    !finitePositive(viewport.height) ||
    !finitePositive(natural.width) ||
    !finitePositive(natural.height)
  ) {
    return ZERO_SIZE;
  }
  const safeWidth = Math.max(0, viewport.width - Math.max(0, insets.x) * 2);
  const safeHeight = Math.max(0, viewport.height - Math.max(0, insets.y) * 2);
  if (!finitePositive(safeWidth) || !finitePositive(safeHeight)) return ZERO_SIZE;
  const scale = Math.min(safeWidth / natural.width, safeHeight / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

function clampedAxisFocus(
  viewportSize: number,
  renderedSize: number,
  requestedFocus: number,
  inset: number
): { focus: number; start: number } {
  const safeInset = Math.max(0, inset);
  const safeSize = Math.max(0, viewportSize - safeInset * 2);
  if (!finitePositive(renderedSize) || renderedSize <= safeSize) {
    return { focus: 0.5, start: (viewportSize - renderedSize) / 2 };
  }
  const requestedStart = viewportSize / 2 - clamp(requestedFocus, 0, 1) * renderedSize;
  const start = clamp(requestedStart, viewportSize - safeInset - renderedSize, safeInset);
  return { focus: (viewportSize / 2 - start) / renderedSize, start };
}

export function inspectionPlacement(
  viewport: InspectionSize,
  natural: InspectionSize,
  zoom: number,
  requestedFocus: InspectionPoint,
  insets: InspectionInsets = DEFAULT_INSETS
): InspectionPlacement {
  const fit = fitInspectionImage(viewport, natural, insets);
  const safeZoom = finitePositive(zoom) ? zoom : 1;
  const width = fit.width * safeZoom;
  const height = fit.height * safeZoom;
  const horizontal = clampedAxisFocus(viewport.width, width, requestedFocus.x, insets.x);
  const vertical = clampedAxisFocus(viewport.height, height, requestedFocus.y, insets.y);
  return {
    left: horizontal.start,
    top: vertical.start,
    width,
    height,
    fitWidth: fit.width,
    fitHeight: fit.height,
    focus: { x: horizontal.focus, y: vertical.focus },
  };
}

export function panInspectionFocus(
  viewport: InspectionSize,
  natural: InspectionSize,
  zoom: number,
  focus: InspectionPoint,
  renderedDelta: InspectionPoint,
  insets: InspectionInsets = DEFAULT_INSETS
): InspectionPoint {
  const current = inspectionPlacement(viewport, natural, zoom, focus, insets);
  if (!finitePositive(current.width) || !finitePositive(current.height)) return { x: 0.5, y: 0.5 };
  return inspectionPlacement(
    viewport,
    natural,
    zoom,
    {
      x: current.focus.x - renderedDelta.x / current.width,
      y: current.focus.y - renderedDelta.y / current.height,
    },
    insets
  ).focus;
}

export function screenPointToImagePercent(point: InspectionPoint, placement: InspectionPlacement): InspectionPoint {
  if (!finitePositive(placement.width) || !finitePositive(placement.height)) return { x: 50, y: 50 };
  return {
    x: ((point.x - placement.left) / placement.width) * 100,
    y: ((point.y - placement.top) / placement.height) * 100,
  };
}

export function imagePercentToViewportPoint(percent: InspectionPoint, placement: InspectionPlacement): InspectionPoint {
  return {
    x: placement.left + (percent.x / 100) * placement.width,
    y: placement.top + (percent.y / 100) * placement.height,
  };
}

export function zoomInspectionFocusAtPoint(
  viewport: InspectionSize,
  natural: InspectionSize,
  currentZoom: number,
  nextZoom: number,
  focus: InspectionPoint,
  viewportPoint: InspectionPoint,
  insets: InspectionInsets = DEFAULT_INSETS
): InspectionPoint {
  const current = inspectionPlacement(viewport, natural, currentZoom, focus, insets);
  const imagePercent = screenPointToImagePercent(viewportPoint, current);
  const nextFit = fitInspectionImage(viewport, natural, insets);
  const nextWidth = nextFit.width * nextZoom;
  const nextHeight = nextFit.height * nextZoom;
  if (!finitePositive(nextWidth) || !finitePositive(nextHeight)) return { x: 0.5, y: 0.5 };
  const desiredLeft = viewportPoint.x - (imagePercent.x / 100) * nextWidth;
  const desiredTop = viewportPoint.y - (imagePercent.y / 100) * nextHeight;
  return inspectionPlacement(
    viewport,
    natural,
    nextZoom,
    {
      x: (viewport.width / 2 - desiredLeft) / nextWidth,
      y: (viewport.height / 2 - desiredTop) / nextHeight,
    },
    insets
  ).focus;
}
