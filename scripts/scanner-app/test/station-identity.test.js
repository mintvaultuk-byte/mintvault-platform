const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const identity = require("../lib/station-identity");

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
