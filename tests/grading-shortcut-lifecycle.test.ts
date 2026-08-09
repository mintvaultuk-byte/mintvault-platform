/**
 * M-1 · the hidden Grade panel must not be able to write a grade by keyboard.
 *
 * WHAT WENT WRONG
 * `GradingPanel` is mounted HIDDEN-not-unmounted by the stage gate so a grader's
 * in-progress work survives a stage switch. Its document-level keydown listener
 * was registered once with an empty dependency array and stayed live for the
 * whole mount — including while Card Details or Review was on screen. Ctrl+S
 * therefore called `saveDraft()` from an OFF-SCREEN panel and issued an
 * authorised `PUT /certificates/:id/grade` carrying `overall_grade`. If another
 * surface had written a newer grade in the meantime, that keystroke reverted it:
 * MV900007's failure class reached by keyboard instead of by debounce.
 *
 * Its only guard was `gradingWorkflowLocked`, which says the GET is not in
 * flight. It does NOT say the panel is visible, and it does NOT say the hydrated
 * payload belongs to the certificate now mounted.
 *
 * A SECOND defect in the same handler: with an empty dependency array `onKey`
 * closed over the FIRST render's `saveDraft`, `deionizationComplete` and
 * `cropGateBlockToast`, so the Ctrl+Enter approval shortcut read a stale
 * deionization checkbox and a stale crop gate.
 *
 * WHY THESE TESTS LOOK LIKE THIS
 * This repository has no DOM test environment — there is no jsdom and no
 * @testing-library, and component tests render with `react-dom/server`. Adding a
 * DOM runtime is a new dependency and out of scope here. So the decision is
 * extracted into `decideGradingShortcut`, exactly as PR #260 extracted
 * `decideGradingPersistence` for the auto-save, and the rule is proven as
 * BEHAVIOUR against that function rather than by asserting the component's
 * source text contains a guard. A source-string assertion proves the text
 * exists, not that the decision is right — it would still pass if the guard were
 * mis-ordered, unreachable or negated.
 *
 * The component-level structural facts that a pure function CANNOT cover
 * (single listener registration, cleanup on unmount, the ref mirror that kills
 * the stale closures) are asserted separately at the bottom, and are labelled as
 * structural rather than behavioural so the distinction is not blurred.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  decideGradingShortcut,
  decideExplicitGradingSave,
  decideGradingPersistence,
  type GradingShortcutState,
} from "@shared/grading-persistence-lifecycle";

/** A fully-hydrated, visible, editable Grade panel — the only state that saves. */
const READY: GradingShortcutState = {
  active: true,
  certId: 42,
  hydratedForCertId: 42,
  workflowLocked: false,
  gradeApprovedAt: null,
  settledAfterHydration: true,
  deionizationComplete: true,
  cropGateBlocked: false,
};

/**
 * M-2 · the SAME panel with the REVIEW stage on screen.
 *
 * This is the real runtime combination the first version of the fix got wrong:
 * on Review the stage gate sets `active` FALSE (Grade is off screen) while
 * Approve/Publish is the only action visible. `approvalStageActive` is what says
 * the approval shortcut's owning stage is up.
 */
const REVIEW_READY: GradingShortcutState = { ...READY, active: false, approvalStageActive: true };

const CTRL_S = { key: "s", ctrlKey: true, targetTag: "DIV" };
const CTRL_ENTER = { key: "Enter", ctrlKey: true, targetTag: "DIV" };

/** Every outcome that results in a grading-route request. */
const isGradingWrite = (o: { action: string }) => o.action === "save-draft";

