/**
 * Regression contract for the former cumulative-shrink loop.
 *
 * The replacement does not need a ratchet. It is a pure projection of the
 * current CSS viewport, source natural dimensions and explicit inspection state.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { inspectionPlacement } from "../client/src/components/grading/inspection-viewport-geometry";

const VIEWER = fs.readFileSync(path.resolve(process.cwd(), "client/src/components/grading/image-viewer.tsx"), "utf8");
const NATURAL = { width: 1200, height: 1700 };
const INSETS = { x: 10, y: 12 };

describe("FIT is deterministic and has no cumulative state", () => {
  it("returns byte-identical placement over repeated observations", () => {
    const viewport = { width: 373, height: 522 };
    const placements = Array.from({ length: 50 }, () =>
      inspectionPlacement(viewport, NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS)
    );
    expect(new Set(placements.map((p) => JSON.stringify(p))).size).toBe(1);
    expect(placements[0].width).toBeGreaterThan(0);
    expect(placements[0].height).toBeGreaterThan(0);
  });

  it("survives the full browser zoom sequence repeatedly and returns exactly to 100%", () => {
    const sequence = [
      { width: 567, height: 640 },
      { width: 504, height: 610 },
      { width: 454, height: 588 },
      { width: 413, height: 556 },
      { width: 363, height: 506 },
      { width: 303, height: 421 },
      { width: 454, height: 588 },
    ];
    const expected = inspectionPlacement(sequence[2], NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS);
    for (let pass = 0; pass < 8; pass += 1) {
      for (const viewport of sequence) {
        const placement = inspectionPlacement(viewport, NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS);
        expect(placement.width).toBeGreaterThan(0);
        expect(placement.height).toBeGreaterThan(0);
      }
    }
    expect(inspectionPlacement(sequence[6], NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS)).toEqual(expected);
  });

  it("recomputes genuine width and height changes independently", () => {
    const wide = inspectionPlacement({ width: 500, height: 400 }, NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS);
    const narrow = inspectionPlacement({ width: 250, height: 400 }, NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS);
    const short = inspectionPlacement({ width: 500, height: 300 }, NATURAL, 1, { x: 0.5, y: 0.5 }, INSETS);
    expect(narrow.width).toBeLessThan(wide.width);
    expect(short.height).toBeLessThan(wide.height);
  });

  it("does not carry a last-known-good fit, revision counter or observer ratchet", () => {
    expect(VIEWER).not.toMatch(/railFitRef|lastKnown|fitRevision|shouldRecommitRailFit/);
    expect(VIEWER).not.toMatch(/data-card-fit-revision|data-card-observer-count/);
  });

  it("never animates the computed image placement", () => {
    expect(VIEWER).toContain('transition: "none"');
  });
});

describe("natural-dimension authority is per displayed source", () => {
  it("re-reads an already-decoded img on side or variant changes", () => {
    expect(VIEWER).toMatch(/useLayoutEffect\(\(\) => \{/);
    expect(VIEWER).toContain("image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0");
    expect(VIEWER).toContain("setImgNaturalDims({ width: image.naturalWidth, height: image.naturalHeight })");
    expect(VIEWER).toMatch(/\}, \[side, variant\]\);/);
    expect(VIEWER).toContain("e.currentTarget.naturalWidth");
    expect(VIEWER).toContain("e.currentTarget.naturalHeight");
  });
});
