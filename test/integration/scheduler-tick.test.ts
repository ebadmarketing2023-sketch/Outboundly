import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runSchedulerTick } from "../../src/application/campaigns/scheduler-tick.js";
import type { FireEnrollmentStepDeps } from "../../src/application/campaigns/fire-enrollment-step.js";
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
import { SqliteErrorLogRepository } from "../../src/adapters/persistence/repositories/error-log-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteSubjectVariantRepository } from "../../src/adapters/persistence/repositories/subject-variant-repository.js";
import { SqliteContentGroupRepository } from "../../src/adapters/persistence/repositories/content-group-repository.js";
import { SqliteSuppressionListRepository } from "../../src/adapters/persistence/repositories/suppression-list-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { SqliteTemplateVariantRepository } from "../../src/adapters/persistence/repositories/template-variant-repository.js";
import { SqliteWarmupProfileRepository } from "../../src/adapters/persistence/repositories/warmup-profile-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("runSchedulerTick (Section 21.1)", () => {
  let db: OutboundlyDb;
  let deps: FireEnrollmentStepDeps;
  let accountId: string;
  let businessHoursProfileId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-scheduler-tick-test-"));
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
      windows: { monday: [{ start: "00:00", end: "23:59" }], tuesday: [{ start: "00:00", end: "23:59" }] }
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
      draftLifecycle: new DraftLifecycleService(new SqliteDraftRepository(db), new SystemClock()),
      errorLogRepository: new SqliteErrorLogRepository(db)
    };
  });

  it("processes every due enrollment and tallies outcomes, isolating one enrollment's failure from the rest", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Subject", weight: 1 });
    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    // findDueForScheduling only considers enrollments whose parent campaign is 'running' (Section
    // 14.2) -- a freshly created campaign defaults to 'draft', which must never fire on its own.
    await deps.campaignRepository.setStatus(campaign.id, "running");

    const goodContact = await deps.contactRepository.upsertByEmail({ email: "good@example.com", source: "manual" });
    const goodEnrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: goodContact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    // A broken enrollment whose currentStepId belongs to a different sequence than its campaign's
    // own -- a real, FK-satisfying row, but one fireEnrollmentStep can't find in its sequence's
    // own steps. This must not stop the good enrollment above from being processed (Section 21.3).
    const otherTemplate = await deps.templateRepository.create({ name: "Other", document: { blocks: [] } });
    const otherSequence = await deps.sequenceRepository.create({
      name: "Other seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: otherTemplate.id }]
    });
    const brokenContact = await deps.contactRepository.upsertByEmail({ email: "broken@example.com", source: "manual" });
    const brokenEnrollment = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: brokenContact.id,
      currentStepId: otherSequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await runSchedulerTick(deps, new Date());

    expect(result.processed).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(result.completed).toBe(1); // single-step sequence completes on its only step
    expect(result.failures).toEqual([
      { enrollmentId: brokenEnrollment.id, error: expect.stringContaining("is not part of its sequence") }
    ]);

    const reloadedGood = await deps.enrollmentRepository.findById(goodEnrollment.id);
    expect(reloadedGood?.status).toBe("completed");

    const logged = await deps.errorLogRepository!.listRecent(10, "scheduler");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ errorType: "enrollment_step_failed", campaignId: campaign.id });
    expect(logged[0]?.errorMessage).toMatch(/is not part of its sequence/);
  });

  it("never fires a still-draft campaign's due enrollments, and Pause/Resume actually gate scheduling (Section 14.2)", async () => {
    const template = await deps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    await deps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Subject", weight: 1 });
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
      nextSendAt: new Date(Date.now() - 60_000)
    });

    // A brand-new campaign defaults to 'draft' -- never clicked "Start" -- so its due enrollment
    // must not fire even though the enrollment itself is 'active' and past due.
    const draftResult = await runSchedulerTick(deps, new Date());
    expect(draftResult.processed).toBe(0);
    expect((await deps.enrollmentRepository.findById(enrollment.id))?.status).toBe("active");

    // Starting the campaign is what makes it eligible.
    await deps.campaignRepository.setStatus(campaign.id, "running");
    const runningResult = await runSchedulerTick(deps, new Date());
    expect(runningResult.processed).toBe(1);
    expect(runningResult.completed).toBe(1); // single-step sequence completes on its only step

    // Re-enroll (the first enrollment already completed) and pause the campaign -- the new due
    // enrollment must not fire while paused, which is the concrete behavior "Pause" promises.
    const contact2 = await deps.contactRepository.upsertByEmail({ email: "lead2@example.com", source: "manual" });
    const enrollment2 = await deps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact2.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });
    await deps.campaignRepository.setStatus(campaign.id, "paused");
    const pausedResult = await runSchedulerTick(deps, new Date());
    expect(pausedResult.processed).toBe(0);
    expect((await deps.enrollmentRepository.findById(enrollment2.id))?.status).toBe("active");

    // Resuming (back to 'running') makes it fire again.
    await deps.campaignRepository.setStatus(campaign.id, "running");
    const resumedResult = await runSchedulerTick(deps, new Date());
    expect(resumedResult.processed).toBe(1);
    expect(resumedResult.completed).toBe(1);
  });

  it("returns all-zero counts when nothing is due", async () => {
    const result = await runSchedulerTick(deps, new Date());
    expect(result).toEqual({
      processed: 0,
      enqueued: 0,
      completed: 0,
      blocked: 0,
      noEligibleAccount: 0,
      suppressed: 0,
      missingPersonalization: 0,
      waitingOnPriorSend: 0,
      failures: []
    });
  });
});
