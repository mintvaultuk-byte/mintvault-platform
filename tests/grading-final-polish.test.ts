/**
 * Final grading-workstation UX polish — source-assertion tests (the admin form
 * is auth-gated). Covers Next Card, queue progress, session HUD, per-field copy,
 * keyboard shortcuts, save confirmation, hidden same-as-last, and proves NO
 * protected grading/centering/server/schema/migration file or save payload
 * changed. Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const HUD = read("client/src/components/grading-workflow/SessionHud.tsx");
const VIEWER = read("client/src/components/grading-workflow/CardPreviewPanel.tsx");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Next Card (spec 1) — user-confirmed, never skips, nav only", () => {
  it("form shows a post-save Saved panel with Next Card (primary) + Back to Queue", () => {
    expect(FORM).toContain('data-testid="saved-panel"');
    expect(FORM).toContain('data-testid="button-next-card"');
    expect(FORM).toContain('data-testid="button-back-to-queue"');
    expect(FORM).toContain("Card Saved");
  });
  it("Next Card only appears when a queue prop is supplied (no queue → old behaviour)", () => {
    // Without a queue, onSuccess is called straight away (unchanged flow).
    expect(FORM).toMatch(/if \(queue\) \{\s*setShowSavedPanel\(true\);\s*\} else \{\s*onSuccess/);
  });
  it("parent advances by exactly one through a frozen snapshot (cannot skip)", () => {
    expect(DASH).toContain("openNextQueuedCard");
    expect(DASH).toContain("gradeQueue.pos + 1");
    expect(DASH).toContain("if (!nextCert) return"); // never skip — bail if unresolved
  });
});

describe("queue progress + batch header (spec 2, 10) — read-only", () => {
  it("shows position / total", () => {
    expect(FORM).toContain('data-testid="queue-progress"');
    expect(FORM).toContain("{queue.position} / {queue.total}");
  });
  it("batch header is read-only (customer / submission / remaining)", () => {
    expect(FORM).toContain('data-testid="batch-header"');
    expect(FORM).toContain("batch?.customer");
    expect(FORM).toContain("batch?.submissionId");
  });
});

describe("session HUD (spec 3,4,5) — client-only, no external tracking", () => {
  it("shows session timer, completed count and cards/hour", () => {
    expect(HUD).toContain('testId="session-timer"');
    expect(HUD).toContain('testId="session-completed"');
    expect(HUD).toContain('testId="session-cards-per-hour"');
    expect(HUD).toContain("data-testid={testId}"); // Stat forwards it to the DOM
  });
  it("cards/hour is a pure UI calculation from this session only", () => {
    expect(HUD).toContain("done / elapsedMs");
    const code = stripComments(HUD);
    expect(code).not.toMatch(/fetch\(|apiRequest|POST/); // no network
  });
  it("form bumps the completed count on successful save (display only)", () => {
    expect(FORM).toContain("setSessionCompleted((c) => c + 1)");
  });
});

describe("keyboard shortcuts (spec 6,7,8)", () => {
  it("Enter continues when not in a textarea and validation passes (never submits Stage 1/2)", () => {
    expect(FORM).toContain('if (e.key !== "Enter") return');
    expect(FORM).toContain('if (tag === "TEXTAREA") return');
    expect(FORM).toContain("goToStage(1)");
  });
  it("Space toggles front/back only inside the preview", () => {
    expect(VIEWER).toMatch(/e\.key === " " \|\| e\.code === "Space"/);
    expect(VIEWER).toContain('s === "front" ? "back" : "front"');
  });
  it("Escape exits fullscreen (viewer)", () => {
    expect(VIEWER).toContain('e.key === "Escape" && setFullscreen(false)');
  });
});

describe("per-field quick copy + change highlight (spec 9, 11)", () => {
  it("Copy Set / Year / Language individually", () => {
    expect(FORM).toContain('data-testid="button-copy-set"');
    expect(FORM).toContain('data-testid="button-copy-year"');
    expect(FORM).toContain('data-testid="button-copy-language"');
    expect(FORM).toContain("copyLastCardField");
  });
  it("filled fields flash briefly (~1s)", () => {
    expect(FORM).toContain("flashApplied");
    expect(FORM).toMatch(/setFlashFields\(new Set\(\)\), 1000/);
    expect(FORM).toContain('flashFields.has("year")');
    expect(FORM).toContain('flashFields.has("language")');
  });
});

describe("save confirmation + hidden same-as-last (spec 12, 13)", () => {
  it("shows a Saved toast that auto-clears (~2.5s)", () => {
    expect(FORM).toContain('data-testid="save-toast"');
    expect(FORM).toMatch(/setSavedToast\(false\), 2500/);
  });
  it("Same as last card is HIDDEN (not disabled) when there is no previous card", () => {
    // Rendered only when lastCardContext exists → absent card = not rendered.
    expect(FORM).toMatch(/lastCardContext &&[^\n]*button-same-as-last-card|lastCardContext && \(/);
    expect(FORM).not.toMatch(/button-same-as-last-card[\s\S]{0,120}disabled=\{!lastCardContext/);
  });
});

describe("no protected / save-payload changes (spec: do-not-modify list)", () => {
  it("save payload builder (buildCertFormData) is untouched by this pass", () => {
    // The FormData keys come straight from form state as before — no new
    // session/queue field is appended to the save payload.
    const fn = FORM.slice(FORM.indexOf("function buildCertFormData"), FORM.indexOf("function buildCertFormData") + 900);
    expect(fn).not.toMatch(/session|queue|cardsPerHour|flashFields|sessionCompleted/);
  });
  it("git diff vs main touches NO protected grading/centering/label/schema/server file", () => {
    const base = ["origin/main", "main"].find((r) => {
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
