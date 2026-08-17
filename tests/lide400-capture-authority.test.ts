/**
 * THE SERVER'S CAPTURE-GEOMETRY AUTHORITY — the ten invariants required before staging.
 *
 * The question these answer is: which physical rectangle was a capture allowed to use, and who got
 * to decide. The answer must be the station's own saved calibration, snapshotted when the side was
 * armed — never the number the uploading station puts in its provenance.
 *
 * Deliberately hermetic. The authority is a pure function over a calibration row and a session row,
 * so every failure mode is provable without a database; the DB's only job is to carry those rows,
 * and a rule that only holds when a test database happens to be configured is a rule that silently
 * stops being tested.
 */
import { describe, expect, it } from "vitest";
import {
  resolveAuthoritativeAcquisitionRegion,
  authoritativeRegionForSession,
  assertDeclaredRegionMatchesAuthority,
  assertLegalCaptureWindow,
  CaptureGeometryError,
  type StationCalibrationRow,
} from "../server/lib/lide400-capture-authority";
import { STANDARD_TCG } from "@shared/lide400-capture-profile.cjs";

const STATION_A = "11111111-1111-4111-8111-111111111111";
const STATION_B = "22222222-2222-4222-8222-222222222222";
const PROFILE = STANDARD_TCG.scannerProfileVersion;
const REGION_20_20 = { x: 20, y: 20, width: 100, height: 130 };
const REGION_60_40 = { x: 60, y: 40, width: 100, height: 130 };

const calibration = (over: Partial<StationCalibrationRow> = {}): StationCalibrationRow => ({
  id: "cal-1",
  stationId: STATION_A,
  healthStatus: "VALID",
  scannerProfileVersion: PROFILE,
  calibrationVersion: STANDARD_TCG.version,
  acquisitionRegion: REGION_20_20,
  ...over,
});
const expected = { stationId: STATION_A, scannerProfileVersion: PROFILE };

describe("TEST 1 — a station calibrated to (20,20,100,130) yields exactly that region", () => {
  it("resolves the saved region verbatim", () => {
    expect(resolveAuthoritativeAcquisitionRegion(calibration(), expected)).toEqual(REGION_20_20);
  });

  it("resolves a DIFFERENT station's own origin, proving the region is read and not assumed", () => {
    // If the code were quietly returning a default window, this would still say 20,20.
    expect(resolveAuthoritativeAcquisitionRegion(calibration({ acquisitionRegion: REGION_60_40 }), expected)).toEqual(
      REGION_60_40
    );
  });
});

describe("TEST 2 — evidence validates against the session's server-owned snapshot", () => {
  it("takes the region from the session row", () => {
    expect(authoritativeRegionForSession({ acquisitionRegion: REGION_60_40, calibrationId: "cal-1" })).toEqual(
      REGION_60_40
    );
  });

  it("REFUSES a session with no snapshot instead of assuming the standard window", () => {
    /*
     * A session armed before this build. "We do not know which rectangle that station used" and
     * "assume the usual one" are different statements and only the first is true, so the operator
     * re-arms rather than having geometry invented for a scan that already happened.
     */
    const fail = () => authoritativeRegionForSession({ acquisitionRegion: null, calibrationId: null });
    expect(fail).toThrow(CaptureGeometryError);
    expect(fail).toThrow(/carries no authoritative capture window/);
  });

  it("refuses a snapshot that is not a usable rectangle", () => {
    expect(() => authoritativeRegionForSession({ acquisitionRegion: { x: 20, y: 20 } })).toThrow(/no authoritative/);
    expect(() => authoritativeRegionForSession({ acquisitionRegion: "20,20,100,130" })).toThrow(/no authoritative/);
  });
});

describe("TEST 3 — a client-submitted alternative origin is refused", () => {
  it("refuses an upload declaring a different origin from the station's calibration", () => {
    const fail = () => assertDeclaredRegionMatchesAuthority(REGION_20_20, REGION_60_40);
    expect(fail).toThrow(CaptureGeometryError);
    expect(fail).toThrow(/but this station is calibrated to/);
  });

  it("refuses an upload declaring a different window SIZE", () => {
    expect(() => assertDeclaredRegionMatchesAuthority({ x: 20, y: 20, width: 120, height: 130 }, REGION_20_20)).toThrow(
      /calibrated to/
    );
  });

  it("accepts a declaration that agrees, because agreement is all it is ever asked for", () => {
    expect(() => assertDeclaredRegionMatchesAuthority(REGION_20_20, REGION_20_20)).not.toThrow();
  });

  it("refuses a missing or malformed declaration rather than treating it as agreement", () => {
    expect(() => assertDeclaredRegionMatchesAuthority(null, REGION_20_20)).toThrow(
      /does not contain a usable scan area/
    );
    expect(() => assertDeclaredRegionMatchesAuthority({ x: 20 }, REGION_20_20)).toThrow(/usable scan area/);
  });

  it("cannot be satisfied by a declaration that merely LOOKS legal", () => {
    // The old rule — "is this origin somewhere sensible on the platen" — passes this. The authority
    // check does not, and that difference is the entire point of this module.
    expect(() => assertLegalCaptureWindow(REGION_20_20)).not.toThrow();
    expect(() => assertDeclaredRegionMatchesAuthority(REGION_20_20, REGION_60_40)).toThrow();
  });
});

