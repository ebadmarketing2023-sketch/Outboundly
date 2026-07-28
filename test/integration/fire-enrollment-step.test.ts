import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEnrollmentStep, type FireEnrollmentStepDeps } from "../../src/application/campaigns/fire-enrollment-step.js";
import {
  handleBounceDetected,
  handleReplyDetected,
  stopEnrollmentsForContact,
  unsubscribeContact
} from "../../src/application/campaigns/stop-enrollments.js";
import { recordConversion } from "../../src/application/analytics/record-conversion.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { SqliteDelayPolicyConfigRepository } from "../../src/adapters/persistence/repositories/delay-policy-config-repository.js";
import { SqliteDeliverabilityReportRepository } from "../../src/adapters/persistence/repositories/deliverability-report-repository.js";
import { SqliteDraftRepository } from "../../src/adapters/persistence/repositories/draft-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { SqliteNotificationRepository } from "../../src/adapters/persistence/repositories/notification-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteSubjectVariantRepository } from "../../src/adapters/persistence/repositories/subject-variant-repository.js";
import { SqliteSuppressionListRepository } from "../../src/adapters/persistence/repositories/suppression-list-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { SqliteTemplateVariantRepository } from "../../src/adapters/persistence/repositories/template-variant-repository.js";
import { SqliteWarmupProfileRepository } from "../../src/adapters/persistence/repositories/warmup-profile-repository.js";
import { accounts, messages, sendQueue } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import { eq } from "drizzle-orm";

