/**
 * Server client. All HTTPS to mintvaultuk.com (or whatever
 * MINTVAULT_API_BASE is set to). Auth header: x-scanner-token, sourced
 * from ~/.mintvault-scanner.env to match the existing watcher's pattern.
 *
 * Re-uses node-fetch (same dep the old watcher used). On Node 20+ the
 * built-in fetch would do, but Electron bundles its own Node and the
 * version varies — node-fetch is stable.
 */

const fs        = require("node:fs");
const os        = require("node:os");
const path      = require("node:path");
const { Transform } = require("node:stream");
const FormData  = require("form-data");
const sharp     = require("sharp");
// node-fetch v3 is ESM-only. Lazy-load via dynamic import; cache the promise.
let _fetchPromise = null;
function getFetch() {
  if (!_fetchPromise) _fetchPromise = import("node-fetch").then(m => m.default);
  return _fetchPromise;
}

// Progress-based upload watchdog. We never cap total upload duration —
// large full-resolution JPEGs over a slow link can legitimately take
// minutes. Instead we abort only if the upload stream stops making
// progress (no bytes flushed to the socket) for this long, which means
// the connection has genuinely stalled. On abort we return a 504 sentinel
// so the watcher's existing retry/backoff logic re-drives the upload.
const STALL_TIMEOUT_MS = 60_000;

// Convert a source scan (TIFF/PNG/etc.) to a full-resolution JPEG buffer
// in memory. quality 92, NO resize — pixels are preserved 1:1. sharp
// auto-detects the input format from the file's magic bytes. The original
// file on disk is left untouched (it still gets archived to processed/).
// limitInputPixels:false because high-DPI SilverFast TIFFs can exceed
// sharp's default 268MP ceiling.
async function toJpegBuffer(filePath) {
  return sharp(filePath, { limitInputPixels: false })
    .jpeg({ quality: 92 })
    .toBuffer();
}

// POST a form-data body with a stall watchdog. Streams the form through a
// counting Transform so we can detect when bytes stop flowing; aborts after
// STALL_TIMEOUT_MS of zero progress. Content-Length is set explicitly
// (all parts are in-memory buffers/strings with known length) so the server
// gets a non-chunked multipart body.
// Once the body is fully flushed, the no-progress watchdog would false-positive
// (there are no more bytes to send — exactly the bug that 504'd large uploads
// while the server processed). So after the form ends we switch to a bounded
// wait for the server's reply. Generous headroom for a backgrounded raw PUT.
const RESPONSE_TIMEOUT_MS = 5 * 60_000;

