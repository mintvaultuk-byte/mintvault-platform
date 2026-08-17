import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { inspectScannerEvidence } from "../server/lib/image-evidence";
import {
  CANON_LIDE_400_PROFILE,
  assertLide400Evidence,
  parseLide400CaptureProvenance,
} from "../server/lib/lide400-profile";
import { LIDE_400_PRESENTATION_ROTATION_DEGREES, orientLide400Presentation } from "../server/lib/lide400-presentation";

const provenance = () => ({
  profileVersion: CANON_LIDE_400_PROFILE.version,
  scannerManufacturer: "Canon",
  scannerModel: "CanoScan LiDE 400",
  scannerDeviceId: "ica-device-123",
  scannerSerial: null,
  workstationId: "mintvault-station-a",
  requestedDpi: 1200,
  driverResolutionDpi: 1200,
  scanAreaMm: { x: 12, y: 144, ...CANON_LIDE_400_PROFILE.areaMm },
  captureStartedAt: "2026-08-11T10:00:00.000Z",
  captureCompletedAt: "2026-08-11T10:00:04.000Z",
});

async function master(density = 1200, width = 4724, height = 6142) {
  return inspectScannerEvidence(
    await sharp({ create: { width, height, channels: 3, background: { r: 60, g: 80, b: 100 } } })
      .tiff()
      .withMetadata({ density })
      .toBuffer()
  );
}

