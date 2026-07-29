import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteErrorLogRepository } from "../../src/adapters/persistence/repositories/error-log-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, asCampaignId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("SqliteErrorLogRepository (Critical Improvement #12)", () => {
  let db: OutboundlyDb;
  let repo: SqliteErrorLogRepository;
  let accountId: string;
  let campaignId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-error-log-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteErrorLogRepository(db);

    accountId = generateId();
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

    const businessHoursProfile = await new SqliteBusinessHoursProfileRepository(db).create({
      name: "Always open",
      timezone: "UTC",
      windows: { monday: [{ start: "00:00", end: "23:59" }] }
    });
    const template = await new SqliteTemplateRepository(db).create({ name: "T", document: { blocks: [] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    const campaign = await new SqliteCampaignRepository(db).create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId: businessHoursProfile.id
    });
    campaignId = campaign.id;
  });

  it("records and retrieves a full entry with every field populated", async () => {
    const occurredAt = new Date();
    await repo.record({
      occurredAt,
      source: "send-worker",
      errorType: "permanent_smtp_rejection",
      errorMessage: "550 no such user",
      campaignId: asCampaignId(campaignId),
      accountId: asAccountId(accountId),
      recipientEmail: "lead@example.com",
      retryCount: 2
    });

    const recent = await repo.listRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      source: "send-worker",
      errorType: "permanent_smtp_rejection",
      errorMessage: "550 no such user",
      campaignId,
      accountId,
      recipientEmail: "lead@example.com",
      retryCount: 2
    });
    expect(recent[0]!.occurredAt.getTime()).toBe(occurredAt.getTime());
  });

  it("records a minimal entry (no campaign/account/recipient/retry count)", async () => {
    await repo.record({
      occurredAt: new Date(),
      source: "account-health-sweep",
      errorType: "dns_lookup_failed",
      errorMessage: "ENOTFOUND"
    });

    const [entry] = await repo.listRecent(10);
    expect(entry?.campaignId).toBeUndefined();
    expect(entry?.accountId).toBeUndefined();
    expect(entry?.recipientEmail).toBeUndefined();
    expect(entry?.retryCount).toBeUndefined();
  });

  it("listRecent returns newest first and respects the limit", async () => {
    const t1 = new Date(Date.now() - 3000);
    const t2 = new Date(Date.now() - 2000);
    const t3 = new Date(Date.now() - 1000);
    await repo.record({ occurredAt: t1, source: "scheduler", errorType: "e1", errorMessage: "first" });
    await repo.record({ occurredAt: t2, source: "scheduler", errorType: "e2", errorMessage: "second" });
    await repo.record({ occurredAt: t3, source: "scheduler", errorType: "e3", errorMessage: "third" });

    const recent = await repo.listRecent(2);
    expect(recent.map((e) => e.errorMessage)).toEqual(["third", "second"]);
  });

  it("listRecent filters by source when given one", async () => {
    await repo.record({ occurredAt: new Date(), source: "send-worker", errorType: "e1", errorMessage: "send failure" });
    await repo.record({ occurredAt: new Date(), source: "inbox-sync", errorType: "e2", errorMessage: "sync failure" });

    const sendOnly = await repo.listRecent(10, "send-worker");
    expect(sendOnly.map((e) => e.errorMessage)).toEqual(["send failure"]);
  });
});
