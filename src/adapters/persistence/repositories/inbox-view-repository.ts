import { and, desc, eq, isNull } from "drizzle-orm";
import type { OutboundlyDb } from "../db.js";
import { messages, threads } from "../schema.js";

/**
 * The Unified Inbox's read-model repository (Section 11.4): a view over the Conversation
 * Engine's storage plus a small set of presentation-level flags (archive/star). It does not own
 * conversation identity or threading logic — that stays entirely in the Conversation Engine
 * (Section 11) — it only queries and toggles state on top of it.
 */

export interface ThreadSummary {
  id: string;
  subjectNormalized: string;
  conversationState: string;
  archivedAt?: Date;
  updatedAt: Date;
}

export interface MessageDetail {
  id: string;
  direction: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  starred: boolean;
  sentAt?: Date;
  receivedAt?: Date;
}

export class InboxViewRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async listThreads(accountId: string, options: { includeArchived?: boolean } = {}): Promise<ThreadSummary[]> {
    const condition = options.includeArchived
      ? eq(threads.accountId, accountId)
      : and(eq(threads.accountId, accountId), isNull(threads.archivedAt));

    const rows = this.db.select().from(threads).where(condition).orderBy(desc(threads.updatedAt)).all();
    return rows.map((row) => ({
      id: row.id,
      subjectNormalized: row.subjectNormalized,
      conversationState: row.conversationState,
      archivedAt: row.archivedAt ?? undefined,
      updatedAt: row.updatedAt
    }));
  }

  async getThreadMessages(threadId: string): Promise<MessageDetail[]> {
    const rows = this.db.select().from(messages).where(eq(messages.threadId, threadId)).all();
    return rows
      .map((row) => ({
        id: row.id,
        direction: row.direction,
        fromAddress: row.fromAddress,
        toAddresses: row.toAddresses,
        subject: row.subject,
        bodyText: row.bodyText ?? undefined,
        bodyHtml: row.bodyHtml ?? undefined,
        snippet: row.snippet ?? undefined,
        starred: row.starred,
        sentAt: row.sentAt ?? undefined,
        receivedAt: row.receivedAt ?? undefined
      }))
      .sort((a, b) => {
        const aTime = (a.sentAt ?? a.receivedAt ?? new Date(0)).getTime();
        const bTime = (b.sentAt ?? b.receivedAt ?? new Date(0)).getTime();
        return aTime - bTime;
      });
  }

  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    this.db
      .update(threads)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(threads.id, threadId))
      .run();
  }

  async setMessageStarred(messageId: string, starred: boolean): Promise<void> {
    this.db.update(messages).set({ starred }).where(eq(messages.id, messageId)).run();
  }
}
