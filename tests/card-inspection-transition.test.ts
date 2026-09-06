import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCardInspectionState,
  inspectionViewToPercentFocus,
  percentFocusToInspectionView,
  updateCardInspectionView,
} from "../client/src/components/grading-workflow/card-inspection-state";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const VIEWER = read("client/src/components/grading/image-viewer.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");

describe("cross-stage inspection transition", () => {
  it("round-trips the Grade viewer's percent focus without viewport pixels", () => {
    const source = { zoom: 3, focusX: 0.23, focusY: 0.81 };
    expect(percentFocusToInspectionView(source.zoom, inspectionViewToPercentFocus(source))).toEqual(source);
  });

  it("keeps front and back focus independent during repeated stage handoffs", () => {
    let state = createCardInspectionState();
    state = updateCardInspectionView(state, "front", { zoom: 2, focusX: 0.25, focusY: 0.4 });
    state = updateCardInspectionView({ ...state, side: "back" }, "back", {
      zoom: 4,
      focusX: 0.75,
      focusY: 0.6,
    });
    expect(state.views.front).toEqual({ zoom: 2, focusX: 0.25, focusY: 0.4 });
    expect(state.views.back).toEqual({ zoom: 4, focusX: 0.75, focusY: 0.6 });
  });

  it("resets both sides to FIT when the workstation opens a different card", () => {
    expect(WORKSTATION).toMatch(
      /useEffect\(\(\) => \{[\s\S]*?setInspectionState\(createCardInspectionState\(\)\);[\s\S]*?\}, \[certId, mode\]\);/
    );
  });
});

describe("grading-coordinate isolation", () => {
  it("shares presentation zoom/pan with MARK without changing stored evidence coordinates", () => {
    expect(VIEWER).toMatch(
      /if \(!inspectionState \|\| !onInspectionStateChange \|\| \(side !== "front" && side !== "back"\)\) return/
    );
    expect(VIEWER).toContain("updateCardInspectionView(");
    expect(VIEWER).toContain('data-testid="grading-coordinate-plane"');
    expect(VIEWER).toContain("const imgRect = imgElRef.current.getBoundingClientRect()");
    expect(VIEWER).toContain("const r = el.getBoundingClientRect()");
    expect(VIEWER).not.toMatch(/transform:\s*`scale\(/);
  });

  it("gates mutation surfaces by active Grade stage while leaving inspection state wired", () => {
    expect(PANEL).toContain("mutationsEnabled={active && !approvalInteractionLocked}");
    expect(PANEL).toContain("inspectionState={inspectionState}");
    expect(PANEL).toContain("onInspectionStateChange={onInspectionStateChange}");
    expect(VIEWER).toContain("if (!mutationsEnabled || !onDefectsChange) return");
    expect(VIEWER).toContain("mayMutateSourceImage && manualCropSide");
    expect(VIEWER).toContain("onOpenCardTool && mutationsEnabled && !readOnly");
    expect(PANEL).toContain("sourceImageMutationsEnabled={workstationCapabilities.imageMutations}");
    expect(PANEL).toContain("onOpenCardTool={active ? setManualCardToolSide : undefined}");
    expect(PANEL).toContain("readOnly={!active || approvalInteractionLocked}");
    expect(PANEL).toContain("if (!active) setManualCardToolSide(null)");
  });
});
