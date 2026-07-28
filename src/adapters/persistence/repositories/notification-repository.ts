import { desc, eq, isNull } from "drizzle-orm";
import { asAccountId, asCampaignId, asNotificationId, generateId, type NotificationId } from "../../../core/shared-kernel/ids.js";
import type {
  NotificationRecord,
  NotificationRepository,
  NotificationSeverity,
  NotificationType,
  RecordNotificationInput
} from "../../../ports/notification-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { notifications } from "../schema.js";

type NotificationRow = typeof notifications.$inferSelect;

function toDomain(row: NotificationRow): NotificationRecord {
  return {
    id: asNotificationId(row.id),
    notificationType: row.notificationType as NotificationType,
    severity: row.severity as NotificationSeverity,
    message: row.message,
    relatedAccountId: row.relatedAccountId ? asAccountId(row.relatedAccountId) : undefined,
    relatedCampaignId: row.relatedCampaignId ? asCampaignId(row.relatedCampaignId) : undefined,
    createdAt: row.createdAt,
    readAt: row.readAt ?? undefined
  };
}

/** SQLite-backed implementation of NotificationRepository (Section 3). */
export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async record(input: RecordNotificationInput): Promise<NotificationRecord> {
    const id = generateId();
    this.db
      .insert(notifications)
      .values({
        id,
        notificationType: input.notificationType,
        severity: input.severity,
        message: input.message,
        relatedAccountId: input.relatedAccountId,
        relatedCampaignId: input.relatedCampaignId,
        createdAt: input.createdAt
      })
      .run();
    const row = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    return toDomain(row!);
  }

  async findUnread(limit: number): Promise<NotificationRecord[]> {
    return this.db
      .select()
      .from(notifications)
      .where(isNull(notifications.readAt))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .all()
      .map(toDomain);
  }

  async markRead(id: NotificationId): Promise<void> {
    this.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, id)).run();
  }
}
