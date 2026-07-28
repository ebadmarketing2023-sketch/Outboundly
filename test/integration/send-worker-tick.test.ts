import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEnrollmentStep, type FireEnrollmentStepDeps } from "../../src/application/campaigns/fire-enrollment-step.js";
import { runSendWorkerTick, type SendWorkerDeps } from "../../src/application/campaigns/send-worker-tick.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountHealthRepository } from "../../src/adapters/persistence/repositories/account-health-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
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
import { SqliteProviderSelector } from "../../src/adapters/persistence/provider-selector.js";
import { SqliteRateLimiter } from "../../src/adapters/persistence/rate-limiter.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { accounts, messages, sendQueue } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import type { AccountRef, ChangeSet, MailProvider, NormalizedMessage, NormalizedThread, ProviderDraftRef, ProviderSendResult, SyncCursor } from "../../src/ports/mail-provider.port.js";
import { GMAIL_CAPABILITIES, type ProviderCapabilities } from "../../src/ports/provider-capabilities.port.js";

class FakeMailProvider implements MailProvider {
  createdDrafts: { account: AccountRef }[] = [];
  sentDrafts: ProviderDraftRef[] = [];
  appended: Buffer[] = [];
  constructor(
    private readonly failCreateDraft = false,
    /** Simulates a real nodemailer SMTP rejection (responseCode attached to the thrown error). */
    private readonly smtpResponseCode?: number
  ) {}

