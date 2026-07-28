import type { AccountId, MessageId, SendQueueId } from "../core/shared-kernel/ids.js";

export type QueuePriority = "manual" | "campaign";
export type SendQueueStatus = "pending" | "claimed" | "sent" | "failed" | "cancelled";

export interface EnqueueInput {
  messageId: MessageId;
  accountId: AccountId;
  priority: QueuePriority;
  earliestSendAt: Date;
  idempotencyKey: string;
}

export interface SendQueueEntry {
  id: SendQueueId;
  messageId: MessageId;
  accountId: AccountId;
  priority: QueuePriority;
  earliestSendAt: Date;
  status: SendQueueStatus;
  attemptCount: number;
  lastError?: string;
  idempotencyKey: string;
  createdAt: Date;
}

/** The single outbound queue (Section 5.8, Section 16.2) — durable, ordered storage only. Rate
 * limiting and account resolution are separate concerns (RateLimiter, Provider Selector), not
 * modeled as queue-row state. */
export interface SendQueueRepository {
  /** Idempotent: re-enqueuing the same idempotencyKey returns the existing row rather than
   * inserting a duplicate (Section 16.4). */
  enqueue(input: EnqueueInput): Promise<SendQueueEntry>;
  findByIdempotencyKey(key: string): Promise<SendQueueEntry | undefined>;
  findById(id: SendQueueId): Promise<SendQueueEntry | undefined>;
  /** Atomically claims the single next-eligible pending row (earliestSendAt <= now), preferring
   * priority=manual over priority=campaign when both have eligible rows (Section 16.2), and flips
   * it to status=claimed in the same transaction so no two callers can claim the same row. */
  claimNext(now: Date): Promise<SendQueueEntry | undefined>;
  markSent(id: SendQueueId): Promise<void>;
  /** permanent=true fails the row terminally with no further retry (e.g. invalid recipient);
   * permanent=false increments attemptCount and reschedules with backoff, or fails terminally once
   * the max-attempt ceiling is reached (Section 16.4). */
  markFailed(id: SendQueueId, error: string, options: { permanent: boolean; now: Date }): Promise<void>;
  markCancelled(id: SendQueueId): Promise<void>;
  /** Releases a claimed row back to pending for a later retry without touching attemptCount or
   * lastError -- for the Rate Limiter's retryAfter (Section 16.2) or a momentarily-ineligible
   * Provider Selector result (Section 16.3), neither of which is a failure of the send itself. */
  releaseForRetry(id: SendQueueId, earliestSendAt: Date): Promise<void>;
}
