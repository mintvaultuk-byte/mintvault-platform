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
  ackConfirmCard:    ()            => ipcRenderer.invoke("ack-confirm-card"),
  restartWatcher:    ()            => ipcRenderer.invoke("restart-watcher"),
  resetScanner:      ()            => ipcRenderer.invoke("reset-scanner"),
  forwardToCert:     (certId)      => ipcRenderer.invoke("forward-to-cert", certId),
  hidePopover:       ()            => ipcRenderer.invoke("hide-popover"),
  openInbox:         ()            => ipcRenderer.invoke("open-inbox"),
  openLogs:          ()            => ipcRenderer.invoke("open-logs"),
  openLastCert:      ()            => ipcRenderer.invoke("open-last-cert"),

  // ── QoL toggles (added in scanner toggles pack) ────────────────────────
  setPaused:         (paused)      => ipcRenderer.invoke("set-paused", paused),
  setSetting:        (key, value)  => ipcRenderer.invoke("set-setting", { key, value }),
  testScan:          ()            => ipcRenderer.invoke("test-scan"),
});
