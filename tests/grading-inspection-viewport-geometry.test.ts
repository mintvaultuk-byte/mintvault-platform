import { describe, expect, it } from "vitest";
import {
  fitInspectionImage,
  imagePercentToViewportPoint,
  inspectionPlacement,
  panInspectionFocus,
  screenPointToImagePercent,
  zoomInspectionFocusAtPoint,
} from "../client/src/components/grading/inspection-viewport-geometry";

const NATURAL = { width: 1200, height: 1700 };
const INSET = { x: 10, y: 12 };

describe("grading inspection viewport geometry", () => {
  it("defines 100% as the largest complete uncropped FIT with natural aspect and safe clearance", () => {
    const fit = fitInspectionImage({ width: 453.6, height: 556 }, NATURAL, INSET);
    expect(fit.width / fit.height).toBeCloseTo(NATURAL.width / NATURAL.height, 10);
    expect(fit.width).toBeLessThanOrEqual(453.6 - INSET.x * 2);
    expect(fit.height).toBeLessThanOrEqual(556 - INSET.y * 2);
    expect(fit.width === 453.6 - INSET.x * 2 || fit.height === 556 - INSET.y * 2).toBe(true);
  });

  it("recomputes from viewport authority and returns to the identical 100% geometry after repeated browser zoom transitions", () => {
    const cssViewports = [
      { width: 567, height: 640 }, // browser 80%
      { width: 504, height: 610 }, // 90%
      { width: 454, height: 588 }, // 100%
      { width: 413, height: 556 }, // 110%
      { width: 363, height: 506 }, // 125%
      { width: 303, height: 421 }, // 150%
      { width: 454, height: 588 }, // back to 100%
    ];
    const first = inspectionPlacement(cssViewports[2], NATURAL, 1, { x: 0.5, y: 0.5 }, INSET);
    for (let repeat = 0; repeat < 5; repeat += 1) {
      for (const viewport of cssViewports) {
        const placement = inspectionPlacement(viewport, NATURAL, 1, { x: 0.5, y: 0.5 }, INSET);
        expect(placement.width).toBeGreaterThan(0);
        expect(placement.height).toBeGreaterThan(0);
        expect(placement.left).toBeGreaterThanOrEqual(INSET.x - 0.001);
        expect(placement.top).toBeGreaterThanOrEqual(INSET.y - 0.001);
        expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width - INSET.x + 0.001);
        expect(placement.top + placement.height).toBeLessThanOrEqual(viewport.height - INSET.y + 0.001);
      }
    }
    const returned = inspectionPlacement(cssViewports[6], NATURAL, 1, { x: 0.5, y: 0.5 }, INSET);
    expect(returned).toEqual(first);
  });

  it("supports the locked 50–500% FIT-relative matrix and centres views smaller than the viewport", () => {
    const viewport = { width: 454, height: 588 };
    const fit = inspectionPlacement(viewport, NATURAL, 1, { x: 0.5, y: 0.5 }, INSET);
    const half = inspectionPlacement(viewport, NATURAL, 0.5, { x: 0, y: 1 }, INSET);
    const five = inspectionPlacement(viewport, NATURAL, 5, { x: 0.5, y: 0.5 }, INSET);
    expect(half.width).toBeCloseTo(fit.width * 0.5, 8);
    expect(half.left).toBeCloseTo((viewport.width - half.width) / 2, 8);
    expect(half.top).toBeCloseTo((viewport.height - half.height) / 2, 8);
    expect(five.width).toBeCloseTo(fit.width * 5, 8);
    expect(five.height).toBeCloseTo(fit.height * 5, 8);
  });

  it("pans in rendered pixels while clamping focus so magnified evidence cannot expose blank space", () => {
    const viewport = { width: 454, height: 588 };
    const zoom = 3;
    const moved = panInspectionFocus(viewport, NATURAL, zoom, { x: 0.5, y: 0.5 }, { x: 180, y: -220 }, INSET);
    const placement = inspectionPlacement(viewport, NATURAL, zoom, moved, INSET);
    expect(moved).not.toEqual({ x: 0.5, y: 0.5 });
    expect(placement.left).toBeLessThanOrEqual(INSET.x + 0.001);
    expect(placement.top).toBeLessThanOrEqual(INSET.y + 0.001);
    expect(placement.left + placement.width).toBeGreaterThanOrEqual(viewport.width - INSET.x - 0.001);
    expect(placement.top + placement.height).toBeGreaterThanOrEqual(viewport.height - INSET.y - 0.001);

    const extreme = panInspectionFocus(viewport, NATURAL, zoom, moved, { x: 100_000, y: 100_000 }, INSET);
    const clamped = inspectionPlacement(viewport, NATURAL, zoom, extreme, INSET);
    expect(clamped.left).toBeCloseTo(INSET.x, 8);
    expect(clamped.top).toBeCloseTo(INSET.y, 8);
  });

  it("keeps the same image feature under the cursor during anchored zoom", () => {
    const viewport = { width: 454, height: 588 };
    const point = { x: 118, y: 431 };
    const before = inspectionPlacement(viewport, NATURAL, 1, { x: 0.5, y: 0.5 }, INSET);
    const feature = screenPointToImagePercent(point, before);
    const nextFocus = zoomInspectionFocusAtPoint(viewport, NATURAL, 1, 3, { x: 0.5, y: 0.5 }, point, INSET);
    const after = inspectionPlacement(viewport, NATURAL, 3, nextFocus, INSET);
    const anchored = imagePercentToViewportPoint(feature, after);
    expect(anchored.x).toBeCloseTo(point.x, 8);
    expect(anchored.y).toBeCloseTo(point.y, 8);
  });

  it("round-trips every stored percentage through the rendered plane without data conversion", () => {
    const placement = inspectionPlacement({ width: 454, height: 588 }, NATURAL, 4, { x: 0.63, y: 0.27 }, INSET);
    for (const percent of [
      { x: 0, y: 0 },
      { x: 12.5, y: 88.25 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
    ]) {
      const screen = imagePercentToViewportPoint(percent, placement);
      const returned = screenPointToImagePercent(screen, placement);
      expect(returned.x).toBeCloseTo(percent.x, 10);
      expect(returned.y).toBeCloseTo(percent.y, 10);
    }
  });
});
