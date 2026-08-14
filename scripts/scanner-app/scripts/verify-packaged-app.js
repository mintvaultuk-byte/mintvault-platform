#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");
const contract = require("./package-contract");

const MAX_TEXT_SCAN_BYTES = 4 * 1024 * 1024;
const REQUIRED_HELPER_FILES = Object.freeze([
  "mv-capture-helper",
  "mv-identity-helper",
]);
const REQUIRED_HELPER_MANIFESTS = Object.freeze(["helper-manifest.json", "identity-helper-manifest.json"]);
const FORBIDDEN_BUNDLE_NAMES = Object.freeze(new Set([
  ".env", ".git", "package-lock.json", "install.sh", "setup-new-mac.sh",
  "launchd-wrapper.sh", "reset-agent.sh", "update.sh", "uninstall.sh",
  "com.mintvault.scanner-app.plist", "clang", "xcrun", "npm", "npx",
]));
const FORBIDDEN_BUILD_PATH = /(^|\/)(build|docs?|examples?|install|native|scripts?|sources?|src|tests?)(\/|$)/i;
const FORBIDDEN_DEPENDENCY_PATH = /(^|\/)(build|docs?|examples?|install|tests?)(\/|$)/i;
const FORBIDDEN_BUILD_EXTENSION = /\.(?:c|cc|cpp|d\.ts|gyp|h|hpp|m|mk|swift)$/i;

function isForbiddenRuntimeEntry(entry) {
  const normalized = String(entry).replace(/^\//, "");
  const dependency = normalized.startsWith("node_modules/");
  return (dependency ? FORBIDDEN_DEPENDENCY_PATH : FORBIDDEN_BUILD_PATH).test(normalized)
    || FORBIDDEN_BUILD_EXTENSION.test(normalized);
}

function command(commandPath, args) {
  const result = spawnSync(commandPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(commandPath)} verification failed`);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function regularFile(filePath, description) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description} must be a regular file`);
  return stat;
}

function plistValue(plistPath, key) {
  return command("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]).trim();
}

function signatureDetails(filePath) {
  const output = command("/usr/bin/codesign", ["-d", "--verbose=4", filePath]);
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  return Object.freeze({
    identifier: /^Identifier=(.+)$/m.exec(output)?.[1]?.trim() || "",
    teamIdentifier: team === "not set" ? "" : team,
    hardenedRuntime: /\bflags=0x[0-9a-f]+\(runtime\)/i.test(output),
  });
}

function walk(root) {
  const output = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      output.push(full);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(full);
    }
  };
  visit(root);
  return output;
}

function versionAtMost(value, maximum) {
  const a = String(value).split(".").map(Number);
  const b = String(maximum).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) < (b[index] || 0)) return true;
    if ((a[index] || 0) > (b[index] || 0)) return false;
  }
  return true;
}

function verifyMachO(filePath) {
  const description = command("/usr/bin/file", ["-b", filePath]);
  if (!description.includes("Mach-O")) return false;
  const architectures = command("/usr/bin/lipo", ["-archs", filePath]).trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== contract.ARCHITECTURE) {
    throw new Error(`non-arm64 Mach-O in package: ${filePath}`);
  }
  const buildVersion = command("/usr/bin/vtool", ["-show-build", filePath]);
  const minimums = [...buildVersion.matchAll(/^\s*minos\s+([0-9.]+)$/gm)].map((match) => match[1]);
  if (minimums.length === 0 || minimums.some((minimum) => !versionAtMost(minimum, contract.MINIMUM_MACOS))) {
    throw new Error(`Mach-O deployment target exceeds macOS ${contract.MINIMUM_MACOS}: ${filePath}`);
  }
  return true;
}

function verifyManifest(helperRoot, manifestRoot, manifestName, helperName, expectedIdentifier, { mode, teamIdentifier }) {
  const manifestPath = path.join(manifestRoot, manifestName);
  const helperPath = path.join(helperRoot, helperName);
  regularFile(manifestPath, manifestName);
  const helperStat = regularFile(helperPath, helperName);
  if ((helperStat.mode & 0o111) === 0) throw new Error(`${helperName} is not executable`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.helperName !== helperName || manifest.bundleIdentifier !== expectedIdentifier
      || manifest.architecture !== contract.ARCHITECTURE || manifest.minimumMacOS !== contract.MINIMUM_MACOS
      || manifest.sha256 !== sha256(helperPath)
      || !/^[a-f0-9]{40}$/.test(String(manifest.packageBinding?.sourceCommit || ""))
      || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(String(manifest.packageBinding?.preparationId || ""))
      || manifest.packageBinding?.packageMode !== mode || manifest.packageBinding?.teamIdentifier !== teamIdentifier) {
    throw new Error(`${helperName} does not match its sealed package manifest`);
  }
  return Object.freeze({ helperPath, manifest });
}