describe("M-1 · 1-2. a HIDDEN Grade stage issues no grading request", () => {
  const hidden: GradingShortcutState = { ...READY, active: false };

  it("1. Card Details on screen + Ctrl+S → zero grading requests", () => {
    const out = decideGradingShortcut(CTRL_S, hidden);
    expect(isGradingWrite(out)).toBe(false);
    expect(out).toEqual({ action: "ignore", reason: "inactive" });
  });

  it("2. Card Details on screen + Ctrl+Enter → no approval, no request", () => {
    const out = decideGradingShortcut(CTRL_ENTER, hidden);
    expect(isGradingWrite(out)).toBe(false);
    expect(out.action).not.toBe("open-approval");
    expect(out).toEqual({ action: "ignore", reason: "inactive" });
  });

  it("an inactive panel does not even swallow the keystroke", () => {
    // Deliberately "ignore", not "blocked": the operator is looking at another
    // stage, so this panel has no claim on Ctrl+S and must not preventDefault
    // the browser's own shortcut.
    expect(decideGradingShortcut(CTRL_S, hidden).action).toBe("ignore");
  });

  it("stays inert regardless of how ready everything ELSE is", () => {
    for (const extra of [
      { workflowLocked: false, hydratedForCertId: 42 },
      { deionizationComplete: true, cropGateBlocked: false },
    ]) {
      expect(decideGradingShortcut(CTRL_S, { ...hidden, ...extra }).action).toBe("ignore");
    }
  });
});

describe("M-1 · 3. an ACTIVE, hydrated Grade stage still saves normally", () => {
  it("3. Ctrl+S on the current certificate produces exactly one save", () => {
    expect(decideGradingShortcut(CTRL_S, READY)).toEqual({ action: "save-draft" });
  });

  it("Ctrl+Enter opens the approval dialog when the checklist is clear", () => {
    // M-2: on the REVIEW stage, which is the stage that owns Approve/Publish.
    expect(decideGradingShortcut(CTRL_ENTER, REVIEW_READY)).toEqual({ action: "open-approval" });
  });

  it("the approval shortcut still honours the deionization checklist", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, deionizationComplete: false })).toEqual({
      action: "blocked-checklist",
      reason: "deionization",
    });
  });

  it("the approval shortcut still honours the crop gate", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, cropGateBlocked: true })).toEqual({
      action: "blocked-checklist",
      reason: "crop-gate",
    });
  });

  it("a checklist block is never a grading write", () => {
    expect(isGradingWrite(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, cropGateBlocked: true }))).toBe(false);
  });
});

describe("M-1 · 4. a certificate switch invalidates the old identity", () => {
  it("4. the panel still holding the PREVIOUS card's payload cannot save", () => {
    // The panel is now mounted for cert 43 but `hydratedForCertId` is still 42:
    // its local state is the OLD record's grading evidence.
    const out = decideGradingShortcut(CTRL_S, { ...READY, certId: 43, hydratedForCertId: 42 });
    expect(isGradingWrite(out)).toBe(false);
    expect(out).toEqual({ action: "blocked", reason: "awaiting-hydration" });
  });

  it("nothing is hydrated yet → refused", () => {
    expect(decideGradingShortcut(CTRL_S, { ...READY, hydratedForCertId: null })).toEqual({
      action: "blocked",
      reason: "awaiting-hydration",
    });
  });

  it("saves again once the NEW certificate has hydrated", () => {
    expect(decideGradingShortcut(CTRL_S, { ...READY, certId: 43, hydratedForCertId: 43 })).toEqual({
      action: "save-draft",
    });
  });

  it("no certificate at all → refused", () => {
    expect(decideGradingShortcut(CTRL_S, { ...READY, certId: 0, hydratedForCertId: null })).toEqual({
      action: "blocked",
      reason: "no-cert",
    });
  });
});

describe("M-1 · 5. a stage change or in-flight load prevents a stale write", () => {
  it("5. going inactive while a keystroke is being handled yields no write", () => {
    // The handler reads the CURRENT state through a ref, so the moment the stage
    // flips the very same keystroke resolves to inert.
    const before = decideGradingShortcut(CTRL_S, READY);
    const after = decideGradingShortcut(CTRL_S, { ...READY, active: false });
    expect(isGradingWrite(before)).toBe(true);
    expect(isGradingWrite(after)).toBe(false);
  });

  it("a GET still in flight (or errored) refuses the keystroke", () => {
    expect(decideGradingShortcut(CTRL_S, { ...READY, workflowLocked: true })).toEqual({
      action: "blocked",
      reason: "workflow-locked",
    });
  });

  it("an APPROVED certificate cannot be rewritten by Ctrl+S", () => {
    // Post-approval edits go through Correction Mode / edit-mode Save, which is
    // audited as a live-record edit. Letting a keyboard shortcut silently
    // rewrite a PUBLISHED certificate is the silent-write behaviour the
    // auto-save gate already removed.
    const out = decideGradingShortcut(CTRL_S, { ...READY, gradeApprovedAt: "2026-07-01T00:00:00Z" });
    expect(isGradingWrite(out)).toBe(false);
    expect(out).toEqual({ action: "blocked", reason: "approved" });
  });
});

