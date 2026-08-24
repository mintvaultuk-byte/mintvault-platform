const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");
const MAIN = path.join(APP_ROOT, "main.js");
const APP_VERSION = require("../package.json").version;
const STATION_CODE = "MV-STN-N5YE3IBUGVMMQDIV";
const TENANT_ID = "377cd09f-d4c7-479b-adf2-e5eedbd3c79b";

function loadMainHarness({ initialPhase = "expired", requiresMfa = true, mfaSucceeds = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const heartbeatPayloads = [];
  let phase = initialPhase;
  let operatorAuthenticated = initialPhase === "active";
  let identityClearCount = 0;
  let requireMfaOnSignIn = requiresMfa;
  let mfaWillSucceed = mfaSucceeds;

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
      phase = requireMfaOnSignIn ? "mfa" : "active";
      operatorAuthenticated = !requireMfaOnSignIn;
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
      assert.equal(stationCode, STATION_CODE);
      return {
        ok: true,
        status: 200,
        body: {
          station: {
            stationCode: STATION_CODE,
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
      heartbeatPayloads.push(payload);
      return { ok: true, status: 200, body: { fixedProfileProvisioned: false } };
    },
  };

  const stationIdentity = {
    currentStationCode: () => STATION_CODE,
    hasActiveStationSession: () => operatorAuthenticated,
    setStationStatus(status) {
      calls.push(`station-status:${status}`);
    },
    clearOperatorSession() {
      identityClearCount += 1;
      operatorAuthenticated = false;
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
      adoptServerCaptureWindow() {},
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
  assert.deepEqual(await harness.handlers.get("get-version")(), { ok: true, version: "1.6.1" });
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
  assert.deepEqual(authCalls.slice(0, 5), [
    "complete-mfa",
    "heartbeat",
    "station-session",
    "credit-summary",
    "enrolment-status",
  ]);
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
  assert.ok(harness.calls.indexOf("heartbeat") < harness.calls.indexOf("station-session"));
});

test("session-expired recovery preserves station identity and returns to ACTIVE after sign-in", async () => {
  const harness = loadMainHarness({ initialPhase: "expired", requiresMfa: false });
  const expired = await harness.handlers.get("get-station-setup")();

  assert.equal(expired.ok, true);
  assert.equal(expired.stage, "session_expired");
  assert.equal(expired.environmentLabel, "STAGING");
  assert.equal(harness.identityClearCount(), 0);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 0);

  const recovered = await harness.handlers.get("station-sign-in")(null, {
    email: "owner@shop-games.test",
    password: "test-only-password",
  });
  assertActiveShopGames(recovered);
  assert.equal(harness.identityClearCount(), 0);
  assert.equal(harness.calls.filter((call) => call === "heartbeat").length, 1);
});
