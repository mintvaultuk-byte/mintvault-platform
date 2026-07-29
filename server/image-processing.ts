/**
 * MintVault Image Processing
 * Auto-crop, image variant generation, and quality checks for grading images.
 */
import sharp from "sharp";

// Trading card corner radius as percentage of the SHORTER dimension.
// 3% of min(width, height) — e.g. ~46 px on a 1520×2097 image. Spec
// equivalence: ~3 mm on a 63 mm card is ~4.76%, but at full crop tightness
// 4.8% × width was visibly eating into the yellow border on real scans
// (the post-tighten card width is much closer to the actual card edge
// than the print spec, so the proportion needs to shrink). The min-dim
// basis also makes the radius behave consistently when the image
// aspect deviates from the card aspect.
const CARD_CORNER_RADIUS_PCT = 0.03;

/**
 * Apply rounded-rectangle mask matching card corner radius.
 * Output is PNG with transparent corners AND a consistent white RGB fill
 * under the transparent pixels — so any downstream flatten (PDF export,
 * thumbnailers that drop alpha, older email clients) renders clean white,
 * not whatever pixel colour happened to sit under the masked-out corner.
 */
export async function maskRoundedCorners(inputBuffer: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return inputBuffer;

    const w = meta.width;
    const h = meta.height;
    const r = Math.round(Math.min(w, h) * CARD_CORNER_RADIUS_PCT);

    const svgMask = Buffer.from(
      `<svg width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="white"/></svg>`
    );

    // Step 1: apply alpha mask (only modifies alpha channel; RGB retained)
    const masked = await sharp(inputBuffer)
      .ensureAlpha()
      .composite([{ input: svgMask, blend: "dest-in" }])
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Step 2: flatten RGB under FULLY-transparent pixels to white (255).
    //
    // Originally `α < 128` to catch the whole AA fringe, but that interacts
    // badly with sharp's PNG quantization (.png({quality:90}) below uses
    // palette mode and crushes alpha to ~3-5 buckets per image, chosen
    // per-image by the quantizer). When the quantizer picks a bucket like
    // α=83 for the outer AA fringe, the original `α<128` rewrote those
    // pixels' RGB to white. The α=83 bucket then composited against the
    // public page's near-white bg as page-bg-coloured pixels — creating
    // a visible "thin white halo" 1px outside the solid card on dark-
    // bordered scans (MV101/back, MV109/back screenshot-confirmed
    // 2026-05-14). Cases where the quantizer happened to pick α=2 + α=255
    // (MV105/back, MV105/front, etc.) didn't show the halo — α=2
    // contributes <1% to composited visible colour regardless of RGB.
    //
    // Narrowing to α === 0 preserves the partial-alpha fringe's underlying
    // card RGB so AA composites smoothly: solid card → light-card → page-bg.
    // No white-jump in the middle of the gradient.
    //
    // α=0 pixels still get RGB=(255,255,255) so non-alpha-aware viewers
    // (rare — PDFKit supports alpha; web/<img>/IG OG all support alpha)
    // render the corner triangles as clean white.
    const px = new Uint8Array(masked.data);
    let flattenedCount = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) {
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        flattenedCount++;
      }
    }

    // Step 3: re-encode as PNG
    const out = await sharp(px, { raw: { width: masked.info.width, height: masked.info.height, channels: 4 } })
      .png({ quality: 90 })
      .toBuffer();

    console.log(
      `[mask] rounded corners: r=${r}px on ${w}×${h} (flattened ${flattenedCount} transparent-corner pixels to white)`
    );
    return out;
  } catch (err: any) {
    console.warn("[mask] rounded corner masking failed, returning original:", err.message);
    return inputBuffer;
  }
}

export interface QualityCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface QualityResult {
  overall: "pass" | "warn" | "fail";
  checks: QualityCheck[];
}

// ── Adaptive background-subtraction card detection ──────────────────────────
// Samples corners of the image to determine background colour, then uses
// luminance distance to separate card from background. More robust than
// fixed black threshold for holographic/silver/pale-bordered cards.

const FALLBACK_BLACK_THRESHOLD = 30;

/** Luminance of an RGB pixel (BT.601 weights) */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Sample average RGB from a corner block of the image */
function sampleCorner(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  startX: number,
  startY: number,
  size: number
): { r: number; g: number; b: number; luma: number } {
  let sumR = 0,
    sumG = 0,
    sumB = 0,
    count = 0;
  const endX = Math.min(startX + size, w);
  const endY = Math.min(startY + size, h);
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * ch;
      sumR += pixels[idx];
      sumG += pixels[idx + 1];
      sumB += pixels[idx + 2];
      count++;
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0, luma: 0 };
  const avgR = sumR / count,
    avgG = sumG / count,
    avgB = sumB / count;
  return { r: avgR, g: avgG, b: avgB, luma: luma(avgR, avgG, avgB) };
}

/**
 * Compute adaptive background colour by sampling all 4 corners, with a
 * mat-aware branching threshold.
 *
 * Fix 0 — bug: old formula `threshold = avgLuma + max(25, avgLuma*0.6+15)`
 * for a white mat (avgLuma≈246.9) produced threshold≈410.0, which exceeds
 * max luma (255). `isBackgroundAdaptive` returning `luma < threshold` was
 * then ALWAYS true — every pixel flagged as background → adaptive-luma
 * stage always failed on bright mats, falling through to later fallbacks.
 *
 * New branching (standard mat is WHITE — tuned for that):
 *   - avgLuma > 180 (bright mat): threshold = avgLuma − 60. Background
 *     is BRIGHT (high luma). "isBackground(p)" = luma(p) > threshold.
 *   - avgLuma < 60  (dark mat):  threshold = clamp(avgLuma + margin, 200).
 *     Background is DARK (low luma). "isBackground(p)" = luma(p) < threshold.
 *   - 60 ≤ avgLuma ≤ 180 (ambiguous): log warning and default to the
 *     bright-mat formula (standard mat is white).
 *
 * Returns an `isBackground(r,g,b)` closure so callers don't need to know
 * which direction to compare.
 */
function computeBackgroundProfile(pixels: Uint8Array, w: number, h: number, ch: number) {
  const sz = Math.max(20, Math.round(Math.min(w, h) * 0.04)); // ~4% of shorter dimension
  const corners = [
    sampleCorner(pixels, w, h, ch, 0, 0, sz), // top-left
    sampleCorner(pixels, w, h, ch, w - sz, 0, sz), // top-right
    sampleCorner(pixels, w, h, ch, 0, h - sz, sz), // bottom-left
    sampleCorner(pixels, w, h, ch, w - sz, h - sz, sz), // bottom-right
  ];
  const avgLuma = corners.reduce((s, c) => s + c.luma, 0) / corners.length;
  const avgR = corners.reduce((s, c) => s + c.r, 0) / corners.length;
  const avgG = corners.reduce((s, c) => s + c.g, 0) / corners.length;
  const avgB = corners.reduce((s, c) => s + c.b, 0) / corners.length;

  let mode: "bright-mat" | "dark-mat" | "ambiguous";
  let threshold: number;
  let isBackground: (r: number, g: number, b: number) => boolean;

  if (avgLuma > 180) {
    mode = "bright-mat";
    threshold = avgLuma - 60; // ~186 for avgLuma=246
    isBackground = (r, g, b) => luma(r, g, b) > threshold;
  } else if (avgLuma < 60) {
    mode = "dark-mat";
    const margin = Math.max(25, avgLuma * 0.6 + 15);
    threshold = Math.min(200, avgLuma + margin);
    isBackground = (r, g, b) => luma(r, g, b) < threshold;
  } else {
    // Ambiguous band: treat as bright-mat (standard mat is white) but warn.
    mode = "ambiguous";
    threshold = avgLuma - 60;
    isBackground = (r, g, b) => luma(r, g, b) > threshold;
  }

  return { avgR, avgG, avgB, avgLuma, threshold, mode, isBackground };
}

/** Legacy fallback: fixed black threshold */
function isBackground(r: number, g: number, b: number): boolean {
  return r < FALLBACK_BLACK_THRESHOLD && g < FALLBACK_BLACK_THRESHOLD && b < FALLBACK_BLACK_THRESHOLD;
}

// ── Mat-agnostic card detection (works for black AND white scanner mats) ─────
// Samples a thin border strip (outer 2% on all 4 sides) and takes the median
// RGB as the mat colour. A pixel is classified as "card" if its Euclidean
// colour distance from the mat median exceeds a threshold. This replaces the
// luma-below-threshold approach, which only worked against dark mats.

interface MatProfile {
  matR: number;
  matG: number;
  matB: number;
  threshold: number;
}

/** Sample outer 2% border strip, return median RGB as mat colour */
function computeMatProfile(pixels: Uint8Array, w: number, h: number, ch: number): MatProfile {
  const borderPx = Math.max(5, Math.round(Math.min(w, h) * 0.02));
  const rs: number[] = [],
    gs: number[] = [],
    bs: number[] = [];

  const pushAt = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    rs.push(pixels[i]);
    gs.push(pixels[i + 1]);
    bs.push(pixels[i + 2]);
  };

  for (let y = 0; y < borderPx; y++) for (let x = 0; x < w; x++) pushAt(x, y);
  for (let y = h - borderPx; y < h; y++) for (let x = 0; x < w; x++) pushAt(x, y);
  for (let y = borderPx; y < h - borderPx; y++) {
    for (let x = 0; x < borderPx; x++) pushAt(x, y);
    for (let x = w - borderPx; x < w; x++) pushAt(x, y);
  }

  const median = (arr: number[]) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };

  return { matR: median(rs), matG: median(gs), matB: median(bs), threshold: 45 };
}

/** Euclidean colour distance from mat median exceeds threshold → card pixel */
function isCardPixel(r: number, g: number, b: number, mat: MatProfile): boolean {
  const dr = r - mat.matR,
    dg = g - mat.matG,
    db = b - mat.matB;
  return Math.sqrt(dr * dr + dg * dg + db * db) > mat.threshold;
}

/**
 * Detect card boundary using adaptive background detection.
 * Samples corners to learn background colour, then finds bounding box of all non-background pixels.
 * Falls back to fixed black threshold if adaptive detection fails.
 */
export interface BoundaryDetection {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  nonBlackPct: number;
  matRgb: { r: number; g: number; b: number };
}

export function detectCardBoundary(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  certId?: string | number,
  options?: { safetyPadPx?: number }
): BoundaryDetection | null {
  const certTag = certId != null ? ` cert=${certId}` : "";
  const safetyPadPx = options?.safetyPadPx ?? CARD_DETECT_SAFETY_PAD_PX;

  // Primary: mat-distance detector (works against any mat colour)
  const mat = computeMatProfile(pixels, w, h, ch);
  const matRgb = { r: mat.matR, g: mat.matG, b: mat.matB };
  console.log(
    `[card-detect] mat profile: rgb(${mat.matR},${mat.matG},${mat.matB}) distance threshold=${mat.threshold} pad=${safetyPadPx}${certTag}`
  );
  const matIsBg = (r: number, g: number, b: number) => !isCardPixel(r, g, b, mat);
  const matBased = detectBoundaryWithTest(pixels, w, h, ch, matIsBg);
  if (matBased) {
    console.log(`[card-detect] mat-distance detection: ${matBased.nonBlackPct.toFixed(1)}% card pixels${certTag}`);
    return { ...tightenToPokemonAspect(pixels, w, h, ch, matBased, matIsBg, certTag, safetyPadPx), matRgb };
  }

  // Fallback 1: adaptive-luma (Fix 0 — mat-aware branching, uses isBackground closure)
  const bg = computeBackgroundProfile(pixels, w, h, ch);
  const bgRgb = { r: Math.round(bg.avgR), g: Math.round(bg.avgG), b: Math.round(bg.avgB) };
  console.log(
    `[card-detect] adaptive-luma: mat_luma=${bg.avgLuma.toFixed(1)} threshold=${bg.threshold.toFixed(1)} (${bg.mode} mode)${certTag}`
  );
  if (bg.mode === "ambiguous") {
    console.warn(`[card-detect] ambiguous mat luma (60–180) — defaulting to bright-mat formula${certTag}`);
  }
  const adaptive = detectBoundaryWithTest(pixels, w, h, ch, bg.isBackground);
  if (adaptive) {
    console.log(`[card-detect] adaptive-luma detection: ${adaptive.nonBlackPct.toFixed(1)}% non-bg${certTag}`);
    return {
      ...tightenToPokemonAspect(pixels, w, h, ch, adaptive, bg.isBackground, certTag, safetyPadPx),
      matRgb: bgRgb,
    };
  }

  // Fallback 2: fixed black threshold
  console.log(`[card-detect] adaptive-luma failed, falling back to fixed black threshold${certTag}`);
  const fixed = detectBoundaryWithTest(pixels, w, h, ch, isBackground);
  if (!fixed) return null;
  return {
    ...tightenToPokemonAspect(pixels, w, h, ch, fixed, isBackground, certTag, safetyPadPx),
    matRgb: { r: 0, g: 0, b: 0 },
  };
}

/** Core boundary detection with a pluggable background test */
function detectBoundaryWithTest(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  isBg: (r: number, g: number, b: number) => boolean
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } | null {
  let minX = w,
    maxX = 0,
    minY = h,
    maxY = 0;
  let fgCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * ch;
      if (!isBg(pixels[idx], pixels[idx + 1], pixels[idx + 2])) {
        fgCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const totalPixels = w * h;
  const nonBlackPct = (fgCount / totalPixels) * 100;

  // Sanity: card should be 20-95% of image
  if (nonBlackPct < 20 || nonBlackPct > 95 || maxX <= minX || maxY <= minY) {
    return null;
  }

  return { minX, maxX, minY, maxY, nonBlackPct };
}

// ── Fix 1: aspect-tighten to Pokémon card ratio ──────────────────────────────
// Pokémon standard card is 63mm × 88mm → width/height = 0.7159. Raw card-detect
// bounds often include a mm or two of mat because the outer card border is
// pale; tightening to the expected ratio trims that remainder. Symmetric shrink
// (both edges by equal px) so we don't introduce bias for the re-centre stage.
// Safeguard: bail out if shrinking would discard >2% of the bounds-internal
// card pixels — that means the true card isn't aspect-off, the test is, and
// we should leave the bounds alone rather than eat into the card.

const POKEMON_ASPECT = 0.716;
const ASPECT_TOL = 0.005;
const MAX_ASPECT_TRIM_LOSS_PCT = 2;

// Outward-pad the detected card bounds by this many pixels on every side
// before returning. Guarantees aspect-tighten can never produce a bounds
// rect that's tight against real card edges — there's always a small buffer
// of mat (or mat-coloured rotation-fill from deskewCard) on every side.
// The strip is invisible downstream: padWithMat covers it with the
// mat-coloured passport frame, so the visual effect is "thicker mat
// padding" not "extra mat strip visible inside the card". Tuneable.
const CARD_DETECT_SAFETY_PAD_PX = 22;

// Expand bounds outward by padPx, clamped to the image frame so we never
// index past the bitmap. Applied at every return path of
// tightenToPokemonAspect so it kicks in regardless of which branch ran
// (in-range, successful trim, pixel-loss bail, zero-trim bail).
// padPx defaults to CARD_DETECT_SAFETY_PAD_PX so existing callers keep
// the v590 8 px behaviour; the display-pipeline tightenForDisplay overrides
// to 0 because it needs bounds flush with the actual card edge.
function applySafetyPad(
  b: { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number },
  w: number,
  h: number,
  padPx: number = CARD_DETECT_SAFETY_PAD_PX
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } {
  return {
    minX: Math.max(0, b.minX - padPx),
    maxX: Math.min(w - 1, b.maxX + padPx),
    minY: Math.max(0, b.minY - padPx),
    maxY: Math.min(h - 1, b.maxY + padPx),
    nonBlackPct: b.nonBlackPct,
  };
}

function tightenToPokemonAspect(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number },
  isBg: (r: number, g: number, b: number) => boolean,
  certTag: string,
  safetyPadPx: number = CARD_DETECT_SAFETY_PAD_PX
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } {
  const startMinX = bounds.minX,
    startMaxX = bounds.maxX;
  const startMinY = bounds.minY,
    startMaxY = bounds.maxY;
  const startW = startMaxX - startMinX + 1;
  const startH = startMaxY - startMinY + 1;
  const startRatio = startW / startH;

  // Already in range — nothing to do
  if (startRatio >= POKEMON_ASPECT - ASPECT_TOL && startRatio <= POKEMON_ASPECT + ASPECT_TOL) {
    console.log(`[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} in-range, no trim${certTag}`);
    return applySafetyPad(bounds, w, h, safetyPadPx);
  }

  // Integral image of fg pixels over the WHOLE frame, built once. Lets us
  // check "fg pixels inside rect R" in O(1) per iteration.
  const integ = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const fg = isBg(pixels[i], pixels[i + 1], pixels[i + 2]) ? 0 : 1;
      rowSum += fg;
      integ[y * w + x] = rowSum + (y > 0 ? integ[(y - 1) * w + x] : 0);
    }
  }
  const fgCountInRect = (x0: number, x1: number, y0: number, y1: number) => {
    const A = x0 > 0 && y0 > 0 ? integ[(y0 - 1) * w + (x0 - 1)] : 0;
    const B = y0 > 0 ? integ[(y0 - 1) * w + x1] : 0;
    const C = x0 > 0 ? integ[y1 * w + (x0 - 1)] : 0;
    const D = integ[y1 * w + x1];
    return D - B - C + A;
  };

  const originalFg = fgCountInRect(startMinX, startMaxX, startMinY, startMaxY);
  const maxLoss = Math.max(1, Math.floor((originalFg * MAX_ASPECT_TRIM_LOSS_PCT) / 100));

  let minX = startMinX,
    maxX = startMaxX,
    minY = startMinY,
    maxY = startMaxY;
  let aborted: "pixel-loss" | "collapse" | null = null;

  // Symmetric 1-px shrink per side per iteration, max bw+bh steps
  const maxSteps = startW + startH;
  for (let step = 0; step < maxSteps; step++) {
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const ratio = bw / bh;
    if (ratio >= POKEMON_ASPECT - ASPECT_TOL && ratio <= POKEMON_ASPECT + ASPECT_TOL) break;

    let nMinX = minX,
      nMaxX = maxX,
      nMinY = minY,
      nMaxY = maxY;
    if (ratio > POKEMON_ASPECT + ASPECT_TOL) {
      nMinX = minX + 1;
      nMaxX = maxX - 1;
    } else {
      nMinY = minY + 1;
      nMaxY = maxY - 1;
    }
    if (nMaxX <= nMinX || nMaxY <= nMinY) {
      aborted = "collapse";
      break;
    }

    const fgAfter = fgCountInRect(nMinX, nMaxX, nMinY, nMaxY);
    if (originalFg - fgAfter > maxLoss) {
      aborted = "pixel-loss";
      break;
    }

    minX = nMinX;
    maxX = nMaxX;
    minY = nMinY;
    maxY = nMaxY;
  }

  const finalW = maxX - minX + 1;
  const finalH = maxY - minY + 1;
  const finalRatio = finalW / finalH;
  const trimmedW = startW - finalW;
  const trimmedH = startH - finalH;
  const finalFg = fgCountInRect(minX, maxX, minY, maxY);
  const finalPct = (finalFg / (finalW * finalH)) * 100;

  if (trimmedW === 0 && trimmedH === 0) {
    console.log(
      `[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} could not shrink (${aborted || "bounds"})${certTag}`
    );
    return applySafetyPad(bounds, w, h, safetyPadPx);
  }

  // Discard partial trim on pixel-loss bail. Previous behaviour kept whatever
  // had been trimmed up to the safeguard, which clipped real card edges on
  // tilted scans (MV133/Oddish — 54-66 px lost before the bail fired). With
  // the tightened threshold above the partial trim is small (~2-3 px) but
  // the safeguard firing is itself a signal that the ratio is too far off,
  // so the safest move is to return the original bounds untouched.
  if (aborted === "pixel-loss") {
    console.log(
      `[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} pixel-loss safeguard fired — discarding partial trim (${trimmedW}×${trimmedH}px), returning original bounds${certTag}`
    );
    return applySafetyPad(bounds, w, h, safetyPadPx);
  }

  const suffix = aborted ? ` [early-exit: ${aborted}]` : "";
  console.log(
    `[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} → ${finalRatio.toFixed(3)} (trimmed ${trimmedW}px width, ${trimmedH}px height)${suffix}${certTag}`
  );

  return applySafetyPad({ minX, maxX, minY, maxY, nonBlackPct: finalPct }, w, h, safetyPadPx);
}

