import { describe, it, expect } from "vitest";
import {
  clampField,
  validateCalibration,
  defaultCalibration,
  FIELD_RANGES,
} from "../server/lib/mvgs-calibration-validation";

describe("clampField — sanitises per-field PATCH input", () => {
  it("clamps below min to min", () => {
    expect(clampField("edgeAffectedPct", 0)).toBe(FIELD_RANGES.edgeAffectedPct.min);
    expect(clampField("edgeAffectedPct", -50)).toBe(FIELD_RANGES.edgeAffectedPct.min);
  });

  it("clamps above max to max", () => {
    expect(clampField("edgeAffectedPct", 500)).toBe(FIELD_RANGES.edgeAffectedPct.max);
    expect(clampField("darkBorderMultiplier", 99)).toBe(FIELD_RANGES.darkBorderMultiplier.max);
  });

  it("passes through values inside the range", () => {
    expect(clampField("edgeAffectedPct", 15)).toBe(15);
    expect(clampField("darkBorderMultiplier", 1.4)).toBe(1.4);
    expect(clampField("creaseMinorMaxPct", 30)).toBe(30);
  });

  it("coerces numeric strings", () => {
    expect(clampField("edgeAffectedPct", "12.5")).toBe(12.5);
  });

  it("returns null for non-finite input (route treats as field absent)", () => {
    expect(clampField("edgeAffectedPct", null)).toBeNull();
    expect(clampField("edgeAffectedPct", undefined)).toBeNull();
    expect(clampField("edgeAffectedPct", "abc")).toBeNull();
    expect(clampField("edgeAffectedPct", NaN)).toBeNull();
    expect(clampField("edgeAffectedPct", Infinity)).toBeNull();
  });

  it("dark-border multiplier floor is 1.0 (never reduces coverage)", () => {
    expect(clampField("darkBorderMultiplier", 0.5)).toBe(1);
    expect(clampField("darkBorderMultiplier", 0)).toBe(1);
  });
});

describe("validateCalibration — cross-field ordering on crease cutoffs", () => {
  it("accepts the spec defaults", () => {
    expect(validateCalibration(defaultCalibration())).toEqual({ ok: true });
  });

  it("rejects creaseMinorMaxPct >= creaseHalfMaxPct", () => {
    const r = validateCalibration({
      ...defaultCalibration(),
      creaseMinorMaxPct: 60,
      creaseHalfMaxPct: 50, // out of order
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/creaseMinorMaxPct.*creaseHalfMaxPct/);
  });

  it("rejects creaseMinorMaxPct == creaseHalfMaxPct (must be strict <)", () => {
    const r = validateCalibration({
      ...defaultCalibration(),
      creaseMinorMaxPct: 50,
      creaseHalfMaxPct: 50,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects creaseHalfMaxPct >= creaseThreeQuarterMaxPct", () => {
    const r = validateCalibration({
      ...defaultCalibration(),
      creaseHalfMaxPct: 80,
      creaseThreeQuarterMaxPct: 75, // out of order
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/creaseHalfMaxPct.*creaseThreeQuarterMaxPct/);
  });

  it("rejects out-of-range single field with a useful error", () => {
    const r = validateCalibration({ ...defaultCalibration(), edgeAffectedPct: 99 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/edgeAffectedPct/);
      expect(r.error).toMatch(/99/);
    }
  });

  it("rejects non-finite values", () => {
    const r = validateCalibration({ ...defaultCalibration(), edgeAffectedPct: NaN });
    expect(r.ok).toBe(false);
  });

  it("accepts a tuned-but-still-ordered crease ladder", () => {
    const r = validateCalibration({
      ...defaultCalibration(),
      creaseMinorMaxPct: 20,
      creaseHalfMaxPct: 45,
      creaseThreeQuarterMaxPct: 70,
    });
    expect(r).toEqual({ ok: true });
  });
});

describe("defaultCalibration — matches spec §3 + §6 starting values", () => {
  it("returns a fresh object each call (no shared reference)", () => {
    const a = defaultCalibration();
    const b = defaultCalibration();
    a.edgeAffectedPct = 999;
    expect(b.edgeAffectedPct).not.toBe(999);
  });

  it("starting values match the spec exactly", () => {
    expect(defaultCalibration()).toEqual({
      edgeAffectedPct: 10,
      minorVisibleSplitPct: 25,
      darkBorderMultiplier: 1.25,
      creaseMinorMaxPct: 25,
      creaseHalfMaxPct: 50,
      creaseThreeQuarterMaxPct: 75,
    });
  });
});
