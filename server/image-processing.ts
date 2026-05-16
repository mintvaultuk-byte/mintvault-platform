/**
 * MintVault Image Processing
 * Auto-crop, image variant generation, and quality checks for grading images.
 */
import sharp from "sharp";

// Trading card corner radius as percentage of width (~3mm on 63mm card = 4.7%)
const CARD_CORNER_RADIUS_PCT = 0.04;

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
    const r = Math.round(w * CARD_CORNER_RADIUS_PCT);

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
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
        flattenedCount++;
      }
    }

    // Step 3: re-encode as PNG
    const out = await sharp(px, { raw: { width: masked.info.width, height: masked.info.height, channels: 4 } })
      .png({ quality: 90 })
      .toBuffer();

    console.log(`[mask] rounded corners: r=${r}px on ${w}×${h} (flattened ${flattenedCount} transparent-corner pixels to white)`);
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
  pixels: Uint8Array, w: number, h: number, ch: number,
  startX: number, startY: number, size: number
): { r: number; g: number; b: number; luma: number } {
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  const endX = Math.min(startX + size, w);
  const endY = Math.min(startY + size, h);
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * ch;
      sumR += pixels[idx]; sumG += pixels[idx + 1]; sumB += pixels[idx + 2];
      count++;
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0, luma: 0 };
  const avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;
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
    sampleCorner(pixels, w, h, ch, 0, 0, sz),           // top-left
    sampleCorner(pixels, w, h, ch, w - sz, 0, sz),      // top-right
    sampleCorner(pixels, w, h, ch, 0, h - sz, sz),      // bottom-left
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
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];

  const pushAt = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    rs.push(pixels[i]); gs.push(pixels[i + 1]); bs.push(pixels[i + 2]);
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
  const dr = r - mat.matR, dg = g - mat.matG, db = b - mat.matB;
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
  pixels: Uint8Array, w: number, h: number, ch: number, certId?: string | number,
  options?: { safetyPadPx?: number },
): BoundaryDetection | null {
  const certTag = certId != null ? ` cert=${certId}` : "";
  const safetyPadPx = options?.safetyPadPx ?? CARD_DETECT_SAFETY_PAD_PX;

  // Primary: mat-distance detector (works against any mat colour)
  const mat = computeMatProfile(pixels, w, h, ch);
  const matRgb = { r: mat.matR, g: mat.matG, b: mat.matB };
  console.log(`[card-detect] mat profile: rgb(${mat.matR},${mat.matG},${mat.matB}) distance threshold=${mat.threshold} pad=${safetyPadPx}${certTag}`);
  const matIsBg = (r: number, g: number, b: number) => !isCardPixel(r, g, b, mat);
  const matBased = detectBoundaryWithTest(pixels, w, h, ch, matIsBg);
  if (matBased) {
    console.log(`[card-detect] mat-distance detection: ${matBased.nonBlackPct.toFixed(1)}% card pixels${certTag}`);
    return { ...tightenToPokemonAspect(pixels, w, h, ch, matBased, matIsBg, certTag, safetyPadPx), matRgb };
  }

  // Fallback 1: adaptive-luma (Fix 0 — mat-aware branching, uses isBackground closure)
  const bg = computeBackgroundProfile(pixels, w, h, ch);
  const bgRgb = { r: Math.round(bg.avgR), g: Math.round(bg.avgG), b: Math.round(bg.avgB) };
  console.log(`[card-detect] adaptive-luma: mat_luma=${bg.avgLuma.toFixed(1)} threshold=${bg.threshold.toFixed(1)} (${bg.mode} mode)${certTag}`);
  if (bg.mode === "ambiguous") {
    console.warn(`[card-detect] ambiguous mat luma (60–180) — defaulting to bright-mat formula${certTag}`);
  }
  const adaptive = detectBoundaryWithTest(pixels, w, h, ch, bg.isBackground);
  if (adaptive) {
    console.log(`[card-detect] adaptive-luma detection: ${adaptive.nonBlackPct.toFixed(1)}% non-bg${certTag}`);
    return { ...tightenToPokemonAspect(pixels, w, h, ch, adaptive, bg.isBackground, certTag, safetyPadPx), matRgb: bgRgb };
  }

  // Fallback 2: fixed black threshold
  console.log(`[card-detect] adaptive-luma failed, falling back to fixed black threshold${certTag}`);
  const fixed = detectBoundaryWithTest(pixels, w, h, ch, isBackground);
  if (!fixed) return null;
  return { ...tightenToPokemonAspect(pixels, w, h, ch, fixed, isBackground, certTag, safetyPadPx), matRgb: { r: 0, g: 0, b: 0 } };
}

