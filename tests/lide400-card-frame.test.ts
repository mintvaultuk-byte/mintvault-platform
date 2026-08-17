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
