import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { assessLide400CardFrame, LIDE_400_MIN_EVIDENCE_MARGIN_MM } from "../server/lib/lide400-card-frame";

const frame = { width: 900, height: 1200, channels: 3 as const };
const acquisition = { width: 100, height: 130 };

async function syntheticFrame(left: number, top: number, width = 567, height = 812): Promise<Buffer> {
  const pixels = Buffer.alloc(frame.width * frame.height * 3, 245);
  for (let y = top; y < Math.min(frame.height, top + height); y++) {
    for (let x = left; x < Math.min(frame.width, left + width); x++) {
      const offset = (y * frame.width + x) * 3;
      pixels[offset] = 20;
      pixels[offset + 1] = 80;
      pixels[offset + 2] = 150;
    }
  }
  return sharp(pixels, { raw: frame }).tiff().withMetadata({ density: 1200 }).toBuffer();
}

describe("LiDE 400 acquired-frame safety gate", () => {
  it("accepts a complete card with generous detected background around all four edges", async () => {
    const assessment = await assessLide400CardFrame(await syntheticFrame(135, 160), frame, acquisition);
    expect(assessment.accepted).toBe(true);
    expect(assessment.evidenceMarginMm?.left).toBeCloseTo(15, 1);
    expect(assessment.evidenceMarginMm?.top).toBeCloseTo(17.33, 1);
    /*
     * 22.0, not 21.9. The retired reduction computed the far margins from the LAST CARD PIXEL
     * INDEX (`width - 1 - rightPx`), which understated right and bottom by one pixel-width. The
     * canonical detector computes `area - (origin + span)`, which is exact: a 63 mm card at 15 mm
     * in a 100 mm region leaves exactly 22 mm. The old value was conservative — it under-reported
     * clearance and so could only ever fail closed — but it was arithmetically wrong.
     */
    expect(assessment.evidenceMarginMm?.right).toBeCloseTo(22.0, 1);
    expect(assessment.evidenceMarginMm?.bottom).toBeCloseTo(24.7, 1);
    // Boundary detection maps whole downscaled pixels back to millimetres;
    // assert physical-card scale rather than sub-millimetre raster rounding.
    expect(assessment.cardBoundsMm?.width).toBeCloseTo(63, 0);
    expect(assessment.cardBoundsMm?.height).toBeCloseTo(88, 0);
  });

  it("rejects a clipped/edge-touching card instead of allowing a working crop to hide it", async () => {
    const assessment = await assessLide400CardFrame(await syntheticFrame(0, 160), frame, acquisition);
    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toMatch(/acquisition boundary/);
    expect(assessment.evidenceMarginMm?.left).toBeLessThan(LIDE_400_MIN_EVIDENCE_MARGIN_MM);
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ALL FOUR EDGES, because for a long time only two of them were ever tested.
 *
 * A hostile review reduced `Math.min(...Object.values(evidenceMarginMm))` to
 * `Math.min(left, top)` — making a card 0.1 mm from the RIGHT or BOTTOM of the acquisition
 * rectangle valid evidence — and 70 of 70 tests still passed. The reason is structural: every one of
 * the four preserved real fixtures is corner-registered at top-left, so its minimum margin is always
 * a left or top margin. The corpus is incapable of exercising the other two edges, and the synthetic
 * suites never chose to.
 *
 * These are deliberately parametrised over the edge rather than written once, so removing any single
 * term from that `Math.min` fails a named test.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("the evidence floor applies to every edge, not just the two the fixtures happen to use", () => {
  const mmPerPxX = frame.width / acquisition.width;
  const mmPerPxY = frame.height / acquisition.height;
  const cardW = 567;
  const cardH = 812;

  /** Place the card so exactly `mm` of background remains on ONE named edge. */
  const atEdge = (edge: "left" | "top" | "right" | "bottom", mm: number) => {
    const centredLeft = Math.round((frame.width - cardW) / 2);
    const centredTop = Math.round((frame.height - cardH) / 2);
    switch (edge) {
      case "left":
        return { left: Math.round(mm * mmPerPxX), top: centredTop };
      case "top":
        return { left: centredLeft, top: Math.round(mm * mmPerPxY) };
      case "right":
        return { left: frame.width - cardW - Math.round(mm * mmPerPxX), top: centredTop };
      case "bottom":
        return { left: centredLeft, top: frame.height - cardH - Math.round(mm * mmPerPxY) };
    }
  };

  for (const edge of ["left", "top", "right", "bottom"] as const) {
    it(`REJECTS a master whose ${edge.toUpperCase()} margin is below the ${LIDE_400_MIN_EVIDENCE_MARGIN_MM} mm floor`, async () => {
      const { left, top } = atEdge(edge, 2);
      const assessment = await assessLide400CardFrame(await syntheticFrame(left, top), frame, acquisition);
      expect(assessment.accepted, `a 2 mm ${edge} margin must never become evidence`).toBe(false);
      expect(assessment.reason).toMatch(/too close to the hardware acquisition boundary/);
      expect(assessment.evidenceMarginMm?.[edge]).toBeLessThan(LIDE_400_MIN_EVIDENCE_MARGIN_MM);
    });

    it(`ACCEPTS a master whose ${edge.toUpperCase()} margin clears the floor`, async () => {
      const { left, top } = atEdge(edge, 8);
      const assessment = await assessLide400CardFrame(await syntheticFrame(left, top), frame, acquisition);
      expect(assessment.accepted, assessment.reason || "").toBe(true);
      expect(Math.min(...Object.values(assessment.evidenceMarginMm!))).toBeGreaterThanOrEqual(
        LIDE_400_MIN_EVIDENCE_MARGIN_MM
      );
    });
  }
});
