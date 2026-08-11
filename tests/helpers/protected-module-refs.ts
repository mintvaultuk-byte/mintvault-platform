/**
 * Module-reference extraction for the MVGS protected-file guards.
 *
 * ── WHY THIS EXISTS (hostile-review blind spot, 2026-08-07) ─────────────────────────────────
 * tests/helpers/strip-non-code.ts blanks StringLiteral INTERIORS in BOTH analysis modes:
 *
 *     case ts.SyntaxKind.StringLiteral:
 *       blank(chars, node.getStart(sf) + 1, node.getEnd() - 1);
 *
 * That is correct and deliberate — it is what stops user-facing prose, error copy and SQL text
 * from satisfying a JavaScript signature (N5), and it is what lets an operator message legally
 * read "Re-run the MVGS workstation…". But a module SPECIFIER is also a StringLiteral, so it
 * vanishes too, and a reach into a protected grading engine becomes invisible to every
 * token-scanning guard:
 *
 *     const seg = ["@shared", "cent" + "ering"].join("/");
 *     const eng = await import(seg);            // ← no protected token survives the stripper
 *
 * ── WHY A DEDICATED CHECK, NOT "STOP BLANKING SPECIFIERS" ──────────────────────────────────
 * The founder's instruction offered both routes. A dedicated extractor is chosen, for two
 * reasons, the second of which is decisive:
 *
 *   1. SAFETY. Un-blanking specifier text feeds it straight back into `addedJs`, the exact
 *      representation the founder-authorised signatures A-D are matched against. A specifier is
 *      attacker-controlled free text, so `await import("class GradeDraftRejected … " +
 *      "checkPrintableGrade(")` would then satisfy signature B out of pure string content —
 *      re-opening N5, the bypass strip-non-code exists to close. A dedicated pass cannot reach
 *      the signature regexes at all, so it adds detection without widening anything.
 *
 *   2. CORRECTNESS. Preserving the literal TEXT does not even catch the demonstrated attack.
 *      `["@shared", "cent" + "ering"]` preserved verbatim spells "@shared", "cent", "ering" —
 *      a /centering/ scan still misses it. Detection requires RESOLVING the expression, which
 *      is what this module does: constant-folding over concatenation, `.join()`, `.concat()`,
 *      templates and single-assignment local bindings.
 *
 * Nothing here modifies strip-non-code.ts. Both existing modes, and every existing protection
 * built on them, are byte-for-byte unchanged.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────────────────────
 * A dynamic `import(…)` / `require(…)` whose specifier cannot be folded to a constant is
 * reported as UNRESOLVED rather than assumed benign. A guard that cannot establish where a
 * module reference points must not report green — the same principle as
 * tests/helpers/protected-diff.ts.
 */
import ts from "typescript";

/** How a module reference was written. Static forms are always literal per the language spec. */
export type ModuleRefForm =
  "import-declaration" | "export-declaration" | "import-equals" | "dynamic-import" | "require";

export interface ModuleRef {
  /** The folded specifier, or null when it could not be resolved to a constant. */
  specifier: string | null;
  form: ModuleRefForm;
  /** Source text of the specifier expression, for error messages. */
  text: string;
}

/**
 * Modules that ARE the protected grade-CALCULATION engine: the MVGS scoring tables, the
 * centering mathematics, the Pristine gate, the MVGS input builder, the grading prompt and the
 * cert-Pristine derivation.
 *
 * This is the CALCULATION surface only — deliberately the same set the sibling guards' token
 * scans name (`mvgs|pristine|centering|…`), expressed as module paths. `server/grader.ts`
 * itself is NOT listed: it is the grader WORKFLOW module, and `server/routes/grader.ts` is its
 * own HTTP layer, so `import … from "../grader"` is the normal, required shape of that file.
 * Listing it would make this guard fire on every legitimate build — the failure mode the
 * founder explicitly called out ("a guard that fires on everything gets disabled by the next
 * engineer"). server/grader.ts stays protected by the existing signature guards, unchanged.
 */
export const PROTECTED_ENGINE_MODULE =
  /(^|[/\\])(mvgs-scoring|pristine|centering|mvgs-input-builder|grading-prompt|cert-pristine)(\.[jt]sx?)?$/;

