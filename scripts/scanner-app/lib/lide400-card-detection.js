/*
 * Local-only card detection and placement-zone proposal for the Canon LiDE
 * setup Preview. These helpers analyse a non-authoritative positioning image;
 * they never write a crop, create evidence provenance, or reach the server.
 */

const { STANDARD_TCG } = require("../../../shared/lide400-capture-profile.cjs");
/**
 * Sourced from the capture profile rather than restated. Two files each holding their own "4" is how
 * a floor gets changed in one place and silently kept in the other.
 */
const MIN_EVIDENCE_MARGIN_MM = STANDARD_TCG.evidenceMinMarginMm;
const { rasterRectToPhysicalRect } = require("./lide400-preview-transform");
/** The canonical, shared segmentation + card-shaped reduction. See shared/lide400-card-geometry.cjs. */
const { detectLide400CardBounds } = require("../../../shared/lide400-card-geometry.cjs");

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function longestExpectedSpan(occupancy, mmPerPixel, minMm, maxMm) {
  const spans = [];
  let start = null;
  for (let index = 0; index <= occupancy.length; index++) {
    const active = index < occupancy.length && occupancy[index] >= 0.035;
    if (active && start === null) start = index;
    if (!active && start !== null) {
      const end = index;
      const sizeMm = (end - start) * mmPerPixel;
      if (sizeMm >= minMm && sizeMm <= maxMm) spans.push({ start, end, sizeMm });
      start = null;
    }
  }
  return spans.sort((a, b) => b.sizeMm - a.sizeMm)[0] || null;
}

/**
 * Find one connected non-background component whose physical bounding box is a
 * plausible standard portrait card.  Projection-only detection is vulnerable
 * to a dark platen/lid reflection that spans the full raster width: it makes
 * every column look occupied even when the actual card is clearly isolated.
 *
 * This does not loosen card acceptance. The candidate must still have the
 * standard-card dimensions and every final TIFF is separately checked for its
 * four physical evidence margins. It only makes positioning Preview robust to
 * unrelated full-width scanner artefacts.
 */
