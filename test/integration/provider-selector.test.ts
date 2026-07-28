import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccountHealthResult } from "../../src/core/account-health/types.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountHealthRepository } from "../../src/adapters/persistence/repositories/account-health-repository.js";
import { SqliteProviderSelector } from "../../src/adapters/persistence/provider-selector.js";
import { SqliteRateLimiter } from "../../src/adapters/persistence/rate-limiter.js";
import { accounts, messages } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("SqliteProviderSelector (Section 16.3)", () => {
  let db: OutboundlyDb;
  let selector: SqliteProviderSelector;
  let healthRepo: SqliteAccountHealthRepository;

  function insertAccount(status: "connected" | "reauth_required" | "disconnected" = "connected"): string {
    const id = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id,
        provider: "google",
        emailAddress: `${id}@outboundly.app`,
        status,
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();
    return id;
  }

  async function setHealth(accountId: string, result: AccountHealthResult): Promise<void> {
    await healthRepo.save({
      accountId: asAccountId(accountId),
      capturedAt: new Date(),
      input: {
        metrics: { sendsLast24h: 0, sendsLast7d: 0, accountAgeDays: 30 },
        authStatus: { spf: "pass", dkim: "pass", dmarc: "pass" },
        liveAuthCheckPassed: true
      },
      result
    });
  }

  function insertSentMessage(accountId: string, sentAt: Date): void {
    const id = generateId();
    const now = new Date();
    db.insert(messages)
      .values({
        id,
        accountId,
        messageIdHeader: `<${id}@outboundly.app>`,
        direction: "outbound",
        fromAddress: "me@outboundly.app",
        toAddresses: ["them@example.com"],
        status: "sent",
        sentAt,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-provider-selector-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    healthRepo = new SqliteAccountHealthRepository(db);
    selector = new SqliteProviderSelector(db, healthRepo, new SqliteRateLimiter(db));
  });

  it("selects the candidate account unchanged when it is fully eligible", async () => {
    const accountId = insertAccount();
    const result = await selector.select({
      candidateAccountId: asAccountId(accountId),
      rotationPool: [asAccountId(accountId)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(accountId), substituted: false });
  });

  it("substitutes when the candidate account is disconnected", async () => {
    const disconnected = insertAccount("disconnected");
    const healthy = insertAccount("connected");
    const result = await selector.select({
      candidateAccountId: asAccountId(disconnected),
      rotationPool: [asAccountId(disconnected), asAccountId(healthy)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(healthy), substituted: true });
  });

  it("substitutes when the candidate account's latest health snapshot is critical", async () => {
    const critical = insertAccount();
    const healthy = insertAccount();
    await setHealth(critical, { healthScore: 20, riskLevel: "critical", findings: [] });

    const result = await selector.select({
      candidateAccountId: asAccountId(critical),
      rotationPool: [asAccountId(critical), asAccountId(healthy)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(healthy), substituted: true });
  });

  it("does not exclude a merely watch/at_risk account — only critical is disqualifying", async () => {
    const watchAccount = insertAccount();
    await setHealth(watchAccount, { healthScore: 65, riskLevel: "watch", findings: [] });

    const result = await selector.select({
      candidateAccountId: asAccountId(watchAccount),
      rotationPool: [asAccountId(watchAccount)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(watchAccount), substituted: false });
  });

  it("substitutes when the candidate account is over its rate limit", async () => {
    const overLimit = insertAccount();
    const healthy = insertAccount();
    await db.update(accounts).set({ dailySendLimit: 1 }).where(eq(accounts.id, overLimit)).run();
    insertSentMessage(overLimit, new Date());

    const result = await selector.select({
      candidateAccountId: asAccountId(overLimit),
      rotationPool: [asAccountId(overLimit), asAccountId(healthy)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(healthy), substituted: true });
  });

  it("skips an explicitly excluded account even if it would otherwise be eligible", async () => {
    const excluded = insertAccount();
    const healthy = insertAccount();
    const result = await selector.select({
      candidateAccountId: asAccountId(excluded),
      rotationPool: [asAccountId(excluded), asAccountId(healthy)],
      excludedAccountIds: [asAccountId(excluded)],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(healthy), substituted: true });
  });

  it("returns selected:false when no account in the rotation pool is eligible", async () => {
    const a = insertAccount("disconnected");
    const b = insertAccount("reauth_required");
    const result = await selector.select({
      candidateAccountId: asAccountId(a),
      rotationPool: [asAccountId(a), asAccountId(b)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result.selected).toBe(false);
  });

  it("round-robin picks the next eligible account after the candidate's position, wrapping around", async () => {
    const a = insertAccount("disconnected");
    const b = insertAccount("disconnected");
    const c = insertAccount("connected");
    const result = await selector.select({
      candidateAccountId: asAccountId(a),
      rotationPool: [asAccountId(a), asAccountId(b), asAccountId(c)],
      excludedAccountIds: [],
      strategy: "round-robin"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(c), substituted: true });
  });

  it("least-recently-used picks the eligible account with the oldest last-sent timestamp", async () => {
    const stale = insertAccount("disconnected"); // candidate, forces substitution
    const recentlyUsed = insertAccount();
    const longIdle = insertAccount();
    insertSentMessage(recentlyUsed, new Date(Date.now() - 60_000));
    insertSentMessage(longIdle, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));

    const result = await selector.select({
      candidateAccountId: asAccountId(stale),
      rotationPool: [asAccountId(stale), asAccountId(recentlyUsed), asAccountId(longIdle)],
      excludedAccountIds: [],
      strategy: "least-recently-used"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(longIdle), substituted: true });
  });

  it("health-weighted picks the eligible account with the highest health score", async () => {
    const stale = insertAccount("disconnected");
    const mediocre = insertAccount();
    const excellent = insertAccount();
    await setHealth(mediocre, { healthScore: 55, riskLevel: "watch", findings: [] });
    await setHealth(excellent, { healthScore: 95, riskLevel: "healthy", findings: [] });

    const result = await selector.select({
      candidateAccountId: asAccountId(stale),
      rotationPool: [asAccountId(stale), asAccountId(mediocre), asAccountId(excellent)],
      excludedAccountIds: [],
      strategy: "health-weighted"
    });
    expect(result).toEqual({ selected: true, accountId: asAccountId(excellent), substituted: true });
  });
});
