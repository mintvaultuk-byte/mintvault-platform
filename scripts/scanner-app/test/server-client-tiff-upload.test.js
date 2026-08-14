const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const helperIntegrity = require("../lib/helper-integrity");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function completeEvidenceBinding(filePath, overrides = {}) {
  return {
    captureAuthorisationId: "capture-authorisation-123",
    semanticOperationId: "92c045a6-b737-4c44-8c71-6a75c1f62bd1",
    cardJobId: "job-123",
    certificateNumber: "MV901",
    side: "front",
    revision: 2,
    profileRevisionId: "profile-revision-3",
    tenantId: "tenant-partner-1",
    locationId: "location-shop-1",
    stationId: "station-credential-a",
    workstationId: "mintvault-station-a",
    originalOperatorId: "operator-7",
    originalOperatorRole: "SCANNER_OPERATOR",
    capturePurpose: "AUTHORITATIVE_CARD_CAPTURE",
    cancelEligible: overrides.cancelEligible ?? overrides.side !== "back",
    authorisationIssuedAt: "2026-08-14T09:00:00.000Z",
    authorisationExpiresAt: "2026-08-14T09:10:00.000Z",
    deviceCapturedAt: "2026-08-14T09:03:21.000Z",
    deviceTimestampAuthority: "NON_AUTHORITATIVE",
    appVersion: "1.2.1",
    captureHelperVersion: helperIntegrity.HELPER_VERSION,
    identityHelperVersion: helperIntegrity.IDENTITY_HELPER_VERSION,
    expectedSha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    expectedByteLength: fs.statSync(filePath).size,
    expectedMimeType: "image/tiff",
    ...overrides,
  };
}

test("active signed stations refuse unsigned multipart evidence fallback", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-no-signed-multipart-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const source = path.join(tempDir, "master.tif");
  fs.writeFileSync(source, Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]));
  const stationIdentity = require("../lib/station-identity");
  const original = stationIdentity.hasActiveStationSession;
  const originalIdentity = stationIdentity.hasActiveStationIdentity;
  stationIdentity.hasActiveStationSession = () => true;
  stationIdentity.hasActiveStationIdentity = () => true;
  t.after(() => {
    stationIdentity.hasActiveStationSession = original;
    stationIdentity.hasActiveStationIdentity = originalIdentity;
  });
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => { delete require.cache[clientPath]; });

  const result = await client.uploadPair(source, null, "stable-idempotency-key");
  assert.equal(result.ok, false);
  assert.equal(result.status, 426);
  assert.match(result.body.error, /staged upload and finalisation/);
});

test("station-only queue recovery also refuses multipart fallback before network I/O", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-no-station-only-multipart-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const source = path.join(tempDir, "master.tif");
  fs.writeFileSync(source, Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]));
  const stationIdentity = require("../lib/station-identity");
  const originalSession = stationIdentity.hasActiveStationSession;
  const originalIdentity = stationIdentity.hasActiveStationIdentity;
  stationIdentity.hasActiveStationSession = () => false;
  stationIdentity.hasActiveStationIdentity = () => true;
  t.after(() => {
    stationIdentity.hasActiveStationSession = originalSession;
    stationIdentity.hasActiveStationIdentity = originalIdentity;
  });
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => { delete require.cache[clientPath]; });
  const result = await client.uploadPair(source, null, "stable-idempotency-key");
  assert.equal(result.status, 426);
});

test("scanner client refuses a non-direct grant without falling back to multipart evidence", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url.endsWith("/staged-upload") ? JSON.stringify({ transport: "server_multipart" }) : "{}");
    });
  });
  await listen(server);
  t.after(() => close(server));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-tiff-upload-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  // Valid little-endian classic TIFF header followed by byte values that make
  // accidental JPEG re-encoding immediately detectable in the request body.
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0xff, 0x00, 0x93, 0x7e]);
  const source = path.join(tempDir, "v850-master.tif");
  fs.writeFileSync(source, tiff);

  const priorBase = process.env.MINTVAULT_API_BASE;
  const priorInsecureUpload = process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
  process.env.MINTVAULT_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = "1";
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE;
    else process.env.MINTVAULT_API_BASE = priorBase;
    if (priorInsecureUpload === undefined) delete process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
    else process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = priorInsecureUpload;
    delete require.cache[clientPath];
  });

  await client.claimNextCapture("mintvault-station-a", "mac-mintvault-station-a");
  await client.renewCapture("session-123", "mac-mintvault-station-a");
  const uploadResult = await client.uploadCaptureEvidence("session-123", "mac-mintvault-station-a", source, {
    profileVersion: "mintvault-canon-lide-400-v3",
    scannerManufacturer: "Canon",
    scannerModel: "CanoScan LiDE 400",
  }, completeEvidenceBinding(source));
  await client.getCaptureStatus("session-123", "mac-mintvault-station-a");

  assert.equal(uploadResult.ok, false);
  assert.equal(uploadResult.status, 502);
  assert.equal(requests.length, 4);
  const grant = requests[2];
  assert.equal(requests[0].url, "/api/admin/scanner/capture-sessions/next?workstation_id=mintvault-station-a&device_id=mac-mintvault-station-a");
  assert.equal(requests[1].url, "/api/admin/scanner/capture-sessions/session-123/keepalive");
  assert.equal(grant.url, "/api/admin/scanner/capture-sessions/session-123/staged-upload");
  assert.match(grant.body.toString("utf8"), /sha256/);
  assert.equal(requests.some((request) => /^multipart\/form-data/.test(String(request.headers["content-type"] || ""))), false);
  assert.equal(requests[3].url, "/api/admin/scanner/capture-sessions/session-123?device_id=mac-mintvault-station-a");
});

test("insecure or malformed direct grants are rejected before any upload receiver sees bytes", async (t) => {
  let requests = 0;
  let bytes = 0;
  const receiver = http.createServer((request, response) => {
    requests += 1;
    request.on("data", (chunk) => { bytes += chunk.length; });
    request.on("end", () => response.writeHead(204).end());
  });
  await listen(receiver);
  t.after(() => close(receiver));
  const client = require("../lib/server-client");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-invalid-grant-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const source = path.join(tempDir, "master.tif");
  fs.writeFileSync(source, Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]));
  const prior = process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
  delete process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
  t.after(() => { if (prior === undefined) delete process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD; else process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = prior; });
  await assert.rejects(
    client._private.putStagedTiff(`http://127.0.0.1:${receiver.address().port}/collect`, {}, source, 5),
    /pinned HTTPS storage boundary/,
  );
  assert.throws(
    () => client._private.validateDirectUploadGrant("https://example.r2.cloudflarestorage.com/object", { authorization: "secret" }, "stage-123"),
    /headers are invalid/,
  );
  assert.equal(requests, 0);
  assert.equal(bytes, 0);
});

test("staging transport and storage errors never project signed grant URLs or untrusted response bodies", async (t) => {
  const client = require("../lib/server-client");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-staging-redaction-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const source = path.join(tempDir, "master.tif");
  fs.writeFileSync(source, Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]));
  const prior = process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
  process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = "1";
  t.after(() => { if (prior === undefined) delete process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD; else process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = prior; });

  const querySecret = "SENTINEL_QUERY_CREDENTIAL";
  const transport = await client._private.putStagedTiff(`http://127.0.0.1:1/upload?X-Amz-Credential=${querySecret}`, {}, source, 5);
  assert.equal(transport.ok, false);
  assert.equal(JSON.stringify(transport).includes(querySecret), false);
  assert.equal(transport.body.error, "Evidence staging transport failed");

  const bodySecret = "SENTINEL_UNTRUSTED_STORAGE_BODY";
  const receiver = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(403, { "content-type": "text/plain" }).end(bodySecret));
  });
  await listen(receiver);
  t.after(() => close(receiver));
  const rejected = await client._private.putStagedTiff(`http://127.0.0.1:${receiver.address().port}/upload`, {}, source, 5);
  assert.equal(rejected.status, 403);
  assert.equal(JSON.stringify(rejected).includes(bodySecret), false);
  assert.equal(rejected.body.error, "Evidence staging service rejected upload — HTTP 403");
});

