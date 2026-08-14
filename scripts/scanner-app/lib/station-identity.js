/**
 * Device-bound station identity facade.
 *
 * Ed25519 private material is generated, Secure-Enclave-wrapped, persisted in
 * a device-only Keychain item, unwrapped and used only by mv-identity-helper.
 * Electron main receives public metadata and signatures. Human sessions live
 * in a separate safeStorage envelope and are never sent to the helper.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const helper = require("./identity-helper-client");

const SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const LEGACY_IDENTITY_FILE = path.join(SUPPORT, "station-identity.enc.json");
const OPERATOR_SESSION_FILE = path.join(SUPPORT, "operator-session.enc.json");

function getSafeStorage() {
  let electron;
  try { electron = require("electron"); } catch { electron = null; }
  const safeStorage = electron && typeof electron === "object" ? electron.safeStorage : null;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) {
    throw new Error("macOS Keychain encryption is unavailable; operator sessions cannot be persisted");
  }
  return safeStorage;
}

function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Station public key must be Ed25519");
  return crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
}

function installationFingerprint(identity) {
  if (!identity || typeof identity.installationId !== "string" || typeof identity.publicKeyPem !== "string") {
    throw new Error("Station public identity is invalid");
  }
  return crypto.createHash("sha256")
    .update(`${identity.installationId}\n${publicKeyFingerprint(identity.publicKeyPem)}`)
    .digest("hex");
}

function canonicalRequest({ stationCode, method, path: requestPath, timestamp, nonce, contentSha256 }) {
  return [
    "mintvault-station-request-v1",
    stationCode,
    String(method).toUpperCase(),
    requestPath,
    String(timestamp),
    String(nonce),
    contentSha256,
  ].join("\n");
}

function canonicalRequestV2({
  stationCode,
  credentialEpoch,
  requestEpoch,
  sequence,
  method,
  path: requestPath,
  timestamp,
  contentSha256,
  semanticOperationId,
}) {
  return [
    "mintvault-station-request-v2",
    stationCode,
    String(credentialEpoch),
    String(requestEpoch),
    String(sequence),
    String(method).toUpperCase(),
    requestPath,
    String(timestamp),
    contentSha256,
    String(semanticOperationId).toLowerCase(),
  ].join("\n");
}

function canonicalResyncChallenge({ stationCode, challengeId, challenge }) {
  return ["mintvault-station-resync-v1", stationCode, challengeId, challenge].join("\n");
}

function assertLegacyIdentity(identity) {
  if (!identity || identity.version !== 1 || typeof identity.publicKeyPem !== "string" || typeof identity.privateKeyPem !== "string") {
    throw new Error("Legacy station identity is invalid; identity recovery is required");
  }
  const publicKey = crypto.createPublicKey(identity.publicKeyPem);
  const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Legacy station identity is not Ed25519; identity recovery is required");
  }
  if (!Number.isSafeInteger(identity.requestNonce) || identity.requestNonce < 0) {
    throw new Error("Legacy station replay state is invalid; identity recovery is required");
  }
  if (publicKeyFingerprint(identity.publicKeyPem) !== publicKeyFingerprint(crypto.createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString())) {
    throw new Error("Legacy station key pair does not match; identity recovery is required");
  }
  return identity;
}

function readLegacyIdentity() {
  if (!fs.existsSync(LEGACY_IDENTITY_FILE)) return null;
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(LEGACY_IDENTITY_FILE, "utf8")); }
  catch { throw new Error("Legacy station identity is corrupt; identity recovery is required"); }
  if (!envelope || envelope.version !== 1 || typeof envelope.ciphertext !== "string") {
    throw new Error("Legacy station identity envelope is invalid; identity recovery is required");
  }
  const decoded = getSafeStorage().decryptString(Buffer.from(envelope.ciphertext, "base64"));
  return assertLegacyIdentity(JSON.parse(decoded));
}

function readOperatorSession() {
  if (!fs.existsSync(OPERATOR_SESSION_FILE)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(OPERATOR_SESSION_FILE, "utf8"));
    if (!envelope || envelope.version !== 1 || typeof envelope.ciphertext !== "string") return null;
    const payload = JSON.parse(getSafeStorage().decryptString(Buffer.from(envelope.ciphertext, "base64")));
    return typeof payload.token === "string" && payload.token.length >= 20 ? payload.token : null;
  } catch {
    return null;
  }
}

function setOperatorSession(token) {
  if (token != null && (typeof token !== "string" || token.length < 20 || token.length > 2048)) {
    throw new Error("Operator session is invalid");
  }
  if (!token) {
    try { fs.unlinkSync(OPERATOR_SESSION_FILE); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return;
  }
  const safeStorage = getSafeStorage();
  fs.mkdirSync(SUPPORT, { recursive: true, mode: 0o700 });
  const ciphertext = safeStorage.encryptString(JSON.stringify({ version: 1, token })).toString("base64");
  const temporary = `${OPERATOR_SESSION_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, ciphertext }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, OPERATOR_SESSION_FILE);
  fs.chmodSync(OPERATOR_SESSION_FILE, 0o600);
}

/** Signing out a person never changes this Mac's enrolled station identity. */
function clearOperatorSession() {
  setOperatorSession(null);
}

function proveMigration(result, publicKeyPem, challenge) {
  if (result.publicKeyFingerprint !== publicKeyFingerprint(publicKeyPem)) {
    throw new Error("Legacy and device-bound station identities do not match; identity recovery is required");
  }
  const verified = crypto.verify(
    null,
    Buffer.from(`mintvault-identity-proof-v1\n${challenge}`),
    publicKeyPem,
    Buffer.from(String(result.proofSignature || ""), "base64url")
  );
  if (!verified) throw new Error("Device-bound identity migration proof failed; identity recovery is required");
}

