import { looksLikeBounceNotification } from "../../core/campaigns/bounce-detection.js";
import { sanitizeInboundHtml } from "../../core/rendering/sanitize-html.js";
import { parseNamedAddress } from "../../core/shared-kernel/email-address.js";
import { asAccountId } from "../../core/shared-kernel/ids.js";
import type { AccountRef, MailProvider } from "../../ports/mail-provider.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { ErrorLogRepository } from "../../ports/error-log-repository.port.js";
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
  /** Invoked for a genuine reply — an inbound message attached to an existing thread, not a
   * cold/new one — so the Campaign Engine can stop matching active enrollments (Section 14.3's
   * ReplyDetected event). Composed in by the caller so this stays decoupled from the Campaign
   * Engine's own repositories; wrapped in the same per-message failure isolation as ingestion
   * itself, so a stop-condition failure can't abort the rest of the sync. */
  onReplyDetected?: (fromAddress: string, threadId: string) => Promise<void>;
  /** Invoked for an inbound message that looks like an automated delivery-failure notice (Section
   * 14.2's BounceDetected event) and threaded back to an existing conversation — a DSN that
   * doesn't thread back to one of our own sends can't be correlated to anything and is silently
   * not detected (see bounce-detection.ts's docblock). Mutually exclusive with onReplyDetected:
   * an automated bounce is never counted as a genuine reply. */
  onBounceDetected?: (threadId: string) => Promise<void>;
  /** Optional (Critical Improvement #12): when provided, a per-message fetch/ingest failure is
   * also recorded as a structured, queryable log entry, not just returned in failedRefs. Omitted
   * in most existing tests since it's a pure side effect. */
  errorLogRepository?: ErrorLogRepository;
}

export interface SyncInboxResult {
  newMessageCount: number;
  repliesDetected: number;
  bouncesDetected: number;
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
  let bouncesDetected = 0;
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
        // Section 23: "inbound synced HTML sanitized ... before rendering" -- the one place
        // externally-authored HTML enters this pipeline, so it's re-parsed against the Internal
        // Document Model's allowed-node schema and re-rendered from that, never stored verbatim.
        bodyHtml: sanitizeInboundHtml(normalized.bodyHtml),
        bodyText: normalized.bodyText,
        snippet: normalized.snippet,
        occurredAt: normalized.date
      });

      if (result.outcome !== "duplicate") {
        newMessageCount++;
        if (direction === "inbound" && result.outcome !== "new-thread") {
          if (looksLikeBounceNotification(normalized.from, normalized.subject)) {
            bouncesDetected++;
            await params.onBounceDetected?.(result.threadId);
          } else {
            repliesDetected++;
            await params.onReplyDetected?.(normalized.from, result.threadId);
          }
        }
      }
    } catch (err) {
      // One message's failure (deleted/moved since being listed, a transient API error) must not
      // abort the rest of the sync or lose the cursor advance below — isolate and continue.
      const errorMessage = err instanceof Error ? err.message : String(err);
      failedRefs.push({ ref, error: errorMessage });
      await params.errorLogRepository?.record({
        occurredAt: new Date(),
        source: "inbox-sync",
        errorType: "message_fetch_failed",
        errorMessage,
        accountId: asAccountId(params.accountId)
      });
    }
  }

  await params.repo.setSyncCursor(params.accountId, changeSet.cursor);
  return { newMessageCount, repliesDetected, bouncesDetected, failedRefs };
}
