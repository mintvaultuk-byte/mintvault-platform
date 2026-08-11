/**
 * Per-Mac cryptographic station identity.
 *
 * Private material and the short-lived operator session are encrypted by
 * Electron's macOS Keychain-backed safeStorage before touching disk. The file
 * contains ciphertext only; no `.env`, hostname or MAC address is an identity
 * or long-lived credential.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const IDENTITY_FILE = path.join(SUPPORT, "station-identity.enc.json");

function getSafeStorage() {
  let electron;
  try { electron = require("electron"); } catch { electron = null; }
  const safeStorage = electron && typeof electron === "object" ? electron.safeStorage : null;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) {
    throw new Error("macOS Keychain encryption is unavailable; station credentials are not permitted to fall back to plaintext storage");
  }
  return safeStorage;
}

function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  return crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
}

function freshIdentity() {
  const keys = crypto.generateKeyPairSync("ed25519");
  return {
    version: 1,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    installationId: crypto.randomUUID(),
    stationCode: null,
    stationStatus: null,
    operatorSession: null,
    requestNonce: 0,
  };
}

function assertIdentity(identity) {
  if (!identity || identity.version !== 1 || typeof identity.publicKeyPem !== "string" || typeof identity.privateKeyPem !== "string") {
    throw new Error("Stored station identity is invalid");
  }
  const publicKey = crypto.createPublicKey(identity.publicKeyPem);
  const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Stored station identity must be Ed25519");
  }
  if (!Number.isSafeInteger(identity.requestNonce) || identity.requestNonce < 0) {
    throw new Error("Stored station request nonce is invalid");
  }
  return identity;
}

function readIdentity() {
  if (!fs.existsSync(IDENTITY_FILE)) return null;
  const safeStorage = getSafeStorage();
  const envelope = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
  if (!envelope || envelope.version !== 1 || typeof envelope.ciphertext !== "string") throw new Error("Station identity envelope is invalid");
  return assertIdentity(JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64"))));
}

function writeIdentity(identity) {
  const safeStorage = getSafeStorage();
  assertIdentity(identity);
  fs.mkdirSync(SUPPORT, { recursive: true, mode: 0o700 });
  const encoded = JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(JSON.stringify(identity)).toString("base64") });
  const temporary = `${IDENTITY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, IDENTITY_FILE);
  fs.chmodSync(IDENTITY_FILE, 0o600);
}

function loadOrCreateIdentity() {
  const existing = readIdentity();
  if (existing) return existing;
  const identity = freshIdentity();
  writeIdentity(identity);
  return identity;
}

function installationFingerprint(identity) {
  assertIdentity(identity);
  // A random installation id plus the public key detects local state loss or
  // key cloning without pretending host/MAC metadata is a trust boundary.
  return crypto.createHash("sha256").update(`${identity.installationId}\n${publicKeyFingerprint(identity.publicKeyPem)}`).digest("hex");
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

function signRequest(identity, { method, path: requestPath, body }) {
  assertIdentity(identity);
  if (!identity.stationCode) throw new Error("This Mac is not approved as a MintVault station");
  const contentSha256 = crypto.createHash("sha256").update(body).digest("hex");
  const timestamp = Date.now();
  const nonce = identity.requestNonce + 1;
  const signature = crypto
    .sign(null, Buffer.from(canonicalRequest({ stationCode: identity.stationCode, method, path: requestPath, timestamp, nonce, contentSha256 })), crypto.createPrivateKey(identity.privateKeyPem))
    .toString("base64url");
  return {
    headers: {
      "x-mintvault-station-id": identity.stationCode,
      "x-mintvault-station-timestamp": String(timestamp),
      "x-mintvault-station-nonce": String(nonce),
      "x-mintvault-content-sha256": contentSha256,
      "x-mintvault-station-signature": signature,
      ...(identity.operatorSession ? { "x-mintvault-operator-session": identity.operatorSession } : {}),
    },
    nextNonce: nonce,
  };
}

function signStoredRequest({ method, path: requestPath, body }) {
  const identity = loadOrCreateIdentity();
  const signed = signRequest(identity, { method, path: requestPath, body });
  identity.requestNonce = signed.nextNonce;
  writeIdentity(identity); // persist before network I/O: never reuse after crash.
  return signed.headers;
}

function saveEnrollment({ stationCode, publicKeyFingerprint: expectedFingerprint, status = "PENDING" }) {
  if (typeof stationCode !== "string" || !/^MV-STN-[A-Z2-7]{10,24}$/.test(stationCode)) {
    throw new Error("Server returned an invalid station code");
  }
  const identity = loadOrCreateIdentity();
  if (expectedFingerprint && expectedFingerprint !== publicKeyFingerprint(identity.publicKeyPem)) {
    throw new Error("Station enrolment does not match this Mac's Keychain identity");
  }
  identity.stationCode = stationCode;
  identity.stationStatus = status;
  writeIdentity(identity);
  return { stationCode, status, publicKeyFingerprint: publicKeyFingerprint(identity.publicKeyPem) };
}

function setStationStatus(status) {
  if (!["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"].includes(status)) {
    throw new Error("Station status is invalid");
  }
  const identity = loadOrCreateIdentity();
  if (!identity.stationCode) throw new Error("This Mac is not enrolled as a MintVault station");
  identity.stationStatus = status;
  writeIdentity(identity);
}

function setOperatorSession(token) {
  if (token != null && (typeof token !== "string" || token.length < 20 || token.length > 512)) {
    throw new Error("Operator session is invalid");
  }
  const identity = loadOrCreateIdentity();
  identity.operatorSession = token || null;
  writeIdentity(identity);
}

function enrolmentPublicPayload(appVersion) {
  const identity = loadOrCreateIdentity();
  return {
    publicKeyPem: identity.publicKeyPem,
    publicKeyFingerprint: publicKeyFingerprint(identity.publicKeyPem),
    installationFingerprint: installationFingerprint(identity),
    appVersion,
  };
}

function readOperatorSession() {
  return readIdentity()?.operatorSession || null;
}

// These read-only helpers are deliberately fail-closed.  A non-Electron test
// process, an unavailable Keychain, or corrupt local state must never make an
// unregistered Mac look enrolled merely because an old .env exists.
function currentStationCode() {
  try {
    return readIdentity()?.stationCode || null;
  } catch {
    return null;
  }
}

function hasActiveStationSession() {
  try {
    const identity = readIdentity();
    return Boolean(identity?.stationCode && identity?.stationStatus === "ACTIVE" && identity?.operatorSession);
  } catch {
    return false;
  }
}

module.exports = {
  enrolmentPublicPayload,
  saveEnrollment,
  setStationStatus,
  setOperatorSession,
  signStoredRequest,
  currentStationCode,
  hasActiveStationSession,
  _private: { canonicalRequest, freshIdentity, installationFingerprint, publicKeyFingerprint, signRequest, readOperatorSession },
};
