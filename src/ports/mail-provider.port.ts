import type { BuiltMimeMessage } from "../core/mime/types.js";
import type { AccountId } from "../core/shared-kernel/ids.js";
import type { ProviderCapabilities } from "./provider-capabilities.port.js";

export interface AccountRef {
  accountId: AccountId;
  emailAddress: string;
  /** The connected Google/Microsoft account's own profile name (or a manually set one for
   * SMTP/IMAP), so campaign-driven sends can put a real name on the From header instead of a bare
   * address (Critical Improvement: professional sender identity). */
  displayName?: string;
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
 * The provider-agnostic shape of a synced message (Section 11) — headers the Conversation
 * Engine needs for reply-graph reconstruction, plus enough content to store and display it.
 * Populated from whatever structured format the provider's own API returns (e.g. Gmail's
 * already-parsed `payload`), never by hand-parsing raw RFC 2822 text ourselves.
 */
export interface NormalizedMessage {
  providerMessageId: string;
  providerThreadId?: string;
  messageIdHeader: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  date: Date;
  bodyHtml?: string;
  bodyText?: string;
  snippet?: string;
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
  fetchMessage(account: AccountRef, providerMessageId: string): Promise<NormalizedMessage>;
  fetchThread(account: AccountRef, threadRef: string): Promise<NormalizedThread>;
  appendToSentFolder(account: AccountRef, rawMessage: Buffer): Promise<void>;
  capabilities(): ProviderCapabilities;
  registerWatch?(account: AccountRef): Promise<WatchHandle>;
}
