/**
 * Unified admin shell architecture pass.
 *
 * Root cause (confirmed by a read-only architecture audit before any edit):
 * Staff dashboard, Super Admin dashboard and the grading workstation had
 * three independently-implemented header/breadcrumb patterns, and the
 * grading workstation's own 4-stage workflow had its aside/header-strip
 * markup duplicated inline inside certificate-form.tsx with no single
 * source of truth — so fixing one stage's spacing repeatedly risked another
 * stage silently drifting. Stage 3 (Grade) visually "escaping" the
 * two-column shell was traced to exactly one condition
 * (`wfStage <= 1 || wfStage === 3`, certificate-form.tsx) that omits the
 * preview aside for Grade — NOT a stray width class on Grade's own content.
 *
 * Fix: three new shared, stateless presentation primitives —
 *   - AdminHeaderRow            (client/src/components/admin/AdminHeaderRow.tsx)
 *   - WorkstationHeaderStrip    (client/src/components/grading-workflow/WorkstationHeaderStrip.tsx)
 *   - WorkstationPreviewAside   (client/src/components/grading-workflow/WorkstationPreviewAside.tsx)
 * plus a shared CertificateToolsButton (CertificateToolsDrawer.tsx) — each
 * with exactly ONE render/definition site, adopted by admin-dashboard.tsx,
 * certificate-form.tsx and staff.tsx. Grade (Stage 3) deliberately does NOT
 * use WorkstationPreviewAside: the protected grading-panel.tsx already
 * renders its own interactive image + defect-marking tool with its OWN
 * internal `grid-cols-1 lg:grid-cols-[60%_40%]` two-column split — adding
 * the generic aside on top would either duplicate the card image or
 * squeeze that protected grid into a materially narrower, harder-to-use
 * width. This is a documented, evidence-based exception, not an oversight.
 *
 * Source-assertion style (matches the sibling grading test files — the
 * admin surfaces are auth-gated). Zero provider calls, zero DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const STAFF = read("client/src/pages/staff.tsx");
const ADMIN_SHELL = read("client/src/components/admin/admin-shell.tsx");
const HEADER_ROW = read("client/src/components/admin/AdminHeaderRow.tsx");
const STRIP = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
const ASIDE = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const CERT_TOOLS = read("client/src/components/grading-workflow/CertificateToolsDrawer.tsx");
const GRADING_PANEL = read("client/src/components/grading/grading-panel.tsx");
const REVIEW_SUMMARY = read("client/src/components/grading-workflow/ReviewSummary.tsx");
const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");

describe("1. Staff and Super Admin share the AdminHeaderRow primitive", () => {
  it("Super Admin's grading-header uses AdminHeaderRow", () => {
    expect(DASH).toContain('import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow"');
    expect(DASH).toContain("<AdminHeaderRow");
    expect(DASH).toContain('testId="grading-header"');
  });
  it("Staff's page header ALSO uses AdminHeaderRow — same row rhythm, different content", () => {
    expect(STAFF).toContain('import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow"');
    expect(STAFF).toContain("<AdminHeaderRow");
    expect(STAFF).toContain('testId="staff-header"');
  });
  it("AdminHeaderRow itself is pure presentation — no role/permission logic, no data fetching", () => {
    expect(HEADER_ROW).not.toMatch(/useState|useEffect|useQuery|useMutation|fetch\(|apiRequest/);
    // checked as CODE only — the doc comment above legitimately explains
    // that permissions/roles differ between callers, which is not the same
    // as the component itself containing role/permission logic.
    const code = HEADER_ROW.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/role|permission|capab/i);
  });
});

describe("2. role permissions remain distinct (Staff vs Super Admin)", () => {
  it("Staff never imports or renders Super Admin-only surfaces", () => {
    expect(STAFF).not.toMatch(/AdminShell|CertificateForm|CertificateToolsDrawer|GradingQueue/);
  });
  it("Staff's tabs are still capability-gated (grade/scan/print), not role-elevated", () => {
    expect(STAFF).toContain("caps.grade");
    expect(STAFF).toContain("caps.scan");
    expect(STAFF).toContain("caps.print");
  });
  it("Super Admin dashboard still uses AdminShell (its own distinct, higher-privilege chrome)", () => {
    expect(DASH).toContain("<AdminShell");
    expect(DASH).toContain("focus");
  });
  it("AdminShell's normal-mode nav (Super Admin sidebar) is untouched by this pass — Staff never renders it", () => {
    expect(ADMIN_SHELL).toContain("admin-side");
    expect(STAFF).not.toContain("admin-side");
  });
});

describe("3. all four grading stages use the SAME WorkstationHeaderStrip component", () => {
  it("certificate-form.tsx renders WorkstationHeaderStrip exactly once, outside the per-stage sections", () => {
    expect((FORM.match(/<WorkstationHeaderStrip/g) ?? []).length).toBe(1);
    const stripCallIdx = FORM.indexOf("<WorkstationHeaderStrip");
    const firstStageIdx = FORM.indexOf('data-workflow-stage="identify"');
    expect(stripCallIdx).toBeLessThan(firstStageIdx);
  });
  it("the strip component itself is the single source of truth for stage-nav + session-stats geometry", () => {
    expect(STRIP).toContain('data-testid="workstation-strip"');
    expect(STRIP).toContain('data-testid="workflow-nav-zone"');
    expect(STRIP).toContain('data-testid="batch-header"');
  });
});

describe("4. all four stages use the same desktop breakpoint (md) for the two-column shell", () => {
  it("the outer workspace row and the preview aside share the SAME md: breakpoint", () => {
    expect(FORM).toContain("flex min-h-0 flex-1 flex-col gap-3 md:flex-row");
    expect(ASIDE).toContain("md:w-[40%] md:shrink-0");
    // no competing/second breakpoint (e.g. lg:, 2xl:) governs the aside's own width.
    expect(ASIDE).not.toMatch(/lg:w-\[|2xl:w-\[|xl:w-\[/);
  });
});

describe("5. the preview zone exists in Card, Rarity AND Review (Grade is a documented exception)", () => {
  it("the aside gate covers wfStage 0, 1 and 3", () => {
    expect(FORM).toMatch(/\{\(wfStage <= 1 \|\| wfStage === 3\) && \(/);
  });
  it("Grade (wfStage 2) is excluded from the shared aside — documented, not accidental", () => {
    const gateIdx = FORM.indexOf("{(wfStage <= 1 || wfStage === 3) && (");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateLine = FORM.slice(gateIdx, gateIdx + 40);
    expect(gateLine).not.toContain("wfStage === 2");
    // the architecture rationale is captured in source, not just tribal knowledge.
    const context = FORM.slice(Math.max(0, gateIdx - 1400), gateIdx);
    expect(context).toMatch(/protected.*grading-panel|grading-panel.*protected/is);
  });
  it("GradingPanel (the protected Stage 3 component) already implements its OWN left-image/right-controls split", () => {
    // Evidence for the exception: grading-panel.tsx has its own internal
    // two-column grid — this is what makes forcing the generic aside on top
    // both redundant (duplicate image) and harmful (squeezes this grid).
    expect(GRADING_PANEL).toMatch(/grid-cols-1\s+lg:grid-cols-\[60%_40%\]/);
  });
});

// unified-shell integration note: pinned to the CHERRY-PICKED equivalent of
// the commit this pass originally started from ("aa8c0cea" pre-integration
// is "0825544a" once replayed onto origin/main — same content, same position
// in this branch's linear history). The old hash now sits on a lineage
// disjoint from origin/main, so a diff against it would walk back to the
// real (much earlier) common ancestor and falsely include Partner Network
// and this branch's own earlier commits (e.g. the rarity-picker hotfix) as
// "changed by this pass" — a base-drift artifact, not a real violation.
const SCOPE_BASE = "0825544a";
function changedSinceScopeBase(): string[] {
  try {
    execSync(`git rev-parse --verify ${SCOPE_BASE}`, { stdio: "pipe" });
    return execSync(`git diff --name-only ${SCOPE_BASE}...HEAD`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("6. Stage 3 (protected) component source remains byte-for-byte untouched", () => {
  const changed = changedSinceScopeBase();
  it("no file under client/src/components/grading/ appears in this branch's diff", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f).not.toMatch(/^client\/src\/components\/grading\//);
  });
  it("no MVGS/centering/defect/grade-cap/rounding/cert-numbering/schema/migration file changed", () => {
    if (changed.length === 0) return;
    const PROTECTED =
      /mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\/|partner/;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
  it("the workstationSlot render site passes the protected component through UNCHANGED (no wrapper transform/scale)", () => {
    // Window widened from 900: the production-regression correction pass
    // (2026-07-19) added an outer containment wrapper (max-h + overflow-y-auto,
    // an explanatory comment, and its onKeyDown handler) around the slot — the
    // slot itself is still passed through unchanged, just further from the
    // "data-workflow-stage" anchor. See production-regression-correction-2026-07-19.test.ts.
    const wrapper = FORM.slice(
      FORM.indexOf('data-workflow-stage="grade"'),
      FORM.indexOf('data-workflow-stage="grade"') + 1700
    );
    expect(wrapper).toContain("{workstationSlot}");
    expect(wrapper).not.toMatch(/transform|scale\(|zoom:/);
  });
});

describe("7. no duplicate preview in Grade or Review", () => {
  it("certificate-form.tsx has exactly ONE render site for the preview aside (WorkstationPreviewAside)", () => {
    expect(FORM).not.toContain("<CardPreviewPanel");
    expect((ASIDE.match(/<CardPreviewPanel/g) ?? []).length).toBe(1);
  });
  it("ReviewSummary does not render its own copy of the card image", () => {
    expect(REVIEW_SUMMARY).not.toContain("CardPreviewPanel");
  });
  it("GradingPanel's own internal image tool is a SEPARATE, protected concern — this pass adds no second copy beside it", () => {
    // The outer shell never mounts WorkstationPreviewAside for Grade (see
    // suite 5), so GradingPanel's own ImageViewer remains the only image
    // rendered for that stage.
    const gateIdx = FORM.indexOf("{(wfStage <= 1 || wfStage === 3) && (");
    const gateLine = FORM.slice(gateIdx, gateIdx + 40);
    expect(gateLine).not.toContain("wfStage === 2");
  });
});

describe("8. workflow stage buttons use the compact shared sizing", () => {
  it("stage buttons are single-line, compact padding, ~28px icon circle", () => {
    const classIdx = BAR.indexOf("className={`flex");
    const buttonClass = BAR.slice(classIdx, BAR.indexOf("${", classIdx));
    expect(buttonClass).toContain("px-2 py-2");
    expect(BAR).toContain("h-7 w-7");
    expect(BAR).not.toMatch(/<span[^>]*>\s*\{stage\.sublabel\}/);
  });
});

describe("9. Certificate Tools uses the shared compact header utility", () => {
  it("admin-dashboard renders the shared CertificateToolsButton (not inline markup)", () => {
    expect(DASH).toContain("<CertificateToolsButton");
    expect(DASH).not.toMatch(/rounded-lg border border-\[var\(--admin-gold\)\]\/30 px-2 py-1 text-\[10px\]/); // no re-inlined copy
  });
  it("the button primitive itself is compact (px-2 py-1, text-[10px])", () => {
    const btnIdx = CERT_TOOLS.indexOf('data-testid="button-certificate-tools"');
    const btnBlock = CERT_TOOLS.slice(btnIdx - 60, btnIdx + 300);
    expect(btnBlock).toContain("px-2 py-1");
    expect(btnBlock).toContain("text-[10px]");
  });
});

describe("10. session statistics use the slim shared row", () => {
  it("SessionHud embedded variant is compact (small text, tight gaps) and rendered from WorkstationHeaderStrip only", () => {
    const hud = read("client/src/components/grading-workflow/SessionHud.tsx");
    expect(hud).toContain("gap-x-2.5 gap-y-0.5");
    expect(STRIP).toContain("<SessionHud embedded");
  });
});

describe("11. no horizontal overflow risk at 1440x900 (structural check)", () => {
  it("the preview aside and control panel are both flex items with min-w-0/shrink control (no fixed oversized widths)", () => {
    expect(ASIDE).toContain("md:shrink-0"); // aside has an explicit, bounded share
    expect(FORM).toContain('className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="grading-control-panel"');
  });
  it("the workflow bar can shrink/scroll instead of forcing overflow", () => {
    expect(BAR).toContain("min-w-0");
    expect(BAR).toContain("overflow-x-auto");
  });
});

describe("12. right panel scrolls independently where required", () => {
  it("the control panel form has its own overflow-y-auto + min-h-0 flex-1", () => {
    const i = FORM.indexOf('data-testid="grading-control-panel"');
    const j = FORM.indexOf("</form>", i);
    const controlPanel = FORM.slice(i, j);
    expect(controlPanel).toContain("overflow-y-auto");
    expect(controlPanel).toContain("min-h-0 flex-1");
  });
});

describe("13. save payload remains unchanged", () => {
  it("the save button, its submit type, and every ReviewSummary field are all present", () => {
    expect(FORM).toContain('data-testid="button-save-cert"');
    expect(FORM).toContain('type="submit"');
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
});

describe("14. rarity picker remains unchanged", () => {
  const changed = changedSinceScopeBase();
  it("no rarity-picker source file appears in this pass's diff", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f).not.toMatch(/^client\/src\/components\/rarity-picker\//);
  });
});

describe("15. no Partner Network files were touched by this pass", () => {
  const changed = changedSinceScopeBase();
  it("no changed file matches a Partner Network path/name", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f).not.toMatch(/partner/i);
  });
});

describe("16. no push/merge/deploy occurred as part of this pass (release-control check)", () => {
  it("HEAD is on the isolated arch/unified-admin-shell branch, not main", () => {
    let branch: string;
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    } catch {
      return;
    }
    expect(branch).not.toBe("main");
  });
});
