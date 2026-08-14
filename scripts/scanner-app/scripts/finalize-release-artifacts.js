#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const contract = require("./package-contract");
const preparation = require("./prepare-macos-package");
const { verifyPackagedApp } = require("./verify-packaged-app");

const CHECKSUM_FILENAME = "SHA256SUMS";
const MANIFEST_FILENAME = "mintvault-scanner-release.json";

function digest(filePath, algorithm, encoding = "hex") {
  return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest(encoding);
}

function exactArtifact(dist, suffix) {
  const matches = fs.readdirSync(dist).filter((name) => name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`expected exactly one ${suffix} artifact, found ${matches.length}`);
  return path.join(dist, matches[0]);
}

function runSensitive(command, args, description) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${description} failed`);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function notarizeAndStapleDmg(dmgPath, env) {
  runSensitive("/usr/bin/xcrun", ["notarytool", "submit", dmgPath, "--wait", ...contract.notarizationArgs(env)], "DMG notarization");
  contract.run("/usr/bin/xcrun", ["stapler", "staple", "-v", dmgPath]);
  contract.run("/usr/bin/xcrun", ["stapler", "validate", "-v", dmgPath]);
  contract.run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath]);
}

function bundleContentDigest(appPath) {
  const hash = crypto.createHash("sha256");
  const visit = (current, relative = "") => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const childRelative = path.posix.join(relative, name);
      const stat = fs.lstatSync(full);
      hash.update(`${childRelative}\0${stat.mode & 0o777}\0`);
      if (stat.isSymbolicLink()) hash.update(`link\0${fs.readlinkSync(full)}\0`);
      else if (stat.isDirectory()) visit(full, childRelative);
      else if (stat.isFile()) hash.update(fs.readFileSync(full));
      else throw new Error(`unsupported bundle entry: ${childRelative}`);
    }
  };
  visit(appPath);
  return hash.digest("hex");
}

function verifyArchiveCopies({ dmgPath, zipPath, appPath, mode }) {
  contract.run("/usr/bin/hdiutil", ["verify", dmgPath]);
  const expectedDigest = bundleContentDigest(appPath);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-package-proof-"));
  const mountPoint = path.join(temporaryRoot, "dmg");
  const zipRoot = path.join(temporaryRoot, "zip");
  fs.mkdirSync(mountPoint, { mode: 0o700 });
  fs.mkdirSync(zipRoot, { mode: 0o700 });
  let mounted = false;
  try {
    contract.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
    mounted = true;
    const dmgApp = path.join(mountPoint, `${contract.PRODUCT_NAME}.app`);
    verifyPackagedApp({ appPath: dmgApp, mode });
    if (bundleContentDigest(dmgApp) !== expectedDigest) throw new Error("DMG app bytes differ from the verified package app");
    contract.run("/usr/bin/ditto", ["-x", "-k", zipPath, zipRoot]);
    const zipApp = path.join(zipRoot, `${contract.PRODUCT_NAME}.app`);
    verifyPackagedApp({ appPath: zipApp, mode });
    if (bundleContentDigest(zipApp) !== expectedDigest) throw new Error("ZIP app bytes differ from the verified package app");
  } finally {
    if (mounted) {
      try { contract.run("/usr/bin/hdiutil", ["detach", mountPoint]); } catch { /* cleanup best-effort after proof failure */ }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return expectedDigest;
}

function validateLatestMac(latestPath, zipPath) {
  const metadata = yaml.load(fs.readFileSync(latestPath, "utf8"));
  const zipName = path.basename(zipPath);
  const zipSize = fs.statSync(zipPath).size;
  const zipSha512 = digest(zipPath, "sha512", "base64");
  if (!metadata || metadata.path !== zipName || metadata.sha512 !== zipSha512 || metadata.files?.length !== 1
      || metadata.files[0]?.url !== zipName || metadata.files[0]?.sha512 !== zipSha512
      || Number(metadata.files[0]?.size) !== zipSize) {
    throw new Error("latest-mac.yml does not bind the exact ZIP bytes");
  }
  return Object.freeze({ metadata, zipSha512 });
}

function normalizeLatestMac(latestPath, zipPath, version) {
  const existing = yaml.load(fs.readFileSync(latestPath, "utf8"));
  const zipName = path.basename(zipPath);
  const zipSize = fs.statSync(zipPath).size;
  const zipSha512 = digest(zipPath, "sha512", "base64");
  const candidate = existing?.files?.find((entry) => entry?.url === zipName);
  if (existing?.version !== version || !candidate || candidate.sha512 !== zipSha512 || Number(candidate.size) !== zipSize) {
    throw new Error("electron-builder update metadata did not bind the generated ZIP");
  }
  const canonical = {
    version,
    files: [{ url: zipName, sha512: zipSha512, size: zipSize }],
    path: zipName,
    sha512: zipSha512,
    releaseDate: existing.releaseDate || new Date().toISOString(),
  };
  contract.atomicWrite(latestPath, yaml.dump(canonical, { lineWidth: -1, noRefs: true, sortKeys: false }));
  return Object.freeze({ metadata: canonical, zipSha512 });
}

function verifyArtifactLedger({ dist, mode }) {
  const dmgPath = exactArtifact(dist, ".dmg");
  const zipPath = exactArtifact(dist, ".zip");
  const latestPath = exactArtifact(dist, "latest-mac.yml");
  const checksumPath = path.join(dist, CHECKSUM_FILENAME);
  const manifestPath = path.join(dist, MANIFEST_FILENAME);
  const latest = validateLatestMac(latestPath, zipPath);
  const expectedChecksums = [dmgPath, zipPath, latestPath]
    .map((filePath) => `${digest(filePath, "sha256")}  ${path.basename(filePath)}`)
    .sort().join("\n") + "\n";
  if (fs.readFileSync(checksumPath, "utf8") !== expectedChecksums) throw new Error("SHA256SUMS does not match the final artifacts");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const release = mode === "release";
  const expectedTeam = release ? contract.releaseTeamAuthority() : contract.LOCAL_TEAM_IDENTIFIER;
  const expectedSigning = {
    teamIdentifier: expectedTeam,
    hardenedRuntime: release,
    notarized: release,
    appStapled: release,
    dmgStapled: release,
    gatekeeperAssessed: release,
  };
  const expectedArtifacts = [
    `MintVault-Scanner-${manifest.app?.version}-arm64.dmg`,
    `MintVault-Scanner-${manifest.app?.version}-arm64.zip`,
    "latest-mac.yml",
  ];
  const actualArtifacts = (manifest.artifacts || []).map((entry) => entry.filename);
  const expectedHelpers = {
    capture: { name: "mv-capture-helper", identifier: contract.CAPTURE_HELPER_IDENTIFIER, version: "1.0.2" },
    identity: { name: "mv-identity-helper", identifier: contract.IDENTITY_HELPER_IDENTIFIER, version: "1.1.2" },
  };
  if (manifest.schemaVersion !== 1 || manifest.packageMode !== mode || manifest.releaseReady !== release
      || !Number.isFinite(Date.parse(manifest.generatedAt))
      || !/^[a-f0-9]{40}$/.test(String(manifest.source?.commit || ""))
      || !new Set(["clean", "dirty"]).has(manifest.source?.treeState)
      || (release && manifest.source.treeState !== "clean")
      || manifest.app?.name !== contract.PRODUCT_NAME
      || manifest.app?.installPath !== `/Applications/${contract.PRODUCT_NAME}.app`
      || !/^\d+\.\d+\.\d+$/.test(String(manifest.app?.version || ""))
      || manifest.app?.bundleIdentifier !== contract.APP_IDENTIFIER
      || manifest.app?.architecture !== contract.ARCHITECTURE || manifest.app?.minimumMacOS !== contract.MINIMUM_MACOS
      || !/^[a-f0-9]{64}$/.test(String(manifest.app?.bundleContentSha256 || ""))
      || JSON.stringify(manifest.signing) !== JSON.stringify(expectedSigning)
      || manifest.update?.metadata !== path.basename(latestPath) || manifest.update?.zipSha512 !== latest.zipSha512
      || latest.metadata.version !== manifest.app?.version
      || manifest.checksums?.filename !== CHECKSUM_FILENAME || manifest.checksums?.sha256 !== digest(checksumPath, "sha256")) {
    throw new Error("MintVault release manifest contract is invalid");
  }
  if (actualArtifacts.length !== new Set(actualArtifacts).size
      || JSON.stringify([...actualArtifacts].sort()) !== JSON.stringify([...expectedArtifacts].sort())
      || path.basename(dmgPath) !== expectedArtifacts[0] || path.basename(zipPath) !== expectedArtifacts[1]) {
    throw new Error("MintVault release manifest artifact names are not exact and unique");
  }
  if (JSON.stringify(Object.keys(manifest.helpers || {}).sort()) !== JSON.stringify(["capture", "identity"])) {
    throw new Error("MintVault release manifest helper set is not exact");
  }
  for (const [name, expected] of Object.entries(expectedHelpers)) {
    const helper = manifest.helpers[name];
    if (helper?.name !== expected.name || helper?.identifier !== expected.identifier || helper?.version !== expected.version
        || !/^[a-f0-9]{64}$/.test(String(helper?.sha256 || ""))) {
      throw new Error(`MintVault release manifest ${name} helper binding is invalid`);
    }
  }
  for (const entry of manifest.artifacts || []) {
    const filePath = path.join(dist, entry.filename);
    if (path.dirname(filePath) !== path.resolve(dist) || !fs.existsSync(filePath) || fs.statSync(filePath).size !== entry.size
        || digest(filePath, "sha256") !== entry.sha256) throw new Error(`release manifest artifact mismatch: ${entry.filename}`);
  }
  return Object.freeze({ ok: true, dmgPath, zipPath, latestPath, checksumPath, manifestPath, manifest });
}

function verifyZipManifestBinding({ zipPath, manifest, mode }) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-release-ledger-"));
  try {
    contract.run("/usr/bin/ditto", ["-x", "-k", zipPath, temporaryRoot]);
    const appPath = path.join(temporaryRoot, `${contract.PRODUCT_NAME}.app`);
    const app = verifyPackagedApp({ appPath, mode });
    return assertManifestAppBinding({ app, appDigest: bundleContentDigest(appPath), manifest, label: "ZIP" });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertManifestAppBinding({ app, appDigest, manifest, label }) {
  if (appDigest !== manifest.app.bundleContentSha256
      || app.helperDigests.capture !== manifest.helpers.capture.sha256
      || app.helperDigests.identity !== manifest.helpers.identity.sha256
      || app.sourceCommit !== manifest.source.commit) {
    throw new Error(`${label} application does not match the MintVault release manifest`);
  }
  return Object.freeze({ ...app, bundleContentSha256: appDigest });
}

function verifyDmgManifestBinding({ dmgPath, manifest, mode }) {
  contract.run("/usr/bin/hdiutil", ["verify", dmgPath]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-release-dmg-ledger-"));
  const mountPoint = path.join(temporaryRoot, "dmg");
  fs.mkdirSync(mountPoint, { mode: 0o700 });
  let mounted = false;
  try {
    contract.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
    mounted = true;
    const appPath = path.join(mountPoint, `${contract.PRODUCT_NAME}.app`);
    const app = verifyPackagedApp({ appPath, mode });
    const bound = assertManifestAppBinding({ app, appDigest: bundleContentDigest(appPath), manifest, label: "DMG" });
    if (mode === "release") {
      contract.run("/usr/bin/xcrun", ["stapler", "validate", "-v", dmgPath]);
      contract.run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath]);
    }
    return bound;
  } finally {
    if (mounted) {
      try { contract.run("/usr/bin/hdiutil", ["detach", mountPoint]); } catch { /* cleanup best-effort after proof failure */ }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertDistributionCopies({ zipApplication, dmgApplication }) {
  if (zipApplication.bundleContentSha256 !== dmgApplication.bundleContentSha256
      || zipApplication.sourceCommit !== dmgApplication.sourceCommit
      || JSON.stringify(zipApplication.helperDigests) !== JSON.stringify(dmgApplication.helperDigests)) {
    throw new Error("DMG and ZIP applications do not contain the same signed MintVault build");
  }
  return true;
}

function verifyArtifactSet({ dist, mode }) {
  const ledger = verifyArtifactLedger({ dist, mode });
  const zipApplication = verifyZipManifestBinding({ zipPath: ledger.zipPath, manifest: ledger.manifest, mode });
  const dmgApplication = verifyDmgManifestBinding({ dmgPath: ledger.dmgPath, manifest: ledger.manifest, mode });
  assertDistributionCopies({ zipApplication, dmgApplication });
  return Object.freeze({ ...ledger, zipApplication, dmgApplication });
}

function finalizeArtifacts({ dist, appPath, mode = contract.packageMode(), env = process.env }) {
  const release = mode === "release";
  const dmgPath = exactArtifact(dist, ".dmg");
  const zipPath = exactArtifact(dist, ".zip");
  const latestPath = exactArtifact(dist, "latest-mac.yml");
  if (release) notarizeAndStapleDmg(dmgPath, env);
  const record = JSON.parse(fs.readFileSync(preparation.PREPARATION_RECORD, "utf8"));
  normalizeLatestMac(latestPath, zipPath, record.version);
  const bundleDigest = verifyArchiveCopies({ dmgPath, zipPath, appPath, mode });
  const { zipSha512 } = validateLatestMac(latestPath, zipPath);
  const artifactPaths = [dmgPath, zipPath, latestPath];
  const checksumPath = path.join(dist, CHECKSUM_FILENAME);
  const checksums = artifactPaths.map((filePath) => `${digest(filePath, "sha256")}  ${path.basename(filePath)}`).sort().join("\n") + "\n";
  contract.atomicWrite(checksumPath, checksums);
  const manifest = {
    schemaVersion: 1,
    packageMode: mode,
    releaseReady: release,
    generatedAt: new Date().toISOString(),
    source: { commit: record.sourceCommit, treeState: record.sourceTreeState },
    app: {
      name: contract.PRODUCT_NAME,
      installPath: `/Applications/${contract.PRODUCT_NAME}.app`,
      version: record.version,
      bundleIdentifier: contract.APP_IDENTIFIER,
      architecture: contract.ARCHITECTURE,
      minimumMacOS: contract.MINIMUM_MACOS,
      bundleContentSha256: bundleDigest,
    },
    signing: {
      teamIdentifier: record.teamIdentifier,
      hardenedRuntime: release,
      notarized: release,
      appStapled: release,
      dmgStapled: release,
      gatekeeperAssessed: release,
    },
    helpers: record.helpers,
    update: { metadata: path.basename(latestPath), zipSha512 },
    artifacts: artifactPaths.map((filePath) => ({
      filename: path.basename(filePath),
      size: fs.statSync(filePath).size,
      sha256: digest(filePath, "sha256"),
    })),
    checksums: { filename: CHECKSUM_FILENAME, sha256: digest(checksumPath, "sha256") },
  };
  const manifestPath = path.join(dist, MANIFEST_FILENAME);
  contract.atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyArtifactSet({ dist, mode });
}

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));
  const appPath = path.resolve(process.argv[3] || path.join(dist, "mac-arm64", `${contract.PRODUCT_NAME}.app`));
  process.stdout.write(`${JSON.stringify(finalizeArtifacts({ dist, appPath }))}\n`);
}

module.exports = {
  finalizeArtifacts,
  verifyArtifactSet,
  verifyArtifactLedger,
  verifyZipManifestBinding,
  verifyDmgManifestBinding,
  assertManifestAppBinding,
  assertDistributionCopies,
  validateLatestMac,
  normalizeLatestMac,
  verifyArchiveCopies,
  bundleContentDigest,
  exactArtifact,
  digest,
  CHECKSUM_FILENAME,
  MANIFEST_FILENAME,
};
