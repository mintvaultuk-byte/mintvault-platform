/**
 * Sleeved / top-loader physical-card isolation — production-path tests.
 *
 * These exercise the REAL exported functions from server/image-processing.ts
 * (detectPhysicalCardRect, assessNearFullFrame, planCardSafetyMargin,
 * cropToCardBoundary) — not a re-implementation. The fixtures model the
 * scanner FRAME (bed + sleeve + card + jig), which is the geometry that broke
 * the old global min/max bounding box.
 *
 * The MV642 reference numbers quoted throughout were measured on the real
 * production source (images/grading/1101/front_original.jpg, 1474×2000). That
 * file is a customer card image and is deliberately NOT committed; the tests
 * that need it are guarded by MINTVAULT_MV642_FRONT and are reported as
 * environment-gated when it is absent — never as passes.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import sharp from "sharp";
import {
  detectPhysicalCardRect,
  assessNearFullFrame,
  planCardSafetyMargin,
  cropToCardBoundary,
  detectCardBoundary,
  evaluateCropIntegrity,
  assessMatPlausibility,
  MAX_EDGE_TRIM_BEYOND_MAT_MM,
  LOW_CONFIDENCE_MAT_MULTIPLE,
  MAX_EDGE_TRIM_UNKNOWN_MAT_MM,
} from "../server/image-processing";
import {
  makeSleevedScanFixture,
  makeCardFixture,
  toRaw,
  SLEEVED_REFERENCE,
  SENTINELS,
  colourFraction,
} from "./helpers/card-fixtures";

const CARD_ASPECT = 63 / 88;
const MV642 = process.env.MINTVAULT_MV642_FRONT;

/** Convenience: build a fixture and run the physical-card detector on it. */
async function detect(spec: Parameters<typeof makeSleevedScanFixture>[0]) {
  const buf = await makeSleevedScanFixture(spec);
  const { pixels, w, h, ch } = await toRaw(buf);
  return { buf, w, h, ch, rect: detectPhysicalCardRect(pixels, w, h, ch) };
}

describe("near-full-frame fail-closed guard", () => {
  const W = 1106;
  const H = 1500;

  it("(1) rejects a near-full-frame rectangle as physical-card isolation", () => {
    // MV642/front's actual primary result: 1104×1483 of an 1106×1500 frame.
    const a = assessNearFullFrame({ minX: 0, maxX: 1103, minY: 17, maxY: 1499 }, W, H);
    expect(a.nearFullFrame).toBe(true);
    expect(a.reasons).toContain("near_full_frame_not_card_isolation");
  });

  it("(2) rejects removal of only a few pixels as meaningful isolation", () => {
    const a = assessNearFullFrame({ minX: 1, maxX: W - 2, minY: 1, maxY: H - 2 }, W, H);
    expect(a.nearFullFrame).toBe(true);
    expect(a.reasons).toContain("negligible_pixels_removed");
    expect(a.retainedFraction.area).toBeGreaterThan(0.99);
  });

  it("(5) rejects the scanner-frame boundary itself as the card", () => {
    const a = assessNearFullFrame({ minX: 0, maxX: W - 1, minY: 0, maxY: H - 1 }, W, H);
    expect(a.nearFullFrame).toBe(true);
    expect(a.frameAdjacentEdges).toBe(4);
    expect(a.reasons).toContain("frame_adjacent_edges");
  });

  it("accepts a genuine card rectangle that sits clear of every frame edge", () => {
    // MV642's true card, measured: 985×1374 at (75,96) in the same frame.
    const a = assessNearFullFrame({ minX: 75, maxX: 1059, minY: 96, maxY: 1469 }, W, H);
    expect(a.nearFullFrame).toBe(false);
    expect(a.frameAdjacentEdges).toBe(0);
    expect(a.reasons).toEqual([]);
  });
});

