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

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, powerMonitor } = require("electron");
const { spawn } = require("node:child_process");
const fs    = require("node:fs");
const path  = require("node:path");
const os    = require("node:os");
const { randomUUID } = require("node:crypto");

/**
 * The in-flight NEW CARD retry token (P6).
 *
 * Advisory process state only, and safe to lose: if the app restarts mid-press the token is gone
 * and the next press is a genuinely new request — the SERVER's (station, client_op_id) record is
 * the authority on what was already bought, never this variable. That is what invariant I19
 * requires: no process-local state may be authoritative over money.
 */
let pendingNewCardOpId = null;

const stateMod = require("./lib/state");
const server   = require("./lib/server-client");
const { Watcher } = require("./lib/watcher");
const stationClient = require("./lib/station-client");
const stationIdentity = require("./lib/station-identity");
const helperIntegrity = require("./lib/helper-integrity");

helperIntegrity.configureRuntime({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
});

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
const APP_VERSION  = (() => { try { return require("./package.json").version; } catch { return "?"; } })();

function versionTuple(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(raw || "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionSatisfies(installed, minimum) {
  if (!minimum) return true;
  const a = versionTuple(installed);
  const b = versionTuple(minimum);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
}
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

function trayImageForState(s) {
  // Template images are auto-tinted by macOS — black source becomes white
  // in dark mode, accent in light mode. All four states ship as templates
  // for visual consistency; differentiation is via glyph shape (M / M+arrow
  // / M+exclamation). The scanner has one target-bound capture mode, so the
  // tray never presents a paused/manual/watch-folder state as normal work.
  const map = {
    idle:            "tray-idle.png",
    starting:        "tray-busy.png",
    scanning_front:  "tray-busy.png",
    scanning_back:   "tray-busy.png",
    awaiting_scan:   "tray-idle.png",
    preview_ready:   "tray-idle.png",
    preview_error:   "tray-error.png",
    expired:         "tray-error.png",
    finalising:      "tray-busy.png",
    uploading:       "tray-busy.png",
    validating:      "tray-busy.png",
    retrying:        "tray-busy.png",
    success:         "tray-idle.png",
    error:           "tray-error.png",
  };
  const file = map[s] || "tray-idle.png";
  const img = loadTrayPng(file);
  img.setTemplateImage(true);
  return img;
}

function trayTooltipForState(s) {
  const stateLabels = {
    idle:           "Ready — waiting for a server-owned capture",
    starting:       "Starting scanner…",
    scanning_front: "Scanning front…",
    scanning_back:  "Scanning back…",
    awaiting_scan:  "Target armed — waiting for operator Scan",
    preview_ready:  "Preview ready — accept or rescan",
    preview_error:  "Preview needs attention",
    expired:        "Capture target expired",
    finalising:     "Processing image…",
    uploading:      "Uploading original TIFF…",
    validating:     "Validating evidence…",
    retrying:       "Retrying current side…",
    success:        "Capture accepted",
    error:          "Capture needs attention",
  };
  const label = stateLabels[s.state] || s.state;
  return `MintVault Scanner — ${label}`;
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
    { label: `Last: ${s.lastUploadedCert || "—"}`, enabled: false },
    { type: "separator" },
    { label: "Show window", click: () => showPopover() },
    { label: "Show service logs", click: () => shell.openPath(SCANNER_LOG) },
    { label: "Restart scanner service", click: () => rebootScanner() },
    { type: "separator" },
    { label: "About", click: () => showPopover() },
  ]);
  tray.setContextMenu(menu);
}

