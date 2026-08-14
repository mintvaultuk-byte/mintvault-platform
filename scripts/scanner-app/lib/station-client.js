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
const { directFetch, boundedResponseText } = require("./http-safety");

let fetchPromise = null;
let refreshPromise = null;
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
  const raw = await boundedResponseText(response);
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function operatorAuthDenied(result) {
  const code = String(result?.body?.error?.code || result?.body?.error || "");
  return result?.status === 401 || (result?.status === 403 && code === "operator_scan_forbidden");
}

async function refreshStationSession({ force = false } = {}) {
  const credentials = stationIdentity._private.readOperatorCredentials();
  const refresh = credentials?.refresh;
  if (!credentials || !refresh) return { ok: false, status: 401, body: { error: "scanner_refresh_unavailable" } };
  if (Date.parse(refresh.expiresAt) <= Date.now()) {
    return { ok: false, status: 401, body: { error: "scanner_refresh_expired" } };
  }
  if (!force && credentials.accessExpiresAt && Date.parse(credentials.accessExpiresAt) > Date.now() + 60_000) {
    return { ok: true, status: 200, body: { unchanged: true } };
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const apiPath = "/api/partner/stations/session/refresh";
    const serialized = Buffer.from(JSON.stringify({ refreshToken: refresh.token }));
    const headers = stationIdentity.signStoredRequest({
      method: "POST",
      path: apiPath,
      body: serialized,
      includeOperatorSession: false,
    });
    const response = await directFetch(fetch, `${baseUrl()}${apiPath}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: serialized,
    });
    const body = await readJson(response);
    if (!response.ok) return { ok: false, status: response.status, body };
    const token = cookieTokenFrom(response);
    const session = body?.session;
    if (!token || session?.stationCode !== refresh.stationCode
        || !Number.isFinite(Date.parse(String(session?.accessExpiresAt || "")))
        || new Date(session.refreshExpiresAt).toISOString() !== refresh.expiresAt) {
      throw new Error("MintVault returned an invalid station-bound Scanner session");
    }
    stationIdentity.setOperatorAccessSession(token, session.accessExpiresAt);
    return { ok: true, status: response.status, body };
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function operatorJson(method, apiPath, payload, { background = false } = {}) {
  await refreshStationSession().catch(() => {});
  const fetch = await getFetch();
  const request = async () => {
    const operatorSession = stationIdentity._private.readOperatorSession();
    if (!operatorSession) throw new Error("Sign in to MintVault before using this station");
    const init = {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `mv.partner.sid=${encodeURIComponent(operatorSession)}`,
        ...(background ? { "x-mintvault-scanner-background": "v1" } : {}),
      },
    };
    if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(payload || {});
    const response = await directFetch(fetch, `${baseUrl()}${apiPath}`, init);
    return { ok: response.ok, status: response.status, body: await readJson(response) };
  };
  let result = await request();
  if (operatorAuthDenied(result) && stationIdentity._private.readOperatorRefreshSession()) {
    const refreshed = await refreshStationSession({ force: true });
    if (refreshed.ok) result = await request();
  }
  return result;
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
  await refreshStationSession().catch(() => {});
  const request = () => stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const serialized = Buffer.from(JSON.stringify(payload || {}));
    const headers = stationIdentity.signStoredRequest({ method, path: apiPath, body: serialized });
    const response = await directFetch(fetch, `${baseUrl()}${apiPath}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: serialized,
    });
    return stationAuthorityLatch.observe({ ok: response.ok, status: response.status, body: await readJson(response) });
  });
  let result = await request();
  if (operatorAuthDenied(result) && stationIdentity._private.readOperatorRefreshSession()) {
    const refreshed = await refreshStationSession({ force: true });
    if (refreshed.ok) result = await request();
  }
  return result;
}

