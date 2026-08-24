/*
 * Partner stations must receive a self-contained app bundle, not a development checkout that asks a
 * shop Mac to install Node, npm, Git, Xcode, or clang. These tests pin the source contract: packaged
 * runtime uses the nested prebuilt ImageCaptureCore bridge and fails closed if that bridge is absent.
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");

function loadController() {
  delete require.cache[require.resolve("../lib/lide400-controller")];
  return require("../lib/lide400-controller");
}

let sandbox;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mv-scanner-package-"));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("macOS scanner packaging contract", () => {
  test("the scanner app declares package and package verification scripts", () => {
    const pkg = require("../package.json");
    assert.strictEqual(pkg.scripts["package:mac"], "node scripts/package-macos.js");
    assert.strictEqual(pkg.scripts["verify:package"], "node scripts/verify-package.js");
    assert.ok(fs.existsSync(path.join(APP_ROOT, "scripts", "package-macos.js")));
    assert.ok(fs.existsSync(path.join(APP_ROOT, "scripts", "verify-package.js")));
  });

  test("packaged runtime is detected from the app bundle resources path", () => {
    const resources = path.join(sandbox, "MintVault Scanner.app", "Contents", "Resources");
    const appDir = path.join(resources, "app");
    assert.strictEqual(loadController()._private.isPackagedRuntime({}, appDir, resources), true);
  });

  test("the explicit packaged-runtime gate exists for package verification", () => {
    assert.strictEqual(
      loadController()._private.isPackagedRuntime({ MINTVAULT_SCANNER_PACKAGED: "1" }, sandbox, sandbox),
      true,
    );
  });

  test("development runtime is not mistaken for a packaged app", () => {
    assert.strictEqual(loadController()._private.isPackagedRuntime({}, APP_ROOT, path.join(sandbox, "Resources")), false);
  });

  test("packaged bridge validation fails closed when the nested bridge is missing", () => {
    assert.throws(
      () => loadController()._private.validatePackagedBridge(path.join(sandbox, "missing-bridge")),
      /bridge is missing/,
    );
  });

  test("packaged bridge validation refuses a non-executable nested bridge", () => {
    const bridge = path.join(sandbox, "mintvault-lide-bridge");
    fs.writeFileSync(bridge, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    assert.throws(() => loadController()._private.validatePackagedBridge(bridge), /not executable/);
  });

  test("packaged bridge validation accepts only an executable nested bridge", () => {
    const bridge = path.join(sandbox, "mintvault-lide-bridge");
    fs.writeFileSync(bridge, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.strictEqual(loadController()._private.validatePackagedBridge(bridge), bridge);
  });

  test("packaged runtime branch precedes the development xcrun build branch", () => {
    const source = fs.readFileSync(path.join(APP_ROOT, "lib", "lide400-controller.js"), "utf8");
    const packagedGuard = source.indexOf("if (isPackagedRuntime()) return validatePackagedBridge(PACKAGED_BRIDGE);");
    const xcrunBuild = source.indexOf('"/usr/bin/xcrun"');
    assert.ok(packagedGuard > 0, "ensureBridge must contain the packaged-runtime guard");
    assert.ok(xcrunBuild > packagedGuard, "the xcrun build path must be unreachable before packaged bridge validation");
  });

  test("the package script excludes dev Electron and tests from the nested app resources", () => {
    const script = fs.readFileSync(path.join(APP_ROOT, "scripts", "package-macos.js"), "utf8");
    assert.match(script, /parts\[0\] === "node_modules" && parts\[1\] === "electron"/);
    assert.match(script, /parts\[0\] === "scripts"/);
    assert.match(script, /parts\[0\] === "test"/);
    assert.match(script, /copyRecursive\(SHARED_SOURCE, OUT_SHARED\)/);
    assert.match(script, /partnerMacRequiresXcodeOrClang: false/);
  });

  test("the source LaunchAgent uses the development wrapper only outside a packaged bundle", () => {
    const agent = require("../lib/agent-plist");
    const rendered = agent.renderPlist();
    assert.ok(rendered.includes(agent.paths().wrapper));
    assert.ok(!rendered.includes(agent.paths().packagedExecutable));
  });
});
