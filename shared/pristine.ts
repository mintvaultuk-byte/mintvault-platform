/**
 * MintVault Pristine 10P / black-label gate — SINGLE SOURCE OF TRUTH.
 *
 * A "Pristine 10P" (black label) card is the top designation. It must clear a
 * stricter bar than a plain Gem-Mint 10: not only must the overall grade and
 * all four subgrades be exactly 10, there must also be ZERO raw defect
 * deduction in every category. A card that buckets to a 10 chip but carries
 * e.g. corners -1.5 / edges -1.25 of real deduction is flawless on paper but
 * not in fact, so it must NOT wear the Pristine badge.
 *
 * This used to be computed three different ways: the client grade panel
 * (grade-logic.ts), the approve-grade route, and the approve route each had
 * their own check, and two of the server checks ignored deductions entirely.
 * They now all call THIS gate. Pure — no DB, no env, no React. Safe on the
 * client (render) and the server.
 */

export interface PristineSubgrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

// Deduction keys that represent real card defects. A Pristine 10P card must
// have zero of these. eye_appeal is a subjective modifier, not a defect, so it
// is intentionally excluded — a card can carry an eye-appeal adjustment and
// still be Pristine. Keys match computeMvgsScore(...).deductions exactly.
export const DEFECT_DEDUCTION_KEYS = ["centering_front", "centering_back", "corners", "edges", "surface"] as const;

/**
 * Pristine 10P / black-label gate. Requires BOTH:
 *   1. overall === 10 AND all four subgrades === 10, AND
 *   2. when `deductions` is supplied, zero raw deduction in every defect
 *      category (any negative value fails the gate).
 *
 * Pass computeMvgsScore(...).deductions to enforce the deduction rule. Omit it
 * (or pass undefined) for the legacy subgrades-only check — callers that have
 * no deduction data fall back to that weaker check rather than crashing.
 */
export function isPristine(
  sub: PristineSubgrades,
  overall: number,
  deductions?: Record<string, number> | null
): boolean {
  const subsAllTen =
    overall === 10 && sub.centering === 10 && sub.corners === 10 && sub.edges === 10 && sub.surface === 10;
  if (!subsAllTen) return false;
  if (!deductions) return true;
  return DEFECT_DEDUCTION_KEYS.every((k) => !((deductions[k] ?? 0) < 0));
}

/**
 * Black label IS the visual manifestation of the Pristine 10P gate — identical
 * rule, kept as a named alias so call sites can use whichever word fits the
 * surrounding code (label rendering says "black label", grading UI says
 * "Pristine").
 */
export const isBlackLabel = isPristine;
