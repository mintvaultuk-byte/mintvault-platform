/**
 * Action Reference pose-diversity gate.
 *
 * Root cause of the bug this fixes: the identity scorer's own prompt explicitly
 * tells the vision model "pose ... ARE ALLOWED to change — do not penalise them"
 * (identity.ts) — correct for identity purposes, but it means NOTHING in the
 * pipeline ever penalises a lazy near-duplicate pose. Combined with a weak
 * one-adjective prompt hint ("dynamic action pose"), the generator had no real
 * pressure to move away from the Master's neutral standing pose, so Action
 * References routinely came back looking like the Master with a slightly
 * different camera angle — high identity score, wrong pose.
 *
 * This module is the pure, independently-testable half of the fix: given a
 * 0-100 "how different is the pose from the Master" score (produced by the
 * SAME vision call the identity scorer already makes — see identity.ts's
 * `opts.masterPng`, one round trip, not a second paid/timed API call), decide
 * pass/fail against a configurable minimum. Deliberately separate from
 * identity.ts's verdict: a candidate can have perfect identity and still fail
 * here, and vice versa — the two are graded independently on purpose.
 */

export interface PoseDiversityVerdict {
  /** 0-100: 0 = essentially the same pose as the Master, 100 = a completely different action/pose. */
  difference: number;
  verdict: "pass" | "fail";
  threshold: number;
}

/** Minimum pose-difference to pass (override with VQ_POSE_DIFFERENCE_MIN). Standing
 *  with near-identical feet/body-angle/head-rotation/tail scores well below this;
 *  running/leaping/crouching/twisting/attacking score well above it. */
export function poseDifferenceThreshold(): number {
  const n = Number(process.env.VQ_POSE_DIFFERENCE_MIN);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 55;
}

/** Pure pass/fail derivation — no network call, no mocking needed to test it. */
export function evaluatePoseDiversity(difference: number): PoseDiversityVerdict {
  const threshold = poseDifferenceThreshold();
  const clamped = Number.isFinite(difference) ? Math.max(0, Math.min(100, Math.round(difference))) : 0;
  return { difference: clamped, verdict: clamped >= threshold ? "pass" : "fail", threshold };
}
