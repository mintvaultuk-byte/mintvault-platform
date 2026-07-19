/**
 * Regression coverage for the two production grading-workstation layout defects:
 *
 *   1. Card/Rarity read-only preview zoom must step by 75 percentage points —
 *      100 → 175 → 250 → 325 → 400 (max 400%, min 100%), button-only, wheel never
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
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PREVIEW = read("client/src/components/grading-workflow/CardPreviewPanel.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const SHELL = read("client/src/components/admin/admin-shell.tsx");

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

describe("1-4. button-only zoom steps 100 → 175 → 250 → 325 → 400", () => {
  it("zoom levels are exactly 100, 175, 250, 325, 400 percent", () => {
    expect(ladder().map(pct)).toEqual([100, 175, 250, 325, 400]);
    // 75 percentage points per click.
    expect(pct(MIN + STEP)).toBe(175);
  });
  it("zoom never exceeds 400%", () => {
    expect(pct(MAX)).toBe(400);
    // stepping up from the top clamps, never overshoots.
    expect(pct(clamp(MAX + STEP))).toBe(400);
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
    expect(reset).toContain("setZoom(1)");
    expect(reset).toContain("setPan({ x: 0, y: 0 })");
  });
  it("the zoom read-out is Math.round(zoom * 100) — so it prints 100/175/250/325/400", () => {
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
    expect(FORM).toContain("flex min-h-0 flex-1 flex-col gap-3 md:flex-row");
    // unified-shell pass: the column-ratio class now lives in the shared
    // WorkstationPreviewAside component.
    const asideSrc = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
    expect(asideSrc).toContain("md:w-[40%] md:shrink-0");
    // the old lg-only breakpoint (which collapsed below 1024px) is gone.
    expect(FORM).not.toContain("gap-3 lg:flex-row");
  });
  it("the workstation is viewport-bounded at desktop (not an unbounded h-full chain)", () => {
    expect(FORM).toContain("md:h-[calc(100dvh-4.5rem)]");
  });
});

describe("7. the right controls column has accessible vertical overflow where required", () => {
  it("the control-panel form scrolls internally (min-h-0 flex-1 + overflow-y-auto)", () => {
    const controlPanel = slice(FORM, 'data-testid="grading-control-panel"', "</form>");
    expect(controlPanel).toContain("overflow-y-auto");
    expect(controlPanel).toContain("min-h-0 flex-1");
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
    const workspace = slice(FORM, 'data-testid="grading-workspace"', 'data-testid="grading-control-panel"');
    expect(workspace).not.toContain("overflow-hidden");
  });
});

describe("9. the workflow strip is in the controls column, not beneath the preview", () => {
  it("WorkstationHeaderStrip (with the embedded workflow bar) lives inside the control panel header", () => {
    const controlHeader = slice(FORM, 'data-testid="grading-control-panel"', "onSubmit={handleSubmit}");
    expect(controlHeader).toContain("<WorkstationHeaderStrip");
    const stripSrc = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
    expect(stripSrc).toContain('data-testid="workstation-strip"');
    expect(stripSrc).toContain("<GradingWorkflowBar embedded");
  });
  it("preview aside and control panel are siblings in the same md flex-row (strip not under a full-width preview)", () => {
    const row = slice(FORM, "flex min-h-0 flex-1 flex-col gap-3 md:flex-row", "onSubmit={handleSubmit}");
    expect(row).toContain("<WorkstationPreviewAside");
    expect(row).toContain('data-testid="grading-control-panel"');
    // the strip sits AFTER the control-panel opening — i.e. in the right column,
    // not above/under both columns.
    const asideIdx = row.indexOf("<WorkstationPreviewAside");
    const panelIdx = row.indexOf('data-testid="grading-control-panel"');
    const stripIdx = row.indexOf("<WorkstationHeaderStrip");
    expect(asideIdx).toBeGreaterThan(-1);
    expect(panelIdx).toBeGreaterThan(asideIdx);
    expect(stripIdx).toBeGreaterThan(panelIdx);
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
  ]);
  const base = ["origin/main", "main"].find((r) => {
    try {
      execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  const changed = base
    ? execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    : [];

  it("this fix changed NO protected grading/schema/server/migration file", () => {
    if (!base) return;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
  it("client edits stay within the allowed layout/preview files", () => {
    if (!base) return;
    for (const f of changed.filter((f) => f.startsWith("client/"))) {
      expect(ALLOWED_CLIENT.has(f), `unexpected client file: ${f}`).toBe(true);
    }
  });
});
