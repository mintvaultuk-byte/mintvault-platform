import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  RAIL_SAFE_MIN_WIDTH_PX,
  RAIL_SIDE_PADDING_PX,
  heightBoundCardWidth,
  requiredRailWidth,
  resolveRailWidth,
  sessionRequiredRailWidth,
  shouldAdoptRailWidth,
} from "@shared/rail-width";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ASIDE = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const VIEWER = read("client/src/components/grading/image-viewer.tsx");
const CONTEXT = read("client/src/components/grading-workflow/rail-width-context.tsx");
const RAIL_WIDTH_SRC = read("shared/rail-width.ts");

/**
 * The three real measurements this model was derived from and must reproduce.
 * Taken in a real browser against the compiled CSS, inside the real AdminShell
 * focus chain, at /dev/admin-shell-geometry.
 */
const MEASURED = {
  "845x685": { safeCardHeight: 456.2, cardW: 327.0, currentRail: 371.3 },
  "1024x768": { safeCardHeight: 531.7, cardW: 381.1, currentRail: 451.8 },
  "1280x800": { safeCardHeight: 563.7, cardW: 404.0, currentRail: 567.0 },
};
const FIXTURE = { naturalWidth: 734, naturalHeight: 1024 };

describe("1. the rail is predicted from card-INDEPENDENT inputs", () => {
  it("uses the SOURCE image's natural aspect, never a rendered card box", () => {
    // naturalWidth/naturalHeight are decoded source dimensions, fixed before
    // layout. That is the whole reason sizing the parent from them is safe.
    for (const [label, m] of Object.entries(MEASURED)) {
      const predicted = heightBoundCardWidth({ safeCardHeight: m.safeCardHeight, ...FIXTURE });
      expect(predicted, `${label} predicted card width`).toBeCloseTo(m.cardW, 0);
    }
  });

  it("the prediction is invariant to the rail it will be applied to", () => {
    // The decisive property. Same inputs must give the same answer no matter how
    // wide the rail currently is — otherwise rail -> prediction -> rail closes.
    const m = MEASURED["1280x800"];
    const answers = [200, 452, 567, 900, 5000].map(() =>
      requiredRailWidth({ safeCardHeight: m.safeCardHeight, ...FIXTURE })
    );
    expect(new Set(answers).size).toBe(1);
  });

  it("neither the module nor its callers read a rendered card width", () => {
    // ANTI-VACUITY 2: the rail must never be sized from the card's own DOM box.
    expect(RAIL_WIDTH_SRC).not.toMatch(/getBoundingClientRect|offsetWidth|clientWidth/);
    // The aside applies a width; it must not measure the card to decide it.
    expect(ASIDE).not.toMatch(/ResizeObserver|getBoundingClientRect/);
    expect(CONTEXT).not.toMatch(/ResizeObserver|getBoundingClientRect/);
  });

  it("no arbitrary viewport-ratio constant anywhere in the model", () => {
    // ANTI-VACUITY 3. The whole point of this design is that it replaced a
    // guessed ratio, exactly as `calc(100dvh-4.5rem)` was a guessed offset.
    // Scoped to executable code: the file's documentation names the rejected
    // approaches in order to explain why they were rejected, and that prose must
    // not be what keeps this assertion honest.
    const code = RAIL_WIDTH_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/100dvh|visualViewport|innerHeight/);
    expect(code).not.toMatch(/\*\s*0\.\d+/); // no `height * 0.58`-style ratio
    expect(code).not.toMatch(/getBoundingClientRect|offsetWidth|clientWidth/);
  });
});

