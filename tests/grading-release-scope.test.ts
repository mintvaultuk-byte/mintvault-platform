/**
 * Tests for the historical grading-release-scope governance helper (tests/helpers/grading-release-scope.ts).
 *
 * Covers: the REAL grading range resolves to the expected immutable footprint and is unaffected by
 * HEAD / origin-main / branch name; and — via disposable synthetic git repositories — that the range
 * validator fails clearly on missing/reversed ranges and that protected-path violations are caught
 * while allowed grading-file changes are accepted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRADING_RELEASE,
  GRADING_PROTECTED_PATHS,
  gradingReleaseChangedFiles,
  gradingReleaseScopeViolations,
  releaseChangedFiles,
  assertRangeValid,
} from "./helpers/grading-release-scope";

const EXPECTED_GRADING_FOOTPRINT = [
  "client/src/components/admin/admin-shell.tsx",
  "client/src/components/certificate-form.tsx",
  "client/src/components/grading-workflow/CardPreviewPanel.tsx",
  "client/src/components/rarity-picker/RarityVariantPicker.tsx",
  "tests/grading-compactness-pass.test.ts",
  "tests/grading-density-pass.test.ts",
  "tests/grading-stages.test.ts",
  "tests/grading-workflow-compact.test.ts",
  "tests/grading-workstation-shell.test.ts",
  "tests/grading-workstation-ux-redesign.test.ts",
].sort();

describe("grading-release-scope — real historical range (immutable)", () => {
  it("1: resolves the grading range successfully (non-empty)", () => {
    expect(gradingReleaseChangedFiles().length).toBeGreaterThan(0);
  });

  it("2: returns the expected grading changed-file inventory", () => {
    expect(gradingReleaseChangedFiles().sort()).toEqual(EXPECTED_GRADING_FOOTPRINT);
  });

  it("3: contains NO Partner Network files", () => {
    expect(gradingReleaseChangedFiles().filter((f) => /partner/i.test(f))).toEqual([]);
  });

  it("4: contains NO migration files", () => {
    expect(gradingReleaseChangedFiles().filter((f) => /^migrations\//.test(f))).toEqual([]);
  });

  it("5: contains NO server files", () => {
    expect(gradingReleaseChangedFiles().filter((f) => /^server\//.test(f))).toEqual([]);
  });

  it("6-9: result is the FIXED footprint, NOT the current branch diff (no HEAD fallback)", () => {
    // This branch changed the helper + this very test file + the 8 guard files. If the check used
    // <base>...HEAD, those would appear. They do NOT — the helper and this test are absent, and the
    // inventory is exactly the historical footprint — proving resolution from d69ad147..fc57b53b.
    const files = gradingReleaseChangedFiles();
    expect(files).not.toContain("tests/helpers/grading-release-scope.ts");
    expect(files).not.toContain("tests/grading-release-scope.test.ts");
    expect(files).not.toContain("tests/grading-final-polish.test.ts"); // a guard we edited, not in the range
  });

  it("15-16: the historical footprint has no migration/partner/server files regardless of current branch", () => {
    expect(gradingReleaseScopeViolations()).toEqual([]);
  });

  it("pins the immutable release metadata", () => {
    expect(GRADING_RELEASE.base).toBe("d69ad147");
    expect(GRADING_RELEASE.final).toBe("fc57b53b");
  });
});

// ── Synthetic disposable repositories for the failure/violation cases ──
describe("grading-release-scope — synthetic-repo behaviour", () => {
  let dir: string;
  let base = "";
  let allowedFinal = "";
  let violationFinal = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gscope-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00 +0000",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00 +0000",
    };
    const g = (args: string[]): string => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    g(["init", "-q"]);
    g(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "readme.md"), "base\n");
    g(["add", "."]);
    g(["commit", "-q", "-m", "base"]);
    base = g(["rev-parse", "HEAD"]).trim();
    // an ALLOWED grading-style change (a client file, no protected path)
    mkdirSync(join(dir, "client"), { recursive: true });
    writeFileSync(join(dir, "client", "app.tsx"), "ui\n");
    g(["add", "."]);
    g(["commit", "-q", "-m", "allowed grading UI change"]);
    allowedFinal = g(["rev-parse", "HEAD"]).trim();
    // a PROTECTED violation on top (adds a migration)
    mkdirSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(join(dir, "migrations", "0001_x.sql"), "SELECT 1;\n");
    g(["add", "."]);
    g(["commit", "-q", "-m", "violation: touches migrations/"]);
    violationFinal = g(["rev-parse", "HEAD"]).trim();
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("14: an allowed grading-file change is accepted (no protected violation)", () => {
    const changed = releaseChangedFiles(base, allowedFinal, dir);
    expect(changed).toEqual(["client/app.tsx"]);
    expect(changed.filter((f) => GRADING_PROTECTED_PATHS.test(f))).toEqual([]);
  });

  it("13: a protected-file violation in the range is detected", () => {
    const changed = releaseChangedFiles(base, violationFinal, dir);
    expect(changed).toContain("migrations/0001_x.sql");
    expect(changed.filter((f) => GRADING_PROTECTED_PATHS.test(f))).toContain("migrations/0001_x.sql");
  });

  it("10: a missing BASE commit fails clearly", () => {
    expect(() => assertRangeValid("0000000000000000000000000000000000000000", allowedFinal, dir)).toThrow(
      /not present in this checkout/
    );
  });

  it("11: a missing FINAL commit fails clearly", () => {
    expect(() => assertRangeValid(base, "0000000000000000000000000000000000000000", dir)).toThrow(
      /not present in this checkout/
    );
  });

  it("12: a reversed / non-ancestral range fails clearly", () => {
    expect(() => assertRangeValid(allowedFinal, base, dir)).toThrow(/does not descend/);
  });
});

// ── 17: ongoing grading safety still lives in current-code assertions ──
describe("grading-release-scope — ongoing grading safety is separate from the historical proof", () => {
  it("17: each grading guard still contains current-code behavioural/content assertions", () => {
    const guards = [
      "grading-compactness-pass",
      "grading-density-pass",
      "grading-final-polish",
      "grading-review-summary",
      "grading-stages",
      "grading-workstation-shell",
      "grading-workstation-ux",
      "grading-workstation-ux-redesign",
    ];
    for (const g of guards) {
      const src = readFileSync(join(process.cwd(), "tests", `${g}.test.ts`), "utf8");
      // a real content/behaviour assertion against the CURRENT source (not the historical range)
      expect(/expect\((FORM|DASH|code|wrapper|panel|review|fn|src|imports)/.test(src), g).toBe(true);
    }
  });
});