function setupTray() {
  const s = stateMod.get();
  let img;
  try {
    img = trayImageForState(s.state);
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
    // A durable half-screen station surface, not a transient tiny popover.
    // It remains open while the operator selects the next target in MintVault.
    width: 660,
    height: 760,
    show: false,
    frame: false,
    transparent: false,
    resizable: true,
    minWidth: 580,
    minHeight: 620,
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popover.loadFile(path.join(__dirname, "renderer", "index.html"));

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
  // A menu-bar item can be at the top *or* bottom of a display. The previous
  // unconditional "under" placement put the Scanner window below a bottom
  // menu bar, making the app appear to have vanished just when the operator
  // needed to review a positioning scan.
  const x = Math.round(Math.min(
    Math.max(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2, display.workArea.x + 8),
    display.workArea.x + display.workArea.width - winBounds.width - 8,
  ));
  const trayAtTop = trayBounds.y <= display.workArea.y + 32;
  const preferredY = trayAtTop
    ? trayBounds.y + trayBounds.height + 4
    : trayBounds.y - winBounds.height - 4;
  const y = Math.round(Math.min(
    Math.max(preferredY, display.workArea.y + 8),
    display.workArea.y + display.workArea.height - winBounds.height - 8,
  ));
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

function stationSummary(sessionBody, availableCredits) {
  if (!sessionBody || typeof sessionBody !== "object") return null;
  return {
    organisationName: typeof sessionBody.organisationName === "string" ? sessionBody.organisationName : null,
    locationName: typeof sessionBody.locationName === "string" ? sessionBody.locationName : null,
    displayName: typeof sessionBody.displayName === "string" ? sessionBody.displayName : null,
    // Number, or null. NEVER 0 as a stand-in for "not answered": an unasked question rendered as an
    // empty wallet would stop a station that can work perfectly well.
    availableCredits: typeof availableCredits === "number" ? availableCredits : null,
  };
}

/**
 * Best-effort read of the shop's balance for the identity row.
 *
 * Deliberately swallows every failure to null. This is a DISPLAY value: the server re-checks the
 * balance on every NEW press and refuses independently, so a station that cannot read it must still
 * be able to work. Blocking setup on a credits fetch would turn a reporting hiccup into a dead shop.
 */
async function availableCreditsOrNull() {
  try {
    const result = await stationClient.creditSummary();
    const value = result?.ok ? result.body?.summary?.availableCredits : null;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/** Sanitised first-run state only — no cookie, private key, UUID or fingerprint crosses IPC. */
async function stationSetupState() {
  let session;
  try {
    session = await stationClient.stationSession();
  } catch (error) {
    return { ok: true, stage: "sign_in", error: error?.message || "Sign in to MintVault" };
  }
  if (!session.ok || !session.body?.mfaPassed) {
    if (session.status === 503) {
      return { ok: true, stage: "station_unavailable", error: "MintVault station service is temporarily unavailable. Contact a MintVault Super Admin." };
    }
    return { ok: true, stage: session.body?.mfaRequired ? "mfa" : "sign_in" };
  }
  const summary = stationSummary(session.body, await availableCreditsOrNull());
  const code = stationIdentity.currentStationCode();
  if (!code) {
    const locations = await stationClient.enrolmentLocations();
    if (!locations.ok) {
      return {
        ok: true,
        stage: "station_unavailable",
        summary,
        error: locations.status === 503
          ? "MintVault station enrolment is temporarily unavailable. Contact a MintVault Super Admin."
          : "MintVault could not confirm this station’s authorised location.",
      };
    }
    return {
      ok: true,
      stage: "register",
      summary,
      locations: locations.ok && Array.isArray(locations.body?.locations) ? locations.body.locations.map((location) => ({
        id: String(location.id), name: String(location.name),
      })) : [],
    };
  }
  const status = await stationClient.enrolmentStatus(code);
  if (!status.ok || !status.body?.station) {
    return { ok: true, stage: "station_unavailable", summary, stationCode: code };
  }
  const station = status.body.station;
  if (!versionSatisfies(APP_VERSION, station.minimumSupportedVersion)) {
    return {
      ok: true,
      stage: "update_required",
      summary,
      stationCode: code,
      minimumSupportedVersion: station.minimumSupportedVersion,
      error: "This Scanner version is no longer supported. Install the current signed MintVault Scanner release.",
    };
  }
  try { stationIdentity.setStationStatus(station.status); } catch {}
  return {
    ok: true,
    stage: String(station.status || "PENDING").toLowerCase(),
    summary,
    stationCode: code,
    calibrationStatus: station.calibrationStatus || "UNPROVISIONED",
  };
}

function heartbeatPayload() {
  const state = stateMod.get();
  const health = state.scannerHealth || {};
  const scannerStatus = String(health.status || "checking");
  return {
    appVersion: APP_VERSION,
    scannerConnected: ["ready", "busy", "profile_unprovisioned"].includes(scannerStatus),
    scannerHardware: {
      manufacturer: "Canon",
      model: String(health.model || "CanoScan LiDE 400"),
      ...(health.serial ? { serial: String(health.serial) } : {}),
      ...(health.deviceId ? { deviceId: String(health.deviceId) } : {}),
    },
    scannerProfileVersion: String(health.profileVersion || "mintvault-canon-lide-400-v3"),
    pendingUploadCount: watcher ? watcher.targetedPendingUploadCount() : 0,
    captureState: String(state.activeCapture?.stage || state.state || "IDLE").slice(0, 64),
    ...(state.lastError ? { lastFailureCode: String(state.lastError).slice(0, 120) } : {}),
  };
}

function setupIpc() {
  ipcMain.handle("get-state", () => stateMod.get());

  // Generic settings setter — only allows keys whitelisted in lib/state.js.
  // Used by the popover's Settings section (auto-open-on-error checkbox).
  ipcMain.handle("set-setting", (_e, payload) => {
    if (!payload || typeof payload.key !== "string") return { ok: false, error: "missing key" };
    stateMod.setSetting(payload.key, payload.value);
    pushStateToRenderer();
    return { ok: true };
  });

  /**
   * P7 — the FIX picker.
   *
   * Now calls the tenant-scoped partner queue instead of `/api/admin/orphan-certs`, which correctly
   * refuses a signed station because it addresses certificates with NO tenant predicate. The button
   * was dead for exactly that reason; the fix is a properly scoped route, not a weakened guard.
   */
  ipcMain.handle("fetch-orphans", async () => {
    return server.getFixQueue();
  });

  ipcMain.handle("authorise-fix", async (_event, payload) => {
    const cardJobId = payload && typeof payload.cardJobId === "string" ? payload.cardJobId : "";
    if (!cardJobId) return { ok: false, error: "Select a card to fix" };
    const result = await server.authoriseFix(cardJobId, payload && payload.sides);
    if (result.ok) return { ok: true, fix: result.body && result.body.fix };
    const error = (result.body && result.body.error) || {};
    return { ok: false, code: error.code || "error", error: error.message || "Could not start the fix" };
  });

  /**
   * P6 — NEW CARD.
   *
   * THE RETRY TOKEN IS MINTED HERE, IN THE MAIN PROCESS, AND HELD UNTIL THE SERVER ANSWERS. A
   * renderer that generated a fresh id per click would turn an impatient double-click into two
   * paid cards. Holding it means every retry of the SAME press carries the SAME token, so the
   * server answers the second one from its idempotency record rather than the wallet.
   *
   * The token is cleared only once the server has given a definitive answer — success or a refusal
   * the operator must act on. A network error deliberately KEEPS it, because that is exactly the
   * case where we do not know whether the card was created.
   */
  ipcMain.handle("start-new-card", async (_event, payload) => {
    const cardName = payload && typeof payload.cardName === "string" ? payload.cardName : "";
    if (!pendingNewCardOpId) pendingNewCardOpId = `new-${randomUUID()}`;
    let result;
    try {
      result = await server.startNewCard(pendingNewCardOpId, cardName);
    } catch (err) {
      // Outcome unknown — keep the token so a retry replays instead of buying a second card.
      return { ok: false, retryable: true, error: err && err.message ? err.message : "Could not reach MintVault" };
    }
    if (result.ok) {
      pendingNewCardOpId = null;
      const job = result.body && result.body.cardJob ? result.body.cardJob : {};
      return { ok: true, cardJob: job };
    }
    // A refusal the operator can act on (no credits, suspended, station not approved) is final for
    // this press: the token is released so their NEXT press is a genuinely new request.
    pendingNewCardOpId = null;
    const error = (result.body && result.body.error) || {};
    return { ok: false, retryable: false, code: error.code || "error", error: error.message || "Could not start a new card" };
  });

  // Recovery opens the exact historic certificate in the authenticated web
  // workstation. That page creates the server-owned capture session; this app
  // never arms arbitrary certificate/side combinations from a scanner token.
  ipcMain.handle("open-grade-cert", async (_e, certId) => {
    if (!certId || !/^MV\d+$/i.test(String(certId))) return { ok: false, error: "format MV###" };
    const base = server.API_BASE.replace(/\/$/, "");
    const url = `${base}/admin?search=${encodeURIComponent(String(certId).toUpperCase())}`;
    shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle("get-version", () => ({ ok: true, version: APP_VERSION }));

  ipcMain.handle("get-station-setup", () => stationSetupState());
  ipcMain.handle("station-sign-in", async (_event, payload) => {
    const email = typeof payload?.email === "string" ? payload.email.trim() : "";
    const password = typeof payload?.password === "string" ? payload.password : "";
    if (!email || !password) return { ok: false, error: "Email and password are required" };
    const result = await stationClient.signIn(email, password);
    return result.ok ? stationSetupState() : { ok: false, error: result.body?.error || "MintVault sign-in failed" };
  });
  ipcMain.handle("station-complete-mfa", async (_event, payload) => {
    const code = typeof payload?.code === "string" ? payload.code.trim() : "";
    const recoveryCode = typeof payload?.recoveryCode === "string" ? payload.recoveryCode.trim() : "";
    if (!code && !recoveryCode) return { ok: false, error: "Authentication code or recovery code is required" };
    const result = await stationClient.completeMfa({ code, recoveryCode });
    return result.ok ? stationSetupState() : { ok: false, error: result.body?.error || "Authentication code was not accepted" };
  });
  ipcMain.handle("register-station", async (_event, payload) => {
    const locationId = typeof payload?.locationId === "string" && payload.locationId ? payload.locationId : undefined;
    if (locationId) {
      const selected = await stationClient.selectLocation(locationId);
      if (!selected.ok) return { ok: false, error: selected.body?.error || "Selected location is not available" };
    }
    const result = await stationClient.registerThisMac({ locationId, appVersion: APP_VERSION });
    return result.ok ? stationSetupState() : { ok: false, error: result.body?.error?.message || result.body?.error || "Station registration failed" };
  });
  ipcMain.handle("station-sign-out", async () => {
    if (stateMod.get().activeCapture || watcher?.targetedPendingUploadCount()) {
      return { ok: false, error: "Finish or safely retry the current card before switching operator" };
    }
    stationIdentity.clearOperatorSession();
    return { ok: true, stage: "sign_in" };
  });

  // These are purpose-built station controls. The renderer never receives a
  // local TIFF path and never supplies a certificate/card/side: Watcher derives
  // all of that from its server-claimed active target and rejects stale IDs.
  ipcMain.handle("scan-target", async () => {
    if (!watcher) return { ok: false, error: "Scanner service is starting" };
    return watcher.scanActiveTarget();
  });

  // Setup Preview is intentionally not a target operation. The renderer can
  // request the one fixed full-platen local JPEG scan, but supplies neither a
  // file path nor any certificate/card/side identity.
  ipcMain.handle("run-positioning-preview", async () => {
    if (!watcher) return { ok: false, error: "Scanner service is starting" };
    return watcher.runPositioningPreview();
  });

  ipcMain.handle("get-positioning-preview", (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Positioning preview is unavailable" };
    return watcher.positioningPreviewData(previewId);
  });

  ipcMain.handle("apply-positioning-preview", (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Positioning preview is unavailable" };
    return watcher.applyPositioningPreview(previewId);
  });

  ipcMain.handle("get-capture-preview", (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Preview is unavailable" };
    return watcher.previewData(previewId);
  });

  ipcMain.handle("accept-capture-preview", async (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Preview is unavailable" };
    return watcher.acceptPreview(previewId);
  });

  ipcMain.handle("rescan-capture-preview", async (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Preview is unavailable" };
    return watcher.rescanPreview(previewId);
  });

  // Scanner software is released only as an owner-approved, signed package.
  // Never turn a physical station into a mutable Git checkout or run npm on
  // an operator's Mac: that would make dependency resolution part of capture
  // authority. The UI sends the operator to the controlled release channel.
  ipcMain.handle("update-app", async () => {
    return {
      ok: false,
      code: "signed_release_required",
      error: "Install the current signed MintVault Scanner package through the approved release channel. This station will not self-update from Git.",
    };
  });

  // Reset the scanner — 3-tier escalation against the LIVE com.mintvault.scanner
  // agent (this app), never the decommissioned scanner-watcher. Tier 1 (Soft)
  // restarts the in-process station service here; if that can't recover, we
  // hand off to reset-agent.sh (Reload/Repair) which outlives this process
  // being killed by kickstart. The operator gets a plain-English status, never
  // a raw exit code.
  ipcMain.handle("reset-scanner", async () => {
    // Tier 1 — Soft: restart the in-process station service.
    try {
      logToFile("Soft: in-process scanner service restart");
      await watcher.stop();
      await watcher.start();
      if (watcher.chokidar) {
        logToFile("Soft OK → scanner service running");
        pushStateToRenderer();
        refreshTray();
        return { ok: true, tier: "soft", status: "Restarted" };
      }
      logToFile("Soft: scanner service did not come back up → escalating");
    } catch (err) {
      logToFile(`Soft failed: ${err.message} → escalating`);
    }
    // Tier 2/3 — Reload/Repair via the detached helper (kills+relaunches us).
    spawnResetAgent("in-app Soft tier insufficient");
    return { ok: true, tier: "reload", status: "Reloading agent…", escalated: true };
  });

  ipcMain.handle("hide-popover", () => { if (popover) popover.hide(); return { ok: true }; });

  ipcMain.handle("open-logs", () => {
    shell.openPath(SCANNER_LOG);
    return { ok: true };
  });

  // Open the public logbook page for the most-recently-uploaded cert.
  // Reuses the existing lastUploadedCert state field after an accepted
  // target-bound capture. The public /cert/:id route shows its evidence.
  ipcMain.handle("open-last-cert", () => {
    const certId = stateMod.get().lastUploadedCert;
    if (!certId) return { ok: false, error: "no cert uploaded yet this session" };
    const base = server.API_BASE.replace(/\/$/, "");
    const url = `${base}/cert/${encodeURIComponent(certId)}`;
    shell.openExternal(url);
    return { ok: true, url };
  });

  // This only dismisses a server-derived, persisted CARD REGISTERED notice.
  // It cannot arm, retarget, or otherwise mutate a capture session.
  ipcMain.handle("acknowledge-card-registered", () => {
    if (!stateMod.get().lastAcceptedCapture?.cardRegistered) {
      return { ok: false, error: "No registered card is awaiting acknowledgement" };
    }
    stateMod.set({ state: "idle", lastAcceptedCapture: null });
    return { ok: true };
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────

app.on("second-instance", () => showPopover());

app.whenReady().then(async () => {
  stateMod.load();

  watcher = new Watcher();
  let lastErrorState = false;
  let lastSuccessState = false;
  let lastPositioningPreviewId = null;
  watcher.on("state-changed", () => {
    pushStateToRenderer();
    const s = stateMod.get();
    const isError   = s.state === "error";
    const isSuccess = s.state === "success";
    // Auto-open popover on error transition (idle→error edge only).
    if (isError && !lastErrorState && s.autoOpenOnError && popover && !popover.isVisible()) {
      console.log(`[main] auto-opening popover on error: ${s.lastError || "(no message)"}`);
      showPopover();
    }
    const positioning = s.positioningPreview;
    if (
      positioning?.id &&
      positioning.id !== lastPositioningPreviewId &&
      ["detected", "reposition", "not_detected"].includes(positioning.status)
    ) {
      lastPositioningPreviewId = positioning.id;
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
  });

  setupTray();
  createPopover();
  setupIpc();

  await watcher.start();
  // Session polling is deliberately inside the one existing scanner process.
  // It never watches a staging folder or calls the legacy unbound ingest.
  let targetedCapturePollInFlight = false;
  const pollTargetedCapture = async () => {
    if (targetedCapturePollInFlight) return;
    targetedCapturePollInFlight = true;
    try {
      await watcher.refreshScannerHealth();
      await watcher.pollTargetedCapture();
    } catch (err) {
      console.error(`[targeted-capture] poll failed: ${err?.message || err}`);
    } finally {
      targetedCapturePollInFlight = false;
    }
  };
  // Target polling is not fleet telemetry. Enrolled stations use a jittered
  // idle cadence to avoid a 5,000-Mac synchronised 3-second request storm;
  // a local development proof retains its short feedback loop. Once a target
  // is active the cadence tightens solely for that one station/session.
  const targetPollDelayMs = () => {
    if (!stationIdentity.hasActiveStationSession()) return 3_000;
    if (stateMod.get().activeCapture) return 5_000;
    return 25_000 + Math.floor(Math.random() * 10_000);
  };
  const scheduleTargetPoll = () => {
    setTimeout(async () => {
      await pollTargetedCapture();
      scheduleTargetPoll();
    }, targetPollDelayMs());
  };
  void pollTargetedCapture();
  scheduleTargetPoll();

  // Lightweight current-state heartbeat. It is intentionally independent of
  // target polling and carries no TIFF/certificate payload. Server-side it
  // appends events only for meaningful connection/hardware transitions.
  let heartbeatInFlight = false;
  const sendHeartbeat = async () => {
    if (heartbeatInFlight || !stationIdentity.hasActiveStationSession()) return;
    heartbeatInFlight = true;
    try {
      const result = await stationClient.heartbeat(heartbeatPayload());
      if (!result.ok) {
        console.warn(`[station-heartbeat] rejected: ${result.body?.error?.code || result.body?.error || `HTTP ${result.status}`}`);
        if ([401, 403, 404, 426].includes(result.status) || result.body?.error?.code === "version_blocked") await stationSetupState();
      }
    } catch (error) {
      console.warn(`[station-heartbeat] failed: ${error?.message || error}`);
    } finally {
      heartbeatInFlight = false;
    }
  };
  const scheduleHeartbeat = () => {
    const delay = 75_000 + Math.floor(Math.random() * 30_000); // 75–105 seconds, per-Mac jitter
    setTimeout(async () => {
      await sendHeartbeat();
      scheduleHeartbeat();
    }, delay);
  };
  void sendHeartbeat();
  scheduleHeartbeat();

  // ── Maintenance (scanner ops pack) ────────────────────────────────────
  // Log rotation: launchd holds the log fd, so rotate copy-truncate style.
  const rotateLogIfNeeded = () => {
    try {
      const st = fs.statSync(SCANNER_LOG);
      if (st.size < 50 * 1024 * 1024) return;
      const dir = path.join(SCANS_BASE, "logs-archive");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      fs.copyFileSync(SCANNER_LOG, path.join(dir, `scanner-app-${stamp}.log`));
      fs.truncateSync(SCANNER_LOG, 0);
      console.log(`[maintenance] rotated scanner-app.log (${Math.round(st.size / 1e6)}MB) → logs-archive/`);
    } catch (err) {
      console.error(`[maintenance] log rotation failed: ${err?.message}`);
    }
  };
  // Scanner TIFFs and diagnostic logs are evidence/support material.  Never
  // auto-delete them on a workstation.  We only warn when attention is needed;
  // any retention decision is an explicit operator action outside this app.
  const reportScanFolderPressure = () => {
    try {
      const duDir = (dir) => {
        let total = 0;
        if (!fs.existsSync(dir)) return 0;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, entry.name);
          try { total += entry.isDirectory() ? duDir(fp) : fs.statSync(fp).size; } catch {}
        }
        return total;
      };
      const bad = duDir(path.join(SCANS_BASE, "failed")) + duDir(path.join(SCANS_BASE, "rejected"));
      if (bad > 500 * 1024 * 1024) {
        console.warn(`[maintenance] failed/ + rejected/ hold ${Math.round(bad / 1e6)}MB — review + clear them`);
      }
    } catch (err) {
      console.error(`[maintenance] folder cleanup failed: ${err?.message}`);
    }
  };
  rotateLogIfNeeded();
  reportScanFolderPressure();
  setInterval(rotateLogIfNeeded, 6 * 3600 * 1000);
  setInterval(reportScanFolderPressure, 24 * 3600 * 1000);

  // Wake-from-sleep recovery: FSEvents subscriptions can go stale across a
  // long sleep — restart the folder watcher and immediately sweep the inbox.
  powerMonitor.on("resume", async () => {
    console.log("[maintenance] system resumed from sleep — restarting watcher + sweeping inbox");
    try { await watcher.stop(); await watcher.start(); } catch (err) { console.error(`[maintenance] resume restart failed: ${err?.message}`); }
    watcher.drainInbox().catch(() => {});
  });
  // Belt-and-braces: sweep the inbox every 10 min for anything chokidar
  // missed. drainInbox is idempotent and respects the confirm/pause gates.
  setInterval(() => watcher.drainInbox().catch(() => {}), 10 * 60 * 1000);
  refreshTray();
  surfacePriorResetStatus();
});

app.on("window-all-closed", (e) => {
  // Don't quit when popover is hidden — this app is menu-bar-only.
  e.preventDefault();
});

app.on("before-quit", () => { isQuitting = true; });
