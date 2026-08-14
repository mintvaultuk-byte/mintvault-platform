/**
 * Grading "workstation shell" structural layout — source assertions proving the
 * parent layout is now a fixed-height two-panel workspace (read-only preview
 * aside on the left, control panel on the right with the workflow strip +
 * Identification Tools INSIDE it), the large title/fieldset chrome is gone, and
 * every protected/save/queue/Ownership/NFC surface is untouched. Zero provider
 * calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, gradingReleaseFileDiff } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const WORKSTATION_SRC = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const SHELL = read("client/src/components/admin/admin-shell.tsx");
// unified-shell pass: the preview aside and the header strip were extracted
// into their own shared components.
const ASIDE_SRC = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const STRIP_SRC = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
// canonical-consolidation pass: the fixed-height/two-panel outer geometry was
// extracted verbatim into ONE shared shell. CertificateForm now MOUNTS it; the
// geometry classes + grading-workspace/grading-control-panel testids live here.
const SHELL_SRC = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");

/** Slice between two anchors (both must exist, in order). */
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

function changedFiles(): string[] {
  // HISTORICAL release-scope: files changed by the grading RELEASE (PR #214), from the fixed range
  // d69ad147..fc57b53b — never the current branch. See tests/helpers/grading-release-scope.ts.
  return gradingReleaseChangedFiles();
}

// GradingWorkstation is the sole shell/header/panel owner. CertificateForm is
// the Super Admin metadata editor rendered inside its right-hand scroll body.
const WORKSPACE = slice(WORKSTATION_SRC, "<CanonicalGradingWorkstationShell", "</CanonicalGradingWorkstationShell>");
const CONTROL_HEADER = slice(
  WORKSTATION_SRC,
  "<WorkstationHeaderStrip",
  "className={`${WORKSTATION_BODY_SCROLL_CLASS}"
);

describe("1-4. two-panel workspace: preview aside + control panel are grid siblings", () => {
  it("a viewport-bounded workspace wraps a two-column flex row (preview | controls)", () => {
    expect(WORKSTATION_SRC).toContain("<CanonicalGradingWorkstationShell");
    expect(FORM).not.toContain("<CanonicalGradingWorkstationShell");
    // The canonical shell OWNS the grading-workspace testid + the bounded,
    // viewport-relative workstation height at desktop (auto below md so the page
    // flows) — extracted verbatim from the old inline /admin layout.
    expect(SHELL_SRC).toMatch(/data-testid="grading-workspace"[^>]*/);
    expect(SHELL_SRC).toContain("flex min-h-0 flex-col");
    expect(SHELL_SRC).toContain("flex min-h-0 flex-col h-full"); // shell fills its parent
    // /admin is the only non-overlay surface, so it must supply the height bound
    // itself. The previous assertion accepted `className="min-h-0 flex-1"`, which
    // proved nothing: `flex-1` is a flex-ITEM property on a BLOCK box, so the
    // workstation's own flex-1 stayed inert and the shell's h-full resolved against
    // an auto-height ancestor — the missing-bound regression behind the PR #234
    // same-day production rollback. Both halves are now required.
    // NO `flex-1` in this assertion, and that is the whole point. `flex-1` is
    // `flex: 1 1 0%`, and on a flex ITEM flex-basis REPLACES height for main-axis
    // sizing — so with it present the bound is computed and discarded and the item
    // stretches to its auto-height parent. Measured in a real browser against the
    // compiled CSS at 1280x800: with flex-1 the workspace was 2568px, the document
    // scrolled, the right pane did NOT scroll internally and the Live Certificate
    // Preview sat at y=2552. Without it: 728px, right pane scrolls, preview bottom
    // 763px, document not scrollable. Same result at 1024x768 (696px / 731px).
    expect(DASH).toMatch(/className="flex min-h-0 flex-col md:h-\[calc\(100dvh-4\.5rem\)\]"/);
    // The panels container is a flex row at md+ (column-stack below): 40% preview
    // aside on the left, flex-1 control panel on the right.
    expect(SHELL_SRC).toContain("flex min-h-0 flex-1 flex-col gap-2 md:flex-row");
    expect(ASIDE_SRC).toContain("md:w-[35%] md:shrink-0");
  });
  it("CardPreviewPanel lives in the preview aside; controls in the control panel — siblings in one flex row", () => {
    // GradingWorkstation passes the preview aside to the canonical shell.
    const row = WORKSPACE;
    expect(row).toContain("<WorkstationPreviewAside");
    expect(ASIDE_SRC).toContain('data-testid="grading-preview-panel"');
    expect(ASIDE_SRC).toContain("<CardPreviewPanel");
    // The control-panel column + its testid are owned by the canonical shell.
    expect(SHELL_SRC).toContain('data-testid="grading-control-panel"');
    // The same aside persists; Grade's one interactive viewer is portalled into it.
    expect(row).toContain("previewHost={gradingEnabled ? interactiveCardHost : null}");
  });
  it("preview is NOT rendered above the fields as a full-width block", () => {
    // certificate-form.tsx no longer renders CardPreviewPanel directly at
    // all — the shared WorkstationPreviewAside is the ONLY render site, and
    // it is a grid sibling of the control panel, never a standalone
    // full-width row above the form.
    expect(FORM).not.toContain("<CardPreviewPanel");
    expect((ASIDE_SRC.match(/<CardPreviewPanel/g) ?? []).length).toBe(1);
    const aside = slice(WORKSTATION_SRC, "<WorkstationPreviewAside", "below={");
    expect(aside).toContain("WorkstationPreviewAside");
  });
});

