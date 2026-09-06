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
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CRITICAL_SUITES,
  SUITES,
  findSuite,
  urlFor,
  assertDisposable,
  isolatedSuiteEnvironment,
} from "./partner-suite-env-matrix.mjs";
import { classifyReport, GREEN_VERDICTS, validatePartnerSuiteFloors } from "./partner-suite-verdict.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all");
const jsonIdx = args.indexOf("--json");
const jsonDir = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const explicit = args.filter((a) => a.endsWith(".test.ts"));
// Individual integration hooks may legitimately consume 180s. The process cap must
// leave room for setup, the full assertion body, and teardown rather than racing the
// suite's own supported timeout.
const PARTNER_SUITE_TIMEOUT_MS = 600_000;
const floorDocument = JSON.parse(readFileSync("scripts/ci/partner-suite-floors.json", "utf8"));
if (floorDocument.schemaVersion !== 1 || !floorDocument.suites) {
  console.error("invalid Partner suite floor baseline");
  process.exit(1);
}

const targets = all ? CRITICAL_SUITES : explicit.map(findSuite).filter(Boolean);
if (targets.length === 0) {
  console.error("usage: run-partner-suite.mjs (--all | <tests/...test.ts> ...) [--json <dir>]");
  console.error(`known suites:\n${SUITES.map((s) => "  " + s.file).join("\n")}`);
  process.exit(1);
}
// An unknown suite name is a MISTAKE, not an empty selection. Without this, a typo'd path silently
// narrowed the run — and if every name were typo'd the usage branch above would at least catch it,
// but one bad name among several would quietly drop that suite and still print green.
const unknown = explicit.filter((f) => !findSuite(f));
if (unknown.length) {
  console.error(`unknown suite(s), not present in the matrix: ${unknown.join(", ")}`);
  process.exit(1);
}

/*
 * JSON EVIDENCE IS MANDATORY (RC-F12).
 *
 * `--json` used to be optional, and without it `classify()` fell back to the vitest EXIT CODE alone:
 * every suite reported `passed=0` and the run still printed "All 36 suite(s) green". A suite that
 * executed nothing was indistinguishable from one that proved everything. There is now no path
 * through this script that reports a verdict it has not counted: when the caller does not ask for
 * reports we still collect them, into a temporary directory that is removed on the way out.
 */
const ephemeralJsonDir = jsonDir ? null : mkdtempSync(join(tmpdir(), "partner-suite-"));
const reportDir = jsonDir ?? ephemeralJsonDir;
mkdirSync(reportDir, { recursive: true });

/**
 * Read one suite's report from disk and classify it. The RULE itself lives in
 * scripts/ci/partner-suite-verdict.mjs so it can be tested; this only does the I/O.
 *
 * A missing or unparseable report is an ENVIRONMENT ABORT, never a pass — see RC-F12 in that file.
 */
function classify(reportPath, file, status) {
  if (!reportPath || !existsSync(reportPath)) return classifyReport(null, file, status);
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return classifyReport(null, file, status);
  }
  return classifyReport(report, file, status);
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
  const psql = (sql) => spawnSync("psql", [maintenance, "-v", "ON_ERROR_STOP=1", "-Atc", sql], { encoding: "utf8" });
  const drop = psql(`DROP DATABASE IF EXISTS "${suite.database}" WITH (FORCE)`);
  if (drop.status !== 0) throw new Error(`drop ${suite.database} failed: ${drop.stderr || drop.stdout}`);
  const create = psql(`CREATE DATABASE "${suite.database}"`);
  if (create.status !== 0) throw new Error(`create ${suite.database} failed: ${create.stderr || create.stdout}`);
  if (suite.seedCoreStubs) seedCoreStubs(suite);
}

/**
 * The MINIMAL core-table precondition for suites that apply the FULL repository migration set.
 *
 * 0018_correction_audit_index builds a partial index ON audit_log, and 0022_print_workflow_lifecycle
 * ALTERs certificates. No PARTNER migration creates either table and these suites do not seed them,
 * so on a freshly created database they die in beforeAll with `relation "audit_log" does not exist`.
 *
 * .github/workflows/ci.yml has done this for six suites all along; this runner did NOT, because it
 * DROPs and recreates each database and so discards anything seeded beforehand. That asymmetry is
 * why these suites passed in CI and environment-aborted here the moment they were added to the gate.
 *
 * DELIBERATELY a minimal stub pair, not a real schema push: the real `certificates` has no `secret`
 * column, and these suites insert cert_id/secret and assert the row survives a rollback. Both tables
 * are owned by pn_migrator because the migrations are applied as that non-superuser role. Kept
 * byte-equivalent to the CI step so the two environments cannot drift.
 */
