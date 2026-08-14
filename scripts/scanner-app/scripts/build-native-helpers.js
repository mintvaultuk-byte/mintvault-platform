#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "native", "mintvault-lide-bridge.m");
const OUTPUT_DIRECTORY = path.join(ROOT, "native", "bin");
const OUTPUT = path.join(OUTPUT_DIRECTORY, "mv-capture-helper");
const MANIFEST = path.join(OUTPUT_DIRECTORY, "helper-manifest.json");
const IDENTITY_SOURCE = path.join(ROOT, "native", "mv-identity-helper.swift");
const IDENTITY_OUTPUT = path.join(OUTPUT_DIRECTORY, "mv-identity-helper");
const IDENTITY_MANIFEST = path.join(OUTPUT_DIRECTORY, "identity-helper-manifest.json");
const IDENTIFIER = "com.mintvault.scanner.capture-helper";
const HELPER_VERSION = "1.0.0";
const IDENTITY_HELPER_VERSION = "1.1.0";
const PROTOCOL_VERSION = 1;
const MINIMUM_MACOS = "12.0";

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
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

function signAndVerify(filePath, identifier) {
  fs.chmodSync(filePath, 0o755);
  run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, filePath]);
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", filePath]);
  assertMachO(filePath);
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Native capture helpers must be built on Apple Silicon macOS");
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
      SOURCE,
      "-o", temporaryOutput,
    ]);
    signAndVerify(temporaryOutput, IDENTIFIER);
    run("/usr/bin/xcrun", [
      "swiftc",
      "-parse-as-library",
      "-O",
      "-target", `arm64-apple-macosx${MINIMUM_MACOS}`,
      IDENTITY_SOURCE,
      "-o", temporaryIdentityOutput,
    ]);
    signAndVerify(temporaryIdentityOutput, "com.mintvault.scanner.identity-helper");
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
    };
    const identityManifest = {
      schemaVersion: 1,
      helperName: "mv-identity-helper",
      helperVersion: IDENTITY_HELPER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      bundleIdentifier: "com.mintvault.scanner.identity-helper",
      architecture: "arm64",
      minimumMacOS: MINIMUM_MACOS,
      sha256: sha256(temporaryIdentityOutput),
      sourceSha256: sha256(IDENTITY_SOURCE),
    };
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    fs.writeFileSync(temporaryIdentityManifest, `${JSON.stringify(identityManifest, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryOutput, OUTPUT);
    fs.renameSync(temporaryManifest, MANIFEST);
    fs.renameSync(temporaryIdentityOutput, IDENTITY_OUTPUT);
    fs.renameSync(temporaryIdentityManifest, IDENTITY_MANIFEST);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      capture: { output: OUTPUT, manifest: MANIFEST, ...manifest },
      identity: { output: IDENTITY_OUTPUT, manifest: IDENTITY_MANIFEST, ...identityManifest },
    })}\n`);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
    fs.rmSync(temporaryManifest, { force: true });
    fs.rmSync(temporaryIdentityOutput, { force: true });
    fs.rmSync(temporaryIdentityManifest, { force: true });
  }
}

main();
