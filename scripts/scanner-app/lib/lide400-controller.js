/**
 * Canon CanoScan LiDE 400 controller for the existing scanner-app process.
 * It runs only the precompiled, integrity-checked ImageCaptureCore helper
 * shipped inside the application. No Canon GUI or runtime compiler is used.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const stationIdentity = require("./station-identity");
const helperIntegrity = require("./helper-integrity");
const lockedProfileStore = require("./locked-scanner-profile");

const PROFILE_VERSION = "mintvault-canon-lide-400-v3";
const MODEL = "CanoScan LiDE 400";
// The disposable 1200-DPI capability frame must exercise the exact final
// hardware ROI. Reject anything smaller, but do not require a region larger
// than the profile the bridge will actually use for card evidence.
const CALIBRATION_MIN_MM = Object.freeze({ width: 100, height: 130 });
const PLATEN_MAX_MM = Object.freeze({ width: 216, height: 297 });
const PROFILE_AREA_MM = Object.freeze({ width: 100, height: 130 });
const POSITIONING_PREVIEW_DPI = 300;
const POSITIONING_PREVIEW_COORDINATE_SPACE = "imagecapturecore-scan-area-upright-raster-v1";
const CALIBRATION_VERSION = "mintvault-lide400-jig-v1";
const MAX_HELPER_STDOUT_BYTES = 256 * 1024;
const MAX_HELPER_STDERR_BYTES = 256 * 1024;
const HELPER_KILL_GRACE_MS = 2_000;
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
let runtime = Object.freeze({ isPackaged: false, appVersion: "development" });
let helperTail = Promise.resolve();

function configureRuntime({ isPackaged, appVersion }) {
  if (typeof isPackaged !== "boolean" || typeof appVersion !== "string" || !appVersion.trim()) {
    throw new Error("LiDE runtime configuration is invalid");
  }
  runtime = Object.freeze({ isPackaged, appVersion: appVersion.trim() });
  lockedProfileStore.configureRuntime({ isPackaged });
}

function stationId() {
  const enrolled = stationIdentity.currentStationCode();
  if (enrolled) return enrolled;
  // Explicit local-development compatibility only.  A production daemon must
  // be enrolled rather than deriving authority from a mutable hostname/env.
  if (!runtime.isPackaged && process.env.MINTVAULT_STATION_ID) {
    return String(process.env.MINTVAULT_STATION_ID).replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 128);
  }
  return "unregistered-station";
}

function deviceId() {
  return `mac-${stationId()}`;
}

function developmentJigOrigin() {
  if (runtime.isPackaged) return null;
  const x = Number(process.env.MINTVAULT_LIDE_SCAN_X_MM);
  const y = Number(process.env.MINTVAULT_LIDE_SCAN_Y_MM);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  return { x, y };
}

function currentLockedProfile() {
  const profile = lockedProfileStore.loadCurrent();
  if (!profile) return null;
  const currentStation = stationIdentity.currentStationCode();
  if (!currentStation || profile.stationCode !== currentStation) {
    throw new Error("Locked scanner profile belongs to another station identity");
  }
  if (profile.globalProfileVersion !== PROFILE_VERSION) {
    throw new Error("Locked scanner profile version is no longer supported");
  }
  if (profile.captureHelperVersion !== helperIntegrity.HELPER_VERSION) {
    throw new Error("Locked scanner profile was proved by a different capture helper version");
  }
  if (profile.profileRevisionId.startsWith("PENDING:")) {
    throw new Error("Pending Scanner profile cannot become capture authority");
  }
  return profile;
}

function profileSelection() {
  const development = developmentJigOrigin();
  if (development) return Object.freeze({ originMm: development, profile: null, development: true });
  const profile = currentLockedProfile();
  if (!profile) return null;
  return Object.freeze({
    originMm: { x: profile.acquisitionRegion.x, y: profile.acquisitionRegion.y },
    profile,
    development: false,
  });
}

function jigOrigin() {
  return profileSelection()?.originMm || null;
}

function scannerMatchesProfile(result, profile) {
  if (!profile) return true;
  const expected = profile.scannerHardware;
  const model = String(result?.model || MODEL).trim();
  const deviceId = String(result?.deviceId || "").trim();
  const serial = result?.serial == null ? null : String(result.serial).trim();
  return model === expected.model
    && (!expected.deviceId || deviceId === expected.deviceId)
    && (!expected.serial || serial === expected.serial);
}

/**
 * Persist only an explicitly opted-in station jig file. The live production
 * token file is never an implicit write target: local/development proof sets
 * MINTVAULT_STATION_CONFIG_PATH to its isolated non-secret configuration.
 */
