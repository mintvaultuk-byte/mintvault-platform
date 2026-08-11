#!/usr/bin/env node
/**
 * MintVault Scanner Watcher — strict-alternating mode.
 *
 * Watches ~/mintvault-scans/inbox/ for .tif files from SilverFast SE.
 * Pairing is now strict-alternating, NOT timer-based:
 *
 *   IDLE          → scan #1 = front, buffer it, expect "back"
 *   FRONT_BUFFERED → scan #2 = back, upload pair, reset to IDLE
 *
 * No timeout. No misassignment when grading takes >60s. The Guide
 * Window (scripts/scanner-watcher/guide-window) tells the operator
 * which side is expected next, so it's impossible to lose track.
 *
 * Required env:
 *   SCANNER_API_TOKEN        — matching the server's Fly secret
 *
 * Optional env:
 *   MINTVAULT_INGEST_URL     — defaults to prod scan-ingest URL
 *   GUIDE_CONTROL_PORT       — defaults to 54871; set if 54871 is taken
 *
 * Local control server (loopback only):
 *   POST 127.0.0.1:54871/control/reset
 *   POST 127.0.0.1:54871/control/upload-front-only
 *   POST 127.0.0.1:54871/control/retry
 *
 * Logs to stdout (launchd captures to watcher.log via plist).
 */

import chokidar from "chokidar";
import FormData from "form-data";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────
const INGEST_URL = process.env.MINTVAULT_INGEST_URL || "https://mintvaultuk.com/api/admin/scan-ingest";
const TOKEN = process.env.SCANNER_API_TOKEN || "";
const CONTROL_PORT = parseInt(process.env.GUIDE_CONTROL_PORT || "54871", 10);

const BASE = path.join(os.homedir(), "mintvault-scans");
const INBOX = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED = path.join(BASE, "failed");
const DISCARDED = path.join(BASE, "discarded");
const STATE_FILE = path.join(BASE, "watcher-state.json");
const STATE_TMP = path.join(BASE, "watcher-state.json.tmp");

const SUCCESS_DWELL_MS = 1_500;
const ERROR_DWELL_MS   = 10_000;

// Only TIF from SilverFast. JPGs are duplicates we deliberately ignore.
const ACCEPTED_EXT = new Set([".tif", ".tiff"]);
const IGNORED_EXT  = new Set([".jpg", ".jpeg", ".png", ".bmp", ".gif"]);

