const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  compareVersions,
  createUpdateManager,
  parseVersion,
  validatePackagedUpdateConfig,
  validateUpdatePolicy,
  validateReleaseEvidence,
  _private,
} = require("../lib/update-manager");

const TEAM = "MINTVAULT1";
const BASE = "https://updates.example.test/mintvault/scanner";

function digest(algorithm, value, encoding = "hex") {
  return crypto.createHash(algorithm).update(value).digest(encoding);
}

function releaseFixture(root, overrides = {}) {
  const version = overrides.version || "1.2.2";
  const zipName = `MintVault-Scanner-${version}-arm64.zip`;
  const dmgName = `MintVault-Scanner-${version}-arm64.dmg`;
  const zipBytes = Buffer.from("signed zip fixture");
  const zipPath = path.join(root, zipName);
  fs.writeFileSync(zipPath, zipBytes);
  const artifactBytes = {
    [dmgName]: Buffer.from("signed dmg fixture"),
    [zipName]: zipBytes,
    "latest-mac.yml": Buffer.from("exact updater metadata fixture"),
  };
  const artifacts = Object.entries(artifactBytes).map(([filename, bytes]) => ({
    filename,
    size: bytes.length,
    sha256: digest("sha256", bytes),
  }));
  const sha512 = digest("sha512", zipBytes, "base64");
  const manifest = {
    schemaVersion: 1,
    packageMode: "release",
    releaseReady: true,
    source: { commit: "a".repeat(40), treeState: "clean" },
    app: {
      name: "MintVault Scanner",
      version,
      bundleIdentifier: "com.mintvault.scanner",
      architecture: "arm64",
      minimumMacOS: "12.0",
      bundleContentSha256: "b".repeat(64),
    },
    signing: {
      teamIdentifier: TEAM,
      hardenedRuntime: true,
      notarized: true,
      appStapled: true,
      dmgStapled: true,
      gatekeeperAssessed: true,
    },
    update: { metadata: "latest-mac.yml", zipSha512: sha512 },
    artifacts,
  };
  const checksumText = `${artifacts.map((entry) => `${entry.sha256}  ${entry.filename}`).join("\n")}\n`;
  const updateInfo = { version, files: [{ url: `${BASE}/${zipName}`, sha512, size: zipBytes.length }] };
  const policy = {
    schemaVersion: 1,
    authority: "MINTVAULT_STATION_POLICY",
    policyId: `scanner-policy-${version}`,
    operation: overrides.operation || "UPDATE",
    targetVersion: version,
    minimumSupportedVersion: overrides.minimumVersion || version,
    teamIdentifier: TEAM,
    sourceCommit: manifest.source.commit,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: overrides.reason || "Current owner-approved Scanner release",
    artifacts: {
      zip: { ...artifacts.find((entry) => entry.filename === zipName), sha512 },
      dmg: { ...artifacts.find((entry) => entry.filename === dmgName) },
      latest: { ...artifacts.find((entry) => entry.filename === "latest-mac.yml") },
    },
  };
  return { version, zipName, dmgName, zipPath, manifest, checksumText, updateInfo, policy, artifactBytes };
}

function response(body, { contentLength = true } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok: true,
    body: Readable.from([bytes]),
    headers: { get: (name) => contentLength && name.toLowerCase() === "content-length" ? String(bytes.length) : null },
  };
}

class FakeUpdater extends EventEmitter {
  constructor(updateInfo, zipPath) {
    super();
    this.updateInfo = updateInfo;
    this.zipPath = zipPath;
    this.quitCalls = 0;
    this.downloadCalls = 0;
    this.httpExecutor = {
      request: async () => { throw new Error("unbounded updater metadata transport used"); },
      download: async () => { throw new Error("unbounded updater ZIP transport used"); },
    };
  }

  async checkForUpdates() {
    await this.httpExecutor.request({ href: `${BASE}/latest-mac.yml` });
    return { updateInfo: this.updateInfo };
  }
  async downloadUpdate() {
    this.downloadCalls += 1;
    const cancellationToken = new EventEmitter();
    cancellationToken.cancelled = false;
    cancellationToken.onCancel = (handler) => cancellationToken.once("cancel", handler);
    fs.rmSync(this.zipPath, { force: true });
    await this.httpExecutor.download(new URL(this.updateInfo.files[0].url), this.zipPath, {
      cancellationToken,
      onProgress: (progress) => this.emit("download-progress", progress),
    });
    this.emit("update-downloaded", { ...this.updateInfo, downloadedFile: this.zipPath });
    return [];
  }
  quitAndInstall() { this.quitCalls += 1; }
}

