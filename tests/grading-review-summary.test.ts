/**
 * Stage 4 Review summary — read-only confirmation panel. Source-assertion tests
 * (the admin grading form is auth-gated). Proves the summary derives only from
 * existing form state, holds no certificate state, computes no grade, saves
 * nothing on entry, and that Edit links only switch the local stage.
 * Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SUMMARY = read("client/src/components/grading-workflow/ReviewSummary.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
/** Strip comments — they deliberately describe what is NOT done. */
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SUMMARY_CODE = stripComments(SUMMARY);

describe("Review summary shows the identification + classification data (spec 1-2)", () => {
  it("card details: name, set, number, year, language", () => {
    expect(SUMMARY).toContain('data-testid="review-card-details"');
    for (const row of ["Name", "Set", "Number", "Year", "Language"]) {
      expect(SUMMARY).toContain(`label="${row}"`);
    }
  });
  it("classification: rarity, finish, promo, subset, designations", () => {
    expect(SUMMARY).toContain('data-testid="review-classification"');
    for (const row of ["Finish", "Promo", "Subset", "Designations"]) {
      expect(SUMMARY).toContain(`label="${row}"`);
    }
    expect(SUMMARY).toContain("RaritySymbol"); // printed rarity symbol shown
  });
});

describe("grade is displayed from existing state, never recomputed (spec 3-4)", () => {
  it("renders the current overall grade from props, not a calculation", () => {
    expect(SUMMARY).toContain('data-testid="review-grade"');
    expect(SUMMARY).toContain("v.gradeOverall");
    // No grade maths in the summary (display text may name "MVGS"; that's fine).
    expect(SUMMARY_CODE).not.toMatch(/computeGrade|calculateGrade|scoreCard|deriveGrade|parseFloat|Math\./);
    const imports = (SUMMARY_CODE.match(/from\s+"[^"]+"/g) ?? []).join("\n");
    expect(imports).not.toMatch(/components\/grading\/|mvgs|scoring|centering|pristine|grader|labels|certificate-document/i);
  });
  it("does NOT surface subgrade/centering it cannot get safely (they live in the protected workstation)", () => {
    // Form state has no subgrade/centering fields; the summary must not invent them.
    expect(SUMMARY_CODE).not.toMatch(/centering|subgrade|corners|edges|surface/i);
  });
});

describe("read-only: no parallel state, no save on entry (spec 5, 10)", () => {
  it("summary holds no useState/useEffect/network — pure presentation", () => {
    expect(SUMMARY_CODE).not.toMatch(/useState|useEffect|useQuery|useMutation|fetch\(|apiRequest/);
  });
  it("entering Review does not save — no mutate/submit is triggered by the summary", () => {
    expect(SUMMARY_CODE).not.toMatch(/mutate|handleSubmit|autoSaveNow|setForm/);
  });
  it("the only persistence path remains the existing save button", () => {
    const review = FORM.slice(FORM.indexOf("Stage 4 · REVIEW"));
    expect(review).toContain("button-save-cert");
    // The summary is rendered above the notes + save, and takes no save handler.
    expect(FORM).toContain("<ReviewSummary");
    expect(FORM).not.toMatch(/<ReviewSummary[\s\S]{0,400}onSave/);
  });
});

describe("Edit links switch stage only (spec 6-8)", () => {
  it("summary exposes Edit Card/Rarity/Grade callbacks", () => {
    for (const id of ["review-edit-card", "review-edit-rarity", "review-edit-grade"]) {
      expect(SUMMARY).toContain(`testId="${id}"`);
    }
    expect(SUMMARY).toContain("onEditCard");
    expect(SUMMARY).toContain("onEditRarity");
    expect(SUMMARY).toContain("onEditGrade");
  });
  it("form wires each Edit link to goToStage(0/1/2) only — no save/mutation", () => {
    expect(FORM).toMatch(/onEditCard=\{\(\) => goToStage\(0\)\}/);
    expect(FORM).toMatch(/onEditRarity=\{\(\) => goToStage\(1\)\}/);
    expect(FORM).toMatch(/onEditGrade=\{\(\) => goToStage\(2\)\}/);
  });
});

describe("summary derives strictly from existing form state (spec safety)", () => {
  it("every value is passed in from form.* / existing state — no new certificate state", () => {
    const block = FORM.slice(FORM.indexOf("<ReviewSummary"), FORM.indexOf("onEditGrade"));
    for (const f of ["form.cardName", "form.setName", "form.cardNumber", "form.year", "form.language", "form.rarityCode", "form.finishVariant", "form.promoType", "form.subsetName", "form.gradeOverall", "form.labelType", "form.status", "designations"]) {
      expect(block, f).toContain(f);
    }
  });
});

describe("notes stay collapsed + protected surfaces untouched (spec 11-16)", () => {
  it("Grader Notes remain collapsed by default behind Add Grader Notes", () => {
    const review = FORM.slice(FORM.indexOf("Stage 4 · REVIEW"));
    expect(review).toContain('data-testid="button-add-grader-notes"');
    expect(FORM).toContain('useState<boolean>(() => Boolean(certificate?.notes))'); // collapsed unless pre-existing notes
  });
  it("git diff vs main touches NO protected grading/centering/label/schema/server file", () => {
    const changed = execSync("git diff --name-only main...HEAD", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const f of changed) {
      expect(f, f).not.toMatch(/components\/grading\/|mvgs|scoring|centering|pristine|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/|^migrations\//);
    }
  });
});
