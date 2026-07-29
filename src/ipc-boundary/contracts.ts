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
  /** Randomized send-pacing (Critical Improvement #1): the RateLimiter generates a fresh random
   * delay in this range after every admitted send from this account and denies the next one until
   * it elapses, regardless of which campaign queued it. Undefined min/max means no pacing is
   * enforced, not a zero-length one. */
  minSendDelaySeconds?: number;
  maxSendDelaySeconds?: number;
  /** Settings module (Section 3: "signatures-by-account"). Plain text only -- this phase's
   * compose screen treats the whole body as plain text (Section 8). */
  signatureText?: string;
}

export interface UpdateAccountLimitsRequest {
  accountId: string;
  /** undefined/omitted clears the limit (no cap); the renderer always sends both fields so an
   * emptied input actually clears rather than leaving the previous value untouched. */
  dailySendLimit?: number;
  hourlySendLimit?: number;
  /** Same clear-on-omit convention as the two fields above. Must both be set together (or both
   * omitted) -- the renderer enforces this before calling. */
  minSendDelaySeconds?: number;
  maxSendDelaySeconds?: number;
}

/** Section 13.3: disconnecting revokes this app's locally stored access to the account (deletes
 * its TokenVault credentials) and marks it 'disconnected' so the Provider Selector (Section 12.4)
 * excludes it from sends/syncs. Reconnecting is the existing sign-in flow for that provider,
 * which already updates the same row back to 'connected' by matching on email address. */