/**
 * Deskew using mat-agnostic edge detection. Works on ANY scanner mat colour
 * (black, white, neutral) by measuring each pixel's colour distance from the
 * sampled mat colour rather than assuming a dark background.
 */
export async function deskewCard(inputBuffer: Buffer): Promise<{ buffer: Buffer; angle: number }> {
  try {
    console.log(`[deskew] START mat-agnostic edge detection (${(inputBuffer.length / 1024).toFixed(0)}KB input)`);
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return { buffer: inputBuffer, angle: 0 };

    const scale = Math.min(1, 1500 / Math.max(meta.width, meta.height));
    const workW = Math.round(meta.width * scale);
    const workH = Math.round(meta.height * scale);

    const { data, info } = await sharp(inputBuffer)
      .resize(workW, workH, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    const w = info.width;
    const h = info.height;
    const ch = info.channels;

    const mat = computeMatProfile(pixels, w, h, ch);
    console.log(`[deskew] mat colour: rgb(${mat.matR},${mat.matG},${mat.matB}) distance threshold=${mat.threshold}`);
    const isCard = (r: number, g: number, b: number) => isCardPixel(r, g, b, mat);

    // Scan top 30% of image: for each row, find leftmost+rightmost card pixel
    const topEdgePoints: { x: number; y: number }[] = [];
    for (let row = 0; row < Math.round(h * 0.3); row++) {
      let rowLeft = -1,
        rowRight = -1,
        fgInRow = 0;
      for (let col = 0; col < w; col++) {
        const idx = (row * w + col) * ch;
        if (isCard(pixels[idx], pixels[idx + 1], pixels[idx + 2])) {
          fgInRow++;
          if (rowLeft === -1) rowLeft = col;
          rowRight = col;
        }
      }
      // Row must have >30% card pixels to count as card content
      if (fgInRow > w * 0.3 && rowLeft >= 0) {
        topEdgePoints.push({ x: rowLeft, y: row });
        topEdgePoints.push({ x: rowRight, y: row });
        if (topEdgePoints.length > 60) break;
      }
    }

    if (topEdgePoints.length < 10) {
      console.log(
        `[deskew] not enough card-edge points (${topEdgePoints.length}) against mat rgb(${mat.matR},${mat.matG},${mat.matB}), skipping`
      );
      return { buffer: inputBuffer, angle: 0 };
    }

    // Linear regression on edge points
    const n = topEdgePoints.length;
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;
    for (const p of topEdgePoints) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumX2 += p.x * p.x;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 0.001) return { buffer: inputBuffer, angle: 0 };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const radians = Math.atan(slope);
    const angle = radians * (180 / Math.PI);

    console.log(`[deskew] non-black edge: points=${n} raw_rad=${radians.toFixed(6)} degrees=${angle.toFixed(4)}`);

    if (Math.abs(angle) > 15) {
      console.log(`[deskew] angle ${angle.toFixed(2)}° exceeds ±15°, skipping`);
      return { buffer: inputBuffer, angle: 0 };
    }
    if (Math.abs(angle) < 0.05) {
      console.log(`[deskew] angle ${angle.toFixed(4)}° below 0.05° threshold, skipping`);
      return { buffer: inputBuffer, angle: 0 };
    }

    const rotated = await sharp(inputBuffer)
      .rotate(-angle, { background: { r: mat.matR, g: mat.matG, b: mat.matB, alpha: 1 } }) // fill rotated edges with sampled mat colour so they trim cleanly downstream
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();

    console.log(
      `[deskew] corrected ${angle.toFixed(2)}° (${n} edge points, mat-fill rgb(${mat.matR},${mat.matG},${mat.matB}))`
    );
    return { buffer: rotated, angle };
  } catch (err: any) {
    console.warn("[deskew] detection failed, skipping:", err.message);
    return { buffer: inputBuffer, angle: 0 };
  }
}

// ── Physical-card rectangle isolation (sleeved / top-loader safe) ───────────
//
// WHY THIS EXISTS
// ---------------
// detectCardBoundary() takes the global MIN/MAX of every pixel whose colour
// distance from the sampled mat median exceeds a threshold. That assumes the
// frame contains exactly TWO things: one uniform mat, and the card. A sleeved
// or top-loadered scan contains at least four: white scanner bed, the sleeve
// (near-mat, with glare), the card, and scanner-jig / neighbouring-object
// hardware at the frame border. Every non-mat pixel that is NOT the card —
// a dark jig strip at the left edge, a dust speck at the top, the guide rail
// along the bottom — drags the global min/max outward. One such pixel per
// side is enough to return the entire frame.
//
// MV642/front (Korean 메가자리ex, 1474×2000 source) is the reference failure:
//   mat median rgb(237,242,246)  — a near-WHITE scanner bed
//   global bbox  → 1104×1483 of an 1106×1500 detector frame (99.8% × 98.9%)
//   aspect 0.744 (frame aspect), not 0.716 (card aspect)
//   → aspect-tighten trimmed 36 px, applySafetyPad(+22 px) gave it all back
//   → 1474×2000 "cropped" to 1473×1999, i.e. one pixel of isolation
//
// THE FIX
// -------
// Replace global min/max with a per-axis COVERAGE PROFILE plus a
// LONGEST-CONTIGUOUS-RUN selection. A physical card is a solid rectangle, so
// every row it spans is ~90% non-mat and every row it does not span is ~0%.
// Foreign hardware is partial: on MV642 the left-edge jig strip covers 44% of
// its columns and the bottom guide covers 23-47% of its rows — far below the
// card's 91% plateau, so neither joins the run. Measured on MV642/front:
//
//   colCoverage  x=0..10   0.44,0.35   (jig)     x=20..60  ~0.005 (bed/sleeve)
//                x=80..1040 0.89-0.92  (CARD)    x=1080+   0.001  (bed)
//   rowCoverage  y=0..90   0.000       (bed)     y=120..1440 0.88-0.91 (CARD)
//                y=1470..1499 0.47,0.34,0.23     (lower jig)
//
//   longest run → x[75,1059] × y[96,1469] = 985×1374, aspect 0.7169
//
// 0.7169 against the true 63×88 mm card aspect of 0.7159 is agreement to
// within 0.0010 — an INDEPENDENT confirmation that the run found the card and
// not the sleeve, the bed or the frame. That agreement is the core of the
// multi-signal test below: no single threshold decides anything on its own.
//
// The detected rectangle also yields the scan's true resolution
// (985 px / 63 mm ≈ 20.8 px/mm ≈ 529 dpi at detector scale), which is what
// converts the safety margin from millimetres into pixels. No magic margins.

/** Trading-card print spec. Source of the expected aspect AND of px/mm. */
const CARD_WIDTH_MM = 63;
const CARD_HEIGHT_MM = 88;
const CARD_ASPECT = CARD_WIDTH_MM / CARD_HEIGHT_MM; // 0.715909…

/**
 * Aspect tolerance for accepting a candidate as the physical card.
 * ±0.035 ≈ ±4.9% of the nominal ratio. Sized to absorb (a) deskew residual —
 * deskewCard only corrects to ±0.05°, and a 0.5° residual on an 88 mm card
 * shifts the measured ratio by ~0.006; (b) mild perspective from a card
 * lifting inside a loose sleeve, measured at up to ~0.02 on the sample set;
 * (c) ±2 px of run-boundary quantisation at detector scale (~0.003). It is
 * deliberately far TIGHTER than the gap to the two things we must never
 * accept: a full 1474×2000 scanner frame is 0.737 and a typical sleeve
 * rectangle is 0.75-0.78, both outside the band on the sample set — but the
 * aspect test is only one of several signals, never a lone gate.
 */
const CARD_ASPECT_TOL = 0.035;

/**
 * Safety margin retained around the detected physical card in the scanner
 * intermediate. Expressed in MILLIMETRES and converted with the px/mm implied
 * by the detected rectangle, so it is identical in physical terms at any scan
 * resolution. 1.5 mm is enough for the Card Tool to recentre without running
 * out of pixels, and small enough that it cannot reach the sleeve seam (which
 * on the sample set sits 3 mm or more outside the card).
 */
const CARD_SAFETY_MARGIN_MM = 1.5;

/**
 * Floor for the bounded reduction policy. If a source edge cannot supply
 * CARD_SAFETY_MARGIN_MM the margin is reduced per-edge to whatever the source
 * actually has, down to zero — the margin is only ever added OUTSIDE the
 * detected card rectangle, so reducing it can never clip the card. Anything
 * below this is reported as a degraded margin so it is visible in forensics.
 */
const CARD_MIN_SAFETY_MARGIN_MM = 0.5;

/**
 * Hysteresis thresholds for the coverage run, as fractions of the profile peak.
 *
 * SEED (0.75) picks the longest contiguous plateau — this is what rejects
 * partial hardware (MV642's jig strip covers 0.44 of its columns, the guide
 * rail 0.23-0.47 of its rows, both far below the card's 0.91 plateau).
 *
 * EXTEND (0.60) then grows that run outward while coverage stays card-like.
 * Without it a single dipping row INSIDE the card splits the run and the
 * detector keeps only the larger half: MV602/back has a pale highlight band
 * across the card at row 676 measuring 0.68 against a 0.93 peak — just under
 * the seed threshold — which cut the detected card down to its lower 765 rows
 * (aspect 1.28) and failed the face closed.
 *
 * The gap between the two is what makes this safe: extension stops at the
 * FIRST index below 0.60, with no gap bridging, so MV642's 0.47/0.34/0.23 jig
 * rows still end the run immediately rather than being absorbed.
 */
const CARD_RUN_SEED_FRACTION = 0.75;
const CARD_RUN_EXTEND_FRACTION = 0.6;

/**
 * Maximum saturation (max channel − min channel) the sampled surround may have
 * and still be a scanner background. Scanner mats, bed vinyl and jigs are
 * achromatic; a printed card border is not. 40 leaves room for a tinted or
 * warm-lit mat while excluding any real card colour (a yellow Pokémon border
 * measures ~200).
 */
const MAT_MAX_SATURATION = 40;

/** Card must occupy at least this fraction of the frame to be a plausible card. */
const CARD_MIN_AREA_FRACTION = 0.15;

/**
 * Card must occupy at most this fraction of the frame. Above this the "card"
 * is the frame: a real scan always shows bed on all four sides.
 */
const CARD_MAX_AREA_FRACTION = 0.92;

/** Retaining this fraction or more of BOTH axes is not card isolation. */
const NEAR_FULL_FRAME_AXIS_FRACTION = 0.97;

/** Removing less than this fraction of the frame area is not card isolation. */
const NEAR_FULL_FRAME_MIN_AREA_REMOVED = 0.02;

export type CardIsolationReason =
  | "near_full_frame_not_card_isolation"
  | "negligible_pixels_removed"
  | "frame_adjacent_edges"
  | "aspect_out_of_card_range"
  | "area_implausible"
  | "no_edge_step_evidence"
  | "edges_not_parallel"
  | "no_contiguous_card_run"
  | "coverage_peak_too_low"
  | "surround_is_not_scanner_background";

export interface PhysicalCardRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  w: number;
  h: number;
  aspect: number;
  /** Scan resolution implied by the detected card against the 63×88 mm spec. */
  pxPerMm: number;
  /** Distance from each frame edge, in detector-frame pixels. */
  edgeDist: { top: number; bottom: number; left: number; right: number };
  /** Peak coverage of each axis profile — how solid the card plateau is. */
  peak: { row: number; col: number };
  signals: {
    areaOk: boolean;
    aspectOk: boolean;
    edgeStepOk: boolean;
    parallelOk: boolean;
    notFrameAdjacent: boolean;
    coveragePeakOk: boolean;
    matAchromatic: boolean;
  };
  /** How many of the seven independent signals agreed. */
  signalCount: number;
  confidence: "high" | "low";
  /** True only when the rectangle may be used as the physical card. */
  trusted: boolean;
  reasons: CardIsolationReason[];
}

export interface NearFullFrameAssessment {
  nearFullFrame: boolean;
  reasons: CardIsolationReason[];
  retainedFraction: { w: number; h: number; area: number };
  frameAdjacentEdges: number;
}

/**
 * Explicit guard against meaningless "successful" isolation.
 *
 * Applies to ANY candidate rectangle, whichever detector produced it. A result
 * that keeps essentially the whole frame is not a card — it is the scan. It
 * must never be silently handed to the safety-pad / uniform-inset path, which
 * is what turned MV642's whole-frame bbox into a 1441×1967 "cropped" image
 * still showing the scanner bed and the lower jig.
 */
export function assessNearFullFrame(
  rect: { minX: number; maxX: number; minY: number; maxY: number },
  w: number,
  h: number
): NearFullFrameAssessment {
  const rw = rect.maxX - rect.minX + 1;
  const rh = rect.maxY - rect.minY + 1;
  const retained = { w: rw / w, h: rh / h, area: (rw * rh) / (w * h) };

  // "Touching" tolerance scales with the frame so it means the same thing at
  // any detector scale; the 3 px floor covers small frames.
  const tolX = Math.max(3, Math.round(w * 0.005));
  const tolY = Math.max(3, Math.round(h * 0.005));
  const frameAdjacentEdges =
    (rect.minX <= tolX ? 1 : 0) +
    (rect.minY <= tolY ? 1 : 0) +
    (w - 1 - rect.maxX <= tolX ? 1 : 0) +
    (h - 1 - rect.maxY <= tolY ? 1 : 0);

  const reasons: CardIsolationReason[] = [];
  if (retained.w >= NEAR_FULL_FRAME_AXIS_FRACTION && retained.h >= NEAR_FULL_FRAME_AXIS_FRACTION) {
    reasons.push("near_full_frame_not_card_isolation");
  }
  if (1 - retained.area < NEAR_FULL_FRAME_MIN_AREA_REMOVED) {
    reasons.push("negligible_pixels_removed");
  }
  if (frameAdjacentEdges >= 3) {
    reasons.push("frame_adjacent_edges");
  }

  return { nearFullFrame: reasons.length > 0, reasons, retainedFraction: retained, frameAdjacentEdges };
}

/**
 * Median distance of outer-strip pixels from the strip median — a robust,
 * outlier-resistant measure of how much the scanner background actually
 * varies. Sampled on the same outer 2% strip computeMatProfile uses.
 */
function matStripMedianDistance(pixels: Uint8Array, w: number, h: number, ch: number, mat: MatProfile): number {
  const borderPx = Math.max(5, Math.round(Math.min(w, h) * 0.02));
  const d: number[] = [];
  const at = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    const dr = pixels[i] - mat.matR,
      dg = pixels[i + 1] - mat.matG,
      db = pixels[i + 2] - mat.matB;
    d.push(Math.sqrt(dr * dr + dg * dg + db * db));
  };
  // Stride the strip: a few thousand samples are plenty for a median and keep
  // this O(1)-ish relative to the full-frame scan that follows.
  const step = Math.max(1, Math.round(Math.min(w, h) / 200));
  for (let y = 0; y < borderPx; y += 1) for (let x = 0; x < w; x += step) at(x, y);
  for (let y = h - borderPx; y < h; y += 1) for (let x = 0; x < w; x += step) at(x, y);
  for (let y = borderPx; y < h - borderPx; y += step) {
    for (let x = 0; x < borderPx; x++) at(x, y);
    for (let x = w - borderPx; x < w; x++) at(x, y);
  }
  if (d.length === 0) return 0;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** Longest contiguous run of indices whose coverage meets `thr`. */
function longestCoverageRun(cov: Float64Array, thr: number, maxGap: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let bestLen = 0;
  let start = -1;
  let gap = 0;
  for (let i = 0; i < cov.length; i++) {
    if (cov[i] >= thr) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      // Bridge only pinhole gaps (a scratch or a thin glare band inside the
      // card). Anything wider ends the run, which is what keeps the card run
      // from reaching across a strip of bed into a jig or a guide rail.
      if (gap > maxGap) {
        const end = i - gap;
        if (end - start + 1 > bestLen) {
          bestLen = end - start + 1;
          best = { start, end };
        }
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) {
    const end = cov.length - 1 - gap;
    if (end - start + 1 > bestLen) best = { start, end };
  }
  return best;
}

/** True when both edges have room for an offset step band plus the band itself. */
function edgeDistFits(lo: number, hi: number, size: number, band: number): boolean {
  return lo >= 2 * band + 1 && size - 1 - hi >= 2 * band + 1;
}

/**
 * Grow a seeded run outward while coverage stays above the extend threshold.
 * Stops at the first index below it — no gap bridging — so partial hardware
 * adjacent to the card cannot be absorbed.
 */
function extendRun(
  run: { start: number; end: number } | null,
  cov: Float64Array,
  extendThr: number
): { start: number; end: number } | null {
  if (!run) return null;
  let { start, end } = run;
  while (start > 0 && cov[start - 1] >= extendThr) start--;
  while (end < cov.length - 1 && cov[end + 1] >= extendThr) end++;
  return { start, end };
}

/** Mean coverage over an index band, clamped to the profile. */
function bandMean(cov: Float64Array, from: number, to: number): number {
  const a = Math.max(0, from);
  const b = Math.min(cov.length - 1, to);
  if (b < a) return 0;
  let s = 0;
  for (let i = a; i <= b; i++) s += cov[i];
  return s / (b - a + 1);
}

/** Sample where the card boundary sits along one edge, at several scanlines. */
function edgeBoundarySamples(
  isCard: (x: number, y: number) => boolean,
  edge: "top" | "bottom" | "left" | "right",
  rect: { minX: number; maxX: number; minY: number; maxY: number }
): number[] {
  const fractions = [0.2, 0.35, 0.5, 0.65, 0.8];
  const out: number[] = [];
  for (const f of fractions) {
    if (edge === "top" || edge === "bottom") {
      const x = Math.round(rect.minX + (rect.maxX - rect.minX) * f);
      if (edge === "top") {
        for (let y = rect.minY; y <= rect.maxY; y++)
          if (isCard(x, y)) {
            out.push(y);
            break;
          }
      } else {
        for (let y = rect.maxY; y >= rect.minY; y--)
          if (isCard(x, y)) {
            out.push(y);
            break;
          }
      }
    } else {
      const y = Math.round(rect.minY + (rect.maxY - rect.minY) * f);
      if (edge === "left") {
        for (let x = rect.minX; x <= rect.maxX; x++)
          if (isCard(x, y)) {
            out.push(x);
            break;
          }
      } else {
        for (let x = rect.maxX; x >= rect.minX; x--)
          if (isCard(x, y)) {
            out.push(x);
            break;
          }
      }
    }
  }
  return out;
}

function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}

