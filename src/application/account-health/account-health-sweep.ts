import { computeAccountHealthSnapshot } from "./compute-account-health-snapshot.js";
import type { AccountDirectory, AccountDirectoryEntry } from "../../ports/account-directory.port.js";
import type { AccountHealthMetricsSource } from "../../ports/account-health-metrics.port.js";
import type { AccountHealthRepository } from "../../ports/account-health-repository.port.js";
import type { DomainAuthChecker } from "../../ports/domain-auth-checker.port.js";
import type { ErrorLogRepository } from "../../ports/error-log-repository.port.js";
import type { MailProvider } from "../../ports/mail-provider.port.js";
import type { NotificationRepository } from "../../ports/notification-repository.port.js";
import { asAccountId } from "../../core/shared-kernel/ids.js";

export interface AccountHealthSweepDeps {
  accountDirectory: AccountDirectory;
  getProviderForAccount: (account: AccountDirectoryEntry) => MailProvider;
  metricsSource: AccountHealthMetricsSource;
  authChecker: DomainAuthChecker;
  repository: AccountHealthRepository;
  notificationRepository: NotificationRepository;
  /** Optional (Critical Improvement #12): when provided, one account's check throwing is also
   * recorded as a structured, queryable log entry. Omitted in most existing tests since it's a
   * pure side effect. */
  errorLogRepository?: ErrorLogRepository;
}

export interface AccountHealthSweepResult {
  checked: number;
  failures: Array<{ accountId: string; error: string }>;
}

/**
 * Periodic Account Health sweep (Section 17.3's "Periodic (background)" mode, Section 21.1) --
 * the piece computeAccountHealthSnapshot's own docblock used to flag as missing until the
 * Scheduler existed. Runs the same snapshot computation the manual "Recompute" button uses, for
 * every account that isn't disconnected, and passes accountDirectory through so the live-auth
 * -check result flips accounts.status between 'connected' and 'reauth_required' -- making a
 * revoked/expired refresh token visible in the UI instead of only surfacing the next time
 * something tries to actually send or sync and fails.
 *
 * A transient failure (e.g. a network blip, not a real revoked token) would also flip an account
 * to 'reauth_required' here; this is self-correcting, since the next tick's successful check
 * flips it straight back to 'connected'.
 *
 * Section 21.3 failure isolation: one account's check throwing doesn't stop the sweep for the rest.
 */
export async function runAccountHealthSweep(deps: AccountHealthSweepDeps, now: Date): Promise<AccountHealthSweepResult> {
  const accounts = await deps.accountDirectory.list();
  const failures: AccountHealthSweepResult["failures"] = [];
  let checked = 0;

  for (const account of accounts) {
    if (account.status === "disconnected") continue;
    checked++;

    try {
      await computeAccountHealthSnapshot({
        accountRef: { accountId: account.id, emailAddress: account.emailAddress },
        provider: deps.getProviderForAccount(account),
        metricsSource: deps.metricsSource,
        authChecker: deps.authChecker,
        repository: deps.repository,
        notificationRepository: deps.notificationRepository,
        providerName: account.provider,
        accountDirectory: deps.accountDirectory,
        now
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failures.push({ accountId: account.id, error: errorMessage });
      await deps.errorLogRepository?.record({
        occurredAt: now,
        source: "account-health-sweep",
        errorType: "health_check_failed",
        errorMessage,
        accountId: asAccountId(account.id)
      });
    }
  }

  return { checked, failures };
}
