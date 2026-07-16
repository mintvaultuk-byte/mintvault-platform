/**
 * Buffer-based magic-byte MIME validation for the identification pipeline.
 * Same `file-type` dependency + allowlist the upload path uses, but on a raw
 * Buffer (not a Multer.File) so the pipeline stays isolated from routes.ts.
 * NOTE: verify at RUNTIME, not by reading the prod bundle — esbuild has been
 * observed tree-shaking validation before (see project memory).
 */
import { fileTypeFromBuffer } from "file-type";

export const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Returns null when the buffer is an allowed image, else a short error string. */
export async function validateImageMagicBytes(buf: Buffer): Promise<string | null> {
  const detected = await fileTypeFromBuffer(buf);
  if (!detected) return "unrecognised file type";
  if (!ALLOWED_IMAGE_MIMES.has(detected.mime)) return `unsupported image type: ${detected.mime}`;
  return null;
}
