/**
 * Persisted state for the scanner-app.
 *
 * Lives at ~/Library/Application Support/MintVaultScanner/state.json so the
 * tray icon, last-scan history, and mode survive a crash + LaunchAgent
 * restart. The watcher writes on every transition; renderer reads via IPC.
 *
 * Schema:
 *   {
 *     state:           "idle" | "front_buffered" | "uploading" | "success" | "error" | "manual_pending",
 *     mode:            "AUTO" | "MANUAL",
 *     bufferedFront:   absolute path or null,
 *     manualPending:   { certId, side, replaceExisting } or null,
 *     lastUploadedCert:"MV60" or null,
 *     lastError:       string or null,
 *     sessionPaired:   integer (resets at process start),
 *     recent:          last 5 { certId, side, ts, source: "auto"|"manual" },
 *     nextCertOverride:"MV62" or null     // forward-to-cert override
 *   }
 */

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");

const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const STATE_PATH  = path.join(APP_SUPPORT, "state.json");
const STATE_TMP   = path.join(APP_SUPPORT, "state.json.tmp");

function ensureDir() {
  fs.mkdirSync(APP_SUPPORT, { recursive: true });
}

const DEFAULT = Object.freeze({
  state:            "idle",
  mode:             "AUTO",
  bufferedFront:    null,
  manualPending:    null,
  lastUploadedCert: null,
  lastError:        null,
  sessionPaired:    0,
  recent:           [],
  nextCertOverride: null,
  // Predicted next cert from the server. Updated whenever the watcher
  // calls /api/admin/next-cert-id. Server is the source of truth; this
  // is a display-only cache, refreshed before each upload.
  predictedNextCert: null,
  updatedAt:        null,
});

let mem = { ...DEFAULT };
let listeners = [];

function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    mem = { ...DEFAULT, ...parsed };
    // sessionPaired resets at process boot — a "session" is one run.
    mem.sessionPaired = 0;
  } catch {
    mem = { ...DEFAULT };
  }
  return mem;
}

function get() {
  return mem;
}

function set(patch) {
  mem = { ...mem, ...patch, updatedAt: new Date().toISOString() };
  // Atomic write: tmp → rename. Avoids torn reads if the renderer polls
  // mid-write (it shouldn't — IPC-only — but defence in depth).
  ensureDir();
  try {
    fs.writeFileSync(STATE_TMP, JSON.stringify(mem, null, 2));
    fs.renameSync(STATE_TMP, STATE_PATH);
  } catch (err) {
    console.error("[state] write failed:", err.message);
  }
  for (const fn of listeners) {
    try { fn(mem); } catch (e) { console.error("[state] listener:", e.message); }
  }
  return mem;
}

function pushRecent(entry) {
  const recent = [{ ...entry, ts: new Date().toISOString() }, ...(mem.recent || [])].slice(0, 5);
  set({ recent });
}

function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(x => x !== fn); };
}

module.exports = { load, get, set, pushRecent, onChange, STATE_PATH };
