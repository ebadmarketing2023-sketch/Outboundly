import { and, eq, gte } from "drizzle-orm";
import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { RateLimitDecision, RateLimiter } from "../../ports/rate-limiter.port.js";
import type { OutboundlyDb } from "./db.js";
import { accounts, messages, sendQueue } from "./schema.js";

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
 * Also enforces each account's own randomized send-pacing (a freshly randomized delay generated
 * after every admitted send, distinct from the per-campaign Delay Policy's one-time
 * scheduling-time jitter): this is what actually stops emails from the same account going out
 * "almost simultaneously" regardless of which campaign queued them, since every claimed row for an
 * account is funneled through this same authoritative check before dispatch.
 *
 * checkAndReserve is synchronous by design: better-sqlite3 itself is synchronous, so with no
 * await point between reading the current counts and this function returning, no other call on
 * this single-threaded process can interleave and observe a stale count — the "reservation" is
 * simply the queue row's own claimed status, which the Queue already set before this is called
 * (Section 16.1's Queue -> RateLimiter ordering), plus (for pacing) this account's own
 * next_allowed_send_at, which this same call advances the instant it admits a send.
 */
export class SqliteRateLimiter implements RateLimiter {
  constructor(private readonly db: OutboundlyDb) {}

  checkAndReserve(accountId: AccountId): RateLimitDecision {
    const account = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    const dailyLimit = account?.dailySendLimit ?? undefined;
    const hourlyLimit = account?.hourlySendLimit ?? undefined;

    const claimedCount = this.db
      .select()
      .from(sendQueue)
      .where(and(eq(sendQueue.accountId, accountId), eq(sendQueue.status, "claimed")))
      .all().length;

    if (dailyLimit !== undefined) {
      const decision = this.checkWindow(accountId, dailyLimit, DAY_MS, claimedCount, "daily");
      if (!decision.allowed) return decision;
    }

    if (hourlyLimit !== undefined) {
      const decision = this.checkWindow(accountId, hourlyLimit, HOUR_MS, claimedCount, "hourly");
      if (!decision.allowed) return decision;
    }

    const pacingDenial = this.checkAndReservePacing(account);
    if (pacingDenial) return pacingDenial;

    return { allowed: true };
  }

  /** Undefined min/max means no pacing is configured for this account -- not a zero-length delay
   * (same convention the Delay Policy already uses). Returns a denial if this account's own
   * randomized delay hasn't elapsed yet; otherwise reserves a fresh one for the *next* send and
   * returns undefined (allowed). */
  private checkAndReservePacing(
    account: { id: string; minSendDelaySeconds: number | null; maxSendDelaySeconds: number | null; nextAllowedSendAt: Date | null } | undefined
  ): RateLimitDecision | undefined {
    if (!account) return undefined;
    const { minSendDelaySeconds: min, maxSendDelaySeconds: max } = account;
    if (min == null || max == null) return undefined;

    const now = new Date();
    if (account.nextAllowedSendAt && account.nextAllowedSendAt.getTime() > now.getTime()) {
      return {
        allowed: false,
        retryAfter: account.nextAllowedSendAt,
        reason: `Waiting for this account's randomized send delay (${min}-${max}s) before the next send`
      };
    }

    const spanSeconds = Math.max(0, max - min);
    const delaySeconds = min + Math.random() * spanSeconds;
    const nextAllowedSendAt = new Date(now.getTime() + delaySeconds * 1000);
    this.db.update(accounts).set({ nextAllowedSendAt }).where(eq(accounts.id, account.id)).run();
    return undefined;
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
      .where(and(eq(messages.accountId, accountId), eq(messages.direction, "outbound"), eq(messages.status, "sent"), gte(messages.sentAt, since)))
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
