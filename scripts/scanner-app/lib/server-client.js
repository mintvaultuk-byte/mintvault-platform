/**
 * Server client. All HTTPS to mintvaultuk.com (or whatever
 * MINTVAULT_API_BASE is set to). Auth header: x-scanner-token, sourced
 * from ~/.mintvault-scanner.env to match the existing watcher's pattern.
 *
 * Re-uses node-fetch (same dep the old watcher used). On Node 20+ the
 * built-in fetch would do, but Electron bundles its own Node and the
 * version varies — node-fetch is stable.
 */

const fs       = require("node:fs");
const os       = require("node:os");
const path     = require("node:path");
const FormData = require("form-data");
// node-fetch v3 is ESM-only. Lazy-load via dynamic import; cache the promise.
let _fetchPromise = null;
function getFetch() {
  if (!_fetchPromise) _fetchPromise = import("node-fetch").then(m => m.default);
  return _fetchPromise;
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
async function uploadPair(frontPath, backPath) {
  const fetch = await getFetch();
  const form = new FormData();
  form.append("front", fs.createReadStream(frontPath));
  if (backPath) form.append("back", fs.createReadStream(backPath));
  form.append("client_source", "scanner_app");
  const res = await fetch(`${API_BASE}/api/admin/scan-ingest`, {
    method: "POST",
    headers: { ...authHeaders(), ...form.getHeaders() },
    body: form,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Manual single-side attach to an existing cert. The server sharp-encodes
 * the .tif → JPEG, so the watcher only needs to stream the raw file.
 */
async function attachImage(certId, side, filePath, replaceExisting) {
  const fetch = await getFetch();
  const form = new FormData();
  form.append("image", fs.createReadStream(filePath));
  form.append("side", side);
  form.append("replace_existing", replaceExisting ? "true" : "false");
  const res = await fetch(`${API_BASE}/api/admin/certs/${encodeURIComponent(certId)}/image`, {
    method: "POST",
    headers: { ...authHeaders(), ...form.getHeaders() },
    body: form,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
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
};
