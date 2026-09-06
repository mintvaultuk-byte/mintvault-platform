/**
 * The inspection host owns the available CSS rectangle. Browser page zoom is
 * allowed to change that rectangle; ImageViewer must consume it directly and
 * must not infer a physical screen height or inspect document scroll height.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fitInspectionImage } from "../client/src/components/grading/inspection-viewport-geometry";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const VIEWER = read("client/src/components/grading/image-viewer.tsx");
const ASIDE = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
const NATURAL = { width: 1200, height: 1700 };
const INSETS = { x: 10, y: 12 };

describe("the current bounded CSS viewport is the sole fit authority", () => {
  it("fits inside each current host without consulting a physical-screen proxy", () => {
    for (const viewport of [
      { width: 568, height: 588 },
      { width: 454, height: 556 },
      { width: 303, height: 421 },
    ]) {
      const fit = fitInspectionImage(viewport, NATURAL, INSETS);
      expect(fit.width).toBeLessThanOrEqual(viewport.width - INSETS.x * 2);
      expect(fit.height).toBeLessThanOrEqual(viewport.height - INSETS.y * 2);
    }
  });

  it("measures the flex host directly and responds to its ResizeObserver", () => {
    expect(VIEWER).toContain("const width = el.clientWidth");
    expect(VIEWER).toContain("const height = el.clientHeight");
    expect(VIEWER).toContain("const observer = new ResizeObserver(measure)");
    expect(VIEWER).toContain("observer.observe(el)");
  });

  it("never derives image geometry from the document, physical viewport or browser zoom", () => {
    const layoutCode = VIEWER.slice(0, VIEWER.indexOf("function DefectEditPopover"));
    expect(layoutCode).not.toMatch(/documentElement\.scrollHeight|body\.scrollHeight/);
    expect(layoutCode).not.toMatch(/visualViewport|window\.innerHeight|outerHeight|devicePixelRatio/);
  });

  it("keeps controls outside the measured card viewport in flex flow", () => {
    const viewportIndex = VIEWER.indexOf('data-testid="grading-card-viewport"');
    const controlsIndex = VIEWER.indexOf('data-testid="grading-card-controls"');
    expect(viewportIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeGreaterThan(viewportIndex);
    expect(VIEWER).toContain('className="flex shrink-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1"');
  });
});

describe("the workstation bounds the left inspection panel", () => {
  it("gives the row and both panes min-size escape hatches", () => {
    expect(SHELL).toContain("flex min-h-0 flex-1 flex-col gap-2");
    expect(ASIDE).toContain("flex min-h-0 flex-col gap-1");
    expect(ASIDE).toContain('<div className="min-h-0 flex-1">{card}</div>');
  });

  it("keeps the right pane independently scrollable", () => {
    expect(SHELL).toContain('WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1"');
  });

  it("does not size the left rail from right-pane content", () => {
    expect(ASIDE).not.toMatch(/scrollHeight|getBoundingClientRect|ResizeObserver/);
    expect(SHELL).not.toMatch(/scrollHeight|getBoundingClientRect|ResizeObserver/);
  });
});
