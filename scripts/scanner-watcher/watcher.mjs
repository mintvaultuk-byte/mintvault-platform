#!/usr/bin/env node
/**
 * MintVault Scanner Watcher
 *
 * Watches ~/mintvault-scans/inbox/ for .tif files from SilverFast SE.
 * Pairs them by 60-second timestamp proximity (first = front, second = back)
 * and uploads each pair to /api/admin/scan-ingest using a static
 * SCANNER_API_TOKEN header (no admin cookie needed).
 *
 * On success: moved to ~/mintvault-scans/processed/YYYY-MM-DD/
 * On failure: moved to ~/mintvault-scans/failed/YYYY-MM-DD/ + .error.txt sibling
 *
 * Required env:
 *   SCANNER_API_TOKEN        — matching the server's Fly secret
 *
 * Optional env:
 *   MINTVAULT_INGEST_URL     — defaults to prod scan-ingest URL; override
 *                              with the staging URL for dev testing
 *
 * Logs to stdout. Under launchd the plist redirects stdout/stderr to
 * ~/mintvault-scans/watcher.log so the daemon's output ends up there. For
 * manual runs, pipe into `tee` if a file is wanted. Rotation is a manual /
 * Phase 6 concern — see docs/scanner-watcher-todo.md.
 *
 * Launch: `npm start` (or via launchd — see install.sh in the same dir)
 */

import chokidar from "chokidar";
import FormData from "form-data";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────
const INGEST_URL = process.env.MINTVAULT_INGEST_URL || "https://mintvault.fly.dev/api/admin/scan-ingest";
const TOKEN = process.env.SCANNER_API_TOKEN || "";

const BASE = path.join(os.homedir(), "mintvault-scans");
const INBOX = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED = path.join(BASE, "failed");
const STATE_FILE = path.join(BASE, "watcher-state.json");
const STATE_TMP = path.join(BASE, "watcher-state.json.tmp");

const PAIR_TIMEOUT_MS = 45_000;
const SUCCESS_DWELL_MS = 3_000;   // success banner dwell before auto-reset to idle
const ERROR_DWELL_MS = 10_000;    // error banner dwell before auto-reset to idle

// Only TIF from SilverFast. JPGs are duplicates we deliberately ignore.
const ACCEPTED_EXT = new Set([".tif", ".tiff"]);
const IGNORED_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".gif"]);

// ── Ensure directory tree exists ─────────────────────────────────────────
for (const dir of [BASE, INBOX, PROCESSED, FAILED]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Logging ──────────────────────────────────────────────────────────────
// Stdout only — under launchd, plist redirects stdout to watcher.log.
// For manual runs, pipe to tee if file output is desired.
function log(msg, level = "info") {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
}

// ── macOS notification (best-effort, darwin-only) ────────────────────────
// Posts a native banner so Cornelius doesn't have to watch the Terminal.
// Silently no-ops on Linux/CI so the code still runs anywhere. osascript is
// invoked via spawn (no shell) to avoid shell-metachar issues; the message
// is escaped for AppleScript string syntax (\, ").
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
    child.on("error", () => { /* best-effort — don't break uploads */ });
    child.unref();
  } catch {
    /* best-effort */
  }
}

// ── State file (for the SwiftBar plugin + status.mjs live display) ───────
// Written atomically (temp + rename) on every state transition. Schema
// matches the Phase AB SwiftBar spec — see ~/.mintvault-scanner-tools.
// Write failures are swallowed so state IO can never break upload flow.
// last_cert sticks across the idle that follows success, so the menu bar
// can always show "Last cert: MV145" until the next cycle starts.
let stateResetTimer = null;
let lastCert = null;
let lastSide = null;

