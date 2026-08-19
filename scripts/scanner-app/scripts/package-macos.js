#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const PACKAGE_JSON = require(path.join(APP_ROOT, "package.json"));
const ELECTRON_APP = path.join(APP_ROOT, "node_modules", "electron", "dist", "Electron.app");
const DIST_ROOT = path.join(APP_ROOT, "dist");
const OUT_ROOT = path.join(DIST_ROOT, "mac-arm64");
const OUT_APP = path.join(OUT_ROOT, "MintVault Scanner.app");
const OUT_RESOURCES = path.join(OUT_APP, "Contents", "Resources");
const OUT_APP_RESOURCES = path.join(OUT_RESOURCES, "app");
const OUT_SHARED = path.join(OUT_APP, "Contents", "shared");
const OUT_MACOS = path.join(OUT_APP, "Contents", "MacOS");
const OUT_EXECUTABLE = path.join(OUT_MACOS, "MintVault Scanner");
const OUT_BRIDGE = path.join(OUT_APP_RESOURCES, "native", "mintvault-lide-bridge");
const BRIDGE_SOURCE = path.join(APP_ROOT, "native", "mintvault-lide-bridge.m");
const SHARED_SOURCE = path.join(REPO_ROOT, "shared");
const MANIFEST = path.join(OUT_ROOT, "mintvault-scanner-package-manifest.json");

function rel(file) {
  return path.relative(APP_ROOT, file) || ".";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || APP_ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const details = options.capture ? result.stderr || result.stdout : "";
    throw new Error(`${command} ${args.join(" ")} failed${details ? `: ${details.trim()}` : ""}`);
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function assertInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`Refusing to operate outside ${resolvedParent}: ${resolvedChild}`);
  }
}

function resetOutput() {
  assertInside(APP_ROOT, OUT_ROOT);
  assertInside(DIST_ROOT, OUT_APP);
  fs.mkdirSync(DIST_ROOT, { recursive: true });
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_ROOT, { recursive: true });
}

function shouldExclude(relativePath) {
  if (!relativePath) return false;
  const parts = relativePath.split(path.sep);
  const basename = parts.at(-1);
  if (parts[0] === "dist") return true;
  if (parts[0] === "scripts") return true;
  if (parts[0] === "test") return true;
  if (parts[0] === "node_modules" && parts[1] === "electron") return true;
  if (parts[0] === "node_modules" && parts[1] === "@electron") return true;
  if (parts[0] === "node_modules" && parts[1] === ".bin" && basename === "electron") return true;
  if (basename === ".DS_Store") return true;
  if (basename && basename.endsWith(".log")) return true;
  if (basename === "experiment-lide400-quality.js") return true;
  return false;
}

function copyRecursive(source, destination, root = source) {
  const relativePath = path.relative(root, source);
  if (shouldExclude(relativePath)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry), root);
    }
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode & 0o777);
  }
}

function plistSet(key, value) {
  run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, path.join(OUT_APP, "Contents", "Info.plist")]);
}

function rewriteBundleMetadata() {
  const electronExecutable = path.join(OUT_MACOS, "Electron");
  if (!fs.existsSync(electronExecutable)) throw new Error("Electron bundle executable is missing");
  fs.renameSync(electronExecutable, OUT_EXECUTABLE);
  plistSet("CFBundleDisplayName", "MintVault Scanner");
  plistSet("CFBundleName", "MintVault Scanner");
  plistSet("CFBundleExecutable", "MintVault Scanner");
  plistSet("CFBundleIdentifier", "com.mintvault.scanner");
  plistSet("CFBundleShortVersionString", PACKAGE_JSON.version);
  plistSet("CFBundleVersion", PACKAGE_JSON.version);
  fs.chmodSync(OUT_EXECUTABLE, 0o755);
}

