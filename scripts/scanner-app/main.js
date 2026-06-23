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
const { spawn } = require("node:child_process");
const fs    = require("node:fs");
const path  = require("node:path");
const os    = require("node:os");

const stateMod = require("./lib/state");
const server   = require("./lib/server-client");
const { Watcher, INBOX, FAILED } = require("./lib/watcher");
const agentPlist = require("./lib/agent-plist");

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

// ── Audible feedback ─────────────────────────────────────────────────────

// Plays one of macOS's bundled system sounds via afplay. Detached + ignored
// stdio so a slow sound subsystem never holds the main process. No-op on
// non-darwin (the app is darwin-only in practice, but the guard keeps a
// future Linux dev environment from crashing on missing afplay).
function playSystemSound(filename) {
  if (process.platform !== "darwin") return;
  try {
    const child = spawn("/usr/bin/afplay", [`/System/Library/Sounds/${filename}`], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (e) => console.warn(`[sound] afplay ${filename} failed: ${e.message}`));
    child.unref();
  } catch (err) {
    console.warn(`[sound] spawn afplay failed: ${err.message}`);
  }
}

// ── Reset / recovery ───────────────────────────────────────────────────────
// The scanner IS the com.mintvault.scanner LaunchAgent (this Electron app).
// Recovery escalates: Soft (in-process watcher restart, handled in the
// reset-scanner IPC) → Reload/Repair (reset-agent.sh, spawned DETACHED because
// the launchctl tiers kill+relaunch this very process). Single source of truth
// for the plist is lib/agent-plist.js. The legacy com.mintvault.scanner-watcher
// daemon is decommissioned and NEVER touched here.

const RESET_HELPER = path.join(__dirname, "reset-agent.sh");
// Reset-log + last-reset marker also respect MINTVAULT_SCANS_DIR so a TEST
// instance keeps its own log/marker in its isolated dir, not the live scanner's.
// agent-plist is intentionally left alone — it drives the LIVE launchd agent's
// plist (don't run "Reset scanner" on a test instance; it targets the prod agent).
const SCANS_BASE   = process.env.MINTVAULT_SCANS_DIR || path.join(os.homedir(), "mintvault-scans");
const SCANNER_LOG  = path.join(SCANS_BASE, "scanner-app.log");
const LAST_RESET   = path.join(SCANS_BASE, "last-reset.json");

// Append a timestamped line to the operator log (tray "Show logs" target).
function logToFile(msg) {
  try {
    fs.appendFileSync(SCANNER_LOG, `[${new Date().toISOString()}] [reset] ${msg}\n`);
  } catch (err) {
    console.warn(`[reset] log append failed: ${err.message}`);
  }
}

// Spawn the detached Reload/Repair escalation. It outlives this process being
// killed by kickstart; the agent's KeepAlive relaunches us and we surface the
// outcome from last-reset.json on boot.
function spawnResetAgent(reason) {
  logToFile(`escalating to reload/repair (reason: ${reason})`);
  const child = spawn("/bin/bash", [RESET_HELPER, reason], { stdio: "ignore", detached: true });
  child.on("error", (e) => logToFile(`reset-agent spawn failed: ${e.message}`));
  child.unref();
}

// On boot, surface the plain-English outcome of a prior Reload/Repair (the app
// was killed mid-reset by kickstart — this is how the operator learns it worked).
function surfacePriorResetStatus() {
  try {
    if (!fs.existsSync(LAST_RESET)) return;
    const st = JSON.parse(fs.readFileSync(LAST_RESET, "utf8"));
    fs.unlinkSync(LAST_RESET); // one-shot
    if (st && st.status) {
      const { Notification } = require("electron");
      new Notification({ title: "MintVault Scanner", body: st.status }).show();
      logToFile(`prior reset outcome: ${st.status}${st.reason ? ` (${st.reason})` : ""}`);
    }
  } catch (err) {
    console.warn(`[reset] could not read ${LAST_RESET}: ${err.message}`);
  }
}

