import { and, eq, gte, lte } from "drizzle-orm";
import { asAccountId, asCampaignId, asEventId, asMessageId, generateId } from "../../../core/shared-kernel/ids.js";
import type { AccountId, CampaignId } from "../../../core/shared-kernel/ids.js";
import type { EventRecord, EventRepository, EventType, RecordEventInput } from "../../../ports/event-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { events } from "../schema.js";

type EventRow = typeof events.$inferSelect;

function toDomain(row: EventRow): EventRecord {
  return {
    id: asEventId(row.id),
    eventType: row.eventType as EventType,
    messageId: row.messageId ? asMessageId(row.messageId) : undefined,
    campaignId: row.campaignId ? asCampaignId(row.campaignId) : undefined,
    accountId: row.accountId ? asAccountId(row.accountId) : undefined,
    occurredAt: row.occurredAt,
    metadata: (row.metadataJson as Record<string, unknown> | null) ?? undefined
  };
}

/** SQLite-backed implementation of EventRepository (Section 5.9, Section 20.1). */
export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async record(input: RecordEventInput): Promise<EventRecord> {
    const id = generateId();
    this.db
      .insert(events)
      .values({
        id,
        eventType: input.eventType,
        messageId: input.messageId,
        campaignId: input.campaignId,
        accountId: input.accountId,
        occurredAt: input.occurredAt,
        metadataJson: input.metadata
      })
      .run();
    const row = this.db.select().from(events).where(eq(events.id, id)).get();
    return toDomain(row!);
  }

  async findByCampaignInWindow(campaignId: CampaignId, since: Date, until: Date): Promise<EventRecord[]> {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.campaignId, campaignId), gte(events.occurredAt, since), lte(events.occurredAt, until)))
      .all()
      .map(toDomain);
  }

  async findByAccountInWindow(accountId: AccountId, since: Date, until: Date): Promise<EventRecord[]> {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.accountId, accountId), gte(events.occurredAt, since), lte(events.occurredAt, until)))
      .all()
      .map(toDomain);
  }
}
