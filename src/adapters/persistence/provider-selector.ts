import { and, desc, eq } from "drizzle-orm";
import type { AccountId, CampaignId } from "../../core/shared-kernel/ids.js";
import type { AccountHealthRepository } from "../../ports/account-health-repository.port.js";
import type {
  ProviderSelectionInput,
  ProviderSelectionResult,
  ProviderSelector,
  RotationStrategy
} from "../../ports/provider-selector.port.js";
import type { RateLimiter } from "../../ports/rate-limiter.port.js";
import type { OutboundlyDb } from "./db.js";
import { accounts, messages } from "./schema.js";
import { sentByAccount } from "./sent-by-account.js";

const CRITICAL_RISK_LEVEL = "critical";

/**
 * SQLite-backed implementation of ProviderSelector (Section 16.3). Tries the Scheduler's proposed
 * candidateAccountId first (it already passed the Scheduling Policy Engine and the Queue's
 * authoritative RateLimiter); only re-validates and substitutes when something changed between
 * scheduling time and dispatch time (disconnected, newly critical health, unexpectedly over quota).
 * "Degraded" per Section 16.3 is treated as the critical risk level specifically — that's the one
 * severity the Account Health Engine (Section 19) forces regardless of numeric score band, meaning
 * something is actively broken (e.g. live auth failing) rather than merely trending down; watch/
 * at_risk accounts stay eligible so a rotation pool that's uniformly mediocre can still send.
 */
export class SqliteProviderSelector implements ProviderSelector {
  constructor(
    private readonly db: OutboundlyDb,
    private readonly accountHealthRepository: AccountHealthRepository,
    private readonly rateLimiter: RateLimiter
  ) {}

  async select(input: ProviderSelectionInput): Promise<ProviderSelectionResult> {
    const excluded = new Set(input.excludedAccountIds);

    if (!excluded.has(input.candidateAccountId) && (await this.isEligible(input.candidateAccountId, input.campaignId, input.excludeSendQueueId))) {
      return { selected: true, accountId: input.candidateAccountId, substituted: false };
    }

    const alternatives = input.rotationPool.filter(
      (accountId) => accountId !== input.candidateAccountId && !excluded.has(accountId)
    );

    const eligibleAlternatives: AccountId[] = [];
    for (const accountId of alternatives) {
      if (await this.isEligible(accountId, input.campaignId, input.excludeSendQueueId)) eligibleAlternatives.push(accountId);
    }

    if (eligibleAlternatives.length === 0) {
      return { selected: false, reason: "No eligible sending account available in the rotation pool" };
    }

    const chosen = await this.rankByStrategy(eligibleAlternatives, input.strategy, input.candidateAccountId, input.rotationPool);
    return { selected: true, accountId: chosen, substituted: true };
  }

  private async isEligible(accountId: AccountId, campaignId?: CampaignId, excludeSendQueueId?: string): Promise<boolean> {
    const account = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account || account.status !== "connected") return false;

    const snapshot = await this.accountHealthRepository.getLatest(accountId);
    if (snapshot?.result.riskLevel === CRITICAL_RISK_LEVEL) return false;

    return this.rateLimiter.checkAndReserve(accountId, campaignId, { excludeSendQueueId }).allowed;
  }

  private async rankByStrategy(
    candidates: AccountId[],
    strategy: RotationStrategy,
    originalCandidateAccountId: AccountId,
    rotationPool: AccountId[]
  ): Promise<AccountId> {
    if (strategy === "health-weighted") {
      const scored = await Promise.all(
        candidates.map(async (accountId) => ({
          accountId,
          score: (await this.accountHealthRepository.getLatest(accountId))?.result.healthScore ?? 0
        }))
      );
      scored.sort((a, b) => b.score - a.score);
      return scored[0]!.accountId;
    }

    if (strategy === "least-recently-used") {
      const withLastSent = candidates.map((accountId) => ({ accountId, lastSentAt: this.lastSentAt(accountId) }));
      withLastSent.sort((a, b) => (a.lastSentAt?.getTime() ?? 0) - (b.lastSentAt?.getTime() ?? 0));
      return withLastSent[0]!.accountId;
    }

    // round-robin: pick the next eligible account after the original candidate's position in the
    // pool's own configured order, wrapping around.
    const startIndex = rotationPool.indexOf(originalCandidateAccountId);
    const ordered = rotationPool.slice(startIndex + 1).concat(rotationPool.slice(0, startIndex + 1));
    for (const accountId of ordered) {
      if (candidates.includes(accountId)) return accountId;
    }
    return candidates[0]!;
  }

  private lastSentAt(accountId: AccountId): Date | undefined {
    const row = this.db
      .select()
      .from(messages)
      .where(and(sentByAccount(accountId), eq(messages.direction, "outbound"), eq(messages.status, "sent")))
      .orderBy(desc(messages.sentAt))
      .get();
    return row?.sentAt ?? undefined;
  }
}
