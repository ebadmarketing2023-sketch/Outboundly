import { describe, expect, it } from "vitest";
import { NoVariantsConfiguredError, selectWeightedVariant } from "../../src/core/campaigns/variant-selection.js";

describe("selectWeightedVariant (Section 14.3)", () => {
  it("throws NoVariantsConfiguredError for an empty list", () => {
    expect(() => selectWeightedVariant([])).toThrow(NoVariantsConfiguredError);
  });

  it("returns the only variant when there's just one", () => {
    const variants = [{ id: "a", weight: 1 }];
    expect(selectWeightedVariant(variants)).toBe(variants[0]);
  });

  it("picks the first variant when the random roll lands in its share", () => {
    const variants = [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 }
    ];
    expect(selectWeightedVariant(variants, () => 0)).toBe(variants[0]);
  });

  it("picks the second variant when the random roll lands past the first variant's share", () => {
    const variants = [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 }
    ];
    // random() * totalWeight(2) = 1.5 -> falls into b's [1,2) slice
    expect(selectWeightedVariant(variants, () => 0.75)).toBe(variants[1]);
  });

  it("respects proportional weighting (a 9:1 split rolls almost always to the heavy variant)", () => {
    const variants = [
      { id: "heavy", weight: 9 },
      { id: "light", weight: 1 }
    ];
    const counts = { heavy: 0, light: 0 };
    for (let i = 0; i < 1000; i++) {
      const picked = selectWeightedVariant(variants, () => i / 1000);
      counts[picked.id as "heavy" | "light"]++;
    }
    expect(counts.heavy).toBeGreaterThan(counts.light * 5);
  });

  it("falls back to the first variant when every weight is zero or negative", () => {
    const variants = [
      { id: "a", weight: 0 },
      { id: "b", weight: 0 }
    ];
    expect(selectWeightedVariant(variants)).toBe(variants[0]);
  });
});
