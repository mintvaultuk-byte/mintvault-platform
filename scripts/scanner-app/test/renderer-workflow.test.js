const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(APP, "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(APP, "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf8");

test("compact station UI keeps final Scan visible but target-gated", () => {
  assert.match(html, /id="scanCardBtn" disabled>SCAN CARD/);
  assert.match(html, /id="positioningPreviewBtn">PREVIEW/);
  assert.doesNotMatch(html, /id="scanCardBtn" hidden/);
  assert.match(renderer, /const scanLabel = hasTarget \? `SCAN \$\{side\}` : "SCAN CARD"/);
  assert.match(renderer, /setActionButton\(els\.scanCardBtn, scanLabel, true, !scanEnabled\)/);
  assert.match(renderer, /Open or arm a card in MintVault to enable final scanning\./);
});

test("normal placement Preview is a compact display crop while full platen is secondary", () => {
  assert.match(html, /id="positioningCardPreviewViewport"/);
  assert.match(html, /id="positioningFullPreview"/);
  assert.match(html, /<details class="row settings secondary" id="diagnosticsRow">/);
  assert.match(renderer, /function renderPositioningCardCrop\(/);
  assert.match(renderer, /const marginMm = 8/);
  assert.match(renderer, /No pixels are written, uploaded, or reused as evidence/);
  assert.match(css, /\.positioning-card-preview-viewport \{[^}]*height: 195px/s);
  assert.match(main, /width: 430,[\s\S]*height: 620/);
});