export interface DisconnectAccountRequest {
  accountId: string;
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

/** Pushed from main -> renderer while a manual sync is running (Critical Improvement #5) -- not a
 * request/response pair, since a sync's duration isn't known up front. */
export interface SyncProgressEvent {
  accountId: string;
  done: number;
  total: number;
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
  /** The source file's name, shown as the group label on the Leads screen (Critical Improvement
   * #3). Optional only for the plain-paste path; falls back to a generic "Pasted import" label. */
  filename?: string;
}

export interface ImportContactsCsvResponse {
  imported: number;
  skipped: Array<{ row: number; reason: string }>;
  batchId: string;
  contactIds: string[];
}

export interface ContactSummary {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  source: string;
  importBatchId?: string;
}

export interface LeadImportBatchSummary {
  id: string;
  filename: string;
  importedAt: string;
  contactCount: number;
}

export interface DeleteContactRequest {
  contactId: string;
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

/** Campaign dashboard list (Critical Improvement #4): one row per campaign with live metrics, so
 * the campaign list doesn't need a separate getCampaignAnalytics round-trip per row. */
export interface CampaignDashboardEntrySummary {
  id: string;
  name: string;
  status: string;
  totalLeads: number;
  emailsSent: number;
  emailsRemaining: number;
  replies: number;
  replyRatePercent?: number;
  completionPercent: number;
  lastActivityAt?: string;
  createdAt: string;
}

/** Deliberately narrow: renaming or switching the business-hours profile only -- see
 * CampaignRepository.update's docblock for why sequence/sending-account changes aren't supported
 * here. */
export interface UpdateCampaignRequest {
  campaignId: string;
  name: string;
  businessHoursProfileId: string;
}

/** Only succeeds for a campaign with zero enrollments (an unused draft) -- see
 * CampaignRepository.delete's docblock. */
export interface DeleteCampaignRequest {
  campaignId: string;
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

/** Campaign-specific leads (Critical Improvement #2): a campaign's own CSV upload imports (or
 * re-tags) contacts by email as a fresh import batch and enrolls exactly and only that batch --
 * never the entire global contacts list ("Enroll all" auto-enrolled every existing contact,
 * which is exactly the cross-campaign leakage this replaces). */
export interface EnrollContactsFromCsvRequest {
  campaignId: string;
  csvText: string;
  filename?: string;
}

export interface EnrollContactsFromCsvResponse {
  batchId: string;
  imported: number;
  importSkipped: Array<{ row: number; reason: string }>;
  enrolled: number;
  enrollSkipped: Array<{ contactId: string; reason: string }>;
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

/** Campaign dashboard (Section 20.5): primary metrics (Section 20.2) from the materialized rollup
 * tables, plus a per-step funnel and stop-reason breakdown. */
export interface CampaignAnalyticsRequest {
  campaignId: string;
}

export interface StepFunnelEntrySummary {
  stepOrder: number;
  templateId: string;
  sentCount: number;
}

export interface StopReasonBreakdownSummary {
  active: number;
  completed: number;
  stopped_reply: number;
  stopped_bounce: number;
  stopped_manual: number;
  stopped_suppressed: number;
}

export interface CampaignAnalyticsSummary {
  sentCount: number;
  bouncedCount: number;
  repliedCount: number;
  positiveReplyCount: number;
  unsubscribedCount: number;
  conversionCount: number;
  replyRate?: number;
  positiveReplyRate?: number;
  bounceRate?: number;
  deliveryRate?: number;
  stepFunnel: StepFunnelEntrySummary[];
  stopReasonBreakdown: StopReasonBreakdownSummary;
}

/** Insights feed (Section 20.3, Section 20.5). */
export interface InsightSummary {
  id: string;
  scope: string;
  scopeId?: string;
  insightType: string;
  severity: string;
  message: string;
  explanation: string;
  recommendedAction?: string;
  generatedAt: string;
}

export interface DismissInsightRequest {
  insightId: string;
}

export interface MarkConversionRequest {
  campaignId: string;
  contactId: string;
}

export interface UnsubscribeContactRequest {
  contactId: string;
  campaignId?: string;
}

/** Suppression list management (Section 5.5). Removing an entry only affects future campaign
 * enrollment/send eligibility -- it never touches outbound email headers or content, so it has no
 * effect on how any provider's inbox classifies mail (e.g. Gmail's Promotions tab). */
export interface SuppressionEntrySummary {
  id: string;
  email: string;
  reason: string;
  createdAt: string;
}

export interface RemoveSuppressionEntryRequest {
  email: string;
}

export type ReplyClassification = "interested" | "not_interested" | "out_of_office";

export interface SetReplyClassificationRequest {
  messageId: string;
  classification: ReplyClassification;
}

/** Notifications module (Section 3): "Surface in-app alerts ... most domain events." */
export interface NotificationSummary {
  id: string;
  notificationType: string;
  severity: string;
  message: string;
  relatedAccountId?: string;
  relatedCampaignId?: string;
  createdAt: string;
}

export interface MarkNotificationReadRequest {
  notificationId: string;
}

/** Structured error logging (Critical Improvement #12): a complete diagnostic trail across every
 * background worker, distinct from Notifications above (a curated, dismissible subset). */
export interface ErrorLogEntrySummary {
  id: string;
  occurredAt: string;
  source: string;
  errorType: string;
  errorMessage: string;
  campaignId?: string;
  accountId?: string;
  recipientEmail?: string;
  retryCount?: number;
}

export interface ListErrorLogsRequest {
  limit: number;
  source?: string;
}

export interface UpdateAccountSignatureRequest {
  accountId: string;
  /** undefined/omitted clears the signature. */
  signatureText?: string;
}

/** Settings module preferences (Section 3: "sending defaults"): pre-fills for the Campaigns
 * screen's "create campaign" form rather than a new domain concept -- the referenced business
 * hours profile/account still have to exist and be chosen the same way either way. */
export interface AppPreferencesSummary {
  defaultBusinessHoursProfileId?: string;
  defaultSendingAccountId?: string;
}

export interface UpdateAppPreferencesRequest {
  defaultBusinessHoursProfileId?: string;
  defaultSendingAccountId?: string;
}

/** Backup/restore (Section 23: "Exported backups are encrypted with a user-supplied passphrase
 * separate from the app's own at-rest key"). The main process owns the file picker (Section 23's
 * "no raw DB or filesystem access from UI" -- the renderer never sees or chooses a raw path, only
 * a passphrase and whether the user completed or cancelled the native dialog. */
export interface ExportBackupRequest {
  passphrase: string;
}

export interface ExportBackupResponse {
  exported: boolean;
  filePath?: string;
}

export interface RestoreBackupRequest {
  passphrase: string;
}

export interface RestoreBackupResponse {
  restored: boolean;
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
  /** Subscribes to sync-progress pushes; returns an unsubscribe function. */
  onSyncProgress(callback: (event: SyncProgressEvent) => void): () => void;
  listThreads(request: ListThreadsRequest): Promise<ThreadSummary[]>;
  getThreadMessages(request: GetThreadMessagesRequest): Promise<MessageSummary[]>;
  setThreadArchived(request: SetThreadArchivedRequest): Promise<void>;
  setMessageStarred(request: SetMessageStarredRequest): Promise<void>;
  computeAccountHealth(request: AccountHealthRequest): Promise<AccountHealthSnapshotSummary>;
  getLatestAccountHealth(request: AccountHealthRequest): Promise<AccountHealthSnapshotSummary | undefined>;
  runLabAnalysis(request: RunLabAnalysisRequest): Promise<LabAnalysisResponse>;
  importContactsCsv(request: ImportContactsCsvRequest): Promise<ImportContactsCsvResponse>;
  listContacts(): Promise<ContactSummary[]>;
  listLeadImportBatches(): Promise<LeadImportBatchSummary[]>;
  deleteContact(request: DeleteContactRequest): Promise<void>;
  createTemplate(request: CreateTemplateRequest): Promise<TemplateSummary>;
  listTemplates(): Promise<TemplateSummary[]>;
  createSequence(request: CreateSequenceRequest): Promise<SequenceSummary>;
  listSequences(): Promise<SequenceSummary[]>;
  createCampaign(request: CreateCampaignRequest): Promise<CampaignSummary>;
  listCampaigns(): Promise<CampaignSummary[]>;
  listCampaignDashboard(): Promise<CampaignDashboardEntrySummary[]>;
  updateCampaign(request: UpdateCampaignRequest): Promise<CampaignSummary>;
  deleteCampaign(request: DeleteCampaignRequest): Promise<void>;
  setCampaignStatus(request: SetCampaignStatusRequest): Promise<void>;
  enrollContacts(request: EnrollContactsRequest): Promise<EnrollContactsResponse>;
  enrollContactsFromCsv(request: EnrollContactsFromCsvRequest): Promise<EnrollContactsFromCsvResponse>;
  listEnrollments(request: ListEnrollmentsRequest): Promise<EnrollmentSummary[]>;
  createBusinessHoursProfile(request: CreateBusinessHoursProfileRequest): Promise<BusinessHoursProfileSummary>;
  listBusinessHoursProfiles(): Promise<BusinessHoursProfileSummary[]>;
  updateAccountLimits(request: UpdateAccountLimitsRequest): Promise<AccountSummary>;
  disconnectAccount(request: DisconnectAccountRequest): Promise<AccountSummary>;
  getCampaignAnalytics(request: CampaignAnalyticsRequest): Promise<CampaignAnalyticsSummary>;
  listActiveInsights(): Promise<InsightSummary[]>;
  dismissInsight(request: DismissInsightRequest): Promise<void>;
  markConversion(request: MarkConversionRequest): Promise<void>;
  unsubscribeContact(request: UnsubscribeContactRequest): Promise<void>;
  listSuppressionEntries(): Promise<SuppressionEntrySummary[]>;
  removeSuppressionEntry(request: RemoveSuppressionEntryRequest): Promise<void>;
  setReplyClassification(request: SetReplyClassificationRequest): Promise<void>;
  listUnreadNotifications(): Promise<NotificationSummary[]>;
  listErrorLogs(request: ListErrorLogsRequest): Promise<ErrorLogEntrySummary[]>;
  markNotificationRead(request: MarkNotificationReadRequest): Promise<void>;
  updateAccountSignature(request: UpdateAccountSignatureRequest): Promise<AccountSummary>;
  getAppPreferences(): Promise<AppPreferencesSummary>;
  updateAppPreferences(request: UpdateAppPreferencesRequest): Promise<AppPreferencesSummary>;
  exportBackup(request: ExportBackupRequest): Promise<ExportBackupResponse>;
  restoreBackup(request: RestoreBackupRequest): Promise<RestoreBackupResponse>;
}