test("scanner client sends an exact TIFF only to a server-minted staging URL before finalisation", async (t) => {
  const requests = [];
  let stagedBytes = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "POST" && req.url.endsWith("/staged-upload")) {
        const port = server.address().port;
        res.writeHead(201, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          transport: "direct",
          staging_id: "stage-123",
          upload_url: `http://127.0.0.1:${port}/opaque-server-staging-key`,
          headers: { "content-type": "image/tiff", "cache-control": "private, no-store" },
        }));
      }
      if (req.method === "PUT" && req.url === "/opaque-server-staging-key") {
        stagedBytes = body;
        res.writeHead(200);
        return res.end();
      }
      if (req.method === "POST" && req.url.endsWith("/finalise")) {
        res.writeHead(201, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, certId: "MV901" }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected request" }));
    });
  });
  await listen(server);
  t.after(() => close(server));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-staged-tiff-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0xff, 0x00, 0x93, 0x7e]);
  const source = path.join(tempDir, "lide-master.tif");
  fs.writeFileSync(source, tiff);
  const priorBase = process.env.MINTVAULT_API_BASE;
  const priorInsecureUpload = process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
  process.env.MINTVAULT_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = "1";
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE;
    else process.env.MINTVAULT_API_BASE = priorBase;
    if (priorInsecureUpload === undefined) delete process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD;
    else process.env.MINTVAULT_ALLOW_INSECURE_TEST_UPLOAD = priorInsecureUpload;
    delete require.cache[clientPath];
  });

  const semanticOperationId = "92c045a6-b737-4c44-8c71-6a75c1f62bd1";
  const result = await client.uploadCaptureEvidence(
    "session-123",
    "mac-mintvault-station-a",
    source,
    { profileVersion: "mintvault-canon-lide-400-v3" },
    completeEvidenceBinding(source, { captureAuthorisationId: "session-123", semanticOperationId }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(stagedBytes, tiff, "the R2 PUT receives the unmodified TIFF bytes");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "/api/admin/scanner/capture-sessions/session-123/staged-upload");
  assert.match(requests[0].body.toString("utf8"), /sha256/);
  const grantBody = JSON.parse(requests[0].body.toString("utf8"));
  assert.equal(grantBody.semantic_operation_id, semanticOperationId);
  assert.equal(grantBody.capture_authorisation_id, "session-123");
  assert.equal(grantBody.card_job_id, "job-123");
  assert.equal(grantBody.side, "front");
  assert.equal(grantBody.revision, 2);
  assert.equal(grantBody.profile_revision_id, "profile-revision-3");
  assert.equal(grantBody.original_operator_id, "operator-7");
  assert.equal(grantBody.device_captured_at, "2026-08-14T09:03:21.000Z");
  assert.equal(grantBody.device_timestamp_authority, "NON_AUTHORITATIVE");
  assert.match(grantBody.sha256, /^[a-f0-9]{64}$/);
  assert.equal(grantBody.byte_length, tiff.length);
  assert.equal(grantBody.mime_type, "image/tiff");
  assert.equal(requests[1].method, "PUT");
  assert.equal(requests[1].url, "/opaque-server-staging-key");
  assert.equal(requests[2].url, "/api/admin/scanner/capture-sessions/session-123/staged-upload/stage-123/finalise");
  const finaliseBody = JSON.parse(requests[2].body.toString("utf8"));
  assert.equal(finaliseBody.semantic_operation_id, semanticOperationId);
  assert.equal(finaliseBody.device_captured_at, grantBody.device_captured_at);
  assert.equal(finaliseBody.device_timestamp_authority, "NON_AUTHORITATIVE");
  assert.equal(finaliseBody.sha256, grantBody.sha256);
  assert.equal(finaliseBody.byte_length, tiff.length);
  assert.equal(finaliseBody.staging_id, "stage-123");
  assert.equal(requests[2].body.includes(tiff), false, "finalisation carries only the opaque staging identity");
  assert.equal(requests.some((request) => /^multipart\/form-data/.test(String(request.headers["content-type"] || ""))), false);
});

function testCaptureQueueKeyProtector() {
  const testDeviceKey = crypto.randomBytes(32);
  return {
    wrap(raw, queueKeyId) {
      const cipher = crypto.createCipheriv("aes-256-gcm", testDeviceKey, Buffer.alloc(12, 1));
      cipher.setAAD(Buffer.from(queueKeyId));
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
      return { queueKeyId, stationPublicKeyFingerprint: "f".repeat(64), wrappedQueueKey: Buffer.concat([cipher.getAuthTag(), ciphertext]).toString("base64url") };
    },
    unwrap(record) {
      const payload = Buffer.from(record.wrappedQueueKey, "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", testDeviceKey, Buffer.alloc(12, 1));
      decipher.setAAD(Buffer.from(record.queueKeyId));
      decipher.setAuthTag(payload.subarray(0, 16));
      return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]);
    },
  };
}

function isolatedTargetedWatcher(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-preview-accept-"));
  const previousScansDir = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  const watcherPath = require.resolve("../lib/watcher");
  const statePath = require.resolve("../lib/state");
  delete require.cache[watcherPath];
  delete require.cache[statePath];
  const { Watcher } = require("../lib/watcher");
  const state = require("../lib/state");
  const server = require("../lib/server-client");
  const lide = require("../lib/lide400-controller");
  const originals = {
    claimNextCapture: server.claimNextCapture,
    renewCapture: server.renewCapture,
    requestRescanAuthorisation: server.requestRescanAuthorisation,
    getCaptureStatus: server.getCaptureStatus,
    uploadCaptureEvidence: server.uploadCaptureEvidence,
    hasToken: server.hasToken,
    scan: lide.scan,
    positioningPreview: lide.positioningPreview,
    scanCalibrationRegion: lide.scanCalibrationRegion,
    persistJigOrigin: lide.persistJigOrigin,
    resumeLockedProfileAcceptance: lide.resumeLockedProfileAcceptance,
    beginLockedProfileAcceptance: lide.beginLockedProfileAcceptance,
    finalizeLockedProfileAcceptance: lide.finalizeLockedProfileAcceptance,
    deviceId: lide.deviceId,
    stationId: lide.stationId,
    health: lide.health,
  };
  for (const dir of ["capture-staging", "processed", "failed", "discarded"]) {
    fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
  }
  state.set({ state: "idle", activeCapture: null, scannerHealth: { status: "ready" }, lastError: null });
  t.after(() => {
    Object.assign(server, {
      claimNextCapture: originals.claimNextCapture,
      renewCapture: originals.renewCapture,
      requestRescanAuthorisation: originals.requestRescanAuthorisation,
      getCaptureStatus: originals.getCaptureStatus,
      uploadCaptureEvidence: originals.uploadCaptureEvidence,
      hasToken: originals.hasToken,
    });
    lide.scan = originals.scan;
    lide.positioningPreview = originals.positioningPreview;
    lide.scanCalibrationRegion = originals.scanCalibrationRegion;
    lide.persistJigOrigin = originals.persistJigOrigin;
    lide.resumeLockedProfileAcceptance = originals.resumeLockedProfileAcceptance;
    lide.beginLockedProfileAcceptance = originals.beginLockedProfileAcceptance;
    lide.finalizeLockedProfileAcceptance = originals.finalizeLockedProfileAcceptance;
    lide.deviceId = originals.deviceId;
    lide.stationId = originals.stationId;
    lide.health = originals.health;
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    delete require.cache[watcherPath];
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  lide.resumeLockedProfileAcceptance = () => null;
  const watcher = new Watcher({ captureQueueKeyProtector: testCaptureQueueKeyProtector() });
  // Unit scan fixtures are deliberately tiny synthetic TIFFs. The dedicated
  // card-frame tests cover boundary math; ordinary state-machine tests inject
  // a safe assessed frame so they remain about Scan/Accept/Rescan behaviour.
  watcher.assessCaptureFrame = async () => ({ accepted: true, reason: null, evidenceMarginMm: { left: 8, top: 8, right: 8, bottom: 8 } });
  watcher.validateCaptureMaster = async (filePath) => ({
    format: "tiff", width: 220, height: 320, channels: 3, depth: "uchar", requestedDpi: 1200,
    driverResolutionDpi: 1200, byteLength: fs.statSync(filePath).size,
  });
  lide.stationId = () => "mintvault-station-a";
  return { tempDir, watcher, state, server, lide };
}

function claimedTarget(overrides = {}) {
  const id = overrides.id || "capture-session-preview";
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    id,
    captureAuthorisationId: `${id}-authorisation-v1`,
    semanticOperationId: crypto.randomUUID(),
    certificateNumber: "MV900",
    side: "front",
    workstationId: "mintvault-station-a",
    cardJobId: "card-job-900",
    revision: 1,
    profileRevisionId: "profile-revision-3",
    tenantId: "tenant-partner-1",
    locationId: "location-shop-1",
    stationId: "station-credential-a",
    originalOperatorId: "operator-original-7",
    originalOperatorRole: "SCANNER_OPERATOR",
    capturePurpose: "AUTHORITATIVE_CARD_CAPTURE",
    cancelEligible: overrides.cancelEligible ?? overrides.side !== "back",
    authorisationIssuedAt: issuedAt,
    authorisationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function captureProvenance(overrides = {}) {
  return { profileVersion: "mintvault-canon-lide-400-v3", helperVersion: helperIntegrity.HELPER_VERSION, ...overrides };
}

function canonicalAcceptedResponse(sessionId, filePath, binding, body = {}) {
  return {
    ok: true,
    body: {
      ...body,
      disposition: "ACCEPTED",
      disposition_binding: {
        capture_session_id: sessionId,
        capture_authorisation_id: binding.captureAuthorisationId,
        semantic_operation_id: binding.semanticOperationId,
        card_job_id: binding.cardJobId,
        certificate_number: binding.certificateNumber,
        side: binding.side,
        revision: binding.revision,
        profile_revision_id: binding.profileRevisionId,
        tenant_id: binding.tenantId,
        location_id: binding.locationId,
        station_id: binding.stationId,
        workstation_id: binding.workstationId,
        original_operator_id: binding.originalOperatorId,
        original_operator_role: binding.originalOperatorRole,
        purpose: binding.capturePurpose,
        authorisation_issued_at: binding.authorisationIssuedAt,
        authorisation_expires_at: binding.authorisationExpiresAt,
        device_captured_at: binding.deviceCapturedAt,
        device_timestamp_authority: binding.deviceTimestampAuthority,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        byte_length: fs.statSync(filePath).size,
        mime_type: "image/tiff",
        app_version: binding.appVersion,
        capture_helper_version: binding.captureHelperVersion,
        identity_helper_version: binding.identityHelperVersion,
      },
    },
  };
}

async function writeStationTiff(dir, name = "master.tif") {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await sharp({ create: { width: 220, height: 320, channels: 3, background: { r: 10, g: 80, b: 160 } } })
    .tiff()
    .withMetadata({ density: 1200 })
    .toFile(filePath);
  return filePath;
}

async function sealedCandidate(fixture, overrides = {}) {
  const capture = claimedTarget(overrides);
  const provenance = captureProvenance();
  const source = await writeStationTiff(path.join(fixture.tempDir, "sealed", crypto.randomUUID()));
  const masterValidation = await fixture.watcher.validateCaptureMaster(source, provenance);
  const frameAssessment = await fixture.watcher.assessCaptureFrame(source, provenance);
  let queued = fixture.watcher.addTargetedPending({
    queueEntryId: crypto.randomUUID(),
    phase: "preview_ready",
    lifecycleState: "PENDING_UPLOAD",
    sessionId: capture.id,
    captureAuthorisationId: capture.captureAuthorisationId,
    semanticOperationId: capture.semanticOperationId,
    cardJobId: capture.cardJobId,
    certId: capture.certificateNumber,
    side: capture.side,
    revision: capture.revision,
    profileRevisionId: capture.profileRevisionId,
    tenantId: capture.tenantId,
    locationId: capture.locationId,
    stationCredentialId: capture.stationId,
    workstationId: capture.workstationId,
    originalOperatorId: capture.originalOperatorId,
    originalOperatorRole: capture.originalOperatorRole,
    capturePurpose: capture.capturePurpose,
    authorisationIssuedAt: capture.authorisationIssuedAt,
    authorisationExpiresAt: capture.authorisationExpiresAt,
    sessionExpiresAt: capture.expiresAt,
    capturedAtMs: Date.now(),
    appVersion: require("../package.json").version,
    captureHelperVersion: helperIntegrity.HELPER_VERSION,
    identityHelperVersion: helperIntegrity.IDENTITY_HELPER_VERSION,
    provenance,
    masterValidation,
    frameAssessment,
  });
  queued = await fixture.watcher.captureQueue.attachFile(queued, source, { kind: "TIFF_MASTER", mimeType: "image/tiff" });
  return fixture.watcher.addTargetedPending({
    ...queued,
    evidenceDigest: queued.artifact.sha256,
    evidenceSize: queued.artifact.byteLength,
    evidenceMime: queued.artifact.mimeType,
  });
}

async function writePositioningJpeg(dir, name = "placement-preview.jpg") {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 245, g: 245, b: 245 } } })
    .jpeg()
    .withMetadata({ density: 300 })
    .toFile(filePath);
  return filePath;
}

