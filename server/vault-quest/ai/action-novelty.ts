/**
 * Action Reference replacement — pose novelty vs the EXISTING approved Action.
 *
 * Root cause this completes (see collectReferenceImages in vault-quest-admin.ts):
 * the existing pose-diversity gate (pose-diversity.ts) only measures how different a
 * new Action candidate is from the neutral MASTER. It never compared against the
 * character's CURRENTLY APPROVED Action pose, so a replacement that recreated the
 * existing action — a different pose from the Master, but the SAME running/leaping
 * pose as the one already approved — passed the gate. Combined with the existing
 * Action image being (wrongly) fed back as a generation reference, Replace Action
 * kept producing the same pose.
 *
 * This module is the pure, independently-testable half of the second gate: given a
 * 0-100 "how different is this pose from the EXISTING approved Action pose" score
 * (produced by the SAME vision call the identity/pose scorer already makes — see
 * identity.ts's `opts.existingActionPng`, one round trip, not a second paid call),
 * decide pass/fail against a configurable minimum. Deliberately separate from both
 * identity and pose-vs-Master: a candidate can be very different from the Master
 * (pose-diversity pass) yet nearly identical to the existing Action (this fails).
 */

export interface ActionNoveltyVerdict {
  /** 0-100: 0 = essentially the same action as the existing approved Action pose,
   *  100 = a completely different action/silhouette. */
  difference: number;
  verdict: "pass" | "fail";
  threshold: number;
}

/** Minimum difference from the EXISTING approved Action pose to pass (override with
 *  VQ_ACTION_REPLACEMENT_DIFF_MIN). Higher than the pose-vs-Master threshold (55) on
 *  purpose: replacing an Action should produce a clearly NEW action, not just any
 *  non-neutral pose. Defaults to 65. */
export function actionReplacementDifferenceThreshold(): number {
  const n = Number(process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 65;
}

/** Pure pass/fail derivation — no network call, no mocking needed to test it. */
export function evaluateActionNovelty(difference: number): ActionNoveltyVerdict {
  const threshold = actionReplacementDifferenceThreshold();
  const clamped = Number.isFinite(difference) ? Math.max(0, Math.min(100, Math.round(difference))) : 0;
  return { difference: clamped, verdict: clamped >= threshold ? "pass" : "fail", threshold };
}
