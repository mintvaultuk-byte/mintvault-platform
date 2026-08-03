#!/usr/bin/env node
/**
 * Run Partner suites with their CORRECT per-suite database pinning.
 *
 * Each suite is launched as its OWN vitest process with ONLY the variables that suite needs
 * (see scripts/ci/partner-suite-env-matrix.mjs). Nothing is pinned globally, so the topology
 * collision that made healthy RBAC suites look broken cannot recur.
 *
 *   node scripts/ci/run-partner-suite.mjs --all            # every critical suite, in order
 *   node scripts/ci/run-partner-suite.mjs tests/x.test.ts  # one suite
 *   node scripts/ci/run-partner-suite.mjs --all --json out # also emit per-suite JSON reports
 *
 * Exit code is non-zero if ANY critical suite failed, was skipped, or aborted on environment.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CRITICAL_SUITES,
  SUITES,
  envForSuite,
  findSuite,
  urlFor,
  assertDisposable,
} from "./partner-suite-env-matrix.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all");
const jsonIdx = args.indexOf("--json");
const jsonDir = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const explicit = args.filter((a) => a.endsWith(".test.ts"));

const targets = all ? CRITICAL_SUITES : explicit.map(findSuite).filter(Boolean);
if (targets.length === 0) {
  console.error("usage: run-partner-suite.mjs (--all | <tests/...test.ts> ...) [--json <dir>]");
  console.error(`known suites:\n${SUITES.map((s) => "  " + s.file).join("\n")}`);
  process.exit(1);
}
if (jsonDir) mkdirSync(jsonDir, { recursive: true });

/**
 * Classify one suite result from its vitest JSON report.
 *
 * `status` (the vitest exit code) is load-bearing and must be consulted FIRST. A suite whose
 * beforeAll throws produces a FILE-level failure with an empty assertionResults array and every
 * test marked skipped — which, read from assertions alone, is indistinguishable from a suite that
 * was never gated on. Reporting that as "skipped" is precisely the silent-green failure mode this
 * matrix exists to eliminate, so a non-zero exit with no failed assertion is an environment abort.
 */
function classify(reportPath, file, status) {
  if (!reportPath || !existsSync(reportPath)) {
    return { passed: 0, failed: 0, skipped: 0, verdict: status === 0 ? "passed" : "environment_abort" };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return { passed: 0, failed: 0, skipped: 0, verdict: "environment_abort" };
  }
  const result = (report.testResults ?? []).find((f) =>
    String(f.name).replace(/\\/g, "/").replace(/^.*?(tests\/)/, "$1") === file
  );
  const assertions = result?.assertionResults ?? [];
  const passed = assertions.filter((a) => a.status === "passed").length;
  const failed = assertions.filter((a) => a.status === "failed").length;
  const skipped = assertions.filter((a) => a.status === "skipped" || a.status === "pending").length;
  let verdict = "passed";
  if (failed > 0) verdict = "failed";
  else if (status !== 0) verdict = "environment_abort"; // file-level throw (beforeAll, import, gate)
  else if (passed === 0 && skipped > 0) verdict = "skipped";
  else if (passed === 0) verdict = "environment_abort";
  return { passed, failed, skipped, verdict };
}

/**
 * Recreate this suite's database so every run starts from an empty schema.
 *
 * Migration suites are NOT idempotent against a database that already holds their objects
 * ("cannot change return type of existing function"), so a reused database turns a healthy suite
 * red for reasons that have nothing to do with the source. Roles are cluster-scoped and survive,
 * which is correct: the realistic role provisioning is itself idempotent.
 */
function recreateDatabase(suite) {
  if (!suite.cluster || !suite.database) return;
  const maintenance = urlFor(suite.cluster, "postgres");
  assertDisposable(maintenance, `${suite.file} maintenance connection`);
  const psql = (sql) =>
    spawnSync("psql", [maintenance, "-v", "ON_ERROR_STOP=1", "-Atc", sql], { encoding: "utf8" });
  const drop = psql(`DROP DATABASE IF EXISTS "${suite.database}" WITH (FORCE)`);
  if (drop.status !== 0) throw new Error(`drop ${suite.database} failed: ${drop.stderr || drop.stdout}`);
  const create = psql(`CREATE DATABASE "${suite.database}"`);
  if (create.status !== 0) throw new Error(`create ${suite.database} failed: ${create.stderr || create.stdout}`);
}

const results = [];
for (const suite of targets) {
  const env = { ...process.env, LC_ALL: "C", LANG: "C", ...envForSuite(suite) };
  // A globally-inherited MINTVAULT pin is exactly the collision this runner exists to prevent.
  // Suites that do not pin accounting themselves must not inherit one from the parent shell.
  if (!Object.prototype.hasOwnProperty.call(envForSuite(suite), "MINTVAULT_DATABASE_URL")) {
    delete env.MINTVAULT_DATABASE_URL;
    delete env.PARTNER_ADMIN_DATABASE_URL;
    delete env.PARTNER_DATABASE_URL;
    delete env.PARTNER_CONNECTOR_DATABASE_URL;
  }
  const reportPath = jsonDir ? join(jsonDir, suite.file.replace(/[\/]/g, "_") + ".json") : null;
  const vitestArgs = ["vitest", "run", suite.file];
  if (reportPath) vitestArgs.push("--reporter=json", "--outputFile", reportPath);

  process.stdout.write(`\n=== ${suite.file}  [${suite.topology}]\n`);
  try {
    recreateDatabase(suite);
  } catch (err) {
    console.error(`[env] ${err.message}`);
    results.push({ file: suite.file, critical: !!suite.critical, ms: 0, passed: 0, failed: 0, skipped: 0, verdict: "environment_abort" });
    continue;
  }
  const started = process.hrtime.bigint();
  const proc = spawnSync("npx", vitestArgs, { env, stdio: "inherit" });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const counts = classify(reportPath, suite.file, proc.status);
  results.push({ file: suite.file, critical: !!suite.critical, ms, ...counts });
}

console.log("\n================ PARTNER SUITE MATRIX ================");
for (const r of results) {
  console.log(
    `${r.verdict.toUpperCase().padEnd(19)} ${r.file}  ` +
      `passed=${r.passed} failed=${r.failed} skipped=${r.skipped} (${r.ms}ms)`
  );
}
const bad = results.filter((r) => r.critical && r.verdict !== "passed");
if (bad.length) {
  console.error(`\n${bad.length} critical Partner suite(s) not green: ${bad.map((b) => b.file).join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} suite(s) green.`);
