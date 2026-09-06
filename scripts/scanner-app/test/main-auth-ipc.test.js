const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");
const MAIN = path.join(APP_ROOT, "main.js");
const APP_VERSION = require("../package.json").version;
const STATION_CODE = "MV-STN-N5YE3IBUGVMMQDIV";
const SHOP_ZERO_STATION_CODE = "MV-STN-6DIISWMIEU2IKRG4";
const TENANT_ID = "377cd09f-d4c7-479b-adf2-e5eedbd3c79b";
const SHOP_ZERO_TENANT_ID = "shop-zero-tenant-id";

function loadMainHarness({
  initialPhase = "expired",
  requiresMfa = true,
  mfaSucceeds = true,
  identityStationCode = STATION_CODE,
  stationScopeMatches = true,
  reportedStationCode = identityStationCode,
  initialState = {},
} = {}) {
  const handlers = new Map();
  const calls = [];
  const heartbeatPayloads = [];
  let phase = initialPhase;
  let operatorAuthenticated = initialPhase === "active";
  let identityClearCount = 0;
  let requireMfaOnSignIn = requiresMfa;
  let mfaWillSucceed = mfaSucceeds;
  let operatorScopeValidated = false;
  let storedStationStatus = "ACTIVE";
  let operatorSessionGeneration = 1;
  let enrolmentStatusGate = null;

  const state = {
    state: "idle",
    activeCapture: null,
    openCardJob: null,
    lastError: null,
    availableCredits: null,
    boundTenantId: TENANT_ID,
    scannerHealth: {
      status: "ready",
      model: "CanoScan LiDE 400",
      deviceId: "shop-games-canon",
      profileVersion: "mintvault-canon-lide-400-v3",
    },
    ...initialState,
  };

  const stateMod = {
    load() {},
    get: () => state,
    set(update) {
      Object.assign(state, update);
    },
    setSetting(key, value) {
      state[key] = value;
    },
  };

  const stationClient = {
    async signIn() {
      calls.push("sign-in");
      operatorSessionGeneration += 1;
      phase = requireMfaOnSignIn ? "mfa" : "active";
      operatorAuthenticated = !requireMfaOnSignIn;
      operatorScopeValidated = false;
      return { ok: true, status: 200, body: { mfaRequired: requireMfaOnSignIn } };
    },
    async completeMfa() {
      calls.push("complete-mfa");
      if (!mfaWillSucceed) {
        return { ok: false, status: 401, body: { error: "Authentication code was not accepted" } };
      }
      phase = "active";
      operatorAuthenticated = true;
      return { ok: true, status: 200, body: { mfaPassed: true } };
    },
    async stationSession() {
      calls.push("station-session");
      if (phase === "expired") return { ok: false, status: 401, body: {} };
      if (phase === "mfa") return { ok: true, status: 200, body: { mfaRequired: true, mfaPassed: false } };
      return {
        ok: true,
        status: 200,
        body: {
          mfaPassed: true,
          tenantId: TENANT_ID,
          organisationName: "Shop Games",
          locationName: "Shop Games",
          displayName: "Shop Games Owner",
          permissions: ["partner.credits.view"],
        },
      };
    },
    async creditSummary() {
      calls.push("credit-summary");
      return { ok: true, status: 200, body: { summary: { availableCredits: 5 } } };
    },
    async enrolmentStatus(stationCode) {
      calls.push("enrolment-status");
      assert.equal(stationCode, identityStationCode);
      if (enrolmentStatusGate) {
        const gate = enrolmentStatusGate;
        enrolmentStatusGate = null;
        gate.entered();
        await gate.released;
      }
      if (!stationScopeMatches) {
        return { ok: false, status: 403, body: { error: { code: "forbidden" } } };
      }
      return {
        ok: true,
        status: 200,
        body: {
          station: {
            stationCode: reportedStationCode,
            status: "ACTIVE",
            calibrationStatus: "VALID",
            minimumSupportedVersion: APP_VERSION,
            acquisitionRegion: { xMm: 20, yMm: 20, widthMm: 100, heightMm: 130 },
          },
        },
      };
    },
    async heartbeat(payload) {
      calls.push("heartbeat");
      assert.equal(operatorScopeValidated, true, "heartbeat requires a validated operator/station pairing");
      heartbeatPayloads.push(payload);
      return { ok: true, status: 200, body: { fixedProfileProvisioned: false } };
    },
    operatorSessionScope() {
      const generation = operatorSessionGeneration;
      const assertCurrent = () => {
        if (generation !== operatorSessionGeneration) {
          const error = new Error("The signed-in operator session changed during station validation");
          error.code = "OPERATOR_SESSION_CHANGED";
          throw error;
        }
      };
      const request = (method) => async (...args) => {
        assertCurrent();
        const result = await stationClient[method](...args);
        assertCurrent();
        return result;
      };
      return Object.freeze({
        assertCurrent,
        stationSession: request("stationSession"),
        creditSummary: request("creditSummary"),
        enrolmentStatus: request("enrolmentStatus"),
        enrolmentLocations: request("enrolmentLocations"),
        registerThisMac: request("registerThisMac"),
        validateStationScope(stationCode, status) {
          assertCurrent();
          stationIdentity.validateOperatorScope(stationCode, status);
          assertCurrent();
        },
      });
    },
    async enrolmentLocations() {
      calls.push("enrolment-locations");
      return { ok: true, status: 200, body: { locations: [] } };
    },
    async registerThisMac() {
      calls.push("register-this-mac");
      return { ok: false, status: 403, body: { error: { code: "forbidden" } } };
    },
  };

  const stationIdentity = {
    currentStationCode: () => identityStationCode,
    hasActiveStationSession: () => operatorAuthenticated && operatorScopeValidated,
    setStationStatus(status) {
      calls.push(`station-status:${status}`);
      storedStationStatus = status;
      operatorScopeValidated = false;
    },
    validateOperatorScope(stationCode, status) {
      assert.equal(operatorAuthenticated, true);
      assert.equal(stationCode, identityStationCode);
      assert.equal(status, storedStationStatus);
      calls.push("operator-scope-validated");
      operatorScopeValidated = true;
    },
    invalidateOperatorScope() {
      calls.push("operator-scope-invalidated");
      operatorScopeValidated = false;
    },
    clearOperatorSession() {
      identityClearCount += 1;
      operatorAuthenticated = false;
      operatorScopeValidated = false;
    },
  };

  const appReadyNeverResolves = new Promise(() => {});
  const electron = {
    app: {
      dock: { hide() {} },
      requestSingleInstanceLock: () => true,
      disableHardwareAcceleration() {},
      on() {},
      whenReady: () => appReadyNeverResolves,
      quit() {},
      exit() {},
      setPath() {},
      getPath: () => path.join(APP_ROOT, ".test-profile"),
    },
    BrowserWindow: class {},
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    nativeImage: {},
    screen: {},
    shell: { openExternal() {}, openPath() {} },
    powerMonitor: { on() {} },
  };

  const fakes = {
    electron,
    "./lib/state": stateMod,
    "./lib/server-client": {},
    "./lib/watcher": { Watcher: class {} },
    "./lib/station-client": stationClient,
    "./lib/station-identity": stationIdentity,
    "./lib/environment": {
      resolveEnvironment: () => ({
        ok: true,
        environment: "staging",
        label: "STAGING",
        apiBase: "https://mintvault-v2.fly.dev",
      }),
      persistEnvironment: (value) => value,
    },
    "./lib/lide400-controller": {
      adoptServerCaptureWindow() {
        calls.push("adopt-server-capture-window");
      },
      _private: { jigOrigin: () => ({ xMm: 20, yMm: 20 }) },
    },
  };

  const loaded = new Module(MAIN, module);
  loaded.filename = MAIN;
  loaded.paths = Module._nodeModulePaths(APP_ROOT);
  loaded.require = (request) =>
    Object.hasOwn(fakes, request) ? fakes[request] : Module.prototype.require.call(loaded, request);

  const priorScansDir = process.env.MINTVAULT_SCANS_DIR;
  delete process.env.MINTVAULT_SCANS_DIR;
  try {
    loaded._compile(
      `${fs.readFileSync(MAIN, "utf8")}\nmodule.exports = { setupIpc, stationSetupState };\n`,
      MAIN,
    );
  } finally {
    if (priorScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = priorScansDir;
  }
  loaded.exports.setupIpc();

  return {
    calls,
    handlers,
    heartbeatPayloads,
    state,
    identityClearCount: () => identityClearCount,
    operatorScopeValidated: () => operatorScopeValidated,
    pauseNextEnrolmentStatus() {
      let signalEntered;
      let release;
      const entered = new Promise((resolve) => {
        signalEntered = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      enrolmentStatusGate = { entered: signalEntered, released };
      return { entered, release };
    },
    replaceOperatorSession() {
      operatorSessionGeneration += 1;
      operatorAuthenticated = true;
      operatorScopeValidated = false;
    },
    setMfaSuccess(value) {
      mfaWillSucceed = value;
    },
    setRequiresMfa(value) {
      requireMfaOnSignIn = value;
    },
  };
}

function assertActiveShopGames(result) {
  assert.equal(result.ok, true);
  assert.equal(result.stage, "active");
  assert.equal(result.environmentLabel, "STAGING");
  assert.equal(result.stationCode, STATION_CODE);
  assert.equal(result.calibrationStatus, "VALID");
  assert.equal(result.summary.organisationName, "Shop Games");
  assert.equal(result.summary.locationName, "Shop Games");
  assert.equal(result.summary.availableCredits, 5);
}

test("actual Scanner version IPC resolves the canonical package version", async () => {
  const harness = loadMainHarness();
  assert.deepEqual(await harness.handlers.get("get-version")(), { ok: true, version: "1.6.2" });
});

test("actual Scanner IPC completes sign-in, MFA, heartbeat, and authenticated status refresh", async () => {
  const harness = loadMainHarness({ initialPhase: "expired", requiresMfa: true });

  const before = await harness.handlers.get("get-station-setup")();
  assert.equal(before.stage, "session_expired");
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);

  const signedIn = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });
  assert.equal(signedIn.stage, "mfa");
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);

  const callStart = harness.calls.length;
  const authenticated = await harness.handlers.get("station-complete-mfa")(null, { code: "123456" });
  assertActiveShopGames(authenticated);
  assert.equal(harness.state.availableCredits, 5);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 1);

  const authCalls = harness.calls.slice(callStart);
  const heartbeatIndex = authCalls.indexOf("heartbeat");
  const statusIndexes = authCalls.reduce(
    (indexes, call, index) => (call === "enrolment-status" ? [...indexes, index] : indexes),
    []
  );
  const validationIndexes = authCalls.reduce(
    (indexes, call, index) => (call === "operator-scope-validated" ? [...indexes, index] : indexes),
    []
  );
  assert.equal(authCalls[0], "complete-mfa");
  assert.equal(statusIndexes.length, 2, "status is checked before and refreshed after heartbeat");
  assert.equal(
    validationIndexes.length,
    4,
    "each status read validates before and after the intervening credit request",
  );
  assert.ok(statusIndexes[0] < validationIndexes[0]);
  assert.ok(validationIndexes[0] < heartbeatIndex, "no heartbeat may precede operator/station validation");
  assert.ok(heartbeatIndex < statusIndexes[1], "authenticated status is refreshed after heartbeat");
  assert.deepEqual(harness.heartbeatPayloads, [
    {
      appVersion: APP_VERSION,
      scannerConnected: true,
      scannerHardware: {
        manufacturer: "Canon",
        model: "CanoScan LiDE 400",
        deviceId: "shop-games-canon",
      },
      scannerProfileVersion: "mintvault-canon-lide-400-v3",
      pendingUploadCount: 0,
      captureState: "idle",
    },
  ]);
});

