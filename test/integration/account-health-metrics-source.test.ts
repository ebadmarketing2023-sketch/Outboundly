import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { SqliteAccountHealthMetricsSource } from "../../src/adapters/persistence/repositories/account-health-metrics-source.js";
import { ingestMessage } from "../../src/application/sync-inbox/ingest-message.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("SqliteAccountHealthMetricsSource (Section 19.2)", () => {
  let db: OutboundlyDb;
  let accountId: string;
  let conversationRepo: SqliteConversationRepository;
  let metricsSource: SqliteAccountHealthMetricsSource;
  const now = new Date("2026-01-15T12:00:00Z");

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-account-health-metrics-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    accountId = randomUUID();
    db.insert(accounts)
      .values({
        id: accountId,
        provider: "google",
        emailAddress: "me@outboundly.app",
        status: "connected",
        connectedAt: new Date(now.getTime() - 90 * DAY_MS),
        createdAt: now,
        updatedAt: now
      })
      .run();
    conversationRepo = new SqliteConversationRepository(db);
    metricsSource = new SqliteAccountHealthMetricsSource(db);
  });

  it("computes account age and 24h/7d send counts from real messages", async () => {
    await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<recent@x>",
      from: "me@outboundly.app",
      to: ["them@example.com"],
      subject: "Recent",
      occurredAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) // 2 hours ago
    });
    await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<older@x>",
      from: "me@outboundly.app",
      to: ["someone@example.com"],
      subject: "Older",
      occurredAt: new Date(now.getTime() - 3 * DAY_MS) // 3 days ago
    });
    await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<too-old@x>",
      from: "me@outboundly.app",
      to: ["far@example.com"],
      subject: "Too old",
      occurredAt: new Date(now.getTime() - 10 * DAY_MS) // outside the 7d window
    });

    const metrics = await metricsSource.getMetrics(asAccountId(accountId), now);
    expect(metrics.accountAgeDays).toBe(90);
    expect(metrics.sendsLast24h).toBe(1);
    expect(metrics.sendsLast7d).toBe(2);
  });

  it("computes reply rate from real thread/message data: replied threads vs. total", async () => {
    // Thread 1: sent, got a reply.
    const t1 = await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<t1-out@x>",
      from: "me@outboundly.app",
      to: ["replier@example.com"],
      subject: "Will get a reply",
      occurredAt: new Date(now.getTime() - 5 * DAY_MS)
    });
    await ingestMessage(conversationRepo, {
      accountId,
      direction: "inbound",
      messageIdHeader: "<t1-in@x>",
      referencesHeader: "<t1-out@x>",
      from: "replier@example.com",
      to: ["me@outboundly.app"],
      subject: "Re: Will get a reply",
      occurredAt: new Date(now.getTime() - 4 * DAY_MS)
    });
    expect(t1.threadId).toBeTruthy();

    // Thread 2: sent, no reply.
    await ingestMessage(conversationRepo, {
      accountId,
      direction: "outbound",
      messageIdHeader: "<t2-out@x>",
      from: "me@outboundly.app",
      to: ["silent@example.com"],
      subject: "No reply",
      occurredAt: new Date(now.getTime() - 3 * DAY_MS)
    });

    const metrics = await metricsSource.getMetrics(asAccountId(accountId), now);
    expect(metrics.replyRate).toBeCloseTo(0.5, 5);
  });

  it("leaves replyRate and sendingConsistencyScore undefined with no outbound history", async () => {
    const metrics = await metricsSource.getMetrics(asAccountId(accountId), now);
    expect(metrics.replyRate).toBeUndefined();
    expect(metrics.sendingConsistencyScore).toBeUndefined();
    expect(metrics.sendsLast24h).toBe(0);
    expect(metrics.sendsLast7d).toBe(0);
  });
});
