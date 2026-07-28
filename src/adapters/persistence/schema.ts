import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Phase 1 subset of the logical schema in Section 5 — just enough to support a single
 * connected Google account composing, drafting, and sending mail. Conversation Engine
 * (archive/star/snooze/threading), campaigns, leads, and everything else in Section 5
 * arrive in later phases without touching these tables' shape.
 */

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // 'google' | 'microsoft' | 'smtp_imap'
  emailAddress: text("email_address").notNull(),
  displayName: text("display_name"),
  status: text("status").notNull(), // 'connected' | 'reauth_required' | 'disconnected'
  connectedAt: integer("connected_at", { mode: "timestamp_ms" }).notNull(),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  // Opaque incremental-sync cursor (Gmail's historyId, Section 11.2) — provider-specific, never
  // interpreted by core logic, just round-tripped through MailProvider.listChangesSince.
  syncCursor: text("sync_cursor"),
  dailySendLimit: integer("daily_send_limit"),
  hourlySendLimit: integer("hourly_send_limit"),
  warmupMode: integer("warmup_mode", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const oauthTokens = sqliteTable("oauth_tokens", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  // Opaque handle into the OS credential vault (Section 23) — never the token material itself.
  providerTokenRef: text("provider_token_ref").notNull(),
  scope: text("scope").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  refreshStatus: text("refresh_status").notNull(),
  lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" })
});

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  providerThreadId: text("provider_thread_id"),
  subjectNormalized: text("subject_normalized").notNull(),
  conversationState: text("conversation_state").notNull().default("active"),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  snoozedUntil: integer("snoozed_until", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  threadId: text("thread_id").references(() => threads.id),
  subject: text("subject").notNull().default(""),
  // The Internal Document Model (Section 8.1), not raw HTML.
  documentModelJson: text("document_model_json").notNull(),
  toAddresses: text("to_addresses", { mode: "json" }).notNull().$type<string[]>(),
  ccAddresses: text("cc_addresses", { mode: "json" }).$type<string[]>(),
  bccAddresses: text("bcc_addresses", { mode: "json" }).$type<string[]>(),
  providerDraftRef: text("provider_draft_ref"),
  autosaveVersion: integer("autosave_version").notNull().default(0),
  lastSavedAt: integer("last_saved_at", { mode: "timestamp_ms" }).notNull()
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").references(() => threads.id),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  providerMessageId: text("provider_message_id"),
  messageIdHeader: text("message_id_header").notNull(),
  inReplyToHeader: text("in_reply_to_header"),
  referencesHeader: text("references_header"),
  direction: text("direction").notNull(), // 'inbound' | 'outbound'
  fromAddress: text("from_address").notNull(),
  toAddresses: text("to_addresses", { mode: "json" }).notNull().$type<string[]>(),
  ccAddresses: text("cc_addresses", { mode: "json" }).$type<string[]>(),
  bccAddresses: text("bcc_addresses", { mode: "json" }).$type<string[]>(),
  subject: text("subject").notNull().default(""),
  bodyHtml: text("body_html"),
  bodyText: text("body_text"),
  snippet: text("snippet"),
  starred: integer("starred", { mode: "boolean" }).notNull().default(false),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }),
  status: text("status").notNull(), // draft|queued|sending|sent|failed|bounced
  // Still no FK, even though campaign_enrollments now exists (Section 5.6, Phase 4): SQLite has
  // no ALTER TABLE ADD CONSTRAINT — adding a FK to an already-existing column requires recreating
  // the whole table, which isn't worth the risk against real installs' existing data for a
  // referential-integrity nicety. Nullable, since a manually composed message never has one.
  campaignEnrollmentId: text("campaign_enrollment_id"),
  policyTraceJson: text("policy_trace_json", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

/**
 * Conversation Engine storage (Section 5.4, Section 11) — the active logic that decides what
 * goes into `threads`/`messages` and keeps it correct, distinct from those tables' passive
 * storage role.
 */

export const messageReferenceEdges = sqliteTable("message_reference_edges", {
  id: text("id").primaryKey(),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id),
  referencedMessageIdHeader: text("referenced_message_id_header").notNull(),
  position: integer("position").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const conversationParticipants = sqliteTable("conversation_participants", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id),
  // Still no FK, even though contacts now exists (Section 5.5, Phase 4) — same reason as
  // messages.campaignEnrollmentId above (SQLite can't add a FK to an existing column without
  // recreating the table). Nullable: not every participant has been reconciled into a Contact.
  contactId: text("contact_id"),
  emailAddress: text("email_address").notNull(),
  displayName: text("display_name"),
  role: text("role").notNull(), // 'sender' | 'to' | 'cc'
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull()
});

