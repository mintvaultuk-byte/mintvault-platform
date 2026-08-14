/**
 * Device-bound cache of the server-accepted current capture profile.
 *
 * The server remains authoritative and immutable history remains server-side.
 * This file only lets the packaged Scanner recover the exact accepted jig
 * geometry without a mutable environment file. Its AES key is wrapped by the
 * station identity helper, so copied/tampered Application Support cannot alter
 * the physical acquisition region or become station authority on another Mac.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const stationIdentity = require("./station-identity");
const runtimePaths = require("./runtime-paths");

const SCHEMA_VERSION = 1;
const PROFILE_FILENAME = "locked-scanner-profile.v1.json";
const PENDING_PROFILE_FILENAME = "pending-scanner-profile.v1.json";
const MAX_ENVELOPE_BYTES = 1024 * 1024;
function configureRuntime({ isPackaged }) {
  if (typeof isPackaged !== "boolean") throw new Error("Scanner package state is unavailable");
  runtimePaths.configureRuntime({ isPackaged });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function boundedText(value, field, max = 200) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > max || Array.from(clean).some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${field} is invalid`);
  }
  return clean;
}

function nullableText(value, field, max = 200) {
  if (value == null || value === "") return null;
  return boundedText(value, field, max);
}

function finiteRegion(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const out = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 400) throw new Error(`${field}.${key} is invalid`);
    out[key] = Number(number.toFixed(3));
  }
  if (out.width <= 0 || out.height <= 0) throw new Error(`${field} dimensions are invalid`);
  return Object.freeze(out);
}

function finiteMargins(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const out = {};
  for (const key of ["left", "right", "top", "bottom"]) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error(`${field}.${key} is invalid`);
    out[key] = Number(number.toFixed(3));
  }
  return Object.freeze(out);
}

function scannerHardware(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scannerHardware is invalid");
  const hardware = Object.freeze({
    manufacturer: nullableText(value.manufacturer, "scannerHardware.manufacturer") || "Canon",
    model: boundedText(value.model, "scannerHardware.model"),
    deviceId: nullableText(value.deviceId, "scannerHardware.deviceId"),
    serial: nullableText(value.serial, "scannerHardware.serial"),
  });
  if (!hardware.deviceId && !hardware.serial) throw new Error("scannerHardware needs a device ID or serial");
  return hardware;
}

function capabilityProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("capabilityProof is invalid");
  const proof = {
    sha256: boundedText(value.sha256, "capabilityProof.sha256", 64).toLowerCase(),
    sizeBytes: Number(value.sizeBytes),
    format: boundedText(value.format, "capabilityProof.format", 16).toUpperCase(),
    requestedDpi: Number(value.requestedDpi),
    driverResolutionDpi: Number(value.driverResolutionDpi),
    colourMode: boundedText(value.colourMode, "capabilityProof.colourMode", 16),
    bitDepth: Number(value.bitDepth),
    widthPx: Number(value.widthPx),
    heightPx: Number(value.heightPx),
    acquisitionRegion: finiteRegion(value.acquisitionRegion, "capabilityProof.acquisitionRegion"),
    captureHelperVersion: boundedText(value.captureHelperVersion, "capabilityProof.captureHelperVersion", 64),
    frameAssessment: Object.freeze({
      accepted: value.frameAssessment?.accepted === true,
      cardBoundsMm: finiteRegion(value.frameAssessment?.cardBoundsMm, "capabilityProof.frameAssessment.cardBoundsMm"),
      evidenceMarginMm: finiteMargins(value.frameAssessment?.evidenceMarginMm, "capabilityProof.frameAssessment.evidenceMarginMm"),
    }),
  };
  const expectedWidthPx = Math.round((proof.acquisitionRegion.width / 25.4) * 1200);
  const expectedHeightPx = Math.round((proof.acquisitionRegion.height / 25.4) * 1200);
  if (!/^[a-f0-9]{64}$/.test(proof.sha256)
      || !Number.isSafeInteger(proof.sizeBytes) || proof.sizeBytes < 64 * 1024 || proof.sizeBytes > 512 * 1024 * 1024
      || proof.format !== "TIFF" || proof.requestedDpi !== 1200 || proof.driverResolutionDpi !== 1200
      || proof.colourMode !== "RGB" || proof.bitDepth !== 8
      || !Number.isSafeInteger(proof.widthPx) || Math.abs(proof.widthPx - expectedWidthPx) > 2
      || !Number.isSafeInteger(proof.heightPx) || Math.abs(proof.heightPx - expectedHeightPx) > 2
      || proof.frameAssessment.accepted !== true
      || Math.min(...Object.values(proof.frameAssessment.evidenceMarginMm)) < 4) {
    throw new Error("capabilityProof constants are invalid");
  }
  return Object.freeze(proof);
}

function normalizedProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Locked scanner profile is invalid");
  const stationCode = boundedText(input.stationCode, "stationCode", 64).toUpperCase();
  if (!/^MV-STN-[A-Z2-7]{10,24}$/.test(stationCode)) throw new Error("stationCode is invalid");
  const profile = {
    schemaVersion: SCHEMA_VERSION,
    stationCode,
    profileRevisionId: boundedText(input.profileRevisionId, "profileRevisionId", 160),
    semanticOperationId: boundedText(input.semanticOperationId, "semanticOperationId", 64).toLowerCase(),
    scannerHardware: scannerHardware(input.scannerHardware),
    globalProfileVersion: boundedText(input.globalProfileVersion, "globalProfileVersion", 120),
    calibrationVersion: boundedText(input.calibrationVersion, "calibrationVersion", 120),
    acquisitionRegion: finiteRegion(input.acquisitionRegion, "acquisitionRegion"),
    workingRegion: finiteRegion(input.workingRegion, "workingRegion"),
    placementToleranceMm: finiteMargins(input.placementToleranceMm, "placementToleranceMm"),
    requestedDpi: Number(input.requestedDpi),
    colourMode: boundedText(input.colourMode, "colourMode", 32),
    bitDepth: Number(input.bitDepth),
    outputFormat: boundedText(input.outputFormat, "outputFormat", 32),
    presentationRotationDegrees: Number(input.presentationRotationDegrees),
    appVersion: boundedText(input.appVersion, "appVersion", 64),
    captureHelperVersion: boundedText(input.captureHelperVersion, "captureHelperVersion", 64),
    identityHelperVersion: boundedText(input.identityHelperVersion, "identityHelperVersion", 64),
    capabilityProof: capabilityProof(input.capabilityProof),
    deviceCreatedAt: boundedText(input.deviceCreatedAt, "deviceCreatedAt", 64),
    deviceTimestampAuthority: boundedText(input.deviceTimestampAuthority, "deviceTimestampAuthority", 32),
  };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profile.semanticOperationId)) {
    throw new Error("semanticOperationId is invalid");
  }
  if (profile.requestedDpi !== 1200 || profile.colourMode !== "RGB" || profile.bitDepth !== 8
      || profile.outputFormat !== "TIFF" || profile.presentationRotationDegrees !== 180
      || profile.deviceTimestampAuthority !== "NON_AUTHORITATIVE"
      || profile.capabilityProof.captureHelperVersion !== profile.captureHelperVersion) {
    throw new Error("Locked scanner profile constants are invalid");
  }
  const parsedDate = Date.parse(profile.deviceCreatedAt);
  if (!Number.isFinite(parsedDate)) throw new Error("deviceCreatedAt is invalid");
  const digest = crypto.createHash("sha256").update(canonicalJson(profile)).digest("hex");
  if (input.profileDigestSha256 != null && input.profileDigestSha256 !== digest) {
    throw new Error("Locked scanner profile digest is invalid");
  }
  return Object.freeze({ ...profile, profileDigestSha256: digest });
}

function assertSecureDirectory(directory, { create = false } = {}) {
  if (!fs.existsSync(directory)) {
    if (!create) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Locked scanner profile directory is unsafe");
  if (create) fs.chmodSync(directory, 0o700);
}

function assertReplaceableProfilePath(profilePath) {
  if (!fs.existsSync(profilePath)) return;
  const stat = fs.lstatSync(profilePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("Locked scanner profile path is unsafe");
  }
}

function defaultProfilePath() {
  return path.join(runtimePaths.appSupport(), PROFILE_FILENAME);
}

function defaultPendingProfilePath() {
  return path.join(path.dirname(defaultProfilePath()), PENDING_PROFILE_FILENAME);
}

function defaultKeyProtector() {
  return Object.freeze({
    wrap: (raw, keyId) => stationIdentity.wrapQueueKey(raw, keyId),
    unwrap: (wrappedQueueKey, keyId) => stationIdentity.unwrapQueueKey(wrappedQueueKey, keyId),
  });
}

class LockedScannerProfileStore {
  constructor({
    profilePath = defaultProfilePath(),
    keyProtector = defaultKeyProtector(),
    randomBytes = crypto.randomBytes,
    randomUUID = crypto.randomUUID,
  } = {}) {
    if (!path.isAbsolute(profilePath)) throw new Error("Locked scanner profile path must be absolute");
    this.profilePath = path.resolve(profilePath);
    this.keyProtector = keyProtector;
    this.randomBytes = randomBytes;
    this.randomUUID = randomUUID;
  }

  load() {
    if (!fs.existsSync(this.profilePath)) return null;
    assertSecureDirectory(path.dirname(this.profilePath));
    assertReplaceableProfilePath(this.profilePath);
    let envelope;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(this.profilePath, flags);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_ENVELOPE_BYTES) {
          throw new Error("unsafe envelope");
        }
        envelope = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
    }
    catch { throw new Error("Locked scanner profile is corrupt"); }
    if (envelope?.schemaVersion !== SCHEMA_VERSION || typeof envelope.keyId !== "string"
        || typeof envelope.wrappedKey !== "string" || typeof envelope.nonce !== "string"
        || typeof envelope.authTag !== "string" || typeof envelope.ciphertext !== "string"
        || typeof envelope.stationCode !== "string" || typeof envelope.profileRevisionId !== "string") {
      throw new Error("Locked scanner profile envelope is invalid");
    }
    let key = null;
    try {
      key = this.keyProtector.unwrap(envelope.wrappedKey, envelope.keyId);
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Locked scanner profile key is invalid");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(Buffer.from(`mintvault-locked-scanner-profile-v1\n${envelope.stationCode}\n${envelope.profileRevisionId}`));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const profile = normalizedProfile(JSON.parse(plaintext.toString("utf8")));
      if (profile.stationCode !== envelope.stationCode || profile.profileRevisionId !== envelope.profileRevisionId) {
        throw new Error("Locked scanner profile routing does not match its authenticated payload");
      }
      return profile;
    } catch (error) {
      if (/routing does not match/.test(String(error?.message))) throw error;
      throw new Error("Locked scanner profile authentication failed");
    } finally {
      if (Buffer.isBuffer(key)) key.fill(0);
    }
  }

  save(input) {
    const profile = normalizedProfile(input);
    const key = this.randomBytes(32);
    const nonce = this.randomBytes(12);
    if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(nonce) || nonce.length !== 12) {
      throw new Error("Locked scanner profile randomness is invalid");
    }
    const keyId = this.randomUUID();
    try {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(keyId || ""))) {
        throw new Error("Locked scanner profile key ID is invalid");
      }
      const wrapped = this.keyProtector.wrap(key, keyId);
      if (!wrapped || wrapped.queueKeyId !== keyId || typeof wrapped.wrappedQueueKey !== "string") {
        throw new Error("Station identity did not wrap the locked scanner profile key");
      }
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`mintvault-locked-scanner-profile-v1\n${profile.stationCode}\n${profile.profileRevisionId}`));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(profile))), cipher.final()]);
      const envelope = {
        schemaVersion: SCHEMA_VERSION,
        stationCode: profile.stationCode,
        profileRevisionId: profile.profileRevisionId,
        stationPublicKeyFingerprint: wrapped.stationPublicKeyFingerprint || null,
        keyId,
        wrappedKey: wrapped.wrappedQueueKey,
        nonce: nonce.toString("base64url"),
        authTag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      };
      const directory = path.dirname(this.profilePath);
      assertSecureDirectory(directory, { create: true });
      assertReplaceableProfilePath(this.profilePath);
      const temporary = `${this.profilePath}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(envelope));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.profilePath);
      fs.chmodSync(this.profilePath, 0o600);
      const directoryFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      return profile;
    } finally {
      key.fill(0);
    }
  }

  remove() {
    if (!fs.existsSync(this.profilePath)) return false;
    const directory = path.dirname(this.profilePath);
    assertSecureDirectory(directory);
    assertReplaceableProfilePath(this.profilePath);
    fs.unlinkSync(this.profilePath);
    const directoryFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return true;
  }
}

function loadCurrent() {
  return new LockedScannerProfileStore().load();
}

function saveCurrent(input) {
  return new LockedScannerProfileStore().save(input);
}

function loadPending() {
  return new LockedScannerProfileStore({ profilePath: defaultPendingProfilePath() }).load();
}

function savePending(input) {
  return new LockedScannerProfileStore({ profilePath: defaultPendingProfilePath() }).save(input);
}

function clearPending() {
  return new LockedScannerProfileStore({ profilePath: defaultPendingProfilePath() }).remove();
}

function retirementFiles() {
  return [defaultProfilePath(), defaultPendingProfilePath()].filter((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    assertSecureDirectory(path.dirname(candidate));
    assertReplaceableProfilePath(candidate);
    return true;
  });
}

module.exports = {
  SCHEMA_VERSION,
  configureRuntime,
  loadCurrent,
  saveCurrent,
  loadPending,
  savePending,
  clearPending,
  retirementFiles,
  LockedScannerProfileStore,
  _private: { canonicalJson, normalizedProfile, defaultProfilePath, defaultPendingProfilePath },
};
