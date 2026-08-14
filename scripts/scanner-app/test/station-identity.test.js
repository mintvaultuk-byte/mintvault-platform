const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const identity = require("../lib/station-identity");

function fixtureIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    version: 1,
    installationId: crypto.randomUUID(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    requestNonce: 7,
  };
}

test("v1 canonical request is wire-compatible and binds every replay field", () => {
  assert.equal(identity._private.canonicalRequest({
    stationCode: "MV-STN-ABCDEFGHJK",
    method: "post",
    path: "/api/partner/stations/heartbeat",
    timestamp: 1_723_456_789_000,
    nonce: 42,
    contentSha256: "a".repeat(64),
  }), [
    "mintvault-station-request-v1",
    "MV-STN-ABCDEFGHJK",
    "POST",
    "/api/partner/stations/heartbeat",
    "1723456789000",
    "42",
    "a".repeat(64),
  ].join("\n"));
});

test("inactive v2 canonical request binds epochs, sequence and semantic operation", () => {
  assert.equal(identity._private.canonicalRequestV2({
    stationCode: "MV-STN-ABCDEFGHJK",
    credentialEpoch: 3,
    requestEpoch: 9,
    sequence: 17,
    method: "delete",
    path: "/api/partner/card-jobs/example",
    timestamp: 1_723_456_789_000,
    contentSha256: "b".repeat(64),
    semanticOperationId: "92C045A6-B737-4C44-8C71-6A75C1F62BD1",
  }), [
    "mintvault-station-request-v2",
    "MV-STN-ABCDEFGHJK",
    "3",
    "9",
    "17",
    "DELETE",
    "/api/partner/card-jobs/example",
    "1723456789000",
    "b".repeat(64),
    "92c045a6-b737-4c44-8c71-6a75c1f62bd1",
  ].join("\n"));
});

test("resync signatures have a separate domain", () => {
  assert.equal(identity._private.canonicalResyncChallenge({
    stationCode: "MV-STN-ABCDEFGHJK", challengeId: "challenge-1", challenge: "opaque-server-challenge",
  }), "mintvault-station-resync-v1\nMV-STN-ABCDEFGHJK\nchallenge-1\nopaque-server-challenge");
});

test("identity helper requires a strictly newer replay epoch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "native", "mv-identity-helper.swift"), "utf8");
  assert.match(source, /requestEpoch > envelope\.requestEpoch/);
  assert.doesNotMatch(source, /requestEpoch >= envelope\.requestEpoch/);
});

test("legacy migration accepts a matching Ed25519 pair and rejects substitution", () => {
  const fixture = fixtureIdentity();
  assert.equal(identity._private.assertLegacyIdentity(fixture), fixture);
  assert.match(identity._private.publicKeyFingerprint(fixture.publicKeyPem), /^[a-f0-9]{64}$/);
  assert.match(identity._private.installationFingerprint(fixture), /^[a-f0-9]{64}$/);

  const replacement = fixtureIdentity();
  assert.throws(() => identity._private.assertLegacyIdentity({
    ...fixture, privateKeyPem: replacement.privateKeyPem,
  }), /key pair does not match/);
});

test("Electron main delegates signing and never directly signs with migrated private material", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "station-identity.js"), "utf8");
  assert.doesNotMatch(source, /crypto\.sign\s*\(/);
  assert.match(source, /helper\.signRequestV1/);
  assert.match(source, /helper\.migrateV1/);
  assert.match(source, /fs\.unlinkSync\(LEGACY_IDENTITY_FILE\)/);
  assert.match(source, /OPERATOR_SESSION_FILE/);
});
