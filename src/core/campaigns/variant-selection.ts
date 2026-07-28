/**
 * Weighted variant selection (Section 14.3) — used for both template content variants and
 * subject-line A/B/n variants, since both are just "a list of weighted options, pick one" against
 * the same shape.
 */
export class NoVariantsConfiguredError extends Error {
  constructor() {
    super("No variants configured to select from");
    this.name = "NoVariantsConfiguredError";
  }
}

export function selectWeightedVariant<T extends { weight: number }>(variants: T[], random: () => number = Math.random): T {
  if (variants.length === 0) throw new NoVariantsConfiguredError();

  const totalWeight = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (totalWeight <= 0) return variants[0]!;

  let roll = random() * totalWeight;
  for (const variant of variants) {
    roll -= Math.max(0, variant.weight);
    if (roll <= 0) return variant;
  }
  return variants[variants.length - 1]!;
}
