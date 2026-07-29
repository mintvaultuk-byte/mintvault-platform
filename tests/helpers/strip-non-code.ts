/**
 * "Judge CODE, not prose" analysis for the MVGS protected-file guards.
 *
 * ── HISTORY ────────────────────────────────────────────────────────────────────────────────
 * F2 (2026-07-29): the original guards blanked whole template literals with a regex, so a
 *   one-line `sql`UPDATE certificates SET certificate_number = ${n}`` was invisible — the
 *   `${…}` slots are executable code and tagged-template text is SQL, i.e. exactly what the
 *   guard protects.
 * N1: the hand-written replacement scanner had no regex-literal state, so `const r = /` + a
 *   backtick + `/;` opened template mode and swallowed every following line to EOF — strictly
 *   worse than the per-line version it replaced, which contained the damage to one line.
 * N4: `certificate_number` inside a tagged template reaches PostgreSQL as
 *   `certificate_number` but did not match the guard's identifier regex.
 * N5: tagged-template TEXT was used to satisfy JavaScript implementation signatures, so
 *   `sql`class GradeDraftRejected checkPrintableGrade(`` admitted an arbitrary change.
 *
 * ── APPROACH ───────────────────────────────────────────────────────────────────────────────
 * Tokenisation is delegated to the TypeScript compiler (already a devDependency — it is what
 * `npm run check` runs). Hand-rolling a JavaScript lexer is what produced N1; `ts.createSourceFile`
 * resolves regex-vs-division, escapes, nested templates and comments correctly, and is
 * error-tolerant, so a partial diff hunk still tokenises instead of swallowing the remainder.
 *
 * Two DISTINCT representations, because the two questions are different (N5):
 *
 *   TWO_MODES:
 *   • "js"      — executable JavaScript only. Comments, string contents, untagged template
 *                 prose AND tagged-template text are all removed; `${…}` expressions are kept.
 *                 Used to prove a JavaScript class/function ACTUALLY EXISTS. SQL text can
 *                 never satisfy a signature.
 *   • "guarded" — the above PLUS tagged-template text (the SQL), with JavaScript escape
 *                 sequences decoded, appended for identifier matching. Used for protected SQL
 *                 identifiers and database-write detection.
 *
 * Ranges are blanked in place rather than deleted, so byte offsets and LINE NUMBERS are
 * preserved — the per-line formula guard in variant-line-consolidation.test.ts depends on that.
 */
import ts from "typescript";

export type AnalysisMode = "js" | "guarded";

/** Lines of a unified diff, reduced to the code they add/remove, with the +/- marker dropped. */
export function diffLinesToSource(diff: string, sign: "+" | "-" | "both" = "+"): string {
  const wanted = sign === "both" ? ["+", "-"] : [sign];
  return diff
    .split("\n")
    .filter((l) => wanted.includes(l[0]) && !l.startsWith("+++") && !l.startsWith("---"))
    .map((l) => l.slice(1))
    .join("\n");
}

