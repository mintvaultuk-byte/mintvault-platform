const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const semanticOperations = require("../lib/semantic-operations");
const { _private } = require("../lib/enrolment-operation");

function payload(overrides = {}) {
  return {
    publicKeyFingerprint: "a".repeat(64),
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n",
    installationFingerprint: "b".repeat(64),
    installationId: "install-1",
    identitySchemaVersion: 2,
    locationId: "location-a",
    appVersion: "1.2.1",
    ...overrides,
  };
}

test("enrolment resumes exact stored payload across upgrade and UI drift", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-enrolment-operation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "operations.json");
  const first = _private.createCoordinator(semanticOperations._private.createStore(file));
  const operation = first.beginOrResume(payload());

  const restarted = _private.createCoordinator(semanticOperations._private.createStore(file));
  const replay = restarted.beginOrResume(payload({ appVersion: "2.0.0", locationId: "location-b" }));
  assert.equal(replay.id, operation.id);
  assert.equal(replay.payload.appVersion, "1.2.1");
  assert.equal(replay.payload.locationId, "location-a");

  assert.throws(() => restarted.beginOrResume(payload({ publicKeyFingerprint: "c".repeat(64) })), {
    code: "IDENTITY_RECOVERY_REQUIRED",
  });
  // Only an authoritative successful station result closes the attempt before
  // the final P14 server adds a durable terminal-refusal protocol.
  restarted.complete(replay, "station:MV-STN-ABCDEFGHJK");
  const corrected = restarted.beginOrResume(payload({ locationId: "location-b" }));
  assert.notEqual(corrected.id, operation.id);
  assert.equal(corrected.payload.locationId, "location-b");
});
