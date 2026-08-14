/**
 * Server client. A packaged Scanner is pinned to the immutable MintVault HTTPS
 * origin. Explicit API-base and legacy-ingest overrides exist only for the
 * unpackaged development harness.
 *
 * Re-uses node-fetch (same dep the old watcher used). On Node 20+ the
 * built-in fetch would do, but Electron bundles its own Node and the
 * version varies — node-fetch is stable.
 */

const fs        = require("node:fs");
const os        = require("node:os");
const path      = require("node:path");
const crypto    = require("node:crypto");
const { Transform } = require("node:stream");
const FormData  = require("form-data");
const stationIdentity = require("./station-identity");
const stationRequestQueue = require("./station-request-queue");
const stationAuthorityLatch = require("./station-authority-latch");
const runtimePaths = require("./runtime-paths");
const { directFetch, boundedResponseText } = require("./http-safety");
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

// Phase 58A evidence invariant: the scanner-produced TIFF is the master.
// Do not decode, colour-convert, resize, or re-encode it in this client.
// A separate, explicitly non-authoritative preview can be introduced later,
// but it must never replace this multipart part.
function assertTiffMaster(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 4) {
    throw new Error(`authoritative scan is not a readable TIFF file: ${filePath}`);
  }

  const header = Buffer.alloc(4);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  // Classic TIFF (42) and BigTIFF (43), in either byte order. Full decoder
  // validation belongs to the server before it accepts an immutable master.
  const isTiff =
    (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a && header[3] === 0x00) ||
    (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0x00 && header[3] === 0x2a) ||
    (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2b && header[3] === 0x00) ||
    (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0x00 && header[3] === 0x2b);
  if (!isTiff) {
    throw new Error(`authoritative scan is not TIFF-signature data: ${filePath}`);
  }
  return stat.size;
}

function appendTiffMaster(form, field, filePath) {
  const byteLength = assertTiffMaster(filePath);
  // Streaming preserves the scanner's original byte sequence and avoids
  // materialising a 16-bit V850 TIFF in memory before the upload.
  form.append(field, fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: "image/tiff",
    knownLength: byteLength,
  });
}

/** Hash directly from the durable local TIFF; never materialise a master in Electron heap. */
function fingerprintTiffMaster(filePath) {
  const byteLength = assertTiffMaster(filePath);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve({ byteLength, sha256: hash.digest("hex") }));
  });
}

/** PUT an exact TIFF stream to a server-minted R2 staging URL. */
async function putStagedTiff(uploadUrl, suppliedHeaders, filePath, byteLength) {
  validateDirectUploadGrant(uploadUrl, suppliedHeaders);
  const fetch = await getFetch();
  const stream = fs.createReadStream(filePath);
  const controller = new AbortController();
  let lastProgressAt = Date.now();
  let sent = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      sent += chunk.length;
      lastProgressAt = Date.now();
      callback(null, chunk);
    },
  });
  stream.on("error", (error) => counter.destroy(error));
  stream.pipe(counter);
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) controller.abort();
  }, 5_000);
  try {
    const response = await directFetch(fetch, uploadUrl, {
      method: "PUT",
      headers: { ...suppliedHeaders, "content-length": String(byteLength) },
      body: counter,
      signal: controller.signal,
    });
    if (!response.ok) {
      await boundedResponseText(response, 64 * 1024).catch(() => "");
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
      return { ok: false, status, body: { error: status ? `Evidence staging service rejected upload — HTTP ${status}` : "Evidence staging service rejected upload" } };
    }
    if (sent !== byteLength) return { ok: false, status: 0, body: { error: "R2 staging stream ended before all TIFF bytes were sent" } };
    return { ok: true, status: response.status, body: {} };
  } catch (error) {
    return { ok: false, status: 0, body: { error: error?.name === "AbortError" ? "Evidence staging upload stalled" : "Evidence staging transport failed" } };
  } finally {
    clearInterval(watchdog);
  }
}

