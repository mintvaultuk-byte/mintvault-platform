const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test("scanner client retains exact TIFF bytes in the bounded compatibility path when direct staging is unavailable", async (t) => {
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
  process.env.MINTVAULT_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE;
    else process.env.MINTVAULT_API_BASE = priorBase;
    delete require.cache[clientPath];
  });

  await client.claimNextCapture("mintvault-station-a", "mac-mintvault-station-a");
  await client.renewCapture("session-123", "mac-mintvault-station-a");
  await client.uploadCaptureEvidence("session-123", "mac-mintvault-station-a", source, {
    profileVersion: "mintvault-canon-lide-400-v3",
    scannerManufacturer: "Canon",
    scannerModel: "CanoScan LiDE 400",
  });
  await client.getCaptureStatus("session-123", "mac-mintvault-station-a");

  assert.equal(requests.length, 5);
  const grant = requests[2];
  const upload = requests[3];
  for (const request of [upload]) {
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(request.body.includes(tiff), true, "original TIFF bytes must be sent unchanged");
    assert.match(request.body.toString("latin1"), /Content-Type: image\/tiff/);
    assert.doesNotMatch(request.body.toString("latin1"), /Content-Type: image\/jpeg/);
  }
  assert.equal(requests[0].url, "/api/admin/scanner/capture-sessions/next?workstation_id=mintvault-station-a&device_id=mac-mintvault-station-a");
  assert.equal(requests[1].url, "/api/admin/scanner/capture-sessions/session-123/keepalive");
  assert.equal(grant.url, "/api/admin/scanner/capture-sessions/session-123/staged-upload");
  assert.match(grant.body.toString("utf8"), /sha256/);
  assert.equal(requests[3].url, "/api/admin/scanner/capture-sessions/session-123/evidence");
  assert.match(requests[3].body.toString("utf8"), /mintvault-canon-lide-400-v3/);
  assert.doesNotMatch(requests[3].url, /\/certs\/.*\/image/);
  assert.equal(requests[4].url, "/api/admin/scanner/capture-sessions/session-123?device_id=mac-mintvault-station-a");
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
  process.env.MINTVAULT_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE;
    else process.env.MINTVAULT_API_BASE = priorBase;
    delete require.cache[clientPath];
  });

  const progress = [];
  const result = await client.uploadCaptureEvidence(
    "session-123",
    "mac-mintvault-station-a",
    source,
    { profileVersion: "mintvault-canon-lide-400-v3" },
    { onProgress: (event) => progress.push(event) },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(stagedBytes, tiff, "the R2 PUT receives the unmodified TIFF bytes");
  assert.deepEqual(
    progress.map((event) => event.phase),
    ["queued", "uploading", "uploaded", "server_validating"],
    "direct staging must publish byte progress before server validation",
  );
  assert.equal(progress[1].bytesSent, tiff.length);
  assert.equal(progress[1].totalBytes, tiff.length);
  assert.equal(progress[3].bytesSent, tiff.length);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "/api/admin/scanner/capture-sessions/session-123/staged-upload");
  assert.match(requests[0].body.toString("utf8"), /sha256/);
  assert.equal(requests[1].method, "PUT");
  assert.equal(requests[1].url, "/opaque-server-staging-key");
  assert.equal(requests[2].url, "/api/admin/scanner/capture-sessions/session-123/staged-upload/stage-123/finalise");
  assert.equal(requests[2].body.includes(tiff), false, "finalisation carries only the opaque staging identity");
  assert.equal(requests.some((request) => /^multipart\/form-data/.test(String(request.headers["content-type"] || ""))), false);
});

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
  const stationClient = require("../lib/station-client");
  const lide = require("../lib/lide400-controller");
  const originals = {
    claimNextCapture: server.claimNextCapture,
    renewCapture: server.renewCapture,
    getCaptureStatus: server.getCaptureStatus,
    prepareCaptureEvidenceUpload: server.prepareCaptureEvidenceUpload,
    finalisePreparedCaptureEvidenceUpload: server.finalisePreparedCaptureEvidenceUpload,
    finaliseStagedCaptureEvidence: server.finaliseStagedCaptureEvidence,
    uploadCaptureEvidence: server.uploadCaptureEvidence,
    failCapture: server.failCapture,
    hasToken: server.hasToken,
    scan: lide.scan,
    positioningPreview: lide.positioningPreview,
    persistJigOrigin: lide.persistJigOrigin,
    persistCalibrationSaveState: lide.persistCalibrationSaveState,
    deviceId: lide.deviceId,
    health: lide.health,
    saveCalibration: stationClient.saveCalibration,
  };
  for (const dir of ["capture-staging", "processed", "failed", "discarded"]) {
    fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
  }
  state.set({ state: "idle", activeCapture: null, scannerHealth: { status: "ready" }, lastError: null });
  t.after(() => {
    Object.assign(server, {
      claimNextCapture: originals.claimNextCapture,
      renewCapture: originals.renewCapture,
      getCaptureStatus: originals.getCaptureStatus,
      prepareCaptureEvidenceUpload: originals.prepareCaptureEvidenceUpload,
      finalisePreparedCaptureEvidenceUpload: originals.finalisePreparedCaptureEvidenceUpload,
      finaliseStagedCaptureEvidence: originals.finaliseStagedCaptureEvidence,
      uploadCaptureEvidence: originals.uploadCaptureEvidence,
      failCapture: originals.failCapture,
      hasToken: originals.hasToken,
    });
    lide.scan = originals.scan;
    lide.positioningPreview = originals.positioningPreview;
    lide.persistJigOrigin = originals.persistJigOrigin;
    lide.persistCalibrationSaveState = originals.persistCalibrationSaveState;
    lide.deviceId = originals.deviceId;
    lide.health = originals.health;
    stationClient.saveCalibration = originals.saveCalibration;
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    delete require.cache[watcherPath];
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const watcher = new Watcher();
  server.prepareCaptureEvidenceUpload = async (_sessionId, _deviceId, filePath, _provenance, options = {}) => {
    const stat = fs.statSync(filePath);
    options.onProgress?.({ phase: "queued", bytesSent: 0, totalBytes: stat.size });
    return { ok: true, status: 201, body: { transport: "direct", staging_id: "stage-test", expected_bytes: stat.size } };
  };
  server.finalisePreparedCaptureEvidenceUpload = async (_sessionId, _deviceId, filePath, _prepared, options = {}) => {
    const stat = fs.statSync(filePath);
    options.onProgress?.({ phase: "uploading", bytesSent: stat.size, totalBytes: stat.size });
    options.onProgress?.({ phase: "uploaded", bytesSent: stat.size, totalBytes: stat.size });
    options.onProgress?.({ phase: "server_validating", bytesSent: stat.size, totalBytes: stat.size });
    return { ok: true, body: { certId: "MV900" } };
  };
  server.finaliseStagedCaptureEvidence = async (_sessionId, _deviceId, _stagingId, options = {}) => {
    options.onProgress?.({ phase: "server_validating", bytesSent: 0, totalBytes: 0 });
    return { ok: true, body: { certId: "MV900" } };
  };
  // Unit scan fixtures are deliberately tiny synthetic TIFFs. The dedicated
  // card-frame tests cover boundary math; ordinary state-machine tests inject
  // a safe assessed frame so they remain about Scan/automatic-upload/Rescan behaviour.
  watcher.assessCaptureFrame = async () => ({ accepted: true, reason: null, evidenceMarginMm: { left: 8, top: 8, right: 8, bottom: 8 } });
  return { tempDir, watcher, state, server, stationClient, lide };
}

function claimedTarget(overrides = {}) {
  return {
    id: "capture-session-preview",
    certificateNumber: "MV900",
    side: "front",
    workstationId: "mintvault-station-a",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
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

async function writePositioningJpeg(dir, name = "placement-preview.jpg") {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 245, g: 245, b: 245 } } })
    .jpeg()
    .withMetadata({ density: 300 })
    .toFile(filePath);
  return filePath;
}

