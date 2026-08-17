/**
 * THE CANONICAL CANON LiDE 400 CARD-GEOMETRY DETECTOR.
 *
 * ONE implementation, shared by the Scanner's local pre-Accept guard, the placement Preview and the
 * server's immutable-evidence validation. It is deliberately a dependency-free CommonJS module with
 * a hand-written `.d.ts`: the Scanner is untranspiled CJS running from a repository checkout and the
 * server is an esbuild bundle, so this is the only form both can consume WITHOUT a second copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Two independent implementations of "where is the card" disagreed on identical
 * TIFF bytes (staging, MV272, 17 Aug 11:25):
 *
 *   local   63.49 x 89.05 mm   ACCEPTED  → the operator was shown a good preview
 *   server  100.0  x 114.0 mm  REJECTED  → the capture was destroyed after a 52-second scan
 *
 * They agreed on everything that matters and differed only in the last step. Both learned the same
 * background, rgb(233,232,233). The server classified 42.18% of pixels as card, against 43.4% for a
 * real card in a 100 x 130 region — its SEGMENTATION was right. What failed was its REDUCTION:
 * `boundingBox(allForegroundPixels)`. Measured on that exact file, ~0.5% of foreground pixels —
 * about 5,000 of 1,052,294, at the platen corner the 0,0-anchored region includes — stretched the
 * box from 62.8 mm to the full 100 mm width. A single stray pixel anywhere is enough.
 *
 * A global bounding box is not a card detector. It measures the extent of everything that is not
 * background, which is only the card when the frame happens to be otherwise spotless.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THREE SEPARATE STAGES, deliberately named and deliberately not merged:
 *
 *   1. SEGMENTATION  — which pixels are not background.
 *   2. REDUCTION     — which physically plausible CARD-SHAPED region those pixels describe.
 *   3. VALIDATION    — does that region satisfy the immutable evidence rules. NOT in this module;
 *                      it stays with the callers, so this file can never relax an evidence floor.
 *
 * The reduction looks for the dominant card-sized run/region — the behaviour the Scanner's detector
 * has used in production all along. It is NOT percentile clipping: nothing is discarded to make a
 * particular image pass. A region is a candidate only if it is already the size of a trading card,
 * so noise is not trimmed away, it is simply never the answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CANONICAL COORDINATE CONVENTION — one convention, everywhere, stated once:
 *
 *   ORIGIN   the TOP-LEFT of the ImageCaptureCore acquisition rectangle.
 *   UNITS    millimetres of real platen.
 *   +X       rightwards across the stored raster.
 *   +Y       downwards through the stored raster.
 *   ROTATION NONE. The 180-degree platen inversion is NEVER applied here.
 *
 * The LiDE platen is physically inverted relative to how staff place a card, and the Scanner has
 * always corrected for it. That correction is a PRESENTATION concern and belongs at exactly one
 * named boundary — `rasterRectToPhysicalRect` in lide400-preview-transform.js, used by the placement
 * Preview for its overlays and its placement proposal. It must never be applied to evidence
 * geometry, because that is how the same physical card came to be reported at 30.2, 36.3 locally and
 * 6.6, 5.1 on the server: two conventions, silently incomparable, and no way to tell which was right.
 *
 * Width, height and the SET of four margins are invariant under a 180-degree rotation, so the
 * evidence rules (card dimensions, minimum margin) return identical verdicts either way. Only the
 * reported position moves — which is precisely the ambiguity being removed.
 */

/** Millimetres, from the acquisition rectangle's top-left. See the convention note above. */
const CANONICAL_COORDINATE_SPACE = "lide400-acquisition-rect-mm-v1";

/**
 * A trading card is 63.5 x 88.9 mm. These bounds are the DETECTION search window and are
 * deliberately wider than the evidence rule they feed: this module answers "which region looks like
 * a card", and the caller's validation then answers "is that a card we accept". Narrowing the
 * search here would silently do validation's job in a place with no authority to do it.
 */
const CARD_SEARCH_MM = Object.freeze({
  minWidth: 48,
  maxWidth: 78,
  minHeight: 70,
  maxHeight: 108,
});

/** Border ring sampled to learn the background, as a fraction of the shorter raster edge. */
const BACKGROUND_RING_FRACTION = 0.02;
const BACKGROUND_RING_MIN_PX = 5;

/**
 * Euclidean colour distance from the learned background beyond which a pixel is card.
 *
 * This is the SERVER's historic threshold, adopted deliberately: where the two implementations used
 * different tests, the canonical one takes the stricter authority's, so unifying them can never make
 * the evidence path more permissive than it was.
 */
