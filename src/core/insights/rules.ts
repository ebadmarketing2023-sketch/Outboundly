import { bounceRate, replyRate } from "../analytics/rollup.js";
import type { DailyRollupBucket, MetricCounts } from "../analytics/rollup.js";
import { zScore } from "./stats.js";
import type { Insight, InsightRule } from "./types.js";

/**
 * Insight Rules (Section 20.3). Each rule is deliberately conservative about small samples: a
 * campaign that's sent 3 emails swinging from a 0% to 33% reply rate is noise, not a trend, so
 * every rule below requires a minimum send volume before it will speak at all.
 */

const MIN_SAMPLE_SENT = 10;
const RELATIVE_CHANGE_THRESHOLD = 0.3; // 30% relative move, either direction
const BOUNCE_RATE_WARNING_CEILING = 0.05;
const BOUNCE_RATE_CRITICAL_CEILING = 0.1;
const ANOMALY_Z_SCORE_THRESHOLD = 2;
const ANOMALY_MIN_BASELINE_DAYS = 6;
const ANOMALY_MIN_DAY_SENT = 5;

function insight(
  rule: InsightRule,
  severity: Insight["severity"],
  message: string,
  explanation: string,
  recommendedAction?: string
): Insight {
  return { insightType: rule.id, severity, message, explanation, recommendedAction };
}