function persistJigOrigin(origin) {
  if (runtime.isPackaged) {
    throw new Error("Packaged Scanner profiles must be accepted by MintVault before local activation");
  }
  const x = Number(origin?.x);
  const y = Number(origin?.y);
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0) {
    throw new Error("Detected LiDE jig origin is invalid");
  }
  const configured = String(process.env.MINTVAULT_STATION_CONFIG_PATH || "").trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("Station configuration persistence is not enabled for this Scanner instance");
  }
  const configPath = path.resolve(configured);
  let current;
  try { current = fs.readFileSync(configPath, "utf8"); }
  catch { throw new Error("Configured station file is unavailable; placement was not persisted"); }
  const writeValue = (source, key, value) => {
    const line = `${key}=${Number(value.toFixed(2))}`;
    const expression = new RegExp(`^${key}=.*$`, "m");
    return expression.test(source) ? source.replace(expression, line) : `${source.replace(/\s*$/, "")}\n${line}\n`;
  };
  const next = writeValue(writeValue(current, "MINTVAULT_LIDE_SCAN_X_MM", x), "MINTVAULT_LIDE_SCAN_Y_MM", y);
  const tmpPath = `${configPath}.tmp`;
  const mode = fs.statSync(configPath).mode & 0o777;
  fs.writeFileSync(tmpPath, next, { mode: mode || 0o600 });
  fs.renameSync(tmpPath, configPath);
  process.env.MINTVAULT_LIDE_SCAN_X_MM = String(Number(x.toFixed(2)));
  process.env.MINTVAULT_LIDE_SCAN_Y_MM = String(Number(y.toFixed(2)));
  return { configPath, originMm: developmentJigOrigin(), areaMm: PROFILE_AREA_MM, profileVersion: PROFILE_VERSION };
}

function profileInput(candidate, { semanticOperationId, profileRevisionId, deviceCreatedAt }) {
  if (!candidate || typeof candidate !== "object") throw new Error("Calibration candidate is invalid");
  return {
    stationCode: stationId(),
    semanticOperationId,
    profileRevisionId,
    scannerHardware: candidate.scannerHardware,
    globalProfileVersion: PROFILE_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    acquisitionRegion: candidate.acquisitionRegion,
    workingRegion: candidate.workingRegion,
    placementToleranceMm: candidate.placementToleranceMm,
    requestedDpi: 1200,
    colourMode: "RGB",
    bitDepth: 8,
    outputFormat: "TIFF",
    presentationRotationDegrees: 180,
    appVersion: runtime.appVersion,
    captureHelperVersion: helperIntegrity.HELPER_VERSION,
    identityHelperVersion: helperIntegrity.IDENTITY_HELPER_VERSION,
    capabilityProof: candidate.capabilityProof,
    deviceCreatedAt,
    deviceTimestampAuthority: "NON_AUTHORITATIVE",
  };
}

function profileCandidate(profile) {
  return Object.freeze({
    stationCode: profile.stationCode,
    semanticOperationId: profile.semanticOperationId,
    scannerHardware: profile.scannerHardware,
    globalProfileVersion: profile.globalProfileVersion,
    calibrationVersion: profile.calibrationVersion,
    acquisitionRegion: profile.acquisitionRegion,
    workingRegion: profile.workingRegion,
    placementToleranceMm: profile.placementToleranceMm,
    requestedDpi: profile.requestedDpi,
    colourMode: profile.colourMode,
    bitDepth: profile.bitDepth,
    outputFormat: profile.outputFormat,
    presentationRotationDegrees: profile.presentationRotationDegrees,
    appVersion: profile.appVersion,
    captureHelperVersion: profile.captureHelperVersion,
    identityHelperVersion: profile.identityHelperVersion,
    capabilityProof: profile.capabilityProof,
    deviceCreatedAt: profile.deviceCreatedAt,
    deviceTimestampAuthority: profile.deviceTimestampAuthority,
  });
}

function candidateDigest(profile) {
  return crypto.createHash("sha256")
    .update(lockedProfileStore._private.canonicalJson(profileCandidate(profile)))
    .digest("hex");
}

