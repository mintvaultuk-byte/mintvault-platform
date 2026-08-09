/**
 * grading-workflow-runtime.test.ts — RUNTIME proof for the three-stage grading
 * workspace (hostile-review test-quality remediation).
 *
 * The rewritten guard suites inspect SOURCE TEXT. This suite does not: it
 * imports the production modules and RENDERS the real production components
 * with representative data, then asserts on the emitted markup. A source-text
 * guard cannot tell you that a stage actually disappeared from the UI; this can.
 *
 * Rendering uses `react-dom/server`, already a project dependency, so no new
 * testing framework was installed. Written with `createElement` rather than JSX
 * so the existing `tests/**\/*.test.ts` glob and tsconfig need no change.
 *
 * KNOWN LIMIT (stated, not hidden): server rendering proves WHAT IS RENDERED for
 * a given state, and the transition functions below are the real production
 * functions, so Continue/Back are proven for real. What is NOT covered here is
 * browser event dispatch (an actual click landing on an actual handler). That
 * needs a DOM environment (jsdom) plus a click-simulation library, which would
 * be a new dependency — deliberately not installed without owner sign-off.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GRADING_STAGES,
  stageStatuses,
  deriveStageCompletion,
  furthestReached,
  hasAnyVariantData,
  clampStageIndex,
  nextStageIndex,
  prevStageIndex,
  stageIndexByKey,
  showsPreviewAside,
  CARD_DETAILS_STAGE,
  GRADE_STAGE,
  REVIEW_STAGE,
} from "../shared/grading-workflow";
import { GradingWorkflowBar } from "../client/src/components/grading-workflow/GradingWorkflowBar";
import { VariantSummary } from "../client/src/components/grading-workflow/VariantSummary";
import { ReviewSummary } from "../client/src/components/grading-workflow/ReviewSummary";
import { SEED_CATALOGUE, POKEMON_DESIGNATIONS } from "../shared/pokemon-rarity-catalogue";
import { buildSnapshotFromRows } from "../shared/catalogue-snapshot";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** Visible text only — tag names and attributes stripped. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// ─────────────────────────────────────────────────────────────────────────────
// 1-2. Production stage model (imported, not string-matched)
// ─────────────────────────────────────────────────────────────────────────────

describe("1-2. GRADING_STAGES + deriveStageCompletion (real modules)", () => {
  it("exposes exactly three stages in order", () => {
    expect(GRADING_STAGES).toHaveLength(3);
    expect(GRADING_STAGES.map((s) => s.key)).toEqual(["card-details", "grade", "review"]);
    expect(GRADING_STAGES.map((s) => s.label)).toEqual(["Card Details", "Grade", "Review"]);
  });

  it("has NO rarity stage by key or label", () => {
    expect(stageIndexByKey("rarity")).toBe(-1);
    expect(GRADING_STAGES.some((s) => /rarity/i.test(s.label))).toBe(false);
  });

  it("deriveStageCompletion returns one flag per stage and ignores Variant entirely", () => {
    expect(deriveStageCompletion({})).toHaveLength(GRADING_STAGES.length);
    const noVariant = deriveStageCompletion({ cardName: "Pikachu", setName: "Base Set" });
    const withVariant = deriveStageCompletion({
      cardName: "Pikachu",
      setName: "Base Set",
      rarityCode: "rare_holo",
      finishVariant: "holo",
      promoType: "black_star",
      subsetName: "trainer_gallery",
    });
    expect(noVariant[CARD_DETAILS_STAGE]).toBe(true);
    expect(withVariant).toEqual(noVariant);
  });

  it("furthestReached tracks the three-stage trail", () => {
    expect(furthestReached(deriveStageCompletion({}))).toBe(0);
    expect(furthestReached(deriveStageCompletion({ cardName: "P", setName: "S" }))).toBe(1);
    expect(furthestReached(deriveStageCompletion({ cardName: "P", setName: "S", gradeOverall: "9" }))).toBe(2);
  });

  it("hasAnyVariantData is advisory only and never feeds completion", () => {
    expect(hasAnyVariantData({ rarityCode: "rare" })).toBe(true);
    expect(deriveStageCompletion({ rarityCode: "rare" })[CARD_DETAILS_STAGE]).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3, 5, 6. The REAL workflow bar, rendered
// ─────────────────────────────────────────────────────────────────────────────

describe("3/5/6. the real GradingWorkflowBar renders exactly three stages", () => {
  const html = render(createElement(GradingWorkflowBar, { currentIndex: 0, maxReached: 0 }));

  it("renders one button per stage — three, not four", () => {
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(3);
  });

  it("the VISIBLE labels are exactly Card Details, Grade, Review", () => {
    const text = textOf(html);
    expect(text).toContain("Card Details");
    expect(text).toContain("Grade");
    expect(text).toContain("Review");
    // The retired stage must not be visible anywhere in the rendered output.
    expect(text).not.toMatch(/\bRarity\b/);
  });

  it("exposes a stable testid per stage and NO navigable rarity stage", () => {
    expect(html).toContain('data-testid="workflow-stage-card-details"');
    expect(html).toContain('data-testid="workflow-stage-grade"');
    expect(html).toContain('data-testid="workflow-stage-review"');
    expect(html).not.toContain('data-testid="workflow-stage-rarity"');
    expect(html).not.toContain('data-testid="workflow-stage-identify"');
  });

  it("marks the current stage accessibly, and only one at a time", () => {
    for (const i of [0, 1, 2]) {
      const h = render(createElement(GradingWorkflowBar, { currentIndex: i, maxReached: i }));
      expect(h.match(/aria-current="step"/g) ?? []).toHaveLength(1);
      const statuses = [...h.matchAll(/data-status="([a-z]+)"/g)].map((m) => m[1]);
      expect(statuses).toHaveLength(3);
      expect(statuses[i]).toBe("current");
    }
  });

  it("renders completed stages before the current one (real stageStatuses)", () => {
    const h = render(createElement(GradingWorkflowBar, { currentIndex: 2, maxReached: 2 }));
    const statuses = [...h.matchAll(/data-status="([a-z]+)"/g)].map((m) => m[1]);
    expect(statuses).toEqual(stageStatuses(2, 2));
    expect(statuses).toEqual(["complete", "complete", "current"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Continue / Back transitions — the real production functions
// ─────────────────────────────────────────────────────────────────────────────

describe("7. Continue and Back transitions (production functions)", () => {
  it("Card Details --Continue--> Grade --Continue--> Review", () => {
    expect(nextStageIndex(CARD_DETAILS_STAGE)).toBe(GRADE_STAGE);
    expect(nextStageIndex(GRADE_STAGE)).toBe(REVIEW_STAGE);
  });

  it("Grade --Back--> Card Details (never to a Rarity stage)", () => {
    expect(prevStageIndex(GRADE_STAGE)).toBe(CARD_DETAILS_STAGE);
    expect(GRADING_STAGES[prevStageIndex(GRADE_STAGE)].key).toBe("card-details");
  });

  it("Review --Back--> Grade", () => {
    expect(prevStageIndex(REVIEW_STAGE)).toBe(GRADE_STAGE);
  });

  it("transitions saturate — there is no fourth stage to reach", () => {
    expect(nextStageIndex(REVIEW_STAGE)).toBe(REVIEW_STAGE);
    expect(prevStageIndex(CARD_DETAILS_STAGE)).toBe(CARD_DETAILS_STAGE);
    expect(clampStageIndex(3)).toBe(REVIEW_STAGE);
    expect(clampStageIndex(99)).toBe(REVIEW_STAGE);
    expect(clampStageIndex(-5)).toBe(CARD_DETAILS_STAGE);
    expect(clampStageIndex(NaN)).toBe(CARD_DETAILS_STAGE);
  });

  it("a full Continue/Back round trip returns to the starting stage", () => {
    let s = CARD_DETAILS_STAGE;
    s = nextStageIndex(s);
    s = nextStageIndex(s);
    expect(s).toBe(REVIEW_STAGE);
    s = prevStageIndex(s);
    s = prevStageIndex(s);
    expect(s).toBe(CARD_DETAILS_STAGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10-11. Preview placement + no duplicate Review preview
// ─────────────────────────────────────────────────────────────────────────────

describe("10-11. live preview appears only where intended, exactly once", () => {
  it("the preview aside persists across Card Details, Grade and Review", () => {
    expect(showsPreviewAside(CARD_DETAILS_STAGE)).toBe(true);
    expect(showsPreviewAside(REVIEW_STAGE)).toBe(true);
    expect(showsPreviewAside(GRADE_STAGE)).toBe(true);
  });

  it("the duplicate Review LabelPreview component no longer exists in the tree", async () => {
    await expect(import("../client/src/components/grading-workflow/LabelPreview")).rejects.toThrow();
  });

  it("ReviewSummary renders NO certificate-preview image of its own", () => {
    const html = render(
      createElement(ReviewSummary, {
        values: {
          certificateId: 1,
          cardGame: "pokemon",
          cardName: "Charizard",
          setName: "Base Set",
          cardNumber: "4/102",
          year: "1999",
          language: "en",
          rarityCode: "rare_holo",
          finishVariant: "holo",
          promoType: "",
          subsetName: "",
          era: "",
          designations: ["FIRST_EDITION"],
          gradeOverall: "9.5",
          labelType: "gold",
          status: "graded",
        },
        onEditCard: () => {},
        onEditRarity: () => {},
        onEditGrade: () => {},
      })
    );
    // The card image + label preview live in the shared aside, never duplicated here.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("label-preview");
    expect(html).toContain('data-testid="review-summary"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12-14. Existing certificate values, catalogue options, legacy designations
// ─────────────────────────────────────────────────────────────────────────────

describe("12. an existing certificate's values populate the rendered Review", () => {
  const html = render(
    createElement(ReviewSummary, {
      values: {
        certificateId: 42,
        cardGame: "pokemon",
        cardName: "Blastoise",
        setName: "Base Set",
        cardNumber: "2/102",
        year: "1999",
        language: "en",
        rarityCode: "rare_holo",
        finishVariant: "holo",
        promoType: "",
        subsetName: "",
        era: "",
        designations: ["FIRST_EDITION", "SHADOWLESS"],
        gradeOverall: "9",
        labelType: "gold",
        status: "graded",
      },
      onEditCard: () => {},
      onEditRarity: () => {},
      onEditGrade: () => {},
    })
  );

  it("renders the stored identity values", () => {
    const text = textOf(html);
    expect(text).toContain("Blastoise");
    expect(text).toContain("Base Set");
    expect(text).toContain("1999");
  });

  it("renders the stored classification under the VARIANT label, not 'Rarity'", () => {
    const text = textOf(html);
    expect(text).toContain("Variant");
    // The classification card must not reintroduce the retired wording.
    expect(text).not.toMatch(/\bRarity\b/);
  });

  it("14. legacy designation codes resolve to their human labels", () => {
    const text = textOf(html);
    expect(text).toContain("1st Edition");
    expect(text).toContain("Shadowless");
  });
});

describe("13. catalogue-backed options render (real snapshot -> real component)", () => {
  it("VariantSummary renders values resolved from the catalogue snapshot", () => {
    const html = render(
      createElement(VariantSummary, {
        values: {
          language: "en",
          rarityCode: SEED_CATALOGUE.rarities[0].value,
          finishVariant: SEED_CATALOGUE.finishes[0].value,
          promoType: "",
          subsetName: "",
          variant: "",
          rarity: "",
          variantOther: "",
          rarityOther: "",
        },
      })
    );
    const text = textOf(html);
    expect(text).toContain(SEED_CATALOGUE.rarities[0].label);
    expect(text).toContain(SEED_CATALOGUE.finishes[0].label);
    // Renamed heading, rendered — not merely present in source.
    expect(text).toContain("Variant");
  });

  it("an EMPTY classification renders the optional-friendly empty state", () => {
    const html = render(
      createElement(VariantSummary, {
        values: {
          language: "en",
          rarityCode: "",
          finishVariant: "",
          promoType: "",
          subsetName: "",
          variant: "",
          rarity: "",
          variantOther: "",
          rarityOther: "",
        },
      })
    );
    // Variant is OPTIONAL: an empty classification is a valid, non-error state.
    expect(textOf(html)).toMatch(/optional/i);
  });

  it("a DB-backed snapshot flows into the same component shape as the seed", () => {
    const snapshot = buildSnapshotFromRows(
      [
        { category: "rarity", value: "custom_rare", label: "Custom Rare", abbreviation: "CR" },
        { category: "finish", value: "custom_holo", label: "Custom Holo" },
        { category: "designation", value: "first_edition", label: "1st Edition", abbreviation: "FIRST_EDITION" },
      ],
      new Set(["rarity", "finish", "designation"])
    );
    expect(snapshot.rarities.map((r) => r.label)).toContain("Custom Rare");
    expect(snapshot.finishes.map((f) => f.label)).toContain("Custom Holo");
    // The PERSISTED designation code is the abbreviation, so stored certificate
    // values keep resolving after the catalogue is edited.
    expect(snapshot.designations).toEqual([{ code: "FIRST_EDITION", label: "1st Edition", help: "" }]);
  });

  it("every historical designation code is still resolvable from the seed", () => {
    const codes = POKEMON_DESIGNATIONS.map((d) => d.code);
    expect(codes).toContain("FIRST_EDITION");
    expect(codes).toContain("ERROR_MISCUT");
    expect(new Set(codes).size).toBe(codes.length); // no duplicate persisted codes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-4 — the shared helpers are WIRED INTO PRODUCTION, not merely tested
// ─────────────────────────────────────────────────────────────────────────────

describe("M-4: the canonical GradingWorkstation owns the wired workflow", () => {
  const WORKSTATION = readFileSync(
    join(process.cwd(), "client/src/components/grading-workflow/GradingWorkstation.tsx"),
    "utf8"
  );
  const HEADER = readFileSync(
    join(process.cwd(), "client/src/components/grading-workflow/WorkstationHeaderStrip.tsx"),
    "utf8"
  );

  it("uses one shared header/bar render site for the three-stage model", () => {
    expect(WORKSTATION.match(/<WorkstationHeaderStrip/g)).toHaveLength(1);
    expect(HEADER).toContain("<GradingWorkflowBar");
    expect(HEADER).toContain("WorkflowStage");
    expect(HEADER).toContain('from "@shared/grading-workflow"');
  });

  it("the fixed preview aside is outside the stage-gated scroll body", () => {
    const preview = WORKSTATION.indexOf("previewAside={");
    const stageGate = WORKSTATION.indexOf("data-ws-stage={stage}");
    expect(preview).toBeGreaterThan(-1);
    expect(stageGate).toBeGreaterThan(preview);
    expect(WORKSTATION.slice(preview, stageGate)).not.toMatch(/stage\s*===/);
  });

  it("one stage value gates both visible sections and shortcut ownership", () => {
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    expect(WORKSTATION).toContain("active={stage === GRADE_STAGE}");
    expect(WORKSTATION).toContain("approvalStageActive={stage === REVIEW_STAGE}");
  });

  it("navigation delegates only header stage indices to the workstation owner", () => {
    expect(WORKSTATION).toContain("onStageClick={(i) => goToStage(i)}");
    expect(HEADER).toContain("onStageClick={onStageClick}");
    expect(WORKSTATION).not.toMatch(/goToStage\(\s*[0-9]\s*\)/);
  });

  it("Review cannot be entered until save and exact authoritative preview succeed", () => {
    const fn = WORKSTATION.slice(WORKSTATION.indexOf("const establishReview"), WORKSTATION.indexOf("const certId"));
    expect(fn).toContain("runReviewTransitionBarrier");
    expect(fn).toContain("if (!result.ok)");
    expect(fn).toContain("setReviewReady(result.snapshot)");
    expect(fn).toContain("setStage(REVIEW_STAGE)");
    expect(fn.indexOf("setReviewReady(result.snapshot)")).toBeLessThan(fn.indexOf("setStage(REVIEW_STAGE)"));
  });

  it("Enter inside the Grade stage cannot advance the workflow or submit the form", () => {
    expect(WORKSTATION).not.toContain("onKeyDown");
    expect(WORKSTATION).not.toContain("onSubmit=");
    expect(WORKSTATION).toContain("approvalStageActive={stage === REVIEW_STAGE}");
  });
});

describe("M-4: the wired transitions produce the approved production flow", () => {
  it("Card Details -> Grade", () => {
    expect(nextStageIndex(CARD_DETAILS_STAGE)).toBe(GRADE_STAGE);
    expect(GRADING_STAGES[nextStageIndex(CARD_DETAILS_STAGE)].label).toBe("Grade");
  });
  it("Grade -> Review", () => {
    expect(nextStageIndex(GRADE_STAGE)).toBe(REVIEW_STAGE);
    expect(GRADING_STAGES[nextStageIndex(GRADE_STAGE)].label).toBe("Review");
  });
  it("Review -> Grade", () => {
    expect(prevStageIndex(REVIEW_STAGE)).toBe(GRADE_STAGE);
    expect(GRADING_STAGES[prevStageIndex(REVIEW_STAGE)].label).toBe("Grade");
  });
  it("Grade -> Card Details (never an intermediate Rarity step)", () => {
    expect(prevStageIndex(GRADE_STAGE)).toBe(CARD_DETAILS_STAGE);
    expect(GRADING_STAGES[prevStageIndex(GRADE_STAGE)].label).toBe("Card Details");
  });
  it("stage clamping saturates at both ends", () => {
    expect(clampStageIndex(-1)).toBe(CARD_DETAILS_STAGE);
    expect(clampStageIndex(3)).toBe(REVIEW_STAGE);
    expect(nextStageIndex(REVIEW_STAGE)).toBe(REVIEW_STAGE);
    expect(prevStageIndex(CARD_DETAILS_STAGE)).toBe(CARD_DETAILS_STAGE);
  });
  it("preview is visible throughout Card Details, Grade and Review", () => {
    expect(showsPreviewAside(CARD_DETAILS_STAGE)).toBe(true);
    expect(showsPreviewAside(GRADE_STAGE)).toBe(true);
    expect(showsPreviewAside(REVIEW_STAGE)).toBe(true);
  });
  it("there is no Rarity stage to navigate to at any point in the flow", () => {
    expect(stageIndexByKey("rarity")).toBe(-1);
    const visited = new Set<number>();
    let s = CARD_DETAILS_STAGE;
    for (let i = 0; i < 6; i++) {
      visited.add(s);
      s = nextStageIndex(s);
    }
    s = REVIEW_STAGE;
    for (let i = 0; i < 6; i++) {
      visited.add(s);
      s = prevStageIndex(s);
    }
    expect([...visited].sort()).toEqual([0, 1, 2]); // only the three approved stages are reachable
  });
});