function managerFixture({
  safe = true,
  appVersion = "1.2.1",
  fixtureOverrides = {},
  fetchOverride = null,
  beforeInstallOverride = null,
  evidenceTimeoutMs = 30_000,
  artifactTimeoutMs = 30_000,
  now = () => Date.now(),
  monotonicNow = () => Number(process.hrtime.bigint() / 1_000_000n),
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-test-"));
  const fixture = releaseFixture(root, fixtureOverrides);
  fs.writeFileSync(path.join(root, "app-update.yml"), `provider: generic\nurl: ${BASE}\nchannel: latest\nupdaterCacheDirName: mintvault-scanner-app-updater\n`);
  const updater = new FakeUpdater(fixture.updateInfo, fixture.zipPath);
  let installAuthorityCalls = 0;
  let installReleaseCalls = 0;
  const statuses = [];
  const manager = createUpdateManager({
    autoUpdater: updater,
    appVersion,
    releaseTrust: { packageMode: "release", teamIdentifier: TEAM, updateBaseUrl: BASE },
    resourcesPath: root,
    downloadDirectory: path.join(root, "verified-dmg"),
    fetchImpl: async (url, options) => {
      if (fetchOverride) {
        const overridden = await fetchOverride(url, options, fixture);
        if (overridden) return overridden;
      }
      if (url.endsWith("mintvault-scanner-release.json")) return response(fixture.manifest);
      if (url.endsWith("SHA256SUMS")) return response(fixture.checksumText);
      if (url.endsWith("latest-mac.yml")) return response(fixture.artifactBytes["latest-mac.yml"]);
      if (url.endsWith(fixture.zipName)) return response(fixture.artifactBytes[fixture.zipName]);
      if (url.endsWith(fixture.dmgName)) return response(fixture.artifactBytes[fixture.dmgName]);
      return { ok: false, body: null, headers: { get: () => null } };
    },
    onStatus: (status) => statuses.push(status),
    isRestartSafe: () => safe,
    beforeInstall: beforeInstallOverride || (() => {
      installAuthorityCalls += 1;
      return () => { installReleaseCalls += 1; };
    }),
    evidenceTimeoutMs,
    artifactTimeoutMs,
    now,
    monotonicNow,
    allowPathUpdaterForTests: true,
  });
  return {
    root,
    fixture,
    updater,
    manager,
    statuses,
    installAuthorityCalls: () => installAuthorityCalls,
    installReleaseCalls: () => installReleaseCalls,
  };
}

test("strict versions and packaged feed reject missing, malformed, downgrade and origin drift", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.throws(() => parseVersion(""), /version is invalid/);
  assert.throws(() => parseVersion("1.2.3-beta"), /version is invalid/);
  assert.equal(compareVersions("1.2.2", "1.2.1"), 1);
  const source = `provider: generic\nurl: ${BASE}\nchannel: latest\nupdaterCacheDirName: mintvault-scanner-app-updater\n`;
  assert.equal(validatePackagedUpdateConfig(source, { updateBaseUrl: BASE }).url, BASE);
  assert.throws(() => validatePackagedUpdateConfig(source.replace(BASE, "https://attacker.example"), { updateBaseUrl: BASE }), /does not match/);
});

test("release evidence is exact, newer-only, minimum-aware and MintVault-Team-bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-evidence-"));
  const fixture = releaseFixture(root);
  const args = {
    manifest: fixture.manifest,
    checksumText: fixture.checksumText,
    updateInfo: fixture.updateInfo,
    currentVersion: "1.2.1",
    minimumVersion: "1.2.2",
    releaseTrust: { teamIdentifier: TEAM, updateBaseUrl: BASE },
    policy: validateUpdatePolicy(fixture.policy, {
      currentVersion: "1.2.1",
      minimumVersion: "1.2.2",
      releaseTrust: { teamIdentifier: TEAM },
    }),
  };
  assert.equal(validateReleaseEvidence(args).expectedZip, fixture.zipName);
  assert.throws(() => validateReleaseEvidence({ ...args, currentVersion: "1.2.2" }), /authenticated target/);
  assert.throws(() => validateReleaseEvidence({ ...args, minimumVersion: "1.2.3" }), /minimum supported/);
  assert.throws(() => validateReleaseEvidence({ ...args, manifest: { ...fixture.manifest, signing: { ...fixture.manifest.signing, teamIdentifier: "ATTACKER01" } } }), /does not authorise/);
  assert.throws(() => validateReleaseEvidence({ ...args, manifest: { ...fixture.manifest, source: { ...fixture.manifest.source, treeState: "dirty" } } }), /does not authorise/);
  assert.throws(() => validateReleaseEvidence({ ...args, checksumText: fixture.checksumText.replace(/[a-f0-9]/, "0") }), /binding is invalid|malformed/);
});

