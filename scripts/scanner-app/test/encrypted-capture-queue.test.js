const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { EncryptedCaptureQueue, QueueCorruptionError } = require("../lib/encrypted-capture-queue");

function protector(deviceKey = crypto.randomBytes(32)) {
  return {
    wrap(raw, queueKeyId) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", deviceKey, nonce);
      cipher.setAAD(Buffer.from(queueKeyId));
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
      return {
        queueKeyId,
        stationPublicKeyFingerprint: crypto.createHash("sha256").update(deviceKey).digest("hex"),
        wrappedQueueKey: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"),
      };
    },
    unwrap(record) {
      const payload = Buffer.from(record.wrappedQueueKey, "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", deviceKey, payload.subarray(0, 12));
      decipher.setAAD(Buffer.from(record.queueKeyId));
      decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
    },
  };
}

function fixture(t, deviceKey) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-encrypted-queue-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  return { baseDir, queue: new EncryptedCaptureQueue({ baseDir, keyProtector: protector(deviceKey) }) };
}

function entry(overrides = {}) {
  return {
    queueEntryId: crypto.randomUUID(),
    sessionId: "capture-authorisation-123",
    captureAuthorisationId: "capture-authorisation-123",
    semanticOperationId: crypto.randomUUID(),
    cardJobId: "job-123",
    certId: "MV900",
    side: "front",
    revision: 1,
    profileRevisionId: "profile-revision-123",
    workstationId: "station-123",
    originalOperatorId: "operator-123",
    capturedAtMs: 1_723_456_789_000,
    lifecycleState: "PENDING_UPLOAD",
    ...overrides,
  };
}

test("capture artifacts are durably encrypted before plaintext is unlinked", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  const bytes = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(4096)]);
  fs.writeFileSync(source, bytes);

  const sealed = await queue.attachFile(queue.upsert(entry()), source);
  assert.equal(fs.existsSync(source), false);
  assert.equal(sealed.artifact.encryption, "AES-256-GCM");
  assert.equal(sealed.artifact.authenticatedMetadata.originalOperatorId, "operator-123");
  assert.equal(sealed.artifact.authenticatedMetadata.semanticOperationId, sealed.semanticOperationId);
  const encrypted = fs.readFileSync(queue.artifactPath(sealed.artifact));
  assert.equal(encrypted.includes(bytes.subarray(0, 32)), false, "ciphertext must not expose TIFF bytes");
  assert.equal(fs.statSync(queue.indexPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(queue.keyPath).mode & 0o777, 0o600);

  const recovered = queue.scratchPath(sealed);
  await queue.decryptToFile(sealed.artifact, recovered);
  assert.deepEqual(fs.readFileSync(recovered), bytes);
  fs.unlinkSync(recovered);
});

test("unique nonces make identical evidence encrypt differently", async (t) => {
  const { baseDir, queue } = fixture(t);
  const bytes = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(2048, 7)]);
  const firstPath = path.join(baseDir, "first.tif");
  const secondPath = path.join(baseDir, "second.tif");
  fs.writeFileSync(firstPath, bytes);
  fs.writeFileSync(secondPath, bytes);
  const first = await queue.attachFile(queue.upsert(entry()), firstPath);
  const second = await queue.attachFile(queue.upsert(entry({ queueEntryId: crypto.randomUUID(), sessionId: "capture-authorisation-456" })), secondPath);
  assert.notDeepEqual(fs.readFileSync(queue.artifactPath(first.artifact)), fs.readFileSync(queue.artifactPath(second.artifact)));
  assert.equal(first.artifact.sha256, second.artifact.sha256);
});

test("metadata substitution and ciphertext tampering fail authentication", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(1024)]));
  const sealed = await queue.attachFile(queue.upsert(entry()), source);

  const substituted = structuredClone(sealed.artifact);
  substituted.authenticatedMetadata.side = "back";
  substituted.aadSha256 = crypto.createHash("sha256")
    .update(require("../lib/encrypted-capture-queue")._private.canonicalJson(substituted.authenticatedMetadata)).digest("hex");
  await assert.rejects(queue.decryptToFile(substituted, queue.scratchPath(sealed)), QueueCorruptionError);

  const artifactPath = queue.artifactPath(sealed.artifact);
  const bytes = fs.readFileSync(artifactPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(artifactPath, bytes);
  await assert.rejects(queue.decryptToFile(sealed.artifact, queue.scratchPath(sealed)), QueueCorruptionError);
});