async function postForm(url, form, extraHeaders = {}) {
  const fetch = await getFetch();

  let contentLength;
  try { contentLength = form.getLengthSync(); } catch { contentLength = undefined; }
  const headers = { ...authHeaders(), ...form.getHeaders(), ...extraHeaders };
  if (contentLength != null) headers["content-length"] = String(contentLength);

  const controller = new AbortController();
  let lastFlush = Date.now();
  let bytesSent = 0;
  let bodyEnded = false;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      lastFlush = Date.now();
      bytesSent += chunk.length;
      cb(null, chunk);
    },
  });
  form.on("error", (err) => counter.destroy(err));
  form.pipe(counter);
  // Body fully produced + accepted downstream → stop the no-progress abort and
  // start the bounded response wait.
  counter.on("end", () => {
    bodyEnded = true;
    lastFlush = Date.now();
  });

  const watchdog = setInterval(() => {
    const idle = Date.now() - lastFlush;
    if (!bodyEnded) {
      // Phase 1 — body still transferring: abort only on a genuine stall.
      if (idle > STALL_TIMEOUT_MS) {
        console.warn(
          `[server-client] upload STALLED mid-transfer — sent ${bytesSent}/${contentLength ?? "?"} bytes, no progress ${STALL_TIMEOUT_MS / 1000}s — aborting for retry`
        );
        controller.abort();
      }
    } else if (idle > RESPONSE_TIMEOUT_MS) {
      // Phase 2 — body fully sent, server slow to reply.
      console.warn(
        `[server-client] no response ${RESPONSE_TIMEOUT_MS / 1000}s after full ${bytesSent}-byte upload — aborting`
      );
      controller.abort();
    }
  }, 5_000);

  try {
    const res = await fetch(url, { method: "POST", headers, body: counter, signal: controller.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === "AbortError") {
      const reason = bodyEnded
        ? `server slow — no reply ${RESPONSE_TIMEOUT_MS / 1000}s after full upload`
        : `upload stalled — no progress ${STALL_TIMEOUT_MS / 1000}s (${bytesSent}/${contentLength ?? "?"} bytes)`;
      return { ok: false, status: 504, body: { error: reason } };
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

function loadEnv() {
  // Match the existing watcher's env file location so the operator
  // doesn't need a second secrets file.
  const envPath = path.join(os.homedir(), ".mintvault-scanner.env");
  const out = {};
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* file may not exist on first install — handled at startup */ }
  return out;
}

const env = loadEnv();
const API_BASE = process.env.MINTVAULT_API_BASE || env.MINTVAULT_API_BASE || "https://mintvaultuk.com";
const TOKEN    = process.env.SCANNER_API_TOKEN  || env.SCANNER_API_TOKEN  || "";

function authHeaders() {
  return TOKEN ? { "x-scanner-token": TOKEN } : {};
}

async function getJson(urlPath) {
  const fetch = await getFetch();
  const res = await fetch(`${API_BASE}${urlPath}`, { method: "GET", headers: authHeaders() });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

async function postJson(urlPath, payload) {
  const fetch = await getFetch();
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

async function deleteJson(urlPath, payload) {
  const fetch = await getFetch();
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

// ── Specific server calls ─────────────────────────────────────────────────

async function getNextCertId() {
  return getJson("/api/admin/next-cert-id");
}

async function getOrphans() {
  return getJson("/api/admin/orphan-certs");
}

async function getCertPreview(certId) {
  return getJson(`/api/admin/certs/${encodeURIComponent(certId)}/preview`);
}

async function softDeleteCert(certId, reason) {
  return deleteJson(`/api/admin/certs/${encodeURIComponent(certId)}`, { reason });
}

/**
 * Upload a strict-alternating front+back pair via the existing scan-ingest
 * endpoint. Server allocates the next cert and runs identification + AI on
 * both sides. Same multipart shape as the old watcher.
 */
async function uploadPair(frontPath, backPath, idempotencyKey) {
  const form = new FormData();
  // Convert to full-resolution JPEG in memory; the raw TIFF/PNG stays on disk.
  form.append("front", await toJpegBuffer(frontPath), { filename: "front.jpg", contentType: "image/jpeg" });
  if (backPath) form.append("back", await toJpegBuffer(backPath), { filename: "back.jpg", contentType: "image/jpeg" });
  // Content-derived idempotency key (front+back SHA, computed by the watcher and
  // stable across retries/restarts). The server's UNIQUE-index gate makes a
  // re-driven/raced ingest resolve to the SAME cert — never a duplicate.
  const headers = idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {};
  return postForm(`${API_BASE}/api/admin/scan-ingest`, form, headers);
}

/**
 * Poll a cert's ingest durability status. The watcher holds the inbox file until
 * raw_uploaded === true here, then moves it (the core-invariant completion
 * signal). Also the reconcile probe after a crash.
 */
async function getScanStatus(certId) {
  return getJson(`/api/admin/scan-status/${encodeURIComponent(certId)}`);
}

/**
 * Manual single-side attach to an existing cert. The server sharp-encodes
 * the .tif → JPEG, so the watcher only needs to stream the raw file.
 */
async function attachImage(certId, side, filePath, replaceExisting) {
  const form = new FormData();
  // Convert to full-resolution JPEG in memory; the raw TIFF/PNG stays on disk.
  form.append("image", await toJpegBuffer(filePath), { filename: `${side}.jpg`, contentType: "image/jpeg" });
  form.append("side", side);
  form.append("replace_existing", replaceExisting ? "true" : "false");
  return postForm(`${API_BASE}/api/admin/certs/${encodeURIComponent(certId)}/image`, form);
}

module.exports = {
  API_BASE,
  hasToken: () => !!TOKEN,
  getNextCertId,
  getOrphans,
  getCertPreview,
  softDeleteCert,
  uploadPair,
  attachImage,
  getScanStatus,
};
