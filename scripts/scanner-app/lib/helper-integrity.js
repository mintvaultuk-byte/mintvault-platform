const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HELPER_FILENAME = "mv-capture-helper";
const MANIFEST_FILENAME = "helper-manifest.json";
const APP_IDENTIFIER = "com.mintvault.scanner";
const HELPER_IDENTIFIER = "com.mintvault.scanner.capture-helper";
const HELPER_VERSION = "1.0.0";
const HELPER_PROTOCOL_VERSION = 1;
const IDENTITY_HELPER_FILENAME = "mv-identity-helper";
const IDENTITY_MANIFEST_FILENAME = "identity-helper-manifest.json";
const IDENTITY_HELPER_IDENTIFIER = "com.mintvault.scanner.identity-helper";
const IDENTITY_HELPER_VERSION = "1.1.0";
const IDENTITY_HELPER_PROTOCOL_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const MINIMUM_MACOS = "12.0";
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_HELPER_BYTES = 32 * 1024 * 1024;

let configuredRuntime = null;

function fail(message) {
  throw new Error(`Capture helper integrity check failed: ${message}`);
}

function configureRuntime({ isPackaged, resourcesPath, execPath, expectedTeamIdentifier = null }) {
  if (typeof isPackaged !== "boolean") fail("packaged runtime state is unavailable");
  if (!path.isAbsolute(String(resourcesPath || ""))) fail("Electron resources path is invalid");
  if (!path.isAbsolute(String(execPath || ""))) fail("Electron executable path is invalid");
  if (isPackaged && !/^[A-Z0-9]{10}$/.test(String(expectedTeamIdentifier || ""))) {
    fail("packaged release has no pinned MintVault Team Identifier");
  }
  configuredRuntime = Object.freeze({
    isPackaged,
    resourcesPath: path.resolve(resourcesPath),
    execPath: path.resolve(execPath),
    expectedTeamIdentifier: isPackaged ? expectedTeamIdentifier : null,
  });
}

function loadReleaseTrust(resourcesPath, expectedTeamIdentifier) {
  const trustPath = path.join(path.resolve(resourcesPath), "release-trust.json");
  readRegularFile(trustPath, "release trust contract", MAX_MANIFEST_BYTES);
  let trust;
  try { trust = JSON.parse(fs.readFileSync(trustPath, "utf8")); }
  catch { fail("release trust contract is not valid JSON"); }
  if (trust?.schemaVersion !== 1 || trust.appIdentifier !== APP_IDENTIFIER
      || !/^[A-Z0-9]{10}$/.test(String(expectedTeamIdentifier || ""))
      || trust.teamIdentifier !== expectedTeamIdentifier) {
    fail("release trust contract has no valid MintVault Team Identifier");
  }
  return Object.freeze({ teamIdentifier: trust.teamIdentifier });
}

function resolvePaths() {
  if (!configuredRuntime) fail("Electron runtime was not configured");
  const root = configuredRuntime.isPackaged
    ? path.join(path.dirname(configuredRuntime.resourcesPath), "Helpers")
    : path.resolve(__dirname, "..", "native", "bin");
  const manifestRoot = configuredRuntime.isPackaged
    ? path.join(configuredRuntime.resourcesPath, "helper-manifests")
    : root;
  return {
    helperPath: path.join(root, HELPER_FILENAME),
    manifestPath: path.join(manifestRoot, MANIFEST_FILENAME),
    runtime: configuredRuntime,
  };
}

