/**
 * Authenticated distributed-station API client. It is intentionally separate
 * from the legacy scanner-token client during migration: current local LiDE
 * proof remains isolated, while enrolled production stations use only this
 * signed user+station path.
 */
const stationIdentity = require("./station-identity");
const stationRequestQueue = require("./station-request-queue");
const stationAuthorityLatch = require("./station-authority-latch");
const enrolmentOperation = require("./enrolment-operation");

let fetchPromise = null;
function getFetch() {
  if (!fetchPromise) fetchPromise = import("node-fetch").then((m) => m.default);
  return fetchPromise;
}

function baseUrl() {
  // Share the same configured host (including the explicit local-development
  // override and legacy-ingest migration fallback) as the scanner evidence
  // client. First-run identity must never silently enrol against production
  // while the physical capture client points at a development server.
  return String(require("./server-client").API_BASE).replace(/\/$/, "");
}

function cookieTokenFrom(response) {
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie().join("; ")
    : response.headers.get("set-cookie") || "";
  const match = /(?:^|[,;]\s*)mv\.partner\.sid=([^;]+)/.exec(raw);
  return match ? decodeURIComponent(match[1]) : null;
}

async function readJson(response) {
  const raw = await response.text();
  try { return JSON.parse(raw); } catch { return { raw }; }
}

async function operatorJson(method, apiPath, payload) {
  const fetch = await getFetch();
  const operatorSession = stationIdentity._private.readOperatorSession();
  if (!operatorSession) throw new Error("Sign in to MintVault before using this station");
  const init = {
    method,
    headers: { "content-type": "application/json", cookie: `mv.partner.sid=${encodeURIComponent(operatorSession)}` },
  };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(payload || {});
  const response = await fetch(`${baseUrl()}${apiPath}`, init);
  return { ok: response.ok, status: response.status, body: await readJson(response) };
}

/**
 * The shop's SERVER-REPORTED Grading Credit balance, for the Scanner's identity row.
 *
 * Read through the operator's own session because `/api/partner/credits` is a portal capability
 * (`partner.credits.view`), not a station one — a Mac has no wallet of its own to report. Display
 * only: pressing NEW asks the server again, and the server's answer at that moment is the one that
 * decides. A stale number here can never authorise or refuse a card.
 */
async function creditSummary() {
  return operatorJson("GET", "/api/partner/credits");
}

async function signedJson(method, apiPath, payload) {
  return stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const serialized = Buffer.from(JSON.stringify(payload || {}));
    const headers = stationIdentity.signStoredRequest({ method, path: apiPath, body: serialized });
    const response = await fetch(`${baseUrl()}${apiPath}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: serialized,
    });
    return stationAuthorityLatch.observe({ ok: response.ok, status: response.status, body: await readJson(response) });
  });
}

async function signedJsonV2(method, apiPath, payload, semanticOperationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(semanticOperationId || ""))) {
    throw new Error("Signed station mutation needs a valid semantic operation ID");
  }
  return stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const serialized = Buffer.from(JSON.stringify(payload || {}));
    const headers = stationIdentity.signStoredRequestV2({
      method, path: apiPath, body: serialized, semanticOperationId,
    });
    const response = await fetch(`${baseUrl()}${apiPath}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: serialized,
    });
    return stationAuthorityLatch.observe({ ok: response.ok, status: response.status, body: await readJson(response) });
  });
}

async function signIn(email, password) {
  const fetch = await getFetch();
  const response = await fetch(`${baseUrl()}/api/partner/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(response);
  if (!response.ok) return { ok: false, status: response.status, body };
  const token = cookieTokenFrom(response);
  if (!token) return { ok: false, status: 500, body: { error: "MintVault sign-in did not issue an operator session" } };
  stationIdentity.setOperatorSession(token);
  return { ok: true, status: response.status, body };
}

async function completeMfa({ code, recoveryCode }) {
  return operatorJson("POST", "/api/partner/auth/mfa", { code, recoveryCode });
}

/**
 * SHIFT CHANGE is local-first: delete the human credential before any network
 * wait, then make a best-effort server revocation with the retained in-memory
 * value. Station identity and already-authorised evidence custody are untouched.
 */
async function signOutWith({ token, clearSession, fetchImpl, origin }) {
  clearSession();
  if (!token) return { ok: true, remoteRevoked: true };
  try {
    const response = await fetchImpl(`${origin}/api/partner/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `mv.partner.sid=${encodeURIComponent(token)}` },
      body: "{}",
    });
    return { ok: true, remoteRevoked: response.ok };
  } catch {
    return { ok: true, remoteRevoked: false };
  }
}

async function signOut() {
  const token = stationIdentity._private.readOperatorSession();
  stationIdentity.clearOperatorSession();
  let fetch;
  try { fetch = await getFetch(); }
  catch { return { ok: true, remoteRevoked: false }; }
  return signOutWith({
    token,
    clearSession: () => {},
    fetchImpl: fetch,
    origin: baseUrl(),
  });
}

async function stationSession() {
  return operatorJson("GET", "/api/partner/session");
}

async function enrolmentLocations() {
  return operatorJson("GET", "/api/partner/stations/enrolment-locations");
}

async function enrolmentStatus(stationCode) {
  if (typeof stationCode !== "string" || !stationCode) throw new Error("Station code is required");
  return operatorJson("GET", `/api/partner/stations/${encodeURIComponent(stationCode)}/enrolment-status`);
}

async function selectLocation(locationId) {
  return operatorJson("POST", "/api/partner/session/location", { locationId });
}

async function registerThisMac({ locationId, appVersion }) {
  const payload = { ...stationIdentity.enrolmentPublicPayload(appVersion), ...(locationId ? { locationId } : {}) };
  const operation = enrolmentOperation.beginOrResume(payload);
  const durablePayload = operation.payload;
  const result = await operatorJson("POST", "/api/partner/stations/enrol", { ...durablePayload, clientOpId: operation.id });
  if (result.ok && result.body?.station?.stationCode) {
    stationIdentity.saveEnrollment({
      stationCode: result.body.station.stationCode,
      publicKeyFingerprint: durablePayload.publicKeyFingerprint,
      status: result.body.station.status || "PENDING",
    });
    enrolmentOperation.complete(operation, `station:${result.body.station.stationCode}`);
  }
  return result;
}

async function heartbeat(payload) {
  return signedJson("POST", "/api/partner/stations/heartbeat", payload);
}

async function saveCalibration(payload) {
  return signedJsonV2(
    "POST",
    "/api/partner/stations/calibrations",
    payload,
    payload?.semanticOperationId,
  );
}

module.exports = {
  creditSummary,
  signIn,
  completeMfa,
  signOut,
  stationSession,
  enrolmentLocations,
  enrolmentStatus,
  selectLocation,
  registerThisMac,
  heartbeat,
  saveCalibration,
  _private: { cookieTokenFrom, baseUrl, signOutWith, signedJsonV2 },
};
