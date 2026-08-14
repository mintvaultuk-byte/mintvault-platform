const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const stationIdentity = require("../lib/station-identity");
const lockedProfiles = require("../lib/locked-scanner-profile");
const lide400 = require("../lib/lide400-controller");

function protector(deviceSecret) {
  const wrappingKey = crypto.createHash("sha256").update(deviceSecret).digest();
  return {
    wrap(raw, keyId) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, nonce);
      cipher.setAAD(Buffer.from(keyId));
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
      return {
        queueKeyId: keyId,
        wrappedQueueKey: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"),
        stationPublicKeyFingerprint: crypto.createHash("sha256").update(deviceSecret).digest("hex"),
      };
    },
    unwrap(wrapped, keyId) {
      const bytes = Buffer.from(wrapped, "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(keyId));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
}

function candidate(overrides = {}) {
  return {
    scannerHardware: { manufacturer: "Canon", model: "CanoScan LiDE 400", deviceId: "ica:lide400:1", serial: null },
    scannerProfileVersion: "mintvault-canon-lide-400-v3",
    calibrationVersion: "mintvault-lide400-jig-v1",
    acquisitionRegion: { x: 22, y: 39, width: 100, height: 130 },
    workingRegion: { x: 40, y: 60, width: 63, height: 88 },
    placementToleranceMm: { left: 14, right: 14, top: 14, bottom: 14 },
    requestedDpi: 1200,
    colourMode: "RGB",
    bitDepth: 8,
    outputFormat: "TIFF",
    presentationRotationDegrees: 180,
    capabilityProof: {
      sha256: "a".repeat(64),
      sizeBytes: 87_000_000,
      format: "TIFF",
      requestedDpi: 1200,
      driverResolutionDpi: 1200,
      colourMode: "RGB",
      bitDepth: 8,
      widthPx: 4724,
      heightPx: 6142,
      acquisitionRegion: { x: 22, y: 39, width: 100, height: 130 },
      captureHelperVersion: "1.0.1",
      frameAssessment: {
        accepted: true,
        cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 },
        evidenceMarginMm: { left: 18, top: 21, right: 19, bottom: 21 },
      },
    },
    ...overrides,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-profile-operation-"));
  const previousScansDir = process.env.MINTVAULT_SCANS_DIR;
  const originals = {
    currentStationCode: stationIdentity.currentStationCode,
    wrapQueueKey: stationIdentity.wrapQueueKey,
    unwrapQueueKey: stationIdentity.unwrapQueueKey,
  };
  const device = protector("profile-operation-device");
  process.env.MINTVAULT_SCANS_DIR = root;
  stationIdentity.currentStationCode = () => "MV-STN-ABCDEFGHJK";
  stationIdentity.wrapQueueKey = (raw, keyId) => device.wrap(raw, keyId);
  stationIdentity.unwrapQueueKey = (wrapped, keyId) => device.unwrap(wrapped, keyId);
  lide400.configureRuntime({ isPackaged: false, appVersion: "1.2.1" });
  t.after(() => {
    stationIdentity.currentStationCode = originals.currentStationCode;
    stationIdentity.wrapQueueKey = originals.wrapQueueKey;
    stationIdentity.unwrapQueueKey = originals.unwrapQueueKey;
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

function exactAcceptance(operation, revision = "profile-revision-7") {
  const pending = lockedProfiles.loadPending();
  const profile = lockedProfiles._private.normalizedProfile({
    ...lide400._private.profileCandidate(pending),
    profileRevisionId: revision,
  });
  return {
    id: revision,
    profileRevisionId: revision,
    calibrationStatus: "VALID",
    semanticOperationId: operation.semanticOperationId,
    candidateDigestSha256: operation.candidateDigestSha256,
    profileDigestSha256: profile.profileDigestSha256,
    profile,
  };
}

test("profile acceptance persists one exact operation and converges after response loss/restart", (t) => {
  const { root } = fixture(t);
  const first = lide400.beginLockedProfileAcceptance(candidate());
  assert.match(first.semanticOperationId, /^[0-9a-f-]{36}$/);
  assert.match(first.candidateDigestSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.request.profile.deviceTimestampAuthority, "NON_AUTHORITATIVE");
  assert.equal(first.request.profile.appVersion, "1.2.1");
  assert.equal(fs.existsSync(path.join(root, "app-state", "pending-scanner-profile.v1.json")), true);

  const replay = lide400.resumeLockedProfileAcceptance(candidate());
  assert.equal(replay.replayed, true);
  assert.equal(replay.semanticOperationId, first.semanticOperationId);
  assert.equal(replay.candidateDigestSha256, first.candidateDigestSha256);
  assert.deepEqual(replay.request.profile, first.request.profile);
  assert.throws(
    () => lide400.resumeLockedProfileAcceptance(candidate({ acquisitionRegion: { x: 23, y: 39, width: 100, height: 130 } })),
    /different Scanner profile operation is pending/,
  );

  assert.throws(
    () => lide400.finalizeLockedProfileAcceptance(first, { id: "legacy-id", calibrationStatus: "VALID" }),
    /exact accepted Scanner profile binding/,
  );
  assert.equal(lockedProfiles.loadPending().semanticOperationId, first.semanticOperationId);

  const acceptance = exactAcceptance(first);
  const activated = lide400.finalizeLockedProfileAcceptance(first, acceptance);
  assert.equal(activated.profileRevisionId, "profile-revision-7");
  assert.equal(activated.profileDigestSha256, acceptance.profileDigestSha256);
  assert.equal(lockedProfiles.loadPending(), null);
  assert.equal(lockedProfiles.loadCurrent().semanticOperationId, first.semanticOperationId);
});

test("server acceptance followed by a local commit failure cannot consume the durable operation", (t) => {
  fixture(t);
  const operation = lide400.beginLockedProfileAcceptance(candidate());
  const acceptance = exactAcceptance(operation, "profile-revision-after-failure");
  const originalSaveCurrent = lockedProfiles.saveCurrent;
  lockedProfiles.saveCurrent = () => { throw new Error("injected local commit failure"); };
  t.after(() => { lockedProfiles.saveCurrent = originalSaveCurrent; });
  assert.throws(
    () => lide400.finalizeLockedProfileAcceptance(operation, acceptance),
    /injected local commit failure/,
  );
  assert.equal(lockedProfiles.loadCurrent(), null);
  assert.equal(lockedProfiles.loadPending().semanticOperationId, operation.semanticOperationId);
});
