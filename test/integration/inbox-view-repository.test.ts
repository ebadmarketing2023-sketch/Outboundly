import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { InboxViewRepository } from "../../src/adapters/persistence/repositories/inbox-view-repository.js";
import { ingestMessage } from "../../src/application/sync-inbox/ingest-message.js";

describe("InboxViewRepository (Section 11.4)", () => {
  let db: OutboundlyDb;
  let accountId: string;
  let conversationRepo: SqliteConversationRepository;
  let inboxView: InboxViewRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-inbox-view-test-"));
    db = openDatabase(join(dir, "test.sqlite"));
    accountId = randomUUID();
    const now = new Date();
    db.insert(accounts)
      .values({
        id: accountId,
        provider: "google",
        emailAddress: "me@outboundly.app",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();
    conversationRepo = new SqliteConversationRepository(db);
    inboxView = new InboxViewRepository(db);
  });

  it("lists threads for an account, excluding archived by default", async () => {
    const first = await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "First"
    });
    const second = await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<m2@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Second"
    });

    await inboxView.setThreadArchived(second.threadId, true);

    const activeOnly = await inboxView.listThreads(accountId);
    expect(activeOnly.map((t) => t.id)).toEqual([first.threadId]);

    const withArchived = await inboxView.listThreads(accountId, { includeArchived: true });
    expect(withArchived.map((t) => t.id).sort()).toEqual([first.threadId, second.threadId].sort());
  });

  it("returns a thread's messages in chronological order and supports starring", async () => {
    const sent = await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello",
      occurredAt: new Date(2026, 0, 1)
    });
    const reply = await ingestMessage(conversationRepo, {
      accountId,
      direction: "inbound",
      messageIdHeader: "<m2@x>",
      inReplyToHeader: "<m1@x>",
      referencesHeader: "<m1@x>",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Re: Hello",
      occurredAt: new Date(2026, 0, 2)
    });
    expect(reply.threadId).toBe(sent.threadId);

    const messagesInThread = await inboxView.getThreadMessages(sent.threadId);
    expect(messagesInThread.map((m) => m.subject)).toEqual(["Hello", "Re: Hello"]);
    expect(messagesInThread.every((m) => m.starred === false)).toBe(true);

    await inboxView.setMessageStarred(messagesInThread[0]!.id, true);
    const reloaded = await inboxView.getThreadMessages(sent.threadId);
    expect(reloaded[0]!.starred).toBe(true);
  });
});
