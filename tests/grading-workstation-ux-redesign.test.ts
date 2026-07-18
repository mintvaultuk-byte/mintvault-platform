/**
 * Grading-workstation UX redesign (AI-first Card stage) — source-assertion tests
 * (the admin grading form is auth-gated, so we assert on the committed source the
 * way the rest of the grading suite does). Proves:
 *   - the Card stage leads with an AI-first identification panel whose primary
 *     action is Accept, with Search Again secondary (using the EXISTING runIdentify);
 *   - the manual card-detail field grid is ALWAYS visible (permanent, not gated
 *     behind a "Manual" toggle/accordion — spec: normal verification process, not
 *     an exceptional fallback) and every card field + binding is preserved;
 *   - intelligent set search is wired to the existing /api/pokemon-sets catalogue;
 *   - the Review stage stays a compact dashboard (ReviewSummary + authentication);
 *   - NO protected grading file (client/src/components/grading/, MVGS/scoring/
 *     centering/pristine, grader.ts, labels.ts, certificate-document,
 *     shared/schema.ts, migrations/) was changed by this task, and this session's
 *     only client edit is certificate-form.tsx.
 * Zero provider calls, zero credits.
 *
 * NOTE: the "protected surfaces" guards below assert a HISTORICAL fact about the fixed
 * grading-workstation release range (see tests/helpers/grading-release-scope.ts) — NOT the current
 * branch's working tree. Unrelated future work (e.g. server/, migrations/) on other branches never
 * appears in that fixed range, so it cannot trip these guards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradingReleaseChangedFiles, GRADING_PROTECTED_PATHS } from "./helpers/grading-release-scope";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");

/** Slice of FORM between two anchors (both must exist, in order). */
function slice(start: string, end: string): string {
  const i = FORM.indexOf(start);
  const j = FORM.indexOf(end, i + 1);
  expect(i, `anchor "${start}"`).toBeGreaterThan(-1);
  expect(j, `anchor "${end}"`).toBeGreaterThan(i);
  return FORM.slice(i, j);
}

