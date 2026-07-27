import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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
  // No FK to a contacts table yet — Leads/Contacts (Section 5.5) is a later phase; this column
  // is nullable and unconstrained until that module exists to reconcile against.
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
 * Deliverability Engine + Lab storage (Section 5.8, Section 17, Section 18). campaignId has no FK
 * yet — Campaigns (Section 5.6) don't exist until Phase 4 — matching the same nullable,
 * unconstrained pattern already used for messages.campaignEnrollmentId above.
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
