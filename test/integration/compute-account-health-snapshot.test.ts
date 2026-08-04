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
import { SqliteErrorLogRepository } from "../../src/adapters/persistence/repositories/error-log-repository.js";
import { SqliteNotificationRepository } from "../../src/adapters/persistence/repositories/notification-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";
import type { DomainAuthChecker, DomainAuthStatus } from "../../src/ports/domain-auth-checker.port.js";
import { AccountReauthRequiredError, type AccountRef, type MailProvider } from "../../src/ports/mail-provider.port.js";

class FakeDomainAuthChecker implements DomainAuthChecker {
  constructor(private readonly status: DomainAuthStatus) {}
  async check(): Promise<DomainAuthStatus> {
    return this.status;
  }
}

type AuthOutcome = "pass" | "revoked" | "transient";

/** Only `authenticate` matters to computeAccountHealthSnapshot; everything else throws so a test
 * fails loudly if it's ever accidentally exercised. "revoked" throws the specific error type that
 * means a real, permanent revocation (only this should ever flip accounts.status); "transient"
 * throws a plain error to simulate a network blip or other inconclusive failure, which must NOT
 * flip status or raise a critical finding -- that distinction is the whole point of this fix. */
class FakeMailProvider implements MailProvider {
  constructor(private readonly outcome: AuthOutcome) {}
  async authenticate(_account: AccountRef): Promise<void> {
    if (this.outcome === "revoked") throw new AccountReauthRequiredError("simulated revoked token");
    if (this.outcome === "transient") throw new Error("simulated transient network error");
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

  it("records a critical account_health_issue notification when the live auth check reports a genuine revocation", async () => {
    const result = await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider("revoked"),
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
      provider: new FakeMailProvider("pass"),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google"
    });
    expect(result.riskLevel).toBe("healthy");
    expect(await notificationRepository.findUnread(10)).toEqual([]);
  });

  // A real reported bug: a transient failure (a network blip, a provider's own 5xx, a momentary
  // keychain hiccup) used to be indistinguishable from a genuinely revoked token here, flipping a
  // perfectly healthy account to reauth_required and firing a disruptive critical notification.
  it("does NOT record a notification or degrade health for a transient/unclassified auth-check error", async () => {
    const result = await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider("transient"),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google"
    });
    expect(result.riskLevel).toBe("healthy");
    expect(await notificationRepository.findUnread(10)).toEqual([]);
  });

  it("logs a transient/unclassified auth-check error as a structured entry when an errorLogRepository is provided", async () => {
    const errorLogRepository = new SqliteErrorLogRepository(db);
    await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider("transient"),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google",
      errorLogRepository
    });

    const logged = await errorLogRepository.listRecent(10);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.errorType).toBe("auth_check_inconclusive");
    expect(logged[0]?.errorMessage).toBe("simulated transient network error");
    expect(logged[0]?.accountId).toBe(accountId);
  });

  it("flips accounts.status to reauth_required when the live auth check reports a genuine revocation and an accountDirectory is provided", async () => {
    const accountDirectory = new SqliteAccountDirectory(db);
    await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider("revoked"),
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

  it("leaves accounts.status untouched on a transient/unclassified auth-check error, neither flipping to reauth_required nor optimistically to connected", async () => {
    const accountDirectory = new SqliteAccountDirectory(db);
    await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider("transient"),
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(HEALTHY_AUTH_STATUS),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository,
      providerName: "google",
      accountDirectory
    });

    const entries = await accountDirectory.list();
    // Started as "connected" (see beforeEach) and must still read "connected" -- not because the
    // check passed, but because an inconclusive result must never touch status either way.
    expect(entries.find((e) => e.id === accountId)?.status).toBe("connected");
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

    await computeAccountHealthSnapshot({ ...commonParams, provider: new FakeMailProvider("revoked") });
    expect((await accountDirectory.list()).find((e) => e.id === accountId)?.status).toBe("reauth_required");

    await computeAccountHealthSnapshot({ ...commonParams, provider: new FakeMailProvider("pass") });
    expect((await accountDirectory.list()).find((e) => e.id === accountId)?.status).toBe("connected");
  });

  it("leaves accounts.status untouched when no accountDirectory is passed (manual-trigger backward compatibility)", async () => {
    await computeAccountHealthSnapshot({
      accountRef,
      provider: new FakeMailProvider("revoked"),
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
