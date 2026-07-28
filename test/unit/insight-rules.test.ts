import { describe, expect, it } from "vitest";
import { emptyMetricCounts } from "../../src/core/analytics/rollup.js";
import type { DailyRollupBucket, MetricCounts } from "../../src/core/analytics/rollup.js";
import { INSIGHT_RULES } from "../../src/core/insights/rules.js";
import type { Insight, InsightContext, InsightRule } from "../../src/core/insights/types.js";

function counts(overrides: Partial<MetricCounts>): MetricCounts {
  return { ...emptyMetricCounts(), ...overrides };
}

function day(sentCount: number, overrides: Partial<MetricCounts> = {}): DailyRollupBucket {
  return { periodStart: new Date(), ...counts(overrides), sentCount };
}

function ctx(overrides: Partial<InsightContext>): InsightContext {
  return {
    scope: "campaign",
    scopeId: "camp-1",
    current: emptyMetricCounts(),
    previous: emptyMetricCounts(),
    dailyHistory: [],
    ...overrides
  };
}

function rule(id: string): InsightRule {
  const found = INSIGHT_RULES.find((r) => r.id === id);
  if (!found) throw new Error(`rule not registered: ${id}`);
  return found;
}

function messages(result: Insight[]): string[] {
  return result.map((i) => i.message);
}

