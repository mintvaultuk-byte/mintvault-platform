/**
 * VERDICT CLASSIFICATION FOR THE PARTNER CRITICAL GATE — the one place that decides "green".
 *
 * WHY THIS IS ITS OWN MODULE (RC-F12). This logic used to live inline in run-partner-suite.mjs,
 * where nothing could test it, and it had a fail-OPEN branch: with no `--json` report to read it
 * returned `{ passed: 0, verdict: status === 0 ? "passed" : ... }`. The runner then printed
 * "All 36 suite(s) green" having OBSERVED ZERO TESTS. A suite that executed nothing and exited 0 was
 * indistinguishable from one that proved everything — in a script whose entire job is to be the
 * evidence that the Partner surface works. Extracting it makes the rule assertable, and
 * tests/partner-suite-runner-integrity.test.ts now pins every branch.
 *
 * THE RULE, FAIL-CLOSED IN EVERY DIRECTION:
 *   no report at all           -> environment_abort   (we cannot SEE what ran; that is not a pass)
 *   unparseable report         -> environment_abort
 *   any failed assertion       -> failed
 *   non-zero exit, none failed -> environment_abort   (file-level throw: beforeAll, import, gate)
 *   zero observed tests        -> environment_abort   (nothing ran; never a pass)
 *   any skipped assertion      -> partially_skipped   (evidence went missing silently)
 *   otherwise                  -> passed
 *
 * `status` (the vitest exit code) is load-bearing and consulted BEFORE the skip rule. A suite whose
 * beforeAll throws produces a FILE-level failure with an empty assertionResults array and every test
 * marked skipped — which, read from assertions alone, is indistinguishable from a suite that was
 * never gated on.
 */

/**
 * @param {object|null} report  parsed vitest JSON report, or null when none exists/parsed
 * @param {string} file         suite path as listed in the matrix, e.g. "tests/partner-x.test.ts"
 * @param {number|null} status  the vitest process exit code
 */
export function classifyReport(report, file, status) {
  if (!report) {
    return { passed: 0, failed: 0, skipped: 0, verdict: "environment_abort" };
  }
  const result = (report.testResults ?? []).find(
    (f) =>
      String(f.name)
        .replace(/\\/g, "/")
        .replace(/^.*?(tests\/)/, "$1") === file
  );
  // The report exists but says nothing about this file — the suite did not run. Fail closed.
  if (!result) {
    return { passed: 0, failed: 0, skipped: 0, verdict: "environment_abort" };
  }
  const assertions = result.assertionResults ?? [];
  const passed = assertions.filter((a) => a.status === "passed").length;
  const failed = assertions.filter((a) => a.status === "failed").length;
  const skipped = assertions.filter((a) => a.status === "skipped" || a.status === "pending").length;

  let verdict = "passed";
  if (failed > 0) verdict = "failed";
  else if (status !== 0) verdict = "environment_abort";
  else if (passed === 0) verdict = "environment_abort";
  // ANY skip in a critical suite is a failure, not a pass. Previously `skipped` only mattered when
  // `passed === 0`, so a suite whose env gate hard-skipped every real test still reported "passed"
  // on the strength of its one out-of-gate CI-wiring guard.
  else if (skipped > 0) verdict = "partially_skipped";
  return { passed, failed, skipped, verdict };
}

/** The verdicts that are allowed to keep the gate green. Exactly one. */
export const GREEN_VERDICTS = Object.freeze(["passed"]);

/**
 * Conservative bootstrap floor already enforced by the five flattened-run
 * sentinels (268 + 24 + 88 + 68 + 25). The isolated matrix normally observes
 * far more; this floor prevents a heavily truncated assertion body from being
 * accepted before an exact per-suite candidate baseline is recorded.
 */
export const MINIMUM_PARTNER_CRITICAL_ASSERTIONS = 473;

export function meetsPartnerAggregateFloor(observed) {
  return Number.isSafeInteger(observed) && observed >= MINIMUM_PARTNER_CRITICAL_ASSERTIONS;
}

export function validatePartnerSuiteFloors(results, floors) {
  const errors = [];
  const expected = Object.keys(floors).sort();
  const observedFiles = results.map((result) => result.file);
  if (new Set(observedFiles).size !== observedFiles.length) errors.push("duplicate Partner suite result");
  for (const file of expected) {
    const result = results.find((candidate) => candidate.file === file);
    if (!result) errors.push(`missing Partner suite result: ${file}`);
    else if (!Number.isSafeInteger(floors[file]) || floors[file] < 1)
      errors.push(`invalid Partner suite floor: ${file}`);
    else if (result.passed < floors[file])
      errors.push(`${file}: per-suite floor not met: ${result.passed} < ${floors[file]}`);
  }
  for (const file of observedFiles)
    if (!Object.hasOwn(floors, file)) errors.push(`unexpected Partner suite result: ${file}`);
  const minimum = Object.values(floors).reduce((sum, count) => sum + count, 0);
  const observed = results.reduce((sum, result) => sum + result.passed, 0);
  if (observed < minimum) errors.push(`Partner matrix floor not met: ${observed} < ${minimum}`);
  return { ok: errors.length === 0, minimum, observed, errors };
}