function writeState(state, opts = {}) {
  try {
    if (stateResetTimer) {
      clearTimeout(stateResetTimer);
      stateResetTimer = null;
    }
    if (opts.last_cert) lastCert = opts.last_cert;
    if (opts.last_side !== undefined) lastSide = opts.last_side;
    // On idle transition, clear the sticky side so the menu bar doesn't keep
    // showing "front" after a cycle has finished.
    if (state === "idle") lastSide = null;

    const payload = {
      state,
      pairing_window_expires_at: opts.pairing_window_expires_at ?? null,
      last_cert: lastCert,
      last_side: lastSide,
      last_error: opts.last_error ?? null,
      ingest_url: INGEST_URL,
      updated_at: new Date().toISOString(),
    };

    fs.writeFileSync(STATE_TMP, JSON.stringify(payload, null, 2));
    fs.renameSync(STATE_TMP, STATE_FILE);

    if (state === "success") {
      stateResetTimer = setTimeout(() => writeState("idle"), SUCCESS_DWELL_MS);
    } else if (state === "error") {
      stateResetTimer = setTimeout(() => writeState("idle"), ERROR_DWELL_MS);
    }
  } catch (err) {
    try { log(`writeState failed (${err.message}) — continuing`, "warn"); } catch {}
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
  // Collision handling: append (2), (3) etc — never overwrite
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
  try { fs.writeFileSync(errPath, payload); } catch { /* best-effort */ }
}

// ── Upload ───────────────────────────────────────────────────────────────
async function upload(frontPath, backPath) {
  const frontName = path.basename(frontPath);
  const backName = backPath ? path.basename(backPath) : null;
  log(`Uploading: front=${frontName}${backName ? ` back=${backName}` : " (front-only)"}`);
  writeState("uploading", { last_side: backName ? "back" : "front" });

  const form = new FormData();
  form.append("front", fs.createReadStream(frontPath));
  if (backPath) form.append("back", fs.createReadStream(backPath));
  form.append("client_source", "scanner_watcher");

  let response;
  try {
    response = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "x-scanner-token": TOKEN,
        ...form.getHeaders(),
      },
      body: form,
    });
  } catch (err) {
    const reason = `network error: ${err.message}`;
    log(`FAILED ${frontName}: ${reason}`, "error");
    const failDir = dateFolder(FAILED);
    const moved = moveFile(frontPath, failDir);
    writeErrorFile(moved, reason);
    if (backPath) {
      const movedBack = moveFile(backPath, failDir);
      writeErrorFile(movedBack, reason);
    }
    log(`READY FOR NEXT SCAN`);
    writeState("error", { last_error: reason });
    notify("MintVault ✗", `FAILED — see watcher.log`);
    return;
  }

  let data;
  try { data = await response.json(); } catch { data = {}; }

  if (!response.ok) {
    const reason = `HTTP ${response.status}: ${data.error || JSON.stringify(data)}`;
    log(`FAILED ${frontName}: ${reason}`, "error");
    const failDir = dateFolder(FAILED);
    const moved = moveFile(frontPath, failDir);
    writeErrorFile(moved, reason);
    if (backPath) {
      const movedBack = moveFile(backPath, failDir);
      writeErrorFile(movedBack, reason);
    }
    log(`READY FOR NEXT SCAN`);
    writeState("error", { last_error: reason });
    notify("MintVault ✗", `FAILED HTTP ${response.status} — see watcher.log`);
    return;
  }

  log(`SUCCESS ${frontName}: ${data.certId} (${data.aiStatus || "queued"}) — ${data.message || ""}`);
  const processedDir = dateFolder(PROCESSED);
  moveFile(frontPath, processedDir);
  if (backPath) moveFile(backPath, processedDir);
  log(`READY FOR NEXT SCAN`);
  writeState("success", { last_cert: data.certId || null });
  notify("MintVault ✓", data.certId ? `READY — ${data.certId} uploaded` : `READY — uploaded`);
}

// ── Pairing (simplified FIFO, 60s timestamp proximity) ───────────────────
/** The one pending scan awaiting a pair, or null. */
let pending = null; // { path, time, timerId }

function handleNewFile(filePath) {
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // Skip hidden files and macOS metadata
  if (filename.startsWith(".") || filename === ".DS_Store") {
    log(`Ignored (hidden): ${filename}`, "debug");
    return;
  }

  // Skip non-TIF images (SilverFast emits .jpg duplicates we don't want)
  if (IGNORED_EXT.has(ext)) {
    log(`Ignored (${ext} not accepted — TIF only): ${filename}`, "debug");
    return;
  }

  if (!ACCEPTED_EXT.has(ext)) {
    log(`Ignored (unknown extension ${ext}): ${filename}`, "debug");
    return;
  }

  const now = Date.now();
  log(`New scan: ${filename}`);

  if (pending) {
    const age = now - pending.time;
    if (age < PAIR_TIMEOUT_MS) {
      // Pair found
      clearTimeout(pending.timerId);
      const front = pending.path;
      const back = filePath;
      pending = null;
      log(`  Paired with ${path.basename(front)} (${age}ms since front)`);
      upload(front, back);
      return;
    }
    // Stale pending shouldn't reach here (timer fires first) — defensive clear
    clearTimeout(pending.timerId);
    pending = null;
  }

  // Start a new pending window
  const deadline = now + PAIR_TIMEOUT_MS;
  const timerId = setTimeout(() => {
    if (pending && pending.path === filePath) {
      log(`  Timeout: ${filename} had no pair in 60s — uploading as front-only`);
      const lone = pending.path;
      pending = null;
      upload(lone, null);
    }
  }, PAIR_TIMEOUT_MS);
  pending = { path: filePath, time: now, timerId };
  log(`  Waiting up to 60s for a pair...`);
  writeState("front-received", { pairing_window_expires_at: new Date(deadline).toISOString(), last_side: "front" });
}

// ── Startup validation ───────────────────────────────────────────────────
if (!TOKEN) {
  const msg = `FATAL: SCANNER_API_TOKEN env var is required. Refusing to start — a token-less POST would just 401 the server.`;
  console.error(msg);
  console.error(`Create ~/.mintvault-scanner.env with:`);
  console.error(`  SCANNER_API_TOKEN=<your-64-char-hex-token>`);
  console.error(`Then restart via launchctl, or run with the env var exported.`);
  process.exit(1);
}

log(`─────────────────────────────────────────────────────────`);
log(`MintVault Scanner Watcher starting`);
log(`Ingest URL: ${INGEST_URL}`);
log(`Inbox: ${INBOX}`);
log(`State file: ${STATE_FILE}`);
log(`Accepted: .tif, .tiff   |   Ignored: .jpg, .jpeg, .png, .bmp, .gif, dotfiles`);
log(`Pairing: 60s FIFO timestamp proximity (first=front, second=back)`);
log(`─────────────────────────────────────────────────────────`);

writeState("idle");

const watcher = chokidar.watch(INBOX, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
});

watcher.on("add", handleNewFile);
watcher.on("error", err => log(`Watcher error: ${err.message}`, "error"));

// Graceful shutdown
function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully`);
  if (pending) {
    clearTimeout(pending.timerId);
    log(`  Unpaired scan at shutdown: ${path.basename(pending.path)} — remains in inbox`);
  }
  watcher.close().finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
