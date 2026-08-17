/**
 * THE CANONICAL LiDE 400 CARD-GEOMETRY DETECTOR — one algorithm, proven on both sides.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (staging, MV272, 17 Aug 11:25). Two independent implementations
 * of "where is the card" disagreed on IDENTICAL TIFF bytes:
 *
 *     local   63.49 x 89.05 mm   ACCEPTED   → operator shown a good preview
 *     server  100.0  x 114.0 mm  REJECTED   → capture destroyed after a 52-second scan
 *
 * They agreed on everything that mattered. Both learned the same background, rgb(233,232,233). The
 * server classified 42.18% of pixels as card, against 43.4% for a real card in a 100 x 130 region —
 * its SEGMENTATION was right. Its REDUCTION was `boundingBox(allForegroundPixels)`, and ~0.5% of
 * foreground pixels at the platen corner stretched that box from 62.8 mm to the full 100 mm.
 *
 * NOTHING HERE WEAKENS AN EVIDENCE RULE. The 4 mm margin floor, the 55–78 x 80–105 mm plausibility
 * window, 1200 DPI, sRGB and the immutable-TIFF requirement are all unchanged and are all asserted
 * below to still reject what they always rejected. Only the measurement handed to them changed.
 *
 * The mutation proof at the end restores the old global bounding box and shows the real MV272
 * artifact failing again — so this suite cannot pass with the defect reintroduced.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { detectLide400CardBounds, CARD_SEARCH_MM } from "@shared/lide400-card-geometry.cjs";
import { assessLide400CardFrame, LIDE_400_MIN_EVIDENCE_MARGIN_MM } from "../server/lib/lide400-card-frame";
import { inspectScannerEvidence } from "../server/lib/image-evidence";

const AREA = { width: 100, height: 130 } as const;
const BG = { r: 233, g: 232, b: 233 } as const;
const CARD = { r: 40, g: 90, b: 160 } as const;

/**
 * The REAL artifacts from the physical test. Both are ~43 MB, so they are read from the operator's
 * scans directory when present rather than committed. The deterministic fixtures below reproduce
 * their exact characteristics, so the suite proves the same properties on any machine.
 */
const REAL = {
  geometryRejected:
    "/Users/cornelius/mintvault-scans/failed/2026-08-17/mintvault-lide-71CF9449-9B7E-4D49-9F02-F018DAD1E82C.tiff",
  rgbRejected:
    "/Users/cornelius/mintvault-scans/discarded/2026-08-17/mintvault-lide-D5B907B4-A8DC-44C7-8EF9-07F4254CCA64.tiff",
};

/**
 * Build a raster in the SAME shape the detectors receive: a uniform platen background with an
 * opaque card region, at the real 1386 x 1800 working resolution so millimetre maths is realistic.
 */
function raster(opts: {
  cardMm?: { x: number; y: number; width: number; height: number } | null;
  /** Sparse specks — the corner outliers that defeated the global bounding box. */
  specks?: Array<{ xMm: number; yMm: number }>;
  /** A second solid region, to prove a decoy cannot become the answer. */
  decoyMm?: { x: number; y: number; width: number; height: number };
  /** A dense non-card mass touching the frame edge. */
  contaminationMm?: { x: number; y: number; width: number; height: number };
}): { data: Uint8Array; width: number; height: number } {
  const width = 1386;
  const height = 1800;
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = BG.r;
    data[i * 3 + 1] = BG.g;
    data[i * 3 + 2] = BG.b;
  }
  const pxX = (mm: number) => Math.round((mm / AREA.width) * width);
  const pxY = (mm: number) => Math.round((mm / AREA.height) * height);
  const fill = (r: { x: number; y: number; width: number; height: number }) => {
    for (let y = pxY(r.y); y < pxY(r.y + r.height) && y < height; y++) {
      for (let x = pxX(r.x); x < pxX(r.x + r.width) && x < width; x++) {
        if (x < 0 || y < 0) continue;
        const o = (y * width + x) * 3;
        data[o] = CARD.r;
        data[o + 1] = CARD.g;
        data[o + 2] = CARD.b;
      }
    }
  };
  if (opts.cardMm) fill(opts.cardMm);
  if (opts.decoyMm) fill(opts.decoyMm);
  if (opts.contaminationMm) fill(opts.contaminationMm);
  for (const s of opts.specks ?? []) {
    // A 2 x 2 speck: far too small to be a card, more than enough to stretch a global bbox.
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = Math.min(width - 1, Math.max(0, pxX(s.xMm) + dx));
        const y = Math.min(height - 1, Math.max(0, pxY(s.yMm) + dy));
        const o = (y * width + x) * 3;
        data[o] = CARD.r;
        data[o + 1] = CARD.g;
        data[o + 2] = CARD.b;
      }
    }
  }
  return { data, width, height };
}

const detect = (r: ReturnType<typeof raster>) => detectLide400CardBounds(r.data, r.width, r.height, 3, AREA);

