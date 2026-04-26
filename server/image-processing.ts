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

    // Step 2: flatten RGB under transparent pixels to white (255) for consistency
    const px = new Uint8Array(masked.data);
    let flattenedCount = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) {
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
  pixels: Uint8Array, w: number, h: number, ch: number, certId?: string | number
): BoundaryDetection | null {
  const certTag = certId != null ? ` cert=${certId}` : "";

  // Primary: mat-distance detector (works against any mat colour)
  const mat = computeMatProfile(pixels, w, h, ch);
  const matRgb = { r: mat.matR, g: mat.matG, b: mat.matB };
  console.log(`[card-detect] mat profile: rgb(${mat.matR},${mat.matG},${mat.matB}) distance threshold=${mat.threshold}${certTag}`);
  const matIsBg = (r: number, g: number, b: number) => !isCardPixel(r, g, b, mat);
  const matBased = detectBoundaryWithTest(pixels, w, h, ch, matIsBg);
  if (matBased) {
    console.log(`[card-detect] mat-distance detection: ${matBased.nonBlackPct.toFixed(1)}% card pixels${certTag}`);
    return { ...tightenToPokemonAspect(pixels, w, h, ch, matBased, matIsBg, certTag), matRgb };
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
    return { ...tightenToPokemonAspect(pixels, w, h, ch, adaptive, bg.isBackground, certTag), matRgb: bgRgb };
  }

  // Fallback 2: fixed black threshold
  console.log(`[card-detect] adaptive-luma failed, falling back to fixed black threshold${certTag}`);
  const fixed = detectBoundaryWithTest(pixels, w, h, ch, isBackground);
  if (!fixed) return null;
  return { ...tightenToPokemonAspect(pixels, w, h, ch, fixed, isBackground, certTag), matRgb: { r: 0, g: 0, b: 0 } };
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

function tightenToPokemonAspect(
  pixels: Uint8Array, w: number, h: number, ch: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number },
  isBg: (r: number, g: number, b: number) => boolean,
  certTag: string,
): { minX: number; maxX: number; minY: number; maxY: number; nonBlackPct: number } {
  const startMinX = bounds.minX, startMaxX = bounds.maxX;
  const startMinY = bounds.minY, startMaxY = bounds.maxY;
  const startW = startMaxX - startMinX + 1;
  const startH = startMaxY - startMinY + 1;
  const startRatio = startW / startH;

  // Already in range — nothing to do
  if (startRatio >= POKEMON_ASPECT - ASPECT_TOL && startRatio <= POKEMON_ASPECT + ASPECT_TOL) {
    console.log(`[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} in-range, no trim${certTag}`);
    return bounds;
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
    return bounds;
  }

  const suffix = aborted ? ` [early-exit: ${aborted}]` : "";
  console.log(`[card-detect] aspect-tighten: ratio ${startRatio.toFixed(3)} → ${finalRatio.toFixed(3)} (trimmed ${trimmedW}px width, ${trimmedH}px height)${suffix}${certTag}`);

  return { minX, maxX, minY, maxY, nonBlackPct: finalPct };
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
 * Auto-crop: detect card in scan and crop tight to the actual card edges.
 * Two-pass approach: aggressive trim first, then validate white border %.
 * Falls back to softer trim if aggressive is too tight.
 */
export async function autoCrop(inputBuffer: Buffer): Promise<{ buffer: Buffer; cropped: boolean; matRgb: { r: number; g: number; b: number } }> {
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
          .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 120 })
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

    // Minimal padding (0.5% each side — just enough to avoid clipping card edge)
    const padW = Math.max(1, Math.round(trimInfo.width * 0.005));
    const padH = Math.max(1, Math.round(trimInfo.height * 0.005));

    const padded = await sharp(trimBuf)
      .extend({ top: padH, bottom: padH, left: padW, right: padW, background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();

    const ratio = trimInfo.width / trimInfo.height;
    const expectedRatio = 0.714; // 2.5/3.5 = standard card
    const ratioDiff = Math.abs(ratio - expectedRatio) / expectedRatio;
    const ringNote = borderRingWhitePct > 90 ? " (likely card margin)" : retrimApplied ? " (post re-trim)" : "";
    console.log(`[crop] ${trimInfo.width}x${trimInfo.height} ratio=${ratio.toFixed(3)} ${ratioDiff < 0.1 ? "✓" : "⚠ off-ratio"} border_ring_white=${borderRingWhitePct.toFixed(1)}%${ringNote}`);

    return { buffer: padded, cropped: true, matRgb };
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
  const out = await pipeline.jpeg({ quality: 95 }).toBuffer();

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