/**
 * Locate the physical trading-card rectangle inside a scan, using several
 * independent signals rather than one colour threshold.
 *
 * Returns a rectangle whenever a contiguous card-shaped plateau exists, with
 * `trusted` set only when the mandatory signals agree. Returns null when there
 * is no plateau at all. The caller must fail closed on `trusted === false`.
 */
export function detectPhysicalCardRect(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  certId?: string | number
): PhysicalCardRect | null {
  const certTag = certId != null ? ` cert=${certId}` : "";
  // Same mat sampling as the production primary detector. The primary failure
  // was never the mat profile — it was taking the global min/max of everything
  // that passed the threshold, which any single stray pixel blows out to the
  // whole frame.
  const mat = computeMatProfile(pixels, w, h, ch);

  // Adaptive content threshold, derived from the mat strip's OWN noise rather
  // than fixed at 45.
  //
  // A fixed 45 is what blinds the detector to a pale card border: a near-white
  // border sits ~15 units from a white bed, so at 45 the border is classified
  // as mat and the plateau starts at the ARTWORK — cropping to that would cut
  // the printed border off. Scaling from the strip's median absolute distance
  // (a robust noise measure) keeps the threshold just above whatever variation
  // the bed genuinely has, so a pale border reads as card while bed texture,
  // sleeve glare and JPEG noise do not.
  //
  // The low floor is safe HERE specifically because every decision below is
  // made on ROW/COLUMN COVERAGE, not on individual pixels: a row must be ~75%
  // of the plateau height before it counts, so scattered noise contributes
  // ~1/w and changes nothing. The ceiling keeps the proven production value as
  // an upper bound on a noisy mat.
  const stripNoise = matStripMedianDistance(pixels, w, h, ch, mat);
  mat.threshold = Math.min(45, Math.max(10, Math.round(4 * stripNoise)));

  const isCardAt = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    return isCardPixel(pixels[i], pixels[i + 1], pixels[i + 2], mat);
  };

  const rowCov = new Float64Array(h);
  const colCount = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    let rowCount = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      if (isCardPixel(pixels[i], pixels[i + 1], pixels[i + 2], mat)) {
        rowCount++;
        colCount[x]++;
      }
    }
    rowCov[y] = rowCount / w;
  }
  const colCov = new Float64Array(w);
  for (let x = 0; x < w; x++) colCov[x] = colCount[x] / h;

  // Peak = 95th percentile, not the max: one saturated scratch row must not
  // set the plateau height the rest of the card is then measured against.
  const pct95 = (a: Float64Array) => {
    const s = Array.from(a).sort((p, q) => q - p);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.05))];
  };
  const peakRow = pct95(rowCov);
  const peakCol = pct95(colCov);

  const rowRun = extendRun(
    longestCoverageRun(rowCov, CARD_RUN_SEED_FRACTION * peakRow, Math.max(2, Math.round(h * 0.002))),
    rowCov,
    CARD_RUN_EXTEND_FRACTION * peakRow
  );
  const colRun = extendRun(
    longestCoverageRun(colCov, CARD_RUN_SEED_FRACTION * peakCol, Math.max(2, Math.round(w * 0.002))),
    colCov,
    CARD_RUN_EXTEND_FRACTION * peakCol
  );

  if (!rowRun || !colRun || rowRun.end <= rowRun.start || colRun.end <= colRun.start) {
    console.warn(`[card-rect] no contiguous card plateau found${certTag}`);
    return null;
  }

  const rect = { minX: colRun.start, maxX: colRun.end, minY: rowRun.start, maxY: rowRun.end };
  const rw = rect.maxX - rect.minX + 1;
  const rh = rect.maxY - rect.minY + 1;
  const aspect = rw / rh;
  const areaFraction = (rw * rh) / (w * h);
  const edgeDist = {
    left: rect.minX,
    top: rect.minY,
    right: w - 1 - rect.maxX,
    bottom: h - 1 - rect.maxY,
  };

  const reasons: CardIsolationReason[] = [];

  // Signal 1 — plausible share of the frame.
  const areaOk = areaFraction >= CARD_MIN_AREA_FRACTION && areaFraction <= CARD_MAX_AREA_FRACTION;
  if (!areaOk) reasons.push("area_implausible");

  // Signal 2 — agrees with the 63×88 mm print spec.
  const aspectOk = Math.abs(aspect - CARD_ASPECT) <= CARD_ASPECT_TOL;
  if (!aspectOk) reasons.push("aspect_out_of_card_range");

  // Signal 3 — coverage really STEPS at all four boundaries. A rectangle
  // carved out of a gradient has no step; a card does. This is what separates
  // a printed card edge from a transparent sleeve edge, which produces only a
  // shallow coverage ripple rather than a step.
  //
  // The outside coverage is the MINIMUM of the band immediately outside the
  // boundary and the band one width beyond it. Measured outward coverage profiles on the sleeved
  // production sample (bands of 0.6% of the dimension, walking away from the
  // card edge) look like this:
  //
  //   MV642/front  top 0.12 0.00 0.00 …   left 0.22 0.01 0.01 …
  //   MV645/front  bot 0.39 0.28 0.37 …   left 0.43 0.11 0.02 …
  //   MV649/front  bot 0.51 0.15 0.00 …   right 0.50 0.10 0.00 …
  //
  // The FIRST band often carries the transition — card-edge blur plus the
  // sleeve seam — which is physically there and cannot be thresholded away, so
  // measuring only against it reports "no step" on every sleeved scan. But the
  // SECOND band can land on hardware sitting just outside the card (a guide
  // rail), so measuring only against that reports "no step" whenever the jig is
  // close. Taking the minimum asks the right question: does coverage fall to
  // background level ANYWHERE in the two band-widths just outside the boundary?
  // A re-rise beyond that is hardware, not the card. Where there is no room for
  // the offset band, the immediate band is used alone.
  const stepBandRow = Math.max(3, Math.round(h * 0.006));
  const stepBandCol = Math.max(3, Math.round(w * 0.006));
  const offsetRow = edgeDistFits(rect.minY, rect.maxY, h, stepBandRow) ? stepBandRow : 0;
  const offsetCol = edgeDistFits(rect.minX, rect.maxX, w, stepBandCol) ? stepBandCol : 0;
  const outsideBefore = (cov: Float64Array, at: number, band: number, offset: number) =>
    Math.min(bandMean(cov, at - band - 1, at - 1), bandMean(cov, at - offset - band - 1, at - offset - 1));
  const outsideAfter = (cov: Float64Array, at: number, band: number, offset: number) =>
    Math.min(bandMean(cov, at + 1, at + band + 1), bandMean(cov, at + offset + 1, at + offset + band + 1));

  const insideTop = bandMean(rowCov, rect.minY, rect.minY + stepBandRow);
  const outsideTop = outsideBefore(rowCov, rect.minY, stepBandRow, offsetRow);
  const insideBottom = bandMean(rowCov, rect.maxY - stepBandRow, rect.maxY);
  const outsideBottom = outsideAfter(rowCov, rect.maxY, stepBandRow, offsetRow);
  const insideLeft = bandMean(colCov, rect.minX, rect.minX + stepBandCol);
  const outsideLeft = outsideBefore(colCov, rect.minX, stepBandCol, offsetCol);
  const insideRight = bandMean(colCov, rect.maxX - stepBandCol, rect.maxX);
  const outsideRight = outsideAfter(colCov, rect.maxX, stepBandCol, offsetCol);
  const step = (inside: number, outside: number) => inside > 0 && outside < inside * 0.5;
  const edgeStepOk =
    step(insideTop, outsideTop) &&
    step(insideBottom, outsideBottom) &&
    step(insideLeft, outsideLeft) &&
    step(insideRight, outsideRight);
  if (!edgeStepOk) reasons.push("no_edge_step_evidence");

  // Signal 4 — opposing edges are straight and parallel. Measured directly on
  // the bitmap at five scanlines per edge, independent of the profiles above.
  const parTolX = Math.max(3, Math.round(w * 0.008));
  const parTolY = Math.max(3, Math.round(h * 0.008));
  const parallelOk =
    stddev(edgeBoundarySamples(isCardAt, "top", rect)) <= parTolY &&
    stddev(edgeBoundarySamples(isCardAt, "bottom", rect)) <= parTolY &&
    stddev(edgeBoundarySamples(isCardAt, "left", rect)) <= parTolX &&
    stddev(edgeBoundarySamples(isCardAt, "right", rect)) <= parTolX;
  if (!parallelOk) reasons.push("edges_not_parallel");

  // Signal 5 — the rectangle is not pinned against the frame. A real scan
  // shows bed on all four sides; a rectangle flush with the frame edge is
  // unverifiable, because the card may continue outside the scan.
  const guard = assessNearFullFrame(rect, w, h);
  const notFrameAdjacent = guard.frameAdjacentEdges === 0 && !guard.nearFullFrame;
  if (!notFrameAdjacent) reasons.push(...guard.reasons.filter((r) => !reasons.includes(r)));
  if (!notFrameAdjacent && guard.reasons.length === 0) reasons.push("frame_adjacent_edges");

  // Signal 6 — the plateau is solid enough to be a printed card face.
  const coveragePeakOk = peakRow >= 0.5 && peakCol >= 0.5;
  if (!coveragePeakOk) reasons.push("coverage_peak_too_low");

  // Signal 7 — what surrounds the rectangle is actually a scanner background.
  // Scanner mats, bed vinyl and jigs are ACHROMATIC (white, grey, black); the
  // whitewash stage already relies on this. A saturated "mat" means the outer
  // strip is card, i.e. the input is an already-cropped card and the detected
  // rectangle is its inner art panel — cropping to that would cut the printed
  // border off. Fail closed instead.
  const matSat = Math.max(mat.matR, mat.matG, mat.matB) - Math.min(mat.matR, mat.matG, mat.matB);
  const matAchromatic = matSat <= MAT_MAX_SATURATION;
  if (!matAchromatic) reasons.push("surround_is_not_scanner_background");

  const signals = { areaOk, aspectOk, edgeStepOk, parallelOk, notFrameAdjacent, coveragePeakOk, matAchromatic };
  const signalCount = Object.values(signals).filter(Boolean).length;

  // MANDATORY conditions: geometry (aspect), plausible size (area), real
  // card-edge evidence (step), and not pinned against the scan frame. Without
  // all four there is no independent confirmation that the rectangle is the
  // card rather than the sleeve, the bed, or the frame — so it can never be
  // trusted, no matter how many of the softer signals agree.
  //
  // Frame adjacency is mandatory because a card flush with the frame edge is
  // UNVERIFIABLE: the card may continue outside the scan, so accepting it
  // risks emitting a clipped card. One adjacent edge is tolerated (a tight but
  // complete scan); two or more, or any near-full-frame reason, fails closed.
  const mandatory =
    aspectOk && areaOk && edgeStepOk && matAchromatic && !guard.nearFullFrame && guard.frameAdjacentEdges <= 1;
  const trusted = mandatory && signalCount >= 6;
  const confidence: "high" | "low" = trusted && signalCount === 7 ? "high" : "low";

  const pxPerMm = (rw / CARD_WIDTH_MM + rh / CARD_HEIGHT_MM) / 2;

  console.log(
    `[card-rect] ${w}x${h} → ${rw}x${rh} at (${rect.minX},${rect.minY})` +
      ` aspect=${aspect.toFixed(4)} (card=${CARD_ASPECT.toFixed(4)})` +
      ` area=${(areaFraction * 100).toFixed(1)}% peak=r${peakRow.toFixed(2)}/c${peakCol.toFixed(2)}` +
      ` pxPerMm=${pxPerMm.toFixed(2)} signals=${signalCount}/7 trusted=${trusted}` +
      (reasons.length ? ` reasons=${reasons.join(",")}` : "") +
      certTag
  );

  return {
    ...rect,
    w: rw,
    h: rh,
    aspect: +aspect.toFixed(4),
    pxPerMm: +pxPerMm.toFixed(3),
    edgeDist,
    peak: { row: +peakRow.toFixed(4), col: +peakCol.toFixed(4) },
    signals,
    signalCount,
    confidence,
    trusted,
    reasons,
  };
}

export interface CardMarginPlan {
  requestedMm: number;
  /** Per-edge margin actually applied, in detector-frame pixels. */
  appliedPx: { top: number; bottom: number; left: number; right: number };
  /** Per-edge margin actually applied, in millimetres. */
  appliedMm: { top: number; bottom: number; left: number; right: number };
  /** True when any edge could not supply CARD_MIN_SAFETY_MARGIN_MM. */
  degraded: boolean;
  /** Rectangle after the margin is added, clamped to the frame. */
  rect: { minX: number; maxX: number; minY: number; maxY: number };
}

/**
 * Expand a TRUSTED physical-card rectangle by the millimetre safety margin.
 *
 * The margin is added strictly OUTSIDE the card, converted with the px/mm the
 * detected card itself implies, and clamped per edge to whatever the source
 * frame can supply. Reducing an edge therefore removes mat, never card — the
 * complete physical card is retained under every branch. No padding is ever
 * invented: if the source has 4 px above the card, the top margin is 4 px.
 */
export function planCardSafetyMargin(rect: PhysicalCardRect, w: number, h: number): CardMarginPlan {
  const wantPx = Math.round(CARD_SAFETY_MARGIN_MM * rect.pxPerMm);
  const appliedPx = {
    top: Math.min(wantPx, rect.edgeDist.top),
    bottom: Math.min(wantPx, rect.edgeDist.bottom),
    left: Math.min(wantPx, rect.edgeDist.left),
    right: Math.min(wantPx, rect.edgeDist.right),
  };
  const toMm = (px: number) => +(px / rect.pxPerMm).toFixed(3);
  const appliedMm = {
    top: toMm(appliedPx.top),
    bottom: toMm(appliedPx.bottom),
    left: toMm(appliedPx.left),
    right: toMm(appliedPx.right),
  };
  const degraded = Object.values(appliedMm).some((mm) => mm < CARD_MIN_SAFETY_MARGIN_MM);

  return {
    requestedMm: CARD_SAFETY_MARGIN_MM,
    appliedPx,
    appliedMm,
    degraded,
    rect: {
      minX: Math.max(0, rect.minX - appliedPx.left),
      maxX: Math.min(w - 1, rect.maxX + appliedPx.right),
      minY: Math.max(0, rect.minY - appliedPx.top),
      maxY: Math.min(h - 1, rect.maxY + appliedPx.bottom),
    },
  };
}

/** First-stage isolation outcome, recorded in crop_geometry forensics. */
export interface CardIsolationOutcome {
  method: "physical_card_rect" | "legacy_bbox" | "fail_closed";
  trusted: boolean;
  requiresRecapture: boolean;
  rect: PhysicalCardRect | null;
  margin: CardMarginPlan | null;
  nearFullFrame: NearFullFrameAssessment | null;
  reasons: CardIsolationReason[];
}

/**
 * Crop to card boundary by detecting non-black pixels.
 * Works on ANY card colour as long as scanner uses a black background mat.
 * Returns null if detection fails (caller should fall back to autoCrop).
 */
export async function cropToCardBoundary(
  inputBuffer: Buffer,
  certId?: string | number
): Promise<{
  buffer: Buffer;
  cropped: boolean;
  matRgb: { r: number; g: number; b: number };
  isolation?: CardIsolationOutcome;
} | null> {
  try {
    console.log(
      `[card-detect] START non-black detection (${(inputBuffer.length / 1024).toFixed(0)}KB input)${certId != null ? ` cert=${certId}` : ""}`
    );
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return null;

    const scale = Math.min(1, 1500 / Math.max(meta.width, meta.height));
    const workW = Math.round(meta.width * scale);
    const workH = Math.round(meta.height * scale);

    const { data, info } = await sharp(inputBuffer)
      .resize(workW, workH, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);

    // ── Stage A: physical-card rectangle (sleeve / top-loader safe) ─────────
    // Runs FIRST so the fallback is never derived from a whole-frame result.
    const physical = detectPhysicalCardRect(pixels, info.width, info.height, info.channels, certId);
    if (physical?.trusted) {
      const margin = planCardSafetyMargin(physical, info.width, info.height);
      const isolation: CardIsolationOutcome = {
        method: "physical_card_rect",
        trusted: true,
        requiresRecapture: false,
        rect: physical,
        margin,
        nearFullFrame: null,
        reasons: physical.reasons,
      };
      const left = Math.max(0, Math.round(margin.rect.minX / scale));
      const top = Math.max(0, Math.round(margin.rect.minY / scale));
      const right = Math.min(meta.width, Math.round((margin.rect.maxX + 1) / scale));
      const bottom = Math.min(meta.height, Math.round((margin.rect.maxY + 1) / scale));
      const cw = right - left;
      const chh = bottom - top;
      const buf = await sharp(inputBuffer)
        .extract({ left, top, width: cw, height: chh })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toBuffer();
      console.log(
        `[card-detect] physical-card isolation ${meta.width}x${meta.height} → ${cw}x${chh}` +
          ` margin=${margin.appliedMm.top}/${margin.appliedMm.right}/${margin.appliedMm.bottom}/${margin.appliedMm.left}mm` +
          `${margin.degraded ? " (degraded)" : ""} confidence=${physical.confidence}` +
          `${certId != null ? ` cert=${certId}` : ""}`
      );
      const matProfile = computeMatProfile(pixels, info.width, info.height, info.channels);
      return {
        buffer: buf,
        cropped: true,
        matRgb: { r: matProfile.matR, g: matProfile.matG, b: matProfile.matB },
        isolation,
      };
    }

    // ── Stage B: legacy bounding-box detector, behind the fail-closed guard ─
    const boundary = detectCardBoundary(pixels, info.width, info.height, info.channels, certId);

    if (!boundary) {
      console.log("[card-detect] boundary detection failed (not enough non-black or too much)");
      return null;
    }

    // The guard is what stops a whole-frame "success" from becoming a 16 px
    // uniform inset of the entire scan (MV642: 1104×1483 of an 1106×1500
    // frame, shipped as a 1441×1967 "cropped" image still showing the bed and
    // the lower jig). Fail closed instead: keep the frame untouched, mark it
    // for recapture, and let downstream skip the misleading inset.
    const nearFullFrame = assessNearFullFrame(boundary, info.width, info.height);
    if (nearFullFrame.nearFullFrame) {
      console.warn(
        `[card-detect] FAIL-CLOSED: primary result is not card isolation` +
          ` (${nearFullFrame.reasons.join(",")}) retained=${(nearFullFrame.retainedFraction.area * 100).toFixed(1)}%` +
          ` frameAdjacentEdges=${nearFullFrame.frameAdjacentEdges}` +
          `${certId != null ? ` cert=${certId}` : ""}`
      );
      return {
        buffer: inputBuffer,
        cropped: false,
        matRgb: boundary.matRgb,
        isolation: {
          method: "fail_closed",
          trusted: false,
          requiresRecapture: true,
          rect: physical,
          margin: null,
          nearFullFrame,
          reasons: [...new Set([...nearFullFrame.reasons, ...(physical?.reasons ?? [])])],
        },
      };
    }

    // Scale back to original dimensions
    const origMinX = Math.max(0, Math.round(boundary.minX / scale));
    const origMinY = Math.max(0, Math.round(boundary.minY / scale));
    const origMaxX = Math.min(meta.width, Math.round(boundary.maxX / scale));
    const origMaxY = Math.min(meta.height, Math.round(boundary.maxY / scale));
    const cropW = origMaxX - origMinX;
    const cropH = origMaxY - origMinY;

    // Safety: cropped area must be 20-95% of original
    const areaRatio = (cropW * cropH) / (meta.width * meta.height);
    if (areaRatio < 0.2) {
      console.log(`[crop-safety] cropped to ${(areaRatio * 100).toFixed(0)}% — REJECTED, using uncropped`);
      return null;
    }

    const cropped = await sharp(inputBuffer)
      .extract({ left: origMinX, top: origMinY, width: cropW, height: cropH })
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();

    const ratio = cropW / cropH;
    console.log(
      `[card-detect] ${meta.width}x${meta.height} → ${cropW}x${cropH} (non-black ${boundary.nonBlackPct.toFixed(1)}%, ratio=${ratio.toFixed(3)})`
    );
    return {
      buffer: cropped,
      cropped: true,
      matRgb: boundary.matRgb,
      isolation: {
        method: "legacy_bbox",
        trusted: false,
        requiresRecapture: false,
        rect: physical,
        margin: null,
        nearFullFrame,
        reasons: physical?.reasons ?? [],
      },
    };
  } catch (err: any) {
    console.warn(`[card-detect] detection failed: ${err.message}`);
    return null;
  }
}

