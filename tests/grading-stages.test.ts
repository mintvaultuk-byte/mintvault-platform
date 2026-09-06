/**
 * Stage-gated grading workflow (Card Details → Grade → Review) — source
 * assertions proving stage isolation, no-save navigation, notes relocation,
 * legacy-control collapse, compact chips, and that NO protected grading file
 * changed. Zero provider calls, zero credits.
 *
 * Consolidated 2026-07-26: Card and Rarity are now ONE stage ("Card Details").
 * The Variant block (formerly the Rarity stage) is asserted to live INSIDE the
 * Card Details section rather than in a stage of its own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, GRADING_PROTECTED_PATHS } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");
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

/** The identity half of Card Details (game/set/name/number/year/language). */
const CARD_IDENTITY = between("STAGE 1 · CARD DETAILS", "VARIANT (formerly the separate");
/** The Variant half of Card Details — same screen, below the identity fields. */
const VARIANT_BLOCK = between("VARIANT (formerly the separate", "Grade metadata remains");
/** The whole consolidated Card Details stage. */
const STAGE_CARD_DETAILS = between("STAGE 1 · CARD DETAILS", "Grade metadata remains");
/** Code with comments stripped (comments deliberately describe what is NOT done). */
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("stage separation (spec 1-4)", () => {
  it("the identity half of Card Details holds identification fields, not the picker or notes", () => {
    expect(CARD_IDENTITY).toContain("Search TCG");
    expect(CARD_IDENTITY).not.toContain("RarityVariantPicker");
    expect(CARD_IDENTITY).not.toContain("designations-chips");
    expect(CARD_IDENTITY).not.toContain("Grader Notes");
  });
  it("the Variant half holds the structured picker + collapsed legacy/designations", () => {
    expect(VARIANT_BLOCK).toContain("RarityVariantPicker");
    expect(VARIANT_BLOCK).toContain('data-testid="legacy-variant-details"');
    expect(VARIANT_BLOCK).toContain('data-testid="designations-details"');
    expect(VARIANT_BLOCK).not.toContain("Grader Notes");
  });
  it("CONSOLIDATION: identity AND Variant render on the SAME stage (one screen)", () => {
    // Both halves are inside the single Card Details section...
    expect(STAGE_CARD_DETAILS).toContain("Search TCG");
    expect(STAGE_CARD_DETAILS).toContain("RarityVariantPicker");
    expect(STAGE_CARD_DETAILS).toContain('data-testid="designations-details"');
    // ...and there is exactly ONE stage wrapper around them.
    expect(FORM).toContain('data-metadata-section="card-details"');
    expect(FORM).not.toContain("data-workflow-stage");
    // The old cross-stage navigation is gone entirely.
    expect(FORM).not.toContain("Continue to Rarity →");
    expect(FORM).not.toContain("← Back to Rarity");
  });
  it("Variant is presented as OPTIONAL and is not part of any gate", () => {
    expect(VARIANT_BLOCK).toContain("optional");
    expect(FORM).not.toContain("button-continue-to-grade");
    // Scanner controls are also a Card Details capability, but they are mounted
    // by the same canonical workstation rather than the metadata drawer. The
    // variant block therefore cannot create a second scanner/stage surface.
    expect(FORM).not.toContain("scannerCaptureRequired");
    expect(WORKSTATION).toContain('data-canonical-section="scanner-controls"');
  });
  it("Card Details shows the permanent variant/classification summary below the picker (item 2)", () => {
    expect(VARIANT_BLOCK).toContain("<VariantSummary");
  });
  it("CertificateForm contains no competing Grade→Review navigation", () => {
    expect(FORM).not.toContain("Continue to Review");
    expect(FORM).not.toContain("button-review-card");
  });
  it("Grade stage metadata is editor-only; GradingPanel is owned by GradingWorkstation", () => {
    expect(FORM).not.toContain("workstationSlot");
    expect(FORM).not.toContain("<GradingPanel");
  });
  it("Review notes + approval remain in the canonical GradingPanel", () => {
    expect(PANEL).toContain('data-canonical-section="notes"');
    expect(PANEL).toContain('data-canonical-section="footer-actions"');
    expect(FORM).not.toContain("legacy-review");
  });
  it("Review stage shows the live certificate preview via the SINGLE canonical panel", () => {
    // The Review-stage live preview is the SINGLE canonical
    // CertificatePreviewPanel, mounted once at the shell level (via
    // WorkstationPreviewAside `below`), never a second per-stage LabelPreview.
    // The workstation owns one persistent panel for all three stages.
    expect(WORKSTATION).toContain("<CertificatePreviewPanel");
    expect(WORKSTATION).toContain("<WorkstationPreviewAside");
    // PROVENANCE: the duplicate Review LabelPreview was removed by CURRENT MAIN,
    // not by this branch — this branch merely preserved main's negative guard
    // (it did NOT invert it) and re-expressed the gate in three-stage numbering.
    // LabelPreview.tsx no longer exists on main at all.
    expect(FORM).not.toContain("<LabelPreview");
    expect(FORM).not.toContain("<CertificatePreviewPanel");
    expect((WORKSTATION.match(/<CertificatePreviewPanel/g) ?? []).length).toBe(1);
  });
  it("CertificateForm exposes only its metadata/create save", () => {
    expect(FORM).toContain('data-testid="button-save-cert"');
    expect(FORM).not.toContain("button-save-now");
  });
});

