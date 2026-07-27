import { describe, expect, it } from "vitest";
import { syncInboxForAccount } from "../../src/application/sync-inbox/sync-inbox.js";
import type {
  AccountRef,
  ChangeSet,
  MailProvider,
  NormalizedMessage,
  NormalizedThread,
  ProviderDraftRef,
  ProviderSendResult,
  SyncCursor
} from "../../src/ports/mail-provider.port.js";
import { GMAIL_CAPABILITIES, type ProviderCapabilities } from "../../src/ports/provider-capabilities.port.js";
import type { ConversationRepository, NewMessageInput } from "../../src/ports/conversation-repository.port.js";
import type { DerivedParticipant } from "../../src/core/conversation/participants.js";
import type { ConversationState } from "../../src/core/conversation/conversation-engine.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

class FakeMailProvider implements MailProvider {
  constructor(private readonly messagesByRef: Record<string, NormalizedMessage>) {}

  async authenticate(): Promise<void> {}
  async sendMessage(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async createDraft(): Promise<ProviderDraftRef> {
    return { providerDraftId: "unused" };
  }
  async sendDraft(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async listChangesSince(_account: AccountRef, cursor: SyncCursor): Promise<ChangeSet> {
    expect(cursor.cursor).toBeUndefined(); // first sync in this test
    return { cursor: "cursor-1", newOrChangedMessageRefs: Object.keys(this.messagesByRef) };
  }
  async fetchMessage(_account: AccountRef, providerMessageId: string): Promise<NormalizedMessage> {
    return this.messagesByRef[providerMessageId]!;
  }
  async fetchThread(): Promise<NormalizedThread> {
    return { providerThreadId: "t", messageRefs: [] };
  }
  async appendToSentFolder(): Promise<void> {}
  capabilities(): ProviderCapabilities {
    return GMAIL_CAPABILITIES;
  }
}

class InMemoryConversationRepository implements ConversationRepository {
  messageIdToThreadId = new Map<string, string>();
  providerThreadIdToThreadId = new Map<string, string>();
  syncCursors = new Map<string, string>();
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
  async createThread(input: { providerThreadId?: string }) {
    const id = `thread-${this.nextId++}`;
    if (input.providerThreadId) this.providerThreadIdToThreadId.set(input.providerThreadId, id);
    return id;
  }
  async updateThreadState(_threadId: string, _state: ConversationState) {}
  async mergeThreads() {}
  async insertMessage(input: NewMessageInput) {
    this.messageIdToThreadId.set(input.messageIdHeader, input.threadId);
    return `message-${this.nextId++}`;
  }
  async insertReferenceEdges() {}
  async upsertParticipants(_threadId: string, _participants: DerivedParticipant[]) {}
}

describe("syncInboxForAccount (Section 11 orchestration)", () => {
  const accountRef: AccountRef = { accountId: asAccountId("acct-1"), emailAddress: "me@outboundly.app" };

  it("classifies direction by comparing From against the account's own address, counts new messages and replies, and saves the new cursor", async () => {
    const repo = new InMemoryConversationRepository();

    // Seed an existing sent message so the inbound reply below has something to attach to.
    repo.messageIdToThreadId.set("<m1@x>", "thread-1");

    const provider = new FakeMailProvider({
      "msg-reply": {
        providerMessageId: "msg-reply",
        messageIdHeader: "<m2@x>",
        inReplyToHeader: "<m1@x>",
        referencesHeader: "<m1@x>",
        from: "them@example.com",
        to: ["me@outboundly.app"],
        subject: "Re: Hello",
        date: new Date()
      },
      "msg-new": {
        providerMessageId: "msg-new",
        messageIdHeader: "<m3@x>",
        from: "someone-else@example.com",
        to: ["me@outboundly.app"],
        subject: "New conversation",
        date: new Date()
      }
    });

    const result = await syncInboxForAccount({ accountId: "acct-1", accountRef, provider, repo });

    expect(result.newMessageCount).toBe(2);
    expect(result.repliesDetected).toBe(1); // only the attach to thread-1 counts as a reply
    expect(repo.syncCursors.get("acct-1")).toBe("cursor-1");
  });
});