// "Reboot scanner" tray item → full reload/repair of the LIVE agent.
function rebootScanner() {
  const { Notification } = require("electron");
  new Notification({ title: "MintVault Scanner", body: "Reloading agent…" }).show();
  setTimeout(() => spawnResetAgent("tray: Reboot scanner"), 500);
}

// ── Tray ─────────────────────────────────────────────────────────────────

// Last-ditch fallback: a 16×16 PNG of a solid black filled square with
// rounded corners, base64-encoded inline. macOS WILL allocate a tray slot
// for any non-empty nativeImage, so this guarantees the icon appears even
// if the assets/ folder is missing on disk (which was today's bug —
// nativeImage.createEmpty() is treated as "no icon" and gets no slot).
const FALLBACK_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR42mNgGAWj" +
  "YBSMgmEKGBkY/hMQ/A8RIIQYqWUAFAyCAYZRMApGwSgYBaNgFIyCUTAKRsEoGAWj" +
  "YBQAAB3DBOAB1V0NAAAAAElFTkSuQmCC";
let fallbackImage = null;
function getFallbackImage() {
  if (!fallbackImage) {
    fallbackImage = nativeImage.createFromBuffer(Buffer.from(FALLBACK_PNG_B64, "base64"));
    fallbackImage.setTemplateImage(true);
  }
  return fallbackImage;
}

function loadTrayPng(file) {
  const fpath = path.join(ASSETS, file);
  try {
    if (!fs.existsSync(fpath)) {
      console.warn(`[tray] missing PNG: ${fpath} — using inline fallback`);
      return getFallbackImage();
    }
    const img = nativeImage.createFromPath(fpath);
    if (img.isEmpty()) {
      console.warn(`[tray] PNG loaded empty: ${fpath} — using inline fallback`);
      return getFallbackImage();
    }
    return img;
  } catch (err) {
    console.warn(`[tray] PNG load error ${fpath}: ${err.message} — using inline fallback`);
    return getFallbackImage();
  }
}

function trayImageForState(s, paused) {
  // Template images are auto-tinted by macOS — black source becomes white
  // in dark mode, accent in light mode. All four states ship as templates
  // for visual consistency; differentiation is via glyph shape (M / M+arrow
  // / M+exclamation / pause-bars).
  // Paused wins over any logical state — when the watcher is muted, the
  // operator sees the pause glyph regardless of upload state.
  if (paused) {
    const img = loadTrayPng("tray-paused.png");
    img.setTemplateImage(true);
    return img;
  }
  const map = {
    idle:            "tray-idle.png",
    front_buffered:  "tray-busy.png",
    uploading:       "tray-busy.png",
    success:         "tray-idle.png",
    error:           "tray-error.png",
    manual_pending:  "tray-busy.png",
  };
  const file = map[s] || "tray-idle.png";
  const img = loadTrayPng(file);
  img.setTemplateImage(true);
  return img;
}

function trayTooltipForState(s) {
  const paused = stateMod.isPaused();
  if (paused) {
    const minsLeft = Math.max(0, Math.ceil((s.pausedUntil - Date.now()) / 60_000));
    return `MintVault Scanner — Paused (${minsLeft}m remaining)`;
  }
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
  const paused = stateMod.isPaused();
  tray.setImage(trayImageForState(s.state, paused));
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
    { label: "Show logs", click: () => shell.openPath(SCANNER_LOG) },
    { label: "Retry failed (today)", click: async () => {
      const result = watcher.retryFailed();
      if (result.moved > 0) {
        await watcher.stop();
        await watcher.start();
        refreshTray();
      }
    }},
    { label: "Restart watcher", click: async () => { await watcher.stop(); await watcher.start(); refreshTray(); } },
    { label: "Reboot scanner", click: () => rebootScanner() },
    { type: "separator" },
    { label: "About", click: () => showPopover() },
  ]);
  tray.setContextMenu(menu);
}

