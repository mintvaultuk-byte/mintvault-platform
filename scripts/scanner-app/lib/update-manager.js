const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const APP_IDENTIFIER = "com.mintvault.scanner";
const PRODUCT_NAME = "MintVault Scanner";
const ARCHITECTURE = "arm64";
const MINIMUM_MACOS = "12.0";
const UPDATE_METADATA = "latest-mac.yml";
const RELEASE_MANIFEST = "mintvault-scanner-release.json";
const CHECKSUMS = "SHA256SUMS";
const MAX_LATEST_BYTES = 1024 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const MAX_UPDATE_ARCHIVE_BYTES = 1024 ** 3;
const MIN_UPDATE_DISK_RESERVE_BYTES = 2 * 1024 ** 3;
const UPDATE_DISK_RESERVE_FRACTION = 0.05;
const DEFAULT_EVIDENCE_TIMEOUT_MS = 30_000;
const DEFAULT_ARTIFACT_TIMEOUT_MS = 15 * 60_000;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
  if (!match) throw new Error("MintVault Scanner version is invalid");
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function exactUpdateBase(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw new Error("MintVault update origin is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("MintVault update origin must be credential-free HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

function parseFlatYaml(source) {
  const result = {};
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*):\s+([^#]+?)\s*$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error("packaged update configuration is malformed");
    result[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

function validatePackagedUpdateConfig(source, releaseTrust) {
  const config = parseFlatYaml(source);
  const keys = Object.keys(config).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["channel", "provider", "updaterCacheDirName", "url"])) {
    throw new Error("packaged update configuration keys are not exact");
  }
  if (config.provider !== "generic" || config.channel !== "latest"
      || config.updaterCacheDirName !== "mintvault-scanner-app-updater"
      || exactUpdateBase(config.url) !== exactUpdateBase(releaseTrust?.updateBaseUrl)) {
    throw new Error("packaged update configuration does not match release trust");
  }
  return Object.freeze(config);
}

function artifactName(value, updateBaseUrl) {
  let parsed;
  try { parsed = new URL(String(value || ""), `${updateBaseUrl}/`); }
  catch { throw new Error("update artifact URL is invalid"); }
  const base = new URL(`${updateBaseUrl}/`);
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) {
    throw new Error("update artifact escaped the pinned MintVault origin");
  }
  const name = path.posix.basename(parsed.pathname);
  if (!name || decodeURIComponent(name) !== name || name.includes("..")) throw new Error("update artifact name is invalid");
  return name;
}

function parseChecksums(source) {
  const entries = new Map();
  for (const line of String(source || "").trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error("MintVault update checksums are malformed or duplicated");
    entries.set(match[2], match[1]);
  }
  return entries;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function exactObjectKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields are not exact`);
  }
}

function validatePolicyArtifact(value, { filename, sha512 = false, maxBytes }) {
  exactObjectKeys(value, sha512 ? ["filename", "size", "sha256", "sha512"] : ["filename", "size", "sha256"], `${filename} policy artifact`);
  if (value.filename !== filename || !Number.isSafeInteger(value.size) || value.size <= 0
      || value.size > maxBytes
      || !/^[a-f0-9]{64}$/.test(String(value.sha256 || ""))
      || (sha512 && !/^[A-Za-z0-9+/]{86}==$/.test(String(value.sha512 || "")))) {
    throw new Error(`${filename} policy artifact is invalid`);
  }
  return Object.freeze({ ...value });
}

function validateUpdatePolicy(value, { currentVersion, minimumVersion, releaseTrust, now = Date.now() }) {
  exactObjectKeys(value, [
    "schemaVersion", "authority", "policyId", "operation", "targetVersion", "minimumSupportedVersion",
    "teamIdentifier", "sourceCommit", "issuedAt", "expiresAt", "reason", "artifacts",
  ], "MintVault update policy");
  if (value.schemaVersion !== 1 || value.authority !== "MINTVAULT_STATION_POLICY"
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{7,127}$/.test(String(value.policyId || ""))
      || !new Set(["UPDATE", "ROLLBACK"]).has(value.operation)
      || value.teamIdentifier !== releaseTrust?.teamIdentifier
      || !/^[a-f0-9]{40}$/.test(String(value.sourceCommit || ""))
      || typeof value.reason !== "string" || value.reason.trim().length < 3 || value.reason.length > 240) {
    throw new Error("MintVault update policy authority is invalid");
  }
  parseVersion(value.targetVersion);
  parseVersion(value.minimumSupportedVersion);
  if (!minimumVersion || compareVersions(value.minimumSupportedVersion, minimumVersion) !== 0
      || compareVersions(value.targetVersion, minimumVersion) < 0) {
    throw new Error("MintVault update policy does not match the authenticated minimum version");
  }
  const direction = compareVersions(value.targetVersion, currentVersion);
  if ((value.operation === "UPDATE" && direction <= 0) || (value.operation === "ROLLBACK" && direction >= 0)) {
    throw new Error("MintVault update policy direction is invalid");
  }
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt
      || expiresAt - issuedAt > 24 * 60 * 60 * 1000 || now < issuedAt - 5 * 60 * 1000 || now >= expiresAt) {
    throw new Error("MintVault update policy lifetime is invalid or expired");
  }
  exactObjectKeys(value.artifacts, ["zip", "dmg", "latest"], "MintVault update policy artifacts");
  const prefix = `MintVault-Scanner-${value.targetVersion}-arm64`;
  const artifacts = Object.freeze({
    zip: validatePolicyArtifact(value.artifacts.zip, { filename: `${prefix}.zip`, sha512: true, maxBytes: MAX_UPDATE_ARCHIVE_BYTES }),
    dmg: validatePolicyArtifact(value.artifacts.dmg, { filename: `${prefix}.dmg`, maxBytes: MAX_UPDATE_ARCHIVE_BYTES }),
    latest: validatePolicyArtifact(value.artifacts.latest, { filename: UPDATE_METADATA, maxBytes: MAX_LATEST_BYTES }),
  });
  const normalized = Object.freeze({ ...value, reason: value.reason.trim(), artifacts });
  return Object.freeze({
    ...normalized,
    fingerprint: crypto.createHash("sha256").update(canonicalJson(normalized)).digest("hex"),
  });
}

function validateReleaseEvidence({ manifest, checksumText, updateInfo, currentVersion, minimumVersion, releaseTrust, policy }) {
  if (!policy?.fingerprint) throw new Error("Authenticated MintVault update policy is required");
  const version = String(updateInfo?.version || "");
  parseVersion(version);
  const direction = compareVersions(version, currentVersion);
  if (version !== policy.targetVersion
      || (policy.operation === "UPDATE" && direction <= 0)
      || (policy.operation === "ROLLBACK" && direction >= 0)) {
    throw new Error("Static update metadata cannot select or change the authenticated target");
  }
  if (minimumVersion && compareVersions(version, minimumVersion) < 0) {
    throw new Error("Available update does not satisfy MintVault's minimum supported version");
  }
  const updateBaseUrl = exactUpdateBase(releaseTrust?.updateBaseUrl);
  const updateZip = (Array.isArray(updateInfo?.files) ? updateInfo.files : [])
    .map((entry) => ({ ...entry, filename: artifactName(entry.url, updateBaseUrl) }))
    .find((entry) => entry.filename.endsWith(".zip"));
  const expectedZip = `MintVault-Scanner-${version}-arm64.zip`;
  const expectedDmg = `MintVault-Scanner-${version}-arm64.dmg`;
  if (!updateZip || updateZip.filename !== expectedZip
      || !Number.isSafeInteger(updateZip.size) || updateZip.size !== policy.artifacts.zip.size
      || !/^[A-Za-z0-9+/]{86}==$/.test(String(updateZip.sha512 || ""))) {
    throw new Error("Update metadata does not bind the canonical signed ZIP");
  }
  const exactSigning = {
    teamIdentifier: releaseTrust.teamIdentifier,
    hardenedRuntime: true,
    notarized: true,
    appStapled: true,
    dmgStapled: true,
    gatekeeperAssessed: true,
  };
  const expectedArtifactNames = [expectedDmg, expectedZip, UPDATE_METADATA].sort();
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const artifactNames = artifacts.map((entry) => entry?.filename);
  if (manifest?.schemaVersion !== 1 || manifest.packageMode !== "release" || manifest.releaseReady !== true
      || manifest.source?.treeState !== "clean" || manifest.source?.commit !== policy.sourceCommit
      || manifest.app?.name !== PRODUCT_NAME || manifest.app?.version !== version
      || manifest.app?.bundleIdentifier !== APP_IDENTIFIER || manifest.app?.architecture !== ARCHITECTURE
      || manifest.app?.minimumMacOS !== MINIMUM_MACOS || !/^[a-f0-9]{64}$/.test(String(manifest.app?.bundleContentSha256 || ""))
      || JSON.stringify(manifest.signing) !== JSON.stringify(exactSigning)
      || manifest.update?.metadata !== UPDATE_METADATA || manifest.update?.zipSha512 !== updateZip.sha512
      || updateZip.sha512 !== policy.artifacts.zip.sha512
      || artifactNames.length !== new Set(artifactNames).size
      || JSON.stringify([...artifactNames].sort()) !== JSON.stringify(expectedArtifactNames)) {
    throw new Error("MintVault release manifest does not authorise this update candidate");
  }
  const checksums = parseChecksums(checksumText);
  if (checksums.size !== expectedArtifactNames.length
      || expectedArtifactNames.some((name) => !checksums.has(name))) {
    throw new Error("MintVault update checksum set is not exact");
  }
  for (const artifact of artifacts) {
    const policyArtifact = artifact.filename === expectedZip
      ? policy.artifacts.zip
      : artifact.filename === expectedDmg
        ? policy.artifacts.dmg
        : policy.artifacts.latest;
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))
        || checksums.get(artifact.filename) !== artifact.sha256
        || artifact.size !== policyArtifact.size || artifact.sha256 !== policyArtifact.sha256) {
      throw new Error("MintVault update artifact/checksum binding is invalid");
    }
  }
  const zipArtifact = artifacts.find((entry) => entry.filename === expectedZip);
  return Object.freeze({
    version,
    expectedZip,
    expectedDmg,
    zipSha256: zipArtifact.sha256,
    zipSha512: policy.artifacts.zip.sha512,
    zipSize: policy.artifacts.zip.size,
    dmgSha256: policy.artifacts.dmg.sha256,
    dmgSize: policy.artifacts.dmg.size,
    policyFingerprint: policy.fingerprint,
    updateBaseUrl,
    manifest,
  });
}

function responseContentLength(response, label) {
  const raw = response?.headers?.get?.("content-length");
  if (raw == null || raw === "") return null;
  if (!/^(0|[1-9]\d*)$/.test(String(raw))) throw new Error(`${label} content length is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} content length is invalid`);
  return value;
}

function assertDownloadCapacity(directory, incomingBytes) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const values = fs.statfsSync(directory);
  const availableBytes = Number(values.bavail) * Number(values.bsize);
  const totalBytes = Number(values.blocks) * Number(values.bsize);
  const reserveBytes = Math.max(MIN_UPDATE_DISK_RESERVE_BYTES, Math.floor(totalBytes * UPDATE_DISK_RESERVE_FRACTION));
  if (!Number.isSafeInteger(incomingBytes) || availableBytes - incomingBytes < reserveBytes) {
    throw new Error("MintVault update download would consume the encrypted-capture safety reserve");
  }
}

async function fetchBoundedBytes(fetchImpl, url, {
  label,
  accept,
  maxBytes,
  expectedSize = null,
  expectedSha256 = null,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept },
      signal: controller.signal,
    });
    if (!response?.ok || !response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
      throw new Error(`${label} is not available`);
    }
    const advertised = responseContentLength(response, label);
    if (advertised != null && (advertised > maxBytes || (expectedSize != null && advertised !== expectedSize))) {
      throw new Error(`${label} content length does not match authenticated policy`);
    }
    const chunks = [];
    const hash = crypto.createHash("sha256");
    let received = 0;
    for await (const rawChunk of response.body) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      received += chunk.length;
      if (received > maxBytes || (expectedSize != null && received > expectedSize)) {
        controller.abort();
        throw new Error(`${label} exceeded its authenticated byte limit`);
      }
      chunks.push(chunk);
      hash.update(chunk);
    }
    if (expectedSize != null && received !== expectedSize) throw new Error(`${label} size does not match authenticated policy`);
    if (expectedSha256 != null && hash.digest("hex") !== expectedSha256) throw new Error(`${label} digest does not match authenticated policy`);
    return Buffer.concat(chunks, received);
  } catch (error) {
    if (controller.signal.aborted && !/byte limit/i.test(String(error?.message || ""))) {
      throw new Error(`${label} download timed out or was cancelled`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBoundedFile(fetchImpl, url, destination, {
  label,
  accept,
  expectedSize,
  expectedSha256,
  expectedSha512 = null,
  maxBytes,
  timeoutMs,
  cancellationToken = null,
  onProgress = null,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const cancel = () => controller.abort();
  cancellationToken?.onCancel?.(cancel);
  let received = 0;
  const sha256Hash = crypto.createHash("sha256");
  const sha512Hash = expectedSha512 == null ? null : crypto.createHash("sha512");
  try {
    const response = await fetchImpl(String(url), {
      method: "GET",
      redirect: "error",
      headers: { accept },
      signal: controller.signal,
    });
    if (!response?.ok || !response.body) throw new Error(`${label} is not available`);
    const advertised = responseContentLength(response, label);
    if (advertised != null && (advertised !== expectedSize || advertised > maxBytes)) {
      throw new Error(`${label} content length does not match authenticated policy`);
    }
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (cancellationToken?.cancelled) return callback(new Error(`${label} download was cancelled`));
        if (received > expectedSize || received > maxBytes) {
          controller.abort();
          return callback(new Error(`${label} exceeded its authenticated byte limit`));
        }
        sha256Hash.update(bytes);
        sha512Hash?.update(bytes);
        onProgress?.({
          total: expectedSize,
          delta: bytes.length,
          transferred: received,
          percent: (received / expectedSize) * 100,
          bytesPerSecond: 0,
        });
        callback(null, bytes);
      },
    });
    await pipeline(response.body, limiter, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    if (received !== expectedSize || sha256Hash.digest("hex") !== expectedSha256
        || (sha512Hash && sha512Hash.digest("base64") !== expectedSha512)) {
      throw new Error(`${label} does not match authenticated policy`);
    }
    return destination;
  } catch (error) {
    if (controller.signal.aborted && !/byte limit|cancelled/i.test(String(error?.message || ""))) {
      throw new Error(`${label} download timed out or was cancelled`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    cancellationToken?.removeListener?.("cancel", cancel);
  }
}

function publicError(error) {
  const message = String(error?.message || error || "");
  if (/minimum supported version/i.test(message)) return "The published update does not satisfy MintVault's required version.";
  if (/policy/i.test(message)) return "An authenticated MintVault update policy is not available for this exact release.";
  if (/downgrade|same-version|authenticated target|direction/i.test(message)) return "MintVault refused a release outside the authenticated update target.";
  if (/not available/i.test(message)) return "No newer approved MintVault Scanner release is available yet.";
  return "MintVault could not verify the signed update set. Use the approved DMG reinstall option or contact support.";
}

function createUpdateManager({
  autoUpdater,
  appVersion,
  releaseTrust,
  resourcesPath,
  downloadDirectory,
  fetchImpl,
  onStatus = () => {},
  isRestartSafe = () => true,
  beforeInstall = () => {},
  readFile = fs.readFileSync,
  now = () => Date.now(),
  evidenceTimeoutMs = DEFAULT_EVIDENCE_TIMEOUT_MS,
  artifactTimeoutMs = DEFAULT_ARTIFACT_TIMEOUT_MS,
}) {
  const enabled = releaseTrust?.packageMode === "release";
  let minimumVersion = null;
  let authenticatedPolicy = null;
  let verifiedEvidence = null;
  let readyCandidate = null;
  let readyDmgCandidate = null;
  let inFlight = null;
  let dmgInFlight = null;
  let releaseInstallAuthority = null;
  let state = Object.freeze({ status: enabled ? "idle" : "disabled", currentVersion: appVersion });

  const publish = (next) => {
    state = Object.freeze({ currentVersion: appVersion, ...next });
    onStatus(state);
    return state;
  };

  if (enabled) {
    if (!path.isAbsolute(String(downloadDirectory || ""))) throw new Error("MintVault verified DMG directory must be absolute");
    const configSource = readFile(path.join(resourcesPath, "app-update.yml"), "utf8");
    validatePackagedUpdateConfig(configSource, releaseTrust);
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.channel = "latest";
    autoUpdater.on("download-progress", (progress) => publish({
      status: "downloading",
      version: verifiedEvidence?.version || null,
      percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null,
    }));
    autoUpdater.on("error", (error) => {
      if (releaseInstallAuthority) {
        const release = releaseInstallAuthority;
        releaseInstallAuthority = null;
        release();
      }
      publish({ status: "error", error: publicError(error) });
    });
  }

  if (!Number.isSafeInteger(evidenceTimeoutMs) || evidenceTimeoutMs <= 0
      || !Number.isSafeInteger(artifactTimeoutMs) || artifactTimeoutMs <= 0) {
    throw new Error("MintVault update network timeouts are invalid");
  }

  async function fetchEvidence(updateInfo) {
    const base = exactUpdateBase(releaseTrust.updateBaseUrl);
    const [manifestBytes, checksumBytes] = await Promise.all([
      fetchBoundedBytes(fetchImpl, `${base}/${RELEASE_MANIFEST}`, {
        label: "MintVault release manifest", accept: "application/json", maxBytes: MAX_RELEASE_MANIFEST_BYTES, timeoutMs: evidenceTimeoutMs,
      }),
      fetchBoundedBytes(fetchImpl, `${base}/${CHECKSUMS}`, {
        label: "MintVault release checksums", accept: "text/plain", maxBytes: MAX_CHECKSUM_BYTES, timeoutMs: evidenceTimeoutMs,
      }),
    ]);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw new Error("MintVault release manifest is invalid"); }
    return validateReleaseEvidence({
      manifest,
      checksumText: checksumBytes.toString("utf8"),
      updateInfo,
      currentVersion: appVersion,
      minimumVersion,
      releaseTrust,
      policy: authenticatedPolicy,
    });
  }

  function clearCandidate() {
    verifiedEvidence = null;
    readyCandidate = null;
    readyDmgCandidate = null;
  }

  function currentPolicy() {
    if (!authenticatedPolicy) throw new Error("Authenticated MintVault update policy is required");
    const rawPolicy = { ...authenticatedPolicy };
    delete rawPolicy.fingerprint;
    authenticatedPolicy = validateUpdatePolicy(rawPolicy, {
      currentVersion: appVersion,
      minimumVersion,
      releaseTrust,
      now: now(),
    });
    return authenticatedPolicy;
  }

  async function downloadZipFromEvent(evidence) {
    let downloadedFile = null;
    const onDownloaded = (event) => { downloadedFile = event?.downloadedFile || null; };
    const httpExecutor = autoUpdater.httpExecutor;
    if (!httpExecutor || typeof httpExecutor.download !== "function") {
      throw new Error("MintVault updater transport cannot enforce the authenticated ZIP size");
    }
    assertDownloadCapacity(downloadDirectory, evidence.zipSize);
    const originalDownload = httpExecutor.download;
    httpExecutor.download = async (url, destination, options = {}) => {
      if (artifactName(String(url), evidence.updateBaseUrl) !== evidence.expectedZip) {
        throw new Error("MintVault updater requested an unauthorised ZIP path");
      }
      return downloadBoundedFile(fetchImpl, url, destination, {
        label: "MintVault update ZIP",
        accept: "application/zip",
        expectedSize: evidence.zipSize,
        expectedSha256: evidence.zipSha256,
        expectedSha512: evidence.zipSha512,
        maxBytes: MAX_UPDATE_ARCHIVE_BYTES,
        timeoutMs: artifactTimeoutMs,
        cancellationToken: options.cancellationToken,
        onProgress: options.onProgress,
      });
    };
    autoUpdater.once("update-downloaded", onDownloaded);
    try {
      await autoUpdater.downloadUpdate();
    } finally {
      autoUpdater.removeListener("update-downloaded", onDownloaded);
      httpExecutor.download = originalDownload;
    }
    return downloadedFile;
  }

  async function checkStaticMetadata(policy) {
    const httpExecutor = autoUpdater.httpExecutor;
    if (!httpExecutor || typeof httpExecutor.request !== "function") {
      throw new Error("MintVault updater transport cannot enforce the authenticated metadata size");
    }
    const originalRequest = httpExecutor.request;
    httpExecutor.request = async (options) => {
      const url = options instanceof URL
        ? options
        : new URL(options?.href || `${options?.protocol || "https:"}//${options?.hostname || options?.host || ""}${options?.path || "/"}`);
      if (artifactName(url.toString(), exactUpdateBase(releaseTrust.updateBaseUrl)) !== UPDATE_METADATA) {
        throw new Error("MintVault updater requested unauthorised static metadata");
      }
      const bytes = await fetchBoundedBytes(fetchImpl, url.toString(), {
        label: "MintVault update metadata",
        accept: "text/yaml",
        maxBytes: MAX_LATEST_BYTES,
        expectedSize: policy.artifacts.latest.size,
        expectedSha256: policy.artifacts.latest.sha256,
        timeoutMs: evidenceTimeoutMs,
      });
      return bytes.toString("utf8");
    };
    try {
      return await autoUpdater.checkForUpdates();
    } finally {
      httpExecutor.request = originalRequest;
    }
  }

  async function check({ download = false } = {}) {
    if (!enabled) return publish({ status: "disabled", error: "Automatic update is available only in a signed MintVault release." });
    if (inFlight) return inFlight;
    inFlight = (async () => {
      publish({ status: "checking" });
      try {
        const policy = currentPolicy();
        clearCandidate();
        autoUpdater.allowDowngrade = policy.operation === "ROLLBACK";
        const result = await checkStaticMetadata(policy);
        const updateInfo = result?.updateInfo;
        if (!updateInfo || updateInfo.version !== policy.targetVersion) throw new Error("Static feed target does not match authenticated MintVault update policy");
        verifiedEvidence = await fetchEvidence(updateInfo);
        publish({ status: "update_available", version: verifiedEvidence.version });
        if (!download) return state;
        const downloadedZip = await downloadZipFromEvent(verifiedEvidence);
        let stat;
        try { stat = fs.lstatSync(downloadedZip || ""); } catch { stat = null; }
        if (!stat?.isFile() || stat.isSymbolicLink() || path.basename(downloadedZip) !== verifiedEvidence.expectedZip
            || stat.size !== verifiedEvidence.zipSize || sha256(downloadedZip) !== verifiedEvidence.zipSha256) {
          throw new Error("Downloaded ZIP does not match the MintVault release manifest");
        }
        readyCandidate = Object.freeze({
          version: verifiedEvidence.version,
          path: downloadedZip,
          sha256: verifiedEvidence.zipSha256,
          policyFingerprint: verifiedEvidence.policyFingerprint,
        });
        return publish({ status: "ready_to_restart", version: verifiedEvidence.version });
      } catch (error) {
        clearCandidate();
        return publish({ status: "error", error: publicError(error) });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function updateAndRestart() {
    if (!readyCandidate) {
      const result = await check({ download: true });
      if (result.status !== "ready_to_restart") return { ok: false, ...result };
    }
    let policy;
    try { policy = currentPolicy(); }
    catch (error) { clearCandidate(); return { ok: false, ...publish({ status: "error", error: publicError(error) }) }; }
    if (!readyCandidate || readyCandidate.policyFingerprint !== policy.fingerprint
        || readyCandidate.version !== policy.targetVersion
        || compareVersions(readyCandidate.version, minimumVersion) < 0
        || path.basename(readyCandidate.path) !== policy.artifacts.zip.filename
        || sha256(readyCandidate.path) !== readyCandidate.sha256) {
      clearCandidate();
      return { ok: false, ...publish({ status: "error", error: publicError(new Error("Downloaded ZIP no longer matches authenticated policy")) }) };
    }
    if (!isRestartSafe()) {
      return { ok: false, ...publish({ status: "restart_deferred", version: verifiedEvidence.version, error: "Finish the current physical capture before restarting." }) };
    }
    const release = beforeInstall();
    if (typeof release !== "function") {
      return { ok: false, ...publish({ status: "restart_deferred", version: verifiedEvidence.version, error: "Finish the current physical capture before restarting." }) };
    }
    releaseInstallAuthority = release;
    try {
      publish({ status: "installing", version: verifiedEvidence.version });
      autoUpdater.quitAndInstall();
    } catch (error) {
      releaseInstallAuthority = null;
      release();
      return { ok: false, ...publish({ status: "error", error: publicError(error) }) };
    }
    return { ok: true, restarting: true, version: verifiedEvidence.version };
  }

  function setMinimumVersion(value) {
    if (value == null || value === "") { minimumVersion = null; authenticatedPolicy = null; clearCandidate(); return; }
    parseVersion(value);
    if (minimumVersion && minimumVersion !== String(value)) {
      authenticatedPolicy = null;
      clearCandidate();
    }
    minimumVersion = String(value);
  }

  function setPolicy(value) {
    if (value == null) {
      authenticatedPolicy = null;
      clearCandidate();
      if (enabled) autoUpdater.allowDowngrade = false;
      return null;
    }
    const next = validateUpdatePolicy(value, {
      currentVersion: appVersion,
      minimumVersion,
      releaseTrust,
      now: now(),
    });
    if (authenticatedPolicy?.fingerprint !== next.fingerprint) clearCandidate();
    authenticatedPolicy = next;
    if (enabled) autoUpdater.allowDowngrade = next.operation === "ROLLBACK";
    return Object.freeze({ policyId: next.policyId, targetVersion: next.targetVersion, operation: next.operation });
  }

  async function downloadReinstallDmg() {
    if (!enabled) return publish({ status: "disabled", error: "DMG reinstall is available only in a signed MintVault release." });
    if (dmgInFlight) return dmgInFlight;
    dmgInFlight = (async () => {
      try {
        const policy = currentPolicy();
        if (!verifiedEvidence || verifiedEvidence.policyFingerprint !== policy.fingerprint) {
          const checked = await check({ download: false });
          if (checked.status !== "update_available") return { ok: false, ...checked };
        }
        const evidence = verifiedEvidence;
        if (!evidence || evidence.policyFingerprint !== policy.fingerprint) throw new Error("Authenticated MintVault update policy changed before DMG download");
        publish({ status: "downloading_dmg", version: evidence.version });
        fs.mkdirSync(downloadDirectory, { recursive: true, mode: 0o700 });
        assertDownloadCapacity(downloadDirectory, evidence.dmgSize);
        const downloadDirectoryStat = fs.lstatSync(downloadDirectory);
        if (!downloadDirectoryStat.isDirectory() || downloadDirectoryStat.isSymbolicLink()) {
          throw new Error("MintVault verified DMG directory is not private");
        }
        fs.chmodSync(downloadDirectory, 0o700);
        const temporary = path.join(downloadDirectory, `.${evidence.expectedDmg}.${crypto.randomUUID()}.download`);
        const destination = path.join(downloadDirectory, evidence.expectedDmg);
        try {
          await downloadBoundedFile(fetchImpl, `${evidence.updateBaseUrl}/${evidence.expectedDmg}`, temporary, {
            label: "Approved MintVault DMG",
            accept: "application/x-apple-diskimage",
            expectedSize: evidence.dmgSize,
            expectedSha256: evidence.dmgSha256,
            maxBytes: MAX_UPDATE_ARCHIVE_BYTES,
            timeoutMs: artifactTimeoutMs,
          });
          const stat = fs.lstatSync(temporary);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== evidence.dmgSize || sha256(temporary) !== evidence.dmgSha256) {
            throw new Error("Downloaded DMG does not match the authenticated MintVault update policy");
          }
          fs.renameSync(temporary, destination);
          fs.chmodSync(destination, 0o600);
          readyDmgCandidate = Object.freeze({
            path: destination,
            version: evidence.version,
            size: evidence.dmgSize,
            sha256: evidence.dmgSha256,
            policyFingerprint: evidence.policyFingerprint,
          });
          publish({ status: "dmg_ready", version: evidence.version });
          return Object.freeze({ ok: true, path: destination, version: evidence.version });
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      } catch (error) {
        return { ok: false, ...publish({ status: "error", error: publicError(error) }) };
      } finally {
        dmgInFlight = null;
      }
    })();
    return dmgInFlight;
  }

  async function openReinstallDmg(openPath) {
    const downloaded = await downloadReinstallDmg();
    if (!downloaded.ok) return downloaded;
    let policy;
    try { policy = currentPolicy(); }
    catch (error) { clearCandidate(); return { ok: false, ...publish({ status: "error", error: publicError(error) }) }; }
    let stat;
    try { stat = fs.lstatSync(readyDmgCandidate?.path || ""); } catch { stat = null; }
    if (!readyDmgCandidate || readyDmgCandidate.policyFingerprint !== policy.fingerprint
        || readyDmgCandidate.version !== policy.targetVersion
        || !stat?.isFile() || stat.isSymbolicLink() || stat.size !== readyDmgCandidate.size
        || sha256(readyDmgCandidate.path) !== readyDmgCandidate.sha256) {
      clearCandidate();
      return { ok: false, ...publish({ status: "error", error: publicError(new Error("Verified DMG no longer matches authenticated policy")) }) };
    }
    const error = await openPath(readyDmgCandidate.path);
    return error ? { ok: false, error: "macOS could not open the verified MintVault DMG." } : { ok: true };
  }

  return Object.freeze({
    enabled,
    check,
    updateAndRestart,
    setMinimumVersion,
    setPolicy,
    downloadReinstallDmg,
    openReinstallDmg,
    status: () => state,
  });
}

module.exports = Object.freeze({
  createUpdateManager,
  parseVersion,
  compareVersions,
  parseFlatYaml,
  validatePackagedUpdateConfig,
  validateUpdatePolicy,
  validateReleaseEvidence,
  parseChecksums,
  publicError,
  _private: Object.freeze({
    fetchBoundedBytes,
    downloadBoundedFile,
    assertDownloadCapacity,
    MAX_LATEST_BYTES,
    MAX_RELEASE_MANIFEST_BYTES,
    MAX_CHECKSUM_BYTES,
    MAX_UPDATE_ARCHIVE_BYTES,
  }),
});
