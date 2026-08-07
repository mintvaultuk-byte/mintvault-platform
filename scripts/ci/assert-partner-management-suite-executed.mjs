#!/usr/bin/env node
/**
 * HARD EXECUTION ASSERTION for tests/partner-management-integration.test.ts.
 *
 * The suite is intentionally skippable on a local machine without disposable PostgreSQL, but CI
 * must never report green while the transactional invitation-management evidence did not run.
 *
 * Usage: node scripts/ci/assert-partner-management-suite-executed.mjs <vitest-json-report>
 *
 * Floor re-measured 2026-08-07: 24 -> 28, the suite's true executed count. A floor is the
 * MEASURED count, never a margin below it — a margin is silent room to delete evidence.
 */
import { readFileSync } from "node:fs";

const EXPECTED_FILE = "tests/partner-management-integration.test.ts";
const MIN_EXECUTED = 28;

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: assert-partner-management-suite-executed.mjs <vitest-json-report>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`[partner-management-exec] cannot read vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(report.testResults)) {
  console.error("[partner-management-exec] vitest JSON report has no testResults array");
  process.exit(1);
}

const result = report.testResults.find((f) => {
  const rel = String(f.name)
    .replace(/\\/g, "/")
    .replace(/^.*?(tests\/)/, "$1");
  return rel === EXPECTED_FILE;
});

if (!result) {
  console.error(`[partner-management-exec] ${EXPECTED_FILE} is absent from the vitest report`);
  process.exit(1);
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
console.table([{ suite: EXPECTED_FILE, executed, passed, failed, skipped, floor: MIN_EXECUTED }]);

if (executed === 0) {
  console.error(`[partner-management-exec] ${EXPECTED_FILE} executed 0 tests; CI evidence is missing`);
  process.exit(1);
}
if (executed < MIN_EXECUTED) {
  console.error(
    `[partner-management-exec] ${EXPECTED_FILE} executed ${executed} tests, expected at least ${MIN_EXECUTED}`
  );
  process.exit(1);
}
if (skipped !== 0) {
  console.error(`[partner-management-exec] ${EXPECTED_FILE} reported ${skipped} skipped tests; expected 0`);
  process.exit(1);
}

console.log(`[partner-management-exec] OK - ${EXPECTED_FILE} executed ${executed} tests with 0 skipped.`);
