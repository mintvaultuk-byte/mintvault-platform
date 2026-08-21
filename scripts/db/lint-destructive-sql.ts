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
import { readFileSync } from "node:fs";
import { basename } from "node:path";

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
  {
    kind: "enum_value_removed",
    severity: "block",
    re: /\bALTER\s+TYPE\b[\s\S]{0,120}?\b(RENAME\s+VALUE|DROP\s+VALUE)\b/i,
  },
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
      findings.push({
        kind: rule.kind,
        severity: rule.severity,
        match: m[0].replace(/\s+/g, " ").trim().slice(0, 80),
        line,
      });
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

function normaliseMigrationFilename(filePath: string): string {
  return basename(filePath.replace(/\\/g, "/"));
}

/**
 * Narrow, owner-approved protected migration exception.
 *
 * 0094 replaces a *defence-in-depth* partial unique index so SFAP-015 can release
 * the physical scanner glass after a local TIFF has been durably bound, without
 * relaxing the single physical target invariant. The linter's DROP INDEX rule is
 * intentionally broad, so this approval is intentionally tiny:
 *
 * - exact migration filename only;
 * - exact DROP INDEX kind only;
 * - replacement unique index must be created before the drop;
 * - replacement predicate must include physical_released=false;
 * - canonical index name is restored by rename inside the same transactional file.
 */
