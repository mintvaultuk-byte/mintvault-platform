/**
 * MintVault Image Processing
 * Auto-crop, image variant generation, and quality checks for grading images.
 */
import sharp from "sharp";

// Trading card corner radius as percentage of width (~3mm on 63mm card = 4.7%)
const CARD_CORNER_RADIUS_PCT = 0.04;

/**
 * Apply rounded-rectangle mask matching card corner radius.
 * Output is PNG with transparent corners.
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

    const masked = await sharp(inputBuffer)
      .ensureAlpha()
      .composite([{ input: svgMask, blend: "dest-in" }])
      .png({ quality: 90 })
      .toBuffer();

    console.log(`[mask] rounded corners: r=${r}px on ${w}×${h}`);
    return masked;
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

/**
 * Deskew: detect and correct slight rotation of a card scan.
 * Samples the top edge of the thresholded image to find the card boundary slope,
 * then rotates the original by the inverse angle. Capped at ±5°.
 */
export async function deskewCard(inputBuffer: Buffer): Promise<{ buffer: Buffer; angle: number }> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return { buffer: inputBuffer, angle: 0 };

    // Work at reduced size for speed (max 1500px wide for angle detection)
    const scale = Math.min(1, 1500 / meta.width);
    const workW = Math.round(meta.width * scale);
    const workH = Math.round(meta.height * scale);

    // Greyscale → threshold → raw pixels
    const { data, info } = await sharp(inputBuffer)
      .resize(workW, workH, { fit: "fill" })
      .greyscale()
      .threshold(200) // white background → 255, card → 0
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    const w = info.width;
    const h = info.height;

    // Sample top edge: for each column, find the first dark pixel (row)
    const sampleCols = Math.min(w, 200);
    const step = Math.max(1, Math.floor(w / sampleCols));
    const points: { x: number; y: number }[] = [];

    for (let col = Math.round(w * 0.1); col < Math.round(w * 0.9); col += step) {
      for (let row = 0; row < Math.round(h * 0.4); row++) {
        if (pixels[row * w + col] < 128) { // dark pixel = card
          points.push({ x: col, y: row });
          break;
        }
      }
    }

    if (points.length < 10) {
      console.log("[deskew] not enough edge points detected, skipping");
      return { buffer: inputBuffer, angle: 0 };
    }

    // Linear regression: y = mx + b → angle = atan(m)
    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of points) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; }
    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 0.001) return { buffer: inputBuffer, angle: 0 };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const angle = Math.atan(slope) * (180 / Math.PI);

    // Cap at ±5° — beyond that it's a bad scan, not a slight rotation
    if (Math.abs(angle) > 5) {
      console.log(`[deskew] angle ${angle.toFixed(2)}° exceeds ±5°, skipping`);
      return { buffer: inputBuffer, angle: 0 };
    }

    // Skip tiny rotations (<0.2°) — not worth the processing
    if (Math.abs(angle) < 0.2) {
      console.log(`[deskew] angle ${angle.toFixed(2)}° too small, skipping`);
      return { buffer: inputBuffer, angle: 0 };
    }

    // Rotate the ORIGINAL full-resolution image by -angle
    const rotated = await sharp(inputBuffer)
      .rotate(-angle, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    console.log(`[deskew] corrected ${angle.toFixed(2)}°`);
    return { buffer: rotated, angle };
  } catch (err: any) {
    console.warn("[deskew] detection failed, skipping:", err.message);
    return { buffer: inputBuffer, angle: 0 };
  }
}

/**
 * Crop to the yellow border of a Pokemon card by detecting yellow pixels.
 * More precise than threshold-based trim — targets the card's actual border colour.
 * Returns null if yellow detection fails (caller should fall back to autoCrop).
 */