function migrateLegacyIdentityIfPresent() {
  const legacy = readLegacyIdentity();
  if (!legacy) return helper.status();
  const privateJwk = crypto.createPrivateKey(legacy.privateKeyPem).export({ format: "jwk" });
  if (!privateJwk.d) throw new Error("Legacy private key cannot be migrated; identity recovery is required");
  const challenge = crypto.randomBytes(32).toString("base64url");
  const result = helper.migrateV1({
    privateKeyRaw: privateJwk.d,
    publicKeyPem: legacy.publicKeyPem,
    installationId: legacy.installationId,
    stationCode: legacy.stationCode || null,
    stationStatus: legacy.stationStatus || null,
    requestNonce: legacy.requestNonce,
    proofChallenge: challenge,
  });
  proveMigration(result, legacy.publicKeyPem, challenge);
  if (legacy.operatorSession) setOperatorSession(legacy.operatorSession);
  fs.unlinkSync(LEGACY_IDENTITY_FILE);
  return result;
}

function publicIdentity({ allowCreate = false } = {}) {
  const current = migrateLegacyIdentityIfPresent();
  if (current.state === "READY_V2") return current;
  if (current.state === "ABSENT_NEW" && allowCreate) return helper.create();
  throw new Error("Station identity is absent; explicit new-station enrolment is required");
}

function enrolmentPublicPayload(appVersion) {
  // This call is reached only from the operator's explicit Register This Mac
  // action. Read-only status and ordinary request paths never create a key.
  const identity = publicIdentity({ allowCreate: true });
  return {
    publicKeyPem: identity.publicKeyPem,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    installationFingerprint: installationFingerprint(identity),
    identitySchemaVersion: identity.schemaVersion,
    appVersion,
  };
}

function saveEnrollment({ stationCode, publicKeyFingerprint: expectedFingerprint, status = "PENDING" }) {
  return helper.bindStation({ stationCode, expectedFingerprint, stationStatus: status });
}

function setStationStatus(status) {
  if (!["PENDING", "ACTIVE", "SUSPENDED", "REVOKED", "REJECTED"].includes(status)) {
    throw new Error("Station status is invalid");
  }
  return helper.setStatus(status);
}

function signStoredRequest({ method, path: requestPath, body }) {
  const contentSha256 = crypto.createHash("sha256").update(body).digest("hex");
  const signed = helper.signRequestV1({ method, path: requestPath, timestamp: Date.now(), contentSha256 });
  const operatorSession = readOperatorSession();
  return {
    "x-mintvault-station-id": signed.stationCode,
    "x-mintvault-station-timestamp": String(signed.timestamp),
    "x-mintvault-station-nonce": String(signed.nonce),
    "x-mintvault-content-sha256": signed.contentSha256,
    "x-mintvault-station-signature": signed.signature,
    ...(operatorSession ? { "x-mintvault-operator-session": operatorSession } : {}),
  };
}

function signStoredRequestV2({ method, path: requestPath, body, semanticOperationId }) {
  const contentSha256 = crypto.createHash("sha256").update(body).digest("hex");
  const signed = helper.signRequestV2({
    method, path: requestPath, timestamp: Date.now(), contentSha256, semanticOperationId,
  });
  const operatorSession = readOperatorSession();
  return {
    "x-mintvault-station-id": signed.stationCode,
    "x-mintvault-station-protocol": "2",
    "x-mintvault-station-credential-epoch": String(signed.credentialEpoch),
    "x-mintvault-station-request-epoch": String(signed.requestEpoch),
    "x-mintvault-station-sequence": String(signed.sequence),
    "x-mintvault-station-timestamp": String(signed.timestamp),
    "x-mintvault-content-sha256": signed.contentSha256,
    "x-mintvault-semantic-operation-id": signed.semanticOperationId,
    "x-mintvault-station-signature": signed.signature,
    ...(operatorSession ? { "x-mintvault-operator-session": operatorSession } : {}),
  };
}

function signResyncChallenge(payload) {
  return helper.signResyncChallenge(payload);
}

function applyReplayState(payload) {
  return helper.applyReplayState(payload);
}

function retireIdentity(expectedFingerprint) {
  const result = helper.retire(expectedFingerprint);
  clearOperatorSession();
  return result;
}

function currentStationCode() {
  try { return migrateLegacyIdentityIfPresent()?.stationCode || null; }
  catch { return null; }
}

function identityStatus() {
  try { return migrateLegacyIdentityIfPresent(); }
  catch (error) {
    const knownStates = new Set(["LOCKED", "NAMESPACE_MISMATCH", "CORRUPT", "IDENTITY_RECOVERY_REQUIRED"]);
    const state = knownStates.has(error?.code) ? error.code : "IDENTITY_RECOVERY_REQUIRED";
    return { state, error: error.message };
  }
}

function hasActiveStationSession() {
  const identity = identityStatus();
  return Boolean(identity.stationCode && identity.stationStatus === "ACTIVE" && readOperatorSession());
}

module.exports = {
  enrolmentPublicPayload,
  saveEnrollment,
  setStationStatus,
  setOperatorSession,
  clearOperatorSession,
  signStoredRequest,
  signStoredRequestV2,
  signResyncChallenge,
  applyReplayState,
  retireIdentity,
  identityStatus,
  currentStationCode,
  hasActiveStationSession,
  _private: {
    canonicalRequest,
    canonicalRequestV2,
    canonicalResyncChallenge,
    installationFingerprint,
    publicKeyFingerprint,
    readOperatorSession,
    assertLegacyIdentity,
    proveMigration,
  },
};