describe("2-3. workflow strip + Identification Tools are INSIDE the right control panel", () => {
  it("workstation-strip is in the control-panel header (before the form)", () => {
    expect(CONTROL_HEADER).toContain("<WorkstationHeaderStrip");
    expect(STRIP_SRC).toContain('data-testid="workstation-strip"');
    expect(STRIP_SRC).toContain("<GradingWorkflowBar embedded");
  });
  it("Identification Tools remains in the bounded admin metadata surface, not the canonical grading body", () => {
    expect(CONTROL_HEADER).not.toContain('data-testid="identification-tools"');
    expect(FORM).toContain('data-testid="identification-tools"');
    // it is a closed-by-default <details>
    const idt = slice(FORM, 'data-testid="identification-tools"', "runIdentify");
    expect(idt).not.toMatch(/<details[^>]*\sopen/);
  });
});

describe("5-6. fixed-height shell + internal scroll", () => {
  it("the right control panel form scrolls internally (page itself does not grow unbounded)", () => {
    const controlPanel = slice(WORKSTATION_SRC, "className={`${WORKSTATION_BODY_SCROLL_CLASS}", "<GradingPanel");
    expect(controlPanel).toContain("WORKSTATION_BODY_SCROLL_CLASS");
    expect(SHELL_SRC).toContain('WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1"');
  });
  it("admin-dashboard renders the grading view in a page-scrollable focus shell", () => {
    expect(DASH).toContain("focus"); // AdminShell focus prop passed
    // grading-header is now the shared AdminHeaderRow primitive, passed
    // testId="grading-header" (a prop, not a literal data-testid attribute).
    expect(DASH).toContain('testId="grading-header"');
    // min-height (not h-full) so the page can always scroll as a fallback.
    expect(DASH).toContain("min-h-[100dvh] flex-col");
  });
  it("AdminShell focus mode hides the big admin-top header AND the sidebar", () => {
    expect(SHELL).toMatch(/focus\??:\s*boolean/);
    // Focus mode is an early return that renders only the compact workstation —
    // no admin-top header and no admin-side sidebar. The full-chrome render
    // (admin-app) comes after.
    const focusBlock = SHELL.slice(SHELL.indexOf("if (focus)"), SHELL.indexOf('className="admin-app"'));
    expect(focusBlock).toContain("admin-focus");
    expect(focusBlock).not.toContain("admin-top");
    expect(focusBlock).not.toContain("admin-side");
  });
});

describe("7-9. old tall chrome is gone", () => {
  it("the large 1·CARD DETAILS fieldset is gone (now a plain div)", () => {
    expect(FORM).not.toMatch(/<fieldset data-workflow-stage="card-details"/);
    expect(FORM).toContain('data-metadata-section="card-details"');
    expect(FORM).not.toContain("data-workflow-stage");
  });
  it("the large EDIT MV### title + 'Update certificate details' subtitle are removed", () => {
    expect(FORM).not.toContain('data-testid="text-form-title"');
    expect(FORM).not.toContain("Update certificate details");
  });
});

describe("10-11. navigation + stage reuse", () => {
  it("CertificateForm has no competing stage navigation", () => {
    expect(FORM).not.toContain('data-testid="button-continue-to-grade"');
    expect(FORM).not.toContain('data-testid="button-review-card"');
  });
  it("Card Details, Grade and Review reuse the same persistent side-by-side shell", () => {
    expect(WORKSTATION_SRC).toContain("<WorkstationPreviewAside");
    expect(WORKSTATION_SRC).toContain("interactiveCardHostRef={gradingEnabled ? interactiveCardHostRef : undefined}");
  });
});

