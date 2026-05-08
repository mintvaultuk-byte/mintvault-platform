/**
 * Preload bridge — exposes a minimal `scanner` global to the renderer.
 * No nodeIntegration in renderer; this is the only way IPC happens.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scanner", {
  // Read current state once (renderer also subscribes via onStateUpdate).
  getState: () => ipcRenderer.invoke("get-state"),

  // Subscribers — the main process pushes state changes and scan events.
  onStateUpdate: (cb) => {
    const wrap = (_e, payload) => cb(payload);
    ipcRenderer.on("state-update", wrap);
    return () => ipcRenderer.removeListener("state-update", wrap);
  },
  onScanDetected: (cb) => {
    const wrap = (_e, payload) => cb(payload);
    ipcRenderer.on("scan-detected", wrap);
    return () => ipcRenderer.removeListener("scan-detected", wrap);
  },

  setMode:           (mode)        => ipcRenderer.invoke("set-mode", mode),
  attachManualScan:  (payload)     => ipcRenderer.invoke("attach-manual-scan", payload),
  fetchOrphans:      ()            => ipcRenderer.invoke("fetch-orphans"),
  armOneShot:        (payload)     => ipcRenderer.invoke("arm-one-shot", payload),
  cancelOneShot:     ()            => ipcRenderer.invoke("cancel-one-shot"),
  deleteCert:        (payload)     => ipcRenderer.invoke("delete-cert", payload),
  retryLast:         ()            => ipcRenderer.invoke("retry-last"),
  resetBuffered:     ()            => ipcRenderer.invoke("reset-buffered"),
  restartWatcher:    ()            => ipcRenderer.invoke("restart-watcher"),
  forwardToCert:     (certId)      => ipcRenderer.invoke("forward-to-cert", certId),
  hidePopover:       ()            => ipcRenderer.invoke("hide-popover"),
  openInbox:         ()            => ipcRenderer.invoke("open-inbox"),
  openLogs:          ()            => ipcRenderer.invoke("open-logs"),
});
