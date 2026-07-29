import { desc, eq } from "drizzle-orm";
import { asAccountId, asCampaignId, asErrorLogId, generateId } from "../../../core/shared-kernel/ids.js";
import type {
  ErrorLogRecord,
  ErrorLogRepository,
  ErrorLogSource,
  RecordErrorLogInput
} from "../../../ports/error-log-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { errorLogs } from "../schema.js";

type ErrorLogRow = typeof errorLogs.$inferSelect;

function toDomain(row: ErrorLogRow): ErrorLogRecord {
  return {
    id: asErrorLogId(row.id),
    occurredAt: row.occurredAt,
    source: row.source as ErrorLogSource,
    errorType: row.errorType,
    errorMessage: row.errorMessage,
    campaignId: row.campaignId ? asCampaignId(row.campaignId) : undefined,
    accountId: row.accountId ? asAccountId(row.accountId) : undefined,
    recipientEmail: row.recipientEmail ?? undefined,
    retryCount: row.retryCount ?? undefined
  };
}

/** SQLite-backed implementation of ErrorLogRepository (Critical Improvement #12). */
export class SqliteErrorLogRepository implements ErrorLogRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async record(input: RecordErrorLogInput): Promise<ErrorLogRecord> {
    const id = generateId();
    this.db
      .insert(errorLogs)
      .values({
        id,
        occurredAt: input.occurredAt,
        source: input.source,
        errorType: input.errorType,
        errorMessage: input.errorMessage,
        campaignId: input.campaignId,
        accountId: input.accountId,
        recipientEmail: input.recipientEmail,
        retryCount: input.retryCount
      })
      .run();
    const row = this.db.select().from(errorLogs).where(eq(errorLogs.id, id)).get();
    return toDomain(row!);
  }

  async listRecent(limit: number, source?: ErrorLogSource): Promise<ErrorLogRecord[]> {
    const rows = source
      ? this.db.select().from(errorLogs).where(eq(errorLogs.source, source)).orderBy(desc(errorLogs.occurredAt)).limit(limit).all()
      : this.db.select().from(errorLogs).orderBy(desc(errorLogs.occurredAt)).limit(limit).all();
    return rows.map(toDomain);
  }
}
