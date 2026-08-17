/**
 * THE SERVER'S CAPTURE-GEOMETRY AUTHORITY.
 *
 * Decides, on the server, which physical rectangle a capture was allowed to use — and refuses to let
 * a station tell it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES. Evidence validation took its acquisition rectangle from
 * `provenance.scanAreaMm`, a station-supplied number. That was survivable only while every station
 * used the same hard-coded window: `assertLide400Evidence` pinned the SIZE against a server constant,
 * and the margin verdict depends on size alone, so a lying client could not move the 4 mm floor.
 *
 * A MOVABLE window ends that. Once each station has its own origin, a declared origin is a number in
 * the immutable evidence record that nothing verifies, and "validate it is somewhere on the platen"
 * is not authority — it accepts 20,20 from a station calibrated to 60,40 without noticing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CHAIN, and it must be complete or the capture is refused:
 *
 *   partner_stations.current_calibration_id
 *     -> partner_station_calibrations row (health VALID, matching profile version, same station)
 *       -> acquisition_region  = THE authoritative rectangle
 *         -> SNAPSHOT onto the capture session when it is ARMED
 *           -> evidence validation uses the SNAPSHOT, never the upload's provenance
 *
 * WHY SNAPSHOT RATHER THAN LOOK UP LATE. A recalibration between arming a side and uploading it
 * would otherwise silently re-interpret a capture that has already physically happened. The snapshot
 * makes calibration history immutable for work in flight: a capture is validated against the geometry
 * it was armed under, and a later recalibration applies to later sessions. It also keeps the evidence
 * hot path free of an extra query — the region is already on the session row it must load anyway.
 *
 * The client's declared `scanAreaMm` is still checked, but only for AGREEMENT with the snapshot. It
 * is never the source.
 */
import { STANDARD_TCG, PLATEN_MM, MIN_PLATEN_INSET_MM } from "@shared/lide400-capture-profile.cjs";

export type AcquisitionRegionMm = { x: number; y: number; width: number; height: number };

/** A calibration as stored, in the shape the station tables return it. */
export type StationCalibrationRow = {
  id: string | null;
  stationId: string | null;
  healthStatus: string | null;
  scannerProfileVersion: string | null;
  calibrationVersion: string | null;
  acquisitionRegion: unknown;
};

export class CaptureGeometryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CaptureGeometryError";
    this.code = code;
  }
}

const TOLERANCE_MM = 0.001;

function finiteRegion(value: unknown): AcquisitionRegionMm | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = Number(source[key]);
    if (!Number.isFinite(number)) return null;
    out[key] = number;
  }
  return out as AcquisitionRegionMm;
}

/**
 * Validate a stored calibration and return its authoritative acquisition rectangle.
 *
 * FAILS CLOSED on every count. An unprovisioned, invalid, expired, foreign-station or wrong-profile
 * calibration yields no geometry at all, which means no capture — not a fallback to a default window.
 * A default window is exactly how a station with no valid calibration would quietly keep scanning.
 */
export function resolveAuthoritativeAcquisitionRegion(
  calibration: StationCalibrationRow | null | undefined,
  expected: { stationId: string; scannerProfileVersion: string }
): AcquisitionRegionMm {
  if (!calibration || !calibration.id) {
    throw new CaptureGeometryError(
      "calibration_missing",
      "This station has no current calibration; move and save the capture window before scanning"
    );
  }
  if (calibration.healthStatus !== "VALID") {
    throw new CaptureGeometryError(
      "calibration_not_valid",
      `This station's calibration is ${String(calibration.healthStatus || "UNPROVISIONED")}; recalibrate the capture window before scanning`
    );
  }
  /*
   * The calibration must belong to THIS station. Without this, a calibration id from another station
   * — or another tenant — could supply the geometry a capture is judged against.
   */
  if (!calibration.stationId || calibration.stationId !== expected.stationId) {
    throw new CaptureGeometryError(
      "calibration_station_mismatch",
      "The calibration offered for this capture belongs to a different station"
    );
  }
  if (calibration.scannerProfileVersion !== expected.scannerProfileVersion) {
    throw new CaptureGeometryError(
      "calibration_profile_mismatch",
      `This station's calibration is for scanner profile ${String(calibration.scannerProfileVersion)}, not ${expected.scannerProfileVersion}`
    );
  }
  const region = finiteRegion(calibration.acquisitionRegion);
  if (!region) {
    throw new CaptureGeometryError(
      "calibration_region_invalid",
      "This station's calibration does not contain a usable acquisition region"
    );
  }
  return assertLegalCaptureWindow(region);
}

