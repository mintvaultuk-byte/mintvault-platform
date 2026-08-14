"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const runtimePaths = require("./runtime-paths");
const stationIdentity = require("./station-identity");
const semanticOperations = require("./semantic-operations");
const lockedProfile = require("./locked-scanner-profile");
const { readBoundedJson } = require("./bounded-file");

const TERMINAL_STATUSES = new Set(["REJECTED", "CANCELLED", "EXPIRED"]);
const MAX_TOMBSTONE_BYTES = 128 * 1024;
const MAX_RETIREMENT_FILE_BYTES = 16 * 1024 * 1024;

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function durableWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(path.dirname(filePath));
}

function snapshotDescriptor(filePath) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_RETIREMENT_FILE_BYTES) {
      throw new Error("Identity retirement file is unsafe or exceeds its size limit");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, before.size));
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const count = fs.readSync(descriptor, buffer, 0, length, offset);
      if (count !== length) throw new Error("Identity retirement file changed while being read");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size) {
      throw new Error("Identity retirement file changed while being read");
    }
    return { size: before.size, sha256: hash.digest("hex") };
  } finally { fs.closeSync(descriptor); }
}

function createCoordinator({
  identity = stationIdentity,
  semantic = semanticOperations,
  profile = lockedProfile,
  appSupport = runtimePaths.appSupport(),
  scansBase = runtimePaths.scansBase(),
  tombstonePath = path.join(appSupport, "identity-retirement.v1.json"),
  afterRetire = () => {},
} = {}) {
  const roots = Object.freeze({ appSupport: path.resolve(appSupport), scansBase: path.resolve(scansBase) });

  function fileReference(filePath) {
    const absolute = path.resolve(filePath);
    for (const [rootName, rootPath] of Object.entries(roots)) {
      const relativePath = path.relative(rootPath, absolute);
      if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
        const snapshot = snapshotDescriptor(absolute);
        return { root: rootName, relativePath, ...snapshot };
      }
    }
    throw new Error("Identity retirement file escaped its fixed application roots");
  }

  function resolveReference(reference) {
    if (!reference || !Object.hasOwn(roots, reference.root) || typeof reference.relativePath !== "string"
        || !reference.relativePath || path.isAbsolute(reference.relativePath) || reference.relativePath.split(path.sep).includes("..")
        || !Number.isSafeInteger(reference.size) || reference.size < 1
        || !/^[a-f0-9]{64}$/.test(String(reference.sha256 || ""))) {
      throw new Error("Identity retirement tombstone contains an invalid file reference");
    }
    const absolute = path.resolve(roots[reference.root], reference.relativePath);
    if (!absolute.startsWith(`${roots[reference.root]}${path.sep}`)) throw new Error("Identity retirement file reference escaped its root");
    return absolute;
  }

  function readTombstone() {
    if (!fs.existsSync(tombstonePath)) return null;
    let value;
    try { value = readBoundedJson(tombstonePath, { maximumBytes: MAX_TOMBSTONE_BYTES, label: "Station identity retirement tombstone" }); }
    catch { throw new Error("Station identity retirement tombstone is corrupt"); }
    if (value?.schemaVersion !== 1 || value.phase !== "PREPARED" || !TERMINAL_STATUSES.has(value.terminalStatus)
        || typeof value.stationCode !== "string" || value.stationCode.length < 4 || value.stationCode.length > 64
        || !/^[a-f0-9]{64}$/.test(String(value.publicKeyFingerprint || ""))
        || !Array.isArray(value.files) || value.files.length > 64 || typeof value.preparedAt !== "string") {
      throw new Error("Station identity retirement tombstone schema is invalid");
    }
    for (const reference of value.files) resolveReference(reference);
    return value;
  }

  function assertFilesUnchanged(tombstone) {
    for (const reference of tombstone.files) {
      const filePath = resolveReference(reference);
      if (!fs.existsSync(filePath)) throw new Error("Identity retirement state disappeared before the device credential was retired");
      const current = snapshotDescriptor(filePath);
      if (current.size !== reference.size || current.sha256 !== reference.sha256) {
        throw new Error("Identity retirement state changed after preparation");
      }
    }
  }

  function guardedFileReferences(watcher) {
    return [...new Set([
      ...semantic.retirementFiles(),
      ...profile.retirementFiles(),
      ...watcher.identityRetirementFiles(),
    ].map((candidate) => path.resolve(candidate)))]
      .map(fileReference)
      .sort((left, right) => `${left.root}:${left.relativePath}`.localeCompare(`${right.root}:${right.relativePath}`));
  }

  function rawGuardedFileReferences(watcher) {
    if (typeof semantic.retirementPaths !== "function" || typeof watcher.identityRetirementRawFiles !== "function") {
      throw new Error("Raw station identity retirement recovery authority is unavailable");
    }
    return [...new Set([
      ...semantic.retirementPaths(),
      ...profile.retirementFiles(),
      ...watcher.identityRetirementRawFiles(),
    ].map((candidate) => path.resolve(candidate)))]
      .map(fileReference)
      .sort((left, right) => `${left.root}:${left.relativePath}`.localeCompare(`${right.root}:${right.relativePath}`));
  }

  function assertExactGuardedFiles(tombstone, currentFiles) {
    const expected = [...tombstone.files]
      .sort((left, right) => `${left.root}:${left.relativePath}`.localeCompare(`${right.root}:${right.relativePath}`));
    if (expected.length !== currentFiles.length) {
      throw new Error("Identity retirement custody set changed after preparation");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const left = expected[index];
      const right = currentFiles[index];
      if (left.root !== right.root || left.relativePath !== right.relativePath
          || left.size !== right.size || left.sha256 !== right.sha256) {
        throw new Error("Identity retirement custody set changed after preparation");
      }
    }
  }

  function assertNoUnexpectedRetirementFiles(tombstone, currentFiles) {
    const expected = new Map(tombstone.files.map((reference) => [
      `${reference.root}:${reference.relativePath}`,
      reference,
    ]));
    for (const current of currentFiles) {
      const prepared = expected.get(`${current.root}:${current.relativePath}`);
      if (!prepared || prepared.size !== current.size || prepared.sha256 !== current.sha256) {
        throw new Error("Unexpected identity-scoped custody appeared during station retirement");
      }
    }
  }

  function completeCleanup(tombstone, watcher = null) {
    const status = identity.identityStatus();
    if (status?.state !== "ABSENT_NEW") throw new Error("Station identity cleanup requires a proven retired device credential");
    assertNoUnexpectedRetirementFiles(tombstone, rawGuardedFileReferences(watcher));
    identity.clearOperatorSession();
    semantic.completeIdentityRetirement();
    for (const reference of tombstone.files) {
      const filePath = resolveReference(reference);
      if (!fs.existsSync(filePath)) continue;
      const current = snapshotDescriptor(filePath);
      if (current.size !== reference.size || current.sha256 !== reference.sha256) {
        throw new Error("Retired identity state changed before crash recovery cleanup");
      }
      fs.unlinkSync(filePath);
      fsyncDirectory(path.dirname(filePath));
    }
    watcher?.completeIdentityRetirement?.();
    if (fs.existsSync(tombstonePath)) {
      fs.unlinkSync(tombstonePath);
      fsyncDirectory(path.dirname(tombstonePath));
    }
    return { ok: true, recovered: true, retiredFingerprint: tombstone.publicKeyFingerprint };
  }

  function recoverIfRetired({ watcher = null } = {}) {
    const tombstone = readTombstone();
    if (!tombstone) return { ok: true, recovered: false };
    const status = identity.identityStatus();
    if (status?.state === "ABSENT_NEW") return completeCleanup(tombstone, watcher);
    if (status?.state === "RETIREMENT_INCOMPLETE") {
      if (status.publicKeyFingerprint !== tombstone.publicKeyFingerprint
          || status.stationCode !== tombstone.stationCode
          || typeof status.credentialUsable !== "boolean") {
        throw new Error("Incomplete station identity retirement does not match its exact crash journal");
      }
      // A native RETIRE journal globally denies unwrap/sign/semantic commands,
      // including the first phase where the credential bytes still exist.  A
      // cold Electron restart therefore cannot rebuild the authenticated
      // semantic/queue caches.  The PREPARED tombstone already binds the exact
      // fixed-path custody set, so every incomplete native phase is recovered
      // through the bounded O_NOFOLLOW raw snapshot before exact retirement is
      // replayed.  The post-ABSENT_NEW raw check below also rejects any new
      // identity-scoped residue that appeared after preparation.
      const currentFiles = rawGuardedFileReferences(watcher);
      assertExactGuardedFiles(tombstone, currentFiles);
      const retired = identity.retireIdentity(tombstone.publicKeyFingerprint);
      if (retired?.state !== "ABSENT_NEW" || retired.retiredFingerprint !== tombstone.publicKeyFingerprint) {
        throw new Error("Incomplete station identity retirement could not be recovered");
      }
      return completeCleanup(tombstone, watcher);
    }
    if (status?.state === "READY_V2" && status.publicKeyFingerprint === tombstone.publicKeyFingerprint
        && status.stationCode === tombstone.stationCode) {
      assertFilesUnchanged(tombstone);
      return { ok: true, recovered: false, awaitingTerminalReproof: true };
    }
    throw new Error("Station identity retirement tombstone does not match the device credential");
  }

  function retire({ status, stationCode, publicKeyFingerprint, watcher }) {
    const terminalStatus = String(status || "").toUpperCase();
    if (!TERMINAL_STATUSES.has(terminalStatus)) return { ok: true, retired: false, ignored: true };
    if (!watcher || typeof watcher.identityRetirementFiles !== "function") throw new Error("Scanner custody authority is unavailable for identity retirement");
    const claimedFingerprint = String(publicKeyFingerprint || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(claimedFingerprint)) {
      throw new Error("Authoritative terminal status did not identify the exact device credential");
    }
    const current = identity.identityStatus();
    if (current?.state !== "READY_V2" || current.stationCode !== stationCode
        || current.publicKeyFingerprint !== claimedFingerprint
        || !/^[a-f0-9]{64}$/.test(String(current.publicKeyFingerprint || ""))) {
      throw new Error("Authoritative terminal status does not match this device identity");
    }
    // This is deliberately recomputed even when a PREPARED tombstone exists.
    // A tombstone is a crash journal, never authority to omit a pending
    // semantic operation or evidence object that appeared after preparation.
    const currentFiles = guardedFileReferences(watcher);
    let tombstone = readTombstone();
    if (tombstone) {
      if (tombstone.terminalStatus !== terminalStatus || tombstone.stationCode !== stationCode
          || tombstone.publicKeyFingerprint !== current.publicKeyFingerprint) {
        throw new Error("A different station identity retirement is already prepared");
      }
      assertExactGuardedFiles(tombstone, currentFiles);
    } else {
      tombstone = {
        schemaVersion: 1,
        phase: "PREPARED",
        terminalStatus,
        stationCode,
        publicKeyFingerprint: current.publicKeyFingerprint,
        files: currentFiles,
        preparedAt: new Date().toISOString(),
      };
      durableWrite(tombstonePath, tombstone);
    }
    const retired = identity.retireIdentity(current.publicKeyFingerprint);
    if (retired?.state !== "ABSENT_NEW" || retired.retiredFingerprint !== current.publicKeyFingerprint) {
      throw new Error("Device identity helper did not confirm exact credential retirement");
    }
    afterRetire(tombstone);
    return { ...completeCleanup(tombstone, watcher), retired: true, terminalStatus };
  }

  return Object.freeze({ retire, recoverIfRetired, readTombstone });
}

const shared = createCoordinator();
module.exports = Object.freeze({
  retire: shared.retire,
  recoverIfRetired: shared.recoverIfRetired,
  readTombstone: shared.readTombstone,
  _private: { createCoordinator, snapshotDescriptor, durableWrite, TERMINAL_STATUSES },
});