export const threadMerges = sqliteTable("thread_merges", {
  id: text("id").primaryKey(),
  absorbedThreadId: text("absorbed_thread_id")
    .notNull()
    .references(() => threads.id),
  canonicalThreadId: text("canonical_thread_id")
    .notNull()
    .references(() => threads.id),
  reason: text("reason").notNull(),
  mergedAt: integer("merged_at", { mode: "timestamp_ms" }).notNull()
});

/**
 * Account Health Engine storage (Section 5.2, Section 19) — a snapshot is a point-in-time
 * computation (manually triggered in this phase; no background Scheduler exists until Phase 4),
 * with its findings/recommendations stored as separate rows so a snapshot is more than a bare
 * number.
 */
export const accountHealthSnapshots = sqliteTable("account_health_snapshots", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  bounceRate: integer("bounce_rate", { mode: "number" }),
  replyRate: integer("reply_rate", { mode: "number" }),
  spamComplaintRate: integer("spam_complaint_rate", { mode: "number" }),
  sendsLast24h: integer("sends_last_24h").notNull(),
  sendsLast7d: integer("sends_last_7d").notNull(),
  accountAgeDays: integer("account_age_days").notNull(),
  sendingConsistencyScore: integer("sending_consistency_score", { mode: "number" }),
  spfStatus: text("spf_status").notNull(), // 'pass' | 'fail' | 'none'
  dkimStatus: text("dkim_status").notNull(), // 'pass' | 'fail' | 'none'
  dmarcStatus: text("dmarc_status").notNull(), // 'pass' | 'fail' | 'none'
  oauthFailureCount30d: integer("oauth_failure_count_30d").notNull(),
  tokenExpiringSoon: integer("token_expiring_soon", { mode: "boolean" }).notNull(),
  providerQuotaUsagePct: integer("provider_quota_usage_pct", { mode: "number" }),
  healthScore: integer("health_score", { mode: "number" }).notNull(),
  riskLevel: text("risk_level").notNull() // 'healthy' | 'watch' | 'at_risk' | 'critical'
});

export const accountHealthFindings = sqliteTable("account_health_findings", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id")
    .notNull()
    .references(() => accountHealthSnapshots.id),
  findingType: text("finding_type").notNull(),
  severity: text("severity").notNull(), // 'info' | 'warning' | 'critical'
  message: text("message").notNull(),
  explanation: text("explanation").notNull(),
  recommendedAction: text("recommended_action")
});

/**
 * Deliverability Engine + Lab storage (Section 5.8, Section 17, Section 18). campaignId still has
 * no FK, even though campaigns now exists (Phase 4) — same reason as messages.campaignEnrollmentId
 * above: SQLite can't add a FK to an already-existing column without recreating the table. Nullable
 * regardless, since message/account-scoped reports have no campaign at all.
 */
export const deliverabilityReports = sqliteTable("deliverability_reports", {
  id: text("id").primaryKey(),
  messageId: text("message_id").references(() => messages.id),
  campaignId: text("campaign_id"),
  accountId: text("account_id").references(() => accounts.id),
  scope: text("scope").notNull(), // 'message' | 'campaign' | 'account'
  generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
  overallScore: integer("overall_score", { mode: "number" }).notNull(),
  findingsJson: text("findings_json", { mode: "json" }).notNull().$type<DeliverabilityFindingRecord[]>()
});

