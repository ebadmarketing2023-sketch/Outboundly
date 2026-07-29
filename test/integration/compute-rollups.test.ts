import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { computeRollups, type ComputeRollupsDeps } from "../../src/adapters/persistence/compute-rollups.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountMetricsRollupRepository } from "../../src/adapters/persistence/repositories/account-metrics-rollup-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignMetricsRollupRepository } from "../../src/adapters/persistence/repositories/campaign-metrics-rollup-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteEventRepository } from "../../src/adapters/persistence/repositories/event-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asCampaignId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("Rollup repositories (Section 5.9, Section 20.1)", () => {
  let db: OutboundlyDb;
  let campaignRollupRepo: SqliteCampaignMetricsRollupRepository;
  let accountRollupRepo: SqliteAccountMetricsRollupRepository;
  let campaignId: string;
  let accountId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-rollup-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    campaignRollupRepo = new SqliteCampaignMetricsRollupRepository(db);
    accountRollupRepo = new SqliteAccountMetricsRollupRepository(db);

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

    // Genuinely every day (not just Monday), matching the fix in send-worker-tick.test.ts -- this
    // avoids the same class of day-of-week fragility even where the current assertions don't
    // happen to exercise the send_queue claim query's earliestSendAt <= now filter.
    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
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
    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await new SqliteCampaignRepository(db).create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    campaignId = campaign.id;
  });

  it("upserts campaign rollup buckets and finds them within a window", async () => {
    await campaignRollupRepo.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart: new Date("2026-01-05T00:00:00.000Z"), sentCount: 3, bouncedCount: 1, repliedCount: 0, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      new Date("2026-01-06T00:00:00.000Z")
    );

    const found = await campaignRollupRepo.findInWindow(asCampaignId(campaignId), new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-31T00:00:00.000Z"));
    expect(found).toHaveLength(1);
    expect(found[0]?.sentCount).toBe(3);
    expect(found[0]?.bouncedCount).toBe(1);
  });

  it("replaces (not accumulates) an existing day's bucket on re-upsert", async () => {
    const periodStart = new Date("2026-01-05T00:00:00.000Z");
    await campaignRollupRepo.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart, sentCount: 3, bouncedCount: 0, repliedCount: 0, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      new Date()
    );
    await campaignRollupRepo.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart, sentCount: 10, bouncedCount: 2, repliedCount: 1, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      new Date()
    );

    const found = await campaignRollupRepo.findInWindow(asCampaignId(campaignId), new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-31T00:00:00.000Z"));
    expect(found).toHaveLength(1); // still one row, not two
    expect(found[0]?.sentCount).toBe(10); // replaced, not 3 + 10
  });

  it("upserts account rollup buckets and finds them within a window", async () => {
    await accountRollupRepo.upsertBuckets(
      asAccountId(accountId),
      [{ periodStart: new Date("2026-01-05T00:00:00.000Z"), sentCount: 7, bouncedCount: 0, repliedCount: 2, positiveReplyCount: 1, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      new Date()
    );

    const found = await accountRollupRepo.findInWindow(asAccountId(accountId), new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-31T00:00:00.000Z"));
    expect(found).toHaveLength(1);
    expect(found[0]?.repliedCount).toBe(2);
  });
});

describe("computeRollups (Section 21.1 Analytics rollup worker)", () => {
  let db: OutboundlyDb;
  let deps: ComputeRollupsDeps;
  let campaignId: string;
  let accountId: string;
  let eventRepository: SqliteEventRepository;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-compute-rollups-test-"));
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

    // Genuinely every day (not just Monday), matching the fix in send-worker-tick.test.ts -- this
    // avoids the same class of day-of-week fragility even where the current assertions don't
    // happen to exercise the send_queue claim query's earliestSendAt <= now filter.
    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
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
    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaignRepository = new SqliteCampaignRepository(db);
    const campaign = await campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    campaignId = campaign.id;

    eventRepository = new SqliteEventRepository(db);
    deps = {
      db,
      campaignRepository,
      eventRepository,
      campaignMetricsRollupRepository: new SqliteCampaignMetricsRollupRepository(db),
      accountMetricsRollupRepository: new SqliteAccountMetricsRollupRepository(db)
    };
  });

  it("computes campaign and account rollups from real recorded events", async () => {
    const now = new Date();
    await eventRepository.record({
      eventType: "sent",
      campaignId: asCampaignId(campaignId),
      accountId: asAccountId(accountId),
      occurredAt: now
    });
    await eventRepository.record({
      eventType: "replied",
      campaignId: asCampaignId(campaignId),
      accountId: asAccountId(accountId),
      occurredAt: now
    });

    const result = await computeRollups(deps, now);
    expect(result).toEqual({ campaignsProcessed: 1, accountsProcessed: 1 });

    const campaignRollups = await deps.campaignMetricsRollupRepository.findInWindow(
      asCampaignId(campaignId),
      new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
      new Date(now.getTime() + 60 * 1000)
    );
    expect(campaignRollups).toHaveLength(1);
    expect(campaignRollups[0]?.sentCount).toBe(1);
    expect(campaignRollups[0]?.repliedCount).toBe(1);

    const accountRollups = await deps.accountMetricsRollupRepository.findInWindow(
      asAccountId(accountId),
      new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
      new Date(now.getTime() + 60 * 1000)
    );
    expect(accountRollups).toHaveLength(1);
    expect(accountRollups[0]?.sentCount).toBe(1);
  });

  it("excludes events older than the rollup lookback window", async () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // well past the 35-day lookback
    await eventRepository.record({ eventType: "sent", campaignId: asCampaignId(campaignId), occurredAt: longAgo });

    await computeRollups(deps, now);

    const campaignRollups = await deps.campaignMetricsRollupRepository.findInWindow(
      asCampaignId(campaignId),
      new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000),
      new Date(now.getTime() + 60 * 1000)
    );
    expect(campaignRollups).toEqual([]);
  });

  it("returns zero-processed counts when there are no campaigns/accounts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-compute-rollups-empty-test-"));
    const emptyDb = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    const emptyDeps: ComputeRollupsDeps = {
      db: emptyDb,
      campaignRepository: new SqliteCampaignRepository(emptyDb),
      eventRepository: new SqliteEventRepository(emptyDb),
      campaignMetricsRollupRepository: new SqliteCampaignMetricsRollupRepository(emptyDb),
      accountMetricsRollupRepository: new SqliteAccountMetricsRollupRepository(emptyDb)
    };
    expect(await computeRollups(emptyDeps, new Date())).toEqual({ campaignsProcessed: 0, accountsProcessed: 0 });
  });
});
