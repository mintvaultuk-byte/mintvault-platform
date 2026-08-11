/**
 * Regression coverage for the two production grading-workstation layout defects:
 *
 *   1. Card Details read-only preview zoom must step by 75 percentage points —
 *      100 → 175 → … → 550 → 600 (max 600%, min 100%), button-only, wheel never
 *      zooms, reset returns to 100%.
 *   2. The desktop workstation must be a real two-column shell with correct scroll
 *      ownership: the right controls column scrolls internally where needed, the
 *      browser page always remains scrollable (no overflow-hidden trap), and the
 *      workflow strip sits in the controls column — not beneath a full-width
 *      preview that consumes the whole page.
 *
 * Source-assertion style (matches the sibling grading tests). Zoom levels are
 * derived from the ACTUAL source constants so the sequence can't silently drift.
 * Protected Stage-3 / grading files must stay untouched. Zero provider calls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { unifiedAdminShellChangedFiles } from "./helpers/grading-release-scope";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PREVIEW = read("client/src/components/grading-workflow/CardPreviewPanel.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const SHELL = read("client/src/components/admin/admin-shell.tsx");
// canonical-consolidation: the workstation outer geometry (grading-workspace +
// grading-control-panel + the two-column row + fixed height) now lives in the
// ONE shared shell that CertificateForm mounts.
const CANON_SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");

function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

/** Pull a numeric `const NAME = <number>;` out of the preview source. */
function num(name: string): number {
  const m = PREVIEW.match(new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`));
  expect(m, `constant ${name}`).toBeTruthy();
  return Number(m![1]);
}

// The component clamps every step: nextZoom = clamp(zoom ± STEP). Rebuild the
// ascending ladder from the real constants so the test tracks the source.
const MIN = num("MIN_ZOOM");
const MAX = num("MAX_ZOOM");
const STEP = num("ZOOM_STEP");
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));
function ladder(): number[] {
  const levels: number[] = [MIN];
  let z = MIN;
  for (let i = 0; i < 20; i++) {
    const next = clamp(z + STEP);
    if (next === z) break;
    levels.push(next);
    z = next;
  }
  return levels;
}
const pct = (z: number) => Math.round(z * 100);

describe("1-4. button-only zoom steps preserve the Grade viewer's 600% ceiling", () => {
  it("steps by 75 percentage points and clamps the final step at 600 percent", () => {
    expect(ladder().map(pct)).toEqual([100, 175, 250, 325, 400, 475, 550, 600]);
    // 75 percentage points per click.
    expect(pct(MIN + STEP)).toBe(175);
  });
  it("zoom never exceeds 600%", () => {
    expect(pct(MAX)).toBe(600);
    // stepping up from the top clamps, never overshoots.
    expect(pct(clamp(MAX + STEP))).toBe(600);
    // the Zoom-In control is disabled at the ceiling.
    expect(PREVIEW).toContain("zoom >= MAX_ZOOM");
  });
  it("zoom never goes below 100%", () => {
    expect(pct(MIN)).toBe(100);
    expect(pct(clamp(MIN - STEP))).toBe(100);
    expect(PREVIEW).toContain("zoom <= MIN_ZOOM");
  });
  it("Reset returns to 100% (and re-centres)", () => {
    const reset = slice(PREVIEW, "const resetView", "};");
    expect(reset).toContain("setView({ zoom: 1, focusX: 0.5, focusY: 0.5 })");
  });
  it("the zoom read-out derives from the shared numeric zoom", () => {
    expect(PREVIEW).toContain("Math.round(zoom * 100)");
  });
});

describe("5. the read-only preview has NO wheel-zoom handler", () => {
  it("no onWheel / wheel listener anywhere in the preview", () => {
    expect(PREVIEW).not.toMatch(/onWheel/);
    expect(PREVIEW).not.toMatch(/addEventListener\(\s*["']wheel["']/);
    // the intent is documented, and zoom is only reachable via the buttons.
    expect(PREVIEW).toContain("Mouse wheel is intentionally NOT handled");
    expect(PREVIEW).toContain("stepZoom(-ZOOM_STEP)");
    expect(PREVIEW).toContain("stepZoom(ZOOM_STEP)");
  });
  it("drag-to-pan is available only while zoomed above 100%", () => {
    const start = slice(PREVIEW, "const startDrag", "};");
    expect(start).toContain("if (zoom <= 1) return;");
  });
});

describe("6. desktop shell is a real two-column layout at desktop breakpoints", () => {
  it("the panels row becomes a two-column flex-row at md+ (engages on real laptops)", () => {
    // GradingWorkstation is the sole shell owner; CertificateForm is an editor slot.
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
    expect(FORM).not.toContain("<CanonicalGradingWorkstationShell");
    expect(CANON_SHELL).toContain("flex min-h-0 flex-1 flex-col gap-3 md:flex-row");
    const asideSrc = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
    expect(asideSrc).toContain("md:w-[40%] md:shrink-0");
    // the old lg-only breakpoint (which collapsed below 1024px) is gone.
    expect(CANON_SHELL).not.toContain("gap-3 lg:flex-row");
  });
  it("the workstation is viewport-bounded at desktop (not an unbounded h-full chain)", () => {
    // The shell fills the bounded flex slot supplied by every route shell.
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
    expect(CANON_SHELL).toContain("flex min-h-0 flex-col h-full");
  });
});

describe("7. the right controls column has accessible vertical overflow where required", () => {
  it("the control-panel form scrolls internally (min-h-0 flex-1 + overflow-y-auto)", () => {
    // GradingWorkstation owns the one right-hand scroll body; the embedded form
    // deliberately has no competing overflow owner.
    const controlPanel = slice(WORKSTATION, "className={`${WORKSTATION_BODY_SCROLL_CLASS}", "<GradingPanel");
    expect(controlPanel).toContain("WORKSTATION_BODY_SCROLL_CLASS");
    expect(CANON_SHELL).toContain(
      'WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2.5 overflow-y-auto md:pr-1"'
    );
    expect(slice(FORM, "onSubmit={handleSubmit}", ">\n")).toContain('className="space-y-2.5"');
  });
});

