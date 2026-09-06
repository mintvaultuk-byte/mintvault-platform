const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const identity = require("../lib/station-identity");

const IDENTITY_MODULE = require.resolve("../lib/station-identity");
const LIDE_MODULE = require.resolve("../lib/lide400-controller");
const SHOP_ZERO_STATION_CODE = "MV-STN-6DIISWMIEU2IKRG4";
const SHOP_GAMES_STATION_CODE = "MV-STN-N5YE3IBUGVMMQDIV";

function fakeSharedKeychainSafeStorage(wrappingKey) {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(envelope) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey, envelope.subarray(0, 12));
      decipher.setAuthTag(envelope.subarray(12, 28));
      return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

function compileModule(filename, fakes = {}) {
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (request) =>
    Object.hasOwn(fakes, request) ? fakes[request] : Module.prototype.require.call(loaded, request);
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return loaded.exports;
}

function withScansDir(scansDir, callback) {
  const previous = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = scansDir;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = previous;
  }
}

function loadIsolatedIdentity(scansDir, safeStorage) {
  return withScansDir(scansDir, () => compileModule(IDENTITY_MODULE, { electron: { safeStorage } }));
}

function loadIsolatedLide(scansDir) {
  return withScansDir(scansDir, () =>
    compileModule(LIDE_MODULE, {
      "./station-identity": { currentStationCode: () => null },
    })
  );
}

test("station request signature binds the station, method, path, body and monotonic nonce", () => {
  const fixture = identity._private.freshIdentity();
  fixture.stationCode = "MV-STN-ABCDEFGHIJKLMNOP";
  fixture.operatorSession = "operator-session-abcdefghijklmnopqrstuvwxyz";
  const signed = identity._private.signRequest(fixture, {
    method: "POST",
    path: "/api/partner/stations/heartbeat",
    body: Buffer.from('{"scannerConnected":true}'),
  });
  const request = identity._private.canonicalRequest({
    stationCode: fixture.stationCode,
    method: "POST",
    path: "/api/partner/stations/heartbeat",
    timestamp: Number(signed.headers["x-mintvault-station-timestamp"]),
    nonce: Number(signed.headers["x-mintvault-station-nonce"]),
    contentSha256: signed.headers["x-mintvault-content-sha256"],
  });
  assert.equal(crypto.verify(null, Buffer.from(request), fixture.publicKeyPem, Buffer.from(signed.headers["x-mintvault-station-signature"], "base64url")), true);
  assert.equal(signed.headers["x-mintvault-operator-session"], fixture.operatorSession);
  assert.equal(signed.nextNonce, 1);
});

test("station identity never derives trust from hostname or a caller-selected ID", () => {
  const fixture = identity._private.freshIdentity();
  assert.match(identity._private.publicKeyFingerprint(fixture.publicKeyPem), /^[a-f0-9]{64}$/);
  assert.match(identity._private.installationFingerprint(fixture), /^[a-f0-9]{64}$/);
  assert.equal(fixture.stationCode, null);
});

