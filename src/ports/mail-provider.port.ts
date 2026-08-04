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
  /** The Message-ID header the provider actually delivered with, when the provider makes this
   * knowable after the fact (Gmail and Microsoft Graph both silently rewrite/replace whatever
   * Message-ID our own MIME builder generated at send time -- verified for real against Gmail's
   * "Show Original" headers on a delivered message). Undefined means the provider is trusted to
   * have preserved the value our own builder generated verbatim (true for SMTP/IMAP, which has no
   * server in the middle to rewrite anything). Callers must persist this over the provisional
   * value once present, since later follow-up steps' In-Reply-To/References -- and inbound reply
   * matching -- need to reference what the recipient's system will actually see, not what we
   * merely intended to send. */
  messageIdHeader?: string;
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
 * Thrown by MailProvider.authenticate() (and anything else that resolves a client, e.g.
 * sendMessage/fetchMessage) specifically when the provider gives an unambiguous, permanent
 * signal that stored credentials are no longer usable and only a fresh sign-in can fix it --
 * Google's `invalid_grant`, MSAL's `InteractionRequiredAuthError`, or an IMAP/SMTP login rejected
 * for bad credentials. Every *other* failure (a network blip, a provider's own 5xx/429, a
 * momentary OS keychain hiccup, an unrecognized error shape) must NOT be wrapped in this class --
 * callers (see computeAccountHealthSnapshot) treat only this specific error as "this account
 * genuinely needs to be reconnected," and anything else as inconclusive, precisely so a transient
 * failure never flips a perfectly healthy account to reauth_required.
 */
export class AccountReauthRequiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccountReauthRequiredError";
  }
}

/**
 * The single interface the Compose, Campaign, Deliverability, and Queue modules see (Section 12.1).
 * No provider-specific payload shape ever crosses this boundary.
 */
export interface MailProvider {
  authenticate(account: AccountRef): Promise<void>;
  /** providerThreadId, when given, is the provider's own opaque thread reference (e.g. Gmail's
   * threadId) for the thread this message continues -- distinct from the In-Reply-To/References
   * headers already baked into `message`, which are what actually thread the message for the
   * *recipient*. This is what keeps the *sender's own* mailbox view (e.g. Gmail's Sent folder)
   * grouped correctly too; per Gmail's API docs it only affects the sending account's own view,
   * so a provider that has no equivalent (Microsoft Graph computes conversationId itself and
   * exposes no way to set it on send; SMTP has no thread concept at all) can safely ignore it. */
  sendMessage(account: AccountRef, message: BuiltMimeMessage, providerThreadId?: string): Promise<ProviderSendResult>;
  createDraft(account: AccountRef, message: BuiltMimeMessage, providerThreadId?: string): Promise<ProviderDraftRef>;
  sendDraft(account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult>;
  listChangesSince(account: AccountRef, cursor: SyncCursor): Promise<ChangeSet>;
  fetchMessage(account: AccountRef, providerMessageId: string): Promise<NormalizedMessage>;
  fetchThread(account: AccountRef, threadRef: string): Promise<NormalizedThread>;
  appendToSentFolder(account: AccountRef, rawMessage: Buffer): Promise<void>;
  capabilities(): ProviderCapabilities;
  registerWatch?(account: AccountRef): Promise<WatchHandle>;
}
