/**
 * Grade-stage layout regression (2026-07-20).
 *
 * BUG (found by the owner in authenticated staging testing): entering the GRADE
 * step (stage 2 of Card/Rarity/Grade/Review) rendered the lower Grade form as a
 * large panel covering roughly half the grading workspace on a Mac desktop
 * viewport, obscuring the card image, MVGS controls, overall grade panel and the
 * centering/corners/edges/surface sub-grades.
 *
 * ROOT CAUSE — not an overlay. There is no fixed/absolute/sticky positioning and
 * no Dialog/Sheet anywhere in the Grade stage. `dfc5b946` ("Grade containment")
 * added `max-h-[calc(100dvh-12rem)] overflow-y-auto` to the workstationSlot
 * wrapper on the stated premise that the stage "had no outer height containment
 * and could stretch the whole page". That premise was false — containment already
 * existed and predated the commit:
 *   - shell root  : `md:h-[calc(100dvh-4.5rem)]`   (grading-workspace)
 *   - the <form>  : `min-h-0 flex-1 ... overflow-y-auto`  (6c428ca8, two days earlier)
 * The added cap was ~120px SHORTER than the space actually available, so it became
 * a second, competing scrollport that clipped the protected GradingPanel
 * mid-content. Everything past the cut (sub-grades, sticky Approve & Publish) was
 * hidden, and the in-flow Grade form that follows sat flush against that artificial
 * boundary — which reads as a panel overlaying the workspace. Stage 2 is also the
 * only stage that omits the preview aside (deliberate — GradingPanel renders its
 * own card image), so its card image is widest and tallest, making the clip worst.
 *
 * FIX: delete the two classes. The wrapper <div> is KEPT because it carries the
 * load-bearing Enter-key guard. One scrollport (the form) → normal document flow.
 *
 * Source-assertion style (matches every sibling grading test — these surfaces are
 * auth-gated and the repo has no jsdom/RTL). Zero provider calls, zero DB.
 * No change under client/src/components/grading/; no MVGS/scoring/label/schema change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");

/**
 * Strip comments before asserting. The fix's own explanatory comment necessarily
 * NAMES the removed class (`max-h-[calc(100dvh-12rem)]`) to document what went
 * wrong, so a raw substring check would false-fail on the very prose that
 * explains it. Same pattern as tests/grading-retire-duplicate-tab.test.ts.
 */
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FORM_CODE = stripComments(FORM);

/** The stage-2 subtree: from the Grade stage wrapper to the Review stage. */
const GRADE_STAGE = (() => {
  const start = FORM.indexOf('<div data-workflow-stage="grade"');
  expect(start, "grade stage wrapper must exist").toBeGreaterThan(-1);
  const end = FORM.indexOf('data-workflow-stage="review"', start);
  return FORM.slice(start, end > start ? end : start + 20000);
})();

/**
 * The workstationSlot wrapper element ONLY — bounded by the element itself, not
 * by a magic character count. A fixed-width window (the old style) overshoots the
 * wrapper's closing tag into the Grade form's own JSX, so an unrelated scrolling
 * dropdown added to the Grade form would false-fail a "wrapper" assertion.
 * Bounded here from the `&&` guard to the `{workstationSlot}` render site.
 */
const SLOT_WRAPPER = (() => {
  const i = FORM.indexOf("{workstationSlot && (");
  expect(i, "workstationSlot wrapper must exist").toBeGreaterThan(-1);
  const render = FORM.indexOf("{workstationSlot}", i);
  expect(render, "workstationSlot must be rendered").toBeGreaterThan(i);
  const block = FORM.slice(i, render);
  return stripComments(block.slice(block.indexOf("<div")));
})();

describe("A1. the Grade section is not fixed, absolutely positioned, or overlaid", () => {
  it("the workstationSlot wrapper has no positioning and no competing scrollport", () => {
    // Deliberately BROAD. Guarding only the literal class that caused the 2026-07-20
    // defect would let the identical bug back in under any of: max-h-[70vh],
    // h-[calc(100dvh-12rem)], overflow-auto (no -y-), overflow-y-scroll, a braced
    // className={...}, or an inline style={{maxHeight/overflowY}}. The wrapper's
    // ONLY job is the Enter-key guard, so it may carry no sizing or scrolling of
    // any kind — which is a rule we can enforce absolutely, unlike a blocklist.
    expect(SLOT_WRAPPER).not.toMatch(/\bmax-h-/);
    expect(SLOT_WRAPPER).not.toMatch(/\bh-\[/);
    expect(SLOT_WRAPPER).not.toMatch(/\bh-screen\b|\bmax-h-screen\b/);
    expect(SLOT_WRAPPER).not.toMatch(/\boverflow(-[xy])?-(auto|scroll|hidden)\b/);
    expect(SLOT_WRAPPER).not.toMatch(/maxHeight|overflowY|overflowX|\boverflow\s*:/);
    expect(SLOT_WRAPPER).not.toMatch(/\b(fixed|absolute|sticky)\b/);
    // The wrapper should carry no className at all — it is a behaviour-only div.
    expect(SLOT_WRAPPER).not.toMatch(/className/);
  });

  it("the Grade form is an ordinary in-flow sibling, not a floating panel", () => {
    // No overlay mechanism anywhere in the stage-2 subtree. `relative` is allowed
    // (the image dropzone uses it with no absolutely-positioned escaping child).
    expect(GRADE_STAGE).not.toMatch(/className="[^"]*\bfixed\b/);
    expect(GRADE_STAGE).not.toMatch(/className="[^"]*\bsticky\b/);
    expect(GRADE_STAGE).not.toMatch(/className="[^"]*\bz-(30|40|50)\b/);
    expect(GRADE_STAGE).not.toMatch(/\bDialog\b|\bSheet\b|\bDrawer\b/);
  });

  it("no transform/scale/zoom is introduced (protected card tool reads live getBoundingClientRect)", () => {
    expect(SLOT_WRAPPER).not.toMatch(/transform|scale\(|zoom:/);
  });
});

