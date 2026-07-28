import { and, eq, lte } from "drizzle-orm";
import { asAccountId, asMessageId, asSendQueueId, generateId, type SendQueueId } from "../../../core/shared-kernel/ids.js";
import type {
  EnqueueInput,
  QueuePriority,
  SendQueueEntry,
  SendQueueRepository,
  SendQueueStatus
} from "../../../ports/send-queue-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { sendQueue } from "../schema.js";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000; // 1 minute, doubling per attempt
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 1 day ceiling

type SendQueueRow = typeof sendQueue.$inferSelect;

function toDomain(row: SendQueueRow): SendQueueEntry {
  return {
    id: asSendQueueId(row.id),
    messageId: asMessageId(row.messageId),
    accountId: asAccountId(row.accountId),
    priority: row.priority as QueuePriority,
    earliestSendAt: row.earliestSendAt,
    status: row.status as SendQueueStatus,
    attemptCount: row.attemptCount,
    lastError: row.lastError ?? undefined,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt
  };
}

function backoffMs(attemptCount: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attemptCount - 1));
}

/** SQLite-backed implementation of SendQueueRepository (Section 5.8, Section 16.2). */
export class SqliteSendQueueRepository implements SendQueueRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async enqueue(input: EnqueueInput): Promise<SendQueueEntry> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const id = generateId();
    this.db
      .insert(sendQueue)
      .values({
        id,
        messageId: input.messageId,
        accountId: input.accountId,
        priority: input.priority,
        earliestSendAt: input.earliestSendAt,
        status: "pending",
        attemptCount: 0,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date()
      })
      .run();
    const row = this.db.select().from(sendQueue).where(eq(sendQueue.id, id)).get();
    return toDomain(row!);
  }

  async findByIdempotencyKey(key: string): Promise<SendQueueEntry | undefined> {
    const row = this.db.select().from(sendQueue).where(eq(sendQueue.idempotencyKey, key)).get();
    return row ? toDomain(row) : undefined;
  }

  async findById(id: SendQueueId): Promise<SendQueueEntry | undefined> {
    const row = this.db.select().from(sendQueue).where(eq(sendQueue.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async claimNext(now: Date): Promise<SendQueueEntry | undefined> {
    return this.db.transaction((tx) => {
      for (const priority of ["manual", "campaign"] as const) {
        const candidate = tx
          .select()
          .from(sendQueue)
          .where(and(eq(sendQueue.status, "pending"), eq(sendQueue.priority, priority), lte(sendQueue.earliestSendAt, now)))
          .orderBy(sendQueue.earliestSendAt)
          .get();
        if (!candidate) continue;

        const result = tx
          .update(sendQueue)
          .set({ status: "claimed" })
          .where(and(eq(sendQueue.id, candidate.id), eq(sendQueue.status, "pending")))
          .run();
        if (result.changes === 0) continue; // claimed by another caller between the select and update

        const claimed = tx.select().from(sendQueue).where(eq(sendQueue.id, candidate.id)).get();
        return toDomain(claimed!);
      }
      return undefined;
    });
  }

  async markSent(id: SendQueueId): Promise<void> {
    this.db.update(sendQueue).set({ status: "sent" }).where(eq(sendQueue.id, id)).run();
  }

  async markFailed(id: SendQueueId, error: string, options: { permanent: boolean; now: Date }): Promise<void> {
    const row = this.db.select().from(sendQueue).where(eq(sendQueue.id, id)).get();
    if (!row) return;

    if (options.permanent) {
      this.db.update(sendQueue).set({ status: "failed", lastError: error }).where(eq(sendQueue.id, id)).run();
      return;
    }

    const nextAttemptCount = row.attemptCount + 1;
    if (nextAttemptCount >= MAX_ATTEMPTS) {
      this.db
        .update(sendQueue)
        .set({ status: "failed", attemptCount: nextAttemptCount, lastError: error })
        .where(eq(sendQueue.id, id))
        .run();
      return;
    }

    this.db
      .update(sendQueue)
      .set({
        status: "pending",
        attemptCount: nextAttemptCount,
        lastError: error,
        earliestSendAt: new Date(options.now.getTime() + backoffMs(nextAttemptCount))
      })
      .where(eq(sendQueue.id, id))
      .run();
  }

  async markCancelled(id: SendQueueId): Promise<void> {
    this.db.update(sendQueue).set({ status: "cancelled" }).where(eq(sendQueue.id, id)).run();
  }
}
