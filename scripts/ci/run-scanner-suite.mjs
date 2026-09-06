#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCANNER_SUITE_FLOORS = Object.freeze({
  "billing-ux.test.js": 7,
  "control-plane-load-sim.test.js": 1,
  "environment-targeting.test.js": 21,
  "lide400-preview-transform.test.js": 6,
  "main-auth-ipc.test.js": 10,
  "payment-credit-load-sim.test.js": 1,
  "preview-orientation.test.js": 31,
  "renderer-parses.test.js": 6,
  "renderer-workflow.test.js": 7,
  "scanner-packaging.test.js": 9,
  "server-client-tiff-upload.test.js": 28,
  "station-active-card.test.js": 41,
  "station-client.test.js": 3,
  "station-identity.test.js": 4,
});
export const EXPECTED_SCANNER_FILES = Object.keys(SCANNER_SUITE_FLOORS).length;
export const MINIMUM_SCANNER_ASSERTIONS = Object.values(SCANNER_SUITE_FLOORS).reduce((sum, count) => sum + count, 0);
export const SCANNER_SUITE_TIMEOUT_MS = 120_000;

export function validateScannerDependencyIsolation({ appPath, manifest, lockfile, resolvedHappyDomPath }) {
  const errors = [];
  const declaredVersion = manifest.dependencies?.["happy-dom"] ?? manifest.devDependencies?.["happy-dom"];
  if (!declaredVersion) errors.push("Scanner package must declare happy-dom directly");
  const lockedVersion =
    lockfile.packages?.[""]?.dependencies?.["happy-dom"] ?? lockfile.packages?.[""]?.devDependencies?.["happy-dom"];
  if (!lockedVersion) errors.push("Scanner lockfile must bind the direct happy-dom dependency");
  else if (declaredVersion && lockedVersion !== declaredVersion) {
    errors.push("Scanner manifest and lockfile disagree on happy-dom");
  }
  const nestedModules = `${resolve(appPath, "node_modules")}${sep}`;
  if (!resolvedHappyDomPath || !resolve(resolvedHappyDomPath).startsWith(nestedModules)) {
    errors.push("Scanner happy-dom must resolve from scripts/scanner-app/node_modules");
  }
  return errors;
}

export function parseTapSummary(output) {
  const value = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? NaN);
  return {
    tests: value("tests"),
    passed: value("pass"),
    failed: value("fail"),
    cancelled: value("cancelled"),
    skipped: value("skipped"),
    todo: value("todo"),
  };
}

export function validateScannerResults(results) {
  const errors = [];
  if (results.length !== EXPECTED_SCANNER_FILES)
    errors.push(`expected ${EXPECTED_SCANNER_FILES} files, observed ${results.length}`);
  const observedFiles = results.map((result) => result.file);
  if (new Set(observedFiles).size !== observedFiles.length) errors.push("duplicate Scanner suite result");
  for (const file of Object.keys(SCANNER_SUITE_FLOORS)) {
    if (!observedFiles.includes(file)) errors.push(`missing Scanner suite: ${file}`);
  }
  for (const file of observedFiles) {
    if (!Object.hasOwn(SCANNER_SUITE_FLOORS, file)) errors.push(`unexpected Scanner suite: ${file}`);
  }
  for (const result of results) {
    if (result.status !== 0) errors.push(`${result.file}: process exit ${result.status}`);
    if (result.timedOut) errors.push(`${result.file}: exceeded ${SCANNER_SUITE_TIMEOUT_MS}ms timeout`);
    if (
      ![result.tests, result.passed, result.failed, result.cancelled, result.skipped, result.todo].every(
        Number.isFinite
      )
    )
      errors.push(`${result.file}: missing TAP summary`);
    else {
      if (result.tests === 0 || result.passed === 0) errors.push(`${result.file}: zero tests observed`);
      if (result.failed !== 0) errors.push(`${result.file}: ${result.failed} failed`);
      if (result.cancelled !== 0) errors.push(`${result.file}: ${result.cancelled} cancelled`);
      if (result.skipped !== 0) errors.push(`${result.file}: ${result.skipped} skipped`);
      if (result.todo !== 0) errors.push(`${result.file}: ${result.todo} todo`);
      if (result.tests !== result.passed + result.failed + result.cancelled + result.skipped + result.todo) {
        errors.push(`${result.file}: inconsistent TAP totals`);
      }
      const floor = SCANNER_SUITE_FLOORS[result.file];
      if (Number.isSafeInteger(floor) && result.passed < floor) {
        errors.push(`${result.file}: per-file floor not met: ${result.passed} < ${floor}`);
      }
    }
  }
  const passed = results.reduce((sum, result) => sum + (Number.isFinite(result.passed) ? result.passed : 0), 0);
  if (passed < MINIMUM_SCANNER_ASSERTIONS)
    errors.push(`assertion floor not met: ${passed} < ${MINIMUM_SCANNER_ASSERTIONS}`);
  return { ok: errors.length === 0, passed, errors };
}

function runCli() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    console.error(`Scanner gate requires Node >=22.12.0; observed ${process.versions.node}`);
    process.exitCode = 1;
    return;
  }
  const app = resolve("scripts/scanner-app");
  const manifest = JSON.parse(readFileSync(resolve(app, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(resolve(app, "package-lock.json"), "utf8"));
  let resolvedHappyDomPath;
  try {
    resolvedHappyDomPath = createRequire(resolve(app, "package.json")).resolve("happy-dom");
  } catch {
    resolvedHappyDomPath = undefined;
  }
  const dependencyErrors = validateScannerDependencyIsolation({
    appPath: app,
    manifest,
    lockfile,
    resolvedHappyDomPath,
  });
  if (dependencyErrors.length > 0) {
    console.error(dependencyErrors.join("\n"));
    process.exitCode = 1;
    return;
  }
  const files = readdirSync(resolve(app, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .sort();
  const results = [];
  for (const file of files) {
    const processResult = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `test/${file}`], {
      cwd: app,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: SCANNER_SUITE_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: "test", CI: "true" },
    });
    const output = `${processResult.stdout ?? ""}\n${processResult.stderr ?? ""}`;
    process.stdout.write(output);
    results.push({
      file,
      status: processResult.status,
      timedOut: processResult.error?.code === "ETIMEDOUT",
      ...parseTapSummary(output),
    });
  }
  const verdict = validateScannerResults(results);
  if (!verdict.ok) {
    console.error(verdict.errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Scanner gate passed: ${results.length} files, ${verdict.passed} assertions, zero failures/skips`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