function relativeChange(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined; // no baseline to compute a percentage against
  return (current - previous) / previous;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Combined volume + reply-rate week-over-week trend (Section 20.3's own example: "sending volume
 * increased 40% this week, but reply rate decreased, because..."). One rule, not two independent
 * ones, so a correlated move produces a single causally-linked insight instead of two separate
 * "volume up" / "reply rate down" insights the reader has to connect themselves.
 */
const volumeAndReplyRateTrend: InsightRule = {
  id: "volume_and_reply_rate_trend",
  evaluate(ctx) {
    if (ctx.current.sentCount < MIN_SAMPLE_SENT || ctx.previous.sentCount < MIN_SAMPLE_SENT) return [];

    const volumeChange = relativeChange(ctx.current.sentCount, ctx.previous.sentCount);
    const currentReplyRate = replyRate(ctx.current);
    const previousReplyRate = replyRate(ctx.previous);
    if (volumeChange === undefined || currentReplyRate === undefined || previousReplyRate === undefined) return [];
    const replyRateChange = relativeChange(currentReplyRate, previousReplyRate);
    if (replyRateChange === undefined) return [];

    const volumeUp = volumeChange >= RELATIVE_CHANGE_THRESHOLD;
    const volumeDown = volumeChange <= -RELATIVE_CHANGE_THRESHOLD;
    const replyRateUp = replyRateChange >= RELATIVE_CHANGE_THRESHOLD;
    const replyRateDown = replyRateChange <= -RELATIVE_CHANGE_THRESHOLD;

    if (volumeUp && replyRateDown) {
      return [
        insight(
          volumeAndReplyRateTrend,
          "warning",
          `Sending volume increased ${pct(volumeChange)} this period, but reply rate dropped from ${pct(previousReplyRate)} to ${pct(currentReplyRate)}`,
          "A reply-rate decline that coincides with a volume increase often means the added volume went to a lower-quality or colder segment of the list, rather than reply quality declining across the board.",
          "Compare reply rates on the newly added contacts/segment against the rest of the list before increasing volume further."
        )
      ];
    }

    if (replyRateDown) {
      return [
        insight(
          volumeAndReplyRateTrend,
          "warning",
          `Reply rate dropped from ${pct(previousReplyRate)} to ${pct(currentReplyRate)} this period`,
          "A reply-rate decline without a volume change points more toward content, targeting, or deliverability than list composition.",
          "Review recent message content and targeting, and check the Deliverability dashboard for new findings."
        )
      ];
    }

    if (replyRateUp) {
      return [
        insight(
          volumeAndReplyRateTrend,
          "info",
          `Reply rate improved from ${pct(previousReplyRate)} to ${pct(currentReplyRate)} this period`,
          "Reply rate trending up is worth noting so whatever changed (content, targeting, timing) can be kept or repeated.",
          undefined
        )
      ];
    }

    if (volumeUp) {
      return [
        insight(
          volumeAndReplyRateTrend,
          "info",
          `Sending volume increased ${pct(volumeChange)} this period with reply rate holding steady`,
          "Volume grew without a corresponding drop in reply rate, which is the outcome you want when scaling up a campaign.",
          undefined
        )
      ];
    }

    if (volumeDown) {
      return [
        insight(
          volumeAndReplyRateTrend,
          "info",
          `Sending volume decreased ${pct(Math.abs(volumeChange))} this period`,
          "A meaningful drop in sending volume compared to the prior period — worth confirming this was intentional (e.g. a paused campaign) rather than a stuck queue.",
          undefined
        )
      ];
    }

    return [];
  }
};

/** Warning rule: bounce rate crossing a safe ceiling (Section 20.3's "a metric crossing a
 * configured or learned threshold" example). */
const bounceRateCeiling: InsightRule = {
  id: "bounce_rate_ceiling",
  evaluate(ctx) {
    if (ctx.current.sentCount < MIN_SAMPLE_SENT) return [];
    const rate = bounceRate(ctx.current);
    if (rate === undefined) return [];

    if (rate >= BOUNCE_RATE_CRITICAL_CEILING) {
      return [
        insight(
          bounceRateCeiling,
          "critical",
          `Bounce rate is ${pct(rate)}, well above the safe ceiling`,
          "Sustained bounce rates this high put sender reputation at serious risk with mailbox providers and can trigger throttling or blocking.",
          "Pause this campaign/account and clean the contact list (remove invalid addresses) before resuming."
        )
      ];
    }
    if (rate >= BOUNCE_RATE_WARNING_CEILING) {
      return [
        insight(
          bounceRateCeiling,
          "warning",
          `Bounce rate is ${pct(rate)}, above the recommended ceiling`,
          "Bounce rate above roughly 5% is commonly treated as a reputation risk signal by mailbox providers.",
          "Review recent bounces for list-hygiene issues (typos, stale addresses) before increasing volume."
        )
      ];
    }
    return [];
  }
};

function dailyRateSeries(history: DailyRollupBucket[], rateFn: (counts: MetricCounts) => number | undefined): number[] {
  return history
    .filter((day) => day.sentCount >= ANOMALY_MIN_DAY_SENT)
    .map((day) => rateFn(day))
    .filter((rate): rate is number => rate !== undefined);
}

/** Anomaly detection (Section 20.3): a sudden reply-rate cliff on the most recent day, flagged
 * only when it's a real statistical outlier against this scope's own recent daily history — not
 * just ordinary week-to-week noise. */
const replyRateCliff: InsightRule = {
  id: "reply_rate_cliff_anomaly",
  evaluate(ctx) {
    if (ctx.dailyHistory.length === 0) return [];
    const today = ctx.dailyHistory[ctx.dailyHistory.length - 1]!;
    if (today.sentCount < ANOMALY_MIN_DAY_SENT) return [];
    const todayRate = replyRate(today);
    if (todayRate === undefined) return [];

    const baseline = dailyRateSeries(ctx.dailyHistory.slice(0, -1), replyRate);
    if (baseline.length < ANOMALY_MIN_BASELINE_DAYS) return [];

    const z = zScore(todayRate, baseline);
    if (z === undefined || z > -ANOMALY_Z_SCORE_THRESHOLD) return [];

    return [
      insight(
        replyRateCliff,
        "critical",
        `Reply rate dropped sharply today (${pct(todayRate)}), far below its recent typical range`,
        "This is a statistical outlier against recent daily history, not ordinary day-to-day variation, so it's more likely a real problem (content, deliverability, or targeting) than noise.",
        "Check whether recent sends changed (new template, new segment, provider issue) and compare against the Deliverability dashboard."
      )
    ];
  }
};

/** Anomaly detection (Section 20.3): a sudden bounce-rate spike on the most recent day. */
const bounceRateSpike: InsightRule = {
  id: "bounce_rate_spike_anomaly",
  evaluate(ctx) {
    if (ctx.dailyHistory.length === 0) return [];
    const today = ctx.dailyHistory[ctx.dailyHistory.length - 1]!;
    if (today.sentCount < ANOMALY_MIN_DAY_SENT) return [];
    const todayRate = bounceRate(today);
    if (todayRate === undefined) return [];

    const baseline = dailyRateSeries(ctx.dailyHistory.slice(0, -1), bounceRate);
    if (baseline.length < ANOMALY_MIN_BASELINE_DAYS) return [];

    const z = zScore(todayRate, baseline);
    if (z === undefined || z < ANOMALY_Z_SCORE_THRESHOLD) return [];

    return [
      insight(
        bounceRateSpike,
        "critical",
        `Bounce rate spiked sharply today (${pct(todayRate)}), far above its recent typical range`,
        "This is a statistical outlier against recent daily history, not ordinary day-to-day variation — a sudden spike like this often points to a bad batch of addresses or a provider-side delivery problem.",
        "Pause sending for this scope until the cause is identified; check the most recent list import for data-quality issues."
      )
    ];
  }
};

export const INSIGHT_RULES: InsightRule[] = [volumeAndReplyRateTrend, bounceRateCeiling, replyRateCliff, bounceRateSpike];