  async authenticate(): Promise<void> {}
  async sendMessage(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async createDraft(account: AccountRef): Promise<ProviderDraftRef> {
    if (this.smtpResponseCode !== undefined) {
      const err = new Error(`${this.smtpResponseCode} SMTP rejection (simulated)`);
      (err as Error & { responseCode: number }).responseCode = this.smtpResponseCode;
      throw err;
    }
    if (this.failCreateDraft) throw new Error("provider unavailable");
    this.createdDrafts.push({ account });
    return { providerDraftId: "fake-draft-1" };
  }
  async sendDraft(_account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult> {
    this.sentDrafts.push(draftRef);
    return { providerMessageId: "fake-message-1", providerThreadId: "fake-thread-1" };
  }
  async listChangesSince(): Promise<ChangeSet> {
    return { cursor: "", newOrChangedMessageRefs: [] };
  }
  async fetchMessage(): Promise<NormalizedMessage> {
    throw new Error("not used by this test");
  }
  async fetchThread(): Promise<NormalizedThread> {
    return { providerThreadId: "t", messageRefs: [] };
  }
  async appendToSentFolder(_account: AccountRef, rawMessage: Buffer): Promise<void> {
    this.appended.push(rawMessage);
  }
  capabilities(): ProviderCapabilities {
    return GMAIL_CAPABILITIES;
  }
}

describe("runSendWorkerTick (Section 21.1)", () => {
  let db: OutboundlyDb;
  let fireStepDeps: FireEnrollmentStepDeps;
  let sendWorkerDeps: SendWorkerDeps;
  let provider: FakeMailProvider;
  let accountId: string;
  let businessHoursProfileId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-send-worker-tick-test-"));
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

    const conversationRepository = new SqliteConversationRepository(db);
    const enrollmentRepository = new SqliteEnrollmentRepository(db);
    const campaignRepository = new SqliteCampaignRepository(db);
    const sequenceRepository = new SqliteSequenceRepository(db);
    const contactRepository = new SqliteContactRepository(db);
    const draftRepository = new SqliteDraftRepository(db);
    const draftLifecycle = new DraftLifecycleService(draftRepository, new SystemClock());
    const sendQueueRepository = new SqliteSendQueueRepository(db);

    fireStepDeps = {
      db,
      businessHoursProfileRepository,
      warmupProfileRepository: new SqliteWarmupProfileRepository(db),
      delayPolicyConfigRepository: new SqliteDelayPolicyConfigRepository(db),
      campaignRepository,
      sequenceRepository,
      templateRepository: new SqliteTemplateRepository(db),
      templateVariantRepository: new SqliteTemplateVariantRepository(db),
      subjectVariantRepository: new SqliteSubjectVariantRepository(db),
      contactRepository,
      suppressionListRepository: new SqliteSuppressionListRepository(db),
      enrollmentRepository,
      sendQueueRepository,
      deliverabilityReportRepository: new SqliteDeliverabilityReportRepository(db),
      conversationRepository,
      draftLifecycle
    };

    provider = new FakeMailProvider();
    sendWorkerDeps = {
      db,
      sendQueueRepository,
      rateLimiter: new SqliteRateLimiter(db),
      providerSelector: new SqliteProviderSelector(db, new SqliteAccountHealthRepository(db), new SqliteRateLimiter(db)),
      conversationRepository,
      enrollmentRepository,
      campaignRepository,
      sequenceRepository,
      contactRepository,
      draftRepository,
      draftLifecycle,
      eventRepository: new SqliteEventRepository(db),
      getProviderForAccount: async () => provider
    };
  });

  async function enqueueOneCampaignMessage() {
    const template = await fireStepDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi there"))] } });
    // Two steps, not one: firing the first step must leave the enrollment "active" (a follow-up
    // is still pending), which is what actually matters for the bounce tests below -- a bounce on
    // a single-step sequence's only message has nothing left to stop, since queuing the last step
    // already completes the enrollment (Section 14.3) before the Send worker ever dispatches it.
    const sequence = await fireStepDeps.sequenceRepository.create({
      name: "Seq",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });
    await fireStepDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Subject", weight: 1 });
    await fireStepDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[1]!.id, subjectText: "Follow-up subject", weight: 1 });
    const campaign = await fireStepDeps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await fireStepDeps.contactRepository.upsertByEmail({ email: "lead@example.com", firstName: "Ada", source: "manual" });
    const enrollment = await fireStepDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const fireResult = await fireEnrollmentStep(fireStepDeps, enrollment, new Date());
    if (fireResult.outcome !== "enqueued") throw new Error(`setup failed: ${fireResult.outcome}`);
    return { ...fireResult, enrollmentId: enrollment.id, contactId: contact.id, campaignId: campaign.id };
  }

  it("dispatches a claimed message end-to-end: provider calls happen, message and queue row are marked sent", async () => {
    const fireResult = await enqueueOneCampaignMessage();

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0, bounced: 0, failures: [] });
    expect(provider.createdDrafts).toHaveLength(1);
    expect(provider.sentDrafts).toEqual([{ providerDraftId: "fake-draft-1" }]);
    expect(provider.appended).toHaveLength(1);

    const queueRow = db.select().from(sendQueue).where(eq(sendQueue.id, fireResult.sendQueueEntryId)).get();
    expect(queueRow?.status).toBe("sent");

    const messageRow = db.select().from(messages).all().find((m) => m.campaignEnrollmentId);
    expect(messageRow?.status).toBe("sent");
    expect(messageRow?.providerMessageId).toBe("fake-message-1");

    const recordedEvents = await sendWorkerDeps.eventRepository.findByCampaignInWindow(
      fireResult.campaignId,
      new Date(0),
      new Date(Date.now() + 60_000)
    );
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]?.eventType).toBe("sent");
    expect(recordedEvents[0]?.metadata).toMatchObject({ templateId: expect.any(String), subjectVariantId: expect.any(String) });
  });

  it("releases the row back to pending (not a failure) when the account is over its rate limit", async () => {
    await enqueueOneCampaignMessage();
    // Simulate the account becoming rate-limited between scheduling and dispatch (Section 15.4's
    // "propose early, confirm late" -- the authoritative check happens now, not at enqueue time).
    await db.update(accounts).set({ dailySendLimit: 0 }).where(eq(accounts.id, accountId)).run();

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(result).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0, bounced: 0, failures: [] });

    const row = db.select().from(sendQueue).all()[0];
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(0); // not counted as a failed attempt
  });

  it("retries with backoff (transient failure) when the provider throws during dispatch", async () => {
    provider = new FakeMailProvider(true);
    sendWorkerDeps.getProviderForAccount = async () => provider;
    await enqueueOneCampaignMessage();

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.error).toMatch(/provider unavailable/);

    const row = db.select().from(sendQueue).all()[0];
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(1);
  });

  it("treats a permanent (5xx) SMTP rejection as a bounce: fails the row terminally and stops the enrollment", async () => {
    provider = new FakeMailProvider(false, 550);
    sendWorkerDeps.getProviderForAccount = async () => provider;
    const { enrollmentId, campaignId } = await enqueueOneCampaignMessage();

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(result).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 0, bounced: 1, failures: [] });

    const row = db.select().from(sendQueue).all()[0];
    expect(row?.status).toBe("failed"); // terminal -- no point retrying the same rejected recipient
    expect(row?.attemptCount).toBe(0); // markFailed(permanent:true) doesn't touch attemptCount

    const enrollment = await fireStepDeps.enrollmentRepository.findById(enrollmentId);
    expect(enrollment?.status).toBe("stopped_bounce");

    const recordedEvents = await sendWorkerDeps.eventRepository.findByCampaignInWindow(campaignId, new Date(0), new Date(Date.now() + 60_000));
    expect(recordedEvents.map((e) => e.eventType)).toEqual(["bounced"]);
  });

  it("does not treat a transient (4xx) SMTP error as a bounce -- it retries normally instead", async () => {
    provider = new FakeMailProvider(false, 421);
    sendWorkerDeps.getProviderForAccount = async () => provider;
    const { enrollmentId } = await enqueueOneCampaignMessage();

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(result).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 1,
      bounced: 0,
      failures: [{ sendQueueEntryId: expect.any(String), error: expect.stringContaining("421 SMTP rejection") }]
    });

    const row = db.select().from(sendQueue).all()[0];
    expect(row?.status).toBe("pending"); // transient -- backoff and retry, not terminal
    expect(row?.attemptCount).toBe(1);

    const enrollment = await fireStepDeps.enrollmentRepository.findById(enrollmentId);
    expect(enrollment?.status).toBe("active"); // not stopped -- this wasn't classified as a bounce
  });

  it("returns all-zero counts when the queue is empty", async () => {
    const result = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(result).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0, bounced: 0, failures: [] });
  });
});
