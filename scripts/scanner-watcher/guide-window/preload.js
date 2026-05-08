/**
 * Preload — exposes a tiny `guide` API to the renderer.
 *
 * Renderer cannot reach Node, fs, or the loopback HTTP server directly
 * (contextIsolation: true). All IO goes through these IPC bridges.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("guide", {
  readState:    ()       => ipcRenderer.invoke("guide:read-state"),
  control:      (action) => ipcRenderer.invoke("guide:control", action),
  hide:         ()       => ipcRenderer.invoke("guide:hide"),
  certPreview:  (certId) => ipcRenderer.invoke("guide:cert-preview", certId),
  manualMode:   (args)   => ipcRenderer.invoke("guide:manual-mode", args),
});
