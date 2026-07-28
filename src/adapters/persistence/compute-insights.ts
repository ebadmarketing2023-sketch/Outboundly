import { sumMetricCounts } from "../../core/analytics/rollup.js";
import type { DailyRollupBucket } from "../../core/analytics/rollup.js";
import { evaluateInsights } from "../../core/insights/engine.js";
import type { InsightScope } from "../../core/insights/types.js";
import { asAccountId } from "../../core/shared-kernel/ids.js";
import type { AccountMetricsRollupRepository } from "../../ports/account-metrics-rollup.port.js";
import type { CampaignMetricsRollupRepository } from "../../ports/campaign-metrics-rollup.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { InsightRepository } from "../../ports/insight-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { accounts } from "./schema.js";

// Section 20.3's own worked example is a week-over-week comparison, so "current"/"previous" are
// both 7-day windows.
const TREND_WINDOW_DAYS = 7;
// Anomaly detection needs more than two data points to establish a baseline (Section 20.3's
// z-score requirement) -- two trend windows' worth of daily buckets covers that comfortably.
const ANOMALY_HISTORY_DAYS = TREND_WINDOW_DAYS * 2;

export interface ComputeInsightsDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  campaignMetricsRollupRepository: CampaignMetricsRollupRepository;
  accountMetricsRollupRepository: AccountMetricsRollupRepository;
  insightRepository: InsightRepository;
}

export interface ComputeInsightsResult {
  campaignsProcessed: number;
  accountsProcessed: number;
  insightsRecorded: number;
}

interface ScopedRollupRepository<Id> {
  findInWindow(scopeId: Id, since: Date, until: Date): Promise<DailyRollupBucket[]>;
}

async function computeForScope<Id>(
  scope: InsightScope,
  scopeId: Id,
  scopeIdAsString: string,
  rollupRepository: ScopedRollupRepository<Id>,
  insightRepository: InsightRepository,
  now: Date
): Promise<number> {
  const historyStart = new Date(now.getTime() - ANOMALY_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const dailyHistory = [...(await rollupRepository.findInWindow(scopeId, historyStart, now))].sort(
    (a, b) => a.periodStart.getTime() - b.periodStart.getTime()
  );

  const currentWindowStart = new Date(now.getTime() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const previousWindowStart = new Date(now.getTime() - 2 * TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const current = sumMetricCounts(dailyHistory.filter((b) => b.periodStart.getTime() >= currentWindowStart.getTime()));
  const previous = sumMetricCounts(
    dailyHistory.filter(
      (b) => b.periodStart.getTime() >= previousWindowStart.getTime() && b.periodStart.getTime() < currentWindowStart.getTime()
    )
  );

  const freshInsights = evaluateInsights({ scope, scopeId: scopeIdAsString, current, previous, dailyHistory });

  // Recomputing every tick would otherwise re-record the same still-true insight over and over --
  // an insight type already active (not yet dismissed) for this exact scope is left alone rather
  // than duplicated. Once dismissed, it's free to resurface on a later tick if the condition
  // recurs, which is the point of dismissal (acknowledged, not permanently silenced).
  const active = await insightRepository.findActiveForScope(scope, scopeIdAsString);
  const activeTypes = new Set(active.map((i) => i.insightType));

  let recorded = 0;
  for (const insight of freshInsights) {
    if (activeTypes.has(insight.insightType)) continue;
    await insightRepository.record({ scope, scopeId: scopeIdAsString, ...insight, generatedAt: now });
    recorded++;
  }
  return recorded;
}

/**
 * Insights worker (Section 21.1): "Fixed interval, after rollups. Runs the Insight Rule registry
 * against fresh rollups." Reads only the already-materialized rollup tables (never the events log
 * directly, per Section 20.1), builds each scope's InsightContext, and persists whatever the rule
 * registry flags that isn't already an active insight for that scope.
 */
export async function computeInsights(deps: ComputeInsightsDeps, now: Date): Promise<ComputeInsightsResult> {
  let insightsRecorded = 0;

  const campaigns = await deps.campaignRepository.list();
  for (const campaign of campaigns) {
    insightsRecorded += await computeForScope(
      "campaign",
      campaign.id,
      campaign.id,
      deps.campaignMetricsRollupRepository,
      deps.insightRepository,
      now
    );
  }

  const accountRows = deps.db.select().from(accounts).all();
  for (const row of accountRows) {
    const accountId = asAccountId(row.id);
    insightsRecorded += await computeForScope(
      "account",
      accountId,
      row.id,
      deps.accountMetricsRollupRepository,
      deps.insightRepository,
      now
    );
  }

  return { campaignsProcessed: campaigns.length, accountsProcessed: accountRows.length, insightsRecorded };
}
