const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const path = require("node:path");
const { _private } = require("../lib/station-client");

const CLIENT_MODULE = require.resolve("../lib/station-client");
const SHOP_ZERO_STATION_CODE = "MV-STN-6DIISWMIEU2IKRG4";

function compileClient(fakes) {
  const loaded = new Module(CLIENT_MODULE, module);
  loaded.filename = CLIENT_MODULE;
  loaded.paths = Module._nodeModulePaths(path.dirname(CLIENT_MODULE));
  loaded.require = (request) =>
    Object.hasOwn(fakes, request) ? fakes[request] : Module.prototype.require.call(loaded, request);
  loaded._compile(fs.readFileSync(CLIENT_MODULE, "utf8"), CLIENT_MODULE);
  return loaded.exports;
}

function changedSessionError() {
  const error = new Error("The signed-in operator session changed during station validation");
  error.code = "OPERATOR_SESSION_CHANGED";
  return error;
}

test("station client extracts only the Partner session cookie", () => {
  const response = { headers: { get: () => "other=x; Path=/, mv.partner.sid=opaque-token_123; HttpOnly; Path=/" } };
  assert.equal(_private.cookieTokenFrom(response), "opaque-token_123");
  assert.equal(_private.cookieTokenFrom({ headers: { get: () => "other=x" } }), null);
});

test("an operator-session scope rejects a response when its token changes in flight", async (t) => {
  let currentToken = "operator-session-a-test-only-1234567890";
  let signalEntered;
  let releaseResponse;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const released = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, `/api/partner/stations/${SHOP_ZERO_STATION_CODE}/enrolment-status`);
    assert.equal(request.headers.cookie, `mv.partner.sid=${encodeURIComponent("operator-session-a-test-only-1234567890")}`);
    signalEntered();
    await released;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ station: { stationCode: SHOP_ZERO_STATION_CODE, status: "ACTIVE" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const stationIdentity = {
    _private: {
      readOperatorSession: () => currentToken,
      assertOperatorSession(expected) {
        if (!expected || expected !== currentToken) throw changedSessionError();
      },
    },
    validateOperatorScope(_stationCode, _stationStatus, expected) {
      if (!expected || expected !== currentToken) throw changedSessionError();
    },
  };
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = compileClient({
    "./station-identity": stationIdentity,
    "./server-client": { API_BASE: `http://127.0.0.1:${address.port}` },
  });
  const scope = client.operatorSessionScope();
  const status = scope.enrolmentStatus(SHOP_ZERO_STATION_CODE);

  await entered;
  currentToken = "operator-session-b-test-only-0987654321";
  releaseResponse();

  await assert.rejects(status, (error) => error?.code === "OPERATOR_SESSION_CHANGED");
  assert.throws(
    () => scope.validateStationScope(SHOP_ZERO_STATION_CODE, "ACTIVE"),
    (error) => error?.code === "OPERATOR_SESSION_CHANGED",
  );
});

test("registration cannot persist after the response token is replaced", async (t) => {
  const tokenA = "operator-session-a-test-only-1234567890";
  const tokenB = "operator-session-b-test-only-0987654321";
  let currentToken = tokenA;
  let assertionCount = 0;
  const saved = [];
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/partner/stations/enrol");
    assert.equal(request.headers.cookie, `mv.partner.sid=${encodeURIComponent(tokenA)}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ station: { stationCode: SHOP_ZERO_STATION_CODE, status: "PENDING" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const stationIdentity = {
    _private: {
      readOperatorSession: () => currentToken,
      assertOperatorSession(expected) {
        assertionCount += 1;
        if (!expected || expected !== currentToken) throw changedSessionError();
        if (assertionCount === 3) queueMicrotask(() => {
          currentToken = tokenB;
        });
      },
    },
    enrolmentPublicPayload: () => ({
      publicKeyPem: "test-only-public-key",
      publicKeyFingerprint: "test-only-public-key-fingerprint",
      installationFingerprint: "test-only-installation-fingerprint",
      appVersion: "1.6.2",
    }),
    saveEnrollment(enrolment) {
      saved.push({ ...enrolment, tokenAtSave: currentToken });
    },
  };
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = compileClient({
    "./station-identity": stationIdentity,
    "./server-client": { API_BASE: `http://127.0.0.1:${address.port}` },
  });

  await assert.rejects(
    client.registerThisMac({ locationId: "shop-zero-location", appVersion: "1.6.2" }),
    (error) => error?.code === "OPERATOR_SESSION_CHANGED",
  );
  assert.equal(currentToken, tokenB);
  assert.deepEqual(saved, [], "session A's enrolment response cannot be persisted under session B");
});