async function writeCalibrationProof(dir, {
  name = "capability-proof.tif",
  width = 4724,
  height = 6142,
  blank = false,
  clipped = false,
  density = 1200,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const image = sharp({ create: { width, height, channels: 3, background: { r: 238, g: 241, b: 244 } } });
  const cardWidth = Math.round(width * 0.63);
  const cardHeight = Math.round(height * (88 / 130));
  const cardX = clipped ? 0 : Math.round(width * 0.18);
  const cardY = clipped ? 0 : Math.round(height * (21 / 130));
  if (!blank) {
    image.composite([{
      input: Buffer.from(`<svg width="${width}" height="${height}"><rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="24" fill="#174a76"/><path d="M ${cardX + 100} ${cardY + 180} H ${cardX + cardWidth - 100} M ${cardX + 100} ${cardY + 330} H ${cardX + cardWidth - 260}" stroke="#e9d39b" stroke-width="38"/></svg>`),
    }]);
  }
  await image.removeAlpha().tiff({ compression: "none" }).withMetadata({ density }).toFile(filePath);
  return filePath;
}

function configureClaimedStation({ watcher, state, server, lide }) {
  server.hasToken = () => true;
  server.claimNextCapture = async () => ({ ok: true, body: { capture: claimedTarget() } });
  server.renewCapture = async () => {
    const current = watcher.activeTargetEntry();
    const serverNow = new Date();
    return {
      ok: true,
      body: {
        serverNow: serverNow.toISOString(),
        capture: {
          state: "claimed",
          id: current.sessionId,
          captureAuthorisationId: current.captureAuthorisationId,
          semanticOperationId: current.semanticOperationId,
          certificateNumber: current.certId,
          side: current.side,
          workstationId: current.workstationId,
          cardJobId: current.cardJobId,
          revision: current.revision,
          profileRevisionId: current.profileRevisionId,
          tenantId: current.tenantId,
          locationId: current.locationId,
          stationId: current.stationCredentialId,
          originalOperatorId: current.originalOperatorId,
          originalOperatorRole: current.originalOperatorRole,
          capturePurpose: current.capturePurpose,
          cancelEligible: current.cancelEligible,
          authorisationIssuedAt: current.authorisationIssuedAt,
          authorisationExpiresAt: current.authorisationExpiresAt,
          expiresAt: new Date(Math.min(
            serverNow.getTime() + 60_000,
            Date.parse(current.authorisationExpiresAt) - 1,
          )).toISOString(),
        },
      },
    };
  };
  server.requestRescanAuthorisation = async (sessionId) => ({
    ok: true,
    body: {
      capture: claimedTarget({
        id: sessionId,
        certificateNumber: watcher.activeTargetEntry()?.certId,
        side: watcher.activeTargetEntry()?.side,
        cardJobId: watcher.activeTargetEntry()?.cardJobId,
        profileRevisionId: watcher.activeTargetEntry()?.profileRevisionId,
        tenantId: watcher.activeTargetEntry()?.tenantId,
        locationId: watcher.activeTargetEntry()?.locationId,
        stationId: watcher.activeTargetEntry()?.stationCredentialId,
        workstationId: watcher.activeTargetEntry()?.workstationId,
        captureAuthorisationId: `${sessionId}-authorisation-v2`,
        semanticOperationId: crypto.randomUUID(),
        revision: Number(watcher.activeTargetEntry()?.revision || 1) + 1,
      }),
    },
  });
  server.getCaptureStatus = async () => ({ ok: true, body: { accepted: false, capture: { state: "claimed" } } });
  lide.deviceId = () => "mac-mintvault-station-a";
  lide.stationId = () => "mintvault-station-a";
  watcher.waitForStable = async () => true;
  state.set({ scannerHealth: { status: "ready" } });
}

test("claiming a target displays it but never performs a physical scan or upload", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let scans = 0;
  let uploads = 0;
  fixture.lide.scan = async () => { scans++; throw new Error("scan must require explicit operator action"); };
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: true, body: {} }; };

  const result = await fixture.watcher.pollTargetedCapture();
  assert.equal(result.ok, true);
  assert.equal(scans, 0);
  assert.equal(uploads, 0);
  assert.equal(fixture.state.get().activeCapture.stage, "awaiting_scan");
  assert.equal(fixture.watcher.readTargetedQueue()[0].phase, "awaiting_scan");
});

test("server-eligible pre-evidence Card Job cancellation is exclusive and archives the exact target", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  await fixture.watcher.pollTargetedCapture();
  assert.equal(fixture.watcher.activeTargetEntry()?.cancelEligible, true, JSON.stringify(fixture.watcher.activeTargetEntry()));
  const begun = fixture.watcher.beginCardCancellation();
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.equal(fixture.watcher.isRestartSafeForUpdate(), false);
  assert.equal((await fixture.watcher.scanActiveTarget()).ok, false, "no scan can race cancellation");
  const operationId = crypto.randomUUID();
  fixture.watcher.markCardCancellationPending(begun.target, operationId);
  fixture.watcher.finishCardCancellation();
  assert.equal((await fixture.watcher.scanActiveTarget()).code, "cancel_pending", "ambiguous CANCEL keeps Scan locked");
  const resumed = fixture.watcher.beginCardCancellationForTarget(begun.target);
  assert.equal(resumed.entry.cancelOperationId, operationId);
  const applied = fixture.watcher.applyCardJobCancellation(begun.target);
  fixture.watcher.finishCardCancellation();
  assert.equal(applied.ok, true);
  assert.equal(fixture.state.get().activeCapture, null);
  const archived = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === begun.entry.queueEntryId);
  assert.equal(archived.lifecycleState, "QUARANTINED");
  assert.equal(archived.disposition, "CANCELLED");
  assert.equal(fixture.watcher.applyCardJobCancellation(begun.target).alreadyApplied, true, "restart/double apply converges");
});

test("ambiguous CANCEL survives restart, blocks Accept/Rescan, and can reconcile after the target disappears", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({ path: await writeStationTiff(dir), provenance: captureProvenance() });
  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  const previewId = fixture.state.get().activeCapture.previewId;
  const begun = fixture.watcher.beginCardCancellation();
  const operationId = crypto.randomUUID();
  fixture.watcher.markCardCancellationPending(begun.target, operationId);
  fixture.watcher.finishCardCancellation(); // response was lost; durable marker remains
  assert.equal((await fixture.watcher.acceptPreview(previewId)).code, "cancel_pending");
  assert.equal((await fixture.watcher.rescanPreview(previewId)).code, "cancel_pending");

  let renewals = 0;
  fixture.server.renewCapture = async () => { renewals += 1; return { ok: false, status: 409, body: { error: "not awaiting" } }; };
  fixture.state.set({ activeCapture: null });
  assert.equal(await fixture.watcher.resumeTargetedCaptures(), true);
  assert.equal(renewals, 0, "restart recovery never keepalives or archives a cancellation-pending target");
  assert.equal(fixture.state.get().activeCapture.stage, "cancel_pending");

  fixture.watcher.removeTargetedPending(begun.target.captureSessionId);
  const absentRecovery = fixture.watcher.beginCardCancellationForTarget(begun.target);
  assert.equal(absentRecovery.ok, true);
  assert.equal(absentRecovery.entry, null);
  assert.equal(fixture.watcher.applyCardJobCancellation(begun.target).localTargetAbsent, true);
  fixture.watcher.finishCardCancellation();
});

test("an incomplete capture authorisation is rejected before arming or physical scan", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.server.claimNextCapture = async () => ({
    ok: true,
    body: { capture: { ...claimedTarget(), cardJobId: null, authorisationIssuedAt: null } },
  });
  let scans = 0;
  fixture.lide.scan = async () => { scans++; throw new Error("must not scan"); };
  const result = await fixture.watcher.pollTargetedCapture();
  assert.equal(result.ok, false);
  assert.equal(result.authorisationRejected, true);
  assert.equal(scans, 0);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0);
});

