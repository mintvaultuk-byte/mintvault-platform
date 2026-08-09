/**
 * 3-stage grading workflow bar — pure stage logic + safe-wiring assertions.
 * The bar is navigation/progress only: it must never gate saving or grading,
 * and must not touch any protected grading/centering/cert-number/label file.
 *
 * Consolidated 2026-07-26: the former separate "Rarity" stage was folded into
 * "Card Details", so the flow is Card Details → Grade → Review. Variant is
 * OPTIONAL and deliberately excluded from the Card Details completion test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  GRADING_STAGES,
  stageStatuses,
  deriveStageCompletion,
  furthestReached,
  hasAnyVariantData,
} from "../shared/grading-workflow";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("stage model (pure)", () => {
  it("has the three named stages in order (compact MacBook labels)", () => {
    expect(GRADING_STAGES.map((s) => s.key)).toEqual(["card-details", "grade", "review"]);
    expect(GRADING_STAGES.map((s) => s.label)).toEqual(["Card Details", "Grade", "Review"]);
  });

  it("there is no longer a standalone Rarity stage", () => {
    expect(GRADING_STAGES.map((s) => s.key)).not.toContain("rarity");
    expect(GRADING_STAGES.map((s) => s.label)).not.toContain("Rarity");
  });

  it("current is highlighted, earlier stages complete, later pending", () => {
    expect(stageStatuses(1)).toEqual(["complete", "current", "pending"]);
    expect(stageStatuses(0)).toEqual(["current", "pending", "pending"]);
    expect(stageStatuses(2)).toEqual(["complete", "complete", "current"]);
  });

  it("stepping back keeps gold ticks via maxReached", () => {
    // Grader reached Review then went back to Card Details: Grade keeps its tick.
    expect(stageStatuses(0, 1)).toEqual(["current", "complete", "pending"]);
  });

  it("out-of-range indices are clamped", () => {
    expect(stageStatuses(99)).toEqual(["complete", "complete", "current"]);
    expect(stageStatuses(-5)).toEqual(["current", "pending", "pending"]);
  });

  it("deriveStageCompletion reflects real form data", () => {
    expect(deriveStageCompletion({})).toEqual([false, false, false]);
    expect(deriveStageCompletion({ cardName: "Pikachu", setName: "Base Set" })).toEqual([true, false, false]);
    expect(deriveStageCompletion({ cardName: "P", setName: "S", gradeOverall: "9.5" })[1]).toBe(true);
    // Review is never auto-complete (the form owns save).
    expect(deriveStageCompletion({ cardName: "P", setName: "S", gradeOverall: "9.5" })[2]).toBe(false);
  });

  it("Variant is OPTIONAL — it never affects Card Details completion", () => {
    const withoutVariant = deriveStageCompletion({ cardName: "P", setName: "S" });
    const withVariant = deriveStageCompletion({ cardName: "P", setName: "S", rarityCode: "rare" });
    expect(withoutVariant[0]).toBe(true);
    expect(withVariant).toEqual(withoutVariant);
    // A card with a variant but no name/set is still incomplete.
    expect(deriveStageCompletion({ rarityCode: "rare", finishVariant: "holo" })[0]).toBe(false);
  });

  it("hasAnyVariantData is advisory display only, and covers every classification field", () => {
    expect(hasAnyVariantData({})).toBe(false);
    expect(hasAnyVariantData({ rarityCode: "rare" })).toBe(true);
    expect(hasAnyVariantData({ variant: "1st Edition" })).toBe(true);
    expect(hasAnyVariantData({ finishVariant: "holo" })).toBe(true);
    expect(hasAnyVariantData({ promoType: "staff" })).toBe(true);
    expect(hasAnyVariantData({ subsetName: "Trainer Gallery" })).toBe(true);
  });

  it("furthestReached is the first incomplete stage", () => {
    expect(furthestReached([false, false, false])).toBe(0);
    expect(furthestReached([true, false, false])).toBe(1);
    expect(furthestReached([true, true, false])).toBe(2);
  });
});

describe("bar component + form wiring (source assertions)", () => {
  const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");
  const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");

  it("bar uses the pure stage-status model + a gold tick for complete", () => {
    expect(BAR).toContain("stageStatuses");
    expect(BAR).toContain("<Check"); // gold tick on completed stages
    expect(BAR).toContain('data-testid="grading-workflow-bar"');
    expect(BAR).toContain('aria-current={isCurrent ? "step" : undefined}'); // accessible current step
  });

  it("the canonical workstation renders one persistent bar and one stage gate", () => {
    expect(WORKSTATION).toContain("<WorkstationHeaderStrip");
    const stripSrc = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
    expect(stripSrc).toContain("<GradingWorkflowBar");
    expect(WORKSTATION.match(/<WorkstationHeaderStrip/g)).toHaveLength(1);
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    expect(WORKSTATION).toContain("grading-stage-gate");
    expect(WORKSTATION).not.toContain('data-workflow-stage="rarity"');
    expect(WORKSTATION).not.toContain('data-workflow-stage="identify"');
  });

  it("the bar is presentation-only; Review navigation is protected by the authoritative barrier", () => {
    expect(BAR).not.toMatch(/\bmutate\b|handleSubmit|setForm|onSubmit=/);
    expect(WORKSTATION).toContain("index === REVIEW_STAGE");
    expect(WORKSTATION).toContain("void establishReview()");
    expect(WORKSTATION).toContain("runReviewTransitionBarrier");
    expect(WORKSTATION).toMatch(/persist:\s*reviewTransitionHandler/);
    expect(WORKSTATION).toMatch(/preview:\s*requestAuthoritativePreview/);
  });

  it("the new code imports NO protected grading/centering/cert-number/label module", () => {
    for (const src of [BAR, read("shared/grading-workflow.ts")]) {
      const imports = (src.match(/from\s+"[^"]+"/g) ?? []).join("\n");
      expect(imports).not.toMatch(
        /components\/grading\/|mvgs|scoring|centering|pristine|grader|labels|certificate-document|cert-id/i
      );
    }
  });
});
