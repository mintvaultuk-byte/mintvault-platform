/**
 * Project Control — automatic evidence scanning.
 *
 * Carried forward from the superseded WIP (19aa73dd `scanners.ts`), whose
 * `scanDatabaseEvidence` / `scanDeploymentEvidence` / `scanTestEvidence` capability this build
 * originally dropped, leaving every piece of evidence to be entered by hand.
 *
 * SAFETY RULES, all inherited from that WIP and tightened:
 *  - READ ONLY. Database access is limited to catalogue introspection and COUNT(*) on `pc_*`
 *    tables. Nothing here writes, and nothing here reads a business table.
 *  - NEVER CONTACTS PRODUCTION. It inspects whatever database this process is already connected
 *    to and says which one that is; it opens no new connection and reads no other environment.
 *  - BOUNDED OUTPUT. Every string is redacted and length-capped before it leaves this module
 *    (the WIP's MAX_EVIDENCE_TEXT_LENGTH bound, restored).
 *  - FAILS SOFT. A scan that errors returns a finding describing the failure; it never throws
 *    into a request.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { boundEvidenceText, type EvidenceKind, type TestResult } from "@shared/project-control";

/** Upper bound on rows/objects any single scan will report. */
const MAX_SCAN_ITEMS = 40;

export interface ScannedEvidence {
  kind: EvidenceKind;
  supports: boolean;
  summary: string;
  sourceRef: string | null;
  /** Where this came from, for the audit trail. */
  scanner: string;
}

export interface EvidenceScanReport {
  scannedAt: string;
  findings: ScannedEvidence[];
  warnings: string[];
}

/**
 * Database evidence: does the Project Control schema actually exist in the connected database?
 *
 * This is what makes "migration 0030 has not been applied here" a fact the dashboard KNOWS rather
 * than an error the user has to interpret from a failed query.
 */
export async function scanDatabaseEvidence(): Promise<EvidenceScanReport> {
  const findings: ScannedEvidence[] = [];
  const warnings: string[] = [];

  try {
    const expected = [
      "pc_nodes",
      "pc_work_packages",
      "pc_evidence",
      "pc_blockers",
      "pc_dependencies",
      "pc_status_events",
      "pc_deployments",
      "pc_test_runs",
      "pc_prompts",
    ];

    const { rows } = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'pc\\_%'
      ORDER BY table_name
    `)) as unknown as { rows: { table_name: string }[] };

    const present = new Set(rows.map((r) => r.table_name));
    const missing = expected.filter((t) => !present.has(t));

    findings.push({
      kind: "database_check",
      supports: missing.length === 0,
      summary: boundEvidenceText(
        missing.length === 0
          ? `All ${expected.length} Project Control tables exist in the connected database.`
          : `${missing.length} Project Control table(s) missing: ${missing.slice(0, MAX_SCAN_ITEMS).join(", ")}. Migration 0030 has not been applied here.`
      ),
      sourceRef: "information_schema.tables",
      scanner: "database",
    });

    // Confirm the append-only guarantee is actually installed, not merely intended.
    const { rows: triggers } = (await db.execute(sql`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN
        ('trg_pc_status_events_append_only','trg_pc_status_events_stamp_time','trg_pc_prompts_immutable')
    `)) as unknown as { rows: { tgname: string }[] };

    const installed = new Set(triggers.map((t) => t.tgname));
    const guardsMissing = [
      "trg_pc_status_events_append_only",
      "trg_pc_status_events_stamp_time",
      "trg_pc_prompts_immutable",
    ].filter((t) => !installed.has(t));

    findings.push({
      kind: "database_check",
      supports: guardsMissing.length === 0,
      summary: boundEvidenceText(
        guardsMissing.length === 0
          ? "Append-only and immutability triggers are installed and enforcing."
          : `Integrity trigger(s) missing: ${guardsMissing.join(", ")}. The audit ledger is NOT enforced by the database here.`
      ),
      sourceRef: "pg_trigger",
      scanner: "database",
    });

    // Confirm the foreign keys exist — an ALTER that silently failed would show up here.
    const { rows: fks } = (await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND conname LIKE 'fk\\_pc\\_%'
    `)) as unknown as { rows: { conname: string }[] };

    findings.push({
      kind: "database_check",
      supports: fks.length >= 7,
      summary: boundEvidenceText(`${fks.length} Project Control foreign key constraint(s) present (7 expected).`),
      sourceRef: "pg_constraint",
      scanner: "database",
    });
  } catch (error) {
    warnings.push(
      boundEvidenceText(`Database evidence scan failed: ${error instanceof Error ? error.message : "unknown error"}`)
    );
  }

  return { scannedAt: new Date().toISOString(), findings, warnings };
}

