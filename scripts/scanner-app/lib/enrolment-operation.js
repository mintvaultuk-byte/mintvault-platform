const crypto = require("node:crypto");
const semanticOperations = require("./semantic-operations");

function assertPayload(payload) {
  if (!payload || typeof payload !== "object" ||
      typeof payload.publicKeyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.publicKeyFingerprint) ||
      typeof payload.publicKeyPem !== "string" || typeof payload.installationFingerprint !== "string") {
    throw new Error("Station enrolment identity payload is invalid");
  }
  return payload;
}

function createCoordinator(store = semanticOperations) {
  return Object.freeze({
    beginOrResume(livePayload) {
      const current = assertPayload(livePayload);
      const pending = store.pending("STATION_ENROLMENT");
      if (pending) {
        if (pending.payload.publicKeyFingerprint !== current.publicKeyFingerprint) {
          const error = new Error("Pending station enrolment belongs to a different device identity");
          error.code = "IDENTITY_RECOVERY_REQUIRED";
          throw error;
        }
        return pending;
      }
      return store.begin({
        key: `station-enrolment:${current.publicKeyFingerprint}:${crypto.randomUUID()}`,
        type: "STATION_ENROLMENT",
        payload: current,
      });
    },
    complete(operation, resultReference) {
      return store.complete(operation.id, resultReference);
    },
  });
}

const sharedCoordinator = createCoordinator();
module.exports = Object.freeze({
  beginOrResume: sharedCoordinator.beginOrResume,
  complete: sharedCoordinator.complete,
  _private: { createCoordinator, assertPayload },
});
