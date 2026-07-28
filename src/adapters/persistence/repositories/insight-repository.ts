import { and, desc, eq, isNull } from "drizzle-orm";
import { asInsightId, generateId, type InsightId } from "../../../core/shared-kernel/ids.js";
import type { InsightScope } from "../../../core/insights/types.js";
import type { InsightRecord, InsightRepository, RecordInsightInput } from "../../../ports/insight-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { insights } from "../schema.js";

type InsightRow = typeof insights.$inferSelect;

function toDomain(row: InsightRow): InsightRecord {
  return {
    id: asInsightId(row.id),
    scope: row.scope as InsightScope,
    scopeId: row.scopeId ?? undefined,
    insightType: row.insightType,
    severity: row.severity as InsightRecord["severity"],
    message: row.message,
    explanation: row.explanation,
    recommendedAction: row.recommendedAction ?? undefined,
    generatedAt: row.generatedAt,
    dismissedAt: row.dismissedAt ?? undefined
  };
}

/** SQLite-backed implementation of InsightRepository (Section 5.9, Section 20.3). */
export class SqliteInsightRepository implements InsightRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async record(input: RecordInsightInput): Promise<InsightRecord> {
    const id = generateId();
    this.db
      .insert(insights)
      .values({
        id,
        scope: input.scope,
        scopeId: input.scopeId,
        insightType: input.insightType,
        severity: input.severity,
        message: input.message,
        explanation: input.explanation,
        recommendedAction: input.recommendedAction,
        generatedAt: input.generatedAt
      })
      .run();
    const row = this.db.select().from(insights).where(eq(insights.id, id)).get();
    return toDomain(row!);
  }

  async findActiveForScope(scope: InsightScope, scopeId: string): Promise<InsightRecord[]> {
    return this.db
      .select()
      .from(insights)
      .where(and(eq(insights.scope, scope), eq(insights.scopeId, scopeId), isNull(insights.dismissedAt)))
      .orderBy(desc(insights.generatedAt))
      .all()
      .map(toDomain);
  }

  async findActiveFeed(limit: number): Promise<InsightRecord[]> {
    return this.db
      .select()
      .from(insights)
      .where(isNull(insights.dismissedAt))
      .orderBy(desc(insights.generatedAt))
      .limit(limit)
      .all()
      .map(toDomain);
  }

  async dismiss(id: InsightId): Promise<void> {
    this.db.update(insights).set({ dismissedAt: new Date() }).where(eq(insights.id, id)).run();
  }
}
