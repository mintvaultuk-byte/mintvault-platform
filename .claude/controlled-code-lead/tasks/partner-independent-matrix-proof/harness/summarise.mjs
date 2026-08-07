#!/usr/bin/env node
/**
 * Reduce one matrix run to the numbers Matrix A and Matrix B are compared on.
 *
 * Counts come from the vitest JSON reports, never from the console output: a suite whose beforeAll
 * throws prints something that reads like a skip while the report shows a file-level failure with
 * an empty assertion list. Every category below is derived from the report, and the run is only
 * "green" when every one of them is what it must be.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [label, pass1Status, pass2Status, floorStatus, storageStatus] = process.argv.slice(2);
const runDir = join(here, "../evidence", `run-${label}`);

function countReport(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  let passed = 0, failed = 0, skipped = 0, files = 0, fileFailures = 0;
  const perFile = {};
  for (const f of report.testResults ?? []) {
    files++;
    const name = String(f.name).replace(/\\/g, "/").replace(/^.*?(tests\/)/, "$1");
    const a = f.assertionResults ?? [];
    const p = a.filter((x) => x.status === "passed").length;
    const fl = a.filter((x) => x.status === "failed").length;
    const sk = a.filter((x) => x.status === "skipped" || x.status === "pending").length;
    // A file that reports a failure with ZERO failed assertions is an ENVIRONMENT ABORT (a throw in
    // beforeAll / import / a gate), which must never be counted as a skip.
    if (f.status === "failed" && fl === 0) fileFailures++;
    passed += p; failed += fl; skipped += sk;
    perFile[name] = { passed: p, failed: fl, skipped: sk, status: f.status };
  }
  return { files, passed, failed, skipped, environmentAborts: fileFailures, perFile };
}

const summary = {
  matrix: label,
  environment: JSON.parse(readFileSync(join(here, "../evidence", `environment-${label}.json`), "utf8")),
  pass1_perSuiteMatrix: { exitCode: Number(pass1Status), suites: [], totals: { passed: 0, failed: 0, skipped: 0 } },
  pass2_fullRepositorySuite: { exitCode: Number(pass2Status) },
  executionFloors: { exitCode: Number(floorStatus) },
  storageAfter: { exitCode: Number(storageStatus) },
};

// PASS 1 — one JSON report per critical suite.
const perSuiteDir = join(runDir, "per-suite");
if (existsSync(perSuiteDir)) {
  for (const file of readdirSync(perSuiteDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const counted = countReport(join(perSuiteDir, file));
    const suiteFile = file.replace(/\.json$/, "").replace(/_/g, "/");
    summary.pass1_perSuiteMatrix.suites.push({ suite: suiteFile, ...counted, perFile: undefined });
    summary.pass1_perSuiteMatrix.totals.passed += counted.passed;
    summary.pass1_perSuiteMatrix.totals.failed += counted.failed;
    summary.pass1_perSuiteMatrix.totals.skipped += counted.skipped;
  }
  summary.pass1_perSuiteMatrix.suiteCount = summary.pass1_perSuiteMatrix.suites.length;
}

// PASS 2 — the whole repository.
const fullReport = join(runDir, "full-report.json");
if (existsSync(fullReport)) {
  const counted = countReport(fullReport);
  summary.pass2_fullRepositorySuite = {
    ...summary.pass2_fullRepositorySuite,
    suiteCount: counted.files,
    passed: counted.passed,
    failed: counted.failed,
    skipped: counted.skipped,
    environmentAborts: counted.environmentAborts,
    perFile: counted.perFile,
  };
}

/**
 * TEST-outcome verdict. Storage cleanliness is reported SEPARATELY below rather than folded in
 * here, because a storage leak is a finding about the suites' own hygiene, not a failed assertion —
 * conflating the two would make one number answer two different questions.
 */
summary.green =
  summary.pass1_perSuiteMatrix.exitCode === 0 &&
  summary.pass2_fullRepositorySuite.exitCode === 0 &&
  summary.executionFloors.exitCode === 0 &&
  (summary.pass2_fullRepositorySuite.failed ?? 1) === 0 &&
  (summary.pass2_fullRepositorySuite.environmentAborts ?? 1) === 0 &&
  summary.pass1_perSuiteMatrix.totals.failed === 0 &&
  summary.pass1_perSuiteMatrix.totals.skipped === 0;

summary.storageClean = summary.storageAfter.exitCode === 0;

console.log(JSON.stringify(summary, null, 2));