/**
 * Deliverability Lab output (Section 18.3) — intentionally separate from deliverability_reports
 * because a lab run has no real message_id/campaign_id/account_id to attach to; the input is a
 * hypothetical draft/template, not a real send.
 */
export const labReports = sqliteTable("lab_reports", {
  id: text("id").primaryKey(),
  inputSnapshotJson: text("input_snapshot_json").notNull(),
  score: integer("score", { mode: "number" }).notNull(),
  findingsJson: text("findings_json", { mode: "json" }).notNull().$type<DeliverabilityFindingRecord[]>(),
  generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull()
});

export interface DeliverabilityFindingRecord {
  ruleId: string;
  category: string;
  severity: string;
  explanation: string;
}

/**
 * Leads / Contacts (Section 5.5, Phase 4) — the recipient side of a campaign, independent of the
 * Conversation Engine's own participant tracking (conversation_participants above still exists
 * for thread-level "who's on this email," while a Contact is a durable, campaign-addressable
 * record with its own lifecycle).
 */
export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    company: text("company"),
    title: text("title"),
    timezone: text("timezone"),
    customFields: text("custom_fields", { mode: "json" }).$type<Record<string, string>>(),
    source: text("source").notNull(), // 'csv_import' | 'manual' | 'reply'
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => ({
    emailIdx: uniqueIndex("contacts_email_idx").on(table.email)
  })
);

export const contactNotes = sqliteTable("contact_notes", {
  id: text("id").primaryKey(),
  contactId: text("contact_id")
    .notNull()
    .references(() => contacts.id),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const suppressionList = sqliteTable("suppression_list", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  reason: text("reason").notNull(), // 'unsubscribed' | 'bounced_hard' | 'manual' | 'complaint'
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const labels = sqliteTable("labels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color")
});

export const contactLabels = sqliteTable(
  "contact_labels",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id)
  },
  (table) => ({
    uniqueAssignment: uniqueIndex("contact_labels_contact_label_idx").on(table.contactId, table.labelId)
  })
);

/**
 * Templates & Sequences (Section 5.6, Phase 4) — the reusable content/step definitions a
 * Campaign later binds to a set of contacts and accounts.
 */
export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // The Internal Document Model (Section 8.1), same shape drafts.document_model_json uses.
  documentModelJson: text("document_model_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const templateVariants = sqliteTable("template_variants", {
  id: text("id").primaryKey(),
  templateId: text("template_id")
    .notNull()
    .references(() => templates.id),
  variantLabel: text("variant_label").notNull(),
  weight: integer("weight").notNull(),
  documentModelOverrideJson: text("document_model_override_json")
});

export const sequences = sqliteTable("sequences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"), // 'draft' | 'active' | 'archived'
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const sequenceSteps = sqliteTable("sequence_steps", {
  id: text("id").primaryKey(),
  sequenceId: text("sequence_id")
    .notNull()
    .references(() => sequences.id),
  stepOrder: integer("step_order").notNull(),
  delayDays: integer("delay_days").notNull().default(0),
  delayHours: integer("delay_hours").notNull().default(0),
  templateId: text("template_id")
    .notNull()
    .references(() => templates.id),
  stopOnReply: integer("stop_on_reply", { mode: "boolean" }).notNull().default(true),
  stopOnBounce: integer("stop_on_bounce", { mode: "boolean" }).notNull().default(true),
  conditionJson: text("condition_json", { mode: "json" })
});

/**
 * Weighting for subject-line A/B/n testing, scoped to a sequence step's template (not a running
 * campaign instance) — the same weighted-variant selection applies to every campaign that reuses
 * this sequence, matching Section 5.6's grouping of templates/variants/sequences as one reusable
 * content layer, separate from the running-instance state campaigns/enrollments own below.
 */
export const subjectVariants = sqliteTable("subject_variants", {
  id: text("id").primaryKey(),
  sequenceStepId: text("sequence_step_id")
    .notNull()
    .references(() => sequenceSteps.id),
  subjectText: text("subject_text").notNull(),
  weight: integer("weight").notNull()
});

