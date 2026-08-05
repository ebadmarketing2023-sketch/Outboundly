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
  /** Delivery *delay* notices seen. Reported separately because they are deliberately not acted
   * on -- the message is still in flight, so stopping the sequence would write off a live lead. */
  transientBouncesDetected: number;
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

/** Deletes an entire CSV import at once (Critical Improvement #3), not one lead at a time -- every
 * contact in the batch goes through the same stop-active-enrollments-then-soft-delete path a
 * single deleteContact call would, and the batch itself is removed from the Leads screen's group
 * switcher. */
export interface DeleteLeadImportBatchRequest {
  batchId: string;
}

export interface CreateTemplateRequest {
  name: string;
  bodyText: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
}

export interface DeleteTemplateRequest {
  templateId: string;
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

export interface DeleteSequenceRequest {
  sequenceId: string;
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
  sendingAccountIds: string[];
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

/** Cascades safely regardless of how many leads the campaign has -- see
 * CampaignRepository.delete's docblock. */
export interface DeleteCampaignRequest {
  campaignId: string;
}

export interface SetCampaignStatusRequest {
  campaignId: string;
  status: string;
}

/** Campaign-creation wizard (Section 5.6): one atomic template+subject pair for the first step.
 * Weight is a share, not required to sum to 100 -- selectWeightedVariant normalizes against
 * whatever total the groups actually add up to. */
export interface CreateCampaignWizardContentGroupRequest {
  subjectText: string;
  bodyText: string;
  weight: number;
}

/** A single optional follow-up step: one template, one delay since the previous step -- no
 * variation/weighting, and no independently configurable subject (it's always sent as
 * "Re: <original subject>", matching the pre-existing follow-up threading behavior exactly). */
export interface CreateCampaignWizardFollowUpStepRequest {
  bodyText: string;
  delayDays: number;
  delayHours: number;
}

export type CreateCampaignWizardLeadsSource =
  | { type: "csv"; csvText: string; filename?: string }
  | { type: "batch"; batchId: string };

export interface CreateCampaignWizardRequest {
  name: string;
  /** At least one required -- every account here goes into the campaign's rotation pool. */
  sendingAccountIds: string[];
  timezone: string;
  /** Lowercase full weekday names ("monday".."sunday") sending is allowed on. */
  days: string[];
  start: string; // "HH:MM", 24-hour
  end: string;
  /** At least one required. */
  contentGroups: CreateCampaignWizardContentGroupRequest[];
  followUpSteps: CreateCampaignWizardFollowUpStepRequest[];
  leadsSource: CreateCampaignWizardLeadsSource;
}

/** Checks the wizard's copy against the leads it will be launched with, before anything is
 * created. A {{token}} with no fallback that a lead has no value for means that lead is silently
 * never emailed, so the Review step reports it up front instead. */
export interface PreviewCampaignPersonalizationRequest {
  /** Every subject and body the campaign will send. */
  texts: string[];
  leadsSource: CreateCampaignWizardLeadsSource;
}

export interface PersonalizationTokenCoverageSummary {
  name: string;
  hasFallback: boolean;
  missingCount: number;
}

export interface PreviewCampaignPersonalizationResponse {
  totalLeads: number;
  tokens: PersonalizationTokenCoverageSummary[];
  leadsMissingRequiredValues: number;
}

export interface CreateCampaignWizardResponse {
  campaign: CampaignSummary;
  imported?: number;
  importSkipped?: Array<{ row: number; reason: string }>;
  enrolled: number;
  enrollSkipped: Array<{ contactId: string; reason: string }>;
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

/** Enrolls a campaign from a CSV batch already uploaded earlier (Leads screen or a previous
 * campaign's own upload) instead of re-uploading/pasting the same file again -- the same
 * isolation guarantee as EnrollContactsFromCsvRequest (only that batch's contacts, never the
 * whole global list), just skipping the re-import step since the batch already exists. */
export interface EnrollContactsFromBatchRequest {
  campaignId: string;
  batchId: string;
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
  /** The randomized per-send delay range in seconds (Critical Improvement #1). Saving this applies
   * it immediately to every currently connected sending account, not just future ones. */
  defaultMinSendDelaySeconds?: number;
  defaultMaxSendDelaySeconds?: number;
  /** Whether a lead may be actively enrolled in more than one campaign at a time. Off by default:
   * two live campaigns sharing a lead send that person two unrelated cold emails from the same
   * domain, which reads as spam rather than as an extra touch. */
  allowConcurrentCampaigns?: boolean;
}

export interface UpdateAppPreferencesRequest {
  defaultBusinessHoursProfileId?: string;
  defaultSendingAccountId?: string;
  defaultMinSendDelaySeconds?: number;
  defaultMaxSendDelaySeconds?: number;
  allowConcurrentCampaigns?: boolean;
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
  importContactsCsv(request: ImportContactsCsvRequest): Promise<ImportContactsCsvResponse>;
  listContacts(): Promise<ContactSummary[]>;
  listLeadImportBatches(): Promise<LeadImportBatchSummary[]>;
  deleteContact(request: DeleteContactRequest): Promise<void>;
  deleteLeadImportBatch(request: DeleteLeadImportBatchRequest): Promise<void>;
  createTemplate(request: CreateTemplateRequest): Promise<TemplateSummary>;
  listTemplates(): Promise<TemplateSummary[]>;
  deleteTemplate(request: DeleteTemplateRequest): Promise<void>;
  createSequence(request: CreateSequenceRequest): Promise<SequenceSummary>;
  listSequences(): Promise<SequenceSummary[]>;
  deleteSequence(request: DeleteSequenceRequest): Promise<void>;
  createCampaign(request: CreateCampaignRequest): Promise<CampaignSummary>;
  createCampaignFromWizard(request: CreateCampaignWizardRequest): Promise<CreateCampaignWizardResponse>;
  previewCampaignPersonalization(request: PreviewCampaignPersonalizationRequest): Promise<PreviewCampaignPersonalizationResponse>;
  listCampaigns(): Promise<CampaignSummary[]>;
  listCampaignDashboard(): Promise<CampaignDashboardEntrySummary[]>;
  updateCampaign(request: UpdateCampaignRequest): Promise<CampaignSummary>;
  deleteCampaign(request: DeleteCampaignRequest): Promise<void>;
  setCampaignStatus(request: SetCampaignStatusRequest): Promise<void>;
  enrollContacts(request: EnrollContactsRequest): Promise<EnrollContactsResponse>;
  enrollContactsFromCsv(request: EnrollContactsFromCsvRequest): Promise<EnrollContactsFromCsvResponse>;
  enrollContactsFromBatch(request: EnrollContactsFromBatchRequest): Promise<EnrollContactsResponse>;
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
