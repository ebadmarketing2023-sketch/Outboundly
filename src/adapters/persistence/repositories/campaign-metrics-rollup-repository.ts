import { and, eq, gte, lte } from "drizzle-orm";
import type { DailyRollupBucket } from "../../../core/analytics/rollup.js";
import { asCampaignId, generateId, type CampaignId } from "../../../core/shared-kernel/ids.js";
import type { CampaignMetricsRollupRepository, CampaignMetricsRollupRow } from "../../../ports/campaign-metrics-rollup.port.js";
import type { OutboundlyDb } from "../db.js";
import { campaignMetricsRollup } from "../schema.js";

type RollupRow = typeof campaignMetricsRollup.$inferSelect;

function toDomain(row: RollupRow): CampaignMetricsRollupRow {
  return {
    campaignId: asCampaignId(row.campaignId),
    periodStart: row.periodStart,
    sentCount: row.sentCount,
    bouncedCount: row.bouncedCount,
    repliedCount: row.repliedCount,
    positiveReplyCount: row.positiveReplyCount,
    unsubscribedCount: row.unsubscribedCount,
    conversionCount: row.conversionCount,
    openedCount: row.openedCount,
    clickedCount: row.clickedCount,
    computedAt: row.computedAt
  };
}

/** SQLite-backed implementation of CampaignMetricsRollupRepository (Section 5.9, Section 20.1). */
export class SqliteCampaignMetricsRollupRepository implements CampaignMetricsRollupRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async upsertBuckets(campaignId: CampaignId, buckets: DailyRollupBucket[], computedAt: Date): Promise<void> {
    for (const bucket of buckets) {
      const values = {
        sentCount: bucket.sentCount,
        bouncedCount: bucket.bouncedCount,
        repliedCount: bucket.repliedCount,
        positiveReplyCount: bucket.positiveReplyCount,
        unsubscribedCount: bucket.unsubscribedCount,
        conversionCount: bucket.conversionCount,
        openedCount: bucket.openedCount,
        clickedCount: bucket.clickedCount,
        computedAt
      };
      this.db
        .insert(campaignMetricsRollup)
        .values({ id: generateId(), campaignId, periodStart: bucket.periodStart, ...values })
        .onConflictDoUpdate({ target: [campaignMetricsRollup.campaignId, campaignMetricsRollup.periodStart], set: values })
        .run();
    }
  }

  async findInWindow(campaignId: CampaignId, since: Date, until: Date): Promise<CampaignMetricsRollupRow[]> {
    return this.db
      .select()
      .from(campaignMetricsRollup)
      .where(
        and(
          eq(campaignMetricsRollup.campaignId, campaignId),
          gte(campaignMetricsRollup.periodStart, since),
          lte(campaignMetricsRollup.periodStart, until)
        )
      )
      .all()
      .map(toDomain);
  }
}
