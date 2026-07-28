import { AccountIneligibleError } from "../types.js";
import type { SchedulingCandidate, SchedulingContext, SchedulingPolicy, WarmupProfile } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Warm-up Policy (Section 15.2): new-account sending limits, gradual volume ramp, account-age-
 * aware caps. The daily cap is derived live from the ramp schedule + current day-offset, not read
 * from warmup_profiles.current_daily_cap (that persisted field has no background process keeping
 * it in sync in this phase — deriving it here avoids trusting a value that could go stale).
 */
function capForDayOffset(profile: WarmupProfile, dayOffset: number): number {
  const configuredDays = Object.keys(profile.rampSchedule)
    .map(Number)
    .sort((a, b) => a - b);
  if (configuredDays.length === 0) return 0;

  const applicableDays = configuredDays.filter((d) => d <= dayOffset);
  // Before the ramp schedule's first configured day, use its earliest (most conservative) cap
  // rather than assuming an unlimited one.
  const effectiveDay = applicableDays.length > 0 ? Math.max(...applicableDays) : configuredDays[0]!;
  return profile.rampSchedule[String(effectiveDay)]!;
}

export const warmupPolicy: SchedulingPolicy = {
  id: "warmup",

  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate {
    const profile = ctx.warmupProfiles.get(candidate.candidateAccountId);
    if (!profile) {
      return {
        ...candidate,
        trace: [...candidate.trace, { policyId: "warmup", decision: "No warm-up profile configured for this account" }]
      };
    }

    const dayOffset = Math.floor((ctx.now.getTime() - profile.startDate.getTime()) / DAY_MS);
    const cap = capForDayOffset(profile, Math.max(0, dayOffset));
    const sentToday = ctx.recentSendCounts.get(candidate.candidateAccountId)?.last24h ?? 0;

    if (sentToday >= cap) {
      throw new AccountIneligibleError(
        `Warm-up daily cap reached for this account (${sentToday}/${cap} sent in the last 24h, day ${Math.max(0, dayOffset)} of ramp)`
      );
    }

    return {
      ...candidate,
      trace: [
        ...candidate.trace,
        { policyId: "warmup", decision: `Within warm-up cap (${sentToday}/${cap} sent in the last 24h)` }
      ]
    };
  }
};
