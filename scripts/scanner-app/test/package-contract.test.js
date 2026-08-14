const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const contract = require("../scripts/package-contract");
const builder = require("../electron-builder.config");
const beforePack = require("../scripts/before-pack");
const { parse, ensureExactDistPath } = require("../scripts/package-macos");
const { isForbiddenRuntimeEntry } = require("../scripts/verify-packaged-app");
const {
  digest,
  validateLatestMac,
  normalizeLatestMac,
  verifyArtifactLedger,
  bundleContentDigest,
  assertManifestAppBinding,
  assertDistributionCopies,
  CHECKSUM_FILENAME,
  MANIFEST_FILENAME,
} = require("../scripts/finalize-release-artifacts");

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-package-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function artifactFixture(t) {
  const dist = temporaryDirectory(t);
  const dmgPath = path.join(dist, "MintVault-Scanner-1.2.1-arm64.dmg");
  const zipPath = path.join(dist, "MintVault-Scanner-1.2.1-arm64.zip");
  const latestPath = path.join(dist, "latest-mac.yml");
  fs.writeFileSync(dmgPath, "dmg bytes");
  fs.writeFileSync(zipPath, "zip bytes");
  const zipSha512 = digest(zipPath, "sha512", "base64");
  fs.writeFileSync(latestPath, yaml.dump({
    version: "1.2.1",
    files: [{ url: path.basename(zipPath), sha512: zipSha512, size: fs.statSync(zipPath).size }],
    path: path.basename(zipPath),
    sha512: zipSha512,
    releaseDate: "2026-08-14T00:00:00.000Z",
  }));
  const artifactPaths = [dmgPath, zipPath, latestPath];
  const checksumPath = path.join(dist, CHECKSUM_FILENAME);
  fs.writeFileSync(checksumPath, artifactPaths.map((filePath) => `${digest(filePath, "sha256")}  ${path.basename(filePath)}`).sort().join("\n") + "\n");
  const manifest = {
    schemaVersion: 1,
    packageMode: "local",
    releaseReady: false,
    generatedAt: "2026-08-14T00:00:00.000Z",
    source: { commit: "a".repeat(40), treeState: "dirty" },
    app: {
      name: contract.PRODUCT_NAME,
      installPath: `/Applications/${contract.PRODUCT_NAME}.app`,
      version: "1.2.1",
      bundleIdentifier: contract.APP_IDENTIFIER,
      architecture: "arm64",
      minimumMacOS: "12.0",
      bundleContentSha256: "b".repeat(64),
    },
    signing: {
      teamIdentifier: contract.LOCAL_TEAM_IDENTIFIER,
      hardenedRuntime: false,
      notarized: false,
      appStapled: false,
      dmgStapled: false,
      gatekeeperAssessed: false,
    },
    helpers: {
      capture: { name: "mv-capture-helper", identifier: contract.CAPTURE_HELPER_IDENTIFIER, version: "1.0.2", sha256: "c".repeat(64) },
      identity: { name: "mv-identity-helper", identifier: contract.IDENTITY_HELPER_IDENTIFIER, version: "1.1.2", sha256: "d".repeat(64) },
    },
    update: { metadata: path.basename(latestPath), zipSha512 },
    artifacts: artifactPaths.map((filePath) => ({ filename: path.basename(filePath), size: fs.statSync(filePath).size, sha256: digest(filePath, "sha256") })),
    checksums: { filename: CHECKSUM_FILENAME, sha256: digest(checksumPath, "sha256") },
  };
  fs.writeFileSync(path.join(dist, MANIFEST_FILENAME), `${JSON.stringify(manifest)}\n`);
  return { dist, dmgPath, zipPath, latestPath, checksumPath };
}

test("builder freezes the product identity, arm64 floor and Contents/Helpers layout", () => {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(packageMetadata.dependencies["electron-updater"], "6.8.9");
  assert.equal(builder.appId, "com.mintvault.scanner");
  assert.equal(builder.productName, "MintVault Scanner");
  assert.equal(builder.mac.minimumSystemVersion, "12.0");
  assert.equal(path.basename(builder.mac.icon), "scanner.icns");
  assert.equal(fs.readFileSync(builder.mac.icon, "ascii", 0, 4).slice(0, 4), "icns");
  assert.equal(builder.mac.identity, "-");
  assert.equal(builder.mac.hardenedRuntime, false);
  assert.deepEqual(builder.mac.target.flatMap((target) => target.arch), ["arm64", "arm64"]);
  assert.deepEqual(builder.extraFiles.map((entry) => entry.to).sort(), ["Helpers/mv-capture-helper", "Helpers/mv-identity-helper"]);
  assert.deepEqual(builder.extraResources.map((entry) => entry.to).sort(), [
    "helper-manifests/helper-manifest.json",
    "helper-manifests/identity-helper-manifest.json",
    "release-trust.json",
  ]);
  assert.ok(builder.files.includes("!lib/agent-plist.js"));
  assert.deepEqual(builder.asarUnpack, [
    "node_modules/@img/sharp-darwin-arm64/lib/*.node",
    "node_modules/@img/sharp-libvips-darwin-arm64/lib/*.dylib",
  ]);
  assert.ok(builder.mac.signIgnore.every((pattern) => pattern.includes("/Contents/Helpers/")));
});

