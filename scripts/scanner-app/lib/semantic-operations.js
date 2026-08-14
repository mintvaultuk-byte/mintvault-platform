const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const DEFAULT_STORE = path.join(SUPPORT, "semantic-operations-v1.json");
const MAX_OPERATIONS = 512;
const RETAIN_COMPLETED = 256;

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

function createStore(filePath = DEFAULT_STORE) {
  function read() {
    if (!fs.existsSync(filePath)) return { schemaVersion: 1, operations: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch { throw new Error("Semantic operation store is corrupt; mutations are paused"); }
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.operations) || parsed.operations.length > MAX_OPERATIONS) {
      throw new Error("Semantic operation store schema is invalid; mutations are paused");
    }
    for (const operation of parsed.operations) {
      if (!validUuidV4(operation.id) || typeof operation.key !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(operation.type) ||
          !/^[a-f0-9]{64}$/.test(String(operation.payloadFingerprint || "")) || !["PENDING", "COMPLETED"].includes(operation.state)) {
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
    durableWrite(filePath, { schemaVersion: 1, operations: [...operations, operation] });
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
    durableWrite(filePath, { schemaVersion: 1, operations });
    return Object.freeze({ ...completed });
  }

  function pending(type) {
    if (typeof type !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) throw new Error("Semantic operation type is invalid");
    const matches = read().operations.filter((operation) => operation.type === type && operation.state === "PENDING");
    if (matches.length > 1) throw new Error("Multiple pending semantic operations require recovery before mutation");
    return matches.length === 1 ? Object.freeze({ ...matches[0], replayed: true }) : null;
  }

  return Object.freeze({ begin, complete, pending, read });
}

const defaultStore = createStore();

module.exports = {
  begin: defaultStore.begin,
  complete: defaultStore.complete,
  pending: defaultStore.pending,
  _private: { canonicalJson, fingerprint, validUuidV4, durableWrite, createStore, DEFAULT_STORE, MAX_OPERATIONS, RETAIN_COMPLETED },
};
