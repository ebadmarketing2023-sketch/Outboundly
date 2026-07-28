import type { AccountId } from "../shared-kernel/ids.js";

/**
 * Policy-Based Scheduling (Section 15): the Scheduler answers "when" and "which account"
 * entirely by orchestrating independent, individually testable policy objects — it contains no
 * business rules of its own (Section 15.1).
 */

export interface PolicyTraceEntry {
  policyId: string;
  decision: string;
  before?: { sendAt?: string; accountId?: AccountId };
  after?: { sendAt?: string; accountId?: AccountId };
}

export interface SchedulingCandidate {
  proposedSendAt: Date;
  candidateAccountId: AccountId;
  rejectedAccountIds: AccountId[];
  /** Set by the Timezone Policy (Section 15.2) for the Business Hours Policy to snap against —
   * the recipient's timezone if known, otherwise the business-hours profile's own timezone. */
  resolvedTimezone?: string;
  trace: PolicyTraceEntry[];
}

/** Per-weekday allowed sending windows, in the profile's own local time (Section 5.7). Weekday
 * keys are lowercase full English weekday names ("monday".."sunday"), matching what
 * Intl.DateTimeFormat({weekday: "long"}) produces — verified real, DST-correct timezone/weekday
 * resolution via Node's built-in Intl, not a hand-rolled UTC-offset table. */
export interface BusinessHoursWindow {
  start: string; // "HH:MM", 24-hour
  end: string; // "HH:MM", 24-hour
}

export interface BusinessHoursProfile {
  id: string;
  name: string;
  timezone: string;
  windows: Record<string, BusinessHoursWindow[]>;
}

export interface WarmupProfile {
  id: string;
  accountId: AccountId;
  startDate: Date;
  /** Day-offset-from-start (as a string key, e.g. "0", "7", "14") -> daily cap. */
  rampSchedule: Record<string, number>;
  currentDailyCap: number;
}

export interface DelayPolicyConfig {
  id: string;
  campaignId?: string;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  jitterStrategy: "uniform";
}

/** What a policy needs to decide, gathered by the application layer beforehand (Section 15.1) —
 * policies themselves stay pure and I/O-free. */
export interface SchedulingContext {
  now: Date;
  /** The full rotation pool this campaign can send from (Section 14.4) — the order here is the
   * rotation order the Warm-up/Rate Limit Policy tries accounts in. */
  availableAccountIds: AccountId[];
  businessHoursProfile: BusinessHoursProfile;
  warmupProfiles: Map<AccountId, WarmupProfile>;
  /** Sends already recorded for each account in the relevant rolling windows — the predictive,
   * soft check (Section 15.4); the Rate Limiter (Section 16.2) is the real-time authoritative one. */
  recentSendCounts: Map<AccountId, { last24h: number; lastHour: number }>;
  /** Effective daily cap per account (account's own dailySendLimit, or a campaign override) —
   * undefined means no explicit cap configured for that account. */
  accountDailyLimits: Map<AccountId, number | undefined>;
  /** Effective hourly cap per account (account's own hourlySendLimit) — undefined means no
   * explicit cap configured. */
  accountHourlyLimits: Map<AccountId, number | undefined>;
  delayPolicy?: DelayPolicyConfig;
  /** The enrolled contact's own timezone, if known (Section 15.2). */
  recipientTimezone?: string;
}

export interface SchedulingPolicy {
  id: string;
  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate;
}

/** Thrown when every account in the rotation pool is ineligible right now (Section 15.3's
 * rotation loop exhausted) — there is no valid SchedulingCandidate to propose at all, which the
 * bare apply(candidate, ctx) -> candidate contract has no way to express as a return value. The
 * Scheduler tick worker (Section 21.1) catches this and simply leaves the enrollment for a later
 * tick rather than treating it as a hard failure. */
export class NoEligibleAccountError extends Error {
  constructor(readonly rejectedAccountIds: AccountId[]) {
    super("No eligible sending account available for this campaign right now");
    this.name = "NoEligibleAccountError";
  }
}

/** Thrown by the Warm-up/Rate Limit policies (Section 15.2) to signal "this account, right now,
 * is not eligible" — the one case where a policy can't just return a transformed candidate,
 * since the Scheduler needs to rotate to the next account and retry from the top (Section 15.3). */
export class AccountIneligibleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AccountIneligibleError";
  }
}