function verifyAsar(asarPath, { expectedTeamIdentifier, mode }) {
  regularFile(asarPath, "app.asar");
  const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/^\//, ""));
  const roots = new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean));
  const allowedRoots = new Set(["assets", "generated", "lib", "main.js", "node_modules", "package.json", "preload.js", "renderer"]);
  for (const root of roots) if (!allowedRoots.has(root)) throw new Error(`unexpected ASAR root: ${root}`);
  for (const required of ["generated/release-team-pin.js", "main.js", "preload.js", "package.json", "renderer/index.html"]) {
    if (!entries.includes(required)) throw new Error(`required ASAR runtime entry is missing: ${required}`);
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const base = path.posix.basename(lower);
    if (FORBIDDEN_BUNDLE_NAMES.has(base) || isForbiddenRuntimeEntry(lower)
        || /\.(pem|key|p12|mobileprovision|map)$/.test(lower) || lower.includes("agent-plist")) {
      throw new Error(`forbidden ASAR entry: ${entry}`);
    }
    if (!/\.(js|json|html|css|txt|md|jpg|jpeg|png|svg|node|dylib)$/.test(lower)) continue;
    let content;
    try { content = asar.extractFile(asarPath, entry); } catch { continue; }
    if (content.length > MAX_TEXT_SCAN_BYTES || content.includes(0)) continue;
    const text = content.toString("utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /postgres(?:ql)?:\/\/[^\s'\"]+:[^\s'\"]+@/i.test(text)) {
      throw new Error(`secret or database credential pattern in ASAR: ${entry}`);
    }
  }
  const generatedEntries = entries.filter((entry) => entry.startsWith("generated/"));
  if (JSON.stringify(generatedEntries) !== JSON.stringify(["generated/release-team-pin.js"])) {
    throw new Error("ASAR generated runtime authority set is not exact");
  }
  const pinSource = asar.extractFile(asarPath, "generated/release-team-pin.js").toString("utf8");
  const pinMatch = /^module\.exports = Object\.freeze\((\{.*\})\);\n$/.exec(pinSource);
  let pin;
  try { pin = JSON.parse(pinMatch?.[1] || ""); } catch { throw new Error("packaged runtime Team pin is invalid"); }
  if (pin.schemaVersion !== 1 || pin.appIdentifier !== contract.APP_IDENTIFIER
      || pin.teamIdentifier !== expectedTeamIdentifier || pin.packageMode !== mode) {
    throw new Error("packaged runtime Team pin does not match the verified release authority");
  }
  const runtimePackage = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  const runtimeEntrypoints = [];
  for (const dependency of Object.keys(runtimePackage.dependencies || {})) {
    const packagePath = `node_modules/${dependency}/package.json`;
    if (!entries.includes(packagePath)) throw new Error(`packaged dependency metadata is missing: ${dependency}`);
    const metadata = JSON.parse(asar.extractFile(asarPath, packagePath).toString("utf8"));
    const entrypoint = String(metadata.main || "index.js").replace(/^\.\//, "");
    const candidates = [
      `node_modules/${dependency}/${entrypoint}`,
      `node_modules/${dependency}/${entrypoint}.js`,
      `node_modules/${dependency}/${entrypoint}/index.js`,
    ];
    const selected = candidates.find((candidate) => entries.includes(candidate));
    if (!selected) {
      throw new Error(`packaged dependency runtime entrypoint is missing: ${dependency}/${entrypoint}`);
    }
    runtimeEntrypoints.push(selected);
  }
  return Object.freeze({ entries, runtimeEntrypoints });
}

