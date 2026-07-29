/**
 * Mat-resumption regression fixtures.
 *
 * Built from the MEASURED MV608 failure: a hard-edged, full-height dark stripe
 * sitting inside the scanner mat stopped the walk at x=21 when clean mat
 * resumed for ~65px and the real card began at ~x121.
 *
 * These drive measureRetainedMatPerEdge() directly with synthetic raw pixels
 * (no JPEG round-trip), so every case is exact and deterministic. No customer
 * images are used or committed.
 */
import { describe, it, expect } from "vitest";
import {
  measureRetainedMatPerEdge,
  MAT_RESUME_MAX_SKIPS,
  MAT_RESUME_MAX_STRIPE_PX,
} from "../server/image-processing";

type RGB = [number, number, number];
const MAT: RGB = [232, 236, 240];

/**
 * Build an image whose LEFT edge follows `columns`, with mat everywhere else.
 * `columns[i]` is the colour of x=i; beyond the list the card colour fills.
 * Rows are identical, so per-row agreement is total — matching the real
 * artefact, which ran the full image height (166/167 rows).
 */
function buildLeftEdge(columns: RGB[], fill: RGB, w = 400, h = 400, jitter = 0) {
  const ch = 3;
  const px = new Uint8Array(w * h * ch);
  // Real scans have mat on ALL four sides, and the detector samples its mat
  // reference from the outer top/bottom rows. Without this band the reference
  // would average in the stripe and the card.
  // Keep the band thin (5% of height, as in a real scan where the card fills
  // most rows) — a fat band would dominate the per-line IQR and depress
  // confidence for reasons that have nothing to do with the edge under test.
  const MAT_BAND = 10;
  for (let y = 0; y < h; y++) {
    const inBand = y < MAT_BAND || y >= h - MAT_BAND;
    for (let x = 0; x < w; x++) {
      const c = inBand ? MAT : x < columns.length ? columns[x] : fill;
      const o = (y * w + x) * ch;
      // Deterministic jitter (no RNG) so "noise" cases stay reproducible.
      const j = jitter === 0 ? 0 : ((x * 7 + y * 13) % (2 * jitter + 1)) - jitter;
      px[o] = Math.max(0, Math.min(255, c[0] + j));
      px[o + 1] = Math.max(0, Math.min(255, c[1] + j));
      px[o + 2] = Math.max(0, Math.min(255, c[2] + j));
    }
  }
  return { px, w, h, ch };
}

const rep = (n: number, c: RGB): RGB[] => Array.from({ length: n }, () => c);

describe("positive fixture — MV608-style artefact stripe inside the mat", () => {
  // Geometry taken from the measurement: mat 0-20, stripe 21-37, mat 38-120,
  // card from 121. Card is a saturated dark artwork edge.
  const CARD: RGB = [40, 30, 66];
  const STRIPE: RGB = [105, 115, 134];
  const columns: RGB[] = [...rep(21, MAT), ...rep(17, STRIPE), ...rep(83, MAT)];

  it("skips the stripe and finds the LATER true boundary at ~121", () => {
    const f = buildLeftEdge(columns, CARD);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    // Without resumption this measured 21. With it, the card boundary wins.
    expect(m.left).toBeGreaterThanOrEqual(115);
    expect(m.left).toBeLessThanOrEqual(125);
    expect(m.skips.left).toBeGreaterThan(0);
    expect(m.skippedWidthPx.left).toBeGreaterThanOrEqual(15);
    expect(m.skippedWidthPx.left).toBeLessThanOrEqual(MAT_RESUME_MAX_STRIPE_PX);
  });

  it("downgrades confidence whenever a stripe is skipped", () => {
    const f = buildLeftEdge(columns, CARD);
    expect(measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch).confidence).toBe("low");
  });

  it("reproduces the OLD failure when resumption is unavailable", () => {
    // Same stripe, but the card starts immediately after it — no mat resumes,
    // so the walk must stop at the stripe exactly as the old code did.
    const noResume: RGB[] = [...rep(21, MAT), ...rep(17, STRIPE)];
    const f = buildLeftEdge(noResume, CARD);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBe(21);
    expect(m.skips.left).toBe(0);
  });
});

