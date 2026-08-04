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
import { deleteContact } from "../../src/application/leads/delete-contact.js";
import { maybeCompleteCampaign } from "../../src/application/campaigns/maybe-complete-campaign.js";
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
import { SqliteContentGroupRepository } from "../../src/adapters/persistence/repositories/content-group-repository.js";
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
        displayName: "Ada Lovelace",
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
      contentGroupRepository: new SqliteContentGroupRepository(db),
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

    // A campaign-driven send must show a real name on the From header, not a bare address (the
    // sending account's own connected profile name) -- otherwise the recipient sees only an email
    // id, which reads as unprofessional/spammy.
    const message = db.select().from(messages).where(eq(messages.id, queueRow!.messageId)).get();
    expect(message?.fromAddress).toBe('"Ada Lovelace" <me@outboundly.app>');
  });

  it("selects an atomic template+subject content group when one is configured, never mixing a group's subject with another group's template", async () => {
    // The step's own templateId/subjectVariants only exist to satisfy the pre-existing NOT NULL
    // schema -- a step with content groups configured must ignore them entirely and always use
    // the selected group's own template+subject together, exactly as createCampaignFromWizard sets
    // one up.
    const placeholderTemplate = await deps.templateRepository.create({
      name: "Placeholder",
      document: { blocks: [paragraph(textRun("placeholder, never sent"))] } as never
    });
    const sequence = await deps.sequenceRepository.create({
      name: "Content-group sequence",
      steps: [{ delayDays: 0, delayHours: 0, templateId: placeholderTemplate.id }]
    });
    const step = sequence.steps[0]!;

    const templateA = await deps.templateRepository.create({ name: "Group A", document: { blocks: [paragraph(textRun("Version A body"))] } as never });
    const templateB = await deps.templateRepository.create({ name: "Group B", document: { blocks: [paragraph(textRun("Version B body"))] } as never });
    const subjectA = await deps.subjectVariantRepository.create({ sequenceStepId: step.id, subjectText: "Subject A", weight: 1 });
    const subjectB = await deps.subjectVariantRepository.create({ sequenceStepId: step.id, subjectText: "Subject B", weight: 1 });

    // Weight 0 on group B makes selection deterministic (selectWeightedVariant's own contract:
    // zero/negative weight is never chosen while any positive-weight option exists).
    await deps.contentGroupRepository.create({
      sequenceStepId: step.id,
      templateId: templateA.id,
      subjectVariantId: subjectA.id,
      document: templateA.document,
      subjectText: "Subject A",
      weight: 1
    });
    await deps.contentGroupRepository.create({
      sequenceStepId: step.id,
      templateId: templateB.id,
      subjectVariantId: subjectB.id,
      document: templateB.document,
      subjectText: "Subject B",
      weight: 0
    });

    const campaign = await deps.campaignRepository.create({
      name: "Content-group campaign",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "group-lead@example.com", firstName: "Grace", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: step.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(result.outcome).toBe("enqueued");
    if (result.outcome !== "enqueued") return;

    const queueRow = db.select().from(sendQueue).where(eq(sendQueue.id, result.sendQueueEntryId)).get();
    const message = db.select().from(messages).where(eq(messages.id, queueRow!.messageId)).get();
    expect(message?.subject).toBe("Subject A");
    expect(message?.bodyText).toContain("Version A body");
    // The message's recorded templateId is group A's own real template -- not the step's
    // placeholder -- so per-template analytics attribute to the content that actually went out.
    expect(message?.templateId).toBe(templateA.id);
    expect(message?.subjectVariantId).toBe(subjectA.id);
  });

  it("completes the enrollment once the final step is fired, and auto-completes the campaign once every enrollment is terminal", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    await deps.campaignRepository.setStatus(campaign.id, "running");
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

    // The enrollment's own state machine already reads "completed" the instant its last message is
    // enqueued, but the actual send hasn't happened yet (it's sitting in send_queue as 'pending') --
    // the campaign itself must stay 'running' until that email has actually left the queue,
    // otherwise Pause/Resume disappear from a campaign that still has a real send in flight.
    const stillRunning = await deps.campaignRepository.findById(campaign.id);
    expect(stillRunning?.status).toBe("running");

    // Once the Send worker actually resolves that last queued send, the campaign completes.
    await deps.sendQueueRepository.markSent(result.sendQueueEntryId);
    await maybeCompleteCampaign(deps, campaign.id);
    const reloadedCampaign = await deps.campaignRepository.findById(campaign.id);
    expect(reloadedCampaign?.status).toBe("completed");
  });

  it("does not auto-complete the campaign while another enrollment is still active", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    await deps.campaignRepository.setStatus(campaign.id, "running");

    const finishing = await deps.contactRepository.upsertByEmail({ email: "finishing@example.com", source: "manual" });
    const finishingEnrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: finishing.id,
      currentStepId: sequence.steps[1]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    // A second contact still mid-sequence, not yet due -- must keep the campaign 'running'.
    const stillActive = await deps.contactRepository.upsertByEmail({ email: "still-active@example.com", source: "manual" });
    await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: stillActive.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() + 60_000)
    });

    const result = await fireEnrollmentStep(deps, finishingEnrollment, new Date());
    expect(result.outcome).toBe("enqueued");
    if (result.outcome !== "enqueued") return;
    expect(result.enrollmentStatus).toBe("completed");

    const reloadedCampaign = await deps.campaignRepository.findById(campaign.id);
    expect(reloadedCampaign?.status).toBe("running");
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

  it("threads a follow-up step as a reply to the first email instead of sending it as a new, unrelated message", async () => {
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "followup@example.com", firstName: "Dee", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const firstResult = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(firstResult.outcome).toBe("enqueued");
    if (firstResult.outcome !== "enqueued") return;

    const firstMessage = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).get();
    expect(firstMessage?.subject).toBe("Step 1 subject");
    expect(firstMessage?.inReplyToHeader).toBeNull();
    expect(firstMessage?.referencesHeader).toBeNull();

    // The Send worker (not exercised by this test) is what actually dispatches step 1 and marks
    // it sent -- doing that here mirrors real dispatch completing before step 2 becomes due.
    await deps.conversationRepository.markMessageSent(firstMessage!.id, { sentAt: new Date() });

    // Re-fetch: fireEnrollmentStep already advanced this enrollment onto step 2 as a side effect
    // of the first call above (Section 14.3's "on successful queuing, next_send_at advances").
    const advanced = await deps.enrollmentRepository.findById(enrollment.id);
    const secondResult = await fireEnrollmentStep(deps, advanced!, new Date());
    expect(secondResult.outcome).toBe("enqueued");
    if (secondResult.outcome !== "enqueued") return;

    const allMessages = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).all();
    expect(allMessages).toHaveLength(2);
    const secondMessage = allMessages.find((m) => m.id !== firstMessage!.id)!;

    // The step's own configured subject ("Step 2 subject") must NOT be what actually goes out --
    // it continues the first email's subject as a reply instead, exactly like a human follow-up.
    expect(secondMessage.subject).toBe("Re: Step 1 subject");
    expect(secondMessage.inReplyToHeader).toBe(firstMessage!.messageIdHeader);
    expect(secondMessage.referencesHeader).toContain(firstMessage!.messageIdHeader);
    // Same thread -- this is what makes it show up as one continuous conversation, not two
    // separate, unrelated emails.
    expect(secondMessage.threadId).toBe(firstMessage!.threadId);

    // The wire-level MIME actually sent must carry the same headers, not just the DB bookkeeping.
    const secondDraft = await new SqliteDraftRepository(db).findById(secondMessage.draftId as never);
    expect(secondDraft?.inReplyTo).toBe(firstMessage!.messageIdHeader);
    expect(secondDraft?.references).toEqual([firstMessage!.messageIdHeader]);
  });

  it("defers a follow-up step (does not send, does not advance) when the prior step hasn't actually dispatched yet, then proceeds once it has", async () => {
    // Reproduces a real reported bug: a follow-up step's next_send_at is computed from when the
    // *previous* step was enqueued, not from when it actually sent -- with a short/zero delay
    // (exactly what's used for quick manual testing), the scheduler can call fireEnrollmentStep for
    // the follow-up before the Send worker has actually dispatched the message it's replying onto.
    // Firing anyway would bake in that message's still-provisional Message-ID (Gmail rewrites it on
    // real delivery) into the follow-up's In-Reply-To/References -- a follow-up that never actually
    // threads for the recipient, even though every Message-ID-correctness fix upstream is sound.
    const { campaign, sequence } = await setUpTwoStepCampaign();
    const contact = await deps.contactRepository.upsertByEmail({ email: "race@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const firstResult = await fireEnrollmentStep(deps, enrollment, new Date());
    expect(firstResult.outcome).toBe("enqueued");
    if (firstResult.outcome !== "enqueued") return;

    const firstMessage = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).get();
    expect(firstMessage?.status).toBe("queued"); // deliberately not yet marked sent

    // The scheduler calling this immediately (as a 0-delay step would let it) must defer, not send.
    const advanced = await deps.enrollmentRepository.findById(enrollment.id);
    const tooEarlyResult = await fireEnrollmentStep(deps, advanced!, new Date());
    expect(tooEarlyResult).toEqual({ outcome: "waiting_on_prior_send" });

    // Nothing was sent and the enrollment did not advance any further -- it's already at step 2
    // (advanced there when step 1 was enqueued, before this deferred attempt) and still due, so
    // the very next scheduler tick will just try this same step 2 fire again, not skip ahead or
    // get stuck.
    const allMessagesStillOne = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).all();
    expect(allMessagesStillOne).toHaveLength(1);
    const stillAtStep2 = await deps.enrollmentRepository.findById(enrollment.id);
    expect(stillAtStep2?.currentStepId).toBe(sequence.steps[1]!.id);
    expect(stillAtStep2?.status).toBe("active");

    // Once the Send worker actually dispatches step 1 (marking it sent), the exact same retry now
    // proceeds normally.
    await deps.conversationRepository.markMessageSent(firstMessage!.id, { sentAt: new Date() });
    const nowReadyResult = await fireEnrollmentStep(deps, stillAtStep2!, new Date());
    expect(nowReadyResult.outcome).toBe("enqueued");

    const allMessagesAfter = db.select().from(messages).where(eq(messages.campaignEnrollmentId, enrollment.id)).all();
    expect(allMessagesAfter).toHaveLength(2);
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
        displayName: "Ada Lovelace",
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
      contentGroupRepository: new SqliteContentGroupRepository(db),
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

  it("unsubscribeContact suppresses the contact, records an event, stops their active enrollments, and auto-completes a campaign left with no active enrollments", async () => {
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
    await deps.campaignRepository.setStatus(campaign.id, "running");
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

    // This was the campaign's only enrollment -- stopping it (Section 14.1) should have flipped
    // the campaign itself to 'completed', same as the natural end-of-sequence path.
    expect((await deps.campaignRepository.findById(campaign.id))?.status).toBe("completed");
  });

  it("deleteContact stops the contact's active enrollments (auto-completing the campaign) then soft-deletes it out of list()", async () => {
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
    await deps.campaignRepository.setStatus(campaign.id, "running");
    const contact = await deps.contactRepository.upsertByEmail({ email: "delete-me@example.com", source: "manual" });
    const enrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    await deleteContact(deps, contact.id);

    expect((await deps.enrollmentRepository.findById(enrollment.id))?.status).toBe("stopped_manual");
    expect((await deps.campaignRepository.findById(campaign.id))?.status).toBe("completed");
    expect(await deps.contactRepository.list()).toHaveLength(0);
    expect((await deps.contactRepository.findById(contact.id))?.deletedAt).toBeInstanceOf(Date);
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
