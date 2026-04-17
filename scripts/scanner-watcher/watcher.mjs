#!/usr/bin/env node
/**
 * MintVault Scanner Watcher
 *
 * Watches ~/mintvault-scans/inbox/ for new image files.
 * Pairs them as front + back, uploads to /api/admin/scan-ingest.
 *
 * File pairing logic:
 *   1. If filename contains _front or _back suffix → explicit pair
 *   2. Otherwise → pair by timestamp proximity (within 60s = same card)
 *      First file = front, second = back
 *
 * On success: moves to ~/mintvault-scans/processed/
 * On failure: moves to ~/mintvault-scans/failed/
 *
 * Required env vars:
 *   MINTVAULT_API_URL  — e.g. https://mintvault.fly.dev
 *   MINTVAULT_ADMIN_COOKIE — session cookie value (mv.sid=...)
 *
 * Usage:
 *   cd scripts/scanner-watcher
 *   npm install
 *   MINTVAULT_API_URL=https://mintvault.fly.dev MINTVAULT_ADMIN_COOKIE="mv.sid=s%3A..." npm start
 */

import chokidar from "chokidar";
import FormData from "form-data";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";

const API_URL = process.env.MINTVAULT_API_URL || "https://mintvault.fly.dev";
const ADMIN_COOKIE = process.env.MINTVAULT_ADMIN_COOKIE || "";

const BASE = path.join(os.homedir(), "mintvault-scans");
const INBOX = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED = path.join(BASE, "failed");

// Ensure directories exist
for (const dir of [INBOX, PROCESSED, FAILED]) {
  fs.mkdirSync(dir, { recursive: true });
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"]);

/** Pending files waiting for a pair */
const pending = new Map(); // basename → { path, time }

const PAIR_TIMEOUT_MS = 60_000; // 60 seconds to find a pair

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function moveFile(src, destDir) {
  const name = path.basename(src);
  const dest = path.join(destDir, `${Date.now()}_${name}`);
  try {
    fs.renameSync(src, dest);
  } catch {
    // Cross-device move fallback
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
  return dest;
}

async function upload(frontPath, backPath) {
  log(`Uploading: front=${path.basename(frontPath)} back=${backPath ? path.basename(backPath) : "none"}`);

  const form = new FormData();
  form.append("front", fs.createReadStream(frontPath));
  if (backPath) form.append("back", fs.createReadStream(backPath));

  try {
    const res = await fetch(`${API_URL}/api/admin/scan-ingest`, {
      method: "POST",
      headers: {
        cookie: ADMIN_COOKIE,
        ...form.getHeaders(),
      },
      body: form,
    });

    const data = await res.json();

    if (!res.ok) {
      log(`FAILED (${res.status}): ${data.error || JSON.stringify(data)}`);
      moveFile(frontPath, FAILED);
      if (backPath) moveFile(backPath, FAILED);
      return;
    }

    log(`SUCCESS: ${data.certId} — ${data.message}`);
    log(`  Workstation: ${API_URL}${data.workstationUrl}`);
    moveFile(frontPath, PROCESSED);
    if (backPath) moveFile(backPath, PROCESSED);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    moveFile(frontPath, FAILED);
    if (backPath) moveFile(backPath, FAILED);
  }
}

function getSide(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes("_front") || lower.includes("-front")) return "front";
  if (lower.includes("_back") || lower.includes("-back")) return "back";
  return null;
}

function getBaseName(filename) {
  // Strip _front/_back suffix and extension for pairing
  return filename.replace(/[_-](front|back)/i, "").replace(/\.[^.]+$/, "");
}

function handleNewFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return;

  const filename = path.basename(filePath);
  const side = getSide(filename);
  const base = getBaseName(filename);
  const now = Date.now();

  log(`New file: ${filename} (side=${side || "auto"}, base=${base})`);

  if (side) {
    // Explicit side — look for the other half
    const otherSide = side === "front" ? "back" : "front";
    const otherKey = `${base}_${otherSide}`;
    const match = pending.get(otherKey);

    if (match) {
      pending.delete(otherKey);
      const front = side === "front" ? filePath : match.path;
      const back = side === "back" ? filePath : match.path;
      upload(front, back);
    } else {
      const key = `${base}_${side}`;
      pending.set(key, { path: filePath, time: now });
      log(`  Waiting for ${otherSide} pair...`);
      // Timeout: upload front-only if no pair arrives
      setTimeout(() => {
        if (pending.has(key)) {
          pending.delete(key);
          if (side === "front") {
            log(`  Timeout: uploading ${filename} as front-only`);
            upload(filePath, null);
          } else {
            log(`  Timeout: ${filename} is back-only, skipping (need front)`);
            moveFile(filePath, FAILED);
          }
        }
      }, PAIR_TIMEOUT_MS);
    }
  } else {
    // Auto-pair by timestamp proximity
    let paired = false;
    for (const [key, entry] of pending) {
      if (Math.abs(now - entry.time) < PAIR_TIMEOUT_MS) {
        pending.delete(key);
        // First file = front, second = back
        upload(entry.path, filePath);
        paired = true;
        break;
      }
    }
    if (!paired) {
      pending.set(filePath, { path: filePath, time: now });
      log(`  Waiting for pair (60s timeout)...`);
      setTimeout(() => {
        if (pending.has(filePath)) {
          pending.delete(filePath);
          log(`  Timeout: uploading ${filename} as front-only`);
          upload(filePath, null);
        }
      }, PAIR_TIMEOUT_MS);
    }
  }
}

// Validate config
if (!ADMIN_COOKIE) {
  console.error("ERROR: MINTVAULT_ADMIN_COOKIE env var is required.");
  console.error("Get it from your browser's DevTools → Application → Cookies → mv.sid value");
  process.exit(1);
}

log(`MintVault Scanner Watcher`);
log(`API: ${API_URL}`);
log(`Inbox: ${INBOX}`);
log(`Watching for new images...`);

const watcher = chokidar.watch(INBOX, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
});

watcher.on("add", handleNewFile);
watcher.on("error", err => log(`Watcher error: ${err.message}`));
