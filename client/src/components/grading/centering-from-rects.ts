/**
 * Pure centering math for the manual-centering tool (manual-centering.tsx).
 * Extracted from the component so the subgrade can be unit tested without
 * React, and — critically — so it routes through the ONE canonical centering
 * chart (shared/centering.ts) instead of a private ladder.
 */

import { centeringAxisGrade, type CenteringSide } from "@shared/centering";

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
  /** Centering subgrade 1–10 = worst of the two axes on the PSA chart. */
  subgrade: number;
}

/**
 * Convert dragged outer/inner rects into L/R + T/B ratios and a centering
 * subgrade. The subgrade is the WORST (minimum) of the two axes scored on the
 * canonical PSA chart for this side — front strict, back lenient — the same
 * source of truth as the 100-pt score, the locked chip, and the public
 * /standard tables. The ratios are rounded the same way they are saved, and
 * the subgrade is computed FROM those rounded ratios, so the tool's displayed
 * grade always equals what the rest of the app derives from the saved values.
 */
export function computeCentering(outer: Rect, inner: Rect, side: CenteringSide): CenteringFromRects {
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

  const subgrade = Math.min(centeringAxisGrade(lr, side), centeringAxisGrade(tb, side));

  return { lr, tb, subgrade };
}
