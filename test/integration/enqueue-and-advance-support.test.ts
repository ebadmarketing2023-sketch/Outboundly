import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { enqueueAndAdvanceEnrollment } from "../../src/adapters/persistence/enqueue-and-advance-support.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts as accountsTable, businessHoursProfiles, messages as messagesTable } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asMessageId, generateId, type EnrollmentId } from "../../src/core/shared-kernel/ids.js";

describe("enqueueAndAdvanceEnrollment (Section 24: Database Integrity, Critical Improvement #13)", () => {
  let db: OutboundlyDb;
  let campaignRepo: SqliteCampaignRepository;
  let enrollmentRepo: SqliteEnrollmentRepository;
  let sendQueueRepo: SqliteSendQueueRepository;
  let accountId: string;
  let messageId: string;
  let enrollmentId: EnrollmentId;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-enqueue-advance-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    campaignRepo = new SqliteCampaignRepository(db);
    enrollmentRepo = new SqliteEnrollmentRepository(db);
    sendQueueRepo = new SqliteSendQueueRepository(db);
    const contactRepo = new SqliteContactRepository(db);
    const sequenceRepo = new SqliteSequenceRepository(db);
    const templateRepo = new SqliteTemplateRepository(db);

    const bhpId = "bhp-1";
    db.insert(businessHoursProfiles).values({ id: bhpId, name: "9-5", timezone: "UTC", windowsJson: {} }).run();

    accountId = "acct-1";
    const now = new Date();
    db.insert(accountsTable)
      .values({ id: accountId, provider: "google", emailAddress: "me@outboundly.app", status: "connected", connectedAt: now, createdAt: now, updatedAt: now })
      .run();

    const template = await templateRepo.create({ name: "T", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({ name: "Seq", steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }] });
    const campaign = await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: bhpId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });
    const enrollment = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });
    enrollmentId = enrollment.id;

    const msgId = generateId();
    db.insert(messagesTable)
      .values({
        id: msgId,
        accountId,
        direction: "outbound",
        status: "queued",
        threadId: null,
        messageIdHeader: `<${msgId}@outboundly.app>`,
        fromAddress: "me@outboundly.app",
        toAddresses: ["lead@example.com"],
        subject: "Hi",
        bodyText: "Hi",
        createdAt: now,
        updatedAt: now
      })
      .run();
    messageId = msgId;
  });

  it("enqueues a send_queue row and advances the enrollment together", () => {
    const entry = enqueueAndAdvanceEnrollment(db, {
      queue: {
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "campaign",
        earliestSendAt: new Date(),
        idempotencyKey: `${enrollmentId}:step-1`
      },
      enrollmentId,
      advance: { status: "completed", nextSendAt: undefined }
    });

    expect(entry.status).toBe("pending");
    expect(entry.idempotencyKey).toBe(`${enrollmentId}:step-1`);
  });

  it("is idempotent under the same idempotencyKey: re-invoking after a simulated crash returns the existing row rather than duplicating it, and still advances the enrollment", async () => {
    const input = {
      queue: {
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "campaign" as const,
        earliestSendAt: new Date(),
        idempotencyKey: `${enrollmentId}:step-1`
      },
      enrollmentId,
      advance: { status: "completed" as const, nextSendAt: undefined }
    };

    const first = enqueueAndAdvanceEnrollment(db, input);
    const second = enqueueAndAdvanceEnrollment(db, input);

    expect(second.id).toBe(first.id);
    const allQueued = await sendQueueRepo.findByIdempotencyKey(input.queue.idempotencyKey);
    expect(allQueued?.id).toBe(first.id);

    const enrollment = await enrollmentRepo.findById(enrollmentId);
    expect(enrollment?.status).toBe("completed");
  });
});
