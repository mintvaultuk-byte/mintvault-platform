/**
 * THE ENTIRE SOURCE SCAN MUST BE VISIBLE, WITH ROOM TO SPARE.
 *
 * Owner rejection, 2026-08-16, real staging /admin: the bottom of the physical card
 * was still cut off. Five prior reproductions had measured "clipped = 0" and been
 * believed. Both were true, because they measured the wrong rectangle:
 *
 *   1. The card frame sized itself with `aspectRatio: 5/7` + `maxHeight: 100%`, and
 *      the <img> filled its content box exactly. The only gap was the frame's own
 *      `padding: 1.5%` (~4.5px) — padding, not visible clearance.
 *   2. The frame carried `rounded-[5%]` WITH `overflow-hidden`. On a ~370px card that
 *      is an ~18px corner radius eating into the scan's lower corners, where the set
 *      symbol, card number and copyright line live. A rect-inside-rect check cannot
 *      see a rounded mask, so every such check passed while content was being removed.
 *
 * The fix stops asking CSS to infer the fit: measure the real viewport, read the
 * scan's natural size, compute explicit pixels with a guaranteed safety inset, and
 * position the result. Runtime reproduction of the real component (real CSS, real
 * browser layout) at the three acceptance viewports, measuring the actual <img> rect
 * against the actual viewport rect:
 *
 *     845x685    viewport 373.0x473.0   img 314.1x445.0   clearance T14 B14 L29.4 R29.5
 *     1024x768   viewport 453.6x556.0   img 372.7x528.0   clearance T14 B14 L40.6 R40.3
 *     1280x800   viewport 568.8x588.0   img 395.3x560.0   clearance T14 B14 L86.9 R86.7
 *
 * These are SOURCE-CONTRACT tests. They deliberately do not assert pixel geometry —
 * jsdom/happy-dom return zero rects for this tree, and a geometry assertion that can
 * only ever pass is exactly the vacuous proof this defect was hiding behind. What
 * they pin is every mechanism the measured result depends on, so that removing any
 * one of them fails CI rather than silently reverting the owner-visible behaviour.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const VIEWER = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/components/grading/image-viewer.tsx"),
  "utf8"
);

/** The frame's inspection-mode style branch — where the fit is actually applied. */
const FIT_BRANCH = VIEWER.slice(VIEWER.indexOf("const cardFrame = ("), VIEWER.indexOf("data-testid=\"grading-image-viewport\""));

