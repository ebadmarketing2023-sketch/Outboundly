import { AccountIneligibleError } from "../types.js";
import type { SchedulingCandidate, SchedulingContext, SchedulingPolicy } from "../types.js";

/**
 * Rate Limit Policy (Section 15.2): predictive/soft per-account daily and hourly cap check, based
 * on the send counts the application layer gathered beforehand (Section 15.4 — "propose early,
 * confirm late"). This is NOT the authoritative admission check; the Rate Limiter (Section 16.2)
 * re-checks for real at actual dispatch time and is the only component allowed to reserve a slot.
 * An undefined limit means "no explicit cap configured for this account" — never treated as 0.
 */
export const rateLimitPolicy: SchedulingPolicy = {
  id: "rate-limit",

  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate {
    const counts = ctx.recentSendCounts.get(candidate.candidateAccountId) ?? { last24h: 0, lastHour: 0 };
    const dailyLimit = ctx.accountDailyLimits.get(candidate.candidateAccountId);
    const hourlyLimit = ctx.accountHourlyLimits.get(candidate.candidateAccountId);

    if (dailyLimit !== undefined && counts.last24h >= dailyLimit) {
      throw new AccountIneligibleError(
        `Daily send limit reached for this account (${counts.last24h}/${dailyLimit} in the last 24h)`
      );
    }

    if (hourlyLimit !== undefined && counts.lastHour >= hourlyLimit) {
      throw new AccountIneligibleError(
        `Hourly send limit reached for this account (${counts.lastHour}/${hourlyLimit} in the last hour)`
      );
    }

    return {
      ...candidate,
      trace: [
        ...candidate.trace,
        {
          policyId: "rate-limit",
          decision: `Within rate limits (daily ${counts.last24h}/${dailyLimit ?? "unlimited"}, hourly ${counts.lastHour}/${hourlyLimit ?? "unlimited"})`
        }
      ]
    };
  }
};
