#!/usr/bin/env node
/**
 * Compare Matrix A and Matrix B mechanically.
 *
 * The point of running the matrix twice is to detect hidden environmental coupling: a suite whose
 * result depends on a port, a login-role name, a database name, a leftover row or another suite's
 * residue will differ between two environments that share none of those. So this compares the
 * numbers AND the per-file breakdown — a total that matches while individual files differ would be
 * two defects cancelling out, which a headline count alone would hide.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const evid = join(dirname(fileURLToPath(import.meta.url)), "../evidence");
const A = JSON.parse(readFileSync(join(evid, "summary-A.json"), "utf8"));
const B = JSON.parse(readFileSync(join(evid, "summary-B.json"), "utf8"));

const rows = [];
const diffs = [];
function cmp(label, a, b) {
  rows.push({ metric: label, A: a, B: b, equal: a === b });
  if (a !== b) diffs.push(`${label}: A=${a} B=${b}`);
}

cmp("full-suite: files", A.pass2_fullRepositorySuite.suiteCount, B.pass2_fullRepositorySuite.suiteCount);
cmp("full-suite: passed", A.pass2_fullRepositorySuite.passed, B.pass2_fullRepositorySuite.passed);
cmp("full-suite: failed", A.pass2_fullRepositorySuite.failed, B.pass2_fullRepositorySuite.failed);
cmp("full-suite: skipped", A.pass2_fullRepositorySuite.skipped, B.pass2_fullRepositorySuite.skipped);
cmp("full-suite: env aborts", A.pass2_fullRepositorySuite.environmentAborts, B.pass2_fullRepositorySuite.environmentAborts);
cmp("full-suite: exit", A.pass2_fullRepositorySuite.exitCode, B.pass2_fullRepositorySuite.exitCode);
cmp("per-suite matrix: suites", A.pass1_perSuiteMatrix.suiteCount, B.pass1_perSuiteMatrix.suiteCount);
cmp("per-suite matrix: passed", A.pass1_perSuiteMatrix.totals.passed, B.pass1_perSuiteMatrix.totals.passed);
cmp("per-suite matrix: failed", A.pass1_perSuiteMatrix.totals.failed, B.pass1_perSuiteMatrix.totals.failed);
cmp("per-suite matrix: skipped", A.pass1_perSuiteMatrix.totals.skipped, B.pass1_perSuiteMatrix.totals.skipped);
cmp("per-suite matrix: exit", A.pass1_perSuiteMatrix.exitCode, B.pass1_perSuiteMatrix.exitCode);
cmp("execution floors: exit", A.executionFloors.exitCode, B.executionFloors.exitCode);
cmp("green", A.green, B.green);

// Per-file: the check a headline total cannot make.
const files = new Set([
  ...Object.keys(A.pass2_fullRepositorySuite.perFile ?? {}),
  ...Object.keys(B.pass2_fullRepositorySuite.perFile ?? {}),
]);
const fileDiffs = [];
for (const f of [...files].sort()) {
  const a = A.pass2_fullRepositorySuite.perFile?.[f];
  const b = B.pass2_fullRepositorySuite.perFile?.[f];
  const key = (x) => (x ? `${x.passed}/${x.failed}/${x.skipped}/${x.status}` : "ABSENT");
  if (key(a) !== key(b)) fileDiffs.push({ file: f, A: key(a), B: key(b) });
}

// Per-suite matrix, suite by suite.
const suiteDiffs = [];
const byFile = (s) => Object.fromEntries(s.pass1_perSuiteMatrix.suites.map((x) => [x.suite, x]));
const aS = byFile(A);
const bS = byFile(B);
for (const s of new Set([...Object.keys(aS), ...Object.keys(bS)])) {
  const k = (x) => (x ? `${x.passed}/${x.failed}/${x.skipped}` : "ABSENT");
  if (k(aS[s]) !== k(bS[s])) suiteDiffs.push({ suite: s, A: k(aS[s]), B: k(bS[s]) });
}

console.log("=============== MATRIX A vs MATRIX B ===============");
console.log("environment:");
console.log(
  `  A  pg16 sysid ${A.environment.pg16.systemIdentifier}  pg17 sysid ${A.environment.pg17.systemIdentifier}  ` +
    `pg17 :${A.environment.pg17.port}  admin ${A.environment.adminRole}  prefix ${A.environment.databasePrefix}  minio :${A.environment.minioPort}`
);
console.log(
  `  B  pg16 sysid ${B.environment.pg16.systemIdentifier}  pg17 sysid ${B.environment.pg17.systemIdentifier}  ` +
    `pg17 :${B.environment.pg17.port}  admin ${B.environment.adminRole}  prefix ${B.environment.databasePrefix}  minio :${B.environment.minioPort}`
);
const sharedIdentity = [
  A.environment.pg16.systemIdentifier === B.environment.pg16.systemIdentifier,
  A.environment.pg17.systemIdentifier === B.environment.pg17.systemIdentifier,
  A.environment.adminRole === B.environment.adminRole,
  A.environment.databasePrefix === B.environment.databasePrefix,
  A.environment.minioPort === B.environment.minioPort,
].some(Boolean);
console.log(`  shared identity between A and B: ${sharedIdentity ? "YES — INDEPENDENCE BROKEN" : "none"}`);
console.log();
console.table(rows);
console.log(`per-file differences in the full suite: ${fileDiffs.length}`);
for (const d of fileDiffs) console.log(`  ${d.file}  A=${d.A}  B=${d.B}`);
console.log(`per-suite matrix differences: ${suiteDiffs.length}`);
for (const d of suiteDiffs) console.log(`  ${d.suite}  A=${d.A}  B=${d.B}`);

const identical = diffs.length === 0 && fileDiffs.length === 0 && suiteDiffs.length === 0 && !sharedIdentity;
console.log();
console.log(identical ? "VERDICT: A and B are IDENTICAL from two independent environments." : "VERDICT: A and B DIFFER.");
for (const d of diffs) console.log(`  ${d}`);
process.exit(identical ? 0 : 1);
