const os = require("node:os");
const path = require("node:path");

let runtime = Object.freeze({
  configured: false,
  isPackaged: process.env.NODE_ENV === "production",
});

function configureRuntime({ isPackaged }) {
  if (typeof isPackaged !== "boolean") throw new Error("Scanner path runtime configuration is invalid");
  if (runtime.configured && runtime.isPackaged !== isPackaged) {
    throw new Error("Scanner path runtime cannot change after configuration");
  }
  runtime = Object.freeze({ configured: true, isPackaged });
  return current();
}

function developmentOverride() {
  const value = process.env.MINTVAULT_SCANS_DIR;
  return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
}

function nativeAccountHome() {
  const value = os.userInfo()?.homedir;
  if (typeof value !== "string" || !path.isAbsolute(value) || value === path.parse(value).root) {
    throw new Error("Scanner native account home is unavailable");
  }
  return path.resolve(value);
}

function defaultHome() {
  return runtime.isPackaged ? nativeAccountHome() : os.homedir();
}

function scansBase() {
  return (!runtime.isPackaged && developmentOverride()) || path.join(defaultHome(), "mintvault-scans");
}

function appSupport() {
  return !runtime.isPackaged && developmentOverride()
    ? path.join(developmentOverride(), "app-state")
    : path.join(defaultHome(), "Library", "Application Support", "MintVaultScanner");
}

function current() {
  return Object.freeze({
    configured: runtime.configured,
    isPackaged: runtime.isPackaged,
    scansBase: scansBase(),
    appSupport: appSupport(),
  });
}

module.exports = { configureRuntime, scansBase, appSupport, current, _private: { nativeAccountHome } };