describe("volumeAndReplyRateTrend (Section 20.3 trends)", () => {
  const trendRule = rule("volume_and_reply_rate_trend");

  it("stays silent below the minimum sample size", () => {
    expect(
      trendRule.evaluate(
        ctx({ current: counts({ sentCount: 5, repliedCount: 1 }), previous: counts({ sentCount: 5, repliedCount: 3 }) })
      )
    ).toEqual([]);
  });

  it("flags a correlated volume-up / reply-rate-down move with one causal insight", () => {
    // previous: 20 sent, 4 replied (20%); current: 28 sent (+40%), 2 replied (~7.1%, well past -30% relative)
    const result = trendRule.evaluate(
      ctx({ current: counts({ sentCount: 28, repliedCount: 2 }), previous: counts({ sentCount: 20, repliedCount: 4 }) })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("warning");
    expect(result[0]?.message).toMatch(/volume increased/i);
    expect(result[0]?.message).toMatch(/reply rate dropped/i);
  });

  it("flags a reply-rate decline on its own when volume didn't move", () => {
    const result = trendRule.evaluate(
      ctx({ current: counts({ sentCount: 20, repliedCount: 2 }), previous: counts({ sentCount: 20, repliedCount: 4 }) })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("warning");
    expect(result[0]?.message).not.toMatch(/volume/i);
  });

  it("reports an improving reply rate as info", () => {
    const result = trendRule.evaluate(
      ctx({ current: counts({ sentCount: 20, repliedCount: 6 }), previous: counts({ sentCount: 20, repliedCount: 2 }) })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("info");
    expect(result[0]?.message).toMatch(/improved/i);
  });

  it("reports a volume increase alone as info when reply rate holds roughly steady", () => {
    const result = trendRule.evaluate(
      ctx({ current: counts({ sentCount: 28, repliedCount: 5 }), previous: counts({ sentCount: 20, repliedCount: 4 }) })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("info");
    expect(result[0]?.message).toMatch(/volume increased/i);
  });

  it("reports a volume decrease as info", () => {
    const result = trendRule.evaluate(
      ctx({ current: counts({ sentCount: 10, repliedCount: 2 }), previous: counts({ sentCount: 20, repliedCount: 4 }) })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("info");
    expect(result[0]?.message).toMatch(/decreased/i);
  });

  it("stays silent when nothing moved significantly", () => {
    expect(
      trendRule.evaluate(
        ctx({ current: counts({ sentCount: 20, repliedCount: 4 }), previous: counts({ sentCount: 20, repliedCount: 4 }) })
      )
    ).toEqual([]);
  });
});

describe("bounceRateCeiling (Section 20.3 threshold warning)", () => {
  const bounceRule = rule("bounce_rate_ceiling");

  it("stays silent below the minimum sample size", () => {
    expect(bounceRule.evaluate(ctx({ current: counts({ sentCount: 5, bouncedCount: 3 }) }))).toEqual([]);
  });

  it("stays silent below the warning ceiling", () => {
    expect(bounceRule.evaluate(ctx({ current: counts({ sentCount: 100, bouncedCount: 3 }) }))).toEqual([]);
  });

  it("warns at the warning ceiling", () => {
    const result = bounceRule.evaluate(ctx({ current: counts({ sentCount: 100, bouncedCount: 6 }) }));
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("warning");
  });

  it("escalates to critical above the critical ceiling", () => {
    const result = bounceRule.evaluate(ctx({ current: counts({ sentCount: 100, bouncedCount: 12 }) }));
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("critical");
  });
});

describe("replyRateCliff anomaly detection (Section 20.3 z-score)", () => {
  const cliffRule = rule("reply_rate_cliff_anomaly");

  // mean 20% reply rate, real variance (sd ≈ 0.0447) across 6 baseline days
  const baseline = [
    day(20, { repliedCount: 4 }),
    day(20, { repliedCount: 5 }),
    day(20, { repliedCount: 3 }),
    day(20, { repliedCount: 4 }),
    day(20, { repliedCount: 5 }),
    day(20, { repliedCount: 3 })
  ];

  it("stays silent with no history", () => {
    expect(cliffRule.evaluate(ctx({ dailyHistory: [] }))).toEqual([]);
  });

  it("stays silent when today's volume is too small to trust", () => {
    const result = cliffRule.evaluate(ctx({ dailyHistory: [...baseline, day(2, { repliedCount: 0 })] }));
    expect(result).toEqual([]);
  });

  it("stays silent with an insufficient baseline (fewer than the minimum days)", () => {
    const result = cliffRule.evaluate(ctx({ dailyHistory: [...baseline.slice(0, 3), day(20, { repliedCount: 0 })] }));
    expect(result).toEqual([]);
  });

  it("stays silent when the baseline has zero variance (nothing to be an outlier against)", () => {
    const flatBaseline = Array.from({ length: 6 }, () => day(20, { repliedCount: 4 }));
    const result = cliffRule.evaluate(ctx({ dailyHistory: [...flatBaseline, day(20, { repliedCount: 0 })] }));
    expect(result).toEqual([]);
  });

  it("stays silent when today's rate is within normal range", () => {
    const result = cliffRule.evaluate(ctx({ dailyHistory: [...baseline, day(20, { repliedCount: 4 })] }));
    expect(result).toEqual([]);
  });

  it("flags a real statistical cliff as critical", () => {
    const result = cliffRule.evaluate(ctx({ dailyHistory: [...baseline, day(20, { repliedCount: 0 })] }));
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("critical");
    expect(messages(result)[0]).toMatch(/dropped sharply/i);
  });
});

describe("bounceRateSpike anomaly detection (Section 20.3 z-score)", () => {
  const spikeRule = rule("bounce_rate_spike_anomaly");

  // mean 5% bounce rate, real variance (sd ≈ 0.0447) across 6 baseline days
  const baseline = [
    day(20, { bouncedCount: 1 }),
    day(20, { bouncedCount: 2 }),
    day(20, { bouncedCount: 0 }),
    day(20, { bouncedCount: 1 }),
    day(20, { bouncedCount: 2 }),
    day(20, { bouncedCount: 0 })
  ];

  it("stays silent with no history", () => {
    expect(spikeRule.evaluate(ctx({ dailyHistory: [] }))).toEqual([]);
  });

  it("stays silent when today's rate is within normal range", () => {
    const result = spikeRule.evaluate(ctx({ dailyHistory: [...baseline, day(20, { bouncedCount: 1 })] }));
    expect(result).toEqual([]);
  });

  it("flags a real statistical spike as critical", () => {
    const result = spikeRule.evaluate(ctx({ dailyHistory: [...baseline, day(20, { bouncedCount: 10 })] }));
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("critical");
    expect(messages(result)[0]).toMatch(/spiked sharply/i);
  });
});
