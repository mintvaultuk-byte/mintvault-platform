const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { _private: terminalRetirement } = require("../lib/terminal-identity-retirement");

const enabled = process.env.MINTVAULT_RUN_SECURE_ENCLAVE_TESTS === "1";
const helperPath = path.join(__dirname, "..", "native", "bin", "mv-identity-helper");

function invoke(testService, command, payload = {}, { allowFailure = false } = {}) {
  const child = spawnSync(helperPath, [], {
    input: JSON.stringify({ command, testService, ...payload }),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  let result;
  try { result = JSON.parse(String(child.stdout || "")); }
  catch { throw new Error(`identity helper emitted invalid JSON: ${String(child.stderr || "")}`); }
  if (!allowFailure && (child.status !== 0 || result.ok !== true)) {
    throw new Error(`${result.error?.code || "IDENTITY_HELPER_FAILED"}: ${result.error?.message || "identity helper failed"}`);
  }
  return { status: child.status, result };
}

function invokeProductionDirect(command) {
  const child = spawnSync(helperPath, [], {
    input: JSON.stringify({ command }), encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024,
  });
  return { status: child.status, result: JSON.parse(String(child.stdout || "")) };
}

function invokeCrash(testService, command, payload, phase) {
  const child = spawnSync(helperPath, [], {
    input: JSON.stringify({ command, testService, ...payload, testFailurePhase: phase }),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(child.status, 86, `${phase} must terminate at the injected process boundary`);
  assert.equal(String(child.stdout || ""), "");
}

function verify(publicKeyPem, canonical, signature) {
  return crypto.verify(null, Buffer.from(canonical), publicKeyPem, Buffer.from(signature, "base64url"));
}

function namespace(label) {
  return `com.mintvault.scanner.identity.test.${label}-${crypto.randomBytes(8).toString("hex")}`;
}

function cleanup(testService) {
  try {
    const status = invoke(testService, "status", {}, { allowFailure: true }).result;
    if (status.ok && status.publicKeyFingerprint) {
      invoke(testService, "retire", { expectedFingerprint: status.publicKeyFingerprint }, { allowFailure: true });
    }
  } catch { /* exact ephemeral test namespace only; preserve original failure */ }
}

test("ad-hoc or direct callers cannot access the production identity namespace", { skip: !enabled }, () => {
  const attempted = invokeProductionDirect("status");
  assert.notEqual(attempted.status, 0);
  assert.equal(attempted.result.error.code, "RELEASE_TRUST_REQUIRED");
});

test("real Secure Enclave identity is explicit, persistent, monotonic and retireable", { skip: !enabled }, (t) => {
  const testService = namespace("lifecycle");
  t.after(() => cleanup(testService));
  assert.equal(invoke(testService, "status").result.state, "ABSENT_NEW");
  assert.equal(invoke(testService, "status").result.state, "ABSENT_NEW");

  const created = invoke(testService, "create").result;
  assert.equal(created.state, "READY_V2");
  assert.equal(created.secureEnclaveBound, true);
  assert.equal(created.keychainAccessibility, "AfterFirstUnlockThisDeviceOnly");
  assert.equal(created.keychainSynchronizable, false);
  assert.equal(invoke(testService, "create", {}, { allowFailure: true }).result.error.code, "IDENTITY_EXISTS");

  const queueKeyRaw = crypto.randomBytes(32);
  const queueKeyId = crypto.randomUUID();
  const wrappedQueueKey = invoke(testService, "wrap-queue-key", {
    queueKeyId, queueKeyRaw: queueKeyRaw.toString("base64url"),
  }).result;
  assert.equal(wrappedQueueKey.queueKeyId, queueKeyId);
  assert.equal(invoke(testService, "unwrap-queue-key", {
    queueKeyId, wrappedQueueKey: wrappedQueueKey.wrappedQueueKey,
  }).result.queueKeyRaw, queueKeyRaw.toString("base64url"));
  const tampered = `${wrappedQueueKey.wrappedQueueKey.slice(0, -1)}${wrappedQueueKey.wrappedQueueKey.endsWith("A") ? "B" : "A"}`;
  assert.notEqual(invoke(testService, "unwrap-queue-key", {
    queueKeyId, wrappedQueueKey: tampered,
  }, { allowFailure: true }).status, 0, "tampered wrapped DEKs fail closed");

  const cloneService = namespace("clone");
  t.after(() => cleanup(cloneService));
  invoke(cloneService, "create");
  assert.notEqual(invoke(cloneService, "unwrap-queue-key", {
    queueKeyId, wrappedQueueKey: wrappedQueueKey.wrappedQueueKey,
  }, { allowFailure: true }).status, 0, "another Secure Enclave identity cannot unwrap a copied queue");

  const stationCode = "MV-STN-ABCDEFGHJK";
  invoke(testService, "bind-station", {
    stationCode, expectedFingerprint: created.publicKeyFingerprint, stationStatus: "ACTIVE",
  });
  const digest = crypto.createHash("sha256").update("{}").digest("hex");
  const first = invoke(testService, "sign-request-v1", {
    method: "POST", path: "/api/partner/stations/heartbeat", timestamp: 1_723_456_789_000, contentSha256: digest,
  }).result;
  const second = invoke(testService, "sign-request-v1", {
    method: "POST", path: "/api/partner/stations/heartbeat", timestamp: 1_723_456_789_001, contentSha256: digest,
  }).result;
  assert.equal(first.nonce, 1);
  assert.equal(second.nonce, 2);
  assert.equal(verify(created.publicKeyPem, [
    "mintvault-station-request-v1", stationCode, "POST", "/api/partner/stations/heartbeat",
    String(first.timestamp), "1", digest,
  ].join("\n"), first.signature), true);
  assert.equal(verify(created.publicKeyPem, [
    "mintvault-station-request-v1", stationCode, "POST", "/api/partner/stations/heartbeat",
    String(second.timestamp), "2", digest,
  ].join("\n"), second.signature), true);

  const challengeId = "challenge-id-1";
  const challenge = crypto.randomBytes(32).toString("base64url");
  const resync = invoke(testService, "sign-resync-challenge", { challengeId, challenge }).result;
  assert.equal(verify(created.publicKeyPem,
    ["mintvault-station-resync-v1", stationCode, challengeId, challenge].join("\n"), resync.signature), true);
  assert.equal(invoke(testService, "status").result.requestNonce, 2);

  const rollback = invoke(testService, "apply-replay-state", {
    credentialEpoch: 1, requestEpoch: 1, requestSequence: 0,
  }, { allowFailure: true }).result;
  assert.equal(rollback.error.code, "INVALID_REPLAY_STATE");
  assert.equal(invoke(testService, "apply-replay-state", {
    credentialEpoch: 1, requestEpoch: 2, requestSequence: 100,
  }).result.requestSequence, 100);
  const replayedRecovery = invoke(testService, "apply-replay-state", {
    credentialEpoch: 1, requestEpoch: 2, requestSequence: 0,
  }, { allowFailure: true }).result;
  assert.equal(replayedRecovery.error.code, "INVALID_REPLAY_STATE");

  assert.equal(invoke(testService, "retire", { expectedFingerprint: created.publicKeyFingerprint }).result.state, "ABSENT_NEW");
  assert.equal(invoke(testService, "status").result.state, "ABSENT_NEW");
});

test("real migration preserves the legacy key, proves possession and converges safely", { skip: !enabled }, (t) => {
  const testService = namespace("migration");
  t.after(() => cleanup(testService));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateJwk = privateKey.export({ format: "jwk" });
  const installationId = crypto.randomUUID();
  const proofChallenge = crypto.randomBytes(32).toString("base64url");
  const payload = {
    privateKeyRaw: privateJwk.d,
    publicKeyPem,
    installationId,
    stationCode: "MV-STN-ABCDEFGHJK",
    stationStatus: "ACTIVE",
    requestNonce: 19,
    proofChallenge,
  };
  const migrated = invoke(testService, "migrate-v1", payload).result;
  assert.equal(migrated.installationId, installationId);
  assert.equal(migrated.requestNonce, 19);
  assert.equal(migrated.publicKeyFingerprint,
    crypto.createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex"));
  assert.equal(verify(publicKeyPem, `mintvault-identity-proof-v1\n${proofChallenge}`, migrated.proofSignature), true);
  assert.equal(invoke(testService, "migrate-v1", payload).result.publicKeyFingerprint, migrated.publicKeyFingerprint);

  const replacement = crypto.generateKeyPairSync("ed25519");
  const mismatch = invoke(testService, "migrate-v1", {
    ...payload,
    privateKeyRaw: replacement.privateKey.export({ format: "jwk" }).d,
    publicKeyPem: replacement.publicKey.export({ format: "pem", type: "spki" }).toString(),
  }, { allowFailure: true }).result;
  assert.equal(mismatch.error.code, "IDENTITY_MISMATCH");
});

test("identity create, migration and retirement recover every journalled process interruption", { skip: !enabled }, (t) => {
  for (const phase of ["create-after-journal", "create-after-wrapping-key", "create-after-envelope"]) {
    const testService = namespace(phase);
    t.after(() => cleanup(testService));
    invokeCrash(testService, "create", {}, phase);
    const recovered = invoke(testService, "status").result;
    const created = recovered.state === "ABSENT_NEW" ? invoke(testService, "create").result : recovered;
    assert.equal(created.state, "READY_V2");
    assert.equal(invoke(testService, "retire", { expectedFingerprint: created.publicKeyFingerprint }).result.state, "ABSENT_NEW");
  }

  for (const phase of ["migrate-after-journal", "migrate-after-wrapping-key", "migrate-after-envelope"]) {
    const testService = namespace(phase);
    t.after(() => cleanup(testService));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const payload = {
      privateKeyRaw: privateKey.export({ format: "jwk" }).d,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      installationId: crypto.randomUUID(),
      stationCode: "MV-STN-ABCDEFGHJK",
      stationStatus: "ACTIVE",
      requestNonce: 4,
      proofChallenge: crypto.randomBytes(32).toString("base64url"),
    };
    invokeCrash(testService, "migrate-v1", payload, phase);
    const status = invoke(testService, "status").result;
    const migrated = invoke(testService, "migrate-v1", payload).result;
    assert.equal(status.state === "ABSENT_NEW" || status.state === "READY_V2", true);
    assert.equal(migrated.publicKeyFingerprint,
      crypto.createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex"));
    assert.equal(invoke(testService, "retire", { expectedFingerprint: migrated.publicKeyFingerprint }).result.state, "ABSENT_NEW");
  }

  for (const phase of ["retire-after-journal", "retire-after-envelope", "retire-after-wrapping-key"]) {
    const testService = namespace(phase);
    t.after(() => cleanup(testService));
    const created = invoke(testService, "create").result;
    invoke(testService, "bind-station", {
      stationCode: "MV-STN-ABCDEFGHJK",
      expectedFingerprint: created.publicKeyFingerprint,
      stationStatus: "REJECTED",
    });
    invokeCrash(testService, "retire", { expectedFingerprint: created.publicKeyFingerprint }, phase);
    if (phase === "retire-after-journal") {
      const signed = invoke(testService, "sign-request-v1", {
        method: "POST",
        path: "/api/partner/stations/heartbeat",
        timestamp: Date.now(),
        contentSha256: "a".repeat(64),
      }, { allowFailure: true });
      assert.equal(signed.result.error.code, "IDENTITY_RETIREMENT_PENDING");
      const wrapped = invoke(testService, "wrap-queue-key", {
        queueKeyId: crypto.randomUUID(), queueKeyRaw: crypto.randomBytes(32).toString("base64url"),
      }, { allowFailure: true });
      assert.equal(wrapped.result.error.code, "IDENTITY_RETIREMENT_PENDING");
    }
    const incomplete = invoke(testService, "status").result;
    assert.equal(incomplete.state, "RETIREMENT_INCOMPLETE");
    assert.equal(incomplete.publicKeyFingerprint, created.publicKeyFingerprint);
    assert.equal(incomplete.credentialUsable, phase === "retire-after-journal");
    assert.equal(invoke(testService, "retire", { expectedFingerprint: created.publicKeyFingerprint }).result.state, "ABSENT_NEW");
    assert.equal(invoke(testService, "status").result.state, "ABSENT_NEW");
  }
});

test("JS boot coordinator converges every real native retirement interruption without custody drift", { skip: !enabled }, (t) => {
  for (const phase of ["retire-after-journal", "retire-after-envelope", "retire-after-wrapping-key"]) {
    const testService = namespace(`coordinator-${phase}`);
    t.after(() => cleanup(testService));
    const created = invoke(testService, "create").result;
    const stationCode = "MV-STN-ABCDEFGHJK";
    invoke(testService, "bind-station", {
      stationCode, expectedFingerprint: created.publicKeyFingerprint, stationStatus: "REJECTED",
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-native-retirement-coordinator-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appSupport = path.join(root, "support");
    const scansBase = path.join(root, "scans");
    fs.mkdirSync(appSupport, { recursive: true });
    fs.mkdirSync(scansBase, { recursive: true });
    const semanticFile = path.join(appSupport, "semantic.json");
    const profileFile = path.join(appSupport, "profile.json");
    const queueFile = path.join(scansBase, "queue.json");
    for (const file of [semanticFile, profileFile, queueFile]) fs.writeFileSync(file, path.basename(file));

    let firstRetire = true;
    const identity = {
      identityStatus: () => invoke(testService, "status").result,
      retireIdentity: (expectedFingerprint) => {
        if (firstRetire) {
          firstRetire = false;
          invokeCrash(testService, "retire", { expectedFingerprint }, phase);
          throw new Error(`injected ${phase}`);
        }
        return invoke(testService, "retire", { expectedFingerprint }).result;
      },
      clearOperatorSession: () => {},
    };
    const semantic = {
      retirementFiles: () => [semanticFile],
      retirementPaths: () => [semanticFile],
      completeIdentityRetirement: () => {},
    };
    const profile = { retirementFiles: () => [profileFile] };
    const watcher = {
      identityRetirementFiles: () => [queueFile],
      identityRetirementRawFiles: () => [queueFile],
      completeIdentityRetirement: () => {},
    };
    const coordinator = terminalRetirement.createCoordinator({
      identity, semantic, profile, appSupport, scansBase,
      tombstonePath: path.join(appSupport, "retirement.json"),
    });

    assert.throws(() => coordinator.retire({
      status: "REJECTED",
      stationCode,
      publicKeyFingerprint: created.publicKeyFingerprint,
      watcher,
    }), new RegExp(phase));
    const nativeStatus = invoke(testService, "status").result;
    assert.equal(nativeStatus.state, "RETIREMENT_INCOMPLETE");
    assert.equal(nativeStatus.credentialUsable, phase === "retire-after-journal");
    assert.equal(coordinator.recoverIfRetired({ watcher }).recovered, true);
    assert.equal(invoke(testService, "status").result.state, "ABSENT_NEW");
    for (const file of [semanticFile, profileFile, queueFile]) assert.equal(fs.existsSync(file), false);
    assert.equal(coordinator.readTombstone(), null);
  }
});
