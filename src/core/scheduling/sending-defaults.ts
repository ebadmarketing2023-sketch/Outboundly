/**
 * Conservative per-account sending limits applied to a newly connected account.
 *
 * A real risk this closes: these columns are all nullable, and null means "no limit" throughout
 * the Rate Limiter (rate-limiter.ts skips the window check entirely when the limit is undefined).
 * A freshly connected mailbox therefore started life with *no daily cap, no hourly cap and no
 * pacing at all* -- a 90-lead campaign would try to dispatch all 90 back to back, which is close
 * to the fastest way to get a mailbox flagged. Unlimited is a legitimate thing to want, but it
 * should be an explicit choice rather than the state every account happens to start in.
 *
 * These are starting points for a mailbox that has not been warmed, chosen to sit well inside what
 * an ordinary person could plausibly send by hand:
 *   - 40/day is within the commonly used steady-state range for cold outreach from a single
 *     established mailbox, and far below any provider's own hard sending quota.
 *   - 8/hour prevents the whole day's allowance going out in one burst, which is the pattern that
 *     actually looks automated.
 *   - A 90-300s randomized gap (re-rolled after every send -- see SqliteRateLimiter.reserveNextSend)
 *     is what stops two messages leaving within the same second of each other.
 *
 * The user can raise, lower, or clear any of these per account on the Sending accounts screen;
 * clearing one restores "no limit" for that dimension, which stays the documented meaning of a
 * blank field.
 */
export const SENDING_DEFAULTS = {
  dailySendLimit: 40,
  hourlySendLimit: 8,
  minSendDelaySeconds: 90,
  maxSendDelaySeconds: 300
} as const;
