const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Window } = require("happy-dom");

const APP = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(APP, "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(APP, "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf8");

async function renderSetup(setup, state = {}) {
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
    getState: () => Promise.resolve({ state: "idle", availableCredits: 0, ...state }),
    getStationSetup: () => Promise.resolve(setup),
    getVersion: () => Promise.resolve({ ok: true, version: "1.5.2" }),
  };
  window.eval(renderer);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return window.document;
}

test("station UI keeps final Scan visible but target-gated", () => {
  assert.match(html, /id="scanCardBtn" disabled>SCAN CARD/);
  assert.match(html, /id="positioningPreviewBtn">PREVIEW/);
  assert.doesNotMatch(html, /id="scanCardBtn" hidden/);
  assert.match(renderer, /const scanLabel = hasTarget \? `SCAN \$\{side\}` : "SCAN CARD"/);
  assert.match(renderer, /setActionButton\(els\.scanCardBtn, scanLabel, true, !scanEnabled\)/);
  assert.match(renderer, /Open or arm a card in MintVault to enable final scanning\./);
  assert.match(html, /id="workflowGuide"/);
  assert.match(renderer, /STEP 1 — PLACE CARD/);
  assert.match(renderer, /STEP 2 — FLIP THE CARD/);
});

test("non-ACTIVE setup hides every operational capture and top-up control before the first station answer", () => {
  assert.match(html, /<main id="operationalWorkflow" hidden>/);
  assert.match(renderer, /let stationSetup = \{ stage: "checking" \};/);
  assert.match(renderer, /els\.operationalWorkflow\.hidden = !active;/);
  assert.match(renderer, /renderStationSetup\(\{ stage: "checking" \}\);/);
  assert.match(renderer, /els\.stationSetupTitle\.textContent = "Checking this Mac";/);
  assert.match(renderer, /if \(!stationCanStartCardWork\(\)\)/);
  assert.match(renderer, /closeBillingModal\(\);/);
  assert.match(renderer, /function stationCanStartCardWork\(\)/);
  assert.match(renderer, /!stationCanStartCards \|\| !noAvailableCredits/);
});

test("pending and session-expired stations render only guided setup, never the legacy capture workflow", async () => {
  for (const setup of [
    {
      stage: "pending",
      stationCode: "MV-STN-N5YE3IBUGVMMQDIV",
      summary: { organisationName: "shop games", locationName: "Main location", availableCredits: 0 },
    },
    { stage: "session_expired", stationCode: "MV-STN-N5YE3IBUGVMMQDIV", summary: { availableCredits: 0 } },
  ]) {
    const document = await renderSetup(setup);
    assert.equal(document.getElementById("operationalWorkflow").hidden, true);
    assert.equal(document.getElementById("creditEmptyPanel").hidden, true);
    assert.equal(document.getElementById("billingLockModal").classList.contains("visible"), false);
    assert.equal(document.getElementById("stationSetupModal").classList.contains("visible"), true);
  }
});

test("a calibrated ACTIVE zero-credit station preserves the guarded operational workflow", async () => {
  const document = await renderSetup({ stage: "active", calibrationStatus: "VALID", summary: { availableCredits: 0 } });
  assert.equal(document.getElementById("operationalWorkflow").hidden, false);
  assert.equal(document.getElementById("stationSetupModal").classList.contains("visible"), false);
  assert.equal(document.getElementById("newCardBtn").disabled, true);
  assert.equal(document.getElementById("creditEmptyPanel").hidden, false);
  assert.equal(document.getElementById("billingLockModal").classList.contains("visible"), true);
});

test("an approved but uncalibrated zero-credit station presents calibration instead of top-up", async () => {
  const document = await renderSetup(
    { stage: "active", calibrationStatus: "UNPROVISIONED", summary: { availableCredits: 0 } },
    { scannerHealth: { status: "profile_unprovisioned" } }
  );
  assert.equal(document.getElementById("operationalWorkflow").hidden, false);
  for (const id of ["stationCreditsCell", "captureTargetRow", "statusRow", "captureActionsRow", "recentRow", "diagnosticsRow"]) {
    assert.equal(document.getElementById(id).hidden, true, `${id} must not leak the legacy workflow`);
  }
  assert.equal(document.getElementById("billingLockModal").classList.contains("visible"), false);
  assert.match(document.getElementById("workflowGuideTitle").textContent, /Calibrate this Scanner/);
  assert.equal(document.getElementById("calibrationPreviewBtn").hidden, false);
  assert.match(document.getElementById("calibrationPreviewBtn").textContent, /CHECK SCANNER HEALTH/);
});