/** Core boundary detection with a pluggable background test */
function detectBoundaryWithTest(
  pixels: Uint8Array, w: number, h: number, ch: number,
  isBg: (r: number, g: number, b: number) => boolean
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } | null {
  let minX = w, maxX = 0, minY = h, maxY = 0;
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
const CARD_DETECT_SAFETY_PAD_PX = 8;

// Expand bounds outward by padPx, clamped to the image frame so we never
// index past the bitmap. Applied at every return path of
// tightenToPokemonAspect so it kicks in regardless of which branch ran
// (in-range, successful trim, pixel-loss bail, zero-trim bail).
// padPx defaults to CARD_DETECT_SAFETY_PAD_PX so existing callers keep
// the v590 8 px behaviour; the display-pipeline tightenForDisplay overrides
// to 0 because it needs bounds flush with the actual card edge.
function applySafetyPad(
  b: { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number },
  w: number, h: number,
  padPx: number = CARD_DETECT_SAFETY_PAD_PX,
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } {
  return {
    minX: Math.max(0,     b.minX - padPx),
    maxX: Math.min(w - 1, b.maxX + padPx),
    minY: Math.max(0,     b.minY - padPx),
    maxY: Math.min(h - 1, b.maxY + padPx),
    nonBlackPct: b.nonBlackPct,
  };
}

function tightenToPokemonAspect(
  pixels: Uint8Array, w: number, h: number, ch: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number },
  isBg: (r: number, g: number, b: number) => boolean,
  certTag: string,
  safetyPadPx: number = CARD_DETECT_SAFETY_PAD_PX,
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } {
  const startMinX = bounds.minX, startMaxX = bounds.maxX;
  const startMinY = bounds.minY, startMaxY = bounds.maxY;
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
    const A = (x0 > 0 && y0 > 0) ? integ[(y0 - 1) * w + (x0 - 1)] : 0;
    const B = (y0 > 0) ? integ[(y0 - 1) * w + x1] : 0;
    const C = (x0 > 0) ? integ[y1 * w + (x0 - 1)] : 0;
    const D = integ[y1 * w + x1];
    return D - B - C + A;
  };

  const originalFg = fgCountInRect(startMinX, startMaxX, startMinY, startMaxY);
  const maxLoss = Math.max(1, Math.floor(originalFg * MAX_ASPECT_TRIM_LOSS_PCT / 100));

  let minX = startMinX, maxX = startMaxX, minY = startMinY, maxY = startMaxY;
  let aborted: "pixel-loss" | "collapse" | null = null;

  // Symmetric 1-px shrink per side per iteration, max bw+bh steps
  const maxSteps = startW + startH;
  for (let step = 0; step < maxSteps; step++) {
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const ratio = bw / bh;
    if (ratio >= POKEMON_ASPECT - ASPECT_TOL && ratio <= POKEMON_ASPECT + ASPECT_TOL) break;

    let nMinX = minX, nMaxX = maxX, nMinY = minY, nMaxY = maxY;
    if (ratio > POKEMON_ASPECT + ASPECT_TOL) {
      nMinX = minX + 1; nMaxX = maxX - 1;
    } else {
      nMinY = minY + 1; nMaxY = maxY - 1;
    }
    if (nMaxX <= nMinX || nMaxY <= nMinY) { aborted = "collapse"; break; }

    const fgAfter = fgCountInRect(nMinX, nMaxX, nMinY, nMaxY);
    if (originalFg - fgAfter > maxLoss) { aborted = "pixel-loss"; break; }

    minX = nMinX; maxX = nMaxX; minY = nMinY; maxY = nMaxY;
  }

  const finalW = maxX - minX + 1;
  const finalH = maxY - minY + 1;
  const finalRatio = finalW / finalH;
  const trimmedW = startW - finalW;
  const trimmedH = startH - finalH;
  const finalFg = fgCountInRect(minX, maxX, minY, maxY);
  const finalPct = (finalFg / (finalW * finalH)) * 100;

  if (trimmedW === 0 && trimmedH === 0) {
    console.log(`[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} could not shrink (${aborted || "bounds"})${certTag}`);
    return applySafetyPad(bounds, w, h, safetyPadPx);
  }

  // Discard partial trim on pixel-loss bail. Previous behaviour kept whatever
  // had been trimmed up to the safeguard, which clipped real card edges on
  // tilted scans (MV133/Oddish — 54-66 px lost before the bail fired). With
  // the tightened threshold above the partial trim is small (~2-3 px) but
  // the safeguard firing is itself a signal that the ratio is too far off,
  // so the safest move is to return the original bounds untouched.
  if (aborted === "pixel-loss") {
    console.log(`[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} pixel-loss safeguard fired — discarding partial trim (${trimmedW}×${trimmedH}px), returning original bounds${certTag}`);
    return applySafetyPad(bounds, w, h, safetyPadPx);
  }

  const suffix = aborted ? ` [early-exit: ${aborted}]` : "";
  console.log(`[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} → ${finalRatio.toFixed(3)} (trimmed ${trimmedW}px width, ${trimmedH}px height)${suffix}${certTag}`);

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
      let rowLeft = -1, rowRight = -1, fgInRow = 0;
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
      console.log(`[deskew] not enough card-edge points (${topEdgePoints.length}) against mat rgb(${mat.matR},${mat.matG},${mat.matB}), skipping`);
      return { buffer: inputBuffer, angle: 0 };
    }

    // Linear regression on edge points
    const n = topEdgePoints.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of topEdgePoints) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; }
    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 0.001) return { buffer: inputBuffer, angle: 0 };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const radians = Math.atan(slope);
    const angle = radians * (180 / Math.PI);

    console.log(`[deskew] non-black edge: points=${n} raw_rad=${radians.toFixed(6)} degrees=${angle.toFixed(4)}`);

    if (Math.abs(angle) > 5) {
      console.log(`[deskew] angle ${angle.toFixed(2)}° exceeds ±5°, skipping`);
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

    console.log(`[deskew] corrected ${angle.toFixed(2)}° (${n} edge points, mat-fill rgb(${mat.matR},${mat.matG},${mat.matB}))`);
    return { buffer: rotated, angle };
  } catch (err: any) {
    console.warn("[deskew] detection failed, skipping:", err.message);
    return { buffer: inputBuffer, angle: 0 };
  }
}