/**
 * Take a real placement Preview and pass its gate.
 *
 * SCAN now requires a live GREEN placement approval bound to the exact session and side, so every
 * test that reaches a physical capture has to go through the gate the operator goes through. Only
 * the two things that need real hardware or real pixels are stubbed — the scanner call and the
 * pixel analysis. Approval creation, its binding to session/side/card, and its consumption by the
 * capture all run for real, which is the point: these tests would otherwise prove that scanning
 * works in a world where the gate does not exist.
 */
async function passPlacementGate(fixture, cardBoundsMm = { x: 18.25, y: 20.55, width: 63.5, height: 88.9 }) {
  const { evaluatePlacement } = require("../../../shared/lide400-capture-profile.cjs");
  fixture.lide.placementPreview = async (dir) => ({
    path: await writePositioningJpeg(dir, "gate-preview.jpg"),
    sizeBytes: 1,
    originMm: { x: 20, y: 20 },
    areaMm: { x: 20, y: 20, width: 100, height: 130 },
    appliedRegionMm: { x: 20, y: 20, width: 100, height: 130 },
    requestedDpi: 300,
    driverResolutionDpi: 300,
    coordinateSpace: "imagecapturecore-scan-area-upright-raster-v1",
    rasterOrientation: 1,
    capturedAt: new Date().toISOString(),
    scanner: {},
  });
  fixture.watcher.analysePlacementPreview = async () => ({
    image: { width: 900, height: 1200, orientation: 1 },
    detected: { cardBoundsMm },
    verdict: evaluatePlacement(cardBoundsMm),
  });
  return fixture.watcher.runPlacementPreview();
}

