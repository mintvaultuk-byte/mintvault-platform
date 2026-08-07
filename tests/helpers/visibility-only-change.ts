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
 * ── HOSTILE-REVIEW FINDING (HIGH, 2026-08-07) — WHY THIS FILE WAS REWRITTEN ────────────────
 * The first implementation compared added and removed line bodies as SORTED multisets:
 *
 *     const a = added.map(normaliseBody).sort();      // ← .sort() destroys order sensitivity
 *     const bodyUnchanged = a.every((v, i) => v === r[i]);
 *
 * A pure REORDERING is therefore body-identical. Bundled with the authorised `export` addition,
 * the "export widened" condition was satisfied too, so the whole conjunction passed. The
 * reviewer's payload exported `worstCeiling` AND moved
 *
 *     if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);
 *
 * from BEFORE `finalGrade` to AFTER it — removing the crease / wrinkle / tear structural
 * ceiling from the final grade entirely, so a card with a major tear grades as undamaged.
 * Digit-free, syntactically valid, and the guard returned `ok: true`. This is the same
 * "ride alongside the approved change" attack that was closed for digits and left open for
 * ordering.
 *
 * ── WHY NEITHER SUGGESTED FIX IS SUFFICIENT ON ITS OWN ─────────────────────────────────────
 * The suggestions were "compare added/removed as ORDERED sequences" or "require a strict
 * line-for-line pairing". Both are necessary but NOT sufficient, and would have left the
 * reviewer's own payload passing. In that payload the moved line is TEXTUALLY IDENTICAL on both
 * sides — the diff is:
 *
 *     -  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);
 *        const scoreGrade = gradeFromMvgsScore(score);
 *        const finalGrade = Math.min(scoreGrade, maxGrade);
 *     +  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);
 *
 * so removed = [X] and added = [X]. An ordered comparison pairs index 0 with index 0, finds
 * X === X, and passes. Line-for-line pairing does the same. What changed is not the set, the
 * multiset, or the ORDER of the changed lines — it is the line's POSITION RELATIVE TO THE
 * UNCHANGED CONTEXT, and neither suggestion looks at context at all.
 *
 * ── THE FIX: HUNK-IMAGE IDENTITY ───────────────────────────────────────────────────────────
 * For each hunk, reconstruct the BEFORE image (context + removed lines, in file order) and the
 * AFTER image (context + added lines, in file order). Normalise away ONLY `export` keywords and
 * trailing whitespace. The two images must be IDENTICAL SEQUENCES.
 *
 * That is the exact, complete statement of "nothing changed except visibility": same lines, same
 * order, same positions relative to unchanged code. Reordering, moving a line across context,
 * inserting, deleting, operator flips and threshold edits all break image identity by
 * construction — no enumeration of attack shapes required. Internal whitespace is now
 * significant too (only trailing whitespace is trimmed), so a reflow cannot hide a change
 * inside a template literal; a genuine reformat simply falls back to owner review.
 *
 * ── THE CONDITIONS (all required, conjunctive) ─────────────────────────────────────────────
 *   1. NO DIGIT in any added or removed line. The owner's condition, on RAW diff text —
 *      deliberately not a stripped or tokenised representation. Raw-text scanning is stronger
 *      than an AST "NumericLiteral" scan: a threshold smuggled as `parseInt("23")`, `` `23` ``,
 *      `0x17` or `23` still contains a digit and is still refused, whereas an AST scan
 *      would classify the first three as StringLiteral / template / escape and miss them. It
 *      also means NO token is stripped before checking, per the standing condition.
 *   2. IMAGE IDENTITY (above). Replaces the defeated multiset comparison.
 *   3. EXPORT WIDENED — the added lines carry strictly more `export` keywords than the removed
 *      ones, so this admits a visibility WIDENING and not some other keyword edit.
 *
 * `bodyUnchanged` (the old, defeated multiset predicate) is RETAINED as a reported field but is
 * no longer sufficient on its own. It exists so the permanent self-tests can demonstrate, in
 * code, that image identity is load-bearing and that the multiset check alone is not.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────────────────────
 * This helper is generic, but it is WIRED to `shared/mvgs-scoring.ts` alone. shared/centering.ts,
 * shared/pristine.ts, shared/mvgs-input-builder.ts, server/grading-prompt.ts and server/grader.ts
 * are NOT exempted — the owner authorised one file, so one file is exempted.
 */

