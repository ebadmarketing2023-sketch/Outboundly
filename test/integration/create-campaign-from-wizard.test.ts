import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCampaignFromWizard,
  type CreateCampaignFromWizardDeps
} from "../../src/application/campaigns/create-campaign-from-wizard.js";
import { fireEnrollmentStep, type FireEnrollmentStepDeps } from "../../src/application/campaigns/fire-enrollment-step.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteContentGroupRepository } from "../../src/adapters/persistence/repositories/content-group-repository.js";
import { SqliteConversationRepository } from "../../src/adapters/persistence/repositories/conversation-repository.js";
import { SqliteDelayPolicyConfigRepository } from "../../src/adapters/persistence/repositories/delay-policy-config-repository.js";
import { SqliteDeliverabilityReportRepository } from "../../src/adapters/persistence/repositories/deliverability-report-repository.js";
import { SqliteDraftRepository } from "../../src/adapters/persistence/repositories/draft-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
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

const DOC = (text: string) => ({ blocks: [paragraph(textRun(text))] }) as never;

describe("createCampaignFromWizard (Section 5.6 campaign-creation wizard)", () => {
  let db: OutboundlyDb;
  let deps: CreateCampaignFromWizardDeps;
  let fireDeps: FireEnrollmentStepDeps;
  let accountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-wizard-test-"));
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

    const templateRepository = new SqliteTemplateRepository(db);
    const subjectVariantRepository = new SqliteSubjectVariantRepository(db);
    const contentGroupRepository = new SqliteContentGroupRepository(db);
    const sequenceRepository = new SqliteSequenceRepository(db);
    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    const campaignRepository = new SqliteCampaignRepository(db);

    deps = { templateRepository, subjectVariantRepository, contentGroupRepository, sequenceRepository, businessHoursProfileRepository, campaignRepository };

    fireDeps = {
      db,
      businessHoursProfileRepository,
      warmupProfileRepository: new SqliteWarmupProfileRepository(db),
      delayPolicyConfigRepository: new SqliteDelayPolicyConfigRepository(db),
      campaignRepository,
      sequenceRepository,
      templateRepository,
      templateVariantRepository: new SqliteTemplateVariantRepository(db),
      subjectVariantRepository,
      contentGroupRepository,
      contactRepository: new SqliteContactRepository(db),
      suppressionListRepository: new SqliteSuppressionListRepository(db),
      enrollmentRepository: new SqliteEnrollmentRepository(db),
      sendQueueRepository: new SqliteSendQueueRepository(db),
      deliverabilityReportRepository: new SqliteDeliverabilityReportRepository(db),
      conversationRepository: new SqliteConversationRepository(db),
      draftLifecycle: new DraftLifecycleService(new SqliteDraftRepository(db), new SystemClock())
    };
  });

  it("rejects a request with no content groups", async () => {
    await expect(
      createCampaignFromWizard(deps, {
        name: "Empty",
        sendingAccountIds: [asAccountId(accountId)],
        timezone: "UTC",
        days: ["monday"],
        start: "09:00",
        end: "17:00",
        contentGroups: [],
        followUpSteps: []
      })
    ).rejects.toThrow(/at least one/i);
  });

  it("creates a business-hours profile, sequence, content groups, and campaign that fires end-to-end without breaking the pre-existing schema", async () => {
    const campaign = await createCampaignFromWizard(deps, {
      name: "Q3 outbound",
      sendingAccountIds: [asAccountId(accountId)],
      timezone: "UTC",
      days: ["monday", "tuesday"],
      start: "09:00",
      end: "17:00",
      contentGroups: [
        { subjectText: "Version A subject", document: DOC("Version A body"), weight: 100 },
        { subjectText: "Version B subject", document: DOC("Version B body"), weight: 0 }
      ],
      followUpSteps: [{ document: DOC("Follow-up body"), delayDays: 3, delayHours: 0 }]
    });

    expect(campaign.status).toBe("draft");
    expect(campaign.sendingAccountIds).toEqual([accountId]);

    const businessHoursProfile = await deps.businessHoursProfileRepository.findById(campaign.businessHoursProfileId);
    expect(businessHoursProfile?.timezone).toBe("UTC");
    expect(Object.keys(businessHoursProfile?.windows ?? {})).toEqual(["monday", "tuesday"]);

    const sequence = await deps.sequenceRepository.findById(campaign.sequenceId);
    expect(sequence?.steps).toHaveLength(2);
    expect(sequence?.steps[1]!.delayDays).toBe(3);

    const contactRepository = fireDeps.contactRepository;
    const contact = await contactRepository.upsertByEmail({ email: "lead@example.com", firstName: "Grace", source: "manual" });
    const enrollment = await fireDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence!.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(fireDeps, enrollment, new Date());
    expect(result.outcome).toBe("enqueued");
    if (result.outcome !== "enqueued") return;

    const queueRow = db.select().from(sendQueue).where(eq(sendQueue.id, result.sendQueueEntryId)).get();
    const message = db.select().from(messages).where(eq(messages.id, queueRow!.messageId)).get();
    // Weight 0 on group B makes selection deterministic -- group A's own subject+body must be
    // used together, never mixed with group B's.
    expect(message?.subject).toBe("Version A subject");
    expect(message?.bodyText).toContain("Version A body");
  });

  it("fires correctly with only a single template/subject group and no follow-ups", async () => {
    const campaign = await createCampaignFromWizard(deps, {
      name: "Single group",
      sendingAccountIds: [asAccountId(accountId)],
      timezone: "UTC",
      days: ["monday"],
      start: "09:00",
      end: "17:00",
      contentGroups: [{ subjectText: "Only subject", document: DOC("Only body"), weight: 100 }],
      followUpSteps: []
    });

    const sequence = await deps.sequenceRepository.findById(campaign.sequenceId);
    expect(sequence?.steps).toHaveLength(1);

    const contact = await fireDeps.contactRepository.upsertByEmail({ email: "solo@example.com", firstName: "Ada", source: "manual" });
    const enrollment = await fireDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence!.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const result = await fireEnrollmentStep(fireDeps, enrollment, new Date());
    expect(result.outcome).toBe("enqueued");
  });

  it("rejects a request with no sending accounts", async () => {
    await expect(
      createCampaignFromWizard(deps, {
        name: "No accounts",
        sendingAccountIds: [],
        timezone: "UTC",
        days: ["monday"],
        start: "09:00",
        end: "17:00",
        contentGroups: [{ subjectText: "Subject", document: DOC("Body"), weight: 100 }],
        followUpSteps: []
      })
    ).rejects.toThrow(/at least one sending account/i);
  });

  it("creates a campaign with multiple sending accounts in its rotation pool", async () => {
    const secondAccountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id: secondAccountId,
        provider: "google",
        emailAddress: "second@outboundly.app",
        displayName: "Second Sender",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const campaign = await createCampaignFromWizard(deps, {
      name: "Two-account camp",
      sendingAccountIds: [asAccountId(accountId), asAccountId(secondAccountId)],
      timezone: "UTC",
      days: ["monday"],
      start: "09:00",
      end: "17:00",
      contentGroups: [{ subjectText: "Subject", document: DOC("Body"), weight: 100 }],
      followUpSteps: []
    });

    expect(campaign.sendingAccountIds.sort()).toEqual([accountId, secondAccountId].sort());
  });
});
