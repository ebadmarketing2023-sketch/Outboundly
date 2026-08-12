import type { AccountId, CampaignId } from "../core/shared-kernel/ids.js";

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfter: Date; reason: string };

export interface CheckOptions {
  /** The instant to evaluate against. The Send worker is driven by an injected clock and every
   * other component on the path honours it; this one used to read wall-clock time internally, so
   * the limiter could disagree with the scheduler that called it, and no time-dependent scheduling
   * behaviour could be tested deterministically. Defaults to now. */
  now?: Date;
  /** The queue row this check is deciding about, so it isn't counted as in-flight competition with
   * itself. In-flight rows exist to stop *other* concurrent dispatches pushing an account over its
   * ceiling; counting the row under consideration as well asks "would sending this put me over?"
   * and then adds it twice, which capped every account one send below its own configured limit. */
  excludeSendQueueId?: string;
}

/** Authoritative admission control, consulted immediately before a claimed queue row is actually
 * dispatched (Section 16.2) — distinct from the Scheduling Policy Engine's Rate Limit Policy
 * (Section 15.4), which is predictive/soft and runs long before dispatch. Counts recent sent
 * messages plus currently in-flight (claimed) queue rows for the account in the relevant rolling
 * windows, so an account can never be over-sent regardless of whether the send originated from a
 * manual compose or a campaign step (Section 16.4). */
export interface RateLimiter {
  /** Read-only eligibility check (daily/hourly limits + this account's own pacing window) with no
   * side effects — safe to call any number of times per real dispatch attempt, including once
   * directly and again per candidate account the Provider Selector screens for rotation-pool
   * eligibility. Committing to a send is a separate, deliberate step: see reserveNextSend. */
  checkAndReserve(accountId: AccountId, campaignId?: CampaignId, options?: CheckOptions): RateLimitDecision;
  /** Commits this account's next randomized send-pacing window (Critical Improvement #1). Call
   * exactly once, right when a send through this specific account is actually about to be
   * dispatched — never from an eligibility check, since eligibility may be evaluated more than
   * once (and for more than one candidate account) per real send. Calling this from checkAndReserve
   * itself was the original design and caused a real bug: the Provider Selector's own eligibility
   * check re-invoked checkAndReserve for the same account moments after dispatchOne's explicit
   * check had just reserved a fresh window, so that second check always failed and the message
   * could never actually go out. A no-op if the account has no delay range configured. */
  reserveNextSend(accountId: AccountId, now?: Date): void;
}
