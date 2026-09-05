#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTypecheckConfiguration } from "./run-typecheck-ratchet.mjs";

export const REQUIRED_PACKAGE_SCRIPTS = Object.freeze({
  "architecture:check": "node scripts/architecture/check-architecture.mjs",
  "architecture:update": "node scripts/architecture/check-architecture.mjs --write",
  "check:tests": "node scripts/ci/run-typecheck-ratchet.mjs tests",
  "check:scripts": "node scripts/ci/run-typecheck-ratchet.mjs scripts",
  "check:unreachable": "node scripts/ci/run-typecheck-ratchet.mjs architecture",
  "check:script-syntax": "node scripts/ci/check-script-syntax.mjs",
  "migration:references:check": "node scripts/ci/check-migration-references.mjs",
  "test:partner:critical": "node scripts/ci/run-partner-suite.mjs --all",
  "test:scanner:critical": "node scripts/ci/run-scanner-suite.mjs",
  "ci:topology": "node scripts/ci/verify-ci-topology.mjs",
});

function scalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

/** Parse only the workflow structure this gate owns; comments never become executable steps. */
export function parseWorkflowTopology(source) {
  const lines = source.split(/\r?\n/);
  const workflow = { name: "", jobs: {} };
  let job = null;
  let step = null;
  let inSteps = false;
  let runBlockIndent = null;
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (/^name:\s*/.test(raw)) workflow.name = scalar(raw.replace(/^name:\s*/, ""));
    const jobMatch = raw.match(/^ {2}(["']?)([A-Za-z0-9_-]+)\1:\s*$/);
    if (jobMatch) {
      job = { id: jobMatch[2], name: "", if: "", continueOnError: "", hasRunDefaults: false, steps: [] };
      workflow.jobs[job.id] = job;
      step = null;
      inSteps = false;
      continue;
    }
    if (!job) continue;
    if (/^ {4}(["']?)defaults\1:\s*(?:$|\{)/.test(raw)) job.hasRunDefaults = true;
    const jobProperty = raw.match(/^ {4}(["']?)(name|if|continue-on-error)\1:\s*(.*)$/);
    if (jobProperty && !inSteps) {
      const [, , key, value] = jobProperty;
      if (key === "continue-on-error") job.continueOnError = scalar(value);
      else job[key] = scalar(value);
    }
    if (/^ {4}(["']?)steps\1:\s*$/.test(raw)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;
    const stepMatch = raw.match(/^ {6}-\s+([^:]+):\s*(.*)$/);
    if (stepMatch) {
      step = { name: "", uses: "", run: "", if: "", continueOnError: "", shell: "", with: {} };
      job.steps.push(step);
      runBlockIndent = null;
      const [, rawKey, value] = stepMatch;
      const key = scalar(rawKey);
      if (["name", "uses", "run", "if", "continue-on-error", "shell"].includes(key)) {
        if (key === "continue-on-error") step.continueOnError = scalar(value);
        else step[key] = scalar(value);
      }
      if (key === "run" && ["|", ">"].includes(value.trim())) {
        step.run = "";
        runBlockIndent = 8;
      }
      continue;
    }
    if (!step) continue;
    if (runBlockIndent !== null && raw.length - raw.trimStart().length > runBlockIndent) {
      step.run += `${raw.trim()}\n`;
      continue;
    }
    runBlockIndent = null;
    const property = raw.match(/^ {8}(["']?)(name|uses|run|if|continue-on-error|shell)\1:\s*(.*)$/);
    if (property) {
      const [, , key, value] = property;
      if (key === "continue-on-error") step.continueOnError = scalar(value);
      else step[key] = scalar(value);
      if (key === "run" && ["|", ">"].includes(value.trim())) {
        step.run = "";
        runBlockIndent = 8;
      }
      continue;
    }
    const withValue = raw.match(/^ {10}(["']?)([A-Za-z0-9_-]+)\1:\s*(.*)$/);
    if (withValue) step.with[withValue[2]] = scalar(withValue[3]);
  }
  return workflow;
}

function enabled(step) {
  const condition = (step.if ?? "").trim();
  const continueOnError = (step.continueOnError ?? "").trim();
  const shell = (step.shell ?? "").trim();
  return (
    condition === "" &&
    (continueOnError === "" || /^(?:false|\$\{\{\s*false\s*\}\})$/i.test(continueOnError)) &&
    shell === ""
  );
}

function stripShellComment(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "'" && !double) single = !single;
    else if (line[i] === '"' && !single) double = !double;
    else if (line[i] === "#" && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function executes(step, command) {
  return enabled(step) && stripShellComment(step.run).trim() === command;
}

export function validateCiTopology({
  workflow,
  packageJson,
  rootConfig,
  testsConfig,
  scriptsConfig,
  architectureConfig,
}) {
  const errors = [];
  if (packageJson.engines?.node !== "20.20.2") errors.push("root Node engine must be exactly 20.20.2");
  for (const [name, command] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    if (packageJson.scripts?.[name] !== command) errors.push(`package script ${name} must equal: ${command}`);
  }
  errors.push(...validateTypecheckConfiguration(rootConfig, testsConfig, "tests"));
  errors.push(...validateTypecheckConfiguration(rootConfig, scriptsConfig, "scripts"));
  errors.push(...validateTypecheckConfiguration(rootConfig, architectureConfig, "architecture"));
  if (
    testsConfig.extends !== "./tsconfig.json" ||
    scriptsConfig.extends !== "./tsconfig.json" ||
    architectureConfig.extends !== "./tsconfig.json"
  ) {
    errors.push("dedicated typecheck configs must inherit the root strict contract");
  }

  const parsed = parseWorkflowTopology(workflow);
  if (parsed.name !== "CI") errors.push("workflow name must remain CI");
  const check = parsed.jobs.check;
  if (!check) return [...errors, "workflow must retain jobs.check"];
  if (!enabled(check)) errors.push("jobs.check must be enabled and failure-blocking");
  if (check.hasRunDefaults) errors.push("jobs.check may not override run defaults");
  if (check.name !== "Lint, Type Check, Test & Build") errors.push("jobs.check display name changed");
  const steps = check.steps;
  const browserCommand =
    "node scripts/ci/run-disposable-integration.mjs --docker-context default --admin-browser-proof";
  const partnerBrowserCommand =
    "node scripts/ci/run-disposable-integration.mjs --docker-context default --partner-browser-proof";
  const requiredCommands = [
    "npm run architecture:check",
    "npm run check:tests",
    "npm run check:scripts",
    "npm run check:unreachable",
    "npm run check:script-syntax",
    "npm run migration:references:check",
    "npm run ci:topology",
    "npm run test:partner:critical",
    "npm run test:scanner:critical",
    "node scripts/ci/run-disposable-integration.mjs --docker-context default --r2-proof",
    browserCommand,
    partnerBrowserCommand,
  ];
  for (const command of requiredCommands) {
    if (!steps.some((step) => executes(step, command))) errors.push(`workflow does not execute ${command}`);
  }
  const node20 = steps.findIndex(
    (step) => enabled(step) && step.uses.startsWith("actions/setup-node@") && step.with["node-version"] === "20.20.2"
  );
  const rootInstall = steps.findIndex((step) => executes(step, "npm ci"));
  const build = steps.findIndex((step) => executes(step, "npm run build"));
  const node22 = steps.findIndex(
    (step) => enabled(step) && step.uses.startsWith("actions/setup-node@") && step.with["node-version"] === "22.12.0"
  );
  const scannerInstall = steps.findIndex((step) =>
    executes(step, "npm ci --prefix scripts/scanner-app --ignore-scripts")
  );
  const scanner = steps.findIndex((step) => executes(step, "npm run test:scanner:critical"));
  const browser = steps.findIndex((step) => executes(step, browserCommand));
  if (!(browser > build && browser < node22))
    errors.push("Admin browser proof must run after Build and before Node 22");
  const partnerBrowser = steps.findIndex((step) => executes(step, partnerBrowserCommand));
  if (!(partnerBrowser > build && partnerBrowser < node22))
    errors.push("Partner browser proof must run after Build and before Node 22");
  if (node20 < 0) errors.push("workflow lacks enabled exact root Node 20.20.2 setup");
  const rootCommandIndexes = requiredCommands
    .filter(
      (item) => item !== "npm run test:scanner:critical" && item !== browserCommand && item !== partnerBrowserCommand
    )
    .map((command) => ({ command, index: steps.findIndex((step) => executes(step, command)) }));
  if (!(
    node20 >= 0 &&
    rootInstall > node20 &&
    rootCommandIndexes.every(({ index }) => index > rootInstall && index < build) &&
    build > rootInstall &&
    node22 > build &&
    scannerInstall > node22 &&
    scanner > scannerInstall
  )) {
    errors.push("Scanner proof must run after the Node 20 build, on Node 22.12.0, from its nested lockfile");
    errors.push("root install, authority gates, Partner matrix, build, and Scanner phase order changed");
  }
  for (const { command, index } of rootCommandIndexes) {
    if (index >= 0 && node22 >= 0 && index > node22) errors.push(`${command} must execute in the root Node 20 phase`);
  }
  return errors;
}

function runCli() {
  const input = {
    workflow: readFileSync(".github/workflows/ci.yml", "utf8"),
    packageJson: JSON.parse(readFileSync("package.json", "utf8")),
    rootConfig: JSON.parse(readFileSync("tsconfig.json", "utf8")),
    testsConfig: JSON.parse(readFileSync("tsconfig.tests.json", "utf8")),
    scriptsConfig: JSON.parse(readFileSync("tsconfig.scripts.json", "utf8")),
    architectureConfig: JSON.parse(readFileSync("tsconfig.architecture.json", "utf8")),
  };
  const errors = validateCiTopology(input);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    "CI topology check passed: executable architecture, typecheck, migration, Partner, and Scanner gates are wired"
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
