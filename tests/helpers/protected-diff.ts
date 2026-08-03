/**
 * Fail-closed base resolution for the protected-system guards.
 *
 * WHY THIS EXISTS. Both protected-grading guards previously called
 * `git diff --name-only origin/main` directly. Under a shallow `actions/checkout`
 * (the default `fetch-depth: 1`) `origin/main` may not exist in the local object
 * store at all. `git diff` against a missing ref THROWS — but an empty or partial
 * history can also yield an EMPTY changed-file list, in which case the guard's
 * `for (const f of changed)` loop never executes and the test reports GREEN while
 * enforcing nothing. That is the exact silent-skip failure mode this repository has
 * been bitten by before, and a protected-system guard is the last place it may occur.
 *
 * So base resolution is explicit and FAILS CLOSED:
 *   • the base ref must resolve to a real commit, and
 *   • a merge-base with HEAD must exist,
 * or we throw. A guard that cannot establish what changed must never pass.
 *
 * Note the deliberate asymmetry: an empty diff is legitimate ON the base itself
 * (nothing changed), so emptiness alone is not treated as failure — what is treated
 * as failure is being UNABLE TO ESTABLISH the comparison at all.
 */
import { execFileSync } from "node:child_process";

export const PROTECTED_DIFF_BASE = process.env.PROTECTED_GUARD_BASE || "origin/main";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Resolve the commit the protected guards compare against.
 * Throws — never returns a sentinel — if the base cannot be established.
 */
export function resolveProtectedBase(base: string = PROTECTED_DIFF_BASE): string {
  let baseSha: string;
  try {
    baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]);
  } catch {
    throw new Error(
      `PROTECTED GUARD FAIL-CLOSED: base ref "${base}" does not resolve to a commit. ` +
        `Under a shallow checkout this guard would otherwise see an empty diff and pass while ` +
        `enforcing nothing. Fetch the base (actions/checkout fetch-depth: 0, or an explicit ` +
        `git fetch origin main) before running the protected-system suites.`
    );
  }

  try {
    git(["merge-base", baseSha, "HEAD"]);
  } catch {
    throw new Error(
      `PROTECTED GUARD FAIL-CLOSED: no merge-base between "${base}" (${baseSha.slice(0, 8)}) and HEAD. ` +
        `The histories are unrelated or truncated, so the changed-file set cannot be trusted.`
    );
  }

  return baseSha;
}

/**
 * Changed files vs the protected base, diffed from the MERGE-BASE rather than the
 * base tip, so unrelated commits landing on main after this branch forked are not
 * misattributed to it.
 */
export function protectedChangedFiles(base: string = PROTECTED_DIFF_BASE): string[] {
  const baseSha = resolveProtectedBase(base);
  const mergeBase = git(["merge-base", baseSha, "HEAD"]);
  return git(["diff", "--name-only", mergeBase])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Diff body for one path, against the same merge-base the file list came from. */
export function protectedDiffFor(file: string, base: string = PROTECTED_DIFF_BASE): string {
  const baseSha = resolveProtectedBase(base);
  const mergeBase = git(["merge-base", baseSha, "HEAD"]);
  return execFileSync("git", ["diff", mergeBase, "--", file], { encoding: "utf8" });
}
