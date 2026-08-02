const { contextBridge, ipcRenderer } = require("electron");

/**
 * Minimal, isolated IPC surface for the license-gate window only -- deliberately separate from
 * the main app's preload.cjs/contracts.ts, since this window exists entirely outside the normal
 * app shell and must keep working even when nothing else about the app has initialized yet.
 */
contextBridge.exposeInMainWorld("licenseGate", {
  getInitialStatus: () => ipcRenderer.invoke("license:getInitialStatus"),
  activate: (licenseKey) => ipcRenderer.invoke("license:activate", licenseKey),
  quit: () => ipcRenderer.invoke("license:quit")
});
