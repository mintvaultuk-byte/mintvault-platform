const crypto = require("node:crypto");
const semanticOperations = require("./semantic-operations");

function assertPayload(payload) {
  if (!payload || typeof payload !== "object" ||
      typeof payload.publicKeyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.publicKeyFingerprint) ||
      typeof payload.publicKeyPem !== "string" || !/^[a-f0-9]{64}$/.test(String(payload.installationFingerprint || ""))
      || payload.identitySchemaVersion !== 2 || !/^\d+\.\d+\.\d+$/.test(String(payload.appVersion || ""))) {
    throw new Error("Station enrolment identity payload is invalid");
  }
  let key;
  try { key = crypto.createPublicKey(payload.publicKeyPem); }
  catch { throw new Error("Station enrolment public key is invalid"); }
  const fingerprint = crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
  if (key.asymmetricKeyType !== "ed25519" || fingerprint !== payload.publicKeyFingerprint) {
    throw new Error("Station enrolment public key does not match its fingerprint");
  }
  return payload;
}

function createCoordinator(store = semanticOperations) {
  return Object.freeze({
    beginOrResume(livePayload) {
      const current = assertPayload(livePayload);
      const pending = store.pending("STATION_ENROLMENT");
      if (pending) {
        if (["publicKeyFingerprint", "publicKeyPem", "installationFingerprint", "identitySchemaVersion"]
          .some((field) => pending.payload[field] !== current[field])) {
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
