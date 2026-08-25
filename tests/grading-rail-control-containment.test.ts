// @vitest-environment happy-dom
/**
 * RAIL CONTAINMENT — the certificate preview must never cover the card's own controls.
 *
 * THE DEFECT (owner visual acceptance, staging 2026-08-16). In the canonical left rail the
 * certificate preview sat over the lower-left control area, covering Manual Crop / Card Tool /
 * Recapture. Not cosmetic: a preview must never obstruct an operator control.
 *
 * ROOT CAUSE. `ImageViewer`'s root was `space-y-2` — plain BLOCK FLOW. With `fillHost` the 5:7 card
 * frame was given `maxHeight:100%` against an auto-height parent, so it resolved to width x 7/5, and
 * the controls row stacked AFTER it. Their combined height exceeded the rail host, whose
 * `overflow-hidden` then clipped the controls out of existence — leaving the certificate preview
 * beneath occupying the space where the controls should have been. Nothing was "on top" of anything;
 * the controls were pushed out of a clipped box.
 *
 * THE INVARIANT THIS PINS. In the rail the space is RESERVED, not competed for:
 *   root         flex column, fills the host        (`flex h-full min-h-0 flex-col`)
 *   tabs         intrinsic height                   (`shrink-0`)
 *   card frame   absorbs ONLY the leftover height   (`flex-1 min-h-0`)
 *   controls     intrinsic height, never shrink     (`shrink-0`)
 * The card shrinks on short viewports instead of pushing controls out of the box, so no control can
 * be covered or clipped at any viewport height, in any preview state.
 *
 * WHY THIS IS A STRUCTURAL CONTRACT AND NOT A PIXEL MEASUREMENT — stated plainly rather than
 * implied. happy-dom does not implement CSS layout: for a flex column of definite height it returns
 * `height: 0` for the container AND every child, and `top: 0` for all of them (verified directly
 * before writing this file). A `getBoundingClientRect()` overlap assertion would therefore compare
 * zero-sized boxes and pass no matter how badly the layout broke — a vacuous test, which is worse
 * than none. There is no real layout engine in this repo's devDependencies. So this file pins the
 * exact CSS contract that makes overlap geometrically impossible, and the pixel verdict remains the
 * owner's visual check on staging.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

const VIEWER = readFileSync("client/src/components/grading/image-viewer.tsx", "utf8");
const ASIDE = readFileSync("client/src/components/grading-workflow/WorkstationPreviewAside.tsx", "utf8");

describe("rail containment — ImageViewer reserves space for its controls", () => {
  it("the rail root is a flex COLUMN that fills the host, not block flow", () => {
    // `space-y-2` in the rail is the defect. It must remain for the inline layout only.
    expect(VIEWER).toMatch(/className=\{fillHost \? "flex h-full min-h-0 flex-col gap-1" : "space-y-2"\}/);
  });

  it("the card frame absorbs ONLY the leftover height (flex-1 min-h-0)", () => {
    // Without min-h-0 a flex item refuses to shrink below its content, which is exactly how the
    // controls got pushed out of the clipped host. Unchanged requirement.
    //
    // The region became a COLUMN once the zoom controls moved out of it into the top
    // utility row. The containment contract this test exists to protect — `min-h-0
    // flex-1`, so the card area takes the leftover and never pushes the controls out —
    // is identical.
    expect(VIEWER).toContain('<div className="flex min-h-0 flex-1 flex-col">{renderImageArea("100%")}</div>');
    // Centring belongs to the measured inspection viewport inside that region, whose
    // overflow containment also stops the card re-inflating the rail.
    expect(VIEWER).toContain("relative h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden overscroll-contain");
  });

  it("the controls row never shrinks and is a real in-flow sibling", () => {
    // The row stays outside the measured card viewport. Horizontal overflow is
    // scrollable instead of wrapping and consuming unpredictable card height.
    expect(VIEWER).toContain('className="flex shrink-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1"');
    expect(VIEWER).toMatch(/data-testid="grading-card-controls"/);
  });

  it("the Front/Back tabs keep their intrinsic height in the rail", () => {
    expect(VIEWER).toMatch(/flex shrink-0 items-center justify-between gap-2/);
    // The tabs, the zoom pill and the certificate share ONE shrink-0 row, so none of
    // them costs the card vertical space beyond the row that already exists. The
    // certificate is the flexible member: controls keep their intrinsic size and it
    // absorbs the squeeze, because compressing a control makes it overlap its neighbour.
    expect(VIEWER).toMatch(
      /topRowSlot \? <div className="flex min-w-0 flex-1 justify-end">\{topRowSlot\}<\/div> : null/
    );
  });

  it("the controls row is NOT absolutely or fixed positioned — it cannot float over anything", () => {
    const i = VIEWER.indexOf('data-testid="grading-card-controls"');
    expect(i).toBeGreaterThan(-1);
    const cls = VIEWER.slice(VIEWER.lastIndexOf('className="', i), i);
    expect(cls).not.toMatch(/\babsolute\b|\bfixed\b|\bsticky\b/);
  });

  it("the controls render AFTER the image area, so they are below it in flow", () => {
    const img = VIEWER.indexOf('{renderImageArea("100%")}');
    const ctl = VIEWER.indexOf('data-testid="grading-card-controls"');
    expect(img).toBeGreaterThan(-1);
    expect(ctl).toBeGreaterThan(img);
  });

  it("the inline (non-rail) layout is untouched — the fix is scoped to fillHost", () => {
    expect(VIEWER).toContain("renderImageArea(525)");
    expect(VIEWER).toContain('"space-y-2"');
  });
});

describe("rail containment — the aside gives the certificate its OWN reserved space", () => {
  it("the card takes the remainder and the certificate panel never overlays it", () => {
    // flex-1 for the card, shrink-0 for the panel below: the panel occupies its own box in flow.
    expect(ASIDE).toMatch(/<div className="min-h-0 flex-1">\{card\}<\/div>/);
    expect(ASIDE).toMatch(/<div className="shrink-0">\{below\}<\/div>/);
  });

  it("the aside itself is a flex column, so the two children cannot overlap", () => {
    expect(ASIDE).toMatch(/flex min-h-0 flex-col gap-1/);
  });

  it("nothing in the aside is absolutely or fixed positioned", () => {
    expect(ASIDE).not.toMatch(/className="[^"]*\b(absolute|fixed|sticky)\b/);
  });
});

describe("rail containment — the aside renders both regions in every preview state", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mountAside(below: unknown) {
    const { WorkstationPreviewAside } = await import("@/components/grading-workflow/WorkstationPreviewAside");
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(WorkstationPreviewAside as never, {
          certificateId: 1,
          apiBase: "/api/admin",
          below,
          interactiveCardHostRef: { current: null },
          inspectionState: { side: "front", zoom: 1, offsetX: 0, offsetY: 0 },
          onInspectionStateChange: () => {},
        })
      );
    });
    return container;
  }

  it("reserves a separate box for the card host and the certificate panel", async () => {
    const el = await mountAside(createElement("div", { "data-testid": "cert-below" }, "cert"));
    const host = el.querySelector('[data-testid="grading-interactive-card-host"]');
    const below = el.querySelector('[data-testid="cert-below"]');
    expect(host, "the card host must render").toBeTruthy();
    expect(below, "the certificate panel must render").toBeTruthy();
    // They are in DIFFERENT wrappers — the panel is not a descendant of the card host, so it cannot
    // be drawn inside/over the card's own control area.
    expect(host!.contains(below!)).toBe(false);
    // …and the certificate comes after the card in flow.
    expect(host!.compareDocumentPosition(below!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => root.unmount());
    container.remove();
  });

  it("when the certificate panel is ABSENT the card still renders (preview unavailable state)", async () => {
    const el = await mountAside(undefined);
    expect(el.querySelector('[data-testid="grading-preview-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="grading-interactive-card-host"]')).toBeTruthy();
    act(() => root.unmount());
    container.remove();
  });
});