describe("Canon LiDE 400 locked profile", () => {
  it("accepts a 1200-DPI TIFF only when driver provenance and card-region geometry agree", async () => {
    assertLide400Evidence(await master(), parseLide400CaptureProvenance(provenance()));
  });

  it("accepts the Canon ICA display-name alias while preserving its provenance", async () => {
    assertLide400Evidence(
      await master(),
      parseLide400CaptureProvenance({ ...provenance(), scannerModel: "Canon LiDE 400" })
    );
  });

  /* ============================================================================================
   * THE COLOUR MODEL THE APPROVED HARDWARE ACTUALLY PRODUCES.
   *
   * DEFECT PINNED, and it stopped a real bench (staging, MV272, 17 Aug 12:10). This guard asked for
   * `channels === 3`. A Canon LiDE 400 driven through Apple Image Capture does not produce that: it
   * emits a genuine RGB TIFF with an ASSOCIATED ALPHA extra-sample. `tiffinfo` on the rejected
   * master, byte-for-byte:
   *
   *     Image Width: 4724  Image Length: 6136
   *     Resolution: 1200, 1200 pixels/inch
   *     Bits/Sample: 8      Sample Format: unsigned integer
   *     Compression Scheme: LZW
   *     Photometric Interpretation: RGB color
   *     Extra Samples: 1<assoc-alpha>
   *     Samples/Pixel: 4
   *     Make: Canon   Model: LiDE 400   Software: Apple Image Capture
   *     ICC Profile: <present>, 1992 bytes
   *
   * So the only hardware this profile approves could never satisfy the profile — and it found out
   * AFTER a 57-second physical scan, with "must decode as RGB colour evidence" for an image whose
   * photometric interpretation is literally RGB.
   *
   * The requirement is NOT relaxed here. What is measured is the COLOUR channels, and every
   * non-colour model is still refused by the same arithmetic — proven below, not asserted.
   * ========================================================================================== */
  it("accepts the Canon's real RGB+alpha master and still refuses every non-RGB colour model", async () => {
    const w = 4724;
    const h = 6136;
    const tiff = (channels: 3 | 4) =>
      sharp({
        create: {
          width: w,
          height: h,
          channels,
          background: channels === 4 ? { r: 60, g: 80, b: 100, alpha: 1 } : { r: 60, g: 80, b: 100 },
        },
      })
        .tiff({ compression: "lzw", predictor: "horizontal" })
        .withMetadata({ density: 1200 })
        .toBuffer();

    // A REAL ENCODED TIFF in exactly the Canon's shape: RGB + associated alpha, 8-bit, LZW,
    // 1200 DPI, 4724 x 6136. This is the artifact that was rejected on the bench.
    const canon = await inspectScannerEvidence(await tiff(4));
    expect(canon.channels).toBe(4);
    expect(canon.hasAlpha).toBe(true);
    expect(canon.colourSpace).toBe("srgb");
    expect(canon.bitDepth).toBe(8);
    expect(canon.dpi).toBe(1200);
    expect(canon.width).toBe(4724);
    expect(canon.height).toBe(6136);
    expect(canon.hasIccProfile).toBe(true);
    expect(() => assertLide400Evidence(canon, parseLide400CaptureProvenance(provenance()))).not.toThrow();

    // Plain RGB, no alpha — the shape the guard already accepted. Must keep working.
    const plainRgb = await inspectScannerEvidence(await tiff(3));
    expect(plainRgb.channels).toBe(3);
    expect(plainRgb.hasAlpha).toBe(false);
    expect(() => assertLide400Evidence(plainRgb, parseLide400CaptureProvenance(provenance()))).not.toThrow();

    /*
     * THE REJECTION MATRIX IS EXERCISED AGAINST THE GUARD DIRECTLY, and deliberately so: sharp's
     * TIFF encoder always writes RGB or RGBA (verified — `toColourspace("b-w")` and 1/2-channel raw
     * input both come back as 3/4-channel sRGB), so a genuine greyscale or CMYK TIFF cannot be
     * synthesised here. `assertLide400Evidence` is a pure function of the inspection record, so
     * varying ONLY the colour-model fields of a real inspection is an exact test of the arithmetic
     * that replaced `channels === 3` — and it is the arithmetic, not the encoder, that changed.
     */
    const variant = (over: Partial<typeof canon>) => ({ ...canon, ...over });
    const refused: Array<[string, Partial<typeof canon>]> = [
      ["greyscale", { channels: 1, hasAlpha: false }],
      ["greyscale + alpha", { channels: 2, hasAlpha: true }],
      // The case a bare `channels === 4` allowance would have let straight in. Subtracting only a
      // DECLARED alpha is exactly what keeps this refused.
      ["CMYK / four samples, no alpha", { channels: 4, hasAlpha: false }],
      ["five samples with alpha", { channels: 5, hasAlpha: true }],
      ["no channel information at all", { channels: null, hasAlpha: false }],
      // The colour SPACE check is untouched: right sample count, wrong space, still refused.
      ["correct samples in the wrong colour space", { colourSpace: "cmyk" }],
      ["correct samples with no colour space", { colourSpace: null }],
    ];
    for (const [label, over] of refused) {
      expect(
        () => assertLide400Evidence(variant(over), parseLide400CaptureProvenance(provenance())),
        label
      ).toThrow("must decode as RGB colour evidence");
    }
  }, 60_000);

  it("rejects a low-DPI TIFF even when its filename/MIME would claim LiDE provenance", async () => {
    const inspection = await master(900);
    expect(() => assertLide400Evidence(inspection, parseLide400CaptureProvenance(provenance()))).toThrow(
      "Decoded TIFF density"
    );
  });

  it("rejects metadata-only resolution spoofing through implausible output dimensions", async () => {
    const inspection = await master(1200, 500, 700);
    expect(() => assertLide400Evidence(inspection, parseLide400CaptureProvenance(provenance()))).toThrow("dimensions");
  });

  it("uses real ImageCaptureCore areas for both bounded final TIFFs and full-platen local JPEG positioning Preview", () => {
    const bridge = readFileSync(path.join(process.cwd(), "scripts/scanner-app/native/mintvault-lide-bridge.m"), "utf8");
    expect(bridge).toContain('strcmp(argv[1], "calibrate") == 0');
    expect(bridge).toContain("unit.scanArea = NSMakeRect(");
    expect(bridge).toContain("self.scanWidthMm / 10.0");
    expect(bridge).toContain("self.appliedScanAreaMm");
    expect(bridge).toContain("[bridge devicePayload:bridge.scanner ready:NO]");
    expect(bridge).toContain('strcmp(argv[1], "preview") == 0');
    expect(bridge).toContain('@"public.jpeg"');
    expect(bridge).toContain("ICSize physical = unit.physicalSize");
    expect(bridge).toContain('@"positioning_preview"');
  });

  it("keeps the TIFF source independent while all LiDE presentation derivatives rotate 180 degrees", async () => {
    const width = 20;
    const height = 20;
    const raw = Buffer.alloc(width * height * 3, 0);
    const setPixel = (x: number, y: number, rgb: [number, number, number]) => raw.set(rgb, (y * width + x) * 3);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setPixel(x, y, [240, 20, 20]);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) setPixel(x, y, [20, 20, 240]);

    const source = await sharp(raw, { raw: { width, height, channels: 3 } })
      .tiff()
      .toBuffer();
    const sourceDigest = (await import("node:crypto")).createHash("sha256").update(source).digest("hex");
    const presentation = await orientLide400Presentation(sharp(source)).raw().toBuffer();
    const topLeft = presentation.subarray(0, 3);
    const bottomRight = presentation.subarray((width * height - 1) * 3, width * height * 3);

    expect(LIDE_400_PRESENTATION_ROTATION_DEGREES).toBe(180);
    expect(CANON_LIDE_400_PROFILE.presentationRotationDegrees).toBe(180);
    expect(topLeft[2]).toBeGreaterThan(topLeft[0]);
    expect(bottomRight[0]).toBeGreaterThan(bottomRight[2]);
    expect((await import("node:crypto")).createHash("sha256").update(source).digest("hex")).toBe(sourceDigest);
  });

  it("recognises the verified session profile provenance stored by both staged and compatibility finalisation", () => {
    const ingest = readFileSync(path.join(process.cwd(), "server/scan-ingest-service.ts"), "utf8");
    expect(ingest).toContain("capture_metadata->>'scannerProfileVersion'");
    expect(ingest).toContain("capture_metadata->>'profileVersion'");
    expect(ingest).toContain("COALESCE(");
  });
});
