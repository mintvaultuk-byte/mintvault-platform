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

const VIEWER = fs.readFileSync(path.resolve(process.cwd(), "client/src/components/grading/image-viewer.tsx"), "utf8");

/** The frame's inspection-mode style branch — where the fit is actually applied. */
const FIT_BRANCH = VIEWER.slice(
  VIEWER.indexOf("const cardFrame = ("),
  VIEWER.indexOf('data-testid="grading-image-viewport"')
);

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
    expect(VIEWER).toMatch(/vp\.w - RAIL_SAFE_INSET_X \* 2/);
    expect(VIEWER).toMatch(/effectiveH - RAIL_SAFE_INSET_Y \* 2/);
  });

  it("computes the fit from the SCAN's own natural dimensions, not an assumed ratio", () => {
    // A scan that is not exactly 5:7 is precisely the case where assuming 5:7 pushes
    // real card content past the edge.
    expect(VIEWER).toMatch(/const widthScale = safeW \/ nat\.w;/);
    expect(VIEWER).toMatch(/safeH \/ nat\.h/);
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

  it("KEEPS THE CARD IN FLOW — out of flow, the rail collapsed and the card vanished", () => {
    // Owner P0, staging v491: the card image disappeared entirely from the real /admin
    // rail. The card is the only element in the rail with real height; positioning it
    // absolutely removed it from flow, and wherever the host's height is content-driven
    // rather than definite the column collapsed to 0 and nothing rendered.
    // Reproduced with host=auto: card invisible before, visible after.
    expect(FIT_BRANCH).not.toMatch(/position: "absolute"/);
    expect(FIT_BRANCH).toMatch(/flexShrink: 0/);
  });

  it("breaks the sizing feedback loop with overflow, not by leaving flow", () => {
    // A flex item whose overflow is not `visible` has an automatic minimum size of 0,
    // so the card's explicit width cannot become an ancestor's min-content width and
    // re-inflate the rail on the next measurement.
    expect(VIEWER).toMatch(/relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden/);
  });

  it("still fits by WIDTH when the viewport has no usable height", () => {
    // If an ancestor's height is content-driven there is no available height to fit
    // into — the card defines it. Treating a 0 height as authoritative is precisely
    // what stranded the image invisible.
    // The height ceiling is now the VISIBLE viewport, not the container it lives in.
    expect(VIEWER).toMatch(/const heightUsable = availableH > RAIL_SAFE_INSET_Y \* 2;/);
    expect(VIEWER).toMatch(/railAvailableHeight\(\{/);
    expect(VIEWER).toMatch(/mode === "safe-fit" \? Math\.min\(widthScale/);
    expect(VIEWER).toMatch(/heightUsable \|\| prev\?\.mode === "safe-fit" \? "safe-fit" : "width-fit"/);
  });

  it("falls back to the LAST-KNOWN-GOOD sizing, never to a blank rail", () => {
    // A path only reachable when measurement fails must not itself be new and unproven.
    expect(FIT_BRANCH).toMatch(/aspectRatio: "5\/7"/);
    expect(FIT_BRANCH).toMatch(/maxWidth: "100%"/);
    expect(FIT_BRANCH).not.toMatch(/inset: 0/);
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

  it("uses canonical full-resolution working evidence for FRONT and BACK pixel inspection", () => {
    expect(VIEWER).toMatch(/function getPixelInspectionAsset/);
    const inspectionHelper = VIEWER.slice(
      VIEWER.indexOf("function getPixelInspectionAsset"),
      VIEWER.indexOf("function hasAny")
    );
    // The production helper is dynamic. Expand that exact contract for Front and Back so the
    // precedence proof cannot accidentally cover one side only.
    for (const side of ["front", "back"]) {
      const sideContract = inspectionHelper.replaceAll("${side}", side);
      expect(sideContract.indexOf(`record[\`${side}_working\`]`)).toBeGreaterThan(-1);
      expect(sideContract.indexOf(`record[\`${side}_original\`]`)).toBeGreaterThan(-1);
      expect(sideContract.indexOf(`record[\`${side}_working\`]`)).toBeLessThan(
        sideContract.indexOf(`record[\`${side}_original\`]`)
      );
    }
    expect(VIEWER).toMatch(/const PIXEL_INSPECTION_MAX_ZOOM = 12/);
    expect(VIEWER).toContain('"working-evidence"');
    expect(VIEWER).toContain("data-inspection-source={");
    expect(VIEWER).toContain(
      'pixelInspection ? `${pixelInspectionAsset?.source ?? "unavailable"}-no-smoothing` : "display"'
    );
    expect(VIEWER).toMatch(/imageRendering: "pixelated"/);
    expect(VIEWER).toMatch(/data-pixel-inspection=\{pixelInspection \? "no-smoothing" : undefined\}/);
    expect(VIEWER).toMatch(/function pixelInspectionLabel/);
    expect(VIEWER).toMatch(/Full-Resolution Working Evidence/);
    expect(VIEWER).toMatch(/Legacy Original Inspection/);
  });

  it("reports the clearances it computed, for runtime acceptance", () => {
    for (const edge of ["top", "bottom", "left", "right"]) {
      expect(VIEWER).toContain(`"data-card-clearance-${edge}"`);
    }
    expect(VIEWER).toContain('"data-card-fit-state"');
  });

  it("puts Front/Back, the zoom pill and the certificate in ONE top utility row", () => {
    expect(VIEWER).toMatch(/data-testid="grading-top-utility-row"/);
    const row = VIEWER.slice(
      VIEWER.indexOf('data-testid="grading-top-utility-row"'),
      VIEWER.indexOf("Reference comparison")
    );
    expect(row).toMatch(/renderTabs\(\)/);
    expect(row).toMatch(/renderZoomPill\(\)/);
    expect(row).toMatch(/topRowSlot/);
  });

  it("does NOT render the zoom toolbar beside or beneath the card in the rail", () => {
    // Beside the card it took ~110px of rail width; beneath it, ~36px of height.
    expect(VIEWER).toMatch(/railFitEnabled \? null : <div className="mt-2 flex shrink-0 items-center justify-end">/);
    expect(VIEWER).toMatch(/<div className="flex min-h-0 flex-1 flex-col">\{renderImageArea\("100%"\)\}<\/div>/);
  });

  it("keeps the remaining-space contract that stops the card overflowing the host", () => {
    expect(VIEWER).toMatch(/relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden/);
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
