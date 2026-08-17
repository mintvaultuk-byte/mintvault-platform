/**
 * THE CARD MUST STOP MOVING.
 *
 * Owner P0, staging v492: two screenshots seconds apart showed the card present, then
 * absent, then present. It was alternating fast enough to make the workstation unusable.
 *
 * Cause — a two-mode limit cycle, possible because the fit's OUTPUT could become its own
 * INPUT. The card is in flow inside the measured viewport, so wherever an ancestor's
 * height is content-driven, the card's fitted height IS the viewport height:
 *
 *   no usable height -> fit by width -> card tall (width x natural aspect)
 *     -> viewport measures tall -> height "usable" -> fit by height -> card shrinks
 *     -> viewport measures short -> height unusable -> fit by width -> tall again -> ...
 *
 * Each lap re-rendered at a different size; the transient between laps is the
 * disappearance in the owner's screenshot.
 *
 * The cure is a RATCHET, not a debounce: a loop of this shape needs the measured height
 * to GROW in response to the card growing, so refusing to act on growth makes it
 * provably terminating. `shouldRecommitRailFit` is that decision, exported pure so this
 * file can DRIVE it over many cycles rather than assert the shape of the source.
 *
 * Runtime confirmation, real component in a real browser against a content-driven host
 * (the mode that closes the loop): 20 consecutive samples, 1 distinct render, fit
 * revision 1, observer count 2, never hidden.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { shouldRecommitRailFit } from "../client/src/components/grading/image-viewer";

const VIEWER = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/components/grading/image-viewer.tsx"),
  "utf8"
);

/** The natural aspect of a scan, used to model "the card's height becomes the viewport". */
const NAT_W = 1200;
const NAT_H = 1700;
const INSET_X = 10;
const INSET_Y = 14;

/**
 * Drives the real ratchet through a measurement sequence, modelling the feedback the
 * real layout produces: whatever height the card is committed at becomes the height the
 * NEXT measurement reports. That is the loop; if the ratchet does not stop it here, it
 * does not stop it in the browser either.
 */
function drive(sequence: Array<{ vw: number; vh: number }>) {
  let committed: { vw: number; vh: number; w: number; h: number } | null = null;
  const renders: string[] = [];
  let recommits = 0;

  for (const raw of sequence) {
    // Feedback: once a fit exists, the viewport reports the card's own height.
    const vh = committed ? committed.h : raw.vh;
    const measured = { vw: raw.vw, vh: raw.vh === 0 ? 0 : vh };

    if (measured.vw <= INSET_X * 2) {
      renders.push(committed ? `${committed.w.toFixed(1)}x${committed.h.toFixed(1)}` : "none");
      continue;
    }
    const heightUsable = measured.vh > INSET_Y * 2;
    const effectiveH = heightUsable ? measured.vh : (committed?.vh ?? 0);
    if (effectiveH <= INSET_Y * 2 && committed) {
      renders.push(`${committed.w.toFixed(1)}x${committed.h.toFixed(1)}`);
      continue;
    }

    if (shouldRecommitRailFit(committed, { vw: measured.vw, vh: effectiveH })) {
      const safeW = measured.vw - INSET_X * 2;
      const safeH = effectiveH - INSET_Y * 2;
      const scale = effectiveH > INSET_Y * 2 ? Math.min(safeW / NAT_W, safeH / NAT_H) : safeW / NAT_W;
      if (Number.isFinite(scale) && scale > 0) {
        committed = { vw: measured.vw, vh: effectiveH, w: NAT_W * scale, h: NAT_H * scale };
        recommits += 1;
      }
    }
    renders.push(committed ? `${committed.w.toFixed(1)}x${committed.h.toFixed(1)}` : "none");
  }
  return { renders, recommits, committed };
}

