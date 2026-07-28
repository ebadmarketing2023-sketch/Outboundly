import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getCampaignAnalytics, type CampaignAnalyticsDeps } from "../../src/adapters/persistence/campaign-analytics-support.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignMetricsRollupRepository } from "../../src/adapters/persistence/repositories/campaign-metrics-rollup-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asCampaignId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("getCampaignAnalytics (Section 20.5 campaign dashboard)", () => {
  let db: OutboundlyDb;
  let deps: CampaignAnalyticsDeps;
  let campaignId: string;
  let conversationRepository: SqliteConversationRepository;
  let accountId: string;
  let templateAId: string;
  let templateBId: string;
  let enrollmentRepository: SqliteEnrollmentRepository;
  let stepAId: string;
  let stepBId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-campaign-analytics-test-"));
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
    const templateRepository = new SqliteTemplateRepository(db);
    const templateA = await templateRepository.create({ name: "Step 1 template", document: { blocks: [] } });
    const templateB = await templateRepository.create({ name: "Step 2 template", document: { blocks: [] } });
    templateAId = templateA.id;
    templateBId = templateB.id;

    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: templateA.id },
        { delayDays: 1, delayHours: 0, templateId: templateB.id }
      ]
    });
    stepAId = sequence.steps[0]!.id;
    stepBId = sequence.steps[1]!.id;

    const campaignRepository = new SqliteCampaignRepository(db);
    const campaign = await campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    campaignId = campaign.id;

    conversationRepository = new SqliteConversationRepository(db);
    enrollmentRepository = new SqliteEnrollmentRepository(db);

    deps = {
      db,
      campaignRepository,
      sequenceRepository: new SqliteSequenceRepository(db),
      enrollmentRepository,
      campaignMetricsRollupRepository: new SqliteCampaignMetricsRollupRepository(db)
    };
  });

  it("combines rollup totals, a per-step funnel, and a stop-reason breakdown", async () => {
    const contactRepository = new SqliteContactRepository(db);
    const contactA = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const contactB = await contactRepository.upsertByEmail({ email: "b@example.com", source: "manual" });

    const now = new Date("2026-03-01T00:00:00.000Z");
    const enrollmentA = await enrollmentRepository.enroll({
      campaignId: asCampaignId(campaignId),
      contactId: contactA.id,
      currentStepId: stepAId,
      nextSendAt: now
    });
    const enrollmentB = await enrollmentRepository.enroll({
      campaignId: asCampaignId(campaignId),
      contactId: contactB.id,
      currentStepId: stepAId,
      nextSendAt: now
    });

    // Enrollment A: sent step 1 then step 2, still active.
    const threadA = await conversationRepository.createThread({
      accountId,
      subjectNormalized: "hello",
      conversationState: "awaiting_reply"
    });
    await conversationRepository.insertMessage({
      accountId,
      threadId: threadA,
      messageIdHeader: "<a-step1@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["a@example.com"],
      subject: "hello",
      status: "sent",
      sentAt: now,
      campaignEnrollmentId: enrollmentA.id,
      templateId: templateAId
    });
    await conversationRepository.insertMessage({
      accountId,
      threadId: threadA,
      messageIdHeader: "<a-step2@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["a@example.com"],
      subject: "hello again",
      status: "sent",
      sentAt: now,
      campaignEnrollmentId: enrollmentA.id,
      templateId: templateBId
    });

    // Enrollment B: sent step 1 only, then bounced.
    const threadB = await conversationRepository.createThread({
      accountId,
      subjectNormalized: "hello",
      conversationState: "active"
    });
    await conversationRepository.insertMessage({
      accountId,
      threadId: threadB,
      messageIdHeader: "<b-step1@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["b@example.com"],
      subject: "hello",
      status: "sent",
      sentAt: now,
      campaignEnrollmentId: enrollmentB.id,
      templateId: templateAId
    });
    await enrollmentRepository.advance(enrollmentB.id, { status: "stopped_bounce" });

    await deps.campaignMetricsRollupRepository.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart: now, sentCount: 3, bouncedCount: 1, repliedCount: 1, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 1, openedCount: 0, clickedCount: 0 }],
      now
    );

    const result = await getCampaignAnalytics(deps, asCampaignId(campaignId), now);

    expect(result.sentCount).toBe(3);
    expect(result.bouncedCount).toBe(1);
    expect(result.conversionCount).toBe(1);
    expect(result.bounceRate).toBeCloseTo(1 / 3, 5);
    expect(result.replyRate).toBeCloseTo(1 / 3, 5);

    expect(result.stepFunnel).toEqual([
      { stepOrder: 1, templateId: templateAId, sentCount: 2 },
      { stepOrder: 2, templateId: templateBId, sentCount: 1 }
    ]);

    expect(result.stopReasonBreakdown).toEqual({
      active: 1,
      completed: 0,
      stopped_reply: 0,
      stopped_bounce: 1,
      stopped_manual: 0,
      stopped_suppressed: 0
    });
  });

  it("returns zeroed metrics and an empty funnel for a campaign with no enrollments or rollup data", async () => {
    const now = new Date();
    const result = await getCampaignAnalytics(deps, asCampaignId(campaignId), now);
    expect(result.sentCount).toBe(0);
    expect(result.replyRate).toBeUndefined();
    expect(result.stepFunnel).toEqual([
      { stepOrder: 1, templateId: templateAId, sentCount: 0 },
      { stepOrder: 2, templateId: templateBId, sentCount: 0 }
    ]);
    expect(result.stopReasonBreakdown).toEqual({
      active: 0,
      completed: 0,
      stopped_reply: 0,
      stopped_bounce: 0,
      stopped_manual: 0,
      stopped_suppressed: 0
    });
  });

  it("throws for an unknown campaign id", async () => {
    await expect(getCampaignAnalytics(deps, asCampaignId(generateId()), new Date())).rejects.toThrow();
  });
});