test("failed MFA does not heartbeat or resolve authenticated Scanner state", async () => {
  const harness = loadMainHarness({ initialPhase: "mfa", mfaSucceeds: false });
  const result = await harness.handlers.get("station-complete-mfa")(null, { code: "000000" });

  assert.deepEqual(result, { ok: false, error: "Authentication code was not accepted" });
  assert.deepEqual(harness.calls, ["complete-mfa"]);
  assert.equal(harness.heartbeatPayloads.length, 0);
});

test("successful sign-in without MFA heartbeats once and resolves ACTIVE Shop Games state", async () => {
  const harness = loadMainHarness({ initialPhase: "expired", requiresMfa: false });
  const result = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });

  assertActiveShopGames(result);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 1);
  assert.ok(harness.calls.indexOf("enrolment-status") < harness.calls.indexOf("heartbeat"));
  assert.ok(harness.calls.indexOf("operator-scope-validated") < harness.calls.indexOf("heartbeat"));
});

test("wrong-tenant station identity fails closed before heartbeat, credit read, or local tenant reconciliation", async () => {
  const previousShopState = {
    boundTenantId: SHOP_ZERO_TENANT_ID,
    lastError: "shop-zero-forensic-marker",
    recent: [{ certId: "shop-zero-cert" }],
    openCardJob: null,
    activeCapture: null,
    availableCredits: 11,
  };
  const harness = loadMainHarness({
    initialPhase: "expired",
    requiresMfa: false,
    identityStationCode: SHOP_ZERO_STATION_CODE,
    stationScopeMatches: false,
    initialState: previousShopState,
  });

  const result = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, "identity_mismatch");
  assert.equal(result.stationCode, SHOP_ZERO_STATION_CODE);
  assert.equal(result.summary.organisationName, "Shop Games");
  assert.equal(result.summary.availableCredits, null);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);
  assert.equal(harness.calls.filter((call) => call === "credit-summary").length, 0);
  assert.equal(harness.calls.filter((call) => call === "operator-scope-validated").length, 0);
  assert.equal(harness.operatorScopeValidated(), false);
  assert.deepEqual(
    {
      boundTenantId: harness.state.boundTenantId,
      lastError: harness.state.lastError,
      recent: harness.state.recent,
      openCardJob: harness.state.openCardJob,
      activeCapture: harness.state.activeCapture,
      availableCredits: harness.state.availableCredits,
    },
    previousShopState,
    "a refused operator may neither rebind nor purge the station owner's local state"
  );
});

