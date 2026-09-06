#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const IGNORE = new Set(["node_modules", "dist", "coverage", ".git"]);
export const MIGRATION_FILE_RE = /^(\d{4,})_.+\.sql$/;
const SQL_NAME = /\b(?:\d{4,}_[A-Za-z0-9_.-]+|add-[A-Za-z0-9_.-]+)\.sql\b/g;
function portable(value) {
  return value.split(sep).join("/");
}
function walk(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [portable(path)];
  const files = [];
  for (const name of readdirSync(absolute).sort()) {
    if (IGNORE.has(name)) continue;
    const child = join(path, name);
    if (statSync(join(root, child)).isDirectory()) files.push(...walk(root, child));
    else files.push(portable(child));
  }
  return files;
}
function sqlFiles(root, directory) {
  return new Set(readdirSync(join(root, directory)).filter((name) => name.endsWith(".sql")));
}

/** Source inventory classification only; actual image/runner proof remains a separate CI gate. */
export function shipsVaultQuestMigrations(root) {
  const file = join(root, "Dockerfile");
  if (!existsSync(file)) return false;
  let production = false;
  let copied = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^FROM\s/i.test(line)) {
      production = /\sAS\sproduction$/i.test(line);
      copied = false;
    } else if (
      production &&
      line === "COPY --from=production-dependencies /app/migrations-vq/[0-9][0-9][0-9][0-9]*_*.sql ./migrations-vq/"
    ) {
      copied = true;
    }
  }
  return production && copied;
}

export function buildMigrationReferenceReport(root, policy) {
  const main = sqlFiles(root, "migrations");
  const vq = sqlFiles(root, "migrations-vq");
  const shippedVq = new Set(
    shipsVaultQuestMigrations(root) ? [...vq].filter((name) => MIGRATION_FILE_RE.test(name)) : []
  );
  const shippedMain = new Set([...main].filter((name) => MIGRATION_FILE_RE.test(name)));
  const references = new Map();
  for (const file of [...walk(root, "tests"), ...walk(root, "scripts")].filter((name) =>
    SOURCE_EXTENSIONS.has(extname(name))
  )) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(SQL_NAME)) {
      const name = match[0];
      if (!references.has(name)) references.set(name, []);
      references.get(name).push(file);
    }
  }
  const classifications = [],
    violations = [];
  for (const [name, files] of [...references].sort(([a], [b]) => a.localeCompare(b))) {
    let disposition = null;
    if (shippedMain.has(name)) disposition = "shipped-main";
    else if (shippedVq.has(name)) disposition = "shipped-vault-quest";
    else if (vq.has(name)) disposition = policy.vqDirectoryDisposition;
    else if (Object.hasOwn(policy.legacyForwardFixtures, name)) {
      disposition = "legacy-forward-fixture-only";
      if (!main.has(name)) violations.push({ code: "MISSING_LEGACY_FIXTURE", name });
    } else if (Object.hasOwn(policy.legacyOperatorReferences, name)) {
      disposition = "legacy-operator-unshipped";
      if (!main.has(name)) violations.push({ code: "MISSING_LEGACY_OPERATOR_SCRIPT", name });
    } else if (Object.hasOwn(policy.syntheticReferences, name)) disposition = "synthetic-test-reference";
    else if (Object.hasOwn(policy.historicalUnshippedReferences, name)) disposition = "historical-unshipped";
    else violations.push({ code: "UNCLASSIFIED_MIGRATION_REFERENCE", name, files: [...new Set(files)].sort() });
    if (disposition) classifications.push({ name, disposition, files: [...new Set(files)].sort() });
  }
  for (const category of [
    "legacyForwardFixtures",
    "legacyOperatorReferences",
    "syntheticReferences",
    "historicalUnshippedReferences",
  ]) {
    for (const name of Object.keys(policy[category]))
      if (!references.has(name)) violations.push({ code: "STALE_MIGRATION_CLASSIFICATION", name, category });
  }
  return {
    schemaVersion: 1,
    inventory: {
      shippedMain: shippedMain.size,
      shippedVaultQuest: shippedVq.size,
      vqUnshippedOwnerDecision: vq.size - shippedVq.size,
      classifiedReferences: classifications.length,
    },
    classifications,
    violations: violations.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code)),
  };
}

function runCli() {
  const root = resolve(process.cwd());
  const policy = JSON.parse(readFileSync(join(root, "scripts/ci/migration-reference-policy.json"), "utf8"));
  const report = buildMigrationReferenceReport(root, policy);
  if (report.violations.length) {
    console.error(JSON.stringify(report.violations, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    `migration references classified: ${report.inventory.classifiedReferences}; ` +
      `shipped-main=${report.inventory.shippedMain}, shipped-VQ=${report.inventory.shippedVaultQuest}, ` +
      `VQ-unshipped=${report.inventory.vqUnshippedOwnerDecision}`
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
