import { describe, expect, it } from "vitest";
import { ingestMessage } from "../../src/application/sync-inbox/ingest-message.js";
import type { ConversationRepository, NewMessageInput } from "../../src/ports/conversation-repository.port.js";
import type { DerivedParticipant } from "../../src/core/conversation/participants.js";
import type { ConversationState } from "../../src/core/conversation/conversation-engine.js";

/** A fully in-memory stand-in for the SQLite-backed repository, so ingestMessage is testable without a database. */
class InMemoryConversationRepository implements ConversationRepository {
  threads = new Map<string, { subjectNormalized: string; conversationState: ConversationState; providerThreadId?: string }>();
  messagesByThread = new Map<string, string[]>(); // threadId -> messageIdHeader[]
  messageIdToThreadId = new Map<string, string>();
  providerThreadIdToThreadId = new Map<string, string>();
  participantsByThread = new Map<string, DerivedParticipant[]>();
  referenceEdgesByMessage = new Map<string, string[]>();
  syncCursors = new Map<string, string>();
  mergeCalls: { canonicalThreadId: string; absorbThreadIds: string[]; reason: string }[] = [];
  private nextId = 1;

  async getSyncCursor(accountId: string) {
    return this.syncCursors.get(accountId);
  }
  async setSyncCursor(accountId: string, cursor: string) {
    this.syncCursors.set(accountId, cursor);
  }
  async findThreadIdsForMessageIds(messageIdHeaders: string[]) {
    const map = new Map<string, string>();
    for (const id of messageIdHeaders) {
      const threadId = this.messageIdToThreadId.get(id);
      if (threadId) map.set(id, threadId);
    }
    return map;
  }
  async findThreadIdForProviderThreadId(_accountId: string, providerThreadId: string) {
    return this.providerThreadIdToThreadId.get(providerThreadId);
  }
  async createThread(input: {
    accountId: string;
    providerThreadId?: string;
    subjectNormalized: string;
    conversationState: ConversationState;
  }) {
    const id = `thread-${this.nextId++}`;
    this.threads.set(id, { subjectNormalized: input.subjectNormalized, conversationState: input.conversationState, providerThreadId: input.providerThreadId });
    if (input.providerThreadId) this.providerThreadIdToThreadId.set(input.providerThreadId, id);
    this.messagesByThread.set(id, []);
    return id;
  }
  async updateThreadState(threadId: string, state: ConversationState) {
    const thread = this.threads.get(threadId);
    if (thread) thread.conversationState = state;
  }
  async mergeThreads(canonicalThreadId: string, absorbThreadIds: string[], reason: string) {
    this.mergeCalls.push({ canonicalThreadId, absorbThreadIds, reason });
    for (const absorbed of absorbThreadIds) {
      const absorbedMessages = this.messagesByThread.get(absorbed) ?? [];
      for (const messageIdHeader of absorbedMessages) {
        this.messageIdToThreadId.set(messageIdHeader, canonicalThreadId);
      }
      this.messagesByThread.set(canonicalThreadId, [...(this.messagesByThread.get(canonicalThreadId) ?? []), ...absorbedMessages]);
      this.messagesByThread.delete(absorbed);
    }
  }
  async insertMessage(input: NewMessageInput) {
    const id = `message-${this.nextId++}`;
    this.messageIdToThreadId.set(input.messageIdHeader, input.threadId);
    this.messagesByThread.set(input.threadId, [...(this.messagesByThread.get(input.threadId) ?? []), input.messageIdHeader]);
    return id;
  }
  async insertReferenceEdges(messageId: string, ancestorChain: string[]) {
    this.referenceEdgesByMessage.set(messageId, ancestorChain);
  }
  async upsertParticipants(threadId: string, participants: DerivedParticipant[]) {
    const existing = this.participantsByThread.get(threadId) ?? [];
    const known = new Set(existing.map((p) => p.emailAddress));
    const toAdd = participants.filter((p) => !known.has(p.emailAddress));
    this.participantsByThread.set(threadId, [...existing, ...toAdd]);
  }
  async markMessageSent() {}
  async findMessageById() {
    return undefined;
  }
  async findCampaignEnrollmentIdForThread() {
    return undefined;
  }
}

describe("ingestMessage (Conversation Engine I/O layer, Section 11)", () => {
  it("creates a new thread for a message with no known ancestors", async () => {
    const repo = new InMemoryConversationRepository();
    const result = await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello there"
    });

    expect(result.outcome).toBe("new-thread");
    expect(repo.threads.get(result.threadId)?.subjectNormalized).toBe("Hello there");
    expect(repo.threads.get(result.threadId)?.conversationState).toBe("awaiting_reply");
    expect(repo.participantsByThread.get(result.threadId)).toEqual(
      expect.arrayContaining([
        { emailAddress: "me@outboundly.app", displayName: undefined, role: "sender" },
        { emailAddress: "them@example.com", displayName: undefined, role: "to" }
      ])
    );
  });

  it("attaches a reply to the thread of its parent via the header graph, and flips state to active", async () => {
    const repo = new InMemoryConversationRepository();
    const sent = await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello there"
    });

    const reply = await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "inbound",
      messageIdHeader: "<m2@x>",
      inReplyToHeader: "<m1@x>",
      referencesHeader: "<m1@x>",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Re: Hello there"
    });

    expect(reply.outcome).toBe("attached");
    expect(reply.threadId).toBe(sent.threadId);
    expect(repo.threads.get(sent.threadId)?.conversationState).toBe("active");
  });

  it("does not re-ingest a Message-ID it has already seen (duplicate detection)", async () => {
    const repo = new InMemoryConversationRepository();
    const first = await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "inbound",
      messageIdHeader: "<dup@x>",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Hi"
    });

    const second = await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "inbound",
      messageIdHeader: "<dup@x>",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Hi"
    });

    expect(second.outcome).toBe("duplicate");
    expect(second.threadId).toBe(first.threadId);
    expect(repo.messagesByThread.get(first.threadId)).toHaveLength(1); // not inserted twice
  });

  it("merges two previously-distinct threads when the header graph proves they're the same conversation", async () => {
    const repo = new InMemoryConversationRepository();

    // Thread A: established purely via provider thread id (as if synced from Gmail).
    await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "inbound",
      messageIdHeader: "<a1@x>",
      providerThreadId: "gmail-thread-1",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Hello"
    });

    // Thread B: a separate message with no provider thread id (as if synced from an SMTP/IMAP
    // account with no native thread concept), header-unrelated at first.
    await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "inbound",
      messageIdHeader: "<b1@x>",
      from: "someone-else@example.com",
      to: ["me@outboundly.app"],
      subject: "Unrelated"
    });

    // A third message arrives that both belongs to gmail-thread-1 (provider thread match) AND
    // references <b1@x> (header match) — proving A and B are the same conversation.
    const merging = await ingestMessage(repo, {
      accountId: "acct-1",
      direction: "inbound",
      messageIdHeader: "<c1@x>",
      referencesHeader: "<b1@x>",
      providerThreadId: "gmail-thread-1",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Re: Hello"
    });

    expect(merging.outcome).toBe("merged");
    expect(repo.mergeCalls).toHaveLength(1);
    expect(repo.mergeCalls[0]!.reason).toBe("header-graph");
  });
});
