/**
 * 4-stage grading workflow bar — pure stage logic + safe-wiring assertions.
 * The bar is navigation/progress only: it must never gate saving or grading,
 * and must not touch any protected grading/centering/cert-number/label file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  GRADING_STAGES,
  stageStatuses,
  deriveStageCompletion,
  furthestReached,
} from "../shared/grading-workflow";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("stage model (pure)", () => {
  it("has the four named stages in order (compact MacBook labels)", () => {
    expect(GRADING_STAGES.map((s) => s.key)).toEqual(["identify", "rarity", "grade", "review"]);
    expect(GRADING_STAGES.map((s) => s.label)).toEqual(["Card", "Rarity", "Grade", "Review"]);
  });

  it("current is highlighted, earlier stages complete, later pending", () => {
    expect(stageStatuses(2)).toEqual(["complete", "complete", "current", "pending"]);
    expect(stageStatuses(0)).toEqual(["current", "pending", "pending", "pending"]);
    expect(stageStatuses(3)).toEqual(["complete", "complete", "complete", "current"]);
  });

  it("stepping back keeps gold ticks via maxReached", () => {
    // Grader reached stage 3 then went back to stage 1: stages 2 & 3 keep ticks.
    expect(stageStatuses(0, 2)).toEqual(["current", "complete", "complete", "pending"]);
  });

  it("out-of-range indices are clamped", () => {
    expect(stageStatuses(99)).toEqual(["complete", "complete", "complete", "current"]);
    expect(stageStatuses(-5)).toEqual(["current", "pending", "pending", "pending"]);
  });

  it("deriveStageCompletion reflects real form data", () => {
    expect(deriveStageCompletion({})).toEqual([false, false, false, false]);
    expect(deriveStageCompletion({ cardName: "Pikachu", setName: "Base Set" })).toEqual([true, false, false, false]);
    expect(deriveStageCompletion({ cardName: "P", setName: "S", rarityCode: "rare" })).toEqual([true, true, false, false]);
    expect(deriveStageCompletion({ cardName: "P", setName: "S", finishVariant: "holo" })[1]).toBe(true);
    expect(deriveStageCompletion({ cardName: "P", setName: "S", gradeOverall: "9.5" })[2]).toBe(true);
    // Review is never auto-complete (the form owns save).
    expect(deriveStageCompletion({ cardName: "P", setName: "S", gradeOverall: "9.5" })[3]).toBe(false);
  });

  it("furthestReached is the first incomplete stage", () => {
    expect(furthestReached([false, false, false, false])).toBe(0);
    expect(furthestReached([true, false, false, false])).toBe(1);
    expect(furthestReached([true, true, true, false])).toBe(3);
  });
});

describe("bar component + form wiring (source assertions)", () => {
  const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");
  const FORM = read("client/src/components/certificate-form.tsx");

  it("bar uses the pure stage-status model + a gold tick for complete", () => {
    expect(BAR).toContain("stageStatuses");
    expect(BAR).toContain("<Check"); // gold tick on completed stages
    expect(BAR).toContain('data-testid="grading-workflow-bar"');
    expect(BAR).toContain('aria-current={isCurrent ? "step" : undefined}'); // accessible current step
  });

  it("the form renders the persistent bar + the four scroll anchors", () => {
    // unified-shell pass: GradingWorkflowBar is rendered via the shared
    // WorkstationHeaderStrip component (ONE render site for all four stages).
    expect(FORM).toContain("<WorkstationHeaderStrip");
    const stripSrc = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
    expect(stripSrc).toContain("<GradingWorkflowBar");
    for (const key of ["identify", "rarity", "grade", "review"]) {
      expect(FORM).toContain(`data-workflow-stage="${key}"`);
    }
  });

  it("the bar is advisory only — it never mutates/saves/sets form state", () => {
    // onStageClick only scrolls; the bar has no save/grade/mutation behaviour.
    expect(FORM).toContain("scrollIntoView");
    expect(BAR).not.toMatch(/\bmutate\b|handleSubmit|setForm|onSubmit=/);
    expect(FORM).toContain("advisory only — never gates saving/grading");
  });

  it("the new code imports NO protected grading/centering/cert-number/label module", () => {
    for (const src of [BAR, read("shared/grading-workflow.ts")]) {
      const imports = (src.match(/from\s+"[^"]+"/g) ?? []).join("\n");
      expect(imports).not.toMatch(/components\/grading\/|mvgs|scoring|centering|pristine|grader|labels|certificate-document|cert-id/i);
    }
  });
});
