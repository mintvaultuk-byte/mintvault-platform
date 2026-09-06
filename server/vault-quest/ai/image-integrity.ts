/**
 * Deterministic image-integrity validation for every Vault Quest generated
 * image (spend-guard Phase 3B, item 2). Independent from validateStudioBackground
 * (bg-validate.ts) — that module checks a specific STUDIO-BACKDROP rule for
 * Master/Action; THIS module checks that the bytes are a genuine, non-corrupt,
 * non-blank image at all, for EVERY generation type. Run this FIRST; background/
 * identity/pose/evolution gates only make sense once integrity has already passed.
 *
 * Root-cause context: a prior incident investigation found the only existing
 * "is this actually a real image" protection was validateStudioBackground's
 * brightness floor — real, but narrow (Master/Action only) and coupled to an
 * unrelated rule. This module is the general-purpose, reusable check.
 *
 * Deliberately uses SEVERAL independent statistics rather than a single mean-
 * brightness threshold, so a genuinely dark, detailed illustration is never
 * confused with a blank/corrupt frame:
 *   - alpha occupancy (fully/effectively transparent detection)
 *   - luminance percentiles (p5/p50/p95) — distinguishes "everything is near one
 *     brightness" from "there's a real spread of light and dark"
 *   - near-black / near-white pixel ratios
 *   - per-channel + luminance standard deviation
 *   - a coarse colour-bin histogram spread (how many distinct buckets are used)
 *   - simple edge/neighbour variation (sum of adjacent-pixel differences)
 * A frame only fails "insufficient variance" when MULTIPLE of these signals
 * agree it's flat — never from brightness alone.
 */
import sharp, { type Metadata, type OutputInfo } from "sharp";

export type ImageIntegrityCode =
  | "empty_buffer"
  | "input_too_large"
  | "unsupported_format"
  | "decode_failed"
  | "content_type_mismatch"
  | "invalid_dimensions"
  | "excessive_pixel_count"
  | "implausible_aspect_ratio"
  | "fully_transparent"
  | "effectively_transparent"
  | "effectively_black"
  | "effectively_white"
  | "insufficient_variance"
  | "insufficient_visible_content";

export interface ImageIntegrityResult {
  ok: boolean;
  code?: ImageIntegrityCode;
  reason?: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface ImageIntegrityOptions {
  /** Claimed content type (e.g. from an HTTP response header), if known. Checked
   *  against the ACTUAL decoded format when present; absent claim = skip check. */
  claimedContentType?: string;
  /** Generation-type-specific aspect ratio sanity bounds. Defaults are broad
   *  (accepts anything from a tall portrait to a wide landscape) — only rejects
   *  truly implausible shapes, never a legitimate composition choice. */
  minAspectRatio?: number;
  maxAspectRatio?: number;
}

// Configured sane bounds — conservative, generously wide (this is a corruption/
// blank-frame filter, not an art-direction filter).
export const MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25MB — Higgsfield outputs are far smaller; guards a runaway/corrupt download
export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 8192;
export const MAX_PIXEL_COUNT = 40_000_000; // ~40MP — generous ceiling, guards decode-bomb-style inputs
const DEFAULT_MIN_ASPECT = 1 / 4; // very tall (1:4)
const DEFAULT_MAX_ASPECT = 4 / 1; // very wide (4:1)

// Analysis is done on a BOUNDED downsample regardless of input size — keeps CPU/
// memory cost constant even for a large valid image.
const ANALYSIS_MAX_DIM = 256;

const SUPPORTED_FORMATS = new Set(["png", "jpeg", "jpg", "webp"]);

function magicBytesFormat(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

function percentile(sorted: Uint8Array | number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export async function validateImageIntegrity(buf: Buffer | null | undefined, opts?: ImageIntegrityOptions): Promise<ImageIntegrityResult> {
  if (!buf || buf.length === 0) {
    return { ok: false, code: "empty_buffer", reason: "The generated image was empty." };
  }
  if (buf.length > MAX_INPUT_BYTES) {
    return { ok: false, code: "input_too_large", reason: "The generated image exceeded the maximum allowed size." };
  }
  const magic = magicBytesFormat(buf);
  if (!magic || !SUPPORTED_FORMATS.has(magic)) {
    return { ok: false, code: "unsupported_format", reason: "The generated file is not a supported image format." };
  }

  let meta: Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    return { ok: false, code: "decode_failed", reason: "The generated image could not be decoded." };
  }
  const format = meta.format ?? magic;
  if (!SUPPORTED_FORMATS.has(format)) {
    return { ok: false, code: "unsupported_format", reason: "The generated image's decoded format is not supported." };
  }
  if (opts?.claimedContentType) {
    const claimed = opts.claimedContentType.toLowerCase();
    const claimedFmt = claimed.includes("png") ? "png" : claimed.includes("jpeg") || claimed.includes("jpg") ? "jpeg" : claimed.includes("webp") ? "webp" : null;
    if (claimedFmt && claimedFmt !== format) {
      return { ok: false, code: "content_type_mismatch", reason: "The claimed content type does not match the actual image format.", format };
    }
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return { ok: false, code: "invalid_dimensions", reason: "The generated image's dimensions are outside the allowed range.", width, height, format };
  }
  const pixelCount = width * height;
  if (pixelCount > MAX_PIXEL_COUNT) {
    return { ok: false, code: "excessive_pixel_count", reason: "The generated image has too many pixels.", width, height, format };
  }
  const aspect = width / height;
  const minAspect = opts?.minAspectRatio ?? DEFAULT_MIN_ASPECT;
  const maxAspect = opts?.maxAspectRatio ?? DEFAULT_MAX_ASPECT;
  if (aspect < minAspect || aspect > maxAspect) {
    return { ok: false, code: "implausible_aspect_ratio", reason: "The generated image's aspect ratio is implausible for this generation type.", width, height, format };
  }

  // ── Bounded-size pixel analysis ──────────────────────────────────────────
  let raw: { data: Buffer; info: OutputInfo };
  try {
    raw = await sharp(buf)
      .resize({ width: ANALYSIS_MAX_DIM, height: ANALYSIS_MAX_DIM, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return { ok: false, code: "decode_failed", reason: "The generated image could not be decoded for analysis.", width, height, format };
  }
  const { data, info } = raw;
  const w = info.width, h = info.height, ch = info.channels; // ch === 4 (RGBA) via ensureAlpha
  const n = w * h;

  let alphaSum = 0;
  let visiblePixels = 0;
  const lum = new Uint8Array(n);
  let sumR = 0, sumG = 0, sumB = 0;
  let nearBlack = 0, nearWhite = 0;
  const NEAR_BLACK_T = 18, NEAR_WHITE_T = 237;
  const histogram = new Array(16).fill(0); // 16 coarse luminance bins

  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
    alphaSum += a;
    if (a > 8) visiblePixels++; // count as "visible" once alpha is more than negligible
    const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    lum[i] = l;
    sumR += r; sumG += g; sumB += b;
    if (l <= NEAR_BLACK_T) nearBlack++;
    if (l >= NEAR_WHITE_T) nearWhite++;
    histogram[Math.min(15, l >> 4)]++;
  }

  const alphaOccupancy = alphaSum / (n * 255);
  const visibleFraction = visiblePixels / n;
  if (alphaOccupancy < 0.005) {
    return { ok: false, code: "fully_transparent", reason: "The generated image is fully transparent.", width, height, format };
  }
  if (visibleFraction < 0.02) {
    return { ok: false, code: "effectively_transparent", reason: "The generated image is almost entirely transparent.", width, height, format };
  }

  const sortedLum = Uint8Array.from(lum).sort();
  const p5 = percentile(sortedLum, 0.05);
  const p50 = percentile(sortedLum, 0.5);
  const p95 = percentile(sortedLum, 0.95);
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;

  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = lum[i] - p50;
    varSum += d * d;
  }
  const lumStdDev = Math.sqrt(varSum / n);

  // Coarse edge/neighbour variation: sum of |difference| between each pixel and
  // its right neighbour, sampled on a stride to stay bounded/cheap.
  let edgeVariation = 0, edgeSamples = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w - 1; x += 2) {
      const i = y * w + x;
      edgeVariation += Math.abs(lum[i] - lum[i + 1]);
      edgeSamples++;
    }
  }
  const meanEdgeVariation = edgeSamples ? edgeVariation / edgeSamples : 0;
  const usedBins = histogram.filter((c) => c > n * 0.001).length; // bins with non-trivial pixel share