test("wrong-tenant station identity still fails closed after successful MFA", async () => {
  const previousShopState = {
    boundTenantId: SHOP_ZERO_TENANT_ID,
    lastError: "shop-zero-forensic-marker",
    recent: [{ certId: "shop-zero-cert" }],
    availableCredits: 11,
  };
  const harness = loadMainHarness({
    initialPhase: "expired",
    requiresMfa: true,
    identityStationCode: SHOP_ZERO_STATION_CODE,
    stationScopeMatches: false,
    initialState: previousShopState,
  });

  const signedIn = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });
  assert.equal(signedIn.stage, "mfa");

  const result = await harness.handlers.get("station-complete-mfa")(null, { code: "123456" });
  assert.equal(result.stage, "identity_mismatch");
  assert.equal(result.stationCode, SHOP_ZERO_STATION_CODE);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);
  assert.equal(harness.calls.filter((call) => call === "credit-summary").length, 0);
  assert.equal(harness.calls.filter((call) => call === "operator-scope-validated").length, 0);
  assert.equal(harness.calls.filter((call) => call === "adopt-server-capture-window").length, 0);
  assert.equal(harness.operatorScopeValidated(), false);
  assert.equal(harness.state.boundTenantId, SHOP_ZERO_TENANT_ID);
  assert.equal(harness.state.lastError, previousShopState.lastError);
  assert.deepEqual(harness.state.recent, previousShopState.recent);
  assert.equal(harness.state.availableCredits, previousShopState.availableCredits);
});