describe("M-1 · 7. ordinary typing keeps native browser behaviour", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    it(`7. Ctrl+S inside a <${tag.toLowerCase()}> is left entirely alone`, () => {
      expect(decideGradingShortcut({ ...CTRL_S, targetTag: tag }, READY)).toEqual({
        action: "ignore",
        reason: "editable-target",
      });
    });
    it(`Ctrl+Enter inside a <${tag.toLowerCase()}> is left entirely alone`, () => {
      expect(decideGradingShortcut({ ...CTRL_ENTER, targetTag: tag }, READY)).toEqual({
        action: "ignore",
        reason: "editable-target",
      });
    });
  }

  it("the editable check runs BEFORE the lifecycle, so typing is never swallowed", () => {
    // Even in a state that would otherwise be blocked-and-toasted, a keystroke
    // inside a form control must fall through to the browser untouched.
    expect(decideGradingShortcut({ ...CTRL_S, targetTag: "INPUT" }, { ...READY, workflowLocked: true })).toEqual({
      action: "ignore",
      reason: "editable-target",
    });
  });

  it("unrelated keystrokes are ignored", () => {
    for (const ev of [
      { key: "s", ctrlKey: false, targetTag: "DIV" },
      { key: "a", ctrlKey: true, targetTag: "DIV" },
      { key: "Enter", ctrlKey: false, targetTag: "DIV" },
      { key: "Escape", ctrlKey: true, targetTag: "DIV" },
    ]) {
      expect(decideGradingShortcut(ev, READY)).toEqual({ action: "ignore", reason: "not-a-shortcut" });
    }
  });

  it("a null target (no element) is still evaluated normally", () => {
    expect(decideGradingShortcut({ key: "s", ctrlKey: true, targetTag: null }, READY)).toEqual({
      action: "save-draft",
    });
  });
});

describe("M-1 · the keyboard gate is the SAME chain as auto-save, not a weaker one", () => {
  const STATES: GradingShortcutState[] = [
    READY,
    { ...READY, active: false },
    { ...READY, certId: 0 },
    { ...READY, workflowLocked: true },
    { ...READY, gradeApprovedAt: "2026-01-01" },
    { ...READY, hydratedForCertId: 7 },
    { ...READY, hydratedForCertId: null },
  ];

  it("every state that refuses AUTO-save also refuses an explicit save", () => {
    for (const s of STATES) {
      const auto = decideGradingPersistence(s);
      const explicit = decideExplicitGradingSave(s);
      // The settle run is the ONE autosave-specific step: it withholds the
      // debounce but is not a lifecycle refusal, so it is excluded here.
      if (!auto.arm && auto.reason !== "hydration-settle") {
        expect(explicit.allow, `explicit save must also refuse: ${auto.reason}`).toBe(false);
        expect(explicit.reason).toBe(auto.reason);
      }
    }
  });

  it("a keystroke never persists in a state where auto-save is refused", () => {
    for (const s of STATES) {
      const auto = decideGradingPersistence(s);
      if (!auto.arm && auto.reason !== "hydration-settle") {
        expect(isGradingWrite(decideGradingShortcut(CTRL_S, s))).toBe(false);
      }
    }
  });

  it("the settle run withholds the DEBOUNCE but not a deliberate keystroke", () => {
    // A settle run means "hydration just landed, swallow its echo". That is
    // meaningless for a keystroke the operator actually pressed.
    const settling = { ...READY, settledAfterHydration: false };
    expect(decideGradingPersistence(settling).arm).toBe(false);
    expect(decideGradingShortcut(CTRL_S, settling)).toEqual({ action: "save-draft" });
  });
});

