import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts as accountsTable, businessHoursProfiles } from "../../src/adapters/persistence/schema.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

describe("Templates/Sequences/Campaigns/Enrollments repositories (Section 5.6, Section 14)", () => {
  let db: OutboundlyDb;
  let templateRepo: SqliteTemplateRepository;
  let sequenceRepo: SqliteSequenceRepository;
  let campaignRepo: SqliteCampaignRepository;
  let enrollmentRepo: SqliteEnrollmentRepository;
  let contactRepo: SqliteContactRepository;
  let businessHoursProfileId: string;
  let accountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-campaign-repos-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    templateRepo = new SqliteTemplateRepository(db);
    sequenceRepo = new SqliteSequenceRepository(db);
    campaignRepo = new SqliteCampaignRepository(db);
    enrollmentRepo = new SqliteEnrollmentRepository(db);
    contactRepo = new SqliteContactRepository(db);

    businessHoursProfileId = "bhp-1";
    db.insert(businessHoursProfiles)
      .values({ id: businessHoursProfileId, name: "9-5", timezone: "UTC", windowsJson: {} })
      .run();

    accountId = "acct-1";
    const now = new Date();
    db.insert(accountsTable)
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
  });

  it("creates a template and round-trips its Internal Document Model", async () => {
    const template = await templateRepo.create({
      name: "Intro",
      document: { blocks: [paragraph(textRun("Hi there"))] }
    });
    const found = await templateRepo.findById(template.id);
    expect(found?.document).toEqual({ blocks: [paragraph(textRun("Hi there"))] });
  });

  it("creates a sequence with its steps atomically, in order", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Cold outreach",
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });

    expect(sequence.steps).toHaveLength(2);
    expect(sequence.steps[0]?.stepOrder).toBe(1);
    expect(sequence.steps[1]?.stepOrder).toBe(2);
    expect(sequence.steps[1]?.delayDays).toBe(3);

    const reloaded = await sequenceRepo.findById(sequence.id);
    expect(reloaded?.steps).toHaveLength(2);
  });

  it("creates a campaign bound to a sequence and sending accounts", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });

    const campaign = await campaignRepo.create({
      name: "Q1 outreach",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    expect(campaign.status).toBe("draft");
    expect(campaign.sendingAccountIds).toEqual([accountId]);

    await campaignRepo.setStatus(campaign.id, "running");
    const reloaded = await campaignRepo.findById(campaign.id);
    expect(reloaded?.status).toBe("running");
  });

  it("update renames a campaign and switches its business-hours profile", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Original name",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    const otherProfileId = "bhp-2";
    db.insert(businessHoursProfiles).values({ id: otherProfileId, name: "24/7", timezone: "UTC", windowsJson: {} }).run();

    const updated = await campaignRepo.update(campaign.id, { name: "Renamed", businessHoursProfileId: otherProfileId });
    expect(updated.name).toBe("Renamed");
    expect(updated.businessHoursProfileId).toBe(otherProfileId);

    const reloaded = await campaignRepo.findById(campaign.id);
    expect(reloaded?.name).toBe("Renamed");
    expect(reloaded?.businessHoursProfileId).toBe(otherProfileId);
  });

  it("delete removes a campaign that has no enrollments", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Unused draft",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });

    await campaignRepo.delete(campaign.id);
    expect(await campaignRepo.findById(campaign.id)).toBeUndefined();
  });

  it("delete throws (the FK constraint rejects it) when the campaign still has enrollments", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "In use",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });
    await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    await expect(campaignRepo.delete(campaign.id)).rejects.toThrow();
  });

  it("enrolls a contact, finds it as due once next_send_at has passed, and advances it", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    // findDueForScheduling only considers enrollments whose parent campaign is 'running' (Section
    // 14.2) -- a freshly created campaign defaults to 'draft', which must never fire on its own.
    await campaignRepo.setStatus(campaign.id, "running");
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const past = new Date(Date.now() - 60_000);
    const enrollment = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: past
    });
    expect(enrollment.status).toBe("active");

    const due = await enrollmentRepo.findDueForScheduling(new Date());
    expect(due.map((e) => e.id)).toContain(enrollment.id);

    await enrollmentRepo.advance(enrollment.id, { status: "completed", nextSendAt: undefined });
    const completed = await enrollmentRepo.findById(enrollment.id);
    expect(completed?.status).toBe("completed");

    const dueAfter = await enrollmentRepo.findDueForScheduling(new Date());
    expect(dueAfter.map((e) => e.id)).not.toContain(enrollment.id);
  });

  it("prevents finding a second active enrollment for the same campaign+contact once stopped", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await campaignRepo.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const enrollment = await enrollmentRepo.enroll({
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    expect(await enrollmentRepo.findActiveByCampaignAndContact(campaign.id, contact.id)).toBeDefined();
    await enrollmentRepo.advance(enrollment.id, { status: "stopped_manual" });
    expect(await enrollmentRepo.findActiveByCampaignAndContact(campaign.id, contact.id)).toBeUndefined();
  });

  it("finds every active enrollment for a contact across multiple campaigns (Section 14.3 fan-out)", async () => {
    const template = await templateRepo.create({ name: "T1", document: { blocks: [] } });
    const sequence = await sequenceRepo.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaignA = await campaignRepo.create({
      name: "A",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const campaignB = await campaignRepo.create({
      name: "B",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
    const contact = await contactRepo.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await enrollmentRepo.enroll({
      campaignId: campaignA.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });
    await enrollmentRepo.enroll({
      campaignId: campaignB.id,
      contactId: contact.id,
      currentStepId: sequence.steps[0]!.id,
      nextSendAt: new Date()
    });

    const active = await enrollmentRepo.findActiveByContact(contact.id);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((e) => e.campaignId))).toEqual(new Set([campaignA.id, campaignB.id]));
  });
});
