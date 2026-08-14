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
const IDENTIFIER = "com.mintvault.scanner.capture-helper";
const HELPER_VERSION = "1.0.0";
const PROTOCOL_VERSION = 1;
const MINIMUM_MACOS = "12.0";

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Native capture helpers must be built on Apple Silicon macOS");
  }
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true, mode: 0o755 });
  const temporaryOutput = path.join(OUTPUT_DIRECTORY, `.mv-capture-helper.${process.pid}.tmp`);
  const temporaryManifest = path.join(OUTPUT_DIRECTORY, `.helper-manifest.${process.pid}.tmp`);
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
    fs.chmodSync(temporaryOutput, 0o755);
    run("/usr/bin/codesign", [
      "--force",
      "--sign", "-",
      "--identifier", IDENTIFIER,
      temporaryOutput,
    ]);
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", temporaryOutput]);
    const architectures = run("/usr/bin/lipo", ["-archs", temporaryOutput]).trim().split(/\s+/);
    if (architectures.length !== 1 || architectures[0] !== "arm64") throw new Error("Built capture helper is not arm64-only");
    const loadCommands = run("/usr/bin/otool", ["-l", temporaryOutput]);
    const minimumVersions = [...loadCommands.matchAll(/^\s*minos\s+([0-9.]+)$/gm)].map((match) => match[1]);
    if (minimumVersions.length !== 1 || minimumVersions[0] !== MINIMUM_MACOS) {
      throw new Error(`Built capture helper minimum macOS is not ${MINIMUM_MACOS}`);
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
    };
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryOutput, OUTPUT);
    fs.renameSync(temporaryManifest, MANIFEST);
    process.stdout.write(`${JSON.stringify({ ok: true, output: OUTPUT, manifest: MANIFEST, ...manifest })}\n`);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
    fs.rmSync(temporaryManifest, { force: true });
  }
}

main();
