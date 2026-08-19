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
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
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
const server = require("./lib/server-client");
const { Watcher } = require("./lib/watcher");
const stationClient = require("./lib/station-client");
const stationIdentity = require("./lib/station-identity");
const environment = require("./lib/environment");
const lide400 = require("./lib/lide400-controller");

// macOS: this is a menu-bar-only app, no Dock icon.
if (process.platform === "darwin" && app.dock) app.dock.hide();

// Prevent multiple instances stacking up if launchd misbehaves.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Force the GPU off in this process — tray-only Electron apps
// occasionally hang on GPU init under launchd.
app.disableHardwareAcceleration();

let tray = null;
let popover = null;
let watcher = null;
let isQuitting = false;

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
const SCANS_BASE = process.env.MINTVAULT_SCANS_DIR || path.join(os.homedir(), "mintvault-scans");
const SCANNER_LOG = path.join(SCANS_BASE, "scanner-app.log");
const APP_VERSION = (() => {
  try {
    return require("./package.json").version;
  } catch {
    return "?";
  }
})();

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
const LAST_RESET = path.join(SCANS_BASE, "last-reset.json");

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
    idle: "tray-idle.png",
    starting: "tray-busy.png",
    scanning_front: "tray-busy.png",
    scanning_back: "tray-busy.png",
    awaiting_scan: "tray-idle.png",
    preview_error: "tray-error.png",
    expired: "tray-error.png",
    finalising: "tray-busy.png",
    uploading: "tray-busy.png",
    validating: "tray-busy.png",
    retrying: "tray-busy.png",
    success: "tray-idle.png",
    error: "tray-error.png",
  };
  const file = map[s] || "tray-idle.png";
  const img = loadTrayPng(file);
  img.setTemplateImage(true);
  return img;
}