/** True when a folded specifier names a protected grading-engine module. */
export function isProtectedEngineModule(specifier: string): boolean {
  // Strip a query/fragment suffix (`?raw`, `#frag`) so it cannot be used to dodge the match.
  const clean = specifier.split(/[?#]/)[0].replace(/\/+$/, "");
  return PROTECTED_ENGINE_MODULE.test(clean);
}

/** Collect every `const/let/var NAME = <init>` binding, so `import(seg)` can be followed. */
function collectBindings(sf: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  const seenTwice = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      // A name assigned more than once is ambiguous — refuse to fold it rather than guess.
      if (bindings.has(name)) seenTwice.add(name);
      bindings.set(name, node.initializer);
    } else if (
      // A later REASSIGNMENT (`s = "@shared/centering"`) is not a VariableDeclaration, so it
      // would otherwise leave the guard folding the stale initialiser and reporting clean —
      // a silent pass on a mutated specifier. Any assignment to a name makes it ambiguous.
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      seenTwice.add(node.left.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  for (const name of seenTwice) bindings.delete(name);
  return bindings;
}

/**
 * Constant-fold an expression to a string, or return null when it is not statically knowable.
 *
 * Handles exactly the forms that can spell a module path without a bare literal:
 * string / template literals, `+` concatenation, parenthesised expressions, `as`/`!` casts,
 * `Array.join`, `String.concat`, and single-assignment local identifiers.
 */
function foldToString(node: ts.Expression, bindings: Map<string, ts.Expression>, seen: Set<ts.Node>): string | null {
  if (seen.has(node)) return null; // self-referential binding
  seen.add(node);

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return foldToString(node.expression, bindings, seen);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return foldToString(node.expression, bindings, seen);
  }

  if (ts.isIdentifier(node)) {
    const init = bindings.get(node.text);
    return init ? foldToString(init, bindings, seen) : null;
  }

  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const part = foldToString(span.expression, bindings, seen);
      if (part === null) return null;
      out += part + span.literal.text;
    }
    return out;
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldToString(node.left, bindings, seen);
    const r = foldToString(node.right, bindings, seen);
    return l === null || r === null ? null : l + r;
  }

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const target = node.expression.expression;

    // ["a", "b"].join("/")  —  the demonstrated bypass.
    if (method === "join" && ts.isArrayLiteralExpression(target)) {
      const sepArg = node.arguments[0];
      const sep = sepArg === undefined ? "," : foldToString(sepArg, bindings, seen);
      if (sep === null) return null;
      const parts: string[] = [];
      for (const el of target.elements) {
        if (ts.isSpreadElement(el)) return null;
        const p = foldToString(el, bindings, seen);
        if (p === null) return null;
        parts.push(p);
      }
      return parts.join(sep);
    }

    // "a".concat("b", "c")
    if (method === "concat") {
      const head = foldToString(target, bindings, seen);
      if (head === null) return null;
      let out = head;
      for (const a of node.arguments) {
        const p = foldToString(a, bindings, seen);
        if (p === null) return null;
        out += p;
      }
      return out;
    }
  }

  return null;
}

/**
 * Every module reference in `source`, with its specifier folded to a constant where possible.
 * Error-tolerant: a partial diff hunk still parses (same rationale as strip-non-code.ts).
 */
export function moduleReferencesOf(source: string): ModuleRef[] {
  const sf = ts.createSourceFile("__refs__.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = collectBindings(sf);
  const refs: ModuleRef[] = [];

  const push = (expr: ts.Expression | undefined, form: ModuleRefForm): void => {
    if (!expr) return;
    refs.push({ specifier: foldToString(expr, bindings, new Set()), form, text: expr.getText(sf) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) push(node.moduleSpecifier, "import-declaration");
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) push(node.moduleSpecifier, "export-declaration");
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      push(node.moduleReference.expression, "import-equals");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) push(node.arguments[0], "dynamic-import");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        push(node.arguments[0], "require");
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return refs;
}

export interface ProtectedReachReport {
  /** References that resolve to a protected grading-engine module. */
  hits: ModuleRef[];
  /** DYNAMIC references whose specifier could not be folded — treated as failures (fail-closed). */
  unresolved: ModuleRef[];
}

/**
 * Analyse `source` for reaches into the protected grading engine.
 *
 * Static declarations with an unfoldable specifier are impossible (the grammar requires a
 * literal), so only dynamic `import()` / `require()` can be unresolved — and an unresolved
 * dynamic reach inside a protected file is exactly the evasion this module exists to catch.
 */
export function protectedEngineReach(source: string): ProtectedReachReport {
  const hits: ModuleRef[] = [];
  const unresolved: ModuleRef[] = [];
  for (const ref of moduleReferencesOf(source)) {
    if (ref.specifier === null) {
      if (ref.form === "dynamic-import" || ref.form === "require") unresolved.push(ref);
      continue;
    }
    if (isProtectedEngineModule(ref.specifier)) hits.push(ref);
  }
  return { hits, unresolved };
}

/**
 * Human-readable failure text, or "" when the source is clean. Used as the assertion message
 * so a red guard names the exact expression that tripped it.
 */
export function describeProtectedEngineReach(source: string): string {
  const { hits, unresolved } = protectedEngineReach(source);
  const parts: string[] = [];
  for (const h of hits) parts.push(`reaches protected grading module "${h.specifier}" via ${h.form}: ${h.text}`);
  for (const u of unresolved) {
    parts.push(`unresolvable ${u.form} specifier (fail-closed — it may reach the grading engine): ${u.text}`);
  }
  return parts.join("; ");
}

/** Convenience: the module-reference report for a unified diff's added (or removed) lines. */
export function diffProtectedEngineReach(diff: string, sign: "+" | "-" | "both" = "+"): string {
  const wanted = sign === "both" ? ["+", "-"] : [sign];
  const source = diff
    .split("\n")
    .filter((l) => wanted.includes(l[0]) && !l.startsWith("+++") && !l.startsWith("---"))
    .map((l) => l.slice(1))
    .join("\n");
  return describeProtectedEngineReach(source);
}
