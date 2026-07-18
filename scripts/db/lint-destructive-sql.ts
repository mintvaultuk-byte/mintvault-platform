/**
 * Phase 0.5 — Destructive-SQL linter.
 *
 * Scans SQL text (a migration file or a generated statement set) for destructive
 * operations that must never run unreviewed against a real database. Pure string
 * analysis — connects to nothing, changes nothing.
 *
 * LIMITATIONS (honest): this is a REGEX-BASED heuristic linter, NOT a full PostgreSQL
 * parser. It strips line comments, block comments, single-quoted string literals, and
 * dollar-quoted bodies ($$...$$ / $tag$...$tag$) before matching, so destructive keywords
 * hidden in those are ignored. It can still be defeated by exotic constructs (deeply nested
 * dollar quotes, dynamically-built SQL executed via EXECUTE, obscure whitespace). It is a
 * safety net that catches the common destructive statements, not a proof of safety. Treat a
 * clean result as "no obvious destructive statement", not "provably non-destructive".
 */

export type DestructiveKind =
  | "drop_database"
  | "drop_schema"
  | "drop_table"
  | "drop_view"
  | "drop_materialized_view"
  | "drop_type"
  | "drop_sequence"
  | "drop_extension"
  | "drop_index"
  | "drop_column"
  | "drop_constraint"
  | "drop_primary_key"
  | "drop_not_null" // usually safe (widening) — flagged for awareness
  | "add_not_null" // can fail / lock on existing data — flagged
  | "truncate"
  | "delete_without_where"
  | "update_without_where"
  | "cascade"
  | "rename_table"
  | "rename_column"
  | "column_type_change"
  | "enum_value_removed";

export interface DestructiveFinding {
  kind: DestructiveKind;
  severity: "block" | "flag";
  match: string;
  line: number;
}

/** Strip line comments, block comments, dollar-quoted bodies, and single-quoted literals. */
export function stripSqlNoise(sql: string): string {
  let s = sql;
  // Dollar-quoted strings/function bodies: $$...$$ or $tag$...$tag$ (tag: letters/digits/_).
  s = s.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " $body$ ");
  s = s.replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
  s = s.replace(/--[^\n]*/g, " "); // line comments
  s = s.replace(/'(?:''|[^'])*'/g, "''"); // single-quoted literals
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
  { kind: "drop_materialized_view", severity: "block", re: /\bDROP\s+MATERIALIZED\s+VIEW\b/i },
  { kind: "drop_table", severity: "block", re: /\bDROP\s+TABLE\b/i },
  { kind: "drop_view", severity: "block", re: /\bDROP\s+VIEW\b/i },
  { kind: "drop_type", severity: "block", re: /\bDROP\s+TYPE\b/i },
  { kind: "drop_sequence", severity: "block", re: /\bDROP\s+SEQUENCE\b/i },
  { kind: "drop_extension", severity: "block", re: /\bDROP\s+EXTENSION\b/i },
  { kind: "drop_index", severity: "block", re: /\bDROP\s+INDEX\b/i },
  { kind: "truncate", severity: "block", re: /\bTRUNCATE\b/i },
  { kind: "drop_column", severity: "block", re: /\bALTER\s+TABLE\b[\s\S]{0,200}?\bDROP\s+COLUMN\b/i },
  { kind: "drop_primary_key", severity: "block", re: /\bDROP\s+CONSTRAINT\b[\s\S]{0,80}?(pkey|primary)/i },
  { kind: "drop_constraint", severity: "block", re: /\bALTER\s+TABLE\b[\s\S]{0,200}?\bDROP\s+CONSTRAINT\b/i },
  { kind: "rename_table", severity: "block", re: /\bALTER\s+TABLE\b[\s\S]{0,120}?\bRENAME\s+TO\b/i },
  { kind: "rename_column", severity: "block", re: /\bALTER\s+TABLE\b[\s\S]{0,200}?\bRENAME\s+COLUMN\b/i },
  // Only DESTRUCTIVE cascades (DROP/TRUNCATE ... CASCADE). Referential actions like
  // "ON DELETE CASCADE" / "ON UPDATE CASCADE" in a FK definition are safe and NOT flagged.
  { kind: "cascade", severity: "block", re: /\b(DROP|TRUNCATE)\b[\s\S]{0,200}?\bCASCADE\b/i },
  { kind: "enum_value_removed", severity: "block", re: /\bALTER\s+TYPE\b[\s\S]{0,120}?\b(RENAME\s+VALUE|DROP\s+VALUE)\b/i },
  // Flags (review, not automatic block):
  { kind: "column_type_change", severity: "flag", re: /\bALTER\s+(?:COLUMN\s+)?[^\s;]+\s+(?:SET\s+DATA\s+)?TYPE\b/i },
  { kind: "add_not_null", severity: "flag", re: /\bALTER\s+COLUMN\b[\s\S]{0,60}?\bSET\s+NOT\s+NULL\b/i },
  { kind: "drop_not_null", severity: "flag", re: /\bALTER\s+COLUMN\b[\s\S]{0,60}?\bDROP\s+NOT\s+NULL\b/i },
];

/** Split into statements on ';' at top level (post-noise-strip). */
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

  return findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

export function hasBlocking(findings: DestructiveFinding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

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
      console.log(`✓ ${f}: no obvious destructive operations (regex heuristic — not a full parser)`);
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