function findExpectedCardComponent(active, width, height, regionMm) {
  const expected = [];
  const queue = new Uint32Array(active.length);
  const xMmPerPixel = regionMm.width / width;
  const yMmPerPixel = regionMm.height / height;
  for (let start = 0; start < active.length; start++) {
    if (!active[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    active[start] = 0;
    let count = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    while (head < tail) {
      const point = queue[head++];
      const x = point % width;
      const y = Math.floor(point / width);
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const enqueue = (neighbor) => {
        if (active[neighbor]) {
          active[neighbor] = 0;
          queue[tail++] = neighbor;
        }
      };
      if (x > 0) enqueue(point - 1);
      if (x + 1 < width) enqueue(point + 1);
      if (y > 0) enqueue(point - width);
      if (y + 1 < height) enqueue(point + width);
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const widthMm = componentWidth * xMmPerPixel;
    const heightMm = componentHeight * yMmPerPixel;
    const fill = count / (componentWidth * componentHeight);
    if (widthMm >= 48 && widthMm <= 78 && heightMm >= 70 && heightMm <= 108 && fill >= 0.04) {
      expected.push({ minX, maxX, minY, maxY, count, fill, widthMm, heightMm });
    }
  }
  return expected.sort((a, b) => (b.fill * b.count) - (a.fill * a.count))[0] || null;
}

/**
 * Detect a portrait standard-card candidate against a uniform scanner bed.
 * `regionMm` is the *actual ImageCaptureCore acquisition rectangle*, so the
 * returned geometry is in real platen millimetres rather than preview pixels.
 */
function detectCardBounds(raw, width, height, regionMm, channels = 3) {
  /*
   * THE CANONICAL DETECTOR DOES THE FINDING; THIS FUNCTION ONLY CHANGES COORDINATES.
   *
   * Segmentation and card-shaped reduction now live in ONE place, shared with the Scanner's
   * pre-Accept guard and the server's immutable-evidence validation, so a card cannot be found in
   * one position by one implementation and somewhere else by another.
   *
   * WHAT REMAINS HERE, AND WHY. The placement Preview is an OPERATOR-FACING surface: its overlays
   * and its placement proposal are drawn in the orientation staff actually see, because the LiDE
   * platen is physically inverted relative to how a card is laid down. That 180-degree correction is
   * a PRESENTATION concern, and this is now the single named boundary where it is applied —
   * `rasterRectToPhysicalRect`. It is deliberately NOT applied to evidence geometry: doing so
   * silently is how the same physical card came to be reported at 30.2, 36.3 by the Scanner's
   * evidence guard and at 6.3, 4.7 by the server, with no way to tell which was right.
   */
  const detected = detectLide400CardBounds(raw, width, height, channels, regionMm);
  if (!detected) return null;
  const cardBoundsMm = rasterRectToPhysicalRect(
    {
      x: detected.cardBoundsPx.left,
      y: detected.cardBoundsPx.top,
      width: detected.cardBoundsPx.width,
      height: detected.cardBoundsPx.height,
    },
    regionMm,
    { width, height }
  );
  const { x, y, width: cardWidth, height: cardHeight } = cardBoundsMm;
  return {
    cardBoundsMm: { x, y, width: cardWidth, height: cardHeight },
    surroundingBackgroundMm: {
      left: x - regionMm.x,
      top: y - regionMm.y,
      right: regionMm.x + regionMm.width - (x + cardWidth),
      bottom: regionMm.y + regionMm.height - (y + cardHeight),
    },
    backgroundRgb: [detected.backgroundRgb.r, detected.backgroundRgb.g, detected.backgroundRgb.b],
    detectionMethod: detected.detectionMethod,
    /** The same bounds in the canonical evidence convention, for diagnostics that must compare. */
    canonicalCardBoundsMm: detected.cardBoundsMm,
    coordinateSpace: "lide400-preview-presentation-mm-v1",
  };
}

/** Retained for the legacy projection helpers below, which the canonical detector supersedes. */
function legacyDetectCardBounds(raw, width, height, regionMm) {
  const border = Math.max(3, Math.floor(Math.min(width, height) * 0.025));
  const red = [];
  const green = [];
  const blue = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= border && x < width - border && y >= border && y < height - border) continue;
      const offset = (y * width + x) * 3;
      red.push(raw[offset]);
      green.push(raw[offset + 1]);
      blue.push(raw[offset + 2]);
    }
  }
  const background = [median(red), median(green), median(blue)];
  const columns = new Uint32Array(width);
  const rows = new Uint32Array(height);
  const active = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const difference =
        Math.abs(raw[offset] - background[0]) +
        Math.abs(raw[offset + 1] - background[1]) +
        Math.abs(raw[offset + 2] - background[2]);
      if (difference < 72) continue;
      active[y * width + x] = 1;
      columns[x]++;
      rows[y]++;
    }
  }
  const xMmPerPixel = regionMm.width / width;
  const yMmPerPixel = regionMm.height / height;
  const horizontal = longestExpectedSpan(Array.from(columns, (count) => count / height), xMmPerPixel, 48, 78);
  const vertical = longestExpectedSpan(Array.from(rows, (count) => count / width), yMmPerPixel, 70, 108);
  let rasterBounds;
  let detectionMethod = "projection";
  if (horizontal && vertical) {
    rasterBounds = {
      x: horizontal.start,
      y: vertical.start,
      width: horizontal.end - horizontal.start,
      height: vertical.end - vertical.start,
    };
  } else {
    const component = findExpectedCardComponent(active, width, height, regionMm);
    if (!component) return null;
    rasterBounds = {
      x: component.minX,
      y: component.minY,
      width: component.maxX - component.minX + 1,
      height: component.maxY - component.minY + 1,
    };
    detectionMethod = "connected_component";
  }
  const cardBoundsMm = rasterRectToPhysicalRect({
    ...rasterBounds,
  }, regionMm, { width, height });
  const { x, y, width: cardWidth, height: cardHeight } = cardBoundsMm;
  return {
    cardBoundsMm: { x, y, width: cardWidth, height: cardHeight },
    surroundingBackgroundMm: {
      left: x - regionMm.x,
      top: y - regionMm.y,
      right: regionMm.x + regionMm.width - (x + cardWidth),
      bottom: regionMm.y + regionMm.height - (y + cardHeight),
    },
    backgroundRgb: background,
    detectionMethod,
  };
}

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * REMOVED 2026-08-17: `derivePlacementProposal`, and the whole card-chasing architecture.
 *
 * It took the detected card bounds and computed where the 100 x 130 mm HARDWARE ACQUISITION
 * RECTANGLE should move to in order to sit around that card — centring it on the card, then solving
 * a clamp window against the platen. For a card near a platen edge the solve had no solution and it
 * proposed rectangles off the glass entirely, such as x = -11.54, y = -15.09. The operator's
 * experience of that was a Scanner that refused every position while apparently asking them to keep
 * moving the card, because the target was moving with them.
 *
 * The capture area is now FIXED: its size is the profile's, its origin is calibrated once during
 * station setup (`watcher.saveCaptureWindowOrigin`), and the detector's only job is to find the card
 * INSIDE it. `detectCardBounds` below still does exactly that, and the verdict belongs to
 * `evaluatePlacement` in shared/lide400-capture-profile.cjs.
 *
 * Do not reintroduce a function that derives acquisition geometry from card position. If a card
 * cannot be captured where it lies, the answer is to move the CARD.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

module.exports = {
  MIN_EVIDENCE_MARGIN_MM,
  detectCardBounds,
  _private: { longestExpectedSpan, findExpectedCardComponent },
};
