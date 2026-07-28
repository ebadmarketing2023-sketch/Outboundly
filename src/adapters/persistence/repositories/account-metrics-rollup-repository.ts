import { and, eq, gte, lte } from "drizzle-orm";
import type { DailyRollupBucket } from "../../../core/analytics/rollup.js";
import { asAccountId, generateId, type AccountId } from "../../../core/shared-kernel/ids.js";
import type { AccountMetricsRollupRepository, AccountMetricsRollupRow } from "../../../ports/account-metrics-rollup.port.js";
import type { OutboundlyDb } from "../db.js";
import { accountMetricsRollup } from "../schema.js";

type RollupRow = typeof accountMetricsRollup.$inferSelect;

function toDomain(row: RollupRow): AccountMetricsRollupRow {
  return {
    accountId: asAccountId(row.accountId),
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

/** SQLite-backed implementation of AccountMetricsRollupRepository (Section 5.9, Section 20.1). */
export class SqliteAccountMetricsRollupRepository implements AccountMetricsRollupRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async upsertBuckets(accountId: AccountId, buckets: DailyRollupBucket[], computedAt: Date): Promise<void> {
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
        .insert(accountMetricsRollup)
        .values({ id: generateId(), accountId, periodStart: bucket.periodStart, ...values })
        .onConflictDoUpdate({ target: [accountMetricsRollup.accountId, accountMetricsRollup.periodStart], set: values })
        .run();
    }
  }

  async findInWindow(accountId: AccountId, since: Date, until: Date): Promise<AccountMetricsRollupRow[]> {
    return this.db
      .select()
      .from(accountMetricsRollup)
      .where(
        and(
          eq(accountMetricsRollup.accountId, accountId),
          gte(accountMetricsRollup.periodStart, since),
          lte(accountMetricsRollup.periodStart, until)
        )
      )
      .all()
      .map(toDomain);
  }
}