describe("TEST 4 — station A cannot use station B's calibration", () => {
  it("refuses a calibration belonging to another station", () => {
    const fail = () => resolveAuthoritativeAcquisitionRegion(calibration({ stationId: STATION_B }), expected);
    expect(fail).toThrow(CaptureGeometryError);
    expect(fail).toThrow(/belongs to a different station/);
  });

  it("refuses a calibration with no station at all", () => {
    expect(() => resolveAuthoritativeAcquisitionRegion(calibration({ stationId: null }), expected)).toThrow(
      /different station/
    );
  });
});

describe("TEST 5 — an invalid or unprovisioned calibration fails closed", () => {
  it("refuses when there is no calibration", () => {
    const fail = () => resolveAuthoritativeAcquisitionRegion(null, expected);
    expect(fail).toThrow(/no current calibration/);
  });

  it("refuses when current_calibration_id is absent", () => {
    expect(() => resolveAuthoritativeAcquisitionRegion(calibration({ id: null }), expected)).toThrow(
      /no current calibration/
    );
  });

  it("requires health status VALID", () => {
    for (const status of ["INVALID", "EXPIRED", "UNPROVISIONED", null]) {
      expect(() => resolveAuthoritativeAcquisitionRegion(calibration({ healthStatus: status }), expected)).toThrow(
        /recalibrate the capture window/
      );
    }
  });

  it("refuses a calibration whose region is absent or unusable", () => {
    expect(() => resolveAuthoritativeAcquisitionRegion(calibration({ acquisitionRegion: null }), expected)).toThrow(
      /does not contain a usable acquisition region/
    );
  });

  it("refuses a stored region at the platen ORIGIN, where the bezel band is", () => {
    // The live station's old (0,0) calibration must not become authoritative geometry either.
    expect(() =>
      resolveAuthoritativeAcquisitionRegion(
        calibration({ acquisitionRegion: { x: 0, y: 0, width: 100, height: 130 } }),
        expected
      )
    ).toThrow(/not a valid position on the platen/);
  });

  it("refuses a stored region of the wrong size, however it got there", () => {
    expect(() =>
      resolveAuthoritativeAcquisitionRegion(
        calibration({ acquisitionRegion: { x: 20, y: 20, width: 216, height: 297 } }),
        expected
      )
    ).toThrow(/Capture window must be 100 x 130 mm/);
  });
});

describe("TEST 6 — a profile mismatch fails closed", () => {
  it("refuses a calibration recorded for a different scanner profile", () => {
    const fail = () =>
      resolveAuthoritativeAcquisitionRegion(
        calibration({ scannerProfileVersion: "mintvault-canon-lide-400-v2" }),
        expected
      );
    expect(fail).toThrow(CaptureGeometryError);
    expect(fail).toThrow(/not mintvault-canon-lide-400-v3/);
  });
});

