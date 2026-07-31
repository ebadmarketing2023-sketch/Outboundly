import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import {
  accounts as accountsTable,
  businessHoursProfiles,
  campaignMetricsRollup,
  errorLogs,
  events,
  notifications,
  subjectMetricsRollup,
  subjectVariants,
  templateMetricsRollup,
  templateVariants
} from "../../src/adapters/persistence/schema.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { SqliteTemplateVariantRepository } from "../../src/adapters/persistence/repositories/template-variant-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteSubjectVariantRepository } from "../../src/adapters/persistence/repositories/subject-variant-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { asAccountId, asMessageId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("Templates/Sequences/Campaigns/Enrollments repositories (Section 5.6, Section 14)", () => {
  let db: OutboundlyDb;
  let templateRepo: SqliteTemplateRepository;
  let sequenceRepo: SqliteSequenceRepository;
  let campaignRepo: SqliteCampaignRepository;
  let enrollmentRepo: SqliteEnrollmentRepository;
  let contactRepo: SqliteContactRepository;
  let businessHoursProfileId: string;
  let accountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-campaign-repos-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    templateRepo = new SqliteTemplateRepository(db);
    sequenceRepo = new SqliteSequenceRepository(db);
    campaignRepo = new SqliteCampaignRepository(db);
    enrollmentRepo = new SqliteEnrollmentRepository(db);
    contactRepo = new SqliteContactRepository(db);

    businessHoursProfileId = "bhp-1";
    db.insert(businessHoursProfiles)
      .values({ id: businessHoursProfileId, name: "9-5", timezone: "UTC", windowsJson: {} })
      .run();

    accountId = "acct-1";
    const now = new Date();
    db.insert(accountsTable)
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
  });

  it("creates a template and round-trips its Internal Document Model", async () => {
    const template = await templateRepo.create({
      name: "Intro",
      document: { blocks: [paragraph(textRun("Hi there"))] }
    });
    const found = await templateRepo.findById(template.id);
    expect(found?.document).toEqual({ blocks: [paragraph(textRun("Hi there"))] });
  });

  it("creates a sequence with its steps atomically, in order", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Cold outreach",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });

    expect(sequence.steps).toHaveLength(2);
    expect(sequence.steps[0]?.stepOrder).toBe(1);
    expect(sequence.steps[1]?.stepOrder).toBe(2);
    expect(sequence.steps[1]?.delayDays).toBe(3);

    const reloaded = await sequenceRepo.findById(sequence.id);
    expect(reloaded?.steps).toHaveLength(2);
  });

  it("creates a campaign bound to a sequence and sending accounts", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });

    const campaign = await campaignRepo.create({
      name: "Q1 outreach",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    expect(campaign.status).toBe("draft");
    expect(campaign.sendingAccountIds).toEqual([accountId]);

    await campaignRepo.setStatus(campaign.id, "running");
    const reloaded = await campaignRepo.findById(campaign.id);
    expect(reloaded?.status).toBe("running");
  });

  it("update renames a campaign and switches its business-hours profile", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Original name",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    const otherProfileId = "bhp-2";
    db.insert(businessHoursProfiles).values({ id: otherProfileId, name: "24/7", timezone: "UTC", windowsJson: {} }).run();

    const updated = await campaignRepo.update(campaign.id, { name: "Renamed", businessHoursProfileId: otherProfileId });
    expect(updated.name).toBe("Renamed");
    expect(updated.businessHoursProfileId).toBe(otherProfileId);

    const reloaded = await campaignRepo.findById(campaign.id);
    expect(reloaded?.name).toBe("Renamed");
    expect(reloaded?.businessHoursProfileId).toBe(otherProfileId);
  });

  it("delete removes a campaign that has no enrollments", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Unused draft",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    await campaignRepo.delete(campaign.id);
    expect(await campaignRepo.findById(campaign.id)).toBeUndefined();
  });

  it("delete cascades safely when the campaign still has enrollments: cancels outstanding queued sends, removes enrollments, keeps sent message history", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "In use",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const conversationRepo = new SqliteConversationRepository(db);
    const sendQueueRepo = new SqliteSendQueueRepository(db);
    const thread = await conversationRepo.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    const sentMessageId = await conversationRepo.insertMessage({
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
    const queuedMessageId = await conversationRepo.insertMessage({
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
    const queuedEntry = await sendQueueRepo.enqueue({
      messageId: asMessageId(queuedMessageId),
      accountId: asAccountId(accountId),
      priority: "campaign",
      earliestSendAt: new Date(Date.now() + 60_000),
      idempotencyKey: "still-queued"
    });

    await campaignRepo.delete(campaign.id);

    expect(await campaignRepo.findById(campaign.id)).toBeUndefined();
    expect(await enrollmentRepo.findById(enrollment.id)).toBeUndefined();
    expect((await sendQueueRepo.findById(queuedEntry.id))?.status).toBe("cancelled");
    // The already-sent message and its history survive the campaign's deletion.
    expect(await conversationRepo.findMessageById(sentMessageId)).toBeDefined();
    expect(await conversationRepo.findMessageById(queuedMessageId)).toBeDefined();
  });

  it("delete succeeds for a campaign that has actually run and accumulated analytics rows, detaching (not losing) its event/notification/error-log history", async () => {
    // Reproduces a real reported bug: a campaign old enough to have real events, a computed
    // campaign_metrics_rollup bucket, a notification, and an error-log entry used to fail to
    // delete outright with "FOREIGN KEY constraint failed" (db.ts turns on `foreign_keys = ON`,
    // and every one of those tables has a real, enforced FK on campaigns.id -- unlike
    // messages.campaignEnrollmentId, which predates campaigns and so has no real FK). A brand-new
    // campaign with none of these rows yet (the "delete removes a campaign that has no
    // enrollments" case above) never hit this, which is exactly why it only ever showed up on
    // "old" campaigns for real users.
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Old campaign",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    const now = new Date();
    db.insert(events)
      .values({ id: generateId(), eventType: "sent", campaignId: campaign.id, accountId, occurredAt: now })
      .run();
    db.insert(campaignMetricsRollup)
      .values({
        id: generateId(),
        campaignId: campaign.id,
        periodStart: now,
        sentCount: 1,
        bouncedCount: 0,
        repliedCount: 0,
        positiveReplyCount: 0,
        unsubscribedCount: 0,
        conversionCount: 0,
        openedCount: 0,
        clickedCount: 0,
        computedAt: now
      })
      .run();
    db.insert(notifications)
      .values({
        id: generateId(),
        notificationType: "send_failure",
        severity: "warning",
        message: "test",
        relatedCampaignId: campaign.id,
        createdAt: now
      })
      .run();
    db.insert(errorLogs)
      .values({ id: generateId(), occurredAt: now, source: "send-worker", errorType: "test", errorMessage: "test", campaignId: campaign.id })
      .run();

    await expect(campaignRepo.delete(campaign.id)).resolves.toBeUndefined();
    expect(await campaignRepo.findById(campaign.id)).toBeUndefined();

    // Rollups are always safely regenerable from the event log and meaningless once the campaign
    // is gone (Section 20's own docblock), so they're deleted outright rather than detached.
    expect(db.select().from(campaignMetricsRollup).where(eq(campaignMetricsRollup.campaignId, campaign.id)).all()).toHaveLength(0);

    // Events/notifications/error-logs are real historical/audit records -- kept, just detached.
    const eventRow = db.select().from(events).all()[0];
    expect(eventRow?.eventType).toBe("sent");
    expect(eventRow?.campaignId).toBeNull();

    const notificationRow = db.select().from(notifications).all()[0];
    expect(notificationRow?.message).toBe("test");
    expect(notificationRow?.relatedCampaignId).toBeNull();

    const errorLogRow = db.select().from(errorLogs).all()[0];
    expect(errorLogRow?.errorMessage).toBe("test");
    expect(errorLogRow?.campaignId).toBeNull();
  });

  it("template delete removes an unused template", async () => {
    const template = await templateRepo.create({ name: "Unused", document: { blocks: [] } });
    await templateRepo.delete(template.id);
    expect(await templateRepo.findById(template.id)).toBeUndefined();
  });

  it("template delete rejects a template still used by a sequence step, with a clear count in the message", async () => {
    const template = await templateRepo.create({ name: "In use", document: { blocks: [] } });
    await sequenceRepo.create({ name: "Seq", steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }] });

    await expect(templateRepo.delete(template.id)).rejects.toThrow(/used by 1 sequence step/);
    expect(await templateRepo.findById(template.id)).toBeDefined();
  });

  it("template delete cascades template_variants and the regenerable template_metrics_rollup, and detaches (not loses) historical messages", async () => {
    const templateVariantRepo = new SqliteTemplateVariantRepository(db);
    const template = await templateRepo.create({ name: "With variant", document: { blocks: [] } });
    await templateVariantRepo.create({ templateId: template.id, variantLabel: "B", weight: 1, documentOverride: { blocks: [] } });

    const now = new Date();
    db.insert(templateMetricsRollup)
      .values({
        id: generateId(),
        templateId: template.id,
        periodStart: now,
        sentCount: 1,
        bouncedCount: 0,
        repliedCount: 0,
        positiveReplyCount: 0,
        unsubscribedCount: 0,
        conversionCount: 0,
        openedCount: 0,
        clickedCount: 0,
        computedAt: now
      })
      .run();

    const conversationRepo = new SqliteConversationRepository(db);
    const thread = await conversationRepo.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    const sentMessageId = await conversationRepo.insertMessage({
      accountId,
      threadId: thread,
      messageIdHeader: "<sent-template@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["lead@example.com"],
      subject: "hi",
      status: "sent",
      sentAt: now,
      templateId: template.id
    });

    await templateRepo.delete(template.id);

    expect(await templateRepo.findById(template.id)).toBeUndefined();
    expect(db.select().from(templateVariants).where(eq(templateVariants.templateId, template.id)).all()).toHaveLength(0);
    expect(db.select().from(templateMetricsRollup).where(eq(templateMetricsRollup.templateId, template.id)).all()).toHaveLength(0);

    const messageRow = await conversationRepo.findMessageById(sentMessageId);
    expect(messageRow).toBeDefined();
    expect(messageRow?.templateId).toBeUndefined();
  });

  it("sequence delete removes an unused sequence and its steps/subject variants", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({ name: "Unused seq", steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }] });
    const subjectVariantRepo = new SqliteSubjectVariantRepository(db);
    await subjectVariantRepo.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Hi", weight: 1 });

    await sequenceRepo.delete(sequence.id);

    expect(await sequenceRepo.findById(sequence.id)).toBeUndefined();
    expect(db.select().from(subjectVariants).where(eq(subjectVariants.sequenceStepId, sequence.steps[0]!.id)).all()).toHaveLength(0);
  });

  it("sequence delete rejects a sequence still bound to a campaign, with a clear count in the message", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({ name: "In use", steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }] });
    await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    await expect(sequenceRepo.delete(sequence.id)).rejects.toThrow(/used by 1 campaign/);
    expect(await sequenceRepo.findById(sequence.id)).toBeDefined();
  });

  it("sequence delete cascades the regenerable subject_metrics_rollup and detaches (not loses) historical messages", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({ name: "Seq", steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }] });
    const subjectVariantRepo = new SqliteSubjectVariantRepository(db);
    const variant = await subjectVariantRepo.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Hi", weight: 1 });

    const now = new Date();
    db.insert(subjectMetricsRollup)
      .values({
        id: generateId(),
        subjectVariantId: variant.id,
        periodStart: now,
        sentCount: 1,
        bouncedCount: 0,
        repliedCount: 0,
        positiveReplyCount: 0,
        unsubscribedCount: 0,
        conversionCount: 0,
        openedCount: 0,
        clickedCount: 0,
        computedAt: now
      })
      .run();

    const conversationRepo = new SqliteConversationRepository(db);
    const thread = await conversationRepo.createThread({ accountId, subjectNormalized: "hi", conversationState: "active" });
    const sentMessageId = await conversationRepo.insertMessage({
      accountId,
      threadId: thread,
      messageIdHeader: "<sent-subject@outboundly>",
      direction: "outbound",
      fromAddress: "me@outboundly.app",
      toAddresses: ["lead@example.com"],
      subject: "hi",
      status: "sent",
      sentAt: now,
      subjectVariantId: variant.id
    });

    await sequenceRepo.delete(sequence.id);

    expect(await sequenceRepo.findById(sequence.id)).toBeUndefined();
    expect(db.select().from(subjectMetricsRollup).where(eq(subjectMetricsRollup.subjectVariantId, variant.id)).all()).toHaveLength(0);

    const messageRow = await conversationRepo.findMessageById(sentMessageId);
    expect(messageRow).toBeDefined();
    expect(messageRow?.subjectVariantId).toBeUndefined();
  });

  it("enrolls a contact, finds it as due once next_send_at has passed, and advances it", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    // findDueForScheduling only considers enrollments whose parent campaign is 'running' (Section
    // 14.2) -- a freshly created campaign defaults to 'draft', which must never fire on its own.
    await campaignRepo.setStatus(campaign.id, "running");
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const past = new Date(Date.now() - 60_000);
    const enrollment = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: past
    });
    expect(enrollment.status).toBe("active");

    const due = await enrollmentRepo.findDueForScheduling(new Date());
    expect(due.map((e) => e.id)).toContain(enrollment.id);

    await enrollmentRepo.advance(enrollment.id, { status: "completed", nextSendAt: undefined });
    const completed = await enrollmentRepo.findById(enrollment.id);
    expect(completed?.status).toBe("completed");

    const dueAfter = await enrollmentRepo.findDueForScheduling(new Date());
    expect(dueAfter.map((e) => e.id)).not.toContain(enrollment.id);
  });

  it("prevents finding a second active enrollment for the same campaign+contact once stopped", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const enrollment = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    expect(await enrollmentRepo.findActiveByCampaignAndContact(campaign.id, contact.id)).toBeDefined();
    await enrollmentRepo.advance(enrollment.id, { status: "stopped_manual" });
    expect(await enrollmentRepo.findActiveByCampaignAndContact(campaign.id, contact.id)).toBeUndefined();
  });

  it("rejects a second active enrollment row for the same campaign+contact at the DB level (Section 24: Database Integrity), but allows re-enrolling after the first stops", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const first = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    // A real DB-level guarantee (a partial unique index on (campaign_id, contact_id) WHERE
    // status = 'active'), not just an application-level check-then-insert, closes the race a
    // concurrent double-click on "Enroll" could otherwise hit between the "already enrolled?"
    // select and the insert.
    await expect(
      enrollmentRepo.enroll({
        campaignId: campaign.id,
        contactId: contact.id,
        currentStepId: sequence.steps[0]!.id,
        nextSendAt: new Date()
      })
    ).rejects.toThrow();

    await enrollmentRepo.advance(first.id, { status: "stopped_manual" });
    const second = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
  });

  it("finds every active enrollment for a contact across multiple campaigns (Section 14.3 fan-out)", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaignA = await campaignRepo.create({
      name: "A",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const campaignB = await campaignRepo.create({
      name: "B",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await enrollmentRepo.enroll({
      campaignId: campaignA.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });
    await enrollmentRepo.enroll({
      campaignId: campaignB.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const active = await enrollmentRepo.findActiveByContact(contact.id);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((e) => e.campaignId))).toEqual(new Set([campaignA.id, campaignB.id]));
  });
});
