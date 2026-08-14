const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const helperIntegrity = require("../lib/helper-integrity");

const { LockedScannerProfileStore, _private } = require("../lib/locked-scanner-profile");

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

function profile(overrides = {}) {
  return {
    stationCode: "MV-STN-ABCDEFGHJK",
    profileRevisionId: "calibration-revision-1",
    semanticOperationId: "12345678-1234-4234-9234-123456789abc",
    scannerHardware: { manufacturer: "Canon", model: "CanoScan LiDE 400", deviceId: "ica:lide400:1", serial: null },
    globalProfileVersion: "mintvault-canon-lide-400-v3",
    calibrationVersion: "mintvault-lide400-jig-v1",
    acquisitionRegion: { x: 22, y: 39, width: 100, height: 130 },
    workingRegion: { x: 40, y: 60, width: 63, height: 88 },
    placementToleranceMm: { left: 14, right: 14, top: 14, bottom: 14 },
    requestedDpi: 1200,
    colourMode: "RGB",
    bitDepth: 8,
    outputFormat: "TIFF",
    presentationRotationDegrees: 180,
    appVersion: "1.2.1",
    captureHelperVersion: helperIntegrity.HELPER_VERSION,
    identityHelperVersion: helperIntegrity.IDENTITY_HELPER_VERSION,
    capabilityProof: {
      sha256: "a".repeat(64),
      sizeBytes: 1_000_000,
      format: "TIFF",
      requestedDpi: 1200,
      driverResolutionDpi: 1200,
      colourMode: "RGB",
      bitDepth: 8,
      widthPx: 4724,
      heightPx: 6142,
      acquisitionRegion: { x: 22, y: 39, width: 100, height: 130 },
      captureHelperVersion: helperIntegrity.HELPER_VERSION,
      frameAssessment: {
        accepted: true,
        cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 },
        evidenceMarginMm: { left: 18, top: 21, right: 19, bottom: 21 },
      },
    },
    deviceCreatedAt: "2026-08-14T12:00:00.000Z",
    deviceTimestampAuthority: "NON_AUTHORITATIVE",
    ...overrides,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-locked-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profilePath: path.join(root, "private", "locked.json") };
}

test("accepted Scanner profile survives restart with exact immutable proof and private modes", (t) => {
  const { profilePath } = fixture(t);
  const store = new LockedScannerProfileStore({ profilePath, keyProtector: protector("device-a") });
  const saved = store.save(profile());
  const envelope = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const loaded = new LockedScannerProfileStore({ profilePath, keyProtector: protector("device-a") }).load();
  assert.deepEqual(loaded, saved);
  assert.match(loaded.profileDigestSha256, /^[a-f0-9]{64}$/);
  assert.equal(loaded.capabilityProof.driverResolutionDpi, 1200);
  assert.equal(loaded.capabilityProof.format, "TIFF");
  assert.match(envelope.keyId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(fs.statSync(profilePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(profilePath)).mode & 0o777, 0o700);
});

test("profile envelope routing, ciphertext and copied-device substitution fail authentication", (t) => {
  const { profilePath } = fixture(t);
  const store = new LockedScannerProfileStore({ profilePath, keyProtector: protector("device-a") });
  store.save(profile());
  const original = JSON.parse(fs.readFileSync(profilePath, "utf8"));

  fs.writeFileSync(profilePath, JSON.stringify({ ...original, profileRevisionId: "attacker-revision" }));
  assert.throws(() => store.load(), /authentication failed/);
  const substituted = `${original.ciphertext[0] === "A" ? "B" : "A"}${original.ciphertext.slice(1)}`;
  fs.writeFileSync(profilePath, JSON.stringify({ ...original, ciphertext: substituted }));
  assert.throws(() => store.load(), /authentication failed/);
  fs.writeFileSync(profilePath, JSON.stringify(original));
  assert.throws(
    () => new LockedScannerProfileStore({ profilePath, keyProtector: protector("device-b") }).load(),
    /authentication failed/,
  );
});

test("symlink, hard-link, non-file and partial profile paths fail closed", (t) => {
  const { root, profilePath } = fixture(t);
  fs.mkdirSync(path.dirname(profilePath));
  const target = path.join(root, "target.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, profilePath);
  const store = new LockedScannerProfileStore({ profilePath, keyProtector: protector("device-a") });
  assert.throws(() => store.load(), /unsafe/);
  assert.throws(() => store.save(profile()), /unsafe/);

  fs.unlinkSync(profilePath);
  fs.writeFileSync(profilePath, "{");
  assert.throws(() => store.load(), /corrupt/);
  fs.unlinkSync(profilePath);
  fs.mkdirSync(profilePath);
  assert.throws(() => store.save(profile()), /unsafe/);
});

test("profile constants and 1200-DPI proof participate in the canonical digest", () => {
  const accepted = _private.normalizedProfile(profile());
  assert.throws(() => _private.normalizedProfile(profile({ requestedDpi: 600 })), /constants/);
  assert.throws(() => _private.normalizedProfile(profile({ capabilityProof: { ...profile().capabilityProof, driverResolutionDpi: 600 } })), /capabilityProof constants/);
  assert.throws(() => _private.normalizedProfile(profile({ capabilityProof: { ...profile().capabilityProof, captureHelperVersion: "0.9.0" } })), /constants/);
  assert.throws(() => _private.normalizedProfile({ ...profile(), profileDigestSha256: "b".repeat(64) }), /digest/);
  const changedProof = _private.normalizedProfile(profile({ capabilityProof: { ...profile().capabilityProof, sha256: "c".repeat(64) } }));
  assert.notEqual(changedProof.profileDigestSha256, accepted.profileDigestSha256);
});

test("profile storage rejects a key label the sealed helper would refuse", (t) => {
  const { profilePath } = fixture(t);
  const store = new LockedScannerProfileStore({
    profilePath,
    keyProtector: protector("device-a"),
    randomUUID: () => "scanner-profile:not-a-uuid",
  });
  assert.throws(() => store.save(profile()), /key ID is invalid/);
  assert.equal(fs.existsSync(profilePath), false);
  const helperSource = fs.readFileSync(path.resolve(__dirname, "..", "native", "mv-identity-helper.swift"), "utf8");
  assert.match(helperSource, /case "wrap-queue-key"[\s\S]*UUID\(uuidString: requestedId\) != nil/);
  assert.match(helperSource, /case "unwrap-queue-key"[\s\S]*UUID\(uuidString: requestedId\) != nil/);
});