test("guided pending state keeps recovery controls and defers calibration/capture until approval", () => {
  for (const id of ["stationRefreshBtn", "stationSignOutBtn", "stationDiagnosticsBtn"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(renderer, /if \(stage === "pending"\)/);
  assert.match(renderer, /Waiting for MintVault approval/);
  assert.match(renderer, /This Mac is connected\. Approve it in MintVault Super Admin\. This screen updates automatically\./);
  assert.match(renderer, /setTimeout\(\(\) => void refreshStationSetup\(\), 6_000\)/);
  assert.match(renderer, /after === "active"\) els\.stationRefreshStatus\.textContent = "APPROVED — CONTINUING"/);
  assert.match(renderer, /Complete placement setup before its first evidence scan\./);
});

test("post-scan Accept/Reject is removed — Scan approval immediately becomes upload", () => {
  const preload = fs.readFileSync(path.join(APP, "preload.js"), "utf8");
  assert.doesNotMatch(html, /id="acceptPreviewBtn"/);
  assert.doesNotMatch(html, /id="rescanPreviewBtn"/);
  assert.match(html, /SCAN ACCEPTED FROM GREEN PREVIEW — UPLOADING THIS TIFF/);
  assert.doesNotMatch(renderer, /acceptPreviewBtn|rescanPreviewBtn|acceptCapturePreview/);
  assert.doesNotMatch(preload, /acceptCapturePreview|accept-capture-preview/);
  assert.doesNotMatch(main, /accept-capture-preview/);
  assert.match(renderer, /scanEstimate/);
  assert.match(renderer, /uploadProgressText/);
});

test("normal placement Preview is a card-centred display crop while full platen and calibration stay secondary", () => {
  assert.match(html, /id="positioningCardPreviewViewport"/);
  assert.match(html, /id="positioningFullPreview"/);
  assert.match(html, /<details class="row settings secondary" id="diagnosticsRow">/);
  /*
   * SAVE PLACEMENT ZONE is gone. It persisted a station's capture origin derived from wherever a
   * card happened to be lying, which is how this station came to be calibrated to the platen corner.
   * The only writer of a capture origin is now the deliberate drag in "Capture window position".
   */
  assert.doesNotMatch(html, /id="savePlacementBtn"/);
  assert.match(html, /id="captureWindowSaveBtn"/);
  assert.match(html, /id="signOutBtn" hidden>SIGN OUT \/ SWITCH USER/);
  assert.match(renderer, /function renderPositioningCardCrop\(/);
  assert.match(renderer, /const marginMm = 8/);
  assert.match(renderer, /No pixels are written, uploaded, or reused as evidence/);
  assert.match(css, /\.positioning-card-preview-viewport \{[^}]*height: 270px/s);
  assert.match(main, /width: 660,[\s\S]*height: 760/);
  assert.doesNotMatch(main, /popover\.on\("blur"/);
});

test("operator sign-out clears only the human session and keeps the Mac station identity", () => {
  const identity = fs.readFileSync(path.join(APP, "lib", "station-identity.js"), "utf8");
  const preload = fs.readFileSync(path.join(APP, "preload.js"), "utf8");
  assert.match(identity, /function clearOperatorSession\(\)/);
  assert.match(identity, /clearOperatorSession,/);
  assert.match(preload, /stationSignOut: \(\) => ipcRenderer\.invoke\("station-sign-out"\)/);
  assert.match(main, /Finish or safely retry the current card before switching operator/);
  assert.match(main, /stationIdentity\.clearOperatorSession\(\)/);
});

test("Fix missing images is target-bound recovery only and cannot delete a certificate", () => {
  const preload = fs.readFileSync(path.join(APP, "preload.js"), "utf8");
  assert.match(html, /Recovery only\./);
  /*
   * P7 replaced "open the card in MintVault" with an in-app, server-derived FIX: the operator never
   * types a card number, so this asserts the CURRENT affordance. The old assertion still named a
   * `recover` button that P7 deleted, and had been failing ever since.
   */
  assert.match(renderer, /fixBtn\.textContent = "FIX THIS CARD"/);
  assert.match(renderer, /cardJobId: item\.cardJobId/);
  assert.doesNotMatch(renderer, /prompt\(|Enter an MV/);
  assert.doesNotMatch(html, /Soft-delete|deleteModal/);
  assert.doesNotMatch(renderer, /deleteCert|delete-cert|Soft-delete/);
  assert.doesNotMatch(preload, /deleteCert|delete-cert/);
  assert.doesNotMatch(main, /ipcMain\.handle\("delete-cert"/);
});

test("the capture area is fixed for normal staff — no drag, no save, and no stale geometry", () => {
  /*
   * OWNER DECISION 2026-08-17. The 100 x 130 mm capture area sits in a proven physical position on
   * the scanner bed. Normal shop work is place-card / PREVIEW / SCAN; nobody on the floor moves it,
   * and somebody moving it by accident is expensive in a way that is invisible at the time — every
   * card afterwards is framed differently from every card before.
   */

  // The overlay STAYS. Staff must still see where to put the card.
  assert.match(html, /id="platenWindow"/);
  assert.match(html, /<span>CAPTURE AREA<\/span>/);

  // The retired inner box is gone from markup, drawing code and styles alike.
  assert.doesNotMatch(html, /id="platenSafe"/);
  assert.doesNotMatch(renderer, /platenSafe/);
  assert.doesNotMatch(renderer, /SAFE_INSET_MM/);

  // Maintenance controls exist but start hidden, and are no longer worded as a normal action.
  assert.match(html, /id="captureWindowMaintenance" hidden/);
  assert.doesNotMatch(html, /SAVE CAPTURE WINDOW/);
  assert.match(html, /MAINTENANCE ONLY/);

  // Authority drives visibility AND the pointer, so an operator who cannot save also cannot drag a
  // box whose read-out would then describe somewhere the hardware does not scan.
  assert.match(renderer, /captureWindowMovable = stationSetup\?\.summary\?\.canCalibrate === true/);
  assert.match(renderer, /if \(!captureWindowMovable\) return;/);

  /*
   * The renderer duplicates the platen bound as a plain number because it is sandboxed. It must
   * match the shared profile's MIN_PLATEN_INSET_MM — the two both reading 5 is what locked every
   * station out of arming a capture.
   */
  const profile = require("../../../shared/lide400-capture-profile.cjs");
  const numeric = (pattern, label) => {
    const found = pattern.exec(renderer);
    assert.ok(found, `the renderer must declare ${label} explicitly`);
    return Number(found[1]);
  };
  assert.strictEqual(
    numeric(/const MIN_INSET_MM = (\d+(?:\.\d+)?);/, "its platen inset"),
    profile.MIN_PLATEN_INSET_MM,
    "renderer platen inset has drifted from the shared capture profile"
  );
  /*
   * The platen and window sizes are duplicated too, and nothing pinned them. A drift there would
   * mis-draw the capture area against the scanner bed with no error anywhere — the operator would be
   * told the window is somewhere it is not.
   */
  assert.strictEqual(
    numeric(/const PLATEN = \{ width: (\d+(?:\.\d+)?),/, "the platen width"),
    profile.PLATEN_MM.width,
    "renderer platen width has drifted from the shared capture profile"
  );
  assert.strictEqual(
    numeric(/const PLATEN = \{ width: \d+(?:\.\d+)?, height: (\d+(?:\.\d+)?) \}/, "the platen height"),
    profile.PLATEN_MM.height,
    "renderer platen height has drifted from the shared capture profile"
  );
  assert.strictEqual(
    numeric(/const WINDOW_MM = \{ width: (\d+(?:\.\d+)?),/, "the capture window width"),
    profile.STANDARD_TCG.outerWindowMm.width,
    "renderer capture window width has drifted from the shared capture profile"
  );
});
