import { describe, expect, it } from "vitest";
import {
  bounceRate,
  computeDailyRollupBuckets,
  deliveryRate,
  emptyMetricCounts,
  positiveReplyRate,
  replyRate,
  sumMetricCounts
} from "../../src/core/analytics/rollup.js";

describe("computeDailyRollupBuckets (Section 20.1)", () => {
  it("returns an empty array for no events", () => {
    expect(computeDailyRollupBuckets([])).toEqual([]);
  });

  it("buckets events into their UTC calendar day", () => {
    const buckets = computeDailyRollupBuckets([
      { eventType: "sent", occurredAt: new Date("2026-01-01T23:59:00.000Z") },
      { eventType: "sent", occurredAt: new Date("2026-01-02T00:01:00.000Z") }
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.periodStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(buckets[0]?.sentCount).toBe(1);
    expect(buckets[1]?.periodStart.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(buckets[1]?.sentCount).toBe(1);
  });

  it("counts every event type into its own column within the same day", () => {
    const day = new Date("2026-01-01T10:00:00.000Z");
    const buckets = computeDailyRollupBuckets([
      { eventType: "sent", occurredAt: day },
      { eventType: "sent", occurredAt: day },
      { eventType: "bounced", occurredAt: day },
      { eventType: "replied", occurredAt: day },
      { eventType: "positive_reply", occurredAt: day },
      { eventType: "unsubscribed", occurredAt: day },
      { eventType: "conversion", occurredAt: day }
    ]);
    expect(buckets).toEqual([
      {
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        sentCount: 2,
        bouncedCount: 1,
        repliedCount: 1,
        positiveReplyCount: 1,
        unsubscribedCount: 1,
        conversionCount: 1,
        openedCount: 0,
        clickedCount: 0
      }
    ]);
  });

  it("sorts buckets oldest first regardless of input order", () => {
    const buckets = computeDailyRollupBuckets([
      { eventType: "sent", occurredAt: new Date("2026-01-05T00:00:00.000Z") },
      { eventType: "sent", occurredAt: new Date("2026-01-01T00:00:00.000Z") },
      { eventType: "sent", occurredAt: new Date("2026-01-03T00:00:00.000Z") }
    ]);
    expect(buckets.map((b) => b.periodStart.toISOString())).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z"
    ]);
  });
});

describe("sumMetricCounts", () => {
  it("sums every column across multiple buckets", () => {
    const total = sumMetricCounts([
      { ...emptyMetricCounts(), sentCount: 10, bouncedCount: 1 },
      { ...emptyMetricCounts(), sentCount: 5, bouncedCount: 2 }
    ]);
    expect(total.sentCount).toBe(15);
    expect(total.bouncedCount).toBe(3);
  });

  it("returns all-zero for an empty list", () => {
    expect(sumMetricCounts([])).toEqual(emptyMetricCounts());
  });
});

describe("primary metric rates (Section 20.2)", () => {
  it("returns undefined for every rate when there is no send volume, not a misleading 0%", () => {
    const counts = emptyMetricCounts();
    expect(replyRate(counts)).toBeUndefined();
    expect(positiveReplyRate(counts)).toBeUndefined();
    expect(bounceRate(counts)).toBeUndefined();
    expect(deliveryRate(counts)).toBeUndefined();
  });

  it("computes reply/positive-reply/bounce rate as a fraction of sends", () => {
    const counts = { ...emptyMetricCounts(), sentCount: 10, repliedCount: 3, positiveReplyCount: 1, bouncedCount: 2 };
    expect(replyRate(counts)).toBeCloseTo(0.3);
    expect(positiveReplyRate(counts)).toBeCloseTo(0.1);
    expect(bounceRate(counts)).toBeCloseTo(0.2);
  });

  it("computes delivery rate as (sent - bounced) / sent, floored at zero", () => {
    expect(deliveryRate({ ...emptyMetricCounts(), sentCount: 10, bouncedCount: 3 })).toBeCloseTo(0.7);
    // Pathological case (more bounces recorded than sends, e.g. from overlapping windows) should
    // never produce a negative rate.
    expect(deliveryRate({ ...emptyMetricCounts(), sentCount: 5, bouncedCount: 10 })).toBe(0);
  });
});
