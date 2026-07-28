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
  connectSmtpImapAccount: (request) => ipcRenderer.invoke("accounts:connectSmtpImap", request),
  createDraft: (request) => ipcRenderer.invoke("drafts:create", request),
  autosaveDraft: (request) => ipcRenderer.invoke("drafts:autosave", request),
  sendDraft: (request) => ipcRenderer.invoke("drafts:send", request),
  syncInbox: (request) => ipcRenderer.invoke("inbox:sync", request),
  listThreads: (request) => ipcRenderer.invoke("inbox:listThreads", request),
  getThreadMessages: (request) => ipcRenderer.invoke("inbox:getThreadMessages", request),
  setThreadArchived: (request) => ipcRenderer.invoke("inbox:setThreadArchived", request),
  setMessageStarred: (request) => ipcRenderer.invoke("inbox:setMessageStarred", request),
  computeAccountHealth: (request) => ipcRenderer.invoke("accountHealth:computeSnapshot", request),
  getLatestAccountHealth: (request) => ipcRenderer.invoke("accountHealth:getLatest", request),
  runLabAnalysis: (request) => ipcRenderer.invoke("deliverabilityLab:runAnalysis", request),
  importContactsCsv: (request) => ipcRenderer.invoke("contacts:importCsv", request),
  listContacts: () => ipcRenderer.invoke("contacts:list"),
  createTemplate: (request) => ipcRenderer.invoke("templates:create", request),
  listTemplates: () => ipcRenderer.invoke("templates:list"),
  createSequence: (request) => ipcRenderer.invoke("sequences:create", request),
  listSequences: () => ipcRenderer.invoke("sequences:list"),
  createCampaign: (request) => ipcRenderer.invoke("campaigns:create", request),
  listCampaigns: () => ipcRenderer.invoke("campaigns:list"),
  setCampaignStatus: (request) => ipcRenderer.invoke("campaigns:setStatus", request),
  enrollContacts: (request) => ipcRenderer.invoke("campaigns:enrollContacts", request),
  listEnrollments: (request) => ipcRenderer.invoke("campaigns:listEnrollments", request)
});
