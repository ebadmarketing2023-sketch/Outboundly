import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts, conversationParticipants, messages, threadMerges, threads } from "../../src/adapters/persistence/schema.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { ingestMessage } from "../../src/application/sync-inbox/ingest-message.js";
import { eq } from "drizzle-orm";

describe("SqliteConversationRepository (Section 11 persistence)", () => {
  let db: OutboundlyDb;
  let accountId: string;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-conv-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
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
    repo = new SqliteConversationRepository(db);
  });

  it("persists a new thread, message, reference edges, and participants for a fresh conversation", async () => {
    const result = await ingestMessage(repo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello there"
    });

    const threadRow = db.select().from(threads).where(eq(threads.id, result.threadId)).get();
    expect(threadRow?.subjectNormalized).toBe("Hello there");
    expect(threadRow?.conversationState).toBe("awaiting_reply");

    const messageRow = db.select().from(messages).where(eq(messages.threadId, result.threadId)).get();
    expect(messageRow?.messageIdHeader).toBe("<m1@x>");

    const participantRows = db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.threadId, result.threadId))
      .all();
    expect(participantRows.map((p) => p.emailAddress).sort()).toEqual(["me@outboundly.app", "them@example.com"]);
  });

  it("round-trips the sync cursor for an account", async () => {
    expect(await repo.getSyncCursor(accountId)).toBeUndefined();
    await repo.setSyncCursor(accountId, "history-123");
    expect(await repo.getSyncCursor(accountId)).toBe("history-123");
  });

  it("markMessageSent records the thread's real provider_thread_id, since a campaign-originated thread never had one until now", async () => {
    // A campaign send is ingested "queued" (Section 14.3) before it actually goes out, so its
    // thread is created with providerThreadId undefined -- the real one is only known once the
    // Send worker (Section 21.1) actually dispatches it. A reply arriving later can only correlate
    // back via findThreadIdForProviderThreadId if this got backfilled at that point.
    const result = await ingestMessage(repo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<queued@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello there",
      status: "queued",
      campaignEnrollmentId: "enrollment-1"
    });

    let threadRow = db.select().from(threads).where(eq(threads.id, result.threadId)).get();
    expect(threadRow?.providerThreadId).toBeNull();

    await repo.markMessageSent(result.messageId!, { sentAt: new Date(), providerMessageId: "pm-1", providerThreadId: "real-thread-1" });

    threadRow = db.select().from(threads).where(eq(threads.id, result.threadId)).get();
    expect(threadRow?.providerThreadId).toBe("real-thread-1");
    expect(await repo.findThreadIdForProviderThreadId(accountId, "real-thread-1")).toBe(result.threadId);
  });

  it("markMessageSent never overwrites a thread's already-known provider_thread_id", async () => {
    const result = await ingestMessage(repo, {
      accountId,
      providerThreadId: "already-known",
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello there"
    });

    await repo.markMessageSent(result.messageId!, { sentAt: new Date(), providerThreadId: "different-value" });

    const threadRow = db.select().from(threads).where(eq(threads.id, result.threadId)).get();
    expect(threadRow?.providerThreadId).toBe("already-known");
  });

  it("attaches a reply to its parent thread via the real database, and records a merge with real rows on conflict", async () => {
    const sent = await ingestMessage(repo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<m1@x>",
      providerThreadId: "gmail-thread-1",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Hello"
    });

    const unrelated = await ingestMessage(repo, {
      accountId,
      direction: "inbound",
      messageIdHeader: "<b1@x>",
      from: "someone-else@example.com",
      to: ["me@outboundly.app"],
      subject: "Unrelated"
    });
    expect(unrelated.threadId).not.toBe(sent.threadId);

    const merging = await ingestMessage(repo, {
      accountId,
      direction: "inbound",
      messageIdHeader: "<c1@x>",
      referencesHeader: "<b1@x>",
      providerThreadId: "gmail-thread-1",
      from: "them@example.com",
      to: ["me@outboundly.app"],
      subject: "Re: Hello"
    });

    expect(merging.outcome).toBe("merged");

    const mergeRows = db.select().from(threadMerges).all();
    expect(mergeRows).toHaveLength(1);
    expect(mergeRows[0]!.canonicalThreadId).toBe(merging.threadId);

    // The absorbed thread's original message should now point at the canonical thread.
    const absorbedMessageRow = db.select().from(messages).where(eq(messages.messageIdHeader, "<b1@x>")).get();
    expect(absorbedMessageRow?.threadId).toBe(merging.threadId);
  });
});
