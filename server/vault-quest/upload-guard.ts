/**
 * Self-contained upload guard for Vault Quest artwork.
 *
 * Copied intent (not import) of the grading side's magic-byte validator, so the
 * VQ module stays liftable. sharp decodes the actual bytes — a spoofed
 * Content-Type cannot pass, because sharp reads the real header, not the claim.
 */
import sharp from "sharp";

const ALLOWED = new Set(["png", "jpeg", "webp"]);

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
    return { ok: true, format: meta.format, width: meta.width, height: meta.height };
  } catch {
    return { ok: false, error: "file is not a decodable image" };
  }
}