test("a physical scan requires an exact server-timed claimed renewal", async (t) => {
  const mutations = [
    ["empty response", () => ({})],
    ["wrong session", (body) => ({ ...body, capture: { ...body.capture, id: "different-session" } })],
    ["wrong operator", (body) => ({ ...body, capture: { ...body.capture, originalOperatorId: "different-operator" } })],
    ["wrong side", (body) => ({ ...body, capture: { ...body.capture, side: "back" } })],
    ["wrong profile", (body) => ({ ...body, capture: { ...body.capture, profileRevisionId: "different-profile" } })],
    ["wrong revision", (body) => ({ ...body, capture: { ...body.capture, revision: body.capture.revision + 1 } })],
    ["wrong purpose", (body) => ({ ...body, capture: { ...body.capture, capturePurpose: "DIAGNOSTIC" } })],
    ["terminal state", (body) => ({ ...body, capture: { ...body.capture, state: "cancelled" } })],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const fixture = isolatedTargetedWatcher(subtest);
      configureClaimedStation(fixture);
      await fixture.watcher.pollTargetedCapture();
      const exactRenewal = fixture.server.renewCapture;
      fixture.server.renewCapture = async (...args) => {
        const response = await exactRenewal(...args);
        return { ...response, body: mutate(response.body) };
      };
      let scans = 0;
      fixture.lide.scan = async () => { scans += 1; throw new Error("physical scan must remain closed"); };
      const result = await fixture.watcher.scanActiveTarget();
      assert.equal(result.ok, false);
      assert.equal(scans, 0);
    });
  }

  await t.test("exact renewal", async (subtest) => {
    const fixture = isolatedTargetedWatcher(subtest);
    configureClaimedStation(fixture);
    await fixture.watcher.pollTargetedCapture();
    let scans = 0;
    fixture.lide.scan = async (dir) => {
      scans += 1;
      return { path: await writeStationTiff(dir), provenance: captureProvenance() };
    };
    const result = await fixture.watcher.scanActiveTarget();
    assert.equal(result.ok, true);
    assert.equal(scans, 1);
  });
});

test("capture authorisation identifiers cannot escape app-private staging paths", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.server.claimNextCapture = async () => ({ ok: true, body: { capture: claimedTarget({ id: "../../outside" }) } });
  const result = await fixture.watcher.pollTargetedCapture();
  assert.equal(result.authorisationRejected, true);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0);
});

test("positioning Preview is a local JPEG-only operation with no target claim, TIFF, or evidence upload", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  let nativePreviews = 0;
  let claims = 0;
  let uploads = 0;
  fixture.server.hasToken = () => true;
  fixture.server.claimNextCapture = async () => { claims++; return { ok: true, body: { capture: null } }; };
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: true, body: {} }; };
  fixture.state.set({ scannerHealth: { status: "profile_unprovisioned" }, activeCapture: null, positioningPreview: null });
  fixture.lide.positioningPreview = async (dir) => {
    nativePreviews++;
    const pathname = await writePositioningJpeg(dir);
    return {
      path: pathname,
      sizeBytes: fs.statSync(pathname).size,
      requestedDpi: 300,
      driverResolutionDpi: 300,
      appliedRegionMm: { x: 0, y: 0, width: 216, height: 297 },
      scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null },
    };
  };
  fixture.watcher.analysePositioningPreview = async () => ({
    image: { width: 900, height: 1200, density: 300, format: "jpeg" },
    cardCandidate: {
      cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 },
      surroundingBackgroundMm: { left: 40, top: 60, right: 113, bottom: 149 },
    },
    placement: {
      ready: true,
      originMm: { x: 22, y: 39 },
      areaMm: { width: 100, height: 130 },
      placementToleranceMm: 14,
    },
  });

  const result = await fixture.watcher.runPositioningPreview();
  assert.equal(result.ok, true);
  assert.equal(nativePreviews, 1);
  assert.equal(claims, 0);
  assert.equal(uploads, 0);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0);
  const positioning = fixture.state.get().positioningPreview;
  assert.equal(positioning.status, "detected");
  assert.equal(positioning.capture.sourceFormat, "jpeg");
  assert.equal(fixture.watcher.positioningPreviewData(positioning.id).ok, true);
  assert.equal(fs.readdirSync(path.dirname(positioning.previewPath)).some((name) => /\.tiff?$/i.test(name)), false);
});

test("positioning Preview is single-flight and only an exact safe result can persist local jig X/Y", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fixture.state.set({ scannerHealth: { status: "profile_unprovisioned" }, activeCapture: null, positioningPreview: null });
  let releasePreview;
  fixture.lide.positioningPreview = async (dir) => {
    await new Promise((resolve) => { releasePreview = resolve; });
    const pathname = await writePositioningJpeg(dir);
    return { path: pathname, sizeBytes: fs.statSync(pathname).size, requestedDpi: 300, driverResolutionDpi: 300, appliedRegionMm: { x: 0, y: 0, width: 216, height: 297 }, scanner: {} };
  };
  fixture.watcher.analysePositioningPreview = async () => ({
    image: {},
    cardCandidate: { cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 }, surroundingBackgroundMm: {} },
    placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
  });
  const first = fixture.watcher.runPositioningPreview();
  for (let attempt = 0; attempt < 20 && !releasePreview; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.watcher.runPositioningPreview()).ok, false, "rapid Preview clicks cannot start two physical scans");
  releasePreview();
  assert.equal((await first).ok, true);
  const previewId = fixture.state.get().positioningPreview.id;
  assert.equal(fixture.watcher.applyPositioningPreview("stale-preview").ok, false, "a stale Preview cannot alter station configuration");
  let persisted = null;
  fixture.lide.persistJigOrigin = (origin) => {
    persisted = origin;
    return { originMm: origin, areaMm: { width: 100, height: 130 }, profileVersion: "mintvault-canon-lide-400-v3" };
  };
  assert.equal(fixture.watcher.applyPositioningPreview(previewId).ok, true);
  assert.deepEqual(persisted, { x: 22, y: 39 });
  assert.equal(fixture.watcher.applyPositioningPreview(previewId).ok, false, "a duplicate save cannot reapply an already consumed Preview");
});

test("profile setup proves an exact disposable 1200-DPI TIFF before activating the server revision", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  let claims = 0;
  let uploads = 0;
  let installed = null;
  fixture.server.claimNextCapture = async () => { claims++; return { ok: true, body: { capture: null } }; };
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: true, body: {} }; };
  fixture.state.set({ scannerHealth: { status: "profile_unprovisioned" }, activeCapture: null, positioningPreview: null });
  fixture.lide.positioningPreview = async (dir) => {
    const pathname = await writePositioningJpeg(dir);
    return {
      path: pathname,
      sizeBytes: fs.statSync(pathname).size,
      requestedDpi: 300,
      driverResolutionDpi: 300,
      appliedRegionMm: { x: 0, y: 0, width: 216, height: 297 },
      scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null },
    };
  };
  fixture.watcher.analysePositioningPreview = async () => ({
    image: { width: 900, height: 1200, density: 300, format: "jpeg" },
    cardCandidate: { cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 }, surroundingBackgroundMm: {} },
    placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
  });
  fixture.lide.scanCalibrationRegion = async (dir, region) => {
    const proofPath = await writeCalibrationProof(dir);
    return {
      path: proofPath,
      sizeBytes: fs.statSync(proofPath).size,
      requestedRegionMm: region,
      appliedRegionMm: { ...region },
      requestedDpi: 1200,
      driverResolutionDpi: 1200,
      helperVersion: helperIntegrity.HELPER_VERSION,
      scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null },
    };
  };
  fixture.lide.beginLockedProfileAcceptance = (candidate) => {
    const semanticOperationId = "12345678-1234-4234-9234-123456789abc";
    const candidateDigestSha256 = "c".repeat(64);
    const profile = { ...candidate, semanticOperationId, deviceCreatedAt: "2026-08-14T12:00:00.000Z" };
    return { semanticOperationId, candidateDigestSha256, request: { ...candidate, semanticOperationId, candidateDigestSha256, profile } };
  };
  fixture.lide.finalizeLockedProfileAcceptance = (operation, calibration) => {
    installed = { operation, calibration };
    return { profileRevisionId: calibration.profileRevisionId, profileDigestSha256: calibration.profileDigestSha256, originMm: operation.request.profile.acquisitionRegion, areaMm: { width: 100, height: 130 } };
  };

  const preview = await fixture.watcher.runPositioningPreview();
  const prepared = await fixture.watcher.preparePositioningCalibration(preview.previewId);
  assert.equal(prepared.ok, true, prepared.error);
  assert.equal(prepared.candidate.profile.capabilityProof.requestedDpi, 1200);
  assert.equal(prepared.candidate.profile.capabilityProof.driverResolutionDpi, 1200);
  assert.equal(prepared.candidate.profile.capabilityProof.format, "TIFF");
  assert.equal(prepared.candidate.profile.capabilityProof.widthPx, 4724);
  assert.equal(prepared.candidate.profile.capabilityProof.heightPx, 6142);
  assert.equal(prepared.candidate.profile.capabilityProof.frameAssessment.accepted, true);
  assert.match(prepared.candidate.profile.capabilityProof.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(fixture.tempDir, "positioning-preview", preview.previewId, "profile-proof", "capability-proof.tif")), false);
  assert.equal(claims, 0);
  assert.equal(uploads, 0);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0);

  const committed = fixture.watcher.commitPositioningCalibration(preview.previewId, {
    profileRevisionId: "server-profile-revision-7",
    profileDigestSha256: "d".repeat(64),
  });
  assert.equal(committed.ok, true);
  assert.equal(installed.calibration.profileRevisionId, "server-profile-revision-7");
  assert.equal(installed.operation.request.profile.capabilityProof.sha256, prepared.candidate.profile.capabilityProof.sha256);
  assert.equal(fixture.watcher.commitPositioningCalibration(preview.previewId, { profileRevisionId: "different-revision" }).ok, false);
});

test("profile setup rejects wrong DPI and removes the disposable TIFF", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fixture.state.set({
    positioningPreview: {
      id: "preview-proof-failure",
      status: "detected",
      capture: { scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null } },
      cardCandidate: { cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 } },
      placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
    },
  });
  let proofPath;
  fixture.lide.scanCalibrationRegion = async (dir, region) => {
    fs.mkdirSync(dir, { recursive: true });
    proofPath = path.join(dir, "wrong-dpi.tif");
    await sharp({ create: { width: 1200, height: 1560, channels: 3, background: { r: 15, g: 75, b: 130 } } })
      .tiff({ compression: "none" })
      .withMetadata({ density: 600 })
      .toFile(proofPath);
    return { path: proofPath, appliedRegionMm: region, requestedDpi: 600, driverResolutionDpi: 600, helperVersion: helperIntegrity.HELPER_VERSION, scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null } };
  };
  const result = await fixture.watcher.preparePositioningCalibration("preview-proof-failure");
  assert.equal(result.ok, false);
  assert.match(result.error, /exact 1200 DPI/);
  assert.equal(fs.existsSync(proofPath), false);
  assert.equal(fixture.watcher.isRestartSafeForUpdate(), true);
});