async function waitForTestCondition(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let value = predicate();
  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = predicate();
  }
  assert.ok(value, `timed out waiting for ${label}`);
  return value;
}

function configureClaimedStation({ watcher, state, server, lide }) {
  server.hasToken = () => true;
  server.claimNextCapture = async () => ({ ok: true, body: { capture: claimedTarget() } });
  server.renewCapture = async () => ({ ok: true, body: { capture: claimedTarget() } });
  server.getCaptureStatus = async () => ({ ok: true, body: { accepted: false, capture: { state: "claimed" } } });
  lide.deviceId = () => "mac-mintvault-station-a";
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

test("positioning Preview is single-flight and can no longer persist local jig X/Y at all", async (t) => {
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
  });
  let persisted = null;
  fixture.lide.persistJigOrigin = (origin) => {
    persisted = origin;
    return { originMm: origin, areaMm: { width: 100, height: 130 }, profileVersion: "mintvault-canon-lide-400-v3" };
  };

  const first = fixture.watcher.runPositioningPreview();
  for (let attempt = 0; attempt < 20 && !releasePreview; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fixture.watcher.runPositioningPreview()).ok, false, "rapid Preview clicks cannot start two physical scans");
  releasePreview();
  assert.equal((await first).ok, true);

  /*
   * THE PROPERTY THAT REPLACED "only an exact safe result can persist". A Preview is now incapable of
   * writing station configuration, safe result or not: `applyPositioningPreview` and the whole
   * card-chasing proposal it consumed are gone, so a card lying somewhere can no longer calibrate a
   * station by being previewed. Fixed profile provisioning is server-owned and automatic.
   */
  assert.equal(typeof fixture.watcher.applyPositioningPreview, "undefined");
  assert.equal(persisted, null, "a Preview must not write the local jig origin");
  const entry = fixture.state.get().positioningPreview;
  assert.equal(entry.status, "detected");
  assert.equal(entry.placement, undefined, "no acquisition rectangle may be proposed from card position");
  assert.equal(typeof fixture.watcher.saveCaptureWindowOrigin, "function");
});

