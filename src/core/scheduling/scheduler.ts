import { businessHoursPolicy } from "./policies/business-hours-policy.js";
import { delayPolicy } from "./policies/delay-policy.js";
import { rateLimitPolicy } from "./policies/rate-limit-policy.js";
import { timezonePolicy } from "./policies/timezone-policy.js";
import { warmupPolicy } from "./policies/warmup-policy.js";
import { AccountIneligibleError, NoEligibleAccountError } from "./types.js";
import type { SchedulingCandidate, SchedulingContext, SchedulingPolicy } from "./types.js";

/** Policies that decide account eligibility (Section 15.2) — a rejection here means "try the next
 * account in rotation", handled by the loop in schedule() rather than by the policy itself. */
const ELIGIBILITY_POLICIES: SchedulingPolicy[] = [warmupPolicy, rateLimitPolicy];

/** Policies that transform an already-eligible candidate (Section 15.3) — order matters: Timezone
 * resolves the zone Business Hours snaps against, and Delay runs last so its jitter survives. */
const REFINEMENT_POLICIES: SchedulingPolicy[] = [timezonePolicy, businessHoursPolicy, delayPolicy];

/**
 * Scheduler (Section 15.1): orchestrates the policy pipeline. Contains no business rules of its
 * own — only the account-rotation retry loop (Section 15.3's flowchart: an ineligible account
 * rotates to the next candidate in the pool; exhausting the pool is a NoEligibleAccountError, not
 * a hard crash, since the caller — the Scheduler tick worker, Section 21.1 — just leaves the
 * enrollment for a later tick).
 */
export function schedule(initialProposedSendAt: Date, ctx: SchedulingContext): SchedulingCandidate {
  const rejectedAccountIds: SchedulingCandidate["rejectedAccountIds"] = [];

  for (const accountId of ctx.availableAccountIds) {
    let candidate: SchedulingCandidate = {
      proposedSendAt: initialProposedSendAt,
      candidateAccountId: accountId,
      rejectedAccountIds: [...rejectedAccountIds],
      trace: []
    };

    try {
      for (const policy of ELIGIBILITY_POLICIES) {
        candidate = policy.apply(candidate, ctx);
      }
    } catch (err) {
      if (err instanceof AccountIneligibleError) {
        rejectedAccountIds.push(accountId);
        continue;
      }
      throw err;
    }

    for (const policy of REFINEMENT_POLICIES) {
      candidate = policy.apply(candidate, ctx);
    }

    return candidate;
  }

  throw new NoEligibleAccountError(rejectedAccountIds);
}
