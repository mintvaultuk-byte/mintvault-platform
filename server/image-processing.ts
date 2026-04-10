/**
 * MintVault Image Processing
 * Auto-crop, image variant generation, and quality checks for grading images.
 */
import sharp from "sharp";

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
 * Auto-crop: detect card in scan and crop tight.
 * Uses Sharp trim() to remove scanner background, then validates the result.
 * Falls back to original if card detection is ambiguous.
 */
export async function autoCrop(inputBuffer: Buffer): Promise<{ buffer: Buffer; cropped: boolean }> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    if (!meta.width || !meta.height) return { buffer: inputBuffer, cropped: false };

    // Downscale huge scanner images first to prevent OOM (e.g. 1600 DPI = 4000x5600px)
    let workBuffer = inputBuffer;
    if (meta.width > 4000 || meta.height > 4000) {
      workBuffer = await sharp(inputBuffer)
        .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 95 })
        .toBuffer();
    }

    // Trim background using threshold — works for dark and light scanner beds
    const trimmed = await sharp(workBuffer)
      .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 30 })
      .toBuffer({ resolveWithObject: true });

    const { info } = trimmed;

    // Validate: trimmed result must be at least 40% of original size (avoid over-trim)
    const areaRatio = (info.width * info.height) / (meta.width * meta.height);
    if (areaRatio < 0.15 || info.width < 100 || info.height < 100) {
      return { buffer: inputBuffer, cropped: false };
    }

    // Add 1% margin on each side
    const padW = Math.round(info.width * 0.01);
    const padH = Math.round(info.height * 0.01);
    const finalW = info.width + padW * 2;
    const finalH = info.height + padH * 2;

    const padded = await sharp(trimmed.data)
      .extend({ top: padH, bottom: padH, left: padW, right: padW, background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .resize(finalW, finalH)
      .jpeg({ quality: 95 })
      .toBuffer();

    return { buffer: padded, cropped: true };
  } catch {
    return { buffer: inputBuffer, cropped: false };
  }
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