test("1200-DPI profile proof rejects under-resolution, blank, and clipped TIFF frames", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fixture.state.set({
    positioningPreview: {
      id: "preview-proof-frame",
      status: "detected",
      capture: { scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null } },
      cardCandidate: { cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 } },
      placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
    },
  });
  const candidate = fixture.watcher.positioningCalibrationCandidate("preview-proof-frame").candidate;
  const capture = (proofPath) => ({
    path: proofPath,
    appliedRegionMm: { ...candidate.acquisitionRegion },
    requestedDpi: 1200,
    driverResolutionDpi: 1200,
    helperVersion: helperIntegrity.HELPER_VERSION,
    scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null },
  });
  const proofDir = path.join(fixture.tempDir, "proof-negative");
  const undersized = await writeCalibrationProof(proofDir, { name: "undersized.tif", width: 1200, height: 1560 });
  await assert.rejects(
    fixture.watcher.validateCalibrationProof(undersized, capture(undersized), candidate),
    /not an exact 1200-DPI/,
  );
  const blank = await writeCalibrationProof(proofDir, { name: "blank.tif", blank: true });
  await assert.rejects(
    fixture.watcher.validateCalibrationProof(blank, capture(blank), candidate),
    /Card edges could not be safely determined/,
  );
  const clipped = await writeCalibrationProof(proofDir, { name: "clipped.tif", clipped: true });
  await assert.rejects(
    fixture.watcher.validateCalibrationProof(clipped, capture(clipped), candidate),
    /too close to the hardware acquisition boundary/,
  );
});

test("mutable renderer state cannot forge a prepared capability proof", (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fixture.state.set({
    positioningPreview: {
      id: "forged-preview",
      status: "detected",
      capture: { scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null } },
      cardCandidate: { cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 } },
      placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
      calibrationCandidate: { capabilityProof: { sha256: "a".repeat(64), requestedDpi: 1200 } },
      verificationStatus: "verified_1200",
    },
  });
  let installed = false;
  fixture.lide.finalizeLockedProfileAcceptance = () => { installed = true; };
  const result = fixture.watcher.commitPositioningCalibration("forged-preview", { profileRevisionId: "forged-revision" });
  assert.equal(result.ok, false);
  assert.equal(installed, false);
});

test("profile submission is single-flight and blocks a new Preview until the exact operation returns", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fixture.state.set({
    scannerHealth: { status: "profile_unprovisioned" },
    positioningPreview: {
      id: "preview-submission",
      status: "detected",
      capture: { scanner: { model: "Canon LiDE 400", deviceId: "ica-preview", serial: null } },
      cardCandidate: { cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 } },
      placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
    },
  });
  const operation = {
    semanticOperationId: "12345678-1234-4234-9234-123456789abc",
    candidateDigestSha256: "c".repeat(64),
    request: {
      semanticOperationId: "12345678-1234-4234-9234-123456789abc",
      candidateDigestSha256: "c".repeat(64),
      profile: {
        deviceCreatedAt: "2026-08-14T12:00:00.000Z",
        capabilityProof: { sha256: "a".repeat(64), sizeBytes: 87_000_000 },
      },
    },
  };
  fixture.lide.resumeLockedProfileAcceptance = () => operation;
  fixture.lide.finalizeLockedProfileAcceptance = () => ({
    profileRevisionId: "profile-revision-7",
    profileDigestSha256: "d".repeat(64),
    originMm: { x: 22, y: 39 },
    areaMm: { width: 100, height: 130 },
  });
  let release;
  const first = fixture.watcher.submitPositioningCalibration("preview-submission", async () =>
    new Promise((resolve) => { release = resolve; }));
  for (let attempt = 0; attempt < 20 && !release; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.watcher.submitPositioningCalibration("preview-submission", async () => ({ ok: true }))).code, "profile_acceptance_in_flight");
  assert.equal((await fixture.watcher.runPositioningPreview()).ok, false);
  release({ ok: true, body: { calibration: { profileRevisionId: "profile-revision-7", profileDigestSha256: "d".repeat(64) } } });
  assert.equal((await first).ok, true);
});

test("explicit Scan creates a JPEG derivative preview without uploading the TIFF", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: captureProvenance(),
  });
  let uploads = 0;
  fixture.server.uploadCaptureEvidence = async (sessionId, _deviceId, filePath, _provenance, binding) => {
    uploads++;
    return canonicalAcceptedResponse(sessionId, filePath, binding, { certId: "MV900" });
  };

  await fixture.watcher.pollTargetedCapture();
  const result = await fixture.watcher.scanActiveTarget();
  assert.equal(result.ok, true);
  assert.equal(uploads, 0, "preview creation must not cross the evidence-upload boundary");
  const entry = fixture.watcher.readTargetedQueue()[0];
  assert.equal(entry.phase, "preview_ready");
  assert.equal(entry.filePath, null, "the TIFF plaintext is unlinked before Accept is exposed");
  assert.equal(entry.artifact.encryption, "AES-256-GCM");
  assert.equal(entry.artifact.authenticatedMetadata.originalOperatorId, "operator-original-7");
  assert.equal(entry.artifact.authenticatedMetadata.cardJobId, "card-job-900");
  assert.equal(entry.artifact.authenticatedMetadata.profileRevisionId, "profile-revision-3");
  assert.equal(entry.artifact.authenticatedMetadata.revision, 1);
  assert.equal(entry.artifact.authenticatedMetadata.semanticOperationId, entry.semanticOperationId);
  const recovered = fixture.watcher.captureQueue.scratchPath(entry);
  await fixture.watcher.captureQueue.decryptToFile(entry.artifact, recovered);
  assert.equal(fs.readFileSync(recovered).subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])), true);
  fs.unlinkSync(recovered);
  const preview = fixture.watcher.previewData(entry.previewId);
  assert.equal(preview.ok, true);
  assert.match(preview.dataUrl, /^data:image\/jpeg;base64,/);
});

test("a locally invalid TIFF is encrypted into quarantine immediately and never reaches the network", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let sourcePath;
  fixture.lide.scan = async (dir) => {
    sourcePath = await writeStationTiff(dir, "invalid-master.tif");
    return { path: sourcePath, provenance: captureProvenance({ profileVersion: "wrong-profile" }) };
  };
  fixture.watcher.validateCaptureMaster = async () => { throw new Error("locked profile mismatch"); };
  let uploads = 0;
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: true, body: {} }; };

  await fixture.watcher.pollTargetedCapture();
  const result = await fixture.watcher.scanActiveTarget();
  assert.equal(result.ok, false);
  assert.equal(uploads, 0);
  assert.equal(fs.existsSync(sourcePath), false);
  const retained = fixture.watcher.readTargetedQueue()[0];
  assert.equal(retained.phase, "preview_error");
  assert.equal(retained.filePath, null);
  assert.equal(retained.artifact.encryption, "AES-256-GCM");
  assert.match(retained.previewError, /locked profile mismatch/);
});

test("Front and Back preview derivatives rotate 180 degrees without changing either TIFF master", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const width = 80;
  const height = 100;
  const raw = Buffer.alloc(width * height * 3, 0);
  const fill = (fromX, fromY, toX, toY, rgb) => {
    for (let y = fromY; y < toY; y++) for (let x = fromX; x < toX; x++) raw.set(rgb, (y * width + x) * 3);
  };
  fill(0, 0, 40, 50, [240, 20, 20]);
  fill(40, 50, 80, 100, [20, 20, 240]);

  for (const side of ["front", "back"]) {
    const masterPath = path.join(fixture.tempDir, `${side}.tif`);
    const previewPath = path.join(fixture.tempDir, `${side}.jpg`);
    await sharp(raw, { raw: { width, height, channels: 3 } }).tiff().toFile(masterPath);
    const sourceBefore = fs.readFileSync(masterPath);
    await fixture.watcher.createPreviewDerivative(masterPath, previewPath);
    const { data } = await sharp(previewPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const topLeft = data.subarray(0, 3);
    const bottomRight = data.subarray((width * height - 1) * 3, width * height * 3);
    assert.ok(topLeft[2] > topLeft[0], `${side} Preview top-left is the original bottom-right after rotation`);
    assert.ok(bottomRight[0] > bottomRight[2], `${side} Preview bottom-right is the original top-left after rotation`);
    assert.deepEqual(fs.readFileSync(masterPath), sourceBefore, `${side} TIFF master bytes remain untouched`);
  }
});

test("a frame that lacks four-side evidence margin is previewed but can only be rescanned, never accepted", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: captureProvenance({ scanAreaMm: { x: 12, y: 144, width: 100, height: 130 } }),
  });
  fixture.watcher.assessCaptureFrame = async () => ({
    accepted: false,
    reason: "Card is too close to the hardware acquisition boundary (1.0 mm; 4 mm required); rescan",
    evidenceMarginMm: { left: 1, top: 16, right: 12, bottom: 15 },
  });
  let uploads = 0;
  fixture.server.uploadCaptureEvidence = async (sessionId, _deviceId, filePath, _provenance, binding) => {
    uploads++;
    return canonicalAcceptedResponse(sessionId, filePath, binding, { certId: "MV900" });
  };

  await fixture.watcher.pollTargetedCapture();
  const scan = await fixture.watcher.scanActiveTarget();
  assert.equal(scan.ok, false);
  const previewId = fixture.state.get().activeCapture.previewId;
  assert.equal(fixture.watcher.readTargetedQueue()[0].phase, "preview_error");
  assert.equal(fixture.watcher.previewData(previewId).ok, true, "unsafe operator preview remains reviewable");
  assert.equal((await fixture.watcher.acceptPreview(previewId)).ok, false, "unsafe frame cannot cross the authoritative upload boundary");
  assert.equal(uploads, 0);
  const prior = fixture.watcher.activeTargetEntry();
  assert.equal((await fixture.watcher.rescanPreview(previewId)).ok, true);
  const fresh = fixture.watcher.readTargetedQueue()[0];
  assert.equal(fresh.phase, "awaiting_scan");
  assert.notEqual(fresh.captureAuthorisationId, prior.captureAuthorisationId);
  assert.notEqual(fresh.semanticOperationId, prior.semanticOperationId);
  assert.ok(fresh.revision > prior.revision);
  const quarantinedPrior = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === prior.queueEntryId);
  assert.equal(quarantinedPrior.lifecycleState, "QUARANTINED");
  assert.equal(quarantinedPrior.disposition, null, "local Rescan must not fabricate a server disposition");
  assert.equal(uploads, 0);
});

