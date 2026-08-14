"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("a preexisting plaintext TIFF blocks identity retirement before the key is touched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-retirement-custody-"));
  const prior = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });

  require("../lib/runtime-paths").configureRuntime({ isPackaged: false });
  const { Watcher, INBOX } = require("../lib/watcher");
  const watcher = Object.create(Watcher.prototype);
  Object.assign(watcher, {
    uploading: false,
    targetCaptureInFlight: false,
    previewActionInFlight: false,
    positioningPreviewInFlight: false,
    profileAcceptanceInFlight: false,
    scannerHealthPromise: null,
    recoveryPlaintextWork: 0,
    initialDrainTimer: null,
    initialDrainPromise: null,
    updateInstallPending: false,
    identityRetirementPending: true,
    captureQueue: {
      entries: () => [],
      artifactsDir: path.join(root, "capture-queue", "artifacts"),
      quarantineDir: path.join(root, "capture-queue", "quarantine"),
      scratchDir: path.join(root, "capture-queue", "scratch"),
      indexPath: path.join(root, "capture-queue", "index.v1.json"),
      keyPath: path.join(root, "capture-queue", "wrapped-key.v1.json"),
    },
    readPendingQueue: () => [],
  });
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, "prior-card.tiff"), "prior identity card bytes");
  assert.throws(() => watcher.identityRetirementFiles(), /Plaintext capture custody/);
});