  const nearBlackRatio = nearBlack / n;
  const nearWhiteRatio = nearWhite / n;

  // "Effectively all black": near-uniform AND overwhelmingly near-black AND
  // negligible spread — several signals, not brightness alone.
  const looksAllBlack = nearBlackRatio > 0.97 && p95 <= NEAR_BLACK_T + 10 && lumStdDev < 6 && meanEdgeVariation < 3;
  if (looksAllBlack) {
    return { ok: false, code: "effectively_black", reason: "The generated image is effectively all black.", width, height, format };
  }
  const looksAllWhite = nearWhiteRatio > 0.97 && p5 >= NEAR_WHITE_T - 10 && lumStdDev < 6 && meanEdgeVariation < 3;
  if (looksAllWhite) {
    return { ok: false, code: "effectively_white", reason: "The generated image is effectively all white.", width, height, format };
  }

  // Flat/near-flat SINGLE colour (any hue, not just black/white): low luminance
  // spread AND low per-channel spread AND very few histogram bins used AND
  // negligible edge variation.
  let varR = 0, varG = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    varR += (data[o] - meanR) ** 2;
    varG += (data[o + 1] - meanG) ** 2;
    varB += (data[o + 2] - meanB) ** 2;
  }
  const chanStdDev = Math.sqrt((varR + varG + varB) / (3 * n));
  const looksFlatColour = lumStdDev < 8 && chanStdDev < 8 && usedBins <= 2 && meanEdgeVariation < 4 && (p95 - p5) < 20;
  if (looksFlatColour) {
    return { ok: false, code: "insufficient_variance", reason: "The generated image is a flat, near-single colour with no real content.", width, height, format };
  }

  // General "not enough visible content/variation" catch-all — requires MULTIPLE
  // signals of flatness together (never brightness alone), so a genuinely dark
  // or genuinely bright but DETAILED illustration always passes: it will have a
  // wide p5-p95 spread and/or real edge variation and/or many histogram bins.
  const insufficientContent = lumStdDev < 10 && meanEdgeVariation < 5 && usedBins <= 3 && (p95 - p5) < 24;
  if (insufficientContent) {
    return { ok: false, code: "insufficient_visible_content", reason: "The generated image does not contain enough visible detail.", width, height, format };
  }

  return { ok: true, width, height, format };
}