test("fresh Rescan authorisation cannot change session or original operator provenance", async (t) => {
  for (const [field, changed] of [
    ["sessionId", "different-session"],
    ["originalOperatorId", "different-operator"],
    ["originalOperatorRole", "PARTNER_OWNER"],
    ["capturePurpose", "DIFFERENT_PURPOSE"],
  ]) {
    await t.test(field, async (subtest) => {
      const fixture = isolatedTargetedWatcher(subtest);
      configureClaimedStation(fixture);
      fixture.lide.scan = async (dir) => ({
        path: await writeStationTiff(dir),
        provenance: captureProvenance(),
      });
      await fixture.watcher.pollTargetedCapture();
      await fixture.watcher.scanActiveTarget();
      const current = fixture.watcher.activeTargetEntry();
      const previewId = current.previewId;
      fixture.server.requestRescanAuthorisation = async () => ({
        ok: true,
        body: {
          capture: claimedTarget({
            id: field === "sessionId" ? changed : current.sessionId,
            certificateNumber: current.certId,
            side: current.side,
            cardJobId: current.cardJobId,
            profileRevisionId: current.profileRevisionId,
            tenantId: current.tenantId,
            locationId: current.locationId,
            stationId: current.stationCredentialId,
            workstationId: current.workstationId,
            originalOperatorId: field === "originalOperatorId" ? changed : current.originalOperatorId,
            originalOperatorRole: field === "originalOperatorRole" ? changed : current.originalOperatorRole,
            capturePurpose: field === "capturePurpose" ? changed : current.capturePurpose,
            captureAuthorisationId: `${current.captureAuthorisationId}-fresh`,
            semanticOperationId: crypto.randomUUID(),
            revision: current.revision + 1,
          }),
        },
      });

      const result = await fixture.watcher.rescanPreview(previewId);
      assert.equal(result.ok, false);
      assert.match(result.error, /changed the pinned|not bound to a SCANNER_OPERATOR|not authoritative card capture/);
      const live = fixture.watcher.activeTargetEntry();
      assert.equal(live.queueEntryId, current.queueEntryId);
      assert.equal(live.phase, current.phase);
      assert.equal(live[field], current[field]);
      assert.notEqual(
        fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === current.queueEntryId)?.lifecycleState,
        "QUARANTINED",
      );
    });
  }
});

test("rapid Scan clicks start exactly one physical capture", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let scans = 0;
  let resolveScan;
  fixture.lide.scan = async (dir) => {
    scans++;
    await new Promise((resolve) => { resolveScan = resolve; });
    return { path: await writeStationTiff(dir), provenance: captureProvenance() };
  };

  await fixture.watcher.pollTargetedCapture();
  const first = fixture.watcher.scanActiveTarget();
  for (let attempt = 0; attempt < 20 && !resolveScan; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scans, 1);
  assert.equal((await fixture.watcher.scanActiveTarget()).ok, false, "double Scan must be single-flight before native capture completes");
  resolveScan();
  assert.equal((await first).ok, true);
  assert.equal(scans, 1);
});

test("periodic health polling never opens ImageCaptureCore during an operator capture action", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  let healthCalls = 0;
  fixture.lide.health = async () => { healthCalls++; return { status: "ready" }; };
  fixture.watcher.targetCaptureInFlight = true;
  const health = await fixture.watcher.refreshScannerHealth();
  assert.equal(healthCalls, 0);
  assert.equal(health.status, "ready");
});

test("an already-authorised encrypted upload resumes after shift logout but no new target can be claimed", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: captureProvenance(),
  });
  let claims = 0;
  let uploads = 0;
  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  const prepared = fixture.watcher.activeTargetEntry();
  fixture.watcher.addTargetedPending({ ...prepared, phase: "upload", lifecycleState: "PENDING_UPLOAD" });
  fixture.server.claimNextCapture = async () => { claims++; return { ok: true, body: { capture: null } }; };
  fixture.server.hasToken = () => false;
  fixture.server.getCaptureStatus = async () => ({ ok: true, body: { accepted: false, capture: { state: "claimed" } } });
  fixture.server.uploadCaptureEvidence = async (sessionId, _deviceId, filePath, _provenance, binding) => {
    uploads++;
    return canonicalAcceptedResponse(sessionId, filePath, binding, { certId: "MV900" });
  };

  const recovered = await fixture.watcher.pollTargetedCapture();
  assert.equal(recovered.resumed, true);
  assert.equal(uploads, 1, "station-only recovery delivers the existing authorisation");
  assert.equal(claims, 0, "shift logout cannot claim a new target");
  assert.equal((await fixture.watcher.pollTargetedCapture()).humanRequired, true);
  assert.equal(claims, 0);
});

test("startup sweep encrypts and quarantines unmatched TIFF and JPEG plaintext", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const orphanDir = path.join(fixture.tempDir, "capture-staging", "orphaned");
  const tiff = await writeStationTiff(orphanDir, "abandoned.tif");
  const jpeg = await writePositioningJpeg(orphanDir, "abandoned.jpg");
  const inboxTiff = await writeStationTiff(path.join(fixture.tempDir, "inbox"), "legacy-inbox.tif");
  const rejectedTiff = await writeStationTiff(path.join(fixture.tempDir, "rejected"), "legacy-rejected.tif");
  await fixture.watcher.sweepAbandonedCapturePlaintext();
  for (const plaintext of [tiff, jpeg, inboxTiff, rejectedTiff]) assert.equal(fs.existsSync(plaintext), false);
  const quarantined = fixture.watcher.captureQueue.entries().filter((entry) => entry.lifecycleState === "QUARANTINED");
  assert.equal(quarantined.length, 4);
  assert.equal(quarantined.every((entry) => entry.artifact || entry.previewArtifact), true);
  assert.equal(quarantined.every((entry) => entry.disposition === null), true, "unmatched evidence awaits explicit server/support disposition");
});

test("capture roots are repaired to app-private directory permissions", (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fs.chmodSync(fixture.tempDir, 0o755);
  for (const name of ["inbox", "processed", "failed", "rejected", "discarded", "capture-staging", "positioning-preview"]) {
    const directory = path.join(fixture.tempDir, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.chmodSync(directory, 0o755);
  }
  fixture.watcher.prepareCaptureDirectories();
  assert.equal(fs.statSync(fixture.tempDir).mode & 0o777, 0o700);
  for (const name of ["inbox", "processed", "failed", "rejected", "discarded", "capture-staging", "positioning-preview"]) {
    assert.equal(fs.statSync(path.join(fixture.tempDir, name)).mode & 0o777, 0o700);
  }
});

test("server dispositions are exhaustive, tuple-bound, and never timer-delete unresolved evidence", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const stillRequired = await sealedCandidate(fixture, { id: "capture-still-required" });
  assert.equal(fixture.watcher.applyServerDisposition(stillRequired, {
    disposition: "STILL_REQUIRED",
    dispositionBinding: fixture.watcher.dispositionBinding(stillRequired),
  }), null);
  for (const disposition of ["SUPERSEDED", "CANCELLED", "INVALID_TARGET", "REQUIRES_FIX"]) {
    const stored = await sealedCandidate(fixture, { id: `capture-${disposition.toLowerCase().replaceAll("_", "-")}` });
    fixture.watcher.applyServerDisposition(stored, {
      disposition,
      dispositionBinding: fixture.watcher.dispositionBinding(stored),
    });
    const retained = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === stored.queueEntryId);
    assert.equal(retained.lifecycleState, "QUARANTINED");
    assert.equal(retained.disposition, disposition);
    assert.equal(retained.resolvedAt, undefined);
  }
  const accepted = await sealedCandidate(fixture, { id: "capture-accepted", certificateNumber: "MV905" });
  assert.equal(fixture.watcher.applyServerDisposition(accepted, {
    disposition: "ACCEPTED",
    dispositionBinding: fixture.watcher.dispositionBinding(accepted),
    capture: { certificateNumber: "MV905" },
  }).ok, true);
  const resolved = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === accepted.queueEntryId);
  assert.equal(resolved.lifecycleState, "RESOLVED");
  assert.equal(resolved.disposition, "ACCEPTED");

  const mismatched = await sealedCandidate(fixture, { id: "capture-mismatched-disposition" });
  const forgedBinding = { ...fixture.watcher.dispositionBinding(mismatched), side: "back" };
  const mismatchResult = fixture.watcher.applyServerDisposition(mismatched, {
    disposition: "ACCEPTED",
    dispositionBinding: forgedBinding,
  });
  assert.equal(mismatchResult.retryPending, true);
  const stillEncrypted = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === mismatched.queueEntryId);
  assert.equal(stillEncrypted.lifecycleState, "NEEDS_RECONCILIATION");
  assert.equal(stillEncrypted.disposition, null);
  assert.ok(stillEncrypted.artifact);
  assert.ok(fixture.watcher.targetedPendingUploadCount() >= 5, "heartbeat custody count includes preview, reconciliation, and quarantine artifacts");
});

