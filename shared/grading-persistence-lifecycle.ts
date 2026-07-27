/**
 * grading-persistence-lifecycle.ts — the ONE decision that says whether the
 * grading workstation may arm its debounced auto-save.
 *
 * WHY THIS IS A PURE FUNCTION (hostile review M-1)
 * The lifecycle rule used to live inline in `GradingPanel`'s auto-save effect as
 * a stack of early returns, and its only coverage was a source-string assertion
 * that the file CONTAINED `if (!active) return;`. That proves the text exists,
 * not that the decision is right — it would still pass if the guard were
 * unreachable, mis-ordered, or negated in a later refactor. Extracting the
 * decision makes it directly testable without a DOM: the component now calls
 * this and does exactly what it is told.
 *
 * WHAT WENT WRONG WITHOUT IT
 *   • MV900007 — the Grade panel is mounted HIDDEN-not-unmounted so a grader's
 *     work survives a stage switch, so its auto-save also ran while Card Details
 *     was on screen and persisted UI defaults (all-zero defect state, which MVGS
 *     scores as a perfect card) onto a certificate nobody had graded.
 *   • MV900010 — the same path converted an Authentic-Only record to numeric 10.
 *
 * FAIL CLOSED. Every unknown or in-between state resolves to "do not persist".
 * Persistence is armed only by a positive, fully-hydrated, user-visible edit.
 */

/** Everything the decision depends on. No React, no DOM, no time. */
export interface GradingPersistenceState {
  /** Is the Grade stage the ACTIVE stage on this surface? */
  active: boolean;
  /** The certificate currently mounted. 0 / null / undefined = nothing to save. */
  certId: number | null | undefined;
  /** The certId the grading GET has actually resolved for, or null. */
  hydratedForCertId: number | null;
  /** The grading GET is in flight, or failed. Either way state is not evidence. */
  workflowLocked: boolean;
  /** Approval timestamp — auto-save is pre-approval only. */
  gradeApprovedAt: unknown;
  /**
   * Whether the FIRST post-hydration run has already been consumed. The run that
   * immediately follows hydration is the GET's own setState echoing back what
   * was just read, not a user edit, so it is swallowed once.
   */
  settledAfterHydration: boolean;
}

export type GradingPersistenceReason =
  | "no-cert"
  | "inactive"
  | "workflow-locked"
  | "approved"
  | "awaiting-hydration"
  | "hydration-settle"
  | "user-edit";

export interface GradingPersistenceDecision {
  /** Arm the debounce and eventually PUT the grading route. */
  arm: boolean;
  reason: GradingPersistenceReason;
  /**
   * Mark this run as the consumed post-hydration settle run. True on exactly the
   * first fully-hydrated run for a given certificate, and never again.
   */
  markSettled: boolean;
  /**
   * Cancel any debounce already scheduled. TRUE for every non-arming decision,
   * so leaving the Grade stage, switching certificate, a failed GET or an
   * approval landing all drop pending work rather than letting a timer that was
   * armed under the old state fire under the new one.
   */
  cancelPending: boolean;
}

const deny = (
  reason: GradingPersistenceReason,
  markSettled = false,
): GradingPersistenceDecision => ({ arm: false, reason, markSettled, cancelPending: true });

/**
 * Order matters and is deliberate:
 *
 *  1. no certificate      — nothing addressable to save.
 *  2. INACTIVE            — checked before anything expensive, so a hidden panel
 *                           can never arm a timer even if a dependency changes
 *                           underneath it.
 *  3. workflow locked     — the GET is pending or errored; local state is UI
 *                           defaults, not grading evidence.
 *  4. approved            — auto-save is pre-approval only.
 *  5. hydration identity  — the payload must have landed FOR THIS certificate.
 *                           A boolean flag was not enough: on a card switch the
 *                           previous card's hydration satisfied it, so a stale
 *                           GET completing after the switch could save the wrong
 *                           record's state. Comparing certIds is self-
 *                           invalidating, which also makes React Strict Mode's
 *                           double-invocation harmless — the second run reaches
 *                           step 6 and is swallowed exactly like the first.
 *  6. settle run          — swallow the run caused by hydration itself.
 *  7. otherwise           — a genuine user edit. Arm.
 */
export function decideGradingPersistence(
  s: GradingPersistenceState,
): GradingPersistenceDecision {
  if (!s.certId) return deny("no-cert");
  if (!s.active) return deny("inactive");
  if (s.workflowLocked) return deny("workflow-locked");
  if (s.gradeApprovedAt) return deny("approved");
  if (s.hydratedForCertId == null || s.hydratedForCertId !== s.certId) {
    return deny("awaiting-hydration");
  }
  if (!s.settledAfterHydration) {
    // Consume the settle run. Nothing is armed, and any timer left over from a
    // previous certificate is dropped.
    return { arm: false, reason: "hydration-settle", markSettled: true, cancelPending: true };
  }
  return { arm: true, reason: "user-edit", markSettled: false, cancelPending: true };
}
