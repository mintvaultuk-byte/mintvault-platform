const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const runtimePaths = require("./runtime-paths");
const { readBoundedJson } = require("./bounded-file");

const SUPPORT = runtimePaths.appSupport();
const DEFAULT_STORE = path.join(SUPPORT, "semantic-operations-v1.json");
const MAX_OPERATIONS = 512;
const RETAIN_COMPLETED = 256;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_KEY_RECORD_BYTES = 64 * 1024;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

function durableWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  const directory = fs.openSync(path.dirname(filePath), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function defaultAuthority() {
  const stationIdentity = require("./station-identity");
  return {
    keyProtector: {
      wrap(raw, keyId) { return stationIdentity.wrapQueueKey(raw, keyId); },
      unwrap(record) { return stationIdentity.unwrapQueueKey(record.wrappedMacKey, record.macKeyId); },
    },
    sentinel: {
      status() { return stationIdentity.semanticLedgerStatus(); },
      prepare(generation, digest) { return stationIdentity.prepareSemanticLedger(generation, digest); },
      commit(generation, digest) { return stationIdentity.commitSemanticLedger(generation, digest); },
      abort(generation, digest) { return stationIdentity.abortSemanticLedger(generation, digest); },
    },
  };
}

function createStore(filePath = DEFAULT_STORE, authority = null) {
  const resolvedAuthority = authority || defaultAuthority();
  if (typeof resolvedAuthority.keyProtector?.wrap !== "function" || typeof resolvedAuthority.keyProtector?.unwrap !== "function"
      || typeof resolvedAuthority.sentinel?.status !== "function" || typeof resolvedAuthority.sentinel?.prepare !== "function"
      || typeof resolvedAuthority.sentinel?.commit !== "function" || typeof resolvedAuthority.sentinel?.abort !== "function") {
    throw new Error("Semantic operation device authority is unavailable");
  }
  const keyPath = `${filePath}.key-v1.json`;
  let cachedMacKey = null;

  function sentinelStatus() {
    const value = resolvedAuthority.sentinel.status();
    if (!value || !Number.isSafeInteger(value.generation) || value.generation < 0
        || (value.generation === 0 ? value.digest !== null : !/^[a-f0-9]{64}$/.test(String(value.digest || "")))
        || (value.pendingGeneration !== null && (!Number.isSafeInteger(value.pendingGeneration)
          || value.pendingGeneration !== value.generation + 1 || !/^[a-f0-9]{64}$/.test(String(value.pendingDigest || ""))))) {
      throw new Error("Semantic operation sentinel is invalid; mutations are paused");
    }
    return value;
  }

  function ensureMacKey() {
    if (cachedMacKey) return cachedMacKey;
    if (fs.existsSync(keyPath)) {
      let record;
      try { record = readBoundedJson(keyPath, { maximumBytes: MAX_KEY_RECORD_BYTES, label: "Semantic operation MAC key" }); }
      catch { throw new Error("Semantic operation MAC key is corrupt; mutations are paused"); }
      if (record?.schemaVersion !== 1 || !validUuidV4(record.macKeyId) || typeof record.wrappedMacKey !== "string"
          || record.wrappedMacKey.length < 32 || record.wrappedMacKey.length > 32 * 1024) {
        throw new Error("Semantic operation MAC key is invalid; mutations are paused");
      }
      const raw = resolvedAuthority.keyProtector.unwrap(record);
      if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error("Semantic operation MAC key cannot be recovered; mutations are paused");
      cachedMacKey = raw;
      return raw;
    }
    if (fs.existsSync(filePath)) throw new Error("Semantic operation MAC key is missing; mutations are paused");
    const raw = crypto.randomBytes(32);
    const macKeyId = crypto.randomUUID();
    const wrapped = resolvedAuthority.keyProtector.wrap(raw, macKeyId);
    if (!wrapped || wrapped.queueKeyId !== macKeyId || typeof wrapped.wrappedQueueKey !== "string") {
      throw new Error("Semantic operation MAC key wrapping failed; mutations are paused");
    }
    durableWrite(keyPath, { schemaVersion: 1, macKeyId, wrappedMacKey: wrapped.wrappedQueueKey });
    cachedMacKey = raw;
    return raw;
  }

  function storeMac(generation, updatedAt, operations) {
    return crypto.createHmac("sha256", ensureMacKey())
      .update(canonicalJson({ schemaVersion: 1, generation, updatedAt, operations }))
      .digest("hex");
  }

  function candidateDigest(candidate) {
    return crypto.createHash("sha256").update(canonicalJson(candidate)).digest("hex");
  }

  function write(operations, currentGeneration) {
    const generation = currentGeneration + 1;
    const updatedAt = new Date().toISOString();
    const candidate = { schemaVersion: 1, generation, updatedAt, operations, mac: storeMac(generation, updatedAt, operations) };
    const digest = candidateDigest(candidate);
    const prepared = resolvedAuthority.sentinel.prepare(generation, digest);
    if (prepared?.generation !== generation || prepared?.digest !== digest) {
      throw new Error("Semantic operation generation could not be prepared; mutations are paused");
    }
    durableWrite(filePath, candidate);
    const committed = resolvedAuthority.sentinel.commit(generation, digest);
    if (committed?.generation !== generation || committed?.digest !== digest) {
      throw new Error("Semantic operation generation could not be committed; mutations are paused");
    }
  }

  function read() {
    if (!fs.existsSync(filePath)) {
      const sentinel = sentinelStatus();
      if (sentinel.generation > 0) throw new Error("Semantic operation store is missing after initialization; mutations are paused");
      if (sentinel.pendingGeneration !== null) resolvedAuthority.sentinel.abort(0, null);
      return { schemaVersion: 1, generation: 0, operations: [] };
    }
    let parsed;
    try { parsed = readBoundedJson(filePath, { maximumBytes: MAX_STORE_BYTES, label: "Semantic operation store" }); }
    catch { throw new Error("Semantic operation store is corrupt; mutations are paused"); }
    if (parsed?.schemaVersion !== 1 || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1
        || typeof parsed.updatedAt !== "string" || !Array.isArray(parsed.operations)
        || parsed.operations.length > MAX_OPERATIONS || !/^[a-f0-9]{64}$/.test(String(parsed.mac || ""))) {
      throw new Error("Semantic operation store schema is invalid; mutations are paused");
    }
    const expectedMac = storeMac(parsed.generation, parsed.updatedAt, parsed.operations);
    if (!crypto.timingSafeEqual(Buffer.from(parsed.mac, "hex"), Buffer.from(expectedMac, "hex"))) {
      throw new Error("Semantic operation store authentication failed; mutations are paused");
    }
    const digest = candidateDigest(parsed);
    const sentinel = sentinelStatus();
    if (sentinel.pendingGeneration === parsed.generation && sentinel.pendingDigest === digest
        && sentinel.generation + 1 === parsed.generation) {
      const committed = resolvedAuthority.sentinel.commit(parsed.generation, digest);
      if (committed?.generation !== parsed.generation || committed?.digest !== digest) {
        throw new Error("Semantic operation pending generation cannot be recovered; mutations are paused");
      }
    } else if (sentinel.generation === parsed.generation && sentinel.digest === digest) {
      if (sentinel.pendingGeneration !== null) resolvedAuthority.sentinel.abort(parsed.generation, digest);
    } else {
      throw new Error("Semantic operation generation does not match device high-water; mutations are paused");
    }
    for (const operation of parsed.operations) {
      if (!validUuidV4(operation.id) || typeof operation.key !== "string" || !operation.key || operation.key.length > 240
          || !/^[A-Z][A-Z0-9_]{1,63}$/.test(operation.type)
          || !/^[a-f0-9]{64}$/.test(String(operation.payloadFingerprint || "")) || !["PENDING", "COMPLETED"].includes(operation.state)
          || typeof operation.createdAt !== "string" || (operation.completedAt != null && typeof operation.completedAt !== "string")
          || (operation.resultReference != null && (typeof operation.resultReference !== "string" || operation.resultReference.length > 240))) {
        throw new Error("Semantic operation store contains an invalid operation; mutations are paused");
      }
      if (fingerprint(operation.payload) !== operation.payloadFingerprint) {
        throw new Error("Semantic operation payload does not match its durable fingerprint; mutations are paused");
      }
    }
    return parsed;
  }

  function begin({ key, type, payload }) {
    if (typeof key !== "string" || !key.trim() || key.length > 240) throw new Error("Semantic operation key is invalid");
    if (typeof type !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) throw new Error("Semantic operation type is invalid");
    const canonical = canonicalJson(payload);
    if (typeof canonical !== "string") throw new Error("Semantic operation payload is invalid");
    if (Buffer.byteLength(canonical) > 32 * 1024) throw new Error("Semantic operation payload is too large");
    const durablePayload = JSON.parse(canonical);
    const payloadFingerprint = fingerprint(payload);
    const store = read();
    const existing = store.operations.find((operation) => operation.key === key);
    if (existing) {
      if (existing.type !== type || existing.payloadFingerprint !== payloadFingerprint) {
        const error = new Error("Semantic operation ID is already bound to different scope or payload");
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return Object.freeze({ ...existing, replayed: true });
    }
    let operations = store.operations;
    if (operations.length >= MAX_OPERATIONS) {
      const pending = operations.filter((operation) => operation.state === "PENDING");
      if (pending.length >= MAX_OPERATIONS) throw new Error("Semantic operation capacity is exhausted; mutations are paused");
      const keepCompleted = Math.min(RETAIN_COMPLETED, MAX_OPERATIONS - pending.length - 1);
      const completed = operations.filter((operation) => operation.state === "COMPLETED");
      const retainedIds = new Set((keepCompleted > 0 ? completed.slice(-keepCompleted) : []).map((operation) => operation.id));
      operations = operations.filter((operation) => operation.state === "PENDING" || retainedIds.has(operation.id));
    }
    const operation = {
      id: crypto.randomUUID(),
      key,
      type,
      payloadFingerprint,
      payload: durablePayload,
      state: "PENDING",
      resultReference: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    write([...operations, operation], store.generation);
    return Object.freeze({ ...operation, replayed: false });
  }

  function complete(id, resultReference = null) {
    if (!validUuidV4(id)) throw new Error("Semantic operation ID is invalid");
    if (resultReference != null && (typeof resultReference !== "string" || resultReference.length > 240)) {
      throw new Error("Semantic operation result reference is invalid");
    }
    const store = read();
    const index = store.operations.findIndex((operation) => operation.id === id);
    if (index < 0) throw new Error("Semantic operation does not exist");
    const existing = store.operations[index];
    if (existing.state === "COMPLETED") {
      if (existing.resultReference !== resultReference) {
        const error = new Error("Completed semantic operation result cannot change");
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return Object.freeze({ ...existing });
    }
    const completed = { ...existing, state: "COMPLETED", resultReference, completedAt: new Date().toISOString() };
    const operations = store.operations.slice();
    operations[index] = completed;
    write(operations, store.generation);
    return Object.freeze({ ...completed });
  }

  function pending(type) {
    if (typeof type !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) throw new Error("Semantic operation type is invalid");
    const matches = read().operations.filter((operation) => operation.type === type && operation.state === "PENDING");
    if (matches.length > 1) throw new Error("Multiple pending semantic operations require recovery before mutation");
    return matches.length === 1 ? Object.freeze({ ...matches[0], replayed: true }) : null;
  }

  function find(id) {
    if (!validUuidV4(id)) throw new Error("Semantic operation ID is invalid");
    const operation = read().operations.find((candidate) => candidate.id === id);
    return operation ? Object.freeze({ ...operation }) : null;
  }

  function retirementFiles() {
    const store = read();
    if (store.operations.some((operation) => operation.state === "PENDING")) {
      throw new Error("Pending semantic operations must reconcile before station identity retirement");
    }
    return [filePath, keyPath].filter((candidate) => fs.existsSync(candidate));
  }

  function retirementPaths() {
    return [filePath, keyPath].filter((candidate) => fs.existsSync(candidate));
  }

  function completeIdentityRetirement() {
    if (cachedMacKey) cachedMacKey.fill(0);
    cachedMacKey = null;
  }

  return Object.freeze({ begin, complete, pending, find, retirementFiles, retirementPaths, completeIdentityRetirement, read, keyPath });
}

const defaultStore = createStore();

module.exports = {
  begin: defaultStore.begin,
  complete: defaultStore.complete,
  pending: defaultStore.pending,
  find: defaultStore.find,
  retirementFiles: defaultStore.retirementFiles,
  retirementPaths: defaultStore.retirementPaths,
  completeIdentityRetirement: defaultStore.completeIdentityRetirement,
  _private: { canonicalJson, fingerprint, validUuidV4, durableWrite, createStore, DEFAULT_STORE, MAX_OPERATIONS, RETAIN_COMPLETED },
};