describe("12-20. protected surfaces / save / queue / Ownership-NFC / providers untouched", () => {
  it("git diff touches ONLY the allowed UI + test files — no protected/server/schema file", () => {
    const changed = changedFiles();
    const allowedNonTest = new Set([
      "client/src/components/certificate-form.tsx",
      "client/src/components/admin/admin-shell.tsx",
      "client/src/pages/admin-dashboard.tsx",
      // viewer wheel-zoom removal (same branch): read-only preview only
      "client/src/components/grading-workflow/CardPreviewPanel.tsx",
      "client/src/components/rarity-picker/RarityVariantPicker.tsx",
      // identify/lookup fix (same branch): structured-error lib + non-protected
      // TCGdex lookup routes/services.
      "client/src/lib/lookup-errors.ts",
      "server/routes/admin-config.ts",
      "server/services/tcgdex-set-resolve.ts",
      "server/services/collector-number.ts",
      // dev-server fs.allow fix (same branch) — dev-only, no prod/grading impact
      "server/vite.ts",
      // Stage 1/2 usability pass (same branch): rarity contrast + custom-rarity
      // workflow + collector-number display formatter.
      "client/src/components/rarity-picker/RaritySymbol.tsx",
      "client/src/components/grading-workflow/ReviewSummary.tsx",
      "shared/pokemon-rarity-catalogue.ts",
      "shared/collector-number-format.ts",
      // workflow-header overlap hotfix (same branch): stage nav + session-stats
      // zoning only — no protected/server file involved.
      "client/src/components/grading-workflow/GradingWorkflowBar.tsx",
      // compact-header + Review-layout hotfix (same branch): session-stats
      // sizing only — no protected/server file involved.
      "client/src/components/grading-workflow/SessionHud.tsx",
      // unified-shell architecture pass (same branch): new shared primitives +
      // the pages/component that adopt them. Layout-only, no protected surface.
      "client/src/components/grading-workflow/WorkstationHeaderStrip.tsx",
      "client/src/components/grading-workflow/WorkstationPreviewAside.tsx",
      "client/src/components/admin/AdminHeaderRow.tsx",
      "client/src/pages/staff.tsx",
      "client/src/components/grading-workflow/CertificateToolsDrawer.tsx",
    ]);
    for (const f of changed) {
      expect(f, `${f} must not be protected/server/schema`).not.toMatch(
        /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/(?!routes\/admin-config\.ts|services\/tcgdex-set-resolve\.ts|services\/collector-number\.ts|vite\.ts)|^migrations\//
      );
      if (!f.startsWith("tests/")) expect(allowedNonTest.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
  it("GradingWorkstation is the sole GradingPanel owner and adds no transform/scale", () => {
    const wrapper = slice(FORM, 'data-metadata-section="creation-grade"', 'data-testid="button-save-cert"');
    expect(FORM).not.toContain("workstationSlot");
    expect((WORKSTATION_SRC.match(/<GradingPanel/g) ?? []).length).toBe(1);
    expect(wrapper).not.toMatch(/transform|scale\(|zoom:/);
  });
  it("save payload builder + endpoints not modified by this pass", () => {
    const diff = gradingReleaseFileDiff("client/src/components/certificate-form.tsx");
    const touched = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l))
      .filter((l) => /apiRequest\(|\/api\/admin\/certificates|method:\s*"(POST|PUT|PATCH)"|buildCertFormData/.test(l));
    // The AI identify / grade / TCGdex-lookup endpoints are NOT the save path;
    // this pass legitimately restructured the identify fetch. Guard the SAVE only.
    const saveTouched = touched.filter(
      (l) => !/\/identify|\/grade|\/analyze|\/approve-grade|\/upload-images|\/images|tcgdex|card-lookup/.test(l)
    );
    expect(saveTouched).toEqual([]);
  });
  it("queue + Ownership/NFC logic untouched (admin-dashboard has no queue/drawer logic change)", () => {
    expect(DASH).toContain("openNextQueuedCard");
    expect(DASH).toContain("<CertificateToolsDrawer");
    expect(DASH).not.toMatch(/<OwnershipSection\b/);
    expect(DASH).not.toMatch(/<NfcSection\b/);
  });
  it("no provider/credit call introduced (UI-only diff)", () => {
    const added = gradingReleaseFileDiff("client/")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    for (const l of added) {
      expect(l).not.toMatch(/anthropic|higgsfield|stripe|\.charge|credits?\.(spend|reserve|deduct)/i);
    }
  });
});