function seedCoreStubs(suite) {
  const url = urlFor(suite.cluster, suite.database);
  assertDisposable(url, `${suite.file} core-stub seed`);
  const run = (sql) => {
    const r = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`core-stub seed failed for ${suite.database}: ${r.stderr || r.stdout}`);
  };
  run(
    "DO $$ BEGIN CREATE ROLE pn_migrator LOGIN PASSWORD 'realistic-migrator-pw' NOSUPERUSER CREATEROLE NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END$$;"
  );
  run(
    "CREATE TABLE IF NOT EXISTS audit_log (id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamp NOT NULL DEFAULT now())"
  );
  run("ALTER TABLE audit_log OWNER TO pn_migrator");
  run("CREATE TABLE IF NOT EXISTS certificates (id serial PRIMARY KEY, cert_id text, secret text)");
  run("ALTER TABLE certificates OWNER TO pn_migrator");
}

const results = [];
for (const suite of targets) {
  // Hosted CI necessarily exports the flattened runner's full database matrix.
  // None of it may leak into an isolated suite: scrub every matrix-managed key,
  // then add back only this suite's declared contract.
  const env = isolatedSuiteEnvironment(process.env, suite);
  const reportPath = join(reportDir, suite.file.replace(/\//g, "_") + ".json");
  // Always emit the machine-readable report: it is the ONLY thing this runner is allowed to
  // conclude "green" from. `--reporter=default` is kept so a human still sees the failure output.
  const vitestArgs = ["vitest", "run", suite.file, "--reporter=default", "--reporter=json", "--outputFile", reportPath];

  process.stdout.write(`\n=== ${suite.file}  [${suite.topology}]\n`);
  try {
    recreateDatabase(suite);
  } catch (err) {
    console.error(`[env] ${err.message}`);
    results.push({
      file: suite.file,
      critical: !!suite.critical,
      ms: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      verdict: "environment_abort",
    });
    continue;
  }
  const started = process.hrtime.bigint();
  const proc = spawnSync("npx", vitestArgs, {
    env,
    stdio: "inherit",
    timeout: PARTNER_SUITE_TIMEOUT_MS,
  });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const counts = classify(reportPath, suite.file, proc.status);
  results.push({
    file: suite.file,
    critical: !!suite.critical,
    ms,
    timedOut: proc.error?.code === "ETIMEDOUT",
    ...counts,
  });
}

console.log("\n================ PARTNER SUITE MATRIX ================");
for (const r of results) {
  console.log(
    `${r.verdict.toUpperCase().padEnd(19)} ${r.file}  ` +
      `passed=${r.passed} failed=${r.failed} skipped=${r.skipped} (${r.ms}ms)`
  );
}
if (ephemeralJsonDir) rmSync(ephemeralJsonDir, { recursive: true, force: true });

const bad = results.filter((r) => r.critical && !GREEN_VERDICTS.includes(r.verdict));
if (bad.length) {
  console.error(`\n${bad.length} critical Partner suite(s) not green: ${bad.map((b) => b.file).join(", ")}`);
  process.exit(1);
}
// Belt and braces: "green" over an empty result set is not green, it is a run that did nothing.
if (results.length === 0) {
  console.error("\nno suites executed — refusing to report green");
  process.exit(1);
}
/*
 * DID WE ACTUALLY RUN EVERY TARGET WE WERE GIVEN?
 *
 * Observed for real on 2026-08-16: a run selected all 70 critical suites, executed only the first
 * 37, and exited 0 printing "All 37 suite(s) green" — a truncated run reporting success, with the
 * 33 unexecuted suites recorded nowhere. Every other fail-closed rule in this runner judges the
 * suites it OBSERVED; none of them noticed that a third of the gate never ran at all.
 *
 * The count is the cheapest possible check and it closes the last way this script can report green
 * over missing evidence: a verdict is only valid for the exact set of targets it was asked to cover.
 */
if (results.length !== targets.length) {
  console.error(
    `\nTRUNCATED RUN: ${results.length} of ${targets.length} selected suite(s) executed. ` +
      `Refusing to report green — the remaining ${targets.length - results.length} were never run, ` +
      `so nothing is known about them.`
  );
  process.exit(1);
}
const observed = results.reduce((n, r) => n + r.passed, 0);
if (observed === 0) {
  console.error("\nzero tests observed across every suite — refusing to report green");
  process.exit(1);
}
const selectedFloors = Object.fromEntries(targets.map((suite) => [suite.file, floorDocument.suites[suite.file]]));
const floorVerdict = validatePartnerSuiteFloors(results, selectedFloors);
if (!floorVerdict.ok) {
  console.error(`\n${floorVerdict.errors.join("\n")}`);
  process.exit(1);
}
console.log(
  `\nAll ${results.length} suite(s) green — ${observed} assertions observed ` +
    `(per-suite baseline ${floorVerdict.minimum}).`
);
