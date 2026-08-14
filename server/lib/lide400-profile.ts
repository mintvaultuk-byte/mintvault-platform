import type { ScannerEvidenceInspection } from "./image-evidence";
import { LIDE_400_PRESENTATION_ROTATION_DEGREES } from "./lide400-presentation";

/**
 * The only production profile accepted from the LiDE control bridge.  The
 * hardware capture rectangle is deliberately a generous 100 x 130 mm station
 * window rather than an A4 platen. It remains below the evidence decoder
 * ceiling at 1200 DPI and intentionally does not require a card to be placed
 * with millimetre precision. Card working geometry is a separate boundary
 * assessment that must retain evidence margin on all four sides.
 *
 * `originMm` is station provisioning data, never an operator control.  It is
 * supplied to ImageCaptureCore from the protected scanner env file and is not
 * persisted as a user preference.
 */
export const CANON_LIDE_400_PROFILE = Object.freeze({
  version: "mintvault-canon-lide-400-v3",
  manufacturer: "Canon",
  model: "CanoScan LiDE 400",
  resolutionDpi: 1200,
  colourMode: "rgb",
  bitDepth: 8,
  outputFormat: "tiff",
  // Presentation derivatives only. The immutable TIFF keeps its exact
  // scanner-produced bytes and orientation for provenance.
  presentationRotationDegrees: LIDE_400_PRESENTATION_ROTATION_DEGREES,
  areaMm: Object.freeze({ width: 100, height: 130 }),
  // Actual ICA output can differ by a few pixels because the driver rounds the
  // physical rectangle to native sensor coordinates.  This is a geometry check
  // in addition to (never instead of) decoded DPI metadata.
  expectedPixels: Object.freeze({ minWidth: 4550, maxWidth: 4900, minHeight: 5950, maxHeight: 6350 }),
});

// Canon's ICA modules use more than one exact display name for this device.
// These are intentionally enumerated, rather than weakened to a vendor/model
// substring check, so stored provenance retains the driver-reported name.
const APPROVED_LIDE_400_MODELS = new Set(["canoscan lide 400", "canon lide 400", "lide 400"]);

export type Lide400CaptureProvenance = {
  profileVersion: string;
  scannerManufacturer: string;
  scannerModel: string;
  scannerDeviceId: string;
  scannerSerial: string | null;
  workstationId: string;
  requestedDpi: number;
  driverResolutionDpi: number;
  scanAreaMm: { x: number; y: number; width: number; height: number };
  captureStartedAt: string;
  captureCompletedAt: string;
  profileRevisionId: string | null;
  profileDigestSha256: string | null;
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Reject missing/spoofable-looking bridge provenance before an immutable row exists. */
export function parseLide400CaptureProvenance(input: unknown): Lide400CaptureProvenance {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("LiDE 400 capture provenance is required");
  const value = input as Record<string, unknown>;
  const requiredText = (name: keyof Lide400CaptureProvenance): string => {
    const raw = value[name];
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`LiDE 400 provenance ${String(name)} is required`);
    return raw.trim();
  };
  const requestedDpi = value.requestedDpi;
  const driverResolutionDpi = value.driverResolutionDpi;
  const scanAreaMm = value.scanAreaMm;
  if (!finiteNumber(requestedDpi) || !finiteNumber(driverResolutionDpi))
    throw new Error("LiDE 400 DPI provenance is invalid");
  if (!scanAreaMm || typeof scanAreaMm !== "object" || Array.isArray(scanAreaMm)) {
    throw new Error("LiDE 400 scan area provenance is required");
  }
  const area = scanAreaMm as Record<string, unknown>;
  if (
    !finiteNumber(area.x) ||
    !finiteNumber(area.y) ||
    !finiteNumber(area.width) ||
    !finiteNumber(area.height) ||
    area.x < 0 ||
    area.y < 0
  ) {
    throw new Error("LiDE 400 scan area provenance is invalid");
  }
  return {
    profileVersion: requiredText("profileVersion"),
    scannerManufacturer: requiredText("scannerManufacturer"),
    scannerModel: requiredText("scannerModel"),
    scannerDeviceId: requiredText("scannerDeviceId"),
    scannerSerial:
      typeof value.scannerSerial === "string" && value.scannerSerial.trim() ? value.scannerSerial.trim() : null,
    workstationId: requiredText("workstationId"),
    requestedDpi,
    driverResolutionDpi,
    scanAreaMm: { x: area.x, y: area.y, width: area.width, height: area.height },
    captureStartedAt: requiredText("captureStartedAt"),
    captureCompletedAt: requiredText("captureCompletedAt"),
    profileRevisionId:
      typeof value.profileRevisionId === "string" && value.profileRevisionId.trim()
        ? value.profileRevisionId.trim()
        : null,
    profileDigestSha256:
      typeof value.profileDigestSha256 === "string" && /^[a-f0-9]{64}$/.test(value.profileDigestSha256)
        ? value.profileDigestSha256
        : null,
  };
}

/**
 * Profile validation intentionally uses three independent signals: the locked
 * bridge request, the driver-reported applied resolution, and decoded geometry.
 * TIFF density is useful corroboration but cannot alone make a capture valid.
 */
export function assertLide400Evidence(
  inspection: ScannerEvidenceInspection,
  provenance: Lide400CaptureProvenance
): void {
  const profile = CANON_LIDE_400_PROFILE;
  if (provenance.profileVersion !== profile.version) throw new Error("Unsupported scanner profile version");
  if (provenance.scannerManufacturer.toLowerCase() !== profile.manufacturer.toLowerCase()) {
    throw new Error("Capture was not reported by the approved Canon scanner");
  }
  if (!APPROVED_LIDE_400_MODELS.has(provenance.scannerModel.toLowerCase())) {
    throw new Error("Capture was not reported by a Canon CanoScan LiDE 400");
  }
  if (provenance.requestedDpi !== profile.resolutionDpi || provenance.driverResolutionDpi !== profile.resolutionDpi) {
    throw new Error(`LiDE 400 capture must request and apply ${profile.resolutionDpi} DPI`);
  }
  if (provenance.scanAreaMm.width !== profile.areaMm.width || provenance.scanAreaMm.height !== profile.areaMm.height) {
    throw new Error("LiDE 400 capture does not use the locked MintVault acquisition area");
  }
  if (inspection.evidenceClass !== "NEW_IMMUTABLE_MASTER" || inspection.format !== "tiff") {
    throw new Error("LiDE 400 capture must be an original TIFF master");
  }
  if (inspection.dpi !== profile.resolutionDpi) {
    throw new Error(`Decoded TIFF density must be ${profile.resolutionDpi} DPI`);
  }
  const p = profile.expectedPixels;
  if (
    inspection.width < p.minWidth ||
    inspection.width > p.maxWidth ||
    inspection.height < p.minHeight ||
    inspection.height > p.maxHeight
  ) {
    throw new Error("LiDE 400 TIFF dimensions do not match the locked card-region capture");
  }
  if (inspection.channels !== 3 || inspection.colourSpace !== "srgb") {
    throw new Error("LiDE 400 capture must decode as RGB colour evidence");
  }
}
