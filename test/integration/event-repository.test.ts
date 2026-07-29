import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asCampaignId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("SqliteEventRepository (Section 5.9, Section 20.1)", () => {
  let db: OutboundlyDb;
  let repo: SqliteEventRepository;
  let campaignId: string;
  let otherCampaignId: string;
  let accountId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-event-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteEventRepository(db);

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
    // Genuinely every day (not just Monday), matching the fix in send-worker-tick.test.ts -- this
    // avoids the same class of day-of-week fragility even where the current assertions don't
    // happen to exercise the send_queue claim query's earliestSendAt <= now filter.
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

    const templateRepository = new SqliteTemplateRepository(db);
    const sequenceRepository = new SqliteSequenceRepository(db);
    const campaignRepository = new SqliteCampaignRepository(db);
    const template = await templateRepository.create({ name: "T", document: { blocks: [] } });
    const sequence = await sequenceRepository.create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });

    const campaign = await campaignRepository.create({
      name: "Camp A",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    campaignId = campaign.id;

    const otherCampaign = await campaignRepository.create({
      name: "Camp B",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    otherCampaignId = otherCampaign.id;
  });

  it("records an event and round-trips its metadata", async () => {
    const record = await repo.record({
      eventType: "sent",
      campaignId: asCampaignId(campaignId),
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      metadata: { templateId: "tmpl-1", subjectVariantId: "sv-1" }
    });

    expect(record.eventType).toBe("sent");
    expect(record.metadata).toEqual({ templateId: "tmpl-1", subjectVariantId: "sv-1" });
  });

  it("finds events for a campaign within a time window, excluding events outside it", async () => {
    await repo.record({ eventType: "sent", campaignId: asCampaignId(campaignId), occurredAt: new Date("2026-01-05T00:00:00.000Z") });
    await repo.record({ eventType: "bounced", campaignId: asCampaignId(campaignId), occurredAt: new Date("2026-01-06T00:00:00.000Z") });
    await repo.record({ eventType: "sent", campaignId: asCampaignId(campaignId), occurredAt: new Date("2026-02-01T00:00:00.000Z") }); // outside window
    await repo.record({ eventType: "sent", campaignId: asCampaignId(otherCampaignId), occurredAt: new Date("2026-01-05T00:00:00.000Z") }); // different campaign

    const found = await repo.findByCampaignInWindow(
      asCampaignId(campaignId),
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-31T00:00:00.000Z")
    );
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.eventType).sort()).toEqual(["bounced", "sent"]);
  });

  it("finds events for an account within a time window", async () => {
    const otherAccountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id: otherAccountId,
        provider: "google",
        emailAddress: "other@outboundly.app",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    await repo.record({ eventType: "sent", accountId: asAccountId(accountId), occurredAt: new Date("2026-01-05T00:00:00.000Z") });
    await repo.record({ eventType: "sent", accountId: asAccountId(otherAccountId), occurredAt: new Date("2026-01-05T00:00:00.000Z") });

    const found = await repo.findByAccountInWindow(
      asAccountId(accountId),
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-31T00:00:00.000Z")
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.accountId).toBe(accountId);
  });

  it("stores an event with no message/campaign/account context (all nullable)", async () => {
    const record = await repo.record({ eventType: "conversion", occurredAt: new Date() });
    expect(record.messageId).toBeUndefined();
    expect(record.campaignId).toBeUndefined();
    expect(record.accountId).toBeUndefined();
  });
});
