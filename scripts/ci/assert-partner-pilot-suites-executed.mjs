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
   * The ONLY proof of the two hostile-review security repairs (A8-F1 RLS, A8-F2 search_path). It
   * needs a floor more than most files here: 11 of its 16 tests are pre-fix controls and mutations
   * whose whole job is to fail if the repair regresses. A silent skip would remove the only thing
   * standing between a rolled-back 0047 and a live cross-tenant enumeration hole.
   */
  { file: "tests/partner-security-repairs-0047-0048.test.ts", min: 16 },
  /**
   * The ONLY suite that executes the partner completion cascade. Everything else stops at the
   * `to_regclass('public.partner_grading_work_items')` guard, because no other DB-backed test
   * creates that table — which is exactly how a cascade that wrote a non-existent column
   * (partner_submissions.completed_at, SQLSTATE 42703) reached a PR with every suite green.
   * If this floor is ever missing, that entire code path is unproven again.
   */
  { file: "tests/partner-completion-cascade.test.ts", min: 18 }, // RE-MEASURED 2026-08-09 (was 15)
  /**
   * FULL-PILOT-LOCAL-01. Pins the corrected approval/settlement lifecycle: approving card ONE of
   * two must NOT settle. The earlier acceptance wording asserted 8/2/0 after BOTH approvals, which
   * production does not do — mirrorPartnerApproval fires on the COMPLETE approved set.
   */
  { file: "tests/partner-full-pilot-workflow.test.ts", min: 21 }, // RE-MEASURED 2026-08-09 (was 17)
  /**
   * The ONLY behavioural coverage of /api/partner/grading/*. Every other assertion about the
   * partner grading adapter in this repository is a source-string pin, and the PR #288 mutation
   * matrix proved those are evadable: GRADE1 deleted the private_notes strip at one call site and
   * survived the entire suite. Without this floor, one env-var slip or one edited gate silently
   * removes the only test that would notice.
   *
   * 9 -> 16 (2026-08-07), MEASURED: `run-partner-suite.mjs tests/partner-grading-http-routes.test.ts`
   * reports passed=16 failed=0 skipped=0. It was raised 8 -> 9 for the D-1 repair and NOT raised
   * again when this PR's headline feature added seven more tests, so the floor carried SEVEN of
   * slack — and those seven were precisely the server-authority proofs A1, A2, B, D, E, F and W.
   * All seven could have been deleted with the floor still green. The block's own warning already
   * said a floor below the real count "permits silent test deletion ... which is exactly what must
   * not happen to the only end-to-end evidence"; it was true of the floor itself.
   */
  // RE-MEASURED 2026-08-09: 27. Pinned at 16, i.e. 11 of slack — the SECOND time this exact suite
  // has drifted (see the note above about the seven server-authority proofs).
  { file: "tests/partner-grading-http-routes.test.ts", min: 27 },
  /**
   * H2-GET-READONLY — the sole behavioural evidence that a GET on the partner grading adapter does
   * not strand a `pending_review` work item. It appeared in NONE of the six manifests.
   *
   * Its own in-file guard only asserts `storageReady`, so it catches a missing MinIO variable and
   * nothing else: changing `(storageReady ? describe : describe.skip)` to a hard `describe.skip`
   * would leave the file reporting as PASSED with the evidence gone. There is no redundancy to fall
   * back on — the stranding defect is proved here and nowhere else, and the failure it guards has
   * no in-app recovery (the work item freezes at `assigned`, settlement never runs and the reserved
   * credits are held for 365 days).
   *
   * MEASURED 2 = 1 real end-to-end test + the CI-wiring guard outside the gate. A floor of 2 is
   * low, but it is the true count, and 0/skip is what actually has to be caught here.
   */
  { file: "tests/partner-grading-get-readonly.test.ts", min: 2 },
  /**
   * The Public Partner Network behavioural harness: the ONLY suite that executes the shipped
   * denominator SQL (measureEvidence), the real recalculateRating and the real getShopProfile
   * against a live PostgreSQL 17 with the full migration chain, plus the cancellation
   * evidence-lock state machine.
   *
   * It had NO floor. It is ungated and self-provisions its own cluster, so it is correctly absent
   * from GATED_SUITES in tests/ci-execution-floor.test.ts — but that also meant nothing in CI
   * noticed if it were deleted, or if tests were removed from it. Breakage was loud (a beforeAll
   * throw exits non-zero); DELETION was silent. Several sibling self-provisioning suites
   * (partner-full-pilot-workflow, partner-completion-cascade) are floored, so "it self-provisions"
   * was never the reason to omit one.
   *
   * MEASURED 19 = 8 denominator/predicate tests (one per conjunct of PUBLIC_CARD_PREDICATE plus
   * attribution and rework), 2 abandonment-gaming tests, 6 cancellation state-machine tests,
   * 3 sample-gate/public-exposure tests.
   */
  // RE-MEASURED 2026-08-09: 63 (49 declarations + a 14-row it.each). The pin was 19, set when the
  // suite had 19 tests, and never raised as it grew — 44 tests of SLACK, i.e. the rating-lifecycle
  // block (8), the public-reader least-privilege block (23), override expiry (4), eligibility
  // suspension (5) and the V2 recency window (3) were all silently deletable with CI green.
  { file: "tests/partner-public-network-behavioural.test.ts", min: 69 },

  // ── PREVIOUSLY UNFLOORED (HIGH H11) ───────────────────────────────────────────────────────
  // All four were deletable in their entirety with every CI step green: nothing in scripts/ci/
  // and nothing in tests/ci-execution-floor.test.ts referenced them. partner-rollback-integrity
  // is the worst of them — it is the ONLY forward+rollback+re-apply proof for the whole 0047-0066
  // series and the only behavioural coverage of the descending recovery order, and it is exactly
  // the suite whose absence would be discovered during an incident.
  // MEASURED 2026-08-09 against a real disposable PostgreSQL 17 cluster.
  { file: "tests/partner-rollback-integrity.test.ts", min: 44 },
  // B1's dedicated behavioural proof. It is the ONLY executable reproduction of the recency
  // exploit, and server/partner/public-network-service.ts names it in a comment as exactly that —
  // so it must not be deletable behind a green build.
  { file: "tests/partner-review-clock.test.ts", min: 8 },
  { file: "tests/partner-public-network-rating.test.ts", min: 48 },
  { file: "tests/partner-public-network-migration.test.ts", min: 42 },
  { file: "tests/partner-public-network-validation.test.ts", min: 31 },
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
  const result = (report.testResults ?? []).find((r) => (r.name ?? "").replace(/\\/g, "/").replace(/^.*?(tests\/)/, "$1") === file);
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
