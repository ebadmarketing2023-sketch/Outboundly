import { computeDailyRollupBuckets } from "../../core/analytics/rollup.js";
import { asAccountId } from "../../core/shared-kernel/ids.js";
import type { AccountMetricsRollupRepository } from "../../ports/account-metrics-rollup.port.js";
import type { CampaignMetricsRollupRepository } from "../../ports/campaign-metrics-rollup.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EventRepository } from "../../ports/event-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { accounts } from "./schema.js";

// Covers week-over-week trend comparisons (Section 20.3) with a buffer, while bounding how much
// gets recomputed on every tick rather than replaying all-time history each time.
const ROLLUP_LOOKBACK_DAYS = 35;

export interface ComputeRollupsDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  eventRepository: EventRepository;
  campaignMetricsRollupRepository: CampaignMetricsRollupRepository;
  accountMetricsRollupRepository: AccountMetricsRollupRepository;
}

export interface ComputeRollupsResult {
  campaignsProcessed: number;
  accountsProcessed: number;
}

/**
 * Analytics rollup worker (Section 21.1): recomputes the campaign/account rollup tables from the
 * events log for a bounded trailing window. A full, idempotent recompute of that window every
 * tick, not an incremental update — matching Section 20.1's "materialized aggregates ... never
 * the analytics source of truth," so a bug here can never compound across ticks the way an
 * incremental += could.
 *
 * Only campaign and account rollups are computed here. Template/subject rollups (Section 5.9)
 * are deliberately deferred: their tables exist, but correctly attributing every event type
 * (not just 'sent') to a template/subject would need resolving it via a messages-table join for
 * events that don't carry template/subject context directly, which is real additional design
 * work this pass doesn't include.
 */
export async function computeRollups(deps: ComputeRollupsDeps, now: Date): Promise<ComputeRollupsResult> {
  const since = new Date(now.getTime() - ROLLUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const campaigns = await deps.campaignRepository.list();
  for (const campaign of campaigns) {
    const events = await deps.eventRepository.findByCampaignInWindow(campaign.id, since, now);
    const buckets = computeDailyRollupBuckets(events);
    await deps.campaignMetricsRollupRepository.upsertBuckets(campaign.id, buckets, now);
  }

  const accountRows = deps.db.select().from(accounts).all();
  for (const row of accountRows) {
    const accountId = asAccountId(row.id);
    const events = await deps.eventRepository.findByAccountInWindow(accountId, since, now);
    const buckets = computeDailyRollupBuckets(events);
    await deps.accountMetricsRollupRepository.upsertBuckets(accountId, buckets, now);
  }

  return { campaignsProcessed: campaigns.length, accountsProcessed: accountRows.length };
}
