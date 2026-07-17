/**
 * Phase 0.5 — Destructive-SQL linter.
 *
 * Scans SQL text (a migration file, or a generated statement set) for destructive
 * operations that must never run unreviewed against a real database. Pure string
 * analysis — connects to nothing, changes nothing.
 *
 * Returns findings; the CLI exits non-zero if any are found. Comments and string
 * literals are stripped first to avoid matching inside them.
 */

export type DestructiveKind =
  | "drop_table"
  | "drop_column"
  | "truncate"
  | "delete_without_where"
  | "update_without_where"
  | "drop_constraint"
  | "drop_not_null_is_fine_but_type_change_flagged"
  | "column_type_change"
  | "drop_schema"
  | "drop_database";

export interface DestructiveFinding {
  kind: DestructiveKind;
  severity: "block" | "flag";
  match: string;
  line: number;
}

/** Remove line comments, block comments, and single-quoted string literals before matching. */
export function stripSqlNoise(sql: string): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
  s = s.replace(/--[^\n]*/g, " "); // line comments
  s = s.replace(/'(?:''|[^'])*'/g, "''"); // string literals -> empty marker
  return s;
}

interface Rule {
  kind: DestructiveKind;
  severity: "block" | "flag";
  re: RegExp;
}

const RULES: Rule[] = [
  { kind: "drop_database", severity: "block", re: /\bDROP\s+DATABASE\b/i },
  { kind: "drop_schema", severity: "block", re: /\bDROP\s+SCHEMA\b/i },
  { kind: "drop_table", severity: "block", re: /\bDROP\s+TABLE\b/i },
  { kind: "truncate", severity: "block", re: /\bTRUNCATE\b/i },
  { kind: "drop_column", severity: "block", re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i },
  { kind: "drop_constraint", severity: "block", re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+CONSTRAINT\b/i },
  // Type change / narrowing — flag for human review (not always destructive, often is).
  { kind: "column_type_change", severity: "flag", re: /\bALTER\s+(?:COLUMN\s+)?[^\s;]+\s+(?:SET\s+DATA\s+)?TYPE\b/i },
];

/** Split into statements on ';' at top level (good enough for migration linting). */
function statements(sql: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buf = "";
  let line = 1;
  let startLine = 1;
  for (const ch of sql) {
    if (buf.trim() === "") startLine = line;
    if (ch === "\n") line++;
    if (ch === ";") {
      out.push({ text: buf, line: startLine });
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== "") out.push({ text: buf, line: startLine });
  return out;
}

export function lintSql(sql: string): DestructiveFinding[] {
  const cleaned = stripSqlNoise(sql);
  const findings: DestructiveFinding[] = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const line = cleaned.slice(0, m.index).split("\n").length;
      findings.push({ kind: rule.kind, severity: rule.severity, match: m[0].replace(/\s+/g, " ").trim().slice(0, 80), line });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // DELETE / UPDATE without WHERE — per-statement so a WHERE elsewhere doesn't mask it.
  for (const st of statements(cleaned)) {
    const t = st.text;
    if (/\bDELETE\s+FROM\b/i.test(t) && !/\bWHERE\b/i.test(t)) {
      findings.push({ kind: "delete_without_where", severity: "block", match: "DELETE without WHERE", line: st.line });
    }
    if (/\bUPDATE\b/i.test(t) && /\bSET\b/i.test(t) && !/\bWHERE\b/i.test(t)) {
      findings.push({ kind: "update_without_where", severity: "flag", match: "UPDATE without WHERE", line: st.line });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

export function hasBlocking(findings: DestructiveFinding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

// CLI entry: tsx scripts/db/lint-destructive-sql.ts <file.sql> [...more]
function isMain(): boolean {
  return typeof process !== "undefined" && !!process.argv[1] && process.argv[1].endsWith("lint-destructive-sql.ts");
}

if (isMain()) {
  const fs = await import("node:fs");
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: lint-destructive-sql.ts <file.sql> [...]");
    process.exit(2);
  }
  let blocking = false;
  for (const f of files) {
    const sql = fs.readFileSync(f, "utf8");
    const findings = lintSql(sql);
    if (findings.length === 0) {
      console.log(`✓ ${f}: no destructive operations`);
      continue;
    }
    for (const fd of findings) {
      const icon = fd.severity === "block" ? "🚫" : "⚠️ ";
      console.log(`${icon} ${f}:${fd.line} [${fd.kind}] ${fd.match}`);
    }
    if (hasBlocking(findings)) blocking = true;
  }
  process.exit(blocking ? 1 : 0);
}