/**
 * Crop to card boundary by detecting non-black pixels.
 * Works on ANY card colour as long as scanner uses a black background mat.
 * Returns null if detection fails (caller should fall back to autoCrop).
 */
export async function cropToCardBoundary(inputBuffer: Buffer, certId?: string | number): Promise<{ buffer: Buffer; cropped: boolean; matRgb: { r: number; g: number; b: number } } | null> {
  try {
    console.log(`[card-detect] START non-black detection (${(inputBuffer.length / 1024).toFixed(0)}KB input)${certId != null ? ` cert=${certId}` : ""}`);
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
    const boundary = detectCardBoundary(pixels, info.width, info.height, info.channels, certId);

    if (!boundary) {
      console.log("[card-detect] boundary detection failed (not enough non-black or too much)");
      return null;
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
    console.log(`[card-detect] ${meta.width}x${meta.height} → ${cropW}x${cropH} (non-black ${boundary.nonBlackPct.toFixed(1)}%, ratio=${ratio.toFixed(3)})`);
    return { buffer: cropped, cropped: true, matRgb: boundary.matRgb };
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
const CARD_EDGE_COVERAGE_THRESHOLD = 0.90;

function detectCardEdgesByCoverage(
  pixels: Uint8Array, w: number, h: number, ch: number,
  certId?: string | number,
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
    ` distance threshold=${mat.threshold} (overridden for second-pass)${certTag}`,
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
  for (let y = 0; y < h; y++) if (rowOk(y)) { minY = y; break; }
  let maxY = -1;
  for (let y = h - 1; y >= 0; y--) if (rowOk(y)) { maxY = y; break; }
  let minX = -1;
  for (let x = 0; x < w; x++) if (colOk(x)) { minX = x; break; }
  let maxX = -1;
  for (let x = w - 1; x >= 0; x--) if (colOk(x)) { maxX = x; break; }

  if (minX < 0 || maxX < 0 || minY < 0 || maxY < 0 || maxX <= minX || maxY <= minY) {
    console.warn(`[edge-coverage] no edge met ${(CARD_EDGE_COVERAGE_THRESHOLD * 100).toFixed(0)}% threshold: L=${minX} R=${maxX} T=${minY} B=${maxY}${certTag}`);
    return null;
  }

  console.log(
    `[edge-coverage] bounds L:${minX} R:${w - 1 - maxX} T:${minY} B:${h - 1 - maxY}` +
    ` (cover threshold ${(CARD_EDGE_COVERAGE_THRESHOLD * 100).toFixed(0)}%)${certTag}`,
  );
  return { minX, maxX, minY, maxY };
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
export async function tightenForDisplay(
  inputBuffer: Buffer,
  certId?: string | number,
  fallbackInsetPx: number = 16,
): Promise<Buffer> {
  const certTag = certId != null ? ` cert=${certId}` : "";
  let metaW = 0, metaH = 0;
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return inputBuffer;
    metaW = meta.width; metaH = meta.height;

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
    const boundary = detectCardEdgesByCoverage(
      pixels, info.width, info.height, info.channels, certId,
    );
    if (!boundary) {
      console.warn(`[tightenForDisplay] coverage detect failed${certTag} — falling back to ${fallbackInsetPx}px inset`);
      return await applyInsetFallback(inputBuffer, metaW, metaH, fallbackInsetPx);
    }

    // Map bounds back to full-res, clamp defensively
    let origMinX = Math.round(boundary.minX / scale);
    let origMinY = Math.round(boundary.minY / scale);
    let origMaxX = Math.round(boundary.maxX / scale);
    let origMaxY = Math.round(boundary.maxY / scale);
    const clamped =
      origMinX < 0 || origMinY < 0 || origMaxX > metaW - 1 || origMaxY > metaH - 1;
    origMinX = Math.max(0, origMinX);
    origMinY = Math.max(0, origMinY);
    origMaxX = Math.min(metaW - 1, origMaxX);
    origMaxY = Math.min(metaH - 1, origMaxY);
    if (clamped) {
      console.warn(`[tightenForDisplay] mapped bounds extended past bitmap, clamped${certTag}`);
    }

    const cropW = origMaxX - origMinX + 1;
    const cropH = origMaxY - origMinY + 1;

    // Sanity: detected crop must be ≥50% of input on both axes
    if (cropW < metaW * 0.5 || cropH < metaH * 0.5) {
      console.warn(
        `[tightenForDisplay] detected crop ${cropW}x${cropH} < 50% of input ${metaW}x${metaH}${certTag}` +
        ` — falling back to ${fallbackInsetPx}px inset`,
      );
      return await applyInsetFallback(inputBuffer, metaW, metaH, fallbackInsetPx);
    }

    console.log(
      `[tightenForDisplay] ${metaW}x${metaH} → ${cropW}x${cropH}` +
      ` (trimmed L:${origMinX} R:${metaW - 1 - origMaxX} T:${origMinY} B:${metaH - 1 - origMaxY})${certTag}`,
    );

    return await sharp(inputBuffer)
      .extract({ left: origMinX, top: origMinY, width: cropW, height: cropH })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err: any) {
    console.warn(`[tightenForDisplay] threw${certTag}: ${err.message} — falling back to ${fallbackInsetPx}px inset`);
    try {
      return await applyInsetFallback(inputBuffer, metaW, metaH, fallbackInsetPx);
    } catch {
      return inputBuffer;
    }
  }
}

async function applyInsetFallback(
  inputBuffer: Buffer, w: number, h: number, insetPx: number,
): Promise<Buffer> {
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
export async function autoCrop(inputBuffer: Buffer): Promise<{ buffer: Buffer; cropped: boolean; matRgb: { r: number; g: number; b: number } }> {
  // Background mode is detected per-scan: white mat (lid-down) vs black
  // background (lid-up). matRgb is sampled from the work buffer's outer 2%
  // strip and threaded through trim, retrim, and the return so downstream
  // padWithMat / reCentreBitmap pad with the same colour the scan came in on.
  let matRgb: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 };
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

    // Sample mat colour from the work buffer's outer 2% strip. Same
    // computeMatProfile() that cropToCardBoundary uses — adapts to white-
    // mat AND black-background scans automatically.
    try {
      const w0 = meta.width || 1, h0 = meta.height || 1;
      const sampleScale = Math.min(1, 1500 / Math.max(w0, h0));
      const sw = Math.max(50, Math.round(w0 * sampleScale));
      const sh = Math.max(50, Math.round(h0 * sampleScale));
      const { data, info } = await sharp(workBuffer)
        .resize(sw, sh, { fit: "fill" })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const profile = computeMatProfile(new Uint8Array(data), info.width, info.height, info.channels);
      matRgb = { r: profile.matR, g: profile.matG, b: profile.matB };
      console.log(`[crop] autoCrop sampled mat rgb(${matRgb.r},${matRgb.g},${matRgb.b})`);
    } catch (e: any) {
      console.warn(`[crop] autoCrop mat sample failed (${e.message}) — defaulting to white`);
    }

    // Pass 1: trim against the sampled mat colour (threshold 80).
    let trimBuf: Buffer;
    let trimInfo: sharp.OutputInfo;
    try {
      const result = await sharp(workBuffer)
        .trim({ background: matRgb, threshold: 80 })
        .toBuffer({ resolveWithObject: true });
      trimBuf = result.data;
      trimInfo = result.info;
    } catch {
      // Aggressive trim failed — try softer
      const result = await sharp(workBuffer)
        .trim({ background: matRgb, threshold: 30 })
        .toBuffer({ resolveWithObject: true });
      trimBuf = result.data;
      trimInfo = result.info;
    }

    // Validate: trimmed result must be reasonable
    const origArea = (meta.width || 1) * (meta.height || 1);
    const trimArea = trimInfo.width * trimInfo.height;
    if (trimArea / origArea < 0.15 || trimInfo.width < 100 || trimInfo.height < 100) {
      console.warn(`[crop] trim too aggressive: ${trimInfo.width}x${trimInfo.height} (${((trimArea / origArea) * 100).toFixed(1)}% of original)`);
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
          .trim({ background: matRgb, threshold: 120 })
          .toBuffer({ resolveWithObject: true });
        const shrunk = tighter.info.width < trimInfo.width || tighter.info.height < trimInfo.height;
        if (tighter.info.width > 100 && tighter.info.height > 100 && shrunk) {
          trimBuf = tighter.data;
          trimInfo = tighter.info;
          borderRingWhitePct = await measureBorderRingWhiteness(trimBuf, trimInfo.width, trimInfo.height);
          retrimApplied = true;
          console.log(`[crop] re-trim reduced border ring: ${firstPassRingWhite.toFixed(1)}% → ${borderRingWhitePct.toFixed(1)}%`);
        } else {
          console.log(`[crop] re-trim no-op (tighter threshold found no additional mat to remove — remaining white is card margin, not mat)`);
        }
      } catch {
        console.log(`[crop] re-trim failed, keeping first-pass result`);
      }
    }

    // No internal padding — the downstream padWithMat step in
    // generateImageVariants/upload-images applies the canonical mat
    // padding (CARD_MAT_PADDING_PCT). Re-encode at JPEG q85 to keep the
    // size sensible without doubling-up padding here.
    const reencoded = await sharp(trimBuf)
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();

    const ratio = trimInfo.width / trimInfo.height;
    const expectedRatio = 0.714; // 2.5/3.5 = standard card
    const ratioDiff = Math.abs(ratio - expectedRatio) / expectedRatio;
    const ringNote = borderRingWhitePct > 90 ? " (likely card margin)" : retrimApplied ? " (post re-trim)" : "";
    console.log(`[crop] ${trimInfo.width}x${trimInfo.height} ratio=${ratio.toFixed(3)} ${ratioDiff < 0.1 ? "✓" : "⚠ off-ratio"} border_ring_white=${borderRingWhitePct.toFixed(1)}%${ringNote}`);

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
    let white = 0, total = 0;
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
  } catch { return 0; }
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
const EDGE_DETECT_COLOUR_DELTA = 45;       // matches isCardPixel threshold
const EDGE_DETECT_ROW_COVERAGE = 0.70;     // 70% non-mat = card row
const RE_CENTRE_SHIFT_EPSILON = 4;         // margin diff below this → no shift
const DEFAULT_MAT_RGB = { r: 255, g: 255, b: 255 }; // standard mat is white

export async function reCentreBitmap(
  inputBuffer: Buffer,
  options?: { matRgb?: { r: number; g: number; b: number }; certId?: string | number },
): Promise<{
  buffer: Buffer;
  pre_padding_px: { top: number; bottom: number; left: number; right: number };
  post_asymmetry_px: { horizontal: number; vertical: number };
  extended: boolean;
}> {
  const certTag = options?.certId != null ? ` cert=${options.certId}` : "";
  const meta = await sharp(inputBuffer).metadata();
  if (!meta.width || !meta.height) {
    return { buffer: inputBuffer, pre_padding_px: { top: 0, bottom: 0, left: 0, right: 0 }, post_asymmetry_px: { horizontal: 0, vertical: 0 }, extended: false };
  }

  const { data, info } = await sharp(inputBuffer).raw().toBuffer({ resolveWithObject: true });
  const px = new Uint8Array(data);
  const w = info.width, h = info.height, ch = info.channels;

  // Mat colour: prefer caller-supplied; else sample only the four corner blocks
  // of the input. The outer-perimeter strip on a tightly-cropped card is mostly
  // the card's outer border (often saturated yellow on Pokémon cards), which
  // skews the median and causes extend padding to be filled with card-border
  // colour instead of mat — visible as a "wraparound" strip below the card.
  // The four corners are mat-on-mat even after card-detect tightening because
  // a Pokémon card's rounded corners cut to mat at the bitmap corners.
  let matR: number, matG: number, matB: number;
  if (options?.matRgb) {
    matR = options.matRgb.r; matG = options.matRgb.g; matB = options.matRgb.b;
  } else {
    const block = Math.min(30, Math.floor(Math.min(w, h) / 4));
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const pushAt = (x: number, y: number) => {
      const i = (y * w + x) * ch;
      if (ch === 4 && px[i + 3] < 128) return;
      rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
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
    const median = (arr: number[]) => { arr.sort((a, b) => a - b); return arr.length ? arr[Math.floor(arr.length / 2)] : 0; };
    if (rs.length > 0) {
      matR = median(rs); matG = median(gs); matB = median(bs);
    } else {
      matR = DEFAULT_MAT_RGB.r; matG = DEFAULT_MAT_RGB.g; matB = DEFAULT_MAT_RGB.b;
    }
  }

  const isNonMat = (r: number, g: number, b: number): boolean => {
    const dr = r - matR, dg = g - matG, db = b - matB;
    return Math.sqrt(dr * dr + dg * dg + db * db) > EDGE_DETECT_COLOUR_DELTA;
  };

  // Row coverage: fraction of opaque pixels in row y that are non-mat.
  const rowCoverage = (y: number): number => {
    let nonMat = 0, opaque = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      if (ch === 4 && px[i + 3] < 128) continue;
      opaque++;
      if (isNonMat(px[i], px[i + 1], px[i + 2])) nonMat++;
    }
    return opaque > 0 ? nonMat / opaque : 0;
  };
  const colCoverage = (x: number): number => {
    let nonMat = 0, opaque = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * ch;
      if (ch === 4 && px[i + 3] < 128) continue;
      opaque++;
      if (isNonMat(px[i], px[i + 1], px[i + 2])) nonMat++;
    }
    return opaque > 0 ? nonMat / opaque : 0;
  };

  let top = 0, bottom = 0, left = 0, right = 0;
  for (let y = 0; y < h; y++) { if (rowCoverage(y) > EDGE_DETECT_ROW_COVERAGE) { top = y; break; } }
  for (let y = h - 1; y >= 0; y--) { if (rowCoverage(y) > EDGE_DETECT_ROW_COVERAGE) { bottom = h - 1 - y; break; } }
  for (let x = 0; x < w; x++) { if (colCoverage(x) > EDGE_DETECT_ROW_COVERAGE) { left = x; break; } }
  for (let x = w - 1; x >= 0; x--) { if (colCoverage(x) > EDGE_DETECT_ROW_COVERAGE) { right = w - 1 - x; break; } }

  const prePadding = { top, bottom, left, right };
  const hDiff = Math.abs(left - right);
  const vDiff = Math.abs(top - bottom);

  if (hDiff <= RE_CENTRE_SHIFT_EPSILON && vDiff <= RE_CENTRE_SHIFT_EPSILON) {
    console.log(`[re-centre] margins L:${left} R:${right} T:${top} B:${bottom} — within ±${RE_CENTRE_SHIFT_EPSILON}px, no shift${certTag}`);
    return { buffer: inputBuffer, pre_padding_px: prePadding, post_asymmetry_px: { horizontal: 0, vertical: 0 }, extended: false };
  }

  // Compute shifts. dx > 0 moves card to the right (trim right margin, pad left).
  const dx = hDiff > RE_CENTRE_SHIFT_EPSILON ? Math.round((right - left) / 2) : 0;
  const dy = vDiff > RE_CENTRE_SHIFT_EPSILON ? Math.round((bottom - top) / 2) : 0;

  // Materialise the shift: extract the inner region offset by the shift, then
  // pad the tight side with mat colour so the bitmap keeps its original size.
  let extractLeft = 0, extractTop = 0, extractW = w, extractH = h;
  let padLeft = 0, padRight = 0, padTop = 0, padBottom = 0;
  if (dx > 0) { // shift card right: trim right, pad left
    extractLeft = 0; extractW = w - dx; padLeft = dx;
  } else if (dx < 0) { // shift card left: trim left, pad right
    extractLeft = -dx; extractW = w + dx; padRight = -dx;
  }
  if (dy > 0) { // shift card down: trim bottom, pad top
    extractTop = 0; extractH = h - dy; padTop = dy;
  } else if (dy < 0) { // shift card up: trim top, pad bottom
    extractTop = -dy; extractH = h + dy; padBottom = -dy;
  }

  let pipeline = sharp(inputBuffer);
  if (extractLeft > 0 || extractTop > 0 || extractW !== w || extractH !== h) {
    pipeline = pipeline.extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH });
  }
  if (padLeft || padRight || padTop || padBottom) {
    pipeline = pipeline.extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: { r: matR, g: matG, b: matB, alpha: 1 } });
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
export async function padWithMat(
  inputBuffer: Buffer,
  matRgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  const meta = await sharp(inputBuffer).metadata();
  if (!meta.width || !meta.height) return inputBuffer;
  const padPx = Math.max(0, Math.round(Math.min(meta.width, meta.height) * CARD_MAT_PADDING_PCT));
  if (padPx === 0) return inputBuffer;
  const isPng = meta.format === "png";
  const pipeline = sharp(inputBuffer)
    .extend({ top: padPx, bottom: padPx, left: padPx, right: padPx, background: { r: matRgb.r, g: matRgb.g, b: matRgb.b, alpha: isPng ? 1 : 1 } });
  const out = isPng
    ? await pipeline.png().toBuffer()
    : await pipeline.jpeg({ quality: 90, progressive: true, mozjpeg: true }).toBuffer();
  return out;
}

