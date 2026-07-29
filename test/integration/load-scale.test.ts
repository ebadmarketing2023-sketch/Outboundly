import RawDatabase from "better-sqlite3-multiple-ciphers";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteSendQueueRepository } from "../../src/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts, campaignEnrollments, contacts, messages, sendQueue } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";

/**
 * Load testing (Section 24.5): "Thousands of campaigns, large queues, multiple accounts --
 * verifying the DB-backed queue polling approach ... holds up at the scale a power user might
 * reach (tens of thousands of enrollments), and that the index choices in Section 5.10 keep the
 * hot-path queries ... fast at that scale."
 *
 * Two things are verified, not just one: an EXPLAIN QUERY PLAN assertion that the hot-path query
 * actually uses its index (SEARCH, not SCAN) -- the real, mechanism-level guarantee -- plus a
 * generous wall-clock ceiling as a sanity check that would fail loudly if the index were somehow
 * not helping in practice. The timing bound is intentionally loose (multiple seconds) since CI
 * hardware varies; it exists to catch "accidentally doing a full table scan," not to benchmark.
 */

const ROW_COUNT = 20_000;
const BATCH_SIZE = 500;

function insertInBatches<T>(rows: T[], insertBatch: (batch: T[]) => void): void {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    insertBatch(rows.slice(i, i + BATCH_SIZE));
  }
}

function explainUsesIndex(dbPath: string, encryptionKey: string, sql: string, params: unknown[]): boolean {
  const raw = new RawDatabase(dbPath);
  raw.pragma("cipher='sqlcipher'");
  raw.pragma(`key="x'${encryptionKey}'"`);
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[];
  raw.close();
  return plan.some((row) => /USING INDEX|SEARCH/i.test(row.detail) && !/SCAN TABLE/i.test(row.detail));
}

describe("Load testing at scale (Section 24.5)", () => {
  it("keeps campaign_enrollments due-for-scheduling and send_queue claim queries index-backed at tens of thousands of rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-load-scale-test-"));
    const dbPath = join(dir, "test.sqlite");
    const encryptionKey = randomBytes(32).toString("hex");
    const db: OutboundlyDb = openDatabase(dbPath, encryptionKey);

    const accountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id: accountId,
        provider: "google",
        emailAddress: "me@outboundly.app",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    // Genuinely every day (not just Monday), matching the fix in send-worker-tick.test.ts -- this
    // avoids the same class of day-of-week fragility even where the current assertions don't
    // happen to exercise the send_queue claim query's earliestSendAt <= now filter.
    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
      name: "Always open",
      timezone: "UTC",
      windows: {
        sunday: [{ start: "00:00", end: "23:59" }],
        monday: [{ start: "00:00", end: "23:59" }],
        tuesday: [{ start: "00:00", end: "23:59" }],
        wednesday: [{ start: "00:00", end: "23:59" }],
        thursday: [{ start: "00:00", end: "23:59" }],
        friday: [{ start: "00:00", end: "23:59" }],
        saturday: [{ start: "00:00", end: "23:59" }]
      }
    });
    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaignRepository = new SqliteCampaignRepository(db);
    const campaign = await campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    // findDueForScheduling only considers enrollments whose parent campaign is 'running' (Section
    // 14.2) -- a freshly created campaign defaults to 'draft', which must never fire on its own.
    await campaignRepository.setStatus(campaign.id, "running");
    const stepId = sequence.steps[0]!.id;

    // One real message row, reused as send_queue's messageId FK target across every queue row --
    // the hot-path query being tested never joins messages, so a single valid FK target is enough.
    const messageId = generateId();
    db.insert(messages)
      .values({
        id: messageId,
        accountId,
        messageIdHeader: `<load-test@outboundly>`,
        direction: "outbound",
        fromAddress: "me@outboundly.app",
        toAddresses: ["someone@example.com"],
        status: "queued",
        createdAt: now,
        updatedAt: now
      })
      .run();

    // Seed ROW_COUNT contacts + campaign_enrollments: ~10% due (nextSendAt in the past), the rest
    // spread into the future -- a realistic "mostly not due yet" distribution.
    const contactRows = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: generateId(),
      email: `contact-${i}@load-test.example`,
      source: "manual" as const,
      createdAt: now,
      updatedAt: now
    }));
    insertInBatches(contactRows, (batch) => db.insert(contacts).values(batch).run());

    const enrollmentRows = contactRows.map((contact, i) => ({
      id: generateId(),
      campaignId: campaign.id,
      contactId: contact.id,
      currentStepId: stepId,
      status: "active" as const,
      nextSendAt: i % 10 === 0 ? new Date(now.getTime() - 60_000) : new Date(now.getTime() + (i + 1) * 60_000),
      enrolledAt: now,
      updatedAt: now
    }));
    insertInBatches(enrollmentRows, (batch) => db.insert(campaignEnrollments).values(batch).run());

    const sendQueueRows = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: generateId(),
      messageId,
      accountId,
      priority: (i % 5 === 0 ? "manual" : "campaign") as "manual" | "campaign",
      earliestSendAt: i % 10 === 0 ? new Date(now.getTime() - 60_000) : new Date(now.getTime() + (i + 1) * 60_000),
      status: "pending" as const,
      idempotencyKey: `load-test-${i}`,
      createdAt: now
    }));
    insertInBatches(sendQueueRows, (batch) => db.insert(sendQueue).values(batch).run());

    // 1. EXPLAIN QUERY PLAN: the real, mechanism-level guarantee that the index is actually used.
    // Matches findDueForScheduling's real query (Section 14.2's campaign-status gate): joined to
    // campaigns on its primary key, which is itself always index-backed, so the join doesn't
    // reintroduce a full scan on the large campaign_enrollments side.
    expect(
      explainUsesIndex(
        dbPath,
        encryptionKey,
        "SELECT * FROM campaign_enrollments JOIN campaigns ON campaign_enrollments.campaign_id = campaigns.id " +
          "WHERE campaign_enrollments.status = ? AND campaign_enrollments.next_send_at <= ? AND campaigns.status = ?",
        ["active", now.getTime(), "running"]
      )
    ).toBe(true);
    expect(
      explainUsesIndex(
        dbPath,
        encryptionKey,
        "SELECT * FROM send_queue WHERE status = ? AND priority = ? AND earliest_send_at <= ? ORDER BY earliest_send_at",
        ["pending", "campaign", now.getTime()]
      )
    ).toBe(true);

    // 2. Wall-clock sanity ceiling -- generous, just to catch an accidental full scan in practice.
    const enrollmentRepository = new SqliteEnrollmentRepository(db);
    const dueStart = performance.now();
    const due = await enrollmentRepository.findDueForScheduling(now);
    const dueElapsedMs = performance.now() - dueStart;
    expect(due.length).toBe(Math.ceil(ROW_COUNT / 10));
    expect(dueElapsedMs).toBeLessThan(2000);

    const sendQueueRepository = new SqliteSendQueueRepository(db);
    const claimStart = performance.now();
    const claimed = await sendQueueRepository.claimNext(now);
    const claimElapsedMs = performance.now() - claimStart;
    expect(claimed).toBeDefined();
    expect(claimElapsedMs).toBeLessThan(2000);
  }, 30_000);
});