test("only an exact downloaded ZIP obtains restart authority", async () => {
  const context = managerFixture();
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  assert.equal(context.manager.enabled, true);
  assert.equal(context.updater.autoDownload, false);
  assert.equal(context.updater.autoInstallOnAppQuit, false);
  assert.equal(context.updater.allowDowngrade, false);
  const ready = await context.manager.check({ download: true });
  assert.equal(ready.status, "ready_to_restart");
  const result = await context.manager.updateAndRestart();
  assert.deepEqual(result, { ok: true, restarting: true, version: "1.2.2" });
  assert.equal(context.installAuthorityCalls(), 1);
  assert.equal(context.updater.quitCalls, 1);
  assert.ok(context.statuses.some((status) => status.status === "ready_to_restart"));
});

test("active physical work defers restart after download", async () => {
  const context = managerFixture({ safe: false });
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  const result = await context.manager.updateAndRestart();
  assert.equal(result.ok, false);
  assert.equal(result.status, "restart_deferred");
  assert.equal(context.installAuthorityCalls(), 0);
  assert.equal(context.updater.quitCalls, 0);
});

test("failed or tampered update leaves identity and encrypted queue state untouched", async () => {
  const context = managerFixture({
    fetchOverride: async (url, _options, fixture) => url.endsWith(fixture.zipName)
      ? response(Buffer.from("tampered zip from feed"))
      : null,
  });
  const identity = path.join(context.root, "station-identity.sentinel");
  const queue = path.join(context.root, "encrypted-queue.sentinel");
  fs.writeFileSync(identity, "persistent identity");
  fs.writeFileSync(queue, "persistent encrypted queue");
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  const result = await context.manager.updateAndRestart();
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(context.installAuthorityCalls(), 0);
  assert.equal(context.updater.quitCalls, 0);
  assert.equal(fs.readFileSync(identity, "utf8"), "persistent identity");
  assert.equal(fs.readFileSync(queue, "utf8"), "persistent encrypted queue");
  assert.doesNotMatch(result.error, /mv-update-test|https?:|\.zip/i);
});

test("a static feed has no authority without an authenticated exact-target policy", async () => {
  const context = managerFixture();
  context.manager.setMinimumVersion("1.2.2");
  const result = await context.manager.updateAndRestart();
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.match(result.error, /authenticated MintVault update policy/i);
  assert.equal(context.updater.downloadCalls, 0);
  assert.equal(context.updater.quitCalls, 0);
});

test("a compromised feed cannot select a different newer release or an old signed version", async () => {
  const context = managerFixture();
  const authorised = releaseFixture(context.root, { version: "1.3.0", minimumVersion: "1.3.0" });
  context.manager.setMinimumVersion("1.3.0");
  context.manager.setPolicy(authorised.policy);
  const wrongNewer = await context.manager.check({ download: true });
  assert.equal(wrongNewer.status, "error");
  assert.equal(context.updater.downloadCalls, 0);

  const rollback = managerFixture({ appVersion: "1.3.0", fixtureOverrides: { version: "1.2.2", minimumVersion: "1.2.0", operation: "ROLLBACK", reason: "Owner-authorised emergency rollback" } });
  rollback.manager.setMinimumVersion("1.2.0");
  rollback.manager.setPolicy(rollback.fixture.policy);
  const allowed = await rollback.manager.check({ download: true });
  assert.equal(allowed.status, "ready_to_restart");
  assert.equal(rollback.updater.allowDowngrade, true);
});

