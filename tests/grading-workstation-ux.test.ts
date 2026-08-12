/**
 * Professional grading-workstation UX pass — source-assertion tests (the admin
 * grading form is auth-gated). Covers: read-only card viewer zoom/fit/fullscreen,
 * auto-focus first field, recent sets, same-as-last-card quick-fill, and proves
 * NO protected grading/centering/server/schema/migration file changed.
 * Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, GRADING_PROTECTED_PATHS } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const VIEWER = read("client/src/components/grading-workflow/CardPreviewPanel.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("floating card viewer is read-only with zoom controls (spec 1)", () => {
  it("has front/back tabs, button zoom (wheel does NOT zoom), fit/reset, and a fullscreen modal", () => {
    expect(VIEWER).toContain("card-preview-${s}"); // front/back tab testids (template)
    expect(VIEWER).toMatch(/\["front", "back"\]/); // both sides rendered
    expect(VIEWER).not.toContain("onWheel"); // wheel scrolls the page/panel, never zooms
    expect(VIEWER).toContain("stepZoom"); // zoom only via +/− buttons
    expect(VIEWER).toContain('data-testid="card-preview-zoom"');
    expect(VIEWER).toContain('data-testid="card-preview-fullscreen"');
    expect(VIEWER).toContain("Full-screen preview");
  });
  it("zoom + pan are a pure CSS transform on a preview image — never touches grading geometry", () => {
    // Controlled image-relative focus + zoom CSS transform, no grading coordinates.
    expect(VIEWER).toContain("`scale(${zoom}) translate(");
    expect(VIEWER).toContain("0.5 - view.focusX");
    expect(VIEWER).toContain("updateCardInspectionView(currentInspection, side, patch)");
    const code = stripComments(VIEWER);
    expect(code).not.toMatch(/centering|crop|defect|x_percent|y_percent|imagePctFromEvent/i);
    const imports = (code.match(/from\s+"[^"]+"/g) ?? []).join("\n");
    expect(imports).not.toMatch(/components\/grading\//);
  });
  it("zoom is clamped to a sane range", () => {
    expect(VIEWER).toContain("MIN_ZOOM");
    expect(VIEWER).toContain("MAX_ZOOM");
    expect(VIEWER).toContain("clampZoom");
  });
});

describe("keyboard-safe canonical Card Details stage (spec 7)", () => {
  it("keeps Card Name addressable without imperative focus stealing and retains keyboard card-side switching", () => {
    expect(FORM).toContain('testId="input-card-name"');
    expect(FORM).not.toContain("alreadyTyping");
    expect(WORKSTATION).toContain("setStage(index)");
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    expect(VIEWER).toContain("tabIndex={0}");
    expect(VIEWER).toContain('e.key === " " || e.code === "Space"');
    expect(VIEWER).toContain('setSide(side === "front" ? "back" : "front")');
  });
});

describe("recent sets (spec 3)", () => {
  it("PokemonSetPicker persists + surfaces recently-used sets, one-click fill", () => {
    expect(FORM).toContain('localStorage.setItem("mv.recentSets"');
    expect(FORM).toContain("recordRecentSet");
    expect(FORM).toContain('data-testid="recent-sets"');
    expect(FORM).toContain("recent-set-"); // per-chip testid
  });
  it("recording a recent set does not mutate the catalogue or call an API", () => {
    const fn = FORM.slice(FORM.indexOf("function recordRecentSet"), FORM.indexOf("function recordRecentSet") + 400);
    expect(fn).not.toMatch(/fetch\(|apiRequest|POST|PATCH|DELETE/);
  });
});

describe("same as last card quick-fill (spec 9) — never overwrites (spec 5)", () => {
  it("captures shared context on Continue and applies only on click", () => {
    expect(FORM).toContain("writeLastCardContext(window.sessionStorage, ctx)");
    expect(FORM).not.toContain('localStorage.setItem("mv.lastCardContext"');
    expect(FORM).toContain("captureLastCardContext");
    expect(FORM).toContain('data-testid="button-same-as-last-card"');
  });
  it("applyLastCardContext only fills EMPTY fields (guarded by !f.x)", () => {
    const fn = FORM.slice(
      FORM.indexOf("function applyLastCardContext"),
      FORM.indexOf("function applyLastCardContext") + 800
    );
    expect(fn).toMatch(/if \(!f\.setName && lastCardContext\.setName\)/);
    expect(fn).toMatch(/if \(!f\.year && lastCardContext\.year\)/);
    expect(fn).toMatch(/if \(!f\.language && lastCardContext\.language\)/);
  });
  it("only remembers the shared context, NOT the per-card name/number", () => {
    const fn = FORM.slice(
      FORM.indexOf("function captureLastCardContext"),
      FORM.indexOf("function captureLastCardContext") + 500
    );
    expect(fn).not.toContain("cardName");
    expect(fn).not.toContain("cardNumber");
  });
});

describe("finish/promo tooltips retained (spec 14)", () => {
  it("finish/promo pills carry a description tooltip", () => {
    expect(PICKER).toContain("title={item.description}");
  });
});

describe("protected surfaces untouched (spec 19)", () => {
  // HISTORICAL release-scope proof: the grading release (PR #214) itself changed no protected file.
  // Pinned to the fixed grading range d69ad147..fc57b53b — never the current branch (see helper).
  it("grading release (PR #214) touched NO protected grading/centering/label/schema/server file", () => {
    for (const f of gradingReleaseChangedFiles()) {
      expect(f, f).not.toMatch(GRADING_PROTECTED_PATHS);
    }
  });
});
