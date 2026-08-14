const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const pathsModule = require.resolve("../lib/runtime-paths");

function withOverride(t) {
  const prior = process.env.MINTVAULT_SCANS_DIR;
  const priorHome = process.env.HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-runtime-paths-"));
  process.env.MINTVAULT_SCANS_DIR = root;
  process.env.HOME = path.join(root, "hostile-home");
  delete require.cache[pathsModule];
  t.after(() => {
    if (prior === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = prior;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    delete require.cache[pathsModule];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("unpackaged test runtime may use one explicit isolated storage root", (t) => {
  const root = withOverride(t);
  const runtimePaths = require("../lib/runtime-paths");
  const current = runtimePaths.configureRuntime({ isPackaged: false });
  assert.equal(current.scansBase, root);
  assert.equal(current.appSupport, path.join(root, "app-state"));
});

test("packaged runtime ignores mutable storage roots for identity, operations, state, queue, logs and profile", (t) => {
  const attackerRoot = withOverride(t);
  const priorApiBase = process.env.MINTVAULT_API_BASE;
  const priorLegacyToken = process.env.SCANNER_API_TOKEN;
  const priorAllowLegacy = process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN;
  process.env.MINTVAULT_API_BASE = "https://attacker.invalid";
  process.env.SCANNER_API_TOKEN = "must-not-load";
  process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN = "1";
  t.after(() => {
    if (priorApiBase === undefined) delete process.env.MINTVAULT_API_BASE; else process.env.MINTVAULT_API_BASE = priorApiBase;
    if (priorLegacyToken === undefined) delete process.env.SCANNER_API_TOKEN; else process.env.SCANNER_API_TOKEN = priorLegacyToken;
    if (priorAllowLegacy === undefined) delete process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN; else process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN = priorAllowLegacy;
  });
  const runtimePaths = require("../lib/runtime-paths");
  const current = runtimePaths.configureRuntime({ isPackaged: true });
  const nativeHome = os.userInfo().homedir;
  const expectedScans = path.join(nativeHome, "mintvault-scans");
  const expectedSupport = path.join(nativeHome, "Library", "Application Support", "MintVaultScanner");
  assert.notEqual(os.homedir(), nativeHome, "test must prove HOME differs from the native account home");
  assert.equal(current.scansBase, expectedScans);
  assert.equal(current.appSupport, expectedSupport);
  assert.notEqual(current.scansBase, attackerRoot);

  for (const relative of ["../lib/state", "../lib/semantic-operations", "../lib/station-identity", "../lib/watcher", "../lib/locked-scanner-profile"]) {
    delete require.cache[require.resolve(relative)];
  }
  const state = require("../lib/state");
  const operations = require("../lib/semantic-operations");
  const identity = require("../lib/station-identity");
  const watcher = require("../lib/watcher");
  const profile = require("../lib/locked-scanner-profile");
  delete require.cache[require.resolve("../lib/server-client")];
  const server = require("../lib/server-client");
  profile.configureRuntime({ isPackaged: true });

  assert.equal(state.STATE_PATH, path.join(expectedSupport, "state.json"));
  assert.equal(operations._private.DEFAULT_STORE, path.join(expectedSupport, "semantic-operations-v1.json"));
  assert.equal(identity._private.supportPath, expectedSupport);
  assert.equal(identity._private.operatorSessionPath, path.join(expectedSupport, "operator-session.enc.json"));
  assert.equal(watcher.INBOX, path.join(expectedScans, "inbox"));
  assert.equal(watcher.FAILED, path.join(expectedScans, "failed"));
  assert.equal(profile._private.defaultProfilePath(), path.join(expectedSupport, "locked-scanner-profile.v1.json"));
  assert.equal(server.API_BASE, "https://mintvaultuk.com");
  assert.deepEqual(server._private.legacyAuthHeaders(), {});

  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(main.indexOf("runtimePaths.configureRuntime({ isPackaged: app.isPackaged })") < main.indexOf('require("./lib/state")'));
  assert.match(main, /const SCANS_BASE\s+= runtimePaths\.scansBase\(\)/);
});