test("legacy geometry writes are quarantined before local persistence or a server request", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  let localWrites = 0;
  let requests = 0;
  fixture.lide.persistCalibrationSaveState = () => { localWrites++; };
  fixture.lide.persistJigOrigin = () => { localWrites++; };
  fixture.stationClient.saveCalibration = async () => { requests++; };

  const result = await fixture.watcher.saveCaptureWindowOrigin({ x: 20, y: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /automatic fixed Scanner profile/);
  assert.equal(localWrites, 0, "a stale caller cannot change local scanner geometry");
  assert.equal(requests, 0, "a stale caller cannot reach the calibration endpoint");
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GATE, AS A CAPABILITY — not as arithmetic.
 *
 * The 5.6 mm preview threshold is proven exhaustively as a pure function across three test files.
 * None of them touched the ONE call site that turns a verdict into an operator-visible capability:
 * `const green = verdict.state === PLACEMENT.READY` in watcher.js, which decides whether a
 * placement approval is written and therefore whether SCAN is live. A hostile review replaced it
 * with `const green = true` — every RED placement authorising a capture — and 129 of 129 tests
 * passed. These connect the two.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
test("a RED placement grants no approval, and SCAN is refused rather than merely discouraged", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  await fixture.watcher.pollTargetedCapture();

  const captureProfile = require("../../../shared/lide400-capture-profile.cjs");
  const floor = captureProfile.previewGreenMinMarginMm();
  // A hair inside the preview threshold: RED, and above the master floor, so this is precisely the
  // "would probably have passed" band that must still not unlock a capture.
  const tooClose = { x: floor - 0.5, y: floor - 0.5, width: 63.5, height: 88.9 };

  const preview = await passPlacementGate(fixture, tooClose);
  assert.equal(preview.ok, true, "the preview itself succeeds — it is the VERDICT that refuses");
  assert.equal(fixture.state.get().placementPreview.verdict.state, "RED");
  assert.equal(fixture.watcher.placementApproval(), null, "a RED verdict must not write an approval");

  let scans = 0;
  fixture.lide.scan = async () => { scans++; throw new Error("a RED placement must never reach the scanner"); };
  const refused = await fixture.watcher.scanActiveTarget();
  assert.equal(refused.ok, false);
  assert.equal(scans, 0, "no 1200-DPI capture may be attempted without a GREEN approval");
});

test("a GREEN placement grants exactly one approval, and it is spent by the scan it authorised", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  await fixture.watcher.pollTargetedCapture();

  const captureProfile = require("../../../shared/lide400-capture-profile.cjs");
  const floor = captureProfile.previewGreenMinMarginMm();
  await passPlacementGate(fixture, { x: floor, y: floor, width: 63.5, height: 88.9 });
  assert.equal(fixture.state.get().placementPreview.verdict.state, "GREEN", "exactly at the threshold is GREEN");
  assert.ok(fixture.watcher.placementApproval(), "a GREEN verdict must write an approval");

  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });
  fixture.server.uploadCaptureEvidence = async () => ({ ok: true, body: { certId: "MV900" } });
  assert.equal((await fixture.watcher.scanActiveTarget()).ok, true);
  // SINGLE USE. A standing approval would let a second capture happen from a placement nobody
  // re-checked — the card may have been moved or replaced in between.
  assert.equal(fixture.watcher.placementApproval(), null, "the approval must be consumed by its scan");
});

test("explicit Scan creates a JPEG derivative preview and automatically starts authoritative upload", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });
  let resolveUpload;
  let uploads = 0;
  fixture.server.prepareCaptureEvidenceUpload = async (_sessionId, _deviceId, filePath, _provenance, options = {}) => {
    const stat = fs.statSync(filePath);
    options.onProgress?.({ phase: "queued", bytesSent: 0, totalBytes: stat.size });
    return { ok: true, status: 201, body: { transport: "direct", staging_id: "stage-front", expected_bytes: stat.size } };
  };
  fixture.server.finalisePreparedCaptureEvidenceUpload = async (_sessionId, _deviceId, _filePath, _prepared, options = {}) => {
    uploads++;
    options.onProgress?.({ phase: "uploading", bytesSent: 5, totalBytes: 10 });
    return new Promise((resolve) => { resolveUpload = resolve; });
  };

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  const scan = await fixture.watcher.scanActiveTarget();
  assert.equal(scan.ok, true);
  assert.equal(scan.backgroundUpload, true);
  const uploadResolver = await waitForTestCondition(() => resolveUpload, "automatic upload after the local safety gate");
  assert.equal(uploads, 1);
  const entry = fixture.watcher.readTargetedQueue()[0];
  assert.equal(entry.phase, "upload");
  assert.equal(entry.uploadProgress.percent, 50);
  assert.equal(fixture.state.get().activeCapture, null);
  assert.equal(fixture.state.get().lastQueuedCapture.side, "front");
  assert.equal(fs.readFileSync(entry.filePath).subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])), true);
  const preview = fixture.watcher.previewData(entry.previewId);
  assert.equal(preview.ok, true);
  assert.match(preview.dataUrl, /^data:image\/jpeg;base64,/);
  uploadResolver({ ok: true, body: { certId: "MV900" } });
  await waitForTestCondition(() => fixture.state.get().lastAcceptedCapture?.side === "front", "background upload acceptance");
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
    provenance: { profileVersion: "mintvault-canon-lide-400-v3", scanAreaMm: { x: 12, y: 144, width: 100, height: 130 } },
  });
  fixture.watcher.assessCaptureFrame = async () => ({
    accepted: false,
    reason: "Card is too close to the hardware acquisition boundary (1.0 mm; 4 mm required); rescan",
    evidenceMarginMm: { left: 1, top: 16, right: 12, bottom: 15 },
  });
  let uploads = 0;
  fixture.server.prepareCaptureEvidenceUpload = async () => { uploads++; return { ok: true, body: { transport: "direct", staging_id: "unsafe" } }; };

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  const scan = await fixture.watcher.scanActiveTarget();
  assert.equal(scan.ok, false);
  const previewId = fixture.state.get().activeCapture.previewId;
  assert.equal(fixture.watcher.readTargetedQueue()[0].phase, "preview_error");
  assert.equal(fixture.watcher.previewData(previewId).ok, true, "unsafe operator preview remains reviewable");
  assert.equal(typeof fixture.watcher.acceptPreview, "undefined", "post-scan Accept is removed from the local workflow");
  assert.equal(uploads, 0);
  assert.equal((await fixture.watcher.rescanPreview(previewId)).ok, true);
  assert.equal(fixture.watcher.readTargetedQueue()[0].phase, "awaiting_scan");
  assert.equal(uploads, 0);
});

