/**
 * Canon CanoScan LiDE 400 controller for the existing scanner-app process.
 * Development checkouts may build the small ImageCaptureCore adapter locally, but a packaged
 * Partner station app must run the nested prebuilt adapter shipped inside the app bundle. No Canon
 * GUI is automated and the result still travels through the canonical server ingest.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const stationIdentity = require("./station-identity");
/*
 * THE CANONICAL CAPTURE PROFILE — the same module the server validates against. Geometry lives in
 * exactly one place for the same reason the detector does: two copies of "how big is the capture
 * window" is how a station and a server come to disagree about the same physical frame.
 */
const captureProfile = require("../../../shared/lide400-capture-profile.cjs");

const PROFILE_VERSION = "mintvault-canon-lide-400-v3";
const MODEL = "CanoScan LiDE 400";
const APP_DIR = path.resolve(__dirname, "..");
const SOURCE = path.join(APP_DIR, "native", "mintvault-lide-bridge.m");
const PACKAGED_BRIDGE = path.join(APP_DIR, "native", "mintvault-lide-bridge");
const SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const BINARY = path.join(SUPPORT, "mintvault-lide-bridge");
const CALIBRATION_MIN_MM = Object.freeze({ width: 110, height: 140 });
const PLATEN_MAX_MM = captureProfile.PLATEN_MM;
const PROFILE_AREA_MM = captureProfile.STANDARD_TCG.outerWindowMm;
const POSITIONING_PREVIEW_DPI = 300;
const PLACEMENT_PREVIEW_DPI = captureProfile.STANDARD_TCG.placementPreviewDpi;
const POSITIONING_PREVIEW_COORDINATE_SPACE = "imagecapturecore-scan-area-upright-raster-v1";
let buildPromise = null;

function stationId() {
  const enrolled = stationIdentity.currentStationCode();
  if (enrolled) return enrolled;
  // Explicit local-development compatibility only.  A production daemon must
  // be enrolled rather than deriving authority from a mutable hostname/env.
  if (process.env.NODE_ENV !== "production" && process.env.MINTVAULT_STATION_ID) {
    return String(process.env.MINTVAULT_STATION_ID)
      .replace(/[^a-zA-Z0-9._:-]/g, "-")
      .slice(0, 128);
  }
  return "unregistered-station";
}

function deviceId() {
  return `mac-${stationId()}`;
}

/**
 * Read the persisted station configuration back off disk.
 *
 * THE DEFECT THIS CLOSES. `persistJigOrigin` writes the placement to
 * `MINTVAULT_STATION_CONFIG_PATH` **and** sets `process.env` — so a saved calibration worked
 * perfectly for the rest of that run and then VANISHED on the next launch, because nothing ever read
 * the file back. Nothing in this app did. The operator's own record said the placement was saved
 * (the file on disk proved it), while the station reported `profile_unprovisioned`, which gates BOTH
 * `pollTargetedCapture` and `scanActiveTarget` — so a correctly calibrated station could neither
 * claim its armed card nor photograph one, and the only visible symptom was "No card ready".
 *
 * Re-read on every call, cheap and mtime-cached, for the same reason `server-client.liveEnv` is: the
 * file can change under a running process (a placement save from this very app), and a value cached
 * once at boot is how the app ends up disagreeing with its own configuration.
 */
const STATION_CONFIG_KEYS = ["MINTVAULT_LIDE_SCAN_X_MM", "MINTVAULT_LIDE_SCAN_Y_MM"];