// Keep cropToYellowBorder as alias for backward compat (routes.ts references it)
export const cropToYellowBorder = cropToCardBoundary;

/**
 * Per-edge coverage scan for tightenForDisplay (Fix A, post-MV109-spur).
 *
 * Walks inward from each of the 4 bitmap edges and finds the first row
 * (top/bottom) or column (left/right) where ≥70% of pixels are non-mat
 * (per the mat-distance threshold). Bounds = the first such row/col on
 * each side.
 *
 * Why this replaces detectCardBoundary's bounding-box approach for the
 * SECOND detect pass:
 *   - Bounding-box uses MIN/MAX of all non-mat pixels. A single noise
 *     pixel inside the mat strip (deskew-rotation AA, JPEG artefact,
 *     scanner glare) inflates bounds by however far inside-the-strip
 *     that spur sits. MV109/front had a 44 px mat strip survive on the
 *     top because a single noise pixel near the top of the mat got the
 *     bounding-box detection to put minY just-below-the-spur, leaving
 *     ~44 rows of mostly-mat content "inside" the bounds.
 *   - Coverage scan requires the ROW (or column) to be ≥70% non-mat
 *     before counting toward the bound. One noise pixel in an otherwise-
 *     mat row contributes 1/w (~0.001) coverage — far below 0.70. The
 *     row stays classified as mat.
 *
 * Returns null if any edge can't find a 70%-coverage row/col, or if the
 * resulting bounds collapse (minX≥maxX or minY≥maxY).
 */
// Coverage threshold for the second-pass detect. 0.70 was too permissive
// — transitional pixels (yellow-tinted mat near the card edge) passed the
// mat-distance test and pushed the bound 10+ px outside the card body,
// leaving residual mat near the rounded corners. 0.90 requires the row
// to be almost-entirely card-content before counting toward the bound,
// landing it on the actual card body.
const CARD_EDGE_COVERAGE_THRESHOLD = 0.9;

function detectCardEdgesByCoverage(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  certId?: string | number
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const certTag = certId != null ? ` cert=${certId}` : "";
  const mat = computeMatProfile(pixels, w, h, ch);
  // Stricter mat-distance threshold for the second pass. The default 45 was
  // letting transitional pixels (yellow-tinted mat near a Pokémon card's
  // outer border) count as card — so the bound landed in the transition
  // zone, ~10 px outside the card body. Threshold 80 requires the pixel to
  // be strongly non-mat (e.g. solid card-yellow/blue/etc) before counting.
  // Mutating the local mat copy doesn't affect callers — the object is
  // freshly returned from computeMatProfile in this scope.
  mat.threshold = 80;
  console.log(
    `[edge-coverage] mat profile: rgb(${mat.matR},${mat.matG},${mat.matB})` +
      ` distance threshold=${mat.threshold} (overridden for second-pass)${certTag}`
  );

  // Single-pass tally: count non-mat pixels per row AND per column.
  // O(w*h) total. Avoids the O(w*h^2) cost of scanning each row inside
  // each iteration of the outer edge-finder.
  const rowNonMat = new Int32Array(h);
  const colNonMat = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    let rowCount = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      if (isCardPixel(pixels[i], pixels[i + 1], pixels[i + 2], mat)) {
        rowCount++;
        colNonMat[x]++;
      }
    }
    rowNonMat[y] = rowCount;
  }

  const rowOk = (y: number) => rowNonMat[y] / w >= CARD_EDGE_COVERAGE_THRESHOLD;
  const colOk = (x: number) => colNonMat[x] / h >= CARD_EDGE_COVERAGE_THRESHOLD;

  let minY = -1;
  for (let y = 0; y < h; y++)
    if (rowOk(y)) {
      minY = y;
      break;
    }
  let maxY = -1;
  for (let y = h - 1; y >= 0; y--)
    if (rowOk(y)) {
      maxY = y;
      break;
    }
  let minX = -1;
  for (let x = 0; x < w; x++)
    if (colOk(x)) {
      minX = x;
      break;
    }
  let maxX = -1;
  for (let x = w - 1; x >= 0; x--)
    if (colOk(x)) {
      maxX = x;
      break;
    }

  if (minX < 0 || maxX < 0 || minY < 0 || maxY < 0 || maxX <= minX || maxY <= minY) {
    console.warn(
      `[edge-coverage] no edge met ${(CARD_EDGE_COVERAGE_THRESHOLD * 100).toFixed(0)}% threshold: L=${minX} R=${maxX} T=${minY} B=${maxY}${certTag}`
    );
    return null;
  }

  console.log(
    `[edge-coverage] bounds L:${minX} R:${w - 1 - maxX} T:${minY} B:${h - 1 - maxY}` +
      ` (cover threshold ${(CARD_EDGE_COVERAGE_THRESHOLD * 100).toFixed(0)}%)${certTag}`
  );
  return { minX, maxX, minY, maxY };
}

/**
 * Per-edge inward saturation walk that paints near-grey pixels white.
 *
 * For each of the 4 edges (top/right/bottom/left), walks inward column-by-
 * column (or row-by-row) up to `maxDepth` px. Each pixel: compute
 *   sat = max(R,G,B) - min(R,G,B)
 * If sat < `satStop` → paint white (mat/vinyl/scanner bleed/JPEG noise).
 * If sat ≥ `satStop` → STOP this column/row (coloured card edge — leave
 * untouched, do not advance further inward).
 *
 * Colour-agnostic: yellow, blue, green, red, black card borders all stop
 * the walk. Mat/vinyl/scanner bleed are always near-grey regardless of
 * the scanner's mat colour, so the walk paints them.
 *
 * Mutates `px` in place and returns the same buffer for chaining.
 */
/**
 * The card border must exceed satStop by at least this margin before the
 * whitewash walk is allowed to run. Below it, border and mat are not separable
 * and the walk would paint through the border (MV609 white/silver, MV161).
 * Small margin only: it must not disturb saturated borders, which sit far above
 * satStop (measured yellow/blue/dark borders: border-satStop gap >= 20).
 */
export const WHITEWASH_MIN_BORDER_SAT_MARGIN = 3;

/** Tolerance added to the retained mat margin when bounding cleanup depth. */
export const WHITEWASH_MAT_TOLERANCE_PX = 4;

export interface WhitewashStats {
  matSat: number;
  borderSat: number;
  satStop: number;
  skipped: boolean;
  reason?: string;
  edgeLimits?: { top: number; bottom: number; left: number; right: number };
  geometryBounded?: boolean;
}