test("two Scanner profiles share one Keychain wrapping root without sharing station identity", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-station-isolation-"));
  const shopZeroDir = path.join(sandbox, "shop-zero");
  const shopGamesDir = path.join(sandbox, "shop-games");
  const safeStorage = fakeSharedKeychainSafeStorage(crypto.randomBytes(32));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const shopZero = loadIsolatedIdentity(shopZeroDir, safeStorage);
  const shopGames = loadIsolatedIdentity(shopGamesDir, safeStorage);
  const shopZeroPublic = shopZero.enrolmentPublicPayload("1.6.2");
  const shopGamesPublic = shopGames.enrolmentPublicPayload("1.6.2");

  shopZero.saveEnrollment({
    stationCode: SHOP_ZERO_STATION_CODE,
    publicKeyFingerprint: shopZeroPublic.publicKeyFingerprint,
    status: "ACTIVE",
  });
  shopGames.saveEnrollment({
    stationCode: SHOP_GAMES_STATION_CODE,
    publicKeyFingerprint: shopGamesPublic.publicKeyFingerprint,
    status: "ACTIVE",
  });
  shopZero.setOperatorSession("shop-zero-operator-session-test-only");
  shopGames.setOperatorSession("shop-games-operator-session-test-only");

  assert.notEqual(shopZeroPublic.publicKeyFingerprint, shopGamesPublic.publicKeyFingerprint);
  assert.notEqual(shopZeroPublic.installationFingerprint, shopGamesPublic.installationFingerprint);
  assert.equal(shopZero.currentStationCode(), SHOP_ZERO_STATION_CODE);
  assert.equal(shopGames.currentStationCode(), SHOP_GAMES_STATION_CODE);
  assert.equal(shopZero.hasActiveStationSession(), false, "restart/startup must validate the operator scope");
  assert.equal(shopGames.hasActiveStationSession(), false, "a stored token alone is never station authority");

  shopZero.validateOperatorScope(SHOP_ZERO_STATION_CODE, "ACTIVE", "shop-zero-operator-session-test-only");
  shopGames.validateOperatorScope(SHOP_GAMES_STATION_CODE, "ACTIVE", "shop-games-operator-session-test-only");
  assert.equal(shopZero.hasActiveStationSession(), true);
  assert.equal(shopGames.hasActiveStationSession(), true);
  assert.equal(
    shopZero.signStoredRequest({ method: "POST", path: "/shop-zero-proof", body: Buffer.from("{}") })[
      "x-mintvault-station-id"
    ],
    SHOP_ZERO_STATION_CODE
  );
  assert.equal(
    shopGames.signStoredRequest({ method: "POST", path: "/shop-games-proof", body: Buffer.from("{}") })[
      "x-mintvault-station-id"
    ],
    SHOP_GAMES_STATION_CODE
  );

  const shopZeroFile = path.join(shopZeroDir, "app-state", "station-identity.enc.json");
  const shopGamesFile = path.join(shopGamesDir, "app-state", "station-identity.enc.json");
  const shopZeroEnvelope = fs.readFileSync(shopZeroFile);
  const shopGamesEnvelope = fs.readFileSync(shopGamesFile);
  assert.notDeepEqual(shopZeroEnvelope, shopGamesEnvelope);
  assert.equal(shopZeroEnvelope.includes(Buffer.from(SHOP_ZERO_STATION_CODE)), false);
  assert.equal(shopGamesEnvelope.includes(Buffer.from(SHOP_GAMES_STATION_CODE)), false);

  const restartedShopZero = loadIsolatedIdentity(shopZeroDir, safeStorage);
  const restartedShopGames = loadIsolatedIdentity(shopGamesDir, safeStorage);
  assert.equal(restartedShopZero.currentStationCode(), SHOP_ZERO_STATION_CODE);
  assert.equal(restartedShopGames.currentStationCode(), SHOP_GAMES_STATION_CODE);
  assert.equal(restartedShopZero.hasActiveStationSession(), false);
  assert.equal(restartedShopGames.hasActiveStationSession(), false);

  restartedShopZero.validateOperatorScope(SHOP_ZERO_STATION_CODE, "ACTIVE", "shop-zero-operator-session-test-only");
  restartedShopGames.validateOperatorScope(SHOP_GAMES_STATION_CODE, "ACTIVE", "shop-games-operator-session-test-only");
  assert.throws(
    () =>
      restartedShopGames.validateOperatorScope(
        SHOP_ZERO_STATION_CODE,
        "ACTIVE",
        "shop-games-operator-session-test-only",
      ),
    /does not match the stored station identity/i
  );
  assert.equal(restartedShopGames.hasActiveStationSession(), false, "a wrong-tenant check closes authority");
  assert.throws(
    () =>
      restartedShopGames.saveEnrollment({
        stationCode: SHOP_ZERO_STATION_CODE,
        publicKeyFingerprint: shopGamesPublic.publicKeyFingerprint,
        status: "ACTIVE",
      }),
    /already enrolled as a different/i
  );
  assert.equal(restartedShopGames.currentStationCode(), SHOP_GAMES_STATION_CODE, "identity is never re-homed");

  restartedShopGames.clearOperatorSession();
  assert.equal(restartedShopGames.currentStationCode(), SHOP_GAMES_STATION_CODE, "sign-out preserves enrolment");
  assert.equal(restartedShopGames.hasActiveStationSession(), false);
  restartedShopGames.setOperatorSession("shop-games-new-mfa-session-test-only");
  assert.equal(restartedShopGames.hasActiveStationSession(), false, "MFA token replacement must revalidate scope");
  assert.throws(
    () =>
      restartedShopGames.saveEnrollment({
        stationCode: SHOP_GAMES_STATION_CODE,
        publicKeyFingerprint: shopGamesPublic.publicKeyFingerprint,
        status: "ACTIVE",
        expectedOperatorSession: "shop-games-old-session-test-only",
      }),
    (error) => error?.code === "OPERATOR_SESSION_CHANGED",
    "the identity write itself rejects an enrolment response authorised by an older token",
  );
  assert.throws(
    () =>
      restartedShopGames.validateOperatorScope(
        SHOP_GAMES_STATION_CODE,
        "ACTIVE",
        "shop-games-old-session-test-only",
      ),
    /does not match the stored station identity/i,
    "a status result from an older operator token cannot bless the replacement token",
  );
  restartedShopGames.validateOperatorScope(
    SHOP_GAMES_STATION_CODE,
    "ACTIVE",
    "shop-games-new-mfa-session-test-only",
  );
  assert.equal(restartedShopGames.hasActiveStationSession(), true);

  const concurrentShopGamesProcess = loadIsolatedIdentity(shopGamesDir, safeStorage);
  concurrentShopGamesProcess.setOperatorSession("shop-games-other-process-session-test-only");
  assert.equal(
    restartedShopGames.hasActiveStationSession(),
    false,
    "another process changing the profile session invalidates the first process's token-bound scope",
  );
  assert.throws(
    () => restartedShopGames.signStoredRequest({ method: "POST", path: "/stale-process", body: Buffer.from("{}") }),
    /has not been validated/i,
  );
  assert.equal(restartedShopZero.currentStationCode(), SHOP_ZERO_STATION_CODE);
});

