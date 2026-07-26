import type { BuiltMimeMessage } from "../core/mime/types.js";
import type { AccountId } from "../core/shared-kernel/ids.js";
import type { ProviderCapabilities } from "./provider-capabilities.port.js";

export interface AccountRef {
  accountId: AccountId;
  emailAddress: string;
}

export interface ProviderSendResult {
  providerMessageId: string;
  providerThreadId?: string;
}

export interface ProviderDraftRef {
  providerDraftId: string;
}

export interface SyncCursor {
  cursor?: string;
}

export interface ChangeSet {
  cursor: string;
  newOrChangedMessageRefs: string[];
}

export interface NormalizedThread {
  providerThreadId: string;
  messageRefs: string[];
}

export interface WatchHandle {
  expiresAt: Date;
}

/**
 * The single interface the Compose, Campaign, Deliverability, and Queue modules see (Section 12.1).
 * No provider-specific payload shape ever crosses this boundary.
 */
export interface MailProvider {
  authenticate(account: AccountRef): Promise<void>;
  sendMessage(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderSendResult>;
  createDraft(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderDraftRef>;
  sendDraft(account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult>;
  listChangesSince(account: AccountRef, cursor: SyncCursor): Promise<ChangeSet>;
  fetchThread(account: AccountRef, threadRef: string): Promise<NormalizedThread>;
  appendToSentFolder(account: AccountRef, rawMessage: Buffer): Promise<void>;
  capabilities(): ProviderCapabilities;
  registerWatch?(account: AccountRef): Promise<WatchHandle>;
}
