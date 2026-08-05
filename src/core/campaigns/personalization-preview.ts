import { collectTextTokens, isMissingValue } from "../rendering/personalization-tokens.js";

/**
 * Answers "will this campaign's copy actually personalize for the leads I just uploaded?" before
 * anything is created, rather than discovering it one contact at a time at send time.
 *
 * A token with no fallback is a hard stop for a lead that has no value for it (see
 * resolveVariables) -- that lead's step returns `missing_personalization` and never goes out. That
 * is the right behavior at send time ("Hi ," must never be sent), but it is a terrible thing to
 * find out about after launching: nothing visibly fails, the lead just silently never gets an
 * email. So the wizard runs the same token rules over the real lead data up front and reports
 * exactly which token is short of values and how many leads it would cost.
 */

export interface PersonalizationTokenCoverage {
  name: string;
  /** True when *every* place this token is written supplies a fallback ({{company|your company}}),
   * so a lead missing it is rendered rather than skipped. A token written both ways counts as
   * having none, because the occurrence without one is the one that throws. */
  hasFallback: boolean;
  /** Leads with no value for it -- absent field or a blank/whitespace-only cell, which the resolver
   * treats identically. */
  missingCount: number;
}

export interface PersonalizationPreview {
  totalLeads: number;
  /** Every distinct token across all supplied texts, in first-seen order. */
  tokens: PersonalizationTokenCoverage[];
  /** Leads that would be skipped outright because at least one fallback-less token has no value
   * for them. This is the number that actually matters to the user. */
  leadsMissingRequiredValues: number;
}

/**
 * @param texts every piece of copy the campaign will send -- subjects and bodies alike, since both
 *   go through the same tokenizer.
 * @param leadValues one personalization-value map per lead, built exactly the way the send path
 *   builds it (contactFieldsToPersonalizationValues), so this cannot drift from what really happens.
 */
export function previewPersonalization(texts: string[], leadValues: Array<Record<string, string>>): PersonalizationPreview {
  const required = new Set<string>();
  const order: string[] = [];
  const withFallback = new Set<string>();

  for (const text of texts) {
    for (const token of collectTextTokens(text)) {
      if (!order.includes(token.name)) order.push(token.name);
      if (token.fallback === undefined) required.add(token.name);
      else withFallback.add(token.name);
    }
  }

  const missingCounts = new Map<string, number>(order.map((name) => [name, 0]));
  let leadsMissingRequiredValues = 0;

  for (const values of leadValues) {
    let leadBlocked = false;
    for (const name of order) {
      if (!isMissingValue(values[name])) continue;
      missingCounts.set(name, missingCounts.get(name)! + 1);
      if (required.has(name)) leadBlocked = true;
    }
    if (leadBlocked) leadsMissingRequiredValues++;
  }

  return {
    totalLeads: leadValues.length,
    tokens: order.map((name) => ({
      name,
      hasFallback: withFallback.has(name) && !required.has(name),
      missingCount: missingCounts.get(name)!
    })),
    leadsMissingRequiredValues
  };
}
