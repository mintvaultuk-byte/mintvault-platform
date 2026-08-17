/**
 * ADAPTIVE RAIL WIDTH — derived from the same card-INDEPENDENT inputs that
 * already decide the card's safe fit, never from the card the rail contains.
 *
 * ── Why the rail could not simply be narrowed ───────────────────────────────
 * The rail was a fixed `md:w-[45%]`. Measured against the real shell, that is
 * three different things at three viewports:
 *
 *   845x685    rail 371.3   card 327.0 wide   margin 22.1px per side
 *   1024x768   rail 451.8   card 381.1 wide   margin 35.4px per side
 *   1280x800   rail 567.0   card 404.0 wide   margin 81.5px per side
 *
 * The card is HEIGHT-bound at every one of them, so the leftover width is dead
 * black margin — 81.5px per side at 1280x800, and essentially none at 845x685,
 * where the rail is already TIGHTER than the 24px target. One percentage cannot
 * serve both. There is no reason the rail needs the same percentage at every
 * viewport; it needs the width the card will actually use.
 *
 * ── Why this is not a feedback loop ─────────────────────────────────────────
 * The obvious implementation — measure the rendered card, size the rail to it —
 * is a loop: the card is laid out inside the rail, so the rail would be sized
 * from its own output, and the next fit would size the card from the new rail.
 * That is the oscillation 65243074 fixed and 8c822396 closed at the source.
 *
 * So the rail is predicted from the SAME inputs the card's own fit consumes,
 * every one of which is upstream of layout:
 *
 *   visible viewport height   global, from visualViewport
 *   card region top           set by the chrome ABOVE the card
 *   controls height           set by the chrome BELOW the card
 *   safety insets             constants
 *   naturalWidth/naturalHeight of the SOURCE IMAGE
 *
 * `naturalWidth`/`naturalHeight` are the decoded dimensions of the source file.
 * They are a property of the scan, fixed before the element is laid out, and
 * completely independent of how large the card is rendered — which is exactly
 * what makes them safe to size the parent from. Nothing here reads a rendered
 * card box, so:
 *
 *   card -> rail -> card -> rail
 *
 * cannot form. The prediction runs the same arithmetic the fit will run, one
 * step ahead of it.
 *
 * ── Residual coupling, and why it is bounded ────────────────────────────────
 * `cardRegionTop` and `controlsH` are independent of the CARD but not perfectly
 * independent of the RAIL: a narrower rail can wrap the controls row onto an
 * extra line, which lowers the available height, which lowers the predicted
 * width. That path is real, so callers must settle ONCE per stable input set
 * rather than recomputing from their own output — see `shouldAdoptRailWidth`,
 * which refuses any adjustment that a previous adoption could have caused.
 *
 * This module is pure and DOM-free so the contract can be driven directly, with
 * no browser and no layout, by the tests in tests/adaptive-rail-width.test.ts.
 */

/** Horizontal breathing room between the card's edge and the rail's edge. */
export const RAIL_SIDE_PADDING_PX = 24;

/**
 * The rail never narrows past this. A pathological input (a source image with a
 * near-zero natural height, a viewport mid-collapse) must not be able to pinch
 * the rail to nothing and strand the grading surface.
 */
export const RAIL_SAFE_MIN_WIDTH_PX = 240;

/**
 * Adjustments smaller than this are ignored. Sub-pixel churn from fractional
 * layout is not a reason to relayout the whole workstation, and this is also the
 * band inside which a Front/Back switch counts as "the same requirement" rather
 * than a new one.
 */
export const RAIL_WIDTH_EPSILON_PX = 2;

/**
 * The width the card will actually occupy once the fit runs, computed from the
 * source aspect and the height the card is going to be given.
 *
 * Returns 0 for any degenerate input rather than NaN/Infinity, so a caller can
 * treat "no usable prediction" as "leave the rail alone".
 */