function verifyPackagedRuntimeImports(executablePath, asarPath, runtimeEntrypoints) {
  regularFile(executablePath, "packaged Electron executable");
  const script = [
    'const { pathToFileURL } = require("node:url");',
    'const path = require("node:path");',
    'const root = process.env.MINTVAULT_VERIFIED_ASAR;',
    'const entries = JSON.parse(process.env.MINTVAULT_RUNTIME_ENTRYPOINTS);',
    'Promise.all(entries.map((entry) => import(pathToFileURL(path.join(root, entry)).href)))',
    '  .then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });',
  ].join("\n");
  const result = spawnSync(executablePath, ["-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MINTVAULT_VERIFIED_ASAR: asarPath,
      MINTVAULT_RUNTIME_ENTRYPOINTS: JSON.stringify(runtimeEntrypoints),
    },
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.error?.message || ""}\n${result.stderr || ""}`.trim().replace(/\s+/g, " ").slice(0, 800);
    throw new Error(`packaged production dependency import smoke check failed${detail ? `: ${detail}` : ""}`);
  }
  return true;
}

function verifyPackagedApp({ appPath, mode = contract.packageMode() }) {
  contract.requireDarwinArm64();
  const release = mode === "release";
  const absoluteApp = path.resolve(appPath);
  if (path.basename(absoluteApp) !== `${contract.PRODUCT_NAME}.app`) throw new Error("packaged app has the wrong install name");
  const contents = path.join(absoluteApp, "Contents");
  const resources = path.join(contents, "Resources");
  const helperRoot = path.join(contents, "Helpers");
  const manifestRoot = path.join(resources, "helper-manifests");
  const plist = path.join(contents, "Info.plist");
  if (plistValue(plist, "CFBundleIdentifier") !== contract.APP_IDENTIFIER) throw new Error("packaged bundle identifier is wrong");
  if (plistValue(plist, "CFBundleName") !== contract.PRODUCT_NAME) throw new Error("packaged bundle name is wrong");
  if (plistValue(plist, "CFBundleExecutable") !== contract.PRODUCT_NAME) throw new Error("packaged executable name is wrong");
  if (plistValue(plist, "LSMinimumSystemVersion") !== contract.MINIMUM_MACOS) throw new Error("packaged minimum macOS is wrong");
  if (plistValue(plist, "LSUIElement") !== "true") throw new Error("packaged app is not menu-bar-only");
  const iconName = plistValue(plist, "CFBundleIconFile");
  if (iconName !== "icon.icns") throw new Error("packaged app icon contract is wrong");
  regularFile(path.join(resources, iconName), "MintVault application icon");

  const trustPath = path.join(resources, "release-trust.json");
  regularFile(trustPath, "release-trust.json");
  const trust = JSON.parse(fs.readFileSync(trustPath, "utf8"));
  if (trust.schemaVersion !== 1 || trust.appIdentifier !== contract.APP_IDENTIFIER || trust.architecture !== contract.ARCHITECTURE
      || trust.minimumMacOS !== contract.MINIMUM_MACOS || trust.packageMode !== mode
      || trust.version !== plistValue(plist, "CFBundleShortVersionString")) {
    throw new Error("release trust contract does not match the app bundle");
  }
  const expectedTeam = release ? contract.releaseTeamAuthority() : contract.LOCAL_TEAM_IDENTIFIER;
  if (trust.teamIdentifier !== expectedTeam) throw new Error("release trust Team ID is wrong");

  const helperEntries = fs.readdirSync(helperRoot).sort();
  if (JSON.stringify(helperEntries) !== JSON.stringify([...REQUIRED_HELPER_FILES].sort())) {
    throw new Error("Contents/Helpers must contain exactly the frozen helper contract");
  }
  const manifestEntries = fs.readdirSync(manifestRoot).sort();
  if (JSON.stringify(manifestEntries) !== JSON.stringify([...REQUIRED_HELPER_MANIFESTS].sort())) {
    throw new Error("Resources/helper-manifests must contain exactly the sealed helper manifests");
  }
  const capture = verifyManifest(helperRoot, manifestRoot, "helper-manifest.json", "mv-capture-helper", contract.CAPTURE_HELPER_IDENTIFIER, { mode, teamIdentifier: expectedTeam });
  const identity = verifyManifest(helperRoot, manifestRoot, "identity-helper-manifest.json", "mv-identity-helper", contract.IDENTITY_HELPER_IDENTIFIER, { mode, teamIdentifier: expectedTeam });
  if (capture.manifest.packageBinding.sourceCommit !== identity.manifest.packageBinding.sourceCommit
      || capture.manifest.packageBinding.preparationId !== identity.manifest.packageBinding.preparationId) {
    throw new Error("packaged helpers do not share one immutable source/preparation binding");
  }
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", absoluteApp]);
  const appSignature = signatureDetails(absoluteApp);
  const captureSignature = signatureDetails(capture.helperPath);
  const identitySignature = signatureDetails(identity.helperPath);
  if (appSignature.identifier !== contract.APP_IDENTIFIER || captureSignature.identifier !== contract.CAPTURE_HELPER_IDENTIFIER
      || identitySignature.identifier !== contract.IDENTITY_HELPER_IDENTIFIER) {
    throw new Error("app or helper signing identifier is wrong");
  }
  if (release) {
    for (const signature of [appSignature, captureSignature, identitySignature]) {
      if (signature.teamIdentifier !== expectedTeam || !signature.hardenedRuntime) throw new Error("release signature Team/hardened-runtime contract failed");
    }
    const entitlements = command("/usr/bin/codesign", ["-d", "--entitlements", ":-", identity.helperPath]);
    if (!entitlements.includes(`<string>${expectedTeam}.${contract.APP_IDENTIFIER}</string>`)) {
      throw new Error("identity helper Keychain access-group entitlement is wrong");
    }
    command("/usr/bin/xcrun", ["stapler", "validate", "-v", absoluteApp]);
    command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", absoluteApp]);
  } else if (appSignature.teamIdentifier || appSignature.hardenedRuntime || captureSignature.teamIdentifier || identitySignature.teamIdentifier) {
    throw new Error("local structural package must remain explicitly ad-hoc and non-releasable");
  }

  const asarPath = path.join(resources, "app.asar");
  const asarProof = verifyAsar(asarPath, { expectedTeamIdentifier: expectedTeam, mode });
  verifyPackagedRuntimeImports(path.join(contents, "MacOS", contract.PRODUCT_NAME), asarPath, asarProof.runtimeEntrypoints);
  const bundleEntries = walk(absoluteApp);
  for (const entry of bundleEntries) {
    const base = path.basename(entry).toLowerCase();
    if (FORBIDDEN_BUNDLE_NAMES.has(base) || /\.(m|swift|p12|mobileprovision)$/.test(base)) {
      throw new Error(`forbidden packaged file: ${entry}`);
    }
    const relative = path.relative(resources, entry).split(path.sep).join("/");
    if (relative.startsWith("app.asar.unpacked/")
        && (FORBIDDEN_BUILD_PATH.test(relative) || FORBIDDEN_BUILD_EXTENSION.test(relative))) {
      throw new Error(`build/source material escaped ASAR into the package: ${relative}`);
    }
  }
  const machOCount = bundleEntries.filter((entry) => fs.lstatSync(entry).isFile()).reduce((count, entry) => count + (verifyMachO(entry) ? 1 : 0), 0);
  if (machOCount < 3) throw new Error("packaged Mach-O inventory is unexpectedly empty");
  return Object.freeze({
    ok: true,
    appPath: absoluteApp,
    mode,
    teamIdentifier: expectedTeam,
    sourceCommit: capture.manifest.packageBinding.sourceCommit,
    preparationId: capture.manifest.packageBinding.preparationId,
    machOCount,
    helperDigests: { capture: capture.manifest.sha256, identity: identity.manifest.sha256 },
  });
}

function defaultAppPath() {
  return path.resolve(__dirname, "..", "dist", "mac-arm64", `${contract.PRODUCT_NAME}.app`);
}

if (require.main === module) {
  const appPath = process.argv[2] || defaultAppPath();
  process.stdout.write(`${JSON.stringify(verifyPackagedApp({ appPath }))}\n`);
}

module.exports = { verifyPackagedApp, verifyAsar, verifyPackagedRuntimeImports, verifyMachO, versionAtMost, isForbiddenRuntimeEntry, defaultAppPath, REQUIRED_HELPER_FILES, REQUIRED_HELPER_MANIFESTS, FORBIDDEN_BUNDLE_NAMES, FORBIDDEN_BUILD_PATH, FORBIDDEN_DEPENDENCY_PATH, FORBIDDEN_BUILD_EXTENSION };
