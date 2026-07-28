import { describe, expect, it } from "vitest";
import { emptyMetricCounts } from "../../src/core/analytics/rollup.js";
import { evaluateInsights } from "../../src/core/insights/engine.js";
import type { InsightContext, InsightRule } from "../../src/core/insights/types.js";

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

describe("evaluateInsights", () => {
  it("returns no insights for an empty, quiet context against the real registry", () => {
    expect(evaluateInsights(ctx({}))).toEqual([]);
  });

  it("runs every provided rule and flattens their results", () => {
    const alwaysOne: InsightRule = {
      id: "always_one",
      evaluate: () => [{ insightType: "always_one", severity: "info", message: "a", explanation: "b" }]
    };
    const alwaysTwo: InsightRule = {
      id: "always_two",
      evaluate: () => [
        { insightType: "always_two", severity: "warning", message: "c", explanation: "d" },
        { insightType: "always_two", severity: "warning", message: "e", explanation: "f" }
      ]
    };
    const result = evaluateInsights(ctx({}), [alwaysOne, alwaysTwo]);
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.insightType)).toEqual(["always_one", "always_two", "always_two"]);
  });

  it("uses the real registry by default and produces a warning for a genuinely bad bounce rate", () => {
    const result = evaluateInsights(
      ctx({ current: { ...emptyMetricCounts(), sentCount: 100, bouncedCount: 6 } })
    );
    expect(result.some((i) => i.insightType === "bounce_rate_ceiling" && i.severity === "warning")).toBe(true);
  });
});
