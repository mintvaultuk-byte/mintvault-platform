/**
 * Grading-workstation UX redesign (AI-first Card stage) — source-assertion tests
 * (the admin grading form is auth-gated, so we assert on the committed source the
 * way the rest of the grading suite does). Proves:
 *   - the Card stage leads with an AI-first identification panel whose primary
 *     actions are Accept / Search Again / Manual (using the EXISTING runIdentify);
 *   - the tall manual field grid is gated behind `manualMode` / `showManualEditor`
 *     and every card field + binding is preserved;
 *   - intelligent set search is wired to the existing /api/pokemon-sets catalogue;
 *   - the Review stage stays a compact dashboard (ReviewSummary + authentication);
 *   - NO protected grading file (client/src/components/grading/, MVGS/scoring/
 *     centering/pristine, grader.ts, labels.ts, certificate-document,
 *     shared/schema.ts, migrations/) was changed by this task, and this session's
 *     only client edit is certificate-form.tsx.
 * Zero provider calls, zero credits.
 *
 * NOTE: this branch also carries unrelated partner-network commits (server/,
 * migrations/000X_partner*, scripts/db/*) from a concurrent session. Those are
 * NOT part of this task; the git guards below are scoped to the grading-protected
 * surface (which none of the partner paths match) and to this session's own
 * working-tree client edits, so they enforce the hard rule without false-failing
 * on that pre-existing contamination.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
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
  it("exposes the three primary actions: Accept · Search Again · Manual", () => {
    expect(FORM).toContain('data-testid="button-accept-identify"');
    expect(FORM).toContain('data-testid="button-ai-identify"');
    expect(FORM).toContain('data-testid="button-manual-entry"');
    expect(FORM).toContain("Accept");
    expect(FORM).toContain("Search Again");
    expect(FORM).toContain('"Hide manual" : "Manual"'); // Manual toggle label
  });
  it("uses the EXISTING runIdentify — no new identify logic, no save/API in the panel", () => {
    const panel = slice('data-testid="ai-identify-panel"', "Same as last card");
    expect(panel).toContain("onClick={runIdentify}"); // Search Again / AI Identify
    expect(panel).toContain("goToStage(1)"); // Accept advances the stage only
    expect(panel).toContain("captureLastCardContext"); // same capture as the existing Continue
    expect(panel).toContain("setManualMode"); // Manual toggles local state
    // The panel triggers no persistence / provider / grade work of its own.
    expect(panel).not.toMatch(/fetch\(|apiRequest|buildCertFormData|method:\s*"(POST|PUT|PATCH)"|runGrade|mutate/);
  });
  it("shows the identified confidence from the existing identifyConfidence state", () => {
    expect(FORM).toContain("identifyConfidence");
    expect(FORM).toContain("identifyVerified");
  });
});

describe("manual editor gated behind manualMode (spec 1)", () => {
  it("manualMode local state + showManualEditor derivation exist", () => {
    expect(FORM).toContain("const [manualMode, setManualMode] = useState(false)");
    expect(FORM).toContain("showManualEditor");
    expect(FORM).toContain("const showManualEditor = manualMode || identifyConfidence === \"low\" || !aiIdentifyAvailable");
  });
  it("the manual field grid renders only when showManualEditor is true", () => {
    expect(FORM).toContain("{showManualEditor && (");
    expect(FORM).toContain('data-testid="manual-card-editor"');
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
  // Grading-protected surface + schema + migrations. Scoped to THIS redesign
  // commit's footprint (HEAD vs its parent = the isolated-worktree base
  // b5fe522c). The redesign is a single clean commit on top of the two-column
  // shell, so its own diff is the exact frame to guard.
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|grader\.ts|grading-prompt|labels\.ts|certificate-document|shared\/schema\.ts|^migrations\//;

  // Files this redesign commit changed. Falls back to the working tree if HEAD
  // has no parent (shouldn't happen here) so the guard never silently no-ops.
  const changed = (() => {
    try {
      return execSync("git diff --name-only HEAD~1 HEAD", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
      return execSync("git diff --name-only", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    }
  })();

  it("this session changed NO grading-protected / schema / migration file", () => {
    expect(changed.length).toBeGreaterThan(0);
    for (const f of changed) {
      expect(f, f).not.toMatch(PROTECTED);
    }
  });

  it("this session's ONLY client edit is certificate-form.tsx (no components/grading touched)", () => {
    const clientEdits = changed.filter((f) => f.startsWith("client/"));
    expect(clientEdits).toEqual(["client/src/components/certificate-form.tsx"]);
  });

  it("workstationSlot render + the 4-stage contract are preserved", () => {
    expect(FORM).toContain("{workstationSlot}");
    expect(FORM).toContain('data-workflow-stage="grade"');
    expect(FORM).toMatch(/stageClass = \(i: number\) => \(wfStage === i \? "" : "hidden"\)/);
  });
});