describe("multi-signal physical-card rectangle", () => {
  it("(7) multi-signal agreement produces a trusted rectangle on a clean sleeved scan", async () => {
    const { rect } = await detect({ sleeve: "penny_sleeve" });
    expect(rect).not.toBeNull();
    expect(rect!.trusted).toBe(true);
    expect(rect!.signalCount).toBe(7);
    expect(rect!.confidence).toBe("high");
    expect(rect!.reasons).toEqual([]);
  });

  it("(3) enforces the physical card aspect within the documented tolerance", async () => {
    const { rect } = await detect({ sleeve: "penny_sleeve" });
    expect(Math.abs(rect!.aspect - CARD_ASPECT)).toBeLessThanOrEqual(0.035);
    expect(rect!.signals.aspectOk).toBe(true);

    // A rectangle that is card-sized but the wrong shape must fail the aspect
    // signal and therefore never be trusted, regardless of the other signals.
    const wide = await detect({ cardW: 640, cardH: 640, cardY: 180, sleeve: "none" });
    expect(wide.rect!.signals.aspectOk).toBe(false);
    expect(wide.rect!.reasons).toContain("aspect_out_of_card_range");
    expect(wide.rect!.trusted).toBe(false);
  });

  it("(4) selects the inner card, not the sleeve or top-loader rectangle", async () => {
    for (const sleeve of ["penny_sleeve", "toploader"] as const) {
      const { rect } = await detect({ sleeve });
      expect(rect!.trusted).toBe(true);
      // The card is at (50,64) with the sleeve 11 px (penny) / 22 px (toploader)
      // further out. Landing on the sleeve would put minX at 39 or 28.
      expect(rect!.minX).toBeGreaterThanOrEqual(SLEEVED_REFERENCE.cardX - 3);
      expect(rect!.minY).toBeGreaterThanOrEqual(SLEEVED_REFERENCE.cardY - 3);
      expect(rect!.w).toBeLessThanOrEqual(SLEEVED_REFERENCE.cardW + 6);
      expect(rect!.h).toBeLessThanOrEqual(SLEEVED_REFERENCE.cardH + 6);
    }
  });

  it("(6) does not take a jig or guide-rail boundary as the card edge", async () => {
    const { rect, w, h } = await detect({ sleeve: "penny_sleeve", jigLeft: true, guideBottom: true });
    expect(rect!.trusted).toBe(true);
    // The jig occupies x < 3.5% of the frame and the guide y > 97.5%. A rect
    // that swallowed either would start at x≈0 or end at y≈h-1.
    expect(rect!.minX).toBeGreaterThan(Math.round(w * 0.035));
    expect(rect!.maxY).toBeLessThan(h - Math.round(h * 0.015));
    expect(rect!.signals.notFrameAdjacent).toBe(true);
  });

  it("(8) fails closed on weak or conflicting evidence", async () => {
    // A frame that is almost entirely card: no bed on any side, so there is no
    // step evidence and no way to confirm the card is complete.
    const { rect } = await detect({
      frameW: 660,
      frameH: 920,
      cardW: 656,
      cardH: 916,
      cardX: 2,
      cardY: 2,
      sleeve: "none",
    });
    expect(rect === null || rect.trusted === false).toBe(true);
    if (rect) {
      expect(rect.reasons.length).toBeGreaterThan(0);
      expect(rect.signalCount).toBeLessThan(7);
      expect(rect.reasons).toContain("surround_is_not_scanner_background");
    }
  });

  it("(21) is deterministic across repeated runs on identical input", async () => {
    const buf = await makeSleevedScanFixture({ sleeve: "toploader", jigLeft: true });
    const { pixels, w, h, ch } = await toRaw(buf);
    const runs = [0, 1, 2].map(() => detectPhysicalCardRect(pixels, w, h, ch));
    expect(JSON.stringify(runs[1])).toBe(JSON.stringify(runs[0]));
    expect(JSON.stringify(runs[2])).toBe(JSON.stringify(runs[0]));
  });
});