function calibrationBinding(value) {
  const rounded = (number) => Number(Number(number).toFixed(3));
  const region = (input) => Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, rounded(input?.[key])]));
  const margins = (input) => Object.fromEntries(["left", "right", "top", "bottom"].map((key) => [key, rounded(input?.[key])]));
  return lockedProfileStore._private.canonicalJson({
    scannerHardware: {
      manufacturer: String(value.scannerHardware?.manufacturer || "Canon").trim(),
      model: String(value.scannerHardware?.model || "").trim(),
      deviceId: value.scannerHardware?.deviceId == null ? null : String(value.scannerHardware.deviceId).trim() || null,
      serial: value.scannerHardware?.serial == null ? null : String(value.scannerHardware.serial).trim() || null,
    },
    globalProfileVersion: value.globalProfileVersion || value.scannerProfileVersion,
    calibrationVersion: value.calibrationVersion,
    acquisitionRegion: region(value.acquisitionRegion),
    workingRegion: region(value.workingRegion),
    placementToleranceMm: margins(value.placementToleranceMm),
    requestedDpi: Number(value.requestedDpi),
    colourMode: value.colourMode,
    bitDepth: Number(value.bitDepth),
    outputFormat: value.outputFormat,
    presentationRotationDegrees: Number(value.presentationRotationDegrees),
  });
}

function acceptanceOperation(profile, { replayed }) {
  const acceptedCandidate = profileCandidate(profile);
  const candidateDigestSha256 = candidateDigest(profile);
  return Object.freeze({
    semanticOperationId: profile.semanticOperationId,
    candidateDigestSha256,
    replayed,
    request: Object.freeze({
      schemaVersion: 1,
      semanticOperationId: profile.semanticOperationId,
      clientOpId: profile.semanticOperationId,
      candidateDigestSha256,
      profile: acceptedCandidate,
      // Transitional flat fields let the pre-P14 endpoint validate the same
      // physical tuple. Scanner activation still requires the exact bound
      // response contract below, so a legacy acknowledgement cannot activate.
      ...acceptedCandidate,
      scannerProfileVersion: acceptedCandidate.globalProfileVersion,
    }),
  });
}

function pendingForCandidate(candidate) {
  const pending = lockedProfileStore.loadPending();
  if (!pending) return null;
  const current = lockedProfileStore.loadCurrent();
  if (current?.semanticOperationId === pending.semanticOperationId) {
    if (candidateDigest(current) !== candidateDigest(pending)) {
      throw new Error("Completed and pending Scanner profiles conflict; profile recovery is required");
    }
    lockedProfileStore.clearPending();
    return null;
  }
  if (pending.stationCode !== stationId() || !pending.profileRevisionId.startsWith(`PENDING:${pending.semanticOperationId}`)
      || pending.globalProfileVersion !== PROFILE_VERSION
      || pending.captureHelperVersion !== helperIntegrity.HELPER_VERSION
      || pending.identityHelperVersion !== helperIntegrity.IDENTITY_HELPER_VERSION) {
    throw new Error("Pending Scanner profile does not match this trusted station runtime");
  }
  if (candidate && calibrationBinding(candidate) !== calibrationBinding(pending)) {
    const error = new Error("A different Scanner profile operation is pending; recover it before changing placement");
    error.code = "IDEMPOTENCY_CONFLICT";
    throw error;
  }
  return pending;
}

function resumeLockedProfileAcceptance(candidate) {
  const pending = pendingForCandidate(candidate);
  return pending ? acceptanceOperation(pending, { replayed: true }) : null;
}

function beginLockedProfileAcceptance(candidate) {
  const existing = pendingForCandidate(candidate);
  if (existing) return acceptanceOperation(existing, { replayed: true });
  const semanticOperationId = crypto.randomUUID();
  const pending = lockedProfileStore.savePending(profileInput(candidate, {
    semanticOperationId,
    profileRevisionId: `PENDING:${semanticOperationId}`,
    deviceCreatedAt: new Date().toISOString(),
  }));
  return acceptanceOperation(pending, { replayed: false });
}