test("production entitlements stay minimal and reject known unsafe exceptions", () => {
  for (const name of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "build", name), "utf8");
    assert.match(source, /com\.apple\.security\.cs\.allow-jit/);
    assert.doesNotMatch(source, /disable-library-validation|get-task-allow|allow-unsigned-executable-memory|DYLD/);
  }
});

test("release inputs reject weak identity, URL and notarization states before tool use", () => {
  assert.equal(contract.validateTeamIdentifier("ABC123XYZ9"), "ABC123XYZ9");
  assert.throws(() => contract.validateTeamIdentifier("abc123"), /exactly 10/);
  assert.equal(contract.validateUpdateBaseUrl("https://updates.mintvault.example/scanner/", { release: true }), "https://updates.mintvault.example/scanner");
  assert.throws(() => contract.validateUpdateBaseUrl("http://updates.example/scanner", { release: true }), /credential-free HTTPS/);
  assert.throws(() => contract.validateUpdateBaseUrl("https://updates.invalid/scanner", { release: true }), /production MintVault/);
  assert.throws(() => contract.notarizationCredentials({ APPLE_API_KEY: "key" }), /incomplete/);
  assert.throws(() => contract.notarizationCredentials({}), /exactly one/);
  assert.deepEqual(contract.notarizationCredentials({ APPLE_KEYCHAIN_PROFILE: "mintvault-notary" }), { kind: "keychain-profile" });
  assert.throws(() => contract.validateReleaseTeamAuthority({
    schemaVersion: 1,
    appIdentifier: contract.APP_IDENTIFIER,
    status: "OWNER_REQUIRED",
    teamIdentifier: null,
  }), /not owner-pinned/);
  assert.equal(contract.validateReleaseTeamAuthority({
    schemaVersion: 1,
    appIdentifier: contract.APP_IDENTIFIER,
    status: "PINNED",
    teamIdentifier: "ABC123XYZ9",
  }), "ABC123XYZ9");

  const checkedInAuthority = JSON.parse(fs.readFileSync(contract.RELEASE_AUTHORITY_PATH, "utf8"));
  if (checkedInAuthority.status === "PINNED") {
    assert.equal(contract.releaseTeamAuthority(), checkedInAuthority.teamIdentifier);
    assert.throws(() => contract.validateReleaseEnvironment({
      MINTVAULT_APPLE_TEAM_ID: checkedInAuthority.teamIdentifier === "ABC123XYZ9" ? "ZZZ123XYZ9" : "ABC123XYZ9",
      MINTVAULT_DEVELOPER_ID_APPLICATION: "-",
      APPLE_KEYCHAIN_PROFILE: "mintvault-notary",
    }), /does not match/);
  } else {
    assert.throws(() => contract.releaseTeamAuthority(), /not owner-pinned/);
    assert.throws(() => contract.validateReleaseEnvironment({
      MINTVAULT_APPLE_TEAM_ID: "ABC123XYZ9",
      MINTVAULT_DEVELOPER_ID_APPLICATION: "-",
      APPLE_KEYCHAIN_PROFILE: "mintvault-notary",
    }), /not owner-pinned/);
  }
});

test("package CLI has only explicit local-structural and release modes", () => {
  assert.deepEqual(parse(["--dir"]), { mode: "local", directoryOnly: true });
  assert.deepEqual(parse(["--local"]), { mode: "local", directoryOnly: false });
  assert.deepEqual(parse(["--release"]), { mode: "release", directoryOnly: false });
  assert.throws(() => parse([]), /usage/);
  assert.throws(() => parse(["--release", "--dir"]), /usage/);
  assert.doesNotThrow(() => ensureExactDistPath());
});

test("direct electron-builder use fails without a fresh package preparation nonce", async () => {
  const original = process.env.MINTVAULT_PREPARATION_ID;
  delete process.env.MINTVAULT_PREPARATION_ID;
  try {
    await assert.rejects(beforePack(), /fresh MintVault package orchestrator/);
  } finally {
    if (original === undefined) delete process.env.MINTVAULT_PREPARATION_ID;
    else process.env.MINTVAULT_PREPARATION_ID = original;
  }
});

