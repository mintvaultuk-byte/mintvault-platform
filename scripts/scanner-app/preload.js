/**
 * Preload bridge for the target-bound scanner station. The renderer receives
 * state and recovery/diagnostic actions only; it cannot select a scan mode,
 * attach a local file, choose a certificate target, or set a profile.
 */
const { contextBridge, ipcRenderer } = require("electron");
const BRIDGE_VERSION = 2;

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Scanner event callback must be a function");
  const wrapped = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge = Object.freeze({
  version: BRIDGE_VERSION,
  getState: () => ipcRenderer.invoke("get-state"),
  onStateUpdate: (callback) => subscribe("state-update", callback),
  onStationSetupUpdate: (callback) => subscribe("station-setup-update", callback),
  onUpdateStatus: (callback) => subscribe("update-status", callback),
  fetchOrphans: () => ipcRenderer.invoke("fetch-orphans"),
  startNewCard: (payload) => ipcRenderer.invoke("start-new-card", payload),
  cancelCard: () => ipcRenderer.invoke("cancel-card"),
  authoriseFix: (payload) => ipcRenderer.invoke("authorise-fix", payload),
  openGradeCert: (certId) => ipcRenderer.invoke("open-grade-cert", certId),
  getVersion: () => ipcRenderer.invoke("get-version"),
  getStationSetup: () => ipcRenderer.invoke("get-station-setup"),
  stationSignIn: (payload) => ipcRenderer.invoke("station-sign-in", payload),
  stationCompleteMfa: (payload) => ipcRenderer.invoke("station-complete-mfa", payload),
  registerStation: (payload) => ipcRenderer.invoke("register-station", payload),
  stationSignOut: () => ipcRenderer.invoke("station-sign-out"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  updateApp: (payload) => ipcRenderer.invoke("update-app", payload),
  openDmgReinstall: () => ipcRenderer.invoke("open-dmg-reinstall"),
  resetScanner: () => ipcRenderer.invoke("reset-scanner"),
  hidePopover: () => ipcRenderer.invoke("hide-popover"),
  openLogs: () => ipcRenderer.invoke("open-logs"),
  openLastCert: () => ipcRenderer.invoke("open-last-cert"),
  acknowledgeCardRegistered: () => ipcRenderer.invoke("acknowledge-card-registered"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", { key, value }),
  scanTarget: () => ipcRenderer.invoke("scan-target"),
  runPositioningPreview: () => ipcRenderer.invoke("run-positioning-preview"),
  getPositioningPreview: (previewId) => ipcRenderer.invoke("get-positioning-preview", previewId),
  applyPositioningPreview: (previewId) => ipcRenderer.invoke("apply-positioning-preview", previewId),
  getCapturePreview: (previewId) => ipcRenderer.invoke("get-capture-preview", previewId),
  acceptCapturePreview: (previewId) => ipcRenderer.invoke("accept-capture-preview", previewId),
  rescanCapturePreview: (previewId) => ipcRenderer.invoke("rescan-capture-preview", previewId),
});

contextBridge.exposeInMainWorld("scanner", bridge);