export function heightBoundCardWidth(input: {
  /** The card's post-inset safe height — what the fit will scale into. */
  safeCardHeight: number;
  /** Source image decoded width. NOT the rendered width. */
  naturalWidth: number;
  /** Source image decoded height. NOT the rendered height. */
  naturalHeight: number;
}): number {
  const { safeCardHeight, naturalWidth, naturalHeight } = input;
  if (!(safeCardHeight > 0) || !(naturalWidth > 0) || !(naturalHeight > 0)) return 0;
  if (!Number.isFinite(safeCardHeight) || !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)) return 0;
  return safeCardHeight * (naturalWidth / naturalHeight);
}

/**
 * The rail width a given source needs: the width its card will occupy, plus the
 * side padding, and nothing else.
 */
export function requiredRailWidth(input: {
  safeCardHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  sidePadding?: number;
}): number {
  const cardW = heightBoundCardWidth(input);
  if (cardW <= 0) return 0;
  return cardW + (input.sidePadding ?? RAIL_SIDE_PADDING_PX) * 2;
}

/**
 * The stable requirement for a grading SESSION, not for whichever side happens
 * to be showing.
 *
 * Front and Back are separate scans and can have different natural aspects, so
 * sizing the rail to the active side would move the whole workstation sideways
 * on every Front/Back click. The session takes the widest requirement across
 * every side whose natural dimensions are known, so switching sides never
 * changes the answer once both have loaded.
 *
 * Sides still loading are simply absent — the caller holds its current width
 * until they arrive and then settles once, rather than adopting a Front-only
 * width and re-adopting when Back decodes.
 */
export function sessionRequiredRailWidth(
  sides: Array<{ naturalWidth: number; naturalHeight: number } | null | undefined>,
  safeCardHeight: number,
  sidePadding: number = RAIL_SIDE_PADDING_PX
): number {
  let widest = 0;
  for (const side of sides) {
    if (!side) continue;
    const required = requiredRailWidth({
      safeCardHeight,
      naturalWidth: side.naturalWidth,
      naturalHeight: side.naturalHeight,
      sidePadding,
    });
    if (required > widest) widest = required;
  }
  return widest;
}

/**
 * Clamp the requirement into what the layout can actually give.
 *
 * `safeMax` is the CURRENT rail width (today's 45%). The rail may narrow toward
 * what the card needs; it may never grow past what it has today. That asymmetry
 * is deliberate and is what protects the accepted card at small viewports: at
 * 845x685 the requirement (375.0) already exceeds the current rail (371.3), so
 * the clamp returns the current width unchanged and the card is untouched —
 * a complete card outranks recovered space.
 */
export function resolveRailWidth(input: { required: number; safeMax: number; safeMin?: number }): number {
  const { required, safeMax } = input;
  const safeMin = input.safeMin ?? RAIL_SAFE_MIN_WIDTH_PX;
  if (!(required > 0) || !Number.isFinite(required)) return safeMax;
  return Math.min(safeMax, Math.max(safeMin, required));
}

/**
 * THE SETTLE RULE — the guard against the one coupling this design cannot
 * remove by construction.
 *
 * A narrower rail can wrap the controls row, which lowers the available height,
 * which lowers the next prediction. Left alone that ratchets the rail inward on
 * every recompute. So an adjustment is adopted only when it is not explainable
 * as a consequence of the adjustment already made:
 *
 *   - the first prediction for a given input set always settles;
 *   - after that, only a genuinely DIFFERENT requirement is adopted, and
 *     "different" means beyond the epsilon;
 *   - a requirement that merely got NARROWER while the rail was already at its
 *     adopted width is refused, because that is the wrap-feedback signature.
 *
 * Growth is always allowed: if the card needs more width (a taller viewport, a
 * wider scan), the card must get it — that direction can only ever end at
 * `safeMax`, so it terminates.
 */
export function shouldAdoptRailWidth(
  adopted: number | null,
  next: number,
  epsilon: number = RAIL_WIDTH_EPSILON_PX
): boolean {
  if (!(next > 0) || !Number.isFinite(next)) return false;
  if (adopted == null) return true;
  const delta = next - adopted;
  if (Math.abs(delta) <= epsilon) return false;
  // Narrower than what we already adopted is the feedback signature — refuse it.
  // Wider is a real new requirement and terminates at safeMax.
  return delta > 0;
}
