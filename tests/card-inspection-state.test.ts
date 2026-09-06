import { describe, expect, it } from "vitest";
import {
  createCardInspectionState,
  normaliseCardInspectionState,
  updateCardInspectionView,
} from "../client/src/components/grading-workflow/card-inspection-state";

describe("canonical card inspection state", () => {
  it("retains independent front/back viewport state across adapters", () => {
    let state = createCardInspectionState();
    state = updateCardInspectionView(state, "front", { zoom: 2.5, focusX: 0.2, focusY: 0.7 });
    state = { ...state, side: "back" };
    state = updateCardInspectionView(state, "back", { zoom: 1.75, focusX: 0.8, focusY: 0.3 });
    expect(state.views.front).toEqual({ zoom: 2.5, focusX: 0.2, focusY: 0.7 });
    expect(state.views.back).toEqual({ zoom: 1.75, focusX: 0.8, focusY: 0.3 });
  });

  it("clamps hostile/non-finite values and recentres fit view", () => {
    const state = normaliseCardInspectionState({
      side: "back",
      views: {
        front: { zoom: Number.NaN, focusX: -3, focusY: 9 },
        back: { zoom: 99, focusX: -1, focusY: 2 },
      },
    });
    expect(state.views.front).toEqual({ zoom: 1, focusX: 0.5, focusY: 0.5 });
    expect(state.views.back).toEqual({ zoom: 5, focusX: 0, focusY: 1 });
  });

  it("contains no grading, crop, defect or MVGS state", () => {
    expect(Object.keys(createCardInspectionState()).sort()).toEqual(["side", "views"]);
  });
});
