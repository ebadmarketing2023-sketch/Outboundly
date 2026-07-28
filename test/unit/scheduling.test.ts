import { describe, expect, it } from "vitest";
import { localWallClockToUtc, nextWeekday, parseHhMm, toLocalTimePoint } from "../../src/core/scheduling/local-time.js";
import { businessHoursPolicy } from "../../src/core/scheduling/policies/business-hours-policy.js";
import { delayPolicy } from "../../src/core/scheduling/policies/delay-policy.js";
import { rateLimitPolicy } from "../../src/core/scheduling/policies/rate-limit-policy.js";
import { timezonePolicy } from "../../src/core/scheduling/policies/timezone-policy.js";
import { warmupPolicy } from "../../src/core/scheduling/policies/warmup-policy.js";
import { schedule } from "../../src/core/scheduling/scheduler.js";
import { AccountIneligibleError, NoEligibleAccountError } from "../../src/core/scheduling/types.js";
import type { BusinessHoursProfile, SchedulingCandidate, SchedulingContext, WarmupProfile } from "../../src/core/scheduling/types.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

const ACCOUNT_A = asAccountId("account-a");
const ACCOUNT_B = asAccountId("account-b");

function baseCandidate(overrides: Partial<SchedulingCandidate> = {}): SchedulingCandidate {
  return {
    proposedSendAt: new Date("2026-07-28T12:00:00.000Z"),
    candidateAccountId: ACCOUNT_A,
    rejectedAccountIds: [],
    trace: [],
    ...overrides
  };
}

const ALWAYS_OPEN_HOURS: BusinessHoursProfile = {
  id: "bh-1",
  name: "Always open",
  timezone: "UTC",
  windows: {
    sunday: [{ start: "00:00", end: "23:59" }],
    monday: [{ start: "00:00", end: "23:59" }],
    tuesday: [{ start: "00:00", end: "23:59" }],
    wednesday: [{ start: "00:00", end: "23:59" }],
    thursday: [{ start: "00:00", end: "23:59" }],
    friday: [{ start: "00:00", end: "23:59" }],
    saturday: [{ start: "00:00", end: "23:59" }]
  }
};

function baseContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    now: new Date("2026-07-28T12:00:00.000Z"),
    availableAccountIds: [ACCOUNT_A],
    businessHoursProfile: ALWAYS_OPEN_HOURS,
    warmupProfiles: new Map(),
    recentSendCounts: new Map(),
    accountDailyLimits: new Map(),
    accountHourlyLimits: new Map(),
    ...overrides
  };
}