describe("fireEnrollmentStep (Section 14.3)", () => {
  let db: OutboundlyDb;
  let deps: FireEnrollmentStepDeps;
  let accountId: string;
  let businessHoursProfileId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-fire-step-test-"));
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

    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    const businessHoursProfile = await businessHoursProfileRepository.create({
      name: "Always open",
      timezone: "UTC",
      windows: {
        sunday: [{ start: "00:00", end: "23:59" }],
        monday: [{ start: "00:00", end: "23:59" }],
        tuesday: [{ start: "00:00", end: "23:59" }],
        wednesday: [{ start: "00:00", end: "23:59" }],
        thursday: [{ start: "00:00", end: "23:59" }],
        friday: [{ start: "00:00", end: "23:59" }],
        saturday: [{ start: "00:00", end: "23:59" }]
      }
    });
    businessHoursProfileId = businessHoursProfile.id;

    deps = {
      db,
      businessHoursProfileRepository,
      warmupProfileRepository: new SqliteWarmupProfileRepository(db),
      delayPolicyConfigRepository: new SqliteDelayPolicyConfigRepository(db),
      campaignRepository: new SqliteCampaignRepository(db),
      sequenceRepository: new SqliteSequenceRepository(db),
      templateRepository: new SqliteTemplateRepository(db),
      templateVariantRepository: new SqliteTemplateVariantRepository(db),
      subjectVariantRepository: new SqliteSubjectVariantRepository(db),
      contactRepository: new SqliteContactRepository(db),
      suppressionListRepository: new SqliteSuppressionListRepository(db),
      enrollmentRepository: new SqliteEnrollmentRepository(db),
      sendQueueRepository: new SqliteSendQueueRepository(db),
      deliverabilityReportRepository: new SqliteDeliverabilityReportRepository(db),
      conversationRepository: new SqliteConversationRepository(db),
      draftLifecycle: new DraftLifecycleService(new SqliteDraftRepository(db), new SystemClock())
    };
  });

  async function setUpTwoStepCampaign(documentByStep: [unknown, unknown?] = [{ blocks: [paragraph(textRun("Hi there"))] }]) {
    const template1 = await deps.templateRepository.create({ name: "Step 1", document: documentByStep[0] as never });
    const template2 = await deps.templateRepository.create({
      name: "Step 2",
      document: (documentByStep[1] ?? documentByStep[0]) as never
    });

    const sequence = await deps.sequenceRepository.create({
      name: "Two-step sequence",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template1.id },
        { delayDays: 3, delayHours: 0, templateId: template2.id }
      ]
    });

    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Step 1 subject", weight: 1 });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[1]!.id, subjectText: "Step 2 subject", weight: 1 });

    const campaign = await deps.campaignRepository.create({
      name: "Test campaign",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    return { campaign, sequence };
  }

  it("enqueues the first step, records a queued message, and advances the enrollment to the second step", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", firstName: "Ada", source: "manual" });

    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result.outcome).toBe("enqueued");
    if (result.outcome !== "enqueued") return;

    expect(result.enrollmentStatus).toBe("active");
    expect(result.accountId).toBe(accountId);

    const queueRow = db.select().from(sendQueue).where(eq(sendQueue.id, result.sendQueueEntryId)).get();
    expect(queueRow?.priority).toBe("campaign");
    expect(queueRow?.status).toBe("pending");

    const reloaded = await deps.enrollmentRepository.findById(enrollment.id);
    expect(reloaded?.status).toBe("active");
    expect(reloaded?.currentStepId).toBe(sequence.steps[1]!.id);
    expect(reloaded?.nextSendAt).toBeDefined();
  });

  it("completes the enrollment once the final step is fired", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead2@example.com", firstName: "Bob", source: "manual" });

    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[1]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result.outcome).toBe("enqueued");
    if (result.outcome !== "enqueued") return;
    expect(result.enrollmentStatus).toBe("completed");

    // nextSendAt is left as whatever it was (drizzle's .set() drops undefined values rather than
    // clearing columns, an established EnrollmentRepository convention) -- harmless once status
    // is no longer "active", since findDueForScheduling filters on status first.
    const reloaded = await deps.enrollmentRepository.findById(enrollment.id);
    expect(reloaded?.status).toBe("completed");
  });

  it("is idempotent: firing the same step twice enqueues only one send_queue row", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead3@example.com", firstName: "Cara", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const first = await fireEnrollmentStep(deps, enrollment, new Date());
    // Re-fire against the same (now-stale, pre-advance) enrollment snapshot to simulate a retry.
    const second = await fireEnrollmentStep(deps, enrollment, new Date());

    expect(first.outcome).toBe("enqueued");
    expect(second.outcome).toBe("enqueued");
    if (first.outcome !== "enqueued" || second.outcome !== "enqueued") return;
    expect(second.sendQueueEntryId).toBe(first.sendQueueEntryId);
  });

  it("returns suppressed and stops the enrollment when the contact is on the suppression list", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "suppressed@example.com", source: "manual" });
    await deps.suppressionListRepository.add(contact.email, "unsubscribed");

    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result.outcome).toBe("suppressed");

    const reloaded = await deps.enrollmentRepository.findById(enrollment.id);
    expect(reloaded?.status).toBe("stopped_suppressed");
  });

  it("returns no_eligible_account when the only sending account is out of daily quota", async () => {
    await db.update(accounts).set({ dailySendLimit: 0 }).where(eq(accounts.id, accountId)).run();
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead4@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result.outcome).toBe("no_eligible_account");

    const reloaded = await deps.enrollmentRepository.findById(enrollment.id);
    expect(reloaded?.status).toBe("active"); // left untouched for a later tick to retry
  });

  it("returns missing_personalization when the template references a field the contact lacks", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign([
      { blocks: [paragraph({ type: "variable", name: "first_name" })] }
    ]);
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead5@example.com", source: "manual" }); // no firstName
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result).toEqual({ outcome: "missing_personalization", variableName: "first_name" });
  });

  it("returns blocked and leaves the enrollment active when the Deliverability Engine finds a blocking issue", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign([{ blocks: [] }]); // empty body -> empty plain text -> blocking
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead6@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") return;
    expect(result.deliverabilityReport?.findings.some((f) => f.ruleId === "content-plain-text-meaningful")).toBe(true);

    const reloaded = await deps.enrollmentRepository.findById(enrollment.id);
    expect(reloaded?.status).toBe("active");
  });
});

