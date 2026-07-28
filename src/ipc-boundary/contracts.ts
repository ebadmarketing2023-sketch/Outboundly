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
  /** Section 15.2's Rate Limit Policy / Section 16.2's authoritative RateLimiter both read these
   * directly off the account — undefined means no cap configured. */
  dailySendLimit?: number;
  hourlySendLimit?: number;
}

export interface UpdateAccountLimitsRequest {
  accountId: string;
  /** undefined/omitted clears the limit (no cap); the renderer always sends both fields so an
   * emptied input actually clears rather than leaving the previous value untouched. */
  dailySendLimit?: number;
  hourlySendLimit?: number;
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
  bouncesDetected: number;
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

/** Deliverability Lab (Section 18) — an on-demand sandbox: no draft is saved, no account is
 * touched to build the message, nothing is queued or sent. `accountId` here is only ever used to
 * borrow a display name/email/domain for the hypothetical "From" identity and, if requested, to
 * pick which provider's default DKIM selector to check — never to authenticate or send. */
export interface RunLabAnalysisRequest {
  subject: string;
  body: string;
  to: string[];
  accountId: string;
  checkDomainAuth?: boolean;
}

export interface LabAnalysisResponse {
  score: number;
  findings: Array<{ ruleId: string; category: string; severity: string; message: string; explanation: string }>;
}

/** Leads/Contacts (Section 5.5) and the Campaign Engine's minimal Phase 4 UI (Section 14). */
export interface ImportContactsCsvRequest {
  csvText: string;
}

export interface ImportContactsCsvResponse {
  imported: number;
  skipped: Array<{ row: number; reason: string }>;
}

export interface ContactSummary {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  source: string;
}

export interface CreateTemplateRequest {
  name: string;
  bodyText: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
}

export interface CreateSequenceStepRequest {
  delayDays: number;
  delayHours: number;
  templateId: string;
  subjectText: string;
}

export interface CreateSequenceRequest {
  name: string;
  steps: CreateSequenceStepRequest[];
}

export interface SequenceSummary {
  id: string;
  name: string;
  stepCount: number;
}

/** Business Hours Profiles (Section 5.7): when a campaign is allowed to send, in the profile's
 * own timezone. The UI applies one shared start/end window to every selected day rather than
 * exposing the underlying per-weekday/multi-window data model directly -- picking several
 * different windows per day isn't supported by this screen. */
export interface CreateBusinessHoursProfileRequest {
  name: string;
  timezone: string;
  /** Lowercase full weekday names ("monday".."sunday") this profile is active on. */
  days: string[];
  start: string; // "HH:MM", 24-hour
  end: string;
}

export interface BusinessHoursProfileSummary {
  id: string;
  name: string;
  timezone: string;
  windows: Record<string, { start: string; end: string }[]>;
}

export interface CreateCampaignRequest {
  name: string;
  sequenceId: string;
  sendingAccountId: string;
  businessHoursProfileId: string;
}

export interface CampaignSummary {
  id: string;
  name: string;
  sequenceId: string;
  status: string;
  businessHoursProfileId: string;
}

export interface SetCampaignStatusRequest {
  campaignId: string;
  status: string;
}

export interface EnrollContactsRequest {
  campaignId: string;
  contactIds: string[];
}

export interface EnrollContactsResponse {
  enrolled: number;
  skipped: Array<{ contactId: string; reason: string }>;
}

export interface ListEnrollmentsRequest {
  campaignId: string;
}

export interface EnrollmentSummary {
  id: string;
  contactId: string;
  status: string;
  nextSendAt?: string;
  enrolledAt: string;
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
  runLabAnalysis(request: RunLabAnalysisRequest): Promise<LabAnalysisResponse>;
  importContactsCsv(request: ImportContactsCsvRequest): Promise<ImportContactsCsvResponse>;
  listContacts(): Promise<ContactSummary[]>;
  createTemplate(request: CreateTemplateRequest): Promise<TemplateSummary>;
  listTemplates(): Promise<TemplateSummary[]>;
  createSequence(request: CreateSequenceRequest): Promise<SequenceSummary>;
  listSequences(): Promise<SequenceSummary[]>;
  createCampaign(request: CreateCampaignRequest): Promise<CampaignSummary>;
  listCampaigns(): Promise<CampaignSummary[]>;
  setCampaignStatus(request: SetCampaignStatusRequest): Promise<void>;
  enrollContacts(request: EnrollContactsRequest): Promise<EnrollContactsResponse>;
  listEnrollments(request: ListEnrollmentsRequest): Promise<EnrollmentSummary[]>;
  createBusinessHoursProfile(request: CreateBusinessHoursProfileRequest): Promise<BusinessHoursProfileSummary>;
  listBusinessHoursProfiles(): Promise<BusinessHoursProfileSummary[]>;
  updateAccountLimits(request: UpdateAccountLimitsRequest): Promise<AccountSummary>;
}
