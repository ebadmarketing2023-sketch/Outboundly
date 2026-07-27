import { and, eq, gte } from "drizzle-orm";
import type { AccountId } from "../../../core/shared-kernel/ids.js";
import type { AccountHealthMetricsSource, AccountMetrics } from "../../../ports/account-health-metrics.port.js";
import type { OutboundlyDb } from "../db.js";
import { accounts, messages } from "../schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLY_RATE_LOOKBACK_DAYS = 30;
const CONSISTENCY_LOOKBACK_DAYS = 14;
const MIN_SENDS_FOR_REPLY_RATE = 1;
const MIN_DAYS_WITH_SENDS_FOR_CONSISTENCY = 3;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** SQLite-backed implementation of AccountHealthMetricsSource (Section 19.2), computing every
 * metric from the Conversation Engine's own stored messages/threads — no external calls. */
export class SqliteAccountHealthMetricsSource implements AccountHealthMetricsSource {
  constructor(private readonly db: OutboundlyDb) {}

  async getMetrics(accountId: AccountId, now: Date): Promise<AccountMetrics> {
    const account = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    const accountAgeDays = account ? Math.max(0, Math.floor((now.getTime() - account.connectedAt.getTime()) / DAY_MS)) : 0;

    const last24h = new Date(now.getTime() - DAY_MS);
    const last7d = new Date(now.getTime() - 7 * DAY_MS);
    const outboundSince7d = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.direction, "outbound"), gte(messages.sentAt, last7d)))
      .all();

    const sendsLast24h = outboundSince7d.filter((m) => (m.sentAt ?? new Date(0)) >= last24h).length;
    const sendsLast7d = outboundSince7d.length;

    return {
      sendsLast24h,
      sendsLast7d,
      accountAgeDays,
      replyRate: await this.computeReplyRate(accountId, now),
      sendingConsistencyScore: this.computeSendingConsistency(accountId, now)
    };
  }

  private async computeReplyRate(accountId: AccountId, now: Date): Promise<number | undefined> {
    const since = new Date(now.getTime() - REPLY_RATE_LOOKBACK_DAYS * DAY_MS);
    const outbound = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.direction, "outbound"), gte(messages.sentAt, since)))
      .all();

    const threadIds = new Set(outbound.map((m) => m.threadId).filter((id): id is string => Boolean(id)));
    if (threadIds.size < MIN_SENDS_FOR_REPLY_RATE) return undefined;

    let repliedThreads = 0;
    for (const threadId of threadIds) {
      const hasInbound = this.db
        .select()
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.direction, "inbound")))
        .get();
      if (hasInbound) repliedThreads++;
    }
    return repliedThreads / threadIds.size;
  }

  private computeSendingConsistency(accountId: AccountId, now: Date): number | undefined {
    const since = new Date(now.getTime() - CONSISTENCY_LOOKBACK_DAYS * DAY_MS);
    const outbound = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.direction, "outbound"), gte(messages.sentAt, since)))
      .all();

    const perDay = new Map<string, number>();
    for (const m of outbound) {
      if (!m.sentAt) continue;
      const key = dayKey(m.sentAt);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    if (perDay.size < MIN_DAYS_WITH_SENDS_FOR_CONSISTENCY) return undefined;

    const counts = [...perDay.values()];
    const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
    if (mean === 0) return undefined;
    const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
    const coefficientOfVariation = Math.sqrt(variance) / mean;
    // Map coefficient of variation to a 0-100 score: 0 variation -> 100, and it falls off linearly,
    // floored at 0. This is a simple, explainable mapping, not a statistically calibrated model.
    return Math.max(0, Math.round(100 - coefficientOfVariation * 100));
  }
}
