/**
 * Review-stage summary — read-only confirmation panel. Source-assertion tests
 * (the admin grading form is auth-gated). Proves the summary derives only from
 * the canonical GradingPanel draft, holds no certificate state, computes no
 * grade and saves nothing on entry. CertificateForm must not retain a second
 * Review-stage implementation.
 * Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, GRADING_PROTECTED_PATHS } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SUMMARY = read("client/src/components/grading-workflow/RoleReviewSummary.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
/** Strip comments — they deliberately describe what is NOT done. */
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const SUMMARY_CODE = stripComments(SUMMARY);

describe("Review summary shows the identification + classification data (spec 1-2)", () => {
  it("card details: name, set, number, year, language", () => {
    expect(SUMMARY).toContain('data-testid="role-review-summary"');
    for (const row of ["Card", "Set", "Number", "Year", "Language", "Game"]) {
      expect(SUMMARY).toContain(`<Item label="${row}">`);
    }
  });
  it("classification: service tier, variant, rarity, finish and promo", () => {
    for (const row of ["Service", "Variant", "Rarity", "Finish", "Promo"]) {
      expect(SUMMARY).toContain(`<Item label="${row}">`);
    }
  });
});

describe("grade is displayed from existing state, never recomputed (spec 3-4)", () => {
  it("renders the current overall grade from props, not a calculation", () => {
    expect(SUMMARY).toContain('<Item label="Overall">{props.grade.overall}</Item>');
    // No grade maths in the summary (display text may name "MVGS"; that's fine).
    expect(SUMMARY_CODE).not.toMatch(/computeGrade|calculateGrade|scoreCard|deriveGrade|parseFloat|Math\./);
    const imports = (SUMMARY_CODE.match(/from\s+"[^"]+"/g) ?? []).join("\n");
    expect(imports).not.toMatch(
      /components\/grading\/|mvgs|scoring|centering|pristine|grader|labels|certificate-document/i
    );
  });
  it("shows all four persisted subgrades from the canonical grading draft", () => {
    for (const field of ["centering", "corners", "edges", "surface"]) {
      expect(SUMMARY).toContain(`props.grade.${field}`);
    }
  });
});

describe("read-only: no parallel state, no save on entry (spec 5, 10)", () => {
  it("summary holds no useState/useEffect/network — pure presentation", () => {
    expect(SUMMARY_CODE).not.toMatch(/useState|useEffect|useQuery|useMutation|fetch\(|apiRequest/);
  });
  it("entering Review does not save — no mutate/submit is triggered by the summary", () => {
    expect(SUMMARY_CODE).not.toMatch(/mutate|handleSubmit|autoSaveNow|setForm/);
  });
  it("Review entry is owned by the save-and-exact-preview workstation barrier", () => {
    expect(WORKSTATION).toContain("runReviewTransitionBarrier");
    expect(WORKSTATION).toContain("persist: reviewTransitionHandler");
    expect(WORKSTATION).toContain("preview: requestAuthoritativePreview");
    expect(PANEL).toContain("onReviewTransitionReady(invoke)");
    expect(SUMMARY).not.toMatch(/onSave|mutate|handleSubmit|fetch\(/);
    expect(FORM).not.toMatch(/ReviewSummary|data-workflow-stage|button-review-card/);
  });
});

describe("one canonical Review stage (spec 6-8)", () => {
  it("the shared stage bar owns navigation and CertificateForm has no parallel stage tree", () => {
    expect(WORKSTATION).toContain("onStageClick={(i) => goToStage(i)}");
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    expect(PANEL).toContain("<RoleReviewSummary");
    expect(FORM).not.toMatch(/goToStage|CARD_DETAILS_STAGE|GRADE_STAGE|review-edit-/);
  });
});

describe("summary derives strictly from the in-memory canonical draft (spec safety)", () => {
  it("GradingPanel passes identity, classification, grade, auth, defects and notes", () => {
    const block = PANEL.slice(PANEL.indexOf("<RoleReviewSummary"), PANEL.indexOf("<RoleReviewSummary") + 1400);
    for (const f of [
      "idName",
      "idSet",
      "idNumber",
      "idYear",
      "idLanguage",
      "rarityCode",
      "finishVariant",
      "promoType",
      "finalGradeOverall",
      "centering",
      "cornersGrade",
      "edgesGrade",
      "surfaceGrade",
      "authStatus",
      "defects",
      "gradeExplanation",
      "privateNotes",
    ]) {
      expect(block, f).toContain(f);
    }
  });
});

describe("complete read-only review + protected surfaces untouched (spec 11-16)", () => {
  it("shows authentication, defects, and both note channels without adding state", () => {
    for (const label of ["Authentication", "Public grade explanation", "Private notes"]) {
      expect(SUMMARY).toContain(`label="${label}"`);
    }
    expect(SUMMARY).toContain("Defects (${props.defects.length})");
    expect(SUMMARY_CODE).not.toMatch(/useState|useEffect/);
  });
  // HISTORICAL release-scope proof: the grading release (PR #214) itself changed no protected file.
  // Pinned to the fixed grading range d69ad147..fc57b53b — never the current branch (see helper).
  it("grading release (PR #214) touched NO protected grading/centering/label/schema/server file", () => {
    for (const f of gradingReleaseChangedFiles()) {
      expect(f, f).not.toMatch(GRADING_PROTECTED_PATHS);
    }
  });
});
