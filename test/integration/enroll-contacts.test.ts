import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollContactsIntoCampaign, type EnrollContactsDeps } from "../../src/application/campaigns/enroll-contacts.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteSuppressionListRepository } from "../../src/adapters/persistence/repositories/suppression-list-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { asAccountId, asContactId, generateId, type CampaignId } from "../../src/core/shared-kernel/ids.js";

/**
 * The admission rules every enrollment path shares. The cross-campaign guard is the reason this
 * lives in the application layer at all: it used to be inline in the Electron main process, where
 * nothing could test it.
 */
describe("enrollContactsIntoCampaign", () => {
  let db: OutboundlyDb;
  let deps: EnrollContactsDeps;
  let templateRepository: SqliteTemplateRepository;
  let businessHoursProfileId: string;
  const accountId = asAccountId(generateId());

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-enroll-contacts-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));

    templateRepository = new SqliteTemplateRepository(db);
    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    businessHoursProfileId = (
      await businessHoursProfileRepository.create({
        name: "Always open",
        timezone: "UTC",
        windows: { monday: [{ start: "00:00", end: "23:59" }] }
      })
    ).id;

    deps = {
      campaignRepository: new SqliteCampaignRepository(db),
      sequenceRepository: new SqliteSequenceRepository(db),
      contactRepository: new SqliteContactRepository(db),
      enrollmentRepository: new SqliteEnrollmentRepository(db),
      suppressionListRepository: new SqliteSuppressionListRepository(db)
    };
  });

  async function makeCampaign(name: string): Promise<CampaignId> {
    const template = await templateRepository.create({ name: `${name} template`, document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await deps.sequenceRepository.create({
      name: `${name} seq`,
      steps: [
        { delayDays: 0, delayHours: 0, templateId: template.id },
        { delayDays: 3, delayHours: 0, templateId: template.id }
      ]
    });
    const campaign = await deps.campaignRepository.create({
      name,
      sequenceId: sequence.id,
      sendingAccountIds: [accountId],
      businessHoursProfileId
    });
    return campaign.id;
  }

  it("enrolls a fresh contact", async () => {
    const campaignId = await makeCampaign("Alpha");
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    const result = await enrollContactsIntoCampaign(deps, { campaignId, contactIds: [contact.id] });

    expect(result).toEqual({ enrolled: 1, skipped: [] });
  });

  it("skips a lead who is already live in another campaign, naming which one", async () => {
    // Two campaigns built from overlapping lead lists would otherwise send the same person two
    // unrelated cold emails from the same domain, sometimes minutes apart.
    const alpha = await makeCampaign("Alpha");
    const beta = await makeCampaign("Beta");
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await enrollContactsIntoCampaign(deps, { campaignId: alpha, contactIds: [contact.id] });
    const result = await enrollContactsIntoCampaign(deps, { campaignId: beta, contactIds: [contact.id] });

    expect(result.enrolled).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("Alpha");
    expect(await deps.enrollmentRepository.findActiveByCampaignAndContact(beta, contact.id)).toBeUndefined();
  });

  it("allows the overlap when the user has explicitly turned the guard off", async () => {
    const alpha = await makeCampaign("Alpha");
    const beta = await makeCampaign("Beta");
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await enrollContactsIntoCampaign(deps, { campaignId: alpha, contactIds: [contact.id] });
    const result = await enrollContactsIntoCampaign(deps, {
      campaignId: beta,
      contactIds: [contact.id],
      allowConcurrentCampaigns: true
    });

    expect(result.enrolled).toBe(1);
    expect(await deps.enrollmentRepository.findActiveByCampaignAndContact(beta, contact.id)).toBeDefined();
  });

  it("lets a lead into a new campaign once their previous one is no longer active", async () => {
    // The guard is about *concurrent* campaigns -- re-engaging a lead later is a normal thing to do.
    const alpha = await makeCampaign("Alpha");
    const beta = await makeCampaign("Beta");
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await enrollContactsIntoCampaign(deps, { campaignId: alpha, contactIds: [contact.id] });
    const active = await deps.enrollmentRepository.findActiveByCampaignAndContact(alpha, contact.id);
    await deps.enrollmentRepository.advance(active!.id, { status: "completed", nextSendAt: undefined });

    const result = await enrollContactsIntoCampaign(deps, { campaignId: beta, contactIds: [contact.id] });

    expect(result).toEqual({ enrolled: 1, skipped: [] });
  });

  it("still skips a second enrollment into the same campaign", async () => {
    const campaignId = await makeCampaign("Alpha");
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await enrollContactsIntoCampaign(deps, { campaignId, contactIds: [contact.id] });
    const result = await enrollContactsIntoCampaign(deps, { campaignId, contactIds: [contact.id] });

    expect(result.enrolled).toBe(0);
    expect(result.skipped[0]?.reason).toBe("Already actively enrolled in this campaign");
  });

  it("skips a suppressed contact and one that no longer exists, without losing the rest of the batch", async () => {
    const campaignId = await makeCampaign("Alpha");
    const good = await deps.contactRepository.upsertByEmail({ email: "good@example.com", source: "manual" });
    const suppressed = await deps.contactRepository.upsertByEmail({ email: "no@example.com", source: "manual" });
    await deps.suppressionListRepository.add(suppressed.email, "unsubscribed");

    const result = await enrollContactsIntoCampaign(deps, {
      campaignId,
      contactIds: [suppressed.id, asContactId("does-not-exist"), good.id]
    });

    expect(result.enrolled).toBe(1);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "Contact is on the suppression list",
      "Contact not found"
    ]);
  });

  it("rejects a campaign whose sequence has no steps rather than creating an enrollment that can never fire", async () => {
    const sequence = await deps.sequenceRepository.create({ name: "Empty", steps: [] });
    const campaign = await deps.campaignRepository.create({
      name: "Empty",
      sequenceId: sequence.id,
      sendingAccountIds: [accountId],
      businessHoursProfileId
    });
    const contact = await deps.contactRepository.upsertByEmail({ email: "lead@example.com", source: "manual" });

    await expect(enrollContactsIntoCampaign(deps, { campaignId: campaign.id, contactIds: [contact.id] })).rejects.toThrow(
      /no steps/
    );
  });
});
