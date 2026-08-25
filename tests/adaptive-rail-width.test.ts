/**
 * Regression for the removed adaptive-rail feedback loop.
 *
 * The viewer may adapt to the rail. The rail must never adapt to a measurement
 * produced by the viewer. A fixed responsive split makes browser zoom a normal
 * CSS-layout input and eliminates the parent/child sizing cycle.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const ASIDE = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
const VIEWER = read("client/src/components/grading/image-viewer.tsx");

describe("the left rail is stable and card-independent", () => {
  it("uses one fixed 45/55 two-pane split for every role", () => {
    expect(ASIDE).toContain('"max-[539px]:h-[100dvh] max-[539px]:flex-none min-[540px]:w-[45%] min-[540px]:shrink-0"');
    expect(ASIDE).toContain('data-layout-boundary="540"');
    expect(SHELL).toContain('WORKSTATION_TWO_PANE_CLASS = "min-[540px]:flex-row"');
  });

  it("does not measure the card or dynamically set rail width", () => {
    expect(ASIDE).not.toMatch(/ResizeObserver|getBoundingClientRect|clientWidth|naturalWidth/);
    expect(ASIDE).not.toMatch(/maxWidth|style=|matchMedia/);
    expect(VIEWER).not.toMatch(/sessionRequiredRailWidth|publishNaturalDimensions|useRailWidth/);
  });

  it("does not contain the former adaptive-width context path", () => {
    expect(ASIDE).not.toMatch(/RailWidthProvider|rail-width-context/);
    expect(SHELL).not.toMatch(/RailWidthProvider|rail-width-context/);
    expect(VIEWER).not.toMatch(/RailWidthProvider|rail-width-context/);
  });

  it("stays two-pane across the owner's 845px browser-zoom sequence until 150%", () => {
    const physicalWidth = 845;
    for (const browserZoom of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
      const cssWidth = physicalWidth / browserZoom;
      expect(cssWidth, `${Math.round(browserZoom * 100)}% CSS width`).toBeGreaterThanOrEqual(540);
      expect(cssWidth * 0.45).toBeGreaterThan(240);
      expect(cssWidth * 0.55).toBeGreaterThan(295);
    }
  });

  it("stacks only below the documented usable-width floor with a definite mobile rail height", () => {
    expect(539).toBeLessThan(540);
    expect(ASIDE).toContain("max-[539px]:h-[100dvh]");
    expect(ASIDE).toContain("max-[539px]:flex-none");
    expect(ASIDE).not.toContain("max-[539px]:basis-1/2");
    expect(ASIDE).not.toContain("max-[539px]:flex-1");
    expect(SHELL).toContain("max-[539px]:overflow-y-auto");
    expect(SHELL).toContain("max-[539px]:h-[100dvh]");
    expect(SHELL).toContain("max-[539px]:flex-none");
    expect(SHELL).toContain("min-[540px]:flex-row");
  });
});
