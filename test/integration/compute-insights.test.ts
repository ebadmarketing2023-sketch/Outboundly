import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { computeInsights, type ComputeInsightsDeps } from "../../src/adapters/persistence/compute-insights.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountMetricsRollupRepository } from "../../src/adapters/persistence/repositories/account-metrics-rollup-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignMetricsRollupRepository } from "../../src/adapters/persistence/repositories/campaign-metrics-rollup-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteInsightRepository } from "../../src/adapters/persistence/repositories/insight-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asCampaignId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("computeInsights (Section 20.3, Section 21.1 Insights worker)", () => {
  let db: OutboundlyDb;
  let deps: ComputeInsightsDeps;
  let campaignId: string;
  let accountId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-compute-insights-test-"));
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

    deps = {
      db,
      campaignRepository,
      campaignMetricsRollupRepository: new SqliteCampaignMetricsRollupRepository(db),
      accountMetricsRollupRepository: new SqliteAccountMetricsRollupRepository(db),
      insightRepository: new SqliteInsightRepository(db)
    };
  });

  it("records a bounce-rate-ceiling insight from real campaign rollup data", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    await deps.campaignMetricsRollupRepository.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart: now, sentCount: 20, bouncedCount: 1, repliedCount: 2, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      now
    );

    const result = await computeInsights(deps, now);
    expect(result.campaignsProcessed).toBe(1);
    expect(result.accountsProcessed).toBe(1);
    expect(result.insightsRecorded).toBeGreaterThanOrEqual(1);

    const active = await deps.insightRepository.findActiveForScope("campaign", campaignId);
    const bounceInsight = active.find((i) => i.insightType === "bounce_rate_ceiling");
    expect(bounceInsight).toBeDefined();
    expect(bounceInsight?.severity).toBe("warning");
  });

  it("records an account-scoped insight from real account rollup data", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    await deps.accountMetricsRollupRepository.upsertBuckets(
      asAccountId(accountId),
      [{ periodStart: now, sentCount: 20, bouncedCount: 3, repliedCount: 1, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      now
    );

    await computeInsights(deps, now);

    const active = await deps.insightRepository.findActiveForScope("account", accountId);
    expect(active.some((i) => i.insightType === "bounce_rate_ceiling" && i.severity === "critical")).toBe(true);
  });

  it("does not duplicate an already-active insight on a repeated tick", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    await deps.campaignMetricsRollupRepository.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart: now, sentCount: 20, bouncedCount: 1, repliedCount: 2, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      now
    );

    const first = await computeInsights(deps, now);
    expect(first.insightsRecorded).toBeGreaterThanOrEqual(1);

    const second = await computeInsights(deps, now);
    expect(second.insightsRecorded).toBe(0);

    const active = await deps.insightRepository.findActiveForScope("campaign", campaignId);
    expect(active.filter((i) => i.insightType === "bounce_rate_ceiling")).toHaveLength(1);
  });

  it("allows an insight to resurface after being dismissed", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    await deps.campaignMetricsRollupRepository.upsertBuckets(
      asCampaignId(campaignId),
      [{ periodStart: now, sentCount: 20, bouncedCount: 1, repliedCount: 2, positiveReplyCount: 0, unsubscribedCount: 0, conversionCount: 0, openedCount: 0, clickedCount: 0 }],
      now
    );
    await computeInsights(deps, now);
    const [active] = await deps.insightRepository.findActiveForScope("campaign", campaignId);
    await deps.insightRepository.dismiss(active!.id);

    const result = await computeInsights(deps, now);
    expect(result.insightsRecorded).toBeGreaterThanOrEqual(1);
    const activeAfter = await deps.insightRepository.findActiveForScope("campaign", campaignId);
    expect(activeAfter.some((i) => i.insightType === "bounce_rate_ceiling")).toBe(true);
  });

  it("returns zero-processed counts when there are no campaigns/accounts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-compute-insights-empty-test-"));
    const emptyDb = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    const emptyDeps: ComputeInsightsDeps = {
      db: emptyDb,
      campaignRepository: new SqliteCampaignRepository(emptyDb),
      campaignMetricsRollupRepository: new SqliteCampaignMetricsRollupRepository(emptyDb),
      accountMetricsRollupRepository: new SqliteAccountMetricsRollupRepository(emptyDb),
      insightRepository: new SqliteInsightRepository(emptyDb)
    };
    expect(await computeInsights(emptyDeps, new Date())).toEqual({ campaignsProcessed: 0, accountsProcessed: 0, insightsRecorded: 0 });
  });
});
