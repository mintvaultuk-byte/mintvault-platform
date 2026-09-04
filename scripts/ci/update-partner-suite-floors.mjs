#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CRITICAL_SUITES, isolatedSuiteEnvironment } from "./partner-suite-env-matrix.mjs";

const OUTPUT = resolve("scripts/ci/partner-suite-floors.json");

export function parseVitestList(output, files) {
  const floors = Object.fromEntries(files.map((file) => [file, 0]));
  for (const line of output.split(/\r?\n/)) {
    const normalized = line.replace(/\\/g, "/");
    const file = files.find((candidate) => normalized.startsWith(`${candidate} > `));
    if (file) floors[file] += 1;
  }
  return floors;
}

function runCli() {
  if (!process.argv.includes("--write")) {
    console.error("usage: update-partner-suite-floors.mjs --write (owner-reviewed baseline update)");
    process.exitCode = 1;
    return;
  }
  const files = CRITICAL_SUITES.map((suite) => suite.file);
  const floors = {};
  for (const suite of CRITICAL_SUITES) {
    const result = spawnSync("npx", ["--no-install", "vitest", "list", suite.file], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: isolatedSuiteEnvironment({ ...process.env, CI: "true" }, suite),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.status !== 0 || result.error) {
      console.error(`${suite.file}: ${result.error?.message ?? result.stderr ?? "vitest list failed"}`);
      process.exitCode = 1;
      return;
    }
    floors[suite.file] = parseVitestList(result.stdout, [suite.file])[suite.file];
  }
  const missing = Object.entries(floors).filter(([, count]) => count === 0);
  if (missing.length) {
    console.error(`refusing zero-test Partner floor(s): ${missing.map(([file]) => file).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const payload = {
    schemaVersion: 1,
    source: "npx --no-install vitest list over the exact 70-suite Partner critical matrix",
    suites: floors,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  const total = Object.values(floors).reduce((sum, count) => sum + count, 0);
  console.log(`Partner suite floors written: ${files.length} suites / ${total} tests`);
}

runCli();
