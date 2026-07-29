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
import type { RecordErrorLogInput } from "../../src/ports/error-log-repository.port.js";
import type { DerivedParticipant } from "../../src/core/conversation/participants.js";
import type { ConversationState } from "../../src/core/conversation/conversation-engine.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

class FakeMailProvider implements MailProvider {
  constructor(
    private readonly messagesByRef: Record<string, NormalizedMessage>,
    private readonly failingRefs: Set<string> = new Set()
  ) {}

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
    if (this.failingRefs.has(providerMessageId)) {
      throw new Error("Requested entity was not found.");
    }
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
  campaignEnrollmentIdByThread = new Map<string, string>();
  insertedMessages: NewMessageInput[] = [];
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
    this.insertedMessages.push(input);
    this.messageIdToThreadId.set(input.messageIdHeader, input.threadId);
    if (input.direction === "outbound" && input.campaignEnrollmentId) {
      this.campaignEnrollmentIdByThread.set(input.threadId, input.campaignEnrollmentId);
    }
    return `message-${this.nextId++}`;
  }
  async insertReferenceEdges() {}
  async upsertParticipants(_threadId: string, _participants: DerivedParticipant[]) {}
  async markMessageSent() {}
  async findMessageById() {
    return undefined;
  }
  async findCampaignEnrollmentIdForThread(threadId: string) {
    return this.campaignEnrollmentIdByThread.get(threadId);
  }
  async setMessageReplyClassification() {}
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
    expect(result.failedRefs).toEqual([]);
    expect(repo.syncCursors.get("acct-1")).toBe("cursor-1");
  });

  it("isolates a single message's fetch failure instead of aborting the whole sync (Section 21.3)", async () => {
    const repo = new InMemoryConversationRepository();

    const provider = new FakeMailProvider(
      {
        "msg-ok": {
          providerMessageId: "msg-ok",
          messageIdHeader: "<ok@x>",
          from: "someone@example.com",
          to: ["me@outboundly.app"],
          subject: "This one works",
          date: new Date()
        },
        "msg-gone": {
          providerMessageId: "msg-gone",
          messageIdHeader: "<gone@x>",
          from: "someone@example.com",
          to: ["me@outboundly.app"],
          subject: "This one was deleted before we could fetch it",
          date: new Date()
        }
      },
      new Set(["msg-gone"])
    );

    const loggedErrors: RecordErrorLogInput[] = [];
    const errorLogRepository = { record: async (entry: RecordErrorLogInput) => void loggedErrors.push(entry) };

    const result = await syncInboxForAccount({ accountId: "acct-1", accountRef, provider, repo, errorLogRepository });

    // The failing message doesn't prevent the healthy one from being ingested...
    expect(result.newMessageCount).toBe(1);
    expect(repo.messageIdToThreadId.has("<ok@x>")).toBe(true);
    expect(repo.messageIdToThreadId.has("<gone@x>")).toBe(false);

    // ...the failure is reported, not silently swallowed...
    expect(result.failedRefs).toEqual([{ ref: "msg-gone", error: "Requested entity was not found." }]);

    // ...and recorded as a structured log entry (Critical Improvement #12)...
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toMatchObject({ source: "inbox-sync", errorType: "message_fetch_failed", accountId: "acct-1" });

    // ...and the cursor still advances, so the sync isn't stuck retrying the same batch forever.
    expect(repo.syncCursors.get("acct-1")).toBe("cursor-1");
  });

  it("invokes onReplyDetected only for a genuine reply, not a new/cold conversation (Section 14.3)", async () => {
    const repo = new InMemoryConversationRepository();
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

    const detectedFrom: string[] = [];
    await syncInboxForAccount({
      accountId: "acct-1",
      accountRef,
      provider,
      repo,
      onReplyDetected: async (from) => {
        detectedFrom.push(from);
      }
    });

    expect(detectedFrom).toEqual(["them@example.com"]);
  });

  it("invokes onBounceDetected (not onReplyDetected) for an automated delivery-failure notice threaded to an existing conversation", async () => {
    const repo = new InMemoryConversationRepository();
    repo.messageIdToThreadId.set("<m1@x>", "thread-1");

    const provider = new FakeMailProvider({
      "msg-bounce": {
        providerMessageId: "msg-bounce",
        messageIdHeader: "<m2@x>",
        inReplyToHeader: "<m1@x>",
        referencesHeader: "<m1@x>",
        from: "mailer-daemon@googlemail.com",
        to: ["me@outboundly.app"],
        subject: "Delivery Status Notification (Failure)",
        date: new Date()
      }
    });

    const detectedFrom: string[] = [];
    const detectedThreads: string[] = [];
    const result = await syncInboxForAccount({
      accountId: "acct-1",
      accountRef,
      provider,
      repo,
      onReplyDetected: async (from) => {
        detectedFrom.push(from);
      },
      onBounceDetected: async (threadId) => {
        detectedThreads.push(threadId);
      }
    });

    expect(detectedThreads).toEqual(["thread-1"]);
    expect(detectedFrom).toEqual([]);
    expect(result.bouncesDetected).toBe(1);
    expect(result.repliesDetected).toBe(0);
  });

  it("does not invoke onBounceDetected for a bounce-looking message that starts a new/cold thread (nothing to correlate it to)", async () => {
    const repo = new InMemoryConversationRepository();

    const provider = new FakeMailProvider({
      "msg-bounce": {
        providerMessageId: "msg-bounce",
        messageIdHeader: "<m9@x>",
        from: "mailer-daemon@example.com",
        to: ["me@outboundly.app"],
        subject: "Undelivered Mail Returned to Sender",
        date: new Date()
      }
    });

    const detectedThreads: string[] = [];
    const result = await syncInboxForAccount({
      accountId: "acct-1",
      accountRef,
      provider,
      repo,
      onBounceDetected: async (threadId) => {
        detectedThreads.push(threadId);
      }
    });

    expect(detectedThreads).toEqual([]);
    expect(result.bouncesDetected).toBe(0);
  });

  it("sanitizes a synced message's bodyHtml before it's ever persisted (Section 23)", async () => {
    const repo = new InMemoryConversationRepository();
    const provider = new FakeMailProvider({
      "msg-html": {
        providerMessageId: "msg-html",
        messageIdHeader: "<m1@x>",
        from: "someone@example.com",
        to: ["me@outboundly.app"],
        subject: "Hi",
        bodyHtml: '<p>Hello</p><script>alert(document.cookie)</script><img src="x" onerror="steal()">',
        date: new Date()
      }
    });

    await syncInboxForAccount({ accountId: "acct-1", accountRef, provider, repo });

    expect(repo.insertedMessages).toHaveLength(1);
    const stored = repo.insertedMessages[0]!.bodyHtml!;
    expect(stored).not.toContain("<script");
    expect(stored).not.toContain("alert(document.cookie)");
    expect(stored).not.toContain("onerror");
    expect(stored).toContain("Hello");
  });
});
