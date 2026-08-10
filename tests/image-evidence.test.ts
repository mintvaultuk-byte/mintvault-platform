import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  assertCompatibleEvidencePair,
  inspectScannerEvidence,
  MAX_SCANNER_EVIDENCE_PIXELS,
} from "../server/lib/image-evidence";

describe("immutable scanner evidence boundary", () => {
  it("classifies TIFF bytes as a hashed immutable master", async () => {
    const tiff = await sharp({ create: { width: 252, height: 342, channels: 3, background: "#102030" } })
      .tiff()
      .withMetadata({ density: 900 })
      .toBuffer();
    const inspection = await inspectScannerEvidence(tiff);
    expect(inspection).toMatchObject({ evidenceClass: "NEW_IMMUTABLE_MASTER", format: "tiff", dpi: 900 });
    expect(inspection.sha256).toBe(createHash("sha256").update(tiff).digest("hex"));
  });

  it("does not let a JPEG, filename, or claimed MIME become a TIFF master", async () => {
    const jpeg = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#fff" } })
      .jpeg()
      .toBuffer();
    const tiff = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#fff" } })
      .tiff()
      .toBuffer();
    await expect(inspectScannerEvidence(Buffer.from("photo.tif", "utf8"))).rejects.toThrow("TIFF or a legacy JPEG");
    const jpegInspection = await inspectScannerEvidence(jpeg);
    const tiffInspection = await inspectScannerEvidence(tiff);
    expect(jpegInspection.evidenceClass).toBe("LEGACY_DERIVED_ONLY");
    expect(() => assertCompatibleEvidencePair(tiffInspection, jpegInspection)).toThrow("both be TIFF masters");
  });

  it("uses a finite decoder bound and an append-only migration-owned ledger", () => {
    expect(MAX_SCANNER_EVIDENCE_PIXELS).toBe(30_000_000);
    const migration = readFileSync(
      new URL("../migrations/0067_certificate_immutable_evidence_ledger.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("certificate_image_masters_append_only");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON certificate_image_masters");
    const r2 = readFileSync(new URL("../server/r2.ts", import.meta.url), "utf8");
    expect(r2).toContain('key.startsWith("evidence/")');
  });
});
