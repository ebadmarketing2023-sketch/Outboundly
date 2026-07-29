import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { maybeCompleteCampaign, type MaybeCompleteCampaignDeps } from "../../src/application/campaigns/maybe-complete-campaign.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asMessageId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("maybeCompleteCampaign (Section 14.1)", () => {
  let db: OutboundlyDb;
  let deps: MaybeCompleteCampaignDeps;
  let campaignRepository: SqliteCampaignRepository;
  let enrollmentRepository: SqliteEnrollmentRepository;
  let sendQueueRepository: SqliteSendQueueRepository;
  let conversationRepository: SqliteConversationRepository;
  let accountId: string;
  let businessHoursProfileId: string;
  let stepAId: string;
  let sequenceId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-maybe-complete-campaign-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));

    accountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({ id: accountId, provider: "google", emailAddress: "me@outboundly.app", status: "connected", connectedAt: now, createdAt: now, updatedAt: now })
      .run();

    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
      name: "Always open",
      timezone: "UTC",
      windows: { monday: [{ start: "00:00", end: "23:59" }] }
    });
    businessHoursProfileId = businessHoursProfile.id;

    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    stepAId = sequence.steps[0]!.id;
    sequenceId = sequence.id;

    campaignRepository = new SqliteCampaignRepository(db);
    enrollmentRepository = new SqliteEnrollmentRepository(db);
    sendQueueRepository = new SqliteSendQueueRepository(db);
    conversationRepository = new SqliteConversationRepository(db);

    deps = { db, campaignRepository, enrollmentRepository };
  });

  async function createRunningCampaign() {
    const campaign = await campaignRepository.create({
      name: "Camp",
      sequenceId,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    await campaignRepository.setStatus(campaign.id, "running");
    return campaign;
  }

  it("completes a running campaign once every enrollment is terminal", async () => {
    const campaign = await createRunningCampaign();
    const contactRepository = new SqliteContactRepository(db);
    const contactA = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const contactB = await contactRepository.upsertByEmail({ email: "b@example.com", source: "manual" });
    const enrollmentA = await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contactA.id, currentStepId: stepAId, nextSendAt: new Date() });
    const enrollmentB = await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contactB.id, currentStepId: stepAId, nextSendAt: new Date() });
    await enrollmentRepository.advance(enrollmentA.id, { status: "completed", nextSendAt: undefined });
    await enrollmentRepository.advance(enrollmentB.id, { status: "stopped_bounce", nextSendAt: undefined });

    const result = await maybeCompleteCampaign(deps, campaign.id);

    expect(result).toBe(true);
    expect((await campaignRepository.findById(campaign.id))?.status).toBe("completed");
  });

  it("does not complete a running campaign with a still-active enrollment", async () => {
    const campaign = await createRunningCampaign();
    const contactRepository = new SqliteContactRepository(db);
    const contactA = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const contactB = await contactRepository.upsertByEmail({ email: "b@example.com", source: "manual" });
    const enrollmentA = await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contactA.id, currentStepId: stepAId, nextSendAt: new Date() });
    await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contactB.id, currentStepId: stepAId, nextSendAt: new Date() });
    await enrollmentRepository.advance(enrollmentA.id, { status: "completed", nextSendAt: undefined });

    const result = await maybeCompleteCampaign(deps, campaign.id);

    expect(result).toBe(false);
    expect((await campaignRepository.findById(campaign.id))?.status).toBe("running");
  });

  it("does not complete a campaign with zero enrollments (never started sending anyone)", async () => {
    const campaign = await createRunningCampaign();

    const result = await maybeCompleteCampaign(deps, campaign.id);

    expect(result).toBe(false);
    expect((await campaignRepository.findById(campaign.id))?.status).toBe("running");
  });

  it("does not touch a paused campaign even if every enrollment is terminal", async () => {
    const campaign = await createRunningCampaign();
    const contactRepository = new SqliteContactRepository(db);
    const contact = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const enrollment = await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contact.id, currentStepId: stepAId, nextSendAt: new Date() });
    await enrollmentRepository.advance(enrollment.id, { status: "completed", nextSendAt: undefined });
    await campaignRepository.setStatus(campaign.id, "paused");

    const result = await maybeCompleteCampaign(deps, campaign.id);

    expect(result).toBe(false);
    expect((await campaignRepository.findById(campaign.id))?.status).toBe("paused");
  });

  it("does not touch a draft campaign", async () => {
    const campaign = await campaignRepository.create({
      name: "Camp",
      sequenceId,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contactRepository = new SqliteContactRepository(db);
    const contact = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const enrollment = await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contact.id, currentStepId: stepAId, nextSendAt: new Date() });
    await enrollmentRepository.advance(enrollment.id, { status: "completed", nextSendAt: undefined });

    const result = await maybeCompleteCampaign(deps, campaign.id);

    expect(result).toBe(false);
    expect((await campaignRepository.findById(campaign.id))?.status).toBe("draft");
  });

  it("does not complete a campaign whose last enrollment is terminal but still has an unsent message sitting in send_queue", async () => {
    // Reproduces a real reported bug: a single-step sequence's enrollment flips to 'completed' the
    // instant its message is enqueued (Section 14.3), well before the Send worker actually
    // dispatches it -- especially with a configured send-pacing delay holding it in the queue. The
    // campaign itself must stay 'running' (so Pause/Resume remain meaningful) until that email has
    // actually left the queue, not the moment it's merely queued.
    const campaign = await createRunningCampaign();
    const contactRepository = new SqliteContactRepository(db);
    const contact = await contactRepository.upsertByEmail({ email: "a@example.com", source: "manual" });
    const enrollment = await enrollmentRepository.enroll({ campaignId: campaign.id, contactId: contact.id, currentStepId: stepAId, nextSendAt: new Date() });

    const thread = await conversationRepository.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    const messageId = await conversationRepository.insertMessage({
      accountId,
      threadId: thread,
      messageIdHeader: "<queued@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["a@example.com"],
      subject: "hi",
      status: "queued",
      campaignEnrollmentId: enrollment.id
    });
    await sendQueueRepository.enqueue({
      messageId: asMessageId(messageId),
      accountId: asAccountId(accountId),
      priority: "campaign",
      earliestSendAt: new Date(Date.now() + 60_000),
      idempotencyKey: "still-queued-key"
    });
    await enrollmentRepository.advance(enrollment.id, { status: "completed", nextSendAt: undefined });

    const result = await maybeCompleteCampaign(deps, campaign.id);

    expect(result).toBe(false);
    expect((await campaignRepository.findById(campaign.id))?.status).toBe("running");
  });
});