test("rapid Scan clicks start exactly one physical capture", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let scans = 0;
  let resolveScan;
  fixture.lide.scan = async (dir) => {
    scans++;
    await new Promise((resolve) => { resolveScan = resolve; });
    return { path: await writeStationTiff(dir), provenance: { profileVersion: "mintvault-canon-lide-400-v3" } };
  };
  fixture.server.uploadCaptureEvidence = async () => ({ ok: true, body: { certId: "MV900" } });

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  const first = fixture.watcher.scanActiveTarget();
  for (let attempt = 0; attempt < 20 && !resolveScan; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scans, 1);
  const second = await fixture.watcher.scanActiveTarget();
  assert.equal(second.ok, false, "double Scan must be single-flight before native capture completes");
  /*
   * REFUSED FOR THE RIGHT REASON. The capture also CONSUMES its placement approval, so a second
   * press would be refused by the gate even if single-flight were broken. Asserting the message
   * keeps this test proving single-flight rather than quietly proving the gate twice.
   */
  assert.match(second.error, /already in progress/);
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

test("a FRONT upload running in the background does not block the same card's BACK target", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  const targets = [
    claimedTarget({ id: "front-session", certificateNumber: "MV900", side: "front" }),
    claimedTarget({ id: "back-session", certificateNumber: "MV900", side: "back" }),
  ];
  let claims = 0;
  fixture.server.claimNextCapture = async () => ({ ok: true, body: { capture: targets[claims++] || null } });
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });
  let resolveUpload;
  fixture.server.prepareCaptureEvidenceUpload = async (_sessionId, _deviceId, filePath, _provenance, options = {}) => {
    const stat = fs.statSync(filePath);
    options.onProgress?.({ phase: "queued", bytesSent: 0, totalBytes: stat.size });
    return { ok: true, status: 201, body: { transport: "direct", staging_id: "stage-front", expected_bytes: stat.size } };
  };
  fixture.server.finalisePreparedCaptureEvidenceUpload = async (_sessionId, _deviceId, _filePath, _prepared, options = {}) => {
    options.onProgress?.({ phase: "uploading", bytesSent: 1, totalBytes: 10 });
    return new Promise((resolve) => { resolveUpload = resolve; });
  };

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  const scan = await fixture.watcher.scanActiveTarget();
  assert.equal(scan.ok, true);
  assert.equal(fixture.state.get().activeCapture, null);
  assert.equal(fixture.state.get().lastQueuedCapture.side, "front");
  const frontPreviewId = fixture.state.get().lastQueuedCapture.previewId;
  const uploadResolver = await waitForTestCondition(() => resolveUpload, "open background front upload");
  const repeatedPoll = await fixture.watcher.pollTargetedCapture();
  assert.equal(repeatedPoll.armed, true);
  assert.equal(claims, 2, "the station may claim BACK for the same card while FRONT uploads");
  assert.deepEqual(
    { id: fixture.state.get().activeCapture.id, certId: fixture.state.get().activeCapture.certId, side: fixture.state.get().activeCapture.side },
    { id: "back-session", certId: "MV900", side: "back" },
  );
  assert.equal(fixture.watcher.previewData(frontPreviewId).ok, true, "queued FRONT preview remains retrievable while BACK is active");
  uploadResolver({ ok: true, body: { certId: "MV900" } });
  await waitForTestCondition(() => fixture.state.get().lastAcceptedCapture?.side === "front", "front upload completion");
  assert.equal(fixture.state.get().activeCapture.id, "back-session", "late FRONT completion must not replace BACK UI");
});