function validateDirectUploadGrant(uploadUrl, suppliedHeaders, stagingId = null) {
  if (typeof uploadUrl !== "string" || uploadUrl.length < 12 || uploadUrl.length > 4096) {
    throw new Error("Direct evidence upload URL is invalid");
  }
  let parsed;
  try { parsed = new URL(uploadUrl); } catch { throw new Error("Direct evidence upload URL is invalid"); }
  const insecureLoopbackTest = !runtime.isPackaged && process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD === "1"
    && parsed.protocol === "http:" && ["127.0.0.1", "::1"].includes(parsed.hostname);
  if ((!insecureLoopbackTest && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash
      || (!insecureLoopbackTest && !(parsed.hostname.endsWith(".r2.cloudflarestorage.com")
        || parsed.hostname === "uploads.mintvaultuk.com"))) {
    throw new Error("Direct evidence upload URL is outside the pinned HTTPS storage boundary");
  }
  if (stagingId !== null && (typeof stagingId !== "string" || stagingId.length < 8 || stagingId.length > 160
      || !/^[A-Za-z0-9_-]+$/.test(stagingId))) {
    throw new Error("Direct evidence staging ID is invalid");
  }
  if (!suppliedHeaders || typeof suppliedHeaders !== "object" || Array.isArray(suppliedHeaders)
      || Object.getPrototypeOf(suppliedHeaders) !== Object.prototype || Object.keys(suppliedHeaders).length > 32) {
    throw new Error("Direct evidence upload headers are invalid");
  }
  const forbidden = new Set(["authorization", "cookie", "host", "connection", "transfer-encoding", "content-length", "proxy-authorization"]);
  for (const [name, value] of Object.entries(suppliedHeaders)) {
    const normalized = name.toLowerCase();
    if (name !== normalized || !/^[a-z0-9-]{1,80}$/.test(name) || forbidden.has(normalized)
        || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) {
      throw new Error("Direct evidence upload headers are invalid");
    }
  }
  return Object.freeze({ url: parsed.toString(), headers: Object.freeze({ ...suppliedHeaders }), stagingId });
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
  if (stationIdentity.hasActiveStationSession() || stationIdentity.hasActiveStationIdentity()) {
    return {
      ok: false,
      status: 426,
      body: { error: "Signed stations require digest-bound staged upload and finalisation; multipart fallback is disabled" },
    };
  }
  return stationRequestQueue.run(() => postFormNow(url, form, extraHeaders));
}

async function postFormNow(url, form, extraHeaders = {}) {
  const fetch = await getFetch();

  let contentLength;
  try { contentLength = form.getLengthSync(); } catch { contentLength = undefined; }
  const requestUrl = new URL(url);
  // Multipart evidence is intentionally streamed from disk.  The canonical
  // server still validates and hashes the uploaded TIFF bytes before it can
  // become evidence; the signed envelope binds the station, method and exact
  // route without materialising a 1200-DPI TIFF in Electron memory.
  const headers = {
    ...(!runtime.isPackaged && process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN === "1" ? legacyAuthHeaders() : {}),
    ...form.getHeaders(),
    ...extraHeaders,
  };
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
    const res = await directFetch(fetch, url, { method: "POST", headers, body: counter, signal: controller.signal });
    const text = await boundedResponseText(res);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return stationAuthorityLatch.observe({ ok: res.ok, status: res.status, body });
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

function baseFromLegacyIngestUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    // Older stations stored the complete legacy ingest endpoint.  Preserve its
    // origin (and any non-root deployment prefix), removing only the retired
    // endpoint suffix so the new session routes stay on that same server.
    url.pathname = url.pathname.replace(/\/api\/admin\/scan-ingest\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).replace(/\/api\/admin\/scan-ingest\/?(?:\?.*)?$/, "").replace(/\/$/, "");
  }
}

