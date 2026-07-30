#!/usr/bin/env node
/**
 * HARD EXECUTION ASSERTION for the Trusted Intake Connector PostgreSQL suites.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every connector suite is `describe.skip` unless its own env-var pair is set. Before this
 * script, CI set exactly ONE such pair (PARTNER_CONNECTOR_RUNTIME_*), so ~250 tests — every
 * exactly-once, fault-injection, concurrency and tenant-isolation proof — reported GREEN while
 * never executing a single assertion. A skipped suite and a passing suite are indistinguishable
 * in an exit code.
 *
 * WHAT IT ASSERTS
 * ---------------
 * For each file in EXPECTED below, the vitest JSON report must contain that file AND it must
 * have executed at least MIN tests (passed + failed, i.e. NOT skipped/todo). Any of:
 *   - file absent from the report (renamed, moved, deleted, or excluded by the glob)
 *   - file present but 0 tests executed (its env gate was not set -> describe.skip)
 *   - file present but fewer tests executed than its recorded floor
 * fails the build.
 *
 * ROBUST TO RENAMES: the manifest is by path. Renaming a suite without updating this file makes
 * the build RED, which is the intended failure mode — the alternative (a glob) silently loses
 * coverage exactly the way this script exists to prevent.
 *
 * The floors are the counts observed on a full-fidelity local run replicating the CI env shape
 * (PostgreSQL 17, LC_ALL=C, the same env vars ci.yml sets). They are FLOORS, not equalities:
 * adding tests to a suite is fine, silently losing them is not.
 *
 * Usage: node scripts/ci/assert-connector-suites-executed.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

/** @type {Array<{file: string, min: number}>} */
const EXPECTED = [
  // Pure (no database gate) — included so an accidental exclusion is still caught.
  { file: "tests/partner-connector-fingerprint.test.ts", min: 14 },
  // Gated on PARTNER_CONNECTOR_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-service.test.ts", min: 49 },
  // PARTNER_CONNECTOR_VALIDATION_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-validation-service.test.ts", min: 32 },
  // PARTNER_CONNECTOR_IMPORT_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-import-service.test.ts", min: 17 },
  // PARTNER_CONNECTOR_RECON_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-reconciliation-service.test.ts", min: 23 },
  // PARTNER_CONNECTOR_RECON_LOAD_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-reconciliation-concurrency.test.ts", min: 3 },
  // PARTNER_CONNECTOR_FAULT_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-fault-injection.test.ts", min: 21 },
  // PARTNER_CONNECTOR_BLOCKER_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-g3f-blockers.test.ts", min: 17 },
  // PARTNER_CONNECTOR_SCALE_RT_ADMIN / _RT_URL
  { file: "tests/partner-connector-scale.test.ts", min: 18 },
  // PARTNER_CONNECTOR_ADMIN_TEST / _ADMIN_TEST_RUNTIME
  { file: "tests/partner-connector-admin-integration.test.ts", min: 7 },
  // PARTNER_CONNECTOR_PLAN_ADMIN
  { file: "tests/partner-connector-query-plan.test.ts", min: 7 },
  // PARTNER_CONNECTOR_RUNTIME_ADMIN / _RUNTIME_URL (wired before this change; kept asserted)
  { file: "tests/partner-connector-runtime.test.ts", min: 15 },
  // PARTNER_CONNECTOR_MIGRATION_ADMIN
  { file: "tests/partner-connector-migration.test.ts", min: 14 },
  // PARTNER_CONNECTOR_ADMIN_MIGRATION_ADMIN
  { file: "tests/partner-connector-admin-migration.test.ts", min: 8 },
  // PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN
  { file: "tests/partner-connector-import-migration.test.ts", min: 10 },
  // PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN
  { file: "tests/partner-connector-validation-migration.test.ts", min: 13 },
];

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: assert-connector-suites-executed.mjs <vitest-json-report>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`[connector-exec] cannot read vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(report.testResults)) {
  console.error("[connector-exec] vitest JSON report has no testResults array");
  process.exit(1);
}

/** file path (repo-relative, posix) -> {executed, passed, failed, skipped} */
const seen = new Map();
for (const f of report.testResults) {
  const rel = String(f.name).replace(/\\/g, "/").replace(/^.*?(tests\/)/, "$1");
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const a of f.assertionResults ?? []) {
    if (a.status === "passed") passed++;
    else if (a.status === "failed") failed++;
    else skipped++;
  }
  seen.set(rel, { executed: passed + failed, passed, failed, skipped });
}

const problems = [];
const rows = [];
for (const { file, min } of EXPECTED) {
  const r = seen.get(file);
  if (!r) {
    problems.push(`${file}: ABSENT from the vitest report (renamed, moved, deleted or not collected)`);
    rows.push({ suite: file, executed: "-", passed: "-", failed: "-", skipped: "-", floor: min });
    continue;
  }
  rows.push({ suite: file, ...r, floor: min });
  if (r.executed === 0) {
    problems.push(
      `${file}: 0 tests EXECUTED (${r.skipped} not run) — either its env-var gate was unset (describe.skip) ` +
        `or its beforeAll threw; check the suite's output above for which`
    );
  } else if (r.executed < min) {
    problems.push(`${file}: only ${r.executed} tests executed, expected at least ${min} — coverage was lost`);
  }
}

console.log("[connector-exec] Trusted Intake Connector suite execution:");
console.table(rows);

if (problems.length > 0) {
  console.error(`\n[connector-exec] FAILED — ${problems.length} connector suite(s) did not actually run:`);
  for (const p of problems) console.error(`   - ${p}`);
  console.error(
    "\nA connector suite that does not execute is NOT evidence. Restore its env-var pair and its\n" +
      "database in .github/workflows/ci.yml, or update this manifest deliberately."
  );
  process.exit(1);
}

const total = rows.reduce((s, r) => s + (typeof r.executed === "number" ? r.executed : 0), 0);
console.log(`[connector-exec] OK — ${rows.length} connector suites executed ${total} tests.`);
