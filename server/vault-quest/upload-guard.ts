/**
 * Self-contained upload guard for Vault Quest artwork.
 *
 * Copied intent (not import) of the grading side's magic-byte validator, so the
 * VQ module stays liftable. sharp decodes the actual bytes — a spoofed
 * Content-Type cannot pass, because sharp reads the real header, not the claim.
 */
import sharp from "sharp";

const ALLOWED = new Set(["png", "jpeg", "webp"]);

// Upper bounds on decoded image geometry. A multi-thousand-pixel flat-colour PNG
// compresses to a few hundred KB (sails under the multer byte cap) but decodes to
// ~1 GB of RGBA — enough to OOM the shared Fly machine that also runs grading and
// payments. sharp.metadata() reads these dimensions from the header WITHOUT
// decoding pixels, so we reject before any decode/re-encode allocates. 8192 px and
// 40 MP comfortably clear legitimate 600-DPI card art (~1800 px) with headroom.
const MAX_DIM = 8192;
export const MAX_PIXELS = 40_000_000;

export interface GuardResult {
  ok: boolean;
  error?: string;
  format?: string;
  width?: number;
  height?: number;
}

export async function validateArtwork(buf: Buffer): Promise<GuardResult> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.format || !ALLOWED.has(meta.format)) {
      return { ok: false, error: `unsupported image format "${meta.format ?? "unknown"}" (allowed: png, jpg, webp)` };
    }
    if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
      return { ok: false, error: `image too small (${meta.width ?? 0}×${meta.height ?? 0}, min 64×64)` };
    }
    if (meta.width > MAX_DIM || meta.height > MAX_DIM || meta.width * meta.height > MAX_PIXELS) {
      return {
        ok: false,
        error: `image too large (${meta.width}×${meta.height}, max ${MAX_DIM}px per side and ${MAX_PIXELS / 1_000_000}MP total)`,
      };
    }
    return { ok: true, format: meta.format, width: meta.width, height: meta.height };
  } catch {
    return { ok: false, error: "file is not a decodable image" };
  }
}
