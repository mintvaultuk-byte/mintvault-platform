/**
 * WHICH EVIDENCE FLOOR APPLIES TO THIS CAPTURE, AND WHY.
 *
 * The fleet floor is 4.0 mm. ONE configuration is qualified for less: the Shop 0 staging station,
 * whose 33 physical trials on 2026-08-21 proved a repeatable 1.70 mm minimum perimeter clearance
 * across a flat-modern and a representative older card. Owner decision, 2026-08-22.
 *
 * THIS IS NOT FLEET POLICY AND NOT PRODUCTION POLICY. It is a single named station, on a single
 * named calibration, in staging, and every gate below must pass. Fleet promotion still requires
 * unplug/replug repeatability, multiple physical LiDE 400 units, and the existing 50+ pair campaign
 * — see docs/scanner/SHOP0_STAGING_ACCEPTANCE_BACKLOG.md. Nothing here claims otherwise, and the
 * historical qualification artifact keeps `fullFleetQualificationStillRequired: true`.
 *
 * THE CLIENT CANNOT CHOOSE THIS. No input carries a floor; the caller passes OBSERVATIONS and this
 * function returns the policy. A dishonest station can only fail gates — the lowest floor it can
 * reach by lying is the one already fixed for the one station this covers, and station code,
 * calibration id, calibration status and environment are all read from server-owned state, never
 * from the request.
 *
 * WHERE THE USB AUTHORITY LIVES — NOT HERE, AND DELIBERATELY SO.
 *
 * There is no VID/PID gate in this function. Canon LiDE 400 identity (VID 04A9 / PID 1912) is
 * enforced INSIDE THE NATIVE BRIDGE at capture time: it refuses the operation outright unless that
 * physical USB device is attached ("Physical Canon LiDE 400 USB device (VID 04A9, PID 1912) is not
 * attached"). A capture therefore cannot exist without that check having passed.
 *
 * Adding a server gate over client-supplied VID/PID constants would be strictly weaker theatre: the
 * client would be asserting the outcome of a check it did not perform, and any client able to lie
 * about the numbers is equally able to lie about having checked them. The authority chain is:
 *
 *   approved authenticated station -> supported native LiDE bridge -> native VID/PID enforcement
 *   -> capture possible only from that device -> per-capture model + native platen provenance
 *   -> this resolver -> 1.70 mm
 *
 * Hardening the bridge to report VID/PID/model natively and binding those into accepted evidence is
 * the stronger fleet architecture and is recorded as backlog, NOT implemented here.
 *
 * FAIL CLOSED, UPWARDS ONLY. Any gate that is false, absent or unparseable yields the fleet floor.
 * There is deliberately no path that lowers the floor on missing information.
 */
import { STANDARD_TCG } from "@shared/lide400-capture-profile.cjs";

/** The qualified configuration, in full. Every field is compared exactly. */
export const SHOP0_STAGING_QUALIFICATION = Object.freeze({
  policy: "shop0-pilot-edge-clearance-v1",
  environment: "staging",
  stationCode: "MV-STN-6DIISWMIEU2IKRG4",
  calibrationId: "f7b7fe4f-aefb-423c-a4a5-dc9cec8fabcf",
  scannerProfileVersion: "mintvault-canon-lide-400-v3",
  calibrationVersion: "capture-geometry-v1",
  evidenceMinMarginMm: 1.7,
  /** Driver-declared, in millimetres: 8.5 in x 11.693333333333333 in. */
  platenMm: Object.freeze({ width: 215.9, height: 297.0107 }),
});

/**
 * PLATEN TOLERANCE — ±0.001 mm per axis, and deliberately tiny.
 *
 * `unit.physicalSize` is DECLARED by the driver, not measured optically. Six consecutive
 * ImageCaptureCore reads on the Shop 0 Canon on 2026-08-22 returned 8.5 x 11.693333333333333 inches
 * bit-for-bit identical — observed variance exactly zero. The only real differences are
 * representation artifacts:
 *
 *   8.5 * 25.4 = 215.89999999999998   vs the stored 215.9          ~2e-14 mm
 *   the profile stores 297.0107       vs the actual 297.0106666…   ~3.3e-5 mm
 *
 * 0.001 mm is ~30x the larger artifact and orders of magnitude below any physically different
 * platen. It is NOT derived from detector edge error: that is an optical measurement of a card and
 * shares no error source with a constant the driver reports about itself.
 *
 * NOT FLEET-QUALIFIED. Six reads, one unit, no physical reconnect between them.
 */
export const PLATEN_TOLERANCE_MM = 0.001;