describe("negative controls — a resumption must be MAT, not merely pale", () => {
  it("MV609-style genuine boundary: no skip, mat stays put", () => {
    const CARD: RGB = [70, 90, 150];
    const f = buildLeftEdge([...rep(92, MAT)], CARD);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBe(92);
    expect(m.skips.left).toBe(0);
    expect(m.confidence).toBe("high");
  });

  it("thin dark border then a WIDE PALE CARD PANEL is not treated as mat", () => {
    // The dangerous case: 6px dark border, then 200px of near-white card.
    // Pale, but NOT the mat profile — must stop at the border.
    const BORDER: RGB = [30, 30, 34];
    const PALE_PANEL: RGB = [246, 245, 242];
    const f = buildLeftEdge([...rep(40, MAT), ...rep(6, BORDER), ...rep(200, PALE_PANEL)], PALE_PANEL);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBe(40);
    expect(m.skips.left).toBe(0);
  });

  it("silver border stops the walk at the genuine border", () => {
    const SILVER: RGB = [226, 228, 231];
    const f = buildLeftEdge([...rep(50, MAT), ...rep(60, SILVER)], [40, 30, 66]);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBe(50);
    expect(m.skips.left).toBe(0);
  });

  it("holo/reflective border with brightness variation still stops correctly", () => {
    const holo: RGB[] = Array.from({ length: 60 }, (_, i) => {
      const v = 150 + 70 * Math.sin(i / 3);
      return [Math.round(v), Math.round(v * 0.9), Math.round(v * 1.05)] as RGB;
    });
    const f = buildLeftEdge([...rep(45, MAT), ...holo], [40, 30, 66]);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBe(45);
    expect(m.skips.left).toBe(0);
  });
});

describe("hard limits", () => {
  it("obeys the skip-count cap with many artefact stripes", () => {
    const STRIPE: RGB = [105, 115, 134];
    const cols: RGB[] = [];
    for (let i = 0; i < 6; i++) cols.push(...rep(20, MAT), ...rep(8, STRIPE));
    const f = buildLeftEdge(cols, [40, 30, 66], 500);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    // Never more than the cap, so a striped region cannot be walked forever.
    expect(m.skips.left).toBeGreaterThan(0);
    expect(m.left).toBeLessThan(20 + MAT_RESUME_MAX_SKIPS * 28 + 30);
  });

  it("refuses to step over a stripe wider than the cap", () => {
    const WIDE: RGB = [105, 115, 134];
    const f = buildLeftEdge(
      [...rep(20, MAT), ...rep(MAT_RESUME_MAX_STRIPE_PX + 15, WIDE), ...rep(60, MAT)],
      [40, 30, 66],
      500
    );
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBe(20);
    expect(m.skips.left).toBe(0);
  });

  it("a narrow dust line does not destabilise the measurement", () => {
    const DUST: RGB = [120, 120, 120];
    const f = buildLeftEdge([...rep(30, MAT), ...rep(2, DUST), ...rep(80, MAT)], [40, 30, 66]);
    const m = measureRetainedMatPerEdge(f.px, f.w, f.h, f.ch);
    expect(m.left).toBeGreaterThanOrEqual(110);
    expect(m.spread.left).toBeLessThanOrEqual(2);
  });
});

describe("asymmetric mat — every edge is independent", () => {
  it("measures left and right separately", () => {
    const ch = 3;
    const w = 400;
    const h = 300;
    const px = new Uint8Array(w * h * ch);
    const CARD: RGB = [40, 30, 66];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // 10px mat on the left, 90px on the right, card between.
        const isMatPx = x < 10 || x >= w - 90 || y < 12 || y >= h - 40;
        const c = isMatPx ? MAT : CARD;
        const o = (y * w + x) * ch;
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
      }
    const m = measureRetainedMatPerEdge(px, w, h, ch);
    expect(m.left).toBe(10);
    expect(m.right).toBe(90);
    expect(m.top).toBe(12);
    expect(m.bottom).toBe(40);
    // No opposing-edge averaging: left and right must NOT converge on 50.
    expect(m.left).not.toBe(m.right);
  });
});
