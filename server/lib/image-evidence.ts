/**
 * Scanner evidence inspection.
 *
 * This module intentionally does not transform input pixels.  It is the
 * boundary between an untrusted multipart upload and immutable scanner
 * evidence storage.  The output is also the metadata snapshot persisted with
 * the evidence object; never derive it from a filename or a client header.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

// 128 MiB accepts the supplied 96.7 MiB 1200-DPI V850 TIFF while still placing
// a finite bound on multipart buffering. The independent 30MP decoder bound
// rejects decompression bombs regardless of compressed byte size.
export const MAX_SCANNER_EVIDENCE_BYTES = 128 * 1024 * 1024;
export const MAX_SCANNER_EVIDENCE_PIXELS = 30_000_000;

export type EvidenceClass = "NEW_IMMUTABLE_MASTER" | "LEGACY_DERIVED_ONLY";

export type ScannerEvidenceInspection = {
  evidenceClass: EvidenceClass;
  sha256: string;
  byteLength: number;
  format: "tiff" | "jpeg";
  mimeType: "image/tiff" | "image/jpeg";
  extension: "tif" | "jpg";
  width: number;
  height: number;
  bitDepth: number | null;
  dpi: number | null;
  channels: number | null;
  colourSpace: string | null;
  hasIccProfile: boolean;
};

function tiffSignature(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  // Classic TIFF (II* / MM*) and BigTIFF (II+ / MM+).
  return (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && (buffer[2] === 0x2a || buffer[2] === 0x2b) && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && (buffer[3] === 0x2a || buffer[3] === 0x2b))
  );
}

function jpegSignature(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function bitDepth(depth: string | undefined): number | null {
  if (depth === "uchar") return 8;
  if (depth === "char") return 8;
  if (depth === "ushort" || depth === "short") return 16;
  if (depth === "float") return 32;
  return null;
}

/**
 * Inspect and strictly classify a scanner upload. TIFF is the only format that
 * can enter the new immutable-master path. JPEG is intentionally retained as
 * readable legacy evidence, never relabelled as raw/master evidence.
 */
export async function inspectScannerEvidence(buffer: Buffer): Promise<ScannerEvidenceInspection> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Scanner evidence is empty");
  if (buffer.length > MAX_SCANNER_EVIDENCE_BYTES) {
    throw new Error(`Scanner evidence exceeds ${MAX_SCANNER_EVIDENCE_BYTES / 1024 / 1024} MiB limit`);
  }

  const isTiff = tiffSignature(buffer);
  const isJpeg = jpegSignature(buffer);
  if (!isTiff && !isJpeg) throw new Error("Scanner evidence must be TIFF or a legacy JPEG");

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_SCANNER_EVIDENCE_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new Error("Scanner evidence could not be decoded safely");
  }
  const expectedFormat = isTiff ? "tiff" : "jpeg";
  if (meta.format !== expectedFormat || !meta.width || !meta.height) {
    throw new Error("Scanner evidence signature and decoded image format do not agree");
  }
  if (meta.width * meta.height > MAX_SCANNER_EVIDENCE_PIXELS) {
    throw new Error(`Scanner evidence exceeds ${MAX_SCANNER_EVIDENCE_PIXELS} pixel limit`);
  }

  return {
    evidenceClass: isTiff ? "NEW_IMMUTABLE_MASTER" : "LEGACY_DERIVED_ONLY",
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteLength: buffer.length,
    format: expectedFormat,
    mimeType: isTiff ? "image/tiff" : "image/jpeg",
    extension: isTiff ? "tif" : "jpg",
    width: meta.width,
    height: meta.height,
    bitDepth: bitDepth(meta.depth),
    dpi: typeof meta.density === "number" && Number.isFinite(meta.density) ? meta.density : null,
    channels: meta.channels ?? null,
    colourSpace: meta.space ?? null,
    hasIccProfile: Boolean(meta.icc),
  };
}

export function assertCompatibleEvidencePair(
  front: ScannerEvidenceInspection,
  back: ScannerEvidenceInspection | null
): void {
  if (back && front.evidenceClass !== back.evidenceClass) {
    throw new Error("Front and back must both be TIFF masters or both be legacy JPEG evidence");
  }
}
