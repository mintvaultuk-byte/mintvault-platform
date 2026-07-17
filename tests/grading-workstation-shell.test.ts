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
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const SHELL = read("client/src/components/admin/admin-shell.tsx");

/** Slice between two anchors (both must exist, in order). */
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

function changedFiles(): string[] | null {
  const base = ["origin/main", "main"].find((r) => {
    try {
      execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  if (!base) return null;
  return execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

const WORKSPACE = slice(FORM, 'data-testid="grading-workspace"', "</form>");
// Everything from the control panel start to the form open = the fixed header of
// the right panel (workflow strip + identification tools live here).
const CONTROL_HEADER = slice(FORM, `data-testid="grading-control-panel"`, "onSubmit={handleSubmit}");

describe("1-4. two-panel workspace: preview aside + control panel are grid siblings", () => {
  it("a viewport-height workspace wraps a two-column grid (preview | controls)", () => {
    expect(FORM).toMatch(/data-testid="grading-workspace"[^>]*/);
    expect(FORM).toContain("flex h-full min-h-0 flex-col");
    // stage 0/1 use the 34% preview column; stages 2/3 collapse to one column.
    expect(FORM).toContain("lg:grid-cols-[minmax(230px,34%)_minmax(0,1fr)]");
    expect(FORM).toContain('wfStage <= 1 ? "lg:grid-cols-[minmax(230px,34%)_minmax(0,1fr)]" : "lg:grid-cols-1"');
  });
  it("CardPreviewPanel lives in the preview aside; controls in the control panel — siblings in one grid", () => {
    const grid = slice(FORM, "className={`grid min-h-0 flex-1", "onSubmit={handleSubmit}");
    expect(grid).toContain('data-testid="grading-preview-panel"');
    expect(grid).toContain("<CardPreviewPanel");
    expect(grid).toContain('data-testid="grading-control-panel"');
    // preview aside only renders for the Card/Rarity stages.
    expect(grid).toMatch(/wfStage <= 1 &&[\s\S]*grading-preview-panel/);
  });
  it("preview is NOT rendered above the fields as a full-width block", () => {
    // The only CardPreviewPanel render is inside the aside (grid sibling of the
    // control panel), never as a standalone full-width row above the form.
    expect((FORM.match(/<CardPreviewPanel/g) ?? []).length).toBe(1);
    const aside = slice(FORM, 'data-testid="grading-preview-panel"', "</aside>");
    expect(aside).toContain("<CardPreviewPanel");
  });
});

describe("2-3. workflow strip + Identification Tools are INSIDE the right control panel", () => {
  it("workstation-strip is in the control-panel header (before the form)", () => {
    expect(CONTROL_HEADER).toContain('data-testid="workstation-strip"');
    expect(CONTROL_HEADER).toContain("<GradingWorkflowBar embedded");
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
    const controlPanel = slice(FORM, 'data-testid="grading-control-panel"', "</form>");
    expect(controlPanel).toContain("overflow-y-auto");
    expect(controlPanel).toContain("min-h-0 flex-1");
  });
  it("admin-dashboard renders the grading view in a full-height focus shell", () => {
    expect(DASH).toContain("focus"); // AdminShell focus prop passed
    expect(DASH).toContain('data-testid="grading-header"');
    expect(DASH).toContain("h-full min-h-0 flex-col");
  });
  it("AdminShell focus mode hides the big admin-top header", () => {
    expect(SHELL).toMatch(/focus\??:\s*boolean/);
    // admin-top is conditional on !focus
    expect(SHELL).toMatch(/focus \?[\s\S]*admin-top/);
  });
});

describe("7-9. old tall chrome is gone", () => {
  it("the large 1·CARD DETAILS fieldset is gone (now a plain div)", () => {
    expect(FORM).not.toMatch(/<fieldset data-workflow-stage="identify"/);
    expect(FORM).toContain('data-workflow-stage="identify"'); // still a stage container, just a div
  });
  it("the large EDIT MV### title + 'Update certificate details' subtitle are removed", () => {
    expect(FORM).not.toContain('data-testid="text-form-title"');
    expect(FORM).not.toContain("Update certificate details");
  });
});

describe("10-11. navigation + stage reuse", () => {
  it("Continue to Rarity stays inside the control panel form", () => {
    const controlPanel = slice(FORM, 'data-testid="grading-control-panel"', "</form>");
    expect(controlPanel).toContain('data-testid="button-continue-to-rarity"');
  });
  it("Rarity stage reuses the same side-by-side shell (aside shows for wfStage <= 1)", () => {
    // The preview aside gate is wfStage <= 1, which covers BOTH Card (0) and Rarity (1).
    expect(FORM).toMatch(/\{wfStage <= 1 && \([\s\S]*grading-preview-panel/);
  });
});

describe("12-20. protected surfaces / save / queue / Ownership-NFC / providers untouched", () => {
  it("git diff touches ONLY the allowed UI + test files — no protected/server/schema file", () => {
    const changed = changedFiles();
    if (!changed) return;
    const allowedNonTest = new Set([
      "client/src/components/certificate-form.tsx",
      "client/src/components/admin/admin-shell.tsx",
      "client/src/pages/admin-dashboard.tsx",
    ]);
    for (const f of changed) {
      expect(f, `${f} must not be protected/server/schema`).not.toMatch(
        /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/|^migrations\//,
      );
      if (!f.startsWith("tests/")) expect(allowedNonTest.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
  it("workstationSlot render + Stage-3 wrapper unchanged (no transform/scale added)", () => {
    const wrapper = slice(FORM, 'data-workflow-stage="grade"', "Stage 3 nav");
    expect(wrapper).toContain("{workstationSlot}");
    expect(wrapper).not.toMatch(/transform|scale\(|zoom:/);
  });
  it("save payload builder + endpoints not modified by this pass", () => {
    const base = ["origin/main", "main"].find((r) => {
      try {
        execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    });
    if (!base) return;
    const diff = execSync(`git diff ${base}...HEAD -- client/src/components/certificate-form.tsx`, { encoding: "utf8" });
    const touched = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l))
      .filter((l) => /apiRequest\(|\/api\/admin\/certificates|method:\s*"(POST|PUT|PATCH)"|buildCertFormData/.test(l));
    expect(touched).toEqual([]);
  });
  it("queue + Ownership/NFC logic untouched (admin-dashboard has no queue/drawer logic change)", () => {
    expect(DASH).toContain("openNextQueuedCard");
    expect(DASH).toContain("<CertificateToolsDrawer");
    expect(DASH).not.toMatch(/<OwnershipSection\b/);
    expect(DASH).not.toMatch(/<NfcSection\b/);
  });
  it("no provider/credit call introduced (UI-only diff)", () => {
    const base = ["origin/main", "main"].find((r) => {
      try {
        execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    });
    if (!base) return;
    const added = execSync(`git diff ${base}...HEAD -- client/`, { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    for (const l of added) {
      expect(l).not.toMatch(/anthropic|higgsfield|stripe|\.charge|credits?\.(spend|reserve|deduct)/i);
    }
  });
});