const PRODUCTION_API_BASE = "https://mintvaultuk.com";
const configuredPaths = runtimePaths.current();
const env = configuredPaths.isPackaged ? {} : loadEnv();

function developmentApiBase() {
  return process.env.MINTVAULT_API_BASE ||
    env.MINTVAULT_API_BASE ||
    baseFromLegacyIngestUrl(process.env.MINTVAULT_INGEST_URL || env.MINTVAULT_INGEST_URL) ||
    PRODUCTION_API_BASE;
}

let runtime = Object.freeze({
  configured: configuredPaths.configured,
  // A directly required production module must already fail toward the pinned
  // origin even before Electron supplies its non-overridable packaged fact.
  isPackaged: configuredPaths.isPackaged,
});
let API_BASE = runtime.isPackaged ? PRODUCTION_API_BASE : developmentApiBase();

function configureRuntime({ isPackaged }) {
  if (typeof isPackaged !== "boolean") throw new Error("Scanner server runtime configuration is invalid");
  runtime = Object.freeze({ configured: true, isPackaged });
  API_BASE = isPackaged ? PRODUCTION_API_BASE : developmentApiBase();
  // Preserve the historical property contract for main/station-client while
  // replacing any value selected before app.isPackaged became available.
  module.exports.API_BASE = API_BASE;
  return API_BASE;
}

// Live credentials: the env file is re-read whenever its mtime changes, so a
// rotated SCANNER_API_TOKEN takes effect on the next request WITHOUT an app
// restart (previously the token was read once at startup and a rotation left
// the app silently 401ing until someone kickstarted it). process.env still
// wins when set (launchd wrapper sources the same file at boot — same values
// unless the file changed since; the mtime check covers exactly that case).
const ENV_PATH = path.join(os.homedir(), ".mintvault-scanner.env");
let _envCache = { mtimeMs: -1, vals: env };
function liveEnv() {
  if (runtime.isPackaged) return {};
  try {
    const st = fs.statSync(ENV_PATH);
    if (st.mtimeMs !== _envCache.mtimeMs) {
      _envCache = { mtimeMs: st.mtimeMs, vals: loadEnv() };
      console.log("[server-client] env file changed on disk — credentials reloaded");
    }
  } catch { /* keep last-known values if the file vanishes mid-session */ }
  return _envCache.vals;
}

function legacyAuthHeaders() {
  if (runtime.isPackaged) return {};
  const vals = liveEnv();
  const token = vals.SCANNER_API_TOKEN || process.env.SCANNER_API_TOKEN || "";
  const operator = vals.SCANNER_OPERATOR || process.env.SCANNER_OPERATOR || "";
  const headers = token ? { "x-scanner-token": token } : {};
  if (operator) headers["x-scanner-operator"] = operator;
  return headers;
}

function requestAuthHeaders(method, urlPath, body, { allowStationOnly = false } = {}) {
  if (stationIdentity.hasActiveStationSession() || (allowStationOnly && stationIdentity.hasActiveStationIdentity())) {
    return stationIdentity.signStoredRequest({
      method,
      path: urlPath,
      body: Buffer.isBuffer(body) ? body : Buffer.from(body || ""),
      // An already-authorised capture belongs to the actor frozen into that
      // authorisation. Never attach whoever happens to be on shift at retry.
      includeOperatorSession: !allowStationOnly,
    });
  }
  // Old shared-token stations remain usable only for the isolated local/dev
  // proof flow.  The server independently rejects this path in production.
  return !runtime.isPackaged && process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN === "1"
    ? legacyAuthHeaders()
    : {};
}

async function getJson(urlPath, options = {}) {
  return stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const res = await directFetch(fetch, `${API_BASE}${urlPath}`, {
      method: "GET",
      headers: requestAuthHeaders("GET", urlPath, Buffer.alloc(0), options),
    });
    const text = await boundedResponseText(res);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return stationAuthorityLatch.observe({ ok: res.ok, status: res.status, body });
  });
}

