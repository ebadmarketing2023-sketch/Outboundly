import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { computeAccountHealthSnapshot } from "../../src/application/account-health/compute-account-health-snapshot.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountDirectory } from "../../src/adapters/persistence/repositories/account-directory.js";
import { SqliteAccountHealthMetricsSource } from "../../src/adapters/persistence/repositories/account-health-metrics-source.js";
import { SqliteAccountHealthRepository } from "../../src/adapters/persistence/repositories/account-health-repository.js";
import { SqliteNotificationRepository } from "../../src/adapters/persistence/repositories/notification-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import type { DomainAuthChecker, DomainAuthStatus } from "../../src/ports/domain-auth-checker.port.js";
import type { AccountRef, MailProvider } from "../../src/ports/mail-provider.port.js";

class FakeDomainAuthChecker implements DomainAuthChecker {
  constructor(private readonly status: DomainAuthStatus) {}
  async check(): Promise<DomainAuthStatus> {
    return this.status;
  }
}

/** Only `authenticate` matters to computeAccountHealthSnapshot; everything else throws so a test
 * fails loudly if it's ever accidentally exercised. */
class FakeMailProvider implements MailProvider {
  constructor(private readonly authenticateShouldSucceed: boolean) {}
  async authenticate(_account: AccountRef): Promise<void> {
    if (!this.authenticateShouldSucceed) throw new Error("simulated auth failure");
  }
  sendMessage(): never {
    throw new Error("not used by this test");
  }
  createDraft(): never {
    throw new Error("not used by this test");
  }
  sendDraft(): never {
    throw new Error("not used by this test");
  }
  listChangesSince(): never {
    throw new Error("not used by this test");
  }
  fetchMessage(): never {
    throw new Error("not used by this test");
  }
  fetchThread(): never {
    throw new Error("not used by this test");
  }
  appendToSentFolder(): never {
    throw new Error("not used by this test");
  }
  capabilities(): never {
    throw new Error("not used by this test");
  }
}

const HEALTHY_AUTH_STATUS: DomainAuthStatus = { spf: "pass", dkim: "pass", dmarc: "pass" };

describe("computeAccountHealthSnapshot (Section 19, notifications surfaced per Section 19.2 diagram)", () => {
  let db: OutboundlyDb;
  let accountId: string;
  let accountRef: AccountRef;
  let notificationRepository: SqliteNotificationRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-account-health-snapshot-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
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
    accountRef = { accountId: asAccountId(accountId), emailAddress: "me@outboundly.app" };
    notificationRepository = new SqliteNotificationRepository(db);
  });

  it("records a critical account_health_issue notification when the live auth check fails", async () => {
    const result = await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider(false),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google"
    });
    expect(result.riskLevel).toBe("critical");

    const unread = await notificationRepository.findUnread(10);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.notificationType).toBe("account_health_issue");
    expect(unread[0]?.severity).toBe("critical");
    expect(unread[0]?.relatedAccountId).toBe(accountId);
    expect(unread[0]?.message).toMatch(/me@outboundly\.app/);
  });

  it("does not record a notification for a healthy account", async () => {
    const result = await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider(true),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google"
    });
    expect(result.riskLevel).toBe("healthy");
    expect(await notificationRepository.findUnread(10)).toEqual([]);
  });

  it("flips accounts.status to reauth_required when the live auth check fails and an accountDirectory is provided", async () => {
    const accountDirectory = new SqliteAccountDirectory(db);
    await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider(false),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google",
      accountDirectory
    });

    const entries = await accountDirectory.list();
    expect(entries.find((e) => e.id === accountId)?.status).toBe("reauth_required");
  });

  it("flips accounts.status back to connected once a subsequent live auth check succeeds", async () => {
    const accountDirectory = new SqliteAccountDirectory(db);
    const commonParams = {
      accountRef,
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google",
      accountDirectory
    };

    await computeAccountHealthSnapshot({ ...commonParams, provider: new FakeMailProvider(false) });
    expect((await accountDirectory.list()).find((e) => e.id === accountId)?.status).toBe("reauth_required");

    await computeAccountHealthSnapshot({ ...commonParams, provider: new FakeMailProvider(true) });
    expect((await accountDirectory.list()).find((e) => e.id === accountId)?.status).toBe("connected");
  });

  it("leaves accounts.status untouched when no accountDirectory is passed (manual-trigger backward compatibility)", async () => {
    await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider(false),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google"
    });

    const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    expect(row?.status).toBe("connected");
  });
});