/*
 * WHERE THE PLACEMENT LIVES, WITHOUT ANYONE HAVING TO SAY SO.
 *
 * THE DEFECT THIS CLOSES. Persistence used to be enabled ONLY by an exported
 * `MINTVAULT_STATION_CONFIG_PATH`. On 2026-08-18 the Scanner was relaunched without it, the operator
 * moved the capture window, and the save half-landed: the SERVER recorded the new rectangle while
 * `persistJigOrigin` threw, leaving the Mac still scanning the old one. The station had to be
 * repaired before it could scan. A Partner shop launching from an app icon has no shell to export
 * anything into, so "persistence is opt-in via the environment" is not a configuration — it is a
 * latent split-brain waiting for someone to move the jig.
 *
 * So the path is DERIVED, and the environment variable becomes an override rather than a switch:
 *
 *   1. an absolute `MINTVAULT_STATION_CONFIG_PATH` still wins — existing installs and the isolated
 *      per-instance paths the tests use keep working exactly as before;
 *   2. otherwise the canonical file next to the station identity, which every launch can find.
 *
 * The canonical file is a DEDICATED NON-SECRET file, not `~/.mintvault-scanner.env`. That file holds
 * SCANNER_API_TOKEN, and this module's long-standing rule — that the live token file is never an
 * implicit write target — is worth more than the convenience of one fewer file.
 */
const CANONICAL_STATION_CONFIG_PATH = path.join(SUPPORT, "station-config.env");
const LEGACY_STATION_CONFIG_PATH = path.join(os.homedir(), ".mintvault-scanner.env");

function stationConfigPath() {
  const configured = String(process.env.MINTVAULT_STATION_CONFIG_PATH || "").trim();
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return CANONICAL_STATION_CONFIG_PATH;
}

function readPlacementKeys(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    // Only the placement keys are honoured. This file is operator-editable, so it must never be a
    // channel for setting arbitrary environment for this process.
    if (match && STATION_CONFIG_KEYS.includes(match[1])) values[match[1]] = match[2];
  }
  return values;
}

/*
 * One-way, read-only migration off the legacy env file.
 *
 * Stations provisioned by `install.sh` before the canonical path existed hold their placement in
 * `~/.mintvault-scanner.env`. Reading it back means a Mac that stops exporting the variable keeps
 * the rectangle it was already calibrated to, instead of coming up unprovisioned and waiting for a
 * server round-trip to re-adopt. ONLY the two placement keys are read; no secret is read, copied or
 * rewritten, and nothing is ever written back to that file.
 *
 * ONLY for the default instance. `MINTVAULT_SCANS_DIR` is how this app isolates a test or secondary
 * instance from the live station, and a fallback that reaches into the real home directory anyway
 * would punch through that isolation — an isolated instance would inherit the live Mac's placement
 * and report itself provisioned when it is not.
 */
function legacyPlacementValues() {
  if (process.env.MINTVAULT_SCANS_DIR) return {};
  try {
    return readPlacementKeys(LEGACY_STATION_CONFIG_PATH);
  } catch {
    return {};
  }
}

let stationConfigCache = { path: null, mtimeMs: -1, values: {} };
function stationConfigValues() {
  const configured = stationConfigPath();
  let values = null;
  try {
    const stat = fs.statSync(configured);
    if (stationConfigCache.path === configured && stationConfigCache.mtimeMs === stat.mtimeMs) {
      return stationConfigCache.values;
    }
    values = readPlacementKeys(configured);
    stationConfigCache = { path: configured, mtimeMs: stat.mtimeMs, values };
  } catch {
    // A missing or unreadable file means "no persisted placement", which `jigOrigin` already treats
    // as unprovisioned. It must never be an exception on the health path.
    values = null;
  }
  if (values && STATION_CONFIG_KEYS.some((key) => values[key] !== undefined)) return values;
  // Nothing canonical yet — fall back to a legacy install's placement rather than reporting a
  // calibrated station as unprovisioned.
  if (configured === CANONICAL_STATION_CONFIG_PATH) {
    const legacy = legacyPlacementValues();
    if (STATION_CONFIG_KEYS.some((key) => legacy[key] !== undefined)) return legacy;
  }
  return values || {};
}

/**
 * The saved placement, or null.
 *
 * `process.env` WINS, so an explicitly launched override and the value `persistJigOrigin` sets
 * in-process both still take precedence; the file is the fallback that makes a saved placement
 * survive a restart.
 */
