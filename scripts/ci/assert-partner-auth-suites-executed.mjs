#!/usr/bin/env node
/**
 * HARD EXECUTION ASSERTION for the DB-gated Partner auth P0 suites.
 *
 * WHY THIS EXISTS. These two files are the ONLY proof for two P0 repairs shipped for the first
 * external Partner pilot:
 *   • P0-E — a newly-accepted Partner OWNER must complete MFA enrolment before any normal partner
 *     API answers. Before the fix, `acceptPartnerInvitation` never set `mfa_required`, which
 *     DEFAULTs to false, so the first owner of every shop got a fully-authorised password-only
 *     session while the portal told them two-step was mandatory.
 *   • P0-F — a successful password reset must actually clear `failed_login_count`/`locked_until`.
 *     Before the fix the locked branch itself re-armed the lock on every attempt, so any user who
 *     kept retrying extended their own lockout and the documented recovery path did not clear it.
 *
 * Each file carries an in-file "is not silently skipped in CI" guard, but that guard only asserts
 * the ADMIN URL is a loopback URL — it catches a MISSING ENVIRONMENT VARIABLE and nothing else. It
 * cannot catch the other way the evidence disappears: editing the `(isLocal ? describe :
 * describe.skip)` gate to a hard `describe.skip`. With the variables correctly set and the gate
 * hard-skipped, vitest reports the file as PASSED and the build stays green while every real proof
 * is gone.
 *
 * That is exactly how ~250 connector tests reported green for months (see
 * assert-connector-suites-executed.mjs) and how the DB-gated RBAC suites did the same (see
 * assert-partner-rbac-suites-executed.mjs). Both of those guards exist for this reason; this is the
 * third, covering the auth surface.
 *
 * So CI asserts EXECUTION, not merely configuration: each file must appear in the report, must run
 * at least its floor of tests, and must report ZERO skipped.
 *
 * Floors are set just below the current counts so adding tests never breaks the build, while
 * deleting or gating-out a block does.
 *
 * Usage: node scripts/ci/assert-partner-auth-suites-executed.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const EXPECTED = [
  // P0-E: mandatory first-owner MFA. Covers the enforcement point (a pre-MFA session is refused by
  // requirePartnerAuth/requirePartnerCapability), the bootstrap path staying reachable so a user who
  // MUST enrol still CAN (the lockout-trap case), and that /mfa/disable no longer clears the
  // requirement (F2) and authenticator replacement demands a current factor (F3).
  { file: "tests/partner-mfa-enrolment-mandatory.test.ts", min: 12 },
  // P0-F: lockout recovery. Covers reset clearing failed_login_count/locked_until, the reset token
  // remaining single-use, and the suspended branch no longer arming the lock.
  { file: "tests/partner-lockout-recovery.test.ts", min: 13 },
];

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: assert-partner-auth-suites-executed.mjs <vitest-json-report>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`[partner-auth-exec] cannot read vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(report.testResults)) {
  console.error("[partner-auth-exec] vitest JSON report has no testResults array");
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
  for (const f of failures) console.error(`[partner-auth-exec] ${f}`);
  process.exit(1);
}

console.log(`[partner-auth-exec] OK - all ${EXPECTED.length} Partner auth P0 suites executed with 0 skipped.`);
