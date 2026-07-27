import { parseNamedAddress } from "../../core/shared-kernel/email-address.js";
import type { AccountRef, MailProvider } from "../../ports/mail-provider.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import { ingestMessage } from "./ingest-message.js";

/**
 * Inbox Synchronization (Section 11): pulls new mail via the provider's incremental sync cursor,
 * normalizes it, and runs every message through the Conversation Engine. Deliberately a plain
 * async function callable from a manual "Sync now" button in Phase 2 — the periodic Sync worker
 * (Section 21) that calls this automatically is Phase 4 territory.
 */

export interface SyncInboxParams {
  accountId: string;
  accountRef: AccountRef;
  provider: MailProvider;
  repo: ConversationRepository;
}

export interface SyncInboxResult {
  newMessageCount: number;
  repliesDetected: number;
  /**
   * Refs that failed to fetch/ingest (message deleted/moved since being listed, a transient
   * API error, etc.) — Section 21.3's failure-isolation principle applies here exactly as it
   * does to the send path: one bad message must not abort the rest of the sync. Reported rather
   * than silently swallowed, per the cross-cutting "explain, don't just flag" rule.
   */
  failedRefs: { ref: string; error: string }[];
}

function isFromAccount(fromHeader: string, accountEmail: string): boolean {
  try {
    return parseNamedAddress(fromHeader).address.toString().toLowerCase() === accountEmail.toLowerCase();
  } catch {
    return false;
  }
}

export async function syncInboxForAccount(params: SyncInboxParams): Promise<SyncInboxResult> {
  const cursor = await params.repo.getSyncCursor(params.accountId);
  const changeSet = await params.provider.listChangesSince(params.accountRef, { cursor });

  let newMessageCount = 0;
  let repliesDetected = 0;
  const failedRefs: { ref: string; error: string }[] = [];

  for (const ref of changeSet.newOrChangedMessageRefs) {
    try {
      const normalized = await params.provider.fetchMessage(params.accountRef, ref);
      const direction = isFromAccount(normalized.from, params.accountRef.emailAddress) ? "outbound" : "inbound";

      const result = await ingestMessage(params.repo, {
        accountId: params.accountId,
        direction,
        providerMessageId: normalized.providerMessageId,
        providerThreadId: normalized.providerThreadId,
        messageIdHeader: normalized.messageIdHeader,
        inReplyToHeader: normalized.inReplyToHeader,
        referencesHeader: normalized.referencesHeader,
        from: normalized.from,
        to: normalized.to,
        cc: normalized.cc,
        subject: normalized.subject,
        bodyHtml: normalized.bodyHtml,
        bodyText: normalized.bodyText,
        snippet: normalized.snippet,
        occurredAt: normalized.date
      });

      if (result.outcome !== "duplicate") {
        newMessageCount++;
        if (direction === "inbound" && result.outcome !== "new-thread") {
          repliesDetected++;
        }
      }
    } catch (err) {
      // One message's failure (deleted/moved since being listed, a transient API error) must not
      // abort the rest of the sync or lose the cursor advance below — isolate and continue.
      failedRefs.push({ ref, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await params.repo.setSyncCursor(params.accountId, changeSet.cursor);
  return { newMessageCount, repliesDetected, failedRefs };
}