function jigOrigin() {
  const configured = stationConfigValues();
  const x = Number(process.env.MINTVAULT_LIDE_SCAN_X_MM ?? configured.MINTVAULT_LIDE_SCAN_X_MM);
  const y = Number(process.env.MINTVAULT_LIDE_SCAN_Y_MM ?? configured.MINTVAULT_LIDE_SCAN_Y_MM);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  /*
   * A saved origin outside the profile's platen bounds is treated as UNPROVISIONED, not clamped.
   *
   * THE DEFECT THIS CLOSES. The live station was calibrated to (0, 0) — the platen ORIGIN — which is
   * exactly where the LiDE's bezel band sits: measured non-card foreground in the first ~1.23 mm of
   * the top edge and ~0.72 mm of the left edge of every one of the eight preserved masters. Silently
   * clamping such an origin to (5, 5) would move a station's physical capture area without anyone
   * deciding to, and every previously captured coordinate would then refer to a different rectangle.
   *
   * Failing closed instead forces one explicit recalibration onto the new geometry, which is what
   * "moving the window is a recalibration action" has to mean if it means anything.
   */
  try {
    if (captureProfile.clampCaptureOriginMm({ x, y }).clamped) return null;
  } catch {
    return null;
  }
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
  /*
   * REFUSE an out-of-bounds origin rather than clamping it. The setup UI constrains the drag live,
   * so a request that arrives here outside the platen is a bug or a tampered payload, and quietly
   * moving it somewhere else would persist a capture window nobody chose.
   */
  const bounds = captureProfile.clampCaptureOriginMm({ x, y });
  if (bounds.clamped) {
    throw new Error(
      `LiDE capture-window origin ${x}, ${y} mm is outside the usable platen ` +
        `(X ${bounds.boundsMm.minX}-${bounds.boundsMm.maxX} mm, Y ${bounds.boundsMm.minY}-${bounds.boundsMm.maxY} mm)`
    );
  }
  const configPath = stationConfigPath();
  /*
   * CREATE the canonical file rather than refusing. A first calibration on a new Mac necessarily
   * happens before any placement file exists, and "the file is missing" was previously indistinguishable
   * from "persistence is disabled" — both threw, and both stranded the operator with a server that had
   * already recorded the move. Only the derived canonical path is created; an explicitly configured
   * path that does not exist is still an operator error and still refuses.
   */
  let current;
  try {
    current = fs.readFileSync(configPath, "utf8");
  } catch {
    if (configPath !== CANONICAL_STATION_CONFIG_PATH) {
      throw new Error("Configured station file is unavailable; placement was not persisted");
    }
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("Station configuration file could not be created; placement was not persisted");
      }
    }
    current = fs.readFileSync(configPath, "utf8");
  }
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

/**
 * Adopt the SERVER's recorded capture rectangle as this Mac's acquisition origin.
 *
 * NOT a calibration. Nothing is written back to the server and nothing physical is decided here —
 * this only stops the Mac being a second, emptier source of truth about a rectangle the server
 * already owns. A station whose local origin has never been written is `profile_unprovisioned` and
 * cannot scan; with a VALID server calibration in hand, that state is pure bookkeeping.
 *
 * Writes the station config so it survives a restart, and is a no-op when the two already agree, so
 * it can run on every session refresh without churning the file.
 *
 * Returns the adopted origin, or null when there is nothing legal to adopt.
 */
