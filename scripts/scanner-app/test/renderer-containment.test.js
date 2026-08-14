"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const containment = require("../lib/renderer-containment");

const APP_DIR = path.resolve(__dirname, "..");

test("renderer state is an explicit path-free projection", () => {
  const projected = containment.rendererStateProjection({
    state: "preview_ready",
    lastError: "safe message",
    secret: "operator-cookie",
    bufferedFront: "/private/card.tiff",
    scannerHealth: { status: "ready", serial: "SECRET", profileDigestSha256: "a".repeat(64) },
    activeCapture: {
      id: "session-secret",
      certId: "MV123",
      side: "front",
      stage: "preview_ready",
      previewId: "550e8400-e29b-41d4-a716-446655440000",
      cancelEligible: true,
      workstationId: "secret-workstation",
      artifact: { path: "/private/cipher.mvq", wrappedKey: "secret" },
    },
    positioningPreview: {
      id: "550e8400-e29b-41d4-a716-446655440001",
      status: "detected",
      previewPath: "/private/preview.jpg",
      capture: { areaMm: { x: 1, y: 2, width: 100, height: 130 }, scanner: { serial: "SECRET" } },
      cardCandidate: { cardBoundsMm: { x: 5, y: 5, width: 64, height: 89 }, internal: "/tmp/x" },
      placement: { ready: true, originMm: { x: 3, y: 4 }, areaMm: { width: 100, height: 130 } },
      capabilityProof: { path: "/private/proof.tiff", sha256: "b".repeat(64) },
    },
    recent: [{ certId: "MV123", side: "front", ts: "2026-08-14T00:00:00.000Z", source: "/private/source" }],
  });

  assert.equal(projected.activeCapture.certId, "MV123");
  assert.equal(projected.activeCapture.cancelEligible, true);
  assert.equal(projected.positioningPreview.capture.areaMm.width, 100);
  const serialized = JSON.stringify(projected);
  for (const forbidden of ["/private", "/tmp", "operator-cookie", "wrappedKey", "workstationId", "profileDigest", "serial", "session-secret"]) {
    assert.equal(serialized.includes(forbidden), false, `projection leaked ${forbidden}`);
  }
});

test("only the exact local main frame can invoke Scanner IPC", () => {
  const url = containment.rendererUrl(APP_DIR);
  const mainFrame = { url };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  assert.equal(containment.isTrustedRendererEvent({ sender: webContents, senderFrame: mainFrame }, window, url), true);
  assert.equal(containment.isTrustedRendererEvent({ sender: webContents, senderFrame: { url: "https://evil.invalid/" } }, window, url), false);
  assert.equal(containment.isTrustedRendererEvent({ sender: {}, senderFrame: mainFrame }, window, url), false);
  assert.equal(containment.isTrustedRendererEvent({ sender: webContents, senderFrame: { url } }, window, url), false);
});

test("BrowserWindow, preload and document enforce the local renderer boundary", () => {
  const main = fs.readFileSync(path.join(APP_DIR, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(APP_DIR, "preload.js"), "utf8");
  const html = fs.readFileSync(path.join(APP_DIR, "renderer", "index.html"), "utf8");
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-navigate/);
  assert.match(main, /will-redirect/);
  assert.match(main, /will-attach-webview/);
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1, "all channels must use the one authenticated registrar");
  assert.match(preload, /const BRIDGE_VERSION = 3/);
  assert.match(preload, /Object\.freeze\(/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /form-action 'none'/);
});

test("update status projection never crosses a verified artifact path", () => {
  assert.deepEqual(containment.safeUpdateStatus({
    status: "dmg_ready",
    version: "1.2.3",
    path: "/Users/operator/Library/Caches/verified.dmg",
    sha256: "a".repeat(64),
  }), { status: "dmg_ready", version: "1.2.3" });
});
