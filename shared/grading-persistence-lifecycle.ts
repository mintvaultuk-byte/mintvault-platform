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
  | "user-edit"
  /** M-1: an explicit operator save (Ctrl+S) that cleared every shared guard. */
  | "explicit-save";

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

const deny = (reason: GradingPersistenceReason, markSettled = false): GradingPersistenceDecision => ({
  arm: false,
  reason,
  markSettled,
  cancelPending: true,
});

/**
 * M-1 · THE ONE GUARD CHAIN, shared by autosave AND explicit operator saves.
 *
 * Extracted so `decideExplicitGradingSave` below cannot become a SECOND, weaker
 * set of conditions. That is exactly what the hostile review found: the debounced
 * autosave was correctly gated while the document-level Ctrl+S handler answered
 * to `gradingWorkflowLocked` alone, so a hidden Grade panel could still issue an
 * authorised grading write from stale state.
 *
 * Order matters and is deliberate. Steps 1-5 live here and are identical for
 * BOTH triggers; the autosave-specific step 6 lives in
 * `decideGradingPersistence`.
 *
 *  1. no certificate      — nothing addressable to save.
 *  2. INACTIVE            — checked before anything expensive, so a hidden panel
 *                           can never arm a timer, and no keystroke it receives
 *                           can persist, even if a dependency changes underneath.
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
 *  6. settle run          — swallow the run caused by hydration itself
 *                           (auto-save only; a deliberate keystroke is not an echo).
 *  7. otherwise           — a genuine user edit. Arm.
 *
 * Returns the denial reason, or null when every shared guard is satisfied.
 */
function sharedPersistenceDenial(s: GradingPersistenceState): GradingPersistenceReason | null {
  if (!s.certId) return "no-cert";
  if (!s.active) return "inactive";
  if (s.workflowLocked) return "workflow-locked";
  if (s.gradeApprovedAt) return "approved";
  if (s.hydratedForCertId == null || s.hydratedForCertId !== s.certId) {
    return "awaiting-hydration";
  }
  return null;
}

/**
 * M-1 · may an EXPLICIT operator action (Ctrl+S, and the Ctrl+Enter approval
 * shortcut) persist right now?
 *
 * Uses the SAME chain as the debounced autosave, minus the settle run — that run
 * exists only to swallow the GET's own setState echo, which is meaningless for a
 * deliberate keystroke. Every other guard applies unchanged, so a hidden panel,
 * an unhydrated panel, a panel showing a DIFFERENT certificate than the one it
 * hydrated for, a locked workflow and an already-approved certificate are all
 * refused.
 *
 * `approved` is deliberately refused here too. Post-approval edits go through
 * edit mode + Save (`saveEditedGrade`), which is audited as a live-record edit;
 * letting Ctrl+S silently rewrite a PUBLISHED certificate is precisely the
 * silent-write behaviour the auto-save gate already removed.
 */
export function decideExplicitGradingSave(s: GradingPersistenceState): {
  allow: boolean;
  reason: GradingPersistenceReason;
} {
  const denial = sharedPersistenceDenial(s);
  return denial ? { allow: false, reason: denial } : { allow: true, reason: "explicit-save" };
}

/** What the document-level keydown handler should actually do. */
export type GradingShortcutOutcome =
  /** Not ours: wrong keys, an editable control, or an INACTIVE panel. The event
   *  is left completely alone — no preventDefault, no toast, no request. */
  | { action: "ignore"; reason: "not-a-shortcut" | "editable-target" | "inactive" }
  /** Ours, but refused. preventDefault + explain; never persists. */
  | { action: "blocked"; reason: GradingPersistenceReason }
  /** Ours, refused by a pre-approval checklist gate rather than the lifecycle. */
  | { action: "blocked-checklist"; reason: "deionization" | "crop-gate" }
  | { action: "save-draft" }
  | { action: "open-approval" };

export interface GradingShortcutEvent {
  key: string;
  ctrlKey: boolean;
  /** `event.target.tagName`, or null/undefined when there is no element target. */
  targetTag?: string | null;
  /**
   * M-2 · `event.target.isContentEditable`. A rich-text host is an editable
   * control that is NOT an INPUT/SELECT/TEXTAREA, so the tag check alone would
   * have swallowed the operator's keystroke inside one.
   */
  targetIsContentEditable?: boolean | null;
}

export interface GradingShortcutState extends GradingPersistenceState {
  deionizationComplete: boolean;
  /** True when the crop gate would block approval right now. */
  cropGateBlocked: boolean;
  /**
   * M-2 · is the stage that OWNS the approval action on screen right now?
   *
   * `active` means the GRADE stage — the stage that owns Ctrl+S. Approval lives
   * on the REVIEW stage, which is a different stage, so it needs its own flag.
   * Overloading `active` for both would either make Ctrl+Enter dead on Review
   * (the defect this closes) or make the Grade stage able to approve — the two
   * shortcuts belong to two different stages and now say so.
   *
   * Optional and defaulting to FALSE at every call site: a surface that forgets
   * to wire it loses the shortcut rather than gaining an unowned one.
   */
  approvalStageActive?: boolean;
}