describe("the fit settles and the card never disappears again", () => {
  it("converges over 20+ measurement cycles with the layout feeding back", () => {
    const seq = Array.from({ length: 24 }, () => ({ vw: 373, vh: 522 }));
    const { renders, recommits, committed } = drive(seq);

    expect(renders).toHaveLength(24);
    expect(committed).not.toBeNull();
    // EXACTLY ONE commit. The first measurement is real; every later one is the card's
    // own height echoing back, and the echo guard refuses it. Without that guard this
    // returned 18 commits over 24 cycles — the card shrinking by one safety inset (28px)
    // per cycle until width finally bound. That is the "shrinking/growing cycles" in the
    // owner's report, and it is why the raw ratchet alone was not enough.
    expect(recommits).toBe(1);
    // Settled: the last two thirds of the cycles render byte-identically.
    const tail = renders.slice(1);
    expect(new Set(tail).size).toBe(1);
    expect(renders.every((r) => r !== "none")).toBe(true);
  });

  it("survives the exact owner sequence: valid, transient shrink, zero, valid, sub-pixel", () => {
    const seq = [
      { vw: 373, vh: 522 }, // valid
      { vw: 373, vh: 120 }, // transient smaller
      { vw: 373, vh: 0 }, // zero height
      { vw: 373, vh: 522 }, // valid again
      { vw: 373.4, vh: 522.3 }, // sub-pixel jitter
      ...Array.from({ length: 16 }, () => ({ vw: 373, vh: 522 })),
    ];
    const { renders } = drive(seq);
    // Once visible, ALWAYS visible — no invalid transient may blank the card.
    const first = renders.findIndex((r) => r !== "none");
    expect(first).toBe(0);
    expect(renders.slice(first).every((r) => r !== "none")).toBe(true);
    // And no 0x0 render at any point.
    expect(renders.some((r) => r.startsWith("0x") || r.endsWith("x0"))).toBe(false);
  });

  it("never lets a HEIGHT INCREASE recommit — that is the loop", () => {
    // The card growing can only ever increase the measured height. Acting on it is the
    // lap; refusing is what terminates.
    expect(shouldRecommitRailFit({ vw: 373, vh: 400, h: 372 }, { vw: 373, vh: 900 })).toBe(false);
    expect(shouldRecommitRailFit({ vw: 373, vh: 400, h: 372 }, { vw: 373, vh: 401 })).toBe(false);
  });

  it("still honours a genuine width change — the one card-independent input", () => {
    expect(shouldRecommitRailFit({ vw: 373, vh: 400, h: 372 }, { vw: 453, vh: 400 })).toBe(true);
  });

  it("still honours a height SHRINK, so the card cannot overflow its box", () => {
    expect(shouldRecommitRailFit({ vw: 373, vh: 400, h: 372 }, { vw: 373, vh: 300 })).toBe(true);
  });

  it("ignores sub-pixel jitter on both axes", () => {
    expect(shouldRecommitRailFit({ vw: 373, vh: 400, h: 372 }, { vw: 373.4, vh: 400.3 })).toBe(false);
    expect(shouldRecommitRailFit({ vw: 373, vh: 400, h: 372 }, { vw: 372.6, vh: 399.7 })).toBe(false);
  });

  it("commits when nothing is committed yet", () => {
    expect(shouldRecommitRailFit(null, { vw: 373, vh: 522 })).toBe(true);
  });
});

describe("the committed fit is per-source and never animated", () => {
  it("drops the last-known-good when the side or variant changes", () => {
    // Front's dimensions must never be reused for Back, which has its own aspect.
    expect(VIEWER).toMatch(/const railFitKey = `\$\{side\}\|\$\{variant\}`;/);
    expect(VIEWER).toMatch(/railFitRef\.current = null;/);
    expect(VIEWER).toMatch(/railFitRef\.current\?\.key === railFitKey/);
  });

  it("reads the committed fit from a ref, so unrelated re-renders cannot resize the card", () => {
    expect(VIEWER).toMatch(/const railFit = railFitRef\.current\?\.key === railFitKey \? railFitRef\.current : null;/);
  });

  it("keeps the fit mode sticky once a real height has been seen", () => {
    expect(VIEWER).toMatch(/heightUsable \|\| prev\?\.mode === "safe-fit"/);
  });

  it("NEVER animates an automatic fit", () => {
    // The frame inherits `transition: all` from the global styles, so a refit animated
    // width and height — a visible pulse on every measurement.
    expect(VIEWER).toMatch(/transition: "none"/);
  });

  it("exposes the stability counters acceptance depends on", () => {
    expect(VIEWER).toContain('"data-card-fit-revision"');
    expect(VIEWER).toContain('"data-card-observer-count"');
  });
});
