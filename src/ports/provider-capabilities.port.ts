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
