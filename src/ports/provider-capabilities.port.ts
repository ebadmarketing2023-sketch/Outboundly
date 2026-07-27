/** Provider Capability Matrix (Section 12.2). */
export interface ProviderCapabilities {
  supportsDrafts: boolean;
  supportsLabels: boolean;
  supportsNativeThreads: boolean;
  supportsIncrementalSyncCursor: boolean;
  supportsPushNotifications: boolean;
  supportsAliases: boolean;
  supportsSendAs: boolean;
  maxAttachmentSizeBytes: number;
  maxRecipientsPerMessage: number;
}

export const GMAIL_CAPABILITIES: ProviderCapabilities = {
  supportsDrafts: true,
  supportsLabels: true,
  supportsNativeThreads: true,
  supportsIncrementalSyncCursor: true,
  supportsPushNotifications: true,
  supportsAliases: true,
  supportsSendAs: true,
  maxAttachmentSizeBytes: 25 * 1024 * 1024,
  maxRecipientsPerMessage: 500
};

/**
 * Outlook/Graph (Section 12.2). `supportsLabels` is false — Outlook organizes mail into folders
 * plus categories, not Gmail-style labels, and the current MicrosoftProvider doesn't model
 * either. `supportsPushNotifications` reflects Graph's change-notification subscriptions
 * (registerWatch is not yet implemented, matching Gmail's own current state in this codebase).
 * maxAttachmentSizeBytes is Graph's documented overall attachment ceiling (large-file upload
 * session, not the 3 MB single-request threshold) — verified via
 * learn.microsoft.com/en-us/graph/outlook-large-attachments.
 */
export const MICROSOFT_CAPABILITIES: ProviderCapabilities = {
  supportsDrafts: true,
  supportsLabels: false,
  supportsNativeThreads: true,
  supportsIncrementalSyncCursor: true,
  supportsPushNotifications: true,
  supportsAliases: false,
  supportsSendAs: false,
  maxAttachmentSizeBytes: 150 * 1024 * 1024,
  maxRecipientsPerMessage: 500
};

/**
 * Universal SMTP/IMAP fallback (Section 12.2): the real, honest capability floor for "any
 * mailbox," not just what a specific server happens to support. `supportsDrafts` is false — the
 * adapter fakes a two-step create/send draft lifecycle with an in-memory placeholder (no server
 * round-trip), which does not survive an app restart between the two steps, so it isn't a real
 * capability. `supportsIncrementalSyncCursor` is true: IMAP UIDs are monotonically
 * non-decreasing within a mailbox's UIDVALIDITY epoch (RFC 3501), which is a real, universal
 * incremental cursor, not an assumption. `supportsNativeThreads`/`supportsLabels` are false since
 * this adapter doesn't rely on non-universal extensions (THREAD, X-GM-EXT-1) that not every IMAP
 * server implements. `maxAttachmentSizeBytes`/`maxRecipientsPerMessage` have no protocol-level
 * universal answer — these are conservative defaults (matching Gmail's own limits), not a
 * verified guarantee from any specific server.
 */
export const SMTP_IMAP_CAPABILITIES: ProviderCapabilities = {
  supportsDrafts: false,
  supportsLabels: false,
  supportsNativeThreads: false,
  supportsIncrementalSyncCursor: true,
  supportsPushNotifications: false,
  supportsAliases: false,
  supportsSendAs: false,
  maxAttachmentSizeBytes: 25 * 1024 * 1024,
  maxRecipientsPerMessage: 500
};
