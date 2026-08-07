#!/usr/bin/env node
/**
 * Derive one matrix's environment FROM .github/workflows/ci.yml, rather than hand-copying it.
 *
 * WHY DERIVE INSTEAD OF TRANSCRIBE. The CI `check` job env block is ~90 variables, and the entire
 * value of this exercise depends on Matrix A and Matrix B running the SAME environment as CI. A
 * hand-written copy drifts silently the moment ci.yml changes, and a drifted copy that still goes
 * green proves nothing. Parsing the workflow means the harness cannot quietly diverge: if a suite
 * gains an env gate, both matrices pick it up.
 *
 * REWRITE RULES (only coordinates change; every variable NAME and every non-URL value is verbatim)
 *   • any postgres URL on port 55433  -> this matrix's pg17 port, and its database gets the prefix
 *   • any postgres URL on port 55432  -> port UNCHANGED (27 suites hard-refuse anything else) and
 *                                        database UNCHANGED, credentials swapped to the matrix admin
 *   • superuser credentials postgres:postgres -> the matrix's own admin login role
 *   • non-superuser logins (partner_app_test_*, partner_connector_*) keep their username and
 *     password: the SUITES create those roles by exactly those names
 *   • the MinIO endpoint port -> this matrix's MinIO port
 *
 * Emits JSON on stdout: { env: {...}, pg17Databases: [...], pg16Databases: [...], runtimeLogins: [...] }
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { matrixFor, assertDisposableCoordinates } from "./matrix-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const CI_PATH = resolve(repoRoot, ".github/workflows/ci.yml");

/**
 * Read the `check` job's `env:` mapping.
 *
 * Deliberately a small indentation-aware scan rather than a YAML dependency: the block is flat
 * `KEY: value` scalars with comments, adding a parser dependency to an assurance harness would be
 * a protected action (CLAUDE.md rule 5), and a wrong parse fails loudly below rather than silently.
 */
export function readCiEnv(path = CI_PATH) {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((l) => /^ {4}env:\s*$/.test(l));
  if (start < 0) throw new Error("could not find the check job's env: block in ci.yml");
  const env = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    // The block ends at the next key at the job's own indentation (e.g. `    services:`).
    if (/^ {4}\S/.test(line)) break;
    const m = line.match(/^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (!m) {
      if (/^ {6}\S/.test(line)) throw new Error(`unparsed line in ci env block: ${JSON.stringify(line)}`);
      continue;
    }
    env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  if (Object.keys(env).length < 50) throw new Error(`ci env parse looks wrong: only ${Object.keys(env).length} vars`);
  return env;
}

const SUPERUSER_RE = /^postgres:postgres$/;

export function deriveEnv(label, ciEnv = readCiEnv()) {
  const m = matrixFor(label);
  assertDisposableCoordinates(m);

  const pg17Databases = new Set();
  const pg16Databases = new Set();
  const runtimeLogins = new Map(); // "user" -> { database, password }
  const out = {};

  for (const [key, rawValue] of Object.entries(ciEnv)) {
    let value = rawValue;

    if (/^postgres(ql)?:\/\//.test(value)) {
      const u = new URL(value);
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
        throw new Error(`${key} is not loopback in ci.yml: refusing to derive from it`);
      }
      const credential = `${u.username}:${u.password}`;
      const isSuperuser = SUPERUSER_RE.test(credential);
      const originalDb = u.pathname.slice(1);

      if (u.port === "55433") {
        u.port = String(m.pg17Port);
        // The maintenance database must stay `postgres` — several consumers rewrite that exact
        // suffix, and prefixing it would silently point them at a database that does not exist.
        const db = originalDb === "postgres" ? "postgres" : `${m.dbPrefix}${originalDb}`;
        u.pathname = `/${db}`;
        if (db !== "postgres") pg17Databases.add(db);
        if (!isSuperuser) runtimeLogins.set(u.username, { database: db, password: u.password });
      } else if (u.port === "55432") {
        // PINNED by 27 suites (host+port+database). Only the credential may change.
        if (originalDb !== "mintvault_vq_phase10_local") {
          throw new Error(`unexpected pg16 database ${originalDb} on port 55432`);
        }
        pg16Databases.add(originalDb);
      } else {
        throw new Error(`${key} uses unexpected port ${u.port}`);
      }

      if (isSuperuser) {
        u.username = m.adminRole;
        u.password = m.adminPassword;
      }
      value = u.toString();
    } else if (/^https?:\/\/127\.0\.0\.1:9010/.test(value)) {
      value = value.replace("127.0.0.1:9010", `127.0.0.1:${m.minioPort}`);
    }

    out[key] = value;
  }

  // The suites are DB-backed; without these 17 files silently skip (see project memory).
  out.LC_ALL = "C";
  out.LANG = "C";
  // Point the matrix runner's own CLUSTERS table at this matrix.
  out.PARTNER_MATRIX_PG16_PORT = String(m.pg16Port);
  out.PARTNER_MATRIX_PG16_USER = m.adminRole;
  out.PARTNER_MATRIX_PG16_PASSWORD = m.adminPassword;
  out.PARTNER_MATRIX_PG17_PORT = String(m.pg17Port);
  out.PARTNER_MATRIX_PG17_USER = m.adminRole;
  out.PARTNER_MATRIX_PG17_PASSWORD = m.adminPassword;
  out.PARTNER_MATRIX_DB_PREFIX = m.dbPrefix;

  return {
    matrix: m,
    env: out,
    pg17Databases: [...pg17Databases].sort(),
    pg16Databases: [...pg16Databases].sort(),
    runtimeLogins: [...runtimeLogins.entries()].map(([user, v]) => ({ user, ...v })).sort((a, b) => a.user.localeCompare(b.user)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const label = process.argv[2];
  const mode = process.argv[3] ?? "json";
  const derived = deriveEnv(label);
  if (mode === "shell") {
    for (const [k, v] of Object.entries(derived.env)) {
      process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(derived, null, 2) + "\n");
  }
}
