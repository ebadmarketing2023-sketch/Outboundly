import { describe, expect, it } from "vitest";
import { mean, stddev, zScore } from "../../src/core/insights/stats.js";

describe("mean", () => {
  it("averages a list of numbers", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });
});

describe("stddev", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(stddev([])).toBe(0);
    expect(stddev([5])).toBe(0);
  });

  it("returns 0 for a constant series (no variance)", () => {
    expect(stddev([4, 4, 4, 4])).toBe(0);
  });

  it("computes the sample standard deviation for a known series", () => {
    // Classic worked example: mean 5, sample stdev ≈ 2.1381
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 3);
  });
});

describe("zScore", () => {
  it("is undefined with fewer than 2 baseline points", () => {
    expect(zScore(10, [])).toBeUndefined();
    expect(zScore(10, [5])).toBeUndefined();
  });

  it("is undefined when the baseline has zero variance", () => {
    expect(zScore(10, [5, 5, 5])).toBeUndefined();
  });

  it("is undefined for a baseline of repeated ratio divisions, despite floating-point noise", () => {
    // 4/20 repeated 6 times isn't bit-identical after a mean/variance pass (~1e-17 stdev), even
    // though the "real" variance is zero -- a strict `sd === 0` check would miss this.
    const baseline = Array.from({ length: 6 }, () => 4 / 20);
    expect(zScore(0, baseline)).toBeUndefined();
  });

  it("computes a known z-score", () => {
    // baseline [1,2,3]: mean 2, sample stdev 1 -> (5-2)/1 = 3
    expect(zScore(5, [1, 2, 3])).toBeCloseTo(3, 5);
  });

  it("is negative when the value sits below the baseline mean", () => {
    expect(zScore(-1, [1, 2, 3])).toBeCloseTo(-3, 5);
  });
});
