import type { InsightId } from "../core/shared-kernel/ids.js";
import type { InsightScope, InsightSeverity } from "../core/insights/types.js";

export interface RecordInsightInput {
  scope: InsightScope;
  scopeId?: string;
  insightType: string;
  severity: InsightSeverity;
  message: string;
  explanation: string;
  recommendedAction?: string;
  generatedAt: Date;
}

export interface InsightRecord extends RecordInsightInput {
  id: InsightId;
  dismissedAt?: Date;
}

/** Persistence for the Insights Engine's output (Section 5.9, Section 20.3). */
export interface InsightRepository {
  record(input: RecordInsightInput): Promise<InsightRecord>;
  /** Non-dismissed insights for one scope instance, newest first -- used both by the worker to
   * avoid re-recording an insight type that's already active, and by the dashboard's per-scope
   * insight panel. */
  findActiveForScope(scope: InsightScope, scopeId: string): Promise<InsightRecord[]>;
  /** The global insights feed (Section 20.5): non-dismissed insights across all scopes, newest
   * first. */
  findActiveFeed(limit: number): Promise<InsightRecord[]>;
  dismiss(id: InsightId): Promise<void>;
}
