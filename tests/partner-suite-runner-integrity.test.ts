/**
 * THE PARTNER GATE RUNNER MUST FAIL CLOSED (RC-F12).
 *
 * `scripts/ci/run-partner-suite.mjs` is the script whose output the whole programme quotes as
 * proof — "36 suites / 691 passed / 0 failed / 0 skipped". A defect in the RUNNER is therefore
 * worse than a defect in any single suite: it can make every other proof a fiction.
 *
 * It had exactly that defect. `--json` was optional, and without it the verdict came from the
 * vitest EXIT CODE alone: every suite reported `passed=0` and the run still printed
 * "All 36 suite(s) green". A suite that executed nothing was indistinguishable from one that proved
 * everything. That was observed for real during the RC-F9 pass.
 *
 * These tests pin the rule directly. `classifyReport` is a pure function over a parsed vitest
 * report, so each branch can be asserted without running PostgreSQL, and the two process-level
 * cases are asserted by actually spawning the runner.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { classifyReport, GREEN_VERDICTS } from "../scripts/ci/partner-suite-verdict.mjs";

const FILE = "tests/partner-example.test.ts";

/** A vitest JSON report shaped like the real thing. */
function report(statuses: string[], name = FILE) {
  return {
    testResults: [{ name: `/abs/path/${name}`, assertionResults: statuses.map((status) => ({ status })) }],
  };
}

/** Would the gate stay green on this verdict? */
const isGreen = (verdict: string) => GREEN_VERDICTS.includes(verdict);

function runRunner(args: string[]) {
  return spawnSync("node", ["scripts/ci/run-partner-suite.mjs", ...args], { encoding: "utf8" });
}

describe("partner gate runner — verdict rule fails closed", () => {
  it("a genuinely green suite is the ONLY thing that reports green", () => {
    const v = classifyReport(report(["passed", "passed", "passed"]), FILE, 0);
    expect(v).toMatchObject({ passed: 3, failed: 0, skipped: 0, verdict: "passed" });
    expect(isGreen(v.verdict)).toBe(true);
  });

  it("ZERO observed tests is never green, even on a clean exit code", () => {
    // The exact silent-green that shipped: exit 0, nothing run.
    const v = classifyReport(report([]), FILE, 0);
    expect(v.passed).toBe(0);
    expect(v.verdict).toBe("environment_abort");
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a MISSING report is never green — a verdict cannot be given for something unseen", () => {
    const v = classifyReport(null, FILE, 0);
    expect(v.verdict).toBe("environment_abort");
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a report that does not mention the suite is never green", () => {
    // e.g. vitest matched no file, or wrote a report for a different path.
    const v = classifyReport(report(["passed"], "tests/some-other.test.ts"), FILE, 0);
    expect(v.verdict).toBe("environment_abort");
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a PARTIALLY skipped critical suite is not green", () => {
    // The historical failure: one out-of-gate CI-wiring guard passes while every real assertion is
    // skipped by an env gate, and the suite reports "passed" on the strength of that single test.
    const v = classifyReport(report(["passed", "skipped", "skipped"]), FILE, 0);
    expect(v).toMatchObject({ passed: 1, skipped: 2, verdict: "partially_skipped" });
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a fully skipped suite is not green", () => {
    const v = classifyReport(report(["skipped", "skipped"]), FILE, 0);
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("`pending` counts as skipped, not as absent", () => {
    const v = classifyReport(report(["passed", "pending"]), FILE, 0);
    expect(v.skipped).toBe(1);
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a beforeAll abort is not green — non-zero exit with no failed assertion", () => {
    // A file-level throw produces an empty/skipped assertion list plus a non-zero exit. Read from
    // assertions alone this is indistinguishable from a suite that was never gated on.
    const v = classifyReport(report(["skipped", "skipped"]), FILE, 1);
    expect(v.verdict).toBe("environment_abort");
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a non-zero exit is never green even when every assertion passed", () => {
    const v = classifyReport(report(["passed", "passed"]), FILE, 1);
    expect(v.verdict).toBe("environment_abort");
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("a failed assertion reports failed, and failure outranks a skip", () => {
    const v = classifyReport(report(["passed", "failed", "skipped"]), FILE, 1);
    expect(v).toMatchObject({ failed: 1, verdict: "failed" });
    expect(isGreen(v.verdict)).toBe(false);
  });

  it("exactly one verdict is green", () => {
    // If a future verdict is added, it is non-green until someone deliberately says otherwise.
    expect(GREEN_VERDICTS).toEqual(["passed"]);
  });
});

describe("partner gate runner — process-level contract", () => {
  it("a usage error exits NON-ZERO and never prints green", () => {
    const r = runRunner([]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("usage:");
    expect(r.stdout ?? "").not.toContain("suite(s) green");
  });

  it("an unknown suite name exits NON-ZERO rather than silently narrowing the run", () => {
    const r = runRunner(["tests/this-suite-does-not-exist.test.ts"]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/unknown suite|usage:/);
    expect(r.stdout ?? "").not.toContain("suite(s) green");
  });

  it("the runner ALWAYS collects JSON evidence, so a verdict is never inferred from an exit code", () => {
    // The `--json` flag may be omitted by a caller; the reports must be collected regardless.
    // Asserted on the source because proving it at runtime would require booting PostgreSQL.
    const src = spawnSync(
      "node",
      ["-e", "process.stdout.write(require('fs').readFileSync('scripts/ci/run-partner-suite.mjs','utf8'))"],
      {
        encoding: "utf8",
      }
    ).stdout;
    expect(src).toContain("mkdtempSync");
    expect(src).toContain('"--reporter=json"');
    // and there is no longer a reportPath that can be null
    expect(src).not.toMatch(/const reportPath = jsonDir \?/);
  });
});
