#!/usr/bin/env node
/**
 * HARD EXECUTION ASSERTION for the DB-gated Partner RBAC suites.
 *
 * WHY THIS EXISTS. Each of these files carries an "is not silently skipped in CI" guard, but that
 * guard only asserts the ADMIN URL is a loopback PostgreSQL 17 URL — i.e. it catches a MISSING
 * ENVIRONMENT VARIABLE and nothing else. It cannot catch the other way the evidence disappears:
 * editing `describe.skipIf(!isLocal)` to `describe.skip`. With the variables correctly set and the
 * gate hard-skipped, vitest reports the file as PASSED and the build stays green while every real
 * proof is gone — verified: the migration suite then reports "6 passed | 15 skipped" and exit 0.
 *
 * That is exactly how ~250 connector tests reported green for months (see
 * assert-connector-suites-executed.mjs, which exists for the same reason), and exactly how the
 * first-owner-invitation blocker survived: thirteen suites hand-seeded RBAC and no test ever built
 * the environment the way a deployment does.
 *
 * So CI asserts EXECUTION, not merely configuration: each file must appear in the report, must run
 * at least its floor of tests, and must report ZERO skipped.
 *
 * Floors are set just below the current counts so adding tests never breaks the build, while
 * deleting or gating-out a block does.
 *
 * Usage: node scripts/ci/assert-partner-rbac-suites-executed.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const EXPECTED = [
  // Migration 0034 driven through the REAL runner: catalogue counts, idempotency, journal +
  // checksum pin, runner transaction wrapping, planMigrations pending->applied, and the read-only
  // validator reporting incomplete BEFORE / ready AFTER under a SELECT-only role.
  { file: "tests/partner-rbac-migration.test.ts", min: 20 },
  // First-owner-invitation blocker runtime regression proofs + migration 0033 audit-action
  // precision. The ONLY coverage that reproduces the unseeded estate instead of hand-seeding.
  { file: "tests/partner-rbac-bootstrap.test.ts", min: 26 },
  // Partner Admin BYPASSRLS capability gate, which fails every Super Admin route closed. Its
  // PostgreSQL-17 half is gated on PARTNER_CAPABILITY_RT_ADMIN and can vanish the same way.
  { file: "tests/partner-admin-capability.test.ts", min: 5 },
  // Wired into CI on 2026-08-03. All three shipped with a self-gate that CI never satisfied, so
  // they reported `describe.skip` and 37 tests never ran while the build stayed green. Floors are
  // set at the counts observed once their databases existed, minus nothing — these suites are
  // stable, and a floor below the real count is how coverage silently drains away.
  { file: "tests/partner-definer-ownership.test.ts", min: 15 },
  { file: "tests/partner-management-migration.test.ts", min: 10 },
  { file: "tests/super-admin-correction-mode-behaviour.test.ts", min: 12 },
];

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: assert-partner-rbac-suites-executed.mjs <vitest-json-report>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`[partner-rbac-exec] cannot read vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(report.testResults)) {
  console.error("[partner-rbac-exec] vitest JSON report has no testResults array");
  process.exit(1);
}

const rows = [];
const failures = [];

for (const { file, min } of EXPECTED) {
  const result = report.testResults.find((f) => {
    const rel = String(f.name)
      .replace(/\\/g, "/")
      .replace(/^.*?(tests\/)/, "$1");
    return rel === file;
  });

  if (!result) {
    rows.push({ suite: file, executed: "-", passed: "-", failed: "-", skipped: "-", floor: min });
    failures.push(`${file} is absent from the vitest report`);
    continue;
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const assertion of result.assertionResults ?? []) {
    if (assertion.status === "passed") passed++;
    else if (assertion.status === "failed") failed++;
    else skipped++;
  }

  const executed = passed + failed;
  rows.push({ suite: file, executed, passed, failed, skipped, floor: min });

  if (executed === 0) failures.push(`${file} executed 0 tests; CI evidence is missing`);
  else if (executed < min) failures.push(`${file} executed ${executed} tests, expected at least ${min}`);
  if (skipped !== 0) failures.push(`${file} reported ${skipped} skipped tests; expected 0`);
}

console.table(rows);

if (failures.length > 0) {
  for (const f of failures) console.error(`[partner-rbac-exec] ${f}`);
  process.exit(1);
}

console.log(`[partner-rbac-exec] OK - all ${EXPECTED.length} Partner RBAC suites executed with 0 skipped.`);