describe("M-1 · 6. structural guarantees the pure function cannot cover", () => {
  // Explicitly labelled STRUCTURAL. These assert wiring that has no runtime
  // representation outside a DOM, and are deliberately NOT presented as
  // behavioural proof of the rule — that lives in the suites above.
  const panel = readFileSync(path.resolve(__dirname, "../client/src/components/grading/grading-panel.tsx"), "utf8");

  it("6. exactly ONE document keydown listener is registered, and it is removed", () => {
    expect(panel.match(/document\.addEventListener\("keydown"/g) ?? []).toHaveLength(1);
    expect(panel.match(/document\.removeEventListener\("keydown"/g) ?? []).toHaveLength(1);
  });

  it("the listener effect keeps its empty dependency array (no re-registration)", () => {
    const idx = panel.indexOf('document.addEventListener("keydown"');
    expect(idx).toBeGreaterThan(-1);
    // The cleanup + `}, []);` must follow immediately: a dependency array with
    // entries would tear down and re-add the listener on every change.
    expect(panel.slice(idx, idx + 300)).toMatch(/\}, \[\]\);/);
  });

  it("the handler reads live state through a ref, not a first-render closure", () => {
    expect(panel).toContain("shortcutStateRef");
    // The mirror effect must have NO dependency array so it refreshes after
    // every render — that is what kills the stale closure.
    expect(panel).toMatch(/shortcutStateRef\.current = \{[\s\S]*?\};\s*\}\);/);
  });

  it("the handler delegates to the shared decision instead of re-deriving one", () => {
    expect(panel).toContain("decideGradingShortcut(");
  });

  it("saveDraft itself is gated, so any future caller inherits the contract", () => {
    const save = panel.slice(panel.indexOf("async function saveDraft()"));
    expect(save.slice(0, 900)).toContain("decideExplicitGradingSave(");
  });

  it("saveDraft pins the certificate it was authorised for", () => {
    // Bound to the function body rather than a character count.
    const start = panel.indexOf("async function saveDraft()");
    const save = panel.slice(start, panel.indexOf("\n  }", panel.indexOf("finally", start)));
    expect(save).toContain("savingCertId");
    expect(save).toContain("saveDraftInFlightRef");
    // The request must address the PINNED id, not whatever certId is current
    // by the time the fetch is constructed.
    expect(save).toMatch(/certificates\/\$\{savingCertId\}\/grade/);
  });
});

/**
 * M-2 (hostile review of PR #262) · each shortcut belongs to the stage that owns
 * its action.
 *
 * WHAT WENT WRONG
 * The first version admitted BOTH shortcuts on `active` alone. `active` is true
 * only on the GRADE stage — but the stage gate hides
 * `[data-canonical-section="footer-actions"]` on Grade and shows it on REVIEW,
 * so Approve/Publish exists only on Review. Ctrl+Enter therefore fired only on
 * the stage where Approve is hidden, and was dead on the stage where it is
 * offered. Safe (it failed closed) but the documented operator shortcut was
 * gone.
 *
 * The fix does NOT relax the lifecycle to let approval through: it substitutes
 * the OWNING stage's flag into the same shared chain. Every other guard —
 * workflow lock, approved state, hydration identity, certificate identity — is
 * still enforced for both shortcuts, which the cross-check at the bottom pins.
 */
