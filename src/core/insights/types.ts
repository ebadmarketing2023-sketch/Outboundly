import type { DailyRollupBucket, MetricCounts } from "../analytics/rollup.js";

/**
 * Section 20.3: the Insights Engine sits between Rollups and the Dashboard, turning raw aggregate
 * deltas into causally-linked, explained observations. Built on the same rule-registry pattern as
 * the Deliverability Engine (src/core/deliverability) and Gmail Compatibility Layer for
 * consistency: a registry of pure, synchronous rules, each pattern-matching over rollup data and
 * emitting zero or more Insights with a severity, a plain-language explanation, and (where one
 * exists) a recommended action.
 */

export type InsightSeverity = "info" | "warning" | "critical";
export type InsightScope = "campaign" | "account";

export interface Insight {
  insightType: string;
  severity: InsightSeverity;
  message: string;
  explanation: string;
  recommendedAction?: string;
}

/**
 * What an Insight Rule evaluates against, for one scope (a single campaign or account) at one
 * point in time.
 *
 * `current`/`previous` are equal-length trailing windows (e.g. the last 7 days vs. the 7 days
 * before that) for week-over-week trend and threshold-warning rules. `dailyHistory` is the full
 * daily series backing those two windows (oldest first, per computeDailyRollupBuckets), used by
 * anomaly detection to establish a baseline mean/stdev — trend/warning rules don't need it.
 */
export interface InsightContext {
  scope: InsightScope;
  scopeId: string;
  current: MetricCounts;
  previous: MetricCounts;
  dailyHistory: DailyRollupBucket[];
}

export interface InsightRule {
  id: string;
  evaluate(ctx: InsightContext): Insight[];
}
