/**
 * Authenticated distributed-station API client. It is intentionally separate
 * from the legacy scanner-token client during migration: current local LiDE
 * proof remains isolated, while enrolled production stations use only this
 * signed user+station path.
 */
const stationIdentity = require("./station-identity");

let fetchPromise = null;
function getFetch() {
  if (!fetchPromise) fetchPromise = import("node-fetch").then((m) => m.default);
  return fetchPromise;
}

function baseUrl() {
  // Share the DECLARED environment with the scanner evidence client, so identity enrolment and
  // physical capture can never address two different MintVaults. This now THROWS on an
  // unconfigured or contradictory station instead of resolving to a default host — refusing to
  // sign in is the correct answer to "which MintVault is this?" when nobody has said.
  return String(require("./server-client").API_BASE).replace(/\/$/, "");
}

function cookieTokenFrom(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie().join("; ")
      : response.headers.get("set-cookie") || "";
  const match = /(?:^|[,;]\s*)mv\.partner\.sid=([^;]+)/.exec(raw);
  return match ? decodeURIComponent(match[1]) : null;
}

async function readJson(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function operatorJsonForSession(operatorSession, method, apiPath, payload) {
  const fetch = await getFetch();
  if (!operatorSession) throw new Error("Sign in to MintVault before using this station");
  stationIdentity._private.assertOperatorSession(operatorSession);
  const init = {
    method,
    headers: { "content-type": "application/json", cookie: `mv.partner.sid=${encodeURIComponent(operatorSession)}` },
  };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(payload || {});
  const response = await fetch(`${baseUrl()}${apiPath}`, init);
  const body = await readJson(response);
  // A response authorises only the exact session that sent it. A concurrent sign-in, sign-out or
  // second process replacing the encrypted token makes this response stale, even when HTTP was 200.
  stationIdentity._private.assertOperatorSession(operatorSession);
  return { ok: response.ok, status: response.status, body };
}

async function operatorJson(method, apiPath, payload) {
  const operatorSession = stationIdentity._private.readOperatorSession();
  return operatorJsonForSession(operatorSession, method, apiPath, payload);
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

async function creditPacks() {
  return operatorJson("GET", "/api/partner/credits/packs");
}

async function creditCheckout(packCode) {
  return operatorJson("POST", "/api/partner/credits/checkout", { packCode });
}

async function signedJson(method, apiPath, payload) {
  const fetch = await getFetch();
  const serialized = Buffer.from(JSON.stringify(payload || {}));
  const headers = stationIdentity.signStoredRequest({ method, path: apiPath, body: serialized });
  const response = await fetch(`${baseUrl()}${apiPath}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: serialized,
  });
  return { ok: response.ok, status: response.status, body: await readJson(response) };
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

async function registerThisMacWith(operatorSession, operatorRequest, { locationId, appVersion }) {
  const payload = { ...stationIdentity.enrolmentPublicPayload(appVersion), ...(locationId ? { locationId } : {}) };
  const result = await operatorRequest("POST", "/api/partner/stations/enrol", payload);
  if (result.ok && result.body?.station?.stationCode) {
    stationIdentity._private.assertOperatorSession(operatorSession);
    stationIdentity.saveEnrollment({
      stationCode: result.body.station.stationCode,
      publicKeyFingerprint: payload.publicKeyFingerprint,
      status: result.body.station.status || "PENDING",
      expectedOperatorSession: operatorSession,
    });
  }
  return result;
}

async function registerThisMac(options) {
  return operatorSessionScope().registerThisMac(options);
}

/**
 * One immutable operator-session generation for the complete setup transaction.
 *
 * The token stays inside this closure. Every request verifies it both before dispatch and after the
 * response, and station validation compares against the same token. A concurrent sign-in/sign-out
 * therefore invalidates the whole transaction instead of letting an old response bless a new token.
 */
function operatorSessionScope() {
  const operatorSession = stationIdentity._private.readOperatorSession();
  stationIdentity._private.assertOperatorSession(operatorSession);
  const request = (method, apiPath, payload) => operatorJsonForSession(operatorSession, method, apiPath, payload);
  return Object.freeze({
    assertCurrent: () => stationIdentity._private.assertOperatorSession(operatorSession),
    validateStationScope: (stationCode, stationStatus) =>
      stationIdentity.validateOperatorScope(stationCode, stationStatus, operatorSession),
    creditSummary: () => request("GET", "/api/partner/credits"),
    stationSession: () => request("GET", "/api/partner/session"),
    enrolmentLocations: () => request("GET", "/api/partner/stations/enrolment-locations"),
    enrolmentStatus: (stationCode) => {
      if (typeof stationCode !== "string" || !stationCode) throw new Error("Station code is required");
      return request("GET", `/api/partner/stations/${encodeURIComponent(stationCode)}/enrolment-status`);
    },
    registerThisMac: (options) => registerThisMacWith(operatorSession, request, options),
  });
}

async function heartbeat(payload) {
  return signedJson("POST", "/api/partner/stations/heartbeat", payload);
}

module.exports = {
  creditSummary,
  creditPacks,
  creditCheckout,
  signIn,
  completeMfa,
  stationSession,
  enrolmentLocations,
  enrolmentStatus,
  selectLocation,
  registerThisMac,
  operatorSessionScope,
  heartbeat,
  _private: { cookieTokenFrom, baseUrl },
};
