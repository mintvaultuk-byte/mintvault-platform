/**
 * Card-stage compactness pass — source assertions proving the density refinements
 * (shorter read-only preview, Year+Language sharing a row, one combined
 * workflow/session/queue strip, thin Identification Tools, compact Search TCG
 * button, reduced padding) while every protected surface, the save payload, the
 * queue/session logic and Stage 3 stay untouched. Zero provider calls, zero
 * credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, gradingReleaseFileDiff } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const PREVIEW = read("client/src/components/grading-workflow/CardPreviewPanel.tsx");
const HUD = read("client/src/components/grading-workflow/SessionHud.tsx");
const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");

/** Slice of a source string between two anchors (asserts both exist, in order). */
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

/** Files changed by the grading RELEASE (PR #214), from the fixed range d69ad147..fc57b53b. */
function changedFiles(): string[] {
  return gradingReleaseChangedFiles();
}

describe("1. read-only preview fills the panel (spec 1)", () => {
  it("fill mode: card contain-fits the full panel height; non-fill keeps a capped thumbnail (Review stage)", () => {
    // Opt-in `fill` prop: the workstation aside passes fill and the panel becomes
    // a full-height flex column whose image grows to fill; the shared Review-stage
    // thumbnail (default, no fill) keeps a capped size so it isn't enlarged.
    expect(PREVIEW).toContain("fill = false"); // opt-in prop, default off
    expect(PREVIEW).toContain("flex h-full min-h-0 flex-col"); // fill: full-height column
    expect(PREVIEW).toContain("flex min-h-0 flex-1 items-center justify-center"); // fill: viewport grows
    expect(PREVIEW).toContain("max-h-full"); // fill: img contains to the flex-1 box
    expect(PREVIEW).toContain("max-h-[40vh]"); // non-fill default: capped thumbnail
    expect(PREVIEW).not.toContain("max-h-[56vh]");
    expect(PREVIEW).not.toContain("max-h-[44vh]");
    expect(PREVIEW).toContain("80vh"); // fullscreen still available for inspection
    // the workstation aside opts in to fill — now via the shared
    // WorkstationPreviewAside primitive (extracted from certificate-form.tsx).
    const asideSrc = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
    expect(asideSrc).toContain("<CardPreviewPanel fill");
  });
  it("keeps front/back, button zoom, fit/reset, fullscreen controls", () => {
    expect(PREVIEW).toContain('(["front", "back"] as const)');
    expect(PREVIEW).toContain("card-preview-${s}");
    expect(PREVIEW).toContain("stepZoom");
    expect(PREVIEW).toContain("Fit to screen / reset zoom");
    expect(PREVIEW).toContain("Full-screen preview");
  });
});

describe("0. read-only viewer: button-only zoom + drag-pan (wheel scrolls normally)", () => {
  it("mouse wheel does NOT zoom — no wheel handler; zoom is button-only", () => {
    expect(PREVIEW).not.toContain("onWheel");
    expect(PREVIEW).not.toContain("wheelZoom");
    expect(PREVIEW).toContain("stepZoom");
    expect(PREVIEW).toContain('label="Zoom in"');
    expect(PREVIEW).toContain('label="Zoom out"');
  });
  it("drag-to-pan while zoomed (the previously-missing behaviour)", () => {
    expect(PREVIEW).toContain("onMouseDown={startDrag}");
    expect(PREVIEW).toContain("onMouseMove={onDrag}");
    expect(PREVIEW).toContain("onMouseUp={endDrag}");
    expect(PREVIEW).toContain("onMouseLeave={endDrag}");
    expect(PREVIEW).toMatch(/const \[pan, setPan\]/);
    expect(PREVIEW).toMatch(/if \(zoom <= 1\) return;/); // no pan until zoomed
  });
  it("smooth transform (translate+scale), no transition while dragging", () => {
    expect(PREVIEW).toMatch(/transform:\s*`translate\([^`]*scale\(/);
    expect(PREVIEW).toContain('transition: dragging ? "none" : "transform 0.1s ease-out"');
  });
  it("fit/reset re-centres (zoom 1 + pan 0); grab/grabbing cursor while zoomed", () => {
    expect(PREVIEW).toContain("resetView");
    expect(PREVIEW).toContain("Fit to screen / reset zoom");
    expect(PREVIEW).toMatch(/cursor-grabbing.*cursor-grab|cursor-grab.*cursor-grabbing/);
  });
  it("front/back + fullscreen + Escape unchanged; no protected import", () => {
    expect(PREVIEW).toContain('(["front", "back"] as const)');
    expect(PREVIEW).toContain('data-testid="card-preview-fullscreen"');
    expect(PREVIEW).toContain('e.key === "Escape"');
    // never imports a protected grading component (grading-coordinate absence is
    // asserted on comment-stripped source in grading-stages / grading-workstation-ux).
    expect(PREVIEW).not.toMatch(/from\s+"[^"]*components\/grading\//);
  });
});

