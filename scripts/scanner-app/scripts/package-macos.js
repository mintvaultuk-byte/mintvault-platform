#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const contract = require("./package-contract");
const preparation = require("./prepare-macos-package");
const { verifyPackagedApp } = require("./verify-packaged-app");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function parse(argv) {
  if (argv.length !== 1 || !new Set(["--dir", "--local", "--release"]).has(argv[0])) {
    throw new Error("usage: package-macos.js --dir|--local|--release");
  }
  return Object.freeze({ mode: argv[0] === "--release" ? "release" : "local", directoryOnly: argv[0] === "--dir" });
}

function ensureExactDistPath() {
  const expected = path.join(ROOT, "dist");
  if (DIST !== expected || path.dirname(DIST) !== ROOT || path.basename(DIST) !== "dist") throw new Error("refusing unsafe package output cleanup");
}

function packageMac(argv = process.argv.slice(2)) {
  contract.requireDarwinArm64();
  const options = parse(argv);
  ensureExactDistPath();
  fs.rmSync(DIST, { recursive: true, force: true });
  const env = { ...process.env, MINTVAULT_PACKAGE_MODE: options.mode, MINTVAULT_PREPARATION_ID: crypto.randomUUID() };
  process.env.MINTVAULT_PACKAGE_MODE = env.MINTVAULT_PACKAGE_MODE;
  process.env.MINTVAULT_PREPARATION_ID = env.MINTVAULT_PREPARATION_ID;
  preparation.prepare(env);
  contract.run(process.execPath, [path.join(__dirname, "build-native-helpers.js")], { cwd: ROOT, env, stdio: "inherit" });
  preparation.sealPreparation(env);
  const builder = path.join(ROOT, "node_modules", ".bin", "electron-builder");
  const args = ["--config", "electron-builder.config.js", "--arm64", "--publish", "never"];
  if (options.directoryOnly) args.push("--dir");
  else args.push("--mac", "dmg", "zip");
  contract.run(builder, args, { cwd: ROOT, env, stdio: "inherit" });
  const appPath = path.join(DIST, "mac-arm64", `${contract.PRODUCT_NAME}.app`);
  const appEvidence = verifyPackagedApp({ appPath, mode: options.mode });
  if (options.directoryOnly) return Object.freeze({ ok: true, directoryOnly: true, app: appEvidence });
  const { finalizeArtifacts } = require("./finalize-release-artifacts");
  return Object.freeze({ ok: true, directoryOnly: false, app: appEvidence, artifacts: finalizeArtifacts({ dist: DIST, appPath, mode: options.mode, env }) });
}

if (require.main === module) process.stdout.write(`${JSON.stringify(packageMac())}\n`);

module.exports = { packageMac, parse, ensureExactDistPath, ROOT, DIST };