function trayTooltipForState(s) {
  const stateLabels = {
    idle: "Ready — waiting for a server-owned capture",
    starting: "Starting scanner…",
    scanning_front: "Scanning front…",
    scanning_back: "Scanning back…",
    awaiting_scan: "Target armed — waiting for operator Scan",
    preview_error: "Preview needs attention",
    expired: "Capture target expired",
    finalising: "Processing image…",
    uploading: "Uploading original TIFF…",
    validating: "Validating evidence…",
    retrying: "Retrying current side…",
    success: "Capture accepted",
    error: "Capture needs attention",
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
    console.log(
      `[tray] created with image (empty=${img.isEmpty()}, template=${img.isTemplateImage()}, size=${JSON.stringify(img.getSize())})`
    );
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
  const winBounds = popover.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  // A menu-bar item can be at the top *or* bottom of a display. The previous
  // unconditional "under" placement put the Scanner window below a bottom
  // menu bar, making the app appear to have vanished just when the operator
  // needed to review a positioning scan.
  const x = Math.round(
    Math.min(
      Math.max(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2, display.workArea.x + 8),
      display.workArea.x + display.workArea.width - winBounds.width - 8
    )
  );
  const trayAtTop = trayBounds.y <= display.workArea.y + 32;
  const preferredY = trayAtTop ? trayBounds.y + trayBounds.height + 4 : trayBounds.y - winBounds.height - 4;
  const y = Math.round(
    Math.min(
      Math.max(preferredY, display.workArea.y + 8),
      display.workArea.y + display.workArea.height - winBounds.height - 8
    )
  );
  popover.setPosition(x, y, false);
}

function showPopover() {
  if (!popover) createPopover();
  positionPopoverNearTray();
  popover.show();
  popover.focus();
}

function togglePopover() {
  if (!popover) {
    showPopover();
    return;
  }
  if (popover.isVisible()) popover.hide();
  else showPopover();
}

// ── IPC bridge ───────────────────────────────────────────────────────────

function pushStateToRenderer() {
  if (popover && !popover.isDestroyed()) {
    /*
     * Resolved on every push rather than cached at boot, so declaring the environment in Service &
     * Diagnostics takes effect immediately. Cheap: a file read the OS has in page cache.
     */
    popover.webContents.send("state-update", { ...stateMod.get(), environment: environment.resolveEnvironment() });
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
    /*
     * MAY THIS OPERATOR MOVE THE CAPTURE AREA? Display only — the server holds the real gate and
     * refuses `POST /stations/calibrations` without `partner.stations.calibrate` regardless of what
     * this says. It exists so a Scanner Operator is not shown a control that will refuse them, which
     * is a worse experience than not seeing it at all.
     *
     * Defaults to FALSE on anything unexpected. The failure direction for "I could not establish
     * whether you may move the scanner's physical capture area" is no.
     */
    canCalibrate: Array.isArray(sessionBody.permissions)
      ? sessionBody.permissions.includes("partner.stations.calibrate")
      : false,
    canPurchaseCredits: Array.isArray(sessionBody.permissions)
      ? sessionBody.permissions.includes("partner.credits.purchase")
      : false,
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

/**
 * RE-ASK THE SERVER WHAT THE WALLET HOLDS, AND COMMIT THE ANSWER TO SHARED STATE.
 *
 * THE DEFECT THIS CLOSES. `creditSummary()` was read once, during setup/session resolution, and the
 * number was then rendered from that setup snapshot for the rest of the shift. Every NEW press
 * reserved a credit and every cancellation returns one, and the figure on the window moved for
 * neither — so an operator watched a station that said 10 while the shop actually had 4, and the
 * first they learned of it was a refusal.
 *
 * CALLED AFTER EVERY RESERVATION-AFFECTING ACTION, including refusals: an INSUFFICIENT_CREDITS
 * answer is exactly the moment the operator most needs the true figure. Arming and capture are NOT
 * reservation-affecting and deliberately do not call it — a credit is reserved at NEW and settled at
 * grading, never in between, so re-asking there would be traffic that can only report the same
 * number.
 *
 * STILL DISPLAY ONLY, and still never a local counter. Nothing here decrements or increments; it
 * asks the server and shows the answer, so a failed fetch degrades to "not answered" rather than to
 * a plausible wrong number.
 */
async function refreshAvailableCredits() {
  const available = await availableCreditsOrNull();
  stateMod.set({
    availableCredits: available,
    walletRefreshGeneration: Number(stateMod.get().walletRefreshGeneration || 0) + 1,
  });
  pushStateToRenderer();
  return available;
}

/**
 * ARM WHATEVER SIDE OF THE OPEN CARD IS STILL OUTSTANDING — the transition that had no caller.
 *
 * THE DEFECT (staging, MV272, 17 Aug 12:09). FRONT was captured, uploaded, validated and persisted:
 * evidence row 5, an immutable 43 MB 1200-DPI master, and the Card Job correctly advanced
 * NEEDS_SCAN -> CAPTURING. Then nothing armed BACK. The server does not auto-arm the next side, and
 * the Scanner's poll only ever CLAIMS sessions that already exist — so no back session was ever
 * created and none could be claimed. The station sat at "FRONT SAVED / Flip the card for Back" and
 * "NOT ARMED" simultaneously, both statements true, with no path between them. The operator flipped
 * the card and pressed the only thing that responded, which ran a placement Preview: it moves the
 * head and sounds exactly like a capture, but by design it is never evidence, so a full physical
 * BACK acquisition produced nothing at all.
 *
 * THE SERVER CHOOSES THE SIDE. This sends only the Card Job id; `authoriseStationCapture` computes
 * the outstanding sides from the evidence ledger. So this can never re-arm a side that already has
 * an accepted master, and the client never names, invents or tracks which side comes next — the
 * missing edge is restored without moving any authority to the Scanner.
 *
 * IDEMPOTENT AND SAFE TO CALL REPEATEDLY. A card with both sides present is refused
 * NOTHING_TO_CAPTURE; a station already holding the right target gets that same session back
 * (the re-arm replay); a card with nothing outstanding simply does nothing. That is what lets it be
 * both an immediate reaction to an accepted side AND the reconciler that runs on the poll, so a
 * restart or a reconnect resolves to the outstanding side rather than to nothing.
 */
let armNextInFlight = false;
async function armNextOutstandingSide(trigger) {
  const state = stateMod.get();
  const cardJobId = state.openCardJob && state.openCardJob.cardJobId;
  if (!cardJobId || state.activeCapture || armNextInFlight) return { ok: false, skipped: true };
  armNextInFlight = true;
  stateMod.set({ armingNextSide: true });
  pushStateToRenderer();
  try {
    let result;
    try {
      result = await server.armCapture(cardJobId);
    } catch (err) {
      // Unknown outcome. Left for the next poll to retry; nothing is recorded as a failure, because
      // a network blip must not paint a red panel over a card that is probably fine.
      console.warn(`[arm-next] (${trigger}) could not reach MintVault: ${err && err.message}`);
      return { ok: false, retryable: true };
    }
    if (!result.ok) {
      const error = (result.body && result.body.error) || {};
      /*
       * NOTHING_TO_CAPTURE means both sides are present — the card is finished, not broken. The
       * server's own completion signal (`card_registered` on accept) is what clears `openCardJob`,
       * so this only stops the reconciler from asking again.
       */
      if (error.code === "NOTHING_TO_CAPTURE") return { ok: true, complete: true };
      console.warn(`[arm-next] (${trigger}) refused: ${error.code || result.status} ${error.message || ""}`);
      return { ok: false, code: error.code || "error", error: error.message };
    }
    const capture = (result.body && result.body.capture) || null;
    if (!capture || !watcher) return { ok: false, error: "MintVault did not return a capture target" };
    const adopted = await watcher.adoptArmedCapture(capture);
    if (!adopted.ok) {
      console.warn(`[arm-next] (${trigger}) could not adopt: ${adopted.error}`);
      return { ok: false, error: adopted.error };
    }
    console.log(`[arm-next] (${trigger}) armed ${adopted.certId} ${adopted.side}`);
    return { ok: true, certId: adopted.certId, side: adopted.side };
  } finally {
    armNextInFlight = false;
    stateMod.set({ armingNextSide: false });
    pushStateToRenderer();
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
      return {
        ok: true,
        stage: "station_unavailable",
        error: "MintVault station service is temporarily unavailable. Contact a MintVault Super Admin.",
      };
    }
    return { ok: true, stage: session.body?.mfaRequired ? "mfa" : "sign_in" };
  }
  // Committed to shared state as well as returned, so the identity row and the capture panel are
  // reading ONE number rather than two that drift apart the moment a card is started.
  const summary = stationSummary(session.body, await refreshAvailableCredits());
  const code = stationIdentity.currentStationCode();
  if (!code) {
    const locations = await stationClient.enrolmentLocations();
    if (!locations.ok) {
      return {
        ok: true,
        stage: "station_unavailable",
        summary,
        error:
          locations.status === 503
            ? "MintVault station enrolment is temporarily unavailable. Contact a MintVault Super Admin."
            : "MintVault could not confirm this station’s authorised location.",
      };
    }
    return {
      ok: true,
      stage: "register",
      summary,
      locations:
        locations.ok && Array.isArray(locations.body?.locations)
          ? locations.body.locations.map((location) => ({
              id: String(location.id),
              name: String(location.name),
            }))
          : [],
    };
  }
  const status = await stationClient.enrolmentStatus(code);
  if (!status.ok || !status.body?.station) {
    return { ok: true, stage: "station_unavailable", summary, stationCode: code };
  }
  const station = status.body.station;
  /*
   * ADOPT THE SERVER'S CAPTURE RECTANGLE. A synchronisation, not a move.
   *
   * A Mac whose local jig origin has never been written reports `profile_unprovisioned` and cannot
   * Preview or scan, even when the server holds a perfectly good VALID calibration for that station.
   * Clearing it used to mean dragging the window — now maintenance-gated and, correctly, refused
   * while a card is open. So a half-captured card became unrecoverable: it needs an origin, and the
   * origin could not be set until the card finished. This is that circle, broken at the only point
   * where breaking it costs nothing: the geometry is the server's own, already recorded, already
   * validated as a legal window before it was published.
   *
   * Idempotent and quiet when they already agree. It never OVERRIDES a local origin that matches,
   * and it is not a calibration write — nothing is sent back.
   */
  try {
    lide400.adoptServerCaptureWindow(station.acquisitionRegion);
  } catch (error) {
    console.warn(`[station] could not adopt the server capture window: ${error?.message || error}`);
  }
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
  try {
    stationIdentity.setStationStatus(station.status);
  } catch {}
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
    if (!result.ok) {
      const error = (result.body && result.body.error) || {};
      return { ok: false, code: error.code || "error", error: error.message || "Could not start the fix" };
    }
    const fix = (result.body && result.body.fix) || {};

    /*
     * AUTHORISING A FIX WAS NOT THE SAME AS ARMING ONE.
     *
     * `fix-authorise` answers "which sides may this station re-capture" and creates NO capture
     * session. The picker then closed itself and left the operator with a card, a positioned sheet
     * and nothing on the glass — exactly the same shape of defect as NEW returning an armed capture
     * it never committed. It is also the ONLY recovery route for a card whose target has lapsed:
     * capture sessions expire after five minutes, so any card left on the bench for longer needs
     * re-arming, and this is where that happens.
     *
     * COSTS NOTHING. Arming spends no credit and mints nothing — same Card Job, same MV, same
     * certificate, same reservation — so doing it here cannot make a FIX expensive.
     */
    let capture = null;
    let captureError = null;
    try {
      const armed = await server.armCapture(cardJobId);
      if (armed.ok) capture = (armed.body && armed.body.capture) || null;
      else captureError = ((armed.body && armed.body.error) || {}).message || "Could not arm the scanner";
    } catch (err) {
      captureError = err && err.message ? err.message : "Could not reach MintVault to arm the scanner";
    }
    if (capture && !captureError && watcher) {
      const adopted = await watcher.adoptArmedCapture(capture);
      if (!adopted.ok) captureError = adopted.error;
    }

    /*
     * The station is now mid-card on THIS job, so NEW CARD must stay disabled until it is finished
     * or cancelled — a FIX puts a real card on the glass exactly as a NEW does. Recorded even when
     * arming failed, so the blocking panel offers retry/cancel rather than an enabled NEW.
     */
    stateMod.set({
      openCardJob: {
        cardJobId,
        mvNumber: fix.mvNumber || null,
        certificateId: typeof fix.certificateId === "number" ? fix.certificateId : null,
        startedAt: new Date().toISOString(),
        armError: captureError,
      },
    });
    pushStateToRenderer();
    return { ok: true, fix, capture, captureError };
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
    const persistedStart = stateMod.get().pendingNewCardStart;
    if (!pendingNewCardOpId && persistedStart?.clientOpId) pendingNewCardOpId = persistedStart.clientOpId;
    if (!pendingNewCardOpId) {
      pendingNewCardOpId = `new-${randomUUID()}`;
      // Persist BEFORE the first network attempt. If the app dies after MintVault
      // commits the Card Job but before this process receives the response, the
      // next press repeats this exact operation and receives the same job.
      stateMod.set({
        pendingNewCardStart: {
          clientOpId: pendingNewCardOpId,
          cardName,
          startedAt: new Date().toISOString(),
        },
      });
      pushStateToRenderer();
    }
    let result;
    try {
      result = await server.startNewCard(pendingNewCardOpId, cardName);
    } catch (err) {
      // Outcome unknown — keep the token so a retry replays instead of buying a second card.
      return { ok: false, retryable: true, error: err && err.message ? err.message : "Could not reach MintVault" };
    }
    if (result.ok) {
      pendingNewCardOpId = null;
      stateMod.set({ pendingNewCardStart: null });
      const job = result.body && result.body.cardJob ? result.body.cardJob : {};
      /*
       * THE CARD IS RECORDED AS OPEN BEFORE ANYTHING ELSE CAN FAIL.
       *
       * The credit is spent the instant the server answered above. From this line on the station is
       * mid-card, and NEW CARD must stay disabled — through arming, through FRONT, through the gap
       * before BACK is armed, and through an arm failure. Committing it here rather than after the
       * arm means an arming failure leaves a DISABLED button and a visible card, not an enabled one
       * that invites a second press and a second charge.
       */
      stateMod.set({
        openCardJob: {
          cardJobId: job.cardJobId || null,
          mvNumber: job.mvNumber || null,
          certificateId: typeof job.certificateId === "number" ? job.certificateId : null,
          startedAt: new Date().toISOString(),
          armError: null,
        },
      });
      pushStateToRenderer();

      /*
       * B1 — arm the FIRST capture immediately, from this station.
       *
       * The card is paid for the moment the server answers above; if nothing arms a session the
       * operator has a charged card they cannot photograph. Arming is free, spends no credit and
       * mints nothing, so doing it here costs the shop nothing and removes the browser step that
       * previously stood between NEW CARD and the glass.
       *
       * A FAILURE TO ARM IS NOT A FAILURE TO START. The card exists, holds its MV and keeps its
       * reservation, and the outstanding side can be armed again later from the fix queue — so
       * this reports the arming problem while still returning the card. Throwing it away here is
       * how an operator would conclude the press failed and press again.
       */
      let capture = null;
      let captureError = null;
      if (job.cardJobId) {
        try {
          const armed = await server.armCapture(job.cardJobId);
          if (armed.ok) capture = (armed.body && armed.body.capture) || null;
          else captureError = ((armed.body && armed.body.error) || {}).message || "Could not arm the scanner";
        } catch (err) {
          captureError = err && err.message ? err.message : "Could not reach MintVault to arm the scanner";
        }
      }

      /*
       * COMMIT THE ARMED TARGET INTO THE SHARED STATE THE WINDOW ACTUALLY READS.
       *
       * Returning `capture` to the renderer was never enough: the capture panel, the workflow guide
       * and the SCAN button all render from `stateMod`, and the physical scan is gated on the
       * watcher's durable target queue. Without this the operator saw "No card ready" for a card
       * that was armed and waiting, and could not scan it, until an idle poll happened to
       * rediscover it up to 35 seconds later.
       */
      if (capture && !captureError) {
        const adopted = watcher
          ? await watcher.adoptArmedCapture(capture)
          : { ok: false, error: "Scanner service is starting" };
        if (!adopted.ok) captureError = adopted.error;
      }
      if (captureError) {
        // Recorded ON THE SAME JOB, so the retry re-arms this card rather than starting another.
        const open = stateMod.get().openCardJob;
        if (open) {
          stateMod.set({ openCardJob: { ...open, armError: captureError } });
        }
      }
      pushStateToRenderer();
      await refreshAvailableCredits();
      return { ok: true, cardJob: job, capture, captureError };
    }
    // A refusal the operator can act on (no credits, suspended, station not approved) is final for
    // this press: the token is released so their NEXT press is a genuinely new request.
    pendingNewCardOpId = null;
    stateMod.set({ pendingNewCardStart: null });
    const error = (result.body && result.body.error) || {};
    // A refusal is exactly when the true balance matters most — "no credits" must be shown with the
    // real figure beside it, not with whatever the wallet held at sign-in.
    const refreshedAvailable = await refreshAvailableCredits();
    if (error.code === "INSUFFICIENT_CREDITS" && typeof refreshedAvailable !== "number") {
      // The refusal itself is authoritative: the server just attempted the reservation and said
      // available capacity is below one. If a follow-up wallet read is unavailable/forbidden, keep
      // the zero-credit lock visible instead of rendering "unknown" and hiding the top-up modal.
      stateMod.set({
        availableCredits: 0,
        walletRefreshGeneration: Number(stateMod.get().walletRefreshGeneration || 0) + 1,
      });
      pushStateToRenderer();
    }
    return {
      ok: false,
      retryable: false,
      code: error.code || "error",
      error: error.message || "Could not start a new card",
    };
  });

  /**
   * B1 — arm the NEXT outstanding side of a card this station owns.
   *
   * Used for the back after the front has been accepted, and to recover a card whose first arm
   * failed or expired. Deliberately takes only a Card Job id: the side is chosen by the server from
   * what is actually missing, so this app can never name a side that would overwrite a good image,
   * and it never names a certificate at all.
   */
  ipcMain.handle("arm-capture", async (_event, payload) => {
    const cardJobId = payload && typeof payload.cardJobId === "string" ? payload.cardJobId : "";
    if (!cardJobId) return { ok: false, error: "A card is required" };
    let result;
    try {
      result = await server.armCapture(cardJobId, payload && payload.side);
    } catch (err) {
      return { ok: false, retryable: true, error: err && err.message ? err.message : "Could not reach MintVault" };
    }
    if (result.ok) {
      const body = result.body || {};
      const capture = body.capture || null;
      // Same commit as the NEW path, for the same reason: the window and the physical Scan button
      // read shared state, not this return value. A re-armed BACK must appear on the SAME MV
      // immediately rather than after the next poll.
      if (capture && watcher) {
        const adopted = await watcher.adoptArmedCapture(capture);
        if (!adopted.ok) {
          return { ok: false, code: "adopt_failed", error: adopted.error };
        }
      }
      // The arm succeeded, so any recorded arm failure on this card is stale. Cleared rather than
      // left behind, or the operator would keep being shown a blocking error for a card that is now
      // armed and waiting on the glass.
      const open = stateMod.get().openCardJob;
      if (open && open.armError && (!open.cardJobId || open.cardJobId === cardJobId)) {
        stateMod.set({ openCardJob: { ...open, armError: null } });
      }
      pushStateToRenderer();
      return { ok: true, capture, cardJob: body.cardJob || null };
    }
    const error = (result.body && result.body.error) || {};
    const message = error.message || "Could not arm the scanner";
    /*
     * A FAILED ARM IS NOT A BLOCKING CONDITION WHEN THIS STATION ALREADY HOLDS THE TARGET.
     *
     * Recording `armError` unconditionally is how a refused re-arm painted a red NOT ARMED panel
     * over a card that was armed, claimed and waiting to be scanned. The station's own live target
     * is the authority on whether it can work; the error is still returned to the caller so the
     * press is not silently swallowed, it simply does not become a blocking state.
     */
    const open = stateMod.get().openCardJob;
    if (open && !stateMod.get().activeCapture && (!open.cardJobId || open.cardJobId === cardJobId)) {
      stateMod.set({ openCardJob: { ...open, armError: message } });
      pushStateToRenderer();
    }
    return { ok: false, code: error.code || "error", error: message };
  });

  /**
   * P6c — CANCEL A CARD STARTED BY MISTAKE.
   *
   * The ONLY safe way out of NEEDS_SCAN for a card that was never photographed. It is deliberately
   * NOT submission cancellation: that path releases the credit through the submission and leaves the
   * Card Job stranded in NEEDS_SCAN, still listed as outstanding work.
   *
   * THE SERVER DOES ALL OF IT IN ONE TRANSACTION — release the reservation exactly once, make any
   * outstanding capture target terminal, and move the job to CANCELLED — so this handler cannot
   * produce a half-cancelled card however it is retried. Retrying is safe: the release carries a
   * deterministic idempotency key derived from the Card Job id, so a second attempt replays rather
   * than returning a second credit.
   *
   * THE MV IS KEPT. Nothing here or on the server touches the certificate; the number stays
   * allocated to this cancelled card for ever and is never reissued.
   */
  ipcMain.handle("cancel-card-job", async (_event, payload) => {
    const cardJobId = payload && typeof payload.cardJobId === "string" ? payload.cardJobId : "";
    if (!cardJobId) return { ok: false, error: "A card is required" };
    const reason =
      payload && typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "Cancelled at the station before any image was captured.";
    let result;
    try {
      result = await server.cancelCardJob(cardJobId, reason);
    } catch (err) {
      // Outcome unknown. The operation is idempotent server-side, so a retry is safe and correct —
      // and we must NOT clear the open-card record on a request whose answer we never saw.
      return { ok: false, retryable: true, error: err && err.message ? err.message : "Could not reach MintVault" };
    }
    if (!result.ok) {
      const error = (result.body && result.body.error) || {};
      return { ok: false, code: error.code || "error", error: error.message || "Could not cancel this card" };
    }
    const cancellation = (result.body && result.body.cancellation) || {};
    // Only now is the station free. Clearing the open-card record re-enables NEW CARD, and dropping
    // a local target for the cancelled session stops the operator being shown a card that is dead.
    const open = stateMod.get().openCardJob;
    if (open && (!open.cardJobId || open.cardJobId === cardJobId)) {
      stateMod.set({ openCardJob: null });
    }
    if (watcher) watcher.releaseTargetForCancelledCard(cancellation.certificateId, cancellation.mvNumber);
    pushStateToRenderer();
    await refreshAvailableCredits();
    return { ok: true, cancellation };
  });

  // Recovery opens the exact historic certificate in the authenticated web
  // workstation. That page creates the server-owned capture session; this app
  // never arms arbitrary certificate/side combinations from a scanner token.
  ipcMain.handle("open-grade-cert", async (_e, certId) => {
    if (!certId || !/^MV\d+$/i.test(String(certId))) return { ok: false, error: "format MV###" };
    // `API_BASE` THROWS on an undeclared environment rather than guessing a hostname, so it must be
    // caught here — otherwise the renderer gets an unhandled rejection instead of the real reason.
    const resolved = environment.resolveEnvironment();
    if (!resolved.ok) return { ok: false, error: resolved.message };
    const base = resolved.apiBase.replace(/\/$/, "");
    const url = `${base}/admin?search=${encodeURIComponent(String(certId).toUpperCase())}`;
    shell.openExternal(url);
    return { ok: true, url };
  });

  /*
   * TOP UP NOW opens the partner wallet page for this declared environment. That web page, not the
   * scanner, reads `/api/partner/credits/packs` and starts `/api/partner/credits/checkout`, so the
   * station never hard-codes pack prices and never grants credits from a redirect.
   */
  ipcMain.handle("open-partner-billing", () => {
    const resolved = environment.resolveEnvironment();
    if (!resolved.ok) return { ok: false, error: resolved.message };
    const url = `${resolved.apiBase.replace(/\/$/, "")}/partner/billing`;
    shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle("refresh-available-credits", async () => {
    const available = await refreshAvailableCredits();
    return { ok: true, availableCredits: available };
  });

  ipcMain.handle("credit-packs", async () => {
    try {
      const result = await stationClient.creditPacks();
      if (!result.ok) {
        const error = result.body?.error || {};
        return {
          ok: false,
          status: result.status,
          error: error.message || error || "Credit packs are unavailable",
        };
      }
      return { ok: true, packs: Array.isArray(result.body?.packs) ? result.body.packs : [] };
    } catch (error) {
      return { ok: false, error: error?.message || "Credit packs are unavailable" };
    }
  });

  ipcMain.handle("credit-checkout", async (_event, payload) => {
    const packCode = typeof payload?.packCode === "string" ? payload.packCode : "";
    if (!packCode) return { ok: false, error: "Select a credit pack" };
    try {
      const result = await stationClient.creditCheckout(packCode);
      if (!result.ok) {
        const error = result.body?.error || {};
        return { ok: false, status: result.status, error: error.message || error || "Checkout could not start" };
      }
      const url = result.body?.url;
      if (!url) return { ok: false, error: "Checkout did not return a Stripe URL" };
      shell.openExternal(url);
      return { ok: true, url, packCode: result.body?.packCode || packCode, credits: result.body?.credits ?? null };
    } catch (error) {
      return { ok: false, error: error?.message || "Checkout could not start" };
    }
  });

  ipcMain.handle("get-version", () => ({ ok: true, version: APP_VERSION }));

  ipcMain.handle("arm-next-side", async () => armNextOutstandingSide("operator"));

  /*
   * Password recovery is the WEBSITE's authority, not the Scanner's. Opening the partner portal in
   * the operator's browser keeps one token lifecycle, one set of rate limits and one audit trail —
   * a second reset implementation inside Electron would be a second thing to get wrong, in the
   * component that is hardest to patch quickly. The URL comes from the DECLARED environment, so a
   * staging Scanner cannot send its operator to the production reset page.
   */
  ipcMain.handle("open-forgot-password", () => {
    const resolved = environment.resolveEnvironment();
    if (!resolved.ok) return { ok: false, error: resolved.message };
    shell.openExternal(`${resolved.apiBase}/partner/forgot-password`);
    return { ok: true };
  });

  /*
   * DECLARE WHICH MINTVAULT THIS SCANNER BELONGS TO.
   *
   * Without this handler the refusal message was a lie: it told the operator to "choose STAGING or
   * PRODUCTION in Service & Diagnostics" and no such control existed. `persistEnvironment` had no
   * caller outside its own tests, and MINTVAULT_ENV appeared in no installer, wrapper or README — so
   * a Mac without a hand-edited `~/.mintvault-scanner.env` could never sign in at all, and the one
   * instruction on screen pointed nowhere. Fail-closed, but permanently.
   *
   * REFUSED WHILE THERE IS WORK IN FLIGHT. Changing environment repoints identity, capture sessions
   * and evidence upload at a different deployment. Doing that with a card open would strand it on a
   * server this app is no longer talking to, so the two states that must not move are blocked: an
   * open card, and a live scan.
   */
  ipcMain.handle("set-environment", async (_event, value) => {
    // The same three states that block switching operator, for the same reason and then some: this
    // moves the whole deployment, not just who is signed in to it.
    if (stateMod.get().activeCapture || stateMod.get().openCardJob || watcher?.targetedPendingUploadCount()) {
      return { ok: false, error: "Finish or safely retry the current card before changing environment" };
    }
    let declared;
    try {
      declared = environment.persistEnvironment(value);
    } catch (error) {
      return { ok: false, error: error?.message || "That is not a MintVault environment" };
    }
    /*
     * The operator session belonged to the OLD deployment's token lifecycle. Keeping it would leave
     * a signed-in badge for an account on a server this app no longer addresses.
     */
    stationIdentity.clearOperatorSession();
    const resolved = environment.resolveEnvironment();
    pushStateToRenderer();
    return { ok: resolved.ok, environment: declared, error: resolved.ok ? null : resolved.message };
  });

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
    return result.ok
      ? stationSetupState()
      : { ok: false, error: result.body?.error || "Authentication code was not accepted" };
  });
  ipcMain.handle("register-station", async (_event, payload) => {
    const locationId = typeof payload?.locationId === "string" && payload.locationId ? payload.locationId : undefined;
    if (locationId) {
      const selected = await stationClient.selectLocation(locationId);
      if (!selected.ok) return { ok: false, error: selected.body?.error || "Selected location is not available" };
    }
    const result = await stationClient.registerThisMac({ locationId, appVersion: APP_VERSION });
    return result.ok
      ? stationSetupState()
      : { ok: false, error: result.body?.error?.message || result.body?.error || "Station registration failed" };
  });
  ipcMain.handle("station-sign-out", async () => {
    // `openCardJob` is included deliberately: a started-but-unfinished card is exactly the state in
    // which switching operator loses the thread — the next person would see an enabled NEW button
    // and a paid card still sitting on the counter with nothing pointing at it.
    if (stateMod.get().activeCapture || stateMod.get().openCardJob || watcher?.targetedPendingUploadCount()) {
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

  /*
   * "apply-positioning-preview" was removed on 2026-08-17 along with the card-chasing architecture.
   * A station's capture origin is set only by "save-capture-window-origin", which the operator drives
   * by dragging the window — never inferred from where a card was lying.
   */

  /*
   * The per-side placement gate. Like the setup Preview it carries no path and no card identity —
   * the watcher binds the approval to the side that is actually awaiting Scan, so the renderer
   * cannot ask for an approval on behalf of some other card.
   */
  ipcMain.handle("run-placement-preview", async () => {
    if (!watcher) return { ok: false, error: "Scanner service is starting" };
    return watcher.runPlacementPreview();
  });

  ipcMain.handle("get-placement-preview", (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Placement preview is unavailable" };
    return watcher.placementPreviewData(previewId);
  });

  /*
   * Move the capture window. An explicit RECALIBRATION action, not part of card capture: it is
   * reachable only from Service & Diagnostics and it invalidates any standing placement approval,
   * because an approval measured against the old window says nothing about the new one.
   */
  ipcMain.handle("save-capture-window", async (_event, originMm) => {
    if (!watcher) return { ok: false, error: "Scanner service is starting" };
    /*
     * AUTHORITY IS CHECKED HERE, not only by hiding a button.
     *
     * The renderer hides the maintenance controls when the operator lacks
     * `partner.stations.calibrate`, but this app runs from a plain repository checkout, the preload
     * bridge exposes `saveCaptureWindow` to the page unconditionally, and the LOCAL half of a window
     * move is what actually drives the hardware. So "the server refuses it anyway" was only ever
     * true of the server's RECORD — the physical rectangle would still have moved.
     *
     * Re-asked from the session on every call rather than cached, so a sign-out or a switch of
     * operator takes effect immediately. The server remains the authority on the record; this is the
     * authority on the machine.
     */
    let allowed = false;
    try {
      const setup = await stationSetupState();
      allowed = setup?.summary?.canCalibrate === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return { ok: false, error: "Moving the capture area requires station maintenance authority" };
    }
    return watcher.saveCaptureWindowOrigin(originMm);
  });

  ipcMain.handle("get-capture-preview", (_event, previewId) => {
    if (!watcher || typeof previewId !== "string") return { ok: false, error: "Preview is unavailable" };
    return watcher.previewData(previewId);
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
      error:
        "Install the current signed MintVault Scanner package through the approved release channel. This station will not self-update from Git.",
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

  ipcMain.handle("hide-popover", () => {
    if (popover) popover.hide();
    return { ok: true };
  });

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
    // Same reason as open-grade-cert: an undeclared environment is a message, not a crash.
    const resolved = environment.resolveEnvironment();
    if (!resolved.ok) return { ok: false, error: resolved.message };
    const base = resolved.apiBase.replace(/\/$/, "");
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
  let lastArmedForAcceptance = null;
  let lastArmedForQueuedCapture = null;
  watcher.on("state-changed", () => {
    pushStateToRenderer();
    const s = stateMod.get();
    const isError = s.state === "error";
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
      if (isError && !lastErrorState) playSystemSound("Sosumi.aiff");
    }

    /*
     * THE SERVER-ACCEPTED EDGE. A side has just been accepted by MintVault and the card is not
     * finished, so its remaining side is armed now rather than at some later poll — the operator has
     * the card in their hand.
     * Keyed on the acceptance timestamp so one accepted side arms once, however many state changes
     * follow it.
     */
    const accepted = s.lastAcceptedCapture;
    const queued = s.lastQueuedCapture;
    if (
      queued &&
      queued.queuedAt &&
      queued.queuedAt !== lastArmedForQueuedCapture &&
      queued.side === "front" &&
      !queued.cardRegistered &&
      !s.activeCapture &&
      s.openCardJob &&
      s.openCardJob.cardJobId
    ) {
      lastArmedForQueuedCapture = queued.queuedAt;
      void armNextOutstandingSide("upload task accepted");
    }
    if (
      accepted &&
      accepted.acceptedAt &&
      accepted.acceptedAt !== lastArmedForAcceptance &&
      accepted.side === "front" &&
      !accepted.cardRegistered &&
      !s.activeCapture &&
      s.openCardJob &&
      s.openCardJob.cardJobId
    ) {
      lastArmedForAcceptance = accepted.acceptedAt;
      void armNextOutstandingSide("accepted side");
    }

    lastErrorState = isError;
    lastSuccessState = isSuccess;
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
      /*
       * RECONCILE. If this station still holds a card and has no target, ask the server for the
       * outstanding side. This is what makes a restart or a reconnect after an accepted FRONT
       * resolve to BACK rather than to nothing at all — the poll alone cannot, because it only
       * claims sessions that already exist and no back session is ever created on its own.
       */
      if (!stateMod.get().activeCapture && stateMod.get().openCardJob) {
        await armNextOutstandingSide("poll reconcile");
      }
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
      /*
       * Adopt the server's capture rectangle on the heartbeat, not only when the operator opens the
       * window. `stationSetupState()` runs on demand from the renderer, so a tray-only Scanner that
       * nobody has clicked sits at `profile_unprovisioned` — unable to Preview or scan — while the
       * server has held a VALID calibration for it the whole time. The station should be ready
       * because it is enrolled, not because somebody looked at it.
       *
       * Cheap and idempotent: it returns immediately once the local origin already agrees.
       */
      if (!lide400._private.jigOrigin()) await stationSetupState();
      const result = await stationClient.heartbeat(heartbeatPayload());
      if (!result.ok) {
        console.warn(
          `[station-heartbeat] rejected: ${result.body?.error?.code || result.body?.error || `HTTP ${result.status}`}`
        );
        if ([401, 403, 404, 426].includes(result.status) || result.body?.error?.code === "version_blocked")
          await stationSetupState();
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
          try {
            total += entry.isDirectory() ? duDir(fp) : fs.statSync(fp).size;
          } catch {}
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
    try {
      await watcher.stop();
      await watcher.start();
    } catch (err) {
      console.error(`[maintenance] resume restart failed: ${err?.message}`);
    }
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

app.on("before-quit", () => {
  isQuitting = true;
});
