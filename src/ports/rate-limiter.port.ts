import type { AccountId, CampaignId } from "../core/shared-kernel/ids.js";

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfter: Date; reason: string };

/** Authoritative admission control, consulted immediately before a claimed queue row is actually
 * dispatched (Section 16.2) — distinct from the Scheduling Policy Engine's Rate Limit Policy
 * (Section 15.4), which is predictive/soft and runs long before dispatch. Counts recent sent
 * messages plus currently in-flight (claimed) queue rows for the account in the relevant rolling
 * windows, so an account can never be over-sent regardless of whether the send originated from a
 * manual compose or a campaign step (Section 16.4). */
export interface RateLimiter {
  checkAndReserve(accountId: AccountId, campaignId?: CampaignId): RateLimitDecision;
}
