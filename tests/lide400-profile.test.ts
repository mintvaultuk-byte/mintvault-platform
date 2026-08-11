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
});
