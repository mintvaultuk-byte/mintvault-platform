/**
 * Stage-gated grading workflow (Card → Rarity → Grade → Review) — source
 * assertions proving stage isolation, no-save navigation, notes relocation,
 * legacy-control collapse, compact chips, and that NO protected grading file
 * changed. Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const PREVIEW = read("client/src/components/grading-workflow/CardPreviewPanel.tsx");

/** The slice of FORM between two unique anchors. */
function between(start: string, end: string): string {
  const i = FORM.indexOf(start);
  const j = FORM.indexOf(end, i);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return FORM.slice(i, j);
}

const STAGE_CARD = between("STAGE 1 · CARD", "STAGE 2 · RARITY");
const STAGE_RARITY = between("STAGE 2 · RARITY", "stage 1 (card) continued");
const STAGE_REVIEW = FORM.slice(FORM.indexOf("Stage 4 · REVIEW"));
/** Code with comments stripped (comments deliberately describe what is NOT done). */
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("stage separation (spec 1-4)", () => {
  it("Card stage holds identification only — no rarity picker, designations or notes", () => {
    expect(STAGE_CARD).toContain("Search TCG");
    expect(STAGE_CARD).not.toContain("RarityVariantPicker");
    expect(STAGE_CARD).not.toContain("designations-chips");
    expect(STAGE_CARD).not.toContain("Grader Notes");
  });
  it("Rarity stage holds the structured picker + collapsed legacy/designations", () => {
    expect(STAGE_RARITY).toContain("RarityVariantPicker");
    expect(STAGE_RARITY).toContain('data-testid="legacy-variant-details"');
    expect(STAGE_RARITY).toContain('data-testid="designations-details"');
    expect(STAGE_RARITY).not.toContain("Grader Notes");
  });
  it("Grade stage renders the workstationSlot inside a plain visibility wrapper (no transform/scale)", () => {
    // Assert on the wrapper region only (up to the stage-3 nav), with comments
    // stripped — they deliberately describe what is NOT done.
    const wrapper = stripComments(between('<div data-workflow-stage="grade"', "Stage 3 nav"));
    expect(wrapper).toContain("{workstationSlot}");
    expect(wrapper).not.toMatch(/transform|scale\(|zoom:/);
  });
  it("Review stage holds the moved grader notes (collapsed) + the save action", () => {
    expect(STAGE_REVIEW).toContain("Grader Notes");
    expect(STAGE_REVIEW).toContain('data-testid="button-add-grader-notes"');
    expect(STAGE_REVIEW).toContain("button-save-cert");
  });
});

describe("stage navigation is UI-state only (spec: no save/grade/issue)", () => {
  it("stages hide with CSS, never unmount — values survive Back/Next by construction", () => {
    expect(FORM).toContain("Hidden-not-unmounted");
    expect(FORM).toMatch(/stageClass = \(i: number\) => \(wfStage === i \? "" : "hidden"\)/);
  });
  it("goToStage only sets local state + scrolls — no save, submit, grade or mutation", () => {
    const fn = FORM.slice(FORM.indexOf("const goToStage"), FORM.indexOf("const stageClass"));
    expect(fn).toContain("setWfStage");
    expect(fn).not.toMatch(/mutate|handleSubmit|autoSaveNow|fetch\(|setForm/);
  });
  it("all nav buttons are type=button (cannot submit the form)", () => {
    for (const id of ["button-continue-to-rarity", "button-continue-to-grade", "button-back-to-card", "button-back-to-rarity", "button-review-card", "button-back-to-grade"]) {
      const i = FORM.indexOf(id);
      expect(i, id).toBeGreaterThan(-1);
      expect(FORM.slice(i - 600, i)).toContain('type="button"');
    }
  });
  it("Continue to Rarity gates only on genuinely mandatory fields with a plain reason", () => {
    expect(FORM).toContain("Enter the card name and number first.");
    expect(FORM).toMatch(/disabled=\{!form\.cardName\.trim\(\) \|\| !form\.cardNumber\.trim\(\)\}/);
  });
});

describe("card preview is read-only (spec 3)", () => {
  it("plain <img> from signed display URLs / uploaded files — no coordinates, no protected imports", () => {
    expect(PREVIEW).toContain("front_display");
    expect(PREVIEW).toContain("URL.createObjectURL");
    // Check CODE only (comments deliberately mention what is NOT done).
    const code = stripComments(PREVIEW);
    expect(code).not.toMatch(/getBoundingClientRect|onMouseDown|centering|crop/i);
    const imports = (code.match(/from\s+"[^"]+"/g) ?? []).join("\n");
    expect(imports).not.toMatch(/components\/grading\//);
  });
  it("form places the sticky preview beside stage controls (MacBook split)", () => {
    expect(FORM).toContain("lg:grid-cols-[minmax(240px,38%)_minmax(0,1fr)]");
    expect(FORM).toContain("lg:sticky");
    expect(FORM).toContain("<CardPreviewPanel");
  });
});

describe("compact chips v2 + region-aware defaults (spec 5-6)", () => {
  it("chips shrank again (~38px high, 84-132px wide)", () => {
    expect(PICKER).toContain("h-[38px] min-w-[84px] max-w-[132px]");
  });
  it("modern-English quick list has no Japanese-only codes; eastern list has them", () => {
    const west = PICKER.slice(PICKER.indexOf("QUICK_RARITIES_WESTERN"), PICKER.indexOf("QUICK_RARITIES_EASTERN"));
    expect(west).not.toContain("jp_");
    expect(west).toContain("ace_spec");
    const east = PICKER.slice(PICKER.indexOf("QUICK_RARITIES_EASTERN"), PICKER.indexOf("function usePersistentList"));
    expect(east).toContain("jp_special_art_rare");
  });
  it("one-line preview + View details + label-unchanged disclaimer (spec 11)", () => {
    expect(PICKER).toContain('data-testid="rarity-preview-line"');
    expect(PICKER).toContain("View details");
    expect(PICKER).toContain("Preview only — printed label unchanged");
  });
});

describe("protected surfaces untouched (spec 12-14, 21-24)", () => {
  it("git diff vs main touches NO protected grading/centering/label/schema/server file", () => {
    const changed = execSync("git diff --name-only main...HEAD", { encoding: "utf8" }).trim().split("\n");
    for (const f of changed) {
      expect(f).not.toMatch(/components\/grading\/|mvgs|scoring|centering|pristine|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/|^migrations\//);
    }
  });
  it("AI Card Identification stays absent; TCGdex stays present (spec 19-20)", () => {
    expect(FORM).not.toContain("CardIdentifyPanel");
    expect(FORM).toContain("Search TCG");
  });
});
