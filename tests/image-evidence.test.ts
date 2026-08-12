import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  assertCompatibleEvidencePair,
  inspectScannerEvidence,
  MAX_SCANNER_EVIDENCE_PIXELS,
} from "../server/lib/image-evidence";

describe("scanner evidence boundary", () => {
  it("classifies a TIFF as an immutable master without changing its bytes", async () => {
    const tiff = await sharp({
      create: { width: 252, height: 342, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .tiff()
      .withMetadata({ density: 900 })
      .toBuffer();
    const inspection = await inspectScannerEvidence(tiff);
    expect(inspection).toMatchObject({
      evidenceClass: "NEW_IMMUTABLE_MASTER",
      format: "tiff",
      width: 252,
      height: 342,
      bitDepth: 8,
      dpi: 900,
    });
    expect(inspection.sha256).toBe(createHash("sha256").update(tiff).digest("hex"));
  });

  it("does not relabel legacy JPEG input as a scanner master", async () => {
    const jpeg = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#fff" } })
      .jpeg()
      .toBuffer();
    const inspection = await inspectScannerEvidence(jpeg);
    expect(inspection.evidenceClass).toBe("LEGACY_DERIVED_ONLY");
    expect(inspection.format).toBe("jpeg");
  });

  it("rejects malformed bytes and a TIFF/JPEG front-back substitution", async () => {
    await expect(inspectScannerEvidence(Buffer.from("not an image"))).rejects.toThrow("TIFF or a legacy JPEG");
    const tiff = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
      .tiff()
      .toBuffer();
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
      .jpeg()
      .toBuffer();
    const ti = await inspectScannerEvidence(tiff);
    const ji = await inspectScannerEvidence(jpeg);
    expect(() => assertCompatibleEvidencePair(ti, ji)).toThrow("both be TIFF masters");
    expect(MAX_SCANNER_EVIDENCE_PIXELS).toBe(30_000_000);
  });
});