describe("local-time (Section 15.2 timezone support)", () => {
  it("resolves a real IANA weekday/time via Intl, not a hand-rolled offset table", () => {
    // 2026-07-28T12:00:00Z is a Tuesday; Tokyo (UTC+9) is already Tuesday 21:00.
    const point = toLocalTimePoint(new Date("2026-07-28T12:00:00.000Z"), "Asia/Tokyo");
    expect(point.weekday).toBe("tuesday");
    expect(point.minutesSinceMidnight).toBe(21 * 60);
  });

  it("parses HH:MM into minutes since midnight", () => {
    expect(parseHhMm("09:30")).toBe(9 * 60 + 30);
    expect(parseHhMm("00:00")).toBe(0);
  });

  it("wraps weekday order from saturday back to sunday", () => {
    expect(nextWeekday("saturday")).toBe("sunday");
    expect(nextWeekday("tuesday")).toBe("wednesday");
  });

  it("round-trips a local wall-clock time through a DST transition (America/New_York)", () => {
    // Jan 15 2026 is EST (UTC-5); localWallClockToUtc(9:00 local) should be 14:00 UTC.
    const winterUtc = localWallClockToUtc(2026, 1, 15, 9, 0, "America/New_York");
    expect(winterUtc.toISOString()).toBe("2026-01-15T14:00:00.000Z");

    // Jul 15 2026 is EDT (UTC-4); localWallClockToUtc(9:00 local) should be 13:00 UTC.
    const summerUtc = localWallClockToUtc(2026, 7, 15, 9, 0, "America/New_York");
    expect(summerUtc.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("round-trips a fractional-offset timezone (Asia/Kolkata, UTC+5:30)", () => {
    const utc = localWallClockToUtc(2026, 7, 15, 9, 0, "Asia/Kolkata");
    expect(utc.toISOString()).toBe("2026-07-15T03:30:00.000Z");
    const backToLocal = toLocalTimePoint(utc, "Asia/Kolkata");
    expect(backToLocal.minutesSinceMidnight).toBe(9 * 60);
  });
});

describe("Warm-up Policy (Section 15.2)", () => {
  const profile: WarmupProfile = {
    id: "wp-1",
    accountId: ACCOUNT_A,
    startDate: new Date("2026-07-21T00:00:00.000Z"), // 7 days before "now" in baseContext
    rampSchedule: { "0": 5, "7": 20 },
    currentDailyCap: 999 // deliberately wrong/stale to prove it's ignored
  };

  it("passes through when no warm-up profile is configured for the account", () => {
    const result = warmupPolicy.apply(baseCandidate(), baseContext());
    expect(result.trace.at(-1)?.decision).toMatch(/no warm-up profile/i);
  });

  it("derives the cap live from the ramp schedule day-offset, ignoring the stale persisted currentDailyCap", () => {
    const ctx = baseContext({
      warmupProfiles: new Map([[ACCOUNT_A, profile]]),
      recentSendCounts: new Map([[ACCOUNT_A, { last24h: 19, lastHour: 1 }]])
    });
    const result = warmupPolicy.apply(baseCandidate(), ctx);
    expect(result.trace.at(-1)?.decision).toMatch(/19\/20/);
  });

  it("throws AccountIneligibleError once the day's cap is reached", () => {
    const ctx = baseContext({
      warmupProfiles: new Map([[ACCOUNT_A, profile]]),
      recentSendCounts: new Map([[ACCOUNT_A, { last24h: 20, lastHour: 1 }]])
    });
    expect(() => warmupPolicy.apply(baseCandidate(), ctx)).toThrow(AccountIneligibleError);
  });

  it("uses the most conservative (earliest) cap before the ramp schedule's first configured day", () => {
    const freshProfile: WarmupProfile = { ...profile, startDate: new Date("2026-07-28T00:00:00.000Z") };
    const ctx = baseContext({
      warmupProfiles: new Map([[ACCOUNT_A, freshProfile]]),
      recentSendCounts: new Map([[ACCOUNT_A, { last24h: 5, lastHour: 1 }]])
    });
    expect(() => warmupPolicy.apply(baseCandidate(), ctx)).toThrow(AccountIneligibleError);
  });
});

describe("Rate Limit Policy (Section 15.2, predictive/soft)", () => {
  it("passes through when no limits are configured", () => {
    const result = rateLimitPolicy.apply(baseCandidate(), baseContext());
    expect(result.trace.at(-1)?.decision).toMatch(/unlimited/);
  });

  it("throws AccountIneligibleError when the daily limit is reached", () => {
    const ctx = baseContext({
      recentSendCounts: new Map([[ACCOUNT_A, { last24h: 50, lastHour: 0 }]]),
      accountDailyLimits: new Map([[ACCOUNT_A, 50]])
    });
    expect(() => rateLimitPolicy.apply(baseCandidate(), ctx)).toThrow(AccountIneligibleError);
  });

  it("throws AccountIneligibleError when the hourly limit is reached", () => {
    const ctx = baseContext({
      recentSendCounts: new Map([[ACCOUNT_A, { last24h: 1, lastHour: 10 }]]),
      accountHourlyLimits: new Map([[ACCOUNT_A, 10]])
    });
    expect(() => rateLimitPolicy.apply(baseCandidate(), ctx)).toThrow(AccountIneligibleError);
  });

  it("does not treat an undefined limit as zero", () => {
    const ctx = baseContext({ recentSendCounts: new Map([[ACCOUNT_A, { last24h: 500, lastHour: 500 }]]) });
    const result = rateLimitPolicy.apply(baseCandidate(), ctx);
    expect(result.trace.at(-1)?.decision).toMatch(/unlimited/);
  });
});

describe("Timezone Policy (Section 15.2)", () => {
  it("prefers the recipient's own timezone when known", () => {
    const ctx = baseContext({ recipientTimezone: "Asia/Tokyo" });
    const result = timezonePolicy.apply(baseCandidate(), ctx);
    expect(result.resolvedTimezone).toBe("Asia/Tokyo");
    expect(result.trace.at(-1)?.decision).toMatch(/recipient/i);
  });

  it("falls back to the business-hours profile's own timezone otherwise", () => {
    const result = timezonePolicy.apply(baseCandidate(), baseContext());
    expect(result.resolvedTimezone).toBe("UTC");
    expect(result.trace.at(-1)?.decision).toMatch(/business-hours profile/i);
  });
});

describe("Business Hours Policy (Section 15.3)", () => {
  it("leaves a candidate already inside an allowed window untouched", () => {
    const candidate = baseCandidate({ resolvedTimezone: "UTC" });
    const result = businessHoursPolicy.apply(candidate, baseContext());
    expect(result.proposedSendAt).toEqual(candidate.proposedSendAt);
    expect(result.trace.at(-1)?.decision).toMatch(/already within/i);
  });

  it("snaps forward to the next allowed window when outside all windows", () => {
    const narrowHours: BusinessHoursProfile = {
      id: "bh-2",
      name: "Business hours",
      timezone: "UTC",
      windows: { wednesday: [{ start: "09:00", end: "17:00" }] }
    };
    // 2026-07-28 is a Tuesday; nothing configured for tuesday, so it must roll to Wednesday 09:00.
    const candidate = baseCandidate({ resolvedTimezone: "UTC" });
    const ctx = baseContext({ businessHoursProfile: narrowHours });
    const result = businessHoursPolicy.apply(candidate, ctx);
    expect(result.proposedSendAt.toISOString()).toBe("2026-07-29T09:00:00.000Z");
  });

  it("throws when the business hours profile has no windows configured at all", () => {
    const emptyHours: BusinessHoursProfile = { id: "bh-3", name: "Empty", timezone: "UTC", windows: {} };
    const ctx = baseContext({ businessHoursProfile: emptyHours });
    expect(() => businessHoursPolicy.apply(baseCandidate({ resolvedTimezone: "UTC" }), ctx)).toThrow(/no allowed windows/i);
  });
});

describe("Delay Policy (Section 15.2, applied last)", () => {
  it("applies no jitter when no delay policy is configured", () => {
    const candidate = baseCandidate();
    const result = delayPolicy.apply(candidate, baseContext());
    expect(result.proposedSendAt).toEqual(candidate.proposedSendAt);
    expect(result.trace.at(-1)?.decision).toMatch(/no delay policy/i);
  });

  it("jitters proposedSendAt within the configured min/max range", () => {
    const candidate = baseCandidate();
    const ctx = baseContext({ delayPolicy: { id: "dp-1", minDelaySeconds: 60, maxDelaySeconds: 300, jitterStrategy: "uniform" } });
    const result = delayPolicy.apply(candidate, ctx);
    const deltaSeconds = (result.proposedSendAt.getTime() - candidate.proposedSendAt.getTime()) / 1000;
    expect(deltaSeconds).toBeGreaterThanOrEqual(60);
    expect(deltaSeconds).toBeLessThanOrEqual(300);
  });

  it("applies a fixed delay when min equals max", () => {
    const candidate = baseCandidate();
    const ctx = baseContext({ delayPolicy: { id: "dp-2", minDelaySeconds: 120, maxDelaySeconds: 120, jitterStrategy: "uniform" } });
    const result = delayPolicy.apply(candidate, ctx);
    expect(result.proposedSendAt.getTime() - candidate.proposedSendAt.getTime()).toBe(120_000);
  });
});

describe("Scheduler orchestrator (Section 15.1/15.3)", () => {
  it("runs the full pipeline for a single eligible account", () => {
    const ctx = baseContext();
    const result = schedule(new Date("2026-07-28T12:00:00.000Z"), ctx);
    expect(result.candidateAccountId).toBe(ACCOUNT_A);
    expect(result.rejectedAccountIds).toEqual([]);
    const policyIds = result.trace.map((t) => t.policyId);
    expect(policyIds).toEqual(["warmup", "rate-limit", "timezone", "business-hours", "delay"]);
  });

  it("rotates to the next account when the first is warm-up ineligible", () => {
    const exhaustedProfile: WarmupProfile = {
      id: "wp-2",
      accountId: ACCOUNT_A,
      startDate: new Date("2026-07-28T00:00:00.000Z"),
      rampSchedule: { "0": 1 },
      currentDailyCap: 1
    };
    const ctx = baseContext({
      availableAccountIds: [ACCOUNT_A, ACCOUNT_B],
      warmupProfiles: new Map([[ACCOUNT_A, exhaustedProfile]]),
      recentSendCounts: new Map([[ACCOUNT_A, { last24h: 1, lastHour: 1 }]])
    });
    const result = schedule(new Date("2026-07-28T12:00:00.000Z"), ctx);
    expect(result.candidateAccountId).toBe(ACCOUNT_B);
    expect(result.rejectedAccountIds).toEqual([ACCOUNT_A]);
  });

  it("throws NoEligibleAccountError when every account in rotation is ineligible", () => {
    const ctx = baseContext({
      availableAccountIds: [ACCOUNT_A, ACCOUNT_B],
      recentSendCounts: new Map([
        [ACCOUNT_A, { last24h: 100, lastHour: 0 }],
        [ACCOUNT_B, { last24h: 100, lastHour: 0 }]
      ]),
      accountDailyLimits: new Map([[ACCOUNT_A, 50], [ACCOUNT_B, 50]])
    });
    expect(() => schedule(new Date("2026-07-28T12:00:00.000Z"), ctx)).toThrow(NoEligibleAccountError);
  });

  it("propagates non-AccountIneligibleError errors instead of rotating past them", () => {
    const emptyHours: BusinessHoursProfile = { id: "bh-4", name: "Empty", timezone: "UTC", windows: {} };
    const ctx = baseContext({ businessHoursProfile: emptyHours });
    expect(() => schedule(new Date("2026-07-28T12:00:00.000Z"), ctx)).toThrow(/no allowed windows/i);
  });
});
