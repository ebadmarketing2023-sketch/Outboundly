import type { CompatibilityReport } from "../core/gmail-compatibility/types.js";
import type { DeliverabilityReport } from "../core/deliverability/types.js";

/**
 * The typed contract crossing the UI <-> core boundary (Section 1.3, Section 23). Both the
 * preload script and the renderer import these types, so a payload shape change is a compile
 * error on both sides rather than a runtime surprise.
 */

export interface AccountSummary {
  id: string;
  provider: string;
  emailAddress: string;
  displayName?: string;
  status: string;
}

export interface DraftSummary {
  id: string;
  accountId: string;
  subject: string;
  to: string[];
  autosaveVersion: number;
  lastSavedAt: string;
}

export interface CreateDraftRequest {
  accountId: string;
  subject: string;
  to: string[];
  body: string;
}

export interface AutosaveDraftRequest {
  draftId: string;
  subject?: string;
  body?: string;
}

export interface SendDraftRequest {
  draftId: string;
}

export interface SendDraftResponse {
  sent: boolean;
  compatibilityReport: CompatibilityReport;
  deliverabilityReport?: DeliverabilityReport;
  providerMessageId?: string;
}

/** Unified Inbox (Section 11.4) — a read-model view over the Conversation Engine's storage. */
export interface ThreadSummary {
  id: string;
  subjectNormalized: string;
  conversationState: string;
  archivedAt?: string;
  updatedAt: string;
}

export interface MessageSummary {
  id: string;
  direction: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  starred: boolean;
  sentAt?: string;
  receivedAt?: string;
}

export interface SyncInboxRequest {
  accountId: string;
}

export interface SyncInboxResponse {
  newMessageCount: number;
  repliesDetected: number;
  /** Count of messages that failed to sync (deleted/moved since listing, transient API errors,
   * etc.) without aborting the rest of the sync — see Section 21.3's failure-isolation principle. */
  failedCount: number;
}

export interface ListThreadsRequest {
  accountId: string;
  includeArchived?: boolean;
}

export interface GetThreadMessagesRequest {
  threadId: string;
}

export interface SetThreadArchivedRequest {
  threadId: string;
  archived: boolean;
}

export interface SetMessageStarredRequest {
  messageId: string;
  starred: boolean;
}

/** Account Health Engine (Section 19) — a manual-trigger read model, since no background
 * Scheduler exists yet (Phase 4) to run this periodically. */
export interface AccountHealthFindingSummary {
  findingType: string;
  severity: string;
  message: string;
  explanation: string;
  recommendedAction?: string;
}

export interface AccountHealthSnapshotSummary {
  capturedAt: string;
  healthScore: number;
  riskLevel: string;
  sendsLast24h: number;
  sendsLast7d: number;
  accountAgeDays: number;
  replyRate?: number;
  sendingConsistencyScore?: number;
  spfStatus: string;
  dkimStatus: string;
  dmarcStatus: string;
  findings: AccountHealthFindingSummary[];
}

export interface AccountHealthRequest {
  accountId: string;
}

export interface ConnectSmtpImapRequest {
  emailAddress: string;
  displayName?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  password: string;
}

export interface OutboundlyRendererApi {
  listAccounts(): Promise<AccountSummary[]>;
  connectGoogleAccount(): Promise<AccountSummary>;
  connectMicrosoftAccount(): Promise<AccountSummary>;
  connectSmtpImapAccount(request: ConnectSmtpImapRequest): Promise<AccountSummary>;
  createDraft(request: CreateDraftRequest): Promise<DraftSummary>;
  autosaveDraft(request: AutosaveDraftRequest): Promise<DraftSummary>;
  sendDraft(request: SendDraftRequest): Promise<SendDraftResponse>;
  syncInbox(request: SyncInboxRequest): Promise<SyncInboxResponse>;
  listThreads(request: ListThreadsRequest): Promise<ThreadSummary[]>;
  getThreadMessages(request: GetThreadMessagesRequest): Promise<MessageSummary[]>;
  setThreadArchived(request: SetThreadArchivedRequest): Promise<void>;
  setMessageStarred(request: SetMessageStarredRequest): Promise<void>;
  computeAccountHealth(request: AccountHealthRequest): Promise<AccountHealthSnapshotSummary>;
  getLatestAccountHealth(request: AccountHealthRequest): Promise<AccountHealthSnapshotSummary | undefined>;
}
