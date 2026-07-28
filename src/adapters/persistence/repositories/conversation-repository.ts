import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { generateId } from "../../../core/shared-kernel/ids.js";
import type { DerivedParticipant } from "../../../core/conversation/participants.js";
import type { ConversationState } from "../../../core/conversation/conversation-engine.js";
import type {
  ConversationRepository as ConversationRepositoryPort,
  NewMessageInput,
  StoredMessageSummary
} from "../../../ports/conversation-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import {
  accounts,
  conversationParticipants,
  messageReferenceEdges,
  messages,
  threadMerges,
  threads
} from "../schema.js";

/**
 * SQLite implementation of the ConversationRepository port. Everything here is intentionally
 * "dumb" storage/query logic — the *decisions* (where a message belongs, whether it's a
 * duplicate, whether two threads should merge) are made by the pure functions in
 * core/conversation/conversation-engine.ts; this class only ever executes what it's told.
 */
export class SqliteConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly db: OutboundlyDb) {}

  async getSyncCursor(accountId: string): Promise<string | undefined> {
    const row = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    return row?.syncCursor ?? undefined;
  }

  async setSyncCursor(accountId: string, cursor: string): Promise<void> {
    this.db.update(accounts).set({ syncCursor: cursor, lastSyncedAt: new Date() }).where(eq(accounts.id, accountId)).run();
  }

  /** Only the Message-ID -> thread mappings relevant to one message's own ancestor chain — not the whole mailbox. */
  async findThreadIdsForMessageIds(messageIdHeaders: string[]): Promise<Map<string, string>> {
    if (messageIdHeaders.length === 0) return new Map();
    const rows = this.db
      .select({ messageIdHeader: messages.messageIdHeader, threadId: messages.threadId })
      .from(messages)
      .where(inArray(messages.messageIdHeader, messageIdHeaders))
      .all();
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.threadId) map.set(row.messageIdHeader, row.threadId);
    }
    return map;
  }

  async findThreadIdForProviderThreadId(accountId: string, providerThreadId: string): Promise<string | undefined> {
    const row = this.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.providerThreadId, providerThreadId))
      .get();
    return row?.id;
  }

  async createThread(input: {
    accountId: string;
    providerThreadId?: string;
    subjectNormalized: string;
    conversationState: ConversationState;
  }): Promise<string> {
    const id = generateId();
    const now = new Date();
    this.db
      .insert(threads)
      .values({
        id,
        accountId: input.accountId,
        providerThreadId: input.providerThreadId,
        subjectNormalized: input.subjectNormalized,
        conversationState: input.conversationState,
        createdAt: now,
        updatedAt: now
      })
      .run();
    return id;
  }

  async updateThreadState(threadId: string, state: ConversationState): Promise<void> {
    this.db.update(threads).set({ conversationState: state, updatedAt: new Date() }).where(eq(threads.id, threadId)).run();
  }

  /**
   * Absorbs each of `absorbThreadIds` into `canonicalThreadId` (Section 11.2 thread merging):
   * every message and participant moves under the canonical thread, and a thread_merges row
   * records why, for auditability.
   */
  async mergeThreads(canonicalThreadId: string, absorbThreadIds: string[], reason: string): Promise<void> {
    const now = new Date();
    for (const absorbedId of absorbThreadIds) {
      if (absorbedId === canonicalThreadId) continue;

      this.db.update(messages).set({ threadId: canonicalThreadId }).where(eq(messages.threadId, absorbedId)).run();

      const existingParticipants = this.db
        .select({ emailAddress: conversationParticipants.emailAddress })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.threadId, canonicalThreadId))
        .all();
      const existingEmails = new Set(existingParticipants.map((p) => p.emailAddress));

      const absorbedParticipants = this.db
        .select()
        .from(conversationParticipants)
        .where(eq(conversationParticipants.threadId, absorbedId))
        .all();
      for (const participant of absorbedParticipants) {
        if (existingEmails.has(participant.emailAddress)) {
          this.db.delete(conversationParticipants).where(eq(conversationParticipants.id, participant.id)).run();
        } else {
          this.db
            .update(conversationParticipants)
            .set({ threadId: canonicalThreadId })
            .where(eq(conversationParticipants.id, participant.id))
            .run();
          existingEmails.add(participant.emailAddress);
        }
      }

      this.db
        .insert(threadMerges)
        .values({
          id: generateId(),
          absorbedThreadId: absorbedId,
          canonicalThreadId,
          reason,
          mergedAt: now
        })
        .run();
    }
  }

  async insertMessage(input: NewMessageInput): Promise<string> {
    const id = generateId();
    const now = new Date();
    this.db
      .insert(messages)
      .values({
        id,
        threadId: input.threadId,
        accountId: input.accountId,
        providerMessageId: input.providerMessageId,
        messageIdHeader: input.messageIdHeader,
        inReplyToHeader: input.inReplyToHeader,
        referencesHeader: input.referencesHeader,
        direction: input.direction,
        fromAddress: input.fromAddress,
        toAddresses: input.toAddresses,
        ccAddresses: input.ccAddresses,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        snippet: input.snippet,
        sentAt: input.sentAt,
        receivedAt: input.receivedAt,
        status: input.status,
        campaignEnrollmentId: input.campaignEnrollmentId,
        draftId: input.draftId,
        createdAt: now,
        updatedAt: now
      })
      .run();
    return id;
  }

  async markMessageSent(messageId: string, input: { sentAt: Date; providerMessageId?: string }): Promise<void> {
    this.db
      .update(messages)
      .set({ status: "sent", sentAt: input.sentAt, providerMessageId: input.providerMessageId, updatedAt: new Date() })
      .where(eq(messages.id, messageId))
      .run();
  }

  async findMessageById(messageId: string): Promise<StoredMessageSummary | undefined> {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      accountId: row.accountId,
      toAddresses: row.toAddresses,
      campaignEnrollmentId: row.campaignEnrollmentId ?? undefined,
      draftId: row.draftId ?? undefined
    };
  }

  async findCampaignEnrollmentIdForThread(threadId: string): Promise<string | undefined> {
    const row = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.direction, "outbound"), isNotNull(messages.campaignEnrollmentId)))
      .orderBy(desc(messages.createdAt))
      .get();
    return row?.campaignEnrollmentId ?? undefined;
  }

  async insertReferenceEdges(messageId: string, ancestorChain: string[]): Promise<void> {
    const now = new Date();
    ancestorChain.forEach((referencedMessageIdHeader, position) => {
      this.db
        .insert(messageReferenceEdges)
        .values({
          id: generateId(),
          messageId,
          referencedMessageIdHeader,
          position,
          createdAt: now
        })
        .run();
    });
  }

  async upsertParticipants(threadId: string, participants: DerivedParticipant[]): Promise<void> {
    const now = new Date();
    const existing = this.db
      .select({ emailAddress: conversationParticipants.emailAddress })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.threadId, threadId))
      .all();
    const known = new Set(existing.map((p) => p.emailAddress));

    for (const participant of participants) {
      if (known.has(participant.emailAddress)) continue;
      known.add(participant.emailAddress);
      this.db
        .insert(conversationParticipants)
        .values({
          id: generateId(),
          threadId,
          emailAddress: participant.emailAddress,
          displayName: participant.displayName,
          role: participant.role,
          firstSeenAt: now
        })
        .run();
    }
  }
}
