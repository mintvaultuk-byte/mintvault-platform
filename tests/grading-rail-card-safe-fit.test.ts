/**
 * Source contracts for the authoritative grading viewport.
 *
 * Pixel geometry and the repeated browser-zoom sequence are exercised against
 * the exported pure geometry in grading-inspection-viewport-geometry.test.ts.
 * This file pins the React wiring that makes those results authoritative.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const VIEWER = read("client/src/components/grading/image-viewer.tsx");
const GEOMETRY = read("client/src/components/grading/inspection-viewport-geometry.ts");

describe("the rail fits the complete authoritative scan from stable inputs", () => {
  it("keeps the visible clearance floor at 12 CSS pixels", () => {
    const inset = VIEWER.match(/INSPECTION_SAFE_INSET_Y = (\d+)/);
    const floor = VIEWER.match(/RAIL_MIN_BOTTOM_CLEARANCE_PX = (\d+)/);
    expect(inset).not.toBeNull();
    expect(floor).not.toBeNull();
    expect(Number(inset![1])).toBeGreaterThanOrEqual(12);
    expect(Number(inset![1])).toBeGreaterThanOrEqual(Number(floor![1]));
  });

  it("computes FIT from the current viewport and natural image dimensions", () => {
    expect(GEOMETRY).toContain("viewport.width - Math.max(0, insets.x) * 2");
    expect(GEOMETRY).toContain("viewport.height - Math.max(0, insets.y) * 2");
    expect(GEOMETRY).toContain("safeWidth / natural.width");
    expect(GEOMETRY).toContain("safeHeight / natural.height");
    expect(VIEWER).toContain("e.currentTarget.naturalWidth");
    expect(VIEWER).toContain("e.currentTarget.naturalHeight");
  });

  it("measures one stable parent viewport with ResizeObserver", () => {
    expect(VIEWER).toContain("inspectionViewportRef");
    expect(VIEWER).toContain("new ResizeObserver(measure)");
    expect(VIEWER).toContain('data-testid="grading-card-viewport"');
    expect(VIEWER).toContain("el.clientWidth");
    expect(VIEWER).toContain("el.clientHeight");
  });

  it("has no browser-zoom inference or previous-render sizing authority", () => {
    const layoutCode = VIEWER.slice(0, VIEWER.indexOf("function DefectEditPopover"));
    expect(layoutCode).not.toMatch(/visualViewport|devicePixelRatio|window\.innerHeight/);
    expect(VIEWER).not.toMatch(/shouldRecommitRailFit|railFitRef|railAvailableHeight/);
    expect(VIEWER).not.toMatch(/sessionRequiredRailWidth|publishNaturalDimensions/);
  });

  it("applies the placement as explicit pixels without clipping or a scale transform", () => {
    expect(VIEWER).toContain('position: "absolute"');
    expect(VIEWER).toContain("left: fittedPlacement.left");
    expect(VIEWER).toContain("top: fittedPlacement.top");
    expect(VIEWER).toContain("width: fittedPlacement.width");
    expect(VIEWER).toContain("height: fittedPlacement.height");
    expect(VIEWER).not.toMatch(/transform:\s*`scale\(/);
    expect(VIEWER).not.toContain('className="relative h-full w-full overflow-hidden rounded-[5%]"');
  });

  it("uses admitted FRONT/BACK working evidence with a distinct review fallback", () => {
    const working = VIEWER.slice(
      VIEWER.indexOf("function getWorkingEvidenceAsset"),
      VIEWER.indexOf("function getReviewEvidenceAsset")
    );
    const review = VIEWER.slice(VIEWER.indexOf("function getReviewEvidenceAsset"), VIEWER.indexOf("function hasAny"));
    expect(working).toContain("record[`${side}_working`]");
    expect(working).not.toMatch(/original|display|cropped/);
    expect(review).toContain("record[`${side}_review`]");
    expect(review).not.toMatch(/original|display|cropped/);
    expect(VIEWER).toContain('data-inspection-source={inspectionAsset?.source ?? "working-evidence-unavailable"}');
  });

  it("reports current viewport, natural, rendered and clearance geometry", () => {
    for (const attribute of [
      "data-card-viewport-w",
      "data-card-viewport-h",
      "data-card-natural-w",
      "data-card-natural-h",
      "data-card-rendered-w",
      "data-card-rendered-h",
      "data-card-clearance-top",
      "data-card-clearance-bottom",
      "data-card-clearance-left",
      "data-card-clearance-right",
      "data-card-fit-state",
    ]) {
      expect(VIEWER).toContain(attribute);
    }
  });

  it("gives the card all remaining rail space and keeps controls in flow", () => {
    expect(VIEWER).toContain('<div className="flex min-h-0 flex-1 flex-col">{renderImageArea("100%")}</div>');
    expect(VIEWER).toContain(
      'className="relative h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden overscroll-contain"'
    );
    expect(VIEWER).toContain('className="flex shrink-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1"');
    expect(VIEWER).toContain('data-testid="grading-card-controls"');
  });

  it("puts side, zoom and certificate controls in one non-wrapping utility row", () => {
    const start = VIEWER.indexOf('data-testid="grading-top-utility-row"');
    const row = VIEWER.slice(start, VIEWER.indexOf("Reference comparison", start));
    expect(start).toBeGreaterThan(-1);
    expect(row).toContain("renderTabs()");
    expect(row).toContain("renderZoomPill()");
    expect(row).toContain("topRowSlot");
    expect(row).toContain("overflow-x-auto");
  });
});

describe("the one certificate preview stays outside the card plane", () => {
  const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");

  it("mounts once in the top slot, never beneath the card", () => {
    expect((WORKSTATION.match(/<CertificatePreviewPanel/g) || []).length).toBe(1);
    expect(WORKSTATION).toContain("previewTopSlot={");
    expect(WORKSTATION).not.toContain("below={");
  });

  it("reserves a state-independent preview aspect", () => {
    const PANEL = read("client/src/components/grading-workflow/CertificatePreviewPanel.tsx");
    expect(PANEL).toContain('aspectRatio: "827 / 236"');
  });
});
