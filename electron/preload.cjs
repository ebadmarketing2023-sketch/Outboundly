const { contextBridge, ipcRenderer } = require("electron");

/**
 * Secure IPC boundary (Section 1.3, Section 23): the renderer gets exactly this narrow,
 * typed surface (matching src/ipc-boundary/contracts.ts) via contextBridge — no direct
 * ipcRenderer access, no Node integration, no filesystem/database/network-credential access.
 */
contextBridge.exposeInMainWorld("outboundly", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  connectGoogleAccount: () => ipcRenderer.invoke("accounts:connectGoogle"),
  connectMicrosoftAccount: () => ipcRenderer.invoke("accounts:connectMicrosoft"),
  createDraft: (request) => ipcRenderer.invoke("drafts:create", request),
  autosaveDraft: (request) => ipcRenderer.invoke("drafts:autosave", request),
  sendDraft: (request) => ipcRenderer.invoke("drafts:send", request),
  syncInbox: (request) => ipcRenderer.invoke("inbox:sync", request),
  listThreads: (request) => ipcRenderer.invoke("inbox:listThreads", request),
  getThreadMessages: (request) => ipcRenderer.invoke("inbox:getThreadMessages", request),
  setThreadArchived: (request) => ipcRenderer.invoke("inbox:setThreadArchived", request),
  setMessageStarred: (request) => ipcRenderer.invoke("inbox:setMessageStarred", request)
});
