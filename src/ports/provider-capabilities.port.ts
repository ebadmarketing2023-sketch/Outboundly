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
