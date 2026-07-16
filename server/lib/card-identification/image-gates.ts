/**
 * Image quality + integrity gates — run BEFORE any provider call so we never
 * spend a credit on an obviously-unusable image. Reuses the repo's magic-byte
 * MIME check and adds the decompression-bomb guard (`limitInputPixels`) the
 * grading-side sharp pipeline lacks. Pure of provider concerns; sharp-only.
 */
import sharp from "sharp";
import crypto from "crypto";
import { validateImageMagicBytes } from "./mime";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB per side
export const MAX_PIXELS = 40_000_000; // decompression-bomb ceiling (VQ parity)
export const MIN_DIMENSION = 200; // below this a card is unreadable
export const MAX_DIMENSION = 8000;

export type ImageGateCode =
  | "missing"
  | "bad_mime"
  | "too_large"
  | "decompression_bomb"
  | "too_small"
  | "too_large_dimensions"
  | "blank"
  | "fully_transparent"
  | "front_back_identical"
  | "unreadable";

export interface ImageGateResult {
  ok: boolean;
  code: ImageGateCode | null;
  /** Grader-facing message; generic + actionable, never provider detail. */
  message: string | null;
  frontChecksum: string | null;
  backChecksum: string | null;
  warnings: string[];
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function inspect(buf: Buffer): Promise<{ width: number; height: number; blank: boolean; transparent: boolean } | null> {
  try {
    const img = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: "none" });
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    // stddev near-zero on every channel ⇒ a blank/flat image.
    const stats = await img.stats();
    const blank = stats.channels.every((c) => c.stdev < 3);
    const transparent = Boolean(meta.hasAlpha) && (stats.channels[3]?.max ?? 255) === 0;
    return { width, height, blank, transparent };
  } catch {
    return null;
  }
}

export interface ImageGateInput {
  front?: Buffer | null;
  back?: Buffer | null;
  /** Whether a back image is required (policy). Default false — back optional. */
  requireBack?: boolean;
}

/**
 * Validate the front (required) and back (optional) card images. Returns ok:false
 * with a grader-facing message on the first hard failure; soft issues go to
 * `warnings` (e.g. front/back identical) so the grader is informed but not blocked.
 */
export async function validateIdentificationImages(input: ImageGateInput): Promise<ImageGateResult> {
  const warnings: string[] = [];
  const fail = (code: ImageGateCode, message: string): ImageGateResult => ({
    ok: false,
    code,
    message,
    frontChecksum: null,
    backChecksum: null,
    warnings,
  });

  const front = input.front;
  if (!front || front.length === 0) return fail("missing", "A front image is required to identify the card.");
  if (front.length > MAX_IMAGE_BYTES) return fail("too_large", "The front image is too large. Use an image under 12 MB.");

  const frontMimeErr = await validateImageMagicBytes(front);
  if (frontMimeErr) return fail("bad_mime", "The front image is not a supported image type (JPEG/PNG/WebP).");

  const frontMeta = await inspect(front);
  if (!frontMeta) return fail("decompression_bomb", "The front image could not be decoded safely. Retake or enter manually.");
  if (frontMeta.width < MIN_DIMENSION || frontMeta.height < MIN_DIMENSION)
    return fail("too_small", "The front image is too small/blurry for reliable identification. Retake or enter manually.");
  if (frontMeta.width > MAX_DIMENSION || frontMeta.height > MAX_DIMENSION)
    return fail("too_large_dimensions", "The front image dimensions are too large. Resize and retry, or enter manually.");
  if (frontMeta.transparent) return fail("fully_transparent", "The front image is fully transparent. Retake or enter manually.");
  if (frontMeta.blank) return fail("blank", "The front image looks blank. Retake or enter manually.");

  const frontChecksum = sha256(front);
  let backChecksum: string | null = null;

  const back = input.back;
  if (back && back.length > 0) {
    if (back.length > MAX_IMAGE_BYTES) return fail("too_large", "The back image is too large. Use an image under 12 MB.");
    if (await validateImageMagicBytes(back)) return fail("bad_mime", "The back image is not a supported image type.");
    const backMeta = await inspect(back);
    if (!backMeta) return fail("decompression_bomb", "The back image could not be decoded safely.");
    backChecksum = sha256(back);
    if (backChecksum === frontChecksum) {
      // Same bytes for both sides — likely a mistake; warn, don't hard-block.
      warnings.push("Front and back images are identical — check you uploaded both sides.");
    }
  } else if (input.requireBack) {
    return fail("missing", "A back image is required for this card.");
  } else {
    warnings.push("No back image provided — identification uses the front only.");
  }

  return { ok: true, code: null, message: null, frontChecksum, backChecksum, warnings };
}

/** Resize + auto-orient to a bounded JPEG for the provider (base64), stripping
 *  metadata. Never enlarges; caps to 1568px (Claude's sweet spot). */
export async function normaliseForProvider(buf: Buffer): Promise<{ base64: string; mediaType: "image/jpeg" }> {
  const out = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: "none" })
    .rotate() // EXIF auto-orient
    .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  return { base64: out.toString("base64"), mediaType: "image/jpeg" };
}