// ── Ensure directory tree exists ─────────────────────────────────────────
for (const dir of [BASE, INBOX, PROCESSED, FAILED, DISCARDED]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Logging ──────────────────────────────────────────────────────────────
function log(msg, level = "info") {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
}

// ── macOS notification (best-effort) ─────────────────────────────────────
function escapeAppleScript(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}
function notify(title, message) {
  if (process.platform !== "darwin") return;
  try {
    const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" sound name "Glass"`;
    const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// ── State machine ────────────────────────────────────────────────────────
// Single source of truth for what the watcher is doing right now. Mutated
// only inside transition helpers (setIdle, setFrontBuffered, setUploading,
// etc.) so it's hard to leave state and watcher-state.json out of sync.

let state = "idle";                 // "idle" | "front_buffered" | "uploading" | "success" | "error" | "manual_pending"
let bufferedFront = null;           // absolute path of buffered front .tif, or null
let lastUploadedCert = null;        // most-recent successful MV<n> for predicting next
let sessionPairedCount = 0;         // cards completed since startup
let lastPair = null;                // { frontPath, backPath } — for "Retry" after error
let lastError = null;
let dwellTimer = null;

// Manual mode: when state="manual_pending", the next inbox .tif is uploaded
// to a SPECIFIC existing cert rather than starting a new strict-alternating
// pair. Cleared on success / cancel / error.
let manualPending = null;           // { certId: "MV57", side: "back", replaceExisting: bool }

// Server endpoints that the watcher proxies for the guide window.
function ingestOrigin() {
  // INGEST_URL is the scan-ingest endpoint; the cert-image and cert-preview
  // endpoints share the same origin.
  try { return new URL(INGEST_URL).origin; } catch { return ""; }
}

function nextCertGuess() {
  // REMOVED: this used to compute `MV${parseInt(lastUploadedCert) + 1}` locally.
  //
  // A scanner must NEVER derive an MV number by adding one to the last number it
  // happened to see. The MV number is the physical card's permanent identity and
  // is issued solely by the server's transactional allocator. A local `last + 1`
  // is wrong the moment any other station, or the admin UI, issues in between —
  // and `lastUploadedCert` is rehydrated from a state file across restarts, so
  // the guess could be seeded from an arbitrarily stale number.
  //
  // The guide window renders "—" for null, which is the correct display: the
  // number is unknown until the server returns it. Kept as a function returning
  // null so the state-file shape is unchanged for any already-installed guide.
  return null;
}

function writeState() {
  if (dwellTimer) {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }
  // expected_next_side is derived from state — keep it in payload for the
  // guide window's convenience (so it doesn't have to map state→side).
  let expectedNextSide;
  switch (state) {
    case "idle":            expectedNextSide = "front"; break;
    case "front_buffered":  expectedNextSide = "back";  break;
    case "manual_pending":  expectedNextSide = manualPending?.side ?? null; break;
    default:                expectedNextSide = null;
  }

  const payload = {
    state,
    expected_next_side:    expectedNextSide,
    buffered_front:        bufferedFront,
    buffered_front_name:   bufferedFront ? path.basename(bufferedFront) : null,
    next_cert_guess:       nextCertGuess(),
    last_uploaded_cert:    lastUploadedCert,
    session_paired_count:  sessionPairedCount,
    last_error:            lastError,
    ingest_url:            INGEST_URL,
    control_port:          CONTROL_PORT,
    manual_pending:        manualPending,
    updated_at:            new Date().toISOString(),
    // Legacy fields retained so the SwiftBar plugin and status.mjs don't
    // break — pairing_window_expires_at is null forever now (no timer).
    pairing_window_expires_at: null,
    last_cert:             lastUploadedCert,
    last_side:             state === "front_buffered" ? "front" : (state === "success" ? "back" : null),
  };

  try {
    fs.writeFileSync(STATE_TMP, JSON.stringify(payload, null, 2));
    fs.renameSync(STATE_TMP, STATE_FILE);
  } catch (err) {
    log(`writeState failed (${err.message}) — continuing`, "warn");
  }

  // Auto-revert from success/error back to idle after dwell. We keep
  // bufferedFront/lastUploadedCert; only the transient banner expires.
  if (state === "success") {
    dwellTimer = setTimeout(() => { state = "idle"; writeState(); }, SUCCESS_DWELL_MS);
  } else if (state === "error") {
    dwellTimer = setTimeout(() => { state = "idle"; lastError = null; writeState(); }, ERROR_DWELL_MS);
  }
}

// ── File movement ────────────────────────────────────────────────────────
function dateFolder(base) {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(base, today);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function moveFile(src, destDir) {
  const name = path.basename(src);
  const dest = path.join(destDir, name);
  let target = dest;
  let suffix = 2;
  while (fs.existsSync(target)) {
    const { name: base, ext } = path.parse(dest);
    target = path.join(destDir, `${base} (${suffix})${ext}`);
    suffix++;
  }
  try {
    fs.renameSync(src, target);
  } catch {
    fs.copyFileSync(src, target);
    fs.unlinkSync(src);
  }
  return target;
}

function writeErrorFile(targetPath, reason) {
  const errPath = `${targetPath}.error.txt`;
  const payload = `${new Date().toISOString()}\n${reason}\n`;
  try { fs.writeFileSync(errPath, payload); } catch {}
}

// ── Upload (front+back, or front-only) ───────────────────────────────────
async function uploadPair(frontPath, backPath) {
  const frontName = path.basename(frontPath);
  const backName  = backPath ? path.basename(backPath) : null;
  log(`Uploading: front=${frontName}${backName ? ` back=${backName}` : " (front-only)"}`);

  state = "uploading";
  lastError = null;
  lastPair = { frontPath, backPath };
  writeState();

  const form = new FormData();
  form.append("front", fs.createReadStream(frontPath));
  if (backPath) form.append("back", fs.createReadStream(backPath));
  form.append("client_source", "scanner_watcher");

  let response;
  try {
    response = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "x-scanner-token": TOKEN, ...form.getHeaders() },
      body: form,
    });
  } catch (err) {
    return failUpload(frontPath, backPath, `network error: ${err.message}`);
  }

  let data;
  try { data = await response.json(); } catch { data = {}; }

  if (!response.ok) {
    return failUpload(frontPath, backPath, `HTTP ${response.status}: ${data.error || JSON.stringify(data)}`);
  }

  // Success path — move TIFs to processed/, advance state.
  log(`SUCCESS ${frontName}: ${data.certId} (${data.aiStatus || "queued"}) — ${data.message || ""}`);
  const processedDir = dateFolder(PROCESSED);
  moveFile(frontPath, processedDir);
  if (backPath) moveFile(backPath, processedDir);

  lastUploadedCert = data.certId || lastUploadedCert;
  sessionPairedCount += 1;
  bufferedFront = null;
  lastPair = null;
  state = "success";
  writeState();
  log(`READY FOR NEXT SCAN`);
  notify("MintVault ✓", data.certId ? `READY — ${data.certId} uploaded` : `READY — uploaded`);
}

// ── Manual mode upload (single-side attach to existing cert) ─────────────
async function uploadManualAttach(filePath, certId, side, replaceExisting) {
  const filename = path.basename(filePath);
  log(`Manual mode: uploading ${filename} as ${side} for ${certId}${replaceExisting ? " (replace=true)" : ""}`);
  state = "uploading";
  lastError = null;
  writeState();

  const form = new FormData();
  form.append("image", fs.createReadStream(filePath));
  form.append("side", side);
  form.append("replace_existing", replaceExisting ? "true" : "false");

  const url = `${ingestOrigin()}/api/admin/certs/${encodeURIComponent(certId)}/image`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "x-scanner-token": TOKEN, ...form.getHeaders() },
      body: form,
    });
  } catch (err) {
    return failManual(filePath, certId, side, `network error: ${err.message}`);
  }

  let data;
  try { data = await response.json(); } catch { data = {}; }

  if (!response.ok) {
    // 409 (already attached, no replace) is its own UI affordance — reflect
    // distinctly so the guide can prompt for replace_existing.
    const reason = response.status === 409
      ? `409: ${side} already attached to ${certId} — set replace_existing=true to overwrite`
      : `HTTP ${response.status}: ${data.error || JSON.stringify(data)}`;
    return failManual(filePath, certId, side, reason);
  }

  log(`Manual SUCCESS: ${filename} → ${certId} ${side}${data.replaced ? " (replaced previous)" : ""}`);
  const processedDir = dateFolder(PROCESSED);
  moveFile(filePath, processedDir);

  manualPending = null;
  lastUploadedCert = certId;
  state = "success";
  writeState();
  notify("MintVault ✓", `Attached to ${certId} ${side.toUpperCase()}`);
}