describe("TESTS 7-9 — recalibration history is immutable for work in flight", () => {
  /*
   * The snapshot IS the mechanism. These prove the property the snapshot exists to give: a session
   * validates against the geometry it was armed under, no matter what the station's calibration says
   * later, while a session armed afterwards picks up the new one.
   */
  it("TEST 7 — a session armed before a recalibration keeps its old snapshot", () => {
    const armedSession = { acquisitionRegion: REGION_20_20, calibrationId: "cal-1" };
    // The station recalibrates to a completely different part of the platen...
    const afterRecalibration = calibration({ id: "cal-2", acquisitionRegion: REGION_60_40 });
    expect(resolveAuthoritativeAcquisitionRegion(afterRecalibration, expected)).toEqual(REGION_60_40);
    // ...and the in-flight session is entirely unaffected.
    expect(authoritativeRegionForSession(armedSession)).toEqual(REGION_20_20);
  });

  it("TEST 8 — a session armed after a recalibration gets the new region", () => {
    const newSession = {
      acquisitionRegion: resolveAuthoritativeAcquisitionRegion(
        calibration({ id: "cal-2", acquisitionRegion: REGION_60_40 }),
        expected
      ),
      calibrationId: "cal-2",
    };
    expect(authoritativeRegionForSession(newSession)).toEqual(REGION_60_40);
  });

  it("TEST 9 — a restart cannot change a session's authoritative region", () => {
    // The snapshot lives on the session row, so recovery re-reads the same bytes. Round-tripped
    // through JSON exactly as the database would carry it.
    const persisted = JSON.parse(JSON.stringify({ acquisitionRegion: REGION_20_20, calibrationId: "cal-1" }));
    expect(authoritativeRegionForSession(persisted)).toEqual(REGION_20_20);
  });

  it("an upload for an in-flight session must still agree with the OLD snapshot, not the new calibration", () => {
    const inFlight = authoritativeRegionForSession({ acquisitionRegion: REGION_20_20 });
    // A station that has already re-read its new local config would declare 60,40 — and be refused,
    // because the card on the glass was armed against 20,20.
    expect(() => assertDeclaredRegionMatchesAuthority(REGION_60_40, inFlight)).toThrow(/calibrated to/);
    expect(() => assertDeclaredRegionMatchesAuthority(REGION_20_20, inFlight)).not.toThrow();
  });
});

describe("TEST 10 — the 4 mm floor is untouched by any of this", () => {
  it("keeps the evidence floor at 4 mm and the operator zone at 10 mm", async () => {
    const { LIDE_400_MIN_EVIDENCE_MARGIN_MM } = await import("../server/lib/lide400-card-frame");
    expect(LIDE_400_MIN_EVIDENCE_MARGIN_MM).toBe(4);
    expect(STANDARD_TCG.operatorInsetMm).toBe(10);
  });

  it("independently rejects a sub-4 mm capture measured against the authoritative region", async () => {
    /*
     * End to end at a NON-ZERO origin: the authority supplies 20,20,100,130, the detector re-derives
     * the card from real-shaped pixels, and the margin rule refuses it. The origin changes where the
     * window sits on the glass; it cannot change what counts as enough background inside it.
     */
    const sharp = (await import("sharp")).default;
    const { assessLide400CardFrame } = await import("../server/lib/lide400-card-frame");
    const frame = { width: 900, height: 1170, channels: 3 as const };
    const pixels = Buffer.alloc(frame.width * frame.height * 3, 233);
    // A real-sized card 1.5 mm from the left edge — below the floor.
    const left = Math.round((1.5 / 100) * frame.width);
    const top = Math.round((20 / 130) * frame.height);
    const cardW = Math.round((63.5 / 100) * frame.width);
    const cardH = Math.round((88.9 / 130) * frame.height);
    for (let y = top; y < top + cardH; y++) {
      for (let x = left; x < left + cardW; x++) {
        const offset = (y * frame.width + x) * 3;
        pixels[offset] = 20;
        pixels[offset + 1] = 80;
        pixels[offset + 2] = 150;
      }
    }
    const buffer = await sharp(pixels, { raw: frame }).tiff().withMetadata({ density: 1200 }).toBuffer();

    const authority = authoritativeRegionForSession({ acquisitionRegion: REGION_20_20 });
    const assessment = await assessLide400CardFrame(buffer, frame, authority);
    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toMatch(/4 mm required/);
  });

  it("accepts a well-placed card through the same non-zero-origin authority", async () => {
    const sharp = (await import("sharp")).default;
    const { assessLide400CardFrame } = await import("../server/lib/lide400-card-frame");
    const frame = { width: 900, height: 1170, channels: 3 as const };
    const pixels = Buffer.alloc(frame.width * frame.height * 3, 233);
    const left = Math.round((18.25 / 100) * frame.width);
    const top = Math.round((20.55 / 130) * frame.height);
    const cardW = Math.round((63.5 / 100) * frame.width);
    const cardH = Math.round((88.9 / 130) * frame.height);
    for (let y = top; y < top + cardH; y++) {
      for (let x = left; x < left + cardW; x++) {
        const offset = (y * frame.width + x) * 3;
        pixels[offset] = 20;
        pixels[offset + 1] = 80;
        pixels[offset + 2] = 150;
      }
    }
    const buffer = await sharp(pixels, { raw: frame }).tiff().withMetadata({ density: 1200 }).toBuffer();
    const authority = authoritativeRegionForSession({ acquisitionRegion: REGION_20_20 });
    const assessment = await assessLide400CardFrame(buffer, frame, authority);
    expect(assessment.accepted, assessment.reason || "").toBe(true);
    expect(Math.min(...Object.values(assessment.evidenceMarginMm!))).toBeGreaterThan(4);
  });
});