function compileBridge() {
  if (process.platform !== "darwin") {
    throw new Error("macOS scanner package builds require ImageCaptureCore and xcrun clang");
  }
  if (!fs.existsSync(BRIDGE_SOURCE)) throw new Error(`Native bridge source is missing: ${rel(BRIDGE_SOURCE)}`);
  fs.mkdirSync(path.dirname(OUT_BRIDGE), { recursive: true });
  run("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-fmodules",
    "-framework",
    "Foundation",
    "-framework",
    "ImageCaptureCore",
    BRIDGE_SOURCE,
    "-o",
    OUT_BRIDGE,
  ]);
  fs.chmodSync(OUT_BRIDGE, 0o755);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function digestTree(root) {
  const hash = crypto.createHash("sha256");
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, entry);
      const relative = path.relative(root, file);
      const stat = fs.lstatSync(file);
      hash.update(relative);
      if (stat.isSymbolicLink()) {
        hash.update("symlink");
        hash.update(fs.readlinkSync(file));
      } else if (stat.isDirectory()) {
        hash.update("directory");
        visit(file);
      } else if (stat.isFile()) {
        hash.update("file");
        hash.update(fs.readFileSync(file));
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function git(command, args, allowFailure = false) {
  const result = run(command, args, { cwd: REPO_ROOT, capture: true, allowFailure });
  return result.status === 0 ? result.stdout.trim() : null;
}

function signingBoundary() {
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], {
    capture: true,
    allowFailure: true,
  });
  const developerIdAvailable = /Developer ID Application/.test(identities.stdout);
  return {
    status: "unsigned",
    developerIdApplicationIdentityDetected: developerIdAvailable,
    reason: process.env.MINTVAULT_MACOS_CODESIGN_IDENTITY
      ? "MINTVAULT_MACOS_CODESIGN_IDENTITY is set but signing is not performed by this package script; use the controlled release signing step."
      : "Developer ID signing/notarisation credentials were not provided to this local packaging pass.",
  };
}

function writeManifest() {
  const trackedDiff = git("git", ["diff", "--quiet"], true);
  const stagedDiff = git("git", ["diff", "--cached", "--quiet"], true);
  const manifest = {
    package: "MintVault Scanner.app",
    packageVersion: PACKAGE_JSON.version,
    builtAt: new Date().toISOString(),
    buildHost: {
      platform: process.platform,
      arch: process.arch,
      electron: PACKAGE_JSON.devDependencies?.electron || null,
    },
    source: {
      commit: git("git", ["rev-parse", "HEAD"], true),
      trackedTreeClean: trackedDiff !== null && stagedDiff !== null,
      statusShort: git("git", ["status", "--short"], true),
    },
    bundle: {
      path: OUT_APP,
      digestSha256: digestTree(OUT_APP),
      bundleIdentifier: "com.mintvault.scanner",
      executable: path.relative(OUT_APP, OUT_EXECUTABLE),
    },
    nativeBridge: {
      source: rel(BRIDGE_SOURCE),
      packagedPath: path.relative(OUT_APP, OUT_BRIDGE),
      sha256: sha256(OUT_BRIDGE),
      executable: true,
      runtimeCompilationRequired: false,
    },
    sharedCanon: {
      packagedPath: path.relative(OUT_APP, OUT_SHARED),
      digestSha256: digestTree(OUT_SHARED),
      modules: ["lide400-capture-profile.cjs", "lide400-card-geometry.cjs"],
    },
    runtimeRequirements: {
      partnerMacRequiresNode: false,
      partnerMacRequiresNpm: false,
      partnerMacRequiresGit: false,
      partnerMacRequiresXcodeOrClang: false,
    },
    signing: signingBoundary(),
    notarisation: {
      status: "not_attempted",
      reason: "Apple notarisation credentials and Developer ID release ceremony are external owner-controlled prerequisites.",
    },
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

function main() {
  if (!fs.existsSync(ELECTRON_APP)) {
    throw new Error("Electron.app is missing; run npm install in scripts/scanner-app on the build machine");
  }
  resetOutput();
  copyRecursive(ELECTRON_APP, OUT_APP);
  rewriteBundleMetadata();
  copyRecursive(APP_ROOT, OUT_APP_RESOURCES);
  copyRecursive(SHARED_SOURCE, OUT_SHARED);
  compileBridge();
  const manifest = writeManifest();
  console.log(`Built ${manifest.bundle.path}`);
  console.log(`Bridge SHA-256 ${manifest.nativeBridge.sha256}`);
  console.log(`Manifest ${MANIFEST}`);
}

main();