/**
 * Scheduling Policies (Section 5.7, backs Section 15) — configuration the Scheduling Policy
 * Engine's policy objects read from, not the policy logic itself (that's pure core logic, kept
 * out of the persistence layer entirely).
 */
export const businessHoursProfiles = sqliteTable("business_hours_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  // Per-weekday start/end windows, e.g. { mon: [{start:"09:00", end:"17:00"}], ... }.
  windowsJson: text("windows_json", { mode: "json" }).notNull().$type<Record<string, { start: string; end: string }[]>>()
});

export const warmupProfiles = sqliteTable("warmup_profiles", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  startDate: integer("start_date", { mode: "timestamp_ms" }).notNull(),
  // Day-offset-from-start -> daily cap, e.g. { "0": 5, "7": 10, "14": 20 }.
  rampScheduleJson: text("ramp_schedule_json", { mode: "json" }).notNull().$type<Record<string, number>>(),
  currentDailyCap: integer("current_daily_cap").notNull()
});

export const delayPolicyConfigs = sqliteTable("delay_policy_configs", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id),
  minDelaySeconds: integer("min_delay_seconds").notNull(),
  maxDelaySeconds: integer("max_delay_seconds").notNull(),
  jitterStrategy: text("jitter_strategy").notNull().default("uniform")
});

/** Campaigns (Section 5.6, Section 14.1) — a running instance of a sequence bound to contacts,
 * sending accounts, and scheduling policy configuration. */
export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sequenceId: text("sequence_id")
    .notNull()
    .references(() => sequences.id),
  sendingAccountIds: text("sending_account_ids", { mode: "json" }).notNull().$type<string[]>(),
  businessHoursProfileId: text("business_hours_profile_id")
    .notNull()
    .references(() => businessHoursProfiles.id),
  warmupProfileId: text("warmup_profile_id").references(() => warmupProfiles.id),
  // No FK constraint here (unlike the other two): delay_policy_configs.campaign_id already
  // expresses the same relationship in the other direction (Section 5.7), and a real FK on both
  // sides would make these two tables' column types circularly dependent on each other, which
  // TypeScript can't infer without manual type annotations drizzle's own docs advise against
  // relying on. This column stays for the doc's documented shape; delay_policy_configs.campaign_id
  // is the constrained, authoritative side of the relationship.
  delayPolicyId: text("delay_policy_id"),
  status: text("status").notNull().default("draft"), // 'draft' | 'running' | 'paused' | 'completed'
  dailyLimitOverride: integer("daily_limit_override"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

/** Enrollment state machine (Section 14.2) — one contact's progress through one campaign. */
export const campaignEnrollments = sqliteTable(
  "campaign_enrollments",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    currentStepId: text("current_step_id").references(() => sequenceSteps.id),
    // 'active' | 'stopped_reply' | 'stopped_bounce' | 'stopped_manual' | 'stopped_suppressed' | 'completed'
    status: text("status").notNull().default("active"),
    nextSendAt: integer("next_send_at", { mode: "timestamp_ms" }),
    enrolledAt: integer("enrolled_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => ({
    statusNextSendIdx: index("campaign_enrollments_status_next_send_idx").on(table.status, table.nextSendAt)
  })
);

/**
 * The single outbound queue (Section 5.8, Section 16.2) — durable, ordered storage only; rate
 * limiting and account resolution are separate concerns handled at dispatch time, not modeled as
 * queue-row state.
 */
export const sendQueue = sqliteTable(
  "send_queue",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    priority: text("priority").notNull(), // 'manual' | 'campaign'
    earliestSendAt: integer("earliest_send_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status").notNull().default("pending"), // 'pending' | 'claimed' | 'sent' | 'failed' | 'cancelled'
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => ({
    statusEarliestSendIdx: index("send_queue_status_earliest_send_idx").on(table.status, table.earliestSendAt),
    idempotencyKeyIdx: uniqueIndex("send_queue_idempotency_key_idx").on(table.idempotencyKey)
  })
);
