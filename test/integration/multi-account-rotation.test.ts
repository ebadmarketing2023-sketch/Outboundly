import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEnrollmentStep, type FireEnrollmentStepDeps } from "../../src/application/campaigns/fire-enrollment-step.js";
import { runSendWorkerTick, type SendWorkerDeps } from "../../src/application/campaigns/send-worker-tick.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountHealthRepository } from "../../src/adapters/persistence/repositories/account-health-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteContentGroupRepository } from "../../src/adapters/persistence/repositories/content-group-repository.js";
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
import { SqliteProviderSelector } from "../../src/adapters/persistence/provider-selector.js";
import { SqliteRateLimiter } from "../../src/adapters/persistence/rate-limiter.js";
import { accounts, messages, sendQueue } from "../../src/adapters/persistence/schema.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import { GMAIL_CAPABILITIES } from "../../src/ports/provider-capabilities.port.js";
import type { AccountRef, MailProvider, ProviderDraftRef, ProviderSendResult } from "../../src/ports/mail-provider.port.js";
import type { BuiltMimeMessage } from "../../src/core/mime/types.js";

class FakeProvider implements MailProvider {
  /** Which account each dispatched message actually went out from. */
  sentFrom: string[] = [];
  private pendingAccount?: string;

  async authenticate(): Promise<void> {}
  async sendMessage(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async createDraft(account: AccountRef, _message: BuiltMimeMessage): Promise<ProviderDraftRef> {
    this.pendingAccount = account.emailAddress;
    return { providerDraftId: `draft-${this.sentFrom.length + 1}` };
  }
  async sendDraft(): Promise<ProviderSendResult> {
    this.sentFrom.push(this.pendingAccount!);
    return { providerMessageId: `m-${this.sentFrom.length}`, providerThreadId: `t-${this.sentFrom.length}` };
  }
  async listChangesSince() {
    return { cursor: "", newOrChangedMessageRefs: [] };
  }
  async fetchMessage(): Promise<never> {
    throw new Error("not used");
  }
  async fetchThread() {
    return { providerThreadId: "t", messageRefs: [] };
  }
  async appendToSentFolder(): Promise<void> {}
  capabilities() {
    return GMAIL_CAPABILITIES;
  }
}

/**
 * Multi-account campaigns, against the exact shape of a real reported failure: two sending accounts
 * capped at 5/day, seven leads. One account sent its share and the rest of the queue was deferred a
 * full 24 hours while the second account sat completely idle -- which makes selecting more than one
 * account pointless.
 */
describe("a campaign with more than one sending account", () => {
  let db: OutboundlyDb;
  let fireDeps: FireEnrollmentStepDeps;
  let sendDeps: SendWorkerDeps;
  let provider: FakeProvider;
  let accountA: string;
  let accountB: string;
  let businessHoursProfileId: string;

  const DAILY_LIMIT = 5;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-multi-account-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    const now = new Date();
    accountA = generateId();
    accountB = generateId();
    for (const [id, email] of [
      [accountA, "first@outboundly.app"],
      [accountB, "second@outboundly.app"]
    ] as const) {
      db.insert(accounts)
        .values({
          id,
          provider: "google",
          emailAddress: email,
          displayName: email,
          status: "connected",
          dailySendLimit: DAILY_LIMIT,
          // No pacing: this suite is about which account is chosen, not about the gap between sends.
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .run();
    }

    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    const allDay = [{ start: "00:00", end: "23:59" }];
    businessHoursProfileId = (
      await businessHoursProfileRepository.create({
        name: "Always open",
        timezone: "UTC",
        windows: { sunday: allDay, monday: allDay, tuesday: allDay, wednesday: allDay, thursday: allDay, friday: allDay, saturday: allDay }
      })
    ).id;

    const conversationRepository = new SqliteConversationRepository(db);
    const enrollmentRepository = new SqliteEnrollmentRepository(db);
    const campaignRepository = new SqliteCampaignRepository(db);
    const sequenceRepository = new SqliteSequenceRepository(db);
    const contactRepository = new SqliteContactRepository(db);
    const draftRepository = new SqliteDraftRepository(db);
    const draftLifecycle = new DraftLifecycleService(draftRepository, new SystemClock());
    const sendQueueRepository = new SqliteSendQueueRepository(db);

    fireDeps = {
      db,
      businessHoursProfileRepository,
      warmupProfileRepository: new SqliteWarmupProfileRepository(db),
      delayPolicyConfigRepository: new SqliteDelayPolicyConfigRepository(db),
      campaignRepository,
      sequenceRepository,
      templateRepository: new SqliteTemplateRepository(db),
      templateVariantRepository: new SqliteTemplateVariantRepository(db),
      subjectVariantRepository: new SqliteSubjectVariantRepository(db),
      contentGroupRepository: new SqliteContentGroupRepository(db),
      contactRepository,
      suppressionListRepository: new SqliteSuppressionListRepository(db),
      enrollmentRepository,
      sendQueueRepository,
      deliverabilityReportRepository: new SqliteDeliverabilityReportRepository(db),
      conversationRepository,
      draftLifecycle
    };

    provider = new FakeProvider();
    sendDeps = {
      db,
      sendQueueRepository,
      rateLimiter: new SqliteRateLimiter(db),
      providerSelector: new SqliteProviderSelector(db, new SqliteAccountHealthRepository(db), new SqliteRateLimiter(db)),
      conversationRepository,
      enrollmentRepository,
      campaignRepository,
      businessHoursProfileRepository,
      sequenceRepository,
      contactRepository,
      draftRepository,
      draftLifecycle,
      eventRepository: new SqliteEventRepository(db),
      notificationRepository: new SqliteNotificationRepository(db),
      getProviderForAccount: async () => provider
    };
  });

  async function launchCampaignWithLeads(leadCount: number) {
    const template = await fireDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi there"))] } });
    const sequence = await fireDeps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    await fireDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Subject", weight: 1 });
    const campaign = await fireDeps.campaignRepository.create({
      name: "Multi-account campaign",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountA), asAccountId(accountB)],
      businessHoursProfileId
    });
    await fireDeps.campaignRepository.setStatus(campaign.id, "running");

    for (let i = 0; i < leadCount; i++) {
      const contact = await fireDeps.contactRepository.upsertByEmail({ email: `lead${i}@example.com`, firstName: `Lead${i}`, source: "manual" });
      const enrollment = await fireDeps.enrollmentRepository.enroll({
        campaignId: campaign.id,
        contactId: contact.id,
        currentStepId: sequence.steps[0]!.id,
        nextSendAt: new Date(Date.now() - 60_000)
      });
      const outcome = await fireEnrollmentStep(fireDeps, enrollment, new Date());
      if (outcome.outcome !== "enqueued") throw new Error(`setup failed: ${outcome.outcome}`);
    }
    return campaign;
  }

