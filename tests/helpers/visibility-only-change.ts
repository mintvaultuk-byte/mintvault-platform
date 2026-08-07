/**
 * "Visibility-only" change detection for the ONE narrowly-authorised exemption to the
 * shared/mvgs-scoring.ts path block.
 *
 * ── THE AUTHORISATION (owner, 2026-08-07) ──────────────────────────────────────────────────
 * The server-authoritative partner MVGS adapter must call the engine's bucket function
 * `remainingToGrade` to derive sub-grades. Its entire diff to the protected engine is:
 *
 *     -function remainingToGrade(remaining: number): number {
 *     +export function remainingToGrade(remaining: number): number {
 *
 * The alternatives were to fork the bracket table into partner code (violates the owner's "ONE
 * MVGS engine, do not fork" rule) or to skip those sub-grades (B3 then blocks every partner
 * publish). The owner approved the export and directed that the guard gain an exemption scoped
 * to: "no added or removed line contains any numeric literal".
 *
 * ── HOW THAT IS IMPLEMENTED, AND WHY IT IS STRICTER THAN THE MINIMUM ───────────────────────
 * Three conditions, ALL required (conjunctive). The exemption is also conjunctive with every
 * pre-existing check at the call site — it replaces nothing.
 *
 *   1. NO DIGIT anywhere in any added or removed line. This is the owner's condition, taken at
 *      face value on the RAW diff text — deliberately NOT on a stripped or tokenised
 *      representation. Scanning raw text is strictly stronger than an AST "NumericLiteral" scan
 *      would be: a threshold smuggled in as `parseInt("23")`, `` `23` ``, `0x17`, a `2`
 *      escape or a comment still contains a digit and is still refused, whereas an AST scan
 *      would classify the first four as StringLiteral / template / escape and miss them. It
 *      also means NO token is stripped before checking, per the standing condition.
 *
 *   2. BODY IDENTICAL. With `export` keywords removed and whitespace normalised, the multiset of
 *      added lines must equal the multiset of removed lines. This is the precise, verifiable
 *      meaning of "an export keyword was added and nothing else happened".
 *
 *   3. EXPORT WIDENED. The added lines must contain strictly more `export` keywords than the
 *      removed ones, so this admits a visibility WIDENING and not some other keyword edit that
 *      happens to normalise away.
 *
 * Condition 2 goes BEYOND the owner's stated minimum, and is declared rather than assumed: the
 * owner's condition alone would admit a genuine mathematics change that happens to contain no
 * digit — for example `-  const g = base;` / `+  const g = base - penalty;` — as well as a
 * comparison-operator flip or a reordering on digit-free lines. Condition 2 closes that, and
 * tests/protected-grader-authority.test.ts proves both conditions are independently
 * load-bearing. Narrowing an exemption is always permitted; widening one is not.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────────────────────
 * This helper is generic, but it is WIRED to `shared/mvgs-scoring.ts` alone. shared/centering.ts,
 * shared/pristine.ts, shared/mvgs-input-builder.ts, server/grading-prompt.ts and server/grader.ts
 * are NOT exempted — the owner authorised one file, so one file is exempted.
 */

/** Added / removed lines of a unified diff, raw, with only the +/- marker dropped. */
function splitDiff(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers
    if (line[0] === "+") added.push(line.slice(1));
    else if (line[0] === "-") removed.push(line.slice(1));
  }
  return { added, removed };
}

/** Remove `export` keywords and collapse whitespace, so only the BODY of the line remains. */
function normaliseBody(line: string): string {
  return line
    .replace(/\bexport\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const countExports = (lines: string[]): number => lines.reduce((n, l) => n + (l.match(/\bexport\b/g)?.length ?? 0), 0);

export interface VisibilityVerdict {
  /** All three conditions hold — the change is a pure visibility widening. */
  ok: boolean;
  /** Condition 1 — true means a digit was found, which DISQUALIFIES the change. */
  hasNumericLiteral: boolean;
  /** Condition 2 — the non-`export` body of the changed lines is unchanged. */
  bodyUnchanged: boolean;
  /** Condition 3 — the change adds `export` keywords rather than removing or swapping them. */
  exportWidened: boolean;
  /** Human-readable explanation, for the guard's assertion message. */
  reason: string;
}

/**
 * Classify a unified diff as a pure visibility-only export change, or not.
 *
 * Returns a structured verdict rather than a boolean so the permanent self-tests can evaluate
 * each condition in isolation and prove it is load-bearing.
 */
export function visibilityOnlyExportChange(diff: string): VisibilityVerdict {
  const { added, removed } = splitDiff(diff);

  // Condition 1 — the owner's condition, on RAW text. Nothing is stripped first.
  const digitLine = [...added, ...removed].find((l) => /[0-9]/.test(l));
  const hasNumericLiteral = digitLine !== undefined;

  // Condition 2 — body identity, as multisets so line ORDER may not change either.
  const a = added.map(normaliseBody).sort();
  const r = removed.map(normaliseBody).sort();
  const bodyUnchanged = a.length === r.length && a.every((v, i) => v === r[i]);

  // Condition 3 — visibility is widened, not merely churned.
  const exportWidened = countExports(added) > countExports(removed);

  // An empty diff is not an exemption; the caller should not have reached here.
  const nonEmpty = added.length > 0 || removed.length > 0;

  const ok = nonEmpty && !hasNumericLiteral && bodyUnchanged && exportWidened;

  const reasons: string[] = [];
  if (!nonEmpty) reasons.push("the diff is empty");
  if (hasNumericLiteral) reasons.push(`a changed line contains a numeric literal: ${digitLine!.trim()}`);
  if (!bodyUnchanged) {
    const onlyAdded = a.filter((x) => !r.includes(x));
    const onlyRemoved = r.filter((x) => !a.includes(x));
    reasons.push(
      `the line body changed, not just its visibility` +
        (onlyAdded.length ? ` (+ ${onlyAdded.join(" | ")})` : "") +
        (onlyRemoved.length ? ` (- ${onlyRemoved.join(" | ")})` : "")
    );
  }
  if (!exportWidened) reasons.push("no `export` keyword was added");

  return {
    ok,
    hasNumericLiteral,
    bodyUnchanged,
    exportWidened,
    reason: ok ? "pure visibility-only export change" : reasons.join("; "),
  };
}