function finalizeLockedProfileAcceptance(operation, calibration) {
  if (!operation || typeof operation !== "object" || !calibration || typeof calibration !== "object") {
    throw new Error("Scanner profile acceptance response is invalid");
  }
  const pending = pendingForCandidate();
  if (!pending || operation.semanticOperationId !== pending.semanticOperationId
      || operation.candidateDigestSha256 !== candidateDigest(pending)) {
    throw new Error("Scanner profile acceptance does not match the durable pending operation");
  }
  const revision = typeof calibration.profileRevisionId === "string" ? calibration.profileRevisionId.trim() : "";
  if (calibration.calibrationStatus !== "VALID"
      || calibration.semanticOperationId !== operation.semanticOperationId
      || calibration.candidateDigestSha256 !== operation.candidateDigestSha256
      || !revision || (calibration.id != null && calibration.id !== revision)
      || !/^[a-f0-9]{64}$/.test(String(calibration.profileDigestSha256 || ""))
      || !calibration.profile || typeof calibration.profile !== "object") {
    throw new Error("MintVault did not return the exact accepted Scanner profile binding");
  }
  const locallyDerived = lockedProfileStore._private.normalizedProfile({
    ...profileCandidate(pending),
    profileRevisionId: revision,
    profileDigestSha256: calibration.profileDigestSha256,
  });
  const serverProfile = lockedProfileStore._private.normalizedProfile(calibration.profile);
  if (lockedProfileStore._private.canonicalJson(serverProfile) !== lockedProfileStore._private.canonicalJson(locallyDerived)) {
    throw new Error("MintVault accepted Scanner profile does not match the durable candidate");
  }
  const saved = lockedProfileStore.saveCurrent(serverProfile);
  lockedProfileStore.clearPending();
  return Object.freeze({
    profileRevisionId: saved.profileRevisionId,
    profileDigestSha256: saved.profileDigestSha256,
    semanticOperationId: saved.semanticOperationId,
    originMm: { x: saved.acquisitionRegion.x, y: saved.acquisitionRegion.y },
    areaMm: { width: saved.acquisitionRegion.width, height: saved.acquisitionRegion.height },
    profileVersion: saved.globalProfileVersion,
  });
}

function calibrationRegion(input) {
  const x = Number(input?.x);
  const y = Number(input?.y);
  const width = Number(input?.width);
  const height = Number(input?.height);
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0) {
    throw new Error("LiDE calibration region must contain non-negative finite X/Y/width/height values");
  }
  if (width < CALIBRATION_MIN_MM.width || height < CALIBRATION_MIN_MM.height) {
    throw new Error(`LiDE calibration region must be at least ${CALIBRATION_MIN_MM.width} x ${CALIBRATION_MIN_MM.height} mm`);
  }
  if (x + width > PLATEN_MAX_MM.width || y + height > PLATEN_MAX_MM.height) {
    throw new Error("LiDE calibration region exceeds the physical platen");
  }
  return { x, y, width, height };
}

