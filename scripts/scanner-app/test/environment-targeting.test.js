/*
 * THE SCANNER MUST NEVER GUESS WHICH MINTVAULT IT BELONGS TO.
 *
 * Pins the 2026-08-17 incident. A staging station was relaunched without MINTVAULT_API_BASE; the
 * API target fell through a four-branch chain to a hardcoded production hostname, and the Mac
 * authenticated against mintvaultuk.com holding credentials that exist only on staging. Every
 * request was refused, and it surfaced to the operator as "sign-in failed" — a password problem
 * that was not a password problem.
 *
 * The property under test is not "the fallback picks the right host". It is that THERE IS NO
 * FALLBACK: an unconfigured station resolves to unconfigured and refuses, because "I don't know"
 * and "production" are different answers.
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGING_URL = "https://mintvault-v2.fly.dev";
const PRODUCTION_URL = "https://mintvaultuk.com";

let sandbox;
let environment;

function loadEnvironmentModule() {
  // The module binds its state directory at require time from MINTVAULT_SCANS_DIR.
  delete require.cache[require.resolve("../lib/environment")];
  return require("../lib/environment");
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mv-scanner-env-"));
  process.env.MINTVAULT_SCANS_DIR = sandbox;
  delete process.env.MINTVAULT_ENV;
  delete process.env.MINTVAULT_API_BASE;
  environment = loadEnvironmentModule();
});

afterEach(() => {
  delete process.env.MINTVAULT_SCANS_DIR;
  delete process.env.MINTVAULT_ENV;
  delete process.env.MINTVAULT_API_BASE;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("declared environment resolves to its own canonical URL", () => {
  test("staging resolves to the staging URL", () => {
    environment.persistEnvironment("staging");
    const resolved = environment.resolveEnvironment();
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.environment, "staging");
    assert.strictEqual(resolved.label, "STAGING");
    assert.strictEqual(resolved.apiBase, STAGING_URL);
  });

  test("production resolves to the production URL", () => {
    environment.persistEnvironment("production");
    const resolved = environment.resolveEnvironment();
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.environment, "production");
    assert.strictEqual(resolved.label, "PRODUCTION");
    assert.strictEqual(resolved.apiBase, PRODUCTION_URL);
  });
});

describe("a missing declaration fails safely — THE INCIDENT", () => {
  test("an unconfigured station does not resolve, and never to production", () => {
    const resolved = environment.resolveEnvironment();
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.code, "ENVIRONMENT_UNCONFIGURED");
    assert.strictEqual(resolved.apiBase, null);
    assert.notStrictEqual(resolved.apiBase, PRODUCTION_URL);
  });

  test("requireApiBase THROWS rather than returning a default host", () => {
    assert.throws(() => environment.requireApiBase(), /has not been told which MintVault/i);
  });

  test("a legacy MINTVAULT_INGEST_URL naming production cannot resolve the target", () => {
    /*
     * The exact shape of the incident: ~/.mintvault-scanner.env held
     * MINTVAULT_INGEST_URL=https://mintvaultuk.com/api/admin/scan-ingest from June. That file must
     * no longer be able to decide which MintVault a station talks to.
     */
    const resolved = environment.resolveEnvironment({
      env: { MINTVAULT_INGEST_URL: `${PRODUCTION_URL}/api/admin/scan-ingest` },
    });
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.code, "ENVIRONMENT_UNCONFIGURED");
  });
});

describe("environment and URL must agree — refused in BOTH directions", () => {
  test("STAGING declared + PRODUCTION url is refused", () => {
    environment.persistEnvironment("staging");
    const resolved = environment.resolveEnvironment({ env: { MINTVAULT_API_BASE: PRODUCTION_URL } });
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.code, "ENVIRONMENT_URL_MISMATCH");
    assert.strictEqual(resolved.apiBase, null);
    assert.match(resolved.message, /STAGING station must never talk to PRODUCTION/i);
  });

  test("PRODUCTION declared + STAGING url is refused", () => {
    environment.persistEnvironment("production");
    const resolved = environment.resolveEnvironment({ env: { MINTVAULT_API_BASE: STAGING_URL } });
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.code, "ENVIRONMENT_URL_MISMATCH");
    assert.match(resolved.message, /PRODUCTION station must never talk to STAGING/i);
  });

  test("a matching override is allowed", () => {
    environment.persistEnvironment("staging");
    const resolved = environment.resolveEnvironment({ env: { MINTVAULT_API_BASE: STAGING_URL } });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.apiBase, STAGING_URL);
  });

  test("an unrecognised host is a deliberate developer target, not drift", () => {
    environment.persistEnvironment("staging");
    const resolved = environment.resolveEnvironment({ env: { MINTVAULT_API_BASE: "http://localhost:5000" } });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.apiBase, "http://localhost:5000");
  });
});

describe("the declaration survives restart", () => {
  test("a persisted environment is read back by a fresh module load", () => {
    environment.persistEnvironment("staging");

    // Simulate a process restart: drop the module, re-require it, read nothing but disk.
    const reloaded = loadEnvironmentModule();
    const resolved = reloaded.resolveEnvironment();

    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.environment, "staging");
    assert.strictEqual(resolved.apiBase, STAGING_URL);
  });

  test("persistence is atomic — a truncated file cannot strand a station silently", () => {
    environment.persistEnvironment("staging");
    // A half-written file reads back as unconfigured, which REFUSES rather than defaulting.
    fs.writeFileSync(environment.ENVIRONMENT_FILE, "{ \"environ");
    const resolved = loadEnvironmentModule().resolveEnvironment();
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.code, "ENVIRONMENT_UNCONFIGURED");
    assert.notStrictEqual(resolved.apiBase, PRODUCTION_URL);
  });

  test("an explicit MINTVAULT_ENV outranks the persisted file", () => {
    environment.persistEnvironment("production");
    const resolved = environment.resolveEnvironment({ env: { MINTVAULT_ENV: "staging" } });
    assert.strictEqual(resolved.environment, "staging");
    assert.strictEqual(resolved.apiBase, STAGING_URL);
  });

  test("an unknown environment name is refused, not coerced", () => {
    assert.throws(() => environment.persistEnvironment("prodution"), /Unknown MintVault environment/i);
    const resolved = environment.resolveEnvironment({ env: { MINTVAULT_ENV: "prodution" } });
    assert.strictEqual(resolved.ok, false);
  });
});

describe("the two canonical deployments are the only hosts this app knows", () => {
  test("staging and production URLs are exactly as expected", () => {
    assert.strictEqual(environment.ENVIRONMENTS.staging.apiBase, STAGING_URL);
    assert.strictEqual(environment.ENVIRONMENTS.production.apiBase, PRODUCTION_URL);
  });

  test("no hardcoded production hostname remains in the resolution path", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "server-client.js"), "utf8");
    /*
     * The old chain ended `|| "https://mintvaultuk.com"`. Assert that no such default-assignment
     * survives. The hostname may still appear in prose; it must not appear as a fallback value.
     */
    assert.doesNotMatch(
      source,
      /\|\|\s*["']https:\/\/mintvaultuk\.com["']/,
      "server-client.js still defaults to the production host when configuration is absent"
    );
  });
});
