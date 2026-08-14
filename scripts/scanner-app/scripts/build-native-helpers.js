#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const contract = require("./package-contract");
const preparation = require("./prepare-macos-package");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "native", "mintvault-lide-bridge.m");
const OUTPUT_DIRECTORY = path.join(ROOT, "native", "bin");
const OUTPUT = path.join(OUTPUT_DIRECTORY, "mv-capture-helper");
const MANIFEST = path.join(OUTPUT_DIRECTORY, "helper-manifest.json");
const IDENTITY_SOURCE = path.join(ROOT, "native", "mv-identity-helper.swift");
const IDENTITY_AUTHORITY_SOURCE = preparation.RELEASE_TEAM_PIN_SWIFT;
const CAPTURE_AUTHORITY_SOURCE = preparation.RELEASE_TEAM_PIN_HEADER;
const IDENTITY_OUTPUT = path.join(OUTPUT_DIRECTORY, "mv-identity-helper");
const IDENTITY_MANIFEST = path.join(OUTPUT_DIRECTORY, "identity-helper-manifest.json");
const IDENTIFIER = contract.CAPTURE_HELPER_IDENTIFIER;
const HELPER_VERSION = "1.0.2";
const IDENTITY_HELPER_VERSION = "1.1.2";
const PROTOCOL_VERSION = 1;
const MINIMUM_MACOS = "12.0";
const PREPARATION_RECORD = path.join(ROOT, "build", "generated", "package-preparation.json");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function inspect(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} inspection failed`);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertMachO(filePath) {
  const architectures = run("/usr/bin/lipo", ["-archs", filePath]).trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== "arm64") throw new Error(`${path.basename(filePath)} is not arm64-only`);
  const loadCommands = run("/usr/bin/otool", ["-l", filePath]);
  const minimumVersions = [...loadCommands.matchAll(/^\s*minos\s+([0-9.]+)$/gm)].map((match) => match[1]);
  if (minimumVersions.length !== 1 || minimumVersions[0] !== MINIMUM_MACOS) {
    throw new Error(`${path.basename(filePath)} minimum macOS is not ${MINIMUM_MACOS}`);
  }
}

function signatureDetails(filePath) {
  const details = inspect("/usr/bin/codesign", ["-d", "--verbose=4", filePath]);
  return {
    identifier: /^Identifier=(.+)$/m.exec(details)?.[1]?.trim() || "",
    teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim() || "",
    hardenedRuntime: /\bflags=0x[0-9a-f]+\(runtime\)/i.test(details),
  };
}

function signAndVerify(filePath, identifier, { release, identity, entitlements = null, teamIdentifier }) {
  fs.chmodSync(filePath, 0o755);
  const args = ["--force", "--sign", identity, "--identifier", identifier];
  if (release) args.push("--options", "runtime", "--timestamp");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(filePath);
  run("/usr/bin/codesign", args);
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", filePath]);
  assertMachO(filePath);
  const signature = signatureDetails(filePath);
  if (signature.identifier !== identifier) throw new Error(`${path.basename(filePath)} signing identifier is wrong`);
  if (release && (signature.teamIdentifier !== teamIdentifier || !signature.hardenedRuntime)) {
    throw new Error(`${path.basename(filePath)} is not hardened and signed by the pinned Team ID`);
  }
  return signature;
}

function currentPackageBinding(mode, teamIdentifier) {
  const preparationId = process.env.MINTVAULT_PREPARATION_ID;
  if (!preparationId) return null;
  const preparation = JSON.parse(fs.readFileSync(PREPARATION_RECORD, "utf8"));
  const currentCommit = run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: ROOT }).trim();
  if (preparation.phase !== "PREPARED" || preparation.preparationId !== preparationId
      || preparation.mode !== mode || preparation.teamIdentifier !== teamIdentifier
      || preparation.sourceCommit !== currentCommit) {
    throw new Error("native helper build is not bound to the active package preparation");
  }
  return Object.freeze({ preparationId, packageMode: mode, sourceCommit: currentCommit, teamIdentifier });
}

function main() {
  contract.requireDarwinArm64();
  const mode = contract.packageMode();
  const release = mode === "release";
  const releaseEnvironment = release
    ? contract.validateReleaseEnvironment()
    : { teamIdentifier: contract.LOCAL_TEAM_IDENTIFIER, identity: "-" };
  const packageBinding = currentPackageBinding(mode, releaseEnvironment.teamIdentifier);
  preparation.writeReleasePins({ teamIdentifier: releaseEnvironment.teamIdentifier, mode });
  const identityEntitlements = release
    ? path.join(ROOT, "build", "generated", "identity-helper.entitlements.plist")
    : null;
  if (release && !fs.existsSync(identityEntitlements)) {
    throw new Error("release identity-helper entitlements were not prepared");
  }
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true, mode: 0o755 });
  const temporaryOutput = path.join(OUTPUT_DIRECTORY, `.mv-capture-helper.${process.pid}.tmp`);
  const temporaryManifest = path.join(OUTPUT_DIRECTORY, `.helper-manifest.${process.pid}.tmp`);
  const temporaryIdentityOutput = path.join(OUTPUT_DIRECTORY, `.mv-identity-helper.${process.pid}.tmp`);
  const temporaryIdentityManifest = path.join(OUTPUT_DIRECTORY, `.identity-helper-manifest.${process.pid}.tmp`);
  try {
    run("/usr/bin/xcrun", [
      "clang",
      "-arch", "arm64",
      `-mmacosx-version-min=${MINIMUM_MACOS}`,
      "-fobjc-arc",
      "-fmodules",
      "-framework", "Foundation",
      "-framework", "ImageCaptureCore",
      "-framework", "Security",
      SOURCE,
      "-o", temporaryOutput,
    ]);
    const captureSignature = signAndVerify(temporaryOutput, IDENTIFIER, {
      release,
      identity: releaseEnvironment.identity,
      teamIdentifier: releaseEnvironment.teamIdentifier,
    });
    run("/usr/bin/xcrun", [
      "swiftc",
      "-parse-as-library",
      "-O",
      "-target", `arm64-apple-macosx${MINIMUM_MACOS}`,
      IDENTITY_SOURCE,
      IDENTITY_AUTHORITY_SOURCE,
      "-o", temporaryIdentityOutput,
    ]);
    const identitySignature = signAndVerify(temporaryIdentityOutput, contract.IDENTITY_HELPER_IDENTIFIER, {
      release,
      identity: releaseEnvironment.identity,
      entitlements: identityEntitlements,
      teamIdentifier: releaseEnvironment.teamIdentifier,
    });
    if (release) {
      const entitlements = inspect("/usr/bin/codesign", ["-d", "--entitlements", ":-", temporaryIdentityOutput]);
      const requiredAccessGroup = `${releaseEnvironment.teamIdentifier}.${contract.APP_IDENTIFIER}`;
      if (!entitlements.includes(`<string>${requiredAccessGroup}</string>`)) {
        throw new Error("identity helper is missing the exact production Keychain access group entitlement");
      }
    }
    const manifest = {
      schemaVersion: 1,
      helperName: "mv-capture-helper",
      helperVersion: HELPER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      bundleIdentifier: IDENTIFIER,
      architecture: "arm64",
      minimumMacOS: MINIMUM_MACOS,
      sha256: sha256(temporaryOutput),
      sourceSha256: sha256(SOURCE),
      authoritySourceSha256: sha256(CAPTURE_AUTHORITY_SOURCE),
      ...(packageBinding ? { packageBinding } : {}),
    };
    const identityManifest = {
      schemaVersion: 1,
      helperName: "mv-identity-helper",
      helperVersion: IDENTITY_HELPER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      bundleIdentifier: contract.IDENTITY_HELPER_IDENTIFIER,
      architecture: "arm64",
      minimumMacOS: MINIMUM_MACOS,
      sha256: sha256(temporaryIdentityOutput),
      sourceSha256: sha256(IDENTITY_SOURCE),
      authoritySourceSha256: sha256(IDENTITY_AUTHORITY_SOURCE),
      ...(packageBinding ? { packageBinding } : {}),
    };
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    fs.writeFileSync(temporaryIdentityManifest, `${JSON.stringify(identityManifest, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryOutput, OUTPUT);
    fs.renameSync(temporaryManifest, MANIFEST);
    fs.renameSync(temporaryIdentityOutput, IDENTITY_OUTPUT);
    fs.renameSync(temporaryIdentityManifest, IDENTITY_MANIFEST);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      packageMode: mode,
      capture: { output: OUTPUT, manifest: MANIFEST, signature: captureSignature, ...manifest },
      identity: { output: IDENTITY_OUTPUT, manifest: IDENTITY_MANIFEST, signature: identitySignature, ...identityManifest },
    })}\n`);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
    fs.rmSync(temporaryManifest, { force: true });
    fs.rmSync(temporaryIdentityOutput, { force: true });
    fs.rmSync(temporaryIdentityManifest, { force: true });
  }
}

main();
