/**
 * MintVault Scanner — Electron main process.
 *
 * Single-process replacement for the old watcher.mjs + guide-window/* +
 * SwiftBar plugin. All three responsibilities live here:
 *
 *   - chokidar-based scan watcher (lib/watcher.js)
 *   - macOS tray icon with status indicator (lib/tray pattern inline)
 *   - frameless BrowserWindow popover for the operator UI
 *
 * Why one process: three processes was the bug. Watcher dying without the
 * tray noticing meant 20-minute "is it broken?" debug sessions. Now: if
 * anything dies, LaunchAgent restarts the whole thing and either the tray
 * icon reappears or it doesn't — no silent drift.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require("electron");
const path  = require("node:path");
const os    = require("node:os");

const stateMod = require("./lib/state");
const server   = require("./lib/server-client");
const { Watcher, INBOX } = require("./lib/watcher");

// macOS: this is a menu-bar-only app, no Dock icon.
if (process.platform === "darwin" && app.dock) app.dock.hide();

// Prevent multiple instances stacking up if launchd misbehaves.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// Force the GPU off in this process — tray-only Electron apps
// occasionally hang on GPU init under launchd.
app.disableHardwareAcceleration();

let tray         = null;
let popover      = null;
let watcher      = null;
let isQuitting   = false;

const ASSETS = path.join(__dirname, "assets");

// ── Tray ─────────────────────────────────────────────────────────────────

function trayImageForState(s) {
  // Template images are auto-tinted by macOS for dark/light menu bar. We
  // ship 16/32px PNGs flagged template; main.js falls back to a text fallback
  // when assets are missing so the app still works on first install before
  // anyone has dropped real PNGs in.
  const map = {
    idle:            "tray-idle.png",
    front_buffered:  "tray-busy.png",
    uploading:       "tray-busy.png",
    success:         "tray-idle.png",
    error:           "tray-error.png",
    manual_pending:  "tray-busy.png",
  };
  const file = map[s] || "tray-idle.png";
  const fpath = path.join(ASSETS, file);
  let img;
  try {
    img = nativeImage.createFromPath(fpath);
    if (img.isEmpty()) throw new Error("empty");
  } catch {
    // Fallback: build a tiny coloured square so the tray slot is visible.
    img = nativeImage.createEmpty();
  }
  // Template images render in the menu bar's accent colour; non-template
  // (error / busy) keep the source colour.
  if (file === "tray-idle.png") img.setTemplateImage(true);
  return img;
}

function trayTooltipForState(s) {
  const stateLabels = {
    idle:           "Idle — waiting for scan",
    front_buffered: "Front captured — scan back",
    uploading:      "Uploading…",
    success:        "Upload succeeded",
    error:          "Upload failed",
    manual_pending: "Manual mode — waiting for scan",
  };
  const label = stateLabels[s.state] || s.state;
  return `MintVault Scanner — ${label} (${s.mode})`;
}

function refreshTray() {
  if (!tray) return;
  const s = stateMod.get();
  tray.setImage(trayImageForState(s.state));
  tray.setToolTip(trayTooltipForState(s));
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const s = stateMod.get();
  const menu = Menu.buildFromTemplate([
    { label: `MintVault Scanner — ${s.state}`, enabled: false },
    { label: `Mode: ${s.mode}`, enabled: false },
    { label: `Last: ${s.lastUploadedCert || "—"}`, enabled: false },
    { type: "separator" },
    { label: "Show window", click: () => showPopover() },
    { label: "Open inbox folder", click: () => shell.openPath(INBOX) },
    { label: "Show logs", click: () => shell.openPath(path.join(os.homedir(), "mintvault-scans", "scanner-app.log")) },
    { label: "Restart watcher", click: async () => { await watcher.stop(); await watcher.start(); refreshTray(); } },
    { type: "separator" },
    { label: "About", click: () => showPopover() },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function setupTray() {
  const s = stateMod.get();
  tray = new Tray(trayImageForState(s.state));
  tray.setToolTip(trayTooltipForState(s));

  // Left click → popover; right click → context menu (handled by setContextMenu).
  tray.on("click", () => togglePopover());

  buildTrayMenu();
}

// ── Popover (BrowserWindow) ──────────────────────────────────────────────

function createPopover() {
  popover = new BrowserWindow({
    width: 420,
    height: 600,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popover.loadFile(path.join(__dirname, "renderer", "index.html"));

  popover.on("blur", () => {
    if (!popover.webContents.isDevToolsOpened()) popover.hide();
  });

  popover.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      popover.hide();
    }
  });
}

function positionPopoverNearTray() {
  if (!tray || !popover) return;
  const trayBounds = tray.getBounds();
  const winBounds  = popover.getBounds();
  const display    = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  // Place under the tray icon, clamped to display.
  const x = Math.round(Math.min(
    Math.max(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2, display.workArea.x + 8),
    display.workArea.x + display.workArea.width - winBounds.width - 8,
  ));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  popover.setPosition(x, y, false);
}

function showPopover() {
  if (!popover) createPopover();
  positionPopoverNearTray();
  popover.show();
  popover.focus();
}

function togglePopover() {
  if (!popover) { showPopover(); return; }
  if (popover.isVisible()) popover.hide();
  else showPopover();
}

// ── IPC bridge ───────────────────────────────────────────────────────────

function pushStateToRenderer() {
  if (popover && !popover.isDestroyed()) {
    popover.webContents.send("state-update", stateMod.get());
  }
  refreshTray();
}

function setupIpc() {
  ipcMain.handle("get-state", () => stateMod.get());

  ipcMain.handle("set-mode", (_e, mode) => {
    watcher.setMode(mode);
    return { ok: true, mode };
  });

  ipcMain.handle("attach-manual-scan", async (_e, payload) => {
    return watcher.attachManualScan(payload || {});
  });

  ipcMain.handle("fetch-orphans", async () => {
    return server.getOrphans();
  });

  ipcMain.handle("arm-one-shot", async (_e, payload) => {
    if (!payload?.certId || !payload?.side) return { ok: false, error: "certId + side required" };
    watcher.armOneShot(payload);
    return { ok: true };
  });

  ipcMain.handle("cancel-one-shot", async () => watcher.cancelOneShot());

  ipcMain.handle("delete-cert", async (_e, { certId, reason }) => {
    if (!certId || !reason || reason.length < 10) return { ok: false, error: "certId + reason ≥10 chars" };
    return server.softDeleteCert(certId, reason);
  });

  ipcMain.handle("retry-last", async () => watcher.retryLastPair());

  ipcMain.handle("reset-buffered", async () => watcher.resetBuffered());

  ipcMain.handle("restart-watcher", async () => {
    await watcher.stop();
    await watcher.start();
    return { ok: true };
  });

  ipcMain.handle("forward-to-cert", async (_e, certId) => {
    if (!certId || !/^MV\d+$/i.test(certId)) return { ok: false, error: "format MV###" };
    stateMod.set({ nextCertOverride: certId.toUpperCase() });
    pushStateToRenderer();
    return { ok: true };
  });

  ipcMain.handle("hide-popover", () => { if (popover) popover.hide(); return { ok: true }; });

  ipcMain.handle("open-inbox", () => { shell.openPath(INBOX); return { ok: true }; });

  ipcMain.handle("open-logs", () => {
    shell.openPath(path.join(os.homedir(), "mintvault-scans", "scanner-app.log"));
    return { ok: true };
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────

app.on("second-instance", () => showPopover());

app.whenReady().then(async () => {
  stateMod.load();

  watcher = new Watcher();
  watcher.on("state-changed", () => pushStateToRenderer());
  watcher.on("scan-detected", (evt) => {
    if (popover && !popover.isDestroyed()) {
      popover.webContents.send("scan-detected", evt);
      showPopover();
    }
  });

  setupTray();
  createPopover();
  setupIpc();

  await watcher.start();
  refreshTray();
});

app.on("window-all-closed", (e) => {
  // Don't quit when popover is hidden — this app is menu-bar-only.
  e.preventDefault();
});

app.on("before-quit", () => { isQuitting = true; });
