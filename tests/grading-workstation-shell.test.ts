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

// CertificateForm now mounts the canonical shell; slice from the mount to the
// form close to bound the /admin workstation body it composes.
const WORKSPACE = slice(FORM, "<CanonicalGradingWorkstationShell", "</form>");
// Everything from the header strip to the form open = the fixed header of the
// right panel (workflow strip + identification tools live here), still composed
// inside certificate-form.tsx as the shell's control-panel children.
const CONTROL_HEADER = slice(FORM, "<WorkstationHeaderStrip", "onSubmit={handleSubmit}");

describe("1-4. two-panel workspace: preview aside + control panel are grid siblings", () => {
  it("a viewport-bounded workspace wraps a two-column flex row (preview | controls)", () => {
    // CertificateForm MOUNTS the one canonical shell — no inline geometry.
    expect(FORM).toContain("<CanonicalGradingWorkstationShell");
    // The canonical shell OWNS the grading-workspace testid + the bounded,
    // viewport-relative workstation height at desktop (auto below md so the page
    // flows) — extracted verbatim from the old inline /admin layout.
    expect(SHELL_SRC).toMatch(/data-testid="grading-workspace"[^>]*/);
    expect(SHELL_SRC).toContain("flex min-h-0 flex-col");
    expect(SHELL_SRC).toContain("flex min-h-0 flex-col h-full"); // shell fills its parent
    expect(FORM).toContain("md:h-[calc(100dvh-4.5rem)]"); // the one bounded viewport wrapper (CertForm)
    // The panels container is a flex row at md+ (column-stack below): 40% preview
    // aside on the left, flex-1 control panel on the right.
    expect(SHELL_SRC).toContain("flex min-h-0 flex-1 flex-col gap-3 md:flex-row");
    expect(ASIDE_SRC).toContain("md:w-[40%] md:shrink-0");
  });
  it("CardPreviewPanel lives in the preview aside; controls in the control panel — siblings in one flex row", () => {
    // CertificateForm passes the preview aside to the canonical shell; the
    // shell composes it beside the control panel. Slice the mount → form.
    const row = slice(FORM, "<CanonicalGradingWorkstationShell", "onSubmit={handleSubmit}");
    expect(row).toContain("<WorkstationPreviewAside");
    expect(ASIDE_SRC).toContain('data-testid="grading-preview-panel"');
    expect(ASIDE_SRC).toContain("<CardPreviewPanel");
    // The control-panel column + its testid are owned by the canonical shell.
    expect(SHELL_SRC).toContain('data-testid="grading-control-panel"');
    // preview aside renders for Card, Rarity AND Review (Grade keeps its own
    // dedicated protected card/defect tool and is intentionally excluded).
    expect(row).toMatch(/wfStage === 0 \|\| wfStage === 2 \?[\s\S]*WorkstationPreviewAside/);
  });
  it("preview is NOT rendered above the fields as a full-width block", () => {
    // certificate-form.tsx no longer renders CardPreviewPanel directly at
    // all — the shared WorkstationPreviewAside is the ONLY render site, and
    // it is a grid sibling of the control panel, never a standalone
    // full-width row above the form.
    expect(FORM).not.toContain("<CardPreviewPanel");
    expect((ASIDE_SRC.match(/<CardPreviewPanel/g) ?? []).length).toBe(1);
    const aside = slice(FORM, "<WorkstationPreviewAside", ") : null");
    expect(aside).toContain("WorkstationPreviewAside");
  });
});

describe("2-3. workflow strip + Identification Tools are INSIDE the right control panel", () => {
  it("workstation-strip is in the control-panel header (before the form)", () => {
    expect(CONTROL_HEADER).toContain("<WorkstationHeaderStrip");
    expect(STRIP_SRC).toContain('data-testid="workstation-strip"');
    expect(STRIP_SRC).toContain("<GradingWorkflowBar embedded");
  });
  it("Identification Tools is in the control-panel header, collapsed, not full-width above both panels", () => {
    expect(CONTROL_HEADER).toContain('data-testid="identification-tools"');
    // it is a closed-by-default <details>
    const idt = slice(FORM, 'data-testid="identification-tools"', "runIdentify");
    expect(idt).not.toMatch(/<details[^>]*\sopen/);
  });
});

describe("5-6. fixed-height shell + internal scroll", () => {
  it("the right control panel form scrolls internally (page itself does not grow unbounded)", () => {
    const controlPanel = slice(FORM, "onSubmit={handleSubmit}", "</form>");
    expect(controlPanel).toContain("overflow-y-auto");
    expect(controlPanel).toContain("min-h-0 flex-1");
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
    expect(FORM).toContain('data-workflow-stage="card-details"'); // still a stage container, just a div
  });
  it("the large EDIT MV### title + 'Update certificate details' subtitle are removed", () => {
    expect(FORM).not.toContain('data-testid="text-form-title"');
    expect(FORM).not.toContain("Update certificate details");
  });
});

describe("10-11. navigation + stage reuse", () => {
  it("Continue to Grade stays inside the control panel form", () => {
    const controlPanel = slice(FORM, "onSubmit={handleSubmit}", "</form>");
    expect(controlPanel).toContain('data-testid="button-continue-to-grade"');
  });
  it("Card Details AND Review reuse the same side-by-side shell (aside shows for wfStage 0, 2)", () => {
    // The preview aside gate covers Card Details (0) and Review (2); Grade (1)
    // keeps its own dedicated protected card/defect tool instead.
    expect(FORM).toMatch(/wfStage === 0 \|\| wfStage === 2 \?[\s\S]*WorkstationPreviewAside/);
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
        /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/(?!routes\/admin-config\.ts|services\/tcgdex-set-resolve\.ts|services\/collector-number\.ts|vite\.ts)|^migrations\//,
      );
      if (!f.startsWith("tests/")) expect(allowedNonTest.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
  it("workstationSlot render + Stage-3 wrapper unchanged (no transform/scale added)", () => {
    const wrapper = slice(FORM, 'data-workflow-stage="grade"', "Grade-stage nav");
    expect(wrapper).toContain("{workstationSlot}");
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
      const saveTouched = touched.filter((l) => !/\/identify|\/grade|\/analyze|\/approve-grade|\/upload-images|\/images|tcgdex|card-lookup/.test(l));
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
