/**
 * Mutation coverage for the MVGS protected-file guard analyser.
 *
 * Pins every bypass hostile review has demonstrated so far:
 *   F2 — single-line template literal hid a database write
 *   N1 — a regex literal containing a backtick opened template mode and swallowed to EOF
 *   N4 — `certificate_number` inside a tagged template evaded the identifier regex
 *   N5 — tagged-template TEXT satisfied a JavaScript implementation signature
 */
import { describe, it, expect } from "vitest";
import {
  stripNonCode,
  stripToJs,
  addedCodeOf,
  addedJsOf,
  diffLinesToSource,
  decodeJsEscapes,
  hasMalformedEscape,
} from "./helpers/strip-non-code";

const FORBIDDEN = /mvgs|pristine|centering|calculateOverallGrade|scoreMvgs|cert_id|certificate_number/i;
/** The protected-identifier question: uses the guarded representation (SQL visible). */
const caught = (src: string) => FORBIDDEN.test(stripNonCode(src));
/** The signature question: uses the JavaScript-only representation (SQL invisible). */
const sigB = (src: string) => {
  const c = stripToJs(src);
  return /class\s+GradeDraftRejected\b/.test(c) && /\bcheckPrintableGrade\s*\(/.test(c);
};

describe("F2 — template literals cannot hide executable code", () => {
  it("catches a SINGLE-LINE sql template rewriting a grade and a certificate number", () => {
    expect(caught("await db.execute(sql`UPDATE certificates SET grade = ${v} WHERE certificate_number = ${n}`);")).toBe(
      true
    );
  });

  it("catches the MULTI-LINE form (parity is the point)", () => {
    expect(
      caught(["await db.execute(sql`", "  UPDATE certificates", "  SET certificate_number = ${n}", "`);"].join("\n"))
    ).toBe(true);
  });

  it("catches identifiers in nested template expressions and tagged member calls", () => {
    expect(caught("const q = sql`SELECT ${cond ? sql`${computeMvgsScore(x)}` : sql`1`} FROM t`;")).toBe(true);
    expect(caught("await tx.execute(db.sql`UPDATE c SET cert_id = ${a}`);")).toBe(true);
  });

  it("ignores prose — the false-positive class stripping exists to prevent", () => {
    expect(caught('error: "Re-run the MVGS workstation so the grade and sub-grades populate.",')).toBe(false);
    expect(caught("// grade is recomputed by MVGS elsewhere; this is only a guard")).toBe(false);
    expect(caught("/* pristine gate is evaluated in shared/pristine.ts */")).toBe(false);
    expect(caught("const msg = `This certificate's centering is recorded elsewhere.`;")).toBe(false);
  });

  it("reduces a unified diff to only the code it adds", () => {
    const diff = ["+++ b/server/grader.ts", "+const a = 1;", "-const b = 2;", " const c = 3;"].join("\n");
    expect(diffLinesToSource(diff, "+")).toBe("const a = 1;");
    expect(addedCodeOf(diff)).toContain("const a = 1;");
    expect(addedJsOf(diff)).toContain("const a = 1;");
  });
});

describe("N1 — regex literals cannot open template mode or swallow code", () => {
  it("REJECTS the exact hostile-review bypass", () => {
    const payload = ["const marker = /`/;", "computeMvgsScore(input);", "grade = score * 0.9;"].join("\n");
    expect(caught(payload)).toBe(true);
  });

  it("a regex-contained backtick does not hide unlimited following code", () => {
    const many = "const r = /`/;\n" + Array.from({ length: 5 }, (_, i) => `const x${i} = scoreMvgs(${i});`).join("\n");
    expect(caught(many)).toBe(true);
  });

  it("handles escaped slashes, character classes and flags", () => {
    expect(caught("const a = /a\\/b/; const c = cert_id;")).toBe(true);
    expect(caught("const a = /[`/]/; const c = certificate_number;")).toBe(true);
    expect(caught("const a = /x/gimsuy; const c = scoreMvgs(1);")).toBe(true);
    expect(caught("const a = /[^`]+/u; computeMvgsScore(v);")).toBe(true);
  });

  it("distinguishes regex from division, including chained division", () => {
    // Division must NOT be treated as a regex (which would swallow the rest of the line).
    expect(caught("const ratio = total / count; const c = cert_id;")).toBe(true);
    expect(caught("const r = a / b / c; const d = certificate_number;")).toBe(true);
    // …and plain arithmetic must not become a false positive.
    expect(caught("const ratio = total / count;")).toBe(false);
    expect(caught("const r = a / b / c;")).toBe(false);
  });

  it("handles a regex in every position that follows an operator or punctuator", () => {
    expect(caught("function f() { return /`/; } const c = cert_id;")).toBe(true);
    expect(caught("const x = /`/; const c = cert_id;")).toBe(true);
    expect(caught("f(/`/); const c = cert_id;")).toBe(true);
    expect(caught("g(a, /`/, b); const c = cert_id;")).toBe(true);
  });

  it("a partial diff hunk or unmatched construct cannot swallow the remainder", () => {
    expect(caught(["  SET cert_id = ${a}", "computeMvgsScore(v);"].join("\n"))).toBe(true);
    expect(caught(["const q = sql`SELECT ${a}", "scoreMvgs(v);"].join("\n"))).toBe(true);
    expect(caught(["const s = 'unterminated", "scoreMvgs(v);"].join("\n"))).toBe(true);
    expect(caught(["const r = /unterminated", "scoreMvgs(v);"].join("\n"))).toBe(true);
  });

  it("tagged SQL AFTER a regex is still inspected", () => {
    expect(
      caught(["const r = /`/;", "await db.execute(sql`UPDATE c SET certificate_number = ${n}`);"].join("\n"))
    ).toBe(true);
  });

  it("does not throw on any malformed input", () => {
    for (const s of ["const q = sql`SELECT ${a}", 'const s = "x', "const r = /a", "`", "${", "/*", "})]"]) {
      expect(() => stripNonCode(s), s).not.toThrow();
      expect(() => stripToJs(s), s).not.toThrow();
    }
  });
});

describe("N4 — unicode escapes inside tagged templates are decoded", () => {
  it("REJECTS the exact hostile-review bypass", () => {
    expect(
      caught("await db.execute(sql`UPDATE certificates SET grade = ${v} WHERE \\u0063ertificate_number = ${n}`);")
    ).toBe(true);
  });

  it("covers \\u{...}, \\xNN and mixed escaped/plain characters", () => {
    expect(caught("await db.execute(sql`SET \\u{63}ertificate_number = ${n}`);")).toBe(true);
    expect(caught("await db.execute(sql`SET \\x63ert_id = ${n}`);")).toBe(true);
    expect(caught("await db.execute(sql`SET c\\u0065rt_id = ${n}`);")).toBe(true);
    expect(caught("await db.execute(sql`SET \\u0043ERT_ID = ${n}`);")).toBe(true); // case-insensitive match
  });

  it("decodes only JavaScript escapes, and leaves ordinary SQL alone", () => {
    expect(decodeJsEscapes("\\u0063ert")).toBe("cert");
    expect(decodeJsEscapes("\\u{63}ert")).toBe("cert");
    expect(decodeJsEscapes("\\x63ert")).toBe("cert");
    // A SQL LIKE pattern's backslash is not a unicode escape and must not corrupt the text.
    expect(decodeJsEscapes("WHERE name LIKE 'a\\_b'")).toBe("WHERE name LIKE 'a_b'");
  });

  it("does not turn harmless prose into a match", () => {
    expect(caught("// \\u0063ertificate_number is mentioned in this comment")).toBe(false);
    expect(caught('const s = "\\u0063ertificate_number";')).toBe(false);
    expect(caught("const s = `\\u0063ertificate_number`;")).toBe(false); // untagged = prose
  });

  it("flags malformed escapes so they fail closed rather than hiding an identifier", () => {
    expect(hasMalformedEscape("sql`SET \\u06rtificate = 1`")).toBe(true); // \u + 2 hex then non-hex
    // …but n IS well-formed (it is 'n'); it decodes rather than being flagged.
    expect(hasMalformedEscape("sql`SET \\u006ertificate = 1`")).toBe(false);
    expect(decodeJsEscapes("\\u006ertificate")).toBe("nrtificate");
    expect(hasMalformedEscape("sql`SET \\uZZZZ = 1`")).toBe(true);
    expect(hasMalformedEscape("sql`SET \\x5 = 1`")).toBe(true);
    expect(hasMalformedEscape("sql`SET \\u{110000} = 1`")).toBe(true); // above max code point
    expect(hasMalformedEscape("sql`SET \\u0063ert = 1`")).toBe(false);
    expect(hasMalformedEscape("sql`SET \\u{63}ert = 1`")).toBe(false);
    expect(hasMalformedEscape("const r = /a\\/b/;")).toBe(false);
  });
});

describe("N5 — SQL text can never satisfy a JavaScript signature", () => {
  it("real class plus real call → PASS", () => {
    expect(
      sigB(
        [
          "export class GradeDraftRejected extends Error {",
          "  readonly status: number;",
          "}",
          "const verdict = checkPrintableGrade({ gradeType: gr?.grade_type ?? null });",
        ].join("\n")
      )
    ).toBe(true);
  });

  it("comment only → FAIL", () => {
    expect(sigB("// see class GradeDraftRejected and checkPrintableGrade(x) for context")).toBe(false);
    expect(sigB("/* class GradeDraftRejected ... checkPrintableGrade(...) */")).toBe(false);
  });

  it("ordinary string → FAIL", () => {
    expect(sigB('const s = "class GradeDraftRejected checkPrintableGrade(";')).toBe(false);
    expect(sigB("const s = 'class GradeDraftRejected checkPrintableGrade(';")).toBe(false);
  });

  it("untagged template → FAIL", () => {
    expect(sigB("const s = `class GradeDraftRejected checkPrintableGrade(`;")).toBe(false);
  });

  it("TAGGED SQL template containing the signature words → FAIL (the N5 bypass)", () => {
    expect(sigB("const s = sql`class GradeDraftRejected checkPrintableGrade(`;")).toBe(false);
    expect(sigB("await db.execute(sql`class GradeDraftRejected checkPrintableGrade( `);")).toBe(false);
  });

  it("signature only inside an interpolation STRING → FAIL", () => {
    expect(sigB("const s = sql`${'class GradeDraftRejected'} ${\"checkPrintableGrade(\"}`;")).toBe(false);
  });

  it("real implementation inside an interpolation EXPRESSION → PASS (it is executable JavaScript)", () => {
    // Documented choice: `${…}` is evaluated JavaScript, so a genuine call there is a genuine
    // call. Treating it as prose would create a blind spot, which is the opposite of the goal.
    expect(sigB("class GradeDraftRejected extends Error {}\nconst q = sql`${checkPrintableGrade(c)}`;")).toBe(true);
  });

  it("renamed, look-alike, partial, import-only and dead prose → FAIL", () => {
    expect(sigB("class GradeDraftRefused extends Error {}\ncheckPrintableGrade(c);")).toBe(false);
    expect(sigB("class GradeDraftRejectedX {}\ncheckPrintableGradeX(c);")).toBe(false);
    expect(sigB("class GradeDraftRejected extends Error {}")).toBe(false);
    expect(sigB("const v = checkPrintableGrade(c);")).toBe(false);
    expect(sigB("import { GradeDraftRejected } from './g';\ncheckPrintableGrade(c);")).toBe(false);
  });

  it("the two modes genuinely differ: SQL is visible to identifiers, invisible to signatures", () => {
    const src = "await db.execute(sql`UPDATE certificates SET certificate_number = ${n}`);";
    expect(stripNonCode(src)).toMatch(/certificate_number/);
    expect(stripToJs(src)).not.toMatch(/certificate_number/);
  });
});

describe("scale and shape", () => {
  it("handles a large diff without throwing or timing out", () => {
    const big = Array.from({ length: 4000 }, (_, i) => `+const v${i} = f(${i}) / ${i + 1};`).join("\n");
    const out = addedCodeOf("+++ b/x.ts\n" + big);
    expect(out.length).toBeGreaterThan(1000);
    expect(FORBIDDEN.test(out)).toBe(false);
  });

  it("preserves line numbering so the per-line formula guard stays aligned", () => {
    const src = ["const a = 1; // comment", "const b = `prose`;", "const c = 3;"].join("\n");
    expect(stripNonCode(src).split("\n").length).toBeGreaterThanOrEqual(3);
    expect(stripToJs(src).split("\n")[2]).toContain("const c = 3;");
  });
});