describe("the rail fits the WHOLE source scan, measured, with a safety margin", () => {
  it("keeps a bottom safety inset at or above the owner's 12px floor", () => {
    // The insets are what turn "technically inside the box" into "visibly ends here".
    const inset = VIEWER.match(/const RAIL_SAFE_INSET_Y = (\d+)/);
    expect(inset).not.toBeNull();
    expect(Number(inset![1])).toBeGreaterThanOrEqual(12);

    const floor = VIEWER.match(/RAIL_MIN_BOTTOM_CLEARANCE_PX = (\d+)/);
    expect(floor).not.toBeNull();
    expect(Number(floor![1])).toBe(12);
    // The inset must not be allowed to drift under the floor it exists to satisfy.
    expect(Number(inset![1])).toBeGreaterThanOrEqual(Number(floor![1]));
  });

  it("subtracts the insets from BOTH edges of each axis", () => {
    // Symmetric insets are what make centring safe: split evenly, each edge still
    // gets the full inset. Subtracting a single inset per axis would halve it.
    expect(VIEWER).toMatch(/railViewport\.w - RAIL_SAFE_INSET_X \* 2/);
    expect(VIEWER).toMatch(/railViewport\.h - RAIL_SAFE_INSET_Y \* 2/);
  });

  it("computes the fit from the SCAN's own natural dimensions, not an assumed ratio", () => {
    // A scan that is not exactly 5:7 is precisely the case where assuming 5:7 pushes
    // real card content past the edge.
    expect(VIEWER).toMatch(/Math\.min\(safeW \/ railNaturalDims\.w, safeH \/ railNaturalDims\.h\)/);
    expect(VIEWER).toMatch(/setRailNaturalDims\(\{ w, h \}\)/);
  });

  it("measures the real viewport rather than inferring it from CSS", () => {
    expect(VIEWER).toMatch(/railViewportRef/);
    expect(VIEWER).toMatch(/new ResizeObserver\(measure\)/);
    expect(VIEWER).toMatch(/data-testid="grading-card-viewport"/);
  });

  it("drops the scan's stale natural size when the side or variant changes", () => {
    // Otherwise the NEW scan is fitted to the OLD aspect and can be pushed off-edge.
    expect(VIEWER).toMatch(/setRailNaturalDims\(null\)/);
  });

  it("applies the computed result as explicit pixels, never as an ambiguous percentage", () => {
    expect(FIT_BRANCH).toMatch(/width: railFit\.w/);
    expect(FIT_BRANCH).toMatch(/height: railFit\.h/);
    // `maxHeight: maxH` may still exist for the INLINE viewer, but the rail's fitted
    // branch must not reach for it.
    expect(FIT_BRANCH).not.toMatch(/railFit\s*\?[\s\S]{0,400}maxHeight: maxH/);
  });

  it("takes the card out of flow so its size cannot feed back into the rail's width", () => {
    // An in-flow box with an explicit width becomes its ancestors' min-content width.
    // With `min-width: auto` anywhere above, that re-widens the rail, which re-measures
    // the viewport, which re-widens the card. The reproduction latched at a 1066px card
    // inside an 829px row and never converged.
    expect(FIT_BRANCH).toMatch(/position: "absolute"/);
    expect(FIT_BRANCH).toMatch(/left: railFit\.clearanceX/);
    expect(FIT_BRANCH).toMatch(/top: railFit\.clearanceY/);
  });

  it("NEVER decoratively clips the inspection image", () => {
    // rounded-[5%] + overflow-hidden removed content while every rectangle check passed.
    // The grader must inspect the true scan.
    expect(VIEWER).toMatch(/railFitEnabled \? "" : "rounded-\[5%\] "/);
    // ...and only on the rail. Other surfaces keep their rounding.
    expect(VIEWER).toContain("rounded-[5%]");
  });

  it("scopes all of it to the grading rail, leaving the inline and public viewers alone", () => {
    expect(VIEWER).toMatch(/const railFitEnabled = fillHost && !markMode;/);
  });

  it("reports the clearances it computed, for runtime acceptance", () => {
    for (const edge of ["top", "bottom", "left", "right"]) {
      expect(VIEWER).toContain(`"data-card-clearance-${edge}"`);
    }
    expect(VIEWER).toContain('"data-card-fit-state"');
  });

  it("gives the card the rail's full width by stacking the zoom toolbar beneath it", () => {
    // As a row, the toolbar sat beside the card and took ~110px out of the rail.
    expect(VIEWER).toMatch(/<div className="flex min-h-0 flex-1 flex-col">\{renderImageArea\("100%"\)\}<\/div>/);
  });

  it("keeps the remaining-space contract that stops the card overflowing the host", () => {
    expect(VIEWER).toMatch(/className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center"/);
    expect(VIEWER).toMatch(/data-testid="grading-card-controls"/);
    expect(VIEWER).toMatch(/flex h-full min-h-0 flex-col gap-1/);
  });
});

describe("the ONE certificate preview stays in the top row, never under the card", () => {
  const WORKSTATION = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/components/grading-workflow/GradingWorkstation.tsx"),
    "utf8"
  );

  it("mounts exactly one certificate preview", () => {
    expect((WORKSTATION.match(/<CertificatePreviewPanel/g) || []).length).toBe(1);
  });

  it("puts it in the tabs row, not in the aside's below-the-card slot", () => {
    // Beneath the card it consumed the rail height the card needed, which is how the
    // card's bottom edge came to be cut off in the first place.
    expect(WORKSTATION).toMatch(/previewTopSlot=\{/);
    expect(WORKSTATION).not.toMatch(/below=\{/);
  });

  it("reserves a state-independent box so the card cannot jump when the preview resolves", () => {
    const PANEL = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/components/grading-workflow/CertificatePreviewPanel.tsx"),
      "utf8"
    );
    // Measured across a live loading -> error transition: card movement 0px, resize 0px.
    expect(PANEL).toMatch(/aspectRatio: "827 \/ 236"/);
  });
});
