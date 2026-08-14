/**
 * Device-bound durable capture queue.
 *
 * The index contains only routing/lifecycle metadata. Evidence bytes are
 * AES-256-GCM encrypted with a queue DEK that is wrapped by the station's
 * Secure Enclave identity helper. Immutable capture metadata is authenticated
 * as AAD, so editing the index cannot substitute a job, side, revision,
 * operator, profile or digest without making the artifact undecryptable.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const MAGIC = Buffer.from("MVQUEUE2", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const METADATA_LENGTH_BYTES = 4;
const FIXED_HEADER_BYTES = MAGIC.length + METADATA_LENGTH_BYTES;
const MAX_EMBEDDED_METADATA_BYTES = 64 * 1024;
const INDEX_SCHEMA_VERSION = 1;
const ARTIFACT_SCHEMA_VERSION = 1;
const STATES = new Set([
  "PENDING_UPLOAD",
  "RETRYING",
  "NEEDS_RECONCILIATION",
  "QUARANTINED",
  "ACCEPTED",
  "RESOLVED",
]);
const DISPOSITIONS = new Set([
  "ACCEPTED",
  "STILL_REQUIRED",
  "SUPERSEDED",
  "CANCELLED",
  "INVALID_TARGET",
  "REQUIRES_FIX",
]);
const LIFECYCLE_TRANSITIONS = Object.freeze({
  PENDING_UPLOAD: new Set(["PENDING_UPLOAD", "RETRYING", "NEEDS_RECONCILIATION", "QUARANTINED", "ACCEPTED"]),
  RETRYING: new Set(["RETRYING", "NEEDS_RECONCILIATION", "QUARANTINED", "ACCEPTED"]),
  NEEDS_RECONCILIATION: new Set(["NEEDS_RECONCILIATION", "RETRYING", "QUARANTINED", "ACCEPTED"]),
  QUARANTINED: new Set(["QUARANTINED"]),
  ACCEPTED: new Set(["ACCEPTED", "RESOLVED"]),
  RESOLVED: new Set(["RESOLVED"]),
});

class QueueCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueCorruptionError";
    this.code = "CAPTURE_QUEUE_CORRUPT";
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function safeName(value, label) {
  const text = String(value || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/.test(text)) throw new QueueCorruptionError(`${label} is invalid`);
  return text;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory) {
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function atomicWriteJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(path.dirname(filePath));
}

function readEmbeddedHeader(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= FIXED_HEADER_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new QueueCorruptionError("Encrypted capture artifact is truncated");
  }
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    const fixed = Buffer.alloc(FIXED_HEADER_BYTES);
    fs.readSync(handle, fixed, 0, fixed.length, 0);
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new QueueCorruptionError("Encrypted capture artifact header is invalid");
    const metadataLength = fixed.readUInt32BE(MAGIC.length);
    if (metadataLength < 2 || metadataLength > MAX_EMBEDDED_METADATA_BYTES || stat.size <= FIXED_HEADER_BYTES + metadataLength + NONCE_BYTES + TAG_BYTES) {
      throw new QueueCorruptionError("Encrypted capture artifact metadata header is invalid");
    }
    const metadataBytes = Buffer.alloc(metadataLength);
    fs.readSync(handle, metadataBytes, 0, metadataLength, FIXED_HEADER_BYTES);
    let embedded;
    try { embedded = JSON.parse(metadataBytes.toString("utf8")); }
    catch { throw new QueueCorruptionError("Encrypted capture embedded metadata is corrupt"); }
    if (embedded?.schemaVersion !== 2 || typeof embedded.keyId !== "string" || typeof embedded.authenticatedMetadata !== "object") {
      throw new QueueCorruptionError("Encrypted capture embedded metadata schema is invalid");
    }
    const nonceOffset = FIXED_HEADER_BYTES + metadataLength;
    const nonce = Buffer.alloc(NONCE_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    fs.readSync(handle, nonce, 0, nonce.length, nonceOffset);
    fs.readSync(handle, tag, 0, tag.length, stat.size - TAG_BYTES);
    return { stat, embedded, metadataBytes, nonce, tag, ciphertextOffset: nonceOffset + NONCE_BYTES };
  } finally { fs.closeSync(handle); }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await new Promise((resolve, reject) => stream.on("end", resolve).on("error", reject));
  return hash.digest("hex");
}

function defaultKeyProtector() {
  const identity = require("./station-identity");
  return {
    wrap: (raw, keyId) => identity.wrapQueueKey(raw, keyId),
    unwrap: (record) => identity.unwrapQueueKey(record.wrappedQueueKey, record.queueKeyId),
  };
}

class EncryptedCaptureQueue {
  constructor({ baseDir, keyProtector = null, now = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
    if (!path.isAbsolute(String(baseDir || ""))) throw new Error("Capture queue base directory must be absolute");
    this.baseDir = path.resolve(baseDir);
    this.root = path.join(this.baseDir, "capture-queue");
    this.artifactsDir = path.join(this.root, "artifacts");
    this.quarantineDir = path.join(this.root, "quarantine");
    this.scratchDir = path.join(this.root, "scratch");
    this.indexPath = path.join(this.root, "index.v1.json");
    this.keyPath = path.join(this.root, "wrapped-key.v1.json");
    this.keyProtector = keyProtector || defaultKeyProtector();
    this.now = now;
    this.randomUUID = randomUUID;
    this.cachedKey = null;
    for (const directory of [this.root, this.artifactsDir, this.quarantineDir, this.scratchDir]) ensurePrivateDirectory(directory);
  }

  readIndex() {
    if (!fs.existsSync(this.indexPath)) return { schemaVersion: INDEX_SCHEMA_VERSION, entries: [] };
    let index;
    try { index = JSON.parse(fs.readFileSync(this.indexPath, "utf8")); }
    catch { throw new QueueCorruptionError("Capture queue index is not valid JSON"); }
    if (index?.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(index.entries)) {
      throw new QueueCorruptionError("Capture queue index schema is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(String(index.mac || "")) || typeof index.updatedAt !== "string") {
      throw new QueueCorruptionError("Capture queue index authentication is missing");
    }
    const expectedMac = this.indexMac(index.updatedAt, index.entries);
    if (!crypto.timingSafeEqual(Buffer.from(index.mac, "hex"), Buffer.from(expectedMac, "hex"))) {
      throw new QueueCorruptionError("Capture queue index authentication failed");
    }
    this.validateEntries(index.entries);
    return index;
  }

  validateEntries(entries) {
    if (!Array.isArray(entries)) throw new QueueCorruptionError("Capture queue entries are invalid");
    const ids = new Set();
    for (const entry of entries) {
      safeName(entry?.queueEntryId, "Queue entry ID");
      if (ids.has(entry.queueEntryId)) throw new QueueCorruptionError("Capture queue contains a duplicate entry ID");
      ids.add(entry.queueEntryId);
      if (entry.lifecycleState != null && !STATES.has(entry.lifecycleState)) {
        throw new QueueCorruptionError("Capture queue lifecycle state is invalid");
      }
      if (entry.disposition != null && !DISPOSITIONS.has(entry.disposition)) {
        throw new QueueCorruptionError("Capture queue disposition is invalid");
      }
      if (entry.artifact) {
        this.assertArtifact(entry.artifact);
        this.assertEntryBinding(entry, entry.artifact);
      }
      if (entry.previewArtifact) {
        this.assertArtifact(entry.previewArtifact);
        this.assertEntryBinding(entry, entry.previewArtifact);
      }
    }
  }

  entries() {
    return this.readIndex().entries.map((entry) => structuredClone(entry));
  }

  writeEntries(entries) {
    this.validateEntries(entries);
    const updatedAt = this.now().toISOString();
    const candidate = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      updatedAt,
      entries,
      mac: this.indexMac(updatedAt, entries),
    };
    atomicWriteJson(this.indexPath, candidate);
  }

  indexMac(updatedAt, entries) {
    const { raw } = this.ensureKey();
    const macKey = Buffer.from(crypto.hkdfSync(
      "sha256",
      raw,
      Buffer.from("mintvault-capture-queue-key-derivation-v1"),
      Buffer.from("mintvault-capture-queue-index-mac-v1"),
      32,
    ));
    const payload = canonicalJson({ schemaVersion: INDEX_SCHEMA_VERSION, updatedAt, entries });
    return crypto.createHmac("sha256", macKey).update(payload).digest("hex");
  }

  upsert(input) {
    const entry = { ...input };
    entry.queueEntryId = entry.queueEntryId || this.randomUUID();
    safeName(entry.queueEntryId, "Queue entry ID");
    entry.updatedAt = this.now().toISOString();
    if (entry.lifecycleState != null && !STATES.has(entry.lifecycleState)) throw new Error("Capture queue lifecycle state is invalid");
    if (entry.disposition != null && !DISPOSITIONS.has(entry.disposition)) throw new Error("Capture queue disposition is invalid");
    const currentEntries = this.entries();
    const previous = currentEntries.find((candidate) => candidate.queueEntryId === entry.queueEntryId);
    if (previous?.lifecycleState && entry.lifecycleState &&
        !LIFECYCLE_TRANSITIONS[previous.lifecycleState]?.has(entry.lifecycleState)) {
      throw new QueueCorruptionError(`Capture queue lifecycle cannot move from ${previous.lifecycleState} to ${entry.lifecycleState}`);
    }
    const entries = currentEntries.filter((candidate) => candidate.queueEntryId !== entry.queueEntryId);
    entries.push(entry);
    this.writeEntries(entries);
    return structuredClone(entry);
  }

  replaceForRescan(previousQueueEntryId, nextInput, {
    reason = "Operator chose Rescan before acceptance; this TIFF was never uploaded as card evidence.",
  } = {}) {
    safeName(previousQueueEntryId, "Previous queue entry ID");
    const currentEntries = this.entries();
    const previous = currentEntries.find((candidate) => candidate.queueEntryId === previousQueueEntryId);
    if (!previous) throw new QueueCorruptionError("Previous Rescan queue entry is missing");
    if (!LIFECYCLE_TRANSITIONS[previous.lifecycleState]?.has("QUARANTINED")) {
      throw new QueueCorruptionError(`Capture queue lifecycle cannot move from ${previous.lifecycleState} to QUARANTINED`);
    }

    const next = { ...nextInput };
    next.queueEntryId = next.queueEntryId || this.randomUUID();
    safeName(next.queueEntryId, "Replacement queue entry ID");
    if (next.queueEntryId === previousQueueEntryId || currentEntries.some((candidate) => candidate.queueEntryId === next.queueEntryId)) {
      throw new QueueCorruptionError("Replacement Rescan queue entry ID is not unique");
    }
    if (next.lifecycleState !== "PENDING_UPLOAD" || next.disposition != null) {
      throw new QueueCorruptionError("Replacement Rescan entry must begin pending without a disposition");
    }

    const updatedAt = this.now().toISOString();
    const quarantined = {
      ...previous,
      phase: "quarantined",
      lifecycleState: "QUARANTINED",
      disposition: null,
      localOutcome: "OPERATOR_RESCAN",
      quarantineReason: reason,
      quarantinedAt: updatedAt,
      updatedAt,
    };
    const waiting = { ...next, updatedAt };
    const replacements = currentEntries
      .filter((candidate) => candidate.queueEntryId !== previousQueueEntryId)
      .concat(quarantined, waiting);
    // Both lifecycle changes become visible through one authenticated atomic
    // index replacement. A crash can therefore expose the old live target or
    // the new one, never a state where neither target is recoverable.
    this.writeEntries(replacements);
    return { previous: structuredClone(quarantined), next: structuredClone(waiting) };
  }

  remove(queueEntryId) {
    this.writeEntries(this.entries().filter((entry) => entry.queueEntryId !== queueEntryId));
  }

  ensureKey() {
    if (this.cachedKey) return this.cachedKey;
    let record;
    if (fs.existsSync(this.keyPath)) {
      try { record = JSON.parse(fs.readFileSync(this.keyPath, "utf8")); }
      catch { throw new QueueCorruptionError("Wrapped capture queue key is corrupt"); }
      if (record?.schemaVersion !== 1 || typeof record.queueKeyId !== "string" || typeof record.wrappedQueueKey !== "string") {
        throw new QueueCorruptionError("Wrapped capture queue key schema is invalid");
      }
      const raw = this.keyProtector.unwrap(record);
      if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new QueueCorruptionError("Capture queue key could not be recovered");
      this.cachedKey = { raw, keyId: record.queueKeyId, stationPublicKeyFingerprint: record.stationPublicKeyFingerprint || null };
      return this.cachedKey;
    }
    const encryptedStateExists = fs.existsSync(this.indexPath) || [this.artifactsDir, this.quarantineDir].some((directory) =>
      fs.readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".mvq"))
    );
    if (encryptedStateExists) {
      throw new QueueCorruptionError("Wrapped capture queue key is missing while encrypted queue state exists");
    }
    const raw = crypto.randomBytes(32);
    const queueKeyId = this.randomUUID().toLowerCase();
    const wrapped = this.keyProtector.wrap(raw, queueKeyId);
    if (!wrapped || wrapped.queueKeyId !== queueKeyId || typeof wrapped.wrappedQueueKey !== "string") {
      throw new Error("Secure Enclave helper did not wrap the capture queue key");
    }
    atomicWriteJson(this.keyPath, {
      schemaVersion: 1,
      queueKeyId,
      stationPublicKeyFingerprint: wrapped.stationPublicKeyFingerprint || null,
      wrappedQueueKey: wrapped.wrappedQueueKey,
      createdAt: this.now().toISOString(),
    });
    this.cachedKey = { raw, keyId: queueKeyId, stationPublicKeyFingerprint: wrapped.stationPublicKeyFingerprint || null };
    return this.cachedKey;
  }

  authenticatedMetadata(entry, { kind, mimeType, sha256, byteLength }) {
    return Object.freeze({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      kind,
      queueEntryId: entry.queueEntryId,
      captureSessionId: entry.sessionId || null,
      captureAuthorisationId: entry.captureAuthorisationId || null,
      semanticOperationId: entry.semanticOperationId || null,
      cardJobId: entry.cardJobId || null,
      certificateNumber: entry.certId || null,
      side: entry.side || null,
      revision: entry.revision ?? null,
      profileRevisionId: entry.profileRevisionId || entry.provenance?.profileRevisionId || entry.provenance?.profileVersion || null,
      tenantId: entry.tenantId || null,
      locationId: entry.locationId || null,
      stationId: entry.stationCredentialId || null,
      workstationId: entry.workstationId || null,
      originalOperatorId: entry.originalOperatorId || null,
      originalOperatorRole: entry.originalOperatorRole || null,
      capturePurpose: entry.capturePurpose || null,
      authorisationIssuedAt: entry.authorisationIssuedAt || null,
      authorisationExpiresAt: entry.authorisationExpiresAt || null,
      deviceCapturedAt: entry.capturedAtMs ? new Date(entry.capturedAtMs).toISOString() : null,
      deviceTimestampAuthority: "NON_AUTHORITATIVE",
      appVersion: entry.appVersion || null,
      captureHelperVersion: entry.captureHelperVersion || null,
      identityHelperVersion: entry.identityHelperVersion || null,
      captureProvenance: entry.provenance || null,
      masterValidation: entry.masterValidation || null,
      frameAssessment: entry.frameAssessment || null,
      sha256,
      byteLength,
      mimeType,
    });
  }

  assertArtifact(artifact) {
    if (artifact?.schemaVersion !== ARTIFACT_SCHEMA_VERSION || artifact.encryption !== "AES-256-GCM" ||
        typeof artifact.relativePath !== "string" || path.isAbsolute(artifact.relativePath) || artifact.relativePath.includes("..") ||
        !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || "")) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
        typeof artifact.authenticatedMetadata !== "object" || artifact.authenticatedMetadata === null) {
      throw new QueueCorruptionError("Encrypted capture artifact metadata is invalid");
    }
    const expected = canonicalJson(artifact.authenticatedMetadata);
    if (artifact.aadSha256 !== crypto.createHash("sha256").update(expected).digest("hex")) {
      throw new QueueCorruptionError("Encrypted capture artifact metadata authentication reference is invalid");
    }
  }

  assertEntryBinding(entry, artifact) {
    const metadata = artifact.authenticatedMetadata;
    const actual = {
      queueEntryId: entry.queueEntryId,
      captureSessionId: entry.sessionId || null,
      captureAuthorisationId: entry.captureAuthorisationId || null,
      semanticOperationId: entry.semanticOperationId || null,
      cardJobId: entry.cardJobId || null,
      certificateNumber: entry.certId || null,
      side: entry.side || null,
      revision: entry.revision ?? null,
      profileRevisionId: entry.profileRevisionId || entry.provenance?.profileRevisionId || entry.provenance?.profileVersion || null,
      tenantId: entry.tenantId || null,
      locationId: entry.locationId || null,
      stationId: entry.stationCredentialId || null,
      workstationId: entry.workstationId || null,
      originalOperatorId: entry.originalOperatorId || null,
      originalOperatorRole: entry.originalOperatorRole || null,
      capturePurpose: entry.capturePurpose || null,
      authorisationIssuedAt: entry.authorisationIssuedAt || null,
      authorisationExpiresAt: entry.authorisationExpiresAt || null,
      deviceCapturedAt: entry.capturedAtMs ? new Date(entry.capturedAtMs).toISOString() : null,
      appVersion: entry.appVersion || null,
      captureHelperVersion: entry.captureHelperVersion || null,
      identityHelperVersion: entry.identityHelperVersion || null,
      captureProvenance: entry.provenance || null,
      masterValidation: entry.masterValidation || null,
      frameAssessment: entry.frameAssessment || null,
    };
    const bound = Object.fromEntries(Object.keys(actual).map((key) => [key, metadata[key] ?? null]));
    if (canonicalJson(actual) !== canonicalJson(bound)) {
      throw new QueueCorruptionError("Capture queue routing tuple does not match authenticated artifact metadata");
    }
  }

  artifactPath(artifact) {
    this.assertArtifact(artifact);
    const candidate = path.resolve(this.root, artifact.relativePath);
    const allowed = [path.resolve(this.artifactsDir) + path.sep, path.resolve(this.quarantineDir) + path.sep];
    if (!allowed.some((root) => candidate.startsWith(root))) throw new QueueCorruptionError("Encrypted capture artifact escaped the queue root");
    return candidate;
  }

  async attachFile(inputEntry, sourcePath, { kind = "TIFF_MASTER", mimeType = "image/tiff", quarantine = false } = {}) {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error("Capture artifact is not a regular non-empty file");
    fs.chmodSync(sourcePath, 0o600);
    const entry = { ...inputEntry, queueEntryId: inputEntry.queueEntryId || this.randomUUID() };
    safeName(entry.queueEntryId, "Queue entry ID");
    const sha256 = await sha256File(sourcePath);
    const authenticatedMetadata = this.authenticatedMetadata(entry, { kind, mimeType, sha256, byteLength: stat.size });
    const aad = Buffer.from(canonicalJson(authenticatedMetadata));
    const { raw, keyId } = this.ensureKey();
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", raw, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: stat.size });
    const directory = quarantine ? this.quarantineDir : this.artifactsDir;
    const basename = `${entry.queueEntryId}.${kind === "PREVIEW_JPEG" ? "preview" : "master"}.mvq`;
    const finalPath = path.join(directory, basename);
    const temporary = `${finalPath}.${process.pid}.${this.randomUUID()}.tmp`;
    const embedded = Buffer.from(canonicalJson({ schemaVersion: 2, keyId, authenticatedMetadata }));
    if (embedded.length > MAX_EMBEDDED_METADATA_BYTES) throw new Error("Authenticated capture metadata exceeds its size limit");
    const metadataLength = Buffer.alloc(METADATA_LENGTH_BYTES);
    metadataLength.writeUInt32BE(embedded.length);
    const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    output.write(Buffer.concat([MAGIC, metadataLength, embedded, nonce]));
    try {
      await pipeline(fs.createReadStream(sourcePath), cipher, output);
      fs.appendFileSync(temporary, cipher.getAuthTag());
      const handle = fs.openSync(temporary, fs.constants.O_RDONLY);
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, finalPath);
      fs.chmodSync(finalPath, 0o600);
      fsyncDirectory(directory);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort for uncommitted ciphertext only */ }
      throw error;
    }
    const relativePath = path.relative(this.root, finalPath);
    const artifact = Object.freeze({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      encryption: "AES-256-GCM",
      keyId,
      relativePath,
      sha256,
      byteLength: stat.size,
      mimeType,
      aadSha256: crypto.createHash("sha256").update(aad).digest("hex"),
      authenticatedMetadata,
      encryptedAt: this.now().toISOString(),
    });
    const field = kind === "PREVIEW_JPEG" ? "previewArtifact" : "artifact";
    const updated = this.upsert({ ...entry, [field]: artifact });
    try { fs.unlinkSync(sourcePath); }
    catch (error) {
      // Ciphertext and its index entry are already durable. Refuse to continue
      // until the duplicate plaintext can be removed; startup recovery retries.
      throw new Error(`Encrypted capture is durable but plaintext removal failed: ${error.message}`);
    }
    return updated;
  }

  async decryptToFile(artifact, destination) {
    const source = this.artifactPath(artifact);
    const header = readEmbeddedHeader(source);
    const embeddedCanonical = canonicalJson(header.embedded.authenticatedMetadata);
    if (header.embedded.keyId !== artifact.keyId || embeddedCanonical !== canonicalJson(artifact.authenticatedMetadata)) {
      throw new QueueCorruptionError("Encrypted capture embedded metadata does not match the queue index");
    }
    const { raw, keyId } = this.ensureKey();
    if (artifact.keyId !== keyId) throw new QueueCorruptionError("Encrypted capture artifact uses an unknown queue key");
    const decipher = crypto.createDecipheriv("aes-256-gcm", raw, header.nonce, { authTagLength: TAG_BYTES });
    const aad = Buffer.from(canonicalJson(artifact.authenticatedMetadata));
    decipher.setAAD(aad, { plaintextLength: artifact.byteLength });
    decipher.setAuthTag(header.tag);
    ensurePrivateDirectory(path.dirname(destination));
    const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    try {
      await pipeline(fs.createReadStream(source, { start: header.ciphertextOffset, end: header.stat.size - TAG_BYTES - 1 }), decipher, output);
      const recovered = fs.statSync(destination);
      if (recovered.size !== artifact.byteLength || await sha256File(destination) !== artifact.sha256) {
        throw new QueueCorruptionError("Decrypted capture digest or size does not match immutable metadata");
      }
      return destination;
    } catch (error) {
      try { fs.unlinkSync(destination); } catch { /* incomplete plaintext only */ }
      if (error instanceof QueueCorruptionError) throw error;
      throw new QueueCorruptionError("Encrypted capture authentication failed");
    }
  }

  async readArtifact(artifact, maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || artifact.byteLength > maximumBytes) {
      throw new Error("Encrypted artifact exceeds the in-memory preview limit");
    }
    const destination = path.join(this.scratchDir, `${this.randomUUID()}.preview-read`);
    await this.decryptToFile(artifact, destination);
    try { return fs.readFileSync(destination); }
    finally { try { fs.unlinkSync(destination); } catch { /* startup sweep handles interrupted cleanup */ } }
  }

  readArtifactSync(artifact, maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || artifact.byteLength > maximumBytes) {
      throw new Error("Encrypted artifact exceeds the in-memory preview limit");
    }
    const source = this.artifactPath(artifact);
    const payload = fs.readFileSync(source);
    const header = readEmbeddedHeader(source);
    if (header.embedded.keyId !== artifact.keyId || canonicalJson(header.embedded.authenticatedMetadata) !== canonicalJson(artifact.authenticatedMetadata)) {
      throw new QueueCorruptionError("Encrypted capture embedded metadata does not match the queue index");
    }
    const { raw, keyId } = this.ensureKey();
    if (artifact.keyId !== keyId) throw new QueueCorruptionError("Encrypted capture artifact uses an unknown queue key");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", raw, header.nonce, { authTagLength: TAG_BYTES });
      const aad = Buffer.from(canonicalJson(artifact.authenticatedMetadata));
      decipher.setAAD(aad, { plaintextLength: artifact.byteLength });
      decipher.setAuthTag(header.tag);
      const plaintext = Buffer.concat([
        decipher.update(payload.subarray(header.ciphertextOffset, payload.length - TAG_BYTES)),
        decipher.final(),
      ]);
      if (plaintext.length !== artifact.byteLength || crypto.createHash("sha256").update(plaintext).digest("hex") !== artifact.sha256) {
        throw new QueueCorruptionError("Decrypted capture digest or size does not match immutable metadata");
      }
      return plaintext;
    } catch (error) {
      if (error instanceof QueueCorruptionError) throw error;
      throw new QueueCorruptionError("Encrypted capture authentication failed");
    }
  }

  scratchPath(entry, extension = ".tif") {
    safeName(entry.queueEntryId, "Queue entry ID");
    return path.join(this.scratchDir, `${entry.queueEntryId}.${this.randomUUID()}${extension}`);
  }

  destroyArtifact(artifact) {
    const target = this.artifactPath(artifact);
    try { fs.unlinkSync(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  recoverOrphanCiphertexts() {
    const index = this.readIndex();
    const referenced = new Set();
    for (const entry of index.entries) {
      if (entry.artifact) referenced.add(this.artifactPath(entry.artifact));
      if (entry.previewArtifact) referenced.add(this.artifactPath(entry.previewArtifact));
    }
    const candidates = [];
    for (const directory of [this.artifactsDir, this.quarantineDir]) {
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        if (dirent.isFile() && dirent.name.endsWith(".mvq")) candidates.push(path.join(directory, dirent.name));
      }
    }
    let recovered = 0;
    for (const candidate of candidates) {
      if (referenced.has(candidate)) continue;
      const header = readEmbeddedHeader(candidate);
      const metadata = header.embedded.authenticatedMetadata;
      safeName(metadata?.queueEntryId, "Recovered queue entry ID");
      if (!/^[a-f0-9]{64}$/.test(String(metadata.sha256 || "")) || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1) {
        throw new QueueCorruptionError("Orphaned encrypted capture metadata is invalid");
      }
      const artifact = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        encryption: "AES-256-GCM",
        keyId: header.embedded.keyId,
        relativePath: path.relative(this.root, candidate),
        sha256: metadata.sha256,
        byteLength: metadata.byteLength,
        mimeType: metadata.mimeType,
        aadSha256: crypto.createHash("sha256").update(canonicalJson(metadata)).digest("hex"),
        authenticatedMetadata: metadata,
        encryptedAt: header.stat.mtime.toISOString(),
      };
      this.assertArtifact(artifact);
      const indexedExisting = index.entries.find((entry) => entry.queueEntryId === metadata.queueEntryId) || null;
      if (indexedExisting?.lifecycleState === "RESOLVED" && indexedExisting.disposition === "ACCEPTED") {
        this.assertEntryBinding(indexedExisting, artifact);
        fs.unlinkSync(candidate);
        fsyncDirectory(path.dirname(candidate));
        continue;
      }
      // Re-read after each recovery write so a master and Preview sharing one
      // queue ID merge into the same record rather than replacing one another.
      const existing = this.entries().find((entry) => entry.queueEntryId === metadata.queueEntryId) || {};
      const field = metadata.kind === "PREVIEW_JPEG" ? "previewArtifact" : "artifact";
      this.upsert({
        ...existing,
        queueEntryId: metadata.queueEntryId,
        semanticOperationId: metadata.semanticOperationId,
        sessionId: metadata.captureSessionId,
        captureAuthorisationId: metadata.captureAuthorisationId,
        cardJobId: metadata.cardJobId,
        certId: metadata.certificateNumber,
        side: metadata.side,
        revision: metadata.revision,
        profileRevisionId: metadata.profileRevisionId,
        tenantId: metadata.tenantId,
        locationId: metadata.locationId,
        stationCredentialId: metadata.stationId,
        workstationId: metadata.workstationId,
        originalOperatorId: metadata.originalOperatorId,
        originalOperatorRole: metadata.originalOperatorRole,
        capturePurpose: metadata.capturePurpose,
        authorisationIssuedAt: metadata.authorisationIssuedAt,
        authorisationExpiresAt: metadata.authorisationExpiresAt,
        capturedAtMs: metadata.deviceCapturedAt ? Date.parse(metadata.deviceCapturedAt) : null,
        appVersion: metadata.appVersion,
        captureHelperVersion: metadata.captureHelperVersion,
        identityHelperVersion: metadata.identityHelperVersion,
        provenance: metadata.captureProvenance,
        masterValidation: metadata.masterValidation,
        frameAssessment: metadata.frameAssessment,
        phase: "quarantined",
        lifecycleState: "QUARANTINED",
        disposition: null,
        quarantineReason: "Encrypted artifact was not referenced by the queue index and was recovered fail-closed",
        [field]: artifact,
      });
      recovered++;
    }
    return recovered;
  }

  assertReferencedArtifactsPresent() {
    for (const entry of this.entries()) {
      for (const artifact of [entry.artifact, entry.previewArtifact].filter(Boolean)) {
        const candidate = this.artifactPath(artifact);
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
          throw new QueueCorruptionError("Capture queue references a missing encrypted artifact");
        }
        const header = readEmbeddedHeader(candidate);
        if (header.embedded.keyId !== artifact.keyId || canonicalJson(header.embedded.authenticatedMetadata) !== canonicalJson(artifact.authenticatedMetadata)) {
          throw new QueueCorruptionError("Capture queue artifact metadata does not match its encrypted container");
        }
      }
    }
  }

  storageStatus() {
    const values = fs.statfsSync(this.root);
    const availableBytes = Number(values.bavail) * Number(values.bsize);
    const totalBytes = Number(values.blocks) * Number(values.bsize);
    const minimumBytes = Math.max(2 * 1024 ** 3, Math.floor(totalBytes * 0.05));
    return Object.freeze({ ok: availableBytes >= minimumBytes, availableBytes, totalBytes, minimumBytes });
  }
}

module.exports = {
  EncryptedCaptureQueue,
  QueueCorruptionError,
  STATES,
  DISPOSITIONS,
  LIFECYCLE_TRANSITIONS,
  _private: { canonicalJson, atomicWriteJson, sha256File, readEmbeddedHeader, MAGIC, FIXED_HEADER_BYTES, TAG_BYTES },
};