function whitewashEdgesBySaturation(
  px: Buffer,
  w: number,
  h: number,
  ch: number,
  maxDepth: number,
  certTag: string = "",
  edgeKeepPx: number = 2,
  stats?: WhitewashStats,
  matMarginPx?: { top: number; bottom: number; left: number; right: number } | null
): Buffer {
  // Corner anti-diagonal sweeps walk by Manhattan distance from the corner,
  // so they need a larger budget than the orthogonal edges to fully fill the
  // triangular wedge before the card curve cuts in (typically ~30 perp px =
  // up to 60 Manhattan px from the corner).
  const CORNER_MAX_DEPTH = 60;
  // Preserve this many pixels of the card edge in the output — without it
  // the sat walk paints right up to the first coloured pixel, leaving zero
  // visible card border. Per-side: front cards have a coloured outer border
  // (yellow) worth preserving 2 px of, back cards have a flat blue field
  // where preserving any buffer just leaves a faint bleed strip.
  const EDGE_BORDER_KEEP_PX = edgeKeepPx;

  const sat = (off: number) => {
    const r = px[off],
      g = px[off + 1],
      b = px[off + 2];
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  const paint = (off: number) => {
    px[off] = 255;
    px[off + 1] = 255;
    px[off + 2] = 255;
  };

  // Adaptive satStop: sample mat-side saturation from the outer 2 px ring
  // (guaranteed mat after the +30 px expansion) and card-border saturation
  // from a 3 px band at inset 17-19 px from each edge (lands inside the
  // card's coloured outer border for any card colour). Pick a threshold
  // 30% of the way from mat-sat to border-sat. Clamp [6, 60] so degenerate
  // inputs (all-grey scans, all-coloured scans) don't blow up the walk.
  let matSatSum = 0,
    matSatN = 0;
  for (let y = 0; y < Math.min(2, h); y++) {
    for (let x = 0; x < w; x++) {
      matSatSum += sat((y * w + x) * ch);
      matSatN++;
    }
  }
  for (let y = Math.max(2, h - 2); y < h; y++) {
    for (let x = 0; x < w; x++) {
      matSatSum += sat((y * w + x) * ch);
      matSatN++;
    }
  }
  for (let y = 2; y < h - 2; y++) {
    for (let x = 0; x < Math.min(2, w); x++) {
      matSatSum += sat((y * w + x) * ch);
      matSatN++;
    }
    for (let x = Math.max(2, w - 2); x < w; x++) {
      matSatSum += sat((y * w + x) * ch);
      matSatN++;
    }
  }
  const matSat = matSatN > 0 ? matSatSum / matSatN : 0;

  let borderSatSum = 0,
    borderSatN = 0;
  for (let d = 17; d <= 19; d++) {
    if (d < h)
      for (let x = 0; x < w; x++) {
        borderSatSum += sat((d * w + x) * ch);
        borderSatN++;
      }
    if (h - 1 - d >= 0)
      for (let x = 0; x < w; x++) {
        borderSatSum += sat(((h - 1 - d) * w + x) * ch);
        borderSatN++;
      }
    if (d < w)
      for (let y = 0; y < h; y++) {
        borderSatSum += sat((y * w + d) * ch);
        borderSatN++;
      }
    if (w - 1 - d >= 0)
      for (let y = 0; y < h; y++) {
        borderSatSum += sat((y * w + (w - 1 - d)) * ch);
        borderSatN++;
      }
  }
  const borderSat = borderSatN > 0 ? borderSatSum / borderSatN : 0;

  // Floor + ceiling for the adaptive threshold. The floor was raised from
  // 6 to 12 after MV161 (mat=2.5 border=10.0 → calculated=6) caused 63k
  // left-edge pixels to be painted — when borderSat is low the gap rule
  // gives a satStop that's barely above mat noise, and JPEG transition
  // artefacts get classified as paintable. Below 12 we treat the
  // calculation as unreliable and fall back to the floor.
  const SAT_STOP_FLOOR = 12;
  const SAT_STOP_CEIL = 60;
  const rawSatStop = matSat + (borderSat - matSat) * 0.3;
  const calculatedSatStop = Math.round(rawSatStop);
  const satStop = Math.max(SAT_STOP_FLOOR, Math.min(SAT_STOP_CEIL, calculatedSatStop));
  if (calculatedSatStop < SAT_STOP_FLOOR) {
    console.log(
      `[whitewash] satStop floored to minimum (calculated=${calculatedSatStop}, floor=${SAT_STOP_FLOOR})${certTag}`
    );
  }
  console.log(
    `[whitewash] adaptive satStop=${satStop} (mat=${matSat.toFixed(1)} border=${borderSat.toFixed(1)})${certTag}`
  );
  if (stats) {
    stats.matSat = +matSat.toFixed(2);
    stats.borderSat = +borderSat.toFixed(2);
    stats.satStop = satStop;
  }

  // ── WHITEWASH SAFETY BOUNDARY — per-edge, geometry-bounded ───────────────
  // The first fix skipped the walk entirely whenever the MEAN border saturation
  // was low. Measured on 60 real cards that skipped 61.7% of fronts, which
  // re-introduced the v593 "thin grey frame around the card" defect, and a mean
  // across four edges also let three saturated edges mask one pale edge.
  //
  // Instead, bound each edge PHYSICALLY. The pipeline knows how much mat it
  // deliberately retained (matMarginPx), so cleanup is limited to that mat and
  // simply cannot reach the card — whatever colour the border happens to be.
  // Where the margin is unknown we fall back to a PER-EDGE saturation test so a
  // pale edge is protected even when its neighbours are saturated.
  const perEdgeBorderSat = (edge: "top" | "bottom" | "left" | "right"): number => {
    let sum = 0,
      n = 0;
    for (let d = 17; d <= 19; d++) {
      if (edge === "top" && d < h)
        for (let x = 0; x < w; x++) {
          sum += sat((d * w + x) * ch);
          n++;
        }
      if (edge === "bottom" && h - 1 - d >= 0)
        for (let x = 0; x < w; x++) {
          sum += sat(((h - 1 - d) * w + x) * ch);
          n++;
        }
      if (edge === "left" && d < w)
        for (let y = 0; y < h; y++) {
          sum += sat((y * w + d) * ch);
          n++;
        }
      if (edge === "right" && w - 1 - d >= 0)
        for (let y = 0; y < h; y++) {
          sum += sat((y * w + (w - 1 - d)) * ch);
          n++;
        }
    }
    return n > 0 ? sum / n : 0;
  };
  const edgeLimit = (edge: "top" | "bottom" | "left" | "right", axisMax: number): number => {
    if (matMarginPx) {
      // Physical bound: the retained mat, plus a small tolerance for the
      // detector's own rounding. Cannot reach card content by construction.
      return Math.max(0, Math.min(axisMax, Math.round(matMarginPx[edge]) + WHITEWASH_MAT_TOLERANCE_PX));
    }
    const bs = perEdgeBorderSat(edge);
    return bs < satStop + WHITEWASH_MIN_BORDER_SAT_MARGIN ? 0 : axisMax;
  };

  // Two-pass edge walk: pass 1 locates the start of the card border using
  // a 3-consecutive-above-threshold rule (single high-sat pixels are
  // treated as JPEG noise/dust and the walk continues past them); pass 2
  // paints up to (stopDepth - EDGE_BORDER_KEEP_PX), leaving a visible
  // strip of card border. If no coloured run is found within `limit`,
  // paint everything (card edge is beyond reach — nothing to preserve).
  const NOISE_TOLERANCE_RUN = 5;
  const walkEdge = (getOffset: (d: number) => number, limit: number): number => {
    let stopDepth = -1;
    let run = 0;
    for (let d = 0; d < limit; d++) {
      if (sat(getOffset(d)) >= satStop) {
        run++;
        if (run >= NOISE_TOLERANCE_RUN) {
          stopDepth = d - (NOISE_TOLERANCE_RUN - 1); // first of the run
          break;
        }
      } else {
        run = 0;
      }
    }
    const paintLimit = stopDepth >= 0 ? Math.max(0, stopDepth - EDGE_BORDER_KEEP_PX) : limit;
    for (let d = 0; d < paintLimit; d++) paint(getOffset(d));
    return paintLimit;
  };

  let pT = 0,
    pB = 0,
    pL = 0,
    pR = 0;
  const hLimit = Math.min(maxDepth, h);
  const wLimit = Math.min(maxDepth, w);
  const limT = edgeLimit("top", hLimit);
  const limB = edgeLimit("bottom", hLimit);
  const limL = edgeLimit("left", wLimit);
  const limR = edgeLimit("right", wLimit);
  if (stats) {
    stats.matSat = +matSat.toFixed(2);
    stats.borderSat = +borderSat.toFixed(2);
    stats.satStop = satStop;
    stats.edgeLimits = { top: limT, bottom: limB, left: limL, right: limR };
    stats.skipped = limT === 0 && limB === 0 && limL === 0 && limR === 0;
    if (stats.skipped) stats.reason = "all_edges_pale_no_contrast";
    stats.geometryBounded = !!matMarginPx;
  }

  for (let x = 0; x < w; x++) pT += walkEdge((d) => (d * w + x) * ch, limT); // Top
  for (let x = 0; x < w; x++) pB += walkEdge((d) => ((h - 1 - d) * w + x) * ch, limB); // Bottom
  for (let y = 0; y < h; y++) pL += walkEdge((d) => (y * w + d) * ch, limL); // Left
  for (let y = 0; y < h; y++) pR += walkEdge((d) => (y * w + (w - 1 - d)) * ch, limR); // Right

  // Corner anti-diagonal sweep — fills the triangular wedge of mat
  // between where the orthogonal edge walks stopped. At each depth d, the
  // anti-diagonal is the line of pixels at Manhattan distance d from the
  // corner. Paint every pixel on that line where sat<satStop. The first
  // time ANY pixel on the anti-diagonal hits sat>=satStop, the card-corner
  // curve has reached this depth — break the depth loop entirely (do not
  // walk further inward, where we'd be inside card content).
  let pTL = 0,
    pTR = 0,
    pBL = 0,
    pBR = 0;

  // TL — anti-diagonal pixels (k, d-k) for k in 0..d
  tlSweep: for (let d = 0; d < CORNER_MAX_DEPTH; d++) {
    for (let k = 0; k <= d; k++) {
      const x = k,
        y = d - k;
      if (x >= w || y >= h) continue;
      const off = (y * w + x) * ch;
      if (sat(off) >= satStop) break tlSweep;
      paint(off);
      pTL++;
    }
  }
  // TR — anti-diagonal pixels (w-1-k, d-k) for k in 0..d
  trSweep: for (let d = 0; d < CORNER_MAX_DEPTH; d++) {
    for (let k = 0; k <= d; k++) {
      const x = w - 1 - k,
        y = d - k;
      if (x < 0 || y >= h) continue;
      const off = (y * w + x) * ch;
      if (sat(off) >= satStop) break trSweep;
      paint(off);
      pTR++;
    }
  }
  // BL — anti-diagonal pixels (k, h-1-(d-k)) for k in 0..d
  blSweep: for (let d = 0; d < CORNER_MAX_DEPTH; d++) {
    for (let k = 0; k <= d; k++) {
      const x = k,
        y = h - 1 - (d - k);
      if (x >= w || y < 0) continue;
      const off = (y * w + x) * ch;
      if (sat(off) >= satStop) break blSweep;
      paint(off);
      pBL++;
    }
  }
  // BR — anti-diagonal pixels (w-1-k, h-1-(d-k)) for k in 0..d
  brSweep: for (let d = 0; d < CORNER_MAX_DEPTH; d++) {
    for (let k = 0; k <= d; k++) {
      const x = w - 1 - k,
        y = h - 1 - (d - k);
      if (x < 0 || y < 0) continue;
      const off = (y * w + x) * ch;
      if (sat(off) >= satStop) break brSweep;
      paint(off);
      pBR++;
    }
  }

  console.log(
    `[whitewash] painted edges T${pT}/B${pB}/L${pL}/R${pR} corners TL${pTL}/TR${pTR}/BL${pBL}/BR${pBR} (edgeMaxDepth=${maxDepth}, edgeKeepPx=${EDGE_BORDER_KEEP_PX}, cornerMaxDepth=${CORNER_MAX_DEPTH}, satStop=${satStop})${certTag}`
  );
  return px;
}

/**
 * Tight-detect crop for the DISPLAY pipeline only.
 *
 * Operates on a buffer that's already been through the standard pipeline
 * (deskew + crop + reCentre), so the only background present is the 8 px
 * safety-pad strip that cropToCardBoundary added on the FIRST detect pass.
 * That strip is uniform and tight on all four sides, which is easy to
 * detect away.
 *
 * Uses per-edge coverage scan (detectCardEdgesByCoverage) rather than
 * detectCardBoundary's bounding-box approach. Coverage is immune to spur
 * pixels — a single noise/AA pixel inside the mat strip won't inflate
 * bounds because it doesn't push the row's non-mat coverage above 70%.
 *
 * Bounding-box detection (the first-pass approach) needs the safety pad
 * to protect against shaving card edges on tilted scans. Coverage scan
 * needs neither a pad nor an inward bias — it lands the bound on the
 * first row that is meaningfully card-content, which is exactly the
 * straight-edge of the card body.
 *
 * On any failure (detect returns null, bounds < 50% of input, anything
 * throws) we fall back to a uniform inset of `fallbackInsetPx` per side.
 * Worst case is "no improvement" rather than "broken pipeline".
 */
// ── Crop-integrity gate (front-crop content-loss defect, MV602/MV608/MV609) ──
//
// detectCardEdgesByCoverage is a saturation/coverage detector: it cannot tell a
// PALE card border (white/silver) or a PALE interior panel (a JP ex-Rule box)
// from the white scanner mat. On such fronts the second-pass bounds land INSIDE
// the card and tightenForDisplay silently destroyed real content — MV602 lost
// its ex-Rule box, illustrator credit and card number 154/190; MV609 lost its
// entire white outer border (the reference centering is measured from).
//
// The pre-existing "≥50% of input on both axes" check cannot catch this: MV602
// lost 17.3% of height and sailed through. These constants are the primary
// integrity control and are derived from MEASURED production geometry, not
// guesses (all values from R2 assets for MV602/MV607-MV611, 2026-07-25):
//
//   healthy crops   aspect 0.7381 0.7382 0.7466 0.7472 0.7473  (max dev 0.0314)
//   MV602 bad front aspect 0.8181                              (dev 0.1022)
//   healthy axis trim   8.1-9.4 %      MV602 bad front  17.3 %
//   healthy |front-back aspect delta| 0.0007 / 0.0090
//   MV602 |front-back aspect delta|   0.0800
//
// Each threshold is placed between the healthy maximum and the defect minimum
// so both classes are separated with margin in BOTH directions.

/** Physical Pokémon card geometry. */
export const CARD_ASPECT_RATIO = 63 / 88;
export const CARD_LONG_EDGE_MM = 88;

// ── Thresholds recalibrated against 500 production certificates ─────────────
// (read-only R2 study, 2026-07-25; 497 healthy vs 3 confirmed-damaged
//  MV602/MV586/MV326). The first implementation calibrated on SIX cards and
//  consequently rejected 1.6% of healthy fronts and flagged 7.0% cross-face.
//
//   metric            healthy p95 / p99 / max      damaged min   separable?
//   front aspectDev   0.0276 / 0.0315 / 0.0385     0.1022        yes
//   front trimV       0.0875 / 0.1100 / 0.1395     0.1725        yes
//   front trimH       0.0963 / 0.1330 / 0.1438     0.0814        NO (overlap)
//   fbAspect          0.0141 / 0.0292 / 0.1700     0.0801        NO (overlap)
//
// trimH and fbAspect OVERLAP, so neither can be a discriminator: the damaged
// cards lost height, not width. Horizontal trim is therefore only a loose
// hard-stop, and the real discriminators are aspect, vertical trim, and the
// content/geometry evidence below.

/** Healthy max 0.0385, damaged min 0.1022 -> midpoint. */
export const MAX_CARD_ASPECT_DEVIATION = 0.07;
/** Healthy max 0.1395, damaged min 0.1725 -> midpoint. */
export const MAX_VERTICAL_TRIM_FRACTION = 0.155;
/** Not a discriminator (overlap). Loose hard-stop above healthy max 0.1438. */
export const MAX_HORIZONTAL_TRIM_FRACTION = 0.17;
/** Overlaps, so kept loose: at 0.05 flags 2/497 healthy (0.4%) + 3/3 damaged
 *  (the old 0.02 flagged 7.0% of healthy cards). */
export const MAX_FRONT_BACK_ASPECT_DELTA = 0.05;
export const MAX_FRONT_BACK_TRIM_DELTA_FRACTION = 0.1;

// ── Absolute physical bounds (the real safety net) ──────────────────────────
/**
 * A single edge may not be trimmed more than this many millimetres BEYOND the
 * mat margin the pipeline deliberately retained. Card information bands
 * (card number, illustrator credit, regulation marks) are ~1.5-2.5mm tall, so
 * a 0.8mm allowance cannot remove one even at the limit.
 */
export const MAX_EDGE_TRIM_BEYOND_MAT_MM = 0.8;
/** When the retained mat margin is UNKNOWN we cannot reason physically, so the
 *  band evidence must carry the decision; this caps the damage either way. */
export const MAX_EDGE_TRIM_UNKNOWN_MAT_MM = 6.0;
/** Widened allowance when the mat measurement itself is unreliable. */
export const LOW_CONFIDENCE_MAT_MULTIPLE = 3;
/** Fraction of a discarded band that may differ from the local mat profile. */
export const MAX_DISCARDED_BAND_CONTENT_FRACTION = 0.1;
/** Colour distance from the local mat profile above which a pixel is content.
 *  Deliberately low: an off-white card border sits only ~9 units from a white
 *  mat, which the previous saturation/darkness test scored as ZERO. */
export const MAT_DEVIATION_FLOOR = 6;
/** Multiplier on the measured mat noise, so a noisy scanner bed does not
 *  manufacture false content. */
export const MAT_DEVIATION_NOISE_MULTIPLE = 2.5;

// ── Mat-resumption look-ahead (MV608 artefact stripe) ───────────────────────
// Measured on MV608: the mat walk stopped at a hard-edged, FULL-HEIGHT dark
// stripe sitting INSIDE the mat (rgb 232->105 in one pixel, 166/167 rows
// agreeing), after which 65px of clean mat resumed before the real card at
// ~x121. A card edge never "un-happens", so a stop followed by genuine mat is
// an artefact, not a boundary. All values are in DETECTOR space (the walk runs
// on the <=1500px analysis copy), and none are certificate-specific.
/** How far past a stop candidate we may look for the mat to resume. */
export const MAT_RESUME_LOOKAHEAD_PX = 80;
/** Consecutive mat-matching columns/rows required to believe a resumption. */
export const MAT_RESUME_MIN_RUN_PX = 16;
/** Widest artefact stripe we will step over. */
export const MAT_RESUME_MAX_STRIPE_PX = 40;
/** Skips permitted per line, and their total width. */
export const MAT_RESUME_MAX_SKIPS = 2;
export const MAT_RESUME_MAX_TOTAL_SKIP_PX = 60;
/**
 * Resumed mat must match the ORIGINAL mat far more tightly than the walk's own
 * tolerance — being merely pale is not enough, or a thin dark border followed
 * by a pale card panel would be skipped straight through. 0.4x cleanly
 * separated the measured cases: MV608's resumed mat scored dev 2-3 against a
 * tolerance of 24.4, while MV609's genuine card scored 66-166.
 */
export const MAT_RESUME_STRICTNESS = 0.4;

// ── Mat-measurement plausibility (scanner-failure audit, 500 cards) ─────────
// A card occupies most of the scanner frame, so the retained mat can only be a
// small share of it. Measured across 1000 real faces:
//
//   horizontal mat share  p50 0.054  p90 0.085  p95 0.091  p99 0.110
//   vertical   mat share  p50 0.053  p90 0.065  p95 0.073  p99 0.084
//   remaining W / frameW  p99 0.972  (min observed ~0.89)
//   remaining aspect      p50 0.7329 p95 0.7456 p99 0.7535
//
// Two faces sat far outside: MV305 (h 0.658 / v 0.542) and MV581 (h 0.545),
// where the walk ran into a pale card body and claimed most of the frame as
// mat. An inflated mat inflates the permitted crop, so such a measurement must
// never be allowed to widen acceptance. The bounds below sit roughly 3x above
// the healthy p99, so they cannot fire on a normal card.
/** Max share of an axis that retained mat may plausibly occupy. */
export const MAX_PLAUSIBLE_MAT_SHARE = 0.3;
/** The card must still occupy at least this fraction of each axis. */
export const MIN_REMAINING_CARD_FRACTION = 0.55;
/** Deviation of the implied remaining-card aspect from a real card. */
export const MAX_REMAINING_ASPECT_DEVIATION = 0.15;

export type MatPlausibilityState =
  | "valid"
  | "valid_after_artefact_skip"
  | "implausibly_large"
  | "all_zero"
  | "partially_collapsed"
  | "reference_unusable"
  | "no_stable_resumption"
  | "cap_exhausted"
  | "geometrically_inconsistent"
  | "not_assessed_detection_failed";

export interface MatPlausibility {
  state: MatPlausibilityState;
  /** May this measurement influence crop acceptance? */
  usableForAcceptance: boolean;
  reasons: string[];
  matShare: { horizontal: number; vertical: number };
  remaining: { w: number; h: number; aspect: number; wFraction: number; hFraction: number };
}

/**
 * Physical plausibility of a retained-mat measurement, judged against the frame
 * it was measured in. Pure and deterministic; no certificate-specific values.
 *
 * Crucially this SEPARATES "the mat is genuinely zero on an edge" from "the
 * measurement failed" — the previous code represented both as 0, which is how
 * MV586's total reference collapse was reported as four plausible zeros.
 */
export function assessMatPlausibility(
  mat: { top: number; bottom: number; left: number; right: number },
  frameW: number,
  frameH: number,
  opts: { skipped?: boolean; sourceUnknown?: boolean } = {}
): MatPlausibility {
  const reasons: string[] = [];
  const hSum = mat.left + mat.right;
  const vSum = mat.top + mat.bottom;
  const matShare = {
    horizontal: frameW > 0 ? hSum / frameW : 1,
    vertical: frameH > 0 ? vSum / frameH : 1,
  };
  const remW = frameW - hSum;
  const remH = frameH - vSum;
  const remaining = {
    w: remW,
    h: remH,
    aspect: remH > 0 ? +(remW / remH).toFixed(4) : 0,
    wFraction: frameW > 0 ? remW / frameW : 0,
    hFraction: frameH > 0 ? remH / frameH : 0,
  };

  let state: MatPlausibilityState = opts.skipped ? "valid_after_artefact_skip" : "valid";

  if (opts.sourceUnknown) {
    reasons.push("mat reference could not be established");
    state = "reference_unusable";
  }
  const zeros = [mat.top, mat.bottom, mat.left, mat.right].filter((v) => v <= 0).length;
  if (zeros === 4) {
    // A real scan always retains SOME mat on at least one edge after centring,
    // so four zeros means the reference failed, not that the card fills the frame.
    reasons.push("all four edges measured zero — reference collapse, not a true zero-mat scan");
    state = "all_zero";
  } else if (zeros >= 2 && state !== "reference_unusable") {
    reasons.push(`${zeros} edges measured zero`);
    state = "partially_collapsed";
  }
  if (matShare.horizontal > MAX_PLAUSIBLE_MAT_SHARE || matShare.vertical > MAX_PLAUSIBLE_MAT_SHARE) {
    reasons.push(
      `mat share h=${matShare.horizontal.toFixed(3)} v=${matShare.vertical.toFixed(3)} exceeds ${MAX_PLAUSIBLE_MAT_SHARE}`
    );
    state = "implausibly_large";
  }
  if (remaining.wFraction < MIN_REMAINING_CARD_FRACTION || remaining.hFraction < MIN_REMAINING_CARD_FRACTION) {
    reasons.push(
      `implied card occupies only ${(remaining.wFraction * 100).toFixed(0)}%x${(remaining.hFraction * 100).toFixed(0)}% of the frame`
    );
    state = "implausibly_large";
  }
  if (
    remaining.w > 0 &&
    remaining.h > 0 &&
    Math.abs(remaining.aspect - CARD_ASPECT_RATIO) > MAX_REMAINING_ASPECT_DEVIATION
  ) {
    reasons.push(`implied card aspect ${remaining.aspect} is not card-like`);
    if (state === "valid" || state === "valid_after_artefact_skip") state = "geometrically_inconsistent";
  }

  const usableForAcceptance = state === "valid" || state === "valid_after_artefact_skip";
  return { state, usableForAcceptance, reasons, matShare, remaining };
}

export type CropIntegrityReasonCode =
  | "aspect_out_of_range"
  | "axis_trim_excessive"
  | "edge_trim_excessive"
  | "edge_trim_exceeds_mat_mm"
  | "discarded_band_contains_content"
  | "coverage_detect_failed"
  | "below_half_input"
  | "threw"
  | "cross_face_aspect_delta"
  | "cross_face_trim_delta";

export interface CropIntegrityReport {
  side?: "front" | "back";
  /** Dimensions handed to tightenForDisplay (the untightened centred buffer). */
  pre: { w: number; h: number; aspect: number } | null;
  /** Dimensions the detector PROPOSED (may have been rejected). */
  proposed: { w: number; h: number; aspect: number } | null;
  /** Dimensions actually emitted. */
  accepted: { w: number; h: number; aspect: number } | null;
  decision: "accepted" | "rejected" | "detect_failed" | "error";
  reasons: CropIntegrityReasonCode[];
  /** Geometry of the PROPOSAL (may have been rejected) — never the emitted image. */
  edgeTrimPx: { top: number; bottom: number; left: number; right: number } | null;
  trimFraction: { horizontal: number; vertical: number } | null;
  /** Geometry of what was ACTUALLY emitted. Cross-face must use only this. */
  emittedTrimFraction: { horizontal: number; vertical: number } | null;
  /** True when the emitted image is a fallback, not the proposal. */
  usedFallback: boolean;
  edgeTrimBeyondMatMm: { top: number; bottom: number; left: number; right: number } | null;
  /** Physical plausibility of the retained-mat measurement. */
  matPlausibility: MatPlausibility | null;
  /** False when an implausible measurement was excluded from the decision. */
  matUsedForAcceptance: boolean;
  /** Explicit primary card-detection outcome — never implicit. */
  cardDetectionState: "detected" | "failed" | "not_reached";
  /** True when a fallback produced usable output that is NOT a primary success. */
  outputSafeButDegraded: boolean;
  /** Per-edge retained mat actually used by the decision, and where it came from. */
  retainedMat: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    source: MatMarginSource;
    confidence: "high" | "low";
  } | null;
  discardedBandContentFraction: { top: number; bottom: number; left: number; right: number } | null;
  /** Which fallback produced the emitted buffer, if any. */
  fallback: "none" | "untightened_input" | "uniform_inset" | "input_on_error";
  whitewash: {
    applied: boolean;
    paintedFraction: number;
    reason?: string;
    matSat?: number;
    borderSat?: number;
    satStop?: number;
  } | null;
  cropConfidence: "high" | "low";
}

export function emptyCropIntegrityReport(side?: "front" | "back"): CropIntegrityReport {
  return {
    side,
    pre: null,
    proposed: null,
    accepted: null,
    decision: "error",
    reasons: [],
    edgeTrimPx: null,
    trimFraction: null,
    emittedTrimFraction: null,
    usedFallback: false,
    edgeTrimBeyondMatMm: null,
    matPlausibility: null,
    matUsedForAcceptance: false,
    cardDetectionState: "not_reached",
    outputSafeButDegraded: false,
    retainedMat: null,
    discardedBandContentFraction: null,
    fallback: "none",
    whitewash: null,
    cropConfidence: "low",
  };
}

const dims = (w: number, h: number) => ({ w, h, aspect: h > 0 ? +(w / h).toFixed(4) : 0 });

/** Stamp what was ACTUALLY emitted, kept strictly separate from the proposal. */
function stampEmitted(report: CropIntegrityReport | undefined, w: number, h: number, usedFallback: boolean): void {
  if (!report) return;
  report.accepted = dims(w, h);
  report.usedFallback = usedFallback;
  const src = report.pre;
  report.emittedTrimFraction = src
    ? { horizontal: Math.max(0, 1 - w / src.w), vertical: Math.max(0, 1 - h / src.h) }
    : { horizontal: 0, vertical: 0 };
}

export interface CropIntegrityInput {
  inputW: number;
  inputH: number;
  cropLeft: number;
  cropTop: number;
  cropW: number;
  cropH: number;
  /** Per-edge fraction of the DISCARDED band that differs from local mat. */
  discardedBandContentFraction?: { top: number; bottom: number; left: number; right: number };
  /**
   * Mat margin the pipeline deliberately retained around the card in the INPUT
   * buffer, per edge, if known. Trimming roughly this much is expected and
   * safe; trimming materially MORE means cutting into the card, regardless of
   * what colour that card happens to be. This is the colour-independent
   * control that catches pale-border loss.
   */
  matMarginPx?: { top: number; bottom: number; left: number; right: number } | null;
  /** Low confidence widens the allowance rather than forcing a fallback. */
  matConfidence?: "high" | "low";
}

export interface CropIntegrityVerdict {
  accepted: boolean;
  reasons: CropIntegrityReasonCode[];
  edgeTrimPx: { top: number; bottom: number; left: number; right: number };
  edgeTrimBeyondMatMm: { top: number; bottom: number; left: number; right: number } | null;
  trimFraction: { horizontal: number; vertical: number };
  proposedAspect: number;
  mmPerPx: number;
}