function failManual(filePath, certId, side, reason) {
  log(`Manual FAILED ${path.basename(filePath)}: ${reason}`, "error");
  const failDir = dateFolder(FAILED);
  const moved = moveFile(filePath, failDir);
  writeErrorFile(moved, reason);
  manualPending = null;
  lastError = reason;
  state = "error";
  writeState();
  notify("MintVault ✗", `Manual attach failed: ${reason.slice(0, 80)}`);
}

function failUpload(frontPath, backPath, reason) {
  const frontName = path.basename(frontPath);
  log(`FAILED ${frontName}: ${reason}`, "error");
  const failDir = dateFolder(FAILED);
  const movedFront = moveFile(frontPath, failDir);
  writeErrorFile(movedFront, reason);
  let movedBack = null;
  if (backPath) {
    movedBack = moveFile(backPath, failDir);
    writeErrorFile(movedBack, reason);
  }
  bufferedFront = null;
  // Track the POST-MOVE paths so /control/retry can find the files in
  // failed/ and re-upload from there (no second move needed before retry).
  lastPair = { frontPath: movedFront, backPath: movedBack };
  lastError = reason;
  state = "error";
  writeState();
  notify("MintVault ✗", `FAILED — ${reason.slice(0, 80)}`);
}

// ── New-file handler ─────────────────────────────────────────────────────
function handleNewFile(filePath) {
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (filename.startsWith(".") || filename === ".DS_Store") {
    log(`Ignored (hidden): ${filename}`, "debug"); return;
  }
  if (IGNORED_EXT.has(ext)) {
    log(`Ignored (${ext} not accepted — TIF only): ${filename}`, "debug"); return;
  }
  if (!ACCEPTED_EXT.has(ext)) {
    log(`Ignored (unknown extension ${ext}): ${filename}`, "debug"); return;
  }

  log(`New scan: ${filename} (state=${state})`);

  // Manual mode — bypass strict-alternating entirely.
  if (state === "manual_pending" && manualPending) {
    const { certId, side, replaceExisting } = manualPending;
    log(`  Manual mode active — attaching to ${certId} ${side}`);
    uploadManualAttach(filePath, certId, side, replaceExisting);
    return;
  }

  if (state === "idle" || state === "success" || state === "error") {
    // Treat as the front of a new card. (success/error states auto-revert
    // to idle after dwell, but a scan arriving mid-dwell shouldn't be lost.)
    bufferedFront = filePath;
    state = "front_buffered";
    writeState();
    log(`  Buffered as FRONT — waiting for BACK`);
    notify("MintVault", `Front captured — scan back`);
    return;
  }

  if (state === "front_buffered") {
    // Treat as the back of the in-flight card.
    const front = bufferedFront;
    log(`  Pairing with buffered front (${path.basename(front)}) — uploading`);
    uploadPair(front, filePath);
    return;
  }

  if (state === "uploading") {
    // A scan arrived while we're mid-upload. Park it in inbox under a
    // staging name so the operator can decide later. This is rare —
    // upload finishes in <2s usually.
    log(`Scan arrived during upload — leaving ${filename} in inbox; will be processed when state returns to idle`, "warn");
    return;
  }
}

