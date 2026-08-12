/**
 * Pure centering math for the manual-centering tool (manual-centering.tsx).
 * This client helper derives only observable ratios from drag geometry. The
 * server resolves every centering subgrade after the measurement is saved.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CenteringFromRects {
  /** Bigger-side-first L/R ratio string, e.g. "60/40". */
  lr: string;
  /** Bigger-side-first T/B ratio string, e.g. "55/45". */
  tb: string;
}

/**
 * Convert dragged outer/inner rects into L/R + T/B ratios. `side` remains in
 * the signature for capture-call compatibility but is intentionally not used
 * by the browser: the server owns the chart and returned subgrade.
 */
export function computeCentering(outer: Rect, inner: Rect, _side: "front" | "back"): CenteringFromRects {
  const leftB = inner.left - outer.left;
  const rightB = outer.right - inner.right;
  const topB = inner.top - outer.top;
  const bottomB = outer.bottom - inner.bottom;
  const totalH = leftB + rightB;
  const totalV = topB + bottomB;

  // Float share of the left / top margin; centred when the side has no width.
  const lFloat = totalH > 0 ? (leftB / totalH) * 100 : 50;
  const tFloat = totalV > 0 ? (topB / totalV) * 100 : 50;

  // Round left/top, derive right/bottom so each pair always sums to 100.
  const lRound = Math.round(lFloat);
  const rRound = 100 - lRound;
  const tRound = Math.round(tFloat);
  const bRound = 100 - tRound;

  const lr = lRound >= rRound ? `${lRound}/${rRound}` : `${rRound}/${lRound}`;
  const tb = tRound >= bRound ? `${tRound}/${bRound}` : `${bRound}/${tRound}`;

  return { lr, tb };
}