/**
 * Pure, deterministic crop-integrity decision. No image decoding, no I/O.
 *
 * Order of authority:
 *   1. physical  — trim beyond the retained mat margin, in millimetres
 *   2. content   — mat-relative evidence in the discarded bands
 *   3. geometry  — aspect / per-axis trim, as loose hard-stops
 */
export function evaluateCropIntegrity(input: CropIntegrityInput): CropIntegrityVerdict {
  const { inputW, inputH, cropLeft, cropTop, cropW, cropH } = input;
  const reasons: CropIntegrityReasonCode[] = [];
  const edgeTrimPx = {
    top: Math.max(0, cropTop),
    left: Math.max(0, cropLeft),
    bottom: Math.max(0, inputH - (cropTop + cropH)),
    right: Math.max(0, inputW - (cropLeft + cropW)),
  };
  const trimFraction = {
    horizontal: inputW > 0 ? Math.max(0, 1 - cropW / inputW) : 1,
    vertical: inputH > 0 ? Math.max(0, 1 - cropH / inputH) : 1,
  };
  const proposedAspect = cropH > 0 ? cropW / cropH : 0;
  // The proposed crop is intended to BE the card, so its height maps to 88mm.
  const mmPerPx = cropH > 0 ? CARD_LONG_EDGE_MM / cropH : 0;

  // 1 ── PHYSICAL: how far past the retained mat did each edge cut?
  let edgeTrimBeyondMatMm: CropIntegrityVerdict["edgeTrimBeyondMatMm"] = null;
  const mat = input.matMarginPx;
  if (mat) {
    edgeTrimBeyondMatMm = {
      top: Math.max(0, edgeTrimPx.top - mat.top) * mmPerPx,
      bottom: Math.max(0, edgeTrimPx.bottom - mat.bottom) * mmPerPx,
      left: Math.max(0, edgeTrimPx.left - mat.left) * mmPerPx,
      right: Math.max(0, edgeTrimPx.right - mat.right) * mmPerPx,
    };
    const worst = Math.max(
      edgeTrimBeyondMatMm.top,
      edgeTrimBeyondMatMm.bottom,
      edgeTrimBeyondMatMm.left,
      edgeTrimBeyondMatMm.right
    );
    // A low-confidence measurement must not force every card to fall back, so
    // the allowance widens instead of the decision flipping.
    const allowance =
      input.matConfidence === "low"
        ? MAX_EDGE_TRIM_BEYOND_MAT_MM * LOW_CONFIDENCE_MAT_MULTIPLE
        : MAX_EDGE_TRIM_BEYOND_MAT_MM;
    if (worst > allowance) reasons.push("edge_trim_exceeds_mat_mm");
    // Emergency stop regardless of the mat model.
    const worstPxAbs = Math.max(edgeTrimPx.top, edgeTrimPx.bottom, edgeTrimPx.left, edgeTrimPx.right);
    if (worstPxAbs * mmPerPx > MAX_EDGE_TRIM_UNKNOWN_MAT_MM) reasons.push("edge_trim_excessive");
  } else {
    // Mat margin unknown: fall back to an absolute per-edge ceiling so a
    // runaway single-edge crop is still bounded.
    const worstPx = Math.max(edgeTrimPx.top, edgeTrimPx.bottom, edgeTrimPx.left, edgeTrimPx.right);
    if (worstPx * mmPerPx > MAX_EDGE_TRIM_UNKNOWN_MAT_MM) reasons.push("edge_trim_excessive");
  }

  // 2 ── CONTENT: mat-relative evidence from the bands being discarded.
  const band = input.discardedBandContentFraction;
  if (
    band &&
    (band.top > MAX_DISCARDED_BAND_CONTENT_FRACTION ||
      band.bottom > MAX_DISCARDED_BAND_CONTENT_FRACTION ||
      band.left > MAX_DISCARDED_BAND_CONTENT_FRACTION ||
      band.right > MAX_DISCARDED_BAND_CONTENT_FRACTION)
  ) {
    reasons.push("discarded_band_contains_content");
  }

  // 3 ── GEOMETRY: loose hard-stops. Per-axis, because horizontal trim does not
  //      discriminate damage in the measured population (healthy max 0.1438 vs
  //      damaged min 0.0814) while vertical trim does.
  if (Math.abs(proposedAspect - CARD_ASPECT_RATIO) > MAX_CARD_ASPECT_DEVIATION) {
    reasons.push("aspect_out_of_range");
  }
  if (trimFraction.vertical > MAX_VERTICAL_TRIM_FRACTION || trimFraction.horizontal > MAX_HORIZONTAL_TRIM_FRACTION) {
    reasons.push("axis_trim_excessive");
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    edgeTrimPx,
    edgeTrimBeyondMatMm,
    trimFraction,
    proposedAspect,
    mmPerPx,
  };
}

export type MatMarginSource = "pixel_measured" | "geometry_derived" | "unknown";

export interface RetainedMat {
  /** Per-edge retained mat depth, in the SAME pixel space as the measurement. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  source: MatMarginSource;
  confidence: "high" | "low";
  /** Spread of the per-row/col depths; high spread = an unreliable edge. */
  spread: { top: number; bottom: number; left: number; right: number };
  /** Why the walk stopped on each edge — distinguishes a ramp from a card edge. */
  stopReason: { top: string; bottom: string; left: string; right: string };
  /** True when any artefact stripe was stepped over — reported INDEPENDENTLY of
   *  measurementConfidence, so a resolved skip cannot widen acceptance. */
  artefactSkipped: boolean;
  /** Lines per edge on which an artefact stripe was stepped over. */
  skips: { top: number; bottom: number; left: number; right: number };
  /** Widest stripe skipped per edge. */
  skippedWidthPx: { top: number; bottom: number; left: number; right: number };
  /** Longest resumed clean-mat run observed per edge. */
  resumedRunPx: { top: number; bottom: number; left: number; right: number };
}

/**
 * Measure the retained scanner mat DIRECTLY from the buffer, per edge.
 *
 * The previous model averaged opposing pre-centre padding values. Real scans
 * are asymmetric (MV609 measured L:0 R:58 before centring), so a mean of 29
 * described neither edge and rejected healthy cards whose crop legitimately
 * landed 1.8-3.1mm away from that fiction.
 *
 * This walks inward from each edge while pixels still match the locally
 * sampled mat, and takes the MEDIAN depth across rows/columns — robust to a
 * few dark dust specks or a tilted card corner. Every edge gets its own value.
 */
export function measureRetainedMatPerEdge(pixels: Uint8Array, w: number, h: number, ch: number): RetainedMat {
  const ring = sampleMatProfile(pixels, w, h, ch, { x0: 0, y0: 0, x1: w, y1: Math.min(2, h) });
  const ring2 = sampleMatProfile(pixels, w, h, ch, { x0: 0, y0: Math.max(0, h - 2), x1: w, y1: h });
  const mat = {
    r: (ring.r + ring2.r) / 2,
    g: (ring.g + ring2.g) / 2,
    b: (ring.b + ring2.b) / 2,
    noise: Math.max(ring.noise, ring2.noise),
    samples: ring.samples + ring2.samples,
  };
  const tol = Math.max(MAT_DEVIATION_FLOOR, MAT_DEVIATION_NOISE_MULTIPLE * mat.noise);
  const isMat = (o: number): boolean =>
    (Math.abs(pixels[o] - mat.r) + Math.abs(pixels[o + 1] - mat.g) + Math.abs(pixels[o + 2] - mat.b)) / 3 <= tol;

  const median = (a2: number[]): number => {
    if (a2.length === 0) return 0;
    const q = [...a2].sort((x, y) => x - y);
    return q[Math.floor(q.length / 2)];
  };
  const iqr = (a2: number[]): number => {
    if (a2.length < 4) return 0;
    const q = [...a2].sort((x, y) => x - y);
    return q[Math.floor(0.75 * q.length)] - q[Math.floor(0.25 * q.length)];
  };

  // ── Resumption-aware line walk ──────────────────────────────────────────
  // Walk mat; on a stop candidate, look ahead for the ORIGINAL mat to resume
  // for a sustained run. If it does, the thing we hit was an artefact stripe
  // lying in the mat: step over it and keep going. If it does not, that was
  // the card and we stop for good.
  const resumeTol = tol * MAT_RESUME_STRICTNESS;
  const isStrictMat = (o: number): boolean =>
    (Math.abs(pixels[o] - mat.r) + Math.abs(pixels[o + 1] - mat.g) + Math.abs(pixels[o + 2] - mat.b)) / 3 <= resumeTol;

  interface LineWalk {
    depth: number;
    skips: number;
    skippedWidth: number;
    resumedRun: number;
  }
  const walkLine = (getOffset: (d: number) => number, limit: number): LineWalk => {
    let d = 0;
    let skips = 0;
    let skippedWidth = 0;
    let resumedRun = 0;
    for (;;) {
      while (d < limit && isMat(getOffset(d))) d++;
      if (d >= limit) return { depth: limit, skips, skippedWidth, resumedRun };
      if (skips >= MAT_RESUME_MAX_SKIPS) return { depth: d, skips, skippedWidth, resumedRun };

      // Look for the mat to resume within a bounded window.
      let resumeAt = -1;
      let runLen = 0;
      const windowEnd = Math.min(limit, d + MAT_RESUME_LOOKAHEAD_PX);
      for (let j = d + 1; j < windowEnd; j++) {
        if (isStrictMat(getOffset(j))) {
          if (runLen === 0) resumeAt = j;
          runLen++;
          if (runLen >= MAT_RESUME_MIN_RUN_PX) break; // decision made; run measured below
        } else {
          runLen = 0;
          resumeAt = -1;
        }
      }
      const stripeWidth = resumeAt >= 0 ? resumeAt - d : Infinity;
      const withinCaps =
        runLen >= MAT_RESUME_MIN_RUN_PX &&
        stripeWidth <= MAT_RESUME_MAX_STRIPE_PX &&
        skippedWidth + stripeWidth <= MAT_RESUME_MAX_TOTAL_SKIP_PX;
      if (!withinCaps) return { depth: d, skips, skippedWidth, resumedRun };

      // Diagnostic only: the loop above exits as soon as the MINIMUM run is
      // satisfied, so runLen would always read exactly MAT_RESUME_MIN_RUN_PX.
      // Measure the true contiguous run (bounded by the look-ahead window, and
      // reported honestly as observed within that bound). This cannot affect
      // the decision — `withinCaps` was already evaluated above.
      let trueRun = 0;
      for (let j = resumeAt; j < Math.min(limit, d + MAT_RESUME_LOOKAHEAD_PX) && isStrictMat(getOffset(j)); j++) {
        trueRun++;
      }
      skips++;
      skippedWidth += stripeWidth;
      resumedRun = Math.max(resumedRun, Math.max(runLen, trueRun));
      d = resumeAt;
    }
  };

  const depthsTop: number[] = [];
  const depthsBottom: number[] = [];
  const skipTally = { top: 0, bottom: 0, left: 0, right: 0 };
  const skipWidth = { top: 0, bottom: 0, left: 0, right: 0 };
  const resumeRun = { top: 0, bottom: 0, left: 0, right: 0 };
  const tally = (e: "top" | "bottom" | "left" | "right", r: LineWalk) => {
    if (r.skips > 0) skipTally[e]++;
    skipWidth[e] = Math.max(skipWidth[e], r.skippedWidth);
    resumeRun[e] = Math.max(resumeRun[e], r.resumedRun);
  };
  for (let x = 0; x < w; x++) {
    const t2 = walkLine((d) => (d * w + x) * ch, h);
    depthsTop.push(t2.depth);
    tally("top", t2);
    const b2 = walkLine((d) => ((h - 1 - d) * w + x) * ch, h);
    depthsBottom.push(b2.depth);
    tally("bottom", b2);
  }
  const depthsLeft: number[] = [];
  const depthsRight: number[] = [];
  for (let y = 0; y < h; y++) {
    const l2 = walkLine((d) => (y * w + d) * ch, w);
    depthsLeft.push(l2.depth);
    tally("left", l2);
    const r2 = walkLine((d) => (y * w + (w - 1 - d)) * ch, w);
    depthsRight.push(r2.depth);
    tally("right", r2);
  }
  const spread = {
    top: iqr(depthsTop),
    bottom: iqr(depthsBottom),
    left: iqr(depthsLeft),
    right: iqr(depthsRight),
  };
  // A whole edge reading as mat means the card was not found on that side.
  const saturated = (v: number, axis: number) => v >= axis - 1;
  const anySkip = skipTally.top + skipTally.bottom + skipTally.left + skipTally.right > 0;
  const t = median(depthsTop),
    b = median(depthsBottom),
    l = median(depthsLeft),
    r = median(depthsRight);
  const unreliable = saturated(t, h) || saturated(b, h) || saturated(l, w) || saturated(r, w) || mat.samples === 0;
  const wide = Math.max(spread.top, spread.bottom, spread.left, spread.right) > Math.max(8, 0.05 * Math.min(w, h));
  return {
    top: t,
    bottom: b,
    left: l,
    right: r,
    source: unreliable ? "unknown" : "pixel_measured",
    // Artefact SKIP is not measurement UNCERTAINTY.
    //
    // A skip only happens when the walk proved the mat resumed: the resumption
    // matched the original mat profile at 2.5x the walk's own strictness, the
    // run was long enough, and every stripe-width/skip-count cap held. That is
    // a *resolved* measurement, not a doubtful one. Folding it into confidence
    // meant the scanner stripe -- present on 500/500 cards and 3955/4000 edges --
    // downgraded essentially every face, so the strict bound never applied
    // anywhere: measured over 1000 faces, 289/289 proposals ran widened, of
    // which 276 were downgraded by the skip ALONE (13 had genuine wide spread,
    // 0 were unreliable).
    //
    // Genuine uncertainty is still honoured: `unreliable` (reference collapse or
    // a saturated edge) and `wide` (inconsistent per-line depths) keep the
    // widened allowance, and an implausible mat still takes the unknown-mat
    // ceiling untouched. The skip remains fully visible in `skips`,
    // `skippedWidthPx` and `resumedRunPx`, and in the artefactSkipped flag.
    confidence: unreliable || wide ? "low" : "high",
    artefactSkipped: anySkip,
    skips: skipTally,
    skippedWidthPx: skipWidth,
    resumedRunPx: resumeRun,
    spread,
    stopReason: { top: "mat_deviation", bottom: "mat_deviation", left: "mat_deviation", right: "mat_deviation" },
  };
}

/** Local mat profile sampled from a strip that is guaranteed to be mat. */
export interface MatProfileSample {
  r: number;
  g: number;
  b: number;
  /** Mean absolute per-channel deviation within the sample = scanner noise. */
  noise: number;
  samples: number;
}

/** Sample the local mat profile from a strip of the buffer. */
export function sampleMatProfile(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  box: { x0: number; y0: number; x1: number; y1: number }
): MatProfileSample {
  const x0 = Math.max(0, Math.min(w, box.x0));
  const x1 = Math.max(0, Math.min(w, box.x1));
  const y0 = Math.max(0, Math.min(h, box.y0));
  const y1 = Math.max(0, Math.min(h, box.y1));
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * ch;
      r += pixels[o];
      g += pixels[o + 1];
      b += pixels[o + 2];
      n++;
    }
  if (n === 0) return { r: 255, g: 255, b: 255, noise: 0, samples: 0 };
  r /= n;
  g /= n;
  b /= n;
  let dev = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * ch;
      dev += (Math.abs(pixels[o] - r) + Math.abs(pixels[o + 1] - g) + Math.abs(pixels[o + 2] - b)) / 3;
    }
  return { r, g, b, noise: dev / n, samples: n };
}

/**
 * Fraction of a discarded band that differs from the LOCAL MAT PROFILE.
 *
 * Replaces the original `sat >= 30 || luma < 120` test, which scored a white
 * card border, a silver border and a pale rule panel as ZERO content — the
 * same blind spot as the detector this gate exists to police. Comparing
 * against the measured mat instead detects any material difference, including
 * near-white print, and the threshold floats with the scanner's own noise so a
 * grainy bed does not manufacture false content.
 */
export function measureBandContentFraction(
  pixels: Uint8Array,
  w: number,
  h: number,
  ch: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  mat?: MatProfileSample
): number {
  const x0 = Math.max(0, Math.min(w, box.x0));
  const x1 = Math.max(0, Math.min(w, box.x1));
  const y0 = Math.max(0, Math.min(h, box.y0));
  const y1 = Math.max(0, Math.min(h, box.y1));
  if (x1 <= x0 || y1 <= y0) return 0;
  const profile = mat ?? sampleMatProfile(pixels, w, h, ch, box);
  const threshold = Math.max(MAT_DEVIATION_FLOOR, MAT_DEVIATION_NOISE_MULTIPLE * profile.noise);
  let contentLike = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * ch;
      const d =
        (Math.abs(pixels[o] - profile.r) + Math.abs(pixels[o + 1] - profile.g) + Math.abs(pixels[o + 2] - profile.b)) /
        3;
      if (d > threshold) contentLike++;
      total++;
    }
  }
  return total > 0 ? contentLike / total : 0;
}

/** Mean inward paint depth (px) per edge, by comparing pre/post whitewash. */
export function measurePaintDepth(
  before: Buffer,
  after: Buffer,
  w: number,
  h: number,
  ch: number
): { top: number; bottom: number; left: number; right: number } {
  const changed = (x: number, y: number): boolean => {
    const off = (y * w + x) * ch;
    return before[off] !== after[off] || before[off + 1] !== after[off + 1] || before[off + 2] !== after[off + 2];
  };
  let top = 0,
    bottom = 0,
    left = 0,
    right = 0;
  for (let x = 0; x < w; x++) {
    let d = 0;
    while (d < h && changed(x, d)) d++;
    top += d;
    d = 0;
    while (d < h && changed(x, h - 1 - d)) d++;
    bottom += d;
  }
  for (let y = 0; y < h; y++) {
    let d = 0;
    while (d < w && changed(d, y)) d++;
    left += d;
    d = 0;
    while (d < w && changed(w - 1 - d, y)) d++;
    right += d;
  }
  return {
    top: top / Math.max(1, w),
    bottom: bottom / Math.max(1, w),
    left: left / Math.max(1, h),
    right: right / Math.max(1, h),
  };
}

/** Fraction of pixels altered by the whitewash walk. */
export function countChangedPixels(before: Buffer, after: Buffer, ch: number): number {
  const n = Math.floor(Math.min(before.length, after.length) / ch);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const off = i * ch;
    if (before[off] !== after[off] || before[off + 1] !== after[off + 1] || before[off + 2] !== after[off + 2])
      changed++;
  }
  return changed / n;
}

/**
 * Cross-face consistency: two faces of ONE physical card must agree. Returns
 * which side (if any) should be rolled back to its untightened derivative.
 * MV602's front/back aspect delta was 0.0800 against a healthy 0.0007-0.0090.
 */
