/** Presentation-only card state shared between workstation stage viewers.
 * Coordinates are normalised to the image. Never use this state for defect,
 * crop, centering, or MVGS coordinates. */
export type CardInspectionSide = "front" | "back";

export interface CardInspectionView {
  zoom: number;
  focusX: number;
  focusY: number;
}

export interface CardInspectionState {
  side: CardInspectionSide;
  views: Record<CardInspectionSide, CardInspectionView>;
}

export const CARD_INSPECTION_MIN_ZOOM = 1;
/** Matches the existing Grade ImageViewer ceiling; stage sharing must not
 * reduce an operator's established inspection capability. */
export const CARD_INSPECTION_MAX_ZOOM = 6;

export function defaultCardInspectionView(): CardInspectionView {
  return { zoom: 1, focusX: 0.5, focusY: 0.5 };
}

export function createCardInspectionState(): CardInspectionState {
  return {
    side: "front",
    views: { front: defaultCardInspectionView(), back: defaultCardInspectionView() },
  };
}

const finiteOr = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? (value as number) : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Fail-closed normalisation for values received from another viewer adapter. */
export function normaliseCardInspectionState(value: CardInspectionState): CardInspectionState {
  const normaliseView = (view: CardInspectionView | undefined): CardInspectionView => {
    const fallback = defaultCardInspectionView();
    const zoom = clamp(finiteOr(view?.zoom, fallback.zoom), CARD_INSPECTION_MIN_ZOOM, CARD_INSPECTION_MAX_ZOOM);
    return {
      zoom,
      focusX: zoom === 1 ? 0.5 : clamp(finiteOr(view?.focusX, fallback.focusX), 0, 1),
      focusY: zoom === 1 ? 0.5 : clamp(finiteOr(view?.focusY, fallback.focusY), 0, 1),
    };
  };
  return {
    side: value.side === "back" ? "back" : "front",
    views: { front: normaliseView(value.views?.front), back: normaliseView(value.views?.back) },
  };
}

export function updateCardInspectionView(
  state: CardInspectionState,
  side: CardInspectionSide,
  patch: Partial<CardInspectionView>
): CardInspectionState {
  return normaliseCardInspectionState({
    ...state,
    views: { ...state.views, [side]: { ...state.views[side], ...patch } },
  });
}

export function inspectionViewToPercentFocus(view: CardInspectionView): { x: number; y: number } {
  return { x: view.focusX * 100, y: view.focusY * 100 };
}

export function percentFocusToInspectionView(zoom: number, focus: { x: number; y: number }): CardInspectionView {
  return normaliseCardInspectionState({
    side: "front",
    views: {
      front: { zoom, focusX: focus.x / 100, focusY: focus.y / 100 },
      back: defaultCardInspectionView(),
    },
  }).views.front;
}