test("a crash after ACCEPTED is finalized on restart without re-uploading evidence", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const candidate = await sealedCandidate(fixture, { id: "capture-accepted-crash", certificateNumber: "MV906" });
  const encryptedPath = fixture.watcher.captureQueue.artifactPath(candidate.artifact);
  const originalUpsert = fixture.watcher.captureQueue.upsert.bind(fixture.watcher.captureQueue);
  let writes = 0;
  fixture.watcher.captureQueue.upsert = (entry) => {
    writes++;
    if (writes === 2) throw new Error("injected crash before RESOLVED index commit");
    return originalUpsert(entry);
  };

  const interrupted = fixture.watcher.applyServerDisposition(candidate, {
    disposition: "ACCEPTED",
    dispositionBinding: fixture.watcher.dispositionBinding(candidate),
    capture: { certificateNumber: "MV906" },
  });
  fixture.watcher.captureQueue.upsert = originalUpsert;
  assert.equal(interrupted.retryPending, true);
  const accepted = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === candidate.queueEntryId);
  assert.equal(accepted.lifecycleState, "ACCEPTED");
  assert.equal(fs.existsSync(encryptedPath), false, "ACCEPTED authorises ciphertext destruction before resolution commit");

  assert.equal(fixture.watcher.finalizeAcceptedCaptures(), 1, "startup finalizer must converge ACCEPTED to RESOLVED");
  const resolved = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === candidate.queueEntryId);
  assert.equal(resolved.lifecycleState, "RESOLVED");
  assert.equal(resolved.disposition, "ACCEPTED");
  assert.equal(resolved.artifact, null);
  assert.equal(fixture.watcher.targetedPendingUploadCount(), 0);
});

test("disk pressure pauses target claims before server or scanner work", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let claims = 0;
  fixture.server.claimNextCapture = async () => { claims++; return { ok: true, body: { capture: claimedTarget() } }; };
  fixture.watcher.captureStorageStatus = () => ({ ok: false, availableBytes: 1, minimumBytes: 2 });
  const result = await fixture.watcher.pollTargetedCapture();
  assert.equal(result.storagePressure, true);
  assert.equal(claims, 0);
  assert.equal(fixture.state.get().state, "storage_pressure");
});

test("health polling shares and rate-limits ImageCaptureCore sessions so the scanner cannot make itself busy", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  let healthCalls = 0;
  fixture.lide.health = async () => {
    healthCalls++;
    return { status: "profile_unprovisioned" };
  };
  const first = await fixture.watcher.refreshScannerHealth();
  const second = await fixture.watcher.refreshScannerHealth();
  assert.equal(first.status, "profile_unprovisioned");
  assert.equal(second.status, "profile_unprovisioned");
  assert.equal(healthCalls, 1, "rapid target polls must reuse the current physical health result");
});

test("a preview pins its exact card-side target until Accept, Rescan, or expiry", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  const targets = [
    claimedTarget({ id: "front-session", certificateNumber: "MV900", side: "front" }),
    claimedTarget({ id: "other-card-session", certificateNumber: "MV901", side: "back" }),
  ];
  let claims = 0;
  fixture.server.claimNextCapture = async () => ({ ok: true, body: { capture: targets[claims++] || null } });
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: captureProvenance(),
  });

  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  const before = fixture.state.get().activeCapture;
  const repeatedPoll = await fixture.watcher.pollTargetedCapture();
  assert.equal(repeatedPoll.resumed, true);
  assert.equal(claims, 1, "the station must not claim a different card while a preview is open");
  assert.deepEqual(
    { id: fixture.state.get().activeCapture.id, certId: fixture.state.get().activeCapture.certId, side: fixture.state.get().activeCapture.side },
    { id: before.id, certId: "MV900", side: "front" },
  );
});

test("stale or duplicate Accept and Rescan during upload cannot cross card sides or duplicate evidence", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let scans = 0;
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir, `master-${++scans}.tif`),
    provenance: captureProvenance(),
  });
  let uploads = 0;
  let resolveUpload;
  let uploadArguments;
  fixture.server.uploadCaptureEvidence = async (...args) => {
    uploads++;
    uploadArguments = args;
    return new Promise((resolve) => { resolveUpload = resolve; });
  };

  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  const stalePreviewId = fixture.state.get().activeCapture.previewId;
  assert.equal((await fixture.watcher.rescanPreview(stalePreviewId)).ok, true);
  assert.equal((await fixture.watcher.acceptPreview(stalePreviewId)).ok, false, "a discarded preview cannot be accepted");
  assert.equal(uploads, 0);

  await fixture.watcher.scanActiveTarget();
  const currentPreviewId = fixture.state.get().activeCapture.previewId;
  const accepting = fixture.watcher.acceptPreview(currentPreviewId);
  for (let attempt = 0; attempt < 100 && !resolveUpload; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(typeof resolveUpload, "function", "Accept must enter the one permitted upload");
  assert.equal((await fixture.watcher.acceptPreview(currentPreviewId)).ok, false, "double Accept must be single-flight");
  assert.equal((await fixture.watcher.rescanPreview(currentPreviewId)).ok, false, "Rescan must be blocked during upload");
  resolveUpload(canonicalAcceptedResponse(uploadArguments[0], uploadArguments[2], uploadArguments[4], { certId: "MV900" }));
  assert.equal((await accepting).ok, true);
  assert.equal(uploads, 1);
  assert.equal(scans, 2, "only the explicit Rescan starts a second physical scan");
});

test("an expired preview is never uploaded or rescanned", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: captureProvenance(),
  });
  let uploads = 0;
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: true, body: {} }; };

  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  fixture.server.getCaptureStatus = async () => ({ ok: true, body: { accepted: false, capture: { state: "expired" } } });
  const previewId = fixture.state.get().activeCapture.previewId;
  assert.equal((await fixture.watcher.acceptPreview(previewId)).ok, false);
  assert.equal((await fixture.watcher.rescanPreview(previewId)).ok, false);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0, "an expired preview releases the station but stays non-authoritative");
  assert.equal(fixture.state.get().activeCapture, null);
  assert.equal(uploads, 0);
});

test("accepting front leaves it untouched when a later back preview is rescanned", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  const targets = [
    claimedTarget({ id: "front-session", certificateNumber: "MV902", side: "front" }),
    claimedTarget({ id: "back-session", certificateNumber: "MV902", side: "back" }),
  ];
  let claimIndex = 0;
  let frontPath;
  let scans = 0;
  let uploads = 0;
  fixture.server.claimNextCapture = async () => ({ ok: true, body: { capture: targets[claimIndex++] || null } });
  fixture.lide.scan = async (dir) => {
    const side = fixture.state.get().activeCapture.side;
    const filePath = await writeStationTiff(dir, `${side}-${++scans}.tif`);
    if (side === "front") frontPath = filePath;
    return { path: filePath, provenance: captureProvenance() };
  };
  fixture.server.uploadCaptureEvidence = async (sessionId, _deviceId, filePath, _provenance, binding) => {
    uploads++;
    return canonicalAcceptedResponse(sessionId, filePath, binding, { certId: "MV902", card_registered: uploads === 2 });
  };

  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  assert.equal((await fixture.watcher.acceptPreview(fixture.state.get().activeCapture.previewId)).ok, true);
  assert.deepEqual(fixture.state.get().lastAcceptedCapture?.side, "front");
  assert.equal(fixture.state.get().lastAcceptedCapture?.certId, "MV902");
  assert.equal(fs.existsSync(frontPath), false, "accepted evidence never leaves a plaintext archive");
  const acceptedFront = fixture.watcher.captureQueue.entries().find((entry) => entry.sessionId === "front-session");
  assert.equal(acceptedFront.lifecycleState, "RESOLVED");
  assert.equal(acceptedFront.disposition, "ACCEPTED");
  assert.match(acceptedFront.evidenceDigest, /^[a-f0-9]{64}$/);

  await fixture.watcher.pollTargetedCapture();
  await fixture.watcher.scanActiveTarget();
  assert.equal((await fixture.watcher.rescanPreview(fixture.state.get().activeCapture.previewId)).ok, true);
  assert.equal(uploads, 1, "only accepted front was uploaded");
  assert.deepEqual(
    fixture.watcher.captureQueue.entries().find((entry) => entry.sessionId === "front-session"),
    acceptedFront,
    "back Rescan never alters accepted front provenance",
  );
  assert.equal(fixture.state.get().activeCapture.side, "back");
  assert.equal(fixture.watcher.readTargetedQueue()[0].phase, "awaiting_scan");

  await fixture.watcher.scanActiveTarget();
  assert.equal((await fixture.watcher.acceptPreview(fixture.state.get().activeCapture.previewId)).ok, true);
  assert.equal(uploads, 2);
  assert.equal(fixture.state.get().lastAcceptedCapture?.side, "back");
  assert.equal(fixture.state.get().lastAcceptedCapture?.cardRegistered, true);
});

test("scanner client preserves a station's legacy ingest host for target-session routes", () => {
  const client = require("../lib/server-client");
  assert.equal(
    client._private.baseFromLegacyIngestUrl("https://scanner.example.test/mintvault/api/admin/scan-ingest?legacy=1"),
    "https://scanner.example.test/mintvault"
  );
  assert.equal(
    client._private.baseFromLegacyIngestUrl("https://scanner.example.test/api/admin/scan-ingest"),
    "https://scanner.example.test"
  );
});

test("packaged Scanner ignores API and legacy-ingest origin overrides before credential use", (t) => {
  const priorBase = process.env.MINTVAULT_API_BASE;
  const priorIngest = process.env.MINTVAULT_INGEST_URL;
  const priorToken = process.env.SCANNER_API_TOKEN;
  process.env.MINTVAULT_API_BASE = "http://127.0.0.1:65534/credential-collector";
  process.env.MINTVAULT_INGEST_URL = "https://attacker.invalid/api/admin/scan-ingest";
  process.env.SCANNER_API_TOKEN = "must-not-leave-packaged-runtime";
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE; else process.env.MINTVAULT_API_BASE = priorBase;
    if (priorIngest === undefined) delete process.env.MINTVAULT_INGEST_URL; else process.env.MINTVAULT_INGEST_URL = priorIngest;
    if (priorToken === undefined) delete process.env.SCANNER_API_TOKEN; else process.env.SCANNER_API_TOKEN = priorToken;
    delete require.cache[clientPath];
  });

  assert.equal(client.API_BASE, "http://127.0.0.1:65534/credential-collector", "unpackaged harness keeps its explicit override");
  assert.equal(client.configureRuntime({ isPackaged: true }), "https://mintvaultuk.com");
  assert.equal(client.API_BASE, "https://mintvaultuk.com");
  assert.deepEqual(client._private.legacyAuthHeaders(), {}, "packaged runtime cannot load or transmit a legacy token");
});

