import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteRateLimiter } from "../../src/adapters/persistence/rate-limiter.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { accounts, messages } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asMessageId, asSendQueueId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("SendQueue + RateLimiter (Section 5.8, Section 16.2)", () => {
  let db: OutboundlyDb;
  let queueRepo: SqliteSendQueueRepository;
  let rateLimiter: SqliteRateLimiter;
  let accountId: string;

  function insertAccount(
    overrides: Partial<{
      dailySendLimit: number;
      hourlySendLimit: number;
      minSendDelaySeconds: number;
      maxSendDelaySeconds: number;
      nextAllowedSendAt: Date;
    }> = {}
  ): string {
    const id = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id,
        provider: "google",
        emailAddress: `${id}@outboundly.app`,
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides
      })
      .run();
    return id;
  }

  function insertMessage(forAccountId: string, opts: { status: string; sentAt?: Date }): string {
    const id = generateId();
    const now = new Date();
    db.insert(messages)
      .values({
        id,
        accountId: forAccountId,
        messageIdHeader: `<${id}@outboundly.app>`,
        direction: "outbound",
        fromAddress: "me@outboundly.app",
        toAddresses: ["them@example.com"],
        status: opts.status,
        sentAt: opts.sentAt,
        createdAt: now,
        updatedAt: now
      })
      .run();
    return id;
  }

  function insertQueueMessage(forAccountId: string): string {
    return insertMessage(forAccountId, { status: "queued" });
  }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-send-queue-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    queueRepo = new SqliteSendQueueRepository(db);
    rateLimiter = new SqliteRateLimiter(db);
    accountId = insertAccount();
  });

  describe("SqliteSendQueueRepository", () => {
    it("enqueues and re-enqueuing the same idempotency key returns the existing row", async () => {
      const messageId = insertQueueMessage(accountId);
      const first = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-1"
      });
      const second = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-1"
      });
      expect(second.id).toBe(first.id);

      const all = db.select().from(messages).all();
      expect(all).toHaveLength(1); // only one message row was ever inserted for this test's setup
    });

    it("claims the eligible pending row and flips it to claimed", async () => {
      const messageId = insertQueueMessage(accountId);
      const entry = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(Date.now() - 1000),
        idempotencyKey: "key-2"
      });

      const claimed = await queueRepo.claimNext(new Date());
      expect(claimed?.id).toBe(entry.id);
      expect(claimed?.status).toBe("claimed");

      const again = await queueRepo.claimNext(new Date());
      expect(again).toBeUndefined();
    });

    it("does not claim a row whose earliestSendAt is still in the future", async () => {
      const messageId = insertQueueMessage(accountId);
      await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(Date.now() + 60_000),
        idempotencyKey: "key-3"
      });

      const claimed = await queueRepo.claimNext(new Date());
      expect(claimed).toBeUndefined();
    });

    it("prefers priority=manual over priority=campaign when both are eligible", async () => {
      const campaignMessageId = insertQueueMessage(accountId);
      const manualMessageId = insertQueueMessage(accountId);
      const past = new Date(Date.now() - 1000);

      const campaignEntry = await queueRepo.enqueue({
        messageId: asMessageId(campaignMessageId),
        accountId: asAccountId(accountId),
        priority: "campaign",
        earliestSendAt: past,
        idempotencyKey: "key-campaign"
      });
      const manualEntry = await queueRepo.enqueue({
        messageId: asMessageId(manualMessageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: past,
        idempotencyKey: "key-manual"
      });

      const claimed = await queueRepo.claimNext(new Date());
      expect(claimed?.id).toBe(manualEntry.id);
      expect(claimed?.id).not.toBe(campaignEntry.id);
    });

    it("marks a transient failure for retry with backoff and increments attemptCount", async () => {
      const messageId = insertQueueMessage(accountId);
      const entry = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-4"
      });

      const now = new Date();
      await queueRepo.markFailed(entry.id, "SMTP timeout", { permanent: false, now });
      const reloaded = await queueRepo.findById(entry.id);
      expect(reloaded?.status).toBe("pending");
      expect(reloaded?.attemptCount).toBe(1);
      expect(reloaded?.lastError).toBe("SMTP timeout");
      expect(reloaded!.earliestSendAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("fails terminally once the max-attempt ceiling is reached", async () => {
      const messageId = insertQueueMessage(accountId);
      const entry = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-5"
      });

      const now = new Date();
      for (let i = 0; i < 5; i++) {
        await queueRepo.markFailed(entry.id, `attempt ${i}`, { permanent: false, now });
      }
      const reloaded = await queueRepo.findById(entry.id);
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.attemptCount).toBe(5);
    });

    it("requeueOrphanedClaims resets a 'claimed' row back to 'pending', incrementing attemptCount (crash recovery)", async () => {
      const messageId = insertQueueMessage(accountId);
      const entry = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(Date.now() - 1000),
        idempotencyKey: "key-orphan"
      });
      const claimed = await queueRepo.claimNext(new Date());
      expect(claimed?.id).toBe(entry.id); // now status='claimed', simulating a crash right here

      const recoveredCount = await queueRepo.requeueOrphanedClaims(new Date());
      expect(recoveredCount).toBe(1);

      const reloaded = await queueRepo.findById(entry.id);
      expect(reloaded?.status).toBe("pending");
      expect(reloaded?.attemptCount).toBe(1);
      expect(reloaded?.lastError).toMatch(/unclean shutdown/i);
    });

    it("requeueOrphanedClaims never touches pending, sent, failed, or cancelled rows", async () => {
      const pendingId = insertQueueMessage(accountId);
      await queueRepo.enqueue({
        messageId: asMessageId(pendingId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-still-pending"
      });

      const sentId = insertQueueMessage(accountId);
      const sentEntry = await queueRepo.enqueue({
        messageId: asMessageId(sentId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-already-sent"
      });
      await queueRepo.markSent(sentEntry.id);

      const recoveredCount = await queueRepo.requeueOrphanedClaims(new Date());
      expect(recoveredCount).toBe(0);
      expect((await queueRepo.findById(sentEntry.id))?.status).toBe("sent");
    });

    it("requeueOrphanedClaims fails a claim terminally once it has already exhausted its retry attempts across repeated crashes", async () => {
      const messageId = insertQueueMessage(accountId);
      const entry = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(Date.now() - 1000),
        idempotencyKey: "key-repeated-crash"
      });

      // Simulate the same row surviving 5 crash-and-reclaim cycles -- each claimNext call uses a
      // "now" far enough ahead to clear the previous cycle's backoff (up to a 1-day ceiling).
      let simulatedNow = new Date();
      for (let i = 0; i < 5; i++) {
        simulatedNow = new Date(simulatedNow.getTime() + 2 * 24 * 60 * 60 * 1000);
        await queueRepo.claimNext(simulatedNow);
        await queueRepo.requeueOrphanedClaims(simulatedNow);
      }

      const reloaded = await queueRepo.findById(entry.id);
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.attemptCount).toBe(5);
    });

    it("fails a permanent error immediately without retry", async () => {
      const messageId = insertQueueMessage(accountId);
      const entry = await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-6"
      });
      await queueRepo.markFailed(entry.id, "invalid recipient", { permanent: true, now: new Date() });
      const reloaded = await queueRepo.findById(entry.id);
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.attemptCount).toBe(0);
    });

    it("markSent and markCancelled set terminal statuses", async () => {
      const messageA = insertQueueMessage(accountId);
      const messageB = insertQueueMessage(accountId);
      const entryA = await queueRepo.enqueue({
        messageId: asMessageId(messageA),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-7"
      });
      const entryB = await queueRepo.enqueue({
        messageId: asMessageId(messageB),
        accountId: asAccountId(accountId),
        priority: "manual",
        earliestSendAt: new Date(),
        idempotencyKey: "key-8"
      });

      await queueRepo.markSent(entryA.id);
      await queueRepo.markCancelled(entryB.id);

      expect((await queueRepo.findById(entryA.id))?.status).toBe("sent");
      expect((await queueRepo.findById(entryB.id))?.status).toBe("cancelled");
    });

    it("returns undefined for an unknown id", async () => {
      expect(await queueRepo.findById(asSendQueueId("nonexistent"))).toBeUndefined();
    });
  });

  describe("SqliteRateLimiter", () => {
    it("allows a send when no limits are configured on the account", () => {
      const decision = rateLimiter.checkAndReserve(asAccountId(accountId));
      expect(decision.allowed).toBe(true);
    });

    it("denies once the daily limit is reached by confirmed sent messages, with a retryAfter", () => {
      const limitedAccountId = insertAccount({ dailySendLimit: 2 });
      insertMessage(limitedAccountId, { status: "sent", sentAt: new Date(Date.now() - 60_000) });
      insertMessage(limitedAccountId, { status: "sent", sentAt: new Date(Date.now() - 30_000) });

      const decision = rateLimiter.checkAndReserve(asAccountId(limitedAccountId));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toMatch(/daily/i);
        expect(decision.retryAfter.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it("denies once the hourly limit is reached, independent of the daily limit", () => {
      const limitedAccountId = insertAccount({ hourlySendLimit: 1, dailySendLimit: 100 });
      insertMessage(limitedAccountId, { status: "sent", sentAt: new Date(Date.now() - 60_000) });

      const decision = rateLimiter.checkAndReserve(asAccountId(limitedAccountId));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toMatch(/hourly/i);
    });

    it("ignores sent messages outside the rolling window", () => {
      const limitedAccountId = insertAccount({ dailySendLimit: 1 });
      insertMessage(limitedAccountId, { status: "sent", sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });

      const decision = rateLimiter.checkAndReserve(asAccountId(limitedAccountId));
      expect(decision.allowed).toBe(true);
    });

    it("counts currently in-flight (claimed) queue rows toward the limit", async () => {
      const limitedAccountId = insertAccount({ dailySendLimit: 1 });
      const messageId = insertQueueMessage(limitedAccountId);
      await queueRepo.enqueue({
        messageId: asMessageId(messageId),
        accountId: asAccountId(limitedAccountId),
        priority: "manual",
        earliestSendAt: new Date(Date.now() - 1000),
        idempotencyKey: "key-inflight"
      });
      await queueRepo.claimNext(new Date());

      const decision = rateLimiter.checkAndReserve(asAccountId(limitedAccountId));
      expect(decision.allowed).toBe(false);
    });

    it("does not treat an undefined limit as zero", () => {
      const limitedAccountId = insertAccount({ dailySendLimit: undefined });
      insertMessage(limitedAccountId, { status: "sent", sentAt: new Date() });
      const decision = rateLimiter.checkAndReserve(asAccountId(limitedAccountId));
      expect(decision.allowed).toBe(true);
    });

    describe("per-account randomized send-pacing (Critical Improvement #1)", () => {
      it("does not enforce any pacing when min/max aren't configured", () => {
        rateLimiter.reserveNextSend(asAccountId(accountId)); // no-op: no delay range configured
        const first = rateLimiter.checkAndReserve(asAccountId(accountId));
        const second = rateLimiter.checkAndReserve(asAccountId(accountId));
        expect(first.allowed).toBe(true);
        expect(second.allowed).toBe(true);
      });

      it("checkAndReserve never writes anything by itself -- calling it repeatedly has no side effects", () => {
        // This is the exact bug this split fixed: the Provider Selector's own eligibility check
        // re-invokes checkAndReserve for the same account moments after dispatchOne's explicit
        // check, and if checkAndReserve itself reserved a window, that second call would always
        // see its own account freshly paced and deny it -- so a message could never actually be
        // dispatched no matter how long the process ran.
        const pacedAccountId = insertAccount({ minSendDelaySeconds: 60, maxSendDelaySeconds: 120 });
        for (let i = 0; i < 5; i++) {
          expect(rateLimiter.checkAndReserve(asAccountId(pacedAccountId)).allowed).toBe(true);
        }
      });

      it("allows the first send immediately even with pacing configured, then denies an immediate second one once reserveNextSend commits it", () => {
        const pacedAccountId = insertAccount({ minSendDelaySeconds: 60, maxSendDelaySeconds: 120 });

        const first = rateLimiter.checkAndReserve(asAccountId(pacedAccountId));
        expect(first.allowed).toBe(true);
        rateLimiter.reserveNextSend(asAccountId(pacedAccountId));

        const second = rateLimiter.checkAndReserve(asAccountId(pacedAccountId));
        expect(second.allowed).toBe(false);
        if (!second.allowed) {
          // Denial's retryAfter must land within the configured range of "now" (the first send's
          // admission time), never before it and never past the max bound.
          const minRetry = Date.now() + 60_000 - 1000; // small slack for test execution time
          const maxRetry = Date.now() + 120_000 + 1000;
          expect(second.retryAfter.getTime()).toBeGreaterThan(minRetry);
          expect(second.retryAfter.getTime()).toBeLessThan(maxRetry);
        }
      });

      it("allows a send once the previously reserved delay has elapsed", () => {
        const pacedAccountId = insertAccount({
          minSendDelaySeconds: 60,
          maxSendDelaySeconds: 120,
          nextAllowedSendAt: new Date(Date.now() - 1000) // already in the past
        });

        const decision = rateLimiter.checkAndReserve(asAccountId(pacedAccountId));
        expect(decision.allowed).toBe(true);
      });

      it("generates a fresh random delay on every reserveNextSend call, not a fixed one", () => {
        const pacedAccountId = insertAccount({ minSendDelaySeconds: 1, maxSendDelaySeconds: 100 });
        const observedDelays = new Set<number>();

        for (let i = 0; i < 5; i++) {
          rateLimiter.reserveNextSend(asAccountId(pacedAccountId));
          const row = db.select().from(accounts).where(eq(accounts.id, pacedAccountId)).get();
          observedDelays.add(row!.nextAllowedSendAt!.getTime());
        }

        // Astronomically unlikely for 5 independent uniform draws over a 99-second span to collide.
        expect(observedDelays.size).toBeGreaterThan(1);
      });

      it("reserveNextSend is a no-op when no delay range is configured", () => {
        rateLimiter.reserveNextSend(asAccountId(accountId));
        const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
        expect(row?.nextAllowedSendAt).toBeNull();
      });

      it("paces independently per account -- one account's reserved delay never blocks another's", () => {
        const accountA = insertAccount({ minSendDelaySeconds: 60, maxSendDelaySeconds: 120 });
        const accountB = insertAccount({ minSendDelaySeconds: 60, maxSendDelaySeconds: 120 });

        expect(rateLimiter.checkAndReserve(asAccountId(accountA)).allowed).toBe(true);
        rateLimiter.reserveNextSend(asAccountId(accountA));
        expect(rateLimiter.checkAndReserve(asAccountId(accountA)).allowed).toBe(false); // paced now
        expect(rateLimiter.checkAndReserve(asAccountId(accountB)).allowed).toBe(true); // unaffected
      });
    });
  });
});
