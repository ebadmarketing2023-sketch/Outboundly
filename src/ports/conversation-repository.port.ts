import type { DerivedParticipant } from "../core/conversation/participants.js";
import type { ConversationState } from "../core/conversation/conversation-engine.js";

export interface NewMessageInput {
  accountId: string;
  threadId: string;
  providerMessageId?: string;
  messageIdHeader: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  ccAddresses?: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  snippet?: string;
  sentAt?: Date;
  receivedAt?: Date;
  status: string;
  /** Set for campaign-originated messages (Section 14.3) — no FK (Section 5.3's schema comment
   * explains why), used to detect a reply against every active enrollment a contact has, not just
   * the one this specific message belongs to (Section 14.3's fan-out). */
  campaignEnrollmentId?: string;
  /** Set alongside campaignEnrollmentId (Section 14.3) so the Send worker (Section 21.1) can
   * re-fetch the original Draft and rebuild its MIME with the final dispatch account, which can
   * differ from the Scheduler's original proposal (Section 16.3's Provider Selector substitution). */
  draftId?: string;
  /** Snapshotted at fire time (Section 14.3) since campaign_enrollments.current_step_id has
   * already advanced past this step's template/subject by the time the message is actually sent
   * — needed for template/subject-level analytics rollups (Section 5.9, Section 20.5). */
  templateId?: string;
  subjectVariantId?: string;
}

export interface StoredMessageSummary {
  id: string;
  accountId: string;
  threadId?: string;
  toAddresses: string[];
  campaignEnrollmentId?: string;
  draftId?: string;
  templateId?: string;
  subjectVariantId?: string;
}

export type ReplyClassification = "interested" | "not_interested" | "out_of_office";

/**
 * The database-facing half of the Conversation Engine (Section 11) as a port, so the pure
 * placement logic's I/O caller (ingest-message.ts) can be tested against a fake, the same way
 * MailProvider is (Section 24.3) — the SQLite implementation is just one adapter behind this.
 */
export interface ConversationRepository {
  getSyncCursor(accountId: string): Promise<string | undefined>;
  setSyncCursor(accountId: string, cursor: string): Promise<void>;
  findThreadIdsForMessageIds(messageIdHeaders: string[]): Promise<Map<string, string>>;
  findThreadIdForProviderThreadId(accountId: string, providerThreadId: string): Promise<string | undefined>;
  createThread(input: {
    accountId: string;
    providerThreadId?: string;
    subjectNormalized: string;
    conversationState: ConversationState;
  }): Promise<string>;
  updateThreadState(threadId: string, state: ConversationState): Promise<void>;
  mergeThreads(canonicalThreadId: string, absorbThreadIds: string[], reason: string): Promise<void>;
  insertMessage(input: NewMessageInput): Promise<string>;
  insertReferenceEdges(messageId: string, ancestorChain: string[]): Promise<void>;
  upsertParticipants(threadId: string, participants: DerivedParticipant[]): Promise<void>;
  /** Transitions a queued campaign message (Section 14.3) to its final delivered state once the
   * Send worker (Section 21.1) actually dispatches it -- the row already exists (created "queued"
   * at enqueue time), so this updates it in place rather than inserting a second row.
   * providerThreadId is the real thread id the provider assigned at send time (unknowable at
   * enqueue time, before the message existed anywhere) -- when given, it's recorded onto the
   * message's thread so a later inbound reply can correlate back to it via
   * findThreadIdForProviderThreadId even if the reply's In-Reply-To/References chain doesn't match
   * (e.g. the provider rewrote the outbound Message-ID). Without this, a campaign-originated
   * thread's provider_thread_id stays null forever, unlike a manually composed send (Section 9.5's
   * sendDraftMessage records it immediately since that message isn't inserted until after sending). */
  markMessageSent(messageId: string, input: { sentAt: Date; providerMessageId?: string; providerThreadId?: string }): Promise<void>;
  /** The minimal fields the Send worker (Section 21.1) needs to dispatch a queued message it
   * didn't create itself -- which account it was queued against, its recipient (to resolve the
   * contact for live personalization), and the Draft/enrollment it was built from. */
  findMessageById(messageId: string): Promise<StoredMessageSummary | undefined>;
  /** The most recent outbound, campaign-originated message in a thread, if any — used to
   * correlate a bounce notification that threaded back to one of our own sends (Section 14.2's
   * ReplyDetected/BounceDetected fan-out reuses the same thread-placement machinery). */
  findCampaignEnrollmentIdForThread(threadId: string): Promise<string | undefined>;
  /** Every outbound message this campaign enrollment has sent so far (Section 14.3's follow-up
   * threading), oldest first. The first entry's subject is the sequence's original subject line
   * (what every later step's "Re: " continues); the last entry's Message-ID is the direct parent
   * to reply onto for the step about to fire. Empty for a first-step fire, since nothing has been
   * sent yet. */
  findOutboundMessageHistoryForEnrollment(campaignEnrollmentId: string): Promise<Array<{ messageIdHeader: string; subject: string }>>;
  /** User-applied label on an inbound reply message (Section 20.2) -- there is no automatic
   * classifier; "interested" is what feeds the Positive Reply Rate primary metric. */
  setMessageReplyClassification(messageId: string, classification: ReplyClassification): Promise<void>;
}