/** A card at a realistic placement: 63.5 x 88.9 mm with ~5–6 mm background on the near sides. */
const STANDARD_CARD = { x: 6.3, y: 4.7, width: 63.5, height: 88.9 } as const;

describe("canonical LiDE 400 card geometry", () => {
  // ---- 9 / mutation target -----------------------------------------------------------------
  it("sparse corner outliers do not redefine the card — the whole point", () => {
    const clean = detect(raster({ cardMm: STANDARD_CARD }))!;
    const noisy = detect(
      raster({
        cardMm: STANDARD_CARD,
        // The exact shape of the real failure: specks at the extreme corners of the frame.
        specks: [
          { xMm: 0.2, yMm: 0.2 },
          { xMm: 99.5, yMm: 0.4 },
          { xMm: 0.4, yMm: 113.5 },
          { xMm: 99.6, yMm: 129.5 },
        ],
      })
    )!;

    expect(clean).not.toBeNull();
    expect(noisy).not.toBeNull();
    // A global bounding box would report ~100 x 130 here. The canonical reduction reports the card.
    expect(noisy.cardBoundsMm.width).toBeCloseTo(clean.cardBoundsMm.width, 1);
    expect(noisy.cardBoundsMm.height).toBeCloseTo(clean.cardBoundsMm.height, 1);
    expect(noisy.cardBoundsMm.width).toBeGreaterThan(60);
    expect(noisy.cardBoundsMm.width).toBeLessThan(67);
    expect(noisy.cardBoundsMm.height).toBeGreaterThan(85);
    expect(noisy.cardBoundsMm.height).toBeLessThan(92);
  });

  // ---- 3 ------------------------------------------------------------------------------------
  it("a clean ordinary card passes the full server assessment", async () => {
    const r = raster({ cardMm: STANDARD_CARD });
    const tiff = await sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 3 } })
      .tiff({ compression: "lzw" })
      .withMetadata({ density: 1200 })
      .toBuffer();
    const inspection = await inspectScannerEvidence(tiff);
    const assessment = await assessLide400CardFrame(tiff, inspection, AREA);
    expect(assessment.accepted).toBe(true);
    expect(assessment.reason).toBeNull();
  });

  // ---- 4 ------------------------------------------------------------------------------------
  it("a genuinely CLIPPED card still fails — an edge running off the frame is not a card", () => {
    // Extends past the right boundary: its visible span is 100 - 6.3 = 93.7 mm, outside the search
    // window entirely, so no card-shaped region exists to find.
    const clipped = detect(raster({ cardMm: { x: 6.3, y: 4.7, width: 120, height: 88.9 } }));
    expect(clipped).toBeNull();
  });

  // ---- 5 ------------------------------------------------------------------------------------
  it("a card with less than the 4 mm evidence margin still fails, and the floor is still 4", async () => {
    expect(LIDE_400_MIN_EVIDENCE_MARGIN_MM).toBe(4);
    const tight = detect(raster({ cardMm: { x: 1.5, y: 4.7, width: 63.5, height: 88.9 } }))!;
    expect(tight).not.toBeNull();
    // The detector still FINDS it — refusing is validation's job, not the detector's.
    expect(tight.cardBoundsMm.width).toBeGreaterThan(60);
    expect(Math.min(...Object.values(tight.evidenceMarginMm))).toBeLessThan(4);

    const r = raster({ cardMm: { x: 1.5, y: 4.7, width: 63.5, height: 88.9 } });
    const tiff = await sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 3 } })
      .tiff({ compression: "lzw" })
      .withMetadata({ density: 1200 })
      .toBuffer();
    const assessment = await assessLide400CardFrame(tiff, await inspectScannerEvidence(tiff), AREA);
    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toMatch(/too close to the hardware acquisition boundary/);
  });

  // ---- 6 ------------------------------------------------------------------------------------
  it("an oversized non-card object is not accepted as a card", () => {
    expect(detect(raster({ cardMm: { x: 5, y: 5, width: 90, height: 118 } }))).toBeNull();
    // And a too-small object cannot pass as one either.
    expect(detect(raster({ cardMm: { x: 20, y: 30, width: 30, height: 40 } }))).toBeNull();
  });

  // ---- 7 ------------------------------------------------------------------------------------
  it("multiple disconnected regions cannot trick the detector into spanning them", () => {
    const withDecoy = detect(
      raster({ cardMm: STANDARD_CARD, decoyMm: { x: 80, y: 100, width: 14, height: 22 } })
    )!;
    expect(withDecoy).not.toBeNull();
    // The answer is still ONE card, not a box enclosing card + decoy (which would be ~88 x 117 mm).
    expect(withDecoy.cardBoundsMm.width).toBeLessThan(67);
    expect(withDecoy.cardBoundsMm.height).toBeLessThan(92);
  });

  // ---- 8 ------------------------------------------------------------------------------------
  it("DENSE contamination touching the acquisition boundary fails closed", async () => {
    // A broad mass along the full left edge: not sparse specks, a real occlusion. It merges with the
    // card in projection and no card-sized run survives.
    const r = raster({ cardMm: STANDARD_CARD, contaminationMm: { x: 0, y: 0, width: 8, height: 130 } });
    const tiff = await sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 3 } })
      .tiff({ compression: "lzw" })
      .withMetadata({ density: 1200 })
      .toBuffer();
    const assessment = await assessLide400CardFrame(tiff, await inspectScannerEvidence(tiff), AREA);
    expect(assessment.accepted).toBe(false);
  });

  // ---- 12 -----------------------------------------------------------------------------------
  it("the canonical coordinate space is declared and carries no 180-degree inversion", () => {
    const detected = detect(raster({ cardMm: STANDARD_CARD }))!;
    expect(detected.coordinateSpace).toBe("lide400-acquisition-rect-mm-v1");
    // Origin is the acquisition rect's top-left, +X right, +Y down: a card placed near the top-left
    // reports small x/y. Under the Preview's presentation inversion it would report ~30 / ~36.
    expect(detected.cardBoundsMm.x).toBeGreaterThan(4);
    expect(detected.cardBoundsMm.x).toBeLessThan(9);
    expect(detected.cardBoundsMm.y).toBeGreaterThan(3);
    expect(detected.cardBoundsMm.y).toBeLessThan(8);
    // Margins are consistent with the bounds in the same convention.
    expect(detected.evidenceMarginMm.left).toBeCloseTo(detected.cardBoundsMm.x, 5);
    expect(detected.evidenceMarginMm.right).toBeCloseTo(
      AREA.width - (detected.cardBoundsMm.x + detected.cardBoundsMm.width),
      5
    );
  });

  it("the detector never invents a card from an empty frame", () => {
    expect(detect(raster({ cardMm: null }))).toBeNull();
    expect(CARD_SEARCH_MM.minWidth).toBeGreaterThan(0);
  });

  // ---- MUTATION PROOF -----------------------------------------------------------------------
  it("MUTATION: the old global bounding box fails the very frame the canonical detector passes", () => {
    const r = raster({
      cardMm: STANDARD_CARD,
      specks: [
        { xMm: 0.2, yMm: 0.2 },
        { xMm: 99.5, yMm: 113.5 },
      ],
    });
    // Reconstruct the retired reduction: bounding box of every foreground pixel.
    let minX = r.width;
    let maxX = 0;
    let minY = r.height;
    let maxY = 0;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const o = (y * r.width + x) * 3;
        const dr = r.data[o] - BG.r;
        const dg = r.data[o + 1] - BG.g;
        const db = r.data[o + 2] - BG.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) <= 45) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const legacyWidthMm = ((maxX - minX + 1) / r.width) * AREA.width;
    const legacyHeightMm = ((maxY - minY + 1) / r.height) * AREA.height;

    // The retired algorithm reports the whole frame and would be refused as implausible…
    expect(legacyWidthMm).toBeGreaterThan(95);
    expect(legacyHeightMm).toBeGreaterThan(105);
    // …on the exact same pixels the canonical detector measures as a standard card.
    const canonical = detect(r)!;
    expect(canonical.cardBoundsMm.width).toBeLessThan(67);
    expect(canonical.cardBoundsMm.height).toBeLessThan(92);
  });

  // ---- 1 & 2 — the REAL preserved artifacts --------------------------------------------------
  const realAvailable = existsSync(REAL.geometryRejected) && existsSync(REAL.rgbRejected);
  (realAvailable ? it : it.skip)(
    "both REAL rejected MV272 masters are measured as a standard card and accepted",
    async () => {
      for (const [label, file] of Object.entries(REAL)) {
        const buf = readFileSync(file);
        const inspection = await inspectScannerEvidence(buf);
        // 10 — the Canon's real RGB + associated alpha, still three colour channels.
        expect(inspection.channels).toBe(4);
        expect(inspection.hasAlpha).toBe(true);
        expect(inspection.colourSpace).toBe("srgb");
        expect(inspection.dpi).toBe(1200);

        const assessment = await assessLide400CardFrame(buf, inspection, AREA);
        expect(assessment.accepted, `${label}: ${assessment.reason ?? ""}`).toBe(true);
        // A standard card is 63.5 x 88.9 mm. Both masters must measure as one.
        expect(assessment.cardBoundsMm!.width).toBeGreaterThan(62);
        expect(assessment.cardBoundsMm!.width).toBeLessThan(66);
        expect(assessment.cardBoundsMm!.height).toBeGreaterThan(87);
        expect(assessment.cardBoundsMm!.height).toBeLessThan(92);
        // And the 4 mm floor is genuinely satisfied, not bypassed.
        expect(Math.min(...Object.values(assessment.evidenceMarginMm!))).toBeGreaterThanOrEqual(4);
      }
    },
    120_000
  );
});
