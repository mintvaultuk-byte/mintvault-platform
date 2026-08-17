import type { ScannerEvidenceInspection } from "./image-evidence";
import { LIDE_400_PRESENTATION_ROTATION_DEGREES } from "./lide400-presentation";
import { STANDARD_TCG, PLATEN_MM, MIN_PLATEN_INSET_MM } from "@shared/lide400-capture-profile.cjs";

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
  // Sourced from the canonical capture profile the Scanner requests its rectangle from, so the
  // station and the server can never hold two different ideas of how big the capture window is.
  areaMm: STANDARD_TCG.outerWindowMm,
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
  /*
   * A CHEAP SHAPE CHECK ON THE DECLARED ORIGIN — NOT THE AUTHORITY.
   *
   * The authority is `lide400-capture-authority`: the acquisition rectangle snapshotted onto the
   * capture session from the station's current VALID calibration, which the evidence path uses
   * INSTEAD of anything in this provenance. The declared origin is separately required to agree with
   * that snapshot.
   *
   * This check stays because it is free and it rejects a structurally impossible claim early, with a
   * clearer message than a mismatch against a specific station's window would give. It must never be
   * mistaken for the thing that makes the origin trustworthy — on its own it would happily accept
   * 20,20 from a station calibrated to 60,40.
   */
  const { x, y } = provenance.scanAreaMm;
  const maxX = PLATEN_MM.width - profile.areaMm.width - MIN_PLATEN_INSET_MM;
  const maxY = PLATEN_MM.height - profile.areaMm.height - MIN_PLATEN_INSET_MM;
  if (x < MIN_PLATEN_INSET_MM || x > maxX || y < MIN_PLATEN_INSET_MM || y > maxY) {
    throw new Error(
      `LiDE 400 capture window origin ${x}, ${y} mm is not a valid position on the platen ` +
        `(X ${MIN_PLATEN_INSET_MM}-${maxX} mm, Y ${MIN_PLATEN_INSET_MM}-${maxY} mm)`
    );
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
  /*
   * THREE COLOUR CHANNELS, IN sRGB. The requirement is unchanged; how it is measured is corrected.
   *
   * THE DEFECT. This asked for `channels === 3`, and the approved scanner does not produce that.
   * A Canon LiDE 400 driven through Apple Image Capture emits a genuine RGB TIFF with an ASSOCIATED
   * ALPHA extra-sample — `Photometric Interpretation: RGB color`, `Samples/Pixel: 4`,
   * `Extra Samples: 1 <assoc-alpha>`, 8 bits/sample, LZW, ICC profile present. Its colour data is
   * exactly the three RGB channels the rule demands; the fourth sample is an opaque alpha the driver
   * always attaches. Counting raw samples therefore rejected the only hardware this profile approves,
   * and it did so AFTER a 57-second physical scan — the operator was told their genuine colour
   * capture was not colour evidence.
   *
   * NOT A RELAXATION. Subtracting a declared alpha channel measures the COLOUR channels, which is
   * what "RGB colour evidence" has always meant, and every non-colour model is still refused by the
   * same arithmetic: greyscale (1) fails, greyscale+alpha (2−1=1) fails, CMYK (4, no alpha) fails,
   * and a palette or CMYK image cannot pass by having four samples. The sRGB space check is
   * untouched, so a correctly-sampled image in the wrong colour space is still refused.
   */
  const colourChannels = (inspection.channels ?? 0) - (inspection.hasAlpha ? 1 : 0);
  if (colourChannels !== 3 || inspection.colourSpace !== "srgb") {
    throw new Error("LiDE 400 capture must decode as RGB colour evidence");
  }
}