test("an in-flight status response cannot cross an operator-session generation", async () => {
  const previousShopState = {
    boundTenantId: SHOP_ZERO_TENANT_ID,
    lastError: "shop-zero-forensic-marker",
    recent: [{ certId: "shop-zero-cert" }],
    availableCredits: 11,
  };
  const harness = loadMainHarness({
    initialPhase: "active",
    identityStationCode: SHOP_ZERO_STATION_CODE,
    initialState: previousShopState,
  });
  const gate = harness.pauseNextEnrolmentStatus();
  const setupPromise = harness.handlers.get("get-station-setup")();

  await gate.entered;
  harness.replaceOperatorSession();
  gate.release();
  const result = await setupPromise;

  assert.equal(result.stage, "session_expired");
  assert.equal(result.environmentLabel, "STAGING");
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);
  assert.equal(harness.calls.filter((call) => call === "credit-summary").length, 0);
  assert.equal(harness.calls.filter((call) => call === "operator-scope-validated").length, 0);
  assert.equal(harness.calls.filter((call) => call.startsWith("station-status:")).length, 0);
  assert.equal(harness.calls.filter((call) => call === "adopt-server-capture-window").length, 0);
  assert.equal(harness.operatorScopeValidated(), false);
  assert.equal(harness.state.boundTenantId, SHOP_ZERO_TENANT_ID);
  assert.equal(harness.state.lastError, previousShopState.lastError);
  assert.deepEqual(harness.state.recent, previousShopState.recent);
  assert.equal(harness.state.availableCredits, previousShopState.availableCredits);
});