async function postJson(urlPath, payload, options = {}) {
  return stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const requestBody = JSON.stringify(payload || {});
    const res = await directFetch(fetch, `${API_BASE}${urlPath}`, {
      method: "POST",
      headers: { ...requestAuthHeaders("POST", urlPath, Buffer.from(requestBody), options), "content-type": "application/json" },
      body: requestBody,
    });
    const text = await boundedResponseText(res);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return stationAuthorityLatch.observe({ ok: res.ok, status: res.status, body });
  });
}

async function postJsonV2(urlPath, payload, semanticOperationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(semanticOperationId || ""))) {
    throw new Error("Station mutation needs a valid semantic operation ID");
  }
  return stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const requestBody = JSON.stringify(payload || {});
    const headers = stationIdentity.signStoredRequestV2({
      method: "POST", path: urlPath, body: Buffer.from(requestBody), semanticOperationId,
    });
    const res = await directFetch(fetch, `${API_BASE}${urlPath}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: requestBody,
    });
    const text = await boundedResponseText(res);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return stationAuthorityLatch.observe({ ok: res.ok, status: res.status, body });
  });
}

async function deleteJson(urlPath, payload) {
  return stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const requestBody = JSON.stringify(payload || {});
    const res = await directFetch(fetch, `${API_BASE}${urlPath}`, {
      method: "DELETE",
      headers: { ...requestAuthHeaders("DELETE", urlPath, Buffer.from(requestBody)), "content-type": "application/json" },
      body: requestBody,
    });
    const text = await boundedResponseText(res);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return stationAuthorityLatch.observe({ ok: res.ok, status: res.status, body });
  });
}

// ── Specific server calls ─────────────────────────────────────────────────

async function getNextCertId() {
  return getJson("/api/admin/next-cert-id");
}

/**
 * LEGACY, and deliberately still 403 for a signed station.
 *
 * `/api/admin/orphan-certs` addresses certificates with no tenant predicate. It is kept for the
 * admin-cookie callers it was built for and is NOT the Scanner's path — see getFixQueue below.
 */
async function getOrphans() {
  return getJson("/api/admin/orphan-certs");
}

/**
 * P7 — the FIX queue, scoped to THIS station's partner and location by the server.
 *
 * This is what the "Fix missing images" picker now calls. The list is derived from the partner's own
 * Card Jobs, so the operator never types an MV number — which is what removes any opportunity to
 * name someone else's card.
 */
async function getFixQueue() {
  return getJson("/api/partner/stations/fix-queue");
}

/**
 * P7 — authorise re-capture of the missing side(s). COSTS ZERO GRADING CREDITS and works at a zero
 * balance: the card was already paid for, and a defect in our own capture is not a reason to charge
 * again. Same Card Job, same MV, same certificate.
 */
async function authoriseFix(cardJobId, sides, clientOpId) {
  return postJsonV2(`/api/partner/card-jobs/${encodeURIComponent(cardJobId)}/fix-authorise`,
    { sides, clientOpId }, clientOpId);
}

/**
 * P6 — "NEW CARD": ask the server to authorise one new Card Job against one Grading Credit.
 *
 * `clientOpId` is the RETRY TOKEN and must stay identical across every retry of one press. The
 * server keys idempotency on (station, clientOpId), so a dropped response, a double-click or an app
 * restart mid-request all return the SAME card, the same MV and the same reservation — and spend
 * nothing further. Generating a fresh id on retry is precisely how a shop would be charged twice,
 * which is why the caller owns it and this function never invents one.
 *
 * The station sends no tenant, no location and no operator: the server takes all three from the
 * signed station identity and the operator session header. It cannot ask for a card on behalf of
 * anyone else.
 */
async function startNewCard(clientOpId, cardName) {
  return postJson("/api/partner/card-jobs", {
    clientOpId,
    ...(cardName ? { cardName } : {}),
  });
}

/** Cancel one exact, still-unspent Card Job before its first accepted side. */
async function cancelCardJob(operation) {
  const payload = operation?.payload || {};
  return postJsonV2(
    `/api/partner/card-jobs/${encodeURIComponent(payload.cardJobId)}/cancel`,
    {
      clientOpId: operation.id,
      captureSessionId: payload.captureSessionId,
      captureAuthorisationId: payload.captureAuthorisationId,
    },
    operation.id,
  );
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
  appendTiffMaster(form, "front", frontPath);
  if (backPath) appendTiffMaster(form, "back", backPath);
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
 * Manual single-side attach to an existing cert. This sends the original
 * scanner TIFF as the same authoritative-master type as pair ingestion.
 */
async function attachImage(certId, side, filePath, replaceExisting) {
  const form = new FormData();
  appendTiffMaster(form, "image", filePath);
  form.append("side", side);
  form.append("replace_existing", replaceExisting ? "true" : "false");
  return postForm(`${API_BASE}/api/admin/certs/${encodeURIComponent(certId)}/image`, form);
}

/** Claim only a server-armed, workstation-bound capture target. */
async function claimNextCapture(workstationId, deviceId) {
  return getJson(
    `/api/admin/scanner/capture-sessions/next?workstation_id=${encodeURIComponent(workstationId)}&device_id=${encodeURIComponent(deviceId)}`
  );
}

async function requestRescanAuthorisation(sessionId, deviceId, priorCaptureAuthorisationId, requestOperationId) {
  return postJson(`/api/admin/scanner/capture-sessions/${encodeURIComponent(sessionId)}/rescan-authorisation`, {
    device_id: deviceId,
    prior_capture_authorisation_id: priorCaptureAuthorisationId,
    request_operation_id: requestOperationId,
  });
}

/**
 * Upload to a server-owned R2 staging key, then ask the server to validate and
 * promote that exact object. Authoritative capture has no multipart or static
 * token fallback: every attempt must first obtain a fresh bounded grant.
 */
async function uploadCaptureEvidence(sessionId, deviceId, filePath, provenance, evidenceBinding = {}) {
  const expected = await fingerprintTiffMaster(filePath);
  const required = (key) => {
    const value = evidenceBinding[key];
    if (typeof value !== "string" || !value) throw new Error(`Evidence binding is missing ${key}`);
    return value;
  };
  if (expected.sha256 !== evidenceBinding.expectedSha256 || expected.byteLength !== evidenceBinding.expectedByteLength ||
      evidenceBinding.expectedMimeType !== "image/tiff") {
    throw new Error("Decrypted TIFF does not match the authenticated queue digest, size, or MIME type");
  }
  if (!Number.isSafeInteger(evidenceBinding.revision) || evidenceBinding.revision < 1) {
    throw new Error("Evidence binding is missing a valid revision");
  }
  const immutableBinding = {
    capture_session_id: sessionId,
    capture_authorisation_id: required("captureAuthorisationId"),
    semantic_operation_id: required("semanticOperationId"),
    card_job_id: required("cardJobId"),
    certificate_number: required("certificateNumber"),
    side: required("side"),
    revision: evidenceBinding.revision,
    profile_revision_id: required("profileRevisionId"),
    tenant_id: required("tenantId"),
    location_id: required("locationId"),
    station_id: required("stationId"),
    workstation_id: required("workstationId"),
    original_operator_id: required("originalOperatorId"),
    original_operator_role: required("originalOperatorRole"),
    purpose: required("capturePurpose"),
    authorisation_issued_at: required("authorisationIssuedAt"),
    authorisation_expires_at: required("authorisationExpiresAt"),
    device_captured_at: required("deviceCapturedAt"),
    device_timestamp_authority: required("deviceTimestampAuthority"),
    sha256: expected.sha256,
    byte_length: expected.byteLength,
    mime_type: "image/tiff",
    app_version: required("appVersion"),
    capture_helper_version: required("captureHelperVersion"),
    identity_helper_version: required("identityHelperVersion"),
  };
  if (immutableBinding.device_timestamp_authority !== "NON_AUTHORITATIVE") {
    throw new Error("Device timestamp authority must be NON_AUTHORITATIVE");
  }
  const grant = await postJson(`/api/admin/scanner/capture-sessions/${encodeURIComponent(sessionId)}/staged-upload`, {
    device_id: deviceId,
    ...immutableBinding,
    capture_provenance: provenance,
  }, { allowStationOnly: true });
  if (grant.ok && grant.body?.transport === "direct" && grant.body?.upload_url && grant.body?.staging_id) {
    try { validateDirectUploadGrant(grant.body.upload_url, grant.body.headers || {}, grant.body.staging_id); }
    catch (error) { return { ok: false, status: 502, body: { error: error.message } }; }
    const staged = await putStagedTiff(grant.body.upload_url, grant.body.headers || {}, filePath, expected.byteLength);
    if (!staged.ok) return staged;
    return postJson(
      `/api/admin/scanner/capture-sessions/${encodeURIComponent(sessionId)}/staged-upload/${encodeURIComponent(grant.body.staging_id)}/finalise`,
      { device_id: deviceId, staging_id: grant.body.staging_id, ...immutableBinding },
      { allowStationOnly: true }
    );
  }
  if (!grant.ok) return grant;
  return { ok: false, status: 502, body: { error: "Server did not return a valid direct evidence-upload grant" } };
}

/**
 * Confirm a direct upload after a transport timeout.  The server derives
 * `accepted` from immutable evidence provenance for this exact session, so a
 * lost 201 never forces an operator to rescan a successfully captured side.
 */
async function getCaptureStatus(sessionId, deviceId) {
  return getJson(
    `/api/admin/scanner/capture-sessions/${encodeURIComponent(sessionId)}?device_id=${encodeURIComponent(deviceId)}`,
    { allowStationOnly: true },
  );
}

/** Keep only this already-claimed station target alive during operator review. */
async function renewCapture(sessionId, deviceId) {
  return postJson(`/api/admin/scanner/capture-sessions/${encodeURIComponent(sessionId)}/keepalive`, {
    device_id: deviceId,
  });
}

/** Release a claimed session when ImageCaptureCore cannot start or complete it. */
async function failCapture(sessionId, deviceId, reason) {
  return postJson(`/api/admin/scanner/capture-sessions/${encodeURIComponent(sessionId)}/failed`, {
    device_id: deviceId,
    reason,
  });
}

module.exports = {
  API_BASE,
  PRODUCTION_API_BASE,
  configureRuntime,
  hasToken: () => {
    const vals = liveEnv();
    return stationIdentity.hasActiveStationSession() ||
      (!runtime.isPackaged && process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN === "1" && !!(vals.SCANNER_API_TOKEN || process.env.SCANNER_API_TOKEN));
  },
  hasActiveStationIdentity: () => stationIdentity.hasActiveStationIdentity(),
  getNextCertId,
  getOrphans,
  getFixQueue,
  authoriseFix,
  startNewCard,
  cancelCardJob,
  getCertPreview,
  softDeleteCert,
  uploadPair,
  attachImage,
  claimNextCapture,
  requestRescanAuthorisation,
  uploadCaptureEvidence,
  getCaptureStatus,
  renewCapture,
  failCapture,
  getScanStatus,
  // Deliberately exposed for the scanner-app regression test only.
  _private: { assertTiffMaster, fingerprintTiffMaster, putStagedTiff, validateDirectUploadGrant, baseFromLegacyIngestUrl, developmentApiBase, legacyAuthHeaders, requestAuthHeaders },
};
