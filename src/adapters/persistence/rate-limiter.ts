import { and, eq, gte } from "drizzle-orm";
import type { AccountId, CampaignId } from "../../core/shared-kernel/ids.js";
import type { CheckOptions, RateLimitDecision, RateLimiter } from "../../ports/rate-limiter.port.js";
import type { OutboundlyDb } from "./db.js";
import { accounts, messages, sendQueue } from "./schema.js";
import { sentByAccount } from "./sent-by-account.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_IN_FLIGHT_RETRY_MS = 5 * 60 * 1000; // no confirmed-sent timestamp to anchor to yet

/**
 * SQLite-backed implementation of RateLimiter (Section 16.2) — the authoritative, real-time
 * admission check consulted immediately before dispatch, distinct from the Scheduling Policy
 * Engine's predictive Rate Limit Policy (Section 15.4).
 *
 * Effective count per window = confirmed-sent messages in that window + currently in-flight
 * (status=claimed) queue rows for the account. The claimed count has no per-row timestamp to
 * bucket by window (send_queue only knows when a row was created, not when it was claimed), so it
 * is conservatively added to every window — a row about to be sent should count against both the
 * hourly and daily ceilings, since it will consume from whichever window it lands in. This never
 * under-counts, which is the direction Section 16.2 requires ("never letting an account exceed its
 * ceiling"); the cost is occasional over-conservatism while sends are in flight, which resolves
 * itself as soon as they land as confirmed sends or fail back to pending.
 *
 * Also enforces each account's own randomized send-pacing (a freshly randomized delay committed
 * by reserveNextSend, distinct from the per-campaign Delay Policy's one-time scheduling-time
 * jitter): this is what actually stops emails from the same account going out "almost
 * simultaneously" regardless of which campaign queued them, since every claimed row for an
 * account is funneled through this same authoritative check before dispatch.
 *
 * checkAndReserve is synchronous by design: better-sqlite3 itself is synchronous, so with no
 * await point between reading the current counts and this function returning, no other call on
 * this single-threaded process can interleave and observe a stale count — the "reservation" for
 * the daily/hourly limits is simply the queue row's own claimed status, which the Queue already
 * set before this is called (Section 16.1's Queue -> RateLimiter ordering). Pacing is different:
 * checkAndReserve itself no longer writes anything (see reserveNextSend) precisely because it gets
 * called more than once per real dispatch -- once directly by the Send worker, and again per
 * candidate account the Provider Selector screens for rotation-pool eligibility. Writing
 * next_allowed_send_at from inside a read-only-sounding "check" used to mean the Provider
 * Selector's own eligibility re-check (moments later, same account) would see the window
 * dispatchOne's own check had just reserved and deny it -- so the message could never actually go
 * out no matter how long the configured delay was.
 */
export class SqliteRateLimiter implements RateLimiter {
  constructor(private readonly db: OutboundlyDb) {}

  checkAndReserve(accountId: AccountId, _campaignId?: CampaignId, options?: CheckOptions): RateLimitDecision {
    const account = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    const dailyLimit = account?.dailySendLimit ?? undefined;
    const hourlyLimit = account?.hourlySendLimit ?? undefined;

    const claimedCount = this.db
      .select()
      .from(sendQueue)
      .where(and(eq(sendQueue.accountId, accountId), eq(sendQueue.status, "claimed")))
      .all()
      .filter((row) => row.id !== options?.excludeSendQueueId).length;

    if (dailyLimit !== undefined) {
      const decision = this.checkWindow(accountId, dailyLimit, DAY_MS, claimedCount, "daily");
      if (!decision.allowed) return decision;
    }

    if (hourlyLimit !== undefined) {
      const decision = this.checkWindow(accountId, hourlyLimit, HOUR_MS, claimedCount, "hourly");
      if (!decision.allowed) return decision;
    }

    const pacingDenial = this.checkPacing(account);
    if (pacingDenial) return pacingDenial;

    return { allowed: true };
  }

  /** Read-only: undefined min/max means no pacing is configured for this account -- not a
   * zero-length delay (same convention the Delay Policy already uses). Returns a denial if this
   * account's own randomized delay (set by a prior reserveNextSend call) hasn't elapsed yet. */
  private checkPacing(
    account: { minSendDelaySeconds: number | null; maxSendDelaySeconds: number | null; nextAllowedSendAt: Date | null } | undefined
  ): RateLimitDecision | undefined {
    if (!account) return undefined;
    const { minSendDelaySeconds: min, maxSendDelaySeconds: max } = account;
    if (min == null || max == null) return undefined;

    if (account.nextAllowedSendAt && account.nextAllowedSendAt.getTime() > Date.now()) {
      return {
        allowed: false,
        retryAfter: account.nextAllowedSendAt,
        reason: `Waiting for this account's randomized send delay (${min}-${max}s) before the next send`
      };
    }
    return undefined;
  }

  reserveNextSend(accountId: AccountId): void {
    const account = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) return;
    const { minSendDelaySeconds: min, maxSendDelaySeconds: max } = account;
    if (min == null || max == null) return;

    const spanSeconds = Math.max(0, max - min);
    const delaySeconds = min + Math.random() * spanSeconds;
    const nextAllowedSendAt = new Date(Date.now() + delaySeconds * 1000);
    this.db.update(accounts).set({ nextAllowedSendAt }).where(eq(accounts.id, accountId)).run();
  }

  private checkWindow(
    accountId: AccountId,
    limit: number,
    windowMs: number,
    claimedCount: number,
    label: "daily" | "hourly"
  ): RateLimitDecision {
    const now = new Date();
    const since = new Date(now.getTime() - windowMs);
    const sent = this.db
      .select()
      .from(messages)
      .where(and(sentByAccount(accountId), eq(messages.direction, "outbound"), eq(messages.status, "sent"), gte(messages.sentAt, since)))
      .all();

    const effectiveCount = sent.length + claimedCount;
    if (effectiveCount < limit) return { allowed: true };

    const oldestSentAt = sent.reduce<Date | undefined>(
      (oldest, m) => (m.sentAt && (!oldest || m.sentAt < oldest) ? m.sentAt : oldest),
      undefined
    );
    const retryAfter = oldestSentAt
      ? new Date(oldestSentAt.getTime() + windowMs)
      : new Date(now.getTime() + DEFAULT_IN_FLIGHT_RETRY_MS);

    return {
      allowed: false,
      retryAfter,
      reason: `${label} send limit reached for this account (${effectiveCount}/${limit}, including ${claimedCount} in-flight)`
    };
  }
}