export type Lide400EvidenceObservations = {
  /** Server-owned. From classifyMintVaultRuntimeEnvironment(). */
  environment: string;
  /** Server-owned. partner_stations.station_code. */
  stationCode: string | null;
  /** Server-owned. partner_stations.status. */
  stationStatus: string | null;
  /** Server-owned. partner_stations.current_calibration_id. */
  calibrationId: string | null;
  /** Server-owned. partner_stations.calibration_status. */
  calibrationStatus: string | null;
  /** Server-owned. partner_station_calibrations.scanner_profile_version. */
  calibrationScannerProfileVersion: string | null;
  /** Server-owned. partner_station_calibrations.calibration_version. */
  calibrationVersion: string | null;
  /** Station-reported, validated against the approved alias set by the profile check. */
  scannerModel: string | null;
  /**
   * The platen the NATIVE capture declared, converted to millimetres from the unit the bridge
   * reported alongside it. Never reconstructed from profile constants.
   */
  platenPhysicalSizeMm: { width: number; height: number } | null;
};

export type Lide400EvidencePolicy = {
  evidenceMinMarginMm: number;
  policy: string;
  qualified: boolean;
  /** Every gate that failed, in evaluation order. Empty when qualified. */
  failedGates: string[];
  /** Persisted with accepted evidence so the floor a capture was admitted under stays provable. */
  audit: {
    policy: string;
    evidenceMinMarginMm: number;
    environment: string;
    stationCode: string | null;
    calibrationId: string | null;
    scannerProfileVersion: string | null;
    platenToleranceMm: number | null;
  };
};

const APPROVED_MODELS = new Set(["canoscan lide 400", "canon lide 400", "lide 400"]);

function fleet(environment: string, observations: Lide400EvidenceObservations, failedGates: string[]): Lide400EvidencePolicy {
  return {
    evidenceMinMarginMm: STANDARD_TCG.evidenceMinMarginMm,
    policy: "fleet-default",
    qualified: false,
    failedGates,
    audit: {
      policy: "fleet-default",
      evidenceMinMarginMm: STANDARD_TCG.evidenceMinMarginMm,
      environment,
      stationCode: observations.stationCode,
      calibrationId: observations.calibrationId,
      scannerProfileVersion: observations.calibrationScannerProfileVersion,
      platenToleranceMm: null,
    },
  };
}

export function resolveLide400EvidencePolicy(observations: Lide400EvidenceObservations): Lide400EvidencePolicy {
  const q = SHOP0_STAGING_QUALIFICATION;
  const failed: string[] = [];
  const near = (a: unknown, b: number) => typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= PLATEN_TOLERANCE_MM;

  if (observations.environment !== q.environment) failed.push("environment");
  if (observations.stationCode !== q.stationCode) failed.push("station");
  if (observations.stationStatus !== "ACTIVE") failed.push("station_status");
  if (observations.calibrationId !== q.calibrationId) failed.push("calibration");
  if (observations.calibrationStatus !== "VALID") failed.push("calibration_status");
  if (observations.calibrationScannerProfileVersion !== q.scannerProfileVersion) failed.push("scanner_profile_version");
  if (observations.calibrationVersion !== q.calibrationVersion) failed.push("calibration_version");
  if (!observations.scannerModel || !APPROVED_MODELS.has(observations.scannerModel.trim().toLowerCase())) {
    failed.push("scanner_model");
  }
  const platen = observations.platenPhysicalSizeMm;
  if (!platen || !near(platen.width, q.platenMm.width) || !near(platen.height, q.platenMm.height)) {
    failed.push("platen_geometry");
  }

  if (failed.length > 0) return fleet(observations.environment, observations, failed);

  return {
    evidenceMinMarginMm: q.evidenceMinMarginMm,
    policy: q.policy,
    qualified: true,
    failedGates: [],
    audit: {
      policy: q.policy,
      evidenceMinMarginMm: q.evidenceMinMarginMm,
      environment: observations.environment,
      stationCode: observations.stationCode,
      calibrationId: observations.calibrationId,
      scannerProfileVersion: observations.calibrationScannerProfileVersion,
      platenToleranceMm: PLATEN_TOLERANCE_MM,
    },
  };
}


/**
 * Convert the platen the NATIVE bridge reported into millimetres, using the unit it reported
 * alongside it.
 *
 * The same ImageCaptureCore property yields different numbers depending on when it is read: the
 * scan path sets `measurementUnit` to CENTIMETRES, while an unconfigured capabilities probe reports
 * INCHES. The bridge therefore emits the raw pair plus its unit and the conversion happens here,
 * once, where it can be tested.
 *
 * Anything unrecognised returns null, which fails the platen gate and drops to the fleet floor.
 * There is no guessing between units: trying each in turn until one matched the expected platen
 * would defeat the point of having a gate.
 */
export function nativePlatenToMm(
  reported: { width?: unknown; height?: unknown; unit?: unknown } | null | undefined
): { width: number; height: number } | null {
  if (!reported || typeof reported !== "object") return null;
  const width = Number(reported.width);
  const height = Number(reported.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = reported.unit === "inches" ? 25.4 : reported.unit === "centimeters" ? 10 : null;
  if (scale === null) return null;
  return { width: width * scale, height: height * scale };
}