/** Controls whose native keyboard behaviour must never be intercepted. */
const EDITABLE_TAGS: ReadonlySet<string> = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/**
 * M-1 · THE WHOLE Ctrl+S / Ctrl+Enter DECISION, as a pure function.
 *
 * Extracted for the same reason `decideGradingPersistence` was in PR #260: the
 * rule previously lived inline in a `useEffect` whose only possible coverage was
 * asserting that the file CONTAINED some guard text. That proves the text
 * exists, not that the decision is right, and it would still pass if the guard
 * were mis-ordered, unreachable or negated. This repository has no DOM test
 * environment (no jsdom, no @testing-library — and adding one is out of scope
 * here), so extracting the decision is what makes the rule provable as
 * BEHAVIOUR rather than as a source-string grep.
 *
 * ORDER IS DELIBERATE:
 *  1. not a shortcut     — leave every other keystroke alone.
 *  2. editable target    — INPUT/SELECT/TEXTAREA and any contentEditable host
 *                          keep native behaviour, checked BEFORE anything else
 *                          can preventDefault.
 *  3. OWNING STAGE       — each shortcut belongs to exactly ONE stage: Ctrl+S to
 *                          Grade (`active`), Ctrl+Enter to Review
 *                          (`approvalStageActive`). A panel whose owning stage is
 *                          off screen is completely inert. Deliberately an
 *                          "ignore", not a "blocked": swallowing the browser's
 *                          own Ctrl+S from an off-screen component would be
 *                          wrong, because the operator is looking at a different
 *                          stage and this panel has no claim on the keystroke.
 *  4. shared lifecycle   — the SAME chain the debounced auto-save uses, run with
 *                          the owning stage's flag substituted for `active`.
 *  5. checklist gates    — approval-only, read from CURRENT state.
 *
 * M-2 · WHY STEP 3 IS PER-ACTION. The first version of this function admitted
 * BOTH shortcuts on `active` alone. `active` is true only on the GRADE stage,
 * but the stage gate hides `[data-canonical-section="footer-actions"]` there and
 * shows it on REVIEW — so Ctrl+Enter fired only on the stage where Approve is
 * hidden and was dead on the stage where it is offered. Substituting the owning
 * stage's flag INTO the shared chain (rather than skipping the chain for
 * approval) is what keeps this from becoming a weaker second gate: workflow
 * lock, approved state, hydration identity and certificate identity are all
 * still enforced, unchanged, for both shortcuts.
 */
export function decideGradingShortcut(ev: GradingShortcutEvent, s: GradingShortcutState): GradingShortcutOutcome {
  const isSave = ev.ctrlKey && ev.key === "s";
  const isApprove = ev.ctrlKey && ev.key === "Enter";
  if (!isSave && !isApprove) return { action: "ignore", reason: "not-a-shortcut" };
  if (ev.targetIsContentEditable) return { action: "ignore", reason: "editable-target" };
  if (ev.targetTag && EDITABLE_TAGS.has(ev.targetTag)) {
    return { action: "ignore", reason: "editable-target" };
  }

  // The stage that OWNS this shortcut. Ctrl+S is Grade-stage work; Ctrl+Enter is
  // Review-stage work. Absent (undefined) approval wiring reads as false.
  const owningStageActive = isSave ? s.active : s.approvalStageActive === true;
  if (!owningStageActive) return { action: "ignore", reason: "inactive" };

  // Same chain, with the owning stage's flag in the `active` slot — NOT a second
  // weaker set of conditions.
  const gate = decideExplicitGradingSave({ ...s, active: owningStageActive });
  if (!gate.allow) return { action: "blocked", reason: gate.reason };

  if (isSave) return { action: "save-draft" };
  if (!s.deionizationComplete) return { action: "blocked-checklist", reason: "deionization" };
  if (s.cropGateBlocked) return { action: "blocked-checklist", reason: "crop-gate" };
  return { action: "open-approval" };
}

export function decideGradingPersistence(s: GradingPersistenceState): GradingPersistenceDecision {
  const denial = sharedPersistenceDenial(s);
  if (denial) return deny(denial);
  if (!s.settledAfterHydration) {
    // Consume the settle run. Nothing is armed, and any timer left over from a
    // previous certificate is dropped.
    return { arm: false, reason: "hydration-settle", markSettled: true, cancelPending: true };
  }
  return { arm: true, reason: "user-edit", markSettled: false, cancelPending: true };
}