test("duplicate Scan and Rescan during automatic upload cannot cross card sides or duplicate evidence", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  let scans = 0;
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir, `master-${++scans}.tif`),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });
  let uploads = 0;
  let resolveUpload;
  fixture.server.finalisePreparedCaptureEvidenceUpload = async () => {
    uploads++;
    return new Promise((resolve) => { resolveUpload = resolve; });
  };

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  const uploading = fixture.watcher.scanActiveTarget();
  const uploadResolver = await waitForTestCondition(() => resolveUpload, "the one permitted upload");
  const currentPreviewId = fixture.watcher.readTargetedQueue()[0]?.previewId;
  assert.equal((await fixture.watcher.scanActiveTarget()).ok, false, "released FRONT has no second active target to scan");
  assert.equal((await fixture.watcher.rescanPreview(currentPreviewId)).ok, false, "Rescan must be blocked during upload");
  uploadResolver({ ok: true, body: { certId: "MV900" } });
  assert.equal((await uploading).ok, true);
  assert.equal(uploads, 1);
  assert.equal(scans, 1, "automatic upload does not permit a duplicate physical scan");
});

test("an expired preview is never uploaded or rescanned", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  configureClaimedStation(fixture);
  fixture.lide.scan = async (dir) => ({
    path: await writeStationTiff(dir),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });
  let uploads = 0;
  fixture.server.prepareCaptureEvidenceUpload = async () => { uploads++; return { ok: true, body: { transport: "direct", staging_id: "expired" } }; };

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  fixture.server.getCaptureStatus = async () => ({ ok: true, body: { accepted: false, capture: { state: "expired" } } });
  assert.equal((await fixture.watcher.scanActiveTarget()).ok, false);
  const previewId = fixture.state.get().activeCapture?.previewId;
  assert.equal((await fixture.watcher.rescanPreview(previewId)).ok, false);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0, "an expired preview releases the station but stays non-authoritative");
  assert.equal(fixture.state.get().activeCapture, null);
  assert.equal(uploads, 0);
});

test("restart recovery fails a released upload task if the accepted local TIFF is missing", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  let failed = null;
  fixture.server.failCapture = async (sessionId, deviceId, reason) => {
    failed = { sessionId, deviceId, reason };
    return { ok: true, status: 200, body: { ok: true, terminalized: true, accepted: false, state: "failed" } };
  };
  fixture.watcher.addTargetedPending({
    sessionId: "released-missing-front",
    certId: "MV903",
    side: "front",
    phase: "upload",
    workstationId: "mintvault-station-a",
    filePath: path.join(fixture.tempDir, "missing.tif"),
    previewPath: path.join(fixture.tempDir, "missing.jpg"),
    stagingId: "stage-lost",
    serverUploadTaskAcceptedAt: new Date().toISOString(),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });

  assert.equal(await fixture.watcher.resumeTargetedCaptures(), true);
  assert.equal(failed.sessionId, "released-missing-front");
  assert.match(failed.reason, /local TIFF is missing/);
  assert.equal(fixture.watcher.readTargetedQueue().length, 0);
  assert.equal(fixture.state.get().captureUploads.front.status, "failed");
});

test("restart recovery keeps a released upload task if the lost-TIFF server failure cannot be recorded", async (t) => {
  const fixture = isolatedTargetedWatcher(t);
  fixture.server.failCapture = async () => ({ ok: false, status: 503, body: { error: "network unavailable" } });
  fixture.watcher.addTargetedPending({
    sessionId: "released-missing-retry",
    certId: "MV904",
    side: "front",
    phase: "upload",
    workstationId: "mintvault-station-a",
    filePath: path.join(fixture.tempDir, "missing.tif"),
    stagingId: "stage-retry",
    serverUploadTaskAcceptedAt: new Date().toISOString(),
    provenance: { profileVersion: "mintvault-canon-lide-400-v3" },
  });

  assert.equal(await fixture.watcher.resumeTargetedCaptures(), true);
  const queued = fixture.watcher.readTargetedQueue()[0];
  assert.equal(queued.sessionId, "released-missing-retry");
  assert.equal(fixture.state.get().captureUploads.front.status, "lost_local_master");
});

