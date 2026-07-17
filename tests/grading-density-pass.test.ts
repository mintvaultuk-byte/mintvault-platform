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
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const DRAWER = read("client/src/components/grading-workflow/CertificateToolsDrawer.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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
    // They must not sit inline below the four stages anymore.
    expect(DASH).not.toMatch(/<OwnershipSection\b/);
    expect(DASH).not.toMatch(/<NfcSection\b/);
  });
  it("a Certificate Tools launcher exists in the grading header with tiny status", () => {
    expect(DASH).toContain('data-testid="button-certificate-tools"');
    expect(DASH).toContain("certificateToolsStatus");
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
    const fn = DRAWER.slice(DRAWER.indexOf("export function certificateToolsStatus"), DRAWER.indexOf("export function CertificateToolsDrawer"));
    expect(fn).toContain("ownershipStatus");
    expect(fn).toContain("nfcUid");
    expect(fn).not.toMatch(/fetch\(|apiRequest/);
  });
});

describe("two-column shell + density (spec 1, 3, 19)", () => {
  it("Card/Rarity render the preview beside the controls (~34% left column)", () => {
    expect(FORM).toContain("lg:grid-cols-[minmax(230px,34%)_minmax(0,1fr)]");
    // Preview now lives in the workspace aside (fixed-height shell), not a sticky
    // column inside the form.
    expect(FORM).toContain('data-testid="grading-preview-panel"');
  });
  it("the grading page uses a full-height focus shell + compact header (not the tall Edit header)", () => {
    // Fixed-height workstation: AdminShell focus mode + full-height flex column,
    // replacing the former max-w-6xl scroll container.
    expect(DASH).toContain("flex h-full min-h-0 flex-col");
    expect(DASH).toContain('data-testid="grading-header"');
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

describe("four stages + protected surfaces unchanged (spec 16-24)", () => {
  it("the four grading stages still exist", () => {
    for (const key of ["identify", "rarity", "grade", "review"]) {
      expect(FORM).toContain(`data-workflow-stage="${key}"`);
    }
  });
  it("workstationSlot renders with no transform/scale/zoom", () => {
    const wrapper = stripComments(FORM.slice(FORM.indexOf('<div data-workflow-stage="grade"'), FORM.indexOf("Stage 3 nav")));
    expect(wrapper).toContain("{workstationSlot}");
    expect(wrapper).not.toMatch(/transform|scale\(|zoom:/);
  });
  it("save payload builder untouched — no density/drawer field added", () => {
    const fn = FORM.slice(FORM.indexOf("function buildCertFormData"), FORM.indexOf("function buildCertFormData") + 900);
    expect(fn).not.toMatch(/certTools|drawer|density|ownership|nfc/i);
  });
  it("git diff vs base touches NO protected grading/centering/label/schema/server file", () => {
    const base = ["origin/main", "main", "f64ec30b"].find((r) => {
      try {
        execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    });
    if (!base) return;
    const changed = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const f of changed) {
      expect(f, f).not.toMatch(/components\/grading\/|mvgs|scoring|centering|pristine|grader\.ts|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/|^migrations\//);
    }
  });
});
