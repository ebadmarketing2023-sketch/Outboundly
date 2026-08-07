import { eq, or, and, isNull, type SQL } from "drizzle-orm";
import { messages } from "./schema.js";

/**
 * "Was this message actually sent by this account?" — the predicate every per-account send count
 * has to use.
 *
 * messages.account_id is the account the message was *enqueued* against. The Provider Selector
 * (Section 16.3) can dispatch through a different one, and records that in sent_from_account_id.
 * Counting by account_id alone therefore bills a substituted send to the wrong mailbox: the
 * originally-pinned account looks like it has sent its whole daily quota while the account that
 * really sent them looks untouched, so one account gets throttled for work it never did and the
 * other never gets throttled at all. With rotation now actually reaching the Provider Selector,
 * that mis-attribution is the difference between a per-account limit being enforced and not.
 *
 * sent_from_account_id is only set when a message truly goes out, so a row that predates it (or a
 * message not yet sent) falls back to account_id.
 */
export function sentByAccount(accountId: string): SQL | undefined {
  return or(
    eq(messages.sentFromAccountId, accountId),
    and(isNull(messages.sentFromAccountId), eq(messages.accountId, accountId))
  );
}