describe("A2. the desktop viewport does not obscure the grading workspace", () => {
  it("exactly ONE viewport-height cap governs the workspace — the outer shell root", () => {
    // The defect was two competing caps. The root keeps its fixed height; the
    // inner one must never come back as live code.
    expect(FORM_CODE).toContain("md:h-[calc(100dvh-4.5rem)]");
    expect(FORM_CODE).not.toContain("max-h-[calc(100dvh-12rem)]");
  });

  it("the stage-2 subtree contains no viewport-height clamp of its own", () => {
    // Viewport-relative clamps are the hazard class: anything sized against the
    // viewport INSIDE a shell that is already viewport-sized creates a competing
    // scrollport. Small fixed clamps are fine and legitimately used (e.g. the
    // `max-h-48` scrolling list in the Grade form), so this bans dvh/vh/screen
    // units specifically rather than all height caps.
    const code = stripComments(GRADE_STAGE);
    expect(code).not.toMatch(/max-h-\[[^\]]*\b(100dvh|100vh|dvh|vh)\b/);
    expect(code).not.toMatch(/\bh-\[[^\]]*\b(100dvh|100vh)\b/);
    expect(code).not.toMatch(/\bh-screen\b|\bmax-h-screen\b/);
    expect(code).not.toMatch(/maxHeight:\s*["'`][^"'`]*\b(dvh|vh)\b/);
  });
});

describe("A3. normal scroll flow remains available", () => {
  it("the <form> is still the single scrollport for stage content", () => {
    expect(FORM).toContain("min-h-0 flex-1 space-y-2.5 overflow-y-auto md:pr-1");
  });

  it("the Grade form renders after the workstation as a plain in-flow block", () => {
    const slotEnd = GRADE_STAGE.indexOf("{workstationSlot}");
    const gradeHeading = GRADE_STAGE.indexOf(">Grade<", slotEnd);
    expect(slotEnd, "workstationSlot renders in the Grade stage").toBeGreaterThan(-1);
    expect(gradeHeading, "the Grade form follows the workstation").toBeGreaterThan(slotEnd);
  });

  it("the Enter-key form-submit guard survives the class removal (the wrapper's only purpose)", () => {
    expect(SLOT_WRAPPER).toContain('e.key === "Enter"');
    expect(SLOT_WRAPPER).toContain("e.preventDefault()");
  });
});

describe("A4. bottom navigation does not cover form fields", () => {
  it("the intended sticky Approve & Publish bar is PRESERVED inside the protected panel", () => {
    // Legitimate, intended sticky navigation — and untouched by this change.
    // Note (verified 2026-07-20): it is currently INERT in practice. Its nearest
    // scrolling ancestor is GradingPanel's right column
    // (`space-y-5 overflow-y-auto`, grading-panel.tsx), which carries no height
    // constraint — as a stretch-aligned grid item its box always equals its
    // content, so there is no scrollable overflow for `sticky` to act against and
    // the bar renders in normal flow. That was equally true BEFORE this change:
    // the removed outer cap never propagated a definite height into that
    // block-layout descendant, so it was never the sticky ancestor either.
    // The fix is therefore NEUTRAL for this bar — it neither fixes nor breaks it.
    // Changing that would mean editing PROTECTED grading source; out of scope.
    expect(PANEL).toContain("sticky bottom-0");
  });

  it("the outer shell adds no fixed/sticky bottom bar of its own over the Grade stage", () => {
    expect(GRADE_STAGE).not.toMatch(/className="[^"]*\bfixed\b[^"]*\bbottom-0\b/);
    expect(GRADE_STAGE).not.toMatch(/className="[^"]*\bbottom-0\b[^"]*\bfixed\b/);
  });
});

describe("A5. blast radius — stages 0/1/3 and protected grading source are untouched", () => {
  it("the workstation wrapper is doubly gated to stage 2 only, so other stages cannot regress", () => {
    expect(FORM_CODE).toContain('<div data-workflow-stage="grade" className={stageClass(2)}>');
    // workstationSlot is RENDERED only inside the stage-2 block. Its prop-type
    // declaration and destructure legitimately live at the top of the file, so
    // count JSX usages (`{workstationSlot`) rather than every mention.
    const jsxUses = (FORM_CODE.match(/\{workstationSlot[\s&}]/g) ?? []).length;
    const inStage = (stripComments(GRADE_STAGE).match(/\{workstationSlot[\s&}]/g) ?? []).length;
    expect(inStage).toBe(2); // the `&&` guard and the render
    expect(jsxUses).toBe(inStage); // ...and nowhere else in the file
  });

  it("the deliberate preview-aside gate (stages 0/1/3, Grade excluded) is unchanged", () => {
    expect(FORM).toMatch(/\{\(wfStage <= 1 \|\| wfStage === 3\) && \(/);
  });

  it("the protected GradingPanel's own internal geometry is untouched", () => {
    expect(PANEL).toContain("lg:grid-cols-[60%_40%]");
  });
});