/** Blank [start,end) with spaces, preserving newlines so line numbers do not shift. */
function blank(chars: string[], start: number, end: number): void {
  for (let i = Math.max(0, start); i < Math.min(end, chars.length); i++) {
    if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
}

/** True when this template literal token belongs to a TAGGED template (sql`…`, css`…`). */
function isTaggedTemplatePart(node: ts.Node): boolean {
  // NoSubstitutionTemplateLiteral -> TaggedTemplateExpression
  // TemplateHead                  -> TemplateExpression -> TaggedTemplateExpression
  // TemplateMiddle / TemplateTail -> TemplateSpan -> TemplateExpression -> TaggedTemplateExpression
  let n: ts.Node | undefined = node.parent;
  for (let hops = 0; n && hops < 3; hops++, n = n.parent) {
    if (ts.isTaggedTemplateExpression(n)) return true;
    if (!ts.isTemplateExpression(n) && !ts.isTemplateSpan(n)) return false;
  }
  return false;
}

/**
 * Decode the JavaScript escape sequences a template literal resolves at runtime, so an
 * identifier written as `certificate_number` is matched as `certificate_number` (N4).
 *
 * Only the escapes that can spell an identifier character are decoded — \uXXXX, \u{…}, \xNN
 * and the standard control escapes. SQL's own escaping is NOT interpreted: this models what
 * JavaScript hands to the tag function, nothing more.
 */
export function decodeJsEscapes(text: string): string {
  return text.replace(
    /\\(u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g,
    (m, _all, brace, u4, x2, other) => {
      try {
        if (brace !== undefined) {
          const cp = parseInt(brace, 16);
          return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
        if (x2 !== undefined) return String.fromCharCode(parseInt(x2, 16));
        // A backslash before an ordinary character is that character in a template literal.
        return other === undefined ? m : other;
      } catch {
        return m; // undecodable — leave raw; hasMalformedEscape() reports it separately
      }
    }
  );
}

/**
 * True when the source contains a malformed JavaScript escape — one that LOOKS like a unicode
 * escape but cannot be decoded. The guards treat this as a violation rather than guessing,
 * so an escape the analyser cannot resolve can never be used to hide an identifier (N4).
 */
export function hasMalformedEscape(source: string): boolean {
  // `\u` not followed by 4 hex digits or a valid {…} form, or `\x` not followed by 2 hex digits.
  if (/\\u(?!\{[0-9a-fA-F]{1,6}\}|[0-9a-fA-F]{4})/.test(source)) return true;
  if (/\\x(?![0-9a-fA-F]{2})/.test(source)) return true;
  // \u{…} with an out-of-range code point.
  for (const m of source.matchAll(/\\u\{([0-9a-fA-F]{1,6})\}/g)) {
    if (parseInt(m[1], 16) > 0x10ffff) return true;
  }
  return false;
}

/**
 * Reduce `source` to executable code under the chosen mode. See the file header for what each
 * mode includes and why they are separate.
 */
export function analyseSource(source: string, mode: AnalysisMode): string {
  // ScriptKind.TS (not TSX) so `<T>` casts parse and a stray `<` cannot be read as JSX.
  const sf = ts.createSourceFile("__diff__.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const chars = source.split("");
  /** Tagged-template text, collected for the "guarded" mode's identifier pass. */
  const taggedText: string[] = [];

  const visit = (node: ts.Node): void => {
    const kids = node.getChildren(sf);

    // Leading trivia of every leaf token is whitespace + comments. The parser has already
    // decided what is a token, so blanking trivia removes comments without any `//` vs regex
    // ambiguity — the exact confusion that produced N1.
    if (kids.length === 0) blank(chars, node.getFullStart(), node.getStart(sf));

    switch (node.kind) {
      // A regex literal is opaque: it is neither prose nor a database write, and crucially a
      // backtick inside it must NOT start template mode (N1).
      case ts.SyntaxKind.RegularExpressionLiteral:
        blank(chars, node.getStart(sf), node.getEnd());
        break;

      // Ordinary strings are always prose.
      case ts.SyntaxKind.StringLiteral:
        blank(chars, node.getStart(sf) + 1, node.getEnd() - 1);
        break;

      // Template literal text. Tagged text is SQL (kept for "guarded", never for "js");
      // untagged text is user-facing prose and is always removed.
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail: {
        const start = node.getStart(sf);
        const end = node.getEnd();
        if (mode === "guarded" && isTaggedTemplatePart(node)) taggedText.push(source.slice(start, end));
        // Blanked in BOTH modes: the tagged text is re-introduced below as appended lines, so
        // it can never be read as JavaScript syntax and can never satisfy a signature (N5).
        blank(chars, start, end);
        break;
      }
    }
    kids.forEach(visit);
  };
  visit(sf);

  let out = chars.join("");
  if (mode === "guarded" && taggedText.length > 0) {
    // Appended, not spliced: appending can only REVEAL identifiers, never hide code, and it
    // leaves the executable region's line numbering intact for the per-line formula guard.
    const decoded = taggedText.map((t) => decodeJsEscapes(t));
    out += "\n" + [...taggedText, ...decoded].join("\n");
  }
  return out;
}

/**
 * Executable JavaScript only — no comments, no string text, no template text (tagged or not).
 * This is the representation a SIGNATURE check must use: SQL can never prove a class exists.
 */
export function stripToJs(source: string): string {
  return analyseSource(source, "js");
}

/**
 * Executable JavaScript plus tagged-template (SQL) text, unicode-decoded. This is the
 * representation the PROTECTED-IDENTIFIER check must use.
 */
export function stripNonCode(source: string): string {
  return analyseSource(source, "guarded");
}

/** Convenience: the guarded representation of a unified diff's added (or removed) code. */
export function addedCodeOf(diff: string, sign: "+" | "-" | "both" = "+"): string {
  return stripNonCode(diffLinesToSource(diff, sign));
}

/** Convenience: the JavaScript-only representation of a unified diff, for signature checks. */
export function addedJsOf(diff: string, sign: "+" | "-" | "both" = "+"): string {
  return stripToJs(diffLinesToSource(diff, sign));
}