test("rollback authority expires monotonically even after the wall clock is rewound", async () => {
  let wall = Date.now();
  let monotonic = 1_000;
  const context = managerFixture({
    appVersion: "1.3.0",
    fixtureOverrides: { version: "1.2.2", minimumVersion: "1.2.0", operation: "ROLLBACK", reason: "Owner-authorised emergency rollback" },
    now: () => wall,
    monotonicNow: () => monotonic,
  });
  context.fixture.policy.issuedAt = new Date(wall - 1_000).toISOString();
  context.fixture.policy.expiresAt = new Date(wall + 10_000).toISOString();
  context.manager.setMinimumVersion("1.2.0");
  context.manager.setPolicy(context.fixture.policy);
  monotonic += 11_000;
  wall -= 60_000;
  const refused = await context.manager.check({ download: false });
  assert.equal(refused.status, "error");
  assert.equal(context.updater.downloadCalls, 0);
});

test("new checks invalidate an old downloaded candidate and install rehashes immediately before quit", async () => {
  const context = managerFixture();
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  assert.equal((await context.manager.check({ download: true })).status, "ready_to_restart");
  assert.equal(context.updater.downloadCalls, 1);
  assert.equal((await context.manager.check({ download: false })).status, "update_available");
  const restarted = await context.manager.updateAndRestart();
  assert.equal(restarted.ok, true);
  assert.equal(context.updater.downloadCalls, 2);

  const second = managerFixture();
  second.manager.setMinimumVersion("1.2.2");
  second.manager.setPolicy(second.fixture.policy);
  assert.equal((await second.manager.check({ download: true })).status, "ready_to_restart");
  fs.writeFileSync(second.fixture.zipPath, "same-user cache mutation");
  const refused = await second.manager.updateAndRestart();
  assert.equal(refused.ok, false);
  assert.equal(second.updater.quitCalls, 0);
});

test("DMG recovery downloads, policy-hashes and opens only one exact candidate path", async () => {
  const context = managerFixture();
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  const result = await context.manager.downloadReinstallDmg();
  assert.equal(result.ok, true);
  assert.equal(path.basename(result.path), context.fixture.dmgName);
  assert.equal(digest("sha256", fs.readFileSync(result.path)), context.fixture.policy.artifacts.dmg.sha256);

  const opening = managerFixture();
  opening.manager.setMinimumVersion("1.2.2");
  opening.manager.setPolicy(opening.fixture.policy);
  let openedPath = null;
  const opened = await opening.manager.openReinstallDmg(async (verifiedPath) => { openedPath = verifiedPath; return ""; });
  assert.equal(opened.ok, true);
  assert.equal(path.basename(openedPath), opening.fixture.dmgName);
  assert.equal(digest("sha256", fs.readFileSync(openedPath)), opening.fixture.policy.artifacts.dmg.sha256);

  const noPolicy = managerFixture();
  noPolicy.manager.setMinimumVersion("1.2.2");
  const refused = await noPolicy.manager.downloadReinstallDmg();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /authenticated MintVault update policy/i);
});

test("install authority remains latched across asynchronous MacUpdater install and releases only on explicit updater failure", async () => {
  const context = managerFixture();
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  const installing = await context.manager.updateAndRestart();
  assert.equal(installing.ok, true);
  assert.equal(context.installAuthorityCalls(), 1);
  assert.equal(context.installReleaseCalls(), 0);

  context.updater.emit("error", new Error("native update install failed before quit"));
  assert.equal(context.installReleaseCalls(), 1);
  context.updater.emit("error", new Error("duplicate updater failure"));
  assert.equal(context.installReleaseCalls(), 1);
});

test("a last-moment quiesce refusal closes the safe-check/install transition", async () => {
  let beginCalls = 0;
  const context = managerFixture({ beforeInstallOverride: () => { beginCalls += 1; return null; } });
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  const refused = await context.manager.updateAndRestart();
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "restart_deferred");
  assert.equal(beginCalls, 1);
  assert.equal(context.updater.quitCalls, 0);
});

