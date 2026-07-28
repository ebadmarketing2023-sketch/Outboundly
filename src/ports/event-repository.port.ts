import type { AccountId, CampaignId, EventId, MessageId } from "../core/shared-kernel/ids.js";

export type EventType =
  | "sent"
  | "bounced"
  | "replied"
  | "positive_reply"
  | "unsubscribed"
  | "conversion"
  // No emitter records these two (Section 20's open/click tracking needs a publicly reachable
  // server to receive a pixel/redirect hit, which a local desktop app doesn't have) -- kept only
  // so the event type space matches the documented shape for when that changes.
  | "opened"
  | "clicked";

export interface RecordEventInput {
  eventType: EventType;
  messageId?: MessageId;
  campaignId?: CampaignId;
  accountId?: AccountId;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface EventRecord {
  id: EventId;
  eventType: EventType;
  messageId?: MessageId;
  campaignId?: CampaignId;
  accountId?: AccountId;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

/** The immutable write side of Analytics & Insights (Section 5.9, Section 20.1) -- dashboards and
 * the Insights Engine never query this at read time; a background worker periodically recomputes
 * the rollup tables from it (Section 20.1), which stay the only thing actually queried live. */
export interface EventRepository {
  record(input: RecordEventInput): Promise<EventRecord>;
  findByCampaignInWindow(campaignId: CampaignId, since: Date, until: Date): Promise<EventRecord[]>;
  findByAccountInWindow(accountId: AccountId, since: Date, until: Date): Promise<EventRecord[]>;
}