/**
 * Convert the (dark) scanner-background pixels to pure white. Only runs
 * when the sampled mat colour is dark (luma < 128) — for white-mat scans
 * it's a no-op.
 *
 * Algorithm: per-side edge-walk with depth-banded saturation thresholds.
 * Validated in the contour-detector prototype against 8 prod certs
 * (MV148/149/150/158/159/160/161/162) including MV162 (worst-case vinyl
 * bleed) and MV159 back (thin saturated outer ring + interior grey band).
 * Replaces the previous flood-fill which ate into dark card corners.
 *
 * For each of the 4 sides of the cropped image, walk inward 1 px at a
 * time per column (top/bottom) or per row (left/right). At each depth:
 *   - depth 0–7  (outer ring): paint if sat<8, STOP only if sat ≥ 60
 *     (lets the walk skip past the slightly-saturated outer slab/vinyl
 *      ring on some scans without false-stopping)
 *   - depth 8–29 (inner band): paint if sat<8, STOP if sat ≥ 8
 *     (once past the outer ring, any colour = real card content)
 *   - hard cap at 30 px
 *
 * Saturation = max(R,G,B) - min(R,G,B). Vinyl/mat/slab edge are grey
 * (low saturation). Card borders (yellow front, blue back, etc.) are
 * coloured (high saturation). The metric separates them cleanly without
 * needing per-card colour assumptions.
 *
 * Interior dark card content (holos, black text inside the artwork) is
 * untouched because the walk stops at the card border and never enters
 * the interior.
 */
