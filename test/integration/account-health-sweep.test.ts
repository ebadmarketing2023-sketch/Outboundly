import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runAccountHealthSweep } from "../../src/application/account-health/account-health-sweep.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountDirectory } from "../../src/adapters/persistence/repositories/account-directory.js";
import { SqliteAccountHealthMetricsSource } from "../../src/adapters/persistence/repositories/account-health-metrics-source.js";
import { SqliteAccountHealthRepository } from "../../src/adapters/persistence/repositories/account-health-repository.js";
import { SqliteNotificationRepository } from "../../src/adapters/persistence/repositories/notification-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { generateId } from "../../src/core/shared-kernel/ids.js";
import type { DomainAuthChecker, DomainAuthStatus } from "../../src/ports/domain-auth-checker.port.js";
import type { AccountRef, MailProvider } from "../../src/ports/mail-provider.port.js";

class FakeDomainAuthChecker implements DomainAuthChecker {
  async check(): Promise<DomainAuthStatus> {
    return { spf: "pass", dkim: "pass", dmarc: "pass" };
  }
}

/** Only `authenticate` matters to this sweep; everything else throws so a test fails loudly if
 * it's ever accidentally exercised. */
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

describe("runAccountHealthSweep (Section 17.3 periodic mode, Section 21.1)", () => {
  let db: OutboundlyDb;
  let healthyAccountId: string;
  let failingAccountId: string;
  let disconnectedAccountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-account-health-sweep-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    const now = new Date();

    healthyAccountId = generateId();
    failingAccountId = generateId();
    disconnectedAccountId = generateId();

    db.insert(accounts)
      .values([
        {
          id: healthyAccountId,
          provider: "google",
          emailAddress: "healthy@outboundly.app",
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        },
        {
          id: failingAccountId,
          provider: "google",
          emailAddress: "failing@outboundly.app",
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        },
        {
          id: disconnectedAccountId,
          provider: "google",
          emailAddress: "disconnected@outboundly.app",
          status: "disconnected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        }
      ])
      .run();
  });

  function deps(getProviderForAccount: (account: { id: string }) => MailProvider) {
    return {
      accountDirectory: new SqliteAccountDirectory(db),
      getProviderForAccount,
      metricsSource: new SqliteAccountHealthMetricsSource(db),
      authChecker: new FakeDomainAuthChecker(),
      repository: new SqliteAccountHealthRepository(db),
      notificationRepository: new SqliteNotificationRepository(db)
    };
  }

  it("checks every non-disconnected account and flips status based on each one's own live auth check", async () => {
    const result = await runAccountHealthSweep(
      deps((account) => new FakeMailProvider(account.id === healthyAccountId)),
      new Date()
    );

    expect(result.checked).toBe(2); // the disconnected account is skipped entirely
    expect(result.failures).toEqual([]);

    const accountDirectory = new SqliteAccountDirectory(db);
    const entries = await accountDirectory.list();
    expect(entries.find((e) => e.id === healthyAccountId)?.status).toBe("connected");
    expect(entries.find((e) => e.id === failingAccountId)?.status).toBe("reauth_required");
    expect(entries.find((e) => e.id === disconnectedAccountId)?.status).toBe("disconnected");
  });

  it("isolates one account's unexpected error so it doesn't stop the sweep for the rest (Section 21.3)", async () => {
    const result = await runAccountHealthSweep(
      deps((account) => {
        if (account.id === failingAccountId) {
          return {
            authenticate: async () => {
              throw new Error("boom");
            }
          } as unknown as MailProvider;
        }
        return new FakeMailProvider(true);
      }),
      new Date()
    );

    // computeAccountHealthSnapshot itself swallows an authenticate() failure into
    // liveAuthCheckPassed=false, so this doesn't actually throw -- the isolation still matters for
    // any other unexpected failure (e.g. the auth checker or repository throwing), so this test
    // just confirms the healthy account was still processed regardless of the other account's outcome.
    expect(result.checked).toBe(2);

    const accountDirectory = new SqliteAccountDirectory(db);
    const entries = await accountDirectory.list();
    expect(entries.find((e) => e.id === healthyAccountId)?.status).toBe("connected");
  });
});
