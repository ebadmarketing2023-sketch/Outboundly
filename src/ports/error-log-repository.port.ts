import type { AccountId, CampaignId, ErrorLogId } from "../core/shared-kernel/ids.js";

/** Which worker/subsystem produced the log entry (Critical Improvement #12) -- not a closed enum
 * of every possible error, just a coarse "where do I look" tag for troubleshooting. */
export type ErrorLogSource = "send-worker" | "scheduler" | "inbox-sync" | "account-health-sweep";

export interface RecordErrorLogInput {
  occurredAt: Date;
  source: ErrorLogSource;
  /** A short, machine-friendly code (e.g. "permanent_smtp_rejection", "rate_limited",
   * "fetch_failed") -- not a full sentence, that's errorMessage's job. */
  errorType: string;
  errorMessage: string;
  campaignId?: CampaignId;
  accountId?: AccountId;
  recipientEmail?: string;
  retryCount?: number;
}

export interface ErrorLogRecord extends RecordErrorLogInput {
  id: ErrorLogId;
}

/**
 * Structured error logging (Critical Improvement #12): a complete, append-only diagnostic trail
 * distinct from Notifications (Section 3), which are a curated, dismissible, user-facing subset.
 * Every background worker's per-item failure gets one row here with exactly the context a real
 * troubleshooting session needs -- which campaign, which account, which recipient, what kind of
 * error, the message, and how many attempts so far -- rather than being visible only in the
 * terminal's console output.
 */
export interface ErrorLogRepository {
  record(input: RecordErrorLogInput): Promise<ErrorLogRecord>;
  /** Newest first, optionally narrowed to one source -- the log viewer's only two query shapes. */
  listRecent(limit: number, source?: ErrorLogSource): Promise<ErrorLogRecord[]>;
}
