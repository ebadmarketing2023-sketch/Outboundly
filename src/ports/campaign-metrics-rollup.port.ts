import type { DailyRollupBucket } from "../core/analytics/rollup.js";
import type { CampaignId } from "../core/shared-kernel/ids.js";

export interface CampaignMetricsRollupRow extends DailyRollupBucket {
  campaignId: CampaignId;
  computedAt: Date;
}

/** Materialized read side for campaign-scoped analytics (Section 5.9, Section 20.1). */
export interface CampaignMetricsRollupRepository {
  /** Upserts one row per bucket, keyed on (campaignId, periodStart) -- recomputing an existing
   * day's bucket replaces it in place, matching "always regenerable from the events log, never
   * authoritative itself." */
  upsertBuckets(campaignId: CampaignId, buckets: DailyRollupBucket[], computedAt: Date): Promise<void>;
  findInWindow(campaignId: CampaignId, since: Date, until: Date): Promise<CampaignMetricsRollupRow[]>;
}
