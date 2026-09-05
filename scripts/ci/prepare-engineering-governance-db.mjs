#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CRITICAL_SUITES, CLUSTERS, assertDisposable, envForSuite, urlFor } from "./partner-suite-env-matrix.mjs";

const sharedTestUrl = urlFor("pg16", "mintvault_vq_phase10_local");
const projectControlAdminUrl = urlFor("pg17", "postgres");
const correctionTestUrl = urlFor("pg17", "mintvault_correction_test");

const env = {};
const globalAccountingKeys = new Set([
  "MINTVAULT_DATABASE_URL",
  "PARTNER_ADMIN_DATABASE_URL",
  "PARTNER_DATABASE_URL",
  "PARTNER_CONNECTOR_DATABASE_URL",
]);

for (const suite of CRITICAL_SUITES) {
  const suiteEnv = envForSuite(suite);
  for (const key of globalAccountingKeys) delete suiteEnv[key];
  Object.assign(env, suiteEnv);
}

Object.assign(env, {
  TEST_DATABASE_URL: sharedTestUrl,
  MINTVAULT_DATABASE_URL: sharedTestUrl,
  PROJECT_CONTROL_TEST_ADMIN_URL: projectControlAdminUrl,
  MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_URL: projectControlAdminUrl,
  CORRECTION_TEST_DATABASE_URL: correctionTestUrl,
});

for (const [key, value] of Object.entries(env)) {
  if (typeof value !== "string") continue;
  assertDisposable(value, key);
}

if (process.env.GITHUB_ENV) {
  const lines = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  appendFileSync(process.env.GITHUB_ENV, `${lines}\n`);
}
Object.assign(process.env, env);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout ?? "";
}

function psql(url, sql, options = {}) {
  return run("psql", [url, "-v", "ON_ERROR_STOP=1", options.tuples ? "-tAc" : "-c", sql], {
    capture: options.capture,
  }).trim();
}

function quoteIdent(identifier) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function ensureDatabase(cluster, database) {
  const maintenance = urlFor(cluster, "postgres");
  assertDisposable(maintenance, `${cluster} maintenance`);
  const present = psql(maintenance, `SELECT 1 FROM pg_database WHERE datname = '${database}'`, {
    capture: true,
    tuples: true,
  });
  if (present !== "1") psql(maintenance, `CREATE DATABASE ${quoteIdent(database)}`);
  console.log(`[ci-db] ${cluster} database ready: ${database}`);
}

function seedCoreStubs(suite) {
  const url = urlFor(suite.cluster, suite.database);
  psql(
    url,
    "DO $$ BEGIN CREATE ROLE pn_migrator LOGIN PASSWORD 'realistic-migrator-pw' NOSUPERUSER CREATEROLE NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END$$;"
  );
  psql(
    url,
    "CREATE TABLE IF NOT EXISTS audit_log (id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamp NOT NULL DEFAULT now())"
  );
  psql(url, "ALTER TABLE audit_log OWNER TO pn_migrator");
  psql(url, "CREATE TABLE IF NOT EXISTS certificates (id serial PRIMARY KEY, cert_id text, secret text)");
  psql(url, "ALTER TABLE certificates OWNER TO pn_migrator");
}

for (const [name, cluster] of Object.entries(CLUSTERS)) {
  const maintenance = urlFor(name, "postgres");
  assertDisposable(maintenance, `${name} maintenance`);
  const version = psql(maintenance, "SHOW server_version_num", { capture: true, tuples: true });
  const major = Number(version);
  if (name === "pg17" && major < 170000) throw new Error(`pg17 service must be PostgreSQL 17+, got ${version}`);
  if (name === "pg16" && major < 160000) throw new Error(`pg16 service must be PostgreSQL 16+, got ${version}`);
  console.log(`[ci-db] ${name} reachable at ${cluster.host}:${cluster.port} server_version_num=${version}`);
}

ensureDatabase("pg16", "mintvault_vq_phase10_local");
psql(sharedTestUrl, "CREATE EXTENSION IF NOT EXISTS vector");
run("npx", ["drizzle-kit", "push", "--force"]);
run(process.execPath, ["--import", "tsx", "scripts/ci/prepare-vq-test-db.mjs"]);
run(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "scripts/db/migrate.ts", "--estate", "vault-quest", "--apply"],
  {
    env: { ...process.env, MINTVAULT_MIGRATION_DATABASE_URL: sharedTestUrl },
  }
);
const featureConstraint = psql(
  sharedTestUrl,
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'vq_feature_flags_feature_check'",
  { capture: true, tuples: true }
);
for (const required of ["gen_action_pose", "auto_paid_retry"]) {
  if (!featureConstraint.includes(required)) throw new Error(`vq_feature_flags_feature_check missing ${required}`);
}

const requiredDatabases = new Map();
for (const suite of CRITICAL_SUITES) {
  if (!suite.cluster || !suite.database) continue;
  const databases = requiredDatabases.get(suite.cluster) ?? new Set();
  databases.add(suite.database);
  requiredDatabases.set(suite.cluster, databases);
}
requiredDatabases.get("pg17")?.add("mintvault_correction_test");

for (const [cluster, databases] of requiredDatabases) {
  for (const database of databases) ensureDatabase(cluster, database);
}
for (const suite of CRITICAL_SUITES) {
  if (suite.seedCoreStubs) seedCoreStubs(suite);
}

const createdb = psql(projectControlAdminUrl, "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user", {
  capture: true,
  tuples: true,
});
if (createdb !== "t") throw new Error("PROJECT_CONTROL_TEST_ADMIN_URL must use a CREATEDB-capable disposable role");

const rlsBypass = psql(
  env.PARTNER_RLS_DB,
  "SELECT coalesce((SELECT rolbypassrls FROM pg_roles WHERE rolname = 'partner_runtime'), false)",
  { capture: true, tuples: true }
);
if (rlsBypass !== "f") {
  throw new Error(`partner_runtime must be NOBYPASSRLS before RLS tests run, got rolbypassrls=${rlsBypass}`);
}

console.log(
  `[ci-db] exported ${Object.keys(env).length} disposable environment variable(s); prepared ${[
    ...requiredDatabases.values(),
  ].reduce((count, set) => count + set.size, 1)} database(s)`
);