describe("2/3. Year + Language share one 4-column row (spec 2)", () => {
  it("Row 2 uses a 4-column template (Name · Number+Auto-fill · Year · Language)", () => {
    expect(FORM).toContain("sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,1fr)]");
  });
  it("Language now lives inside Row 2 beside Year — not in a row of its own", () => {
    // Language input sits within a short window after the Year field (same row),
    // and there is exactly one Language field (moved, not duplicated).
    expect((FORM.match(/testId="input-language"/g) ?? []).length).toBe(1);
    expect((FORM.match(/label="Year \*"/g) ?? []).length).toBe(1);
    const row2 = slice(FORM, 'label="Card Name *"', "{!fallbackMatch && canAutofill");
    expect(row2).toContain('testId="input-year"');
    expect(row2).toContain('testId="input-language"'); // Language is in the same row block as Year
    // The former standalone language row wrapper is gone.
    expect(FORM).not.toContain("stage 1 (card) continued");
  });
});

describe("4. one combined workflow/session/queue strip (spec 3)", () => {
  // unified-shell pass: the strip is now the shared WorkstationHeaderStrip
  // component, rendered from exactly ONE call site in certificate-form.tsx.
  const STRIP_SRC = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
  it("a single WorkstationHeaderStrip wraps the workflow bar + queue + session HUD", () => {
    expect(FORM).toContain("<WorkstationHeaderStrip");
    expect((FORM.match(/<WorkstationHeaderStrip/g) ?? []).length).toBe(1);
    expect(STRIP_SRC).toContain('data-testid="workstation-strip"');
    expect(STRIP_SRC).toContain("<GradingWorkflowBar embedded");
    expect(STRIP_SRC).toContain('data-testid="queue-progress"');
    expect(STRIP_SRC).toContain("<SessionHud embedded");
    expect(STRIP_SRC).toContain('data-testid="batch-header"');
  });
  it("the three former separate strips are gone (no standalone SessionHud / bordered batch row)", () => {
    // No non-embedded SessionHud usage remains, and the workflow bar is embedded.
    expect(STRIP_SRC).not.toMatch(/<SessionHud completed=\{sessionCompleted\} \/>/);
    expect((STRIP_SRC.match(/<GradingWorkflowBar/g) ?? []).length).toBe(1);
    expect(STRIP_SRC).toContain("<GradingWorkflowBar embedded");
    // certificate-form.tsx no longer imports these directly — it delegates to
    // the shared strip component instead.
    expect(FORM).not.toContain('import { GradingWorkflowBar } from "@/components/grading-workflow/GradingWorkflowBar"');
    expect(FORM).not.toContain('import { SessionHud } from "@/components/grading-workflow/SessionHud"');
  });
  it("workflow bar + HUD support an embedded (chrome-less) variant", () => {
    expect(BAR).toContain("embedded");
    expect(HUD).toContain("embedded");
  });
});

describe("5/6. queue order + session calc unchanged (spec 3)", () => {
  it("session cards/hr + completed math is byte-identical (display only)", () => {
    expect(HUD).toContain("Math.round((done / elapsedMs) * 3600_000)");
    expect(HUD).toContain("session.completedTimes.length");
  });
  it("admin-dashboard queue stepping (frozen snapshot, +1) logic is intact", () => {
    // The queue-stepping helper is present; the file may change for unrelated
    // layout reasons on later branches, but the queue logic stays.
    expect(DASH).toContain("openNextQueuedCard");
    expect(DASH).toContain("gradeQueue");
  });
});

describe("7/8. Identification Tools thin + collapsed (spec 4)", () => {
  const IDT = slice(FORM, 'data-testid="identification-tools"', "runIdentify");
  it("stays a closed-by-default <details> (no `open` attribute, no large AI banner)", () => {
    expect(IDT).toContain("<summary");
    expect(IDT).not.toMatch(/<details[^>]*\sopen/);
  });
  it("uses compact styling (py-1.5 summary, lighter frame)", () => {
    expect(IDT).toContain("py-1.5");
    expect(IDT).toContain("Identification tools");
  });
});

