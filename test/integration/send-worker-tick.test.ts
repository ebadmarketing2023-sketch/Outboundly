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
import { SqliteNotificationRepository } from "../../src/adapters/persistence/repositories/notification-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteSubjectVariantRepository } from "../../src/adapters/persistence/repositories/subject-variant-repository.js";
import { SqliteContentGroupRepository } from "../../src/adapters/persistence/repositories/content-group-repository.js";
import { SqliteSuppressionListRepository } from "../../src/adapters/persistence/repositories/suppression-list-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { SqliteTemplateVariantRepository } from "../../src/adapters/persistence/repositories/template-variant-repository.js";
import { SqliteWarmupProfileRepository } from "../../src/adapters/persistence/repositories/warmup-profile-repository.js";
import { SqliteProviderSelector } from "../../src/adapters/persistence/provider-selector.js";
import { SqliteRateLimiter } from "../../src/adapters/persistence/rate-limiter.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { SqliteErrorLogRepository } from "../../src/adapters/persistence/repositories/error-log-repository.js";
import { accounts, messages, sendQueue, threads } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId, type CampaignId } from "../../src/core/shared-kernel/ids.js";
import type { AccountRef, ChangeSet, MailProvider, NormalizedMessage, NormalizedThread, ProviderDraftRef, ProviderSendResult, SyncCursor } from "../../src/ports/mail-provider.port.js";
import type { BuiltMimeMessage } from "../../src/core/mime/types.js";
import { GMAIL_CAPABILITIES, type ProviderCapabilities } from "../../src/ports/provider-capabilities.port.js";

class FakeMailProvider implements MailProvider {
  createdDrafts: { account: AccountRef; message: BuiltMimeMessage; providerThreadId?: string }[] = [];
  sentDrafts: ProviderDraftRef[] = [];
  appended: Buffer[] = [];
  private sendCount = 0;
  constructor(
    private readonly failCreateDraft = false,
    /** Simulates a real nodemailer SMTP rejection (responseCode attached to the thrown error). */
    private readonly smtpResponseCode?: number
  ) {}