test("authenticated container length rejects truncation, append and sparse extension before plaintext output", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(1024)]));
  const sealed = await queue.attachFile(queue.upsert(entry()), source);
  const artifactPath = queue.artifactPath(sealed.artifact);
  const original = fs.readFileSync(artifactPath);

  for (const [name, mutate] of [
    ["short", () => fs.writeFileSync(artifactPath, original.subarray(0, original.length - 1))],
    ["long", () => fs.writeFileSync(artifactPath, Buffer.concat([original, Buffer.from([0])]))],
    ["sparse", () => { fs.writeFileSync(artifactPath, original); fs.truncateSync(artifactPath, original.length + 1024 * 1024 * 1024); }],
  ]) {
    mutate();
    const destination = path.join(baseDir, `${name}.plain`);
    await assert.rejects(queue.decryptToFile(sealed.artifact, destination), /container size does not match/);
    assert.equal(fs.existsSync(destination), false, `${name} container must fail before output is opened`);
  }
});

test("synchronous Preview reads reject an extended container before whole-file allocation", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "preview.jpg");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(1024)]));
  const sealed = await queue.attachFile(queue.upsert(entry()), source, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg" });
  const artifactPath = queue.artifactPath(sealed.previewArtifact);
  const originalSize = fs.statSync(artifactPath).size;
  fs.truncateSync(artifactPath, originalSize + 1024 * 1024 * 1024);
  assert.throws(() => queue.readArtifactSync(sealed.previewArtifact, 12 * 1024 * 1024), /container size does not match/);
});

test("streaming decrypt consumes the already-verified descriptor across a pathname swap", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  const plaintext = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(2048)]);
  fs.writeFileSync(source, plaintext);
  const sealed = await queue.attachFile(queue.upsert(entry()), source);
  const artifactPath = queue.artifactPath(sealed.artifact);
  queue.afterArtifactOpen = () => {
    fs.renameSync(artifactPath, `${artifactPath}.verified`);
    fs.writeFileSync(artifactPath, Buffer.alloc(32, 0x41));
    queue.afterArtifactOpen = () => {};
  };
  const destination = path.join(baseDir, "recovered.tif");
  await queue.decryptToFile(sealed.artifact, destination);
  assert.deepEqual(fs.readFileSync(destination), plaintext);
});

test("synchronous Preview decrypt consumes the already-verified descriptor across a pathname swap", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "preview.jpg");
  const plaintext = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(2048)]);
  fs.writeFileSync(source, plaintext);
  const sealed = await queue.attachFile(queue.upsert(entry()), source, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg" });
  const artifactPath = queue.artifactPath(sealed.previewArtifact);
  queue.afterArtifactOpen = () => {
    fs.renameSync(artifactPath, `${artifactPath}.verified`);
    const substitute = fs.openSync(artifactPath, "w", 0o600);
    try { fs.ftruncateSync(substitute, 1024 * 1024 * 1024); } finally { fs.closeSync(substitute); }
    queue.afterArtifactOpen = () => {};
  };
  assert.deepEqual(queue.readArtifactSync(sealed.previewArtifact, 12 * 1024 * 1024), plaintext);
});

test("encryption streams the attested descriptor even when the plaintext pathname is replaced after hashing", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  const plaintext = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(128 * 1024)]);
  const digest = crypto.createHash("sha256").update(plaintext).digest("hex");
  fs.writeFileSync(source, plaintext, { mode: 0o600 });
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  queue.afterSourceHash = () => {
    fs.renameSync(source, `${source}.attested`);
    fs.writeFileSync(source, Buffer.alloc(plaintext.length, 0x43), { mode: 0o600 });
    queue.afterSourceHash = () => {};
  };
  let sealed;
  try {
    sealed = await queue.attachFile(queue.upsert(entry()), source, {
      sourceDescriptor: descriptor,
      expectedSha256: digest,
      expectedByteLength: plaintext.length,
    });
  } finally {
    fs.closeSync(descriptor);
  }
  const recovered = path.join(baseDir, "recovered.tif");
  await queue.decryptToFile(sealed.artifact, recovered);
  assert.deepEqual(fs.readFileSync(recovered), plaintext);
  assert.equal(sealed.artifact.sha256, digest);
});

