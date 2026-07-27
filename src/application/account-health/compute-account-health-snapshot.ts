import { computeAccountHealth } from "../../core/account-health/engine.js";
import type { AccountHealthResult } from "../../core/account-health/types.js";
import type { AccountHealthMetricsSource } from "../../ports/account-health-metrics.port.js";
import type { AccountHealthRepository } from "../../ports/account-health-repository.port.js";
import type { DomainAuthChecker } from "../../ports/domain-auth-checker.port.js";
import type { AccountRef, MailProvider } from "../../ports/mail-provider.port.js";

/**
 * Orchestrates an Account Health snapshot (Section 19): gathers real local metrics, a real DNS
 * auth-posture check, and a real live authentication attempt, then runs the pure scoring engine
 * and persists the result. Manually triggered in this phase — a periodic background sweep
 * (Section 17.3's "Periodic (background)" mode) needs the Scheduler, which doesn't exist until
 * Phase 4.
 */

export interface ComputeAccountHealthSnapshotParams {
  accountRef: AccountRef;
  provider: MailProvider;
  metricsSource: AccountHealthMetricsSource;
  authChecker: DomainAuthChecker;
  repository: AccountHealthRepository;
  providerName: string;
  now?: Date;
}

export async function computeAccountHealthSnapshot(
  params: ComputeAccountHealthSnapshotParams
): Promise<AccountHealthResult> {
  const now = params.now ?? new Date();
  const domain = params.accountRef.emailAddress.split("@")[1] ?? "";

  const [metrics, authStatus, liveAuthCheckPassed] = await Promise.all([
    params.metricsSource.getMetrics(params.accountRef.accountId, now),
    params.authChecker.check(domain, params.providerName),
    params.provider
      .authenticate(params.accountRef)
      .then(() => true)
      .catch(() => false)
  ]);

  const input = { metrics, authStatus, liveAuthCheckPassed };
  const result = computeAccountHealth(input);

  await params.repository.save({
    accountId: params.accountRef.accountId,
    capturedAt: now,
    input,
    result
  });

  return result;
}
