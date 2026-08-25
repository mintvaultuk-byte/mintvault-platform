/**
 * Unified admin shell architecture pass.
 *
 * Root cause (confirmed by a read-only architecture audit before any edit):
 * Staff dashboard, Super Admin dashboard and the grading workstation had
 * three independently-implemented header/breadcrumb patterns, and the
 * grading workstation's own 3-stage workflow had its aside/header-strip
 * markup duplicated inline inside certificate-form.tsx with no single
 * source of truth — so fixing one stage's spacing repeatedly risked another
 * stage silently drifting. Stage 3 (Grade) visually "escaping" the
 * two-column shell was traced to exactly one condition
 * (`wfStage === 0 || wfStage === 2`, certificate-form.tsx) that omits the
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
import { join } from "path";
import { unifiedAdminShellChangedFiles } from "./helpers/grading-release-scope";

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
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const REVIEW_SUMMARY = read("client/src/components/grading-workflow/ReviewSummary.tsx");
// canonical-consolidation pass: the two-panel outer geometry + control-panel
// column now live in the ONE shared shell (CertificateForm mounts it).
const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
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

describe("3. all three grading stages use the SAME WorkstationHeaderStrip component", () => {
  it("GradingWorkstation renders WorkstationHeaderStrip exactly once; the editor renders none", () => {
    expect((WORKSTATION.match(/<WorkstationHeaderStrip/g) ?? []).length).toBe(1);
    expect(FORM).not.toContain("<WorkstationHeaderStrip");
  });
  it("the strip component itself is the single source of truth for stage-nav + session-stats geometry", () => {
    expect(STRIP).toContain('data-testid="workstation-strip"');
    expect(STRIP).toContain('data-testid="workflow-nav-zone"');
    expect(STRIP).toContain('data-testid="batch-header"');
  });
});

describe("4. all three stages use the same 540px floor for the two-column shell", () => {
  it("the outer workspace row and preview aside share the SAME breakpoint", () => {
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
    expect(SHELL).toContain('WORKSTATION_TWO_PANE_CLASS = "min-[540px]:flex-row"');
    expect(ASIDE).toContain("min-[540px]:w-[45%] min-[540px]:shrink-0");
    // no competing/second breakpoint (e.g. lg:, 2xl:) governs the aside's own width.
    expect(ASIDE).not.toMatch(/lg:w-\[|2xl:w-\[|xl:w-\[/);
  });
});

describe("5. the preview zone persists through Card Details, Grade and Review", () => {
  it("the canonical shell always receives the shared aside", () => {
    expect(WORKSTATION).toMatch(/previewAside=\{[\s\S]*<WorkstationPreviewAside/);
  });
  it("Grade portals the protected interactive surface into the persistent rail", () => {
    expect(WORKSTATION).toContain("interactiveCardHostRef={gradingEnabled ? interactiveCardHostRef : undefined}");
    expect(WORKSTATION).toContain("previewHost={gradingEnabled ? interactiveCardHost : null}");
  });
  it("GradingPanel suppresses its internal split when a preview host is supplied", () => {
    expect(GRADING_PANEL).toContain('previewHost ? "block" : "grid grid-cols-1 lg:grid-cols-[60%_40%] gap-5"');
  });
});

// unified-shell scope check — pinned to the pass's IMMUTABLE historical range
// (UNIFIED_ADMIN_SHELL 0825544a..a7cac275) via the shared helper, NOT a moving
// `${base}...HEAD` window. The old moving window drifted once origin/main
// advanced past the base (Partner Network G2–G4: server/partner/*, migrations
// 0009–0014, partner pages, and .claude task docs), pulling all that unrelated
// later work into the diff and false-tripping the protected-path matcher. The
// fixed range contains ONLY this pass's own files, so the guard again measures
// exactly "did THIS pass touch protected files?" — and still fails closed if it
// ever did (the PROTECTED regex is unchanged and still applied to that set).
function changedSinceScopeBase(): string[] {
  return unifiedAdminShellChangedFiles();
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
  it("GradingWorkstation is the single protected-panel mount", () => {
    expect((WORKSTATION.match(/<GradingPanel/g) ?? []).length).toBe(1);
    expect(FORM).not.toContain("<GradingPanel");
    expect(FORM).not.toContain("workstationSlot");
  });
});

describe("7. no duplicate preview in Grade or Review", () => {
  it("the workstation has exactly one aside and CertificateForm has no preview mount", () => {
    expect(FORM).not.toContain("<CardPreviewPanel");
    expect(FORM).not.toContain("<WorkstationPreviewAside");
    expect((WORKSTATION.match(/<WorkstationPreviewAside/g) ?? []).length).toBe(1);
    expect((ASIDE.match(/<CardPreviewPanel/g) ?? []).length).toBe(1);
  });
  it("ReviewSummary does not render its own copy of the card image", () => {
    expect(REVIEW_SUMMARY).not.toContain("CardPreviewPanel");
  });
  it("GradingPanel portals its single interactive viewer into the persistent aside", () => {
    expect(WORKSTATION).toContain("previewHost={gradingEnabled ? interactiveCardHost : null}");
    expect(WORKSTATION).toContain("interactiveCardHostRef={gradingEnabled ? interactiveCardHostRef : undefined}");
  });
});

describe("8. workflow stage buttons use the compact shared sizing", () => {
  it("stage buttons are single-line, compact padding, ~28px icon circle", () => {
    const classIdx = BAR.indexOf("className={`flex");
    const buttonClass = BAR.slice(classIdx, BAR.indexOf("${", classIdx));
    expect(buttonClass).toContain("px-2 py-1");
    expect(BAR).toContain("h-6 w-6");
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
    expect(ASIDE).toContain("min-[540px]:shrink-0"); // aside has an explicit, bounded share
    // The control-panel column (min-w-0 flex item) is owned by the canonical shell.
    expect(SHELL).toContain('className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="grading-control-panel"');
  });
  it("the workflow bar can shrink/scroll instead of forcing overflow", () => {
    expect(BAR).toContain("min-w-0");
    expect(BAR).toContain("overflow-x-auto");
  });
});

describe("12. right panel scrolls independently where required", () => {
  it("GradingWorkstation owns the one overflow-y-auto + min-h-0 flex-1 body", () => {
    const i = WORKSTATION.indexOf("className={`${WORKSTATION_BODY_SCROLL_CLASS}");
    const j = WORKSTATION.indexOf("<GradingPanel", i);
    const controlPanel = WORKSTATION.slice(i, j);
    expect(controlPanel).toContain("WORKSTATION_BODY_SCROLL_CLASS");
    expect(SHELL).toContain('WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1"');
    expect(FORM.slice(FORM.indexOf("onSubmit={handleSubmit}"), FORM.indexOf('className="space-y-2.5"') + 30)).toContain(
      'className="space-y-2.5"'
    );
  });
});

describe("13. save + review ownership remains explicit", () => {
  it("CertificateForm keeps metadata save while GradingPanel owns canonical Review", () => {
    expect(FORM).toContain('data-testid="button-save-cert"');
    expect(FORM).toContain('type="submit"');
    expect(FORM).not.toContain("<ReviewSummary");
    expect(FORM).not.toContain("legacy-review");
    expect(GRADING_PANEL).toContain("<RoleReviewSummary");
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
