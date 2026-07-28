import type { DailyRollupBucket } from "../core/analytics/rollup.js";
import type { AccountId } from "../core/shared-kernel/ids.js";

export interface AccountMetricsRollupRow extends DailyRollupBucket {
  accountId: AccountId;
  computedAt: Date;
}

/** Materialized read side for account-scoped analytics (Section 5.9, Section 20.1). */
export interface AccountMetricsRollupRepository {
  upsertBuckets(accountId: AccountId, buckets: DailyRollupBucket[], computedAt: Date): Promise<void>;
  findInWindow(accountId: AccountId, since: Date, until: Date): Promise<AccountMetricsRollupRow[]>;
}
