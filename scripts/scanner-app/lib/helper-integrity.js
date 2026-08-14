const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HELPER_FILENAME = "mv-capture-helper";
const MANIFEST_FILENAME = "helper-manifest.json";
const APP_IDENTIFIER = "com.mintvault.scanner";
const HELPER_IDENTIFIER = "com.mintvault.scanner.capture-helper";
const HELPER_VERSION = "1.0.2";
const HELPER_PROTOCOL_VERSION = 1;
const IDENTITY_HELPER_FILENAME = "mv-identity-helper";
const IDENTITY_MANIFEST_FILENAME = "identity-helper-manifest.json";
const IDENTITY_HELPER_IDENTIFIER = "com.mintvault.scanner.identity-helper";
const IDENTITY_HELPER_VERSION = "1.1.2";
const IDENTITY_HELPER_PROTOCOL_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const MINIMUM_MACOS = "12.0";
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_HELPER_BYTES = 32 * 1024 * 1024;

let configuredRuntime = null;

function fail(message) {
  throw new Error(`Capture helper integrity check failed: ${message}`);
}

function configureRuntime({ isPackaged, resourcesPath, execPath, expectedTeamIdentifier = null, packageMode = null }) {
  if (typeof isPackaged !== "boolean") fail("packaged runtime state is unavailable");
  if (!path.isAbsolute(String(resourcesPath || ""))) fail("Electron resources path is invalid");
  if (!path.isAbsolute(String(execPath || ""))) fail("Electron executable path is invalid");
  if (isPackaged && !/^[A-Z0-9]{10}$/.test(String(expectedTeamIdentifier || ""))) {
    fail("packaged release has no pinned MintVault Team Identifier");
  }
  if (isPackaged && !["local", "release"].includes(packageMode)) fail("packaged release mode is unavailable");
  configuredRuntime = Object.freeze({
    isPackaged,
    resourcesPath: path.resolve(resourcesPath),
    execPath: path.resolve(execPath),
    expectedTeamIdentifier: isPackaged ? expectedTeamIdentifier : null,
    packageMode: isPackaged ? packageMode : "development",
  });
}

function loadReleaseTrust(resourcesPath, expectedPin, expectedVersion) {
  const trustPath = path.join(path.resolve(resourcesPath), "release-trust.json");
  let trust;
  try { trust = JSON.parse(readRegularFile(trustPath, "release trust contract", MAX_MANIFEST_BYTES).bytes.toString("utf8")); }
  catch { fail("release trust contract is not valid JSON"); }
  const exactKeys = ["appIdentifier", "architecture", "minimumMacOS", "packageMode", "schemaVersion", "teamIdentifier", "updateBaseUrl", "version"];
  if (!expectedPin || expectedPin.schemaVersion !== 1 || expectedPin.appIdentifier !== APP_IDENTIFIER
      || !["local", "release"].includes(expectedPin.packageMode)
      || !/^[A-Z0-9]{10}$/.test(String(expectedPin.teamIdentifier || ""))
      || trust?.schemaVersion !== 1 || trust.appIdentifier !== APP_IDENTIFIER
      || JSON.stringify(Object.keys(trust).sort()) !== JSON.stringify(exactKeys)
      || trust.teamIdentifier !== expectedPin.teamIdentifier || trust.packageMode !== expectedPin.packageMode
      || trust.architecture !== "arm64" || trust.minimumMacOS !== MINIMUM_MACOS
      || trust.version !== expectedVersion || !/^\d+\.\d+\.\d+$/.test(String(trust.version || ""))) {
    fail("release trust contract does not match the independently signed package authority");
  }
  let updateBase;
  try { updateBase = new URL(String(trust.updateBaseUrl || "")); }
  catch { fail("release trust update origin is invalid"); }
  if (updateBase.protocol !== "https:" || updateBase.username || updateBase.password || updateBase.search || updateBase.hash
      || (trust.packageMode === "release" && (updateBase.hostname.endsWith(".invalid") || updateBase.hostname === "localhost"))) {
    fail("release trust update origin is invalid");
  }
  return Object.freeze({ ...trust, updateBaseUrl: updateBase.toString().replace(/\/$/, "") });
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
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) fail(`${description} must be a regular file, not a link`);
    } catch (error) {
      if (String(error?.message || "").startsWith("Capture helper integrity check failed:")) throw error;
    }
    fail(`${description} is missing`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) fail(`${description} must be a regular file, not a link`);
    if (stat.size < 1 || stat.size > maxBytes) fail(`${description} exceeds its size limit`);
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${description} changed while being read`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 1 || after.size !== stat.size) {
      fail(`${description} changed while being read`);
    }
    return Object.freeze({ stat, bytes });
  } finally {
    fs.closeSync(descriptor);
  }
}

function readManifest(manifestPath, expected) {
  let manifest;
  try {
    manifest = JSON.parse(readRegularFile(manifestPath, "helper manifest", MAX_MANIFEST_BYTES).bytes.toString("utf8"));
  } catch {
    fail("helper manifest is not valid JSON");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key === "manifestName") continue;
    if (manifest?.[key] !== value) fail(`helper manifest ${key} is incompatible`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.sha256 || ""))) fail("helper manifest SHA-256 is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(manifest.sourceSha256 || ""))) fail("helper source SHA-256 is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(manifest.authoritySourceSha256 || ""))) fail("helper authority source SHA-256 is invalid");
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

function assertImmutablePackagedTree(targets) {
  const checked = new Set();
  for (const target of targets) {
    let current = path.resolve(target);
    while (!checked.has(current)) {
      checked.add(current);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch { fail("release application install tree is incomplete"); }
      if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        fail("release application install tree must be root-owned and not group/other writable");
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

function verifyHelperAt({ helperPath, manifestPath, runtime, expected = captureExpected(), runTool = defaultRunTool, assertImmutableTree = assertImmutablePackagedTree }) {
  if (process.platform !== "darwin") fail("capture is supported only on macOS");
  const appBundle = runtime.isPackaged ? appBundleFromExecutable(runtime.execPath) : null;
  if (runtime.isPackaged && runtime.packageMode === "release") {
    assertImmutableTree([helperPath, manifestPath, runtime.execPath, appBundle]);
  }
  const helperFile = readRegularFile(helperPath, "capture helper", MAX_HELPER_BYTES);
  const stat = helperFile.stat;
  if ((stat.mode & 0o111) === 0) fail("capture helper is not executable");
  const manifest = readManifest(manifestPath, expected);
  const digest = crypto.createHash("sha256").update(helperFile.bytes).digest("hex");
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

  if (runtime.isPackaged && runtime.packageMode === "release") {
    assertImmutableTree([helperPath, manifestPath, runtime.execPath, appBundle]);
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
  _private: { verifyHelperAt, appBundleFromExecutable, readManifest, readRegularFile, assertImmutablePackagedTree, captureExpected, identityExpected },
};