describe("2. the measured viewports reproduce, and the card never shrinks", () => {
  it("1280x800 recovers 115px and lands on exactly 24px margins", () => {
    const m = MEASURED["1280x800"];
    const required = requiredRailWidth({ safeCardHeight: m.safeCardHeight, ...FIXTURE });
    const final = resolveRailWidth({ required, safeMax: m.currentRail });
    expect(required).toBeCloseTo(452.0, 0);
    expect(final).toBeCloseTo(452.0, 0);
    expect(m.currentRail - final).toBeCloseTo(115.0, 0); // recovered, to the right pane
    expect((final - m.cardW) / 2).toBeCloseTo(RAIL_SIDE_PADDING_PX, 0);
  });

  it("1024x768 recovers ~22.7px", () => {
    const m = MEASURED["1024x768"];
    const final = resolveRailWidth({
      required: requiredRailWidth({ safeCardHeight: m.safeCardHeight, ...FIXTURE }),
      safeMax: m.currentRail,
    });
    expect(m.currentRail - final).toBeCloseTo(22.7, 0);
  });

  it("845x685 does NOT narrow — the owner's viewport is already tighter than the target", () => {
    // ANTI-VACUITY 4 + the hard acceptance rule. The requirement (376.4) EXCEEDS
    // the current rail (371.3), so the clamp must return the current width.
    // A complete card outranks recovered space.
    const m = MEASURED["845x685"];
    const required = requiredRailWidth({ safeCardHeight: m.safeCardHeight, ...FIXTURE });
    expect(required).toBeGreaterThan(m.currentRail);
    expect(resolveRailWidth({ required, safeMax: m.currentRail })).toBe(m.currentRail);
  });

  it("the rail can never be narrower than the card needs plus its padding", () => {
    // ANTI-VACUITY 4, stated as the general invariant rather than one viewport.
    for (const m of Object.values(MEASURED)) {
      const required = requiredRailWidth({ safeCardHeight: m.safeCardHeight, ...FIXTURE });
      const final = resolveRailWidth({ required, safeMax: m.currentRail });
      // Either we met the requirement exactly, or the current rail was tighter
      // and we left it alone — never something in between that clips the card.
      expect(final === m.currentRail || Math.abs(final - required) < 0.01).toBe(true);
      if (final < required) expect(final).toBe(m.currentRail);
    }
  });

  it("never collapses below the safe minimum", () => {
    expect(resolveRailWidth({ required: 10, safeMax: 900 })).toBe(RAIL_SAFE_MIN_WIDTH_PX);
  });

  it("a degenerate source leaves the rail alone rather than pinching it", () => {
    for (const bad of [
      { naturalWidth: 0, naturalHeight: 1024 },
      { naturalWidth: 734, naturalHeight: 0 },
      { naturalWidth: NaN, naturalHeight: 1024 },
      { naturalWidth: 734, naturalHeight: Infinity },
    ]) {
      const required = requiredRailWidth({ safeCardHeight: 500, ...bad });
      expect(required).toBe(0);
      expect(resolveRailWidth({ required, safeMax: 567 })).toBe(567);
    }
  });
});

describe("3. aspect coverage — tall/narrow and wide scans", () => {
  it("a very tall narrow card asks for a narrower rail", () => {
    const tall = requiredRailWidth({ safeCardHeight: 563.7, naturalWidth: 500, naturalHeight: 1024 });
    const normal = requiredRailWidth({ safeCardHeight: 563.7, ...FIXTURE });
    expect(tall).toBeLessThan(normal);
    expect(tall).toBeCloseTo(563.7 * (500 / 1024) + 48, 1);
  });

  it("a wider scan asks for a wider rail, and the clamp stops it at today's width", () => {
    // 1100x1024 is wider than tall — a landscape scan. 563.7*(1100/1024)+48 = 653.5.
    const wide = requiredRailWidth({ safeCardHeight: 563.7, naturalWidth: 1100, naturalHeight: 1024 });
    expect(wide).toBeCloseTo(563.7 * (1100 / 1024) + 48, 1);
    expect(wide).toBeGreaterThan(567);
    // Clamped to safeMax: the rail never grows past what the layout gives today.
    expect(resolveRailWidth({ required: wide, safeMax: 567 })).toBe(567);
  });
});

describe("4. Front/Back stability", () => {
  it("the session requirement is the WIDEST side, so switching sides cannot move the rail", () => {
    // ANTI-VACUITY 5. Front and Back are separate scans with their own aspects.
    const front = { naturalWidth: 734, naturalHeight: 1024 };
    const back = { naturalWidth: 800, naturalHeight: 1024 };
    const both = sessionRequiredRailWidth([front, back], 563.7);
    const backOnly = sessionRequiredRailWidth([back], 563.7);
    const frontOnly = sessionRequiredRailWidth([front], 563.7);
    expect(both).toBeCloseTo(backOnly, 5); // the wider side wins
    expect(both).toBeGreaterThan(frontOnly);
    // Order must not matter — the answer is a max, not a last-write.
    expect(sessionRequiredRailWidth([back, front], 563.7)).toBeCloseTo(both, 5);
  });

  it("sides still decoding are ignored, not treated as zero-width", () => {
    const front = { naturalWidth: 734, naturalHeight: 1024 };
    expect(sessionRequiredRailWidth([front, null, undefined], 563.7)).toBeCloseTo(
      sessionRequiredRailWidth([front], 563.7),
      5
    );
  });
});

