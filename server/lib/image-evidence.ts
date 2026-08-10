/**
 * Scanner evidence inspection boundary. File names and multipart MIME claims are
 * untrusted; only the bytes and decoder metadata decide whether a scan can be a
 * new immutable TIFF master.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

// Covers the recorded 1200-DPI V850 capture (96.7 MiB) with finite headroom.
export const MAX_SCANNER_EVIDENCE_BYTES = 128 * 1024 * 1024;
export const MAX_SCANNER_EVIDENCE_PIXELS = 30_000_000;

export type EvidenceClass = "NEW_IMMUTABLE_MASTER" | "LEGACY_DERIVED_ONLY";

export interface ScannerEvidenceInspection {
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
}

function isTiff(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && (buffer[2] === 0x2a || buffer[2] === 0x2b) && buffer[3] === 0) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0 && (buffer[3] === 0x2a || buffer[3] === 0x2b))
  );
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function toBitDepth(depth: string | undefined): number | null {
  if (depth === "uchar" || depth === "char") return 8;
  if (depth === "ushort" || depth === "short") return 16;
  if (depth === "float") return 32;
  return null;
}

export async function inspectScannerEvidence(buffer: Buffer): Promise<ScannerEvidenceInspection> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Scanner evidence is empty");
  if (buffer.length > MAX_SCANNER_EVIDENCE_BYTES) throw new Error("Scanner evidence exceeds the 128 MiB limit");

  const tiff = isTiff(buffer);
  const jpeg = isJpeg(buffer);
  if (!tiff && !jpeg) throw new Error("Scanner evidence must be TIFF or a legacy JPEG");

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_SCANNER_EVIDENCE_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new Error("Scanner evidence could not be decoded safely");
  }
  const format = tiff ? "tiff" : "jpeg";
  if (metadata.format !== format || !metadata.width || !metadata.height) {
    throw new Error("Scanner evidence signature and decoded image format do not agree");
  }
  if (metadata.width * metadata.height > MAX_SCANNER_EVIDENCE_PIXELS) {
    throw new Error("Scanner evidence exceeds the decoded-pixel limit");
  }

  return {
    evidenceClass: tiff ? "NEW_IMMUTABLE_MASTER" : "LEGACY_DERIVED_ONLY",
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteLength: buffer.length,
    format,
    mimeType: tiff ? "image/tiff" : "image/jpeg",
    extension: tiff ? "tif" : "jpg",
    width: metadata.width,
    height: metadata.height,
    bitDepth: toBitDepth(metadata.depth),
    dpi: typeof metadata.density === "number" && Number.isFinite(metadata.density) ? metadata.density : null,
    channels: metadata.channels ?? null,
    colourSpace: metadata.space ?? null,
    hasIccProfile: Boolean(metadata.icc),
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