/**
 * Deployment evidence derived from the recorded release history in this database.
 *
 * It does NOT call Fly, does not call /api/version, and does not open a network connection —
 * contacting production is explicitly out of bounds. It reasons over what has been recorded.
 */
export async function scanDeploymentEvidence(): Promise<EvidenceScanReport> {
  const findings: ScannedEvidence[] = [];
  const warnings: string[] = [];

  try {
    const { rows } = (await db.execute(sql`
      SELECT environment, result, COUNT(*)::int AS count, MAX(deployed_at) AS latest
      FROM pc_deployments
      GROUP BY environment, result
      ORDER BY environment, result
      LIMIT ${MAX_SCAN_ITEMS}
    `)) as unknown as { rows: { environment: string; result: string; count: number; latest: string }[] };

    if (rows.length === 0) {
      findings.push({
        kind: "deployment",
        supports: false,
        summary: "No deployment has ever been recorded, so no release can be evidenced.",
        sourceRef: null,
        scanner: "deployment",
      });
    }

    for (const r of rows) {
      findings.push({
        kind: "deployment",
        supports: r.result === "succeeded",
        summary: boundEvidenceText(
          `${r.count} ${r.result} release(s) recorded for ${r.environment}; latest ${r.latest}.`
        ),
        sourceRef: `${r.environment}:${r.result}`,
        scanner: "deployment",
      });
    }
  } catch (error) {
    warnings.push(
      boundEvidenceText(`Deployment evidence scan failed: ${error instanceof Error ? error.message : "unknown error"}`)
    );
  }

  return { scannedAt: new Date().toISOString(), findings, warnings };
}

/** Test evidence derived from the recorded gate history. */
export async function scanTestEvidence(): Promise<EvidenceScanReport> {
  const findings: ScannedEvidence[] = [];
  const warnings: string[] = [];

  try {
    const { rows } = (await db.execute(sql`
      SELECT kind, result, COUNT(*)::int AS count, MAX(ran_at) AS latest
      FROM pc_test_runs
      GROUP BY kind, result
      ORDER BY kind, result
      LIMIT ${MAX_SCAN_ITEMS}
    `)) as unknown as { rows: { kind: string; result: TestResult; count: number; latest: string }[] };

    if (rows.length === 0) {
      findings.push({
        kind: "vitest",
        supports: false,
        summary: "No test run has ever been recorded, so no gate can be evidenced.",
        sourceRef: null,
        scanner: "tests",
      });
    }

    for (const r of rows) {
      if (r.result === "not_run" || r.result === "skipped") continue;
      findings.push({
        kind: r.kind as EvidenceKind,
        supports: r.result === "passed",
        summary: boundEvidenceText(`${r.count} ${r.kind} run(s) ${r.result}; latest ${r.latest}.`),
        sourceRef: `${r.kind}:${r.result}`,
        scanner: "tests",
      });
    }
  } catch (error) {
    warnings.push(
      boundEvidenceText(`Test evidence scan failed: ${error instanceof Error ? error.message : "unknown error"}`)
    );
  }

  return { scannedAt: new Date().toISOString(), findings, warnings };
}

/** Run every safe scanner and merge the results. */
export async function scanAllEvidence(): Promise<EvidenceScanReport> {
  const reports = await Promise.all([scanDatabaseEvidence(), scanDeploymentEvidence(), scanTestEvidence()]);
  return {
    scannedAt: new Date().toISOString(),
    findings: reports.flatMap((r) => r.findings),
    warnings: reports.flatMap((r) => r.warnings),
  };
}