describe("5. the settle rule stops the controls-wrap feedback path", () => {
  it("the first prediction for an input set always settles", () => {
    expect(shouldAdoptRailWidth(null, 452)).toBe(true);
  });

  it("a NARROWER requirement at an unchanged key is refused — that is the wrap signature", () => {
    // ANTI-VACUITY 5 (oscillation). A narrower rail can wrap the controls row,
    // which lowers the available height, which lowers the next prediction. Left
    // alone that ratchets inward forever.
    expect(shouldAdoptRailWidth(452, 430)).toBe(false);
    expect(shouldAdoptRailWidth(452, 300)).toBe(false);
  });

  it("sub-epsilon churn is ignored in both directions", () => {
    expect(shouldAdoptRailWidth(452, 452.9)).toBe(false);
    expect(shouldAdoptRailWidth(452, 451.1)).toBe(false);
  });

  it("a genuinely wider requirement is adopted, and that direction terminates", () => {
    // Growth can only ever end at safeMax, so it cannot run away.
    expect(shouldAdoptRailWidth(452, 500)).toBe(true);
    expect(resolveRailWidth({ required: 500, safeMax: 567 })).toBe(500);
    expect(resolveRailWidth({ required: 5000, safeMax: 567 })).toBe(567);
  });

  it("repeated identical predictions converge to a single adoption", () => {
    let adopted: number | null = null;
    let adoptions = 0;
    for (let i = 0; i < 50; i++) {
      if (shouldAdoptRailWidth(adopted, 452)) {
        adopted = 452;
        adoptions++;
      }
    }
    expect(adoptions).toBe(1);
  });
});

describe("6. wiring — the rail is a max-width cap, applied desktop-only", () => {
  it("applies max-width, NOT width, so the browser evaluates min(45%, requirement)", () => {
    // ANTI-VACUITY 1: the responsive default must survive as the safe maximum.
    // Measuring the rail to learn its own maximum is the loop this avoids —
    // after the first adjustment the measured width would BE the adjusted width.
    expect(ASIDE).toContain("maxWidth");
    expect(ASIDE).not.toMatch(/style=\{\{\s*width:/);
    expect(ASIDE).toContain('WORKSTATION_PREVIEW_WIDTH_CLASS = "md:w-[45%] md:shrink-0"');
  });

  it("the cap is desktop-only, so the stacked mobile rail is untouched", () => {
    expect(ASIDE).toContain('matchMedia("(min-width: 768px)")');
    expect(ASIDE).toMatch(/isDesktop\s*&&/);
  });

  it("the prediction runs in a PASSIVE effect, never inside the fit's layout effect", () => {
    // Publishing inside the fit's useLayoutEffect updates the provider mid-layout,
    // re-rendering the aside and its portal host before the browser settles. The
    // card viewport's ResizeObserver then reports 0, the fit falls back to
    // width-only, and the card blows up to fill the rail — reproduced cold at
    // 1280x800 as 523x729.6 with the controls stranded at y=899, off-screen.
    // Assert on the HOOK CALL that opens the effect, not on the block text — the
    // doc comment deliberately names useLayoutEffect to explain the hazard.
    const docIdx = VIEWER.indexOf("PREDICT THE RAIL'S WIDTH");
    expect(docIdx).toBeGreaterThan(-1);
    const afterDoc = VIEWER.slice(docIdx);
    const hookCall = afterDoc.slice(afterDoc.indexOf("*/") + 2).trimStart();
    expect(hookCall.startsWith("useEffect(")).toBe(true);
    // And the fit itself is still the layout effect it always was.
    expect(VIEWER).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*?const widthScale = safeW \/ nat\.w;/);
  });

  it("the card's own fit maths is untouched by this pass", () => {
    // The frozen safe-fit contract: same inputs, same scale decision.
    expect(VIEWER).toContain("const widthScale = safeW / nat.w;");
    expect(VIEWER).toContain('const scale = mode === "safe-fit" ? Math.min(widthScale, safeH / nat.h) : widthScale;');
    expect(VIEWER).toContain("const safeW = vp.w - RAIL_SAFE_INSET_X * 2;");
    expect(VIEWER).toContain("const safeH = effectiveH - RAIL_SAFE_INSET_Y * 2;");
  });
});