function readRegularFile(filePath, description, maxBytes = Number.MAX_SAFE_INTEGER) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${description} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${description} must be a regular file, not a link`);
  if (stat.size > maxBytes) fail(`${description} exceeds its size limit`);
  let real;
  try {
    real = fs.realpathSync.native(filePath);
  } catch {
    fail(`${description} cannot be resolved`);
  }
  const expectedReal = path.join(fs.realpathSync.native(path.dirname(filePath)), path.basename(filePath));
  if (real !== expectedReal) fail(`${description} resolved outside its exact packaged path`);
  return stat;
}

function readManifest(manifestPath, expected) {
  readRegularFile(manifestPath, "helper manifest", MAX_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail("helper manifest is not valid JSON");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key === "manifestName") continue;
    if (manifest?.[key] !== value) fail(`helper manifest ${key} is incompatible`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.sha256 || ""))) fail("helper manifest SHA-256 is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(manifest.sourceSha256 || ""))) fail("helper source SHA-256 is invalid");
  return Object.freeze({ ...manifest });
}

function defaultRunTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runChecked(runTool, command, args, description) {
  const result = runTool(command, args);
  if (result?.error || result?.status !== 0) fail(`${description} failed`);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function signatureDetails(runTool, target, description) {
  const output = runChecked(runTool, "/usr/bin/codesign", ["-d", "--verbose=4", target], `${description} signature inspection`);
  const identifier = /^Identifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  return {
    identifier,
    teamIdentifier: teamIdentifier === "not set" ? "" : teamIdentifier,
    hardenedRuntime: /\bflags=0x[0-9a-f]+\(runtime\)/i.test(output),
  };
}

function appBundleFromExecutable(execPath) {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.lastIndexOf(marker);
  if (index < 0) fail("packaged application bundle cannot be derived");
  return execPath.slice(0, index + 4);
}

function verifyHelperAt({ helperPath, manifestPath, runtime, expected = captureExpected(), runTool = defaultRunTool }) {
  if (process.platform !== "darwin") fail("capture is supported only on macOS");
  const stat = readRegularFile(helperPath, "capture helper", MAX_HELPER_BYTES);
  if ((stat.mode & 0o111) === 0) fail("capture helper is not executable");
  const manifest = readManifest(manifestPath, expected);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(manifest.sha256, "hex"))) {
    fail("capture helper SHA-256 does not match its sealed manifest");
  }

  const architectures = runChecked(runTool, "/usr/bin/lipo", ["-archs", helperPath], "capture helper architecture")
    .trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") fail("capture helper is not arm64-only");

  const loadCommands = runChecked(runTool, "/usr/bin/otool", ["-l", helperPath], "capture helper load-command inspection");
  const minimumVersions = [...loadCommands.matchAll(/^\s*minos\s+([0-9.]+)$/gm)].map((match) => match[1]);
  if (minimumVersions.length !== 1 || minimumVersions[0] !== manifest.minimumMacOS) {
    fail("capture helper minimum macOS does not match its manifest");
  }

  runChecked(runTool, "/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", helperPath], "capture helper code-signature verification");
  const helperSignature = signatureDetails(runTool, helperPath, "capture helper");
  if (helperSignature.identifier !== manifest.bundleIdentifier) fail("capture helper signing identifier is wrong");

  if (runtime.isPackaged) {
    const expectedRoot = path.join(path.dirname(runtime.resourcesPath), "Helpers");
    const expectedManifestRoot = path.join(runtime.resourcesPath, "helper-manifests");
    const expectedHelper = path.join(expectedRoot, expected.helperName);
    const expectedManifest = path.join(expectedManifestRoot, expected.manifestName);
    if (path.resolve(helperPath) !== expectedHelper || path.resolve(manifestPath) !== expectedManifest) {
      fail("packaged helper or manifest is outside the sealed resources directory");
    }
    const appBundle = appBundleFromExecutable(runtime.execPath);
    runChecked(runTool, "/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", appBundle], "application code-signature verification");
    const appSignature = signatureDetails(runTool, appBundle, "application");
    if (appSignature.identifier !== APP_IDENTIFIER) fail("packaged application signing identifier is wrong");
    if (!/^[A-Z0-9]{10}$/.test(appSignature.teamIdentifier)) fail("packaged application has no valid Team Identifier");
    if (appSignature.teamIdentifier !== runtime.expectedTeamIdentifier || helperSignature.teamIdentifier !== runtime.expectedTeamIdentifier) {
      fail("application or helper is not signed by the pinned MintVault Team Identifier");
    }
    if (!appSignature.hardenedRuntime || !helperSignature.hardenedRuntime) fail("packaged application and helper must use the hardened runtime");
    if (!helperSignature.teamIdentifier || helperSignature.teamIdentifier !== appSignature.teamIdentifier) {
      fail("capture helper Team Identifier does not match the packaged application");
    }
  }

  return Object.freeze({ path: path.resolve(helperPath), manifest, helperSignature });
}

function captureExpected() {
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    helperName: HELPER_FILENAME,
    manifestName: MANIFEST_FILENAME,
    helperVersion: HELPER_VERSION,
    protocolVersion: HELPER_PROTOCOL_VERSION,
    bundleIdentifier: HELPER_IDENTIFIER,
    architecture: "arm64",
    minimumMacOS: MINIMUM_MACOS,
  });
}

function identityExpected() {
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    helperName: IDENTITY_HELPER_FILENAME,
    manifestName: IDENTITY_MANIFEST_FILENAME,
    helperVersion: IDENTITY_HELPER_VERSION,
    protocolVersion: IDENTITY_HELPER_PROTOCOL_VERSION,
    bundleIdentifier: IDENTITY_HELPER_IDENTIFIER,
    architecture: "arm64",
    minimumMacOS: MINIMUM_MACOS,
  });
}

function verifiedCaptureHelper() {
  const paths = resolvePaths();
  return verifyHelperAt({ ...paths, expected: captureExpected() });
}

function verifiedIdentityHelper() {
  if (!configuredRuntime) fail("Electron runtime was not configured");
  const root = configuredRuntime.isPackaged
    ? path.join(path.dirname(configuredRuntime.resourcesPath), "Helpers")
    : path.resolve(__dirname, "..", "native", "bin");
  const manifestRoot = configuredRuntime.isPackaged
    ? path.join(configuredRuntime.resourcesPath, "helper-manifests")
    : root;
  return verifyHelperAt({
    helperPath: path.join(root, IDENTITY_HELPER_FILENAME),
    manifestPath: path.join(manifestRoot, IDENTITY_MANIFEST_FILENAME),
    runtime: configuredRuntime,
    expected: identityExpected(),
  });
}

function assertCompatibleResult(result) {
  if (!result || result.protocolVersion !== HELPER_PROTOCOL_VERSION || result.helperVersion !== HELPER_VERSION) {
    fail("capture helper response protocol/version is incompatible");
  }
  return result;
}

function assertCompatibleIdentityResult(result) {
  if (!result || result.protocolVersion !== IDENTITY_HELPER_PROTOCOL_VERSION || result.helperVersion !== IDENTITY_HELPER_VERSION) {
    fail("identity helper response protocol/version is incompatible");
  }
  return result;
}

module.exports = {
  HELPER_FILENAME,
  APP_IDENTIFIER,
  HELPER_IDENTIFIER,
  HELPER_VERSION,
  HELPER_PROTOCOL_VERSION,
  IDENTITY_HELPER_FILENAME,
  IDENTITY_HELPER_IDENTIFIER,
  IDENTITY_HELPER_VERSION,
  IDENTITY_HELPER_PROTOCOL_VERSION,
  MINIMUM_MACOS,
  configureRuntime,
  loadReleaseTrust,
  verifiedCaptureHelper,
  verifiedIdentityHelper,
  assertCompatibleResult,
  assertCompatibleIdentityResult,
  _private: { verifyHelperAt, appBundleFromExecutable, readManifest, captureExpected, identityExpected },
};
