"use strict";

function semanticAuthority() {
  let generation = 0;
  let digest = null;
  let pendingGeneration = null;
  let pendingDigest = null;
  const wrappedKeys = [];
  return {
    wrappedKeys,
    resetForNewIdentity() {
      generation = 0;
      digest = null;
      pendingGeneration = null;
      pendingDigest = null;
    },
    keyProtector: {
      wrap(raw, queueKeyId) {
        wrappedKeys.push(Buffer.from(raw));
        return { queueKeyId, wrappedQueueKey: raw.toString("base64url") };
      },
      unwrap(record) { return Buffer.from(record.wrappedMacKey, "base64url"); },
    },
    sentinel: {
      status() { return { generation, digest, pendingGeneration, pendingDigest }; },
      prepare(nextGeneration, nextDigest) {
        assertNext(nextGeneration, nextDigest);
        pendingGeneration = nextGeneration;
        pendingDigest = nextDigest;
        return { generation: nextGeneration, digest: nextDigest };
      },
      commit(nextGeneration, nextDigest) {
        if (pendingGeneration !== nextGeneration || pendingDigest !== nextDigest) throw new Error("test semantic generation desync");
        generation = nextGeneration;
        digest = nextDigest;
        pendingGeneration = null;
        pendingDigest = null;
        return { generation, digest };
      },
      abort(currentGeneration, currentDigest) {
        if (generation !== currentGeneration || digest !== currentDigest || pendingGeneration === null) throw new Error("test semantic abort desync");
        pendingGeneration = null;
        pendingDigest = null;
        return { generation, digest };
      },
    },
  };

  function assertNext(nextGeneration, nextDigest) {
    if (pendingGeneration === nextGeneration && pendingDigest === nextDigest) return;
    if (pendingGeneration !== null || nextGeneration !== generation + 1 || !/^[a-f0-9]{64}$/.test(nextDigest)) {
      throw new Error("test semantic prepare desync");
    }
  }
}

module.exports = { semanticAuthority };
