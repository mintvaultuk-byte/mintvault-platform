/**
 * Production hotfix: workflow header overlap.
 *
 * At the real 13" laptop viewport, the combined workstation strip (4-stage
 * workflow nav + queue/session stats) shared a single flex-wrap row and relied
 * on text truncation alone to fit. Two bugs compounded:
 *   1. The workflow nav's <nav> and its stage <button>s were flex-1 items with
 *      NO min-width: 0, so they could never actually shrink/truncate below their
 *      intrinsic content width — the nav silently overflowed its allotted space.
 *   2. That overflow (default overflow: visible) rendered on top of the
 *      session-stats zone laid out immediately after it in the same row —
 *      stage labels, the session timer, completed count and cards/hour all
 *      visually collided.
 *
 * Fix: the workflow nav and the session-stats zone are now two EXPLICIT zones
 * (separate containers, `min-w-0` all the way down the nav so it can actually
 * shrink/truncate/scroll instead of overflow, and the strip stacks as two full
 * rows below 2xl — only sitting side-by-side once there's genuinely enough
 * width). No absolute positioning, no negative margins, no shared grid column
 * that could let one zone bleed into the other.
 *
 * Source-assertion style (matches the sibling grading test files — the admin
 * grading form is auth-gated). Zero provider calls, zero DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");
// unified-shell pass: the workstation-strip markup was extracted into its own
// shared component (WorkstationHeaderStrip) so every stage renders it from
// ONE source instead of an inline block inside certificate-form.tsx. All the
// strip-geometry assertions below now target that component's source.
const STRIP = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");

function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("all four workflow stages render with labels intact", () => {
  it("GRADING_STAGES (imported from the shared workflow contract) drives every stage button", () => {
    expect(BAR).toContain("GRADING_STAGES.map((stage, i)");
    expect(BAR).toContain("data-testid={`workflow-stage-${stage.key}`}");
    const shared = read("shared/grading-workflow.ts");
    const stagesArray = shared.slice(shared.indexOf("export const GRADING_STAGES"), shared.indexOf("export type StageStatus"));
    const stageCount = (stagesArray.match(/\{\s*key:\s*"/g) ?? []).length;
    expect(stageCount).toBe(4);
  });
  it("stage label renders; sublabel is available via the tooltip only (compact hotfix removed the visible second line)", () => {
    expect(BAR).toContain("{stage.label}");
    // the sublabel is still passed to `title` (hover tooltip) so the fuller
    // description isn't lost, but it is no longer rendered as a visible span —
    // that second line forced a two-line button height at exactly the xl
    // breakpoint a 13" laptop viewport crosses.
    expect(BAR).toContain("stage.label} — ${stage.sublabel}");
    expect(BAR).not.toMatch(/<span[^>]*>\s*\{stage\.sublabel\}/);
  });
});

describe("workflow navigation and session statistics are two SEPARATE containers (spec)", () => {
  it("the nav zone and the stats zone are distinct data-testid'd containers inside the strip", () => {
    expect(STRIP).toContain('data-testid="workflow-nav-zone"');
    expect(STRIP).toContain('data-testid="batch-header"');
    // the nav zone appears before the stats zone in source order.
    expect(STRIP.indexOf('data-testid="workflow-nav-zone"')).toBeLessThan(STRIP.indexOf('data-testid="batch-header"'));
  });
  it("the workflow bar lives inside the nav zone, and SessionHud lives inside the stats zone (not mixed)", () => {
    const navZone = slice(STRIP, 'data-testid="workflow-nav-zone"', 'data-testid="batch-header"');
    expect(navZone).toContain("<GradingWorkflowBar embedded");
    expect(navZone).not.toContain("<SessionHud");
    const statsZone = STRIP.slice(STRIP.indexOf('data-testid="batch-header"'));
    expect(statsZone).toContain("<SessionHud embedded");
    expect(statsZone).not.toContain("<GradingWorkflowBar");
  });
});

describe("no overlap mechanism (absolute positioning / negative margins / z-index stacking)", () => {
  it("no element in the strip uses className=\"...absolute...\" or a z-index utility", () => {
    // Checked as actual class TOKENS (not the explanatory comment prose above
    // the strip, which legitimately uses the word "absolute" in English).
    expect(STRIP).not.toMatch(/className="[^"]*\babsolute\b[^"]*"/);
    expect(STRIP).not.toMatch(/className="[^"]*\bz-\d[^"]*"/);
  });
  it("the workflow bar itself never uses absolute positioning to lay out stages", () => {
    expect(BAR).not.toMatch(/className=\{?"[^"]*\babsolute\b/);
  });
});

describe("responsive rules move statistics below/beside the nav explicitly (not squeeze-to-fit)", () => {
  it("the strip stacks as two full rows by default and only sits side-by-side at 2xl+", () => {
    // gap tightened further by the later compact-header hotfix (gap-1.5 -> gap-1)
    // — the two-row/2xl-side-by-side structure itself is what this guards.
    expect(STRIP).toMatch(/className="flex flex-col gap-1[^"]*2xl:flex-row[^"]*"/);
  });
  it("the stats zone never grows to compete with the nav zone at the wide breakpoint (shrink-0)", () => {
    expect(STRIP).toMatch(/className="[^"]*2xl:shrink-0[^"]*"\s+data-testid="batch-header"/);
  });
  it("the nav zone can actually shrink (min-w-0) instead of overflowing into the stats zone", () => {
    const navZoneOpenTag = STRIP.slice(
      STRIP.indexOf('data-testid="workflow-nav-zone"') - 80,
      STRIP.indexOf('data-testid="workflow-nav-zone"')
    );
    expect(navZoneOpenTag).toContain("min-w-0");
  });
});

describe("the workflow bar can genuinely shrink/scroll instead of silently overflowing (root cause fix)", () => {
  it("the <nav> has min-w-0 so it isn't held to its content's intrinsic width by its flex-1 parent", () => {
    const navTag = BAR.slice(BAR.indexOf("<nav"), BAR.indexOf(">", BAR.indexOf("<nav")) + 1);
    expect(navTag).toContain("min-w-0");
    // horizontal overflow becomes a scroll, never a silent visual bleed, on the
    // rare width where even truncated labels don't fit.
    expect(navTag).toContain("overflow-x-auto");
  });
  it("each stage button has min-w-0 so flex-1 + truncate actually shrinks it (not held to content width)", () => {
    const classIdx = BAR.indexOf("className={`flex");
    expect(classIdx).toBeGreaterThan(-1);
    const buttonClass = BAR.slice(classIdx, BAR.indexOf("${", classIdx));
    expect(buttonClass).toContain("min-w-0");
  });
});

describe("active stage and completed-stage styling preserved", () => {
  it("current stage keeps its gold border/background; completed keeps its tick + gold-tinted style", () => {
    expect(BAR).toContain("border border-[var(--admin-gold)] bg-[var(--admin-gold)]/15");
    expect(BAR).toContain("border border-[var(--admin-gold)]/30 bg-[var(--admin-gold)]/5");
    expect(BAR).toContain("<Check size={13} strokeWidth={3} />");
    expect(BAR).toContain('aria-current={isCurrent ? "step" : undefined}');
  });
});

describe("protected boundary: only the workflow header + this test changed", () => {
  // Pinned to the FIXED historical range of the header-overlap hotfix itself
  // (bcf74e25 -> ceea57a5, its functional commit), not "...HEAD" — later
  // hotfixes stack additional commits on top (e.g. the compact-header pass),
  // which is expected and must not falsely trip this guard.
  const base = "bcf74e25";
  const head = "ceea57a5";
  let changed: string[] = [];
  try {
    execSync(`git rev-parse --verify ${base}`, { stdio: "pipe" });
    execSync(`git rev-parse --verify ${head}`, { stdio: "pipe" });
    changed = execSync(`git diff --name-only ${base}..${head}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    changed = [];
  }
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\/|partner|^server\//;
  const ALLOWED = new Set([
    "client/src/components/certificate-form.tsx",
    "client/src/components/grading-workflow/GradingWorkflowBar.tsx",
  ]);

  it("no protected/partner-network/schema/migration/server file changed", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
  it("no rarity-picker SOURCE file was touched by this pass (that hotfix stays as-is)", () => {
    if (changed.length === 0) return;
    // Scoped to the source directory only — test files that happen to mention
    // "rarity-picker" in their own name (e.g. a stale-assertion fix to
    // grading-rarity-picker-hotfix.test.ts, made in the same branch) are not
    // a violation of this boundary.
    for (const f of changed) expect(f).not.toMatch(/^client\/src\/components\/rarity-picker\//);
  });
  it("every non-test change is exactly the workflow header files", () => {
    if (changed.length === 0) return;
    for (const f of changed.filter((f) => !f.startsWith("tests/"))) {
      expect(ALLOWED.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
});