test("index routing, validation, phase, and lifecycle tampering fails authentication", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(1024)]));
  await queue.attachFile(queue.upsert(entry({
    phase: "preview_ready",
    frameAssessment: { accepted: true },
  })), source);

  const index = JSON.parse(fs.readFileSync(queue.indexPath, "utf8"));
  index.entries[0].sessionId = "capture-authorisation-attacker";
  index.entries[0].side = "back";
  index.entries[0].phase = "resolved";
  index.entries[0].lifecycleState = "RESOLVED";
  index.entries[0].frameAssessment = { accepted: false };
  fs.writeFileSync(queue.indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  assert.throws(() => queue.entries(), /index authentication failed/);
  assert.throws(() => queue.assertReferencedArtifactsPresent(), /index authentication failed/);
});

test("even a valid index MAC cannot detach the top-level route from artifact AAD", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(1024)]));
  const sealed = await queue.attachFile(queue.upsert(entry()), source);
  assert.throws(
    () => queue.writeEntries([{ ...sealed, side: "back", originalOperatorId: "operator-attacker" }]),
    /routing tuple does not match/,
  );
});

test("copying queue files to another device cannot unwrap the DEK", async (t) => {
  const sourceDeviceKey = crypto.randomBytes(32);
  const source = fixture(t, sourceDeviceKey);
  const plain = path.join(source.baseDir, "master.tif");
  fs.writeFileSync(plain, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(1024)]));
  await source.queue.attachFile(source.queue.upsert(entry()), plain);

  const clonedBase = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-cloned-queue-"));
  t.after(() => fs.rmSync(clonedBase, { recursive: true, force: true }));
  fs.cpSync(source.queue.root, path.join(clonedBase, "capture-queue"), { recursive: true });
  const clone = new EncryptedCaptureQueue({ baseDir: clonedBase, keyProtector: protector(crypto.randomBytes(32)) });
  assert.throws(() => clone.ensureKey(), /authentic|unsupported|bad decrypt/i);
});

test("a missing wrapped DEK never creates a replacement key over existing queue state", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(1024)]));
  await queue.attachFile(queue.upsert(entry()), source);
  fs.unlinkSync(queue.keyPath);
  const reopened = new EncryptedCaptureQueue({ baseDir, keyProtector: protector() });
  assert.throws(() => reopened.entries(), /wrapped capture queue key is missing/i);
  assert.equal(fs.existsSync(reopened.keyPath), false, "recovery must not overwrite the missing-key evidence condition");
});

test("corrupt indexes fail closed instead of becoming an empty queue", (t) => {
  const { queue } = fixture(t);
  fs.writeFileSync(queue.indexPath, "{not-json", { mode: 0o600 });
  assert.throws(() => queue.entries(), QueueCorruptionError);
  assert.throws(() => queue.upsert(entry()), QueueCorruptionError);
});

test("deleted index records are reconstructed from authenticated container metadata into quarantine", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(2048)]));
  const sealed = await queue.attachFile(queue.upsert(entry()), source);
  queue.writeEntries([]); // models index deletion/partial restoration while ciphertext survives
  assert.equal(queue.entries().length, 0);
  assert.equal(queue.recoverOrphanCiphertexts(), 1);
  const recovered = queue.entries()[0];
  assert.equal(recovered.lifecycleState, "QUARANTINED");
  assert.equal(recovered.disposition, null);
  assert.equal(recovered.originalOperatorId, sealed.originalOperatorId);
  assert.equal(recovered.artifact.sha256, sealed.artifact.sha256);
  assert.doesNotThrow(() => queue.assertReferencedArtifactsPresent());
});