async function signedJsonV2(method, apiPath, payload, semanticOperationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(semanticOperationId || ""))) {
    throw new Error("Signed station mutation needs a valid semantic operation ID");
  }
  await refreshStationSession().catch(() => {});
  const request = () => stationRequestQueue.run(async () => {
    const fetch = await getFetch();
    const serialized = Buffer.from(JSON.stringify(payload || {}));
    const headers = stationIdentity.signStoredRequestV2({
      method, path: apiPath, body: serialized, semanticOperationId,
    });
    const response = await directFetch(fetch, `${baseUrl()}${apiPath}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: serialized,
    });
    return stationAuthorityLatch.observe({ ok: response.ok, status: response.status, body: await readJson(response) });
  });
  let result = await request();
  if (operatorAuthDenied(result) && stationIdentity._private.readOperatorRefreshSession()) {
    const refreshed = await refreshStationSession({ force: true });
    if (refreshed.ok) result = await request();
  }
  return result;
}

async function signIn(email, password) {
  const fetch = await getFetch();
  const response = await directFetch(fetch, `${baseUrl()}/api/partner/auth/scanner-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(response);
  if (!response.ok) return { ok: false, status: response.status, body };
  const token = cookieTokenFrom(response);
  if (!token) return { ok: false, status: 500, body: { error: "MintVault sign-in did not issue an operator session" } };
  const lifetime = Number(body?.accessExpiresInSeconds);
  stationIdentity.setOperatorSession(
    token,
    Number.isSafeInteger(lifetime) && lifetime > 0 && lifetime <= 15 * 60
      ? new Date(Date.now() + lifetime * 1000).toISOString()
      : null,
  );
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
    const response = await directFetch(fetchImpl, `${origin}/api/partner/auth/logout`, {
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
  const credentials = stationIdentity._private.readOperatorCredentials();
  const token = credentials?.token || null;
  const refresh = credentials?.refresh || null;
  stationIdentity.clearOperatorSession();
  let fetch;
  try { fetch = await getFetch(); }
  catch { return { ok: true, remoteRevoked: false }; }
  let stationRevoked = false;
  if (refresh) {
    try {
      const apiPath = "/api/partner/stations/session/logout";
      const serialized = Buffer.from(JSON.stringify({ refreshToken: refresh.token }));
      const result = await stationRequestQueue.run(async () => {
        const headers = stationIdentity.signStoredRequest({
          method: "POST", path: apiPath, body: serialized, includeOperatorSession: false,
        });
        const response = await directFetch(fetch, `${baseUrl()}${apiPath}`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" }, body: serialized,
        });
        return response.ok;
      });
      stationRevoked = result === true;
    } catch { /* local lock is already complete */ }
  }
  const ordinary = await signOutWith({
    token,
    clearSession: () => {},
    fetchImpl: fetch,
    origin: baseUrl(),
  });
  return { ok: true, remoteRevoked: stationRevoked || ordinary.remoteRevoked };
}

async function stationSession() {
  return operatorJson("GET", "/api/partner/session", undefined, { background: true });
}

async function enrolmentLocations() {
  return operatorJson("GET", "/api/partner/stations/enrolment-locations");
}

async function enrolmentStatus(stationCode) {
  if (typeof stationCode !== "string" || !stationCode) throw new Error("Station code is required");
  return operatorJson("GET", `/api/partner/stations/${encodeURIComponent(stationCode)}/enrolment-status`, undefined, { background: true });
}

async function ensureScannerSessionBound(stationCode) {
  const current = stationIdentity._private.readOperatorRefreshSession();
  if (current?.stationCode === stationCode && Date.parse(current.expiresAt) > Date.now()) {
    return { ok: true, status: 200, body: { unchanged: true } };
  }
  const result = await signedJson("POST", "/api/partner/stations/session/bind", {});
  const session = result.body?.session;
  if (!result.ok || session?.stationCode !== stationCode || typeof session?.refreshToken !== "string") return result;
  stationIdentity.setOperatorRefreshSession({
    stationCode,
    refreshToken: session.refreshToken,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
  });
  return result;
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

async function resyncReplayState() {
  const stationCode = stationIdentity.currentStationCode();
  if (!stationCode) throw new Error("Station identity is unavailable for replay recovery");
  const issued = await operatorJson("POST", "/api/partner/stations/replay-resync/challenge", { stationCode });
  const challenge = issued.body?.challenge;
  if (!issued.ok || challenge?.stationCode !== stationCode || typeof challenge?.challengeId !== "string"
      || typeof challenge?.challenge !== "string") {
    return { ok: false, status: issued.status, body: issued.body };
  }
  const proof = stationIdentity.signResyncChallenge({
    stationCode,
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
  });
  const completed = await operatorJson("POST", "/api/partner/stations/replay-resync/complete", {
    stationCode,
    challengeId: proof.challengeId,
    signature: proof.signature,
  });
  const state = completed.body?.replayState;
  if (!completed.ok || state?.stationCode !== stationCode || !Number.isSafeInteger(state?.credentialEpoch)
      || !Number.isSafeInteger(state?.requestEpoch) || !Number.isSafeInteger(state?.requestSequence)) {
    return { ok: false, status: completed.status, body: completed.body };
  }
  stationIdentity.applyReplayState(state);
  stationAuthorityLatch.clearAfterResync();
  return { ok: true, status: completed.status, body: completed.body };
}

module.exports = {
  creditSummary,
  signIn,
  completeMfa,
  signOut,
  stationSession,
  enrolmentLocations,
  enrolmentStatus,
  ensureScannerSessionBound,
  selectLocation,
  registerThisMac,
  heartbeat,
  saveCalibration,
  resyncReplayState,
  _private: {
    cookieTokenFrom,
    baseUrl,
    signOutWith,
    signedJsonV2,
    operatorAuthDenied,
    refreshStationSession,
  },
};