test("a stale setup cannot clear a newer session's validated station scope", async () => {
  const harness = loadMainHarness({ initialPhase: "active" });
  const gate = harness.pauseNextEnrolmentStatus();
  const staleSetup = harness.handlers.get("get-station-setup")();

  await gate.entered;
  harness.replaceOperatorSession();
  const currentSetup = await harness.handlers.get("get-station-setup")();
  assertActiveShopGames(currentSetup);
  assert.equal(harness.operatorScopeValidated(), true);

  gate.release();
  const staleResult = await staleSetup;
  assert.equal(staleResult.stage, "session_expired");
  assert.equal(harness.operatorScopeValidated(), true, "stale session A cannot revoke validated session B");
  assert.equal(harness.state.boundTenantId, TENANT_ID);
  assert.equal(harness.state.availableCredits, 5);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);
});

test("an inconsistent enrolment-status response cannot validate or re-home the loaded identity", async () => {
  const harness = loadMainHarness({
    initialPhase: "expired",
    requiresMfa: false,
    identityStationCode: SHOP_ZERO_STATION_CODE,
    reportedStationCode: STATION_CODE,
    initialState: { boundTenantId: SHOP_ZERO_TENANT_ID, availableCredits: 11 },
  });

  const result = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });

  assert.equal(result.stage, "identity_mismatch");
  assert.equal(result.stationCode, SHOP_ZERO_STATION_CODE);
  assert.equal(harness.state.boundTenantId, SHOP_ZERO_TENANT_ID);
  assert.equal(harness.state.availableCredits, 11);
  assert.equal(harness.calls.includes("heartbeat"), false);
  assert.equal(harness.calls.includes("credit-summary"), false);
  assert.equal(harness.calls.includes("station-status:ACTIVE"), false);
  assert.equal(harness.operatorScopeValidated(), false);
});

test("session-expired recovery preserves station identity and returns to ACTIVE after sign-in", async () => {
  const harness = loadMainHarness({ initialPhase: "expired", requiresMfa: false });
  const expired = await harness.handlers.get("get-station-setup")();

  assert.equal(expired.ok, true);
  assert.equal(expired.stage, "session_expired");
  assert.equal(expired.environmentLabel, "STAGING");
  assert.equal(harness.identityClearCount(), 0);
  assert.equal(harness.operatorScopeValidated(), false);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);

  const recovered = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });
  assertActiveShopGames(recovered);
  assert.equal(harness.identityClearCount(), 0);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 1);
});