function run(command, args, timeoutMs, { spawnImpl = spawn, killGraceMs = HELPER_KILL_GRACE_MS } = {}) {
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const prior = helperTail;
  helperTail = prior.catch(() => {}).then(() => turn);
  return prior.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    let spawnError = null;
    let killTimer = null;
    const terminate = (error) => {
      if (terminalError) return;
      terminalError = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => terminate(new Error(`LiDE bridge timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_HELPER_STDOUT_BYTES) terminate(new Error("LiDE bridge stdout exceeded its size limit"));
      else stdout.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > MAX_HELPER_STDERR_BYTES) terminate(new Error("LiDE bridge stderr exceeded its size limit"));
      else stderr.push(bytes);
    });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (terminalError) return reject(terminalError);
      if (spawnError) return reject(spawnError);
      const out = Buffer.concat(stdout, stdoutBytes).toString("utf8").trim();
      try {
        const parsed = JSON.parse(out);
        resolve(helperIntegrity.assertCompatibleResult(parsed));
      } catch {
        reject(new Error(`LiDE bridge exited ${code ?? "?"}: ${Buffer.concat(stderr, stderrBytes).toString("utf8").trim() || out || "no result"}`));
      }
    });
  })).finally(release);
}

async function ensureBridge() {
  if (process.platform !== "darwin") throw new Error("Canon LiDE control requires macOS Image Capture");
  // Verification deliberately runs before every spawn. A valid signature from
  // a prior operation cannot authorise a subsequently replaced executable.
  return helperIntegrity.verifiedCaptureHelper().path;
}

function sha256Descriptor(descriptor, byteLength) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, byteLength));
  let offset = 0;
  while (offset < byteLength) {
    const length = Math.min(buffer.length, byteLength - offset);
    const count = fs.readSync(descriptor, buffer, 0, length, offset);
    if (count !== length) throw new Error("LiDE capture changed while its attestation was verified");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex");
}

function openAttestedCapture(capturedPath, result, { afterOpen = null } = {}) {
  const expectedSize = Number(result?.fileSizeBytes);
  const expectedSha256 = String(result?.fileSha256 || "");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 4 || expectedSize > MAX_CAPTURE_BYTES
      || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("LiDE bridge did not attest the exact bounded capture bytes");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(capturedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize) {
      throw new Error("LiDE capture does not match the helper-attested file object");
    }
    if (typeof afterOpen === "function") afterOpen({ descriptor, stat, capturedPath });
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 1 || after.size !== stat.size
        || sha256Descriptor(descriptor, stat.size) !== expectedSha256) {
      throw new Error("LiDE capture digest does not match the trusted helper attestation");
    }
    return Object.freeze({ descriptor, stat, sha256: expectedSha256, byteLength: expectedSize });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

async function health() {
  try {
    const bridge = await ensureBridge();
    const result = await run(bridge, ["health"], 12_000);
    let selected;
    try { selected = profileSelection(); }
    catch (error) {
      return { ...result, status: "profile_invalid", error: error.message, profileVersion: PROFILE_VERSION, workstationId: stationId() };
    }
    if (["ready", "busy"].includes(result.status) && !selected) {
      return { ...result, status: "profile_unprovisioned", error: "Canon is connected but the station jig origin is not provisioned", profileVersion: PROFILE_VERSION, workstationId: stationId() };
    }
    if (selected?.profile && !scannerMatchesProfile(result, selected.profile)) {
      return { ...result, status: "profile_invalid", error: "Connected Canon does not match the locked Scanner profile", profileVersion: PROFILE_VERSION, workstationId: stationId() };
    }
    return {
      ...result,
      profileVersion: PROFILE_VERSION,
      workstationId: stationId(),
      ...(selected?.profile ? {
        profileRevisionId: selected.profile.profileRevisionId,
        profileDigestSha256: selected.profile.profileDigestSha256,
      } : {}),
    };
  } catch (error) {
    return { status: "control_unavailable", error: error.message, profileVersion: PROFILE_VERSION, workstationId: stationId() };
  }
}

async function scan(outputDirectory) {
  const selected = profileSelection();
  const origin = selected?.originMm;
  if (!origin) throw new Error("Scanner jig origin is not provisioned; run the LiDE station acceptance setup");
  const startedAt = new Date().toISOString();
  const bridge = await ensureBridge();
  const result = await run(bridge, ["scan", outputDirectory, String(origin.x), String(origin.y)], 360_000);
  if (result.status !== "captured" || typeof result.path !== "string") throw new Error(result.error || "LiDE capture failed");
  const root = path.resolve(outputDirectory) + path.sep;
  const capturedPath = path.resolve(result.path);
  if (!capturedPath.startsWith(root) || ![".tif", ".tiff"].includes(path.extname(capturedPath).toLowerCase())) {
    throw new Error("LiDE bridge returned an unsafe or non-TIFF output path");
  }
  const attested = openAttestedCapture(capturedPath, result);
  if (selected.profile && !scannerMatchesProfile(result, selected.profile)) {
    fs.closeSync(attested.descriptor);
    throw new Error("Captured Canon does not match the locked Scanner profile");
  }
  return {
    path: capturedPath,
    artifactDescriptor: attested.descriptor,
    provenance: {
      profileVersion: PROFILE_VERSION,
      scannerManufacturer: "Canon",
      // Preserve the exact ImageCaptureCore name in immutable provenance.
      // The server validates it against the same strict LiDE 400 alias set.
      scannerModel: result.model || MODEL,
      scannerDeviceId: result.deviceId || "",
      scannerSerial: result.serial || null,
      workstationId: stationId(),
      requestedDpi: 1200,
      driverResolutionDpi: Number(result.driverResolutionDpi),
      scanAreaMm: result.scanAreaMm,
      captureStartedAt: startedAt,
      captureCompletedAt: new Date().toISOString(),
      helperVersion: result.helperVersion,
      helperAttestedSha256: attested.sha256,
      helperAttestedByteLength: attested.byteLength,
      profileRevisionId: selected.profile?.profileRevisionId || null,
      profileDigestSha256: selected.profile?.profileDigestSha256 || null,
    },
  };
}

/**
 * Acquire a full-platen, low-resolution JPEG used only to locate a card before
 * station calibration. It is intentionally separate from `scan`: it has no
 * certificate/session input, no TIFF output, and no server client path.
 */
async function positioningPreview(outputDirectory) {
  const bridge = await ensureBridge();
  const result = await run(bridge, ["preview", outputDirectory], 180_000);
  if (result.status !== "captured" || result.captureKind !== "positioning_preview" || typeof result.path !== "string") {
    throw new Error(result.error || "LiDE positioning preview failed");
  }
  if (result.previewCoordinateSpace !== POSITIONING_PREVIEW_COORDINATE_SPACE || Number(result.previewRasterOrientation) !== 1) {
    throw new Error("LiDE positioning Preview did not return the canonical upright ImageCaptureCore coordinate contract");
  }
  const root = path.resolve(outputDirectory) + path.sep;
  const capturedPath = path.resolve(result.path);
  if (!capturedPath.startsWith(root) || ![".jpg", ".jpeg"].includes(path.extname(capturedPath).toLowerCase())) {
    throw new Error("LiDE bridge returned an unsafe or non-JPEG positioning preview");
  }
  const attested = openAttestedCapture(capturedPath, result);
  return {
    path: capturedPath,
    artifactDescriptor: attested.descriptor,
    sizeBytes: attested.byteLength,
    helperAttestedSha256: attested.sha256,
    helperAttestedByteLength: attested.byteLength,
    appliedRegionMm: result.scanAreaMm,
    requestedDpi: Number(result.requestedDpi),
    driverResolutionDpi: Number(result.driverResolutionDpi),
    coordinateSpace: result.previewCoordinateSpace,
    rasterOrientation: Number(result.previewRasterOrientation),
    scanner: {
      model: result.model || MODEL,
      deviceId: result.deviceId || "",
      serial: result.serial || null,
    },
  };
}

/**
 * Capture a disposable-card calibration frame using ImageCaptureCore's actual
 * scan area. It is deliberately separate from `scan`: no capture session,
 * server client, provenance acceptance, or evidence upload is reachable here.
 */
async function scanCalibrationRegion(outputDirectory, region) {
  const measured = calibrationRegion(region);
  const bridge = await ensureBridge();
  const result = await run(
    bridge,
    ["calibrate", outputDirectory, String(measured.x), String(measured.y), String(measured.width), String(measured.height)],
    420_000
  );
  if (result.status !== "captured" || result.captureKind !== "calibration" || typeof result.path !== "string") {
    throw new Error(result.error || "LiDE calibration capture failed");
  }
  const root = path.resolve(outputDirectory) + path.sep;
  const capturedPath = path.resolve(result.path);
  if (!capturedPath.startsWith(root) || ![".tif", ".tiff"].includes(path.extname(capturedPath).toLowerCase())) {
    throw new Error("LiDE bridge returned an unsafe or non-TIFF calibration output path");
  }
  const attested = openAttestedCapture(capturedPath, result);
  return {
    path: capturedPath,
    artifactDescriptor: attested.descriptor,
    sizeBytes: attested.byteLength,
    helperAttestedSha256: attested.sha256,
    helperAttestedByteLength: attested.byteLength,
    requestedRegionMm: measured,
    appliedRegionMm: result.scanAreaMm,
    requestedDpi: Number(result.requestedDpi),
    driverResolutionDpi: Number(result.driverResolutionDpi),
    helperVersion: result.helperVersion,
    scanner: {
      model: result.model || MODEL,
      deviceId: result.deviceId || "",
      serial: result.serial || null,
    },
  };
}

module.exports = {
  PROFILE_VERSION,
  stationId,
  deviceId,
  health,
  scan,
  positioningPreview,
  scanCalibrationRegion,
  persistJigOrigin,
  resumeLockedProfileAcceptance,
  beginLockedProfileAcceptance,
  finalizeLockedProfileAcceptance,
  currentLockedProfile,
  configureRuntime,
  requiresLockedProfile: () => runtime.isPackaged,
  _private: { run, jigOrigin, developmentJigOrigin, profileSelection, scannerMatchesProfile, calibrationRegion, ensureBridge, openAttestedCapture, sha256Descriptor, profileInput, profileCandidate, candidateDigest, calibrationBinding, acceptanceOperation, pendingForCandidate, CALIBRATION_MIN_MM, PLATEN_MAX_MM, PROFILE_AREA_MM, POSITIONING_PREVIEW_DPI, CALIBRATION_VERSION, MAX_HELPER_STDOUT_BYTES, MAX_HELPER_STDERR_BYTES, MAX_CAPTURE_BYTES },
};
