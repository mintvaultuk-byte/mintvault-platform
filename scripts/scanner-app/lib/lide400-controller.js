/**
 * Canon CanoScan LiDE 400 controller for the existing scanner-app process.
 * It runs only the precompiled, integrity-checked ImageCaptureCore helper
 * shipped inside the application. No Canon GUI or runtime compiler is used.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const stationIdentity = require("./station-identity");
const helperIntegrity = require("./helper-integrity");

const PROFILE_VERSION = "mintvault-canon-lide-400-v3";
const MODEL = "CanoScan LiDE 400";
const CALIBRATION_MIN_MM = Object.freeze({ width: 110, height: 140 });
const PLATEN_MAX_MM = Object.freeze({ width: 216, height: 297 });
const PROFILE_AREA_MM = Object.freeze({ width: 100, height: 130 });
const POSITIONING_PREVIEW_DPI = 300;
const POSITIONING_PREVIEW_COORDINATE_SPACE = "imagecapturecore-scan-area-upright-raster-v1";

function stationId() {
  const enrolled = stationIdentity.currentStationCode();
  if (enrolled) return enrolled;
  // Explicit local-development compatibility only.  A production daemon must
  // be enrolled rather than deriving authority from a mutable hostname/env.
  if (process.env.NODE_ENV !== "production" && process.env.MINTVAULT_STATION_ID) {
    return String(process.env.MINTVAULT_STATION_ID).replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 128);
  }
  return "unregistered-station";
}

function deviceId() {
  return `mac-${stationId()}`;
}

function jigOrigin() {
  const x = Number(process.env.MINTVAULT_LIDE_SCAN_X_MM);
  const y = Number(process.env.MINTVAULT_LIDE_SCAN_Y_MM);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  return { x, y };
}

/**
 * Persist only an explicitly opted-in station jig file. The live production
 * token file is never an implicit write target: local/development proof sets
 * MINTVAULT_STATION_CONFIG_PATH to its isolated non-secret configuration.
 */
function persistJigOrigin(origin) {
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
  return { configPath, originMm: jigOrigin(), areaMm: PROFILE_AREA_MM, profileVersion: PROFILE_VERSION };
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

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`LiDE bridge timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      try {
        const parsed = JSON.parse(out);
        resolve(helperIntegrity.assertCompatibleResult(parsed));
      } catch {
        reject(new Error(`LiDE bridge exited ${code ?? "?"}: ${Buffer.concat(stderr).toString("utf8").trim() || out || "no result"}`));
      }
    });
  });
}

async function ensureBridge() {
  if (process.platform !== "darwin") throw new Error("Canon LiDE control requires macOS Image Capture");
  // Verification deliberately runs before every spawn. A valid signature from
  // a prior operation cannot authorise a subsequently replaced executable.
  return helperIntegrity.verifiedCaptureHelper().path;
}

async function health() {
  const origin = jigOrigin();
  try {
    const bridge = await ensureBridge();
    const result = await run(bridge, ["health"], 12_000);
    if (result.status === "ready" && !origin) {
      return { ...result, status: "profile_unprovisioned", error: "Canon is connected but the station jig origin is not provisioned", profileVersion: PROFILE_VERSION, workstationId: stationId(), deviceId: deviceId() };
    }
    return { ...result, profileVersion: PROFILE_VERSION, workstationId: stationId(), deviceId: deviceId() };
  } catch (error) {
    return { status: "control_unavailable", error: error.message, profileVersion: PROFILE_VERSION, workstationId: stationId(), deviceId: deviceId() };
  }
}

async function scan(outputDirectory) {
  const origin = jigOrigin();
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
  const stat = fs.statSync(capturedPath);
  if (!stat.isFile() || stat.size < 4) throw new Error("LiDE bridge returned an empty TIFF");
  return {
    path: capturedPath,
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
  const stat = fs.statSync(capturedPath);
  if (!stat.isFile() || stat.size < 4) throw new Error("LiDE bridge returned an empty positioning preview");
  return {
    path: capturedPath,
    sizeBytes: stat.size,
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
  const stat = fs.statSync(capturedPath);
  if (!stat.isFile() || stat.size < 4) throw new Error("LiDE bridge returned an empty calibration TIFF");
  return {
    path: capturedPath,
    sizeBytes: stat.size,
    requestedRegionMm: measured,
    appliedRegionMm: result.scanAreaMm,
    requestedDpi: Number(result.requestedDpi),
    driverResolutionDpi: Number(result.driverResolutionDpi),
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
  _private: { jigOrigin, calibrationRegion, ensureBridge, CALIBRATION_MIN_MM, PLATEN_MAX_MM, PROFILE_AREA_MM, POSITIONING_PREVIEW_DPI },
};
