#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const contract = require("./package-contract");

const ROOT = path.resolve(__dirname, "..");
const GENERATED = path.join(ROOT, "build", "generated");
const RELEASE_TRUST = path.join(GENERATED, "release-trust.json");
const IDENTITY_ENTITLEMENTS = path.join(GENERATED, "identity-helper.entitlements.plist");
const PREPARATION_RECORD = path.join(GENERATED, "package-preparation.json");
const RELEASE_TEAM_PIN_JS = path.join(GENERATED, "release-team-pin.js");
const RELEASE_TEAM_PIN_SWIFT = path.join(GENERATED, "release-team-pin.swift");
const STALE_NATIVE_OUTPUTS = Object.freeze([
  path.join(ROOT, "native", "bin", "mv-capture-helper"),
  path.join(ROOT, "native", "bin", "helper-manifest.json"),
  path.join(ROOT, "native", "bin", "mv-identity-helper"),
  path.join(ROOT, "native", "bin", "identity-helper-manifest.json"),
]);

function sourceState() {
  const sourceCommit = contract.run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: ROOT }).trim();
  const dirty = contract.run("/usr/bin/git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: ROOT }).trim() !== "";
  return Object.freeze({ sourceCommit, sourceTreeState: dirty ? "dirty" : "clean" });
}

function writeReleasePins({ teamIdentifier, mode }) {
  const pin = { schemaVersion: 1, appIdentifier: contract.APP_IDENTIFIER, teamIdentifier, packageMode: mode };
  contract.atomicWrite(RELEASE_TEAM_PIN_JS, `module.exports = Object.freeze(${JSON.stringify(pin)});\n`);
  contract.atomicWrite(
    RELEASE_TEAM_PIN_SWIFT,
    `import Foundation\n\nenum MintVaultReleaseAuthority {\n  static let teamIdentifier = ${JSON.stringify(teamIdentifier)}\n  static let packageMode = ${JSON.stringify(mode)}\n}\n`,
  );
  return Object.freeze(pin);
}

function prepare(env = process.env) {
  contract.requireDarwinArm64();
  const mode = contract.packageMode(env.MINTVAULT_PACKAGE_MODE);
  const release = mode === "release";
  const preparationId = String(env.MINTVAULT_PREPARATION_ID || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(preparationId)) {
    throw new Error("package preparation requires a fresh UUIDv4 MINTVAULT_PREPARATION_ID");
  }
  const releaseEnvironment = release
    ? contract.validateReleaseEnvironment(env)
    : { teamIdentifier: contract.LOCAL_TEAM_IDENTIFIER, identity: "-" };
  const updateBaseUrl = contract.validateUpdateBaseUrl(
    env.MINTVAULT_UPDATE_BASE_URL || "https://updates.invalid/mintvault/scanner",
    { release },
  );
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(String(packageMetadata.version || ""))) throw new Error("scanner package version must be strict semver");
  const source = sourceState();
  if (release && source.sourceTreeState !== "clean") throw new Error("release packaging requires a clean source tree");

  const trust = {
    schemaVersion: 1,
    appIdentifier: contract.APP_IDENTIFIER,
    teamIdentifier: releaseEnvironment.teamIdentifier,
    architecture: contract.ARCHITECTURE,
    minimumMacOS: contract.MINIMUM_MACOS,
    version: packageMetadata.version,
    packageMode: mode,
    updateBaseUrl,
  };
  const keychainGroup = `${releaseEnvironment.teamIdentifier}.${contract.APP_IDENTIFIER}`;
  const entitlements = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>keychain-access-groups</key>\n  <array>\n    <string>${keychainGroup}</string>\n  </array>\n</dict>\n</plist>\n`;
  for (const stalePath of STALE_NATIVE_OUTPUTS) fs.rmSync(stalePath, { force: true });
  const releaseTeamPin = writeReleasePins({ teamIdentifier: releaseEnvironment.teamIdentifier, mode });
  contract.atomicWrite(RELEASE_TRUST, `${JSON.stringify(trust, null, 2)}\n`);
  contract.atomicWrite(IDENTITY_ENTITLEMENTS, entitlements);
  const preparation = {
    schemaVersion: 1,
    preparationId,
    phase: "PREPARED",
    preparedAt: new Date().toISOString(),
    mode,
    version: packageMetadata.version,
    teamIdentifier: releaseEnvironment.teamIdentifier,
    updateBaseUrl,
    ...source,
    releaseTeamPin,
  };
  contract.atomicWrite(PREPARATION_RECORD, `${JSON.stringify(preparation, null, 2)}\n`);
  return Object.freeze({ mode, release, trust, preparation, identity: releaseEnvironment.identity, releaseTrustPath: RELEASE_TRUST, identityEntitlementsPath: IDENTITY_ENTITLEMENTS, preparationRecordPath: PREPARATION_RECORD });
}

function sealPreparation(env = process.env) {
  const preparation = JSON.parse(fs.readFileSync(PREPARATION_RECORD, "utf8"));
  if (preparation.preparationId !== env.MINTVAULT_PREPARATION_ID || preparation.phase !== "PREPARED"
      || preparation.mode !== contract.packageMode(env.MINTVAULT_PACKAGE_MODE)) {
    throw new Error("package preparation record cannot be sealed by this build");
  }
  const helpers = {};
  for (const [name, manifestName] of [["capture", "helper-manifest.json"], ["identity", "identity-helper-manifest.json"]]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "native", "bin", manifestName), "utf8"));
    const helperPath = path.join(ROOT, "native", "bin", manifest.helperName);
    const sourcePath = name === "capture"
      ? path.join(ROOT, "native", "mintvault-lide-bridge.m")
      : path.join(ROOT, "native", "mv-identity-helper.swift");
    const digest = contract.run("/usr/bin/shasum", ["-a", "256", helperPath]).trim().split(/\s+/)[0];
    const sourceDigest = contract.run("/usr/bin/shasum", ["-a", "256", sourcePath]).trim().split(/\s+/)[0];
    const authorityDigest = name === "identity"
      ? contract.run("/usr/bin/shasum", ["-a", "256", RELEASE_TEAM_PIN_SWIFT]).trim().split(/\s+/)[0]
      : null;
    const expectedBinding = {
      preparationId: preparation.preparationId,
      packageMode: preparation.mode,
      sourceCommit: preparation.sourceCommit,
      teamIdentifier: preparation.teamIdentifier,
    };
    if (digest !== manifest.sha256 || sourceDigest !== manifest.sourceSha256
        || (name === "identity" && authorityDigest !== manifest.authoritySourceSha256)
        || JSON.stringify(manifest.packageBinding) !== JSON.stringify(expectedBinding)) {
      throw new Error(`${name} helper is stale or not bound to this package preparation`);
    }
    helpers[name] = { name: manifest.helperName, identifier: manifest.bundleIdentifier, version: manifest.helperVersion, sha256: manifest.sha256 };
  }
  const ready = { ...preparation, phase: "READY", sealedAt: new Date().toISOString(), helpers };
  contract.atomicWrite(PREPARATION_RECORD, `${JSON.stringify(ready, null, 2)}\n`);
  return Object.freeze(ready);
}

if (require.main === module) process.stdout.write(`${JSON.stringify({ ok: true, ...prepare() })}\n`);

module.exports = { prepare, sealPreparation, sourceState, writeReleasePins, ROOT, GENERATED, RELEASE_TRUST, IDENTITY_ENTITLEMENTS, PREPARATION_RECORD, RELEASE_TEAM_PIN_JS, RELEASE_TEAM_PIN_SWIFT, STALE_NATIVE_OUTPUTS };