test("queue recovery signs without the current human while new target claims remain human-bound", async (t) => {
  const seen = [];
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.includes("/next?") ? { capture: null } : { accepted: false, capture: { state: "claimed" } }));
  });
  await listen(httpServer);
  t.after(() => close(httpServer));
  const priorBase = process.env.MINTVAULT_API_BASE;
  process.env.MINTVAULT_API_BASE = `http://127.0.0.1:${httpServer.address().port}`;
  const stationIdentity = require("../lib/station-identity");
  const originals = {
    hasActiveStationSession: stationIdentity.hasActiveStationSession,
    hasActiveStationIdentity: stationIdentity.hasActiveStationIdentity,
    signStoredRequest: stationIdentity.signStoredRequest,
  };
  stationIdentity.hasActiveStationSession = () => true;
  stationIdentity.hasActiveStationIdentity = () => true;
  stationIdentity.signStoredRequest = (payload) => { seen.push(payload); return { "x-test-signature": "signed" }; };
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    Object.assign(stationIdentity, originals);
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE; else process.env.MINTVAULT_API_BASE = priorBase;
    delete require.cache[clientPath];
  });

  await client.getCaptureStatus("capture-auth-1", "station-a");
  await client.claimNextCapture("station-a", "station-a");
  assert.equal(seen[0].includeOperatorSession, false, "queued evidence never adopts the current shift operator");
  assert.equal(seen[1].includeOperatorSession, true, "new target claims retain dual human/station authority");
});

test("scanner client rejects a non-TIFF before attempting authoritative upload", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-not-tiff-"));
  try {
    const source = path.join(tempDir, "not-a-tiff.tif");
    fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = require("../lib/server-client");
    assert.throws(() => client._private.assertTiffMaster(source), /not TIFF-signature data/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("targeted recovery resolves only a canonical tuple-bound ACCEPTED disposition", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const candidate = await sealedCandidate(fixture, { id: "session-accepted", certificateNumber: "MV700" });
  fixture.server.getCaptureStatus = async () => ({
    ok: true,
    body: {
      disposition: "ACCEPTED",
      disposition_binding: fixture.watcher.dispositionBinding(candidate),
      capture: { state: "captured", certificateNumber: "MV700" },
    },
  });
  fixture.server.uploadCaptureEvidence = async () => { throw new Error("must not re-upload accepted evidence"); };
  const result = await fixture.watcher.uploadTargetedCapture(candidate);
  assert.equal(result.ok, true);
  assert.equal(fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === candidate.queueEntryId).lifecycleState, "RESOLVED");
});

test("targeted upload reconciles a timeout before any retry can duplicate evidence", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const candidate = await sealedCandidate(fixture, { id: "session-timeout", certificateNumber: "MV701", side: "back" });
  let uploads = 0;
  fixture.server.getCaptureStatus = async () => ({
    ok: true,
    body: uploads ? {
      disposition: "ACCEPTED",
      disposition_binding: fixture.watcher.dispositionBinding(candidate),
      capture: { state: "captured", certificateNumber: "MV701" },
    } : { capture: { state: "claimed" } },
  });
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: false, status: 504, body: { error: "server slow — no reply" } }; };
  const result = await fixture.watcher.uploadTargetedCapture(candidate);
  assert.equal(result.ok, true);
  assert.equal(uploads, 1, "ambiguous timeout must be reconciled before a second POST");
});

test("empty 2xx and legacy accepted booleans retain ciphertext in NEEDS_RECONCILIATION", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  const candidate = await sealedCandidate(fixture, { id: "session-ambiguous-2xx", certificateNumber: "MV702" });
  let uploads = 0;
  fixture.server.uploadCaptureEvidence = async () => { uploads++; return { ok: true, status: 204, body: {} }; };
  fixture.server.getCaptureStatus = async () => ({
    ok: true,
    body: uploads
      ? { accepted: true, capture: { state: "captured", certificateNumber: "MV702" } }
      : { accepted: false, capture: { state: "claimed", certificateNumber: "MV702" } },
  });

  const result = await fixture.watcher.uploadTargetedCapture(candidate);
  assert.equal(result.ok, false);
  assert.equal(result.retryPending, true);
  assert.equal(uploads, 1);
  const retained = fixture.watcher.captureQueue.entries().find((entry) => entry.queueEntryId === candidate.queueEntryId);
  assert.equal(retained.lifecycleState, "NEEDS_RECONCILIATION");
  assert.equal(retained.disposition, null);
  assert.ok(retained.artifact);
  assert.equal(fs.existsSync(fixture.watcher.captureQueue.artifactPath(retained.artifact)), true);
});

test("LiDE controller requires station jig provisioning before it can request a capture", async (t) => {
  if (process.platform !== "darwin") t.skip("ImageCaptureCore is macOS-only");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-lide-controller-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const priorBase = process.env.MINTVAULT_SCANS_DIR;
  const priorX = process.env.MINTVAULT_LIDE_SCAN_X_MM;
  const priorY = process.env.MINTVAULT_LIDE_SCAN_Y_MM;
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  delete process.env.MINTVAULT_LIDE_SCAN_X_MM;
  delete process.env.MINTVAULT_LIDE_SCAN_Y_MM;
  const controllerPath = require.resolve("../lib/lide400-controller");
  delete require.cache[controllerPath];
  const controller = require("../lib/lide400-controller");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_SCANS_DIR; else process.env.MINTVAULT_SCANS_DIR = priorBase;
    if (priorX === undefined) delete process.env.MINTVAULT_LIDE_SCAN_X_MM; else process.env.MINTVAULT_LIDE_SCAN_X_MM = priorX;
    if (priorY === undefined) delete process.env.MINTVAULT_LIDE_SCAN_Y_MM; else process.env.MINTVAULT_LIDE_SCAN_Y_MM = priorY;
    delete require.cache[controllerPath];
  });

  const health = await controller.health();
  assert.equal(health.profileVersion, "mintvault-canon-lide-400-v3");
  assert.match(String(health.status), /disconnected|profile_unprovisioned|control_unavailable|busy|ready/);
  await assert.rejects(() => controller.scan(tempDir), /jig origin is not provisioned/);
});

test("LiDE calibration is bounded to a sufficiently large physical platen region", () => {
  const controller = require("../lib/lide400-controller");
  assert.deepEqual(controller._private.calibrationRegion({ x: 22, y: 39, width: 100, height: 130 }), {
    x: 22, y: 39, width: 100, height: 130,
  }, "the shipped locked profile's exact ROI must reach ImageCaptureCore calibration");
  assert.deepEqual(controller._private.calibrationRegion({ x: 12, y: 108, width: 120, height: 160 }), {
    x: 12, y: 108, width: 120, height: 160,
  });
  assert.throws(
    () => controller._private.calibrationRegion({ x: 12, y: 108, width: 99.9, height: 129.9 }),
    /at least 100 x 130 mm/
  );
  assert.throws(
    () => controller._private.calibrationRegion({ x: 120, y: 108, width: 120, height: 160 }),
    /exceeds the physical platen/
  );
});

test("calibration analysis reports a conservative standard-card physical candidate from a hardware frame", () => {
  const { detectCardBounds } = require("../calibrate-lide");
  const width = 1200;
  const height = 1600;
  const raw = Buffer.alloc(width * height * 3, 245);
  // Presentation raster: a physical X=76/Y=102 card is rotated 180°.
  const left = 290;
  const top = 380;
  const cardWidth = 630;
  const cardHeight = 880;
  for (let y = top; y < top + cardHeight; y++) {
    for (let x = left; x < left + cardWidth; x++) {
      const offset = (y * width + x) * 3;
      raw[offset] = 20;
      raw[offset + 1] = 80;
      raw[offset + 2] = 150;
    }
  }
  const candidate = detectCardBounds(raw, width, height, { x: 48, y: 68, width: 120, height: 160 });
  assert.ok(candidate, "expected a card candidate with substantial surrounding platen background");
  assert.ok(Math.abs(candidate.cardBoundsMm.x - 76) < 0.25);
  assert.ok(Math.abs(candidate.cardBoundsMm.y - 102) < 0.25);
  assert.ok(Math.abs(candidate.cardBoundsMm.width - 63) < 0.25);
  assert.ok(Math.abs(candidate.cardBoundsMm.height - 88) < 0.25);
  assert.ok(candidate.surroundingBackgroundMm.left > 20 && candidate.surroundingBackgroundMm.top > 30);
});

test("station-side frame safety refuses an edge-touching TIFF before it exposes Accept", async (t) => {
  const { assessLide400CardFrame } = require("../lib/lide400-card-frame");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-frame-safety-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const frameWidth = 900;
  const frameHeight = 1200;
  const raw = Buffer.alloc(frameWidth * frameHeight * 3, 245);
  for (let y = 160; y < 1040; y++) {
    for (let x = 0; x < 630; x++) {
      const offset = (y * frameWidth + x) * 3;
      raw[offset] = 20;
      raw[offset + 1] = 80;
      raw[offset + 2] = 150;
    }
  }
  const pathname = path.join(tempDir, "edge-touching.tif");
  await sharp(raw, { raw: { width: frameWidth, height: frameHeight, channels: 3 } }).tiff().withMetadata({ density: 1200 }).toFile(pathname);
  const assessment = await assessLide400CardFrame(pathname, { width: 100, height: 130 });
  assert.equal(assessment.accepted, false);
  assert.match(assessment.reason, /acquisition boundary/);
});
