const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(APP, "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(APP, "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf8");

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

test("normal placement Preview is a card-centred display crop while full platen and calibration stay secondary", () => {
  assert.match(html, /id="positioningCardPreviewViewport"/);
  assert.match(html, /id="positioningFullPreview"/);
  assert.match(html, /<details class="row settings secondary" id="diagnosticsRow">/);
  assert.match(html, /id="savePlacementBtn"/);
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