describe("AI-first Card stage (spec 1-2)", () => {
  it("Card stage leads with an AI identification panel", () => {
    expect(FORM).toContain('data-testid="ai-identify-panel"');
    expect(FORM).toContain('data-testid="ai-identify-summary"'); // read-only verify chips
    expect(FORM).toContain('data-testid="ai-identify-confidence"'); // high/medium/low indicator
  });
  it("exposes Accept as primary, Search Again secondary, and a jump-to-fields affordance", () => {
    expect(FORM).toContain('data-testid="button-accept-identify"');
    expect(FORM).toContain('data-testid="button-ai-identify"');
    expect(FORM).toContain('data-testid="button-manual-entry"');
    expect(FORM).toContain("Accept");
    expect(FORM).toContain("Search Again");
  });
  it("uses the EXISTING runIdentify — no new identify logic, no save/API in the panel", () => {
    const panel = slice('data-testid="ai-identify-panel"', "Same as last card");
    expect(panel).toContain("onClick={runIdentify}"); // Search Again / AI Identify
    expect(panel).toContain("goToStage(1)"); // Accept advances the stage only
    expect(panel).toContain("captureLastCardContext"); // same capture as the existing Continue
    expect(panel).toContain("manualEditorRef.current?.scrollIntoView"); // jump to the (always-visible) fields
    // The panel triggers no persistence / provider / grade work of its own.
    expect(panel).not.toMatch(/fetch\(|apiRequest|buildCertFormData|method:\s*"(POST|PUT|PATCH)"|runGrade|mutate/);
  });
  it("shows the identified confidence from the existing identifyConfidence state", () => {
    expect(FORM).toContain("identifyConfidence");
    expect(FORM).toContain("identifyVerified");
  });
});

describe("manual card-detail fields are ALWAYS visible (spec: normal process, not a fallback)", () => {
  it("no manualMode/showManualEditor gating exists anywhere in the form", () => {
    expect(FORM).not.toContain("manualMode");
    expect(FORM).not.toContain("showManualEditor");
  });
  it("the manual field grid renders unconditionally — no accordion/hidden panel", () => {
    expect(FORM).toContain('<div ref={manualEditorRef} className="space-y-3" data-testid="manual-card-editor">');
    // not wrapped in any {condition && (...)} gate.
    expect(FORM).not.toContain("{showManualEditor && (");
  });
  it("ALL card fields + bindings are preserved inside the manual editor", () => {
    for (const id of [
      "select-card-game",
      "input-set-name",
      "input-set-id",
      "input-card-name",
      "input-card-number",
      "input-year",
      "input-language",
    ]) {
      expect(FORM, id).toContain(`"${id}"`);
    }
    // Exactly one of each critical field (moved/gated, never duplicated).
    expect((FORM.match(/testId="input-card-name"/g) ?? []).length).toBe(1);
    expect((FORM.match(/testId="input-language"/g) ?? []).length).toBe(1);
    expect((FORM.match(/data-testid="input-card-number"/g) ?? []).length).toBe(1);
  });
  it("TCGdex search stays directly reachable (not gated behind manual)", () => {
    const card = slice("STAGE 1 · CARD", "manual-card-editor");
    expect(card).toContain("Search TCG");
    expect(card).toContain("setTcgSearchOpen(true)");
  });
});

describe("intelligent set search wired to the existing catalogue (spec 3)", () => {
  it("PokemonSetPicker still reads the EXISTING /api/pokemon-sets source", () => {
    expect(FORM).toContain('fetch("/api/pokemon-sets")');
  });
  it("ranks matches over collection code (ptcgo/id) AND name", () => {
    expect(FORM).toContain("const scoreSet = (s: PokemonSet): number =>");
    expect(FORM).toContain("s.ptcgoCode"); // collection code considered
    expect(FORM).toMatch(/code === q \|\| id === q/); // exact code outranks
    expect(FORM).toMatch(/name\.startsWith\(q\)/); // name prefix
  });
  it("documents the near-empty staging catalogue as a data condition", () => {
    expect(FORM).toMatch(/staging the card_sets catalogue is near-empty/i);
  });
});

describe("Review stage stays a compact dashboard (spec 5)", () => {
  it("uses the ReviewSummary dashboard + an authentication summary", () => {
    const review = FORM.slice(FORM.indexOf("Stage 4 · REVIEW"));
    expect(review).toContain("<ReviewSummary");
    expect(review).toContain('data-testid="review-authentication"');
    expect(review).toContain("button-save-cert"); // existing save action unchanged
  });
  it("authentication is derived from the existing gradeType — no invented value", () => {
    const review = FORM.slice(FORM.indexOf("Stage 4 · REVIEW"));
    expect(review).toContain("NON_NUMERIC_GRADES.find");
    expect(review).toContain("form.gradeType");
  });
});

describe("protected surfaces untouched (hard rule)", () => {
  // HISTORICAL release-scope proof: this asserts the grading-workstation RELEASE (PR #214) itself
  // stayed in scope. It is pinned to the FIXED grading commit range d69ad147..fc57b53b (see the
  // grading-release-scope helper), NOT to `<moving-base>...HEAD`. After PR #214 merged into main a
  // moving-HEAD check would run on every future branch and falsely flag unrelated features that
  // legitimately touch server/ or migrations/. Ongoing grading safety is provided by the
  // behavioural/content assertions below + the MVGS regression suite (they run against current code).
  const changed = gradingReleaseChangedFiles();

  // Non-protected grading-UX surfaces the release is allowed to touch. Any client file outside this
  // set fails the guard.
  const ALLOWED_CLIENT = new Set([
    "client/src/components/certificate-form.tsx",
    "client/src/components/rarity-picker/RarityVariantPicker.tsx",
    "client/src/components/admin/admin-shell.tsx",
    "client/src/pages/admin-dashboard.tsx",
    "client/src/components/grading-workflow/CardPreviewPanel.tsx",
    "client/src/lib/lookup-errors.ts",
    // Stage 1/2 usability pass (same branch): rarity contrast + custom-rarity
    // workflow.
    "client/src/components/rarity-picker/RaritySymbol.tsx",
    "client/src/components/grading-workflow/ReviewSummary.tsx",
  ]);

  it("the grading release (PR #214) changed NO grading-protected / schema / migration file", () => {
    for (const f of changed) {
      expect(f, f).not.toMatch(GRADING_PROTECTED_PATHS);
    }
  });

  it("grading release client edits stayed within the allowed grading-UX files (no components/grading touched)", () => {
    const clientEdits = changed.filter((f) => f.startsWith("client/"));
    for (const f of clientEdits) {
      expect(ALLOWED_CLIENT.has(f), `unexpected client file: ${f}`).toBe(true);
    }
    // certificate-form.tsx is always part of the redesign.
    expect(clientEdits).toContain("client/src/components/certificate-form.tsx");
  });

  it("workstationSlot render + the 4-stage contract are preserved", () => {
    expect(FORM).toContain("{workstationSlot}");
    expect(FORM).toContain('data-workflow-stage="grade"');
    expect(FORM).toMatch(/stageClass = \(i: number\) => \(wfStage === i \? "" : "hidden"\)/);
  });
});