describe("M-2 · Ctrl+S belongs to Grade, Ctrl+Enter belongs to Review", () => {
  it("Ctrl+S on the GRADE stage saves", () => {
    expect(decideGradingShortcut(CTRL_S, READY)).toEqual({ action: "save-draft" });
  });

  it("Ctrl+S on the REVIEW stage does NOT save — Grade is off screen", () => {
    // The regression this must never allow back: a save issued from a stage
    // whose editing surface the operator cannot see.
    const out = decideGradingShortcut(CTRL_S, REVIEW_READY);
    expect(out).toEqual({ action: "ignore", reason: "inactive" });
    expect(isGradingWrite(out)).toBe(false);
  });

  it("Ctrl+Enter on the REVIEW stage opens approval — the M-2 defect itself", () => {
    expect(decideGradingShortcut(CTRL_ENTER, REVIEW_READY)).toEqual({ action: "open-approval" });
  });

  it("Ctrl+Enter on the GRADE stage does nothing — Approve is not offered there", () => {
    expect(decideGradingShortcut(CTRL_ENTER, READY)).toEqual({ action: "ignore", reason: "inactive" });
  });

  it("a HIDDEN panel is inert for BOTH shortcuts", () => {
    const hidden: GradingShortcutState = { ...READY, active: false, approvalStageActive: false };
    expect(decideGradingShortcut(CTRL_S, hidden)).toEqual({ action: "ignore", reason: "inactive" });
    expect(decideGradingShortcut(CTRL_ENTER, hidden)).toEqual({ action: "ignore", reason: "inactive" });
  });

  it("UNWIRED approval (flag absent) fails CLOSED rather than open", () => {
    const unwired = { ...READY, active: false } as GradingShortcutState;
    expect(unwired.approvalStageActive).toBeUndefined();
    expect(decideGradingShortcut(CTRL_ENTER, unwired)).toEqual({ action: "ignore", reason: "inactive" });
  });

  it("both stages active at once still routes each key to its own action", () => {
    // Not a real runtime combination, but it proves the two flags are read
    // independently rather than one being derived from the other.
    const both: GradingShortcutState = { ...READY, active: true, approvalStageActive: true };
    expect(decideGradingShortcut(CTRL_S, both)).toEqual({ action: "save-draft" });
    expect(decideGradingShortcut(CTRL_ENTER, both)).toEqual({ action: "open-approval" });
  });
});

describe("M-2 · the Review-stage approval inherits EVERY lifecycle guard", () => {
  it("a stale certificate identity refuses approval", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, hydratedForCertId: 41 })).toEqual({
      action: "blocked",
      reason: "awaiting-hydration",
    });
  });

  it("an unhydrated panel refuses approval", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, hydratedForCertId: null })).toEqual({
      action: "blocked",
      reason: "awaiting-hydration",
    });
  });

  it("a certificate SWITCH mid-review refuses until the new card hydrates", () => {
    const switched: GradingShortcutState = { ...REVIEW_READY, certId: 43 };
    expect(decideGradingShortcut(CTRL_ENTER, switched)).toEqual({
      action: "blocked",
      reason: "awaiting-hydration",
    });
    // …and allows it again once hydration catches up.
    expect(decideGradingShortcut(CTRL_ENTER, { ...switched, hydratedForCertId: 43 })).toEqual({
      action: "open-approval",
    });
  });

  it("a locked workflow refuses approval", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, workflowLocked: true })).toEqual({
      action: "blocked",
      reason: "workflow-locked",
    });
  });

  it("an ALREADY-APPROVED certificate refuses approval", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, gradeApprovedAt: "2026-07-01T00:00:00Z" })).toEqual({
      action: "blocked",
      reason: "approved",
    });
  });

  it("no certificate at all refuses approval", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, certId: null })).toEqual({
      action: "blocked",
      reason: "no-cert",
    });
  });

  it("every state that refuses a Grade-stage SAVE also refuses a Review APPROVAL", () => {
    const denials: Array<Partial<GradingShortcutState>> = [
      { certId: null },
      { workflowLocked: true },
      { gradeApprovedAt: "2026-07-01T00:00:00Z" },
      { hydratedForCertId: null },
      { hydratedForCertId: 41 },
    ];
    for (const d of denials) {
      const save = decideGradingShortcut(CTRL_S, { ...READY, ...d });
      const approve = decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, ...d });
      expect(save.action, `save must not proceed for ${JSON.stringify(d)}`).not.toBe("save-draft");
      expect(approve.action, `approval must not proceed for ${JSON.stringify(d)}`).not.toBe("open-approval");
    }
  });
});

