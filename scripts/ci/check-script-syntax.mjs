#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function trackedJavaScriptFiles() {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "scripts/*.mjs",
      "scripts/*.cjs",
      "scripts/*.js",
      "scripts/**/*.mjs",
      "scripts/**/*.cjs",
      "scripts/**/*.js",
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))].sort();
}
export function validateScriptSyntaxInventory(files, baseline) {
  const filesSha256 = createHash("sha256").update(files.join("\n")).digest("hex");
  const ok =
    baseline.schemaVersion === 1 &&
    files.length > 0 &&
    files.length === baseline.fileCount &&
    filesSha256 === baseline.filesSha256 &&
    JSON.stringify(files) === JSON.stringify(baseline.files);
  return { ok, filesSha256 };
}

function runCli() {
  const files = trackedJavaScriptFiles();
  const baselinePath = "scripts/ci/script-syntax-baseline.json";
  const filesSha256 = createHash("sha256").update(files.join("\n")).digest("hex");
  if (process.argv.includes("--write")) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ schemaVersion: 1, fileCount: files.length, filesSha256, files }, null, 2)}\n`
    );
    console.log(`script syntax baseline written: ${files.length} JavaScript modules`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const inventory = validateScriptSyntaxInventory(files, baseline);
  if (!inventory.ok) {
    console.error(
      `script syntax inventory drifted: expected ${baseline.fileCount}/${baseline.filesSha256}, ` +
        `observed ${files.length}/${inventory.filesSha256}`
    );
    process.exit(1);
  }
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) failures.push(`${file}: ${result.stderr || result.stdout}`);
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`script syntax check passed: ${files.length} JavaScript modules`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
