/**
 * Visual-density + beginner-friendly grading pass — source-assertion tests
 * (the admin form is auth-gated). Proves the AI banner is collapsed, Ownership/
 * NFC moved into the Certificate Tools drawer (out of the grading scroll), the
 * two-column shell + compact controls + beginner guidance exist, and NO
 * protected grading/centering/server/schema/save-payload file changed.
 * Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, GRADING_PROTECTED_PATHS } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const CANON_SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const FOCUS_SURFACE = read("client/src/components/admin/admin-focus-surface.ts");
const DRAWER = read("client/src/components/grading-workflow/CertificateToolsDrawer.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("AI banner collapsed into Identification tools drawer (spec 2, 6)", () => {
  it("the large AI block is now a collapsed <details> drawer, not an open banner", () => {
    expect(FORM).toContain('data-testid="identification-tools"');
    const m = FORM.indexOf('data-testid="identification-tools"');
    expect(FORM.slice(m - 220, m)).toContain("<details");
    expect(FORM).toContain("Identification tools");
  });
  it("AI Identify + AI Grade logic is preserved inside the drawer", () => {
    expect(FORM).toContain("runIdentify");
    expect(FORM).toContain("runGrade");
  });
  it("TCGdex remains available in the Card stage", () => {
    expect(FORM).toContain("Search TCG");
  });
});

describe("Ownership + NFC moved out of the grading scroll (spec 8-13, 15-17)", () => {
  it("admin-dashboard no longer renders OwnershipSection/NfcSection beneath the form", () => {
    // They must not sit inline below the grading stages anymore.
    expect(DASH).not.toMatch(/<OwnershipSection\b/);
    expect(DASH).not.toMatch(/<NfcSection\b/);
  });
  it("a Certificate Tools launcher exists in the grading header with tiny status", () => {
    // unified-shell pass: the launcher itself is the shared CertificateToolsButton
    // primitive (same file as the status helper) — admin-dashboard.tsx renders it.
    expect(DASH).toContain("<CertificateToolsButton");
    expect(DRAWER).toContain('data-testid="button-certificate-tools"');
    expect(DRAWER).toContain("certificateToolsStatus");
    expect(DASH).toContain("<CertificateToolsDrawer");
  });
  it("the drawer re-parents the EXISTING Ownership + NFC components (logic unchanged)", () => {
    expect(DRAWER).toContain("OwnershipSection");
    expect(DRAWER).toContain("NfcSection");
    expect(DRAWER).toContain("cert-tools-tab-${id}"); // template testids for both tabs
    expect(DRAWER).toMatch(/id="ownership"/);
    expect(DRAWER).toMatch(/id="nfc"/);
  });
  it("both tabs stay mounted (visibility toggled) so entered values are retained", () => {
    expect(DRAWER).toContain('data-testid="cert-tools-ownership"');
    expect(DRAWER).toContain('data-testid="cert-tools-nfc"');
    expect(DRAWER).toMatch(/tab === "ownership" \? "" : "hidden"/);
  });
  it("the drawer closes on Escape and does not save or mutate grading", () => {
    expect(DRAWER).toContain('e.key === "Escape"');
    const code = stripComments(DRAWER);
    expect(code).not.toMatch(/mutate|handleSubmit|buildCertFormData|setForm|grade/i);
  });
  it("status helper reads existing cert fields only (no network)", () => {
    const fn = DRAWER.slice(
      DRAWER.indexOf("export function certificateToolsStatus"),
      DRAWER.indexOf("export function CertificateToolsDrawer")
    );
    expect(fn).toContain("ownershipStatus");
    expect(fn).toContain("nfcUid");
    expect(fn).not.toMatch(/fetch\(|apiRequest/);
  });
});

describe("two-column shell + density (spec 1, 3, 19)", () => {
  it("Card Details renders the preview beside the controls (~40% left column)", () => {
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
    expect(CANON_SHELL).toContain('WORKSTATION_TWO_PANE_CLASS = "min-[540px]:flex-row"');
    // unified-shell pass: the column-ratio class now lives in ONE shared
    // constant inside WorkstationPreviewAside, not inline in certificate-form.
    const asideSrc = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
    expect(asideSrc).toContain("min-[540px]:w-[45%] min-[540px]:shrink-0");
    expect(asideSrc).toContain('data-testid="grading-preview-panel"');
    expect(WORKSTATION).toContain("<WorkstationPreviewAside");
  });
  it("the grading page uses a page-scrollable focus shell + compact header (not the tall Edit header)", () => {
    // Bounded-height workstation: AdminShell focus mode + min-h-[100dvh] flex
    // column (page-scrollable, no clip), replacing the former max-w-6xl container.
    // The surface class moved into ADMIN_FOCUS_SURFACE_CLASS so /admin and the
    // dev geometry harness that measures it cannot drift apart. Below `md` it is
    // still min-height + auto height (page-scrollable, no clip); the `md:`
    // tokens add the definite desktop height that replaced the guessed
    // `calc(100dvh-4.5rem)` offset.
    expect(DASH).toContain("ADMIN_FOCUS_SURFACE_CLASS");
    expect(FOCUS_SURFACE).toContain("flex min-h-[100dvh] flex-col");
    // grading-header is now the shared AdminHeaderRow primitive, passed
    // testId="grading-header" (a prop, not a literal data-testid attribute).
    expect(DASH).toContain('testId="grading-header"');
    expect(DASH).toContain("&larr; Certificates");
  });
  it("form vertical rhythm tightened (space-y-4, not space-y-6)", () => {
    expect(FORM).toMatch(/className="space-y-4"\s*>/);
  });
});

describe("beginner-friendly guidance (spec 6) + readable rarity names (spec 6, 8)", () => {
  it("plain-English help for Set, Set Code and Card Number", () => {
    expect(FORM).toContain('data-testid="help-set"');
    expect(FORM).toContain('data-testid="help-set-code"');
    expect(FORM).toContain('data-testid="help-card-number"');
    expect(FORM).toContain("The number at the bottom of the card");
  });
  it("rarity chips show the code AND the readable name (code over name)", () => {
    expect(PICKER).toContain("{rr.codes[0] || rr.label}");
    expect(PICKER).toContain("{rr.label}"); // readable name beneath
  });
  it("plain-English section headings remain", () => {
    expect(PICKER).toContain("Choose the symbol printed on the card");
    expect(PICKER).toContain("Choose the finish");
  });
  it("specialist designations stay collapsed in the daily view", () => {
    expect(FORM).toContain('data-testid="designations-details"');
  });
});

describe("three stages + protected surfaces unchanged (spec 16-24)", () => {
  it("the three grading stages still exist", () => {
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    expect(WORKSTATION).toContain("stage === GRADE_STAGE");
    expect(WORKSTATION).toContain("stage === REVIEW_STAGE");
    expect(FORM).not.toContain("data-workflow-stage");
  });
  it("the sole GradingPanel mount has no transform/scale/zoom wrapper", () => {
    const start = WORKSTATION.indexOf("{gradingEnabled && <GradingPanel");
    const wrapper = stripComments(WORKSTATION.slice(start, WORKSTATION.indexOf("/>}", start)));
    expect(FORM).not.toContain("workstationSlot");
    expect((WORKSTATION.match(/<GradingPanel/g) ?? []).length).toBe(1);
    expect(wrapper).not.toMatch(/transform|scale\(|zoom:/);
  });
  it("save payload builder untouched — no density/drawer field added", () => {
    const fn = FORM.slice(FORM.indexOf("function buildCertFormData"), FORM.indexOf("function buildCertFormData") + 900);
    expect(fn).not.toMatch(/certTools|drawer|density|ownership|nfc/i);
  });
  // HISTORICAL release-scope proof: the grading release (PR #214) itself changed no protected file.
  // Pinned to the fixed grading range d69ad147..fc57b53b — never the current branch (see helper).
  it("grading release (PR #214) touched NO protected grading/centering/label/schema/server file", () => {
    for (const f of gradingReleaseChangedFiles()) {
      expect(f, f).not.toMatch(GRADING_PROTECTED_PATHS);
    }
  });
});
