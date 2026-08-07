/**
 * Execution floors for the Partner pilot suites that had NONE.
 *
 * A hostile vacuity review of the partner suites found that three of the four suites carrying the
 * pilot's end-to-end evidence were absent from every manifest in scripts/ci/ and from
 * partner-suite-env-matrix.mjs. Their only protection was an in-file `describe.skipIf(!isLocal)`
 * gate, and two of them had no CI guard at all. Editing the gate to a hard `describe.skip` — or
 * simply failing to set one env var — reported the FILE as passed with zero tests executed and
 * nothing anywhere noticed.
 *
 * That is the exact failure mode that let ~250 connector tests report green for months without
 * running. The connector suites got floors afterwards; these never did.
 *
 * This asserts EXECUTION, not configuration. An env-var check cannot catch a skipped describe; a
 * floor can. Each floor is set to the suite's real current test count, so DELETING a test is a
 * build failure and must be a deliberate act that also edits this file.
 *
 * skipped !== 0 is a failure too. assert-connector-suites-executed.mjs omits that check, which
 * means a suite there can add two tests, skip three, stay above its floor and stay green. Every
 * floor in this file checks it.
 */
import { readFileSync } from "node:fs";

const reportPath = process.argv[2] ?? "vitest-report.json";

/**
 * floor = the suite's actual test count at the time it was pinned. Not a round number, not 1, and
 * never 0 — a floor of 0 or 1 is indistinguishable from no floor at all.
 */
const SUITES = [
  { file: "tests/partner-submission-workflow.test.ts", min: 46 },
  { file: "tests/partner-portal-mount-integration.test.ts", min: 28 },
  { file: "tests/partner-connector-runtime.test.ts", min: 15 },
  { file: "tests/partner-real-r2-storage.test.ts", min: 2 },
  { file: "tests/partner-grading-bridge-migration.test.ts", min: 12 },
  /**
   * The ONLY suite that executes the partner completion cascade. Everything else stops at the
   * `to_regclass('public.partner_grading_work_items')` guard, because no other DB-backed test
   * creates that table — which is exactly how a cascade that wrote a non-existent column
   * (partner_submissions.completed_at, SQLSTATE 42703) reached a PR with every suite green.
   * If this floor is ever missing, that entire code path is unproven again.
   */
  { file: "tests/partner-completion-cascade.test.ts", min: 9 },
  /**
   * FULL-PILOT-LOCAL-01. Pins the corrected approval/settlement lifecycle: approving card ONE of
   * two must NOT settle. The earlier acceptance wording asserted 8/2/0 after BOTH approvals, which
   * production does not do — mirrorPartnerApproval fires on the COMPLETE approved set.
   */
  { file: "tests/partner-full-pilot-workflow.test.ts", min: 14 },
  /**
   * The ONLY behavioural coverage of /api/partner/grading/*. Every other assertion about the
   * partner grading adapter in this repository is a source-string pin, and the PR #288 mutation
   * matrix proved those are evadable: GRADE1 deleted the private_notes strip at one call site and
   * survived the entire suite. Without this floor, one env-var slip or one edited gate silently
   * removes the only test that would notice.
   *
   * Raised 8 -> 9 with the D-1 repair (2026-08-07). G1b was inverted from a characterisation of
   * the data-destroying defect into a preservation assertion, and G1c was added for the other two
   * undeclared columns. A floor sitting BELOW the real count permits silent test deletion
   * (finding A10-F5), which is exactly what must not happen to the only end-to-end evidence that
   * a partner save no longer destroys admin-internal data.
   */
  { file: "tests/partner-grading-http-routes.test.ts", min: 9 },
  /**
   * The Super Admin control shell: requireAdmin rejection, partner/location/user suspend, session
   * revoke, feature-flag writes, emergency stop, MFA reset, read-endpoint authorisation and the
   * suspend concurrency proof. Its two environment variables were absent from ci.yml since the file
   * was written, so all 11 tests reported as a passing FILE while executing nothing. Wiring the
   * variables fixes today; this floor is what stops it recurring.
   *
   * 12 = 11 real tests + the CI-wiring guard that now sits outside the gate.
   */
  { file: "tests/partner-admin-control-shell-integration.test.ts", min: 12 },
];

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  // A missing report is a FAILURE, never a pass. run-partner-suite.mjs historically fell back to
  // exit-code-only when the report was absent, which reported passed=0 as green.
  console.error(`[partner-pilot-exec] cannot read vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

const problems = [];
const rows = [];

for (const { file, min } of SUITES) {
  const result = (report.testResults ?? []).find((r) => (r.name ?? "").replace(/\\/g, "/").endsWith(file));
  if (!result) {
    problems.push(`${file}: absent from the vitest report — the suite did not run at all`);
    rows.push({ suite: file, executed: "ABSENT", passed: 0, failed: 0, skipped: 0, floor: min });
    continue;
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const a of result.assertionResults ?? []) {
    if (a.status === "passed") passed++;
    else if (a.status === "failed") failed++;
    else skipped++;
  }
  const executed = passed + failed;
  rows.push({ suite: file, executed, passed, failed, skipped, floor: min });

  if (executed === 0) problems.push(`${file}: executed 0 tests; the suite is gated off or skipped`);
  else if (executed < min) problems.push(`${file}: executed ${executed} tests, expected at least ${min}`);
  if (skipped !== 0) problems.push(`${file}: reported ${skipped} skipped test(s); expected 0`);
}

console.table(rows);

if (problems.length > 0) {
  for (const p of problems) console.error(`[partner-pilot-exec] ${p}`);
  console.error(
    "[partner-pilot-exec] These suites carry the pilot's end-to-end evidence. " +
      "A skipped suite and a passing suite look identical in an exit code — do not lower a floor to go green."
  );
  process.exit(1);
}

console.log(`[partner-pilot-exec] OK — ${SUITES.length} pilot suites executed above their floors with 0 skipped.`);
