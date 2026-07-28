/** Pure statistics helpers backing the Insights Engine's anomaly detection (Section 20.3). */

export function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator) — `values` is a baseline sample, not a population. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Rates computed as ratios of small integers (e.g. 4/20) are rarely bit-identical even when they
// represent the "same" value across days, so a literal `sd === 0` check would almost never fire on
// real data — a baseline whose true variance is zero still comes out as ~1e-17 from floating-point
// rounding. Anything below this epsilon is treated as no real variance to compare against.
const NEGLIGIBLE_VARIANCE = 1e-9;

/**
 * How many standard deviations `value` sits from the mean of `baseline`. Returns undefined when
 * there isn't enough baseline data (fewer than 2 points) or the baseline has negligible variance —
 * either way, there's no meaningful way to call anything an "outlier" yet, so anomaly rules must
 * treat undefined as "don't flag," not as zero.
 */
export function zScore(value: number, baseline: number[]): number | undefined {
  if (baseline.length < 2) return undefined;
  const sd = stddev(baseline);
  if (sd < NEGLIGIBLE_VARIANCE) return undefined;
  return (value - mean(baseline)) / sd;
}