function adoptServerCaptureWindow(region) {
  const x = Number(region?.x);
  const y = Number(region?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // The server validated this before publishing it; refuse anything that would not clamp cleanly
  // here too, rather than trusting a payload because of where it came from.
  if (captureProfile.clampCaptureOriginMm({ x, y }).clamped) return null;
  const current = jigOrigin();
  if (current && Math.abs(current.x - x) < 0.001 && Math.abs(current.y - y) < 0.001) return current;
  /*
   * The process environment FIRST, and it is the part that matters: `jigOrigin()` reads it ahead of
   * the config file, so this makes the station usable immediately. Writing the file is a durability
   * bonus, and an instance with no `MINTVAULT_STATION_CONFIG_PATH` — which is a supported
   * configuration, not a fault — simply re-adopts from the server on the next session refresh.
   * Failing the whole adoption because the optional half is unavailable would leave a station
   * unable to scan for a reason that does not affect scanning.
   */
  process.env.MINTVAULT_LIDE_SCAN_X_MM = String(Number(x.toFixed(2)));
  process.env.MINTVAULT_LIDE_SCAN_Y_MM = String(Number(y.toFixed(2)));
  try {
    persistJigOrigin({ x, y });
  } catch {
    // Durability only. The in-process origin above is already live for this session.
  }
  return jigOrigin();
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
    throw new Error(
      `LiDE calibration region must be at least ${CALIBRATION_MIN_MM.width} x ${CALIBRATION_MIN_MM.height} mm`
    );
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
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      try {
        const parsed = JSON.parse(out);
        resolve(parsed);
      } catch {
        reject(
          new Error(
            `LiDE bridge exited ${code ?? "?"}: ${Buffer.concat(stderr).toString("utf8").trim() || out || "no result"}`
          )
        );
      }
    });
  });
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("LiDE bridge build timed out"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(`LiDE bridge build failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`}`)
        );
    });
  });
}

function isPackagedRuntime(env = process.env, appDir = APP_DIR, resourcesPath = process.resourcesPath) {
  if (env.MINTVAULT_SCANNER_PACKAGED === "1") return true;
  if (!resourcesPath) return false;
  const resourcesRoot = path.resolve(String(resourcesPath));
  const packagedAppRoot = path.join(resourcesRoot, "app");
  const resolvedAppDir = path.resolve(String(appDir));
  return resolvedAppDir === packagedAppRoot || resolvedAppDir.startsWith(`${packagedAppRoot}${path.sep}`);
}

function validatePackagedBridge(candidate = PACKAGED_BRIDGE) {
  const resolved = path.resolve(candidate);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error("Packaged LiDE ImageCaptureCore bridge is missing; reinstall the current MintVault Scanner app");
  }
  if (!stat.isFile()) {
    throw new Error("Packaged LiDE ImageCaptureCore bridge is not a file; reinstall the current MintVault Scanner app");
  }
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw new Error("Packaged LiDE ImageCaptureCore bridge is not executable; reinstall the current MintVault Scanner app");
  }
  return resolved;
}

async function ensureBridge() {
  if (process.platform !== "darwin") throw new Error("Canon LiDE control requires macOS Image Capture");
  if (isPackagedRuntime()) return validatePackagedBridge(PACKAGED_BRIDGE);
  // Rebuild after an app update as well as on the first launch.  Otherwise a
  // LaunchAgent can keep an older native adapter indefinitely even though its
  // JavaScript wrapper has been upgraded.
  if (fs.existsSync(BINARY) && fs.existsSync(SOURCE)) {
    const binaryMtime = fs.statSync(BINARY).mtimeMs;
    const sourceMtime = fs.statSync(SOURCE).mtimeMs;
    if (binaryMtime >= sourceMtime) return BINARY;
  }
  if (!buildPromise) {
    buildPromise = (async () => {
      if (!fs.existsSync(SOURCE)) throw new Error("LiDE ImageCaptureCore bridge source is missing");
      fs.mkdirSync(SUPPORT, { recursive: true });
      await runCommand(
        "/usr/bin/xcrun",
        [
          "clang",
          "-fobjc-arc",
          "-fmodules",
          "-framework",
          "Foundation",
          "-framework",
          "ImageCaptureCore",
          SOURCE,
          "-o",
          BINARY,
        ],
        60_000
      );
      fs.chmodSync(BINARY, 0o700);
      return BINARY;
    })().finally(() => {
      buildPromise = null;
    });
  }
  return buildPromise;
}

async function health() {
  const origin = jigOrigin();
  try {
    const bridge = await ensureBridge();
    const result = await run(bridge, ["health"], 12_000);
    // The saved window travels with health so the setup UI opens on the placement this station is
    // actually using, rather than on the default with no way to tell the two apart.
    const captureWindow = {
      originMm: origin,
      areaMm: PROFILE_AREA_MM,
      profileVersion: captureProfile.STANDARD_TCG.version,
    };
    if (result.status === "ready" && !origin) {
      return {
        ...result,
        status: "profile_unprovisioned",
        error: "Canon is connected but the station capture window is not provisioned",
        profileVersion: PROFILE_VERSION,
        workstationId: stationId(),
        deviceId: deviceId(),
        captureWindow,
      };
    }
    return {
      ...result,
      profileVersion: PROFILE_VERSION,
      workstationId: stationId(),
      deviceId: deviceId(),
      captureWindow,
    };
  } catch (error) {
    return {
      status: "control_unavailable",
      error: error.message,
      profileVersion: PROFILE_VERSION,
      workstationId: stationId(),
      deviceId: deviceId(),
    };
  }
}

async function scan(outputDirectory) {
  const origin = jigOrigin();
  if (!origin) throw new Error("Scanner jig origin is not provisioned; run the LiDE station acceptance setup");
  const startedAt = new Date().toISOString();
  const bridge = await ensureBridge();
  const result = await run(bridge, ["scan", outputDirectory, String(origin.x), String(origin.y)], 360_000);
  if (result.status !== "captured" || typeof result.path !== "string")
    throw new Error(result.error || "LiDE capture failed");
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
  if (
    result.previewCoordinateSpace !== POSITIONING_PREVIEW_COORDINATE_SPACE ||
    Number(result.previewRasterOrientation) !== 1
  ) {
    throw new Error(
      "LiDE positioning Preview did not return the canonical upright ImageCaptureCore coordinate contract"
    );
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
 * Acquire the PER-SIDE PLACEMENT PREVIEW: the calibrated capture window only, at 300 DPI, as JPEG.
 *
 * WHY THIS EXISTS. Until now the operator scanned at 1200 DPI — 45 seconds, measured — and only then
 * learned the placement was wrong. Four of today's eight masters were discarded that way. This
 * previews the IDENTICAL rectangle the evidence capture will use, so the gate and the master frame
 * the same physical area, at a quarter of the linear resolution.
 *
 * It shares `scan`'s origin and window but NOT its authority: no certificate/session input, JPEG
 * only, no TIFF, no provenance acceptance, and no server evidence path. A green verdict from this
 * frame never entitles anything — the server still re-derives geometry from the immutable master.
 */
async function placementPreview(outputDirectory) {
  const origin = jigOrigin();
  if (!origin) throw new Error("Scanner capture window is not provisioned; run the LiDE station setup");
  const bridge = await ensureBridge();
  const startedAt = new Date().toISOString();
  const result = await run(bridge, ["place", outputDirectory, String(origin.x), String(origin.y)], 180_000);
  if (result.status !== "captured" || result.captureKind !== "placement_preview" || typeof result.path !== "string") {
    throw new Error(result.error || "LiDE placement preview failed");
  }
  if (
    result.previewCoordinateSpace !== POSITIONING_PREVIEW_COORDINATE_SPACE ||
    Number(result.previewRasterOrientation) !== 1
  ) {
    throw new Error("LiDE placement Preview did not return the canonical upright ImageCaptureCore coordinate contract");
  }
  if (Number(result.driverResolutionDpi) !== PLACEMENT_PREVIEW_DPI) {
    throw new Error("LiDE placement Preview did not apply the locked 300-DPI preview resolution");
  }
  const root = path.resolve(outputDirectory) + path.sep;
  const capturedPath = path.resolve(result.path);
  if (!capturedPath.startsWith(root) || ![".jpg", ".jpeg"].includes(path.extname(capturedPath).toLowerCase())) {
    throw new Error("LiDE bridge returned an unsafe or non-JPEG placement preview");
  }
  const stat = fs.statSync(capturedPath);
  if (!stat.isFile() || stat.size < 4) throw new Error("LiDE bridge returned an empty placement preview");
  /*
   * The applied rectangle must be the profile window at the calibrated origin. If the driver applied
   * anything else, the gate would be judging a different frame from the one the master will contain,
   * so this refuses rather than analysing it.
   */
  const applied = result.scanAreaMm || {};
  const expected = captureProfile.captureWindowRectMm(origin);
  const agrees = ["x", "y", "width", "height"].every((key) => Math.abs(Number(applied[key]) - expected[key]) <= 0.5);
  if (!agrees) {
    throw new Error("LiDE placement Preview did not apply the calibrated capture window");
  }
  return {
    path: capturedPath,
    sizeBytes: stat.size,
    originMm: origin,
    areaMm: expected,
    appliedRegionMm: applied,
    requestedDpi: Number(result.requestedDpi),
    driverResolutionDpi: Number(result.driverResolutionDpi),
    coordinateSpace: result.previewCoordinateSpace,
    rasterOrientation: Number(result.previewRasterOrientation),
    capturedAt: startedAt,
    scanner: { model: result.model || MODEL, deviceId: result.deviceId || "", serial: result.serial || null },
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
    [
      "calibrate",
      outputDirectory,
      String(measured.x),
      String(measured.y),
      String(measured.width),
      String(measured.height),
    ],
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

async function diagnosticCapabilities() {
  const bridge = await ensureBridge();
  return run(bridge, ["capabilities"], 30_000);
}

function diagnosticExperimentRegion(input) {
  const x = Number(input?.x);
  const y = Number(input?.y);
  const width = Number(input?.width);
  const height = Number(input?.height);
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new Error("LiDE experiment region must contain finite X/Y/width/height millimetres");
  }
  if (x + width > PLATEN_MAX_MM.width || y + height > PLATEN_MAX_MM.height) {
    throw new Error("LiDE experiment region exceeds the physical platen");
  }
  return { x, y, width, height };
}

async function diagnosticCapture(outputDirectory, options) {
  const dpi = Number(options?.dpi);
  if (!Number.isInteger(dpi) || dpi <= 0) throw new Error("LiDE experiment DPI must be a positive integer");
  const region = diagnosticExperimentRegion(options?.region);
  const bridge = await ensureBridge();
  const startedAt = new Date().toISOString();
  const result = await run(
    bridge,
    [
      "experiment",
      outputDirectory,
      String(dpi),
      String(region.x),
      String(region.y),
      String(region.width),
      String(region.height),
    ],
    720_000
  );
  if (
    result.status !== "captured" ||
    result.captureKind !== "diagnostic_experiment" ||
    typeof result.path !== "string"
  ) {
    throw new Error(result.error || "LiDE diagnostic experiment capture failed");
  }
  const root = path.resolve(outputDirectory) + path.sep;
  const capturedPath = path.resolve(result.path);
  if (!capturedPath.startsWith(root) || ![".tif", ".tiff"].includes(path.extname(capturedPath).toLowerCase())) {
    throw new Error("LiDE bridge returned an unsafe or non-TIFF diagnostic output path");
  }
  const stat = fs.statSync(capturedPath);
  if (!stat.isFile() || stat.size < 4) throw new Error("LiDE bridge returned an empty diagnostic TIFF");
  return {
    path: capturedPath,
    sizeBytes: stat.size,
    requestedRegionMm: region,
    appliedRegionMm: result.scanAreaMm,
    requestedDpi: dpi,
    driverResolutionDpi: Number(result.driverResolutionDpi),
    physicalScanDurationMs: Number(result.physicalScanDurationMs),
    capturedAt: startedAt,
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
  placementPreview,
  scanCalibrationRegion,
  diagnosticCapabilities,
  diagnosticCapture,
  persistJigOrigin,
  adoptServerCaptureWindow,
  captureProfile,
  stationConfigPath,
  _private: {
    jigOrigin,
    stationConfigValues,
    CANONICAL_STATION_CONFIG_PATH,
    LEGACY_STATION_CONFIG_PATH,
    PACKAGED_BRIDGE,
    calibrationRegion,
    diagnosticExperimentRegion,
    ensureBridge,
    isPackagedRuntime,
    validatePackagedBridge,
    CALIBRATION_MIN_MM,
    PLATEN_MAX_MM,
    PROFILE_AREA_MM,
    POSITIONING_PREVIEW_DPI,
    PLACEMENT_PREVIEW_DPI,
  },
};