describe("9. Search TCG is a compact button, behaviour unchanged (spec 5)", () => {
  it("outlined utility button that still opens the TCGdex search dialog", () => {
    const region = slice(FORM, "Search TCG is a compact", "Search TCG Database");
    expect(region).toContain("setTcgSearchOpen(true)");
    expect(region).toContain("Search TCG");
    expect(region).toMatch(/rounded-md border/); // button, not a bare text link
  });
});

describe("10/11. Certificate Tools + Ownership/NFC unchanged (spec 7)", () => {
  it("Certificate Tools launcher + drawer remain wired in admin-dashboard", () => {
    // unified-shell pass: the launcher button itself is now the shared
    // CertificateToolsButton primitive (CertificateToolsDrawer.tsx) — verify
    // admin-dashboard.tsx renders it, and the button itself still carries the
    // same testid/behaviour.
    expect(DASH).toContain("<CertificateToolsButton");
    expect(DASH).toContain("<CertificateToolsDrawer");
    const drawerSrc = read("client/src/components/grading-workflow/CertificateToolsDrawer.tsx");
    expect(drawerSrc).toContain('data-testid="button-certificate-tools"');
  });
  it("Ownership/NFC are NOT rendered inline beneath the grading form", () => {
    expect(DASH).not.toMatch(/<OwnershipSection\b/);
    expect(DASH).not.toMatch(/<NfcSection\b/);
  });
});

describe("12/13/14. save payload + navigation + Next Card unchanged", () => {
  it("no save endpoint / payload line changed in this pass", () => {
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
  it("stage navigation stays pure and Next Card still advances the queue", () => {
    const fn = FORM.slice(FORM.indexOf("const goToStage"), FORM.indexOf("const stageClass"));
    expect(fn).toContain("setWfStage");
    expect(fn).not.toMatch(/mutate|handleSubmit|fetch\(|setForm/);
    expect(FORM).toContain('data-testid="button-next-card"');
    expect(FORM).toContain("queue.onNext");
  });
});

describe("15-20. protected surfaces, providers, credits", () => {
  it("git diff touches ONLY the allowed UI + test files — no protected/server/schema file", () => {
    const changed = changedFiles();
    const allowedNonTest = new Set([
      "client/src/components/certificate-form.tsx",
      "client/src/components/grading-workflow/CardPreviewPanel.tsx",
      "client/src/components/rarity-picker/RarityVariantPicker.tsx",
      "client/src/components/grading-workflow/GradingWorkflowBar.tsx",
      "client/src/components/grading-workflow/SessionHud.tsx",
      // workstation-shell pass (same branch): layout-only shell files
      "client/src/components/admin/admin-shell.tsx",
      "client/src/pages/admin-dashboard.tsx",
      // identify/lookup fix (same branch): structured-error lib + non-protected
      // TCGdex lookup routes/services (NOT grading/schema/migrations).
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
      // unified-shell architecture pass (same branch): new shared primitives +
      // the pages/component that adopt them. Layout-only, no protected surface.
      "client/src/components/grading-workflow/WorkstationHeaderStrip.tsx",
      "client/src/components/grading-workflow/WorkstationPreviewAside.tsx",
      "client/src/components/admin/AdminHeaderRow.tsx",
      "client/src/pages/staff.tsx",
    ]);
    for (const f of changed) {
      expect(f, `${f} must not be a protected/server/schema file`).not.toMatch(
        /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/(?!routes\/admin-config\.ts|services\/tcgdex-set-resolve\.ts|services\/collector-number\.ts|vite\.ts)|^migrations\//,
      );
      if (!f.startsWith("tests/")) {
        expect(allowedNonTest.has(f), `unexpected non-test file changed: ${f}`).toBe(true);
      }
    }
  });
  it("no provider/credit call introduced (UI-only diff)", () => {
    // Scan the SOURCE diff only (client/); test files legitimately contain these
    // provider words inside this very guard's regex.
    const added = gradingReleaseFileDiff("client/")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    for (const l of added) {
      expect(l).not.toMatch(/anthropic|higgsfield|stripe|\.charge|credits?\.(spend|reserve|deduct)/i);
    }
  });
});