/**
 * A rectangle is only a legal capture window if it is the profile's window SIZE at a position wholly
 * on the platen, clear of the bezel inset. Checked even for a stored calibration: a row written by an
 * older build, or edited by hand, must not become geometry the evidence path trusts.
 */
export function assertLegalCaptureWindow(region: AcquisitionRegionMm): AcquisitionRegionMm {
  const profileWindow = STANDARD_TCG.outerWindowMm;
  if (
    Math.abs(region.width - profileWindow.width) > TOLERANCE_MM ||
    Math.abs(region.height - profileWindow.height) > TOLERANCE_MM
  ) {
    throw new CaptureGeometryError(
      "region_size_mismatch",
      `Capture window must be ${profileWindow.width} x ${profileWindow.height} mm; calibration says ${region.width} x ${region.height} mm`
    );
  }
  const maxX = PLATEN_MM.width - profileWindow.width - MIN_PLATEN_INSET_MM;
  const maxY = PLATEN_MM.height - profileWindow.height - MIN_PLATEN_INSET_MM;
  if (
    region.x < MIN_PLATEN_INSET_MM - TOLERANCE_MM ||
    region.x > maxX + TOLERANCE_MM ||
    region.y < MIN_PLATEN_INSET_MM - TOLERANCE_MM ||
    region.y > maxY + TOLERANCE_MM
  ) {
    throw new CaptureGeometryError(
      "region_off_platen",
      `Capture window origin ${region.x}, ${region.y} mm is not a valid position on the platen ` +
        `(X ${MIN_PLATEN_INSET_MM}-${maxX} mm, Y ${MIN_PLATEN_INSET_MM}-${maxY} mm)`
    );
  }
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

/**
 * The rectangle a capture must be validated against: the session's own snapshot.
 *
 * A session armed before this build carries no snapshot. That is refused rather than defaulted,
 * because "we do not know which rectangle this station was using" and "assume the standard one" are
 * different statements and only the first is true. The station re-arms and gets a snapshot.
 */
export function authoritativeRegionForSession(session: {
  acquisitionRegion?: unknown;
  calibrationId?: string | null;
}): AcquisitionRegionMm {
  const region = finiteRegion(session.acquisitionRegion);
  if (!region) {
    throw new CaptureGeometryError(
      "session_region_missing",
      "This capture session carries no authoritative capture window; re-arm this card side"
    );
  }
  return assertLegalCaptureWindow(region);
}

/**
 * The station's declared rectangle must AGREE with the authority; it never replaces it.
 *
 * A mismatch means the hardware scanned something other than what this station is calibrated for —
 * a stale local config, a hand-edited station file, or a forged upload. All three are refusals, and
 * the message names both rectangles so the cause is diagnosable rather than mysterious.
 */
export function assertDeclaredRegionMatchesAuthority(declared: unknown, authority: AcquisitionRegionMm): void {
  const region = finiteRegion(declared);
  if (!region) {
    throw new CaptureGeometryError("declared_region_invalid", "Capture provenance does not contain a usable scan area");
  }
  for (const key of ["x", "y", "width", "height"] as const) {
    if (Math.abs(region[key] - authority[key]) > 0.5) {
      throw new CaptureGeometryError(
        "declared_region_mismatch",
        `Capture reports a scan area of ${region.x}, ${region.y}, ${region.width} x ${region.height} mm but this station ` +
          `is calibrated to ${authority.x}, ${authority.y}, ${authority.width} x ${authority.height} mm`
      );
    }
  }
}