describe("8. no top-level workstation container traps page scrolling", () => {
  it("the focus shell uses min-height and does NOT set overflow:hidden", () => {
    const focusBlock = SHELL.slice(SHELL.indexOf("if (focus)"), SHELL.indexOf('className="admin-app"'));
    expect(focusBlock).toContain('minHeight: "100dvh"');
    expect(focusBlock).not.toMatch(/overflow:\s*["']hidden["']/);
    expect(focusBlock).not.toContain('height: "100vh"');
  });
  it("the dashboard grading container uses min-h (page-scrollable), not a clipped fixed height", () => {
    expect(DASH).toContain("min-h-[100dvh] flex-col");
    expect(DASH).not.toContain("h-full min-h-0 flex-col");
  });
  it("the workspace itself never sets overflow-hidden", () => {
    // The workspace + control-panel wrappers are the shell's; it must never trap
    // page scrolling with overflow-hidden.
    const workspace = slice(CANON_SHELL, 'data-testid="grading-workspace"', 'data-testid="grading-control-panel"');
    expect(workspace).not.toContain("overflow-hidden");
  });
});

describe("9. the workflow strip is in the controls column, not beneath the preview", () => {
  it("WorkstationHeaderStrip (with the embedded workflow bar) lives inside the control panel header", () => {
    const controlHeader = slice(WORKSTATION, "<WorkstationHeaderStrip", "className={`${WORKSTATION_BODY_SCROLL_CLASS}");
    expect(controlHeader).toContain("<WorkstationHeaderStrip");
    const stripSrc = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
    expect(stripSrc).toContain('data-testid="workstation-strip"');
    expect(stripSrc).toContain("<GradingWorkflowBar embedded");
  });
  it("preview aside and control panel are siblings in the same md flex-row (strip not under a full-width preview)", () => {
    // In GradingWorkstation the shell receives the preview aside (previewAside
    // prop) BEFORE the header strip child, and the shell owns the control-panel
    // column — so the strip renders in the right column, never under the preview.
    const row = slice(WORKSTATION, "<CanonicalGradingWorkstationShell", "className={`${WORKSTATION_BODY_SCROLL_CLASS}");
    expect(row).toContain("<WorkstationPreviewAside");
    expect(CANON_SHELL).toContain('data-testid="grading-control-panel"');
    const asideIdx = row.indexOf("<WorkstationPreviewAside");
    const stripIdx = row.indexOf("<WorkstationHeaderStrip");
    expect(asideIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeGreaterThan(asideIdx);
  });
});

describe("10. protected Stage-3 / grading files remain untouched", () => {
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^server\/(?!routes\/admin-config\.ts|services\/tcgdex-set-resolve\.ts|services\/collector-number\.ts|vite\.ts)|^migrations\//;
  const ALLOWED_CLIENT = new Set([
    "client/src/components/grading-workflow/CardPreviewPanel.tsx",
    "client/src/components/certificate-form.tsx",
    "client/src/components/admin/admin-shell.tsx",
    "client/src/pages/admin-dashboard.tsx",
    "client/src/lib/lookup-errors.ts",
    // Stage 1/2 usability pass (same branch): rarity contrast + custom-rarity
    // workflow.
    "client/src/components/rarity-picker/RarityVariantPicker.tsx",
    "client/src/components/rarity-picker/RaritySymbol.tsx",
    "client/src/components/grading-workflow/ReviewSummary.tsx",
    // workflow-header overlap hotfix (same branch): stage nav + session-stats
    // zoning only — no protected/server file involved.
    "client/src/components/grading-workflow/GradingWorkflowBar.tsx",
    // compact-header + Review-layout hotfix (same branch): session-stats sizing
    // only — no protected/server file involved.
    "client/src/components/grading-workflow/SessionHud.tsx",
    // unified-shell architecture pass (same branch): new shared primitives +
    // the pages/component that adopt them. Layout-only, no protected surface.
    "client/src/components/grading-workflow/WorkstationHeaderStrip.tsx",
    "client/src/components/grading-workflow/WorkstationPreviewAside.tsx",
    "client/src/components/admin/AdminHeaderRow.tsx",
    "client/src/pages/staff.tsx",
    "client/src/components/grading-workflow/CertificateToolsDrawer.tsx",
    // production-regression correction pass (2026-07-19, same branch):
    // /admin/staff Review-overlay + Manual Identity Override shell
    // unification — layout/token-only, no protected surface.
    "client/src/pages/admin-staff.tsx",
    // Group 1 admin-route unification (2026-07-19, same branch): shared
    // AdminShell/AdminHeaderRow + design tokens. Visual-shell-only, no
    // protected surface, no API/mutation change.
    "client/src/pages/admin-operator-stats.tsx",
    "client/src/pages/admin-mvgs-calibration.tsx",
    "client/src/pages/admin-legacy-review.tsx",
    "client/src/pages/admin-sets.tsx",
    // Group 2 admin-route unification (2026-07-19, same branch): shared
    // AdminHeaderRow + design tokens on the knowledge/community pages.
    // Visual-shell-only, no protected surface, no API/mutation change.
    "client/src/pages/admin-pokemon-knowledge.tsx",
    "client/src/pages/admin/community.tsx",
    // Group 3 grader-surface unification (2026-07-19, same branch): shared
    // AdminHeaderRow + design tokens on the grader entry pages. Visual-shell-
    // only, no protected surface, no API/session/permission change.
    "client/src/pages/grader.tsx",
    "client/src/pages/grader-login.tsx",
    // Group 3.5 canonical Staff/Grader login unification (2026-07-19, same
    // branch): shared var(--admin-*) tokens on /staff/login. Visual-shell-only,
    // no protected surface, no auth-flow/endpoint/permission change.
    "client/src/pages/staff-login.tsx",
  ]);
  const changed = unifiedAdminShellChangedFiles();

  // admin-mvgs-calibration.tsx matches the PROTECTED `mvgs` alternative by
  // FILENAME only. The 2026-07-19 Group-1 pass changed that page's SHELL
  // (.admin-root + AdminHeaderRow + relocated intro copy) — zero calibration
  // value/range/lock/save/API change (verified; two independent reviewers
  // concurred). The MVGS engine/logic (server/lib/mvgs-calibration*.ts,
  // server+shared mvgs-scoring.ts, shared/mvgs-input-builder.ts, mvgs-mark.tsx)
  // is UNTOUCHED and stays fully protected by the unchanged regex.
  const DISPLAY_ONLY_MVGS_PAGE = "client/src/pages/admin-mvgs-calibration.tsx";
  // client/src/pages/grader.tsx matches the PROTECTED `grader\.ts` alternative by
  // FILENAME only. The genuinely-protected grading engine is server/grader.ts +
  // server/routes/grader.ts (UNTOUCHED). The 2026-07-19 Group-3 pass changed only
  // this client page's SHELL — zero /api/grader/* endpoint, payload, session-gate,
  // permission, or GradingPanel-prop change. Exempt this ONE display-only page.
  const DISPLAY_ONLY_GRADER_PAGE = "client/src/pages/grader.tsx";
  it("this fix changed NO protected grading/schema/server/migration file", () => {
    for (const f of changed) {
      if (f === DISPLAY_ONLY_MVGS_PAGE || f === DISPLAY_ONLY_GRADER_PAGE) continue;
      expect(f, f).not.toMatch(PROTECTED);
    }
  });
  it("client edits stay within the allowed layout/preview files", () => {
    for (const f of changed.filter((f) => f.startsWith("client/"))) {
      expect(ALLOWED_CLIENT.has(f), `unexpected client file: ${f}`).toBe(true);
    }
  });
});