export interface CrossFaceVerdict {
  consistent: boolean;
  reasons: CropIntegrityReasonCode[];
  aspectDelta: number;
  trimDelta: { horizontal: number; vertical: number };
  /** The side to roll back — the one further from the physical card aspect. */
  rollback: "front" | "back" | null;
  /** Non-null when the comparison was deliberately not performed. */
  skipped: "missing_face" | "face_already_fell_back" | null;
}

export interface CrossFaceInput {
  /** EMITTED aspect — never a rejected proposal's. */
  aspect: number;
  /** EMITTED trim — never a rejected proposal's. */
  trimFraction: { horizontal: number; vertical: number };
  /** True when this face is already a fallback. */
  usedFallback: boolean;
}

export function evaluateCrossFaceConsistency(
  front: CrossFaceInput | null,
  back: CrossFaceInput | null
): CrossFaceVerdict {
  if (!front || !back) {
    return {
      consistent: true,
      reasons: [],
      aspectDelta: 0,
      trimDelta: { horizontal: 0, vertical: 0 },
      rollback: null,
      skipped: "missing_face",
    };
  }
  // If either face already fell back, its geometry describes the UNTIGHTENED
  // source, not a comparable crop. Comparing them would measure the fallback,
  // not a defect — and previously selected the HEALTHY face for rollback
  // (hostile-review finding 4, reproduced with MV602 front + MV609 back).
  // The offending face has already been made safe by the gate; the other face
  // is judged on its own merits and left alone.
  if (front.usedFallback || back.usedFallback) {
    const aspectDelta = Math.abs(front.aspect - back.aspect);
    return {
      consistent: true,
      reasons: [],
      aspectDelta,
      trimDelta: {
        horizontal: Math.abs(front.trimFraction.horizontal - back.trimFraction.horizontal),
        vertical: Math.abs(front.trimFraction.vertical - back.trimFraction.vertical),
      },
      rollback: null,
      skipped: "face_already_fell_back",
    };
  }
  const reasons: CropIntegrityReasonCode[] = [];
  const aspectDelta = Math.abs(front.aspect - back.aspect);
  const trimDelta = {
    horizontal: Math.abs(front.trimFraction.horizontal - back.trimFraction.horizontal),
    vertical: Math.abs(front.trimFraction.vertical - back.trimFraction.vertical),
  };
  if (aspectDelta > MAX_FRONT_BACK_ASPECT_DELTA) reasons.push("cross_face_aspect_delta");
  if (
    trimDelta.horizontal > MAX_FRONT_BACK_TRIM_DELTA_FRACTION ||
    trimDelta.vertical > MAX_FRONT_BACK_TRIM_DELTA_FRACTION
  ) {
    reasons.push("cross_face_trim_delta");
  }
  let rollback: "front" | "back" | null = null;
  if (reasons.length > 0) {
    const fDev = Math.abs(front.aspect - CARD_ASPECT_RATIO);
    const bDev = Math.abs(back.aspect - CARD_ASPECT_RATIO);
    rollback = fDev >= bDev ? "front" : "back";
  }
  return { consistent: reasons.length === 0, reasons, aspectDelta, trimDelta, rollback, skipped: null };
}

export async function tightenForDisplay(
  inputBuffer: Buffer,
  certId?: string | number,
  fallbackInsetPx: number = 16,
  side?: "front" | "back",
  report?: CropIntegrityReport,
  matMarginPx?: { top: number; bottom: number; left: number; right: number } | null
): Promise<Buffer> {
  const certTag = certId != null ? ` cert=${certId}` : "";
  let metaW = 0,
    metaH = 0;
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return inputBuffer;
    metaW = meta.width;
    metaH = meta.height;
    if (report) {
      report.side = side;
      report.pre = dims(metaW, metaH);
    }

    // Detect on a downscaled copy (same pattern as cropToCardBoundary).
    const scale = Math.min(1, 1500 / Math.max(metaW, metaH));
    const workW = Math.round(metaW * scale);
    const workH = Math.round(metaH * scale);
    const { data, info } = await sharp(inputBuffer)
      .resize(workW, workH, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    const boundary = detectCardEdgesByCoverage(pixels, info.width, info.height, info.channels, certId);
    if (!boundary) {
      console.warn(`[tightenForDisplay] coverage detect failed${certTag} — falling back to ${fallbackInsetPx}px inset`);
      if (report) {
        report.decision = "detect_failed";
        report.reasons = ["coverage_detect_failed"];
        report.fallback = "uniform_inset";
        report.cropConfidence = "low";
        // Detection failed before any mat measurement was attempted. Record that
        // explicitly rather than leaving the state undefined (MV394): a missing
        // assessment must never read as a clean primary-stage success, and we
        // must not invent mat values we never measured.
        report.cardDetectionState = "failed";
        report.matUsedForAcceptance = false;
        report.matPlausibility = {
          state: "not_assessed_detection_failed",
          usableForAcceptance: false,
          reasons: ["card edge detection failed; mat measurement was never attempted"],
          matShare: { horizontal: 0, vertical: 0 },
          remaining: { w: 0, h: 0, aspect: 0, wFraction: 0, hFraction: 0 },
        };
        report.outputSafeButDegraded = true;
      }
      const inset = await applyInsetFallback(inputBuffer, metaW, metaH, fallbackInsetPx);
      const mi = await sharp(inset).metadata();
      stampEmitted(report, mi.width ?? metaW, mi.height ?? metaH, true);
      return inset;
    }

    // Map bounds back to full-res
    let origMinX = Math.round(boundary.minX / scale);
    let origMinY = Math.round(boundary.minY / scale);
    let origMaxX = Math.round(boundary.maxX / scale);
    let origMaxY = Math.round(boundary.maxY / scale);

    // Outward expansion (uniform, colour-agnostic). The coverage detector
    // lands bounds on the first meaningfully-card row/column, which can
    // shave a sliver off lower-contrast borders (yellow on white mat is
    // worst — the outer fraction of yellow has weak mat-contrast and the
    // 70%-coverage rule excludes it). A 30 px outward buffer guarantees
    // mat/vinyl pixels are present in the crop for the saturation walk
    // below to locate the actual coloured card edge. Same value for both
    // sides — the per-side hardcoded numbers (front 18, back 13) were a
    // workaround for the detector's colour-specific behaviour and never
    // worked for green/red/black-bordered cards.
    const EXPAND_PX = 30;
    origMinX -= EXPAND_PX;
    origMinY -= EXPAND_PX;
    origMaxX += EXPAND_PX;
    origMaxY += EXPAND_PX;

    const clamped = origMinX < 0 || origMinY < 0 || origMaxX > metaW - 1 || origMaxY > metaH - 1;
    origMinX = Math.max(0, origMinX);
    origMinY = Math.max(0, origMinY);
    origMaxX = Math.min(metaW - 1, origMaxX);
    origMaxY = Math.min(metaH - 1, origMaxY);
    if (clamped) {
      console.warn(
        `[tightenForDisplay] mapped bounds extended past bitmap, clamped${certTag} (after +${EXPAND_PX}px expansion)`
      );
    }

    const cropW = origMaxX - origMinX + 1;
    const cropH = origMaxY - origMinY + 1;

    if (report) report.proposed = dims(cropW, cropH);

    // Legacy floor, kept as a coarse backstop only. It is NOT the integrity
    // control — MV602 lost 17.3% of card height and passed this check.
    if (cropW < metaW * 0.5 || cropH < metaH * 0.5) {
      console.warn(
        `[tightenForDisplay] detected crop ${cropW}x${cropH} < 50% of input ${metaW}x${metaH}${certTag}` +
          ` — falling back to ${fallbackInsetPx}px inset`
      );
      if (report) {
        report.decision = "rejected";
        report.reasons = ["below_half_input"];
        report.fallback = "uniform_inset";
        report.cropConfidence = "low";
      }
      const inset = await applyInsetFallback(inputBuffer, metaW, metaH, fallbackInsetPx);
      const mi = await sharp(inset).metadata();
      stampEmitted(report, mi.width ?? metaW, mi.height ?? metaH, true);
      return inset;
    }

    // ── PRIMARY CROP-INTEGRITY GATE ─────────────────────────────────────────
    // Measure, in detector space, how much CARD CONTENT sits in each band this
    // crop would discard. A band that is mostly mat is fine; a band carrying a
    // rule box, card number or a pale border is content loss.
    const sMinX = Math.round(boundary.minX);
    const sMinY = Math.round(boundary.minY);
    const sMaxX = Math.round(boundary.maxX);
    const sMaxY = Math.round(boundary.maxY);
    // The +EXPAND_PX outward buffer is applied in full-res space; mirror it in
    // detector space so the measured band matches what is actually discarded.
    const sExpand = Math.max(1, Math.round(EXPAND_PX * scale));
    const bTop = Math.max(0, sMinY - sExpand);
    const bBottom = Math.min(info.height, sMaxY + sExpand);
    const bLeft = Math.max(0, sMinX - sExpand);
    const bRight = Math.min(info.width, sMaxX + sExpand);
    const discardedBandContentFraction = {
      top: measureBandContentFraction(pixels, info.width, info.height, info.channels, {
        x0: bLeft,
        y0: 0,
        x1: bRight,
        y1: bTop,
      }),
      bottom: measureBandContentFraction(pixels, info.width, info.height, info.channels, {
        x0: bLeft,
        y0: bBottom,
        x1: bRight,
        y1: info.height,
      }),
      left: measureBandContentFraction(pixels, info.width, info.height, info.channels, {
        x0: 0,
        y0: bTop,
        x1: bLeft,
        y1: bBottom,
      }),
      right: measureBandContentFraction(pixels, info.width, info.height, info.channels, {
        x0: bRight,
        y0: bTop,
        x1: info.width,
        y1: bBottom,
      }),
    };
    // Per-edge retained mat, MEASURED from this very buffer (detector space),
    // then scaled to full resolution. Replaces the opposing-edge mean, which
    // described neither edge on an asymmetric scan.
    const measured = measureRetainedMatPerEdge(pixels, info.width, info.height, info.channels);
    const toFull = (v: number) => Math.round(v / scale);
    const resolvedMat =
      measured.source === "pixel_measured"
        ? {
            top: toFull(measured.top),
            bottom: toFull(measured.bottom),
            left: toFull(measured.left),
            right: toFull(measured.right),
          }
        : (matMarginPx ?? null);
    const matSource: MatMarginSource =
      measured.source === "pixel_measured" ? "pixel_measured" : matMarginPx ? "geometry_derived" : "unknown";

    // ── PLAUSIBILITY GATE ───────────────────────────────────────────────────
    // An inflated or collapsed mat measurement inflates the crop we are willing
    // to permit, which is the destructive direction. If the measurement is not
    // physically plausible it is recorded but is NOT allowed to influence
    // acceptance: we fall through to the absolute unknown-mat ceiling, which is
    // strictly more conservative than trusting a bad number.
    const anySkip = measured.skips.top + measured.skips.bottom + measured.skips.left + measured.skips.right > 0;
    const plaus = assessMatPlausibility(resolvedMat ?? { top: 0, bottom: 0, left: 0, right: 0 }, metaW, metaH, {
      skipped: anySkip,
      sourceUnknown: matSource === "unknown",
    });
    const acceptanceMat = plaus.usableForAcceptance ? resolvedMat : null;
    if (!plaus.usableForAcceptance) {
      console.warn(
        `[tightenForDisplay] mat measurement NOT usable for acceptance${certTag} side=${side ?? "?"}` +
          ` state=${plaus.state} reasons=${plaus.reasons.join("; ")}` +
          ` — falling back to the absolute unknown-mat ceiling`
      );
    }
    if (report) {
      report.cardDetectionState = "detected";
      report.retainedMat = resolvedMat
        ? { ...resolvedMat, source: matSource, confidence: measured.confidence }
        : { top: 0, bottom: 0, left: 0, right: 0, source: "unknown", confidence: "low" };
      report.matPlausibility = plaus;
      report.matUsedForAcceptance = plaus.usableForAcceptance;
    }

    const verdict = evaluateCropIntegrity({
      inputW: metaW,
      inputH: metaH,
      cropLeft: origMinX,
      cropTop: origMinY,
      cropW,
      cropH,
      discardedBandContentFraction,
      matMarginPx: acceptanceMat,
      matConfidence: measured.confidence,
    });
    if (report) {
      report.edgeTrimPx = verdict.edgeTrimPx;
      report.trimFraction = verdict.trimFraction;
      report.discardedBandContentFraction = discardedBandContentFraction;
      report.edgeTrimBeyondMatMm = verdict.edgeTrimBeyondMatMm;
    }
    if (!verdict.accepted) {
      // FAIL CLOSED. Emit the UNTIGHTENED centred input unchanged: it still has
      // the mat safety strip (cosmetically imperfect) but it provably contains
      // the whole card. Never emit a crop we cannot vouch for.
      console.warn(
        `[tightenForDisplay] REJECTED crop ${metaW}x${metaH} → ${cropW}x${cropH}${certTag}` +
          ` side=${side ?? "?"} reasons=${verdict.reasons.join(",")}` +
          ` trimH=${(verdict.trimFraction.horizontal * 100).toFixed(1)}%` +
          ` trimV=${(verdict.trimFraction.vertical * 100).toFixed(1)}%` +
          ` aspect=${verdict.proposedAspect.toFixed(4)} — emitting untightened input`
      );
      if (report) {
        report.decision = "rejected";
        report.reasons = verdict.reasons;
        report.fallback = "untightened_input";
        report.cropConfidence = "low";
        report.whitewash = { applied: false, paintedFraction: 0, reason: "crop_rejected" };
      }
      stampEmitted(report, metaW, metaH, true);
      return inputBuffer;
    }

    console.log(
      `[tightenForDisplay] ${metaW}x${metaH} → ${cropW}x${cropH}` +
        ` (trimmed L:${origMinX} R:${metaW - 1 - origMaxX} T:${origMinY} B:${metaH - 1 - origMaxY})${certTag}`
    );

    // Extract to raw pixels for in-place per-edge saturation walk, then
    // encode once at the end. See whitewashEdgesBySaturation for the
    // algorithm; the walk paints mat/vinyl/scanner-bleed pixels (sat<30)
    // white and stops at the first coloured pixel (sat≥30) per row/col,
    // up to 30 px deep. Card borders of any colour stop the walk.
    const { data: cropData, info: cropInfo } = await sharp(inputBuffer)
      .extract({ left: origMinX, top: origMinY, width: cropW, height: cropH })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const edgeKeepPx = side === "back" ? 0 : 2;
    const original = Buffer.from(cropData);
    const whitewashStats: WhitewashStats = { matSat: 0, borderSat: 0, satStop: 0, skipped: false };
    const emitted = whitewashEdgesBySaturation(
      Buffer.from(cropData),
      cropInfo.width,
      cropInfo.height,
      cropInfo.channels,
      30,
      certTag,
      edgeKeepPx,
      whitewashStats,
      acceptanceMat
    );
    // Diagnostics only — the accept/skip decision is made inside the walk on
    // border-vs-mat saturation contrast (see WHITEWASH SAFETY BOUNDARY there).
    const paintedFraction = countChangedPixels(original, emitted, cropInfo.channels);
    if (report) {
      report.decision = "accepted";
      report.reasons = [];
      report.fallback = "none";
      report.cropConfidence = "high";
      report.whitewash = {
        applied: !whitewashStats.skipped,
        paintedFraction: +paintedFraction.toFixed(4),
        reason: whitewashStats.reason,
        matSat: whitewashStats.matSat,
        borderSat: whitewashStats.borderSat,
        satStop: whitewashStats.satStop,
      };
    }

    stampEmitted(report, cropInfo.width, cropInfo.height, false);
    return await sharp(emitted, {
      raw: { width: cropInfo.width, height: cropInfo.height, channels: cropInfo.channels },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err: any) {
    console.warn(`[tightenForDisplay] threw${certTag}: ${err.message} — falling back to ${fallbackInsetPx}px inset`);
    if (report) {
      report.decision = "error";
      report.reasons = ["threw"];
      report.cropConfidence = "low";
    }
    try {
      const insetE = await applyInsetFallback(inputBuffer, metaW, metaH, fallbackInsetPx);
      if (report) report.fallback = "uniform_inset";
      const me = await sharp(insetE).metadata();
      stampEmitted(report, me.width ?? metaW, me.height ?? metaH, true);
      return insetE;
    } catch {
      if (report) report.fallback = "input_on_error";
      stampEmitted(report, metaW, metaH, true);
      return inputBuffer;
    }
  }
}

async function applyInsetFallback(inputBuffer: Buffer, w: number, h: number, insetPx: number): Promise<Buffer> {
  if (!w || !h || w <= 2 * insetPx + 50 || h <= 2 * insetPx + 50) return inputBuffer;
  return await sharp(inputBuffer)
    .extract({ left: insetPx, top: insetPx, width: w - 2 * insetPx, height: h - 2 * insetPx })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Auto-crop: detect card in scan and crop tight to the actual card edges.
 * Two-pass approach: aggressive trim first, then validate white border %.
 * Falls back to softer trim if aggressive is too tight.
 */
export async function autoCrop(
  inputBuffer: Buffer
): Promise<{ buffer: Buffer; cropped: boolean; matRgb: { r: number; g: number; b: number } }> {
  // autoCrop's pass-1 trim assumes a near-white background ({255,255,255}
  // threshold 80). Surface that as matRgb so reCentreBitmap fills extend
  // padding with white rather than misdetecting the card border as mat.
  const matRgb = { r: 255, g: 255, b: 255 };
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return { buffer: inputBuffer, cropped: false, matRgb };

    // Downscale huge scanner images first to prevent OOM
    let workBuffer = inputBuffer;
    if (meta.width > 4000 || meta.height > 4000) {
      workBuffer = await sharp(inputBuffer)
        .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toBuffer();
    }

    // Pass 1: Aggressive trim (threshold 80 — catches subtle yellow-on-white card borders)
    let trimBuf: Buffer;
    let trimInfo: sharp.OutputInfo;
    try {
      const result = await sharp(workBuffer)
        .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 80 })
        .toBuffer({ resolveWithObject: true });
      trimBuf = result.data;
      trimInfo = result.info;
    } catch {
      // Aggressive trim failed — try softer
      const result = await sharp(workBuffer)
        .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 30 })
        .toBuffer({ resolveWithObject: true });
      trimBuf = result.data;
      trimInfo = result.info;
    }

    // Validate: trimmed result must be reasonable
    const origArea = (meta.width || 1) * (meta.height || 1);
    const trimArea = trimInfo.width * trimInfo.height;
    if (trimArea / origArea < 0.15 || trimInfo.width < 100 || trimInfo.height < 100) {
      console.warn(
        `[crop] trim too aggressive: ${trimInfo.width}x${trimInfo.height} (${((trimArea / origArea) * 100).toFixed(1)}% of original)`
      );
      return { buffer: workBuffer, cropped: false, matRgb };
    }

    // Measure the proportion of near-white pixels in the 5-px border ring.
    // NOTE: this is the outer-ring ratio, NOT a trim-quality signal — a
    // correctly-cropped card with a white margin (common on Pokémon backs)
    // will legitimately read 90–100%. The re-trim below is an attempt to
    // catch remaining mat bleed, but will no-op when the white IS the card.
    let borderRingWhitePct = await measureBorderRingWhiteness(trimBuf, trimInfo.width, trimInfo.height);
    const firstPassRingWhite = borderRingWhitePct;
    let retrimApplied = false;
    if (borderRingWhitePct > 5) {
      console.log(`[crop] first pass: border_ring_white=${borderRingWhitePct.toFixed(1)}%, attempting re-trim`);
      try {
        const tighter = await sharp(trimBuf)
          .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 120 })
          .toBuffer({ resolveWithObject: true });
        const shrunk = tighter.info.width < trimInfo.width || tighter.info.height < trimInfo.height;
        if (tighter.info.width > 100 && tighter.info.height > 100 && shrunk) {
          trimBuf = tighter.data;
          trimInfo = tighter.info;
          borderRingWhitePct = await measureBorderRingWhiteness(trimBuf, trimInfo.width, trimInfo.height);
          retrimApplied = true;
          console.log(
            `[crop] re-trim reduced border ring: ${firstPassRingWhite.toFixed(1)}% → ${borderRingWhitePct.toFixed(1)}%`
          );
        } else {
          console.log(
            `[crop] re-trim no-op (tighter threshold found no additional mat to remove — remaining white is card margin, not mat)`
          );
        }
      } catch {
        console.log(`[crop] re-trim failed, keeping first-pass result`);
      }
    }

    // No internal padding — the downstream padWithMat step in
    // generateImageVariants/upload-images applies the canonical mat
    // padding (CARD_MAT_PADDING_PCT). Re-encode at JPEG q85 to keep the
    // size sensible without doubling-up padding here.
    const reencoded = await sharp(trimBuf).jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();

    const ratio = trimInfo.width / trimInfo.height;
    const expectedRatio = 0.714; // 2.5/3.5 = standard card
    const ratioDiff = Math.abs(ratio - expectedRatio) / expectedRatio;
    const ringNote = borderRingWhitePct > 90 ? " (likely card margin)" : retrimApplied ? " (post re-trim)" : "";
    console.log(
      `[crop] ${trimInfo.width}x${trimInfo.height} ratio=${ratio.toFixed(3)} ${ratioDiff < 0.1 ? "✓" : "⚠ off-ratio"} border_ring_white=${borderRingWhitePct.toFixed(1)}%${ringNote}`
    );

    return { buffer: reencoded, cropped: true, matRgb };
  } catch {
    return { buffer: inputBuffer, cropped: false, matRgb };
  }
}

