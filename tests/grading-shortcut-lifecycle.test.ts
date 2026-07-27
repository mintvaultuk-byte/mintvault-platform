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
    expect(decideGradingShortcut(CTRL_ENTER, READY)).toEqual({ action: "open-approval" });
  });

  it("the approval shortcut still honours the deionization checklist", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...READY, deionizationComplete: false })).toEqual({
      action: "blocked-checklist",
      reason: "deionization",
    });
  });

  it("the approval shortcut still honours the crop gate", () => {
    expect(decideGradingShortcut(CTRL_ENTER, { ...READY, cropGateBlocked: true })).toEqual({
      action: "blocked-checklist",
      reason: "crop-gate",
    });
  });

  it("a checklist block is never a grading write", () => {
    expect(isGradingWrite(decideGradingShortcut(CTRL_ENTER, { ...READY, cropGateBlocked: true }))).toBe(false);
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