function setupTray() {
  const s = stateMod.get();
  let img;
  try {
    img = trayImageForState(s.state, stateMod.isPaused());
    console.log(`[tray] created with image (empty=${img.isEmpty()}, template=${img.isTemplateImage()}, size=${JSON.stringify(img.getSize())})`);
  } catch (err) {
    console.error(`[tray] image load failed entirely: ${err.message} — using inline fallback`);
    img = getFallbackImage();
  }
  try {
    tray = new Tray(img);
    tray.setToolTip(trayTooltipForState(s));
    tray.on("click", () => togglePopover());
    buildTrayMenu();
    console.log(`[tray] tray bounds: ${JSON.stringify(tray.getBounds())}`);
  } catch (err) {
    console.error(`[tray] new Tray() failed: ${err.message}`);
    throw err; // launchd will restart — better to crash than run iconless
  }
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

  // Pause toggle. setPaused(true) sets a 30-min ceiling on pausedUntil so
  // a forgotten pause auto-clears. Tray + popover update via the same
  // state-update push that other transitions use.
  ipcMain.handle("set-paused", (_e, paused) => {
    stateMod.setPaused(!!paused);
    pushStateToRenderer();
    return { ok: true, paused: stateMod.isPaused(), pausedUntil: stateMod.get().pausedUntil };
  });

  // Generic settings setter — only allows keys whitelisted in lib/state.js.
  // Used by the popover's Settings section (auto-open-on-error checkbox).
  ipcMain.handle("set-setting", (_e, payload) => {
    if (!payload || typeof payload.key !== "string") return { ok: false, error: "missing key" };
    stateMod.setSetting(payload.key, payload.value);
    pushStateToRenderer();
    return { ok: true };
  });

  // Test-scan — write a 1×1 transparent PNG to ~/mintvault-scans/inbox/
  // with a .tif extension. Chokidar will pick it up like a real scan and
  // route through the same pipeline. Creates a real cert (server has no
  // way to know it's a test), so the operator must soft-delete via the
  // orphan picker afterwards. Documented in README.
  ipcMain.handle("test-scan", () => {
    try {
      const { INBOX } = require("./lib/watcher");
      const ts = Date.now();
      const dest = path.join(INBOX, `test-scan-${ts}.tif`);
      // 1×1 transparent PNG — sharp on the server side decodes it fine.
      // Renamed to .tif so it passes the watcher's accepted-ext filter.
      const TINY_PNG = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABAQEAH" +
        "9N6GgAAAABJRU5ErkJggg==",
        "base64",
      );
      fs.writeFileSync(dest, TINY_PNG);
      console.log(`[test-scan] wrote ${dest} (${TINY_PNG.length} bytes)`);
      return { ok: true, path: dest };
    } catch (err) {
      console.error("[test-scan] failed:", err);
      return { ok: false, error: err.message };
    }
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

  // Operator acknowledged the blocking scan-confirmation popup. Clear it, then
  // drain any scans the gate HELD while it was up (scan-one-write-one). The
  // drain re-gates as soon as the next pair completes, so one card at a time.
  ipcMain.handle("ack-confirm-card", async () => {
    stateMod.set({ confirmCard: null });
    pushStateToRenderer();
    // Drain held scans in the BACKGROUND — do NOT await. The ack must return
    // immediately so the modal closes promptly and the OK button never hangs on
    // a slow upload; drainInbox sets the next confirmCard when the next held
    // pair completes, which re-opens the modal via the state-driven render.
    watcher.drainInbox().catch((e) => console.error("[main] drainInbox after ack failed:", e?.message));
    return { ok: true };
  });

  ipcMain.handle("restart-watcher", async () => {
    await watcher.stop();
    await watcher.start();
    return { ok: true };
  });

  // Reset the scanner — 3-tier escalation against the LIVE com.mintvault.scanner
  // agent (this app), never the decommissioned scanner-watcher. Tier 1 (Soft)
  // restarts the in-process chokidar watcher here; if that can't recover, we
  // hand off to reset-agent.sh (Reload/Repair) which outlives this process
  // being killed by kickstart. The operator gets a plain-English status, never
  // a raw exit code.
  ipcMain.handle("reset-scanner", async () => {
    // Tier 1 — Soft: restart the in-process watcher + clear the buffered pair.
    try {
      logToFile("Soft: in-process watcher restart");
      await watcher.stop();
      watcher.resetBuffered();
      await watcher.start();
      if (watcher.chokidar) {
        logToFile("Soft OK → watching");
        pushStateToRenderer();
        refreshTray();
        return { ok: true, tier: "soft", status: "Restarted" };
      }
      logToFile("Soft: watcher did not come back up → escalating");
    } catch (err) {
      logToFile(`Soft failed: ${err.message} → escalating`);
    }
    // Tier 2/3 — Reload/Repair via the detached helper (kills+relaunches us).
    spawnResetAgent("in-app Soft tier insufficient");
    return { ok: true, tier: "reload", status: "Reloading agent…", escalated: true };
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
    shell.openPath(SCANNER_LOG);
    return { ok: true };
  });

  // Open the public logbook page for the most-recently-uploaded cert.
  // Reuses the existing lastUploadedCert state field (already set on every
  // successful upload — auto + manual + one-shot all write to it). The
  // /cert/:id route is public (no auth), shows images + grade.
  ipcMain.handle("open-last-cert", () => {
    const certId = stateMod.get().lastUploadedCert;
    if (!certId) return { ok: false, error: "no cert uploaded yet this session" };
    const base = server.API_BASE.replace(/\/$/, "");
    const url = `${base}/cert/${encodeURIComponent(certId)}`;
    shell.openExternal(url);
    return { ok: true, url };
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────

app.on("second-instance", () => showPopover());

app.whenReady().then(async () => {
  stateMod.load();

  watcher = new Watcher();
  let lastErrorState = false;
  let lastSuccessState = false;
  let lastConfirmPending = false;
  watcher.on("state-changed", () => {
    pushStateToRenderer();
    const s = stateMod.get();
    const isError   = s.state === "error";
    const isSuccess = s.state === "success";
    const hasConfirm = !!s.confirmCard;

    // Auto-open popover on error transition (idle→error edge only).
    if (isError && !lastErrorState && s.autoOpenOnError && popover && !popover.isVisible()) {
      console.log(`[main] auto-opening popover on error: ${s.lastError || "(no message)"}`);
      showPopover();
    }

    // Auto-open the popover when a scan confirmation appears (edge) — the
    // blocking popup needs the window visible so the operator can't miss it.
    if (hasConfirm && !lastConfirmPending && popover && !popover.isVisible()) {
      console.log(`[main] auto-opening popover for scan confirmation: ${s.confirmCard.certId || "incomplete scan"}`);
      showPopover();
    }

    // Audible feedback — edge-triggered on success and error transitions.
    // afplay is fire-and-forget; we don't wait for it. Each system sound
    // is ~300ms, plenty of head-room before the next state-change tick.
    if (s.soundEnabled !== false) {
      if (isSuccess && !lastSuccessState) playSystemSound("Glass.aiff");
      if (isError   && !lastErrorState)   playSystemSound("Sosumi.aiff");
    }

    lastErrorState     = isError;
    lastSuccessState   = isSuccess;
    lastConfirmPending = hasConfirm;
  });
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
  surfacePriorResetStatus();
});

app.on("window-all-closed", (e) => {
  // Don't quit when popover is hidden — this app is menu-bar-only.
  e.preventDefault();
});

app.on("before-quit", () => { isQuitting = true; });