test("policy, metadata and manifest enforce authenticated byte ceilings before installation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-ceiling-"));
  const fixture = releaseFixture(root);
  const oversizedPolicy = {
    ...fixture.policy,
    artifacts: {
      ...fixture.policy.artifacts,
      zip: { ...fixture.policy.artifacts.zip, size: _private.MAX_UPDATE_ARCHIVE_BYTES + 1 },
    },
  };
  assert.throws(() => validateUpdatePolicy(oversizedPolicy, {
    currentVersion: "1.2.1",
    minimumVersion: "1.2.2",
    releaseTrust: { teamIdentifier: TEAM },
  }), /artifact is invalid/);

  const manifestOverflow = managerFixture({
    fetchOverride: async (url) => url.endsWith("mintvault-scanner-release.json")
      ? response(Buffer.alloc(_private.MAX_RELEASE_MANIFEST_BYTES + 1), { contentLength: false })
      : null,
  });
  manifestOverflow.manager.setMinimumVersion("1.2.2");
  manifestOverflow.manager.setPolicy(manifestOverflow.fixture.policy);
  const refused = await manifestOverflow.manager.check({ download: false });
  assert.equal(refused.status, "error");
  assert.equal(manifestOverflow.updater.downloadCalls, 0);
});

test("ZIP and DMG streams abort at the authenticated size instead of consuming an oversized feed", async () => {
  let zipProduced = 0;
  const zipOverflow = managerFixture({
    fetchOverride: async (url, _options, fixture) => {
      if (!url.endsWith(fixture.zipName)) return null;
      const body = Readable.from((async function* generate() {
        const exact = fixture.artifactBytes[fixture.zipName];
        zipProduced += exact.length;
        yield exact;
        const overflow = Buffer.alloc(64 * 1024, 7);
        zipProduced += overflow.length;
        yield overflow;
        throw new Error("reader should already be aborted");
      })());
      return { ok: true, body, headers: { get: () => null } };
    },
  });
  zipOverflow.manager.setMinimumVersion("1.2.2");
  zipOverflow.manager.setPolicy(zipOverflow.fixture.policy);
  const zipResult = await zipOverflow.manager.check({ download: true });
  assert.equal(zipResult.status, "error");
  assert.equal(zipOverflow.updater.quitCalls, 0);
  assert.ok(fs.statSync(zipOverflow.fixture.zipPath).size <= zipOverflow.fixture.policy.artifacts.zip.size);
  assert.ok(zipProduced <= zipOverflow.fixture.policy.artifacts.zip.size + 64 * 1024);

  let dmgProduced = 0;
  const dmgOverflow = managerFixture({
    fetchOverride: async (url, _options, fixture) => {
      if (!url.endsWith(fixture.dmgName)) return null;
      const body = Readable.from((async function* generate() {
        const exact = fixture.artifactBytes[fixture.dmgName];
        dmgProduced += exact.length;
        yield exact;
        const overflow = Buffer.alloc(64 * 1024, 9);
        dmgProduced += overflow.length;
        yield overflow;
      })());
      return { ok: true, body, headers: { get: () => null } };
    },
  });
  dmgOverflow.manager.setMinimumVersion("1.2.2");
  dmgOverflow.manager.setPolicy(dmgOverflow.fixture.policy);
  const dmgResult = await dmgOverflow.manager.downloadReinstallDmg();
  assert.equal(dmgResult.ok, false);
  const retainedDownloads = fs.existsSync(path.join(dmgOverflow.root, "verified-dmg"))
    ? fs.readdirSync(path.join(dmgOverflow.root, "verified-dmg")).filter((name) => name.endsWith(".download"))
    : [];
  assert.deepEqual(retainedDownloads, []);
  assert.ok(dmgProduced <= dmgOverflow.fixture.policy.artifacts.dmg.size + 64 * 1024);
});

