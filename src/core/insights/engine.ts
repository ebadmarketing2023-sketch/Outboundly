import { INSIGHT_RULES } from "./rules.js";
import type { Insight, InsightContext, InsightRule } from "./types.js";

/** The Insights Engine's entry point (Section 20.3): runs every registered Insight Rule against
 * one scope's rollup data and returns whatever findings surfaced. Pure and I/O-free, matching the
 * Deliverability Engine's `evaluate(ctx): Finding[]` shape — fetching rollups and persisting the
 * results is the application layer's job (src/application/analytics). */
export function evaluateInsights(ctx: InsightContext, rules: InsightRule[] = INSIGHT_RULES): Insight[] {
  return rules.flatMap((rule) => rule.evaluate(ctx));
}