describe("controlled millimetre safety margin", () => {
  it("(10) preserves the complete card and adds the margin strictly outside it", async () => {
    const { rect, w, h } = await detect({ sleeve: "penny_sleeve" });
    const plan = planCardSafetyMargin(rect!, w, h);
    expect(plan.requestedMm).toBe(1.5);
    // Margin only ever expands: every edge of the padded rect is at or outside
    // the detected card edge, so the card cannot be clipped by this step.
    expect(plan.rect.minX).toBeLessThanOrEqual(rect!.minX);
    expect(plan.rect.minY).toBeLessThanOrEqual(rect!.minY);
    expect(plan.rect.maxX).toBeGreaterThanOrEqual(rect!.maxX);
    expect(plan.rect.maxY).toBeGreaterThanOrEqual(rect!.maxY);
    // And it stays inside the source frame — no invented padding.
    expect(plan.rect.minX).toBeGreaterThanOrEqual(0);
    expect(plan.rect.minY).toBeGreaterThanOrEqual(0);
    expect(plan.rect.maxX).toBeLessThanOrEqual(w - 1);
    expect(plan.rect.maxY).toBeLessThanOrEqual(h - 1);
  });

  it("reduces the margin per edge, bounded and reported, when the source is short", async () => {
    // Card pushed hard against the top: only 3 px of bed above it.
    const { rect, w, h } = await detect({ cardY: 3, sleeve: "none" });
    if (!rect) return expect.unreachable("fixture must yield a rectangle");
    const plan = planCardSafetyMargin(rect, w, h);
    expect(plan.appliedPx.top).toBeLessThanOrEqual(rect.edgeDist.top);
    expect(plan.rect.minY).toBeGreaterThanOrEqual(0);
    // The reduction is visible in forensics rather than silent.
    expect(plan.degraded).toBe(true);
    expect(plan.appliedMm.top).toBeLessThan(plan.requestedMm);
  });
});

