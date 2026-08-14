const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const integrity = require("../lib/helper-integrity");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fixture(t, { packaged = false, helperTeam = "", appTeam = "", expectedTeam = "MINTVAULT1", identifier, architectures = "arm64", minos = "12.0" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-helper-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesPath = packaged
    ? path.join(root, "MintVault Scanner.app", "Contents", "Resources")
    : root;
  const helperRoot = packaged ? path.join(resourcesPath, "helpers") : root;
  const execPath = packaged
    ? path.join(root, "MintVault Scanner.app", "Contents", "MacOS", "MintVault Scanner")
    : process.execPath;
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  if (packaged) fs.writeFileSync(execPath, "app");
  fs.mkdirSync(helperRoot, { recursive: true });
  const helperPath = path.join(helperRoot, "mv-capture-helper");
  const manifestPath = path.join(helperRoot, "helper-manifest.json");
  const bytes = Buffer.from("fixture arm64 Mach-O bytes");
  fs.writeFileSync(helperPath, bytes, { mode: 0o755 });
  const manifest = {
    schemaVersion: 1,
    helperName: "mv-capture-helper",
    helperVersion: "1.0.0",
    protocolVersion: 1,
    bundleIdentifier: "com.mintvault.scanner.capture-helper",
    architecture: "arm64",
    minimumMacOS: "12.0",
    sha256: sha256(bytes),
    sourceSha256: sha256("source"),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const calls = [];
  const runTool = (command, args) => {
    calls.push({ command, args });
    const target = args.at(-1);
    if (command === "/usr/bin/lipo") return { status: 0, stdout: `${architectures}\n`, stderr: "" };
    if (command === "/usr/bin/otool") return { status: 0, stdout: `      cmd LC_BUILD_VERSION\n    minos ${minos}\n`, stderr: "" };
    if (command === "/usr/bin/codesign" && args[0] === "--verify") return { status: 0, stdout: "", stderr: "valid on disk\n" };
    if (command === "/usr/bin/codesign" && args[0] === "-d") {
      const app = target.endsWith(".app");
      const id = app ? "com.mintvault.scanner" : (identifier || "com.mintvault.scanner.capture-helper");
      const team = app ? appTeam : helperTeam;
      const flags = packaged ? "flags=0x10000(runtime)\n" : "flags=0x2(adhoc)\n";
      return { status: 0, stdout: "", stderr: `Identifier=${id}\nTeamIdentifier=${team || "not set"}\n${flags}` };
    }
    throw new Error(`Unexpected tool call ${command} ${args.join(" ")}`);
  };
  return {
    root,
    resourcesPath,
    helperPath,
    manifestPath,
    manifest,
    calls,
    options: { helperPath, manifestPath, runtime: { isPackaged: packaged, resourcesPath, execPath, expectedTeamIdentifier: packaged ? expectedTeam : null }, runTool },
  };
}

test("accepts an exact arm64 ad-hoc development helper with a sealed manifest", (t) => {
  const value = fixture(t);
  const verified = integrity._private.verifyHelperAt(value.options);
  assert.equal(verified.path, value.helperPath);
  assert.equal(verified.manifest.sha256, value.manifest.sha256);
  assert.equal(verified.helperSignature.identifier, "com.mintvault.scanner.capture-helper");
  assert.equal(value.calls.filter((call) => call.command === "/usr/bin/codesign").length, 2);
});

test("rejects a symlink before invoking any external verifier", (t) => {
  const value = fixture(t);
  const target = `${value.helperPath}.target`;
  fs.renameSync(value.helperPath, target);
  fs.symlinkSync(target, value.helperPath);
  assert.throws(() => integrity._private.verifyHelperAt(value.options), /regular file, not a link/);
  assert.equal(value.calls.length, 0);
});

test("rejects a helper whose bytes do not match the sealed SHA-256", (t) => {
  const value = fixture(t);
  fs.appendFileSync(value.helperPath, "tampered");
  assert.throws(() => integrity._private.verifyHelperAt(value.options), /SHA-256 does not match/);
  assert.equal(value.calls.length, 0);
});

test("rejects a non-executable helper", (t) => {
  const value = fixture(t);
  fs.chmodSync(value.helperPath, 0o644);
  assert.throws(() => integrity._private.verifyHelperAt(value.options), /not executable/);
  assert.equal(value.calls.length, 0);
});

test("rejects universal and wrong-architecture helpers", async (t) => {
  await t.test("universal", (st) => {
    const value = fixture(st, { architectures: "arm64 x86_64" });
    assert.throws(() => integrity._private.verifyHelperAt(value.options), /not arm64-only/);
  });
  await t.test("x86_64", (st) => {
    const value = fixture(st, { architectures: "x86_64" });
    assert.throws(() => integrity._private.verifyHelperAt(value.options), /not arm64-only/);
  });
});

test("rejects helper deployment-target drift", (t) => {
  const value = fixture(t, { minos: "13.0" });
  assert.throws(() => integrity._private.verifyHelperAt(value.options), /minimum macOS does not match/);
});

test("rejects an unsigned or invalidly signed helper", (t) => {
  const value = fixture(t);
  const original = value.options.runTool;
  value.options.runTool = (command, args) => {
    if (command === "/usr/bin/codesign" && args[0] === "--verify") return { status: 1, stdout: "", stderr: "code object is not signed" };
    return original(command, args);
  };
  assert.throws(() => integrity._private.verifyHelperAt(value.options), /code-signature verification failed/);
});

test("rejects a valid signature with the wrong helper identifier", (t) => {
  const value = fixture(t, { identifier: "com.attacker.replacement" });
  assert.throws(() => integrity._private.verifyHelperAt(value.options), /signing identifier is wrong/);
});

test("packaged runtime accepts only the same non-empty Team ID as the application", async (t) => {
  await t.test("same team", (st) => {
    const value = fixture(st, { packaged: true, helperTeam: "MINTVAULT1", appTeam: "MINTVAULT1" });
    assert.equal(integrity._private.verifyHelperAt(value.options).helperSignature.teamIdentifier, "MINTVAULT1");
  });
  await t.test("wrong team", (st) => {
    const value = fixture(st, { packaged: true, helperTeam: "ATTACKER01", appTeam: "MINTVAULT1" });
    assert.throws(() => integrity._private.verifyHelperAt(value.options), /pinned MintVault Team Identifier/);
  });
  await t.test("same attacker team on app and helper", (st) => {
    const value = fixture(st, { packaged: true, helperTeam: "ATTACKER01", appTeam: "ATTACKER01" });
    assert.throws(() => integrity._private.verifyHelperAt(value.options), /pinned MintVault Team Identifier/);
  });
  await t.test("ad-hoc production app", (st) => {
    const value = fixture(st, { packaged: true, helperTeam: "", appTeam: "" });
    assert.throws(() => integrity._private.verifyHelperAt(value.options), /application has no valid Team Identifier/);
  });
});

test("rejects stale or malformed native response protocol before controller use", () => {
  assert.deepEqual(integrity.assertCompatibleResult({ helperVersion: "1.0.0", protocolVersion: 1, status: "ready" }), {
    helperVersion: "1.0.0", protocolVersion: 1, status: "ready",
  });
  assert.throws(() => integrity.assertCompatibleResult({ helperVersion: "0.9.0", protocolVersion: 1 }), /response protocol\/version/);
  assert.throws(() => integrity.assertCompatibleResult({ helperVersion: "1.0.0", protocolVersion: 2 }), /response protocol\/version/);
});

test("identity helper uses its own sealed manifest and signing identifier contract", (t) => {
  const value = fixture(t);
  const identityPath = path.join(value.root, "mv-identity-helper");
  const manifestPath = path.join(value.root, "identity-helper-manifest.json");
  fs.renameSync(value.helperPath, identityPath);
  const manifest = {
    ...value.manifest,
    helperName: "mv-identity-helper",
    bundleIdentifier: "com.mintvault.scanner.identity-helper",
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  value.options.runTool = (command, args) => {
    if (command === "/usr/bin/lipo") return { status: 0, stdout: "arm64\n", stderr: "" };
    if (command === "/usr/bin/otool") return { status: 0, stdout: "      cmd LC_BUILD_VERSION\n    minos 12.0\n", stderr: "" };
    if (command === "/usr/bin/codesign" && args[0] === "--verify") return { status: 0, stdout: "", stderr: "valid on disk\n" };
    if (command === "/usr/bin/codesign" && args[0] === "-d") {
      return { status: 0, stdout: "", stderr: "Identifier=com.mintvault.scanner.identity-helper\nTeamIdentifier=not set\nflags=0x2(adhoc)\n" };
    }
    throw new Error(`Unexpected tool call ${command} ${args.join(" ")}`);
  };
  const verified = integrity._private.verifyHelperAt({
    ...value.options,
    helperPath: identityPath,
    manifestPath,
    expected: integrity._private.identityExpected(),
  });
  assert.equal(verified.manifest.bundleIdentifier, "com.mintvault.scanner.identity-helper");
});

test("rejects stale or malformed identity-helper response protocol", () => {
  assert.equal(integrity.assertCompatibleIdentityResult({ ok: true, helperVersion: "1.0.0", protocolVersion: 1 }).ok, true);
  assert.throws(() => integrity.assertCompatibleIdentityResult({ helperVersion: "0.9.0", protocolVersion: 1 }), /response protocol\/version/);
  assert.throws(() => integrity.assertCompatibleIdentityResult({ helperVersion: "1.0.0", protocolVersion: 2 }), /response protocol\/version/);
});