describe("M-2 · editable targets keep native behaviour on BOTH shortcuts", () => {
  for (const tag of ["INPUT", "SELECT", "TEXTAREA"]) {
    it(`Ctrl+Enter inside a <${tag.toLowerCase()}> on Review is left alone`, () => {
      expect(decideGradingShortcut({ ...CTRL_ENTER, targetTag: tag }, REVIEW_READY)).toEqual({
        action: "ignore",
        reason: "editable-target",
      });
    });
  }

  it("a contentEditable host is an editable target too", () => {
    // A rich-text host is not an INPUT/SELECT/TEXTAREA, so the tag check alone
    // would have swallowed the operator's keystroke inside one.
    expect(
      decideGradingShortcut(
        { key: "Enter", ctrlKey: true, targetTag: "DIV", targetIsContentEditable: true },
        REVIEW_READY
      )
    ).toEqual({ action: "ignore", reason: "editable-target" });
    expect(
      decideGradingShortcut({ key: "s", ctrlKey: true, targetTag: "DIV", targetIsContentEditable: true }, READY)
    ).toEqual({ action: "ignore", reason: "editable-target" });
  });

  it("the editable check runs BEFORE the stage gate, so typing is never swallowed", () => {
    // Even on a panel whose stage is off screen, an editable target is an
    // "ignore" for the editable reason — the keystroke belongs to the control.
    expect(
      decideGradingShortcut({ ...CTRL_ENTER, targetTag: "TEXTAREA" }, { ...REVIEW_READY, approvalStageActive: false })
    ).toEqual({ action: "ignore", reason: "editable-target" });
  });

  it("contentEditable false / null behaves like an ordinary element", () => {
    expect(decideGradingShortcut({ ...CTRL_ENTER, targetIsContentEditable: false }, REVIEW_READY)).toEqual({
      action: "open-approval",
    });
    expect(decideGradingShortcut({ ...CTRL_ENTER, targetIsContentEditable: null }, REVIEW_READY)).toEqual({
      action: "open-approval",
    });
  });
});

describe("M-2 · repeated approval keystrokes cannot stack requests", () => {
  it("repeated Ctrl+Enter is idempotent — it only ever opens the dialog", () => {
    // The decision is pure, so N keystrokes give N identical "open" outcomes and
    // never a write. Opening an already-open dialog issues no request; the
    // component-level in-flight guard below is what stops a second SUBMIT.
    const outs = [1, 2, 3].map(() => decideGradingShortcut(CTRL_ENTER, REVIEW_READY));
    expect(outs.every((o) => o.action === "open-approval")).toBe(true);
    expect(outs.some((o) => isGradingWrite(o))).toBe(false);
  });

  it("approveGrade holds a synchronous in-flight ref, not just React state", () => {
    // STRUCTURAL: the confirm button is `disabled={approving || …}`, but that is
    // state — it only stops a second click after the re-render lands. A ref
    // flips synchronously. Asserted on source because there is no DOM runtime.
    const src = readFileSync(path.join(process.cwd(), "client/src/components/grading/grading-panel.tsx"), "utf8");
    expect(src).toMatch(/approveInFlightRef\s*=\s*useRef\(false\)/);
    expect(src).toMatch(/if\s*\(approveInFlightRef\.current\)\s*return;/);
    expect(src).toMatch(/approveInFlightRef\.current\s*=\s*false;/);
  });
});

describe("M-2 · the approval stage is wired from stage state, never from a page", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

  it("GradingWorkstation derives approvalStageActive from its OWN stage", () => {
    const src = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
    expect(src).toMatch(/approvalStageActive=\{stage === REVIEW_STAGE\}/);
    // Both flags are omitted from the adapter's public props, so a page cannot
    // contradict the stage the operator is actually looking at.
    expect(src).toMatch(/"active"\s*\|\s*"approvalStageActive"/);
  });

  it("CertificateForm is metadata-only and cannot inject shortcut lifecycle flags", () => {
    const src = read("client/src/components/certificate-form.tsx");
    expect(src).not.toContain("<GradingPanel");
    expect(src).not.toContain("approvalStageActive");
  });

  it("pages cannot override either lifecycle flag on the canonical adapter", () => {
    const src = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
    expect(src).toMatch(/"active"\s*\|\s*"approvalStageActive"/);
    for (const page of ["client/src/pages/admin-dashboard.tsx", "client/src/pages/dev-card-details-harness.tsx"]) {
      expect(read(page)).not.toMatch(/<GradingWorkstation[\s\S]*?approvalStageActive=/);
    }
  });

  it("the handler passes the live approval flag and contentEditable through", () => {
    const src = read("client/src/components/grading/grading-panel.tsx");
    expect(src).toMatch(/approvalStageActive:\s*s\.approvalStageActive/);
    expect(src).toMatch(/targetIsContentEditable:\s*target\?\.isContentEditable/);
    // Still mirrored through the ref, so no stale closure creeps back in.
    expect(src).toMatch(/shortcutStateRef\.current = \{[\s\S]*?approvalStageActive,/);
  });
});

