import { eq } from "drizzle-orm";
import { asAccountId, asMessageId, asSendQueueId, generateId, type EnrollmentId } from "../../core/shared-kernel/ids.js";
import type { AdvanceEnrollmentInput } from "../../ports/enrollment-repository.port.js";
import type { EnqueueInput, QueuePriority, SendQueueEntry, SendQueueStatus } from "../../ports/send-queue-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { campaignEnrollments as enrollmentsTable, sendQueue as sendQueueTable } from "./schema.js";

type SendQueueRow = typeof sendQueueTable.$inferSelect;

function toSendQueueDomain(row: SendQueueRow): SendQueueEntry {
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

/**
 * Database Integrity (Critical Improvement #13): fireEnrollmentStep's final two writes -- enqueue
 * the send_queue row, then advance the enrollment to its next step (or completed) -- happen in one
 * real db.transaction() here rather than as two independent repository calls, so a crash or error
 * between them can't leave an enrollment stuck "ahead" of a queue row that never got created (or
 * vice versa). This intentionally duplicates SqliteSendQueueRepository.enqueue's idempotency-check
 * logic and SqliteEnrollmentRepository.advance's update as raw synchronous drizzle calls against the
 * same transaction handle: better-sqlite3 transactions must be plain synchronous callbacks, and
 * calling those repositories' own (async-declared) methods without awaiting inside one would let a
 * thrown error become a silently-swallowed promise rejection instead of rolling the transaction
 * back -- exactly the failure mode this exists to prevent.
 */
export function enqueueAndAdvanceEnrollment(
  db: OutboundlyDb,
  input: { queue: EnqueueInput; enrollmentId: EnrollmentId; advance: AdvanceEnrollmentInput }
): SendQueueEntry {
  return db.transaction((tx) => {
    const existing = tx.select().from(sendQueueTable).where(eq(sendQueueTable.idempotencyKey, input.queue.idempotencyKey)).get();

    let queueEntry: SendQueueRow;
    if (existing) {
      queueEntry = existing;
    } else {
      const id = generateId();
      tx.insert(sendQueueTable)
        .values({
          id,
          messageId: input.queue.messageId,
          accountId: input.queue.accountId,
          priority: input.queue.priority,
          earliestSendAt: input.queue.earliestSendAt,
          status: "pending",
          attemptCount: 0,
          idempotencyKey: input.queue.idempotencyKey,
          createdAt: new Date()
        })
        .run();
      queueEntry = tx.select().from(sendQueueTable).where(eq(sendQueueTable.id, id)).get()!;
    }

    tx.update(enrollmentsTable)
      .set({
        currentStepId: input.advance.currentStepId,
        nextSendAt: input.advance.nextSendAt,
        status: input.advance.status,
        updatedAt: new Date()
      })
      .where(eq(enrollmentsTable.id, input.enrollmentId))
      .run();

    return toSendQueueDomain(queueEntry);
  });
}
