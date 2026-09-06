#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIAGNOSTIC = /^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/;

export function parseDiagnostics(output) {
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(DIAGNOSTIC);
    if (!match) continue;
    const fingerprint = `${match[1].replace(/\\/g, "/")}|${match[2]}|${match[3].trim()}`;
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([fingerprint, count]) => ({ fingerprint, count }));
}

export function compareDiagnosticBaseline(baseline, observed) {
  const allowed = new Map(baseline.fingerprints.map((item) => [item.fingerprint, item.count]));
  const additions = observed.filter((item) => item.count > (allowed.get(item.fingerprint) ?? 0));
  return { ok: additions.length === 0, additions };
}

const STRICT_OPTIONS = [
  "strict",
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateTypecheckConfiguration(rootConfig, childConfig, kind) {
  const errors = [];
  if (rootConfig.compilerOptions?.strict !== true) errors.push("root strict must be true");
  if (childConfig.compilerOptions?.noCheck === true) errors.push(`${kind} noCheck may not be enabled`);
  for (const option of STRICT_OPTIONS) {
    if (childConfig.compilerOptions?.[option] === false) errors.push(`${kind} may not disable ${option}`);
  }
  const required =
    kind === "tests"
      ? ["tests/**/*.ts", "tests/**/*.tsx"]
      : kind === "scripts"
        ? ["script/**/*.ts", "scripts/**/*.ts"]
        : ["client/src/**/*.ts", "client/src/**/*.tsx", "server/**/*.ts", "shared/**/*.ts"];
  for (const pattern of required)
    if (!childConfig.include?.includes(pattern)) errors.push(`${kind} include missing ${pattern}`);
  const coveredRoots =
    kind === "tests" ? ["tests"] : kind === "scripts" ? ["script", "scripts"] : ["client/src", "server", "shared"];
  for (const excluded of childConfig.exclude ?? []) {
    if (coveredRoots.some((root) => [root, `${root}/*`, `${root}/**`, `${root}/**/*`].includes(excluded))) {
      errors.push(`${kind} exclude may not remove covered root: ${excluded}`);
    }
  }
  return errors;
}

function trackedEntryFiles(kind) {
  const patterns =
    kind === "tests"
      ? ["tests/*.ts", "tests/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]
      : kind === "scripts"
        ? ["script/*.ts", "scripts/*.ts", "script/**/*.ts", "scripts/**/*.ts"]
        : [
            "client/src/*.ts",
            "client/src/*.tsx",
            "client/src/**/*.ts",
            "client/src/**/*.tsx",
            "server/*.ts",
            "server/**/*.ts",
            "shared/*.ts",
            "shared/**/*.ts",
          ];
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...patterns], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))].sort();
}

function buildContract(kind, rootConfig, childConfig, files) {
  const noCheckFiles = files.filter((file) => /(?:^|\n)\s*\/\/\s*@ts-nocheck\b/m.test(readFileSync(file, "utf8")));
  return {
    compilerVersion: JSON.parse(readFileSync("node_modules/typescript/package.json", "utf8")).version,
    configSha256: sha256(JSON.stringify({ root: rootConfig.compilerOptions, child: childConfig })),
    trackedFileCount: files.length,
    trackedFilesSha256: sha256(files.join("\n")),
    noCheckFileCount: noCheckFiles.length,
    noCheckFiles,
    noCheckFilesSha256: sha256(noCheckFiles.join("\n")),
  };
}

export function compareTypecheckContract(baseline, observed) {
  if (!baseline) return { ok: false, changes: ["missing baseline contract"] };
  const changes = [];
  for (const key of ["compilerVersion", "configSha256", "trackedFileCount", "trackedFilesSha256"]) {
    if (baseline[key] !== observed[key]) changes.push(`${key}: ${String(baseline[key])} -> ${String(observed[key])}`);
  }
  const allowedNoCheck = new Set(baseline.noCheckFiles ?? []);
  if (observed.noCheckFileCount !== (observed.noCheckFiles ?? []).length) {
    changes.push("@ts-nocheck inventory count is inconsistent");
  }
  const addedNoCheck = (observed.noCheckFiles ?? []).filter((file) => !allowedNoCheck.has(file));
  if (addedNoCheck.length) changes.push(`@ts-nocheck added outside baseline: ${addedNoCheck.join(", ")}`);
  return { ok: changes.length === 0, changes };
}

function runCli() {
  const kind = process.argv.find((argument) => ["tests", "scripts", "architecture"].includes(argument));
  if (!kind) {
    console.error("usage: run-typecheck-ratchet.mjs (tests|scripts|architecture) [--write]");
    process.exitCode = 1;
    return;
  }
  const config = `tsconfig.${kind}.json`;
  const baselinePath = resolve(`scripts/ci/typecheck-baselines/${kind}.json`);
  const rootConfig = JSON.parse(readFileSync("tsconfig.json", "utf8"));
  const childConfig = JSON.parse(readFileSync(config, "utf8"));
  const configErrors = validateTypecheckConfiguration(rootConfig, childConfig, kind);
  if (configErrors.length) {
    console.error(configErrors.join("\n"));
    process.exitCode = 1;
    return;
  }
  const files = trackedEntryFiles(kind);
  if (files.length === 0) {
    console.error(`${kind} typecheck resolved zero tracked entry files`);
    process.exitCode = 1;
    return;
  }
  const contract = buildContract(kind, rootConfig, childConfig, files);
  const generatedBase = resolve(".engineering/tmp");
  mkdirSync(generatedBase, { recursive: true });
  const generatedRoot = mkdtempSync(join(generatedBase, `${kind}-tsc-`));
  const generatedConfig = join(generatedRoot, "tsconfig.json");
  writeFileSync(
    generatedConfig,
    `${JSON.stringify({ extends: resolve(config), files: files.map((file) => resolve(file)), include: [], exclude: [] })}\n`
  );
  const result = spawnSync("npx", ["--no-install", "tsc", "-p", generatedConfig, "--noEmit", "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  rmSync(generatedRoot, { recursive: true, force: true });
  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
    return;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const fingerprints = parseDiagnostics(output);
  const diagnosticCount = fingerprints.reduce((sum, item) => sum + item.count, 0);
  if (result.status !== 0 && diagnosticCount === 0) {
    console.error(`typecheck failed without parseable diagnostics (exit ${result.status})\n${output}`);
    process.exitCode = 1;
    return;
  }
  const observed = { schemaVersion: 2, config, contract, diagnosticCount, fingerprints };
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(observed, null, 2)}\n`);
    console.log(`${kind} typecheck baseline written: ${diagnosticCount} diagnostics`);
    return;
  }
  if (!existsSync(baselinePath)) {
    console.error(`missing typecheck baseline: ${baselinePath}`);
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const contractComparison = compareTypecheckContract(baseline.contract, contract);
  if (!contractComparison.ok) {
    console.error(`${kind} typecheck contract drifted:\n${contractComparison.changes.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  const comparison = compareDiagnosticBaseline(baseline, fingerprints);
  if (!comparison.ok) {
    console.error(`${kind} typecheck introduced ${comparison.additions.length} new diagnostic fingerprint(s):`);
    for (const item of comparison.additions) console.error(`  ${item.count}x ${item.fingerprint}`);
    process.exitCode = 1;
    return;
  }
  const removed = baseline.diagnosticCount - diagnosticCount;
  console.log(
    `${kind} typecheck ratchet passed: ${diagnosticCount} existing diagnostics (${removed >= 0 ? removed : 0} removed from baseline)`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