test("orphan recovery merges a TIFF master and Preview that share one queue ID", async (t) => {
  const { baseDir, queue } = fixture(t);
  const master = path.join(baseDir, "master.tif");
  const preview = path.join(baseDir, "preview.jpg");
  fs.writeFileSync(master, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(2048)]));
  fs.writeFileSync(preview, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(1024)]));
  let sealed = await queue.attachFile(queue.upsert(entry()), master);
  sealed = await queue.attachFile(sealed, preview, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg" });
  queue.writeEntries([]);

  assert.equal(queue.recoverOrphanCiphertexts(), 2);
  const [recovered] = queue.entries();
  assert.equal(recovered.lifecycleState, "QUARANTINED");
  assert.equal(recovered.artifact.sha256, sealed.artifact.sha256);
  assert.equal(recovered.previewArtifact.sha256, sealed.previewArtifact.sha256);
  assert.doesNotThrow(() => queue.assertReferencedArtifactsPresent());
});

test("a missing encrypted artifact is detected before startup recovery continues", async (t) => {
  const { baseDir, queue } = fixture(t);
  const source = path.join(baseDir, "master.tif");
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(512)]));
  const sealed = await queue.attachFile(queue.upsert(entry()), source);
  fs.unlinkSync(queue.artifactPath(sealed.artifact));
  assert.throws(() => queue.assertReferencedArtifactsPresent(), /missing encrypted artifact/);
});

test("the lifecycle contract rejects ad-hoc phases and dispositions", (t) => {
  const { queue } = fixture(t);
  assert.throws(() => queue.upsert(entry({ lifecycleState: "upload_retry" })), /lifecycle state/);
  assert.throws(() => queue.upsert(entry({ disposition: "DELETE_LATER" })), /disposition/);
  for (const lifecycleState of ["PENDING_UPLOAD", "RETRYING", "NEEDS_RECONCILIATION", "QUARANTINED", "ACCEPTED", "RESOLVED"]) {
    assert.doesNotThrow(() => queue.upsert(entry({ queueEntryId: crypto.randomUUID(), lifecycleState })));
  }
});

test("terminal queue lifecycle transitions cannot be reopened", (t) => {
  const { queue } = fixture(t);
  const stored = queue.upsert(entry());
  queue.upsert({ ...stored, lifecycleState: "QUARANTINED" });
  assert.throws(
    () => queue.upsert({ ...stored, lifecycleState: "RETRYING" }),
    /cannot move from QUARANTINED to RETRYING/,
  );
});

test("Rescan atomically quarantines the prior evidence and installs the fresh target", (t) => {
  const { queue } = fixture(t);
  const previous = queue.upsert(entry({ phase: "preview_ready" }));
  const next = entry({
    queueEntryId: crypto.randomUUID(),
    sessionId: previous.sessionId,
    captureAuthorisationId: "capture-authorisation-456",
    semanticOperationId: crypto.randomUUID(),
    revision: previous.revision + 1,
    phase: "awaiting_scan",
  });

  const originalWriteEntries = queue.writeEntries;
  queue.writeEntries = () => { throw new Error("simulated crash before atomic index replacement"); };
  assert.throws(() => queue.replaceForRescan(previous.queueEntryId, next), /simulated crash/);
  queue.writeEntries = originalWriteEntries;
  assert.deepEqual(queue.entries().map(({ queueEntryId, lifecycleState }) => ({ queueEntryId, lifecycleState })), [
    { queueEntryId: previous.queueEntryId, lifecycleState: "PENDING_UPLOAD" },
  ]);

  const replaced = queue.replaceForRescan(previous.queueEntryId, next);
  assert.equal(replaced.previous.lifecycleState, "QUARANTINED");
  assert.equal(replaced.previous.localOutcome, "OPERATOR_RESCAN");
  assert.equal(replaced.next.lifecycleState, "PENDING_UPLOAD");
  assert.deepEqual(new Set(queue.entries().map((candidate) => candidate.queueEntryId)), new Set([previous.queueEntryId, next.queueEntryId]));
});
