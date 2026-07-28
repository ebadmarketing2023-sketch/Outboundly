import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts, messages } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import { labelReply, type LabelReplyDeps } from "../../src/application/analytics/label-reply.js";

describe("labelReply (Section 20.2 manual reply labeling)", () => {
  let db: OutboundlyDb;
  let deps: LabelReplyDeps;
  let conversationRepository: SqliteConversationRepository;
  let accountId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-label-reply-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));

    accountId = generateId();
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

    conversationRepository = new SqliteConversationRepository(db);
    deps = {
      conversationRepository,
      enrollmentRepository: new SqliteEnrollmentRepository(db),
      eventRepository: new SqliteEventRepository(db)
    };
  });

  function replyClassificationOf(messageId: string): string | null {
    return db.select().from(messages).where(eq(messages.id, messageId)).get()?.replyClassification ?? null;
  }

  it("labels a message and records a positive_reply event when it correlates to a campaign", async () => {
    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
      name: "Always open",
      timezone: "UTC",
      windows: { monday: [{ start: "00:00", end: "23:59" }] }
    });
    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await new SqliteCampaignRepository(db).create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    const contact = await new SqliteContactRepository(db).upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const threadId = await conversationRepository.createThread({
      accountId,
      subjectNormalized: "hello",
      conversationState: "awaiting_reply"
    });
    await conversationRepository.insertMessage({
      accountId,
      threadId,
      messageIdHeader: "<outbound@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["lead@example.com"],
      subject: "hello",
      status: "sent",
      sentAt: new Date(),
      campaignEnrollmentId: enrollment.id
    });
    const replyMessageId = await conversationRepository.insertMessage({
      accountId,
      threadId,
      messageIdHeader: "<reply@example.com>",
      direction: "inbound",
      fromAddress: "lead@example.com",
      toAddresses: ["me@outboundly.app"],
      subject: "Re: hello",
      status: "received",
      receivedAt: new Date()
    });

    const now = new Date("2026-04-01T00:00:00.000Z");
    await labelReply(deps, replyMessageId, "interested", now);

    expect(replyClassificationOf(replyMessageId)).toBe("interested");

    const events = await deps.eventRepository.findByCampaignInWindow(
      campaign.id,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 60_000)
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("positive_reply");
  });

  it("labels a message without recording an event for non-interested classifications", async () => {
    const threadId = await conversationRepository.createThread({
      accountId,
      subjectNormalized: "hello",
      conversationState: "active"
    });
    const replyMessageId = await conversationRepository.insertMessage({
      accountId,
      threadId,
      messageIdHeader: "<reply2@example.com>",
      direction: "inbound",
      fromAddress: "lead2@example.com",
      toAddresses: ["me@outboundly.app"],
      subject: "Re: hello",
      status: "received",
      receivedAt: new Date()
    });

    await labelReply(deps, replyMessageId, "not_interested");
    expect(replyClassificationOf(replyMessageId)).toBe("not_interested");

    await labelReply(deps, replyMessageId, "out_of_office");
    expect(replyClassificationOf(replyMessageId)).toBe("out_of_office");
  });

  it("labels 'interested' without recording an event when the thread has no campaign-originated message", async () => {
    const threadId = await conversationRepository.createThread({
      accountId,
      subjectNormalized: "manual thread",
      conversationState: "active"
    });
    const replyMessageId = await conversationRepository.insertMessage({
      accountId,
      threadId,
      messageIdHeader: "<manual-reply@example.com>",
      direction: "inbound",
      fromAddress: "someone@example.com",
      toAddresses: ["me@outboundly.app"],
      subject: "Re: manual",
      status: "received",
      receivedAt: new Date()
    });

    await labelReply(deps, replyMessageId, "interested");
    expect(replyClassificationOf(replyMessageId)).toBe("interested");
  });
});