test("isolated Shop Games profile cannot inherit Shop 0 placement configuration", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-placement-isolation-"));
  const shopZeroDir = path.join(sandbox, "shop-zero");
  const shopGamesDir = path.join(sandbox, "shop-games");
  const shopZeroConfig = path.join(shopZeroDir, "app-state", "station-config.env");
  const shopGamesConfig = path.join(shopGamesDir, "app-state", "station-config.env");
  fs.mkdirSync(path.dirname(shopZeroConfig), { recursive: true });
  fs.writeFileSync(shopZeroConfig, "MINTVAULT_LIDE_SCAN_X_MM=0\nMINTVAULT_LIDE_SCAN_Y_MM=167.01\n");

  const priorConfig = process.env.MINTVAULT_STATION_CONFIG_PATH;
  const priorX = process.env.MINTVAULT_LIDE_SCAN_X_MM;
  const priorY = process.env.MINTVAULT_LIDE_SCAN_Y_MM;
  delete process.env.MINTVAULT_STATION_CONFIG_PATH;
  delete process.env.MINTVAULT_LIDE_SCAN_X_MM;
  delete process.env.MINTVAULT_LIDE_SCAN_Y_MM;
  t.after(() => {
    if (priorConfig === undefined) delete process.env.MINTVAULT_STATION_CONFIG_PATH;
    else process.env.MINTVAULT_STATION_CONFIG_PATH = priorConfig;
    if (priorX === undefined) delete process.env.MINTVAULT_LIDE_SCAN_X_MM;
    else process.env.MINTVAULT_LIDE_SCAN_X_MM = priorX;
    if (priorY === undefined) delete process.env.MINTVAULT_LIDE_SCAN_Y_MM;
    else process.env.MINTVAULT_LIDE_SCAN_Y_MM = priorY;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const shopZeroLide = loadIsolatedLide(shopZeroDir);
  const shopGamesLide = loadIsolatedLide(shopGamesDir);
  assert.deepEqual(
    withScansDir(shopZeroDir, () => shopZeroLide._private.jigOrigin()),
    { x: 0, y: 167.01 }
  );
  assert.equal(
    withScansDir(shopGamesDir, () => shopGamesLide._private.jigOrigin()),
    null,
    "isolated profile has no cross-profile fallback"
  );

  fs.mkdirSync(path.dirname(shopGamesConfig), { recursive: true });
  fs.writeFileSync(shopGamesConfig, "MINTVAULT_LIDE_SCAN_X_MM=20\nMINTVAULT_LIDE_SCAN_Y_MM=20\n");
  const restartedShopGamesLide = loadIsolatedLide(shopGamesDir);
  assert.deepEqual(
    withScansDir(shopGamesDir, () => restartedShopGamesLide._private.jigOrigin()),
    { x: 20, y: 20 }
  );
  assert.deepEqual(
    withScansDir(shopZeroDir, () => shopZeroLide._private.jigOrigin()),
    { x: 0, y: 167.01 }
  );
});