/** H-1 · every role uses the same canonical stage ownership. */
describe("H-1 · canonical workstation owns save on Grade and approval on Review", () => {
  it("workstation Grade + Ctrl+Enter does nothing — footer-actions is hidden there", () => {
    expect(decideGradingShortcut(CTRL_ENTER, READY)).toEqual({ action: "ignore", reason: "inactive" });
  });

  it("workstation Review + Ctrl+Enter opens approval", () => {
    expect(decideGradingShortcut(CTRL_ENTER, REVIEW_READY)).toEqual({ action: "open-approval" });
  });

  it("every role adapter derives the two flags from the same stage value", () => {
    const src = readFileSync(
      path.join(process.cwd(), "client/src/components/grading-workflow/GradingWorkstation.tsx"),
      "utf8"
    );
    expect(src).toMatch(/active=\{stage === GRADE_STAGE\}/);
    expect(src).toMatch(/approvalStageActive=\{stage === REVIEW_STAGE\}/);
    expect(src).not.toMatch(/approvalStageActive=\{stage === GRADE_STAGE\}/);
    expect(src).toContain("mode: GradingWorkstationMode");
    expect(src).not.toMatch(/mode\s*===\s*["']super-admin["'][\s\S]{0,160}approvalStageActive/);
  });

  it("the approving stage still inherits every lifecycle guard", () => {
    for (const denial of [
      { certId: null },
      { workflowLocked: true },
      { gradeApprovedAt: "2026-07-01T00:00:00Z" },
      { hydratedForCertId: null },
      { hydratedForCertId: 41 },
    ]) {
      expect(decideGradingShortcut(CTRL_ENTER, { ...REVIEW_READY, ...denial }).action).not.toBe("open-approval");
    }
  });
});

describe("H-1 · a pending confirmation can never outlive its context", () => {
  const panel = () => readFileSync(path.join(process.cwd(), "client/src/components/grading/grading-panel.tsx"), "utf8");

  it("leaving the approving stage clears showConfirm", () => {
    // STRUCTURAL (no DOM runtime): the effect that drops a pending dialog the
    // moment this panel stops being the approving surface.
    expect(panel()).toMatch(/if \(!approvalStageActive\) setShowConfirm\(false\);/);
    expect(panel()).toMatch(/\}, \[approvalStageActive\]\);/);
  });

  it("a certificate switch clears showConfirm", () => {
    expect(panel()).toMatch(/setShowConfirm\(false\);\s*\n\s*\}, \[certId\]\);/);
  });

  it("an IGNORED shortcut never mutates confirmation state", () => {
    // Behavioural: on every inert state the outcome is "ignore", and the handler
    // returns before it can reach setShowConfirm.
    for (const s of [
      { ...READY, active: false, approvalStageActive: false },
      { ...READY, approvalStageActive: false },
      { ...REVIEW_READY, approvalStageActive: false },
    ]) {
      const out = decideGradingShortcut(CTRL_ENTER, s as GradingShortcutState);
      expect(out.action).toBe("ignore");
      expect(out.action).not.toBe("open-approval");
    }
  });

  it("repeated Ctrl+Enter cannot double-submit", () => {
    const outs = [1, 2, 3].map(() => decideGradingShortcut(CTRL_ENTER, REVIEW_READY));
    expect(outs.every((o) => o.action === "open-approval")).toBe(true);
    expect(outs.some((o) => isGradingWrite(o))).toBe(false);
    // …and the synchronous in-flight guard on the submit itself is still there.
    expect(panel()).toMatch(/if \(approveInFlightRef\.current\) return;/);
    expect(panel()).toMatch(/approveInFlightRef\.current = false;/);
  });

  it("the mouse approval path is untouched", () => {
    // The Approve button still calls setShowConfirm(true) directly, and
    // approveGrade is still reachable from the dialog.
    expect(panel()).toMatch(/setShowConfirm\(true\)/);
    expect(panel()).toMatch(/async function approveGrade\(\)/);
  });
});
