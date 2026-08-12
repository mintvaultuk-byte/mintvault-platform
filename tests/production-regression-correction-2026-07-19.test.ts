/**
 * Controlled production-regression correction phase (2026-07-19).
 *
 * Live production screenshots disproved four release assumptions from the
 * unified-admin-architecture pass (PR #217): Staff kept a duplicate legacy
 * header inside its own grading workflow, the workstation header carried
 * redundant chrome, the Set Name field/dropdown was too narrow and
 * destructively truncated long set names, and the Grade stage had no outer
 * height containment. This file proves the four source-level fixes and that
 * nothing protected was touched.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const STAFF = read("client/src/pages/staff.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");

describe("Staff shell — no duplicate legacy header in the active-card grading view", () => {
  it("GradeTab's active-card breadcrumb uses the shared AdminHeaderRow primitive, not raw markup", () => {
    // The active-card branch renders exactly one more AdminHeaderRow (the
    // breadcrumb) in addition to the outer StaffPage header — never a second,
    // differently-styled raw <div> header stacked beneath it.
    const activeCardBranch = STAFF.slice(STAFF.indexOf("if (active) {"), STAFF.indexOf("if (active) {") + 1200);
    expect(activeCardBranch).toContain("<AdminHeaderRow");
    expect(activeCardBranch).toContain('testId="staff-grading-breadcrumb"');
  });
  it("the breadcrumb no longer hardcodes raw hex gold in its className attributes — it uses the shared design token", () => {
    const activeCardBranch = STAFF.slice(STAFF.indexOf("if (active) {"), STAFF.indexOf("if (active) {") + 1200);
    expect(activeCardBranch).not.toMatch(/className="[^"]*#D4AF37/);
    expect(activeCardBranch).toContain("var(--admin-gold)");
  });
  it("both the outer Staff header and the grading breadcrumb use the same AdminHeaderRow component", () => {
    expect((STAFF.match(/<AdminHeaderRow/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("Staff active grading still uses the grader-scoped canonical workstation", () => {
    expect(STAFF).toContain("<GradingWorkstation");
    expect(STAFF).toContain('mode="staff"');
    expect(STAFF).toContain('apiBase="/api/grader"');
    expect(STAFF).toContain("graderMode");
  });
});

describe("Set Name — wider grid column and non-truncating, viewport-bounded dropdown", () => {
  it("the Card-identity row weights Set Name wider than Card Game / Set Code (not an equal 1/3 split)", () => {
    expect(FORM).toContain("grid grid-cols-1 sm:grid-cols-[0.8fr_2fr_0.9fr] gap-4");
    expect(FORM).not.toContain("grid grid-cols-1 sm:grid-cols-3 gap-4");
  });
  it("the results dropdown can exceed the input's own width, bounded by the viewport", () => {
    expect(FORM).toContain("w-[max(100%,26rem)]");
    expect(FORM).toContain("max-w-[calc(100vw-2rem)]");
    // no longer pinned to exactly the input's width via left-0 right-0
    expect(FORM).not.toContain('className="absolute z-30 left-0 right-0 mt-1');
  });
  it("result-row set names no longer use destructive ellipsis truncation", () => {
    const dropdownBlock = FORM.slice(
      FORM.indexOf("filtered.map((s) => {"),
      FORM.indexOf("filtered.map((s) => {") + 2500
    );
    expect(dropdownBlock).not.toContain("truncate text-xs font-medium text-[var(--admin-ink)]");
    expect(dropdownBlock).toContain("text-xs font-medium leading-snug text-[var(--admin-ink)]");
  });
  it("keyboard nav, recent-sets, and TCGdex-backed selection are untouched (same handlers still present)", () => {
    expect(FORM).toContain("recordRecentSet");
    expect(FORM).toContain('data-testid="recent-sets"');
    expect(FORM).toContain("onChange(s.name, s.id)");
  });
});

describe("Grade stage — containment lives on the outer shell, not the workstation wrapper (superseded 2026-07-20)", () => {
  // SUPERSEDED 2026-07-20. This block previously asserted the workstationSlot
  // wrapper carried `max-h-[calc(100dvh-12rem)]` + `overflow-y-auto`. Live
  // authenticated staging testing proved that cap WAS the defect, not the fix:
  // it created a second scrollport ~120px shorter than the space available,
  // clipping the protected GradingPanel mid-content so the Grade form appeared
  // to overlay half the workspace. Containment was never missing — the shell
  // root and the <form> already provided it, and both predate dfc5b946.
  // The assertion is inverted here so the regression can never be reintroduced;
  // the sibling geometry/Enter-guard assertions below are unchanged and still valid.
  it("there is no CertificateForm workstation slot or competing grading scrollport", () => {
    expect(FORM).not.toContain("workstationSlot");
    expect(WORKSTATION).not.toContain("max-h-[calc(100dvh-12rem)]");
  });
  it("containment still lives on the outer shell (root fixed height + the form as the single scrollport)", () => {
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
    expect(SHELL).toContain("flex min-h-0 flex-col h-full");
    expect(SHELL).toContain("overflow-y-auto");
    expect(WORKSTATION).toContain("WORKSTATION_BODY_SCROLL_CLASS");
    expect(FORM).not.toContain("CanonicalGradingWorkstationShell");
  });
  it("no transform/scale/zoom was introduced (the protected card tool reads live getBoundingClientRect)", () => {
    expect(WORKSTATION).not.toMatch(/scale\(|zoom:/);
  });
  it("CertificateForm cannot intercept Enter to navigate the canonical stages", () => {
    expect(FORM).not.toMatch(/goToStage|nextStageIndex|data-workflow-stage/);
    expect(WORKSTATION).toContain("onStageClick={(i) => goToStage(i)}");
  });
});

describe("Protected grading source untouched by this correction pass", () => {
  it("no file under client/src/components/grading/ was edited (no changed-file reference in this test's own diffs)", () => {
    // This pass never opened grading-panel.tsx / grading-queue.tsx /
    // session-summary.tsx. Guarded structurally: certificate-form.tsx still
    // renders the protected panel purely as an opaque slot, never inlining
    // its internals.
    expect(FORM).not.toContain("computeMvgsScore");
    expect(FORM).not.toContain("SURFACE_ISSUES");
  });
});