test("latest-mac normalization retains only the exact signed ZIP update payload", (t) => {
  const root = temporaryDirectory(t);
  const zipPath = path.join(root, "MintVault-Scanner-1.2.1-arm64.zip");
  const latestPath = path.join(root, "latest-mac.yml");
  fs.writeFileSync(zipPath, "zip bytes");
  const zipSha512 = digest(zipPath, "sha512", "base64");
  fs.writeFileSync(latestPath, yaml.dump({
    version: "1.2.1",
    files: [
      { url: path.basename(zipPath), sha512: zipSha512, size: fs.statSync(zipPath).size },
      { url: "obsolete.dmg", sha512: "stale", size: 1 },
    ],
    path: path.basename(zipPath), sha512: zipSha512,
  }));
  normalizeLatestMac(latestPath, zipPath, "1.2.1");
  assert.equal(validateLatestMac(latestPath, zipPath).metadata.files.length, 1);
  fs.appendFileSync(zipPath, "tamper");
  assert.throws(() => validateLatestMac(latestPath, zipPath), /exact ZIP bytes/);
});

test("artifact ledger rejects byte, size, checksum and readiness drift", (t) => {
  const value = artifactFixture(t);
  assert.equal(verifyArtifactLedger({ dist: value.dist, mode: "local" }).ok, true);
  fs.appendFileSync(value.zipPath, "tamper");
  assert.throws(() => verifyArtifactLedger({ dist: value.dist, mode: "local" }), /latest-mac|SHA256SUMS|artifact mismatch/);
});

test("artifact ledger rejects duplicate names and security provenance tampering", (t) => {
  const value = artifactFixture(t);
  const manifestPath = path.join(value.dist, MANIFEST_FILENAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.signing.teamIdentifier = "ATTACKER01";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(() => verifyArtifactLedger({ dist: value.dist, mode: "local" }), /manifest contract/);

  const fresh = artifactFixture(t);
  const freshManifestPath = path.join(fresh.dist, MANIFEST_FILENAME);
  const duplicate = JSON.parse(fs.readFileSync(freshManifestPath, "utf8"));
  duplicate.artifacts = [duplicate.artifacts[0], duplicate.artifacts[0], duplicate.artifacts[2]];
  fs.writeFileSync(freshManifestPath, `${JSON.stringify(duplicate)}\n`);
  assert.throws(() => verifyArtifactLedger({ dist: fresh.dist, mode: "local" }), /exact and unique/);
});

test("artifact/app binding rejects source provenance and DMG/ZIP drift", () => {
  const manifest = {
    source: { commit: "a".repeat(40) },
    app: { bundleContentSha256: "b".repeat(64) },
    helpers: { capture: { sha256: "c".repeat(64) }, identity: { sha256: "d".repeat(64) } },
  };
  const app = {
    sourceCommit: "a".repeat(40),
    helperDigests: { capture: "c".repeat(64), identity: "d".repeat(64) },
  };
  const zipApplication = assertManifestAppBinding({ app, appDigest: "b".repeat(64), manifest, label: "ZIP" });
  assert.throws(() => assertManifestAppBinding({
    app: { ...app, sourceCommit: "e".repeat(40) },
    appDigest: "b".repeat(64),
    manifest,
    label: "ZIP",
  }), /does not match/);
  assert.throws(() => assertDistributionCopies({
    zipApplication,
    dmgApplication: { ...zipApplication, bundleContentSha256: "f".repeat(64) },
  }), /do not contain the same/);
});

test("bundle content digest binds paths, modes, symlinks and file bytes", (t) => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, "runtime"), "v1", { mode: 0o755 });
  fs.symlinkSync("runtime", path.join(root, "current"));
  const first = bundleContentDigest(root);
  fs.writeFileSync(path.join(root, "runtime"), "v2", { mode: 0o755 });
  assert.notEqual(bundleContentDigest(root), first);
});

test("production package config never carries LaunchAgent, native source or build tools", () => {
  const serialized = JSON.stringify({ files: builder.files, extraFiles: builder.extraFiles, extraResources: builder.extraResources });
  for (const forbidden of ["install.sh", "reset-agent.sh", "agent-plist.js", "mintvault-lide-bridge.m", "mv-identity-helper.swift", "package-lock.json"]) {
    assert.equal(serialized.includes(forbidden), forbidden === "agent-plist.js", forbidden);
  }
  for (const forbidden of [
    "node_modules/sharp/install/build.js",
    "node_modules/sharp/src/common.h",
    "node_modules/example/source.cpp",
    "node_modules/example/binding.gyp",
  ]) {
    assert.equal(isForbiddenRuntimeEntry(forbidden), true, forbidden);
  }
  assert.equal(isForbiddenRuntimeEntry("node_modules/node-fetch/src/index.js"), false);
});
