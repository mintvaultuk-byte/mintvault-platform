const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const APP_IDENTIFIER = "com.mintvault.scanner";
const CAPTURE_HELPER_IDENTIFIER = `${APP_IDENTIFIER}.capture-helper`;
const IDENTITY_HELPER_IDENTIFIER = `${APP_IDENTIFIER}.identity-helper`;
const PRODUCT_NAME = "MintVault Scanner";
const MINIMUM_MACOS = "12.0";
const ARCHITECTURE = "arm64";
const LOCAL_TEAM_IDENTIFIER = "LOCALDEV00";
const RELEASE_AUTHORITY_PATH = path.resolve(__dirname, "..", "build", "release-authority.json");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function requireDarwinArm64() {
  if (process.platform !== "darwin" || process.arch !== ARCHITECTURE) {
    throw new Error("MintVault Scanner packages must be built on Apple Silicon macOS");
  }
}

function packageMode(value = process.env.MINTVAULT_PACKAGE_MODE) {
  const mode = value || "local";
  if (mode !== "local" && mode !== "release") throw new Error("package mode must be local or release");
  return mode;
}

function validateTeamIdentifier(value) {
  const teamIdentifier = String(value || "").trim();
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) throw new Error("MintVault Apple Team Identifier must be exactly 10 uppercase letters/digits");
  return teamIdentifier;
}

function validateReleaseTeamAuthority(authority) {
  if (authority?.schemaVersion !== 1 || authority.appIdentifier !== APP_IDENTIFIER
      || authority.status !== "PINNED" || !/^[A-Z0-9]{10}$/.test(String(authority.teamIdentifier || ""))) {
    throw new Error("MintVault release Team authority is not owner-pinned; release mode remains externally blocked");
  }
  return authority.teamIdentifier;
}

function releaseTeamAuthority() {
  let authority;
  try { authority = JSON.parse(fs.readFileSync(RELEASE_AUTHORITY_PATH, "utf8")); }
  catch { throw new Error("MintVault release Team authority is missing or invalid"); }
  return validateReleaseTeamAuthority(authority);
}

function validateUpdateBaseUrl(value, { release }) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw new Error("MINTVAULT_UPDATE_BASE_URL must be an absolute HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("MINTVAULT_UPDATE_BASE_URL must be credential-free HTTPS without query or fragment");
  }
  if (release && (parsed.hostname.endsWith(".invalid") || parsed.hostname === "localhost")) {
    throw new Error("release update URL must identify the production MintVault update origin");
  }
  return parsed.toString().replace(/\/$/, "");
}

function notarizationCredentials(env = process.env) {
  const api = [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER];
  const appleId = [env.APPLE_ID, env.APPLE_APP_SPECIFIC_PASSWORD, env.APPLE_TEAM_ID];
  const keychain = [env.APPLE_KEYCHAIN_PROFILE];
  const complete = [api.every(Boolean), appleId.every(Boolean), keychain.every(Boolean)];
  const partial = [api.some(Boolean), appleId.some(Boolean), keychain.some(Boolean)];
  if (partial.some((value, index) => value && !complete[index])) {
    throw new Error("notarization credential set is incomplete");
  }
  if (complete.filter(Boolean).length !== 1) {
    throw new Error("release packaging requires exactly one notarization credential set");
  }
  if (complete[0]) return { kind: "api-key" };
  if (complete[1]) return { kind: "apple-id" };
  return { kind: "keychain-profile" };
}

function notarizationArgs(env = process.env) {
  const credentials = notarizationCredentials(env);
  if (credentials.kind === "api-key") {
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  }
  if (credentials.kind === "apple-id") {
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  }
  const args = ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_KEYCHAIN) args.push("--keychain", env.APPLE_KEYCHAIN);
  return args;
}

function validateReleaseEnvironment(env = process.env) {
  const teamIdentifier = releaseTeamAuthority();
  if (validateTeamIdentifier(env.MINTVAULT_APPLE_TEAM_ID) !== teamIdentifier) {
    throw new Error("MINTVAULT_APPLE_TEAM_ID does not match the owner-pinned release Team authority");
  }
  const identity = String(env.MINTVAULT_DEVELOPER_ID_APPLICATION || "").trim();
  if (!identity.startsWith("Developer ID Application:") || !identity.endsWith(`(${teamIdentifier})`)) {
    throw new Error("MINTVAULT_DEVELOPER_ID_APPLICATION must be the exact Developer ID Application identity for the pinned Team ID");
  }
  if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== teamIdentifier) {
    throw new Error("APPLE_TEAM_ID and MINTVAULT_APPLE_TEAM_ID disagree");
  }
  notarizationCredentials(env);
  const identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!identities.includes(`\"${identity}\"`)) throw new Error("the requested Developer ID Application identity is not installed and valid");
  return Object.freeze({ teamIdentifier, identity });
}

function atomicWrite(filePath, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, { mode });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

module.exports = Object.freeze({
  APP_IDENTIFIER,
  CAPTURE_HELPER_IDENTIFIER,
  IDENTITY_HELPER_IDENTIFIER,
  PRODUCT_NAME,
  MINIMUM_MACOS,
  ARCHITECTURE,
  LOCAL_TEAM_IDENTIFIER,
  RELEASE_AUTHORITY_PATH,
  run,
  requireDarwinArm64,
  packageMode,
  validateTeamIdentifier,
  validateReleaseTeamAuthority,
  releaseTeamAuthority,
  validateUpdateBaseUrl,
  notarizationCredentials,
  notarizationArgs,
  validateReleaseEnvironment,
  atomicWrite,
});