/**
 * Measure percentage of near-white pixels (greyscale > 240) within a 5-px
 * ring around the image perimeter. This is a RING ratio, not a trim-quality
 * score — for a correctly-cropped card with a white margin it will read
 * 90–100%. Used as a heuristic to decide whether to attempt a tighter trim.
 */
async function measureBorderRingWhiteness(buf: Buffer, w: number, h: number): Promise<number> {
  try {
    const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(data);
    let white = 0,
      total = 0;
    const border = 5;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < border || x >= w - border || y < border || y >= h - border) {
          total++;
          if (pixels[y * w + x] > 240) white++;
        }
      }
    }
    return total > 0 ? (white / total) * 100 : 0;
  } catch {
    return 0;
  }
}

/**
 * Re-centre the card content within its own bitmap by measuring actual card
 * edges against the mat colour (Fix 2 rewrite — previously used a fixed white-
 * luma threshold, which fell over on black/neutral mats and on cards with
 * pale outer borders).
 *
 * Algorithm:
 *  1. Determine matRgb — either supplied by caller (preferred: sample from the
 *     pre-crop buffer where the strip is reliably mat) or best-effort-sampled
 *     from the outer 2% strip of the input buffer.
 *  2. Scan inward from each edge. A row/col is declared "card" when >70% of
 *     its opaque pixels are non-mat (Euclidean colour distance > 45 from
 *     matRgb). The first such row/col on each side gives the margin L/R/T/B.
 *  3. If |L-R| > 4 (or |T-B| > 4), the card is off-centre within the bitmap.
 *     Shift it by dx = round((R-L)/2) (and dy analogously) — trim `dx` from
 *     the loose side, pad `dx` mat-coloured pixels on the tight side. Bitmap
 *     dimensions are preserved.
 *
 * Pad colour is matRgb so the visible mat colour stays consistent; the
 * downstream maskRoundedCorners pass replaces the mat region with
 * transparent corners anyway.
 *
 * Returns the (possibly shifted) buffer plus pre-shift margins and applied
 * shift amounts for forensics / audit-log persistence.
 */
const EDGE_DETECT_COLOUR_DELTA = 45; // matches isCardPixel threshold
const EDGE_DETECT_ROW_COVERAGE = 0.7; // 70% non-mat = card row
const RE_CENTRE_SHIFT_EPSILON = 4; // margin diff below this → no shift
const DEFAULT_MAT_RGB = { r: 255, g: 255, b: 255 }; // standard mat is white

export async function reCentreBitmap(
  inputBuffer: Buffer,
  options?: { matRgb?: { r: number; g: number; b: number }; certId?: string | number }
): Promise<{
  buffer: Buffer;
  pre_padding_px: { top: number; bottom: number; left: number; right: number };
  post_asymmetry_px: { horizontal: number; vertical: number };
  extended: boolean;
}> {
  const certTag = options?.certId != null ? ` cert=${options.certId}` : "";
  const meta = await sharp(inputBuffer).metadata();
  if (!meta.width || !meta.height) {
    return {
      buffer: inputBuffer,
      pre_padding_px: { top: 0, bottom: 0, left: 0, right: 0 },
      post_asymmetry_px: { horizontal: 0, vertical: 0 },
      extended: false,
    };
  }

  const { data, info } = await sharp(inputBuffer).raw().toBuffer({ resolveWithObject: true });
  const px = new Uint8Array(data);
  const w = info.width,
    h = info.height,
    ch = info.channels;

  // Mat colour: prefer caller-supplied; else sample only the four corner blocks
  // of the input. The outer-perimeter strip on a tightly-cropped card is mostly
  // the card's outer border (often saturated yellow on Pokémon cards), which
  // skews the median and causes extend padding to be filled with card-border
  // colour instead of mat — visible as a "wraparound" strip below the card.
  // The four corners are mat-on-mat even after card-detect tightening because
  // a Pokémon card's rounded corners cut to mat at the bitmap corners.
  let matR: number, matG: number, matB: number;
  if (options?.matRgb) {
    matR = options.matRgb.r;
    matG = options.matRgb.g;
    matB = options.matRgb.b;
  } else {
    const block = Math.min(30, Math.floor(Math.min(w, h) / 4));
    const rs: number[] = [],
      gs: number[] = [],
      bs: number[] = [];
    const pushAt = (x: number, y: number) => {
      const i = (y * w + x) * ch;
      if (ch === 4 && px[i + 3] < 128) return;
      rs.push(px[i]);
      gs.push(px[i + 1]);
      bs.push(px[i + 2]);
    };
    const sampleBlock = (x0: number, y0: number) => {
      for (let y = y0; y < y0 + block && y < h; y++) {
        for (let x = x0; x < x0 + block && x < w; x++) pushAt(x, y);
      }
    };
    sampleBlock(0, 0);
    sampleBlock(w - block, 0);
    sampleBlock(0, h - block);
    sampleBlock(w - block, h - block);
    const median = (arr: number[]) => {
      arr.sort((a, b) => a - b);
      return arr.length ? arr[Math.floor(arr.length / 2)] : 0;
    };
    if (rs.length > 0) {
      matR = median(rs);
      matG = median(gs);
      matB = median(bs);
    } else {
      matR = DEFAULT_MAT_RGB.r;
      matG = DEFAULT_MAT_RGB.g;
      matB = DEFAULT_MAT_RGB.b;
    }
  }

  const isNonMat = (r: number, g: number, b: number): boolean => {
    const dr = r - matR,
      dg = g - matG,
      db = b - matB;
    return Math.sqrt(dr * dr + dg * dg + db * db) > EDGE_DETECT_COLOUR_DELTA;
  };

  // Row coverage: fraction of opaque pixels in row y that are non-mat.
  const rowCoverage = (y: number): number => {
    let nonMat = 0,
      opaque = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      if (ch === 4 && px[i + 3] < 128) continue;
      opaque++;
      if (isNonMat(px[i], px[i + 1], px[i + 2])) nonMat++;
    }
    return opaque > 0 ? nonMat / opaque : 0;
  };
  const colCoverage = (x: number): number => {
    let nonMat = 0,
      opaque = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * ch;
      if (ch === 4 && px[i + 3] < 128) continue;
      opaque++;
      if (isNonMat(px[i], px[i + 1], px[i + 2])) nonMat++;
    }
    return opaque > 0 ? nonMat / opaque : 0;
  };

  let top = 0,
    bottom = 0,
    left = 0,
    right = 0;
  for (let y = 0; y < h; y++) {
    if (rowCoverage(y) > EDGE_DETECT_ROW_COVERAGE) {
      top = y;
      break;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    if (rowCoverage(y) > EDGE_DETECT_ROW_COVERAGE) {
      bottom = h - 1 - y;
      break;
    }
  }
  for (let x = 0; x < w; x++) {
    if (colCoverage(x) > EDGE_DETECT_ROW_COVERAGE) {
      left = x;
      break;
    }
  }
  for (let x = w - 1; x >= 0; x--) {
    if (colCoverage(x) > EDGE_DETECT_ROW_COVERAGE) {
      right = w - 1 - x;
      break;
    }
  }

  const prePadding = { top, bottom, left, right };
  const hDiff = Math.abs(left - right);
  const vDiff = Math.abs(top - bottom);

  if (hDiff <= RE_CENTRE_SHIFT_EPSILON && vDiff <= RE_CENTRE_SHIFT_EPSILON) {
    console.log(
      `[re-centre] margins L:${left} R:${right} T:${top} B:${bottom} — within ±${RE_CENTRE_SHIFT_EPSILON}px, no shift${certTag}`
    );
    return {
      buffer: inputBuffer,
      pre_padding_px: prePadding,
      post_asymmetry_px: { horizontal: 0, vertical: 0 },
      extended: false,
    };
  }

  // Compute shifts. dx > 0 moves card to the right (trim right margin, pad left).
  const dx = hDiff > RE_CENTRE_SHIFT_EPSILON ? Math.round((right - left) / 2) : 0;
  const dy = vDiff > RE_CENTRE_SHIFT_EPSILON ? Math.round((bottom - top) / 2) : 0;

  // Materialise the shift: extract the inner region offset by the shift, then
  // pad the tight side with mat colour so the bitmap keeps its original size.
  let extractLeft = 0,
    extractTop = 0,
    extractW = w,
    extractH = h;
  let padLeft = 0,
    padRight = 0,
    padTop = 0,
    padBottom = 0;
  if (dx > 0) {
    // shift card right: trim right, pad left
    extractLeft = 0;
    extractW = w - dx;
    padLeft = dx;
  } else if (dx < 0) {
    // shift card left: trim left, pad right
    extractLeft = -dx;
    extractW = w + dx;
    padRight = -dx;
  }
  if (dy > 0) {
    // shift card down: trim bottom, pad top
    extractTop = 0;
    extractH = h - dy;
    padTop = dy;
  } else if (dy < 0) {
    // shift card up: trim top, pad bottom
    extractTop = -dy;
    extractH = h + dy;
    padBottom = -dy;
  }

  let pipeline = sharp(inputBuffer);
  if (extractLeft > 0 || extractTop > 0 || extractW !== w || extractH !== h) {
    pipeline = pipeline.extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH });
  }
  if (padLeft || padRight || padTop || padBottom) {
    pipeline = pipeline.extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      background: { r: matR, g: matG, b: matB, alpha: 1 },
    });
  }
  const out = await pipeline.jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();

  const dxSign = dx > 0 ? `+${dx}` : `${dx}`;
  const dySign = dy > 0 ? `+${dy}` : `${dy}`;
  console.log(`[re-centre] margins L:${left} R:${right} T:${top} B:${bottom} → shift ${dxSign}x, ${dySign}y${certTag}`);

  return {
    buffer: out,
    pre_padding_px: prePadding,
    post_asymmetry_px: { horizontal: dx, vertical: dy },
    extended: false,
  };
}

// ── Mat padding (final pipeline step) ──────────────────────────────────────
// reCentreBitmap preserves bitmap dimensions — its job is centring, not
// adding mat space. Without an explicit padding step the cropped output is
// edge-to-edge card with essentially zero mat margin. padWithMat extends the
// bitmap on all four sides with the sampled mat colour, giving the final
// image a passport-style frame.
//
// Apply AFTER maskRoundedCorners so the rounded-corner alpha mask is on the
// card's actual corners (not pushed out to the bitmap corners far from the
// card by the new padding).

/** Per-side padding as a fraction of min(input width, height). 0.30 ≈ 1.5×
 *  total output dims for a roughly square aspect. Tunable. */
export const CARD_MAT_PADDING_PCT = 0.02;

/**
 * Extend an image with mat-coloured padding on all four sides.
 *
 * Per-side padding = round(min(w,h) * CARD_MAT_PADDING_PCT). Using min(w,h)
 * keeps padding proportional to the smaller dimension so portrait cards
 * don't get massively over-padded vertically.
 *
 * Output keeps the input's encoding family — PNG in, PNG out (preserves
 * alpha for the masked display); JPEG in, JPEG out.
 */
export async function padWithMat(inputBuffer: Buffer, matRgb: { r: number; g: number; b: number }): Promise<Buffer> {
  const meta = await sharp(inputBuffer).metadata();
  if (!meta.width || !meta.height) return inputBuffer;
  const padPx = Math.max(0, Math.round(Math.min(meta.width, meta.height) * CARD_MAT_PADDING_PCT));
  if (padPx === 0) return inputBuffer;
  const isPng = meta.format === "png";
  const pipeline = sharp(inputBuffer).extend({
    top: padPx,
    bottom: padPx,
    left: padPx,
    right: padPx,
    background: { r: matRgb.r, g: matRgb.g, b: matRgb.b, alpha: isPng ? 1 : 1 },
  });
  const out = isPng
    ? await pipeline.png().toBuffer()
    : await pipeline.jpeg({ quality: 90, progressive: true, mozjpeg: true }).toBuffer();
  return out;
}

/**
 * 1600px-wide q80 display derivative for the grading-panel viewer.
 * The full-res cropped scan (often 3000px+, multi-MB) stays in R2 as the
 * zoom / manual-tool source; the viewer loads this (~150-300KB) instead.
 */
export async function makeDisplayDerivative(inputBuffer: Buffer): Promise<Buffer> {
  return sharp(inputBuffer)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: true, mozjpeg: true })
    .toBuffer();
}

/**
 * Generate all image variants for grading analysis.
 * Resizes to max 2000px first to reduce memory usage,
 * then processes sequentially to avoid OOM on 512MB-1GB machines.
 */
export async function generateVariants(inputBuffer: Buffer): Promise<{
  greyscale: Buffer;
  highcontrast: Buffer;
  edgeenhanced: Buffer;
  inverted: Buffer;
}> {
  // Resize to 2576px max (Opus 4.7 resolution) — keeps peak RAM manageable
  const resized = await sharp(inputBuffer)
    .resize(2576, 2576, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

  // Sequential processing to limit peak memory
  const greyscale = await sharp(resized).greyscale().jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();

  const highcontrast = await sharp(resized)
    .modulate({ brightness: 1.1 })
    .linear(1.6, -(128 * 1.6 - 128))
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

  const edgeenhanced = await sharp(resized)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

  const inverted = await sharp(resized).negate().jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();

  return { greyscale, highcontrast, edgeenhanced, inverted };
}

/**
 * Run quality checks on an image buffer.
 */
export async function checkImageQuality(inputBuffer: Buffer): Promise<QualityResult> {
  const checks: QualityCheck[] = [];

  try {
    const meta = await sharp(inputBuffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const longest = Math.max(width, height);

    // 1. Resolution check
    if (longest >= 2000) {
      checks.push({ name: "resolution", status: "pass", message: `${width} × ${height}px — excellent resolution` });
    } else if (longest >= 1000) {
      checks.push({
        name: "resolution",
        status: "warn",
        message: `${width} × ${height}px — low resolution. Scan at 1200 DPI or higher for best results.`,
      });
    } else {
      checks.push({
        name: "resolution",
        status: "fail",
        message: `${width} × ${height}px — resolution too low for accurate grading. Please rescan at higher resolution.`,
      });
    }

    // 2. Blur detection (Laplacian variance)
    try {
      const edgeBuf = await sharp(inputBuffer)
        .greyscale()
        .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const pixels = new Uint8Array(edgeBuf.data);
      let sum = 0,
        sum2 = 0;
      const n = pixels.length;
      for (let i = 0; i < n; i++) {
        sum += pixels[i];
        sum2 += pixels[i] * pixels[i];
      }
      const mean = sum / n;
      const variance = sum2 / n - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance));

      if (stddev > 8) {
        checks.push({ name: "blur", status: "pass", message: "Image is sharp" });
      } else {
        checks.push({
          name: "blur",
          status: "warn",
          message: "Image may be slightly blurry. Ensure camera/scanner is in focus.",
        });
      }
    } catch {
      checks.push({ name: "blur", status: "pass", message: "Sharpness check skipped" });
    }

    // 3. Brightness check
    try {
      const { data: rawData } = await sharp(inputBuffer)
        .greyscale()
        .resize(100, 100, { fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const pixels = new Uint8Array(rawData);
      const avgBrightness = pixels.reduce((a, b) => a + b, 0) / pixels.length;

      if (avgBrightness < 50) {
        checks.push({
          name: "brightness",
          status: "warn",
          message: "Image appears too dark. Adjust lighting for best results.",
        });
      } else if (avgBrightness > 220) {
        checks.push({
          name: "brightness",
          status: "warn",
          message: "Image appears too bright / overexposed. Reduce lighting or scanner exposure.",
        });
      } else {
        checks.push({ name: "brightness", status: "pass", message: "Good exposure" });
      }
    } catch {
      checks.push({ name: "brightness", status: "pass", message: "Brightness check skipped" });
    }

    // 4. Card boundary / aspect ratio check
    const aspectRatio = height > 0 ? width / height : 0;
    // Standard trading card: 2.5 × 3.5 inches = 0.714 ratio (portrait)
    const expectedRatio = 2.5 / 3.5;
    const ratioDiff = Math.abs(aspectRatio - expectedRatio) / expectedRatio;

    if (ratioDiff <= 0.15) {
      checks.push({ name: "card_boundary", status: "pass", message: "Card detected and cropped successfully" });
    } else if (width > 0 && height > 0) {
      checks.push({
        name: "card_boundary",
        status: "warn",
        message: "Card may not be fully visible or may be cropped incorrectly. Check the image.",
      });
    } else {
      checks.push({ name: "card_boundary", status: "fail", message: "Could not determine card boundaries." });
    }
  } catch (err: any) {
    checks.push({ name: "resolution", status: "fail", message: `Could not read image: ${err.message}` });
  }

  const hasFailure = checks.some((c) => c.status === "fail");
  const hasWarning = checks.some((c) => c.status === "warn");
  const overall: QualityResult["overall"] = hasFailure ? "fail" : hasWarning ? "warn" : "pass";

  return { overall, checks };
}