const CARD_PIXEL_DISTANCE = 45;

/** A row/column counts as occupied once this fraction of it is card pixels. */
const OCCUPANCY_THRESHOLD = 0.035;
/** A connected component must fill at least this fraction of its own bounding box. */
const COMPONENT_MIN_FILL = 0.04;

function median(values) {
  if (!values.length) return 0;
  const sorted = Array.prototype.slice.call(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * STAGE 1 — SEGMENTATION.
 *
 * The background is learned from a border ring rather than assumed, so the detector works against a
 * white platen, a dark lid or anything between. Median, not mean: a few card pixels intruding into
 * the ring cannot drag the reference colour.
 */
function learnBackground(raw, width, height, channels) {
  const ring = Math.max(BACKGROUND_RING_MIN_PX, Math.round(Math.min(width, height) * BACKGROUND_RING_FRACTION));
  const reds = [];
  const greens = [];
  const blues = [];
  const sample = (x, y) => {
    const offset = (y * width + x) * channels;
    reds.push(raw[offset]);
    greens.push(raw[offset + 1]);
    blues.push(raw[offset + 2]);
  };
  for (let y = 0; y < ring && y < height; y++) for (let x = 0; x < width; x++) sample(x, y);
  for (let y = Math.max(ring, height - ring); y < height; y++) for (let x = 0; x < width; x++) sample(x, y);
  for (let y = ring; y < height - ring; y++) {
    for (let x = 0; x < ring && x < width; x++) sample(x, y);
    for (let x = Math.max(ring, width - ring); x < width; x++) sample(x, y);
  }
  return { r: median(reds), g: median(greens), b: median(blues), distance: CARD_PIXEL_DISTANCE };
}

/** Card-pixel mask plus per-axis occupancy, from one pass over the raster. */
function segmentCardPixels(raw, width, height, channels, background) {
  const active = new Uint8Array(width * height);
  const columns = new Uint32Array(width);
  const rows = new Uint32Array(height);
  let cardPixels = 0;
  const limit = background.distance * background.distance;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const dr = raw[offset] - background.r;
      const dg = raw[offset + 1] - background.g;
      const db = raw[offset + 2] - background.b;
      if (dr * dr + dg * dg + db * db <= limit) continue;
      active[y * width + x] = 1;
      columns[x]++;
      rows[y]++;
      cardPixels++;
    }
  }
  return { active, columns, rows, cardPixels };
}

/**
 * STAGE 2a — the dominant CARD-SIZED run along one axis.
 *
 * Occupancy is scanned for contiguous runs, and a run is a candidate ONLY if its physical size is
 * already within the card search window. Sparse outliers form their own tiny runs that can never
 * qualify, so they are not trimmed, weighted or clipped — they simply are not card-shaped.
 */
function dominantCardRun(occupancy, mmPerPixel, minMm, maxMm) {
  const runs = [];
  let start = null;
  for (let index = 0; index <= occupancy.length; index++) {
    const occupied = index < occupancy.length && occupancy[index] >= OCCUPANCY_THRESHOLD;
    if (occupied && start === null) start = index;
    if (!occupied && start !== null) {
      const sizeMm = (index - start) * mmPerPixel;
      if (sizeMm >= minMm && sizeMm <= maxMm) runs.push({ start, end: index, sizeMm });
      start = null;
    }
  }
  return runs.sort((a, b) => b.sizeMm - a.sizeMm)[0] || null;
}

/**
 * STAGE 2b — the dominant CARD-SIZED connected component.
 *
 * The fallback for when projection cannot separate the card, most often because an unrelated
 * artefact spans the full raster width and makes every column look occupied. Flood-fill is
 * iterative, never recursive: a 30-megapixel frame would overflow the call stack.
 *
 * Consumes `active` destructively — callers pass a copy when they still need the mask.
 */
