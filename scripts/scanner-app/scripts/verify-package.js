#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_APP = path.join(APP_ROOT, "dist", "mac-arm64", "MintVault Scanner.app");
const APP_BUNDLE = path.resolve(process.argv[2] || DEFAULT_APP);
const CONTENTS = path.join(APP_BUNDLE, "Contents");
const RESOURCES = path.join(CONTENTS, "Resources");
const PACKAGED_APP = path.join(RESOURCES, "app");
const PACKAGED_SHARED = path.join(CONTENTS, "shared");
const EXECUTABLE = path.join(CONTENTS, "MacOS", "MintVault Scanner");
const BRIDGE = path.join(PACKAGED_APP, "native", "mintvault-lide-bridge");
const MANIFEST = path.join(path.dirname(APP_BUNDLE), "mintvault-scanner-package-manifest.json");
const SOURCE_PACKAGE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));

function fail(message) {
  throw new Error(message);
}

function mustExist(file, description) {
  if (!fs.existsSync(file)) fail(`${description} missing: ${file}`);
}

function mustExecutable(file, description) {
  mustExist(file, description);
  const stat = fs.statSync(file);
  if (!stat.isFile()) fail(`${description} is not a file: ${file}`);
  fs.accessSync(file, fs.constants.X_OK);
}

function plistValue(key) {
  const result = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", path.join(CONTENTS, "Info.plist")], {
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`Could not read Info.plist ${key}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function assertNoPath(file, description) {
  if (fs.existsSync(file)) fail(`${description} must not be present: ${file}`);
}

function mustMatch(actual, expected, description) {
  if (actual !== expected) fail(`${description} mismatch: expected ${expected}, got ${actual || "missing"}`);
}

function requirePackagedController() {
  const controllerPath = path.join(PACKAGED_APP, "lib", "lide400-controller.js");
  mustExist(controllerPath, "packaged LiDE controller");
  delete require.cache[require.resolve(controllerPath)];
  return require(controllerPath);
}

function main() {
  mustExist(APP_BUNDLE, "MintVault Scanner app bundle");
  mustExecutable(EXECUTABLE, "app executable");
  mustExecutable(BRIDGE, "packaged LiDE bridge");
  mustExist(path.join(PACKAGED_APP, "main.js"), "Electron main process");
  mustExist(path.join(PACKAGED_APP, "preload.js"), "Electron preload");
  mustExist(path.join(PACKAGED_APP, "renderer", "index.html"), "renderer");
  mustExist(path.join(PACKAGED_APP, "node_modules", "sharp"), "runtime sharp dependency");
  mustExist(path.join(PACKAGED_SHARED, "lide400-capture-profile.cjs"), "shared LiDE capture profile");
  mustExist(path.join(PACKAGED_SHARED, "lide400-card-geometry.cjs"), "shared LiDE card geometry");
  assertNoPath(path.join(PACKAGED_APP, "node_modules", "electron"), "dev Electron dependency");
  assertNoPath(path.join(PACKAGED_APP, "scripts"), "local build/release scripts");
  assertNoPath(path.join(PACKAGED_APP, "test"), "test suite");
  assertNoPath(path.join(PACKAGED_APP, "dist"), "nested dist output");

  if (plistValue("CFBundleIdentifier") !== "com.mintvault.scanner") {
    fail("bundle identifier is not com.mintvault.scanner");
  }
  if (plistValue("CFBundleExecutable") !== "MintVault Scanner") {
    fail("bundle executable is not MintVault Scanner");
  }

  const controller = requirePackagedController();
  if (!controller._private.isPackagedRuntime({}, PACKAGED_APP, RESOURCES)) {
    fail("controller does not recognise Contents/Resources/app as packaged runtime");
  }
  if (!controller._private.isPackagedRuntime({ MINTVAULT_SCANNER_PACKAGED: "1" }, "/tmp/dev", "/tmp/dev")) {
    fail("controller does not honour the explicit packaged-runtime gate");
  }
  if (controller._private.validatePackagedBridge(BRIDGE) !== BRIDGE) {
    fail("controller does not accept the nested packaged bridge");
  }

  mustExist(MANIFEST, "package manifest");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const expectedVersion = SOURCE_PACKAGE.version;
  const packagedPackage = JSON.parse(fs.readFileSync(path.join(PACKAGED_APP, "package.json"), "utf8"));
  const packagedMain = fs.readFileSync(path.join(PACKAGED_APP, "main.js"), "utf8");
  const packagedRenderer = fs.readFileSync(path.join(PACKAGED_APP, "renderer", "app.js"), "utf8");
  const packagedPreload = fs.readFileSync(path.join(PACKAGED_APP, "preload.js"), "utf8");
  mustMatch(plistValue("CFBundleShortVersionString"), expectedVersion, "CFBundleShortVersionString");
  mustMatch(plistValue("CFBundleVersion"), expectedVersion, "CFBundleVersion");
  mustMatch(packagedPackage.version, expectedVersion, "packaged runtime package version");
  mustMatch(manifest.packageVersion, expectedVersion, "package manifest version");
  if (!packagedMain.includes('require("./package.json").version')) {
    fail("packaged runtime does not source its version from package.json");
  }
  if (!packagedPreload.includes('getVersion: () => ipcRenderer.invoke("get-version")')) {
    fail("packaged preload does not expose the runtime version IPC");
  }
  if (!packagedRenderer.includes('els.appVersion.textContent = `v${result.version}`')) {
    fail("packaged About UI does not render the runtime version");
  }
  if (manifest.nativeBridge?.runtimeCompilationRequired !== false) {
    fail("manifest must state that runtime bridge compilation is not required");
  }
  if (!manifest.sharedCanon?.modules?.includes("lide400-capture-profile.cjs")) {
    fail("manifest must record the packaged shared LiDE capture profile");
  }
  if (manifest.runtimeRequirements?.partnerMacRequiresXcodeOrClang !== false) {
    fail("manifest must state that partner Macs do not require Xcode/clang");
  }

  console.log(`Verified ${APP_BUNDLE}`);
  console.log(`Bridge ${manifest.nativeBridge.packagedPath}`);
}

main();