// ── Control server (localhost-only) ──────────────────────────────────────
// The guide window's buttons POST here. Loopback bind only — no auth, no
// CORS, no exposed port. If 54871 is in use, the watcher logs an error
// and continues without the control surface (scans still work; only
// Reset/Upload-front-only/Retry buttons will 404).

function handleControl(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "POST") {
    res.statusCode = 405; res.end("POST only"); return;
  }

  if (url.pathname === "/control/reset") {
    if (state !== "front_buffered") {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: `state=${state}; reset only valid in front_buffered` }));
      return;
    }
    const front = bufferedFront;
    const discardedDir = dateFolder(DISCARDED);
    const moved = moveFile(front, discardedDir);
    log(`Reset: discarded ${path.basename(front)} → ${moved}`);
    bufferedFront = null;
    state = "idle";
    writeState();
    res.statusCode = 200; res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/control/upload-front-only") {
    if (state !== "front_buffered") {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: `state=${state}; upload-front-only only valid in front_buffered` }));
      return;
    }
    const front = bufferedFront;
    log(`Upload-front-only: ${path.basename(front)}`);
    uploadPair(front, null);
    res.statusCode = 202; res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /control/manual-mode — guide window arms a single-side attach ─────
  // Body: { certId, side: "front"|"back", replaceExisting: bool }. Watcher
  // flips state to "manual_pending"; next inbox file routes through
  // uploadManualAttach instead of normal pairing.
  if (url.pathname === "/control/manual-mode") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const certId = String(parsed.certId || "").trim();
        const side   = String(parsed.side   || "").toLowerCase();
        const replaceExisting = !!parsed.replaceExisting;
        if (!certId || !/^MV\d+$/i.test(certId)) {
          res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "certId must look like MV123" })); return;
        }
        if (side !== "front" && side !== "back") {
          res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "side must be 'front' or 'back'" })); return;
        }
        if (state === "uploading") {
          res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: "upload in flight; try again in a moment" })); return;
        }
        // Override any prior front-buffered context — manual mode wins.
        // Buffered front (if any) stays on disk in inbox until the next
        // cycle; we just stop tracking it.
        bufferedFront = null;
        manualPending = { certId: certId.toUpperCase(), side, replaceExisting };
        state = "manual_pending";
        writeState();
        log(`Manual mode armed: ${manualPending.certId} ${side}${replaceExisting ? " (replace)" : ""}`);
        res.statusCode = 200; res.end(JSON.stringify({ ok: true, manual_pending: manualPending }));
      } catch (err) {
        res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    });
    return;
  }

  // ── /control/cancel-manual — clear manual_pending without uploading ───
  if (url.pathname === "/control/cancel-manual") {
    if (state !== "manual_pending") {
      res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: `state=${state}; cancel only valid in manual_pending` })); return;
    }
    log(`Manual mode cancelled (was ${manualPending?.certId} ${manualPending?.side})`);
    manualPending = null;
    state = "idle";
    writeState();
    res.statusCode = 200; res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /control/cert-preview — proxy to /api/admin/certs/:certId/preview ─
  // Used by the Manual Mode modal's debounced lookup. Loopback-only;
  // server side enforces auth via x-scanner-token.
  if (url.pathname.startsWith("/control/cert-preview/")) {
    const certId = decodeURIComponent(url.pathname.slice("/control/cert-preview/".length));
    if (!certId) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "missing certId" })); return; }
    fetch(`${ingestOrigin()}/api/admin/certs/${encodeURIComponent(certId)}/preview`, {
      method: "GET",
      headers: { "x-scanner-token": TOKEN },
    }).then(async r => {
      const text = await r.text();
      res.statusCode = r.status;
      res.end(text);
    }).catch(err => {
      res.statusCode = 502;
      res.end(JSON.stringify({ ok: false, error: `proxy error: ${err.message}` }));
    });
    return;
  }

  if (url.pathname === "/control/retry") {
    if (state !== "error" || !lastPair) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: `no failed upload to retry` }));
      return;
    }
    // lastPair tracks the post-failure paths in failed/. uploadPair reads
    // from those paths directly; failUpload moves them again on a second
    // failure, succeed-path moves them to processed/. Either way the
    // files end up in the right place.
    const { frontPath, backPath } = lastPair;
    if (!fs.existsSync(frontPath)) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: `front file missing — was moved or deleted manually` }));
      return;
    }
    log(`Retry triggered — re-uploading ${path.basename(frontPath)}${backPath ? " + " + path.basename(backPath) : ""}`);
    uploadPair(frontPath, backPath);
    res.statusCode = 202; res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.statusCode = 404; res.end("not found");
}

