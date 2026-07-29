import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getCampaignDashboard, type CampaignDashboardDeps } from "../../src/adapters/persistence/campaign-dashboard-support.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asCampaignId, asMessageId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("getCampaignDashboard (Critical Improvement #4 campaign list)", () => {
  let db: OutboundlyDb;
  let deps: CampaignDashboardDeps;
  let campaignId: string;
  let conversationRepository: SqliteConversationRepository;
  let enrollmentRepository: SqliteEnrollmentRepository;
  let sendQueueRepository: SqliteSendQueueRepository;
  let eventRepository: SqliteEventRepository;
  let accountId: string;
  let stepAId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-campaign-dashboard-test-"));
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
    stepAId = sequence.steps[0]!.id;

    const campaignRepository = new SqliteCampaignRepository(db);
    const campaign = await campaignRepository.create({
      name: "Q1 outreach",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    campaignId = campaign.id;

    conversationRepository = new SqliteConversationRepository(db);
    enrollmentRepository = new SqliteEnrollmentRepository(db);
    sendQueueRepository = new SqliteSendQueueRepository(db);
    eventRepository = new SqliteEventRepository(db);

    deps = { db, campaignRepository, enrollmentRepository };
  });

  it("returns zeroed metrics for a campaign with no enrollments yet", async () => {
    const [entry] = await getCampaignDashboard(deps);
    expect(entry).toMatchObject({
      id: campaignId,
      name: "Q1 outreach",
      status: "draft",
      sendingAccountIds: [accountId],
      totalLeads: 0,
      emailsSent: 0,
      emailsRemaining: 0,
      replies: 0,
      completionPercent: 0
    });
    expect(entry!.replyRatePercent).toBeUndefined();
    expect(entry!.lastActivityAt).toBeUndefined();
    expect(entry!.createdAt).toBeInstanceOf(Date);
  });

  it("computes totalLeads, completionPercent, and lastActivityAt across a mix of active/terminal enrollments", async () => {
    const contactRepository = new SqliteContactRepository(db);
    const contactA = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const contactB = await contactRepository.upsertByEmail({ email: "b@example.com", source: "manual" });

    const earlier = new Date("2026-03-01T00:00:00.000Z");
    const later = new Date("2026-03-02T00:00:00.000Z");

    const enrollmentA = await enrollmentRepository.enroll({
      campaignId: asCampaignId(campaignId),
      contactId: contactA.id,
      currentStepId: stepAId,
      nextSendAt: earlier
    });
    const enrollmentB = await enrollmentRepository.enroll({
      campaignId: asCampaignId(campaignId),
      contactId: contactB.id,
      currentStepId: stepAId,
      nextSendAt: earlier
    });

    // Enrollment A completed, with its last send at `later`.
    const threadA = await conversationRepository.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    await conversationRepository.insertMessage({
      accountId,
      threadId: threadA,
      messageIdHeader: "<a@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["a@example.com"],
      subject: "hi",
      status: "sent",
      sentAt: later,
      campaignEnrollmentId: enrollmentA.id
    });
    await enrollmentRepository.advance(enrollmentA.id, { status: "completed", nextSendAt: undefined });

    // Enrollment B still active, sent earlier than A.
    const threadB = await conversationRepository.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    await conversationRepository.insertMessage({
      accountId,
      threadId: threadB,
      messageIdHeader: "<b@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["b@example.com"],
      subject: "hi",
      status: "sent",
      sentAt: earlier,
      campaignEnrollmentId: enrollmentB.id
    });

    // Live-computed, not from a rollup bucket (Section 21.1's rollup worker can lag by minutes, or
    // by a full hour on a fresh app start before its startup fix) -- the dashboard must reflect a
    // real reply immediately.
    await eventRepository.record({ eventType: "replied", campaignId: asCampaignId(campaignId), occurredAt: later });

    const [entry] = await getCampaignDashboard(deps);
    expect(entry).toMatchObject({
      totalLeads: 2,
      emailsSent: 2,
      replies: 1,
      completionPercent: 50, // 1 of 2 enrollments terminal
      replyRatePercent: 50 // 1 reply / 2 sent
    });
    expect(entry!.lastActivityAt?.getTime()).toBe(later.getTime());
  });

  it("counts only pending/claimed send_queue rows toward emailsRemaining, not sent/failed/cancelled ones", async () => {
    const contactRepository = new SqliteContactRepository(db);
    const contact = await contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await enrollmentRepository.enroll({
      campaignId: asCampaignId(campaignId),
      contactId: contact.id,
      currentStepId: stepAId,
      nextSendAt: new Date()
    });

    const thread = await conversationRepository.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    const pendingMessageId = await conversationRepository.insertMessage({
      accountId,
      threadId: thread,
      messageIdHeader: "<pending@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["lead@example.com"],
      subject: "hi",
      status: "queued",
      campaignEnrollmentId: enrollment.id
    });
    const sentMessageId = await conversationRepository.insertMessage({
      accountId,
      threadId: thread,
      messageIdHeader: "<sent@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["lead@example.com"],
      subject: "hi",
      status: "sent",
      sentAt: new Date(),
      campaignEnrollmentId: enrollment.id
    });

    await sendQueueRepository.enqueue({
      messageId: asMessageId(pendingMessageId),
      accountId: asAccountId(accountId),
      priority: "campaign",
      earliestSendAt: new Date(Date.now() + 60_000),
      idempotencyKey: "pending-key"
    });
    const sentQueueEntry = await sendQueueRepository.enqueue({
      messageId: asMessageId(sentMessageId),
      accountId: asAccountId(accountId),
      priority: "campaign",
      earliestSendAt: new Date(Date.now() - 60_000),
      idempotencyKey: "sent-key"
    });
    await sendQueueRepository.markSent(sentQueueEntry.id);

    const [entry] = await getCampaignDashboard(deps);
    expect(entry!.emailsRemaining).toBe(1);
  });

  it("does not count an enrollment as 'complete' while its last email is still sitting in send_queue, unsent", async () => {
    // Reproduces a real reported bug: a single-step sequence's enrollment flips to 'completed' the
    // instant its message is enqueued (Section 14.3 -- queuing, not delivery, advances the state
    // machine), which can be well before the Send worker actually dispatches it (e.g. a configured
    // send delay holding it in the queue). The dashboard must not show 100% completion until the
    // email has actually left the queue.
    const contactRepository = new SqliteContactRepository(db);
    const contact = await contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await enrollmentRepository.enroll({
      campaignId: asCampaignId(campaignId),
      contactId: contact.id,
      currentStepId: stepAId,
      nextSendAt: new Date()
    });

    const thread = await conversationRepository.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    const messageId = await conversationRepository.insertMessage({
      accountId,
      threadId: thread,
      messageIdHeader: "<queued@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["lead@example.com"],
      subject: "hi",
      status: "queued",
      campaignEnrollmentId: enrollment.id
    });
    await sendQueueRepository.enqueue({
      messageId: asMessageId(messageId),
      accountId: asAccountId(accountId),
      priority: "campaign",
      earliestSendAt: new Date(Date.now() + 60_000), // still waiting out a configured send delay
      idempotencyKey: "still-queued-key"
    });
    // The engine's own state machine already advanced this enrollment to 'completed' at enqueue
    // time, well before the send worker gets to it.
    await enrollmentRepository.advance(enrollment.id, { status: "completed", nextSendAt: undefined });

    const [entry] = await getCampaignDashboard(deps);
    expect(entry!.emailsSent).toBe(0);
    expect(entry!.emailsRemaining).toBe(1);
    expect(entry!.completionPercent).toBe(0);
  });
});
