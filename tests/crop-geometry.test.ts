import { describe, it, expect } from "vitest";
import { quadRotation, quadBounds, type CropQuad } from "@/components/grading/crop-geometry";

const FLAT: CropQuad = {
  tl: { x: 0, y: 0 },
  tr: { x: 100, y: 0 },
  br: { x: 100, y: 100 },
  bl: { x: 0, y: 100 },
};

describe("quadRotation", () => {
  it("is 0 for a level top edge, regardless of image dimensions", () => {
    expect(quadRotation(FLAT, 400, 1000)).toBeCloseTo(0, 6);
    expect(quadRotation(FLAT)).toBeCloseTo(0, 6);
  });

  it("converts the tilt to PIXEL space on a non-square image", () => {
    // 1% vertical drop over a 100% horizontal run. On a 400×1000 (tall) image
    // that is 10px down over 400px across → atan2(10, 400) = 1.4321°.
    const tilted: CropQuad = {
      tl: { x: 0, y: 0 },
      tr: { x: 100, y: 1 },
      br: { x: 100, y: 101 },
      bl: { x: 0, y: 100 },
    };
    const pixelAngle = quadRotation(tilted, 400, 1000);
    expect(pixelAngle).toBeCloseTo((Math.atan2(10, 400) * 180) / Math.PI, 6);
    expect(pixelAngle).toBeCloseTo(1.4321, 3);

    // Square-pixel fallback (dims unknown) reproduces the OLD percentage angle:
    // atan2(1, 100) = 0.5729°. This is the aspect-distorted value the fix
    // replaces — the pixel-space angle on a tall card is materially larger.
    const pctAngle = quadRotation(tilted);
    expect(pctAngle).toBeCloseTo((Math.atan2(1, 100) * 180) / Math.PI, 6);
    expect(pctAngle).toBeCloseTo(0.5729, 3);
    expect(pixelAngle).toBeGreaterThan(pctAngle * 2);
  });

  it("gives 45° for a diagonal top edge on a square image", () => {
    const diag: CropQuad = { ...FLAT, tl: { x: 0, y: 0 }, tr: { x: 100, y: 100 } };
    expect(quadRotation(diag, 1000, 1000)).toBeCloseTo(45, 6);
  });

  it("is sign-correct: TR below TL → positive, TR above TL → negative", () => {
    expect(quadRotation({ ...FLAT, tr: { x: 100, y: 5 } }, 1000, 1000)).toBeGreaterThan(0);
    expect(quadRotation({ ...FLAT, tr: { x: 100, y: -5 } }, 1000, 1000)).toBeLessThan(0);
  });
});

describe("quadBounds", () => {
  it("computes the axis-aligned bounding box in percent", () => {
    const q: CropQuad = {
      tl: { x: 10, y: 20 },
      tr: { x: 80, y: 15 },
      br: { x: 85, y: 90 },
      bl: { x: 5, y: 95 },
    };
    const b = quadBounds(q);
    expect(b.left_pct).toBe(5);
    expect(b.top_pct).toBe(15);
    expect(b.width_pct).toBe(80); // 85 − 5
    expect(b.height_pct).toBe(80); // 95 − 15
  });
});