function dominantCardComponent(active, width, height, regionMm) {
  const queue = new Uint32Array(active.length);
  const xMmPerPixel = regionMm.width / width;
  const yMmPerPixel = regionMm.height / height;
  let best = null;
  for (let seed = 0; seed < active.length; seed++) {
    if (!active[seed]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = seed;
    active[seed] = 0;
    let count = 0;
    let minX = seed % width;
    let maxX = minX;
    let minY = Math.floor(seed / width);
    let maxY = minY;
    while (head < tail) {
      const point = queue[head++];
      const x = point % width;
      const y = (point - x) / width;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const enqueue = (neighbour) => {
        if (active[neighbour]) {
          active[neighbour] = 0;
          queue[tail++] = neighbour;
        }
      };
      if (x > 0) enqueue(point - 1);
      if (x + 1 < width) enqueue(point + 1);
      if (y > 0) enqueue(point - width);
      if (y + 1 < height) enqueue(point + width);
    }
    const componentWidthMm = (maxX - minX + 1) * xMmPerPixel;
    const componentHeightMm = (maxY - minY + 1) * yMmPerPixel;
    const fill = count / ((maxX - minX + 1) * (maxY - minY + 1));
    if (
      componentWidthMm < CARD_SEARCH_MM.minWidth ||
      componentWidthMm > CARD_SEARCH_MM.maxWidth ||
      componentHeightMm < CARD_SEARCH_MM.minHeight ||
      componentHeightMm > CARD_SEARCH_MM.maxHeight ||
      fill < COMPONENT_MIN_FILL
    ) {
      continue;
    }
    const score = fill * count;
    if (!best || score > best.score) best = { minX, maxX, minY, maxY, score };
  }
  return best;
}

/**
 * THE CANONICAL DETECTION. Raw RGB pixels in, card bounds in canonical millimetres out, or null.
 *
 * `null` means "no physically plausible card region was found" and every caller must treat it as a
 * refusal. It is never a licence to fall back to the whole frame — falling back to the whole frame
 * is the defect this module exists to remove.
 *
 * @param {Uint8Array} raw            tightly packed pixels
 * @param {number} width              raster width
 * @param {number} height             raster height
 * @param {number} channels           samples per pixel (>= 3; any alpha must be removed first)
 * @param {{width:number,height:number}} regionMm  the ImageCaptureCore acquisition rectangle
 */
function detectLide400CardBounds(raw, width, height, channels, regionMm) {
  if (!raw || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!Number.isFinite(channels) || channels < 3) return null;
  const areaWidth = Number(regionMm && regionMm.width);
  const areaHeight = Number(regionMm && regionMm.height);
  if (!Number.isFinite(areaWidth) || !Number.isFinite(areaHeight) || areaWidth <= 0 || areaHeight <= 0) return null;

  const background = learnBackground(raw, width, height, channels);
  const { active, columns, rows, cardPixels } = segmentCardPixels(raw, width, height, channels, background);
  if (!cardPixels) return null;

  const xMmPerPixel = areaWidth / width;
  const yMmPerPixel = areaHeight / height;
  const horizontal = dominantCardRun(
    Array.from(columns, (count) => count / height),
    xMmPerPixel,
    CARD_SEARCH_MM.minWidth,
    CARD_SEARCH_MM.maxWidth
  );
  const vertical = dominantCardRun(
    Array.from(rows, (count) => count / width),
    yMmPerPixel,
    CARD_SEARCH_MM.minHeight,
    CARD_SEARCH_MM.maxHeight
  );

  let bounds;
  let method;
  if (horizontal && vertical) {
    bounds = { minX: horizontal.start, maxX: horizontal.end - 1, minY: vertical.start, maxY: vertical.end - 1 };
    method = "dominant_run";
  } else {
    const component = dominantCardComponent(active, width, height, { width: areaWidth, height: areaHeight });
    if (!component) return null;
    bounds = component;
    method = "dominant_component";
  }

  const cardBoundsMm = {
    x: bounds.minX * xMmPerPixel,
    y: bounds.minY * yMmPerPixel,
    width: (bounds.maxX - bounds.minX + 1) * xMmPerPixel,
    height: (bounds.maxY - bounds.minY + 1) * yMmPerPixel,
  };
  return {
    coordinateSpace: CANONICAL_COORDINATE_SPACE,
    detectionMethod: method,
    cardBoundsPx: {
      left: bounds.minX,
      top: bounds.minY,
      width: bounds.maxX - bounds.minX + 1,
      height: bounds.maxY - bounds.minY + 1,
    },
    cardBoundsMm,
    /** Background visible on each side, in the SAME canonical convention. */
    evidenceMarginMm: {
      left: cardBoundsMm.x,
      top: cardBoundsMm.y,
      right: Math.max(0, areaWidth - (cardBoundsMm.x + cardBoundsMm.width)),
      bottom: Math.max(0, areaHeight - (cardBoundsMm.y + cardBoundsMm.height)),
    },
    backgroundRgb: { r: background.r, g: background.g, b: background.b },
    cardPixelPercent: (100 * cardPixels) / (width * height),
  };
}

module.exports = {
  CANONICAL_COORDINATE_SPACE,
  CARD_SEARCH_MM,
  CARD_PIXEL_DISTANCE,
  detectLide400CardBounds,
  // Exported for focused tests of each stage; callers should use detectLide400CardBounds.
  _stages: { learnBackground, segmentCardPixels, dominantCardRun, dominantCardComponent },
};