  /** Drains the queue the way the real worker does: repeated ticks, until nothing more moves. */
  async function drain(maxTicks = 12) {
    for (let i = 0; i < maxTicks; i++) {
      const result = await runSendWorkerTick(sendDeps, new Date());
      if (result.sent === 0) break;
    }
  }

  it("uses both accounts for seven leads rather than parking the overflow for 24 hours", async () => {
    // The reported failure exactly: 7 leads, two accounts capped at 5/day each. Between them they
    // can send all 7 today. What happened instead was 4-5 from one account and the rest deferred a
    // full day, with the second account never touched.
    await launchCampaignWithLeads(7);

    await drain();

    expect(provider.sentFrom).toHaveLength(7);
    const fromA = provider.sentFrom.filter((e) => e === "first@outboundly.app").length;
    const fromB = provider.sentFrom.filter((e) => e === "second@outboundly.app").length;
    expect(fromA).toBeLessThanOrEqual(DAILY_LIMIT);
    expect(fromB).toBeLessThanOrEqual(DAILY_LIMIT);
    expect(fromB).toBeGreaterThan(0);

    const stillQueued = db.select().from(sendQueue).all().filter((r) => r.status === "pending");
    expect(stillQueued).toHaveLength(0);
  });

  it("respects each account's own daily limit, so the pool's capacity is the sum and no more", async () => {
    // 12 leads against 2 accounts x 5/day: 10 go out today, 2 legitimately wait.
    await launchCampaignWithLeads(12);

    await drain(30);

    expect(provider.sentFrom).toHaveLength(DAILY_LIMIT * 2);
    expect(provider.sentFrom.filter((e) => e === "first@outboundly.app")).toHaveLength(DAILY_LIMIT);
    expect(provider.sentFrom.filter((e) => e === "second@outboundly.app")).toHaveLength(DAILY_LIMIT);

    const sentRows = db.select().from(messages).all().filter((m) => m.status === "sent");
    expect(sentRows).toHaveLength(DAILY_LIMIT * 2);
  });

  it("still sends everything from the one account when a campaign only has one", async () => {
    // Guards the single-account path this change must not disturb.
    const template = await fireDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await fireDeps.sequenceRepository.create({
      name: "Solo",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    await fireDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "S", weight: 1 });
    const campaign = await fireDeps.campaignRepository.create({
      name: "Solo campaign",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountA)],
      businessHoursProfileId
    });
    await fireDeps.campaignRepository.setStatus(campaign.id, "running");
    for (let i = 0; i < 3; i++) {
      const contact = await fireDeps.contactRepository.upsertByEmail({ email: `solo${i}@example.com`, source: "manual" });
      const enrollment = await fireDeps.enrollmentRepository.enroll({
        campaignId: campaign.id,
        contactId: contact.id,
        currentStepId: sequence.steps[0]!.id,
        nextSendAt: new Date(Date.now() - 60_000)
      });
      await fireEnrollmentStep(fireDeps, enrollment, new Date());
    }

    await drain();

    expect(provider.sentFrom).toEqual(["first@outboundly.app", "first@outboundly.app", "first@outboundly.app"]);
  });
});
