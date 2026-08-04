import { and, eq, gte } from "drizzle-orm";
import type { Campaign } from "../../core/campaigns/campaign.js";
import type { SchedulingContext } from "../../core/scheduling/types.js";
import { asAccountId, type AccountId } from "../../core/shared-kernel/ids.js";
import type { AccountRef } from "../../ports/mail-provider.port.js";
import type { BusinessHoursProfileRepository } from "../../ports/business-hours-profile-repository.port.js";
import type { DelayPolicyConfigRepository } from "../../ports/delay-policy-config-repository.port.js";
import type { WarmupProfileRepository } from "../../ports/warmup-profile-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { accounts, messages } from "./schema.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface BuildSchedulingContextDeps {
  db: OutboundlyDb;
  businessHoursProfileRepository: BusinessHoursProfileRepository;
  warmupProfileRepository: WarmupProfileRepository;
  delayPolicyConfigRepository: DelayPolicyConfigRepository;
}

/**
 * Assembles a real SchedulingContext (Section 15.1) for one campaign's due step-firing from
 * persisted configuration and actual send history — the Scheduling Policy Engine's policies stay
 * pure/I/O-free (Section 15's design), so this glue lives here, behind the same adapter boundary
 * as the other raw-table readers (account-health-metrics-source.ts, rate-limiter.ts), since there
 * is no standalone AccountRepository port in this codebase to go through instead.
 */
export async function buildSchedulingContext(
  deps: BuildSchedulingContextDeps,
  campaign: Campaign,
  now: Date,
  recipientTimezone?: string,
  preferredAccountId?: AccountId
): Promise<SchedulingContext> {
  const businessHoursProfile = await deps.businessHoursProfileRepository.findById(campaign.businessHoursProfileId);
  if (!businessHoursProfile) {
    throw new Error(`Campaign "${campaign.name}" references a business hours profile that no longer exists`);
  }

  const warmupProfiles: SchedulingContext["warmupProfiles"] = new Map();
  const accountDailyLimits: SchedulingContext["accountDailyLimits"] = new Map();
  const accountHourlyLimits: SchedulingContext["accountHourlyLimits"] = new Map();
  const recentSendCounts: SchedulingContext["recentSendCounts"] = new Map();

  for (const accountId of campaign.sendingAccountIds) {
    const account = deps.db.select().from(accounts).where(eq(accounts.id, accountId)).get();

    // dailyLimitOverride, when set, replaces the account's own default for this campaign's own
    // scheduling decisions specifically (Section 5.6) -- there is no per-campaign send-count
    // tracking, so this can't act as an additional ceiling layered on top of the account's count.
    accountDailyLimits.set(accountId, campaign.dailyLimitOverride ?? account?.dailySendLimit ?? undefined);
    accountHourlyLimits.set(accountId, account?.hourlySendLimit ?? undefined);

    const warmupProfile = await deps.warmupProfileRepository.findByAccountId(accountId);
    if (warmupProfile) warmupProfiles.set(accountId, warmupProfile);

    recentSendCounts.set(accountId, countRecentSends(deps.db, accountId, now));
  }

  const delayPolicy = await deps.delayPolicyConfigRepository.findByCampaignId(campaign.id);

  // A follow-up prefers whichever account actually sent this enrollment's previous step (see
  // fire-enrollment-step.ts): schedule() tries availableAccountIds in order and takes the first
  // eligible one, so putting the preferred account first is enough to express "stay consistent
  // for this recipient's thread" without changing schedule()'s own pure rotation logic at all --
  // if that account is no longer eligible (disconnected, rate-limited, unhealthy), the existing
  // fall-through to the next account in the pool (and the Provider Selector's own substitution at
  // dispatch time) still applies exactly as before. A real reported concern: sending consecutive
  // messages in the same conversation from different "From" addresses looks unusual to a
  // recipient even though the reply threading itself still works -- this keeps that from
  // happening whenever it's avoidable.
  const availableAccountIds =
    preferredAccountId && campaign.sendingAccountIds.includes(preferredAccountId)
      ? [preferredAccountId, ...campaign.sendingAccountIds.filter((id) => id !== preferredAccountId)]
      : campaign.sendingAccountIds;

  return {
    now,
    availableAccountIds,
    businessHoursProfile,
    warmupProfiles,
    recentSendCounts,
    accountDailyLimits,
    accountHourlyLimits,
    delayPolicy,
    recipientTimezone
  };
}

function countRecentSends(db: OutboundlyDb, accountId: AccountId, now: Date): { last24h: number; lastHour: number } {
  const since24h = new Date(now.getTime() - DAY_MS);
  const sentLast24h = db
    .select()
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.direction, "outbound"), eq(messages.status, "sent"), gte(messages.sentAt, since24h)))
    .all();

  const sinceLastHour = new Date(now.getTime() - HOUR_MS);
  const lastHour = sentLast24h.filter((m) => (m.sentAt ?? new Date(0)) >= sinceLastHour).length;

  return { last24h: sentLast24h.length, lastHour };
}

/** Looks up the sending identity for an already-chosen account (Section 12.1's AccountRef), for
 * building the RFC 5322 From header of a campaign-generated message. */
export function getAccountRef(db: OutboundlyDb, accountId: AccountId): AccountRef | undefined {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  return account
    ? { accountId: asAccountId(account.id), emailAddress: account.emailAddress, displayName: account.displayName ?? undefined }
    : undefined;
}
