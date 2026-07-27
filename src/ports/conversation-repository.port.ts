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
}

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
}