test("automatic front upload leaves it untouched when a later back safety failure is rescanned", async (t) => {
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
  let backFirstFrame = true;
  fixture.server.claimNextCapture = async () => ({ ok: true, body: { capture: targets[claimIndex++] || null } });
  fixture.lide.scan = async (dir) => {
    const side = fixture.state.get().activeCapture.side;
    const filePath = await writeStationTiff(dir, `${side}-${++scans}.tif`);
    if (side === "front") frontPath = filePath;
    return { path: filePath, provenance: { profileVersion: "mintvault-canon-lide-400-v3" } };
  };
  fixture.watcher.assessCaptureFrame = async () => {
    const side = fixture.state.get().activeCapture.side;
    if (side === "back" && backFirstFrame) {
      backFirstFrame = false;
      return {
        accepted: false,
        reason: "Back card is too close to the hardware acquisition boundary; rescan",
        evidenceMarginMm: { left: 1, top: 16, right: 12, bottom: 15 },
      };
    }
    return { accepted: true, reason: null, evidenceMarginMm: { left: 8, top: 8, right: 8, bottom: 8 } };
  };
  fixture.server.finalisePreparedCaptureEvidenceUpload = async () => {
    uploads++;
    return { ok: true, body: { certId: "MV902", card_registered: uploads === 2 } };
  };

  await fixture.watcher.pollTargetedCapture();
  await passPlacementGate(fixture);
  await fixture.watcher.scanActiveTarget();
  await waitForTestCondition(() => fixture.state.get().lastAcceptedCapture?.side === "front", "front background acceptance");
  assert.deepEqual(fixture.state.get().lastAcceptedCapture?.side, "front");
  assert.equal(fixture.state.get().lastAcceptedCapture?.certId, "MV902");
  const acceptedFront = path.join(fixture.tempDir, "processed", new Date().toISOString().slice(0, 10), path.basename(frontPath));
  assert.equal(fs.existsSync(acceptedFront), true);
  const acceptedFrontBytes = fs.readFileSync(acceptedFront);

  await fixture.watcher.pollTargetedCapture();
  assert.equal(fixture.state.get().activeCapture.side, "back");

  /*
   * A FRONT PREVIEW NEVER AUTHORISES BACK — proved on the live watcher, not just on the predicate.
   *
   * FRONT's automatic upload cleared its approval, and BACK is a different session and side besides,
   * so SCAN must refuse until the operator looks at the glass again. Without this the gate would be
   * a rule that holds in a unit test and evaporates in the object that actually runs it.
   */
  const withoutFreshPreview = await fixture.watcher.scanActiveTarget();
  assert.equal(withoutFreshPreview.ok, false, "BACK must not scan on the FRONT side's placement approval");
  assert.match(withoutFreshPreview.error, /placement Preview/i);

  await passPlacementGate(fixture);
  await fixture.watcher.scanActiveTarget();
  assert.equal((await fixture.watcher.rescanPreview(fixture.state.get().activeCapture.previewId)).ok, true);
  assert.equal(uploads, 1, "only the accepted front was uploaded");
  assert.equal(fs.readFileSync(acceptedFront).equals(acceptedFrontBytes), true, "back Rescan never alters accepted front evidence");
  assert.equal(fixture.state.get().activeCapture.side, "back");
  assert.equal(fixture.watcher.readTargetedQueue()[0].phase, "awaiting_scan");

  await passPlacementGate(fixture);

  await fixture.watcher.scanActiveTarget();
  await waitForTestCondition(() => fixture.state.get().lastAcceptedCapture?.side === "back", "back background acceptance");
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

test("targeted upload treats a lost response as accepted when immutable session provenance exists", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-targeted-reconcile-"));
  const previousScansDir = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  const watcherPath = require.resolve("../lib/watcher");
  const statePath = require.resolve("../lib/state");
  delete require.cache[watcherPath];
  delete require.cache[statePath];
  const { Watcher } = require("../lib/watcher");
  const server = require("../lib/server-client");
  const originalStatus = server.getCaptureStatus;
  const originalUpload = server.uploadCaptureEvidence;
  const originalPrepare = server.prepareCaptureEvidenceUpload;
  const originalFinalise = server.finalisePreparedCaptureEvidenceUpload;
  const originalFinaliseStaged = server.finaliseStagedCaptureEvidence;
  const originalDeviceId = require("../lib/lide400-controller").deviceId;
  t.after(() => {
    server.getCaptureStatus = originalStatus;
    server.uploadCaptureEvidence = originalUpload;
    server.prepareCaptureEvidenceUpload = originalPrepare;
    server.finalisePreparedCaptureEvidenceUpload = originalFinalise;
    server.finaliseStagedCaptureEvidence = originalFinaliseStaged;
    require("../lib/lide400-controller").deviceId = originalDeviceId;
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR; else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    delete require.cache[watcherPath];
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const watcher = new Watcher();
  watcher.waitForStable = async () => true;
  let completed = null;
  watcher.completeTargetedCapture = (entry, capture) => { completed = { entry, capture }; return { ok: true }; };
  server.getCaptureStatus = async () => ({ ok: true, body: { accepted: true, capture: { state: "captured", certificateNumber: "MV700" } } });
  server.uploadCaptureEvidence = async () => { throw new Error("must not re-upload accepted evidence"); };
  server.finaliseStagedCaptureEvidence = async () => ({ ok: true, body: { certId: "MV700", card_registered: false } });

  const result = await watcher.uploadTargetedCapture({
    sessionId: "session-accepted", certId: "MV700", side: "front", workstationId: "mintvault-station-a", filePath: path.join(tempDir, "master.tif"), provenance: {}, uploadAttempts: 0, stagingId: "stage-accepted",
  });
  assert.equal(result.ok, true);
  assert.equal(completed.capture.certificateNumber, "MV700");
});

test("targeted upload reconciles a timeout before any retry can duplicate evidence", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-targeted-timeout-"));
  const previousScansDir = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  const watcherPath = require.resolve("../lib/watcher");
  const statePath = require.resolve("../lib/state");
  delete require.cache[watcherPath];
  delete require.cache[statePath];
  const { Watcher } = require("../lib/watcher");
  const server = require("../lib/server-client");
  const originalStatus = server.getCaptureStatus;
  const originalUpload = server.uploadCaptureEvidence;
  const originalPrepare = server.prepareCaptureEvidenceUpload;
  const originalFinalise = server.finalisePreparedCaptureEvidenceUpload;
  const originalFinaliseStaged = server.finaliseStagedCaptureEvidence;
  t.after(() => {
    server.getCaptureStatus = originalStatus;
    server.uploadCaptureEvidence = originalUpload;
    server.prepareCaptureEvidenceUpload = originalPrepare;
    server.finalisePreparedCaptureEvidenceUpload = originalFinalise;
    server.finaliseStagedCaptureEvidence = originalFinaliseStaged;
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR; else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    delete require.cache[watcherPath];
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const watcher = new Watcher();
  watcher.waitForStable = async () => true;
  let completed = 0;
  let uploads = 0;
  watcher.completeTargetedCapture = () => { completed++; return { ok: true }; };
  server.getCaptureStatus = async () => ({
    ok: true,
    body: uploads ? { accepted: true, capture: { state: "captured", certificateNumber: "MV701" } } : { accepted: false, capture: { state: "claimed" } },
  });
  server.prepareCaptureEvidenceUpload = async () => ({ ok: true, status: 201, body: { transport: "direct", staging_id: "timeout", expected_bytes: 12 } });
  server.finalisePreparedCaptureEvidenceUpload = async () => { uploads++; return { ok: false, status: 504, body: { error: "server slow — no reply" } }; };
  server.finaliseStagedCaptureEvidence = async () => { uploads++; return { ok: true, body: { certId: "MV701", card_registered: true } }; };

  const first = await watcher.uploadTargetedCapture({
    sessionId: "session-timeout", certId: "MV701", side: "back", workstationId: "mintvault-station-a", filePath: path.join(tempDir, "master.tif"), provenance: {}, uploadAttempts: 0,
  });
  assert.equal(first.ok, false, "a failed finalise response must not be completed from status alone");
  assert.equal(uploads, 1, "ambiguous timeout must be reconciled before a second POST");
  assert.equal(completed, 0);
  const queued = watcher.readTargetedQueue()[0];
  assert.equal(queued.stagingId, "timeout");

  const second = await watcher.uploadTargetedCapture(queued);
  assert.equal(second.ok, true);
  assert.equal(uploads, 2, "the retry replays finalise for the same staging task, not a new upload");
  assert.equal(completed, 1);
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
  assert.deepEqual(controller._private.calibrationRegion({ x: 12, y: 108, width: 120, height: 160 }), {
    x: 12, y: 108, width: 120, height: 160,
  });
  assert.throws(
    () => controller._private.calibrationRegion({ x: 12, y: 108, width: 90, height: 120 }),
    /at least 110 x 140 mm/
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

test("station-side frame safety refuses an edge-touching TIFF before upload", async (t) => {
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