  async authenticate(): Promise<void> {}
  async sendMessage(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async createDraft(account: AccountRef, message: BuiltMimeMessage, providerThreadId?: string): Promise<ProviderDraftRef> {
    if (this.smtpResponseCode !== undefined) {
      const err = new Error(`${this.smtpResponseCode} SMTP rejection (simulated)`);
      (err as Error & { responseCode: number }).responseCode = this.smtpResponseCode;
      throw err;
    }
    if (this.failCreateDraft) throw new Error("provider unavailable");
    this.createdDrafts.push({ account, message, providerThreadId });
    return { providerDraftId: `fake-draft-${this.createdDrafts.length}` };
  }
  async sendDraft(_account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult> {
    this.sentDrafts.push(draftRef);
    this.sendCount += 1;
    // A stable per-send provider thread id, always the same one for every send in this fake test
    // account (real Gmail would keep one thread id for the whole conversation too) -- distinct from
    // "fake-message-N" so the two id spaces are never confusable in an assertion.
    return {
      providerMessageId: `fake-message-${this.sendCount}`,
      providerThreadId: "fake-thread-1",
      // Simulates a real provider (Gmail/Microsoft Graph both verified for real) silently
      // rewriting the Message-ID header on actual delivery, discarding whatever this app's own
      // MIME builder put in the raw payload -- deliberately a *different* value than whatever
      // Message-ID this same send's `built` MIME message carried, so a test can prove the app
      // corrects for this rather than assuming its own generated value survived delivery.
      messageIdHeader: `<confirmed-delivered-${this.sendCount}@mail.fake-provider.example>`
    };
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
        displayName: "Ada Lovelace",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    // Genuinely every day, not just Monday/Tuesday: this suite calls runSendWorkerTick, whose
    // send_queue claim query filters on earliestSendAt <= now (Section 5.10) -- a business hours
    // window that excludes today's real weekday would push earliestSendAt into the future and
    // make every "claimed"/"sent"/"bounced" assertion below fail depending on what day the suite
    // happens to run on, which is exactly the bug this fixture used to have.
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
      contentGroupRepository: new SqliteContentGroupRepository(db),
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
      businessHoursProfileRepository,
      sequenceRepository,
      contactRepository,
      draftRepository,
      draftLifecycle,
      eventRepository: new SqliteEventRepository(db),
      notificationRepository: new SqliteNotificationRepository(db),
      errorLogRepository: new SqliteErrorLogRepository(db),
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
    // A real campaign only ever reaches send_queue via the Scheduler, whose findDueForScheduling
    // join requires campaigns.status='running' (Section 14.2) -- matching that invariant here so
    // this fixture doesn't rely on the Send worker dispatching for a still-'draft' campaign, which
    // can no longer happen after this suite's own "paused campaign" test below.
    await fireStepDeps.campaignRepository.setStatus(campaign.id, "running");
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

  /** Points an already-enqueued campaign at weekday-only 09:00-17:00 UTC hours. Used by the two
   * tests below, which cover the case the Scheduler's own snap cannot: a queue row whose send time
   * was moved *after* it was scheduled. */
  async function restrictToWeekdayBusinessHours(campaignId: CampaignId) {
    const weekdayWindow = [{ start: "09:00", end: "17:00" }];
    const profile = await fireStepDeps.businessHoursProfileRepository.create({
      name: "Weekdays 9-5 UTC",
      timezone: "UTC",
      windows: {
        monday: weekdayWindow,
        tuesday: weekdayWindow,
        wednesday: weekdayWindow,
        thursday: weekdayWindow,
        friday: weekdayWindow
      }
    });
    await fireStepDeps.campaignRepository.update(campaignId, { businessHoursProfileId: profile.id });
  }

  it("holds a queued campaign message that a retry pushed outside business hours, instead of sending it", async () => {
    // The gap this closes: the Scheduler snaps the original send into an allowed window, but every
    // path that moves the row afterwards is plain clock arithmetic -- the transient-failure backoff
    // (1 min doubling to 24h), the Rate Limiter's retryAfter, the paused-campaign hold, and
    // unclean-shutdown recovery. A send that failed at 16:55 came back at 17:55 and went out past
    // the cutoff; enough doublings and it goes out at 3am or on a Sunday. Simulated here by simply
    // running the tick at a time outside the window, which is exactly the state those retries leave
    // the row in.
    const fireResult = await enqueueOneCampaignMessage();
    await restrictToWeekdayBusinessHours(fireResult.campaignId);

    const sundayAt3am = new Date(Date.UTC(2030, 0, 6, 3, 0, 0)); // 2030-01-06 is a Sunday
    const result = await runSendWorkerTick(sendWorkerDeps, sundayAt3am);

    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 1, failed: 0, bounced: 0 });
    expect(provider.sentDrafts).toEqual([]);

    const queueRow = db.select().from(sendQueue).where(eq(sendQueue.id, fireResult.sendQueueEntryId)).get();
    expect(queueRow?.status).toBe("pending");
    // Held precisely until Monday's window opens -- not dropped, not retried in five minutes to be
    // rejected again, and with attemptCount untouched since nothing about the send itself failed.
    expect(queueRow?.earliestSendAt).toEqual(new Date(Date.UTC(2030, 0, 7, 9, 0, 0)));
    expect(queueRow?.attemptCount).toBe(0);
  });

  it("sends the same message once the window is open, so the hold is a delay and not a block", async () => {
    const fireResult = await enqueueOneCampaignMessage();
    await restrictToWeekdayBusinessHours(fireResult.campaignId);

    const mondayAt10am = new Date(Date.UTC(2030, 0, 7, 10, 0, 0));
    const result = await runSendWorkerTick(sendWorkerDeps, mondayAt10am);

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0 });
    expect(provider.sentDrafts).toHaveLength(1);
    expect(db.select().from(sendQueue).where(eq(sendQueue.id, fireResult.sendQueueEntryId)).get()?.status).toBe("sent");
  });

  it("stamps the campaign's own timezone offset on the dispatched Date header, not a uniform +0000", async () => {
    // A real mail client stamps the sender's configured zone. A mailbox whose every message claims
    // UTC while its sends cluster inside one region's working hours describes itself as automated.
    const fireResult = await enqueueOneCampaignMessage();
    const allDay = [{ start: "00:00", end: "23:59" }];
    const newYork = await fireStepDeps.businessHoursProfileRepository.create({
      name: "New York, always open",
      timezone: "America/New_York",
      windows: {
        sunday: allDay, monday: allDay, tuesday: allDay, wednesday: allDay, thursday: allDay, friday: allDay, saturday: allDay
      }
    });
    await fireStepDeps.campaignRepository.update(fireResult.campaignId, { businessHoursProfileId: newYork.id });

    await runSendWorkerTick(sendWorkerDeps, new Date());

    const dateHeader = provider.createdDrafts[0]!.message.headers.find((h) => h.name === "Date")?.value;
    // -0500 or -0400 depending on whether the suite runs in EST or EDT -- asserting the real
    // offset rather than recomputing it here, which would just restate the implementation.
    expect(dateHeader).toMatch(/ -0[45]00$/);
    expect(dateHeader).not.toContain("+0000");
  });

  it("dispatches a claimed message end-to-end: provider calls happen, message and queue row are marked sent", async () => {
    const fireResult = await enqueueOneCampaignMessage();

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0, bounced: 0, failures: [] });
    expect(provider.createdDrafts).toHaveLength(1);
    expect(provider.sentDrafts).toEqual([{ providerDraftId: "fake-draft-1" }]);
    expect(provider.appended).toHaveLength(1);

    // The account's own connected profile name must appear on the From header of the actual
    // dispatched MIME message, not just a bare address -- otherwise every campaign send looks
    // unprofessional to the recipient regardless of what the account is named in this app.
    const fromHeader = provider.createdDrafts[0]!.message.headers.find((h) => h.name === "From")?.value;
    expect(fromHeader).toContain("Ada Lovelace");
    expect(fromHeader).toContain("me@outboundly.app");

    const queueRow = db.select().from(sendQueue).where(eq(sendQueue.id, fireResult.sendQueueEntryId)).get();
    expect(queueRow?.status).toBe("sent");

    const messageRow = db.select().from(messages).all().find((m) => m.campaignEnrollmentId);
    expect(messageRow?.status).toBe("sent");
    expect(messageRow?.providerMessageId).toBe("fake-message-1");

    // Reproduces a real reported bug: a reply to a campaign-originated message never bumped its
    // campaign's reply rate, because this thread's provider_thread_id was never recorded at send
    // time -- leaving inbox sync's later reply with nothing to correlate against via
    // findThreadIdForProviderThreadId if the reply's own header chain doesn't line up.
    const threadRow = db.select().from(threads).where(eq(threads.id, messageRow!.threadId!)).get();
    expect(threadRow?.providerThreadId).toBe("fake-thread-1");

    const recordedEvents = await sendWorkerDeps.eventRepository.findByCampaignInWindow(
      fireResult.campaignId,
      new Date(0),
      new Date(Date.now() + 60_000)
    );
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]?.eventType).toBe("sent");
    expect(recordedEvents[0]?.metadata).toMatchObject({ templateId: expect.any(String), subjectVariantId: expect.any(String) });
  });

  it("threads a follow-up correctly at the real wire level even when the Provider Selector substitutes a different sending account between the two dispatches", async () => {
    // Reproduces a real reported bug: the Message-ID recorded for a message (used to build a
    // follow-up's In-Reply-To/References) used to be derived from whichever account was proposed
    // at *enqueue* time -- but the Provider Selector (Section 16.3) can substitute a *different*
    // account at actual *dispatch* time (e.g. the originally proposed account hits its daily limit
    // in between), which used to mint a completely different Message-ID for the real, sent copy.
    // A follow-up's headers would then reference an ID that never actually appeared on the wire,
    // and Gmail/any client would fail to thread it -- starting a new conversation instead of
    // replying, exactly what was reported. This test forces that exact substitution on *both*
    // dispatches and asserts the real, wire-level headers (not just what's recorded in our own DB)
    // still chain correctly.
    // Three accounts, not two: fireEnrollmentStep now prefers whichever account actually sent an
    // enrollment's previous step when proposing the next one (see the "prefers the account that
    // actually sent the first step" test above), so forcing step 2's *proposed* account to be the
    // one step 1 really used (deterministic, by design) and then substituting it away needs a third
    // account to land on -- otherwise the substitution could coincidentally fall back onto whichever
    // account the thread's own accountId column happens to still carry from step 1's enqueue-time
    // creation, which would defeat this test's whole point of forcing a genuine mismatch.
    const secondAccountId = generateId();
    const thirdAccountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values([
        {
          id: secondAccountId,
          provider: "google",
          emailAddress: "backup@another-domain.app",
          displayName: "Backup Sender",
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        },
        {
          id: thirdAccountId,
          provider: "google",
          emailAddress: "third@another-domain.app",
          displayName: "Third Sender",
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        }
      ])
      .run();

    const template = await fireStepDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi there"))] } });
    const sequence = await fireStepDeps.sequenceRepository.create({
      name: "Seq",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });
    await fireStepDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Original subject", weight: 1 });
    await fireStepDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[1]!.id, subjectText: "Follow-up subject (should not be used verbatim)", weight: 1 });
    const campaign = await fireStepDeps.campaignRepository.create({
      name: "Rotating camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId), asAccountId(secondAccountId), asAccountId(thirdAccountId)],
      businessHoursProfileId
    });
    await fireStepDeps.campaignRepository.setStatus(campaign.id, "running");
    const contact = await fireStepDeps.contactRepository.upsertByEmail({ email: "rotating-lead@example.com", source: "manual" });
    const enrollment = await fireStepDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    // --- Step 1: enqueue, then force the Provider Selector to substitute a *different* account ---
    // Disconnection (not a rate/daily limit) is what forces this: dispatchOne's own rate-limiter
    // check on claimed.accountId runs *before* the Provider Selector is ever consulted, so a
    // dailySendLimit-based denial would just retry the row without ever reaching substitution.
    // Provider Selector's own isEligible() checks account.status, which the earlier gate doesn't.
    // accountId is disconnected up front so schedule() proposes secondAccountId at enqueue time
    // (the thread's own accountId column, set at creation, ends up being secondAccountId); then
    // secondAccountId itself is disconnected too, forcing dispatch to substitute all the way to
    // thirdAccountId -- the account that actually sends step 1.
    await db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, accountId)).run();
    const firstFire = await fireEnrollmentStep(fireStepDeps, enrollment, new Date());
    if (firstFire.outcome !== "enqueued") throw new Error(`setup failed: ${firstFire.outcome}`);
    const firstQueueRow = db.select().from(sendQueue).where(eq(sendQueue.id, firstFire.sendQueueEntryId)).get();
    const accountProposedForStep1 = firstQueueRow!.accountId;
    await db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, accountProposedForStep1)).run();

    const firstDispatch = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(firstDispatch.sent).toBe(1);
    expect(provider.createdDrafts).toHaveLength(1);
    const step1Message = provider.createdDrafts[0]!.message;
    const step1MessageId = step1Message.headers.find((h) => h.name === "Message-ID")?.value;
    const step1Subject = step1Message.headers.find((h) => h.name === "Subject")?.value;
    expect(step1MessageId).toBeTruthy();
    expect(step1Subject).toBe("Original subject");
    // Proves the substitution actually happened -- otherwise this test wouldn't be exercising the
    // real reported bug at all.
    expect(provider.createdDrafts[0]!.account.accountId).not.toBe(accountProposedForStep1);
    const accountThatActuallySentStep1 = provider.createdDrafts[0]!.account.accountId;

    // Restore all three accounts to eligible. fireEnrollmentStep now proposes step 2 against
    // whichever account actually sent step 1 (accountThatActuallySentStep1 -- thirdAccountId) --
    // deterministic, not incidental -- so forcing a *second* substitution needs both that account
    // and the thread's own accountId column (still secondAccountId, from step 1's enqueue-time
    // creation) disconnected together; otherwise substituting away from thirdAccountId could land
    // right back on secondAccountId and coincidentally "match" the thread, defeating the point.
    await db.update(accounts).set({ status: "connected" }).where(eq(accounts.id, accountId)).run();
    await db.update(accounts).set({ status: "connected" }).where(eq(accounts.id, secondAccountId)).run();
    await db.update(accounts).set({ status: "connected" }).where(eq(accounts.id, thirdAccountId)).run();

    const advanced = await fireStepDeps.enrollmentRepository.findById(enrollment.id);
    const secondFire = await fireEnrollmentStep(fireStepDeps, advanced!, new Date());
    if (secondFire.outcome !== "enqueued") throw new Error(`setup failed: ${secondFire.outcome}`);
    const secondQueueRow = db.select().from(sendQueue).where(eq(sendQueue.id, secondFire.sendQueueEntryId)).get();
    const accountProposedForStep2 = secondQueueRow!.accountId;
    // Proves the new account-consistency preference: step 2 is proposed against the same account
    // that actually sent step 1, not the original first-choice account or an arbitrary rotation.
    expect(accountProposedForStep2).toBe(accountThatActuallySentStep1);
    await db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, accountProposedForStep2)).run();
    await db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, secondAccountId)).run();

    const secondDispatch = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(secondDispatch.sent).toBe(1);
    expect(provider.createdDrafts).toHaveLength(2);
    const step2Message = provider.createdDrafts[1]!.message;
    expect(provider.createdDrafts[1]!.account.accountId).not.toBe(accountProposedForStep2);

    // The actual bytes sent over the wire for step 2 -- not just what's recorded in our own DB --
    // must reference step 1's *actual delivered* Message-ID (what FakeMailProvider.sendDraft
    // confirmed post-send), not step1MessageId (what this app's own MIME builder merely proposed
    // and which a real provider like Gmail silently rewrites away on delivery -- the deeper root
    // cause discovered after the account-rotation fix alone still didn't resolve the real-world
    // report), and continue its actual subject.
    expect(step2Message.headers.find((h) => h.name === "In-Reply-To")?.value).toBe("<confirmed-delivered-1@mail.fake-provider.example>");
    expect(step2Message.headers.find((h) => h.name === "References")?.value).toBe("<confirmed-delivered-1@mail.fake-provider.example>");
    expect(step2Message.headers.find((h) => h.name === "In-Reply-To")?.value).not.toBe(step1MessageId);
    expect(step2Message.headers.find((h) => h.name === "Subject")?.value).toBe("Re: Original subject");

    // Also a real reported risk with the providerThreadId passthrough: step 1's thread belongs to
    // whichever account actually sent it (a *different* account than step 2 dispatches through,
    // since this test forces rotation on both) -- provider thread ids are scoped per-account, so
    // reusing one across accounts isn't just unhelpful, real providers reject it outright. It must
    // be omitted here, not carried over, leaving the In-Reply-To/References headers (already
    // asserted above) as what threads this correctly for the recipient regardless of account.
    expect(provider.createdDrafts[1]!.providerThreadId).toBeUndefined();
  });

  it("prefers the account that actually sent the first step for a follow-up, over rotating back to the original first-choice account", async () => {
    // A real user concern: with multiple sending accounts in rotation, a recipient could otherwise
    // see the first email from one address and the follow-up from a completely different one in
    // the same conversation -- unusual and easy to notice, even though the reply threading headers
    // themselves would still technically work. Once step 1 has actually gone out through account
    // B (because account A was temporarily ineligible), step 2 should keep using account B too,
    // not fall back to account A the moment it becomes eligible again.
    const secondAccountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id: secondAccountId,
        provider: "google",
        emailAddress: "backup@another-domain.app",
        displayName: "Backup Sender",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const template = await fireStepDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi there"))] } });
    const sequence = await fireStepDeps.sequenceRepository.create({
      name: "Seq",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });
    await fireStepDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[0]!.id, subjectText: "Original subject", weight: 1 });
    await fireStepDeps.subjectVariantRepository.create({ sequenceStepId: sequence.steps[1]!.id, subjectText: "Follow-up subject", weight: 1 });
    const campaign = await fireStepDeps.campaignRepository.create({
      name: "Consistent-sender camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId), asAccountId(secondAccountId)],
      businessHoursProfileId
    });
    await fireStepDeps.campaignRepository.setStatus(campaign.id, "running");
    const contact = await fireStepDeps.contactRepository.upsertByEmail({ email: "consistent-lead@example.com", source: "manual" });
    const enrollment = await fireStepDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    // Force step 1 to dispatch through the *second* account by disconnecting the first-listed one
    // (accountId) beforehand -- same mechanism the rotation test above uses.
    await db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, accountId)).run();
    const firstFire = await fireEnrollmentStep(fireStepDeps, enrollment, new Date());
    if (firstFire.outcome !== "enqueued") throw new Error(`setup failed: ${firstFire.outcome}`);
    const firstDispatch = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(firstDispatch.sent).toBe(1);
    expect(provider.createdDrafts[0]!.account.accountId).toBe(secondAccountId);

    // Reconnect the original account -- without the fix, schedule() would try
    // campaign.sendingAccountIds in its stored order and propose accountId again, since it's now
    // eligible and listed first.
    await db.update(accounts).set({ status: "connected" }).where(eq(accounts.id, accountId)).run();

    const advanced = await fireStepDeps.enrollmentRepository.findById(enrollment.id);
    const secondFire = await fireEnrollmentStep(fireStepDeps, advanced!, new Date());
    if (secondFire.outcome !== "enqueued") throw new Error(`setup failed: ${secondFire.outcome}`);
    const secondQueueRow = db.select().from(sendQueue).where(eq(sendQueue.id, secondFire.sendQueueEntryId)).get();
    // Proposed for the SAME account step 1 actually sent from, not the reconnected original.
    expect(secondQueueRow!.accountId).toBe(secondAccountId);

    const secondDispatch = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(secondDispatch.sent).toBe(1);
    expect(provider.createdDrafts[1]!.account.accountId).toBe(secondAccountId);
  });

  it("does pass the provider thread id through when the same account sends every step (the common case: one sender per campaign)", async () => {
    const template = await fireStepDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi there"))] } });
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
      name: "Single-sender camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    await fireStepDeps.campaignRepository.setStatus(campaign.id, "running");
    const contact = await fireStepDeps.contactRepository.upsertByEmail({ email: "single-sender-lead@example.com", source: "manual" });
    const enrollment = await fireStepDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const firstFire = await fireEnrollmentStep(fireStepDeps, enrollment, new Date());
    if (firstFire.outcome !== "enqueued") throw new Error(`setup failed: ${firstFire.outcome}`);
    await runSendWorkerTick(sendWorkerDeps, new Date());

    const advanced = await fireStepDeps.enrollmentRepository.findById(enrollment.id);
    const secondFire = await fireEnrollmentStep(fireStepDeps, advanced!, new Date());
    if (secondFire.outcome !== "enqueued") throw new Error(`setup failed: ${secondFire.outcome}`);
    await runSendWorkerTick(sendWorkerDeps, new Date());

    expect(provider.createdDrafts).toHaveLength(2);
    // Same account both times -- step 1's real thread id (from FakeMailProvider.sendDraft) is
    // exactly what step 2's createDraft call should receive, keeping this account's own Sent/All
    // Mail view grouped too, on top of the recipient-facing In-Reply-To/References headers.
    expect(provider.createdDrafts[1]!.providerThreadId).toBe("fake-thread-1");
  });

  it("corrects the stored Message-ID to what the provider actually delivered, so the DB record (not just the wire bytes) reflects reality", async () => {
    // Reproduces the real, still-outstanding bug reported after the account-rotation fix alone:
    // Gmail (and Microsoft Graph) silently rewrite the Message-ID header on actual delivery,
    // discarding whatever this app's own MIME builder generated -- verified for real against a
    // delivered message's "Show Original" headers, which showed Gmail's own `<CA...@mail.gmail.com>`
    // id, never the app's `<hash@domain>` one. Without correcting the stored row, every later
    // follow-up step (via findOutboundMessageHistoryForEnrollment, which reads this exact column)
    // would keep threading against an id the recipient's system never actually saw.
    const template = await fireStepDeps.templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi there"))] } });
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
      name: "Confirmed-id camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    await fireStepDeps.campaignRepository.setStatus(campaign.id, "running");
    const contact = await fireStepDeps.contactRepository.upsertByEmail({ email: "confirmed-id-lead@example.com", source: "manual" });
    const enrollment = await fireStepDeps.enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date(Date.now() - 60_000)
    });

    const firstFire = await fireEnrollmentStep(fireStepDeps, enrollment, new Date());
    if (firstFire.outcome !== "enqueued") throw new Error(`setup failed: ${firstFire.outcome}`);
    const firstQueueRow = db.select().from(sendQueue).where(eq(sendQueue.id, firstFire.sendQueueEntryId)).get();
    await runSendWorkerTick(sendWorkerDeps, new Date());

    const step1Message = provider.createdDrafts[0]!.message;
    const step1OwnGeneratedMessageId = step1Message.headers.find((h) => h.name === "Message-ID")?.value;
    expect(step1OwnGeneratedMessageId).toBeTruthy();

    const step1Row = db.select().from(messages).where(eq(messages.id, firstQueueRow!.messageId)).get();
    // The stored row must reflect what the provider actually confirmed, not our own proposal.
    expect(step1Row?.messageIdHeader).toBe("<confirmed-delivered-1@mail.fake-provider.example>");
    expect(step1Row?.messageIdHeader).not.toBe(step1OwnGeneratedMessageId);

    const advanced = await fireStepDeps.enrollmentRepository.findById(enrollment.id);
    const secondFire = await fireEnrollmentStep(fireStepDeps, advanced!, new Date());
    if (secondFire.outcome !== "enqueued") throw new Error(`setup failed: ${secondFire.outcome}`);
    await runSendWorkerTick(sendWorkerDeps, new Date());

    const step2Message = provider.createdDrafts[1]!.message;
    // Step 2's actual dispatched headers must chain onto what step 1 was really delivered with.
    expect(step2Message.headers.find((h) => h.name === "In-Reply-To")?.value).toBe("<confirmed-delivered-1@mail.fake-provider.example>");
    expect(step2Message.headers.find((h) => h.name === "References")?.value).toBe("<confirmed-delivered-1@mail.fake-provider.example>");
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

  it("releases an already-queued message back to pending instead of sending it once its campaign is paused", async () => {
    // Reproduces a real reported bug: pausing a campaign only ever stopped the Scheduler from
    // enqueuing *new* sends (Section 14.2's status='running' join) -- a message that reached
    // send_queue while the campaign was still running kept going out regardless, since claimNext
    // has no notion of campaigns at all. The fix must hold it, not send it, and not fail it either.
    const { campaignId } = await enqueueOneCampaignMessage();
    await fireStepDeps.campaignRepository.setStatus(campaignId, "paused");

    const result = await runSendWorkerTick(sendWorkerDeps, new Date());
    expect(result).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0, bounced: 0, failures: [] });
    expect(provider.createdDrafts).toHaveLength(0); // the provider must never even be asked to send it

    const row = db.select().from(sendQueue).all()[0];
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(0); // held, not counted as a failed attempt
    expect(row!.earliestSendAt.getTime()).toBeGreaterThan(Date.now());
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

    const logged = await sendWorkerDeps.errorLogRepository!.listRecent(10, "send-worker");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ errorType: "transient_dispatch_failure", retryCount: 1 });
    expect(logged[0]?.errorMessage).toMatch(/provider unavailable/);
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

    const unread = await sendWorkerDeps.notificationRepository.findUnread(10);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.notificationType).toBe("send_failure");
    expect(unread[0]?.relatedCampaignId).toBe(campaignId);

    const logged = await sendWorkerDeps.errorLogRepository!.listRecent(10, "send-worker");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ errorType: "permanent_smtp_rejection", campaignId });
    expect(logged[0]?.recipientEmail).toContain("lead@example.com");
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