/** One hunk of a unified diff, as its BEFORE and AFTER line images. */
interface HunkImages {
  before: string[];
  after: string[];
}

/**
 * Split a unified diff into hunks and reconstruct each one's BEFORE and AFTER images.
 *
 * Context lines (leading space) belong to BOTH images and are what make the check
 * position-aware — they are the anchor a moved line moves relative to.
 */
function hunkImages(diff: string): HunkImages[] {
  const hunks: HunkImages[] = [];
  let current: HunkImages | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      current = { before: [], after: [] };
      hunks.push(current);
      continue;
    }
    // File headers and git metadata sit outside any hunk.
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) continue;
    if (current === null) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = line[0];
    const body = line.slice(1);
    if (marker === "+") current.after.push(body);
    else if (marker === "-") current.before.push(body);
    else if (marker === " " || line === "") {
      // Context — present in both images. An empty string is an empty context line.
      current.before.push(body);
      current.after.push(body);
    }
  }
  return hunks;
}

/**
 * Normalise a line for IMAGE comparison: remove `export` keywords, trim trailing whitespace.
 * Leading indentation and internal whitespace stay SIGNIFICANT.
 */
function normaliseForImage(line: string): string {
  return line.replace(/\bexport\s+/g, "").replace(/\s+$/, "");
}

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

/** The OLD, defeated normalisation — retained only so the self-tests can exhibit its weakness. */
function normaliseBody(line: string): string {
  return line
    .replace(/\bexport\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const countExports = (lines: string[]): number => lines.reduce((n, l) => n + (l.match(/\bexport\b/g)?.length ?? 0), 0);

export interface VisibilityVerdict {
  /** All conditions hold — the change is a pure visibility widening. */
  ok: boolean;
  /** Condition 1 — true means a digit was found, which DISQUALIFIES the change. */
  hasNumericLiteral: boolean;
  /**
   * Condition 2 — every hunk's BEFORE and AFTER images are identical once `export` keywords are
   * removed. Order- AND position-sensitive. This is the check that closes the reorder bypass.
   */
  imageIdentical: boolean;
  /**
   * The OLD multiset predicate, kept for reporting and for the self-tests only. It is TRUE for a
   * pure reordering, which is exactly why it is no longer sufficient on its own.
   */
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

  // Condition 2 — per-hunk BEFORE/AFTER image identity (order- and position-sensitive).
  const hunks = hunkImages(diff);
  let firstImageMismatch = "";
  const imageIdentical =
    hunks.length > 0 &&
    hunks.every((h) => {
      const b = h.before.map(normaliseForImage);
      const a = h.after.map(normaliseForImage);
      const same = b.length === a.length && b.every((v, i) => v === a[i]);
      if (!same && !firstImageMismatch) {
        const i = b.findIndex((v, idx) => v !== a[idx]);
        firstImageMismatch =
          b.length !== a.length
            ? `hunk changed line count (${b.length} before, ${a.length} after)`
            : `line ${i + 1} of the hunk moved or changed: "${(b[i] ?? "").trim()}" -> "${(a[i] ?? "").trim()}"`;
      }
      return same;
    });

  // Retained weaker predicate — reported, never sufficient. TRUE for a pure reordering.
  const bs = removed.map(normaliseBody).sort();
  const as = added.map(normaliseBody).sort();
  const bodyUnchanged = as.length === bs.length && as.every((v, i) => v === bs[i]);

  // Condition 3 — visibility is widened, not merely churned.
  const exportWidened = countExports(added) > countExports(removed);

  // An empty diff is not an exemption; the caller should not have reached here.
  const nonEmpty = added.length > 0 || removed.length > 0;

  const ok = nonEmpty && !hasNumericLiteral && imageIdentical && exportWidened;

  const reasons: string[] = [];
  if (!nonEmpty) reasons.push("the diff is empty");
  if (hasNumericLiteral) reasons.push(`a changed line contains a numeric literal: ${digitLine!.trim()}`);
  if (!imageIdentical) {
    reasons.push(
      hunks.length === 0
        ? "no diff hunk could be parsed (fail-closed)"
        : `code moved or changed, not just its visibility — ${firstImageMismatch}`
    );
  }
  if (!exportWidened) reasons.push("no `export` keyword was added");

  return {
    ok,
    hasNumericLiteral,
    imageIdentical,
    bodyUnchanged,
    exportWidened,
    reason: ok ? "pure visibility-only export change" : reasons.join("; "),
  };
}