describe("stage navigation is UI-state only (spec: no save/grade/issue)", () => {
  it("canonical stages are owned and hidden-not-unmounted by GradingWorkstation", () => {
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    expect(WORKSTATION).toContain("grading-stage-gate");
    expect(WORKSTATION).not.toMatch(/\beditor\??\s*:/);
  });
  it("CertificateForm cannot receive the canonical stage controller from /admin", () => {
    expect(DASH).not.toMatch(/workflowStage=|onStageRequest=|editor=\{/);
    expect(FORM).not.toMatch(/workflowStage|onStageRequest|onPresentationChange/);
  });
  it("all grading-stage navigation is absent from the metadata form", () => {
    for (const id of [
      "button-continue-to-grade",
      "button-back-to-card-details",
      "button-review-card",
      "button-back-to-grade",
    ])
      expect(FORM).not.toContain(id);
    expect(FORM).not.toContain("legacy-review");
  });
  it("the retired Rarity-stage nav testids are gone", () => {
    for (const id of ["button-continue-to-rarity", "button-back-to-rarity"]) {
      expect(FORM).not.toContain(id);
    }
  });
  it("CertificateForm contains no grading-stage gate or duplicate scanner surface", () => {
    expect(FORM).not.toContain("Continue to Grade");
    expect(FORM).not.toContain("button-continue-to-grade");
    // Super Admin capture and recapture are passed through the workstation's
    // Card Details slot; the metadata drawer can never become a competing
    // scanner/viewer implementation.
    expect(FORM).not.toContain("CaptureWizard");
    expect(DASH).toContain("scannerControls={");
    expect(DASH).toContain("<CaptureWizard");
    expect(WORKSTATION).toContain('data-testid="workstation-scanner-controls"');
  });
});

describe("card preview is read-only (spec 3)", () => {
  it("plain <img> from signed full-resolution working URLs / uploaded files — no coordinates, no protected imports", () => {
    expect(PREVIEW).toContain("front_working");
    expect(PREVIEW).not.toContain("?? data?.urls?.front_display");
    expect(PREVIEW).toContain("URL.createObjectURL");
    // Check CODE only (comments deliberately mention what is NOT done).
    const code = stripComments(PREVIEW);
    // Read-only preview may pan/zoom (viewport geometry), but must do NO grading
    // coordinate work: no centering/crop/defect/image-percent mapping.
    expect(code).not.toMatch(/centering|crop|defect|x_percent|y_percent|imagePctFromEvent/i);
    const imports = (code.match(/from\s+"[^"]+"/g) ?? []).join("\n");
    expect(imports).not.toMatch(/components\/grading\//);
  });
  it("workspace places the read-only preview aside beside stage controls (MacBook split)", () => {
    // Fixed-height workstation shell: preview lives in a dedicated aside beside
    // the control panel, not a sticky column inside the form. unified-shell
    // pass: the aside is now the shared WorkstationPreviewAside component.
    // The two-column row lives in the sole canonical GradingWorkstation shell.
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
    const shellSrc = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
    expect(shellSrc).toContain('WORKSTATION_TWO_PANE_CLASS = "min-[540px]:flex-row"');
    expect(WORKSTATION).toContain("<WorkstationPreviewAside");
    const asideSrc = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
    expect(asideSrc).toContain("min-[540px]:w-[45%] min-[540px]:shrink-0");
    expect(asideSrc).toContain('data-testid="grading-preview-panel"');
    expect(asideSrc).toContain("<CardPreviewPanel");
  });
});

describe("compact chips v2 + region-aware defaults (spec 5-6)", () => {
  it("chips shrank again (v5 hotfix: ~28px high, dense auto-fill grid)", () => {
    expect(PICKER).toContain("min-h-[28px]");
    expect(PICKER).toContain("RARITY_TILE_GRID");
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
  // HISTORICAL release-scope proof: the grading release (PR #214) itself changed no protected file.
  // Pinned to the fixed grading range d69ad147..fc57b53b — never the current branch (see helper).
  it("grading release (PR #214) touched NO protected grading/centering/label/schema/server file", () => {
    for (const f of gradingReleaseChangedFiles()) {
      expect(f, f).not.toMatch(GRADING_PROTECTED_PATHS);
    }
  });
  it("AI Card Identification stays absent; TCGdex stays present (spec 19-20)", () => {
    expect(FORM).not.toContain("CardIdentifyPanel");
    expect(FORM).toContain("Search TCG");
  });
});
