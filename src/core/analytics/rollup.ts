import type { EventType } from "../../ports/event-repository.port.js";

/**
 * Rollup computation (Section 20.1): pure aggregation from a list of raw events into daily
 * buckets — the actual database round-trip (fetching events, upserting rollup rows) lives in the
 * application layer, so this stays testable without a database.
 */

export interface MetricCounts {
  sentCount: number;
  bouncedCount: number;
  repliedCount: number;
  positiveReplyCount: number;
  unsubscribedCount: number;
  conversionCount: number;
  // No emitter records these two yet (Section 20's open/click tracking needs a publicly
  // reachable server this local desktop app doesn't have) -- kept so the shape matches the
  // documented schema for when that changes, always zero today.
  openedCount: number;
  clickedCount: number;
}

export interface DailyRollupBucket extends MetricCounts {
  /** UTC calendar-day boundary (midnight) this bucket covers. */
  periodStart: Date;
}

export function emptyMetricCounts(): MetricCounts {
  return {
    sentCount: 0,
    bouncedCount: 0,
    repliedCount: 0,
    positiveReplyCount: 0,
    unsubscribedCount: 0,
    conversionCount: 0,
    openedCount: 0,
    clickedCount: 0
  };
}

const EVENT_TYPE_TO_COUNT_KEY: Partial<Record<EventType, keyof MetricCounts>> = {
  sent: "sentCount",
  bounced: "bouncedCount",
  replied: "repliedCount",
  positive_reply: "positiveReplyCount",
  unsubscribed: "unsubscribedCount",
  conversion: "conversionCount",
  opened: "openedCount",
  clicked: "clickedCount"
};

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Buckets a flat list of events into one row per UTC calendar day, sorted oldest first. A day
 * with zero events simply produces no bucket — the caller treats "no rollup row" as all-zero,
 * matching Section 20.1's "fully recomputable, never authoritative" rollup semantics. */
export function computeDailyRollupBuckets(events: { eventType: EventType; occurredAt: Date }[]): DailyRollupBucket[] {
  const byDay = new Map<number, MetricCounts>();

  for (const event of events) {
    const periodStartMs = utcDayStart(event.occurredAt).getTime();
    const counts = byDay.get(periodStartMs) ?? emptyMetricCounts();
    const countKey = EVENT_TYPE_TO_COUNT_KEY[event.eventType];
    if (countKey) counts[countKey]++;
    byDay.set(periodStartMs, counts);
  }

  return [...byDay.entries()]
    .map(([periodStartMs, counts]) => ({ periodStart: new Date(periodStartMs), ...counts }))
    .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
}

export function sumMetricCounts(buckets: MetricCounts[]): MetricCounts {
  const total = emptyMetricCounts();
  for (const bucket of buckets) {
    total.sentCount += bucket.sentCount;
    total.bouncedCount += bucket.bouncedCount;
    total.repliedCount += bucket.repliedCount;
    total.positiveReplyCount += bucket.positiveReplyCount;
    total.unsubscribedCount += bucket.unsubscribedCount;
    total.conversionCount += bucket.conversionCount;
    total.openedCount += bucket.openedCount;
    total.clickedCount += bucket.clickedCount;
  }
  return total;
}

/** Primary metrics (Section 20.2) -- undefined when there's no send volume to compute a rate
 * against, rather than a misleading 0%. */
export function replyRate(counts: MetricCounts): number | undefined {
  return counts.sentCount === 0 ? undefined : counts.repliedCount / counts.sentCount;
}

export function positiveReplyRate(counts: MetricCounts): number | undefined {
  return counts.sentCount === 0 ? undefined : counts.positiveReplyCount / counts.sentCount;
}

export function bounceRate(counts: MetricCounts): number | undefined {
  return counts.sentCount === 0 ? undefined : counts.bouncedCount / counts.sentCount;
}

/** No real delivery-confirmation signal exists (no DSN success receipts) -- approximated as
 * "sent and not (yet) bounced," per this module's own documented limitation. */
export function deliveryRate(counts: MetricCounts): number | undefined {
  return counts.sentCount === 0 ? undefined : Math.max(0, counts.sentCount - counts.bouncedCount) / counts.sentCount;
}
