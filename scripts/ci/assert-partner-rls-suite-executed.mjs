#!/usr/bin/env node
/**
 * HARD EXECUTION ASSERTION for the Partner RLS tenant-isolation suite.
 *
 * WHY THIS EXISTS. tests/partner-rls-isolation.test.ts is the ONLY adversarial proof of the partner
 * tenant boundary — that one partner cannot read, update, delete, insert-as, or tenant-hop into
 * another partner's customers, submissions, cards or credit records. It gates the whole file on
 * PARTNER_RLS_DB, and that variable appeared ZERO times in .github/workflows/ci.yml, so the file
 * was `describe.skip` in CI from the day it was written: the tenant boundary reported green while
 * never executing a single assertion. That is the same failure mode that hid ~250 connector tests
 * (see assert-connector-suites-executed.mjs) and the first-owner-invitation blocker (see
 * assert-partner-rbac-suites-executed.mjs).
 *
 * The file now carries an "is not silently skipped in CI" guard, but that guard only catches a
 * MISSING ENVIRONMENT VARIABLE. It cannot catch the other way the evidence disappears: editing
 * `(isLocal ? describe : describe.skip)` to a hard `describe.skip`. With PARTNER_RLS_DB correctly
 * set and the gate hard-skipped, vitest reports the file as PASSED and the build stays green with
 * every cross-tenant proof gone.
 *
 * So CI asserts EXECUTION, not merely configuration: the file must appear in the report, must run
 * at least its floor of tests, and must report ZERO skipped.
 *
 * The floor is the MEASURED count, not a margin below it. `>= min` still lets the suite grow
 * freely; a margin only ever buys silent room to delete evidence.
 *
 * Usage: node scripts/ci/assert-partner-rls-suite-executed.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const EXPECTED = [
  // Tenant isolation attacked as the NOBYPASSRLS `partner_runtime` role across the tables the
  // pilot actually uses (0001 foundation + 0007 submissions + 0016 wallet/ledger + 0017 credit
  // reservations): cross-tenant SELECT / UPDATE / DELETE / INSERT / tenant-hop, fail-closed on
  // missing / empty / malformed context, no leak through the reporting views, no self-topup of the
  // credit ledger, and the RLS+FORCE+policy coverage sweep that catches a new tenant table added
  // without protection.
  // 68 -> 85 (2026-08-07). The comment here claimed "currently 69 executed" and the floor sat at
  // 68 — but nobody re-measured after the merge split this file into two suites on separate
  // databases. The real count is 85 (32 + 1 + 52), so the floor was stale by SEVENTEEN and any
  // seventeen of these isolation proofs could have been deleted with CI still green.
  // MEASURED: `run-partner-suite.mjs --all` reports passed=85 failed=0 skipped=0, and the full
  // vitest report agrees. The floor is now the true count: adding tests still never breaks the
  // build, deleting even one does.
  { file: "tests/partner-rls-isolation.test.ts", min: 85 },
];

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: assert-partner-rls-suite-executed.mjs <vitest-json-report>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`[partner-rls-exec] cannot read vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(report.testResults)) {
  console.error("[partner-rls-exec] vitest JSON report has no testResults array");
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

  if (executed === 0) failures.push(`${file} executed 0 tests; the partner tenant boundary is UNPROVEN`);
  else if (executed < min) failures.push(`${file} executed ${executed} tests, expected at least ${min}`);
  if (skipped !== 0) failures.push(`${file} reported ${skipped} skipped tests; expected 0`);
}

console.table(rows);

if (failures.length > 0) {
  for (const f of failures) console.error(`[partner-rls-exec] ${f}`);
  process.exit(1);
}

console.log("[partner-rls-exec] OK - the Partner RLS tenant-isolation suite executed with 0 skipped.");
