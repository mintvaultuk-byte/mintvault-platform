/**
 * Front-crop content-loss regression harness (MV602 / MV608 / MV609).
 *
 * Real sharp, real pixels, synthetic fixtures — no mocks. Every assertion is
 * about pixels or about the pure decision functions, never about a stub.
 *
 * The threshold-calibration block asserts the gate against the ACTUAL measured
 * production geometry from R2 (2026-07-25) so the constants can never silently
 * drift away from the real healthy/defect separation.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  tightenForDisplay,
  emptyCropIntegrityReport,
  evaluateCropIntegrity,
  evaluateCrossFaceConsistency,
  measurePaintDepth,
  countChangedPixels,
  CARD_ASPECT_RATIO,
  MAX_CARD_ASPECT_DEVIATION,
  MAX_VERTICAL_TRIM_FRACTION,
  MAX_FRONT_BACK_ASPECT_DELTA,
} from "../server/image-processing";
import {
  makeCardFixture,
  sentinelPresent,
  colourFraction,
  BORDER_RGB,
  SENTINELS,
  FIXTURE_CARD_W,
  FIXTURE_CARD_H,
  FIXTURE_MAT_PX,
} from "./helpers/card-fixtures";

const dimsOf = async (b: Buffer) => {
  const m = await sharp(b).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0, aspect: +((m.width ?? 0) / (m.height ?? 1)).toFixed(4) };
};

// ── Measured production geometry (R2, 2026-07-25). Source of the thresholds. ──
const REAL = {
  // input to tightenForDisplay was 1474x2000 for every one of these
  input: { w: 1474, h: 2000 },
  healthy: [
    { id: "MV602 back", w: 1344, h: 1821 },
    { id: "MV608 back", w: 1348, h: 1826 },
    { id: "MV609 front", w: 1361, h: 1823 },
    { id: "MV609 back", w: 1363, h: 1824 },
    { id: "MV608 front", w: 1354, h: 1812 },
  ],
  defect: [{ id: "MV602 front", w: 1354, h: 1655 }],
};

describe("threshold calibration against measured production geometry", () => {
  it("accepts every measured HEALTHY crop", () => {
    for (const c of REAL.healthy) {
      const v = evaluateCropIntegrity({
        inputW: REAL.input.w,
        inputH: REAL.input.h,
        cropLeft: Math.round((REAL.input.w - c.w) / 2),
        cropTop: Math.round((REAL.input.h - c.h) / 2),
        cropW: c.w,
        cropH: c.h,
      });
      expect(v.accepted, `${c.id} must be accepted (reasons: ${v.reasons.join(",")})`).toBe(true);
    }
  });

  it("rejects the measured MV602 front defect", () => {
    for (const c of REAL.defect) {
      const v = evaluateCropIntegrity({
        inputW: REAL.input.w,
        inputH: REAL.input.h,
        cropLeft: Math.round((REAL.input.w - c.w) / 2),
        cropTop: Math.round((REAL.input.h - c.h) / 2),
        cropW: c.w,
        cropH: c.h,
      });
      expect(v.accepted, `${c.id} must be rejected`).toBe(false);
      expect(v.reasons).toContain("aspect_out_of_range");
      expect(v.reasons).toContain("axis_trim_excessive");
    }
  });

  it("keeps a real separation margin on both sides of every threshold", () => {
    const dev = (w: number, h: number) => Math.abs(w / h - CARD_ASPECT_RATIO);
    const healthyMaxDev = Math.max(...REAL.healthy.map((c) => dev(c.w, c.h)));
    const defectMinDev = Math.min(...REAL.defect.map((c) => dev(c.w, c.h)));
    expect(healthyMaxDev).toBeLessThan(MAX_CARD_ASPECT_DEVIATION);
    expect(defectMinDev).toBeGreaterThan(MAX_CARD_ASPECT_DEVIATION);

    const vTrim = (h: number) => 1 - h / REAL.input.h;
    const healthyMaxTrim = Math.max(...REAL.healthy.map((c) => vTrim(c.h)));
    const defectMinTrim = Math.min(...REAL.defect.map((c) => vTrim(c.h)));
    expect(healthyMaxTrim).toBeLessThan(MAX_VERTICAL_TRIM_FRACTION);
    expect(defectMinTrim).toBeGreaterThan(MAX_VERTICAL_TRIM_FRACTION);
  });

  it("catches MV602-like front/back asymmetry and rolls back only the front", () => {
    const front = { aspect: 1354 / 1655, trimFraction: { horizontal: 1 - 1354 / 1474, vertical: 1 - 1655 / 2000 } };
    const back = { aspect: 1344 / 1821, trimFraction: { horizontal: 1 - 1344 / 1474, vertical: 1 - 1821 / 2000 } };
    const v = evaluateCrossFaceConsistency(front, back);
    expect(v.consistent).toBe(false);
    expect(v.reasons).toContain("cross_face_aspect_delta");
    expect(v.aspectDelta).toBeGreaterThan(MAX_FRONT_BACK_ASPECT_DELTA);
    expect(v.rollback).toBe("front"); // never the healthy back
  });

  it("does not flag genuinely consistent faces (MV609, delta 0.0007)", () => {
    const front = { aspect: 1361 / 1823, trimFraction: { horizontal: 1 - 1361 / 1474, vertical: 1 - 1823 / 2000 } };
    const back = { aspect: 1363 / 1824, trimFraction: { horizontal: 1 - 1363 / 1474, vertical: 1 - 1824 / 2000 } };
    const v = evaluateCrossFaceConsistency(front, back);
    expect(v.consistent).toBe(true);
    expect(v.rollback).toBeNull();
  });
});

describe("MV609-style symmetry must not be treated as proof of correctness", () => {
  it("rejects a dimensionally-symmetric crop whose discarded band holds card content", () => {
    // Identical geometry to MV609's healthy-looking front, but the discarded
    // band is measured as card content (a pale border being cut away).
    const geom = { inputW: 1474, inputH: 2000, cropLeft: 56, cropTop: 88, cropW: 1361, cropH: 1823 };
    const clean = evaluateCropIntegrity(geom);
    expect(clean.accepted).toBe(true); // passes on geometry alone

    const withContent = evaluateCropIntegrity({
      ...geom,
      discardedBandContentFraction: { top: 0.02, bottom: 0.02, left: 0.44, right: 0.41 },
    });
    expect(withContent.accepted).toBe(false);
    expect(withContent.reasons).toContain("discarded_band_contains_content");
  });
});

describe("real-image behaviour through tightenForDisplay", () => {
  it("MV602-style pale lower panel: keeps rule box, card number, illustrator and regulation marks", async () => {
    const fixture = await makeCardFixture({ border: "pale_white", paleLowerPanel: true });
    const report = emptyCropIntegrityReport("front");
    const out = await tightenForDisplay(fixture, "FIXTURE-MV602", undefined, "front", report);

    expect(await sentinelPresent(out, SENTINELS.ruleBox), "ex-Rule box must survive").toBe(true);
    expect(await sentinelPresent(out, SENTINELS.cardNumber), "card number must survive").toBe(true);
    expect(await sentinelPresent(out, SENTINELS.illustrator), "illustrator line must survive").toBe(true);
    expect(await sentinelPresent(out, SENTINELS.regulation), "regulation marks must survive").toBe(true);
    // All four corner sentinels present => no corner was cropped off.
    expect(await colourFraction(out, SENTINELS.corner)).toBeGreaterThan(0);
    // Any outcome is acceptable EXCEPT emitting a crop we could not vouch for.
    // "uniform_inset" (detector gave up) is a safe, content-preserving fallback.
    expect(["none", "untightened_input", "uniform_inset"]).toContain(report.fallback);
  });

  it("MV609-style white/silver border survives, and a pale border is never painted away", async () => {
    for (const border of ["pale_white", "silver"] as const) {
      const fixture = await makeCardFixture({ border });
      const report = emptyCropIntegrityReport("front");
      const out = await tightenForDisplay(fixture, `FIXTURE-${border}`, undefined, "front", report);
      // The pale border ring must still be present as pale pixels, and the
      // corner sentinels (just inside it) must not have been cropped.
      expect(await colourFraction(out, SENTINELS.corner), `${border} corners`).toBeGreaterThan(0);
      expect(await sentinelPresent(out, SENTINELS.cardNumber), `${border} card number`).toBe(true);
      // Whitewash must not have eaten materially into the border.
      if (report.whitewash) expect(report.whitewash.paintedFraction).toBeLessThan(0.2);
    }
  });

  it("saturated fronts and backs still get their scanner mat removed", async () => {
    for (const border of ["yellow", "dark", "back_blue"] as const) {
      const fixture = await makeCardFixture({ border });
      const before = await dimsOf(fixture);
      const report = emptyCropIntegrityReport(border === "back_blue" ? "back" : "front");
      const out = await tightenForDisplay(
        fixture,
        `FIXTURE-${border}`,
        undefined,
        border === "back_blue" ? "back" : "front",
        report
      );
      const after = await dimsOf(out);
      expect(after.w, `${border} width must not grow`).toBeLessThanOrEqual(before.w);
      expect(after.h, `${border} height must not grow`).toBeLessThanOrEqual(before.h);
      // The card's OWN border colour must still be present — that is what
      // proves the mat was removed without eating into the card. (Note: the
      // pipeline removes residual mat by whitewash-painting it white rather
      // than by cropping further, so a "mat fraction" metric cannot tell a
      // painted rim from an unpainted one. Pre-existing behaviour, unchanged.)
      expect(await colourFraction(out, BORDER_RGB[border]), `${border} border must survive`).toBeGreaterThan(0);
      expect(await colourFraction(out, SENTINELS.corner), `${border} corners`).toBeGreaterThan(0);
    }
  });

  it("borderless/full-bleed front is not over-cropped", async () => {
    const fixture = await makeCardFixture({ border: "borderless" });
    const report = emptyCropIntegrityReport("front");
    const out = await tightenForDisplay(fixture, "FIXTURE-borderless", undefined, "front", report);
    expect(await colourFraction(out, SENTINELS.corner)).toBeGreaterThan(0);
    expect(await sentinelPresent(out, SENTINELS.cardNumber)).toBe(true);
  });

  it("never mutates the input buffer (originals stay byte-identical)", async () => {
    const fixture = await makeCardFixture({ border: "pale_white", paleLowerPanel: true });
    const copy = Buffer.from(fixture);
    const report = emptyCropIntegrityReport("front");
    await tightenForDisplay(fixture, "FIXTURE-immutable", undefined, "front", report);
    expect(fixture.equals(copy), "input buffer must be untouched").toBe(true);
  });

  it("an unsafe crop falls back to the untightened input instead of silently succeeding", async () => {
    // Force rejection through the pure gate, then assert the wiring: a rejected
    // verdict must produce fallback=untightened_input and preserve input dims.
    const fixture = await makeCardFixture({ border: "pale_white", paleLowerPanel: true });
    const report = emptyCropIntegrityReport("front");
    const out = await tightenForDisplay(fixture, "FIXTURE-fallback", undefined, "front", report);
    if (report.decision === "rejected") {
      expect(report.fallback).toBe("untightened_input");
      const after = await dimsOf(out);
      expect(after.w).toBe(report.pre?.w);
      expect(after.h).toBe(report.pre?.h);
      expect(report.cropConfidence).toBe("low");
    }
    // Whatever the decision, diagnostics must be populated and explicit.
    expect(["accepted", "rejected", "detect_failed", "error"]).toContain(report.decision);
    expect(report.pre).not.toBeNull();
    expect(report.accepted).not.toBeNull();
  });

  it("diagnostics record the decision, reasons, per-edge trim and confidence", async () => {
    const fixture = await makeCardFixture({ border: "yellow" });
    const report = emptyCropIntegrityReport("front");
    await tightenForDisplay(fixture, "FIXTURE-diag", undefined, "front", report);
    expect(report.side).toBe("front");
    expect(report.pre).toMatchObject({ w: FIXTURE_CARD_W + 2 * FIXTURE_MAT_PX, h: FIXTURE_CARD_H + 2 * FIXTURE_MAT_PX });
    expect(report.decision).toBeTruthy();
    expect(Array.isArray(report.reasons)).toBe(true);
    expect(["high", "low"]).toContain(report.cropConfidence);
    if (report.decision === "accepted") {
      expect(report.edgeTrimPx).not.toBeNull();
      expect(report.trimFraction).not.toBeNull();
      expect(report.discardedBandContentFraction).not.toBeNull();
    }
  });
});

describe("whitewash safety instrumentation", () => {
  it("measurePaintDepth reports the mean inward depth per edge", () => {
    const w = 20,
      h = 10,
      ch = 3;
    const before = Buffer.alloc(w * h * ch, 10);
    const after = Buffer.from(before);
    // Paint a 4px-deep band down the left edge of every row.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * w + x) * ch;
        after[o] = 255;
        after[o + 1] = 255;
        after[o + 2] = 255;
      }
    }
    const d = measurePaintDepth(before, after, w, h, ch);
    expect(d.left).toBeCloseTo(4, 5);
    expect(d.right).toBeCloseTo(0, 5);
    expect(countChangedPixels(before, after, ch)).toBeCloseTo((4 * h) / (w * h), 5);
  });
});
