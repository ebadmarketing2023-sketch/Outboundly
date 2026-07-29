import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteLeadImportBatch, type DeleteLeadImportBatchDeps } from "../../src/application/leads/delete-lead-import-batch.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteLeadImportBatchRepository } from "../../src/adapters/persistence/repositories/lead-import-batch-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("deleteLeadImportBatch (Critical Improvement #3)", () => {
  let db: OutboundlyDb;
  let deps: DeleteLeadImportBatchDeps;
  let contactRepository: SqliteContactRepository;
  let enrollmentRepository: SqliteEnrollmentRepository;
  let batchRepository: SqliteLeadImportBatchRepository;
  let accountId: string;
  let businessHoursProfileId: string;
  let sequenceId: string;
  let stepAId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-delete-batch-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));

    accountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({ id: accountId, provider: "google", emailAddress: "me@outboundly.app", status: "connected", connectedAt: now, createdAt: now, updatedAt: now })
      .run();

    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
      name: "Always open",
      timezone: "UTC",
      windows: { monday: [{ start: "00:00", end: "23:59" }] }
    });
    businessHoursProfileId = businessHoursProfile.id;

    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    sequenceId = sequence.id;
    stepAId = sequence.steps[0]!.id;

    contactRepository = new SqliteContactRepository(db);
    enrollmentRepository = new SqliteEnrollmentRepository(db);
    batchRepository = new SqliteLeadImportBatchRepository(db);

    deps = {
      db,
      contactRepository,
      enrollmentRepository,
      campaignRepository: new SqliteCampaignRepository(db),
      sequenceRepository: new SqliteSequenceRepository(db),
      leadImportBatchRepository: batchRepository
    };
  });

  it("soft-deletes every contact in the batch, stops their active enrollments, and removes the batch itself", async () => {
    const batch = await batchRepository.create({ filename: "leads.csv", importedAt: new Date() });
    const contactA = await contactRepository.upsertByEmail({ email: "a@example.com", source: "csv_import", importBatchId: batch.id });
    const contactB = await contactRepository.upsertByEmail({ email: "b@example.com", source: "csv_import", importBatchId: batch.id });

    const campaign = await deps.campaignRepository.create({
      name: "Camp",
      sequenceId,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    await deps.campaignRepository.setStatus(campaign.id, "running");
    const enrollmentA = await enrollmentRepository.enroll({
      campaignId: campaign.id,
      contactId: contactA.id,
      currentStepId: stepAId,
      nextSendAt: new Date()
    });

    await deleteLeadImportBatch(deps, batch.id);

    expect(await batchRepository.findById(batch.id)).toBeUndefined();
    expect((await contactRepository.findById(contactA.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await contactRepository.findById(contactB.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await enrollmentRepository.findById(enrollmentA.id))?.status).toBe("stopped_manual");
    // Deleting the batch shouldn't leave a dangling FK reference on the (now-deleted) contacts.
    expect((await contactRepository.findById(contactA.id))?.importBatchId).toBeUndefined();
  });

  it("leaves a contact from a different batch untouched", async () => {
    const batchOne = await batchRepository.create({ filename: "one.csv", importedAt: new Date() });
    const batchTwo = await batchRepository.create({ filename: "two.csv", importedAt: new Date() });
    await contactRepository.upsertByEmail({ email: "a@example.com", source: "csv_import", importBatchId: batchOne.id });
    const untouched = await contactRepository.upsertByEmail({ email: "b@example.com", source: "csv_import", importBatchId: batchTwo.id });

    await deleteLeadImportBatch(deps, batchOne.id);

    expect(await batchRepository.findById(batchTwo.id)).toBeDefined();
    expect((await contactRepository.findById(untouched.id))?.deletedAt).toBeUndefined();
    expect(await contactRepository.list()).toHaveLength(1);
  });

  it("is idempotent-safe for a contact in the batch that was already individually deleted", async () => {
    const batch = await batchRepository.create({ filename: "leads.csv", importedAt: new Date() });
    const contact = await contactRepository.upsertByEmail({ email: "a@example.com", source: "csv_import", importBatchId: batch.id });
    await contactRepository.delete(contact.id);

    await expect(deleteLeadImportBatch(deps, batch.id)).resolves.toBeUndefined();
    expect(await batchRepository.findById(batch.id)).toBeUndefined();
  });
});
