/**
 * THE NARROW SHOP 0 1.70 MM STAGING AUTHORITY.
 *
 * Owner decision 2026-08-22: one station, one calibration, staging only, 1.70 mm. Everything else
 * keeps the fleet floor. These tests exist to make "narrow" mechanical rather than aspirational.
 */
import { describe, expect, it } from "vitest";
import {
  resolveLide400EvidencePolicy,
  SHOP0_STAGING_QUALIFICATION as Q,
  PLATEN_TOLERANCE_MM,
  type Lide400EvidenceObservations,
} from "../server/lib/lide400-evidence-policy";
import { STANDARD_TCG } from "@shared/lide400-capture-profile.cjs";

const FLEET = STANDARD_TCG.evidenceMinMarginMm;

/** The exact qualified Shop 0 configuration, as the server observes it. */
const qualified = (over: Partial<Lide400EvidenceObservations> = {}): Lide400EvidenceObservations => ({
  environment: "staging",
  stationCode: Q.stationCode,
  stationStatus: "ACTIVE",
  calibrationId: Q.calibrationId,
  calibrationStatus: "VALID",
  calibrationScannerProfileVersion: Q.scannerProfileVersion,
  calibrationVersion: Q.calibrationVersion,
  scannerModel: "Canon LiDE 400",
  usbVendorId: 0x04a9,
  usbProductId: 0x1912,
  platenPhysicalSizeMm: { width: 215.9, height: 297.0107 },
  ...over,
});

describe("the qualified Shop 0 configuration resolves to 1.70 mm", () => {
  it("applies 1.70 mm when every gate passes", () => {
    const p = resolveLide400EvidencePolicy(qualified());
    expect(p.qualified).toBe(true);
    expect(p.evidenceMinMarginMm).toBe(1.7);
    expect(p.policy).toBe("shop0-pilot-edge-clearance-v1");
    expect(p.failedGates).toEqual([]);
  });

  it("carries enough audit authority to prove the floor later", () => {
    const { audit } = resolveLide400EvidencePolicy(qualified());
    expect(audit).toMatchObject({
      policy: "shop0-pilot-edge-clearance-v1",
      evidenceMinMarginMm: 1.7,
      environment: "staging",
      stationCode: Q.stationCode,
      calibrationId: Q.calibrationId,
      scannerProfileVersion: Q.scannerProfileVersion,
      platenToleranceMm: PLATEN_TOLERANCE_MM,
    });
  });
});

describe("boundary — the qualified floor is exactly 1.70 mm", () => {
  const floor = resolveLide400EvidencePolicy(qualified()).evidenceMinMarginMm;
  // The admission rule is `closestMargin < floor -> refuse`, applied in lide400-card-frame.
  const admits = (marginMm: number) => !(marginMm < floor);

  it.each([
    [1.699, false],
    [1.7, true],
    [1.8, true],
    [3.9, true],
  ])("a %s mm master margin is admitted: %s", (margin, expected) => {
    expect(admits(margin as number)).toBe(expected);
  });
});

describe("every gate fails closed to the fleet floor, never downwards", () => {
  const cases: Array<[string, Partial<Lide400EvidenceObservations>, string]> = [
    ["production runtime", { environment: "production" }, "environment"],
    ["development runtime", { environment: "development" }, "environment"],
    ["a different station", { stationCode: "MV-STN-R2AWFZIBMQ4UXK6F" }, "station"],
    ["no station", { stationCode: null }, "station"],
    ["a suspended station", { stationStatus: "SUSPENDED" }, "station_status"],
    ["a different calibration", { calibrationId: "00000000-0000-4000-8000-000000000000" }, "calibration"],
    ["an unbound calibration", { calibrationId: null }, "calibration"],
    ["an INVALID calibration", { calibrationStatus: "INVALID" }, "calibration_status"],
    ["another scanner profile", { calibrationScannerProfileVersion: "mintvault-canon-lide-400-v2" }, "scanner_profile_version"],
    ["another calibration version", { calibrationVersion: "capture-geometry-v0" }, "calibration_version"],
    ["a different scanner model", { scannerModel: "CanoScan LiDE 300" }, "scanner_model"],
    ["no model at all", { scannerModel: null }, "scanner_model"],
    ["a different USB vendor", { usbVendorId: 0x1234 }, "usb_identity"],
    ["a different USB product", { usbProductId: 0x9999 }, "usb_identity"],
    ["absent USB identity", { usbVendorId: null, usbProductId: null }, "usb_identity"],
    ["absent platen geometry", { platenPhysicalSizeMm: null }, "platen_geometry"],
  ];

  it.each(cases)("%s does not get 1.70 mm", (_label, over, gate) => {
    const p = resolveLide400EvidencePolicy(qualified(over));
    expect(p.qualified).toBe(false);
    expect(p.evidenceMinMarginMm).toBe(FLEET);
    expect(p.failedGates).toContain(gate);
    expect(p.policy).toBe("fleet-default");
  });

  it("production NEVER receives 1.70 mm, even with every other gate perfect", () => {
    const p = resolveLide400EvidencePolicy(qualified({ environment: "production" }));
    expect(p.evidenceMinMarginMm).toBe(FLEET);
    expect(p.evidenceMinMarginMm).toBeGreaterThan(1.7);
  });

  it("a failing gate never yields a floor lower than the fleet default", () => {
    for (const [, over] of cases) {
      expect(resolveLide400EvidencePolicy(qualified(over)).evidenceMinMarginMm).toBeGreaterThanOrEqual(FLEET);
    }
  });
});

describe("the platen invariant", () => {
  it("accepts the driver-declared value exactly", () => {
    expect(resolveLide400EvidencePolicy(qualified()).qualified).toBe(true);
  });

  it("accepts the float artifact of 8.5 in -> mm", () => {
    // 8.5 * 25.4 === 215.89999999999998, not 215.9. A strict equality check would reject the real
    // driver value converted honestly.
    const p = resolveLide400EvidencePolicy(
      qualified({ platenPhysicalSizeMm: { width: 8.5 * 25.4, height: 11.693333333333333 * 25.4 } })
    );
    expect(p.qualified).toBe(true);
  });

  it("rejects a platen off by more than the tolerance on either axis", () => {
    for (const platen of [
      { width: 215.9 + 0.002, height: 297.0107 },
      { width: 215.9, height: 297.0107 + 0.002 },
      { width: 216, height: 297 },
      { width: 210, height: 297.0107 },
    ]) {
      const p = resolveLide400EvidencePolicy(qualified({ platenPhysicalSizeMm: platen }));
      expect(p.qualified).toBe(false);
      expect(p.failedGates).toContain("platen_geometry");
    }
  });

  it("the tolerance is not coupled to detector edge error", () => {
    // Detector edge error is 0.40 mm budgeted. If that number ever leaked into this constant, a
    // materially different platen would be admitted.
    expect(PLATEN_TOLERANCE_MM).toBeLessThan(0.01);
    expect(resolveLide400EvidencePolicy(qualified({ platenPhysicalSizeMm: { width: 215.9 + 0.3, height: 297.0107 } })).qualified).toBe(false);
  });
});

describe("no client-supplied floor exists", () => {
  it("the observation contract carries no margin/floor field", () => {
    const keys = Object.keys(qualified());
    expect(keys.filter((k) => /margin|floor|clearance|evidenceMin/i.test(k))).toEqual([]);
  });
});
