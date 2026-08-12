import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
import { accounts, sendQueue } from "../../src/adapters/persistence/schema.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import { GMAIL_CAPABILITIES } from "../../src/ports/provider-capabilities.port.js";
import type { AccountRef, MailProvider, ProviderDraftRef, ProviderSendResult } from "../../src/ports/mail-provider.port.js";
import type { BuiltMimeMessage } from "../../src/core/mime/types.js";

class FakeProvider implements MailProvider {
  sentFrom: string[] = [];
  private pending?: string;
  async authenticate(): Promise<void> {}
  async sendMessage(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async createDraft(account: AccountRef, _m: BuiltMimeMessage): Promise<ProviderDraftRef> {
    this.pending = account.emailAddress;
    return { providerDraftId: `d${this.sentFrom.length + 1}` };
  }
  async sendDraft(): Promise<ProviderSendResult> {
    this.sentFrom.push(this.pending!);
    return { providerMessageId: `m${this.sentFrom.length}`, providerThreadId: `t${this.sentFrom.length}` };
  }
  async listChangesSince() {
    return { cursor: "", newOrChangedMessageRefs: [] };
  }
  async fetchMessage(): Promise<never> {
    throw new Error("unused");
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
 * Scheduling audit. Every case here runs the real Scheduler and the real Send worker against a real
 * database, with the per-account pacing a connected account actually gets by default -- the
 * dimension the multi-account suite deliberately left out, and the one a "the timer keeps resetting
 * and nothing sends" report points straight at.
 */
describe("scheduling, end to end", () => {
  let db: OutboundlyDb;
  let fireDeps: FireEnrollmentStepDeps;
  let sendDeps: SendWorkerDeps;
  let provider: FakeProvider;
  let accountIds: string[];
  let businessHoursProfileId: string;

  async function setUp(accountCount: number, opts: { minDelaySeconds?: number; maxDelaySeconds?: number; dailyLimit?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-sched-audit-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    const now = new Date();
    accountIds = [];
    for (let i = 0; i < accountCount; i++) {
      const id = generateId();
      accountIds.push(id);
      db.insert(accounts)
        .values({
          id,
          provider: "google",
          emailAddress: `acct${i}@outboundly.app`,
          displayName: `Acct ${i}`,
          status: "connected",
          dailySendLimit: opts.dailyLimit ?? 40,
          hourlySendLimit: null,
          minSendDelaySeconds: opts.minDelaySeconds ?? null,
          maxSendDelaySeconds: opts.maxDelaySeconds ?? null,
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
  }

  async function launch(leadCount: number) {
    const template = await fireDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await fireDeps.sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    await fireDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "S", weight: 1 });
    const campaign = await fireDeps.campaignRepository.create({
      name: "C",
      sequenceId: sequence.id,
      sendingAccountIds: accountIds.map(asAccountId),
      businessHoursProfileId
    });
    await fireDeps.campaignRepository.setStatus(campaign.id, "running");
    for (let i = 0; i < leadCount; i++) {
      const contact = await fireDeps.contactRepository.upsertByEmail({ email: `lead${i}@example.com`, source: "manual" });
      const enrollment = await fireDeps.enrollmentRepository.enroll({
        campaignId: campaign.id,
        contactId: contact.id,
        currentStepId: sequence.steps[0]!.id,
        nextSendAt: new Date(Date.now() - 60_000)
      });
      const outcome = await fireEnrollmentStep(fireDeps, enrollment, new Date());
      if (outcome.outcome !== "enqueued") throw new Error(`setup: ${outcome.outcome}`);
    }
    return campaign;
  }

  function pendingDueTimes(): number[] {
    return db
      .select()
      .from(sendQueue)
      .all()
      .filter((r) => r.status === "pending")
      .map((r) => r.earliestSendAt.getTime());
  }

  it("does not push a queued email further away every time it is examined", async () => {
    // The reported symptom: "the timer just keeps getting reset and doesn't send". A deferral must
    // be anchored to the real condition that caused it, never recomputed as now+X each time the
    // worker looks -- otherwise a row is pushed out of reach forever and nothing ever sends.
    await setUp(2, { minDelaySeconds: 300, maxDelaySeconds: 300 });
    await launch(4);

    await runSendWorkerTick(sendDeps, new Date()); // sends what it can, defers the rest
    const firstPass = pendingDueTimes().sort();
    expect(firstPass.length).toBeGreaterThan(0);

    // Look again, repeatedly, without time having meaningfully moved.
    for (let i = 0; i < 5; i++) await runSendWorkerTick(sendDeps, new Date());
    const afterPass = pendingDueTimes().sort();

    expect(afterPass).toEqual(firstPass);
  });

  it("eventually sends every lead once pacing elapses, rather than stalling", async () => {
    await setUp(2, { minDelaySeconds: 60, maxDelaySeconds: 60 });
    await launch(6);

    // Step a simulated clock forward, one pacing window at a time. Nothing is reached into here
    // beyond advancing time: pacing, limits and queue timestamps all resolve on their own.
    let clock = Date.now();
    for (let i = 0; i < 30 && provider.sentFrom.length < 6; i++) {
      await runSendWorkerTick(sendDeps, new Date(clock));
      clock += 61_000;
    }

    expect(provider.sentFrom).toHaveLength(6);
    expect(new Set(provider.sentFrom).size).toBe(2); // both accounts were used
  });

  it("paces sends from a single account instead of firing them back to back", async () => {
    await setUp(1, { minDelaySeconds: 120, maxDelaySeconds: 120 });
    await launch(3);

    await runSendWorkerTick(sendDeps, new Date());

    // Exactly one goes now; the others wait for this account's own window.
    expect(provider.sentFrom).toHaveLength(1);
    const account = db.select().from(accounts).where(eq(accounts.id, accountIds[0]!)).get();
    expect(account?.nextAllowedSendAt).toBeDefined();
    expect(account!.nextAllowedSendAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("INVARIANT: after any tick, no pending row is left due in the past", async () => {
    // If a deferral lands on (or before) now, the row goes straight back into the same tick's claim
    // loop -- re-claimed, re-deferred, burning the per-tick budget on one row while its due time
    // visibly jitters. The rolling windows make that reachable: a daily denial's retryAfter is
    // oldestSentAt + 24h, which lands on roughly *now* just as the oldest send ages out.
    for (const scenario of ["capped", "paced", "disconnected", "paused"] as const) {
      await setUp(2, { minDelaySeconds: 120, maxDelaySeconds: 120, dailyLimit: 2 });
      const campaign = await launch(5);

      if (scenario === "capped") {
        for (let i = 0; i < 6; i++) await runSendWorkerTick(sendDeps, new Date());
      } else if (scenario === "disconnected") {
        db.update(accounts).set({ status: "disconnected" }).run();
      } else if (scenario === "paused") {
        await fireDeps.campaignRepository.setStatus(campaign.id, "paused");
      }

      const tickAt = new Date();
      await runSendWorkerTick(sendDeps, tickAt);

      const stillDueInThePast = db
        .select()
        .from(sendQueue)
        .all()
        .filter((r) => r.status === "pending" && r.earliestSendAt.getTime() <= tickAt.getTime());
      expect({ scenario, stuck: stillDueInThePast.length }).toEqual({ scenario, stuck: 0 });
    }
  });

  it("INVARIANT: a tick never churns the same row over and over", async () => {
    // A row released into the past would be claimed repeatedly inside one tick. Claims per tick
    // must stay bounded by the number of rows that actually exist.
    await setUp(2, { minDelaySeconds: 600, maxDelaySeconds: 600, dailyLimit: 1 });
    await launch(3);

    const result = await runSendWorkerTick(sendDeps, new Date());

    expect(result.claimed).toBeLessThanOrEqual(3);
  });

  it("holds at the daily limit and does not drift the wait time on every look", async () => {
    await setUp(1, { dailyLimit: 2 });
    await launch(4);

    for (let i = 0; i < 3; i++) await runSendWorkerTick(sendDeps, new Date());
    const afterCap = pendingDueTimes().sort();
    expect(provider.sentFrom).toHaveLength(2);

    for (let i = 0; i < 3; i++) await runSendWorkerTick(sendDeps, new Date());
    expect(pendingDueTimes().sort()).toEqual(afterCap);
  });
});