export async function cropToYellowBorder(inputBuffer: Buffer): Promise<{ buffer: Buffer; cropped: boolean } | null> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return null;

    // Work at reduced size for speed (max 1500px)
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

    // Scan for yellow pixels — Pokemon card border colour
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let yellowCount = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * ch;
        const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
        // Yellow detection: high red, medium-high green, low blue
        if (r > 200 && g > 150 && g < 240 && b < 100) {
          yellowCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const totalPixels = w * h;
    const yellowPct = (yellowCount / totalPixels) * 100;

    // Need at least 3% yellow pixels to be confident this is a Pokemon card border
    if (yellowPct < 3 || maxX <= minX || maxY <= minY) {
      console.log(`[crop-yellow] only ${yellowPct.toFixed(1)}% yellow pixels — skipping (not enough border detected)`);
      return null;
    }

    // Scale coordinates back to original image dimensions
    const origMinX = Math.max(0, Math.round(minX / scale));
    const origMinY = Math.max(0, Math.round(minY / scale));
    const origMaxX = Math.min(meta.width, Math.round(maxX / scale));
    const origMaxY = Math.min(meta.height, Math.round(maxY / scale));
    const cropW = origMaxX - origMinX;
    const cropH = origMaxY - origMinY;

    // Validate: cropped area must be at least 30% of original
    if (cropW * cropH < meta.width * meta.height * 0.3) {
      console.log(`[crop-yellow] yellow bbox too small: ${cropW}x${cropH} — skipping`);
      return null;
    }

    const cropped = await sharp(inputBuffer)
      .extract({ left: origMinX, top: origMinY, width: cropW, height: cropH })
      .jpeg({ quality: 95 })
      .toBuffer();

    const ratio = cropW / cropH;
    console.log(`[crop-yellow] ${meta.width}x${meta.height} → ${cropW}x${cropH} (yellow ${yellowPct.toFixed(1)}%, ratio=${ratio.toFixed(3)})`);
    return { buffer: cropped, cropped: true };
  } catch (err: any) {
    console.warn(`[crop-yellow] detection failed: ${err.message}`);
    return null;
  }
}

/**
 * Auto-crop: detect card in scan and crop tight to the actual card edges.
 * Two-pass approach: aggressive trim first, then validate white border %.
 * Falls back to softer trim if aggressive is too tight.
 */
export async function autoCrop(inputBuffer: Buffer): Promise<{ buffer: Buffer; cropped: boolean }> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return { buffer: inputBuffer, cropped: false };

    // Downscale huge scanner images first to prevent OOM
    let workBuffer = inputBuffer;
    if (meta.width > 4000 || meta.height > 4000) {
      workBuffer = await sharp(inputBuffer)
        .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 95 })
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
      return { buffer: workBuffer, cropped: false };
    }

    // Check white border percentage — sample 5px border on all 4 sides
    const borderWhite = await measureBorderWhiteness(trimBuf, trimInfo.width, trimInfo.height);
    if (borderWhite > 5) {
      // >5% white on border — try even more aggressive trim
      console.log(`[crop] first pass: ${borderWhite.toFixed(1)}% white border, re-trimming`);
      try {
        const tighter = await sharp(trimBuf)
          .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 120 })
          .toBuffer({ resolveWithObject: true });
        if (tighter.info.width > 100 && tighter.info.height > 100) {
          trimBuf = tighter.data;
          trimInfo = tighter.info;
        }
      } catch { /* keep first pass result */ }
    }

    // Minimal padding (0.5% each side — just enough to avoid clipping card edge)
    const padW = Math.max(1, Math.round(trimInfo.width * 0.005));
    const padH = Math.max(1, Math.round(trimInfo.height * 0.005));

    const padded = await sharp(trimBuf)
      .extend({ top: padH, bottom: padH, left: padW, right: padW, background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const ratio = trimInfo.width / trimInfo.height;
    const expectedRatio = 0.714; // 2.5/3.5 = standard card
    const ratioDiff = Math.abs(ratio - expectedRatio) / expectedRatio;
    console.log(`[crop] ${trimInfo.width}x${trimInfo.height} ratio=${ratio.toFixed(3)} ${ratioDiff < 0.1 ? "✓" : "⚠ off-ratio"} white=${borderWhite.toFixed(1)}%`);

    return { buffer: padded, cropped: true };
  } catch {
    return { buffer: inputBuffer, cropped: false };
  }
}

/** Measure percentage of near-white pixels in a 5px border ring around the image */
async function measureBorderWhiteness(buf: Buffer, w: number, h: number): Promise<number> {
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
  // Resize to 2000px max first — keeps peak RAM manageable
  const resized = await sharp(inputBuffer)
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Sequential processing to limit peak memory
  const greyscale = await sharp(resized)
    .greyscale()
    .jpeg({ quality: 85 })
    .toBuffer();

  const highcontrast = await sharp(resized)
    .modulate({ brightness: 1.1 })
    .linear(1.6, -(128 * 1.6 - 128))
    .jpeg({ quality: 85 })
    .toBuffer();

  const edgeenhanced = await sharp(resized)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .jpeg({ quality: 85 })
    .toBuffer();

  const inverted = await sharp(resized)
    .negate()
    .jpeg({ quality: 85 })
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