const BG_MAX_DEPTH      = 80;
const BG_OUTER_RING     = 8;
const BG_OUTER_STOP_SAT = 60;
const BG_INNER_STOP_SAT = 8;
const BG_PAINT_THRESH   = 8;

export async function convertBackgroundToWhite(
  inputBuffer: Buffer,
  matRgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  const matLuma = 0.299 * matRgb.r + 0.587 * matRgb.g + 0.114 * matRgb.b;
  const isBlack = matLuma < 128;
  console.log(`[convertBg] entry matRgb=rgb(${matRgb.r},${matRgb.g},${matRgb.b}) matLuma=${matLuma.toFixed(1)} isBlack=${isBlack} bufSize=${inputBuffer.length}`);
  if (!isBlack) {
    console.log(`[convertBg] no-op (white-mat scan)`);
    return inputBuffer;
  }

  const meta = await sharp(inputBuffer).metadata();
  if (!meta.width || !meta.height) {
    console.log(`[convertBg] no-op (zero-dim metadata)`);
    return inputBuffer;
  }

  const { data, info } = await sharp(inputBuffer)
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.from(data);
  const w = info.width, h = info.height, ch = info.channels;

  const saturation = (off: number): number => {
    const r = px[off], g = px[off + 1], b = px[off + 2];
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  const paintWhite = (off: number) => { px[off] = 255; px[off + 1] = 255; px[off + 2] = 255; };
  const stopThreshAtDepth = (d: number) => d < BG_OUTER_RING ? BG_OUTER_STOP_SAT : BG_INNER_STOP_SAT;

  let pT = 0, pB = 0, pL = 0, pR = 0;
  // Telemetry: how many walks crossed BG_MAX_DEPTH (asymmetric centring;
  // expected on cards that sit off-centre in the bitmap) vs how many ran
  // all the way to the opposite edge without hitting a sat-stop (would
  // mean the saturation walk never found the card border — should be ~0
  // for real cards, indicates a pipeline issue if it spikes).
  let deepT = 0, deepB = 0, deepL = 0, deepR = 0;
  let runawayT = 0, runawayB = 0, runawayL = 0, runawayR = 0;

  // Black-bg scans uncap the walk depth — earlier BG_MAX_DEPTH=80 left a
  // thin dark strip on the bottom edge of cards that sit high in the
  // bitmap (asymmetric centring → bottom padding > 80 px). The depth-banded
  // saturation thresholds (BG_OUTER_STOP_SAT=60 for outer 8 px, then
  // BG_INNER_STOP_SAT=8) are the real stop condition; BG_MAX_DEPTH is kept
  // only as a telemetry waypoint. White-mat scans never reach this loop
  // (no-op short-circuit above), so removing the cap is safe.

  // Top — per column, walk down
  for (let x = 0; x < w; x++) {
    let stopped = false;
    for (let d = 0; d < h; d++) {
      const off = (d * w + x) * ch;
      const s = saturation(off);
      if (s >= stopThreshAtDepth(d)) { stopped = true; break; }
      if (s < BG_PAINT_THRESH) { paintWhite(off); pT++; }
      if (d === BG_MAX_DEPTH) deepT++;
    }
    if (!stopped) runawayT++;
  }
  // Bottom — per column, walk up
  for (let x = 0; x < w; x++) {
    let stopped = false;
    for (let d = 0; d < h; d++) {
      const y = h - 1 - d;
      const off = (y * w + x) * ch;
      const s = saturation(off);
      if (s >= stopThreshAtDepth(d)) { stopped = true; break; }
      if (s < BG_PAINT_THRESH) { paintWhite(off); pB++; }
      if (d === BG_MAX_DEPTH) deepB++;
    }
    if (!stopped) runawayB++;
  }
  // Left — per row, walk right
  for (let y = 0; y < h; y++) {
    let stopped = false;
    for (let d = 0; d < w; d++) {
      const off = (y * w + d) * ch;
      const s = saturation(off);
      if (s >= stopThreshAtDepth(d)) { stopped = true; break; }
      if (s < BG_PAINT_THRESH) { paintWhite(off); pL++; }
      if (d === BG_MAX_DEPTH) deepL++;
    }
    if (!stopped) runawayL++;
  }
  // Right — per row, walk left
  for (let y = 0; y < h; y++) {
    let stopped = false;
    for (let d = 0; d < w; d++) {
      const x = w - 1 - d;
      const off = (y * w + x) * ch;
      const s = saturation(off);
      if (s >= stopThreshAtDepth(d)) { stopped = true; break; }
      if (s < BG_PAINT_THRESH) { paintWhite(off); pR++; }
      if (d === BG_MAX_DEPTH) deepR++;
    }
    if (!stopped) runawayR++;
  }

  const isPng = meta.format === "png";
  const pipeline = sharp(px, { raw: { width: w, height: h, channels: ch } });
  const out = isPng
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
    : await pipeline.jpeg({ quality: 90, progressive: true, mozjpeg: true }).toBuffer();

  console.log(`[convertBg] DONE painted T${pT}/B${pB}/L${pL}/R${pR} total=${pT+pB+pL+pR} (depth uncapped, sat-stop only) outBufSize=${out.length}`);
  const deepTotal = deepT + deepB + deepL + deepR;
  if (deepTotal > 0) console.log(`[convertBg] walks past BG_MAX_DEPTH=${BG_MAX_DEPTH}: T${deepT}/B${deepB}/L${deepL}/R${deepR} (asymmetric centring — expected)`);
  const runawayTotal = runawayT + runawayB + runawayL + runawayR;
  if (runawayTotal > 0) console.warn(`[convertBg] WARN ${runawayTotal} walks ran to opposite edge without hitting sat-stop: T${runawayT}/B${runawayB}/L${runawayL}/R${runawayR} — sat walk never found card border`);
  return out;
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
  const greyscale = await sharp(resized)
    .greyscale()
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

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

  const inverted = await sharp(resized)
    .negate()
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

  return { greyscale, highcontrast, edgeenhanced, inverted };
}

/**
 * Run quality checks on an image buffer.
 */
export async function checkImageQuality(inputBuffer: Buffer): Promise<QualityResult> {
  const checks: QualityCheck[] = [];

  try {
    const meta = await sharp(inputBuffer).metadata();
    const width  = meta.width  || 0;
    const height = meta.height || 0;
    const longest = Math.max(width, height);

    // 1. Resolution check
    if (longest >= 2000) {
      checks.push({ name: "resolution", status: "pass", message: `${width} × ${height}px — excellent resolution` });
    } else if (longest >= 1000) {
      checks.push({ name: "resolution", status: "warn", message: `${width} × ${height}px — low resolution. Scan at 1200 DPI or higher for best results.` });
    } else {
      checks.push({ name: "resolution", status: "fail", message: `${width} × ${height}px — resolution too low for accurate grading. Please rescan at higher resolution.` });
    }

    // 2. Blur detection (Laplacian variance)
    try {
      const edgeBuf = await sharp(inputBuffer)
        .greyscale()
        .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const pixels = new Uint8Array(edgeBuf.data);
      let sum = 0, sum2 = 0;
      const n = pixels.length;
      for (let i = 0; i < n; i++) { sum += pixels[i]; sum2 += pixels[i] * pixels[i]; }
      const mean = sum / n;
      const variance = (sum2 / n) - (mean * mean);
      const stddev = Math.sqrt(Math.max(0, variance));

      if (stddev > 8) {
        checks.push({ name: "blur", status: "pass", message: "Image is sharp" });
      } else {
        checks.push({ name: "blur", status: "warn", message: "Image may be slightly blurry. Ensure camera/scanner is in focus." });
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
        checks.push({ name: "brightness", status: "warn", message: "Image appears too dark. Adjust lighting for best results." });
      } else if (avgBrightness > 220) {
        checks.push({ name: "brightness", status: "warn", message: "Image appears too bright / overexposed. Reduce lighting or scanner exposure." });
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
      checks.push({ name: "card_boundary", status: "warn", message: "Card may not be fully visible or may be cropped incorrectly. Check the image." });
    } else {
      checks.push({ name: "card_boundary", status: "fail", message: "Could not determine card boundaries." });
    }

  } catch (err: any) {
    checks.push({ name: "resolution", status: "fail", message: `Could not read image: ${err.message}` });
  }

  const hasFailure = checks.some(c => c.status === "fail");
  const hasWarning = checks.some(c => c.status === "warn");
  const overall: QualityResult["overall"] = hasFailure ? "fail" : hasWarning ? "warn" : "pass";

  return { overall, checks };
}
