import type { AccountId } from "../core/shared-kernel/ids.js";

export interface AccountMetrics {
  sendsLast24h: number;
  sendsLast7d: number;
  accountAgeDays: number;
  /** Undefined when there isn't enough outbound volume in the lookback window to mean anything. */
  replyRate?: number;
  /** 0-100, higher = more consistent day-to-day volume. Undefined with too little send history. */
  sendingConsistencyScore?: number;
}

/** Real, derivable-from-local-data account metrics (Section 19.2) — sourced from the Conversation
 * Engine's own storage (messages/threads), not fabricated. Bounce rate and spam-complaint rate
 * are intentionally absent from this shape: no connected provider exposes either signal to this
 * app yet (Gmail/Graph don't surface feedback-loop data to a normal OAuth app, and plain
 * SMTP/IMAP has no concept of either), so there is nothing real to report. */
export interface AccountHealthMetricsSource {
  getMetrics(accountId: AccountId, now: Date): Promise<AccountMetrics>;
}