export function isApprovedDestructiveFinding(filePath: string, sql: string, finding: DestructiveFinding): boolean {
  const filename = normaliseMigrationFilename(filePath);
  if (filename === "0096_partner_card_job_void_management_audit.sql") {
    if (finding.severity !== "block" || finding.kind !== "drop_constraint") return false;
    const cleaned = stripSqlNoise(sql);
    const drop =
      /\bALTER\s+TABLE\s+partner_management_audit\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+chk_partner_management_audit_action\s*;/i.exec(
        cleaned
      );
    const add =
      /\bALTER\s+TABLE\s+partner_management_audit\s+ADD\s+CONSTRAINT\s+chk_partner_management_audit_action\s+CHECK\s*\(\s*action_type\s+IN\s*\(/i.exec(
        cleaned
      );
    if (!drop || !add || drop.index > add.index) return false;
    const rawAdd =
      /\bALTER\s+TABLE\s+partner_management_audit\s+ADD\s+CONSTRAINT\s+chk_partner_management_audit_action\s+CHECK\s*\(\s*action_type\s+IN\s*\(/i.exec(
        sql
      );
    if (!rawAdd) return false;
    const blockEnd = sql.indexOf("));", rawAdd.index);
    if (blockEnd < 0) return false;
    const block = sql.slice(rawAdd.index, blockEnd);
    return [
      "partner_card_job_voided",
      "partner_location_created",
      "partner_wallet_backfilled",
      "partner_user_mfa_reset",
      "partner_created",
    ].every((action) => block.includes(`'${action}'`));
  }

  if (filename === "0107_partner_management_audit_idempotency_scope.sql") {
    // 0107 WIDENS the management-audit idempotency namespace from (key) to
    // (tenant_id, action_type, key). PostgreSQL cannot alter a partial unique index's key list in
    // place, so the replacement is a transactional DROP + CREATE of the SAME index name. Approve it
    // only when the file provably drops that exact index and recreates it, in that order, with all
    // three columns and the same partial predicate. Do not generalise this to other indexes.
    if (finding.severity !== "block" || finding.kind !== "drop_index") return false;
    const cleaned = stripSqlNoise(sql);
    const drop = /\bDROP\s+INDEX\s+IF\s+EXISTS\s+uq_partner_management_audit_idem\s*;/i.exec(cleaned);
    const create =
      /\bCREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_partner_management_audit_idem\s+ON\s+partner_management_audit\s*\(\s*tenant_id\s*,\s*action_type\s*,\s*idempotency_key\s*\)/i.exec(
        cleaned
      );
    if (!drop || !create || drop.index > create.index) return false;
    // stripSqlNoise() blanks string literals, so the partial predicate's 'succeeded' value has to
    // be verified against the RAW sql. Ordering is still judged on the cleaned text, where comments
    // cannot fake a statement.
    const rawCreate =
      /\bCREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_partner_management_audit_idem\s+ON\s+partner_management_audit\s*\(\s*tenant_id\s*,\s*action_type\s*,\s*idempotency_key\s*\)\s*WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL\s+AND\s+result\s*=\s*'succeeded'\s*;/i;
    return rawCreate.test(sql);
  }

  if (filename === "0105_partner_first_shop_delivery_address.sql") {
    // 0103 makes the existing management-audit vocabulary one action wider. PostgreSQL cannot
    // alter a CHECK expression in place, so this is a deliberately narrow transactional
    // DROP/ADD replacement: exact table/constraint, exact order, and the complete expected
    // vocabulary. Do not generalise this exception to other audit constraints or migrations.
    if (finding.severity !== "block" || finding.kind !== "drop_constraint") return false;
    const cleaned = stripSqlNoise(sql);
    const drop =
      /\bALTER\s+TABLE\s+partner_management_audit\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+chk_partner_management_audit_action\s*;/i.exec(
        cleaned
      );
    const add =
      /\bALTER\s+TABLE\s+partner_management_audit\s+ADD\s+CONSTRAINT\s+chk_partner_management_audit_action\s+CHECK\s*\(\s*action_type\s+IN\s*\(/i.exec(
        cleaned
      );
    if (!drop || !add || drop.index > add.index) return false;
    const rawAdd =
      /\bALTER\s+TABLE\s+partner_management_audit\s+ADD\s+CONSTRAINT\s+chk_partner_management_audit_action\s+CHECK\s*\(\s*action_type\s+IN\s*\(/i.exec(
        sql
      );
    if (!rawAdd) return false;
    const blockEnd = sql.indexOf("));", rawAdd.index);
    if (blockEnd < 0) return false;
    const actionValues = new Set([...sql.slice(rawAdd.index, blockEnd).matchAll(/'([^']+)'/g)].map((match) => match[1]));
    const expected = [
      "partner_created",
      "profile_updated",
      "status_changed",
      "contact_added",
      "contact_updated",
      "contact_deactivated",
      "branding_updated",
      "note_added",
      "partner_user_invited",
      "partner_invitation_resent",
      "partner_invitation_revoked",
      "partner_invitation_accepted",
      "partner_user_role_changed",
      "partner_user_suspended",
      "partner_user_reactivated",
      "partner_user_password_reset_initiated",
      "partner_user_sessions_revoked",
      "partner_user_membership_removed",
      "partner_user_mfa_reset",
      "partner_invitation_amended",
      "partner_legal_name_changed",
      "partner_duplicate_override",
      "partner_wallet_backfilled",
      "partner_location_created",
      "partner_location_updated",
      "partner_location_status_changed",
      "partner_user_locations_changed",
      "partner_card_job_voided",
      "partner_first_shop_onboarded",
    ];
    return actionValues.size === expected.length && expected.every((action) => actionValues.has(action));
  }

  if (filename !== "0094_scanner_capture_physical_release.sql") return false;
  if (finding.severity !== "block" || finding.kind !== "drop_index") return false;

  const cleaned = stripSqlNoise(sql);
  const addColumn =
    /\bALTER\s+TABLE\s+scanner_capture_sessions\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+physical_released\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+false\b/i.exec(
      cleaned
    );
  const createReplacement =
    /\bCREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_scanner_capture_one_active_station_physical\s+ON\s+scanner_capture_sessions\s*\(\s*station_id\s*\)/i.exec(
      cleaned
    );
  const dropCanonical = /\bDROP\s+INDEX\s+IF\s+EXISTS\s+uq_scanner_capture_one_active_station\s*;/i.exec(cleaned);
  const renameCanonical =
    /\bALTER\s+INDEX\s+IF\s+EXISTS\s+uq_scanner_capture_one_active_station_physical\s+RENAME\s+TO\s+uq_scanner_capture_one_active_station\s*;/i.exec(
      cleaned
    );

  if (!addColumn || !createReplacement || !dropCanonical || !renameCanonical) return false;
  if (!(addColumn.index < createReplacement.index && createReplacement.index < dropCanonical.index)) return false;
  if (!(dropCanonical.index < renameCanonical.index)) return false;

  const replacementStatement = cleaned.slice(createReplacement.index, dropCanonical.index);
  return (
    /\bWHERE\b/i.test(replacementStatement) &&
    /\bstation_id\s+IS\s+NOT\s+NULL\b/i.test(replacementStatement) &&
    /\bphysical_released\s*=\s*false\b/i.test(replacementStatement) &&
    /\bstate\s+IN\s*\(/i.test(replacementStatement)
  );
}

export function unapprovedBlockingFindings(
  filePath: string,
  sql: string,
  findings: DestructiveFinding[] = lintSql(sql)
): DestructiveFinding[] {
  return findings.filter(
    (finding) => finding.severity === "block" && !isApprovedDestructiveFinding(filePath, sql, finding)
  );
}

function approvedDestructiveFindingSuffix(filePath: string): string {
  const filename = normaliseMigrationFilename(filePath);
  if (filename === "0094_scanner_capture_physical_release.sql") return " (approved protected index replacement)";
  if (filename === "0096_partner_card_job_void_management_audit.sql") {
    return " (approved protected constraint replacement)";
  }
  if (filename === "0105_partner_first_shop_delivery_address.sql") {
    return " (approved protected first-shop audit constraint replacement)";
  }
  if (filename === "0107_partner_management_audit_idempotency_scope.sql") {
    return " (approved protected idempotency-namespace index widening)";
  }
  return " (approved protected migration replacement)";
}

function isMain(): boolean {
  return typeof process !== "undefined" && !!process.argv[1] && process.argv[1].endsWith("lint-destructive-sql.ts");
}

if (isMain()) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: lint-destructive-sql.ts <file.sql> [...]");
    process.exit(2);
  }
  let blocking = false;
  for (const f of files) {
    const sql = readFileSync(f, "utf8");
    const findings = lintSql(sql);
    if (findings.length === 0) {
      console.log(`✓ ${f}: no obvious destructive operations (regex heuristic — not a full parser)`);
      continue;
    }
    for (const fd of findings) {
      const approved = isApprovedDestructiveFinding(f, sql, fd);
      const icon = approved ? "✅" : fd.severity === "block" ? "🚫" : "⚠️ ";
      const suffix = approved ? approvedDestructiveFindingSuffix(f) : "";
      console.log(`${icon} ${f}:${fd.line} [${fd.kind}] ${fd.match}${suffix}`);
    }
    if (unapprovedBlockingFindings(f, sql, findings).length > 0) blocking = true;
  }
  process.exit(blocking ? 1 : 0);
}