test("evidence fetch timeout aborts fail closed without invoking ZIP download", async () => {
  const context = managerFixture({
    evidenceTimeoutMs: 20,
    fetchOverride: async (url, options) => {
      if (!url.endsWith("mintvault-scanner-release.json")) return null;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  context.manager.setMinimumVersion("1.2.2");
  context.manager.setPolicy(context.fixture.policy);
  const result = await context.manager.check({ download: true });
  assert.equal(result.status, "error");
  assert.equal(context.updater.downloadCalls, 0);
});

test("bounded artifact writes refuse pre-existing paths and symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-exclusive-"));
  const sentinel = path.join(root, "sentinel");
  const destination = path.join(root, "candidate.zip");
  const bytes = Buffer.from("bounded artifact");
  fs.writeFileSync(sentinel, "do not overwrite");
  fs.symlinkSync(sentinel, destination);
  await assert.rejects(() => _private.downloadBoundedFile(
    async () => response(bytes),
    `${BASE}/candidate.zip`,
    destination,
    {
      label: "test artifact",
      accept: "application/zip",
      expectedSize: bytes.length,
      expectedSha256: digest("sha256", bytes),
      maxBytes: 1024,
      timeoutMs: 1000,
    },
  ), /EEXIST/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do not overwrite");
});

test("Squirrel install bytes are copied into an anonymous descriptor before a retained writer can mutate the cache", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-anonymous-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate.zip");
  const original = crypto.randomBytes(256 * 1024);
  const expectedSha256 = digest("sha256", original);
  fs.writeFileSync(candidate, original, { mode: 0o600 });
  const retainedWriter = fs.openSync(candidate, fs.constants.O_RDWR);
  const source = _private.openVerifiedCandidate(candidate, {
    expectedSize: original.length,
    expectedSha256,
    label: "test ZIP",
  });
  const anonymous = _private.anonymousVerifiedSnapshot(source, root, {
    expectedSize: original.length,
    expectedSha256,
    label: "test ZIP",
  });
  try {
    fs.writeSync(retainedWriter, Buffer.alloc(4096, 0x41), 0, 4096, 0);
    assert.equal(anonymous.validate(), true);
    assert.equal(_private.digestDescriptor(anonymous.descriptor, original.length), expectedSha256);
    assert.equal(anonymous.stat.nlink, 0);
  } finally {
    fs.closeSync(retainedWriter);
    source.close();
    anonymous.close();
  }
});

test("production DMG recovery mounts the unlinked verified descriptor read-only before Gatekeeper/open", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-dmg-fd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dmg = path.join(root, "candidate.dmg");
  const bytes = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(dmg, bytes, { mode: 0o600 });
  const retainedWriter = fs.openSync(dmg, fs.constants.O_RDWR);
  const sourceAuthority = _private.openVerifiedCandidate(dmg, {
    expectedSize: bytes.length,
    expectedSha256: digest("sha256", bytes),
    label: "test DMG",
  });
  const authority = _private.anonymousVerifiedSnapshot(sourceAuthority, root, {
    expectedSize: bytes.length,
    expectedSha256: digest("sha256", bytes),
    label: "test DMG",
  });
  fs.unlinkSync(dmg);
  sourceAuthority.close();
  fs.writeSync(retainedWriter, Buffer.alloc(4096, 0x55), 0, 4096, 0);
  const calls = [];
  let opened = null;
  try {
    const result = await _private.openDescriptorBoundDmg(authority, {
      downloadDirectory: root,
      expectedTeamIdentifier: TEAM,
      openPath: async (mountpoint) => { opened = mountpoint; return ""; },
      runTool(command, args, options) {
        calls.push({ command, args, fd: options.stdio?.[3] });
        if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
          const mountpoint = args[args.indexOf("-mountpoint") + 1];
          fs.mkdirSync(path.join(mountpoint, "MintVault Scanner.app"));
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "/usr/bin/codesign" && args[0] === "-d") {
          return { status: 0, stdout: "", stderr: `Identifier=com.mintvault.scanner\nTeamIdentifier=${TEAM}\nflags=0x10000(runtime)\n` };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mountpoint, opened);
    assert.ok(calls.some((call) => call.command === "/usr/bin/hdiutil" && call.args.at(-1) === "/dev/fd/3" && call.fd === authority.descriptor));
    assert.ok(calls.some((call) => call.command === "/usr/sbin/spctl"));
  } finally {
    fs.closeSync(retainedWriter);
    authority.close();
  }
});

test("the streaming limiter stops file output at the authenticated size", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mv-update-stream-limit-"));
  const destination = path.join(root, "candidate.zip");
  const exact = Buffer.from("exact release bytes");
  const overflow = Buffer.alloc(64 * 1024, 4);
  await assert.rejects(() => _private.downloadBoundedFile(
    async () => ({
      ok: true,
      body: Readable.from([exact, overflow]),
      headers: { get: () => null },
    }),
    `${BASE}/candidate.zip`,
    destination,
    {
      label: "test artifact",
      accept: "application/zip",
      expectedSize: exact.length,
      expectedSha256: digest("sha256", exact),
      maxBytes: _private.MAX_UPDATE_ARCHIVE_BYTES,
      timeoutMs: 1000,
    },
  ), /byte limit|authenticated policy/);
  assert.ok(fs.statSync(destination).size <= exact.length);
});