describe("stopEnrollmentsForContact (Section 14.3 fan-out)", () => {
  let db: OutboundlyDb;
  let deps: FireEnrollmentStepDeps;
  let eventRepository: SqliteEventRepository;
  let notificationRepository: SqliteNotificationRepository;
  let accountId: string;
  let businessHoursProfileId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-stop-enrollments-test-"));
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

    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    const businessHoursProfile = await businessHoursProfileRepository.create({
      name: "Always open",
      timezone: "UTC",
      windows: { monday: [{ start: "00:00", end: "23:59" }] }
    });
    businessHoursProfileId = businessHoursProfile.id;

    deps = {
      db,
      businessHoursProfileRepository,
      warmupProfileRepository: new SqliteWarmupProfileRepository(db),
      delayPolicyConfigRepository: new SqliteDelayPolicyConfigRepository(db),
      campaignRepository: new SqliteCampaignRepository(db),
      sequenceRepository: new SqliteSequenceRepository(db),
      templateRepository: new SqliteTemplateRepository(db),
      templateVariantRepository: new SqliteTemplateVariantRepository(db),
      subjectVariantRepository: new SqliteSubjectVariantRepository(db),
      contactRepository: new SqliteContactRepository(db),
      suppressionListRepository: new SqliteSuppressionListRepository(db),
      enrollmentRepository: new SqliteEnrollmentRepository(db),
      sendQueueRepository: new SqliteSendQueueRepository(db),
      deliverabilityReportRepository: new SqliteDeliverabilityReportRepository(db),
      conversationRepository: new SqliteConversationRepository(db),
      draftLifecycle: new DraftLifecycleService(new SqliteDraftRepository(db), new SystemClock())
    };
    eventRepository = new SqliteEventRepository(db);
    notificationRepository = new SqliteNotificationRepository(db);
  });

  it("stops a reply-eligible step but leaves a stopOnReply:false step running", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id, stopOnReply: false }]
    });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const stoppedIds = await stopEnrollmentsForContact(deps, contact.id, "stopped_reply");
    expect(stoppedIds).toEqual([]);

    const reloaded = await deps.enrollmentRepository.findById(enrollment.id);
    expect(reloaded?.status).toBe("active");
  });

  it("stops every active enrollment across multiple campaigns for a reply when stopOnReply is true (default)", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaignA = await deps.campaignRepository.create({
      name: "A",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const campaignB = await deps.campaignRepository.create({
      name: "B",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const enrollmentA = await deps.enrollmentRepository.enroll({
      campaignId: campaignA.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });
    const enrollmentB = await deps.enrollmentRepository.enroll({
      campaignId: campaignB.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const stoppedIds = await stopEnrollmentsForContact(deps, contact.id, "stopped_reply");
    expect(new Set(stoppedIds)).toEqual(new Set([enrollmentA.id, enrollmentB.id]));

    expect((await deps.enrollmentRepository.findById(enrollmentA.id))?.status).toBe("stopped_reply");
    expect((await deps.enrollmentRepository.findById(enrollmentB.id))?.status).toBe("stopped_reply");
  });

  it("stopped_manual and stopped_suppressed apply unconditionally, ignoring per-step flags", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id, stopOnReply: false, stopOnBounce: false }]
    });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const stoppedIds = await stopEnrollmentsForContact(deps, contact.id, "stopped_manual");
    expect(stoppedIds).toEqual([enrollment.id]);
    expect((await deps.enrollmentRepository.findById(enrollment.id))?.status).toBe("stopped_manual");
  });

  it("handleBounceDetected correlates a bounce's thread back to the enrollment it belongs to and stops it", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Subject 1", weight: 1 });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[1]!.id, subjectText: "Subject 2", weight: 1 });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "bounced-lead@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const fireResult = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(fireResult.outcome).toBe("enqueued");

    const messageRow = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).get();
    expect(messageRow?.threadId).toBeDefined();

    const stoppedIds = await handleBounceDetected({ ...deps, eventRepository }, messageRow!.threadId!, accountId);
    expect(stoppedIds).toEqual([enrollment.id]);
    expect((await deps.enrollmentRepository.findById(enrollment.id))?.status).toBe("stopped_bounce");

    const events = await eventRepository.findByCampaignInWindow(campaign.id, new Date(0), new Date(Date.now() + 60_000));
    expect(events.some((e) => e.eventType === "bounced")).toBe(true);
  });

  it("handleBounceDetected is a no-op for a thread with no campaign-originated message", async () => {
    expect(await handleBounceDetected({ ...deps, eventRepository }, "some-unrelated-thread-id", accountId)).toEqual([]);
  });

  it("handleReplyDetected records a 'replied' event for the thread-correlated campaign and stops the contact's enrollments", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    // Two steps, not one: firing the only step of a single-step sequence already completes the
    // enrollment (Section 14.3), leaving no "active" enrollment left for stopEnrollmentsForContact
    // to find -- a two-step sequence leaves it active after the first step, which is what this
    // test actually needs to exercise (a reply arriving before the follow-up fires).
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Subject 1", weight: 1 });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[1]!.id, subjectText: "Subject 2", weight: 1 });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "replier@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const fireResult = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(fireResult.outcome).toBe("enqueued");

    const messageRow = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).get();

    const stoppedIds = await handleReplyDetected(
      { ...deps, eventRepository, notificationRepository },
      contact.email,
      { threadId: messageRow!.threadId!, accountId }
    );
    expect(stoppedIds).toEqual([enrollment.id]);
    expect((await deps.enrollmentRepository.findById(enrollment.id))?.status).toBe("stopped_reply");

    const events = await eventRepository.findByCampaignInWindow(campaign.id, new Date(0), new Date(Date.now() + 60_000));
    expect(events.some((e) => e.eventType === "replied")).toBe(true);

    const unread = await notificationRepository.findUnread(10);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.notificationType).toBe("reply_arrived");
    expect(unread[0]?.relatedCampaignId).toBe(campaign.id);
  });

  it("handleReplyDetected does not record an event or throw when the reply doesn't correlate to any campaign send", async () => {
    const contact = await deps.contactRepository.upsertByEmail({ email: "unrelated@example.com", source: "manual" });
    const stoppedIds = await handleReplyDetected(
      { ...deps, eventRepository, notificationRepository },
      contact.email,
      { threadId: "no-such-thread", accountId }
    );
    expect(stoppedIds).toEqual([]); // no active enrollments to stop either

    // A notification still fires (a known contact replied), just without a campaign correlation.
    const unread = await notificationRepository.findUnread(10);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.notificationType).toBe("reply_arrived");
    expect(unread[0]?.relatedCampaignId).toBeUndefined();
  });

  it("unsubscribeContact suppresses the contact, records an event, and stops their active enrollments", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "unsub@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const stoppedIds = await unsubscribeContact({ ...deps, eventRepository }, contact.id, campaign.id);
    expect(stoppedIds).toEqual([enrollment.id]);
    expect((await deps.enrollmentRepository.findById(enrollment.id))?.status).toBe("stopped_suppressed");
    expect(await deps.suppressionListRepository.isSuppressed(contact.email)).toBe(true);

    const events = await eventRepository.findByCampaignInWindow(campaign.id, new Date(0), new Date(Date.now() + 60_000));
    expect(events.map((e) => e.eventType)).toEqual(["unsubscribed"]);
  });

  it("recordConversion records a conversion event scoped to the campaign", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "converted@example.com", source: "manual" });

    await recordConversion(eventRepository, campaign.id, contact.id);

    const events = await eventRepository.findByCampaignInWindow(campaign.id, new Date(0), new Date(Date.now() + 60_000));
    expect(events.map((e) => e.eventType)).toEqual(["conversion"]);
  });
});
