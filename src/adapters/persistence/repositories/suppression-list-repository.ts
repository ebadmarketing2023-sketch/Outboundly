import { eq } from "drizzle-orm";
import { generateId } from "../../../core/shared-kernel/ids.js";
import type { SuppressionEntry, SuppressionListRepository, SuppressionReason } from "../../../ports/suppression-list.port.js";
import type { OutboundlyDb } from "../db.js";
import { suppressionList as suppressionListTable } from "../schema.js";

/** SQLite-backed implementation of SuppressionListRepository (Section 5.5). */
export class SqliteSuppressionListRepository implements SuppressionListRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async isSuppressed(email: string): Promise<boolean> {
    const row = this.db
      .select()
      .from(suppressionListTable)
      .where(eq(suppressionListTable.email, email.toLowerCase()))
      .get();
    return Boolean(row);
  }

  async add(email: string, reason: SuppressionReason): Promise<void> {
    const normalized = email.toLowerCase();
    if (await this.isSuppressed(normalized)) return;
    this.db
      .insert(suppressionListTable)
      .values({ id: generateId(), email: normalized, reason, createdAt: new Date() })
      .run();
  }

  async list(): Promise<SuppressionEntry[]> {
    return this.db
      .select()
      .from(suppressionListTable)
      .all()
      .map((row) => ({
        id: row.id,
        email: row.email,
        reason: row.reason as SuppressionReason,
        createdAt: row.createdAt
      }));
  }
}
