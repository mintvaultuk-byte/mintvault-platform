const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { ensureDefaultAfterEnrolment } = require("../lib/login-item");
const { Watcher } = require("../lib/watcher");

const ROOT = path.resolve(__dirname, "..");

function source(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

test("login startup is off before enrolment, defaults on once, then respects the user's choice", { skip: process.platform !== "darwin" }, () => {
  const calls = [];
  const app = {
    isPackaged: true,
    setLoginItemSettings: (value) => calls.push(value),
    getLoginItemSettings: () => ({ openAtLogin: false, status: "disabled" }),
  };
  let persisted = 0;
  const before = ensureDefaultAfterEnrolment({ app, enrolled: false, alreadyConfigured: false, persistConfigured: () => { persisted += 1; } });
  assert.equal(before.reason, "not-enrolled");
  assert.equal(calls.length, 0);
  assert.equal(persisted, 0);

  const enrolled = ensureDefaultAfterEnrolment({ app, enrolled: true, alreadyConfigured: false, persistConfigured: () => { persisted += 1; } });
  assert.equal(enrolled.reason, "default-enabled-after-enrolment");
  assert.deepEqual(calls, [{ openAtLogin: true }]);
  assert.equal(persisted, 1);

  const later = ensureDefaultAfterEnrolment({ app, enrolled: true, alreadyConfigured: true, persistConfigured: () => { persisted += 1; } });
  assert.equal(later.reason, "previously-configured");
  assert.deepEqual(calls, [{ openAtLogin: true }]);
  assert.equal(persisted, 1);
});

test("packaged runtime has no LaunchAgent, shell repair, Git or npm update authority", () => {
  const main = source("main.js");
  const runtime = [main, source("preload.js"), source("renderer/app.js")].join("\n");
  for (const forbidden of ["reset-agent.sh", "spawnResetAgent", "launchctl", "git pull", "npm install"]) {
    assert.doesNotMatch(runtime, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(main, /app\.relaunch\(\)/);
  assert.match(main, /ensurePostEnrolmentLoginItem\(\)/);
  assert.match(source("lib/state.js"), /loginItemConfigured:\s+false/);
});

test("minimum-version absence fails closed and UPDATE_REQUIRED has usable modal actions", () => {
  const main = source("main.js");
  const html = source("renderer/index.html");
  const preload = source("preload.js");
  assert.doesNotMatch(main, /if \(!minimum\) return true/);
  assert.match(main, /if \(!versionTuple\(station\.minimumSupportedVersion\)\)/);
  assert.match(main, /setPolicy\(station\.scannerUpdatePolicy \?\? null\)/);
  assert.match(main, /stage:\s+"degraded"/);
  for (const id of ["stationUpdatePanel", "stationUpdateBtn", "stationReinstallBtn", "stationUpdateStatus"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(preload, /"update-status"/);
  assert.match(preload, /"open-dmg-reinstall"/);
  assert.match(source("renderer/app.js"), /stage !== "update_required"/);
});

test("reinstall-safe identity and queue custody live outside the application bundle", () => {
  assert.match(source("lib/state.js"), /Library["),.\s]+Application Support["),.\s]+MintVaultScanner/);
  assert.match(source("lib/station-identity.js"), /Keychain|keychain/i);
  assert.match(source("lib/watcher.js"), /os\.homedir\(\), "mintvault-scans"/);
  assert.match(source("lib/watcher.js"), /new EncryptedCaptureQueue\(\{ baseDir: BASE/);
});

test("an update restart is denied across every watcher operation that can expose plaintext or scanner state", () => {
  const watcher = Object.create(Watcher.prototype);
  watcher.uploading = false;
  watcher.targetCaptureInFlight = false;
  watcher.previewActionInFlight = false;
  watcher.positioningPreviewInFlight = false;
  watcher.scannerHealthPromise = null;
  watcher.recoveryPlaintextWork = 0;
  watcher.initialDrainTimer = null;
  watcher.initialDrainPromise = null;
  watcher.updateInstallPending = false;
  assert.equal(watcher.isRestartSafeForUpdate(), true);
  for (const key of ["uploading", "targetCaptureInFlight", "previewActionInFlight", "positioningPreviewInFlight", "scannerHealthPromise", "recoveryPlaintextWork", "initialDrainTimer", "initialDrainPromise", "updateInstallPending"]) {
    watcher[key] = true;
    assert.equal(watcher.isRestartSafeForUpdate(), false, key);
    watcher[key] = false;
  }
  const main = source("main.js");
  for (const state of ["uploading", "retrying", "positioning_preview_scanning", "processing_preview"]) {
    assert.match(main, new RegExp(`"${state}"`));
  }
  assert.match(main, /watcher\?\.isRestartSafeForUpdate/);
});

test("preview recovery is restart-unsafe for the entire decrypted-scratch lifetime", async () => {
  const watcher = Object.create(Watcher.prototype);
  Object.assign(watcher, {
    uploading: false,
    targetCaptureInFlight: false,
    previewActionInFlight: false,
    positioningPreviewInFlight: false,
    scannerHealthPromise: null,
    recoveryPlaintextWork: 0,
    initialDrainTimer: null,
    initialDrainPromise: null,
    updateInstallPending: false,
  });
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mv-recovery-latch-"));
  let releaseDecrypt;
  const decryptGate = new Promise((resolve) => { releaseDecrypt = resolve; });
  watcher.captureQueue = {
    scratchPath: (_entry, suffix) => path.join(root, `scratch${suffix}`),
    decryptToFile: async () => decryptGate,
    attachFile: async (entry) => ({ ...entry, previewArtifact: { id: "preview" } }),
  };
  watcher.createPreviewDerivative = async () => {};
  watcher.addTargetedPending = (entry) => entry;
  watcher.setTargetState = () => {};
  watcher.log = () => {};
  const restoring = watcher.restorePreviewCandidate({
    queueEntryId: "entry-1",
    artifact: { id: "master" },
    frameAssessment: { accepted: true },
    phase: "preview_ready",
  });
  assert.equal(watcher.recoveryPlaintextWork, 1);
  assert.equal(watcher.isRestartSafeForUpdate(), false);
  releaseDecrypt();
  await restoring;
  assert.equal(watcher.recoveryPlaintextWork, 0);
  assert.equal(watcher.isRestartSafeForUpdate(), true);
});

test("install quiesce refuses every watcher entry point before it can touch scanner or plaintext state", async () => {
  const watcher = Object.create(Watcher.prototype);
  watcher.updateInstallPending = false;
  watcher.setUpdateInstallPending(true);
  const checks = [
    watcher.runPositioningPreview(),
    watcher.applyPositioningPreview("preview"),
    watcher.refreshScannerHealth(),
    watcher.pollTargetedCapture(),
    watcher.scanActiveTarget(),
    watcher.acceptPreview("preview"),
    watcher.rescanPreview("preview"),
    watcher.drainInbox(),
    watcher.handleNewFile("/definitely/not/opened.tif"),
  ];
  for (const result of await Promise.all(checks)) {
    assert.equal(result.ok, false);
    assert.equal(result.code, "update_install_pending");
  }

  const main = source("main.js");
  assert.match(main, /updateDeniedAfterSetup/);
  assert.match(main, /updateDeniedAfterHeartbeat/);
  assert.match(main, /if \(targetedCapturePollInFlight \|\| updateInstallPending\) return/);
  assert.match(main, /beforeInstall: beginUpdateInstall/);
});

test("an asynchronous inbox event is restart-unsafe until its plaintext handling settles", async () => {
  const watcher = Object.create(Watcher.prototype);
  Object.assign(watcher, {
    uploading: false,
    targetCaptureInFlight: false,
    previewActionInFlight: false,
    positioningPreviewInFlight: false,
    scannerHealthPromise: null,
    recoveryPlaintextWork: 0,
    initialDrainTimer: null,
    initialDrainPromise: null,
    updateInstallPending: false,
  });
  let finish;
  watcher.handleNewFileImpl = async () => new Promise((resolve) => { finish = resolve; });
  const handling = watcher.handleNewFile("/private/inbox/unbound.tif");
  assert.equal(watcher.recoveryPlaintextWork, 1);
  assert.equal(watcher.isRestartSafeForUpdate(), false);
  finish();
  await handling;
  assert.equal(watcher.recoveryPlaintextWork, 0);
  assert.equal(watcher.isRestartSafeForUpdate(), true);
});
