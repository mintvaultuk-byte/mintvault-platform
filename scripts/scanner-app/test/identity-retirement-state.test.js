"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("identity retirement clears prior tenant/card projection and preserves only device preferences", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-retirement-state-"));
  const prior = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runtimePaths = require("../lib/runtime-paths");
  runtimePaths.configureRuntime({ isPackaged: false });
  const state = require("../lib/state");
  state.load();
  state.set({
    state: "success",
    mode: "AUTO",
    bufferedFront: "/private/old-front.tiff",
    manualPending: { certId: "MV100", side: "front" },
    lastUploadedCert: "MV100",
    lastError: "old tenant error",
    sessionPaired: 7,
    recent: [{ certId: "MV100", side: "front" }],
    nextCertOverride: "MV101",
    predictedNextCert: "MV102",
    pausedUntil: Date.now() + 60_000,
    confirmCard: { certId: "MV100" },
    scannerHealth: { status: "ready", profileRevisionId: "old-profile" },
    positioningPreview: { id: "old-preview", previewPath: "/private/preview.jpg" },
    activeCapture: { id: "old-session", cardJobId: "old-job" },
    lastAcceptedCapture: { certId: "MV100", cardJobId: "old-job" },
    autoOpenOnError: false,
    soundEnabled: false,
    loginItemConfigured: true,
    hostileUnknownProjection: "must disappear",
  });

  const reset = state.resetForIdentityRetirement();
  assert.equal(reset.autoOpenOnError, false);
  assert.equal(reset.soundEnabled, false);
  assert.equal(reset.loginItemConfigured, true);
  assert.equal(reset.state, "idle");
  assert.equal(reset.mode, "MANUAL");
  for (const key of [
    "bufferedFront", "manualPending", "lastUploadedCert", "lastError", "nextCertOverride",
    "predictedNextCert", "pausedUntil", "confirmCard", "positioningPreview", "activeCapture", "lastAcceptedCapture",
  ]) assert.equal(reset[key], null, `${key} must not cross station identities`);
  assert.equal(reset.sessionPaired, 0);
  assert.deepEqual(reset.recent, []);
  assert.deepEqual(reset.scannerHealth, { status: "checking" });
  assert.equal(Object.hasOwn(reset, "hostileUnknownProjection"), false);

  const reloaded = state.load();
  assert.equal(reloaded.lastUploadedCert, null);
  assert.deepEqual(reloaded.recent, []);
  assert.equal(Object.hasOwn(reloaded, "hostileUnknownProjection"), false);

  for (const method of ["writeFileSync", "renameSync", "fsyncSync"]) {
    state.set({ lastUploadedCert: "MV999", recent: [{ certId: "MV999" }] });
    const original = fs[method];
    fs[method] = (...args) => {
      if (method !== "writeFileSync" || typeof args[0] === "number") {
        const error = new Error(`injected ${method} retirement failure`);
        error.code = "EIO";
        throw error;
      }
      return original(...args);
    };
    try {
      assert.throws(() => state.resetForIdentityRetirement(), new RegExp(`injected ${method}`));
    } finally {
      fs[method] = original;
    }
    const durable = JSON.parse(fs.readFileSync(state.STATE_PATH, "utf8"));
    assert.equal(durable.lastUploadedCert, "MV999", `${method} failure must not report a durable retirement reset`);
    state.load();
  }
});