const controlServer = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    handleControl(req, res);
  } catch (err) {
    log(`control server handler error: ${err.message}`, "error");
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }
});
controlServer.on("error", err => log(`control server error: ${err.message}`, "error"));
controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
  log(`Control server listening on 127.0.0.1:${CONTROL_PORT}`);
});

// ── Startup hydration ────────────────────────────────────────────────────
// If a previous run left a buffered_front, we want to pick up where we
// left off — operator was mid-pair when the watcher restarted. If the
// file still exists at its recorded path, restore the FRONT_BUFFERED
// state. Otherwise reset to IDLE.

function hydrateOnStartup() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (prev.last_uploaded_cert) lastUploadedCert = prev.last_uploaded_cert;
    if (typeof prev.session_paired_count === "number") sessionPairedCount = prev.session_paired_count;
    if (prev.buffered_front && fs.existsSync(prev.buffered_front)) {
      bufferedFront = prev.buffered_front;
      state = "front_buffered";
      log(`Hydrated FRONT_BUFFERED from previous run: ${path.basename(bufferedFront)}`);
      return;
    }
    if (prev.buffered_front) {
      log(`Previous run had buffered_front=${prev.buffered_front} but file is gone — resetting to idle`, "warn");
    }
  } catch (err) {
    log(`Hydration failed (${err.message}) — starting fresh`, "warn");
  }
  state = "idle";
  bufferedFront = null;
}

// ── Startup validation ───────────────────────────────────────────────────
if (!TOKEN) {
  console.error(`FATAL: SCANNER_API_TOKEN env var is required. Refusing to start.`);
  console.error(`Create ~/.mintvault-scanner.env with SCANNER_API_TOKEN=<hex>`);
  process.exit(1);
}

log(`─────────────────────────────────────────────────────────`);
log(`MintVault Scanner Watcher starting (strict-alternating mode)`);
log(`Ingest URL: ${INGEST_URL}`);
log(`Inbox: ${INBOX}`);
log(`State file: ${STATE_FILE}`);
log(`Control: 127.0.0.1:${CONTROL_PORT}`);
log(`Accepted: .tif, .tiff   |   Ignored: .jpg, .jpeg, .png, .bmp, .gif, dotfiles`);
log(`Pairing: strict alternating (front → back → upload → next)`);
log(`─────────────────────────────────────────────────────────`);

hydrateOnStartup();
writeState();

// Heartbeat — touch the state file's mtime once a minute even when nothing
// has happened. Strict-alternating mode only writes on transitions, which
// can be hours apart on a quiet day; the SwiftBar plugin's 300s staleness
// check would otherwise flag a healthy idle watcher as dead. Pure mtime
// touch (utimesSync) so we don't re-trigger dwell timers or rewrite content.
const HEARTBEAT_MS = 60_000;
setInterval(() => {
  try {
    const now = new Date();
    fs.utimesSync(STATE_FILE, now, now);
  } catch (err) {
    // File may be missing if writeState has never run — let next transition fix it.
  }
}, HEARTBEAT_MS);

const watcher = chokidar.watch(INBOX, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
});
watcher.on("add", handleNewFile);
watcher.on("error", err => log(`Watcher error: ${err.message}`, "error"));

// Graceful shutdown — preserves buffered_front so the next launch can
// hydrate and continue mid-card.
function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully (state=${state}, buffered_front=${bufferedFront ? path.basename(bufferedFront) : "none"})`);
  controlServer.close();
  watcher.close().finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
