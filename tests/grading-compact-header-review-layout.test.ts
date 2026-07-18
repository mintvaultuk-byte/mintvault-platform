/**
 * Production hotfix: compact workstation chrome + restore the two-column
 * Review workstation.
 *
 * Two production problems, both layout-only:
 *   1. The top area (stage buttons, session stats, Certificate Tools) was too
 *      tall/bulky at a real 13" laptop viewport — the stage buttons' sublabel
 *      forced a two-line button at exactly the xl breakpoint (>=1280px) that a
 *      13" laptop crosses, and Certificate Tools/session-stats used
 *      dashboard-card-sized padding instead of a slim utility row.
 *   2. Stage 4 Review had NO preview aside at all (the aside only rendered for
 *      wfStage <= 1), so the control panel stretched to the full page width —
 *      a long single-column page instead of the approved card-left/details-
 *      right workstation used by Card and Rarity.
 *
 * Source-assertion style (matches the sibling grading test files — the admin
 * grading form is auth-gated). Zero provider calls, zero DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");
const HUD = read("client/src/components/grading-workflow/SessionHud.tsx");
const SUMMARY = read("client/src/components/grading-workflow/ReviewSummary.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");

function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("1. compact stage buttons (no more two-line dashboard cards)", () => {
  it("padding and icon-circle size are reduced from the previous oversized dimensions", () => {
    const buttonClassIdx = BAR.indexOf("className={`flex");
    const buttonClass = BAR.slice(buttonClassIdx, BAR.indexOf("${", buttonClassIdx));
    expect(buttonClass).toContain("px-2 py-2");
    expect(buttonClass).not.toContain("px-2.5 py-1.5"); // old oversized padding gone
    expect(BAR).toContain("h-7 w-7"); // compact ~28px number/check circle
    expect(BAR).not.toContain("h-6 w-6"); // confirms this is a deliberate resize, not a stray duplicate
  });
  it("the secondary sublabel line is gone — single-line label only", () => {
    expect(BAR).not.toMatch(/<span[^>]*>\s*\{stage\.sublabel\}/);
    expect(BAR).not.toContain("xl:block"); // the breakpoint that used to reveal it
  });
  it("all four stages are still labelled and click targets remain a real <button>", () => {
    expect(BAR).toContain("GRADING_STAGES.map((stage, i)");
    expect(BAR).toContain("<button");
    expect(BAR).toContain("{stage.label}");
  });
  it("active and completed stage styling is preserved", () => {
    expect(BAR).toContain("border border-[var(--admin-gold)] bg-[var(--admin-gold)]/15");
    expect(BAR).toContain("bg-[var(--admin-gold)] text-[#1A1400]");
    expect(BAR).toContain("<Check size={13} strokeWidth={3} />");
  });
});

describe("2. session statistics render as a slim utility row", () => {
  it("SessionHud stat rows use reduced font size and spacing", () => {
    const statBlock = slice(HUD, "const Stat = (", "return (");
    expect(statBlock).toContain("text-[8px]"); // label
    expect(statBlock).toContain("text-[10px]"); // value
    expect(statBlock).not.toContain("text-[9px] uppercase"); // old label size gone
  });
  it("the embedded statistics row stays visually secondary (small text, tight gaps)", () => {
    expect(HUD).toContain("gap-x-2.5 gap-y-0.5");
  });
  it("statistics render in their own container, separate from the stage-nav container (spec)", () => {
    const stripBlock = slice(FORM, "Combined workstation header strip", "identification-tools");
    expect(stripBlock).toContain('data-testid="workflow-nav-zone"');
    expect(stripBlock).toContain('data-testid="batch-header"');
    expect(stripBlock.indexOf('data-testid="workflow-nav-zone"')).toBeLessThan(stripBlock.indexOf('data-testid="batch-header"'));
  });
});

describe("3. Certificate Tools is a compact utility control, not a large isolated pill", () => {
  it("uses reduced padding/text-size classes", () => {
    const btnIdx = DASH.indexOf('data-testid="button-certificate-tools"');
    const btnBlock = DASH.slice(btnIdx - 40, btnIdx + 400);
    expect(btnBlock).toContain("px-2 py-1");
    expect(btnBlock).not.toContain("px-3 py-1.5"); // old larger padding gone
    expect(btnBlock).toContain("text-[10px]");
  });
  it("stays in the same breadcrumb row as Certificates / cert-id (not a separate tall row)", () => {
    const header = slice(DASH, 'data-testid="grading-header"', "</div>\n          </div>");
    expect(header).toContain("button-back-list");
    expect(header).toContain('data-testid="grading-header-cert"');
    expect(header).toContain('data-testid="button-certificate-tools"');
  });
  it("ownership/link status text is retained (function unchanged)", () => {
    expect(DASH).toContain("certificateToolsStatus");
    expect(DASH).toContain("s.ownership");
    expect(DASH).toContain("s.nfc");
  });
});

describe("4. Stage 4 Review restores the two-column workstation (card left, details right)", () => {
  it("the preview aside now also renders for Review (wfStage === 3), not just Card/Rarity", () => {
    expect(FORM).toMatch(/\{\(wfStage <= 1 \|\| wfStage === 3\) && \(/);
  });
  it("Grade (wfStage 2) is deliberately excluded — its own protected card/defect tool is untouched", () => {
    const cond = FORM.slice(FORM.indexOf("{(wfStage <= 1 || wfStage === 3) && ("), FORM.indexOf("{(wfStage <= 1 || wfStage === 3) && (") + 60);
    expect(cond).not.toContain("wfStage === 2");
  });
  it("preview and review-details are separate zones — no duplicated image", () => {
    // Exactly one CardPreviewPanel render in certificate-form.tsx (the shared aside).
    expect((FORM.match(/<CardPreviewPanel/g) ?? []).length).toBe(1);
    // ReviewSummary no longer imports or renders CardPreviewPanel at all.
    expect(SUMMARY).not.toContain("CardPreviewPanel");
  });
  it("ReviewSummary's own layout is now 2 columns (details/classification), not 3 (image+details+classification)", () => {
    expect(SUMMARY).toContain('className="grid gap-2 lg:grid-cols-2"');
    expect(SUMMARY).not.toMatch(/grid-cols-\[minmax\(150px/);
  });
  it("Review reuses the SAME responsive breakpoint as the approved Card/Rarity workstation (md, not an excessively wide 2xl)", () => {
    // The aside/control-panel row is `md:flex-row` — Review renders inside that
    // exact same row (same aside gate, same flex row), so it inherits the
    // identical md breakpoint rather than requiring a new one.
    expect(FORM).toContain("flex min-h-0 flex-1 flex-col gap-3 md:flex-row");
    expect(FORM).toContain("md:w-[40%] md:shrink-0");
  });
  it("mobile stacking remains supported (no md:/lg:-only mandatory two-column)", () => {
    // Base (mobile-first) classes are flex-col; md:flex-row only applies at
    // the md breakpoint and above, so below it the aside and control panel
    // stack vertically like Card/Rarity already do.
    expect(FORM).toMatch(/flex min-h-0 flex-1 flex-col gap-3 md:flex-row/);
  });
});

describe("5. no absolute-position overlap mechanism was introduced by this pass", () => {
  it("the strip, Certificate Tools row, and Review aside all use normal flow only", () => {
    const stripBlock = slice(FORM, "Combined workstation header strip", "identification-tools");
    expect(stripBlock).not.toMatch(/className="[^"]*\babsolute\b[^"]*"/);
    const headerBlock = slice(DASH, 'data-testid="grading-header"', "</div>\n          </div>");
    expect(headerBlock).not.toMatch(/className="[^"]*\babsolute\b[^"]*"/);
  });
});

describe("6. save payload and Review field content are unchanged", () => {
  it("ReviewSummary still receives every existing field — nothing added or removed from the save-adjacent values", () => {
    const block = FORM.slice(FORM.indexOf("<ReviewSummary"), FORM.indexOf("onEditGrade"));
    for (const f of [
      "form.cardName",
      "form.setName",
      "form.cardNumber",
      "form.year",
      "form.language",
      "form.rarityCode",
      "form.finishVariant",
      "form.promoType",
      "form.subsetName",
      "form.gradeOverall",
      "form.labelType",
      "form.status",
      "designations",
    ]) {
      expect(block, f).toContain(f);
    }
  });
  it("the save button and its handler are untouched", () => {
    expect(FORM).toContain('data-testid="button-save-cert"');
    expect(FORM).toContain("type=\"submit\"");
  });
  it("ReviewSummary itself still holds no state, triggers no save on entry", () => {
    const stripComments = (s: string) =>
      s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const code = stripComments(SUMMARY);
    expect(code).not.toMatch(/useState|useEffect|useQuery|useMutation|fetch\(|apiRequest|mutate|handleSubmit|autoSaveNow|setForm/);
  });
});

describe("7. protected boundary: Stage 3 internals and the rarity picker are untouched", () => {
  const base = "b0e2e374";
  let changed: string[] = [];
  try {
    execSync(`git rev-parse --verify ${base}`, { stdio: "pipe" });
    changed = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    changed = [];
  }
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\/|partner|^server\//;
  const ALLOWED = new Set([
    "client/src/components/certificate-form.tsx",
    "client/src/components/grading-workflow/GradingWorkflowBar.tsx",
    "client/src/components/grading-workflow/SessionHud.tsx",
    "client/src/components/grading-workflow/ReviewSummary.tsx",
    "client/src/pages/admin-dashboard.tsx",
  ]);

  it("no protected/partner-network/schema/migration/server file changed", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
  it("no rarity-picker SOURCE file was touched by this pass", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f).not.toMatch(/^client\/src\/components\/rarity-picker\//);
  });
  it("every non-test change is exactly the compact-header/Review-layout files", () => {
    if (changed.length === 0) return;
    for (const f of changed.filter((f) => !f.startsWith("tests/"))) {
      expect(ALLOWED.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
});
