const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Window } = require("happy-dom");

const APP = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(APP, "renderer", "app.js"), "utf8");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(APP, "preload.js"), "utf8");
const packager = fs.readFileSync(path.join(APP, "scripts", "package-macos.js"), "utf8");
const SCANNER_VERSION = require("../package.json").version;

async function renderSetup(setup, state = {}, scannerOverrides = {}) {
  const window = new Window({ url: "http://mintvault-scanner.test" });
  window.document.write(html);
  window.document.close();
  window.alert = () => {};
  window.confirm = () => false;
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.setTimeout = () => 0;
  window.clearTimeout = () => {};
  window.scanner = {
    onStateUpdate: () => () => {},
    getState: () => Promise.resolve({ state: "idle", availableCredits: 5, ...state }),
    getStationSetup: () => Promise.resolve(setup),
    getVersion: () => Promise.resolve({ ok: true, version: SCANNER_VERSION }),
    getPlacementPreview: () => Promise.resolve({ ok: false }),
    runPlacementPreview: () => Promise.resolve({ ok: true }),
    ...scannerOverrides,
  };
  window.eval(renderer);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return window.document;
}

test("normal Scanner workflow has no movable area, reset, save, or operator calibration surface", () => {
  for (const forbidden of [
    "captureWindowSetup",
    "captureWindowSaveBtn",
    "captureWindowResetBtn",
    "calibrationSetupRow",
    "calibrationPreviewBtn",
    "platenWindow",
    "SAVE CALIBRATION",
    "RESET TO DEFAULT",
  ]) {
    assert.doesNotMatch(html, new RegExp(forbidden));
  }
  assert.doesNotMatch(renderer, /saveCaptureWindow|captureWindowMovable|enableCaptureWindowDrag|DEFAULT_ORIGIN_MM/);
  assert.doesNotMatch(preload, /saveCaptureWindow|save-capture-window/);
  assert.doesNotMatch(main, /save-capture-window|saveCaptureWindowOrigin|run-positioning-preview|get-positioning-preview/);
  assert.match(packager, /basename === "calibrate-lide\.js"/);
  assert.match(html, /id="positioningPreviewBtn" hidden>PREVIEW FRONT/);
  assert.match(renderer, /`PREVIEW \$\{side\.toUpperCase\(\)\}`/);
});

test("About UI displays the Scanner package version", async () => {
  assert.equal(SCANNER_VERSION, "1.6.1");
  const document = await renderSetup({ stage: "active", calibrationStatus: "VALID", summary: { availableCredits: 5 } });
  assert.equal(document.getElementById("appVersion").textContent, `v${SCANNER_VERSION}`);
});

test("a non-ACTIVE station exposes no card or billing workflow before authority is known", async () => {
  const document = await renderSetup({ stage: "pending", summary: { availableCredits: 5 } });
  assert.equal(document.getElementById("operationalWorkflow").hidden, true);
  assert.equal(document.getElementById("stationSetupModal").classList.contains("visible"), true);
  assert.equal(document.getElementById("billingLockModal").classList.contains("visible"), false);
  assert.match(document.getElementById("stationSetupTitle").textContent, /Waiting for MintVault approval/);
});

test("an approved station automatically prepares its fixed profile without a user-facing calibration stage", async () => {
  const document = await renderSetup(
    { stage: "active", calibrationStatus: "UNPROVISIONED", summary: { availableCredits: 5 } },
    { scannerHealth: { status: "profile_unprovisioned" } }
  );
  assert.equal(document.getElementById("operationalWorkflow").hidden, true);
  assert.equal(document.getElementById("stationSetupModal").classList.contains("visible"), true);
  assert.equal(document.getElementById("positioningPreviewBtn").hidden, true);
  assert.match(document.getElementById("stationSetupTitle").textContent, /Preparing Scanner/);
  assert.match(document.getElementById("stationSetupText").textContent, /automatically applying/i);
  assert.doesNotMatch(document.body.textContent, /save calibration|reset to default|drag/i);
});

test("an ACTIVE fixed-profile station preserves the guarded zero-credit workflow", async () => {
  const document = await renderSetup(
    { stage: "active", calibrationStatus: "VALID", summary: { availableCredits: 0 } },
    { availableCredits: 0 }
  );
  assert.equal(document.getElementById("operationalWorkflow").hidden, false);
  assert.equal(document.getElementById("stationSetupModal").classList.contains("visible"), false);
  assert.equal(document.getElementById("newCardBtn").disabled, true);
  assert.equal(document.getElementById("creditEmptyPanel").hidden, false);
  assert.equal(document.getElementById("billingLockModal").classList.contains("visible"), true);
});

test("the armed side alone gets Preview and Scan, with front/back labels bound to the server target", async () => {
  const front = {
    id: "session-front",
    certId: "MV901",
    side: "front",
    stage: "awaiting_scan",
  };
  const frontDocument = await renderSetup(
    { stage: "active", calibrationStatus: "VALID", summary: { availableCredits: 5 } },
    {
      scannerHealth: { status: "ready" },
      activeCapture: front,
      placementApproval: { state: "GREEN", sessionId: front.id, certId: front.certId, side: front.side },
    }
  );
  assert.equal(frontDocument.getElementById("positioningPreviewBtn").hidden, false);
  assert.equal(frontDocument.getElementById("positioningPreviewBtn").textContent, "PREVIEW FRONT");
  assert.equal(frontDocument.getElementById("scanCardBtn").textContent, "SCAN FRONT");
  assert.equal(frontDocument.getElementById("scanCardBtn").disabled, false);
  assert.match(frontDocument.getElementById("workflowGuideStep").textContent, /STEP 1/);

  const back = { ...front, id: "session-back", side: "back" };
  const backDocument = await renderSetup(
    { stage: "active", calibrationStatus: "VALID", summary: { availableCredits: 5 } },
    {
      scannerHealth: { status: "ready" },
      activeCapture: back,
      placementApproval: { state: "GREEN", sessionId: back.id, certId: back.certId, side: back.side },
    }
  );
  assert.equal(backDocument.getElementById("positioningPreviewBtn").textContent, "PREVIEW BACK");
  assert.equal(backDocument.getElementById("scanCardBtn").textContent, "SCAN BACK");
  assert.match(backDocument.getElementById("workflowGuideStep").textContent, /STEP 2 — FLIP/);
});

test("Fix missing images remains server-derived, target-bound recovery with no destructive card action", () => {
  assert.match(html, /FIX THIS CARD arms the missing side on this station straight away/);
  assert.match(renderer, /fixBtn\.textContent = "FIX THIS CARD"/);
  assert.match(renderer, /cardJobId: item\.cardJobId/);
  assert.doesNotMatch(renderer, /prompt\(|Enter an MV|deleteCert|delete-cert/);
  assert.doesNotMatch(preload, /deleteCert|delete-cert/);
  assert.doesNotMatch(main, /ipcMain\.handle\("delete-cert"/);
});