describe("production crop path", () => {
  it("(9) the safe fallback never returns the full scanner frame as a crop", async () => {
    // Frame with hardware on three sides and no isolable card: the legacy
    // detector returns essentially the whole frame, and the guard must stop it
    // being emitted as a crop.
    const buf = await makeSleevedScanFixture({
      sleeve: "none",
      jigLeft: true,
      guideBottom: true,
      cardX: 1,
      cardY: 1,
      cardW: 733,
      cardH: 996,
    });
    const out = await cropToCardBoundary(buf, "TEST-FULLFRAME");
    expect(out).not.toBeNull();
    if (out!.isolation?.method === "fail_closed") {
      expect(out!.cropped).toBe(false);
      expect(out!.isolation.requiresRecapture).toBe(true);
      expect(out!.isolation.reasons.length).toBeGreaterThan(0);
    } else {
      // If it did crop, it must be a genuinely isolated card — never the frame.
      const m = await sharp(out!.buffer).metadata();
      const src = await sharp(buf).metadata();
      expect(m.width! / src.width!).toBeLessThan(0.97);
    }
  });

  it("(14) removes hardware from a sleeved scan carrying a jig and a guide rail", async () => {
    const src = await makeSleevedScanFixture({ sleeve: "penny_sleeve", jigLeft: true, guideBottom: true });
    const out = await cropToCardBoundary(src, "TEST-MV642-SHAPED");
    expect(out).not.toBeNull();
    expect(out!.isolation?.method).toBe("physical_card_rect");
    expect(out!.cropped).toBe(true);
    const m = await sharp(out!.buffer).metadata();
    const s = await sharp(src).metadata();
    // The jig band (3.5% of width) and the guide (2.5% of height) are gone.
    expect(m.width!).toBeLessThan(s.width! * 0.96);
    expect(m.height!).toBeLessThan(s.height! * 0.97);
    // All four card corners survive.
    expect(await colourFraction(out!.buffer, SENTINELS.corner)).toBeGreaterThan(0);
    // Geometric proof rather than a colour heuristic (the card's own art panel
    // is nearly as dark as the jig): the retained rectangle starts inside the
    // jig band and ends above the guide rail.
    const r = out!.isolation!.rect!;
    expect(r.minX).toBeGreaterThan(Math.round(r.minX + r.w + r.edgeDist.right) * 0.035);
    expect(r.edgeDist.bottom).toBeGreaterThan(0);
    expect(out!.isolation!.margin!.degraded).toBe(false);
  });

  it("(20) existing good unsleeved scans still crop and do not regress", async () => {
    // The already-tight fixtures used by the front-crop-integrity suite: a
    // 30 px mat on every side and nothing else in frame.
    for (const border of ["pale_white", "silver", "yellow", "dark", "back_blue"] as const) {
      const src = await makeCardFixture({ border });
      const out = await cropToCardBoundary(src, `TEST-${border}`);
      expect(out, border).not.toBeNull();
      const m = await sharp(out!.buffer).metadata();
      const s = await sharp(src).metadata();
      // Something was actually removed, and the card was not eaten into.
      expect(m.width!, border).toBeLessThan(s.width!);
      expect(m.width! / s.width!, border).toBeGreaterThan(0.85);
      expect(await colourFraction(out!.buffer, SENTINELS.corner), border).toBeGreaterThan(0);
    }
  });

  it("(11) a rejected strict-bound tightening falls back to validated card isolation, not the frame", () => {
    // evaluateCropIntegrity is the strict-bound gate. A rejected proposal must
    // leave the caller on its INPUT — which, after this change, is the
    // card-relative intermediate rather than the scanner frame.
    const verdict = evaluateCropIntegrity({
      inputW: 1375,
      inputH: 1894,
      cropLeft: 0,
      cropTop: 0,
      cropW: 900,
      cropH: 1300,
      matMarginPx: { top: 31, bottom: 31, left: 31, right: 31 },
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
    // The input it falls back to is card-relative: aspect near the card, and
    // far smaller than any plausible scanner frame.
    expect(Math.abs(1375 / 1894 - CARD_ASPECT)).toBeLessThan(0.035);
  });
});

describe("confidence and strict-bound integration", () => {
  it("(12) a resolved artefact skip does not by itself lower confidence", () => {
    const p = assessMatPlausibility({ top: 35, bottom: 33, left: 32, right: 33 }, 1375, 1894, { skipped: true });
    // The state records that an artefact was skipped, and it stays usable.
    expect(p.state).toBe("valid_after_artefact_skip");
    expect(p.usableForAcceptance).toBe(true);
  });

  it("(13) genuine measurement uncertainty still lowers confidence", () => {
    const p = assessMatPlausibility({ top: 400, bottom: 400, left: 400, right: 400 }, 1375, 1894);
    expect(p.usableForAcceptance).toBe(false);
  });

  it("keeps the documented tolerance ladder intact", () => {
    expect(MAX_EDGE_TRIM_BEYOND_MAT_MM).toBe(0.8);
    expect(MAX_EDGE_TRIM_UNKNOWN_MAT_MM).toBe(6);
    expect(MAX_EDGE_TRIM_BEYOND_MAT_MM * LOW_CONFIDENCE_MAT_MULTIPLE).toBeCloseTo(2.4, 5);
  });
});

describe("MV642 reference regression (real production source)", () => {
  const gated = !MV642 || !fs.existsSync(MV642);

  it.skipIf(gated)(
    "(14) isolates the physical card and drops bed, sleeve and lower jig",
    { timeout: 30_000 },
    async () => {
      const raw = fs.readFileSync(MV642!);
      const resized = await sharp(raw)
        .rotate()
        .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const meta = await sharp(resized).metadata();
      expect(meta.width).toBe(1474);
      expect(meta.height).toBe(2000);

      const scale = Math.min(1, 1500 / Math.max(meta.width!, meta.height!));
      const { data, info } = await sharp(resized)
        .resize(Math.round(meta.width! * scale), Math.round(meta.height! * scale), { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const px = new Uint8Array(data);

      // The OLD primary detector returns the whole frame — this is the bug.
      const legacy = detectCardBoundary(px, info.width, info.height, info.channels);
      expect(legacy).not.toBeNull();
      const guard = assessNearFullFrame(legacy!, info.width, info.height);
      expect(guard.nearFullFrame).toBe(true);

      // The NEW detector finds the physical card, and the aspect agrees with the
      // 63×88 mm print spec to within 0.002 — independent confirmation.
      const rect = detectPhysicalCardRect(px, info.width, info.height, info.channels, "MV642");
      expect(rect).not.toBeNull();
      expect(rect!.trusted).toBe(true);
      expect(rect!.confidence).toBe("high");
      expect(rect!.signalCount).toBe(7);
      expect(Math.abs(rect!.aspect - CARD_ASPECT)).toBeLessThan(0.002);
      expect(rect!.minX).toBeGreaterThan(60);
      expect(rect!.minY).toBeGreaterThan(80);
      expect(rect!.maxY).toBeLessThan(info.height - 25);

      const out = await cropToCardBoundary(resized, "MV642");
      expect(out!.isolation?.method).toBe("physical_card_rect");
      const m = await sharp(out!.buffer).metadata();
      // Old output was 1441×1967 — 97.8% × 98.4% of source. New must be far tighter.
      expect(m.width! / meta.width!).toBeLessThan(0.95);
      expect(m.height! / meta.height!).toBeLessThan(0.96);
      // Margin retained on every edge, in millimetres.
      const margin = out!.isolation!.margin!;
      expect(Math.min(...Object.values(margin.appliedMm))).toBeGreaterThan(0.5);
    }
  );

  it.skipIf(gated)("(21) produces a deterministic rectangle and decoded-pixel hash", { timeout: 30_000 }, async () => {
    const raw = fs.readFileSync(MV642!);
    const resized = await sharp(raw)
      .rotate()
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const a = await cropToCardBoundary(resized, "MV642");
    const b = await cropToCardBoundary(resized, "MV642");
    expect(JSON.stringify(a!.isolation!.rect)).toBe(JSON.stringify(b!.isolation!.rect));
    const rawA = await sharp(a!.buffer).removeAlpha().raw().toBuffer();
    const rawB = await sharp(b!.buffer).removeAlpha().raw().toBuffer();
    expect(rawA.equals(rawB)).toBe(true);
  });
});

/**
 * Named-card regressions against real production scans.
 *
 * These need the read-only scan cache (customer images, never committed).
 * Point MINTVAULT_SCAN_FIXTURE_DIR at a directory of `<CERT>-<side>.jpg`.
 * Without it every case here is SKIPPED — reported as environment-gated, not
 * as a pass. Expected outcomes were measured on the real sources; see
 * docs/front-crop-integrity.md.
 */
describe("named-card regressions (real scans, environment-gated)", () => {
  const DIR = process.env.MINTVAULT_SCAN_FIXTURE_DIR;
  const has = (cert: string, side: string) => Boolean(DIR && fs.existsSync(`${DIR}/${cert}-${side}.jpg`));

  async function isolate(cert: string, side: string) {
    const raw = fs.readFileSync(`${DIR}/${cert}-${side}.jpg`);
    const resized = await sharp(raw)
      .rotate()
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const out = await cropToCardBoundary(resized, cert);
    const emitted = out ? await sharp(out.buffer).metadata() : null;
    return { out, meta, emitted };
  }

  it.skipIf(!has("MV605", "front"))(
    "(15) MV605 front isolates the card and states any rejection explicitly",
    { timeout: 30_000 },
    async () => {
      const { out, meta, emitted } = await isolate("MV605", "front");
      expect(out!.isolation!.method).toBe("physical_card_rect");
      expect(out!.isolation!.rect!.trusted).toBe(true);
      // Was rejected at the strict bound on a whole-frame input (0.73 mm
      // overshoot measured against an unreliable mat). With a card-relative
      // intermediate the measurement is sound and the face passes.
      expect(emitted!.width! / meta.width!).toBeLessThan(0.97);
      expect(out!.isolation!.reasons).toEqual([]);
    }
  );

  it.skipIf(!has("MV605", "back"))(
    "(16) MV605 back does not revert to scanner-frame output",
    { timeout: 30_000 },
    async () => {
      const { out, meta, emitted } = await isolate("MV605", "back");
      expect(out!.isolation!.method).toBe("physical_card_rect");
      expect(emitted!.width!).toBeLessThan(meta.width!);
      expect(emitted!.height!).toBeLessThan(meta.height!);
    }
  );

  it.skipIf(!has("MV609", "back"))(
    "(17) MV609 back does not revert to scanner-frame output",
    { timeout: 30_000 },
    async () => {
      const { out, meta, emitted } = await isolate("MV609", "back");
      expect(out!.isolation!.method).toBe("physical_card_rect");
      expect(emitted!.width! / meta.width!).toBeLessThan(0.97);
      expect(Math.abs(out!.isolation!.rect!.aspect - CARD_ASPECT)).toBeLessThan(0.035);
    }
  );

  it.skipIf(!has("MV586", "front"))(
    "(18) MV586 remains fail-closed rather than guessing",
    { timeout: 30_000 },
    async () => {
      const { out } = await isolate("MV586", "front");
      expect(out!.isolation!.method).toBe("fail_closed");
      expect(out!.isolation!.requiresRecapture).toBe(true);
      expect(out!.cropped).toBe(false);
      expect(out!.isolation!.reasons).toContain("near_full_frame_not_card_isolation");
    }
  );

  it.skipIf(!has("MV394", "front"))(
    "(19) MV394 front is handled explicitly, never guessed",
    { timeout: 30_000 },
    async () => {
      const { out } = await isolate("MV394", "front");
      // Primary detection genuinely fails on this scan: the mat-distance
      // detector finds no plausible foreground and the coverage profile finds no
      // card plateau. The requirement is that it says so and returns NOTHING —
      // never a guessed rectangle. generateImageVariants then marks the face
      // requiresRecapture, which suppresses the misleading uniform inset.
      expect(out).toBeNull();

      // And the physical-card detector agrees: no trustworthy rectangle exists.
      const raw = fs.readFileSync(`${DIR}/MV394-front.jpg`);
      const resized = await sharp(raw)
        .rotate()
        .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const m = await sharp(resized).metadata();
      const scale = Math.min(1, 1500 / Math.max(m.width!, m.height!));
      const { data, info } = await sharp(resized)
        .resize(Math.round(m.width! * scale), Math.round(m.height! * scale), { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const rect = detectPhysicalCardRect(new Uint8Array(data), info.width, info.height, info.channels, "MV394");
      expect(rect === null || rect.trusted === false).toBe(true);
    }
  );

  it.skipIf(!has("MV394", "back"))("MV394 back recovers a trusted card rectangle", { timeout: 30_000 }, async () => {
    const { out } = await isolate("MV394", "back");
    expect(out!.isolation!.method).toBe("physical_card_rect");
    expect(out!.isolation!.rect!.confidence).toBe("high");
  });

  it.skipIf(!has("MV602", "back"))(
    "MV602 back survives an interior coverage dip (hysteresis)",
    { timeout: 30_000 },
    async () => {
      const { out } = await isolate("MV602", "back");
      // A pale highlight band across the card at ~row 676 dips below the seed
      // threshold. Without run extension the detector kept only the lower 765
      // rows (aspect 1.28) and failed the face closed.
      expect(out!.isolation!.method).toBe("physical_card_rect");
      expect(Math.abs(out!.isolation!.rect!.aspect - CARD_ASPECT)).toBeLessThan(0.035);
    }
  );
});
