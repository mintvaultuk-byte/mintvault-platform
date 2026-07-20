/**
 * Historical release-scope proof for the grading-workstation redesign (PR #214).
 *
 * WHAT THIS IS
 * ------------
 * The grading guards prove that the grading-workstation RELEASE ITSELF stayed inside its approved
 * file scope. They are pinned to the FIXED, IMMUTABLE commit range the grading task actually
 * shipped — NOT to `<moving-base>...HEAD`.
 *
 * WHY (the bug this fixes)
 * ------------------------
 * Originally each guard compared `origin/main...HEAD` (or `b5fe522c...HEAD`). On the grading branch
 * that range equalled only the grading changes — a correct branch-scope check. But once PR #214
 * merged these tests into `main`, they began running on EVERY branch, so `<base>...HEAD` became
 * "whatever the current branch changed". Any unrelated future feature that legitimately touches
 * `server/` or `migrations/` (e.g. the Partner Network) then falsely tripped them. Pinning to the
 * grading task's own commit range makes each guard a stable fact about PR #214 that never fires on
 * unrelated future work.
 *
 * IMPORTANT SEMANTIC DISTINCTION
 * ------------------------------
 *  - HISTORICAL release-scope proof (this module): "did PR #214 stay in its lane?" — immutable,
 *    resolved only from d69ad147..fc57b53b, unaffected by HEAD / origin-main / branch name.
 *  - ONGOING grading safety: "did anyone just break grading?" — provided by the behavioural/content
 *    assertions in the same test files (which read the CURRENT code) plus the MVGS regression suite
 *    (mvgs-scoring / pristine / centering / mvgs-input-builder). Those run against current code and
 *    MUST continue to catch future grading regressions.
 *
 * Do NOT rely on this fixed-range check to detect future edits to grading files — that is the job of
 * the current-code tests above.
 *
 * FAIL-CLOSED: unlike the old guards (which silently `return`/passed when no base ref resolved),
 * this throws if either pinned commit is unreachable in the current checkout. That is deliberate —
 * a guard that can't be evaluated should error, not silently pass. It does mean CI must fetch deep
 * enough for d69ad147/fc57b53b to be reachable (both are permanent origin/main history post PR #214,
 * so a normal non-shallow or sufficiently-deep clone always has them).
 */
import { execFileSync } from "node:child_process";

/** Immutable metadata for the grading-workstation release (PR #214). */
export const GRADING_RELEASE = {
  id: "grading-workstation-ux-redesign (PR #214)",
  base: "d69ad147", // main immediately BEFORE the grading-workstation work
  final: "fc57b53b", // final grading-workstation commit merged by PR #214
} as const;

/**
 * Immutable metadata for the unified-AdminShell grading pass (the AdminHeaderRow /
 * WorkstationHeaderStrip / WorkstationPreviewAside primitives + the retire-
 * duplicate-tab refactor + its own base-drift-fix commit). Pinning BOTH endpoints
 * to fixed SHAs makes the "did THIS pass touch protected files?" scope an immutable
 * historical fact — the same de-drift pattern GRADING_RELEASE already uses. The
 * two guards (grading-retire-duplicate-tab, grading-unified-admin-shell) previously
 * used a LOCAL moving-window `${base}...HEAD`; once origin/main advanced past the
 * base (Partner Network G2–G4: server/partner/*, migrations 0009–0014, partner
 * pages, .claude task docs), that window drifted to include all that unrelated
 * later work and false-tripped the protected-path matcher. `0825544a..a7cac275`
 * contains ONLY this pass's own files and NO partner/migration/.claude file.
 */
export const UNIFIED_ADMIN_SHELL = {
  id: "unified-admin-shell + retire-duplicate-tab pass",
  base: "0825544a", // main immediately BEFORE the unified-shell pass
  final: "a7cac275", // final commit of the pass (post-integration base-drift fix)
} as const;

/**
 * Canonical protected-path matcher — the UNION of the individual grading guards' protections, so it
 * is at least as strict as any single guard. Genuinely grading-owned + broad safety nets (server,
 * migrations) are all retained: within the FIXED grading footprint they are correct (the grading
 * task touched none of them), and because the range is fixed they never affect unrelated branches.
 */
export const GRADING_PROTECTED_PATHS =
  /components\/grading\/|mvgs|scoring|centering|pristine|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|schema\.ts|^server\/|^migrations\//;

/** Run git with array args (no shell → no injection). Optional cwd for synthetic-repo tests. */
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
}

function assertCommit(ref: string, cwd?: string): void {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  } catch {
    throw new Error(
      `grading-release-scope: required commit ${ref} is not present in this checkout — cannot prove historical grading scope.`
    );
  }
}

/**
 * Verify a release range is well-formed (both commits exist; final descends from base). Exposed with
 * explicit base/final/cwd so the compatibility tests can exercise it against synthetic repositories.
 */
export function assertRangeValid(base: string, final: string, cwd?: string): void {
  assertCommit(base, cwd);
  assertCommit(final, cwd);
  try {
    git(["merge-base", "--is-ancestor", base, final], cwd);
  } catch {
    throw new Error(`grading-release-scope: ${final} does not descend from ${base} (reversed or non-ancestral range).`);
  }
}

/** Core: files changed between base..final, resolved ONLY from those two fixed commits. */
export function releaseChangedFiles(base: string, final: string, cwd?: string): string[] {
  assertRangeValid(base, final, cwd);
  return git(["diff", "--name-only", `${base}..${final}`], cwd)
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** Files changed by the grading release, from the FIXED historical range (never HEAD). */
export function gradingReleaseChangedFiles(): string[] {
  return releaseChangedFiles(GRADING_RELEASE.base, GRADING_RELEASE.final);
}

/**
 * Files changed by the unified-AdminShell pass, from its FIXED historical range
 * (0825544a..a7cac275) — never `...HEAD`. Replaces the fragile per-file
 * moving-window base that drifted to include unrelated later Partner Network /
 * migration / documentation commits once origin/main advanced past the base.
 */
export function unifiedAdminShellChangedFiles(): string[] {
  return releaseChangedFiles(UNIFIED_ADMIN_SHELL.base, UNIFIED_ADMIN_SHELL.final);
}
/** Diff of ONE file across the grading release range (for content-scope assertions). */
export function gradingReleaseFileDiff(path: string): string {
  assertRangeValid(GRADING_RELEASE.base, GRADING_RELEASE.final);
  return git(["diff", `${GRADING_RELEASE.base}..${GRADING_RELEASE.final}`, "--", path]);
}

/** Protected-path violations within the grading release footprint (should always be empty). */
export function gradingReleaseScopeViolations(): string[] {
  return gradingReleaseChangedFiles().filter((f) => GRADING_PROTECTED_PATHS.test(f));
}
