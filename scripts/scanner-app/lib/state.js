/**
 * Persisted state for the scanner-app.
 *
 * Lives at ~/Library/Application Support/MintVaultScanner/state.json so the
 * tray icon, last-scan history, and mode survive a crash + LaunchAgent
 * restart. The watcher writes on every transition; renderer reads via IPC.
 *
 * Schema:
 *   {
 *     state:           "idle" | "scanning_front" | "scanning_back" | "uploading" | "success" | "error",
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

// State is isolated per-instance when MINTVAULT_SCANS_DIR is set — a TEST
// instance keeps its state under <MINTVAULT_SCANS_DIR>/app-state/, NOT the shared
// Application Support file, so it never clobbers the live scanner's state.json.
const APP_SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const STATE_PATH  = path.join(APP_SUPPORT, "state.json");
const STATE_TMP   = path.join(APP_SUPPORT, "state.json.tmp");

function ensureDir() {
  fs.mkdirSync(APP_SUPPORT, { recursive: true });
}

const DEFAULT = Object.freeze({
  state:            "idle",
  // Default to MANUAL. AUTO is opt-in per session (operator clicks it in the
  // tray) and never auto-resumes across a restart — see load(). This prevents
  // a crash-restart from silently resuming an AUTO batch and minting phantom
  // certs (2026-05-28: a stray AUTO resume minted 8 phantom certs MV57–64).
  mode:             "MANUAL",
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
  // Pause: epoch-ms timestamp; while pausedUntil > Date.now(), the
  // watcher logs and ignores .tif arrivals (no buffering, no upload).
  // 30-minute auto-clear means an accidental overnight pause can't
  // strand a grading session — re-pause is one click.
  pausedUntil:      null,
  // Scan-confirmation popup (blocking; multi-operator scan-one-write-one).
  // Set on a completed AUTO pair from THIS Mac's own ingest response — the
  // ASSIGNED number (never predictedNextCert). Shape:
  //   { certId, thumb (data-URL of the captured front), status, note, ts }
  //   status: "confirmed" | "raw_pending" | "incomplete"
  // Cleared when the operator clicks OK (ack-confirm-card). Transient UI state
  // — reset to null on boot (see load) so a crash can't strand the gate.
  confirmCard:      null,
  // Settings — local prefs, never written to the server.
  autoOpenOnError:  true,
  // Audible feedback. Plays Glass.aiff on success, Sosumi.aiff on error
  // via macOS afplay. No-op on non-darwin.
  soundEnabled:     true,
  // Direct ImageCaptureCore device/profile state, refreshed by the existing
  // scanner process. This is intentionally distinct from HTTP health.
  scannerHealth:    { status: "checking" },
  // Setup-only broad JPEG Preview. It has no certificate/session identifier,
  // no TIFF, and is never an evidence source; the renderer can display only
  // the restricted local derivative referenced by this transient record.
  positioningPreview: null,
  activeCapture:    null,
  updatedAt:        null,
});

const PAUSE_DURATION_MS = 30 * 60 * 1000;

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
    // Force MANUAL on every launch. AUTO must be re-armed by the operator
    // each session so a crash-restart can't silently resume runaway minting.
    mem.mode = "MANUAL";
    // confirmCard is transient UI state — never resurrect a stale confirmation
    // (a left-over would gate the watcher / block startup drain forever).
    if (mem.confirmCard) {
      console.warn(
        `[state] RECOVERY: cleared a stale confirmation gate left by a prior run (was ${mem.confirmCard.certId || "incomplete scan"}) — startup drain can proceed`
      );
    }
    mem.confirmCard = null;
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

/**
 * Toggle pause. paused=true sets pausedUntil to NOW + 30min; paused=false
 * clears it. The 30-min ceiling is a safety net so a forgotten pause
 * doesn't strand grading overnight.
 */
function setPaused(paused) {
  if (paused) {
    return set({ pausedUntil: Date.now() + PAUSE_DURATION_MS });
  } else {
    return set({ pausedUntil: null });
  }
}

/** True iff pausedUntil is set and still in the future. */
function isPaused() {
  return mem.pausedUntil != null && mem.pausedUntil > Date.now();
}

/**
 * Generic settings setter for the popover's Settings section. Only allows
 * known keys to prevent the renderer from injecting arbitrary state.
 */
const ALLOWED_SETTINGS = new Set(["autoOpenOnError", "soundEnabled"]);
function setSetting(key, value) {
  if (!ALLOWED_SETTINGS.has(key)) {
    console.warn(`[state] rejected unknown setting: ${key}`);
    return mem;
  }
  return set({ [key]: value });
}

function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(x => x !== fn); };
}

module.exports = { load, get, set, pushRecent, onChange, setPaused, isPaused, setSetting, PAUSE_DURATION_MS, STATE_PATH };
